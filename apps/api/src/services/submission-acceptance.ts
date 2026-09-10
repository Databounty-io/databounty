// SPDX-License-Identifier: Apache-2.0

import { BountyKind, BountyStatus, SubmissionStatus, type Prisma } from "@prisma/client";
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
  /** True only for the call that actually flipped `poolClosedAt` back to
   * null because the recounted capacity fell back under target. */
  poolJustReopened: boolean;
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
 *
 * REOPEN. Closing is NOT one-shot in practice, whatever the schema comment on
 * `Bounty.poolClosedAt` used to claim — a closed pool's capacity can still
 * drop below target afterward (a validator flags an `in_audit` item, an
 * admin overturns a dispute to `rejected`), and nothing brought the pool back
 * open when that happened. Verified live: a bounty that hit 1000/1000,
 * closed, then had one accepted item rejected in human audit sat permanently
 * closed at 999/1000 — invisible to every contributor despite genuinely
 * having a free slot. So the symmetric case: if the bounty is a community
 * pool that is currently closed, has a positive target, and the recounted
 * capacity has fallen back under it, `poolClosedAt` (and the dispute-review
 * clock `disputeCycleWindowOpensAt`, which must not keep counting down toward
 * a settlement the pool no longer deserves) are cleared through the same
 * `poolClosedAt: { not: null }` compare-and-swap, so two concurrent recounts
 * can't double-fire the reopen either. The sampling markers
 * (`poolSamplingStartedAt`/`poolSamplingCompletedAt`) are cleared too: they
 * gate `runPoolSamplingJob` on a per-bounty "already ran" flag, and leaving
 * them set would make a legitimate future re-close's re-enqueued sampling job
 * silently no-op instead of actually sampling the newly-accepted item(s). If
 * `settleDueCommunityPools` had already auto-settled the pool to
 * `completed`/`partially_completed` before this recount ran, that is reverted
 * to `active` (and `disputeCycleSettledAt` cleared) too — a pool an admin
 * explicitly moved to `disputed`/`paused`/`cancelled` is left alone, same
 * carve-out `settleDueCommunityPools` itself applies. See
 * `services/pool-lifecycle.ts` and `services/karma-holds.ts` for why each of
 * those was safe to touch here (nothing else assumes `poolClosedAt` is
 * permanent once written).
 */
export async function recomputeAcceptedItemCounters(
  tx: Prisma.TransactionClient,
  bountyId: string,
  now = new Date()
): Promise<AcceptedItemCounters> {
  await tx.$queryRaw`SELECT id FROM bounties WHERE id = ${bountyId} FOR UPDATE`;
  const bounty = await tx.bounty.findUnique({
    where: { id: bountyId },
    select: {
      kind: true,
      status: true,
      targetItems: true,
      acceptedItems: true,
      finalAcceptedItems: true,
      poolClosedAt: true,
    },
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

  // Symmetric reopen: a pool that is currently closed but whose recounted
  // capacity has fallen back under target (a slot-holding item left the
  // counted set after close — flagged in human audit, rejected on a
  // dispute overturn) gets the close undone through the same CAS pattern.
  const shouldReopen =
    bounty.kind === BountyKind.community && bounty.poolClosedAt !== null && target > 0 && acceptedItems < target;

  let poolJustReopened = false;
  if (shouldReopen) {
    // If settleDueCommunityPools already auto-settled this pool to a
    // terminal status before this recount ran, undo that too — a pool
    // sitting at `completed`/`partially_completed` never shows up in
    // listOpenPoolsForContributor's `status: active` filter no matter what
    // poolClosedAt says, so reopening capacity without reopening status
    // would leave the pool exactly as unreachable as before. Never override
    // a status an admin explicitly set (disputed/paused/cancelled) —
    // settleDueCommunityPools carves out the same set for the same reason.
    const wasAutoSettled = bounty.status === BountyStatus.completed || bounty.status === BountyStatus.partially_completed;

    const claim = await tx.bounty.updateMany({
      where: { id: bountyId, poolClosedAt: { not: null } },
      data: {
        poolClosedAt: null,
        disputeCycleWindowOpensAt: null,
        // One-shot markers for the sampling job that just ran (or is
        // in-flight) — leaving them set would make a future re-close's
        // re-enqueued `pool.sampling` job see `poolSamplingCompletedAt`
        // still stamped and no-op instead of actually sampling the newly
        // accepted item(s).
        poolSamplingStartedAt: null,
        poolSamplingCompletedAt: null,
        ...(wasAutoSettled ? { status: BountyStatus.active, disputeCycleSettledAt: null } : {}),
      },
    });
    poolJustReopened = claim.count === 1;

    if (poolJustReopened) {
      await writeAuditLog(tx, {
        actorUserId: null,
        action: "community_pool.reopened",
        targetType: "bounty",
        targetId: bountyId,
        before: { poolClosedAt: bounty.poolClosedAt ? bounty.poolClosedAt.toISOString() : null, status: bounty.status },
        after: { poolClosedAt: null, status: wasAutoSettled ? BountyStatus.active : bounty.status },
        metadata: {
          trigger: "pool_capacity_dropped_below_target",
          targetItems: String(target),
          acceptedItems: String(acceptedItems),
          finalAcceptedItems: String(finalAcceptedItems),
          revertedAutoSettle: String(wasAutoSettled),
        },
      });
    }
  }

  return { acceptedItems, finalAcceptedItems, poolJustClosed, poolJustReopened };
}
