// SPDX-License-Identifier: Apache-2.0

export type DatasetCategory =
  | "debugging"
  | "implementation"
  | "test_generation"
  | "error_diagnosis"
  | "migration";

export type AuditMode = "llm_only" | "partial" | "full";
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
  // Deprecated, mirrored from the API enum only: external-corpus plagiarism
  // screening was removed from the pipeline by owner decision and no code path
  // transitions a submission to this status.
  | "contamination_check"
  | "running_tests"
  | "tests_failed"
  | "llm_validation"
  | "needs_fixes"
  | "provisionally_accepted"
  | "in_audit"
  | "accepted_pending_sample"
  | "flagged"
  | "disputed"
  | "accepted"
  | "rejected"
  | "karma_released";


export type FlagReason =
  | "duplicate"
  | "wrong_category"
  | "prompt_unclear"
  | "solution_incorrect"
  | "tests_weak_or_missing"
  | "code_mismatch"
  | "too_trivial"
  | "unrealistic"
  | "license_concern"
  | "benchmark_copy"
  | "schema_issue"
  | "other";

export interface PublicSampleArtifact {
  id: string;
  filename: string;
  contentType: string;
  downloadUrl: string;
  sample: { available: boolean; content?: string; truncated?: boolean; reason?: string };
}

export interface SamplePreviewMedia {
  key: string;
  url: string;
  kind: "image" | "audio" | "video" | "file";
  alt?: string;
}

/** One admin-authored illustrative sample for a dataset TYPE (not a specific
 * pool's submitted work) — `DatasetType.sampleAssets`. Most dataset types
 * have none authored yet; absent/null/empty is the common, honest case, not
 * an error. */
export interface DatasetTypeSampleAsset {
  fields?: Record<string, string>;
  media?: SamplePreviewMedia[];
  caption?: string;
}

export interface BountySlot {
  id: string;
  name: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  targetItems: number;
  acceptedItems: number;
}

export interface Bounty {
  id: string;
  /** Emitted verbatim by the Community API (`serializeCommunityCatalogBounty`,
   * `listCommunityPools`). The `BountyKind` enum in this edition has a single
   * member, so no other value can arrive on a public payload. */
  kind: "community";
  title: string;
  description: string;
  category: DatasetCategory;
  datasetTypeId?: string;
  /** The real dataset type as the API reports it. Preferred over matching the
   * static catalog by category, which mislabelled pools: a "debugging" type
   * whose legacy category is "implementation" was shown as
   * "Function / Feature Implementation". */
  datasetTypeName?: string;
  datasetTypeTrustTier?: string;
  /** Admin-authored illustrative samples for this pool's dataset type.
   * Undefined/empty means no admin has authored any yet — render nothing,
   * never a "no samples" placeholder. */
  datasetTypeSampleAssets?: DatasetTypeSampleAsset[];
  language: string;
  framework: string;
  targetItems: number;
  acceptedItems: number;
  clearedItems?: number;
  submittedItems: number;
  needsFixesItems: number;
  rejectedItems: number;
  status: BountyStatus;
  auditMode: AuditMode;
  deadline: string;
  requesterNickname: string;
  mine?: boolean;
  slots: BountySlot[];
  /* These five are OPTIONAL on purpose. The public catalog does not measure
   * them per pool, and `number(undefined)` used to turn every one into a 0 the
   * UI then printed as fact — a delivered, execution-verified corpus rendered
   * "execution pass 0%" and "0 contributors". Absent means not measured and
   * must render as such. */
  duplicateRate?: number;
  llmPassRate?: number;
  executionPassRate?: number;
  contributorCount?: number;
  validatorCount?: number;
  generationMix?: { human: number; aiAssisted: number; aiGenerated: number };
  deliveredAt?: string;
  communityPolicy?: {

    validation: "full_human" | "automation_only";
    sponsorDispute: false;
    karmaRelease: "on_final_accept";
  } | null;
  communityProgress?: {
    /** Optional on purpose: absent when the API returned a rollup without it.
     * A missing count and a genuine zero must not render the same. */
    totalSubmitted?: number;
    capacityReserved: number;
    finalAccepted: number;
    validatorReview: number;
    processing: number;
    rejected: number;
    failedAutomatedChecks: number;
    flagged: number;
    disputed: number;
  } | null;
  /** Set when the pool has hit its target and takes no more contributions;
   * its status stays "active" while the remaining items are audited. */
  poolClosedAt?: string | null;
  karmaPerItem?: number;
  /** Karma a validator earns per audited item (karmaPricing.validatorPerAuditedItem). */
  karmaPerAuditedItem?: number;
  /** Share of this pool's items routed to a human validator, in percent. */
  auditCoveragePct?: number;
  openLicense?: string;
  hfSlug?: string;
  /** Every confirmed publication target beyond Hugging Face (github, aikosh, ...
   * future targets need no type change here). Hugging Face itself stays on
   * `hfSlug` for the many existing call sites already keyed off it. */
  publications?: { target: string; url: string; pushedAt?: string }[];
  publicSamples?: PublicSampleArtifact[];
}
