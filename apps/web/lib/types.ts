// SPDX-License-Identifier: Apache-2.0

/** Coarse dataset-type bucket, driven entirely by the live catalog
 * (GET /v1/meta/taxonomy / /v1/planner/catalog) — not a fixed coding-only
 * union. New domains/categories need zero frontend changes. */
export type DatasetCategory = string;

import type { KarmaReleaseRule } from "@/lib/karma-state";

export type AuditMode = "llm_only" | "partial" | "full";
export type LicenseType = "non_exclusive" | "exclusive" | "perpetual";
export type GenerationMethod = "human" | "ai_assisted" | "ai_generated";

export type BountyStatus =
  | "draft"
  | "planning"
  | "platform_review"
  | "active"
  | "paused"
  | "closing"
  | "export_ready"
  | "completed"
  | "partially_completed"
  | "cancelled"
  | "disputed";

export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "duplicate_check"
  | "running_tests"
  | "tests_failed"
  | "llm_validation"
  | "needs_fixes"
  | "provisionally_accepted"
  | "accepted_pending_sample"
  | "in_audit"
  | "in_sponsor_review"
  | "flagged"
  | "disputed"
  | "accepted"
  | "rejected"
  | "completed_settled";

export type BatchStatus =
  | "available"
  | "claimed"
  | "submitted"
  | "needs_fixes"
  | "partially_accepted"
  | "accepted"
  | "abandoned"
  | "completed_settled";

export type AuditBatchStatus =
  | "available"
  | "claimed"
  | "in_progress"
  // Deadline missed on a partly-decided batch: it keeps its owner and their
  // recorded decisions instead of returning to the pool (databounty-api
  // services/audit-lifecycle.ts), so the validator can still finish it.
  | "overdue_review"
  | "submitted"
  | "completed"
  | "abandoned"
  | "disputed"
  | "completed_settled";

/** Mirrors the API's `FlagStatus` Prisma enum EXACTLY. It previously carried
 *  four mock-era members the server can never send (`contributor_fix_pending`,
 *  `rejected`, `resolved`) while missing the one it does (`dismissed`) — which
 *  is how `openFlags` came to filter on a status that does not exist, and how a
 *  dismissed flag had no declared shape at all. */
export type FlagStatus =
  | "open"
  | "fixed"
  | "disputed"
  | "confirmed"
  | "dismissed";

/** Mirrors the API's `FlagReason` Prisma enum EXACTLY. Renderers still key off
 *  `FLAG_REASON_LABELS` (a `Record<string, string>` with a raw-value fallback),
 *  so a future server-side reason degrades to a humanized string rather than a
 *  blank — but this union is what the server can actually send today. */
export type FlagReason =
  | "duplicate"
  | "contaminated"
  | "tests_invalid"
  | "solution_incorrect"
  | "too_trivial"
  | "low_quality"
  | "off_spec"
  | "other";

export interface ExecutionResult {
  /** null when this dataset type has no broken/fixed-code distinction (only
   * Debugging & Bug Fix-style types do) — must not render as a false "no". */
  brokenCodeFailedTests: boolean | null;
  fixedCodePassedTests: boolean;
  testsRun: number;
  logs: string;
  decision: "pass" | "fail" | "pending";
  reason?: string;
}

/** One rubric line the LLM judge scored (0–1), with its own note. */
export interface LlmReviewCriterion {
  name: string;
  score: number;
  note: string;
}

/** Real per-item LLM review evidence, surfaced from the "llm" validation stage
 * so the contributor can see WHAT the judge checked, not just a bare percentage.
 * `status` mirrors the backend detail: "reviewed" (a real model ran),
 * "pending_llm_review" (held, no model), or "skipped_sampling" (not selected). */
export interface LlmReviewResult {
  status: string;
  verdict?: "pass" | "fail" | "uncertain";
  /** Overall 0–1 quality score. */
  score?: number;
  /** 0–1 bar the score had to clear to pass. */
  passThreshold?: number;
  evidence?: string;
  criteria: LlmReviewCriterion[];
  /** Present for pending/skipped states. */
  reason?: string;
}

export interface Flag {
  id: string;
  submissionId: string;
  /** The API sends the reviewer's user id, not a display name — the old
   *  `validator: string` field was mock-era and had no server counterpart, so
   *  the submission page's "flagged by {flag.validator}" rendered as a bare
   *  "flagged by " with nothing after it. Kept as the id (not surfaced as a
   *  name: the reviewer's identity is not disclosed to the submitter, and
   *  disputes are admin-arbitrated precisely so it need not be). */
  validatorUserId: string | null;
  reason: FlagReason;
  /** The reviewer's written explanation. Non-null in practice for a rejecting
   *  decision — the API refuses one without a note (lib/audit-decision-note.ts)
   *  — but nullable in the schema, so treat an absent note as "no explanation
   *  recorded" rather than rendering an empty paragraph. */
  details: string | null;
  status: FlagStatus;
  createdAt?: string;
}

export interface Submission {
  id: string;
  bountyId: string;
  batchId: string;
  title: string;
  prompt: string;
  language: string;
  framework: string;
  /** Dataset-type-defined level; do not restrict this to coding's three labels. */
  difficulty: string;
  bugType: string;
  concepts: string[];
  brokenCode: string;
  fixedCode: string;
  tests: string;
  explanation: string;
  expectedBehavior: string;
  generationMethod: GenerationMethod;
  status: SubmissionStatus;
  duplicateScore?: number;
  /** Raw dedupe stage decision (e.g. "review_required" for a 0.80–0.90
   * near-match sent to human audit instead of auto-passed) — kept distinct
   * from the numeric score so the UI can flag it, not just display it
   * identically to a clean pass. */
  duplicateDecision?: string;
  llmScore?: number;
  execution?: ExecutionResult;
  llmReview?: LlmReviewResult;
  reviewNotes?: string[];
  flags: Flag[];
  reward: number;
  submittedAt: string;
}

export interface ContributorBatch {
  id: string;
  bountyId: string;
  bountyTitle: string;
  slotName: string;
  category: DatasetCategory;
  difficulty: string;
  itemCount: number;
  submittedCount: number;
  karmaPerAcceptedItem: number;
  expectedReward: number;
  deadline: string;
  status: BatchStatus;
  /** Only present on batches hydrated from GET /v1/batches (real data embeds
   * the parent bounty's language directly); absent on legacy mock seeds,
   * which still resolve language via a join against `bounties` by bountyId. */
  language?: string;
  datasetTypeId?: string | null;
  datasetTypeName?: string;
  domain?: string | null;
  bountyTotalBatchCount?: number;
  claimedAt?: string | null;
  createdAt?: string;
  // Karma-tier early-access gate for open community batches (server-computed on
  // GET /v1/batches). `claimableLabel` ("opens in 3d") and `claimableOnLabel`
  // ("Aug 8") are present only while the batch is still gated for this viewer;
  // null once open (or for a guest). The claim endpoint 409s an early claim, so
  // the card must render this rather than offer a claim that would be refused.
  claimableAt?: string | null;
  claimableLabel?: string | null;
  claimableOnLabel?: string | null;
  validationSummary?: {
    accepted: number;
    actionNeeded: number;
    inReview: number;
    disputed: number;
  };
  validationReview?: {
    automatedChecks: number;
    validatorAudit: number;
    poolCloseReview: number;
  };
}

export interface AuditItem {
  id: string;
  submissionId: string;
  decision: "pending" | "ok" | "flagged" | "skipped";
  flagReason?: FlagReason;
  notes?: string;
}

export interface AuditBatch {
  id: string;
  bountyId: string;
  bountyTitle: string;
  itemCount: number;
  deadline: string;
  status: AuditBatchStatus;
  /** Server-computed number of audit items already decided in this batch. */
  decidedCount?: number;
  items: AuditItem[];
  /** Real data (GET /v1/audits) embeds the parent bounty's category/language
   * directly; legacy mock seeds resolve both via a join against `bounties`. */
  category?: DatasetCategory;
  language?: string;
  /** "community" audits pay karma instead of karma; karmaReward is set only
   * for community audits (see GET /v1/audits). */
  kind?: "community" | "enterprise";
  karmaReward?: number | null;
  /** Set when a corrective backfill retired this window and re-routed its items
   * into a later, policy-compliant one. The window stays in the validator's own
   * lists — it is still a claim they really held — but the detail route
   * hard-rejects it, so the row must render as a tombstone, never as a link.
   * Absent on an API predating the field, which reads as "not superseded". */
  supersededAt?: string | null;
  supersededReason?: string | null;
}

export interface BountySlot {
  id: string;
  name: string;
  difficulty: string;
  targetItems: number;
  acceptedItems: number;
  karmaPerAcceptedItem: number;
}

/**
 * Where a community dataset is in its ONE publication event.
 *
 * A community pool publishes once, as a whole pool, when the pool is complete
 * and every validator decision is in — never per item. These five states are
 * the whole lifecycle of that single event.
 */
export type PublicationState =
  | "not_published"
  | "queued"
  | "publishing"
  | "published"
  | "failed";

/**
 * The server-owned publication block on a community pool's `poolSummary`.
 *
 * `label` and `detail` are the SERVER's sentences. Render them verbatim: never
 * paraphrase them, and never compute a label of your own from `state` — three
 * surfaces wording the same publication rule three ways is how someone ends up
 * believing the dataset is on Hugging Face when it is not. `state` is for tone
 * and for deciding whether a link exists, not for text.
 *
 * `datasetUrl` is set ONLY when `state === "published"`. In every other state
 * there is no dataset to link to and no surface may imply otherwise.
 */
export interface DatasetPublication {
  state: PublicationState;
  label: string;
  detail: string;
  datasetUrl: string | null;
  target: "huggingface" | "github" | "aikosh" | null;
  /** Each provider's own evidence. Public UI renders only published rows that
   * include a URL; an AIKosh URL is an administrator attestation, not a
   * provider-verified upload. */
  targets?: Array<{
    target: "huggingface" | "github" | "aikosh";
    name: string;
    state: PublicationState;
    url: string | null;
    attested: boolean;
  }>;
  progress?: {
    finalAccepted: number;
    targetItems: number;
    remainingToTarget: number;
  } | null;
}

export interface Bounty {
  id: string;
  title: string;
  description: string;
  /** Immutable policy returned for a policy-controlled community pool. Omitted only by
   * legacy API payloads, which retain their historical lifecycle copy. */
  communityPolicy?: {
    validation: "full_human" | "automation_only";
    sponsorDispute: false;
    karmaRelease: "on_final_accept";
  } | null;
  /** Server-owned publication state for a community pool (`poolSummary.publication`).
   * Null on any API payload predating the block — absence
   * means "the server said nothing", which is rendered as nothing, never as
   * "not published". */
  communityPublication?: DatasetPublication | null;
  /** Authoritative live community counters. Use capacityReserved for intake
   * capacity and finalAccepted for completion; do not infer either from the
   * legacy stored `acceptedItems`/`clearedItems` counters. */
  communityProgress?: {
    totalSubmitted: number;
    capacityReserved: number;
    finalAccepted: number;
    validatorReview: number;
    processing: number;
    rejected: number;
    failedAutomatedChecks: number;
  } | null;
  category: DatasetCategory;
  /** Which dataset-type template this bounty launched with (version snapshotted at creation). */
  datasetTypeId?: string;
  language: string;
  framework: string;
  targetItems: number;
  requiredSponsorExamples?: number;
  approvedSponsorExamples?: number;
  contributorTargetItems?: number;
  acceptedItems: number;
  /** Submitted and still in flight (automated stages or a pending human call). */
  submittedItems: number;
  needsFixesItems: number;
  rejectedItems: number;
  /** Every item a contributor has submitted, across all four funnel buckets.
   *  See api/src/lib/bounty-funnel.ts — the bucket map is exhaustive over
   *  SubmissionStatus, so these four numbers always account for the total.
   *  Optional because the in-memory dev fixtures predate it; `apiToBounty`
   *  always populates it (deriving from the buckets if the server omits it). */
  totalSubmittedItems?: number;
  /** Sponsor/admin view of what this program's karma has actually done: real
   *  award rows, not `accepted × ratePerItem`. `releaseRule` is server-owned
   *  copy — render it, never paraphrase (see lib/karma-state.ts). */
  karma?: {
    releasedTotal: number;
    securedTotal: number;
    recipients: number;
    releaseRule: KarmaReleaseRule;
  } | null;
  status: BountyStatus;
  auditMode: AuditMode;
  license: LicenseType;
  /** Community pool's real public license string (e.g. "CC-BY-4.0"), from
   *  the API's `communityLicense` column. */
  communityLicense?: string | null;
  /** Real per-accepted-item karma rate (mirrors the API's `Bounty.karmaPerAcceptedItem`
   *  Prisma column). `0` is the backend's "matrix-priced, no fixed rate" sentinel —
   *  render through `karmaPerItemLabel()` (lib/format.ts) rather than the raw number. */
  karmaPerAcceptedItem: number;
  deadline: string;
  requesterNickname: string;
  mine?: boolean;
  slots: BountySlot[];
  duplicateRate: number;
  llmPassRate: number;
  executionPassRate?: number;
  contributorCount: number;
  validatorCount: number;
  generationMix?: { human: number; aiAssisted: number; aiGenerated: number };
  deliveredAt?: string;
}

export interface Notification {
  id: string;
  type: string;
  /** Derived server-side from the event catalog (events.ts EventCategory) —
   * collapses many event types into a handful of categories. The icon table
   * keys off this instead of `type` so a new event in an existing category
   * needs no frontend change. Absent for notifications whose `type` isn't a
   * catalog key (shouldn't happen in practice, but stay defensive). */
  category?: string | null;
  title: string;
  body: string;
  time: string;
  read: boolean;
  /** Deep link to the surface this notification is about. */
  href?: string;
}

/** A transient, auto-dismissing on-screen message. Unlike {@link Notification}
 * (which is persisted to the bell feed), a Toast is ephemeral UI feedback for
 * the result of an action the user just took — success confirmation or, most
 * importantly, an error so the user isn't left guessing why nothing happened. */
export interface Toast {
  id: string;
  variant: "error" | "success" | "info";
  title: string;
  /** Optional secondary line, e.g. the backend's error message. */
  body?: string;
}

/** Mirrors the API's `KarmaEventType` Prisma enum EXACTLY (api/prisma/schema.prisma)
 *  — a real, non-monetary karma history vocabulary
 *  external tracking system this
 *  codebase must never carry, per D3/D11 "Structural Absence". */
export type KarmaEventEntryType =
  | "community_item_accepted"
  | "community_item_reversed"
  | "community_audit_completed"
  | "community_request_approved"
  | "community_bounty_published"
  | "community_flag_confirmed"
  | "community_publish_bonus"
  | "admin_adjustment";

export interface KarmaEventEntry {
  id: string;
  type: KarmaEventEntryType;
  amount: number;
  status: "pending" | "confirmed" | "failed";
  date: string;
  note: string;
}

export interface Dispute {
  id: string;
  bountyTitle: string;
  submissionTitle: string;
  flagReason: FlagReason;
  contributorArgument: string;
  validatorArgument: string;
  status: "open" | "resolved";
  resolution?: string;
}
