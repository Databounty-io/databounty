// SPDX-License-Identifier: Apache-2.0

import type { JsonRecord } from "./execution-providers/types.js";

/**
 * Ported from V1 (databounty-api/src/services/ai-attribution.ts).
 *
 * Evidence-based attribution check. This deliberately detects only explicit
 * model/co-author disclosures; it does not pretend to infer authorship from
 * writing style. Research shows general-purpose AI-text detectors are not
 * reliable enough for a punitive automated decision.
 *
 * Cheap, deterministic, dependency-free text scan — no LLM call, no API key,
 * no external service. It is wired into services/validation.ts as an
 * unconditional stage that runs on every submission (see the comment there
 * for why this diverges from V1's admin-configurable `pipeline` allowlist
 * mechanism, which community's rebuilt validation.ts does not use at all).
 */
// Provider/model names are intentionally matched only when the surrounding
// language asserts generation, authorship, or co-authorship. A dataset item
// may legitimately discuss any of these products, so a bare name is never a
// flag. Extend this registry rather than adding one-off vendor checks.
const MODEL_OR_TOOL = [
  "openai", "chatgpt", "gpt(?:[- ]?(?:3(?:\\.5)?|4(?:o)?|5))?", "codex",
  "anthropic", "claude", "gemini", "google ai", "bard", "copilot", "github copilot",
  "mistral", "le chat", "llama", "meta ai", "deepseek", "grok", "xai", "qwen",
  "perplexity", "poe", "cursor", "tabnine", "codewhisperer", "amazon q", "replit ai",
  "cohere", "command r", "ai21", "phind",
].join("|");

const DISCLOSURES: Array<{ id: string; pattern: RegExp }> = [
  { id: "ai_language_model", pattern: /\bas an ai(?:[-\s]+powered)? language model\b/i },
  { id: "model_identity", pattern: new RegExp(`\\b(?:i am|i'?m)\\s+(?:${MODEL_OR_TOOL}|an ai(?:[-\\s]+powered)? language model)\\b`, "i") },
  { id: "generated_by_model", pattern: new RegExp(`\\b(?:generated|written|created|produced|drafted|authored)\\s+(?:entirely\\s+)?by\\s+(?:${MODEL_OR_TOOL}|an ai(?:[-\\s]+powered)? (?:tool|model))\\b`, "i") },
  { id: "coauthor_disclosure", pattern: new RegExp(`\\b(?:co-?authored|co-?written|assisted|with help)\\s+(?:by|with)\\s+(?:${MODEL_OR_TOOL}|an ai(?:[-\\s]+powered)? (?:tool|model))\\b`, "i") },
  { id: "generic_ai_generated", pattern: /\b(?:ai|llm|machine)[-\s]?(?:generated|written|authored|produced)\b/i },
];
const MAX_SCANNED_CHARS = 100_000;
const MAX_VISITED_VALUES = 10_000;
export const AI_ATTRIBUTION_CHECKER_VERSION = "2026-07-22.2";

export interface AiAttributionResult {
  passed: boolean;
  score: number;
  detail: JsonRecord;
}

function collectPayloadText(value: unknown): { text: string; truncated: boolean; visitedValues: number } {
  // Iterative traversal prevents a deeply nested, attacker-controlled JSON
  // payload from overflowing the worker stack. Both node and character caps
  // make work O(min(payload, configured bounds)) per submission.
  const pending: unknown[] = [value];
  const strings: string[] = [];
  let remainingChars = MAX_SCANNED_CHARS;
  let visitedValues = 0;
  let truncated = false;
  while (pending.length > 0 && remainingChars > 0 && visitedValues < MAX_VISITED_VALUES) {
    const current = pending.pop();
    visitedValues += 1;
    if (typeof current === "string") {
      const chunk = current.slice(0, remainingChars);
      remainingChars -= chunk.length;
      strings.push(chunk);
      if (chunk.length < current.length) truncated = true;
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current && typeof current === "object") {
      pending.push(...Object.values(current as Record<string, unknown>));
    }
  }
  if (pending.length > 0) truncated = true;
  return { text: strings.join("\n"), truncated, visitedValues };
}

export function checkAiAttribution(payload: JsonRecord): AiAttributionResult {
  const { text, truncated, visitedValues } = collectPayloadText(payload);
  const matches = DISCLOSURES.flatMap(({ id, pattern }) =>
    [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))]
      .slice(0, 20)
      .map((found) => ({ id, excerpt: found[0].slice(0, 200) }))
  ).slice(0, 50);
  const common = {
    checkerVersion: AI_ATTRIBUTION_CHECKER_VERSION,
    coverage: "submitted_payload_text_only",
    scannedChars: text.length,
    visitedValues,
    truncated,
  };
  return {
    passed: matches.length === 0,
    score: matches.length ? 1 : 0,
    detail: matches.length
      ? { status: "flagged", matches, ...common, reason: "Explicit AI attribution or co-author disclosure requires validator review." }
      : { status: truncated ? "partial_scan" : "clear", ...common, reason: truncated ? "No explicit attribution was found in the bounded scanned portion; unscanned content requires the applicable modality/profile review." : "No explicit AI attribution or co-author disclosure was detected in submitted textual payload fields." },
  };
}
