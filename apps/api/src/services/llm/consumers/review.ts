// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { llm } from "../service.js";
import { LlmUnavailableError } from "../types.js";

/**
 * Submission-review consumer — the non-fakeable quality gate. Ported from v1's
 * `services/llm/consumers/review.ts` (which v1 reaches through
 * `services/validation-pipeline.ts`'s `llm` stage).
 *
 * WHY THIS FILE EXISTS AT ALL. The call it makes used to live in
 * `services/llm-client.ts` as a direct `fetch` to OpenRouter with a hardcoded
 * prompt and a hardcoded two-model list. That made `submission_review` a lie
 * on the admin console: `features.ts` renders it as a configurable feature
 * (model routing, system prompt, params) and `routes/v1/admin-llm.ts` accepts
 * an `LlmRoutingOverride` row against it, but nothing read either — the stored
 * override changed no byte of the outbound request. Routing it through
 * `llm.complete()` makes those controls real, and brings this call under the
 * layer's guardrails, failover chain, data-class routing, spend governor,
 * circuit breaker and `llm_audit_log` evidence trail like every other feature.
 *
 * THE FAIL-CLOSED CONTRACT, and why it is expressed by an ABSENCE:
 *
 * `llm.complete()` guarantees no-throw *only when the caller supplies a
 * `fallback`* — the deterministic safe default the caller owns. Every planner
 * consumer supplies one so planner assists work with zero API keys, and
 * `validate-field.ts` then re-checks `res.fallbackUsed` and reports
 * "review unavailable" rather than passing the deterministic answer off as an
 * AI verdict.
 *
 * This consumer deliberately supplies NO fallback. There is no
 * domain-correct deterministic verdict for "is this contributor's submission
 * correct?", and for a quality gate the difference between the planner case
 * and this one is severity: a planner field guard that fabricated a pass would
 * let a weak title through, whereas a submission review that fabricated one
 * would put a platform trust claim ("quality score 92/100") behind a model run
 * that never happened. So instead of a fallback plus a `fallbackUsed` check —
 * which is only as safe as the caller remembering to make the check — the
 * absence makes the layer throw `LlmUnavailableError`, and it is structurally
 * impossible for any code path here to yield a passing verdict without a live
 * model having answered.
 *
 * Both call sites already treat a throw as the honest-unavailable path and
 * neither one lets an item through on it:
 *   - `services/validation.ts` records an `llm` `ValidationResult` with
 *     outcome `provider_error` and routes the item to a human validator.
 *   - `services/jobs/sponsor-reference-review.ts` re-queues the job until its
 *     retry budget is gone, then records a `pending` processing event for an
 *     admin to review by hand.
 *
 * A model that answers with something OTHER than the required shape is the
 * same fail-closed path, not a lenient one: the strict schema below fails, the
 * layer spends its one bounded repair round-trip, and a still-invalid reply
 * advances to the next candidate and ultimately to the (absent) fallback. In
 * particular `verdict` accepts only `pass`/`fail`; a model hedging with
 * "uncertain" is treated as no answer rather than being silently coerced into
 * either direction.
 */

/** The verdict shape both call sites consume. Unchanged from the pre-layer
 * `llm-client.ts` contract on purpose: `score` stays 0-100 (written to
 * `Submission.llmScore` and `ValidationResult.score`, and rendered by
 * `apps/web` as "score/100"), so moving the call site changed no stored value
 * and no user-visible number. v1's consumer returns 0-1 against an
 * admin-settable pass threshold; that difference predates this change and is
 * a separate parity item, not something this file should silently flip
 * underneath existing rows. */
export interface LlmReviewVerdict {
  passed: boolean;
  score: number;
  reasons: string[];
  model: string;
}

/** Strict verdict schema. `z.preprocess` normalises only formatting — models
 * occasionally quote the score — and never the verdict itself. This mirrors
 * what the pre-layer client did by hand (coerce a numeric string, clamp to
 * 0-100, drop non-string reasons, cap the list) so a model reply that used to
 * be accepted still is. */
const verdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  score: z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
    z.number().finite()
  ),
  reasons: z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((r): r is string => typeof r === "string").slice(0, 10) : []),
    z.array(z.string())
  ),
});

/** The rubric handed to the model as DATA in the user message. The trusted
 * instruction is the system prompt, which the layer resolves through
 * `resolveSystemPrompt` (code default in `features.ts`, overridable per
 * admin/account in `admin_settings`) — so this consumer must not restate it. */
function rubricPayload(params: {
  datasetTypeName: string;
  contractFields: { key: string; role?: string }[];
  payload: Record<string, unknown>;
}): string {
  return JSON.stringify(
    {
      dataset_type: params.datasetTypeName,
      contract_fields: params.contractFields,
      submitted_item: params.payload,
      rubric:
        "Score 0-100. 90+: correct, complete, matches every contract field's role, high quality. " +
        "60-89: minor issues, still usable. Below 60: incorrect, incomplete, or violates the contract.",
      required_output_shape: { verdict: "pass | fail", score: "0-100 integer", reasons: "array of short strings" },
    },
    null,
    0
  );
}

/**
 * Review one submitted item against its dataset-type contract.
 *
 * THROWS when no live model produced a verdict — no key configured, feature
 * disabled by an admin override, every routed model exhausted, over the spend
 * cap, or a reply that never validated. Callers must treat that as
 * "unavailable", never as a result. See the fail-closed note above.
 */
export async function reviewSubmission(params: {
  datasetTypeName: string;
  contractFields: { key: string; role?: string }[];
  payload: Record<string, unknown>;
  /** Rate-limit and audit attribution; optional because the sponsor-reference
   * job reviews an admin-uploaded example that has no contributor. */
  userId?: string;
  /** Selects an account-scoped routing override, if one exists. */
  accountId?: string;
  /**
   * Stable per-item identity (e.g. `<submissionId>:<validationAttempt>`).
   * Correlates the `llm_audit_log` row with the item under review. It is NOT
   * a cache key here: `submission_review` is `dataClass: "proprietary"`, and
   * the service refuses to cache any proprietary-class call (see
   * `service.ts`), so a re-run always re-asks a live model.
   */
  idempotencySuffix?: string;
}): Promise<LlmReviewVerdict> {
  const res = await llm.complete({
    feature: "submission_review",
    userId: params.userId,
    accountId: params.accountId,
    ...(params.idempotencySuffix ? { idempotencyKey: `submission-review:${params.idempotencySuffix}` } : {}),
    schema: verdictSchema,
    messages: [{ role: "user", content: rubricPayload(params) }],
    // NO `fallback`. This is the fail-closed contract, not an omission —
    // `llm.complete` raises LlmUnavailableError instead of inventing a
    // verdict. Do not add one.
  });

  // Unreachable while no fallback is supplied (the layer throws first), but
  // asserted rather than assumed: if a future edit ever adds a `fallback`
  // above, this turns a fabricated pass into a loud failure instead of a
  // silent trust claim.
  if (res.fallbackUsed) {
    throw new LlmUnavailableError(
      "submission_review",
      "the deterministic fallback answered; a fabricated verdict must never be reported as a review"
    );
  }

  return {
    passed: res.data.verdict === "pass",
    score: Math.max(0, Math.min(100, res.data.score)),
    reasons: res.data.reasons,
    model: res.model,
  };
}
