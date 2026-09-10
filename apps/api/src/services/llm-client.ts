// SPDX-License-Identifier: Apache-2.0

import { config } from "../config.js";

/**
 * WHAT IS LEFT IN THIS FILE, AND WHY IT SHRANK.
 *
 * This used to be a standalone OpenRouter client: a hardcoded system prompt, a
 * hardcoded two-model list, and a direct `fetch` — the whole submission-review
 * call, sitting outside `services/llm/`. That made the admin console's /llm
 * page dishonest about `submission_review`: `services/llm/features.ts` renders
 * it as a configurable feature and `routes/v1/admin-llm.ts` will store an
 * `LlmRoutingOverride` against it, but nothing on this path read either, so the
 * stored model / prompt / params changed nothing about the real request.
 *
 * The call now lives at `services/llm/consumers/review.ts` and goes through
 * `llm.complete()` like every other feature, so those controls are real. Read
 * that file for the fail-closed contract (it deliberately supplies no
 * deterministic fallback, so an unavailable model raises rather than
 * fabricating a verdict).
 *
 * `reviewSubmissionWithLlm` is kept as a name-compatible alias because
 * `services/jobs/sponsor-reference-review.ts` imports it; it is the same
 * function, not a second implementation.
 */
export { reviewSubmission as reviewSubmissionWithLlm, type LlmReviewVerdict } from "./llm/consumers/review.js";

/**
 * Is a provider credential present at all in this environment?
 *
 * Read by ten-odd surfaces (`routes/v1/meta.ts`, `mcp/tools.ts`,
 * `services/bounties.ts`, …) to publish `llmProviderConfigured` as a fact
 * SEPARATE from the `validation.llm.enabled` admin switch, so a client can
 * tell "the stage is off" from "the stage is on but nothing can run" without
 * either state being presented as a pass. It stays here rather than moving
 * into the LLM layer because it is a plain environment predicate, not a
 * routing decision: the layer's own per-provider `isConfigured()` checks are
 * what actually gate egress.
 *
 * It answers only for OpenRouter because OpenRouter is the sole provider
 * credential this deployment wires (`src/config.ts`, `services/llm/registry.ts`).
 * If an Anthropic/OpenAI key is ever added, this predicate has to widen with it
 * — otherwise these surfaces would report "no provider" while the layer
 * happily routed a call.
 */
export function openRouterConfigured(): boolean {
  return Boolean(config.openRouterApiKey);
}
