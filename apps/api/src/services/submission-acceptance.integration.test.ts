// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the community-pool counter drift verified live on the
 * dev deployment and the staging snapshot: pools showing "1000 / 1000
 * capacity reserved" with 989/998/999 final accepts that never closed.
 *
 * `Bounty.acceptedItems` was only ever incremented (atomically, by
 * `claimPoolAcceptanceSlot`) and `finalAcceptedItems` only ever incremented
 * on accept. Nothing brought `acceptedItems` back down when a slot-holding
 * item left the counted set (validator flag, dispute -> rejected, revision),
 * and the close-out check only ran at accept time. These tests drive
 * `recomputeAcceptedItemCounters` and the `reconcileOpenCommunityPools`
 * sweep against real rows and prove:
 *
 *  (a) flagging a slot-holding `in_audit` item releases its slot and a new
 *      item can claim it through the existing atomic gate;
 *  (b) a pool at target closes exactly once and enqueues sampling exactly
 *      once, however many times the recount runs;
 *  (c) the sweep repairs the two live shapes with no manual data fix — a
 *      pool whose counter says full but holds flagged rows reopens, and a
 *      pool whose true count is at target closes.
 *
 * Self-guards like the other integration tests: refuses to run unless
 * DATABASE_URL points at a disposable local database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { AuditMode, AuthMethod, BountyKind, BountyStatus, DatasetCategory, GenerationMethod, JobStatus, SubmissionStatus, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import { recomputeAcceptedItemCounters } from "./submission-acceptance.js";
import { claimPoolAcceptanceSlot, reconcileOpenCommunityPools } from "./pool-lifecycle.js";

requireDisposableDatabase();

const createdBountyIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  await prisma.jobQueue.deleteMany({
    where: { idempotencyKey: { in: createdBountyIds.map((id) => `pool-sample:${id}`) } },
  });
  await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: createdBountyIds } } });
  await prisma.submission.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function seedPool(opts: {
  targetItems: number;
  /** Stored counter to seed drift with; defaults to the target (the live bug shape). */
  acceptedItems?: number;
  finalAcceptedItems?: number;
  statuses: Array<{ status: SubmissionStatus; count: number }>;
  /** Seed the pool already closed (and optionally settled), to test reopen. */
  poolClosedAt?: Date;
  poolSamplingStartedAt?: Date;
  poolSamplingCompletedAt?: Date;
  disputeCycleWindowOpensAt?: Date;
  disputeCycleSettledAt?: Date;
  status?: BountyStatus;
}): Promise<{ bountyId: string; contributorId: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contributor = await prisma.user.create({
    data: { authMethod: AuthMethod.email, email: `counter-recount-${suffix}@local.test`, displayName: "Recount Fixture" },
  });
  createdUserIds.push(contributor.id);

  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: contributor.id,
      kind: BountyKind.community,
      status: opts.status ?? BountyStatus.active,
      title: `counter-recount fixture ${suffix}`,
      description: "fixture pool for accepted-item counter recount",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(opts.targetItems),
      acceptedItems: BigInt(opts.acceptedItems ?? opts.targetItems),
      finalAcceptedItems: BigInt(opts.finalAcceptedItems ?? 0),
      // Must stay below targetItems (bounties_required_sponsor_examples_bounds).
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 20,
      holdDays: 0,
      karmaPerAcceptedItem: 25,
      poolClosedAt: opts.poolClosedAt ?? null,
      poolSamplingStartedAt: opts.poolSamplingStartedAt ?? null,
      poolSamplingCompletedAt: opts.poolSamplingCompletedAt ?? null,
      disputeCycleWindowOpensAt: opts.disputeCycleWindowOpensAt ?? null,
      disputeCycleSettledAt: opts.disputeCycleSettledAt ?? null,
    },
  });
  createdBountyIds.push(bounty.id);

  const rows: Prisma.SubmissionCreateManyInput[] = [];
  let n = 0;
  for (const { status, count } of opts.statuses) {
    for (let i = 0; i < count; i++) {
      n++;
      rows.push({
        bountyId: bounty.id,
        contributorUserId: contributor.id,
        title: `item ${n} (${status})`,
        payloadJson: { prompt: `item ${n}` },
        generationMethod: GenerationMethod.human,
        status,
        acceptedAt: status === SubmissionStatus.accepted ? new Date() : null,
      });
    }
  }
  if (rows.length > 0) await prisma.submission.createMany({ data: rows });

  return { bountyId: bounty.id, contributorId: contributor.id };
}

const samplingJobs = (bountyId: string) => prisma.jobQueue.count({ where: { idempotencyKey: `pool-sample:${bountyId}` } });
const closeLogs = (bountyId: string) => prisma.adminAuditLog.count({ where: { targetId: bountyId, action: "community_pool.closed" } });
const reopenLogs = (bountyId: string) => prisma.adminAuditLog.count({ where: { targetId: bountyId, action: "community_pool.reopened" } });

describe("recomputeAcceptedItemCounters", () => {
  it("(a) flagging a slot-holding in_audit item releases its slot; the pool stays open and a new item can claim it", async () => {
    // Pool at target: 2 accepted + 1 in_audit = 3 slots reserved of 3.
    const { bountyId } = await seedPool({
      targetItems: 3,
      acceptedItems: 3,
      finalAcceptedItems: 2,
      statuses: [
        { status: SubmissionStatus.accepted, count: 2 },
        { status: SubmissionStatus.in_audit, count: 1 },
      ],
    });
    const inAudit = await prisma.submission.findFirstOrThrow({ where: { bountyId, status: SubmissionStatus.in_audit } });

    // A validator flags the sampled item — same shape as submitAuditDecisions:
    // status flip and recount in ONE transaction.
    const result = await prisma.$transaction(async (tx) => {
      await tx.submission.update({ where: { id: inAudit.id }, data: { status: SubmissionStatus.flagged } });
      return recomputeAcceptedItemCounters(tx, bountyId);
    });

    expect(result).toEqual({ acceptedItems: 2, finalAcceptedItems: 2, poolJustClosed: false, poolJustReopened: false });

    const afterFlag = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(Number(afterFlag.acceptedItems)).toBe(2);
    expect(Number(afterFlag.finalAcceptedItems)).toBe(2);
    expect(afterFlag.poolClosedAt).toBeNull();
    expect(await samplingJobs(bountyId)).toBe(0);

    // The released slot is claimable again through the existing atomic gate.
    const claimed = await prisma.$transaction((tx) => claimPoolAcceptanceSlot(tx, bountyId));
    expect(claimed).toBe(true);
    const afterClaim = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(Number(afterClaim.acceptedItems)).toBe(3);

    // And the pool is genuinely full again: a fourth claim is refused.
    expect(await prisma.$transaction((tx) => claimPoolAcceptanceSlot(tx, bountyId))).toBe(false);
  });

  it("(b) a pool at target closes exactly once and enqueues sampling exactly once, idempotent on repeat", async () => {
    // Counter already at target, every item accepted or in_audit — the true
    // count IS the target, so the recount must close, not reopen.
    const { bountyId } = await seedPool({
      targetItems: 5,
      acceptedItems: 5,
      finalAcceptedItems: 3,
      statuses: [
        { status: SubmissionStatus.accepted, count: 3 },
        { status: SubmissionStatus.in_audit, count: 2 },
      ],
    });

    const first = await prisma.$transaction((tx) => recomputeAcceptedItemCounters(tx, bountyId));
    expect(first).toEqual({ acceptedItems: 5, finalAcceptedItems: 3, poolJustClosed: true, poolJustReopened: false });

    const closed = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(closed.poolClosedAt).not.toBeNull();

    // Same job, same idempotency key as checkAndClosePoolIfTargetReached and
    // the deadline force-close — downstream cannot tell which path closed it.
    const job = await prisma.jobQueue.findUnique({ where: { idempotencyKey: `pool-sample:${bountyId}` } });
    expect(job).not.toBeNull();
    expect(job!.type).toBe("pool.sampling");
    expect(job!.status).toBe(JobStatus.pending);
    expect(await closeLogs(bountyId)).toBe(1);

    // Repeat (and a concurrent burst): no second close, no second job.
    const repeats = await Promise.all(
      Array.from({ length: 4 }, () => prisma.$transaction((tx) => recomputeAcceptedItemCounters(tx, bountyId))),
    );
    for (const r of repeats) expect(r).toEqual({ acceptedItems: 5, finalAcceptedItems: 3, poolJustClosed: false, poolJustReopened: false });

    const after = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(after.poolClosedAt?.getTime()).toBe(closed.poolClosedAt?.getTime());
    expect(await samplingJobs(bountyId)).toBe(1);
    expect(await closeLogs(bountyId)).toBe(1);
  });

  it("(b') concurrent recounts on a pool crossing its target produce exactly one close", async () => {
    const { bountyId } = await seedPool({
      targetItems: 4,
      acceptedItems: 4,
      statuses: [{ status: SubmissionStatus.accepted, count: 4 }],
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => prisma.$transaction((tx) => recomputeAcceptedItemCounters(tx, bountyId))),
    );
    expect(results.filter((r) => r.poolJustClosed)).toHaveLength(1);
    expect(await samplingJobs(bountyId)).toBe(1);
    expect(await closeLogs(bountyId)).toBe(1);
  });

  it("(d) reopens a genuinely closed pool when a slot-holding item is rejected after close, dropping capacity under target", async () => {
    // Exactly the live production shape: a pool that reached 1000/1000, closed
    // for real (poolClosedAt set, dispute clock started, sampling completed),
    // then one of its accepted items was rejected in human audit — 999/1000.
    const closedAt = new Date(Date.now() - 60_000);
    const { bountyId } = await seedPool({
      targetItems: 3,
      acceptedItems: 3,
      finalAcceptedItems: 3,
      statuses: [{ status: SubmissionStatus.accepted, count: 2 }, { status: SubmissionStatus.in_audit, count: 1 }],
      poolClosedAt: closedAt,
      poolSamplingStartedAt: closedAt,
      poolSamplingCompletedAt: closedAt,
      disputeCycleWindowOpensAt: closedAt,
    });
    const inAudit = await prisma.submission.findFirstOrThrow({ where: { bountyId, status: SubmissionStatus.in_audit } });

    // A validator rejects the sampled item post-close — same shape as the
    // real audit-decision call site (services/audits.ts): status flip and
    // recount in ONE transaction.
    const result = await prisma.$transaction(async (tx) => {
      await tx.submission.update({ where: { id: inAudit.id }, data: { status: SubmissionStatus.rejected } });
      return recomputeAcceptedItemCounters(tx, bountyId);
    });
    expect(result).toEqual({ acceptedItems: 2, finalAcceptedItems: 2, poolJustClosed: false, poolJustReopened: true });

    const reopened = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(Number(reopened.acceptedItems)).toBe(2);
    expect(reopened.poolClosedAt).toBeNull();
    expect(reopened.disputeCycleWindowOpensAt).toBeNull();
    expect(reopened.poolSamplingStartedAt).toBeNull();
    expect(reopened.poolSamplingCompletedAt).toBeNull();
    expect(reopened.status).toBe(BountyStatus.active);
    expect(await reopenLogs(bountyId)).toBe(1);

    // The pool is genuinely open again: the freed slot is claimable through
    // the existing atomic gate, and it's listed for contributors again
    // (listOpenPoolsForContributor filters on poolClosedAt: null).
    expect(await prisma.$transaction((tx) => claimPoolAcceptanceSlot(tx, bountyId))).toBe(true);

    // Idempotent: recounting an already-open, still-under-target pool again
    // does not reopen a second time or write a second audit log row.
    const again = await prisma.$transaction((tx) => recomputeAcceptedItemCounters(tx, bountyId));
    expect(again.poolJustReopened).toBe(false);
    expect(await reopenLogs(bountyId)).toBe(1);
  });

  it("(d') reopening a closed pool that had already auto-settled reverts status back to active and clears the settle clock", async () => {
    const closedAt = new Date(Date.now() - 120_000);
    const { bountyId } = await seedPool({
      targetItems: 2,
      acceptedItems: 2,
      finalAcceptedItems: 2,
      statuses: [{ status: SubmissionStatus.accepted, count: 1 }, { status: SubmissionStatus.in_audit, count: 1 }],
      poolClosedAt: closedAt,
      poolSamplingStartedAt: closedAt,
      poolSamplingCompletedAt: closedAt,
      disputeCycleWindowOpensAt: closedAt,
      disputeCycleSettledAt: closedAt,
      status: BountyStatus.completed,
    });
    const inAudit = await prisma.submission.findFirstOrThrow({ where: { bountyId, status: SubmissionStatus.in_audit } });

    const result = await prisma.$transaction(async (tx) => {
      await tx.submission.update({ where: { id: inAudit.id }, data: { status: SubmissionStatus.flagged } });
      return recomputeAcceptedItemCounters(tx, bountyId);
    });
    expect(result.poolJustReopened).toBe(true);

    const reopened = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(reopened.status).toBe(BountyStatus.active);
    expect(reopened.disputeCycleSettledAt).toBeNull();
    expect(reopened.poolClosedAt).toBeNull();
  });

  it("(d'') leaves an admin-set status (disputed/paused/cancelled) untouched on reopen", async () => {
    const closedAt = new Date(Date.now() - 60_000);
    const { bountyId } = await seedPool({
      targetItems: 2,
      acceptedItems: 2,
      finalAcceptedItems: 2,
      statuses: [{ status: SubmissionStatus.accepted, count: 1 }, { status: SubmissionStatus.in_audit, count: 1 }],
      poolClosedAt: closedAt,
      disputeCycleWindowOpensAt: closedAt,
      status: BountyStatus.disputed,
    });
    const inAudit = await prisma.submission.findFirstOrThrow({ where: { bountyId, status: SubmissionStatus.in_audit } });

    const result = await prisma.$transaction(async (tx) => {
      await tx.submission.update({ where: { id: inAudit.id }, data: { status: SubmissionStatus.rejected } });
      return recomputeAcceptedItemCounters(tx, bountyId);
    });
    expect(result.poolJustReopened).toBe(true);

    const reopened = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(reopened.status).toBe(BountyStatus.disputed);
    expect(reopened.poolClosedAt).toBeNull();
  });
});

describe("reconcileOpenCommunityPools (self-healing sweep)", () => {
  it("(c) reopens a pool whose counter says full but holds a flagged row, and closes one whose true count is at target", async () => {
    // Shape 1 — the live bug: stored acceptedItems = target, poolClosedAt
    // null, 999 accepted + 1 flagged still holding its slot.
    const stuckOpen = await seedPool({
      targetItems: 1000,
      acceptedItems: 1000,
      finalAcceptedItems: 999,
      statuses: [
        { status: SubmissionStatus.accepted, count: 999 },
        { status: SubmissionStatus.flagged, count: 1 },
      ],
    });
    // Shape 2 — counter reached target under an earlier code version but the
    // close-out never ran: 1000 accepted, poolClosedAt null.
    const stuckFull = await seedPool({
      targetItems: 1000,
      acceptedItems: 1000,
      finalAcceptedItems: 1000,
      statuses: [{ status: SubmissionStatus.accepted, count: 1000 }],
    });

    const outcome = await reconcileOpenCommunityPools(10_000);
    expect(outcome.scanned).toBeGreaterThanOrEqual(2);
    expect(outcome.corrected).toBeGreaterThanOrEqual(1);
    expect(outcome.closed).toBeGreaterThanOrEqual(1);

    // Shape 1: capacity reopened by exactly the flagged item; still open; no
    // sampling job; the freed slot is claimable.
    const reopened = await prisma.bounty.findUniqueOrThrow({ where: { id: stuckOpen.bountyId } });
    expect(Number(reopened.acceptedItems)).toBe(999);
    expect(Number(reopened.finalAcceptedItems)).toBe(999);
    expect(reopened.poolClosedAt).toBeNull();
    expect(await samplingJobs(stuckOpen.bountyId)).toBe(0);
    expect(await prisma.$transaction((tx) => claimPoolAcceptanceSlot(tx, stuckOpen.bountyId))).toBe(true);

    // Shape 2: closed, sampling enqueued once, evidence written.
    const closed = await prisma.bounty.findUniqueOrThrow({ where: { id: stuckFull.bountyId } });
    expect(Number(closed.acceptedItems)).toBe(1000);
    expect(Number(closed.finalAcceptedItems)).toBe(1000);
    expect(closed.poolClosedAt).not.toBeNull();
    expect(await samplingJobs(stuckFull.bountyId)).toBe(1);
    expect(await closeLogs(stuckFull.bountyId)).toBe(1);

    // Second tick is a no-op: nothing re-closes, nothing re-enqueues, and a
    // now-closed pool is no longer scanned.
    const firstCloseAt = closed.poolClosedAt!.getTime();
    await reconcileOpenCommunityPools(10_000);
    const again = await prisma.bounty.findUniqueOrThrow({ where: { id: stuckFull.bountyId } });
    expect(again.poolClosedAt?.getTime()).toBe(firstCloseAt);
    expect(await samplingJobs(stuckFull.bountyId)).toBe(1);
    expect(await closeLogs(stuckFull.bountyId)).toBe(1);
  });

  it("leaves a healthy open pool untouched", async () => {
    const healthy = await seedPool({
      targetItems: 10,
      acceptedItems: 3,
      finalAcceptedItems: 1,
      statuses: [
        { status: SubmissionStatus.accepted, count: 1 },
        { status: SubmissionStatus.accepted_pending_sample, count: 1 },
        { status: SubmissionStatus.in_sponsor_review, count: 1 },
        { status: SubmissionStatus.rejected, count: 4 },
      ],
    });
    const before = await prisma.bounty.findUniqueOrThrow({ where: { id: healthy.bountyId } });
    await reconcileOpenCommunityPools(10_000);
    const after = await prisma.bounty.findUniqueOrThrow({ where: { id: healthy.bountyId } });
    expect(Number(after.acceptedItems)).toBe(3);
    expect(Number(after.finalAcceptedItems)).toBe(1);
    expect(after.poolClosedAt).toBeNull();
    // No write happened at all when the counters already matched.
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await samplingJobs(healthy.bountyId)).toBe(0);
  });
});
