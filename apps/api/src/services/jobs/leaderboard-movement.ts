// SPDX-License-Identifier: Apache-2.0

/**
 * `leaderboard.rank_check` — the ONLY writer of `User.leaderboardRank*`.
 *
 * Ported from v1 `databounty-api/src/services/leaderboard-movement.ts`
 * (`enqueueLeaderboardRankCheck`, `readRankSnapshot`, `runLeaderboardRankCheck`,
 * `describeWork`, `MIN_REPORTABLE_RANK_GAIN`, `COALESCE_WINDOW_MS`).
 *
 * Why a job and not inline in the karma award: a rank is a range COUNT over
 * users, and karma is awarded once per accepted item. Inline, a 200-item
 * acceptance would pay that count 200 times, on the hot path, inside an open
 * transaction. Off the request path it costs one check per burst.
 *
 * Honesty rules encoded here, because this is the only place they can be:
 *  - Movement is measured against a position the platform ACTUALLY recorded,
 *    at a recorded time: "you were #14 as of <then>, you are #11 now" — never
 *    "you passed 3 contributors", which other members' awards and reversals
 *    would falsify.
 *  - Only improvements are announced. A worsened rank silently updates the
 *    stored position so the NEXT comparison stays honest, and notifies nobody.
 *  - The gain is attributed from the member's OWN karma events since the last
 *    check, so a validator is never told their "accepted items" moved them.
 */
import { KarmaEventType, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { notifyEvent } from "../notifications.js";
import { enqueueJob, workspaceKeyForUser } from "../jobs.js";

/** Improvement of at least this many places is worth announcing. 1 = every
 * real gain; the coalescing window already caps a bulk acceptance at one
 * message. */
export const MIN_REPORTABLE_RANK_GAIN = 1;

/** Bucket width for the job's idempotency key. Karma events landing in the
 * same window collapse into ONE check — a 200-item acceptance yields one
 * message. */
const COALESCE_WINDOW_MS = 60_000;

export interface LeaderboardMovementSource {
  acceptedItems: number;
  completedAudits: number;
  other: number;
}

const NO_SOURCE: LeaderboardMovementSource = { acceptedItems: 0, completedAudits: 0, other: 0 };

/**
 * Queue a rank check for one member. Safe to call on every karma write: the
 * key is time-bucketed, so repeated calls inside the window are no-ops against
 * the already-pending job. `runAfter` is one full window out so the check
 * reads a settled balance instead of racing the middle of a bulk acceptance.
 */
export async function enqueueLeaderboardRankCheck(
  userId: string,
  now = new Date(),
  tx?: Prisma.TransactionClient
): Promise<void> {
  const bucket = Math.floor(now.getTime() / COALESCE_WINDOW_MS);
  await enqueueJob("leaderboard.rank_check", { userId }, {
    idempotencyKey: `leaderboard.rank_check:${userId}:${bucket}`,
    runAfter: new Date(now.getTime() + COALESCE_WINDOW_MS),
    workspaceId: workspaceKeyForUser(userId),
    // A missed check costs a congratulation, not correctness: the member's
    // next karma event re-checks from the same stored baseline.
    maxAttempts: 2,
    tx,
  });
}

interface RankSnapshot {
  eligible: boolean;
  rank: number | null;
  storedRank: number | null;
  acceptedItems: number;
  completedAudits: number;
  otherEvents: number;
}

/**
 * One query for the whole read phase: eligibility, the live rank, the stored
 * position, and the karma events since that position was recorded. These
 * cannot be parallelised — the event window starts at `leaderboard_rank_at`,
 * which only the user row knows — so the fix is to let Postgres do the
 * dependent work in one pass rather than fan out three awaits. The rank
 * subquery is covered by `@@index([profilePublic, handle, karmaTotal])` and is
 * evaluated only for an eligible member (the CASE guards it).
 */
async function readRankSnapshot(userId: string): Promise<RankSnapshot | null> {
  const rows = await prisma.$queryRaw<
    {
      eligible: boolean;
      rank: bigint | null;
      stored_rank: number | null;
      accepted_items: bigint;
      completed_audits: bigint;
      other_events: bigint;
    }[]
  >(Prisma.sql`
    WITH me AS (
      SELECT
        u.id,
        u.karma_total,
        u.leaderboard_rank AS stored_rank,
        u.leaderboard_rank_at AS stored_rank_at,
        (u.profile_public = true
          AND u.handle IS NOT NULL
          AND COALESCE((u.public_profile_prefs ->> 'showKarma')::boolean, true) = true
          AND u.karma_total > 0) AS eligible
      FROM users u
      WHERE u.id = ${userId}
    )
    SELECT
      me.eligible,
      CASE WHEN me.eligible THEN (
        SELECT 1 + COUNT(*)
        FROM users o
        WHERE o.profile_public = true
          AND o.handle IS NOT NULL
          AND COALESCE((o.public_profile_prefs ->> 'showKarma')::boolean, true) = true
          AND o.karma_total > 0
          AND o.karma_total > me.karma_total
      ) END AS rank,
      me.stored_rank,
      COALESCE((SELECT COUNT(*) FROM karma_events e
        WHERE e.user_id = me.id AND e.amount > 0
          AND e.event_type = ${KarmaEventType.community_item_accepted}::"KarmaEventType"
          AND (me.stored_rank_at IS NULL OR e.created_at > me.stored_rank_at)), 0) AS accepted_items,
      COALESCE((SELECT COUNT(*) FROM karma_events e
        WHERE e.user_id = me.id AND e.amount > 0
          AND e.event_type = ${KarmaEventType.community_audit_completed}::"KarmaEventType"
          AND (me.stored_rank_at IS NULL OR e.created_at > me.stored_rank_at)), 0) AS completed_audits,
      COALESCE((SELECT COUNT(*) FROM karma_events e
        WHERE e.user_id = me.id AND e.amount > 0
          AND e.event_type NOT IN (
            ${KarmaEventType.community_item_accepted}::"KarmaEventType",
            ${KarmaEventType.community_audit_completed}::"KarmaEventType"
          )
          AND (me.stored_rank_at IS NULL OR e.created_at > me.stored_rank_at)), 0) AS other_events
    FROM me
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    eligible: row.eligible,
    rank: row.rank === null ? null : Number(row.rank),
    storedRank: row.stored_rank,
    acceptedItems: Number(row.accepted_items),
    completedAudits: Number(row.completed_audits),
    otherEvents: Number(row.other_events),
  };
}

export interface RankCheckOutcome {
  rank: number | null;
  previousRank: number | null;
  improvedBy: number;
  reported: boolean;
  source: LeaderboardMovementSource;
}

/**
 * Recompute one member's position, store it, and announce a real improvement.
 *
 * The write is a compare-and-set (`WHERE leaderboard_rank IS DISTINCT FROM
 * $rank`) so when two checks for the same member overlap — different
 * coalescing buckets, or a retry racing the original — exactly ONE records the
 * transition and therefore exactly one announces it. The loser sees zero rows
 * updated and returns quietly rather than re-announcing a recorded position.
 */
export async function runLeaderboardRankCheck(userId: string): Promise<RankCheckOutcome> {
  const none: RankCheckOutcome = { rank: null, previousRank: null, improvedBy: 0, reported: false, source: NO_SOURCE };
  const snapshot = await readRankSnapshot(userId);
  if (!snapshot) return none;

  const { rank, storedRank: previous } = snapshot;
  const now = new Date();

  // Left the leaderboard (went private, hid karma, or was reversed to zero):
  // clear the stored position so a later re-entry is not measured against a
  // stale one, and say nothing.
  if (rank === null) {
    if (previous !== null) {
      await prisma.user.updateMany({
        where: { id: userId, leaderboardRank: { not: null } },
        data: { leaderboardRank: null, leaderboardRankAt: now },
      });
    }
    return { ...none, previousRank: previous };
  }

  const source: LeaderboardMovementSource = {
    acceptedItems: snapshot.acceptedItems,
    completedAudits: snapshot.completedAudits,
    other: snapshot.otherEvents,
  };
  // A LOWER number is a better position. `previous === null` is a first
  // appearance, not an improvement of unknown size — it gets its own message.
  const isFirstAppearance = previous === null;
  const improvedBy = isFirstAppearance ? 0 : previous - rank;
  const isImprovement = improvedBy >= MIN_REPORTABLE_RANK_GAIN;

  // `IS DISTINCT FROM` (not `!=`) so a stored NULL matches a real rank — a
  // first appearance must win the race too.
  const written = await prisma.$executeRaw`
    UPDATE users
    SET leaderboard_rank = ${rank},
        leaderboard_rank_at = ${now},
        leaderboard_rank_prev = ${isImprovement ? previous : isFirstAppearance ? null : Prisma.sql`leaderboard_rank_prev`},
        leaderboard_rank_moved_at = ${isImprovement || isFirstAppearance ? now : Prisma.sql`leaderboard_rank_moved_at`}
    WHERE id = ${userId}
      AND leaderboard_rank IS DISTINCT FROM ${rank}
  `;

  if (!isFirstAppearance && !isImprovement) {
    return { rank, previousRank: previous, improvedBy: 0, reported: false, source };
  }
  // Another worker already recorded this exact position: it owns the
  // announcement, so this one must not duplicate it.
  if (written === 0) {
    return { rank, previousRank: previous, improvedBy, reported: false, source };
  }

  await prisma.$transaction((tx) =>
    notifyEvent(tx, "leaderboard.rank_improved", {
      userId,
      // Keyed on the position REACHED, so one arrival is announced once even
      // if a retry slips past the guard above; a later, better position is a
      // new key.
      keySuffix: `${rank}`,
      data: {
        rank: String(rank),
        previousRank: isFirstAppearance ? "" : String(previous),
        places: String(improvedBy),
        work: describeWork(source),
      },
    })
  );

  return { rank, previousRank: previous, improvedBy, reported: true, source };
}

/**
 * Plain-language attribution for the gain, from real event counts.
 *
 * Says "accepting 7 items you submitted earlier" rather than "your accepted
 * items", because the distinction is the whole point: karma lands on final
 * ACCEPTANCE, not on submission, so what moved the member is work they handed
 * in some time ago clearing validation now. Falls back to "recent work"; never
 * guesses a track.
 */
export function describeWork(source: LeaderboardMovementSource): string {
  const parts: string[] = [];
  if (source.acceptedItems > 0) {
    parts.push(`accepting ${source.acceptedItems} item${source.acceptedItems === 1 ? "" : "s"} you submitted earlier`);
  }
  if (source.completedAudits > 0) {
    parts.push(`completing ${source.completedAudits} audit${source.completedAudits === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return "recent work";
  return parts.join(" and ");
}

/**
 * Sweep producer.
 *
 * v1 called `enqueueLeaderboardRankCheck` from inside the karma-award
 * transaction. The award paths in this rebuild (services/karma.ts,
 * services/karma-holds.ts) are not part of this change, so the producer here
 * reads the same signal from the other side: members with a positive karma
 * event in the recent window whose stored position predates it. Both dedupe
 * layers still hold — the time-bucketed queue key collapses a burst into one
 * job, and the notification key means one announcement per position reached.
 *
 * `enqueueLeaderboardRankCheck` stays exported so the award path can call it
 * directly later; that is strictly better (immediate, no polling lag) and this
 * sweep then becomes a harmless backstop rather than the only trigger.
 */
export async function enqueueDueLeaderboardRankChecks(
  lookbackMs = 10 * 60_000,
  limit = 200
): Promise<{ enqueued: number }> {
  const since = new Date(Date.now() - lookbackMs);
  const rows = await prisma.karmaEvent.findMany({
    where: { createdAt: { gte: since }, amount: { gt: 0 } },
    select: { userId: true },
    distinct: ["userId"],
    take: limit,
  });
  for (const row of rows) await enqueueLeaderboardRankCheck(row.userId);
  return { enqueued: rows.length };
}
