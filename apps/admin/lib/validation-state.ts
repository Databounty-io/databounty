// SPDX-License-Identifier: Apache-2.0

/**
 * ADMIN COPY of the canonical validation-stage decoder.
 *
 * The reference implementation lives at `community/apps/web/lib/api-work.ts`
 * (`validationStageState`, `normalizeValidationStage`, `llmScoreTo01`). This
 * file MUST stay in sync with it. It cannot import from it: `apps/admin` is a
 * separate Next application with its own `tsconfig.json` `@/*` root, and the
 * two apps share no published package — an import across the app boundary
 * would not resolve at build time. So the rule is duplicated here, deliberately
 * and in one place per app, rather than re-derived inline at each render site.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `ValidationResult.passed === false` is FOUR different things, and reading it
 * as a boolean made this console report several of them as a red "failed":
 *
 *   - `score == null`  ⇒ nothing ran. A hold: queued, not reached, no provider
 *                        configured, deferred to pool close-out. Not a verdict.
 *   - terminal-without-score ⇒ a real refusal that also has no score. The one
 *                        real case is `pool_capacity_reached`: the pool filled
 *                        before this item could be counted, and the submission
 *                        is rejected outright. Rendering it as "pending" tells
 *                        the reader to wait for a check that already refused.
 *   - `score != null` and the stage ESCALATES ⇒ flagged for a human validator.
 *                        `ai_attribution` flagged writes `passed: false,
 *                        score: 1` with `detail.status: "flagged"` — nothing
 *                        failed; a disclosure was found and a human must judge
 *                        whether the contract permits it. `dedupe`
 *                        `review_required` is an escalation by definition.
 *   - `llm` ⇒ its own state. A failing LLM verdict is a genuine advisory
 *                        quality verdict, but it gates nothing: every item that
 *                        clears execution still goes to a human validator
 *                        regardless of the LLM's answer. So it is neither
 *                        terminal "failed" nor an open escalation. It renders
 *                        as "review fail", the wording the contributor and
 *                        validator surfaces already use for the same row.
 *
 * ── Wire-shape caveat ──────────────────────────────────────────────────────
 * `ai_attribution` rows and PASSING `dedupe` rows are written with NO `outcome`
 * column at all, so they can only be decoded from `detailJson`. Any admin
 * payload that carries `outcome`/`status` alone therefore cannot classify them;
 * this decoder degrades to "failed" in that case rather than inventing an
 * escalation it has no evidence for. The admin submission/user payloads are
 * being widened concurrently to send `detailJson` too — `stageFromAdminPayload`
 * below reads it when present and falls back when it is absent, so both wire
 * shapes render.
 */

export type ValidationStageState = "passed" | "failed" | "flagged" | "review_fail" | "hold";

/**
 * Stages that are TERMINAL even with `score == null`, so the "no score means
 * nothing ran" rule must not swallow them. Keyed on `ValidationResult.outcome`.
 */
const TERMINAL_WITHOUT_SCORE = new Set(["pool_capacity_reached"]);

/**
 * `ValidationResult.stage` is written literally as `duplicate_check` on the API
 * (see every write site in `services/validation.ts`), while every display
 * surface calls that stage `dedupe`. Normalize before any stage comparison or
 * `map.get("dedupe")` lookup, or the duplicate-check row silently misses and
 * reads as permanently "not reached".
 */
export function normalizeValidationStage(stage: string): string {
  return stage === "duplicate_check" ? "dedupe" : stage;
}

export function validationStageState(result: {
  stage: string;
  passed: boolean;
  score: number | null;
  outcome?: string | null;
  detailJson?: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
}): ValidationStageState {
  if (result.passed) return "passed";
  const detail = (result.detailJson ?? result.detail ?? {}) as Record<string, unknown>;
  const stage = normalizeValidationStage(result.stage);
  if (result.outcome != null && TERMINAL_WITHOUT_SCORE.has(result.outcome)) return "failed";
  if (stage === "pool_capacity") return "failed";
  if (result.score == null) return "hold";
  // Decoded from `detailJson` only — these two stages write no `outcome`.
  if (stage === "ai_attribution" && detail.status === "flagged") return "flagged";
  if (stage === "llm") return "review_fail";
  if (stage === "dedupe" && (detail.duplicateDecision === "review_required" || detail.decision === "review_required")) {
    return "flagged";
  }
  return "failed";
}

/** The wording each state renders as — the same labels the contributor and
 *  validator surfaces use, so the three consoles no longer disagree about the
 *  same row. */
export const VALIDATION_STAGE_STATE_LABEL: Record<ValidationStageState, string> = {
  passed: "passed",
  failed: "failed",
  flagged: "flagged for review",
  review_fail: "review fail",
  hold: "pending / blocked",
};

/** Pill tone per state. `flagged` and `hold` are amber because neither is a
 *  verdict; `review_fail` is red because the LLM verdict itself did fail, even
 *  though it gates nothing. */
export const VALIDATION_STAGE_STATE_TONE: Record<ValidationStageState, "success" | "warning" | "danger"> = {
  passed: "success",
  failed: "danger",
  flagged: "warning",
  review_fail: "danger",
  hold: "warning",
};

/**
 * The stage shape the admin submission/user payloads send: `status` IS the
 * `ValidationResult.outcome` column (`admin-internal.ts` `buildValidationStages`
 * and `admin-submissions.ts` both map `status: r.outcome`), and `detailJson` is
 * being added alongside it. Decode through this so a payload with either shape
 * classifies correctly.
 */
export function stageStateFromAdminStage(stage: {
  stage: string;
  passed: boolean;
  score: number | null;
  status?: string | null;
  detailJson?: Record<string, unknown> | null;
}): ValidationStageState {
  return validationStageState({
    stage: stage.stage,
    passed: stage.passed,
    score: stage.score,
    outcome: stage.status ?? null,
    detailJson: stage.detailJson ?? null,
  });
}

/**
 * Stages whose `score` is stored on a 0–100 scale rather than 0–1. `llm` is the
 * only one: `dedupe` (Jaccard/similarity) and `execution` (pass ratio) are
 * already 0–1. A single `toFixed(2)` across all of them printed an LLM 95 as
 * "95.00" beside a dedupe "0.92" — the same column claiming two different
 * scales — so normalize before formatting.
 */
const HUNDRED_SCALE_STAGES = new Set(["llm"]);

/**
 * A stage score on one honest 0–1 scale. The `> 1` test is the same magnitude
 * heuristic `llmScoreTo01` uses in the web app, so both apps print the same
 * number for the same stored score. It has one ambiguous point — a literal 1
 * reads as 1.00, not 1/100 — which is the safe reading for a 0–1 source and a
 * vanishingly rare score for a 0–100 one.
 */
export function stageScoreTo01(stage: string, score: number): number {
  return HUNDRED_SCALE_STAGES.has(normalizeValidationStage(stage)) && score > 1 ? score / 100 : score;
}

/** Two-decimal 0–1 stage score, or null when nothing was recorded — callers
 *  choose their own absent-wording rather than getting a bare dash here. */
export function formatStageScore(stage: string, score: number | null): string | null {
  if (score == null) return null;
  return stageScoreTo01(stage, score).toFixed(2);
}
