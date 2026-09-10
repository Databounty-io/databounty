// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly activity series for the signed-in member's own workspace charts
 * (GET /v1/me/analytics).
 *
 * Every number here is a COUNT or SUM over rows this member owns. Nothing is
 * estimated, smoothed, extrapolated or back-filled from a rate: a week with no
 * rows is returned as a real zero, and a quantity the schema cannot answer is
 * not returned at all rather than approximated.
 *
 * Two different time models are in play, and mixing them silently would be a
 * lie, so they are separate series:
 *
 *  - `submissions` is a COHORT series, bucketed by when the item was
 *    submitted, broken down by where those items stand TODAY. It answers "of
 *    what I sent that week, what happened to it". It cannot answer "how many
 *    items were rejected during week N": `submissions` stores `accepted_at`
 *    but no rejected-at/needs-fixes-at timestamp, so no rejection event time
 *    exists to bucket by. `notes` says so in the response.
 *  - `karma` and `audits` are EVENT-TIME series: `karma_events.created_at` and
 *    `audit_items.decided_at` are real event timestamps, so those buckets mean
 *    what a reader assumes they mean.
 *
 * Weeks are ISO weeks starting Monday, in UTC, computed identically in SQL
 * (`date_trunc('week', …)` over columns that already hold UTC wall-clock —
 * NOT `AT TIME ZONE 'UTC'`, which yields a timestamptz that `date_trunc` then
 * truncates in the SESSION timezone, silently bucketing by the server's local
 * week and mismatching the TypeScript list) and in TypeScript, so the
 * bucket list and the aggregates always line up. The week start is rendered to
 * text in SQL rather than returned as a timestamp, so a driver's timezone
 * handling can never shift a bucket into the previous day.
 */
import { Prisma, SubmissionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  ACCEPTED_SUBMISSION_STATUSES,
  IN_REVIEW_SUBMISSION_STATUSES,
  NEEDS_ATTENTION_SUBMISSION_STATUSES,
} from "./profile-summary.js";

/** Smallest and largest window the endpoint will serve, in weeks. */
export const MIN_WEEKS = 4;
export const MAX_WEEKS = 52;
export const DEFAULT_WEEKS = 12;

export interface SubmissionWeek {
  weekStart: string;
  submitted: number;
  accepted: number;
  rejected: number;
  needsFixes: number;
  inReview: number;
}

export interface KarmaWeek {
  weekStart: string;
  karma: number;
  events: number;
}

export interface AuditWeek {
  weekStart: string;
  audited: number;
  flagged: number;
  flagsConfirmed: number;
  flagsDismissed: number;
  flagsPending: number;
}

export interface MemberAnalytics {
  range: {
    weeks: number;
    from: string;
    to: string;
    bucket: "week";
    weekStartsOn: "monday";
    timezone: "UTC";
  };
  contributor: {
    submissions: SubmissionWeek[];
    karma: KarmaWeek[];
    totals: {
      submitted: number;
      accepted: number;
      rejected: number;
      needsFixes: number;
      inReview: number;
      karma: number;
    };
  };
  validator: {
    audits: AuditWeek[];
    totals: {
      audited: number;
      flagged: number;
      flagsConfirmed: number;
      flagsDismissed: number;
      flagsPending: number;
    };
  };
  /** Anything a reader could otherwise misread. Rendered verbatim by the UI. */
  notes: { field: string; note: string }[];
}

/** Monday 00:00:00 UTC of the week containing `date`. */
export function startOfUtcWeek(date: Date): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay: Sunday = 0. Shift so Monday = 0, matching date_trunc('week').
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return day;
}

/** The `weeks` consecutive Monday-start weeks ending with the current one. */
export function weekStarts(weeks: number, now: Date): string[] {
  const first = startOfUtcWeek(now);
  first.setUTCDate(first.getUTCDate() - (weeks - 1) * 7);
  const out: string[] = [];
  for (let i = 0; i < weeks; i += 1) {
    const d = new Date(first);
    d.setUTCDate(d.getUTCDate() + i * 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The Monday-start weeks covering an explicit [from, to] date range.
 *
 * Owner instruction 2026-09-07: analytics is chosen by DATE RANGE, not by a
 * trailing week count. `weekStarts()` above can only produce the run of weeks
 * ending today, so an arbitrary past range was unservable and the UI could only
 * offer week counts. Buckets still start Monday in UTC — the bucket rule does
 * not change, only which span is asked for — and the first/last bucket are the
 * weeks CONTAINING `from` and `to`, so a range that starts mid-week is not
 * silently truncated to the following Monday.
 */
export function weekStartsBetween(from: Date, to: Date): string[] {
  const first = startOfUtcWeek(from);
  const last = startOfUtcWeek(to);
  const out: string[] = [];
  for (const d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 7)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** What the caller asked for: a trailing week count, or an explicit range. */
export type AnalyticsWindow = number | { from: Date; to: Date };

/** Longest span the endpoint will bucket, in weeks — the same ceiling
 *  `MAX_WEEKS` puts on a trailing window, so an explicit range cannot be used
 *  to ask for an unbounded scan. */
export const MAX_RANGE_WEEKS = MAX_WEEKS;

/** Postgres COUNT/SUM come back as bigint (or null for an empty SUM). */
function n(value: bigint | number | null): number {
  return value === null ? 0 : Number(value);
}

/** Enum columns compare against text parameters only after an explicit cast. */
function statusList(statuses: readonly SubmissionStatus[]) {
  return Prisma.join(statuses.map((s) => Prisma.sql`${s}`));
}

export async function getMemberAnalytics(
  userId: string,
  window: AnalyticsWindow,
  now: Date = new Date(),
): Promise<MemberAnalytics> {
  const buckets =
    typeof window === "number" ? weekStarts(window, now) : weekStartsBetween(window.from, window.to);
  const firstWeek = buckets[0];
  const lastWeek = buckets[buckets.length - 1];
  // Both shapes are validated at the route, so this cannot fire; it is here so
  // the window bounds below are real strings rather than an assertion.
  if (!firstWeek || !lastWeek) throw new Error(`no buckets for window ${JSON.stringify(window)}`);
  const weeks = buckets.length;
  const from = new Date(`${firstWeek}T00:00:00.000Z`);
  // Upper bound, exclusive: the instant after the last bucket's week ends. A
  // trailing window has no upper bound (it runs to "now" by definition), but an
  // explicit range must not leak rows from the weeks after `to` — the bucket
  // list would drop them silently while the totals still counted them.
  const toExclusive = new Date(`${lastWeek}T00:00:00.000Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 7);
  const upper = typeof window === "number" ? null : toExclusive;

  const [submissionRows, karmaRows, auditRows, flagRows] = await Promise.all([
    prisma.$queryRaw<
      {
        week_start: string;
        submitted: bigint;
        accepted: bigint;
        rejected: bigint;
        needs_fixes: bigint;
        in_review: bigint;
      }[]
    >(Prisma.sql`
      SELECT
        to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week_start,
        COUNT(*) AS submitted,
        COUNT(*) FILTER (WHERE status::text IN (${statusList(ACCEPTED_SUBMISSION_STATUSES)})) AS accepted,
        COUNT(*) FILTER (WHERE status::text = ${SubmissionStatus.rejected}) AS rejected,
        COUNT(*) FILTER (WHERE status::text IN (${statusList(NEEDS_ATTENTION_SUBMISSION_STATUSES)})) AS needs_fixes,
        COUNT(*) FILTER (WHERE status::text IN (${statusList(IN_REVIEW_SUBMISSION_STATUSES)})) AS in_review
      FROM submissions
      WHERE contributor_user_id = ${userId}
        AND created_at >= ${from}
        AND (${upper}::timestamp IS NULL OR created_at < ${upper}::timestamp)
      GROUP BY 1
    `),

    prisma.$queryRaw<{ week_start: string; karma: bigint | null; events: bigint }[]>(Prisma.sql`
      SELECT
        to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week_start,
        SUM(amount) AS karma,
        COUNT(*) AS events
      FROM karma_events
      WHERE user_id = ${userId}
        AND created_at >= ${from}
        AND (${upper}::timestamp IS NULL OR created_at < ${upper}::timestamp)
      GROUP BY 1
    `),

    prisma.$queryRaw<{ week_start: string; audited: bigint; flagged: bigint }[]>(Prisma.sql`
      SELECT
        to_char(date_trunc('week', ai.decided_at), 'YYYY-MM-DD') AS week_start,
        COUNT(*) AS audited,
        COUNT(*) FILTER (WHERE ai.verdict::text = 'flagged') AS flagged
      FROM audit_items ai
      JOIN audit_batches ab ON ab.id = ai.audit_batch_id
      -- Community audits attribute through the WINDOW's claim, not the batch:
      -- the community close-out path creates the AuditBatch as a container and
      -- leaves validator_user_id NULL, recording the validator on
      -- HumanAuditWindow.claimedByUserId instead. Filtering on the batch alone
      -- reported audited=0 for every community validator, forever, while
      -- their audit karma was credited normally.
      LEFT JOIN human_audit_windows w ON w.audit_batch_id = ab.id
      WHERE COALESCE(ab.validator_user_id, w.claimed_by_user_id) = ${userId}
        AND ai.decided_at IS NOT NULL
        AND ai.decided_at >= ${from}
        AND (${upper}::timestamp IS NULL OR ai.decided_at < ${upper}::timestamp)
      GROUP BY 1
    `),

    prisma.$queryRaw<
      { week_start: string; confirmed: bigint; dismissed: bigint; pending: bigint }[]
    >(Prisma.sql`
      SELECT
        to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week_start,
        COUNT(*) FILTER (WHERE status::text = 'confirmed') AS confirmed,
        COUNT(*) FILTER (WHERE status::text = 'dismissed') AS dismissed,
        COUNT(*) FILTER (WHERE status::text NOT IN ('confirmed', 'dismissed')) AS pending
      FROM flags
      WHERE validator_user_id = ${userId}
        AND created_at >= ${from}
        AND (${upper}::timestamp IS NULL OR created_at < ${upper}::timestamp)
      GROUP BY 1
    `),
  ]);

  const submissionsBy = new Map(submissionRows.map((r) => [r.week_start, r]));
  const karmaBy = new Map(karmaRows.map((r) => [r.week_start, r]));
  const auditsBy = new Map(auditRows.map((r) => [r.week_start, r]));
  const flagsBy = new Map(flagRows.map((r) => [r.week_start, r]));

  const submissions: SubmissionWeek[] = buckets.map((weekStart) => {
    const r = submissionsBy.get(weekStart);
    return {
      weekStart,
      submitted: n(r?.submitted ?? 0),
      accepted: n(r?.accepted ?? 0),
      rejected: n(r?.rejected ?? 0),
      needsFixes: n(r?.needs_fixes ?? 0),
      inReview: n(r?.in_review ?? 0),
    };
  });

  const karma: KarmaWeek[] = buckets.map((weekStart) => {
    const r = karmaBy.get(weekStart);
    return { weekStart, karma: n(r?.karma ?? 0), events: n(r?.events ?? 0) };
  });

  const audits: AuditWeek[] = buckets.map((weekStart) => {
    const a = auditsBy.get(weekStart);
    const f = flagsBy.get(weekStart);
    return {
      weekStart,
      audited: n(a?.audited ?? 0),
      flagged: n(a?.flagged ?? 0),
      flagsConfirmed: n(f?.confirmed ?? 0),
      flagsDismissed: n(f?.dismissed ?? 0),
      flagsPending: n(f?.pending ?? 0),
    };
  });

  const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((t, r) => t + pick(r), 0);

  return {
    range: {
      weeks,
      from: firstWeek,
      to: lastWeek,
      bucket: "week",
      weekStartsOn: "monday",
      timezone: "UTC",
    },
    contributor: {
      submissions,
      karma,
      totals: {
        submitted: sum(submissions, (r) => r.submitted),
        accepted: sum(submissions, (r) => r.accepted),
        rejected: sum(submissions, (r) => r.rejected),
        needsFixes: sum(submissions, (r) => r.needsFixes),
        inReview: sum(submissions, (r) => r.inReview),
        karma: sum(karma, (r) => r.karma),
      },
    },
    validator: {
      audits,
      totals: {
        audited: sum(audits, (r) => r.audited),
        flagged: sum(audits, (r) => r.flagged),
        flagsConfirmed: sum(audits, (r) => r.flagsConfirmed),
        flagsDismissed: sum(audits, (r) => r.flagsDismissed),
        flagsPending: sum(audits, (r) => r.flagsPending),
      },
    },
    notes: [
      {
        field: "contributor.submissions",
        note: "Grouped by the week you submitted, and split by where those items stand today — not by when each decision was made. Submissions record an accepted-at time but no rejected-at or needs-fixes-at time, so there is no decision timestamp to group by.",
      },
      {
        field: "validator.audits.flags*",
        note: "Flag outcomes are grouped by the week the flag was raised, and count how each flag stands today. A flag raised this week and confirmed next week stays in this week's bucket.",
      },
    ],
  };
}
