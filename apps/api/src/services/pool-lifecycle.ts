// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";
// `Prisma` is a value import (not `type`) because claimPoolAcceptanceSlot
// builds its atomic UPDATE with Prisma.sql, mirroring the same
// value-vs-type note in services/submissions.ts.
import { BountyKind, BountyStatus, DisputeStatus, KarmaEventType, SubmissionStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { awardOrHoldAcceptedItemKarma, defaultDisputeWindowHours } from "./karma-holds.js";
import { createWindowAuditBatch } from "./audit-routing.js";
import { dbJobQueue } from "./jobs.js";
import { emitAuditAvailableMatches, notifyUser } from "./notifications.js";
import { writeAuditLog } from "../lib/audit-log.js";
import { recomputeAcceptedItemCounters, FINAL_ACCEPTED_STATUSES } from "./submission-acceptance.js";

/**
 * Community open-pool close-out + human-audit-window sampling
 * (COMMUNITY_OPEN_POOL_PLAN_V2 §3.3/§3.3b/§3.3c/§3.3d/§4/§9,
 * docs/engineering/COMMUNITY_OPEN_POOL_PLAN_V2.md).
 *
 * SCOPE DECISION (documented here so it's easy to double-check): the schema
 * carries `Bounty.humanAuditWindowSize` for the doc's §3.3d *rolling*
 * human-audit-window mode (close a window every N automation-cleared items,
 * before the pool fills). That mode is feature-gated behind
 * `community.rolling_human_audit_windows.enabled` per the doc, and nothing in
 * this codebase reads/enqueues on that admin setting or wires the "queue an
 * eligibility job as each item clears" trigger it needs. Building that
 * trigger would be inventing a feature this rebuild has not turned on.
 *
 * What IS real and unconditionally required in this schema: the base
 * §3.3/§3.3c *pool-close-out* mode (windowSize null/0 in the doc's own
 * language — "retains whole-pool close-out"), which every community pool
 * uses today regardless of humanAuditWindowSize. This file implements that
 * mode: HumanAuditWindow rows are opened for a bounty at the moment the
 * pool's target is reached (windowIndex is genuinely incremented per bounty,
 * not hardcoded to 1, so this composes correctly if the rolling mode is
 * wired up later and opens additional windows for the same bounty).
 *
 * WINDOW SIZE (the admin control, previously a placebo): the selected set is
 * still drawn by `auditCoveragePct` exactly as before — coverage decides HOW
 * MANY items get human review — and the configured window size decides how
 * that selected set is PACKED into claimable windows, at most `size` selected
 * items each. See `resolveHumanAuditWindowSize` below for precedence and the
 * enforced 50–100 band. `humanAuditFailureThresholdPct` remains read only by
 * services/audits.ts at settle time.
 *
 * Community pools are deliberately open-ended (owner decision D39,
 * 2026-09-09). `Bounty.deadline` remains nullable for schema compatibility,
 * but no Community mint path assigns it and no worker closes a pool because
 * time elapsed. A pool closes only after reaching its verified-item target.
 */

const POOL_SAMPLE_JOB_KEY_PREFIX = "pool-sample:";

/**
 * How many selected (human-review) submissions one HumanAuditWindow may hold
 * — the unit of work a validator picks up.
 *
 * The owner's requirement is "the validator claims a batch, 50–100, adjustable
 * from admin", so the band is enforced HERE as well as at the settings write
 * boundary: a stored value outside it (including the catalog's current
 * default of 10, which predates the requirement) is clamped rather than
 * obeyed, and a missing/malformed row falls back to the low end. Failing
 * toward MIN, not MAX, is the fail-closed choice: a smaller window means more,
 * smaller claimable units, never one unbounded window that a single validator
 * could sit on.
 *
 * Precedence, highest first:
 *   1. `Bounty.humanAuditWindowSize` — the per-bounty override the schema
 *      already carries (nullable; unset on every bounty in this deployment).
 *   2. `community.human_audit_window_size` — the platform admin setting.
 *   3. HUMAN_AUDIT_WINDOW_SIZE_DEFAULT.
 *
 * Read inside the sampling transaction on the same `tx` (mirrors v1's
 * `openPoolAuditBatchCapacity`, services/audit-routing.ts) rather than
 * memoised: sampling runs once per pool close-out, so one extra indexed read
 * is cheaper than reasoning about a stale cap, and an admin who changes the
 * size sees it take effect on the very next close-out with no redeploy.
 */
export const HUMAN_AUDIT_WINDOW_SIZE_MIN = 50;
export const HUMAN_AUDIT_WINDOW_SIZE_MAX = 100;
export const HUMAN_AUDIT_WINDOW_SIZE_DEFAULT = HUMAN_AUDIT_WINDOW_SIZE_MIN;

export function clampHumanAuditWindowSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return Math.min(HUMAN_AUDIT_WINDOW_SIZE_MAX, Math.max(HUMAN_AUDIT_WINDOW_SIZE_MIN, value));
}

export async function resolveHumanAuditWindowSize(
  tx: Prisma.TransactionClient,
  bountyWindowSize?: number | null
): Promise<number> {
  const perBounty = clampHumanAuditWindowSize(bountyWindowSize);
  if (perBounty !== null) return perBounty;
  const row = await tx.adminSetting.findUnique({ where: { key: "community.human_audit_window_size" } });
  return clampHumanAuditWindowSize(row?.value) ?? HUMAN_AUDIT_WINDOW_SIZE_DEFAULT;
}

/**
 * Deterministic, verifiable, non-gameable member ranking for a window.
 * HMAC-SHA256 keyed on a server-only secret over the immutable
 * (bountyId, windowId, submissionId) tuple — nobody (not even an admin
 * reading the DB) can predict a not-yet-computed rank without the key, and
 * the same inputs always reproduce the same rank, so a crash-and-replay of
 * the sampling job (guarded idempotent below) recomputes identical output
 * rather than re-rolling the dice. Never logged or persisted anywhere but
 * the membership row's own `rank` column.
 */
function hmacRank(bountyId: string, windowId: string, submissionId: string): string {
  return createHmac("sha256", config.poolSamplingHmacSecret).update(`${bountyId}:${windowId}:${submissionId}`).digest("hex");
}

/**
 * The single atomic accept-time capacity gate (COMMUNITY_OPEN_POOL_PLAN_V2
 * §4 — "Pool close-out race safety"). This is the ONLY place that may
 * increment `Bounty.acceptedItems`; every call site that used to do a plain
 * `bounty.update({ data: { acceptedItems: { increment: 1 } } } })` must route
 * through here instead (see services/validation.ts's two accept-time call
 * sites).
 *
 * BUG THIS CLOSES: the pre-existing intake check in
 * services/submissions.ts's `createBountyPoolItems` (`target > 0 &&
 * acceptedItems >= target`) only ever sees the pool's state at SUBMISSION
 * time. For a fast-moving pool a few items short of its target, that read is
 * stale by the time THIS item is actually accepted — dedupe, execution, and
 * LLM review all run in between, possibly much later. If N items are all
 * mid-pipeline concurrently when the pool has room for only one more, every
 * one of them saw "not full yet" at intake and every one of them would
 * previously reach the unconditional `increment: 1` and all succeed,
 * overshooting `targetItems` by up to N-1. Observed live: "E2E
 * validator-reject action test" (target 1, accepted hit 2) and "FULL LOOP
 * E2E REGRESSION" (target 100, accepted hit 106).
 *
 * The fix is a single conditional UPDATE — mirrors the doc's own proposed
 * SQL and the same compare-and-swap idiom already used by this codebase's
 * other accept-time races (the `updateMany` guard below, and the raw-SQL
 * `revision_count + 1 ... AND revision_count < maxRevisions` claim in
 * services/submissions.ts's reviseSubmission). Postgres serialises concurrent
 * UPDATEs on the same row, so of N concurrent callers only as many can match
 * `accepted_items < target_items` as there is room for; every other caller's
 * WHERE re-evaluates against the already-incremented row and updates zero
 * rows. A read-then-check-then-increment (what every call site did before)
 * lets every caller pass the check because none of them see each other's
 * write until after they've all already decided to proceed.
 *
 * `targetItems <= 0` means uncapped (mirrors the intake check's own `target >
 * 0` guard), so the WHERE short-circuits true and the increment always wins.
 *
 * MUST be called on the same `tx` as the submission's own status flip, so the
 * two commit or roll back together — a caller that increments the counter
 * but then fails to flip the submission's status (or vice versa) would leave
 * the counter and the submission set out of sync.
 *
 * Returns `true` if this call won the slot (the increment happened — the
 * caller may accept the submission), `false` if the pool was already full
 * (the caller MUST NOT accept the submission; it must record a real,
 * visible, non-quality-reason terminal outcome instead — see the two call
 * sites in services/validation.ts for exactly what that outcome is).
 */
export async function claimPoolAcceptanceSlot(tx: Prisma.TransactionClient, bountyId: string): Promise<boolean> {
  const claimed = await tx.$queryRaw<{ accepted_items: bigint }[]>(Prisma.sql`
    UPDATE bounties
       SET accepted_items = accepted_items + 1
     WHERE id = ${bountyId}
       AND (target_items <= 0 OR accepted_items < target_items)
    RETURNING accepted_items
  `);
  return claimed.length === 1;
}

/**
 * Call after any write that can push `Bounty.acceptedItems` (the "cleared
 * automation" intake counter, §3.2d) up to `targetItems`. Atomically closes
 * the pool exactly once (`poolClosedAt` is one-shot, §9) and enqueues the
 * sampling job. Safe to call redundantly — the `updateMany` guarded on
 * `poolClosedAt: null` is a single-statement compare-and-swap, so only the
 * caller that actually crosses the target wins the close, even under
 * concurrent submissions landing at the same instant.
 */
export async function checkAndClosePoolIfTargetReached(bountyId: string): Promise<void> {
  const bounty = await prisma.bounty.findUnique({
    where: { id: bountyId },
    select: { kind: true, targetItems: true, acceptedItems: true, poolClosedAt: true },
  });
  if (!bounty || bounty.kind !== BountyKind.community) return;

  const target = Number(bounty.targetItems);
  if (target <= 0) return;
  if (Number(bounty.acceptedItems) < target) return;
  if (bounty.poolClosedAt) return;

  const closedAt = new Date();
  // Same reasoning as the twin close path in submission-acceptance.ts
  // `recomputeAcceptedItemCounters`: the dispute-review clock starts in the
  // SAME write as the close, not a later step, or a pool that closes through
  // this path (the direct post-increment check, not the periodic recount)
  // never gets a clock at all.
  const claim = await prisma.bounty.updateMany({
    where: { id: bountyId, poolClosedAt: null },
    data: { poolClosedAt: closedAt, disputeCycleWindowOpensAt: closedAt },
  });
  if (claim.count === 0) return; // another writer already closed this pool

  await enqueuePoolSampling(bountyId);
}

/**
 * The one `pool.sampling` enqueue every close-out path shares (natural
 * target-reached close above, the deadline force-close below, and the
 * recount in services/submission-acceptance.ts). One idempotency key per
 * bounty, so however many paths decide a pool is closed, one sampling job
 * exists for it.
 */
export async function enqueuePoolSampling(bountyId: string, tx?: Prisma.TransactionClient): Promise<void> {
  await dbJobQueue.enqueue(
    {
      type: "pool.sampling",
      idempotencyKey: `${POOL_SAMPLE_JOB_KEY_PREFIX}${bountyId}`,
      payload: { bountyId },
    },
    tx
  );
}

export interface PoolReconcileOutcome {
  /** Open community pools whose counters were recounted this tick. */
  scanned: number;
  /** Pools whose stored `acceptedItems`/`finalAcceptedItems` disagreed with
   * their submissions and were corrected (capacity reopened or tightened). */
  corrected: number;
  /** Pools the recount closed because the true capacity count had already
   * reached the target. */
  closed: number;
}

/**
 * Self-healing counter sweep for OPEN community pools. Runs from the
 * `pool-reconcile-and-settle` worker tick (src/worker.ts).
 *
 * WHY. Until `recomputeAcceptedItemCounters` was wired into every membership
 * transition, `Bounty.acceptedItems` only ever went UP (the atomic
 * `claimPoolAcceptanceSlot` gate) and `checkAndClosePoolIfTargetReached` only
 * ran at accept time. Two live failure shapes followed, both verified on the
 * dev deployment and the staging snapshot:
 *
 *  1. Items that had reserved a slot were later flagged/rejected/sent back,
 *     but kept their slot forever — a pool read "1000 / 1000 reserved" with
 *     989 final accepts and 129 `flagged` rows, so nobody could contribute
 *     the 11 missing items and the pool could never fill honestly.
 *  2. A pool whose counter reached the target under an earlier code version
 *     never had the close-out path run for it, so `poolClosedAt` stayed null
 *     with no `pool.sampling` job — stuck indefinitely.
 *
 * Every transition now recounts inline, so new drift cannot be created; this
 * sweep repairs the drift that already exists and any that a crash between
 * "submission committed" and "close-out enqueued" could still leave. It is
 * a recount per pool — idempotent, harmless when nothing is wrong (a pool
 * whose counters already match is not written to at all).
 *
 * Bounded (`limit`, oldest-updated first) and one transaction per pool, for
 * the same fault-isolation reasons: one failing pool must
 * not roll back its neighbours, and no connection is pinned across an
 * unbounded set. A pool that is corrected gets a fresh `updatedAt`, so it
 * naturally falls to the back of the queue for the next tick.
 */
export async function reconcileOpenCommunityPools(limit = 200): Promise<PoolReconcileOutcome> {
  const open = await prisma.bounty.findMany({
    where: { kind: BountyKind.community, poolClosedAt: null },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, limit),
    select: { id: true, acceptedItems: true, finalAcceptedItems: true },
  });

  const outcome: PoolReconcileOutcome = { scanned: 0, corrected: 0, closed: 0 };
  for (const pool of open) {
    outcome.scanned += 1;
    const result = await prisma.$transaction((tx) => recomputeAcceptedItemCounters(tx, pool.id));
    if (
      result.acceptedItems !== Number(pool.acceptedItems) ||
      result.finalAcceptedItems !== Number(pool.finalAcceptedItems)
    ) {
      outcome.corrected += 1;
    }
    if (result.poolJustClosed) outcome.closed += 1;
  }
  return outcome;
}

export interface PoolSettleOutcome {
  scanned: number;
  settled: number;
  completed: number;
  partiallyCompleted: number;
}

/**
 * Settle every CLOSED community pool whose dispute-review window has
 * elapsed: stamp `disputeCycleSettledAt` and flip `status` to a terminal,
 * publicly-delivered value.
 *
 * This was the missing final step of the whole pool lifecycle. Closing
 * (`poolClosedAt`) and the sampling/audit pipeline it kicks off both already
 * worked; nothing anywhere ever moved `Bounty.status` off `active` once a
 * pool finished, so a fully-resolved pool sat `active` forever and never
 * appeared on the public "delivered datasets" listing
 * (`lib/public-query.ts`'s `delivered` filter: `export_ready | completed |
 * partially_completed`) no matter how long ago it actually finished.
 *
 * `completed` vs `partially_completed`: whether every accepted item made it
 * all the way to final acceptance, not just whether the pool closed —
 * `finalAcceptedItems` (the `FINAL_ACCEPTED_STATUSES` count) can legitimately
 * land short of `targetItems` when some accepted-pending-sample items are
 * later rejected in audit. Read as of NOW rather than the values recorded at
 * close time, so a pool disputed/reduced after closing still reports its
 * true final shape at settle time, not a stale snapshot.
 *
 * Only acts on `status: active` — a pool an admin has separately moved to
 * `disputed`, `paused`, or `cancelled` is left alone; this function is not
 * the place to override an explicit operator decision.
 *
 * Idempotent per pool via the same `disputeCycleSettledAt: null` compare-
 * and-swap pattern the rest of this file uses: `outcome.settled` only counts
 * the caller that actually wins the update, so two concurrent sweep ticks
 * settle a pool exactly once.
 */
export async function settleDueCommunityPools(limit = 200): Promise<PoolSettleOutcome> {
  const defaultHours = await defaultDisputeWindowHours();
  const due = await prisma.bounty.findMany({
    where: {
      kind: BountyKind.community,
      status: BountyStatus.active,
      poolClosedAt: { not: null },
      disputeCycleSettledAt: null,
    },
    orderBy: { poolClosedAt: "asc" },
    take: Math.max(1, limit),
    select: { id: true, disputeCycleWindowOpensAt: true, disputeWindowHours: true, targetItems: true },
  });

  const outcome: PoolSettleOutcome = { scanned: 0, settled: 0, completed: 0, partiallyCompleted: 0 };
  const now = new Date();
  for (const bounty of due) {
    outcome.scanned += 1;
    // No opens-at recorded (a pool closed before this fix shipped, or the
    // direct-increment close path raced ahead of a deploy): treat this sweep
    // tick as the open, same as the close paths do, rather than settling
    // instantly with zero review window.
    const opensAt = bounty.disputeCycleWindowOpensAt ?? now;
    if (bounty.disputeCycleWindowOpensAt === null) {
      await prisma.bounty.update({ where: { id: bounty.id }, data: { disputeCycleWindowOpensAt: opensAt } });
      continue;
    }
    const windowHours = bounty.disputeWindowHours ?? defaultHours;
    const settlesAt = new Date(opensAt.getTime() + windowHours * 60 * 60 * 1000);
    if (now < settlesAt) continue;

    // An open dispute means the pool is not actually clean, whatever its
    // window timestamp says — nothing in the current dispute-file routes
    // resets `disputeCycleWindowOpensAt` to null the way the design doc
    // describes, so this is the only thing standing between an elapsed
    // window and force-settling a bounty a sponsor is actively disputing.
    const openDispute = await prisma.dispute.findFirst({
      where: { bountyId: bounty.id, status: DisputeStatus.open },
      select: { id: true },
    });
    if (openDispute) continue;

    const result = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction: a dispute filed between the read
      // above and this transaction starting must still block the settle.
      const stillOpenDispute = await tx.dispute.findFirst({
        where: { bountyId: bounty.id, status: DisputeStatus.open },
        select: { id: true },
      });
      if (stillOpenDispute) return null;

      // Re-read inside the transaction: recount from real submission rows,
      // the same source of truth `recomputeAcceptedItemCounters` uses,
      // never the possibly-stale cached column.
      const finalAcceptedItems = await tx.submission.count({
        where: { bountyId: bounty.id, status: { in: FINAL_ACCEPTED_STATUSES } },
      });
      const target = Number(bounty.targetItems);
      const nextStatus =
        target > 0 && finalAcceptedItems >= target ? BountyStatus.completed : BountyStatus.partially_completed;
      const claim = await tx.bounty.updateMany({
        where: { id: bounty.id, disputeCycleSettledAt: null },
        data: { disputeCycleSettledAt: now, status: nextStatus, finalAcceptedItems: BigInt(finalAcceptedItems) },
      });
      if (claim.count === 0) return null; // another tick already settled this one
      await writeAuditLog(tx, {
        actorUserId: null,
        action: "community_pool.settled",
        targetType: "bounty",
        targetId: bounty.id,
        before: { status: "active", disputeCycleSettledAt: null },
        after: { status: nextStatus, disputeCycleSettledAt: now.toISOString() },
        metadata: {
          trigger: "dispute_window_elapsed",
          targetItems: String(target),
          finalAcceptedItems: String(finalAcceptedItems),
          disputeWindowHours: String(windowHours),
        },
      });
      return nextStatus;
    });

    if (result === BountyStatus.completed) {
      outcome.settled += 1;
      outcome.completed += 1;
    } else if (result === BountyStatus.partially_completed) {
      outcome.settled += 1;
      outcome.partiallyCompleted += 1;
    }
  }
  return outcome;
}

interface SamplingOutcome {
  skipped: boolean;
  reason?: string;
  /** The primary window — the row that records the draw. */
  windowId?: string;
  /** Every window opened by this close-out, primary first (see the packing
   * comment in runPoolSamplingJob: the selected set is split into claimable
   * windows of at most the admin-configured size). */
  windowIds?: string[];
  windowSize?: number;
  eligibleCount?: number;
  selectedCount?: number;
  autoAcceptedCount?: number;
  sponsorReviewCount?: number;
}

/**
 * The `pool.sampling` job handler (`schedulePoolSampling` /
 * `runPoolSamplingJob` in the doc/V1 naming). Resolves every
 * `accepted_pending_sample` item for a closed pool to its real final
 * disposition:
 *
 *  - `auditCoveragePct === 0` (§3.3c, "Piece 2" — no-validator pool): every
 *    eligible item routes to the SPONSOR (`in_sponsor_review`), no
 *    HumanAuditWindow is created at all — the doc is explicit that this mode
 *    creates no window.
 *  - `auditCoveragePct > 0`: opens one real `HumanAuditWindow`, HMAC-ranks
 *    every eligible item, selects `quota` of them for human review PLUS
 *    every `pendingHumanReview` item unconditionally (§3.3b — forced
 *    escalations are guaranteed review, never subject to the coverage dice
 *    roll, and don't consume the quota). Selected items move to `in_audit`
 *    (feeds the existing `HumanAuditWindow`-based validator dashboard in
 *    services/audits.ts unchanged). Unselected items move straight to
 *    `accepted`, get `finalAcceptedItems` incremented, and the contributor's
 *    karma is awarded via the same idempotent `awardKarma` call/pattern the
 *    sponsor-review accept path already uses (routes/v1/bounties.ts).
 *
 * Idempotent and crash-safe: everything (window, memberships, status
 * flips, karma) happens inside one Postgres transaction, guarded at the top
 * by an `updateMany` on `poolSamplingCompletedAt: null` that also acts as a
 * row-lock mutex — a concurrent second run of this job for the same bounty
 * blocks on that UPDATE until the first transaction commits, then sees
 * `poolSamplingCompletedAt` already set and no-ops. A worker crash mid-way
 * rolls the whole transaction back, so a retry starts clean rather than
 * double-sampling or double-awarding.
 */
export async function runPoolSamplingJob(bountyId: string): Promise<SamplingOutcome> {
  const notifications: Array<() => Promise<unknown>> = [];

  const result = await prisma.$transaction(async (tx) => {
    const bounty = await tx.bounty.findUnique({
      where: { id: bountyId },
      include: { datasetType: { select: { domain: true } } },
    });
    if (!bounty || bounty.kind !== BountyKind.community) return { skipped: true, reason: "not_a_community_bounty" };
    if (!bounty.poolClosedAt) return { skipped: true, reason: "pool_not_closed" };
    if (bounty.poolSamplingCompletedAt) return { skipped: true, reason: "already_completed" };

    // Compare-and-swap + row-lock mutex: see doc comment above.
    const claim = await tx.bounty.updateMany({
      where: { id: bountyId, poolSamplingCompletedAt: null },
      data: { poolSamplingStartedAt: bounty.poolSamplingStartedAt ?? new Date() },
    });
    if (claim.count === 0) return { skipped: true, reason: "lost_claim_race" };

    const eligible = await tx.submission.findMany({
      where: { bountyId, status: SubmissionStatus.accepted_pending_sample },
      select: { id: true, contributorUserId: true, title: true, pendingHumanReview: true },
    });

    const sponsorUserId = bounty.communityRequesterUserId ?? bounty.requesterUserId;

    if (eligible.length === 0) {
      await tx.bounty.update({ where: { id: bountyId }, data: { poolSamplingCompletedAt: new Date() } });
      return { skipped: false, eligibleCount: 0, selectedCount: 0, autoAcceptedCount: 0, sponsorReviewCount: 0 };
    }

    // §3.3c "Piece 2": a pool with no validators routes everything to the
    // sponsor at close-out instead of auto-accepting. No window is created.
    if (bounty.auditCoveragePct === 0) {
      await tx.submission.updateMany({
        where: { id: { in: eligible.map((s) => s.id) } },
        data: { status: SubmissionStatus.in_sponsor_review },
      });
      await tx.bounty.update({ where: { id: bountyId }, data: { poolSamplingCompletedAt: new Date() } });

      notifications.push(() =>
        notifyUser({
          userId: sponsorUserId,
          type: "pool.sponsor_review_ready",
          title: "Pool closed — your review is needed",
          body: `"${bounty.title}" reached its item target with no validator coverage configured. ${eligible.length} submission(s) are awaiting your approve/reject decision.`,
          entityType: "Bounty",
          entityId: bountyId,
          linkBountyId: bountyId,
        })
      );
      for (const sub of eligible) {
        notifications.push(() =>
          notifyUser({
            userId: sub.contributorUserId,
            type: "submission.pending_sponsor_review",
            title: "Submission awaiting sponsor review",
            body: `"${sub.title}" cleared automation and is now awaiting the pool requester's direct review (no validator coverage on this pool).`,
            entityType: "Submission",
            entityId: sub.id,
            linkBountyId: bountyId,
          })
        );
      }

      return { skipped: false, eligibleCount: eligible.length, selectedCount: 0, autoAcceptedCount: 0, sponsorReviewCount: eligible.length };
    }

    // Fractional-quota carry-over across windows (§3.3d): read the most
    // recent prior window for this bounty (there may be none — first
    // close-out ever) and continue its leftover remainder rather than
    // resetting to zero every time.
    const priorWindow = await tx.humanAuditWindow.findFirst({
      where: { bountyId },
      orderBy: { windowIndex: "desc" },
      select: { windowIndex: true, carryNumerator: true },
    });
    const windowIndex = (priorWindow?.windowIndex ?? 0) + 1;
    const previousCarry = priorWindow?.carryNumerator ?? 0;

    const numerator = eligible.length * bounty.auditCoveragePct + previousCarry;
    const quota = Math.floor(numerator / 100);
    const thisWindowCarry = numerator % 100;

    const window = await tx.humanAuditWindow.create({
      data: {
        bountyId,
        windowIndex,
        eligibleCount: eligible.length,
        quota,
        carryNumerator: thisWindowCarry,
        closureReason: "pool_target_reached",
      },
    });

    // Forced escalations (pendingHumanReview) are ALWAYS selected regardless
    // of the coverage draw and never consume the quota (§3.3b). The random
    // sample is drawn only from the remaining clean items.
    const forced = eligible.filter((s) => s.pendingHumanReview);
    const clean = eligible.filter((s) => !s.pendingHumanReview);

    const rankedClean = clean
      .map((s) => ({ submission: s, rank: hmacRank(bountyId, window.id, s.id) }))
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));

    const boundedQuota = Math.min(quota, rankedClean.length);
    const randomlySelectedIds = new Set(rankedClean.slice(0, boundedQuota).map((r) => r.submission.id));
    const forcedIds = new Set(forced.map((s) => s.id));

    // Deterministic ordering for the packing below: forced escalations first
    // (they are guaranteed review), then the coverage draw, each group in HMAC
    // rank order. A crash-and-replay of this job recomputes the identical
    // order, so the same submission always lands in the same window.
    const rankIn = (windowId: string, submissionId: string) => hmacRank(bountyId, windowId, submissionId);
    const orderedSelected = [
      ...forced.map((s) => s.id).sort((a, b) => (rankIn(window.id, a) < rankIn(window.id, b) ? -1 : 1)),
      ...rankedClean.filter((r) => randomlySelectedIds.has(r.submission.id)).map((r) => r.submission.id),
    ];

    // Pack the selected set into windows of at most `windowSize` items — the
    // claimable unit. `window` (created above) is the PRIMARY window: it
    // records the pool-wide draw (eligibleCount / quota / carryNumerator) and
    // carries the first chunk of selected items plus every unselected
    // membership row, so the draw still reconciles against real persisted
    // rows. Any overflow chunk opens a continuation window whose
    // eligibleCount/quota are its own selected count and whose closureReason
    // names it as a split of this same close-out.
    const windowSize = await resolveHumanAuditWindowSize(tx, bounty.humanAuditWindowSize);
    const chunks: string[][] = [];
    for (let i = 0; i < orderedSelected.length; i += windowSize) {
      chunks.push(orderedSelected.slice(i, i + windowSize));
    }
    if (chunks.length === 0) chunks.push([]);

    const windowIdByChunk: string[] = [window.id];
    for (let i = 1; i < chunks.length; i++) {
      const extra = await tx.humanAuditWindow.create({
        data: {
          bountyId,
          windowIndex: windowIndex + i,
          eligibleCount: chunks[i]!.length,
          quota: chunks[i]!.length,
          carryNumerator: 0,
          closureReason: "pool_target_reached_window_split",
        },
      });
      windowIdByChunk.push(extra.id);
    }
    if (chunks.length > 1) {
      // `quota` is the denominator services/audits.ts uses for this window's
      // rejection/failure threshold at settle time, so on a split it has to
      // describe THIS window's own review load — left at the pool-wide draw it
      // would be larger than the window's item count and the threshold could
      // never be reached. `eligibleCount` and `carryNumerator` stay pool-wide
      // on the primary window: it is the row that records the draw.
      await tx.humanAuditWindow.update({ where: { id: window.id }, data: { quota: chunks[0]!.length } });
    }

    const selectedIds = orderedSelected;
    const selectedIdSet = new Set(selectedIds);
    const unselected = eligible.filter((s) => !selectedIdSet.has(s.id));

    // Every eligible submission gets a membership row (real, unique HMAC rank
    // computed against the window it actually belongs to), whether or not it
    // ends up selected.
    const membershipRows: Prisma.HumanAuditWindowMembershipCreateManyInput[] = [
      ...chunks.flatMap((chunk, i) =>
        chunk.map((submissionId) => ({
          windowId: windowIdByChunk[i]!,
          submissionId,
          rank: rankIn(windowIdByChunk[i]!, submissionId),
          selected: true,
        }))
      ),
      ...unselected.map((s) => ({
        windowId: window.id,
        submissionId: s.id,
        rank: rankIn(window.id, s.id),
        selected: false,
      })),
    ];
    await tx.humanAuditWindowMembership.createMany({ data: membershipRows });

    if (selectedIds.length > 0) {
      await tx.submission.updateMany({
        where: { id: { in: selectedIds } },
        data: { status: SubmissionStatus.in_audit },
      });

      // Give each window chunk its claimable AuditBatch, with one undecided
      // AuditItem per selected submission (validator-flow alignment with v1).
      //
      // 1:1 with the window, NOT v1's independent bounty-wide pooling: this
      // deployment already batches at the window level — `community.human_audit_window_size`
      // is "the batch a validator claims. 50-100 (owner requirement)" and the
      // chunking above enforces it. A second layer sized by v1's
      // `community.audit_batch_size` (25) would contradict that requirement and
      // leave two different things both called "the unit a validator claims".
      //
      // The window is the sampling record and the claimable unit; the batch
      // exists for what the window cannot express — a per-item verdict, with
      // the validator's note and decision timestamp.
      //
      // Replay safety is the CONDITIONAL LINK below, not the `@unique` on
      // `auditBatchId`. That constraint only stops two windows sharing one
      // batch; it does not stop a window's link being reassigned, so on its own
      // a replayed close-out would happily point the window at a second batch
      // and orphan the first (with its verdicts). The `auditBatchId: null`
      // guard on the update is what actually makes this idempotent.
      for (let i = 0; i < chunks.length; i++) {
        const chunkIds = chunks[i]!;
        if (chunkIds.length === 0) continue;
        const windowId = windowIdByChunk[i]!;

        // Cheap pre-check so a replay does not create a batch it will only
        // delete again. The guarded update below is still the authority.
        const existing = await tx.humanAuditWindow.findUnique({
          where: { id: windowId },
          select: { auditBatchId: true },
        });
        if (existing?.auditBatchId) continue;

        const auditBatchId = await createWindowAuditBatch(tx, { bountyId, submissionIds: chunkIds });
        if (!auditBatchId) continue;

        const linked = await tx.humanAuditWindow.updateMany({
          where: { id: windowId, auditBatchId: null },
          data: { auditBatchId },
        });
        if (linked.count === 0) {
          // Someone linked a batch between the pre-check and here. Ours is an
          // orphan holding undecided items no window points at — remove it
          // rather than leave audit rows nothing can ever surface.
          await tx.auditItem.deleteMany({ where: { auditBatchId } });
          await tx.auditBatch.delete({ where: { id: auditBatchId } });
        }
      }

      // Validator-side watch alert: one or more HumanAuditWindows just became
      // claimable for this bounty. Keyed to the bounty (not the window) — see
      // emitAuditAvailableMatches's own doc comment — and fired post-commit
      // below alongside the rest of this job's notifications, never inside
      // the transaction (fanOutWatchers opens its own per-recipient tx).
      notifications.push(() =>
        emitAuditAvailableMatches({
          id: bountyId,
          title: bounty.title,
          datasetCategory: bounty.datasetCategory,
          language: bounty.language,
          requesterUserId: sponsorUserId,
          domain: bounty.datasetType?.domain ?? "coding",
        })
      );
    }

    if (unselected.length > 0) {
      await tx.submission.updateMany({
        where: { id: { in: unselected.map((s) => s.id) } },
        data: { status: SubmissionStatus.accepted, acceptedAt: new Date() },
      });
      // Recount, never increment: a replay of this job (or any other path
      // that flips these rows) must re-derive the same number, not add to it.
      await recomputeAcceptedItemCounters(tx, bountyId);
      for (const sub of unselected) {
        // Same idempotent (userId, eventType, sourceType, sourceId) award as
        // the sponsor-review accept path (routes/v1/bounties.ts) — a retry
        // of this job after a crash re-runs the same submission through
        // awardOrHoldAcceptedItemKarma, which no-ops on the already-recorded
        // KarmaEvent/PendingKarmaAward row. Routed through the hold-then-release
        // gate so this pool-driven accept path also respects the sponsor's
        // dispute window instead of paying out immediately.
        await awardOrHoldAcceptedItemKarma(tx, {
          bountyId,
          userId: sub.contributorUserId,
          eventType: KarmaEventType.community_item_accepted,
          amount: bounty.karmaPerAcceptedItem || 25,
          sourceType: "Submission",
          sourceId: sub.id,
          metadata: { bountyId, windowId: window.id, title: sub.title },
        });
      }
    }

    await tx.bounty.update({ where: { id: bountyId }, data: { poolSamplingCompletedAt: new Date() } });

    notifications.push(() =>
      notifyUser({
        userId: sponsorUserId,
        type: "pool.sampling_started",
        title: "Pool closed — human review sampling complete",
        body: `"${bounty.title}" reached its item target. ${selectedIds.length} of ${eligible.length} submissions were selected for validator review across ${windowIdByChunk.length} review window(s) of up to ${windowSize} items; the rest are accepted.`,
        entityType: "Bounty",
        entityId: bountyId,
        linkBountyId: bountyId,
      })
    );
    for (const sub of eligible) {
      const wasSelected = selectedIds.includes(sub.id);
      notifications.push(() =>
        notifyUser({
          userId: sub.contributorUserId,
          type: wasSelected ? "submission.sampled_for_audit" : "submission.auto_accepted",
          title: wasSelected ? "Submission selected for validator review" : "Submission accepted",
          body: wasSelected
            ? `"${sub.title}" was selected for human validator review as the pool closed.`
            : `"${sub.title}" was accepted — the pool closed and it was not selected for the human review sample.`,
          entityType: "Submission",
          entityId: sub.id,
          linkBountyId: bountyId,
        })
      );
    }

    return {
      skipped: false,
      windowId: window.id,
      windowIds: windowIdByChunk,
      windowSize,
      eligibleCount: eligible.length,
      selectedCount: selectedIds.length,
      autoAcceptedCount: unselected.length,
      sponsorReviewCount: 0,
    };
  });

  // Notifications fire only after the transaction actually commits — never
  // inside it (matches services/validation.ts's convention elsewhere).
  for (const send of notifications) await send();

  return result;
}
