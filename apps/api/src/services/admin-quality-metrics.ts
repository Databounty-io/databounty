// SPDX-License-Identifier: Apache-2.0

import { BountyKind, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Rolling quality aggregates for the admin console (GET /v1/admin/overview).
 *
 * PORTED FROM V1, deliberately, definition for definition:
 * databounty-api/src/services/admin-metrics.ts's `refreshAdminQualityMetrics`
 * (its `refreshScope(COMMUNITY_QUALITY_7D_ID, "community")` pass) and
 * databounty-api/src/lib/bounty-metrics.ts's `bountyPipelineRates`:
 *
 *   duplicateRate      = avg(Submission.duplicateScore) over submissions
 *                        created in the window (0-1 fraction)
 *   llmPassRate        = avg(Submission.llmScore) over submissions created in
 *                        the window that HAVE a score (0-100 rubric integer,
 *                        which is why the console renders it with
 *                        `pctFromScore100`, not `pct`)
 *   executionPassRate  = passedExecutionResults / totalExecutionResults over
 *                        ValidationResult rows with stage="execution" created
 *                        in the window (0-1 fraction)
 *
 * ...with the same rolling 7-day window (V1's `oneWeekAgo`) and the same
 * `bounty.kind = community` scope. Nothing here is a new metric definition.
 *
 * V1's snapshot carries a fourth number, `contaminationHits` — a count of
 * submissions whose external-corpus plagiarism screening scored at or above
 * 0.8. There is deliberately NO counterpart here: contamination / plagiarism
 * screening was removed from this product per owner decision, so no pipeline
 * stage produces the evidence such a metric would aggregate. A
 * contamination figure on this dashboard would report a check that does not
 * run.
 *
 * TWO DELIBERATE DEPARTURES FROM V1, both required by this project's
 * trust-honesty invariant (a check that did not run must never be counted as
 * a pass, and "not measured" must never be rendered as a real 0%):
 *
 *  1. V1's snapshot writer collapses an empty window to a literal `0`
 *     (`dupStats._avg.duplicateScore ?? 0`) and relies solely on
 *     `computedAt === null` to mean "no data". That only works while the
 *     snapshot worker is the thing that might not have run. These metrics are
 *     computed live per request, so `computedAt` is ALWAYS set — the empty
 *     window has to be expressed in the value itself. Each rate is therefore
 *     `null` with an explicit `state` when its denominator is empty, exactly
 *     as V1's own `bountyPipelineRates` does for the per-bounty rates ("a
 *     real measured 0% and an unmeasured rate mean opposite things").
 *
 *  2. `executionPassRate`'s denominator counts ONLY rows where a sandbox
 *     actually produced a verdict (`outcome = "runner_completed"`). V1's
 *     query divides by every execution row, which silently counts a row that
 *     recorded "no provider configured / no executable harness / provider
 *     failed" (all written with `passed: false` by
 *     services/validation.ts, honestly) as a FAILED execution. That reports
 *     an unconfigured sandbox as a failing pipeline — the mirror image of the
 *     defect this module exists to fix, so it is not reproduced. The excluded
 *     rows are not hidden: they are returned as `excluded` /
 *     `excludedByOutcome` so the console can say how many runs produced no
 *     verdict.
 */

export const QUALITY_METRICS_WINDOW_DAYS = 7;

/**
 * The only `ValidationResult.outcome` value on stage="execution" that means a
 * sandbox really ran the submission's tests and returned a verdict (see
 * services/validation.ts: "`runner_completed` ONLY when a sandbox produced a
 * real verdict"). Every other value — including a legacy/backfilled NULL,
 * which cannot be shown to have come from a real run — is excluded from the
 * pass-rate denominator rather than counted as a failure. Fail closed.
 */
const EXECUTION_VERDICT_OUTCOME = "runner_completed";

/**
 * Outcomes that are positive evidence the check could not run because nothing
 * is configured to run it, as opposed to "nothing has been submitted yet".
 * They are what lets the console say "not configured" instead of the vaguer
 * "not measured". `no_executable_harness` is intentionally NOT here: that
 * means this dataset type declares nothing to execute, which is a contract
 * property, not a missing-provider misconfiguration.
 */
const UNCONFIGURED_OUTCOME = "no_provider_configured";

export type QualityMetricState =
  /** A real denominator existed; `rate` is a measurement (0 included). */
  | "measured"
  /** Nothing to measure yet — no scored submissions / no verdicts in window. */
  | "not_measured"
  /** Nothing measured AND the evidence says the check has no provider configured. */
  | "not_configured";

export interface QualityMetric {
  /** `null` whenever `state !== "measured"`. Never zero-filled. */
  rate: number | null;
  /** Size of the denominator the rate was computed over. */
  sampleSize: number;
  /** Rows/records deliberately left out of the denominator (no verdict). */
  excluded: number;
  /** Per-outcome breakdown of `excluded`, for an honest UI caption. */
  excludedByOutcome: Record<string, number>;
  state: QualityMetricState;
}

export interface CommunityQualityMetrics {
  windowDays: number;
  computedAt: Date;
  duplicate: QualityMetric;
  /** 0-100 rubric average, not a 0-1 fraction — see the header note. */
  llm: QualityMetric;
  execution: QualityMetric;
}

/**
 * Pure state derivation, kept separate from the queries so the
 * not-measured-vs-real-zero rule is unit-testable without a database.
 *
 * The whole point: `sampleSize === 0` yields `rate: null`, NEVER `0`. A
 * genuinely measured zero (`rate: 0` over a non-empty sample) is preserved as
 * a measurement.
 */
export function deriveQualityMetric(input: {
  rate: number | null;
  sampleSize: number;
  excludedByOutcome?: Record<string, number>;
  unconfiguredCount?: number;
}): QualityMetric {
  const excludedByOutcome = input.excludedByOutcome ?? {};
  const excluded = Object.values(excludedByOutcome).reduce((sum, n) => sum + n, 0);

  if (input.sampleSize > 0 && input.rate !== null) {
    return { rate: input.rate, sampleSize: input.sampleSize, excluded, excludedByOutcome, state: "measured" };
  }

  return {
    rate: null,
    sampleSize: 0,
    excluded,
    excludedByOutcome,
    state: (input.unconfiguredCount ?? 0) > 0 ? "not_configured" : "not_measured",
  };
}

/**
 * Folds the `groupBy(outcome, passed)` rows for stage="execution" into a
 * verdict-only numerator/denominator plus an excluded-run breakdown. Split out
 * as a pure function so the "a run that produced no verdict is never counted
 * as a failure" rule is unit-testable without a database.
 */
export function foldExecutionRows(
  rows: Array<{ outcome: string | null; passed: boolean; count: number }>,
): { verdicts: number; passed: number; excludedByOutcome: Record<string, number> } {
  let verdicts = 0;
  let passed = 0;
  const excludedByOutcome: Record<string, number> = {};
  for (const row of rows) {
    if (row.outcome === EXECUTION_VERDICT_OUTCOME) {
      verdicts += row.count;
      if (row.passed) passed += row.count;
      continue;
    }
    // NULL outcome = legacy/backfilled row that cannot be shown to be a real
    // run; bucketed under an explicit label rather than silently dropped.
    const key = row.outcome ?? "outcome_not_recorded";
    excludedByOutcome[key] = (excludedByOutcome[key] ?? 0) + row.count;
  }
  return { verdicts, passed, excludedByOutcome };
}

/**
 * Runs the window aggregates and derives the three metrics. Live per
 * request (this schema has no `AdminMetricsSnapshot` table to read a
 * precomputed row from, and adding one would be a migration), so
 * `computedAt` is an honest "as of now" rather than a snapshot age.
 */
export async function computeCommunityQualityMetrics(now: Date = new Date()): Promise<CommunityQualityMetrics> {
  const since = new Date(now.getTime() - QUALITY_METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // `kind: BountyKind.community` stated explicitly, matching every other
  // Bounty/Submission aggregate in this codebase (see the /overview handler
  // and admin-overview-bounty-kind-scope.test.ts's source-level guard).
  const communityScope = { bounty: { kind: BountyKind.community } } as const;

  const [dupAgg, llmAgg, executionRows, llmUnconfigured] = await Promise.all([
    prisma.submission.aggregate({
      where: { ...communityScope, createdAt: { gte: since }, duplicateScore: { not: null } },
      _avg: { duplicateScore: true },
      _count: { duplicateScore: true },
    }),
    prisma.submission.aggregate({
      where: { ...communityScope, createdAt: { gte: since }, llmScore: { not: null } },
      _avg: { llmScore: true },
      _count: { llmScore: true },
    }),
    prisma.validationResult.groupBy({
      by: ["outcome", "passed"],
      where: { stage: "execution", createdAt: { gte: since }, submission: communityScope },
      _count: { _all: true },
    }),
    prisma.validationResult.count({
      where: { stage: "llm", createdAt: { gte: since }, outcome: UNCONFIGURED_OUTCOME, submission: communityScope },
    }),
  ]);

  const execution = foldExecutionRows(
    executionRows.map((row) => ({ outcome: row.outcome, passed: row.passed, count: row._count._all })),
  );

  return {
    windowDays: QUALITY_METRICS_WINDOW_DAYS,
    computedAt: now,
    duplicate: deriveQualityMetric({
      rate: dupAgg._avg.duplicateScore ?? null,
      sampleSize: dupAgg._count.duplicateScore,
    }),
    llm: deriveQualityMetric({
      rate: llmAgg._avg.llmScore ?? null,
      sampleSize: llmAgg._count.llmScore,
      unconfiguredCount: llmUnconfigured,
    }),
    execution: deriveQualityMetric({
      rate: execution.verdicts > 0 ? execution.passed / execution.verdicts : null,
      sampleSize: execution.verdicts,
      excludedByOutcome: execution.excludedByOutcome,
      unconfiguredCount: execution.excludedByOutcome[UNCONFIGURED_OUTCOME] ?? 0,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot layer
//
// `computeCommunityQualityMetrics` above runs four window aggregates over
// `submissions` and `validation_results`. Running it on every admin request —
// which is what this module did before the snapshot table existed — repeats
// that scan per page load on both the overview and submissions routes. V1
// solved this with `AdminMetricsSnapshot` + a worker tick
// (services/admin-metrics.ts); this is the same idea, storing the honest
// payload rather than v1's four bare floats (see the model's schema comment).
//
// The honesty rule extends to snapshot AGE: a route must be able to tell a
// fresh snapshot from one whose worker died three days ago. `readSnapshot`
// therefore returns an explicit `fresh | stale` state and never hides the age.
// ─────────────────────────────────────────────────────────────────────────────

/** The one metric set this table holds today. */
export const QUALITY_SNAPSHOT_ID = "quality_7d";

/**
 * A snapshot older than this is reported `stale` — the caller decides whether
 * to show it with an age warning or fall back to a live compute. Sized well
 * above the worker's own cadence so an ordinary slow tick never flaps.
 */
export const QUALITY_SNAPSHOT_STALE_AFTER_MS = 30 * 60_000;

export type QualitySnapshotState = "fresh" | "stale" | "never_computed";

export interface QualitySnapshotRead {
  state: QualitySnapshotState;
  /** Null only when `state === "never_computed"`. */
  metrics: CommunityQualityMetrics | null;
  computedAt: Date | null;
  ageMs: number | null;
}

/** Recomputes the aggregates and upserts the snapshot row. Worker-side. */
export async function refreshCommunityQualityMetricsSnapshot(
  now: Date = new Date(),
): Promise<CommunityQualityMetrics> {
  const metrics = await computeCommunityQualityMetrics(now);
  // `computedAt` is a Date on the in-memory type and an ISO string once it has
  // been through JSONB; `readSnapshot` revives it. Stored inside the payload as
  // well as in its own column so a payload read is self-describing.
  const payload = JSON.parse(JSON.stringify(metrics)) as Prisma.InputJsonValue;
  await prisma.adminMetricsSnapshot.upsert({
    where: { id: QUALITY_SNAPSHOT_ID },
    create: { id: QUALITY_SNAPSHOT_ID, payload, computedAt: metrics.computedAt },
    update: { payload, computedAt: metrics.computedAt },
  });
  return metrics;
}

/**
 * Reads the precomputed snapshot. Returns `never_computed` when no tick has run
 * yet (fresh environment / worker just started) — callers must surface that as
 * an explicit state, never as silently-zero real numbers.
 */
export async function readCommunityQualityMetricsSnapshot(
  now: Date = new Date(),
): Promise<QualitySnapshotRead> {
  const row = await prisma.adminMetricsSnapshot.findUnique({ where: { id: QUALITY_SNAPSHOT_ID } });
  if (!row) return { state: "never_computed", metrics: null, computedAt: null, ageMs: null };

  const ageMs = now.getTime() - row.computedAt.getTime();
  const revived = row.payload as unknown as CommunityQualityMetrics;
  return {
    state: ageMs > QUALITY_SNAPSHOT_STALE_AFTER_MS ? "stale" : "fresh",
    // The payload round-trips through JSONB, so `computedAt` comes back as a
    // string; hand callers the typed column value instead of the revived one.
    metrics: { ...revived, computedAt: row.computedAt },
    computedAt: row.computedAt,
    ageMs,
  };
}

/**
 * What the admin routes should call: a FRESH snapshot if the worker has
 * produced one, otherwise a live compute.
 *
 * The fallback is deliberate and must not be removed for "consistency". A
 * never-computed or stale snapshot means the metrics worker is not running —
 * serving a three-day-old rate as if it were current would be exactly the kind
 * of dishonest reporting this module exists to prevent, and serving nothing at
 * all would break the page over an operational problem. Computing live is
 * slower but always truthful, and `computedAt` on the returned value tells the
 * caller which path produced it (a snapshot read carries the snapshot's own
 * timestamp; a live compute carries `now`).
 *
 * The stale case is separately visible to operators: the watchdog raises
 * `worker_stale:admin-metrics-snapshot` when that loop stops ticking.
 */
export async function getCommunityQualityMetrics(now: Date = new Date()): Promise<CommunityQualityMetrics> {
  const snapshot = await readCommunityQualityMetricsSnapshot(now);
  if (snapshot.state === "fresh" && snapshot.metrics) return snapshot.metrics;
  return computeCommunityQualityMetrics(now);
}
