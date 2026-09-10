// SPDX-License-Identifier: Apache-2.0

import type { AdminPillTone } from "@/components/admin-shell";

/** Lifecycle status of a sponsor's community dataset request. Shared here
 * because both /community-requests (the review queue) and the sponsor's
 * /users/view profile render the same underlying record — a tone mapping
 * that only lived on one page previously let the two disagree on how
 * "approved" should look (drifted to neutral on the profile view). */
export type CommunityRequestStatus =
  | "submitted"
  | "under_review"
  | "changes_requested"
  | "disputed"
  | "approved"
  | "declined"
  | "implemented";

export const COMMUNITY_REQUEST_STATUS_TONE: Record<CommunityRequestStatus, AdminPillTone> = {
  submitted: "neutral",
  under_review: "info",
  changes_requested: "warning",
  disputed: "warning",
  approved: "success",
  implemented: "lime",
  declined: "danger",
};

export function num(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

export function pct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

/** Same rendering as `pct()`, for a value that is ALREADY on a 0-100 scale
 * (e.g. `stats.llmPassRate`, an average of `ValidationResult.score` for the
 * "llm" stage — that score is a 0-100 rubric integer per
 * `services/llm-client.ts`, unlike the 0-1 fraction every other stage's
 * `score` uses). Passing an already-0-100 value through `pct()` re-multiplies
 * by 100 and renders a four-digit reading like "4054%" — use this instead
 * wherever the source value is already a percentage. */
export function pctFromScore100(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${Math.round(n)}%`;
}

export const GENERATION_LABELS: Record<string, string> = {
  human: "Human",
  ai_assisted: "AI-assisted",
  ai_generated: "AI-generated",
};

// Community submission status labels:
export const SUBMISSION_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  duplicate_check: "Running duplicate check",
  running_tests: "Running tests",
  tests_failed: "Tests failed",
  llm_validation: "Running LLM validation",
  needs_fixes: "Needs fixes",
  provisionally_accepted: "Provisionally accepted",
  in_audit: "Awaiting validator audit",
  in_sponsor_review: "Awaiting sponsor review",
  accepted_pending_sample: "Awaiting next audit window",
  flagged: "Flagged",
  disputed: "Disputed",
  accepted: "Accepted",
  rejected: "Rejected",
};

export const FLAG_REASON_LABELS: Record<string, string> = {
  duplicate: "Duplicate or near-duplicate",
  wrong_category: "Wrong category",
  prompt_unclear: "Prompt unclear",
  solution_incorrect: "Solution incorrect",
  tests_weak_or_missing: "Tests weak or missing",
  code_mismatch: "Code does not match prompt",
  too_trivial: "Too trivial",
  unrealistic: "Unrealistic example",
  license_concern: "License/provenance concern",
  benchmark_copy: "Likely copied benchmark",
  schema_issue: "Formatting/schema issue",
  other: "Other",
};
