// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for `services/audit-routing.ts` — the AuditBatch/AuditItem layer
 * added when the validator flow was aligned with v1.
 *
 * WHAT THIS LAYER IS FOR, since the first version of this file tested the wrong
 * thing. v1 pools items into batches of `community.audit_batch_size` (25)
 * because it has no other batching layer. This deployment already batches at
 * the window level — `community.human_audit_window_size` is documented as "the
 * batch a validator claims. 50–100 (owner requirement)" and `pool-lifecycle`
 * enforces it. Porting v1's pooling gave two layers with different sizes both
 * claiming to be the claimable unit, so batches are now created 1:1 with a
 * window chunk and exist for the one thing a window cannot express: a per-item
 * verdict with the validator's note and decision timestamp.
 *
 * Behaviours asserted here, all invisible to a typecheck:
 *
 *  1. A batch is created with one UNDECIDED item per selected submission, and
 *     `itemCount` matches reality. Undecided matters: items arriving
 *     pre-verdicted would report work as done that no human did.
 *  2. The `@unique` window→batch link is NOT a replay guard on its own —
 *     the caller's `auditBatchId: null` update guard is. Asserted explicitly,
 *     because an earlier version of this code claimed otherwise.
 *  3. PARTIAL-BATCH REOPEN. Reopening one item must not hand a partially
 *     decided batch back to the pool — v1 saw 12 batches pay two validators
 *     because it did. Asserted in both directions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma.js";
import { AUDIT_REVIEW_SLA_MS, createWindowAuditBatch, reopenAuditItemForReview } from "./audit-routing.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const TOKEN = `ar_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
let userId = "";
let datasetTypeId = "";
const submissionIds: string[] = [];
const bountyIds: string[] = [];

async function makeBounty(label: string): Promise<string> {
  const b = await prisma.bounty.create({
    data: {
      kind: "community",
      title: `audit-routing ${label} ${TOKEN}`,
      description: "probe",
      datasetTypeId,
      requesterUserId: userId,
      status: "active",
      targetItems: 100,
      datasetCategory: "implementation",
      language: "Python",
      framework: "Community",
      auditMode: "partial",
      auditCoveragePct: 100,
      holdDays: 30,
    },
    select: { id: true },
  });
  bountyIds.push(b.id);
  return b.id;
}

async function makeSubmission(intoBounty: string, i: number): Promise<string> {
  const s = await prisma.submission.create({
    data: {
      bountyId: intoBounty,
      contributorUserId: userId,
      status: "in_audit",
      title: `audit-routing probe ${TOKEN}-${i}`,
      payloadJson: { probe: `${TOKEN}-${i}` },
      generationMethod: "human",
    },
    select: { id: true },
  });
  submissionIds.push(s.id);
  return s.id;
}

beforeAll(async () => {
  const dt = await prisma.datasetType.findFirst({ select: { id: true } });
  if (!dt) throw new Error("no dataset type in the verify database — run the catalog seed");
  datasetTypeId = dt.id;

  const user = await prisma.user.create({
    data: { email: `${TOKEN}@local.test`, displayName: "audit routing probe", authMethod: "email" },
    select: { id: true },
  });
  userId = user.id;
});

afterAll(async () => {
  // Explicit order: `audit_items.submission_id` is ON DELETE RESTRICT (v1's
  // constraint too — it is what stops a submission delete from erasing the
  // record of who audited it), so items go before submissions. The window's
  // batch link is cleared first so the batch delete is not blocked.
  if (bountyIds.length) {
    await prisma.humanAuditWindow.updateMany({
      where: { bountyId: { in: bountyIds } },
      data: { auditBatchId: null },
    });
    await prisma.auditItem.deleteMany({ where: { auditBatch: { bountyId: { in: bountyIds } } } });
    await prisma.auditBatch.deleteMany({ where: { bountyId: { in: bountyIds } } });
  }
  if (submissionIds.length) await prisma.submission.deleteMany({ where: { id: { in: submissionIds } } });
  if (bountyIds.length) await prisma.bounty.deleteMany({ where: { id: { in: bountyIds } } });
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
});

describe("createWindowAuditBatch", { timeout: 120_000 }, () => {
  it("creates one batch holding one UNDECIDED item per selected submission", async () => {
    const bountyId = await makeBounty("create");
    const ids = [
      await makeSubmission(bountyId, 1),
      await makeSubmission(bountyId, 2),
      await makeSubmission(bountyId, 3),
    ];

    const batchId = await prisma.$transaction((tx) =>
      createWindowAuditBatch(tx, { bountyId, submissionIds: ids }),
    );
    expect(batchId).toBeTruthy();

    const batch = await prisma.auditBatch.findUniqueOrThrow({
      where: { id: batchId! },
      include: { items: true },
    });
    expect(batch.status).toBe("available");
    expect(batch.validatorUserId).toBeNull();
    // The hand-set counter must match the real rows — a drifting itemCount is
    // what lets a validator be credited for work that is not there.
    expect(batch.itemCount).toBe(3);
    expect(batch.items).toHaveLength(3);
    expect(batch.items.map((i) => i.submissionId).sort()).toEqual([...ids].sort());
    // Undecided: no verdict may exist before a human decides.
    expect(batch.items.every((i) => i.verdict === null && i.decidedAt === null && i.note === null)).toBe(true);
  });

  it("returns null for an empty selection rather than creating an empty batch", async () => {
    const bountyId = await makeBounty("empty");
    const batchId = await prisma.$transaction((tx) =>
      createWindowAuditBatch(tx, { bountyId, submissionIds: [] }),
    );
    expect(batchId).toBeNull();
    expect(await prisma.auditBatch.count({ where: { bountyId } })).toBe(0);
  });

  it("the @unique link does NOT by itself stop a window being relinked — the caller's null-guard does", async () => {
    // This case exists because the first version of this code claimed `@unique`
    // made close-out replay-safe. It does not: the constraint stops two windows
    // sharing one batch, not one window's link being reassigned. Asserting the
    // real behaviour here keeps that claim from being reintroduced.
    const bountyId = await makeBounty("replay");
    const ids = [await makeSubmission(bountyId, 10)];

    const window = await prisma.humanAuditWindow.create({
      data: { bountyId, windowIndex: 1, eligibleCount: 1, quota: 1, closureReason: "pool_target_reached" },
      select: { id: true },
    });

    const first = await prisma.$transaction(async (tx) => {
      const id = await createWindowAuditBatch(tx, { bountyId, submissionIds: ids });
      await tx.humanAuditWindow.update({ where: { id: window.id }, data: { auditBatchId: id } });
      return id;
    });
    const second = (await prisma.$transaction((tx) =>
      createWindowAuditBatch(tx, { bountyId, submissionIds: ids }),
    ))!;

    // Unguarded, a relink SUCCEEDS — this is the hazard.
    await prisma.humanAuditWindow.update({ where: { id: window.id }, data: { auditBatchId: second } });
    expect((await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: window.id } })).auditBatchId).toBe(second);

    // Guarded the way pool-lifecycle does it, the relink is refused and the
    // original batch — the one holding the verdicts — keeps the window.
    await prisma.humanAuditWindow.update({ where: { id: window.id }, data: { auditBatchId: first } });
    const guarded = await prisma.humanAuditWindow.updateMany({
      where: { id: window.id, auditBatchId: null },
      data: { auditBatchId: second },
    });
    expect(guarded.count).toBe(0);
    expect((await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: window.id } })).auditBatchId).toBe(first);

    // Two windows may never share one batch, though — that part IS enforced.
    const other = await prisma.humanAuditWindow.create({
      data: { bountyId, windowIndex: 2, eligibleCount: 1, quota: 1, closureReason: "pool_target_reached" },
      select: { id: true },
    });
    await expect(
      prisma.humanAuditWindow.update({ where: { id: other.id }, data: { auditBatchId: first } }),
    ).rejects.toThrow();
  });
});

describe("reopenAuditItemForReview", { timeout: 120_000 }, () => {
  it("returns the batch to the pool when nothing else in it is decided", async () => {
    const bountyId = await makeBounty("return-to-pool");
    const ids = [await makeSubmission(bountyId, 20)];
    const batchId = (await prisma.$transaction((tx) =>
      createWindowAuditBatch(tx, { bountyId, submissionIds: ids }),
    ))!;

    await prisma.auditBatch.update({
      where: { id: batchId },
      data: { status: "claimed", validatorUserId: userId, claimedAt: new Date(), deadline: new Date() },
    });
    const item = await prisma.auditItem.findFirstOrThrow({ where: { auditBatchId: batchId } });
    await prisma.auditItem.update({
      where: { id: item.id },
      data: { verdict: "ok", note: "will be reopened", decidedAt: new Date() },
    });

    const result = await prisma.$transaction((tx) =>
      reopenAuditItemForReview(tx, { id: item.id, auditBatchId: batchId }),
    );
    expect(result.returnedToPool).toBe(true);
    expect(result.retainedValidatorUserId).toBeNull();

    const batch = await prisma.auditBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("available");
    expect(batch.validatorUserId).toBeNull();
    expect(batch.claimedAt).toBeNull();

    // The verdict is genuinely cleared, not just the batch flipped.
    const reopened = await prisma.auditItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reopened.verdict).toBeNull();
    expect(reopened.note).toBeNull();
    expect(reopened.decidedAt).toBeNull();
  });

  it("keeps the owner and re-arms the SLA when other items are already decided", async () => {
    const bountyId = await makeBounty("partial-reopen");
    const ids = [await makeSubmission(bountyId, 30), await makeSubmission(bountyId, 31)];
    const batchId = (await prisma.$transaction((tx) =>
      createWindowAuditBatch(tx, { bountyId, submissionIds: ids }),
    ))!;

    await prisma.auditBatch.update({
      where: { id: batchId },
      data: { status: "claimed", validatorUserId: userId, claimedAt: new Date() },
    });
    const items = await prisma.auditItem.findMany({
      where: { auditBatchId: batchId },
      orderBy: { id: "asc" },
    });
    expect(items).toHaveLength(2);
    for (const it of items) {
      await prisma.auditItem.update({ where: { id: it.id }, data: { verdict: "ok", decidedAt: new Date() } });
    }

    const before = Date.now();
    const result = await prisma.$transaction((tx) =>
      reopenAuditItemForReview(tx, { id: items[0]!.id, auditBatchId: batchId }),
    );

    // The anti-double-pay guarantee.
    expect(result.returnedToPool).toBe(false);
    expect(result.retainedValidatorUserId).toBe(userId);

    const batch = await prisma.auditBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("in_progress");
    expect(batch.validatorUserId).toBe(userId);
    expect(batch.deadline).not.toBeNull();
    // Re-armed, not merely non-null.
    expect(batch.deadline!.getTime()).toBeGreaterThanOrEqual(before + AUDIT_REVIEW_SLA_MS - 5_000);

    // The other item's verdict survives untouched.
    const untouched = await prisma.auditItem.findUniqueOrThrow({ where: { id: items[1]!.id } });
    expect(untouched.verdict).toBe("ok");
    expect(untouched.decidedAt).not.toBeNull();
  });
});
