// SPDX-License-Identifier: Apache-2.0

import type { DatasetCategory } from "./types";

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export const CATEGORY_LABELS: Record<DatasetCategory, string> = {
  debugging: "Debugging / Bug Fix",
  implementation: "Function / Feature Implementation",
  test_generation: "Test Generation",
  error_diagnosis: "Error Diagnosis",
  migration: "Migration / Refactor",
};

export const BOUNTY_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  planning: "Planning",
  platform_review: "Platform review",
  active: "Active",
  paused: "Paused",
  closing: "Closing",
  export_ready: "Export ready",
  completed: "Completed",
  partially_completed: "Partially completed",
  cancelled: "Cancelled",
  disputed: "Disputed",
};

export const SUBMISSION_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  duplicate_check: "Running duplicate check",
  // Deprecated status. External-corpus plagiarism screening was removed from
  // the pipeline by owner decision; nothing transitions a submission here, and
  // the label must not claim a check is running.
  contamination_check: "Deprecated status",
  running_tests: "Running tests",
  tests_failed: "Tests failed",
  llm_validation: "Running LLM validation",
  needs_fixes: "Needs fixes",
  provisionally_accepted: "Provisionally accepted",
  in_audit: "In audit",
  accepted_pending_sample: "Awaiting next audit window",
  flagged: "Flagged",
  disputed: "Disputed",
  accepted: "Accepted",
  rejected: "Rejected",
  karma_released: "Karma released",
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

export const CONTRIBUTOR_RANKS = [
  "Scout",
  "Apprentice",
  "Builder",
  "Specialist",
  "Craftsman",
  "Senior Builder",
  "Expert",
  "Architect",
  "Principal",
  "Master Builder",
];

export const VALIDATOR_RANKS = [
  "Observer",
  "Reviewer",
  "Inspector",
  "Auditor",
  "Senior Auditor",
  "Quality Lead",
  "Verifier",
  "Principal Verifier",
  "Arbiter",
  "Master Arbiter",
];

export const GENERATION_LABELS: Record<string, string> = {
  human: "Human",
  ai_assisted: "AI-assisted",
  ai_generated: "AI-generated",
};

export const AUDIT_MODE_LABELS: Record<string, string> = {
  llm_only: "LLM only",
  partial: "Partial audit (25%)",
  full: "Full audit (100%)",
};

/** A percentage, or an em dash when the value was never measured. Keeps
 * "not measured" visually distinct from a measured zero. */
export function optionalPct(value: number | undefined): string {
  return typeof value === "number" ? pct(value) : "—";
}

/** A count, or an em dash when the value was never measured. */
export function optionalNum(value: number | undefined): string {
  return typeof value === "number" ? num(value) : "—";
}

/** ISO timestamp -> YYYY-MM-DD. Falls back to the raw string if unparseable. */
export function isoDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10);
}
