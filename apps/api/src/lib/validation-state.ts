// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side decoding of the `ValidationResult` sentinel.
 *
 * `ValidationResult.passed === false` is OVERLOADED — it encodes four
 * different states, separated only by `score`, `stage` and `outcome`:
 *
 *   - `outcome: "pool_capacity_reached"` (or stage `pool_capacity`)
 *        TERMINAL rejection even though `score` is null — the pool filled
 *        before the item could be counted (services/validation.ts:244-253).
 *   - `score == null`
 *        NOTHING RAN. A hold: queued, not reached, no provider configured,
 *        the stage switched off. Never a failure.
 *   - `score != null`, escalating stage
 *        Flagged for a human validator; NOT terminal. `ai_attribution` with
 *        `detailJson.status === "flagged"`, or `dedupe` with
 *        `detailJson.duplicateDecision === "review_required"`.
 *   - `score != null`, stage `llm`
 *        An ADVISORY verdict that failed but gates nothing. validation.ts:396:
 *        an LLM verdict "never changes the accept/reject OUTCOME below: every
 *        item that clears execution still goes to a human validator regardless
 *        of the LLM's answer". Measured in community_test: 99 of 100
 *        `llm_fail` items are already `accepted`.
 *   - `score != null`, terminal stage
 *        Genuinely failed (`execution` fail, `dedupe` `rejected`).
 *
 * This mirrors `apps/web/lib/api-work.ts`'s `validationStageState` and
 * `apps/admin/lib/validation-state.ts`. It cannot import either — three
 * separate apps, no shared package — so all three must be changed together.
 *
 * NOTE ON `outcome` COVERAGE: `ai_attribution` (validation.ts:144) and a
 * PASSING `dedupe` (validation.ts:92) are written with NO `outcome` column at
 * all. Those two can only be classified from `detailJson`. Any payload that
 * ships `outcome` but not `detailJson` cannot classify them — send both.
 */

export type ValidationStageState = "passed" | "failed" | "flagged" | "review_fail" | "hold";

/** Stages that are terminal despite carrying no score. */
const TERMINAL_OUTCOMES = new Set(["pool_capacity_reached"]);

/** The API stores this stage as `duplicate_check`; every display surface calls it `dedupe`. */
export function normalizeValidationStage(stage: string): string {
  return stage === "duplicate_check" ? "dedupe" : stage;
}

export interface StageRow {
  stage: string;
  passed: boolean;
  score: number | null;
  outcome?: string | null;
  detailJson?: unknown;
}

export function validationStageState(row: StageRow): ValidationStageState {
  if (row.passed) return "passed";
  const detail = (row.detailJson ?? {}) as Record<string, unknown>;
  const stage = normalizeValidationStage(row.stage);
  if (row.outcome != null && TERMINAL_OUTCOMES.has(row.outcome)) return "failed";
  if (stage === "pool_capacity") return "failed";
  if (row.score == null) return "hold";
  if (stage === "ai_attribution" && detail.status === "flagged") return "flagged";
  if (stage === "llm") return "review_fail";
  if (stage === "dedupe" && (detail.duplicateDecision === "review_required" || detail.decision === "review_required")) {
    return "flagged";
  }
  return "failed";
}

/**
 * The stage that actually caused an automated rejection, or `undefined` when
 * no stage did.
 *
 * Replaces a bare `find((r) => !r.passed)`, which was wrong in three ways at
 * once. That predicate selected any non-passing row, and because the caller
 * builds its stage map from rows ordered `createdAt: desc` (first-wins), the
 * map's iteration order is NEWEST-STAGE-FIRST — so `llm`, the last stage
 * written, was almost always selected. With the LLM stage switched off (the
 * platform default) an `llm` row is `passed: false, score: null`, so an admin
 * decision record read "Automated llm did not pass." for a stage that never
 * ran: a false statement in an admin record, which also SHADOWED the stage
 * that really did reject the item.
 *
 * Only a `failed` state can be a rejection cause:
 *   - `hold` never rejected anything — it did not run.
 *   - `flagged` escalates to a human; it does not reject.
 *   - `review_fail` (`llm`) explicitly "never changes the accept/reject
 *     OUTCOME", so it can never be the cause.
 */
export function findRejectingStage<T extends StageRow>(rows: T[]): T | undefined {
  return rows.find((r) => validationStageState(r) === "failed");
}

/**
 * ` (score N)` for a stage score, or `""` when there is none.
 *
 * `llm` stores its score 0-100 while `dedupe`/`execution` store 0-1, so a
 * single `toFixed(2)` across both printed `(score 0.92)` beside
 * `(score 87.00)` with no unit. Normalized to a percentage so one reading
 * works for every stage.
 */
export function formatStageScoreSuffix(row: Pick<StageRow, "score">): string {
  if (row.score == null) return "";
  const pct = Math.round((row.score > 1 ? row.score / 100 : row.score) * 100);
  return ` (score ${pct}%)`;
}
