// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for a genuine TOCTOU race in writeAuditLog(): without
 * serializing writers, two concurrent transactions can both read the same
 * "previous" chain row via findFirst, both compute a new row chained off
 * that same prevHash, and both commit — forking the tamper-evident hash
 * chain. This was reproduced live on 2026-08-31/09-01 under heavy
 * concurrent-agent test-write load against the shared verification and
 * community_test databases (historical
 * broken-chain-row counts left behind by that pre-fix window).
 *
 * The fix (matching databounty-api/src/lib/audit-log.ts) is a
 * transaction-scoped Postgres advisory lock — `pg_advisory_xact_lock`
 * with a fixed key — taken immediately before the "read previous" step, so
 * every concurrent writeAuditLog call serializes through it for the
 * duration of its own transaction.
 *
 * This test fires N concurrent writeAuditLog calls, each in its own
 * transaction, then walks the resulting rows in creation order and asserts
 * the chain is fully valid: every row's stored prevHash matches the actual
 * previous row's rowHash, with no forks/gaps, and every row's stored
 * rowHash matches a fresh recompute of its evidence. If the advisory lock
 * in writeAuditLog is removed, this test fails (verified manually while
 * authoring it).
 */
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "./lib/prisma.js";
import { canonicalizeAuditValue, hashAuditEvidence, writeAuditLog } from "./lib/audit-log.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

const MARKER_ACTION = `test.audit_chain_concurrency.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
const CONCURRENCY = 10;

afterAll(async () => {
  await prisma.adminAuditLog.deleteMany({ where: { action: MARKER_ACTION } });
  await prisma.$disconnect();
});

describe("writeAuditLog concurrency", () => {
  it("keeps the hash chain unforked under N concurrent writers", async () => {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, index) =>
        prisma.$transaction((tx) =>
          writeAuditLog(tx, {
            actorUserId: null,
            action: MARKER_ACTION,
            targetType: "test_row",
            targetId: `row-${index}`,
            result: "success",
            metadata: { index },
          }),
        ),
      ),
    );

    const rows = await prisma.adminAuditLog.findMany({
      where: { action: MARKER_ACTION },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        actorSnapshot: true,
        action: true,
        targetType: true,
        targetId: true,
        result: true,
        metadata: true,
        before: true,
        after: true,
        ip: true,
        userAgent: true,
        requestId: true,
        prevHash: true,
        rowHash: true,
        createdAt: true,
      },
    });

    expect(rows).toHaveLength(CONCURRENCY);

    // Every writer must have chained off a distinct previous row — no two
    // rows may share the same prevHash (that would be the fork this lock
    // prevents), and every rowHash must be unique.
    const prevHashes = rows.map((row) => row.prevHash);
    const nonNullPrevHashes = prevHashes.filter((hash): hash is string => hash !== null);
    expect(new Set(nonNullPrevHashes).size).toBe(nonNullPrevHashes.length);

    const rowHashes = rows.map((row) => row.rowHash);
    expect(new Set(rowHashes).size).toBe(rows.length);

    // Walk in creation order and verify the chain proper: each row's
    // prevHash equals the immediately preceding row's rowHash (or null for
    // the very first of our batch, chained onto whatever pre-existed), and
    // each row's rowHash matches a fresh recompute of its evidence.
    let expectedPrevHash: string | null = rows[0]!.prevHash;
    for (const row of rows) {
      expect(row.prevHash).toBe(expectedPrevHash);

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
        prevHash: row.prevHash,
        createdAt: row.createdAt.toISOString(),
      };
      expect(hashAuditEvidence(evidence)).toBe(row.rowHash);

      expectedPrevHash = row.rowHash;
    }
  });
});
