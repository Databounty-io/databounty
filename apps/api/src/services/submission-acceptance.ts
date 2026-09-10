// SPDX-License-Identifier: Apache-2.0

import { BountyKind, SubmissionStatus, type Prisma } from "@prisma/client";
import { writeAuditLog } from "../lib/audit-log.js";
import { enqueuePoolSampling } from "./pool-lifecycle.js";

/**
 * Submission statuses that hold one unit of a community pool's intake
 * capacity (`Bounty.acceptedItems`, COMMUNITY_OPEN_POOL_PLAN_V2 §3.2b/§3.2d).
 *
 *  - `accepted`: final.
 *  - `accepted_pending_sample`: cleared automation, waiting for close-out
 *    sampling — must close the intake window (§3.3).
 *  - `in_audit`: a sampled item still occupies its slot while a validator
 *    decides it. Excluding it made every pool counter drop the moment a
 *    window routed work to audit.
 *  - `in_sponsor_review` (§3.3c): provisionally accepted pending the sponsor,
 *    exactly like `accepted_pending_sample` for capacity purposes.
 *
 * Everything else (`flagged`, `disputed`, `rejected`, `needs_fixes`,
 * `tests_failed`, ...) has left the counted set and its slot is free again.
 * This deployment's `SubmissionStatus` enum has no `paid` value (there is no
 * paid track), so v1's `paid` member is deliberately absent here.
 */
export const POOL_CAPACITY_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.accepted,
  SubmissionStatus.accepted_pending_sample,
  SubmissionStatus.in_audit,
  SubmissionStatus.in_sponsor_review,
];

/** Statuses that count as FINAL acceptance (`Bounty.finalAcceptedItems`). */
export const FINAL_ACCEPTED_STATUSES: SubmissionStatus[] = [SubmissionStatus.accepted];

export interface AcceptedItemCounters {
  acceptedItems: number;
  finalAcceptedItems: number;
  /** True only for the call that actually flipped `poolClosedAt` from null. */
  poolJustClosed: boolean;
}

/**
 * Set `bounties.accepted_items` / `final_accepted_items` to the truth held in
 * `submissions.status`, and close the pool if that truth has reached the
 * target. Ported from v1 `services/submission-acceptance.ts`
 * (`recomputeAcceptedItemCounters`) minus its pilot/funded branches, which
 * this community-only schema does not have.
 *
 * WHY A RECOUNT AND NOT A DELTA. `claimPoolAcceptanceSlot`
 * (services/pool-lifecycle.ts) is the race-safe intake gate: it is the only
 * thing that may INCREMENT `acceptedItems`, and it is exact by construction.
 * But nothing ever brought the counter back DOWN when a slot-holding item
 * left the counted set — a validator flagging an `in_audit` item, an admin
 * resolving a dispute to `rejected`, a sponsor sending an item back for
 * revision. Verified live: pools showing "1000 / 1000 capacity reserved"
 * with 989/998/999 final accepts and dozens of `flagged`/`rejected` rows
 * still holding their slots, never closing and never reopening. A recount
 * derives both counters from the durable fact instead of accumulating
 * deltas, so it is idempotent (calling it twice is a no-op), it heals any
 * pre-existing drift on the next call, and it can never be skewed by a
 * lost, duplicated or retried call.
 *
 * SAFETY UNDER READ COMMITTED. The bounty row is locked `FOR UPDATE` first,
 * so two concurrent recounts for the same bounty serialise; the loser blocks
 * on the lock and, once the winner commits, its own `count(*)` statements run
 * against the latest committed snapshot and see the winner's writes.
 * `claimPoolAcceptanceSlot`'s conditional UPDATE takes the same row lock, so
 * a claim and a recount never interleave inside one another either.
 *
 * MUST run on the same `tx` as the submission status flip that motivated it,
 * so the counters and the submission set commit or roll back together.
 *
 * CLOSE-OUT. If the bounty is a community pool that is still open, has a
 * positive target, and the recounted capacity has reached it, `poolClosedAt`
 * is set through the same `poolClosedAt: null` compare-and-swap that
 * `checkAndClosePoolIfTargetReached` uses, and the `pool.sampling` job is
 * enqueued under the same idempotency key — the downstream pipeline cannot
 * tell which path closed the pool. Only the caller that wins the CAS
 * enqueues, so a pool is closed and sampled exactly once.
 */
export async function recomputeAcceptedItemCounters(
  tx: Prisma.TransactionClient,
  bountyId: string,
  now = new Date()
): Promise<AcceptedItemCounters> {
  await tx.$queryRaw`SELECT id FROM bounties WHERE id = ${bountyId} FOR UPDATE`;
  const bounty = await tx.bounty.findUnique({
    where: { id: bountyId },
    select: { kind: true, targetItems: true, acceptedItems: true, finalAcceptedItems: true, poolClosedAt: true },
  });
  if (!bounty) throw new Error(`bounty ${bountyId} not found while recomputing accepted-item counters`);

  const acceptedItems = await tx.submission.count({
    where: { bountyId, status: { in: POOL_CAPACITY_STATUSES } },
  });
  const finalAcceptedItems = await tx.submission.count({
    where: { bountyId, status: { in: FINAL_ACCEPTED_STATUSES } },
  });

  // Write only when something actually changed: the sweep in
  // reconcileOpenCommunityPools calls this on every open pool, and an
  // unconditional update would bump `updatedAt` on rows nothing happened to.
  if (Number(bounty.acceptedItems) !== acceptedItems || Number(bounty.finalAcceptedItems) !== finalAcceptedItems) {
    await tx.bounty.update({
      where: { id: bountyId },
      data: { acceptedItems: BigInt(acceptedItems), finalAcceptedItems: BigInt(finalAcceptedItems) },
    });
  }

  const target = Number(bounty.targetItems);
  const shouldClose =
    bounty.kind === BountyKind.community && bounty.poolClosedAt === null && target > 0 && acceptedItems >= target;

  let poolJustClosed = false;
  if (shouldClose) {
    // Starts the dispute-review clock in the SAME write as the close, not a
    // later step: `disputeCycleWindowOpensAt` gates both karma-hold release
    // (services/karma-holds.ts `holdReleasesAt`) and, via
    // `settleDueCommunityPools` below, the pool's own final delivered status.
    // Before this, closing a pool set `poolClosedAt` and nothing else ever
    // wrote this column — karma-holds.ts's own doc comment called it out as
    // "currently written by nothing" — so a fully-resolved pool had no clock
    // running and could never settle into `completed`/`partially_completed`.
    const claim = await tx.bounty.updateMany({
      where: { id: bountyId, poolClosedAt: null },
      data: { poolClosedAt: now, disputeCycleWindowOpensAt: now },
    });
    poolJustClosed = claim.count === 1;
  }

  if (poolJustClosed) {
    await enqueuePoolSampling(bountyId, tx);
    await writeAuditLog(tx, {
      actorUserId: null,
      action: "community_pool.closed",
      targetType: "bounty",
      targetId: bountyId,
      before: { poolClosedAt: null },
      after: { poolClosedAt: now.toISOString() },
      metadata: {
        trigger: "pool_capacity_reserved_target_reached",
        targetItems: String(target),
        acceptedItems: String(acceptedItems),
        finalAcceptedItems: String(finalAcceptedItems),
      },
    });
  }

  return { acceptedItems, finalAcceptedItems, poolJustClosed };
}
