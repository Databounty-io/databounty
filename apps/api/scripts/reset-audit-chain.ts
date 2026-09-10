// SPDX-License-Identifier: Apache-2.0

/**
 * One-off, explicitly authorized reset of the admin_audit_log tamper-evident
 * hash chain, for two named local dev/test databases only:
 *   - databounty_community_parity_verify
 *   - community_test
 *
 * Context: writeAuditLog() (src/lib/audit-log.ts) previously lacked a
 * pg_advisory_xact_lock around its read-then-chain-then-write sequence,
 * so concurrent writers could race and fork the chain (two rows both
 * chaining off the same "previous" row). That bug is now fixed. This
 * script recomputes every row's prevHash/rowHash from scratch, in true
 * creation order, using the EXACT SAME hashing/canonicalization functions
 * as the live writeAuditLog()/verifyAuditChainIntegrity() code (imported
 * directly, not reimplemented), so the repaired chain is indistinguishable
 * in shape from one the live app would have produced, and the live app's
 * NEXT write extends it without a seam.
 *
 * Only the `prev_hash` and `row_hash` columns are ever written. No other
 * column, row, or table is touched.
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres:databounty@localhost:5432/databounty_community_parity_verify?schema=public \
 *     npx tsx scripts/reset-audit-chain.ts
 *
 *   DATABASE_URL=postgresql://postgres:databounty@localhost:5432/community_test?schema=public \
 *     npx tsx scripts/reset-audit-chain.ts
 */
import { prisma } from "../src/lib/prisma.js";
import {
  canonicalizeAuditValue,
  hashAuditEvidence,
  verifyAuditChainIntegrity,
  writeAuditLog,
} from "../src/lib/audit-log.js";

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? "(unset)";
  console.log(`\n=== Target: ${dbUrl} ===`);

  const before = await verifyAuditChainIntegrity();
  console.log("BEFORE verifyAuditChainIntegrity():", before);

  const rows = await prisma.adminAuditLog.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  console.log(`Read ${rows.length} rows in creation order.`);

  let expectedPrevHash: string | null = null;
  const updates: { id: string; prevHash: string | null; rowHash: string }[] = [];

  for (const row of rows) {
    // Rows written before hashing existed (rowHash null) don't participate
    // in the chain -- leave them untouched, exactly like verifyAuditChainIntegrity
    // does. (None exist in either target DB today, but keep parity with
    // the live semantics in case that ever changes.)
    if (row.rowHash === null) continue;

    const evidence = {
      id: row.id,
      actorSnapshot: canonicalizeAuditValue(row.actorSnapshot),
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      result: row.result,
      metadata: canonicalizeAuditValue(row.metadata) ?? null,
      before: canonicalizeAuditValue(row.before) ?? null,
      after: canonicalizeAuditValue(row.after) ?? null,
      ip: row.ip ?? null,
      userAgent: row.userAgent ?? null,
      requestId: row.requestId ?? null,
      prevHash: expectedPrevHash,
      createdAt: row.createdAt.toISOString(),
    };
    const rowHash = hashAuditEvidence(evidence);
    updates.push({ id: row.id, prevHash: expectedPrevHash, rowHash });
    expectedPrevHash = rowHash;
  }

  console.log(`Recomputing chain hashes for ${updates.length} of ${rows.length} rows.`);

  await prisma.$transaction(
    async (tx) => {
      for (const u of updates) {
        await tx.adminAuditLog.update({
          where: { id: u.id },
          data: { prevHash: u.prevHash, rowHash: u.rowHash },
        });
      }
    },
    { timeout: 300_000, maxWait: 300_000 }
  );

  const after = await verifyAuditChainIntegrity();
  console.log("AFTER reset verifyAuditChainIntegrity():", after);

  if (!after.valid) {
    throw new Error(`Reset did not produce a valid chain: ${JSON.stringify(after)}`);
  }

  // Live-proof: write one new row the normal way (real writeAuditLog call,
  // with the fixed advisory-lock code path) and re-verify that it extends
  // the reset history with no break at the seam.
  await prisma.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      actorUserId: null,
      action: "system.audit_chain_reset_live_proof",
      targetType: "system",
      targetId: "audit-chain-reset",
      result: "success",
      metadata: {
        note: "Post-reset live-proof write via real writeAuditLog(), confirming the reset chain extends cleanly.",
        resetAt: new Date().toISOString(),
      },
    });
  });

  const liveProof = await verifyAuditChainIntegrity();
  console.log("LIVE-PROOF verifyAuditChainIntegrity() after new real write:", liveProof);

  if (!liveProof.valid) {
    throw new Error(`Live-proof write broke the chain: ${JSON.stringify(liveProof)}`);
  }

  console.log(
    JSON.stringify(
      {
        database: dbUrl,
        rowsRead: rows.length,
        rowsUpdated: updates.length,
        before,
        after,
        liveProof,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
