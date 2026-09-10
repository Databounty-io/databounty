// SPDX-License-Identifier: Apache-2.0

import type { DatasetCategory, BountyStatus, SubmissionStatus } from "./types";

export function karmaAward(n: number): string {
  return (
    n.toLocaleString("en-US", {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }) + " karma"
  );
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** `karmaPerAcceptedItem === 0` is the backend's "matrix-priced, no fixed
 * rate" sentinel (see acceptedItemKarmaForBounty in the API) — the real
 * per-item award is computed dynamically at acceptance and can be nonzero.
 * Every surface that shows a community pool's per-item rate must go through
 * this so "+0 karma" is never shown for work that actually pays. */
export function karmaPerItemLabel(karmaPerAcceptedItem: number): string {
  return karmaPerAcceptedItem > 0 ? `+${karmaPerAcceptedItem} karma` : "market-priced karma";
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Same rounding as `pct`, but safe for scores that may not exist yet
 * (a stage that hasn't produced a score, or a review with no rating).
 * Renders "—" for null/undefined instead of throwing or showing "NaN%".
 * Was previously redefined identically in three files
 * (components/llm-review-card.tsx, components/stage-evidence-cards.tsx,
 * components/sponsor-submission-detail.tsx) — consolidated here so a future
 * fix to this formatting only has to happen once. */
export function pctOrDash(n?: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

export function shortAddr(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

// The tier-gate countdown ("opens in 3d") and open-date ("Aug 8") labels used
// to be computed here from the raw `claimableAt` timestamp. They now come
// pre-rendered from the API (`claimableLabel` / `claimableOnLabel` on
// GET /v1/community/batches, via `claimGateLabels` in the karma service): the
// wait is a policy fact the server enforces with a 409, so the server also owns
// how it reads — the client renders the string verbatim and does no date math.

/**
 * "Due Aug 6, 2026" for a deadline ISO string, or "Deadline pending" when there
 * isn't one yet (a batch's window starts on claim, so an unclaimed row has no
 * date). Shared rather than per-page: this was a private helper in the
 * contributor workspace while the claim toast printed the raw ISO timestamp
 * straight from the API.
 */
export function deadlineLabel(value: string): string {
  if (!value) return "Deadline pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `Due ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

/** Acronyms that must keep their casing when a raw key is humanized. */
const KEY_ACRONYMS: Record<string, string> = {
  llm: "LLM",
  ai: "AI",
  karma: "Karma",
  hf: "HF",
  mcp: "MCP",
  api: "API",
  id: "ID",
  url: "URL",
  pii: "PII",
};

/**
 * Turn an internal snake_case identifier into readable sentence case.
 *
 * This is the LAST-RESORT fallback for values with no curated label (a new enum
 * member, an unmapped stage). It exists so an unmapped key degrades to
 * "Needs fixes" rather than leaking `needs_fixes` into the UI. Prefer a curated
 * label map (SUBMISSION_STATUS_LABELS, FLAG_REASON_LABELS, stageLabel, …) when
 * the wording matters — this only guarantees it is never raw.
 */
export function humanizeKey(key: string): string {
  const words = key
    .split("_")
    .filter(Boolean)
    .map((word) => KEY_ACRONYMS[word.toLowerCase()] ?? word);
  if (words.length === 0) return key;
  const [first, ...rest] = words;
  const head = KEY_ACRONYMS[first.toLowerCase()] ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(" ");
}

export const CATEGORY_LABELS: Record<DatasetCategory, string> = {
  debugging: "Debugging / Bug Fix",
  implementation: "Function / Feature Implementation",
  test_generation: "Test Generation",
  error_diagnosis: "Error Diagnosis",
  migration: "Migration / Refactor",
};

export const BOUNTY_STATUS_LABELS: Record<BountyStatus, string> = {
  draft: "Draft",
  planning: "Planning spec",
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

/**
 * One sentence per bounty status, written for the sponsor who owns it: what
 * state the bounty is in and who has to act next. Shown in an `InfoTip` beside
 * `BountyStatusPill` so a pill like "Awaiting full start" isn't left to be
 * guessed at.
 *
 * Exhaustive over `BountyStatus` on purpose — the compiler then rejects a
 * renamed or added enum value instead of silently rendering no explanation.
 * Several states the API cannot currently produce (`draft`, `platform_review`,
 * `closing`, `export_ready`,
 * bounty-level `disputed`) are still described, because the pill renders
 * whatever the server sends and an unexplained pill is worse than a rare one.
 */
export const BOUNTY_STATUS_HELP: Record<BountyStatus, string> = {
  draft: "Spec is being drafted and has not been submitted.",
  planning: "Spec is being refined with community requirements.",
  platform_review: "Held for platform review before opening.",
  active: "Live and open — contributors are submitting items. You can monitor progress or review accepted work.",
  paused: "An admin paused intake. Submissions are preserved until resumed.",
  closing: "Intake is closing — in-flight validations and audits are finishing.",
  export_ready: "Intake completed and validated; artifacts are prepared for public release.",
  completed: "All items completed and verified. The dataset is ready for export.",
  partially_completed: "Closed with accepted items short of the target count.",
  cancelled: "Cancelled before any contributor claimed work.",
  disputed: "A platform-level dispute was opened on this dataset pool.",
};


export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  duplicate_check: "Running duplicate check",
  running_tests: "Running tests",
  tests_failed: "Tests failed",
  llm_validation: "Running LLM validation",
  needs_fixes: "Needs fixes",
  provisionally_accepted: "Provisionally accepted",
  accepted_pending_sample: "Awaiting next audit window",
  in_audit: "Awaiting validator audit",
  in_sponsor_review: "Awaiting sponsor review",
  flagged: "Flagged",
  disputed: "Disputed",
  accepted: "Accepted",
  rejected: "Rejected",
  completed_settled: "Completed",
};

export const FLAG_REASON_LABELS: Record<string, string> = {
  duplicate: "Duplicate or near-duplicate",
  contaminated: "Contaminated source",
  wrong_category: "Wrong category",
  prompt_unclear: "Prompt unclear",
  solution_incorrect: "Solution incorrect",
  tests_invalid: "Tests invalid",
  tests_weak_or_missing: "Tests weak or missing",
  code_mismatch: "Code does not match prompt",
  too_trivial: "Too trivial",
  low_quality: "Low quality",
  off_spec: "Off specification",
  other: "Other issue",
};

export const GENERATION_LABELS: Record<string, string> = {
  human: "Human generated",
  ai_assisted: "AI assisted",
  ai_generated: "AI generated",
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

/** Mirrors the API's VALIDATOR_RANK_TIERS (services/reputation.ts) in order —
 * the same list `ranks.validator.rank` on GET /v1/me/validator-dashboard is
 * drawn from, so the rank ladder in `WorkspaceStatusBar` can index it. The last
 * three tiers were missing here, which left a Principal Verifier or Arbiter
 * rendered at index 0 as if they were an Observer. */
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

/** Darkens a tier's own hex so its label stays legible on the 15%-alpha wash of
 * that same hex. Falls back to the karma violet for a malformed value rather
 * than rendering an invisible chip. Needs an actual #RRGGBB literal to do the
 * bit-math — a CSS custom property (`var(--color-karma)`) can't be parsed
 * this way, so the fallback stays a hex literal on purpose. */
export function shadeHex(hex: string, factor: number): string {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#7c5cc4";
  const value = parseInt(normalized.slice(1), 16);
  return `#${[(value >> 16) & 255, (value >> 8) & 255, value & 255]
    .map((channel) => Math.round(channel * factor).toString(16).padStart(2, "0"))
    .join("")}`;
}
