// SPDX-License-Identifier: Apache-2.0

import { KarmaEventType, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getAdminSetting } from "./admin-settings.js";
import { awardKarma } from "./karma.js";

/**
 * Karma holds: the write side of `PendingKarmaAward`.
 *
 * The table, the `GET /v1/community/karma` hold list, and the whole
 * dispute-window story around it already existed — but NOTHING in this API ever
 * inserted a row. "Pending karma" was therefore permanently 0 and the hold list
 * permanently empty, while the endpoint reported a hold-window state that could
 * not structurally exist.
 *
 * The reason that matters is not cosmetic. Karma is awarded IMMEDIATELY on
 * acceptance (services/audits.ts, services/pool-lifecycle.ts,
 * routes/v1/bounties.ts all call `awardKarma` straight through), so the
 * sponsor's dispute window is bypassed entirely: by the time a dispute is
 * upheld the karma is already in the member's balance and on the leaderboard,
 * and the only remedy left is a claw-back. Holding the award instead means an
 * upheld dispute simply declines to release it — nothing public ever moved.
 *
 * ## Lifecycle
 *
 *   accept  ->  `awardOrHoldAcceptedItemKarma`
 *                 holds ON  -> `PendingKarmaAward` row (frozen amount, invisible)
 *                 holds OFF -> `awardKarma` exactly as today
 *
 *   window   ->  `releaseDueKarmaHolds` (sweep) claims the row and calls
 *   elapsed      `awardKarma` with the SAME (sourceType, sourceId) key, so the
 *                award stays idempotent end to end.
 *
 *   dispute  ->  `reverseAcceptedItemKarma` reverses a released award, or — if
 *   upheld       it was never released — cancels the pending row (`reversedAt`,
 *                never deleted, so the evidence trail survives).
 *
 * ## Two deliberate deviations from v1, both reported rather than assumed
 *
 * 1. **Release is gated on the dispute window only, not on publication.** v1
 *    additionally requires the bounty to reach `publicationStatus: "published"`.
 *    Nothing in this API publishes a community bounty automatically yet
 *    (`community.publish` has no worker handler), so a publication gate here
 *    would hold every member's karma forever. The route's own hold copy still
 *    says "Held until X is published" — that wording is in
 *    routes/v1/community.ts (another owner) and needs to change with this.
 *
 * 2. **The queue path is behind `community.karma_holds.enabled`.** Turning
 *    holds on changes WHEN karma lands for every member, which is a product
 *    decision, not a refactor. The flag defaults to ON because
 *    dispute-window-bypass is the bug being fixed, but an operator can put the
 *    old behaviour back without a deploy. The key is not yet in
 *    SETTINGS_CATALOG (services/admin-settings.ts is another owner's file) —
 *    `getAdminSetting` honours an explicit default for an uncatalogued key, so
 *    this reads correctly either way.
 */

const HOUR_MS = 3_600_000;

export const KARMA_HOLDS_ENABLED_KEY = "community.karma_holds.enabled";
export const DISPUTE_WINDOW_HOURS_KEY = "community.dispute_window_hours";
export const DEFAULT_COMMUNITY_DISPUTE_WINDOW_HOURS = 48;

/** Case-insensitive: existing call sites write `sourceType: "Submission"`
 *  (services/audits.ts, services/pool-lifecycle.ts, routes/v1/bounties.ts)
 *  while the schema comments and v1 use `"submission"`. The anchor lookup must
 *  not silently miss a row over capitalisation. */
function isSubmissionSource(sourceType: string): boolean {
  return sourceType.toLowerCase() === "submission";
}

export async function karmaHoldsEnabled(): Promise<boolean> {
  const value = await getAdminSetting<unknown>(KARMA_HOLDS_ENABLED_KEY, true);
  return typeof value === "boolean" ? value : true;
}

export async function defaultDisputeWindowHours(): Promise<number> {
  const value = await getAdminSetting<unknown>(DISPUTE_WINDOW_HOURS_KEY, DEFAULT_COMMUNITY_DISPUTE_WINDOW_HOURS);
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_COMMUNITY_DISPUTE_WINDOW_HOURS;
}

export interface KarmaAwardParams {
  bountyId: string;
  userId: string;
  eventType: KarmaEventType;
  amount: number;
  sourceType: string;
  sourceId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Freeze an award without making it visible. The amount is captured here and
 * never re-priced, so a later karma-matrix edit cannot retroactively change
 * what already-accepted work is worth.
 *
 * Idempotent on the `(userId, eventType, sourceType, sourceId)` unique index,
 * via `createMany({ skipDuplicates })` rather than a caught P2002 — a caught
 * unique violation still aborts the surrounding Postgres transaction, which
 * would break every later statement in the caller's accept transaction.
 *
 * Returns true only when a NEW row was written.
 */
export async function queuePendingKarmaAward(
  tx: Prisma.TransactionClient,
  params: KarmaAwardParams
): Promise<boolean> {
  if (!Number.isInteger(params.amount) || params.amount <= 0) {
    throw new Error("pending karma amount must be a positive integer");
  }
  const result = await tx.pendingKarmaAward.createMany({
    data: [
      {
        bountyId: params.bountyId,
        userId: params.userId,
        eventType: params.eventType,
        amount: params.amount,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        metadata: params.metadata as Prisma.InputJsonValue | undefined,
      },
    ],
    skipDuplicates: true,
  });
  return result.count === 1;
}

/**
 * The single call site an accept path needs. Decides hold-vs-award once, so no
 * route has to know the policy, and so flipping the flag can never leave two
 * accept paths disagreeing about whether karma is live.
 *
 * `holdsEnabled` may be passed in by a caller that already resolved the flag
 * outside its transaction (preferred — it keeps a settings read off the
 * transaction's connection).
 */
export async function awardOrHoldAcceptedItemKarma(
  tx: Prisma.TransactionClient,
  params: KarmaAwardParams,
  opts: { holdsEnabled?: boolean } = {}
): Promise<{ held: boolean; written: boolean }> {
  const holds = opts.holdsEnabled ?? (await karmaHoldsEnabled());
  if (!holds) {
    const event = await awardKarma(tx, {
      userId: params.userId,
      eventType: params.eventType,
      amount: params.amount,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      metadata: params.metadata,
    });
    return { held: false, written: event !== null };
  }
  const written = await queuePendingKarmaAward(tx, params);
  return { held: true, written };
}

/**
 * Cancel a not-yet-released hold so the sweep can never pay it out later.
 *
 * Idempotent by construction: an already-released or already-reversed row is
 * excluded from the match, so a retried dispute resolution — or one that runs
 * just after the sweep released the award, a genuine race — is a safe no-op
 * rather than a double reversal. The row is marked, never deleted.
 */
export async function reverseUnreleasedPendingKarmaAward(
  tx: Prisma.TransactionClient,
  params: { userId: string; sourceType: string; sourceId: string; reason?: string }
): Promise<boolean> {
  const result = await tx.pendingKarmaAward.updateMany({
    where: {
      userId: params.userId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      releasedAt: null,
      reversedAt: null,
    },
    data: { reversedAt: new Date(), reversedReason: params.reason ?? "dispute_upheld" },
  });
  return result.count > 0;
}

/**
 * Undo one accepted item's karma, whichever state it is in.
 *
 * An upheld dispute can land on either side of the release boundary depending
 * on whether the window closed first. Handling only the released case silently
 * no-ops on a held award, which then survives to be paid out in full by the
 * next sweep — the exact gap this closes. Released is checked first because a
 * released row also carries `releasedAt`, so the pending branch would not match
 * it anyway.
 */
export async function reverseAcceptedItemKarma(
  tx: Prisma.TransactionClient,
  params: { userId: string; sourceType: string; sourceId: string; reason?: string }
): Promise<{ reversed: boolean; state: "released" | "held" | "none" }> {
  const released = await tx.karmaEvent.findUnique({
    where: {
      userId_eventType_sourceType_sourceId: {
        userId: params.userId,
        eventType: KarmaEventType.community_item_accepted,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
      },
    },
    select: { id: true, amount: true },
  });

  if (released) {
    // Append an equal negative event rather than mutating or deleting the
    // original: the evidence of what was awarded, and of the reversal, both
    // have to survive. Guarded by the same compound key, so a retry cannot
    // double-deduct.
    const written = await tx.karmaEvent.createMany({
      data: [
        {
          userId: params.userId,
          eventType: KarmaEventType.community_item_reversed,
          amount: -released.amount,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          metadata: { originalEventId: released.id, reason: params.reason ?? "dispute_upheld" } as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    if (written.count === 1) {
      await tx.user.update({
        where: { id: params.userId },
        data: { karmaTotal: { decrement: released.amount } },
      });
    }
    // Mark the originating hold too (if there was one) so the pending/reversed
    // totals the karma endpoint reports stay consistent with the balance.
    await tx.pendingKarmaAward.updateMany({
      where: { userId: params.userId, sourceType: params.sourceType, sourceId: params.sourceId, reversedAt: null },
      data: { reversedAt: new Date(), reversedReason: params.reason ?? "dispute_upheld" },
    });
    return { reversed: written.count === 1, state: "released" };
  }

  const cancelled = await reverseUnreleasedPendingKarmaAward(tx, params);
  return { reversed: cancelled, state: cancelled ? "held" : "none" };
}

/**
 * When a given hold stops being disputable.
 *
 * Two clocks, and the LATER one wins, because they gate different things and
 * releasing on the earlier of the two would pay out inside a window a surface
 * is currently telling someone is open:
 *
 *  - the per-item clock (`submission.acceptedAt`), which is what v1 uses and
 *    what the sponsor's per-item dispute route runs on; and
 *  - the batch clock (`bounty.disputeCycleWindowOpensAt`), which is what
 *    `GET /v1/community/karma` renders as `windowClosesAt` today.
 *
 * `disputeCycleWindowOpensAt` is nullable and currently written by nothing, so
 * in practice the per-item clock is the operative one — but taking the max
 * means this is already correct the moment the pool-lifecycle owner starts
 * writing it, and can never release EARLIER than the window the API displays.
 */
export function holdReleasesAt(
  award: { sourceType: string; createdAt: Date },
  bounty: { disputeWindowHours: number | null; disputeCycleWindowOpensAt: Date | null },
  acceptedAt: Date | null,
  defaultWindowHours: number
): Date {
  const windowMs = (bounty.disputeWindowHours ?? defaultWindowHours) * HOUR_MS;
  // A non-submission award (request approval, publish bonus) has no per-item
  // acceptance to anchor on; its own creation is the only honest clock.
  const itemAnchor = (isSubmissionSource(award.sourceType) ? acceptedAt : null) ?? award.createdAt;
  const anchor =
    bounty.disputeCycleWindowOpensAt && bounty.disputeCycleWindowOpensAt > itemAnchor
      ? bounty.disputeCycleWindowOpensAt
      : itemAnchor;
  return new Date(anchor.getTime() + windowMs);
}

export interface KarmaHoldReleaseResult {
  scanned: number;
  released: number;
  releasedKarma: number;
}

/**
 * Sweep: release every hold whose dispute window has closed.
 *
 * Safe to run concurrently with itself and with a dispute resolution. Each row
 * is CLAIMED FIRST with a conditional `updateMany` on
 * `{ releasedAt: null, reversedAt: null }` and only awarded if that claim
 * matched — the claim, not the read, is the race guard. `candidates` is read
 * outside the per-row transaction, so a dispute could reverse a row in between;
 * whichever transaction commits first wins the row and the other backs off.
 *
 * Bounded by `limit` and ordered oldest-first so a large backlog drains in a
 * predictable order across ticks instead of one unbounded pass.
 */
export async function releaseDueKarmaHolds(
  opts: { now?: Date; limit?: number } = {}
): Promise<KarmaHoldReleaseResult> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const defaultWindowHours = await defaultDisputeWindowHours();

  const candidates = await prisma.pendingKarmaAward.findMany({
    where: { releasedAt: null, reversedAt: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      userId: true,
      eventType: true,
      amount: true,
      sourceType: true,
      sourceId: true,
      metadata: true,
      createdAt: true,
      bounty: { select: { disputeWindowHours: true, disputeCycleWindowOpensAt: true } },
    },
  });
  if (candidates.length === 0) return { scanned: 0, released: 0, releasedKarma: 0 };

  const submissionIds = candidates.filter((c) => isSubmissionSource(c.sourceType)).map((c) => c.sourceId);
  const submissions = submissionIds.length
    ? await prisma.submission.findMany({
        where: { id: { in: submissionIds } },
        select: { id: true, acceptedAt: true, createdAt: true },
      })
    : [];
  const acceptedAtById = new Map(submissions.map((s) => [s.id, s.acceptedAt ?? s.createdAt]));

  let released = 0;
  let releasedKarma = 0;
  for (const award of candidates) {
    const releasesAt = holdReleasesAt(
      award,
      award.bounty,
      acceptedAtById.get(award.sourceId) ?? null,
      defaultWindowHours
    );
    if (releasesAt.getTime() > now.getTime()) continue; // window still open

    const didRelease = await prisma.$transaction(async (tx) => {
      const claimed = await tx.pendingKarmaAward.updateMany({
        where: { id: award.id, releasedAt: null, reversedAt: null },
        data: { releasedAt: now },
      });
      if (claimed.count !== 1) return false; // reversed concurrently — do not award
      await awardKarma(tx, {
        userId: award.userId,
        eventType: award.eventType,
        amount: award.amount,
        sourceType: award.sourceType,
        sourceId: award.sourceId,
        metadata: {
          ...((award.metadata as Record<string, unknown> | null) ?? {}),
          releasedByHoldSweep: true,
          releasedAt: now.toISOString(),
        },
      });
      return true;
    });

    if (didRelease) {
      released += 1;
      releasedKarma += award.amount;
    }
  }

  return { scanned: candidates.length, released, releasedKarma };
}
