// SPDX-License-Identifier: Apache-2.0

/**
 * Typed client for the real contributor/validator "available work" surfaces
 * (`GET /v1/batches`, `GET /v1/audits`) on databounty-api. Every row here is a
 * real ContributorBatch/AuditBatch DB row, not fabricated demo data (the
 * mock seeds these once replaced have been deleted from lib/mock-data.ts).
 *
 * Audits legitimately return an empty list when no eligible AuditBatch rows
 * exist; rows are created by the real contributor submit/revision pipeline.
 */
import { authedFetch } from "@/lib/store";
import { API } from "@/lib/api-endpoints";
import type { DatasetType } from "@/lib/dataset-types";
import type { ApiArtifact } from "@/lib/api-artifacts";
import type { AuditBatch, BountyStatus, ContributorBatch, DatasetCategory, DatasetPublication, Submission, Flag } from "@/lib/types";
import type { ProfileSummary } from "@/lib/api-profile-sources";
import { parseDatasetPublication } from "@/lib/publication";

interface ApiContributorBatch {
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
  deadline: string | null;
  status: ContributorBatch["status"];
  language: string;
  datasetTypeId?: string | null;
  datasetTypeName?: string;
  domain?: string | null;
  bountyTotalBatchCount?: number;
  claimedAt?: string | null;
  createdAt?: string;
  claimableAt?: string | null;
  claimableLabel?: string | null;
  claimableOnLabel?: string | null;
  validationSummary?: ContributorBatch["validationSummary"];
  validationReview?: ContributorBatch["validationReview"];
}

interface ApiAuditBatch {
  id: string;
  bountyId: string;
  bountyTitle: string;
  itemCount: number;
  deadline: string | null;
  status: string;
  decidedCount?: number;
  category: DatasetCategory;
  language: string;
  /** "community" audits pay karma, "enterprise" ones pay karma. Returned by
   * GET /v1/audits, GET /v1/me/audits and GET /v1/me/validator-dashboard. */
  kind?: "community" | "enterprise";
  karmaReward?: number | null;
  /** Server-owned publication block for the parent COMMUNITY pool. Null on a
   * enterprise row (no pool, no Hugging Face publication) and absent on an API
   * predating the block — both render nothing rather than "not published". */
  publication?: DatasetPublication | null;
}

export interface ApiValidationResult {
  id: string;
  stage: string;
  passed: boolean;
  score: number | null;
  /** The API's own `ValidationResult.outcome` column ("llm_pass" | "llm_fail" |
   *  "provider_error" | …). Always serialized by the submission-detail route;
   *  absent on a revision snapshot, which stores a reduced shape. */
  outcome?: string | null;
  detailJson?: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * `ValidationResult.passed === false` is THREE different states, and reading it
 * as a boolean is what made one submission render "pending" and "failed" at the
 * same time on the same screen:
 *
 *   - `score == null`  ⇒ nothing ran. A hold: queued, not reached, no provider
 *                        configured, deferred to pool close-out.
 *   - `score != null` and the stage ESCALATES ⇒ flagged for a human validator.
 *                        Not a verdict, and not terminal — the backend keeps
 *                        carrying the item forward to `in_audit`.
 *   - `score != null` and terminal ⇒ genuinely failed.
 *
 * The escalating cases are real and deliberate on the API side:
 *   - `ai_attribution` flagged writes `passed: false, score: 1` with
 *     `detail.status: "flagged"`. Nothing failed: a disclosure was found and a
 *     human must judge whether the contract permits it. The stage doc's
 *     Outcomes table mandates the user-visible state "flagged — validator
 *     review required" (docs/engineering/AI_ATTRIBUTION_AND_PROVENANCE.md).
 *   - `dedupe` `review_required` is an escalation by definition.
 *
 * Anything reading `!passed && score != null ⇒ failed` therefore reports an
 * escalated item as a failure and disagrees with the status pill next to it
 * (`in_audit` ⇒ "Awaiting validator audit"). This is the ONE implementation —
 * a 2026-09-04 audit found the rule re-derived, inconsistently, in nine other
 * places across web/admin/api (the validator page had its own copy that got
 * `dedupe` and `ai_attribution` right but rendered `llm` as a red "failed";
 * two admin pages rendered a never-ran stage as "failed"; two admin API
 * routes built the sentence "Automated llm did not pass" for a stage that
 * never ran). Call this; never re-derive it inline.
 *
 * `llm` is deliberately its OWN state rather than either of the above. A
 * failing verdict (`outcome: "llm_fail"`) is a real advisory quality verdict
 * that genuinely failed — but it gates nothing: services/validation.ts states
 * it "never changes the accept/reject OUTCOME below: every item that clears
 * execution still goes to a human validator regardless of the LLM's answer".
 * So it is neither terminal "failed" (the item is not rejected — measured in
 * community_test, 99 of 100 `llm_fail` items are `accepted`) nor "flagged for
 * review" (that would claim an open escalation on a settled item). It renders
 * as "review fail", the label llm-review-card.tsx and stage-evidence-cards.tsx
 * already use for exactly this row, so all three surfaces agree.
 */
export type ValidationStageState = "passed" | "failed" | "flagged" | "review_fail" | "hold";

/**
 * Stages that are TERMINAL even with `score == null`, so the "no score means
 * nothing ran" rule must not swallow them. `pool_capacity` is the real case:
 * services/validation.ts writes `passed: false, score: null,
 * outcome: "pool_capacity_reached"` and rejects the submission outright — the
 * pool filled before this item could be counted. Rendering that as
 * "pending / blocked" tells a contributor to wait for a check that already
 * refused their work.
 */
const TERMINAL_WITHOUT_SCORE = new Set(["pool_capacity_reached"]);

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
  // `ai_attribution` and a passing `dedupe` are written with NO `outcome`
  // column at all (services/validation.ts:92,144), so these two must be
  // decoded from `detailJson`, never from `outcome`. Any consumer that gets
  // only `outcome` on the wire cannot classify them — send `detailJson` too.
  if (stage === "ai_attribution" && detail.status === "flagged") return "flagged";
  if (stage === "llm") return "review_fail";
  if (stage === "dedupe" && (detail.duplicateDecision === "review_required" || detail.decision === "review_required")) {
    return "flagged";
  }
  return "failed";
}

/** The wording each state renders as. "flagged for review" is the exact label
 *  the validator audit screen already uses for these rows, so the two surfaces
 *  now agree instead of one saying "failed" and the other "flagged". */
export const VALIDATION_STAGE_STATE_LABEL: Record<ValidationStageState, string> = {
  passed: "passed",
  failed: "failed",
  flagged: "flagged for review",
  review_fail: "review fail",
  hold: "pending / blocked",
};

/**
 * `ValidationResult.stage` on this backend is written literally as
 * "duplicate_check" (see prisma/schema.prisma on the API: `stage String //
 * duplicate_check | ai_attribution | execution | llm`, and every write site in
 * services/validation.ts). Every pipeline/evidence view across contributor,
 * validator, and sponsor pages was built against v1's stage vocabulary, which
 * calls this stage "dedupe" — so every `map.get("dedupe")` lookup against a
 * raw `ApiValidationResult[]` silently missed and rendered the duplicate-check
 * row as permanently "not reached" / pending, even on an item that had
 * plainly cleared it and moved on to later stages. Use this whenever building
 * a `stage -> ApiValidationResult` map from raw API data, so the display-side
 * stage vocabulary ("dedupe") is what every lookup key actually is.
 */
export function normalizeValidationStage(stage: string): string {
  return stage === "duplicate_check" ? "dedupe" : stage;
}

/** Immutable evidence from an earlier submitted version. The API retains these
 * snapshots before a contributor replaces an item, so a sponsor can see a
 * failure and the later resubmission rather than only the current outcome. */
export interface ApiSubmissionRevision {
  id: string;
  revisionNumber: number;
  title: string;
  status: string;
  validationEvidence: Array<{
    id?: string;
    stage: string;
    passed: boolean;
    score: number | null;
    detail?: Record<string, unknown> | null;
    createdAt: string;
  }>;
  createdAt: string;
}

export interface ApiFlag {
  id: string;
  submissionId: string;
  validatorUserId: string | null;
  reason: string;
  details: string | null;
  status: string;
  createdAt: string;
}

/** A contributor's dispute on a validator flag, with the admin's resolution
 * outcome once resolved. `resolutionDecision` is "uphold_flag" (validator's
 * flag stands) or "overturn_flag" (flag dismissed, item re-queued). */
export interface ApiDispute {
  id: string;
  status: "open" | "resolved";
  resolution: string | null;
  resolutionDecision: "uphold_flag" | "overturn_flag" | null;
  flagReason: string;
  contributorArgument: string;
  validatorArgument: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ApiSubmissionDetail {
  id: string;
  bountyId: string;
  contributorBatchId: string | null;
  contributorUserId: string;
  title: string;
  payloadJson: Record<string, unknown>;
  generationMethod: "human" | "ai_assisted" | "ai_generated";
  status: string;
  duplicateScore: number | null;
  llmScore: number | null;
  /** Server-owned validation-stage switch; false means the UI must not imply LLM review is running. */
  llmValidationEnabled?: boolean;
  validationResults: ApiValidationResult[];
  revisions?: ApiSubmissionRevision[];
  /** Real validator decisions on this item, if any were ever claimed/decided —
   * distinct from validationResults, which never carries a "human_audit" row.
   * Empty/undecided means no validator ever reviewed this submission, even if
   * its final status is "accepted" via automated stages alone. */
  auditItems?: Array<{ id: string; verdict: string | null; decidedAt: string | null }>;
  flags?: ApiFlag[];
  disputes?: ApiDispute[];
  attachments?: ApiArtifact[];
  validationLogs?: ApiArtifact[];
  actionable?: boolean;
  /** Why an item that looks revisable is not — a closed community pool, a
   *  settled batch, a passed deadline, or an exhausted revision budget. Null
   *  whenever `actionable` is true. Rendered instead of a bare disabled control. */
  notActionableReason?: string | null;
  /** Community work pays karma; external work pays karma. Every surface that read
   *  `reward` alone showed "0 karma" on a community item — false in both
   *  directions (implies cash, and implies nothing was earned). */
  rewardKind?: "karma" | "reward";
  /** This item's karma position. Null for a external submission. */
  karma?: {
    state: "released" | "secured" | "projected" | "none";
    amount: number;
    /** The program's frozen per-accepted-item rate — real even in `none`. */
    perItem: number;
    /** Server-owned sentence. Render verbatim. */
    explanation: string;
  } | null;
  revisionsRemaining?: number;
  createdAt?: string;
}

export interface BatchContract {
  batch: ApiContributorBatch;
  bounty: {
    id: string;
    title: string;
    description: string;
    category: DatasetCategory;
    language: string;
    framework: string;
    /** The sponsor's CHOSEN human-audit coverage — the answer, not the
     *  template's `auditOptions` menu. Optional: an older API build omits it. */
    auditCoveragePct?: number;
  };
  datasetType: DatasetType;
  verification: DatasetType["verification"];
  sourceUpload: SourceUploadRequirements;
  /** Sponsor reference samples/files — the brief in the format they asked for. */
  sponsorReferences?: ApiArtifact[];
  /** Server-owned `validation.llm.enabled`. This contract is read BEFORE any
   *  submission exists, so the UI cannot infer the switch from evidence rows —
   *  treat a missing value as false and do not promise the stage. */
  llmValidationEnabled?: boolean;
  /** Every item already submitted in this batch, including rejected/fixable rows. */
  submissions?: Array<ApiSubmissionDetail & { actionable: boolean; revisionsRemaining: number }>;
  submissionCounts?: Record<string, number>;
}

export interface SourceUploadRequirements {
  profile: string;
  version: number;
  extensions: string[];
  mimeTypes: string[];
  accept: string;
  available: boolean;
  unavailableReason: string | null;
}

export interface AuditDetail {
  id: string;
  bountyId: string;
  itemCount: number;
  deadline: string | null;
  status: string;
  kind: "community" | "enterprise";
  /** Server-calculated validator karma per audited item for community work. */
  karmaReward?: number | null;
  contributorBatch?: {
    id: string;
    itemCount: number;
    submittedCount: number;
    status: string;
  } | null;
  bounty: {
    id: string;
    title: string;
    category: DatasetCategory;
    language: string;
    framework: string;
    datasetType?: DatasetType | null;
    /** Community pools only, and only the publication slice of `poolSummary` —
     * a validator has no use for the capacity buckets. Optional on both levels:
     * a enterprise audit has no pool at all, and an API predating the block sends
     * neither, in which case the surface shows nothing rather than guessing. */
    poolSummary?: { publication?: DatasetPublication | null } | null;
  };
  /** Same block, accepted at the top level too, since the audit payload is
   * assembled per-audit rather than from the bounty serializer. Whichever the
   * server sends wins; all absent renders nothing. */
  publication?: DatasetPublication | null;
  /** Where the server ACTUALLY puts it today: the audit payload carries its own
   * `poolSummary` as a sibling of `bounty`, not nested inside it. Verified live
   * against `GET /v1/audits/:id` — reading only the other two locations left the
   * validator surface silently blank, which is the failure this branch exists to
   * prevent. Kept alongside them rather than replacing them so a payload shaped
   * either way still renders. */
  poolSummary?: { publication?: DatasetPublication | null } | null;
  items: Array<{
    id: string;
    submissionId: string;
    verdict: "ok" | "flagged" | null;
    flagReason?: string | null;
    note?: string | null;
    submission: ApiSubmissionDetail;
    /** Files the contributor attached to this submission. */
    attachments?: ApiArtifact[];
    /** Sandbox stdout/stderr artifacts attached to validation results. */
    validationLogs?: ApiArtifact[];
  }>;
  /** Sponsor reference samples/files for the bounty (the brief). */
  sponsorReferences?: ApiArtifact[];
}

function mapBatch(b: ApiContributorBatch): ContributorBatch {
  return {
    id: b.id,
    bountyId: b.bountyId,
    bountyTitle: b.bountyTitle,
    slotName: b.slotName,
    category: b.category,
    difficulty: b.difficulty as ContributorBatch["difficulty"],
    itemCount: b.itemCount,
    submittedCount: b.submittedCount,
    karmaPerAcceptedItem: b.karmaPerAcceptedItem,
    expectedReward: b.expectedReward,
    deadline: b.deadline ?? "",
    status: b.status,
    language: b.language,
    datasetTypeId: b.datasetTypeId,
    datasetTypeName: b.datasetTypeName,
    domain: b.domain,
    bountyTotalBatchCount: b.bountyTotalBatchCount,
    claimedAt: b.claimedAt,
    createdAt: b.createdAt,
    claimableAt: b.claimableAt,
    claimableLabel: b.claimableLabel,
    claimableOnLabel: b.claimableOnLabel,
    validationSummary: b.validationSummary,
    validationReview: b.validationReview,
  };
}

/**
 * An audit-list row plus the server-owned publication block the LIST endpoints
 * (`GET /v1/audits`, `GET /v1/me/audits`, `GET /v1/me/validator-dashboard`) now
 * carry. Declared here rather than widened onto `AuditBatch` in lib/types.ts so
 * the mock-seeded shape stays untouched; every consumer that only reads the
 * base fields keeps working unchanged.
 */
export type AuditBatchRow = AuditBatch & {
  /** Null for a enterprise audit, and null when the API sent no block at all. */
  publication: DatasetPublication | null;
};

/**
 * Read the publication block off an audit row from any list.
 *
 * Written to accept a plain `AuditBatch` too: the shared store holds the queue
 * as `AuditBatch[]`, so the field is present at runtime (mapAudit sets it) but
 * not in that declared type. Parsing again here costs nothing and keeps the
 * "never render a half-formed publication claim" rule in one place.
 */
export function auditRowPublication(audit: AuditBatch | AuditBatchRow): DatasetPublication | null {
  return parseDatasetPublication((audit as Partial<AuditBatchRow>).publication);
}

function mapAudit(a: ApiAuditBatch): AuditBatchRow {
  return {
    id: a.id,
    bountyId: a.bountyId,
    bountyTitle: a.bountyTitle,
    itemCount: a.itemCount,
    deadline: a.deadline ?? "",
    status: a.status as AuditBatch["status"],
    decidedCount: a.decidedCount ?? 0,
    items: [], // list view — per-item detail is fetched on the audit detail page
    category: a.category,
    language: a.language,
    // Carried through so a row can render as karma vs karma work. Dropping
    // these made every audit look external during the karma-only launch.
    kind: a.kind,
    karmaReward: a.karmaReward ?? null,
    // Parsed, never trusted verbatim: a half-formed block would draw a pill
    // that is a trust claim about a real dataset (see lib/publication.ts).
    publication: parseDatasetPublication(a.publication),
  };
}

/** Real available task batches across every publicly-visible bounty. Best-effort:
 * a failed/errored fetch resolves to [], never throws — callers keep whatever
 * was there before rather than crashing the browse page. */
export async function getAvailableBatches(): Promise<ContributorBatch[]> {
  try {
    const res = await authedFetch(API.batches.list);
    if (!res.ok) return [];
    const data = (await res.json()) as { batches?: ApiContributorBatch[] };
    return (data.batches ?? []).map(mapBatch);
  } catch {
    return [];
  }
}

export interface BatchListFilters {
  domains?: string[];
  datasetTypes?: string[];
  difficulties?: string[];
  search?: string;
  sort?: "newest" | "reward" | "total" | "items" | "deadline_asc";
  /** Keyset cursor — the `nextCursor` from a prior page, or undefined for
   * the first page (scalability plan §2.2: no more `page` number). */
  cursor?: string;
  limit?: number;
}

export interface BountyBatchGroup {
  bountyId: string;
  bountyTitle: string;
  datasetTypeId: string | null;
  datasetTypeName: string;
  domain: string | null;
  totalBatchCount: number;
  availableBatchCount: number;
  batches: ContributorBatch[];
}

export interface BatchListPage {
  batches: ContributorBatch[];
  bountyGroups: BountyBatchGroup[];
  nextCursor: string | null;
  limit: number;
  hasMore: boolean;
  filterOptions: {
    datasetTypes: Array<{ id: string; name: string; domain: string }>;
    difficulties: string[];
  };
}

const EMPTY_BATCH_PAGE: BatchListPage = {
  batches: [],
  bountyGroups: [],
  nextCursor: null,
  limit: 0,
  hasMore: false,
  filterOptions: { datasetTypes: [], difficulties: [] },
};

/** Server-side filtered/sorted/paginated batch listing for the /contributor browse
 * page — every filter and the page cursor are sent as query params so the
 * backend's Prisma `where`/`orderBy`/`skip` does the work, not client-side
 * `.filter()`/`.sort()`. Best-effort: errors resolve to an empty page. */
export async function getAvailableBatchesPage(filters: BatchListFilters): Promise<BatchListPage> {
  const qs = new URLSearchParams();
  if (filters.domains?.length) qs.set("domains", filters.domains.join(","));
  if (filters.datasetTypes?.length) qs.set("datasetTypes", filters.datasetTypes.join(","));
  if (filters.difficulties?.length) qs.set("difficulties", filters.difficulties.join(","));
  if (filters.search) qs.set("search", filters.search);
  if (filters.sort) qs.set("sort", filters.sort);
  if (filters.cursor) qs.set("cursor", filters.cursor);
  qs.set("limit", String(filters.limit ?? 12));
  qs.set("grouped", "true");

  try {
    const res = await authedFetch(`${API.batches.list}?${qs.toString()}`);
    if (!res.ok) return EMPTY_BATCH_PAGE;
    const data = (await res.json()) as {
      bountyGroups?: Array<{
        bountyId: string;
        bountyTitle: string;
        datasetTypeId: string | null;
        datasetTypeName: string;
        domain: string | null;
        totalBatchCount: number;
        availableBatchCount: number;
        batches: ApiContributorBatch[];
      }>;
      nextCursor?: string | null;
      limit?: number;
      hasMore?: boolean;
      filterOptions?: {
        datasetTypes?: Array<{ id: string; name: string; domain: string }>;
        difficulties?: string[];
      };
    };
    const bountyGroups = (data.bountyGroups ?? []).map((group) => ({
      ...group,
      batches: group.batches.map((batch) => mapBatch({
        ...batch,
        datasetTypeId: group.datasetTypeId,
        datasetTypeName: group.datasetTypeName,
        domain: group.domain,
        bountyTotalBatchCount: group.totalBatchCount,
      })),
    }));
    return {
      batches: bountyGroups.flatMap((group) => group.batches),
      bountyGroups,
      nextCursor: data.nextCursor ?? null,
      limit: data.limit ?? filters.limit ?? 12,
      hasMore: data.hasMore ?? false,
      filterOptions: {
        datasetTypes: data.filterOptions?.datasetTypes ?? [],
        difficulties: data.filterOptions?.difficulties ?? [],
      },
    };
  } catch {
    return EMPTY_BATCH_PAGE;
  }
}

export interface WorkMatchFilters {
  categories?: string[];
  languages?: string[];
}

/** Server-computed count of open task batches matching a contributor's watch
 * filters. Enterprise and community work are separate browse surfaces on the API
 * (`GET /v1/batches/count` for external bounties, `GET /v1/community/batches/count`
 * for karma-only community bounties — scalability plan §2.2's per-page
 * `count(*)` removal only applies to the list endpoints, a genuine count is
 * still right for a one-shot badge check), so this sums both rather than
 * reporting only the enterprise figure — enterprise bounties aren't active here, so
 * querying only `/v1/batches/count` always read zero even when real
 * claimable community batches existed. Used by the notifications
 * "new-work alerts" strip so the match count reflects the backend's Prisma
 * `where`, not a client-side `.filter()` over a fetched page. Best-effort:
 * either count errors resolve to 0 for that surface, never a thrown error. */
export async function getAvailableBatchesCount(filters: WorkMatchFilters): Promise<number> {
  const qs = new URLSearchParams();
  if (filters.categories?.length) qs.set("categories", filters.categories.join(","));
  if (filters.languages?.length) qs.set("languages", filters.languages.join(","));
  const query = qs.toString();
  const fetchCount = async (path: string): Promise<number> => {
    try {
      const res = await authedFetch(`${path}?${query}`);
      if (!res.ok) return 0;
      const data = (await res.json()) as { total?: number };
      return data.total ?? 0;
    } catch {
      return 0;
    }
  };
  const [enterpriseCount, communityCount] = await Promise.all([
    fetchCount(API.batches.count),
    fetchCount(API.community.batchesCount),
  ]);
  return enterpriseCount + communityCount;
}

/** Same as {@link getAvailableBatchesCount} for open audit batches
 * (`GET /v1/audits?...&limit=1`, reads `total`). Best-effort: any error resolves
 * to 0 rather than throwing. (This used to also absorb a "validator role
 * required" 403; there is no validator role any more, so a signed-in caller
 * gets a real count.) */
export async function getAvailableAuditsCount(filters: WorkMatchFilters): Promise<number> {
  const qs = new URLSearchParams();
  if (filters.categories?.length) qs.set("categories", filters.categories.join(","));
  if (filters.languages?.length) qs.set("languages", filters.languages.join(","));
  qs.set("limit", "1");
  try {
    const res = await authedFetch(`${API.audits.list}?${qs.toString()}`);
    if (!res.ok) return 0;
    const data = (await res.json()) as { total?: number };
    return data.total ?? 0;
  } catch {
    return 0;
  }
}

/** Real available audit batches. Empty when no eligible audit rows exist.
 * `kind` narrows the shared queue to karma (community) or karma (enterprise) work. */
export async function getAvailableAudits(filters?: {
  kind?: "community" | "enterprise";
  limit?: number;
  skip?: number;
}): Promise<AuditBatchRow[]> {
  try {
    const res = await authedFetch(`${API.audits.list}${auditQuery(filters)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { audits?: ApiAuditBatch[] };
    return (data.audits ?? []).map(mapAudit);
  } catch {
    return [];
  }
}

/** Shared query builder for the two audit-list endpoints; omits any unset
 * filter so an absent `kind` means "both work types", matching the API. */
function auditQuery(filters?: { kind?: string; status?: string; limit?: number; skip?: number; q?: string }): string {
  const query = new URLSearchParams();
  if (filters?.kind) query.set("kind", filters.kind);
  if (filters?.q) query.set("q", filters.q);
  if (filters?.status) query.set("status", filters.status);
  if (filters?.limit != null) query.set("limit", String(filters.limit));
  if (filters?.skip != null) query.set("skip", String(filters.skip));
  const qs = query.toString();
  return qs ? `?${qs}` : "";
}

export async function getMyAuditsReal(filters?: {
  kind?: "community" | "enterprise";
  status?: string;
  limit?: number;
  skip?: number;
}): Promise<AuditBatchRow[]> {
  try {
    const res = await authedFetch(`${API.me.audits}${auditQuery(filters)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { audits?: ApiAuditBatch[] };
    return (data.audits ?? []).map(mapAudit);
  } catch {
    return [];
  }
}

/** One server-paginated page of the validator's OWN audits, with the total the
 * filters actually match. `getMyAuditsReal` above returns only the rows and is
 * used where the caller wants the full claimed set; this one backs the paged
 * "My audits" history section, which needs `total` for its result count and
 * page arithmetic.
 *
 * `q` is a free-text bounty-title search applied SERVER-side over the whole
 * history (GET /v1/me/audits) — filtering the loaded page here would hide every
 * match sitting on a page the client never fetched. */
export interface MyAuditsPage {
  audits: AuditBatchRow[];
  total: number;
  limit: number;
  skip: number;
}

export async function getMyAuditsPage(filters?: {
  kind?: "community" | "enterprise";
  status?: string;
  q?: string;
  limit?: number;
  skip?: number;
}): Promise<MyAuditsPage> {
  const res = await authedFetch(`${API.me.audits}${auditQuery(filters)}`);
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Could not load your audits."));
  }
  const data = (await res.json()) as {
    audits?: ApiAuditBatch[];
    total?: number;
    limit?: number;
    skip?: number;
  };
  return {
    audits: (data.audits ?? []).map(mapAudit),
    total: data.total ?? 0,
    limit: data.limit ?? filters?.limit ?? 0,
    skip: data.skip ?? filters?.skip ?? 0,
  };
}

export interface ContributorDashboardData {
  batches: ContributorBatch[];
  submissions: Submission[];
  profileSummary: ProfileSummary;
  workSummary: PersonalWorkSummary;
}

export interface ValidatorDashboardData {
  audits: AuditBatchRow[];
  availableAudits: AuditBatchRow[];
  availableTotal: number;
  conflictExcluded: number;
  conflictExcludedByReason: { ownSubmission: number; duplicateOfOwnWork: number };
  profileSummary: ProfileSummary;
  workSummary: PersonalWorkSummary;
}

export type PersonalWorkSummary = {
  contributor: { submitted: number; processing: number; awaitingDecision: number; finalAccepted: number; needsAttention: number; terminalFailed: number };
  validator: { claimedBatches: number; completedBatches: number; pendingDecisions: number; decidedItems: number };
};

export type SubmissionListFilter = "all" | "action_needed" | "in_review" | "accepted";

export type SubmissionReviewBreakdown = {
  automatedChecks: number;
  validatorAudit: number;
  poolCloseReview: number;
};

export interface ContributorSubmissionBatchSummary {
  batch: ContributorBatch;
  /** Server-owned publication block for the parent bounty. Null on external work
   *  and on any payload that omitted it. */
  publication?: DatasetPublication | null;
  submissionTotal: number;
  summary: { accepted: number; actionNeeded: number; inReview: number; disputed: number };
  review?: SubmissionReviewBreakdown;
}

export type SubmissionWorkType = "all" | "community";

export interface CommunityOpenPool {
  id: string;
  title: string;
  datasetCategory: string;
  karmaPerAcceptedItem: number;
  karmaPricing: {
    contributorPerItem: number;
    contributorTotal: number;
    validatorPerAuditedItem: number;
    plannedAuditItems: number;
    validatorTotal: number;
  };
  communityLicense?: string | null;
  targetItems: string;
  acceptedItems: string;
  clearedItems?: string;
  poolSummary?: {
    capacityReserved?: number;
    finalAccepted?: number;
    validatorReview?: number;
  } | null;
  datasetType?: { id: string; name: string; domain: string } | null;
}

export interface CommunityOpenPoolPage {
  pools: CommunityOpenPool[];
  nextCursor: string | null;
  filterOptions: {
    datasetTypes: Array<{ id: string; name: string; domain: string }>;
  };
}

/** Typed, centralized client for the Community open-pool queue. Unlike the
 * retired community-batches endpoint, these rows are directly submittable. */
export async function getCommunityOpenPools(filters: {
  limit?: number;
  cursor?: string | null;
  search?: string;
  difficulty?: string;
  domain?: string;
  datasetTypeId?: string;
} = {}): Promise<CommunityOpenPoolPage> {
  const query = new URLSearchParams({ limit: String(filters.limit ?? 12) });
  if (filters.cursor) query.set("cursor", filters.cursor);
  if (filters.search?.trim()) query.set("q", filters.search.trim());
  if (filters.difficulty && filters.difficulty !== "all") query.set("difficulty", filters.difficulty);
  if (filters.domain && filters.domain !== "all") query.set("domain", filters.domain);
  if (filters.datasetTypeId && filters.datasetTypeId !== "all") query.set("datasetTypeId", filters.datasetTypeId);
  const res = await authedFetch(`${API.community.pools}?${query.toString()}`);
  if (!res.ok) throw new Error(await errorMessageFromResponse(res, "Could not load open community pools."));
  const data = (await res.json()) as Partial<CommunityOpenPoolPage>;
  return {
    pools: data.pools ?? [],
    nextCursor: data.nextCursor ?? null,
    filterOptions: { datasetTypes: data.filterOptions?.datasetTypes ?? [] },
  };
}

/** A contributor's community open-pool contributions to one bounty, grouped —
 * pool submissions have no ContributorBatch, so they surface here rather than in the
 * batch list. Links to /contributor/pool/[bountyId]. */
export interface PoolSubmissionGroup {
  bountyId: string;
  bountyTitle: string;
  category: string | null;
  language: string | null;
  karmaPerAcceptedItem: number;
  /** A closed pool accepts no new items and no revisions, so its failed items
   *  are evidence to read, not work to do — "N need action" is a lie on one. */
  poolClosed?: boolean;
  publicationStatus?: string;
  /** Server-owned publication block — the ONE wording of this pool's single
   *  publication event, shared with the pool detail page. Null when the API
   *  sent nothing, which renders as nothing. */
  publication?: DatasetPublication | null;
  submissionTotal: number;
  summary: { accepted: number; actionNeeded: number; inReview: number; disputed: number };
  review?: SubmissionReviewBreakdown;
}

export interface PoolSubmissionGroupPage {
  pools: PoolSubmissionGroup[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  allSummary: { submitted: number; accepted: number; actionNeeded: number; inReview: number; disputed: number };
}

export async function getMyPoolSubmissions(filters: {
  filter?: SubmissionListFilter;
  workType?: SubmissionWorkType;
  search?: string;
  page?: number;
  limit?: number;
}): Promise<PoolSubmissionGroupPage> {
  const query = new URLSearchParams({
    filter: filters.filter ?? "all",
    workType: filters.workType ?? "all",
    page: String(filters.page ?? 1),
    limit: String(filters.limit ?? 6),
  });
  if (filters.search?.trim()) query.set("search", filters.search.trim());
  const res = await authedFetch(`${API.me.poolSubmissions}?${query}`);
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Could not load your pool submissions."));
  }
  const data = (await res.json()) as Partial<PoolSubmissionGroupPage>;
  // Re-parse the block rather than trusting the payload's shape: same rule as
  // mapAudit above — a half-formed publication claim must render as nothing.
  return {
    pools: (data.pools ?? []).map((pool) => ({ ...pool, publication: parseDatasetPublication(pool.publication) })),
    total: data.total ?? 0,
    page: data.page ?? filters.page ?? 1,
    limit: data.limit ?? filters.limit ?? 6,
    totalPages: data.totalPages ?? 0,
    allSummary: data.allSummary ?? { submitted: 0, accepted: 0, actionNeeded: 0, inReview: 0, disputed: 0 },
  };
}

/** One authenticated round trip for Contributor history + rank. Available
 * work remains independently paginated/filtered by GET /v1/batches. */
export async function getContributorDashboard(): Promise<ContributorDashboardData | null> {
  try {
    const res = await authedFetch(API.me.contributorDashboard);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      batches?: ApiContributorBatch[];
      submissions?: Array<ApiSubmissionDetail & { bounty?: { language?: string; framework?: string } }>;
      profileSummary?: ProfileSummary;
      workSummary?: PersonalWorkSummary;
    };
    if (!data.profileSummary) return null;
    return {
      batches: (data.batches ?? []).map(mapBatch),
      submissions: (data.submissions ?? []).map((submission) =>
        submissionDisplayFromApi(submission, {
          language: submission.bounty?.language,
          framework: submission.bounty?.framework,
        })
      ),
      profileSummary: data.profileSummary,
      workSummary: data.workSummary ?? { contributor: { submitted: 0, processing: 0, awaitingDecision: 0, finalAccepted: 0, needsAttention: 0, terminalFailed: 0 }, validator: { claimedBatches: 0, completedBatches: 0, pendingDecisions: 0, decidedItems: 0 } },
    };
  } catch {
    return null;
  }
}

/** One authenticated round trip for Validator rank, aggregate work counts and
 * the conflict-filtered available queue. `limit`/`skip` page the available
 * queue; `domains`/`categories`/`languages`/`kind` filter it server-side.
 *
 * `audits` is ALWAYS `[]` on this endpoint (routes/v1/me.ts
 * `/validator-dashboard` sends a literal empty array): the validator's own
 * claimed rows come from GET /v1/me/audits (`getMyAuditsPage`). No caller may
 * treat this field as the owned-audit list — it is kept only so the response
 * shape stays stable. `workSummary.validator` IS real (getMyAuditWorkSummary):
 * claimed/completed/pending counts over the validator's whole history,
 * unaffected by the queue's filters or paging.
 *
 * `kind` narrows to karma (community) or karma (enterprise) work. Both share one
 * queue server-side, so without it a flood of one kind can push the other off
 * the page entirely — the same reason the contributor workspace has an
 * All/Community control. */
export async function getValidatorDashboard(paging?: {
  limit?: number;
  skip?: number;
  domains?: string[];
  categories?: string[];
  languages?: string[];
  kind?: "community" | "enterprise";
  /** Free-text bounty-title search, applied server-side over the whole queue. */
  q?: string;
}): Promise<ValidatorDashboardData | null> {
  try {
    const query = new URLSearchParams();
    if (paging?.limit != null) query.set("limit", String(paging.limit));
    if (paging?.skip != null) query.set("skip", String(paging.skip));
    if (paging?.domains?.length) query.set("domains", paging.domains.join(","));
    if (paging?.categories?.length) query.set("categories", paging.categories.join(","));
    if (paging?.languages?.length) query.set("languages", paging.languages.join(","));
    if (paging?.kind) query.set("kind", paging.kind);
    if (paging?.q) query.set("q", paging.q);
    const qs = query.toString();
    const res = await authedFetch(qs ? `${API.me.validatorDashboard}?${qs}` : API.me.validatorDashboard);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      audits?: ApiAuditBatch[];
      availableAudits?: ApiAuditBatch[];
      availableTotal?: number;
      conflictExcluded?: number;
      conflictExcludedByReason?: { own_submission?: number; duplicate_of_own_work?: number };
      profileSummary?: ProfileSummary;
      workSummary?: PersonalWorkSummary;
    };
    if (!data.profileSummary) return null;
    return {
      audits: (data.audits ?? []).map(mapAudit),
      availableAudits: (data.availableAudits ?? []).map(mapAudit),
      availableTotal: data.availableTotal ?? (data.availableAudits ?? []).length,
      conflictExcluded: data.conflictExcluded ?? 0,
      conflictExcludedByReason: {
        ownSubmission: data.conflictExcludedByReason?.own_submission ?? 0,
        duplicateOfOwnWork: data.conflictExcludedByReason?.duplicate_of_own_work ?? 0,
      },
      profileSummary: data.profileSummary,
      workSummary: data.workSummary ?? { contributor: { submitted: 0, processing: 0, awaitingDecision: 0, finalAccepted: 0, needsAttention: 0, terminalFailed: 0 }, validator: { claimedBatches: 0, completedBatches: 0, pendingDecisions: 0, decidedItems: 0 } },
    };
  } catch {
    return null;
  }
}

/** Pull a clean, human-readable message out of a non-2xx response. Prefers the
 * API's `message`/`error` JSON field; falls back to the raw text, then a
 * caller-supplied default — so toasts/inline errors never show a raw JSON blob
 * like `{"statusCode":409,"error":"ConflictError","message":"…"}`. */
// Fastify's built-in 404 handler writes messages of the exact shape
// "Route POST:/v1/foo/bar not found" whenever a route genuinely doesn't
// exist server-side — a routing implementation detail, never something a
// real handler would phrase that way. Trusting it blindly meant a missing
// backend route displayed that raw string to the user instead of the
// caller's own fallback. A handler's own `reply.notFound("...")`-style
// message never matches this pattern, so it still passes through untouched.
const FASTIFY_ROUTE_NOT_FOUND = /^Route (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):.* not found$/;

export async function errorMessageFromResponse(
  res: Response,
  fallback: string,
): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return fallback;
  try {
    const body = JSON.parse(text) as { message?: string; error?: string };
    const candidate = body.message || body.error;
    if (!candidate || FASTIFY_ROUTE_NOT_FOUND.test(candidate)) return fallback;
    return candidate;
  } catch {
    return FASTIFY_ROUTE_NOT_FOUND.test(text) ? fallback : text;
  }
}

export type ClaimResult =
  | { ok: true; batch: ContributorBatch }
  | { ok: false; error: string };

/** Claim a batch. On failure returns the backend's message (e.g. the
 * concurrency-limit / already-claimed reasons) so the caller can surface it
 * — never silently swallow a rejected claim. */
export async function claimBatchReal(batchId: string): Promise<ClaimResult> {
  const res = await authedFetch(API.batches.claim(batchId), { method: "POST" });
  if (!res.ok) {
    let message = "Couldn't claim this batch. Please try again.";
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      const candidate = body.message || body.error;
      if (candidate && !FASTIFY_ROUTE_NOT_FOUND.test(candidate)) message = candidate;
    } catch {
      /* non-JSON error body — keep the default message */
    }
    return { ok: false, error: message };
  }
  const data = (await res.json()) as { batch?: ApiContributorBatch };
  if (!data.batch) return { ok: false, error: "Claim did not return a batch." };
  return { ok: true, batch: mapBatch(data.batch) };
}

export async function getBatchContract(batchId: string): Promise<BatchContract | null> {
  const res = await authedFetch(API.batches.contract(batchId));
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Could not load this batch. Please try again."));
  }
  return (await res.json()) as BatchContract;
}

// Community open-pool contribution (COMMUNITY_OPEN_POOL_PLAN_V2) — no
// ContributorBatch, so this is a distinct, bounty-keyed contract shape rather
// than reusing BatchContract.
export interface PoolContract {
  bounty: {
    id: string;
    title: string;
    description: string;
    category: DatasetCategory;
    language: string;
    framework: string;
    karmaPerAcceptedItem: number;
    karmaPricing: { contributorPerItem: number; contributorTotal: number; validatorPerAuditedItem: number; plannedAuditItems: number; validatorTotal: number; matrixVersion: number | null; complexityScore: number | null; verificationUnits: number | null; difficulty: string };
    targetItems: string;
    /** FINAL acceptance only: a validator passed the item, or it shipped in the
     *  published dataset. This is the honest "accepted" number — it must NOT be
     *  used to measure how full the pool is. */
    acceptedItems: string;
    /** Items that cleared the automated pipeline and hold pool capacity, final
     *  fate still pending. This is the counter that fills the pool and triggers
     *  close-out, so it is the correct source for capacity/progress and for any
     *  "is the pool full" gate. Optional only for API versions predating the
     *  accepted-vs-cleared split. */
    clearedItems?: string;
    poolClosedAt: string | null;
    deadline: string | null;
    /** The real accept gate also requires status === "active" (see
     * services/pool-submission.ts POOL_OPEN_STATUSES) — a paused/closing/
     * disputed pool can have poolClosedAt still null. */
    status: BountyStatus;
    /** The requester's CHOSEN human-audit coverage — the answer, not the
     *  template's `verification.auditOptions` menu. */
    auditCoveragePct?: number;
    /** The pool's ONE difficulty, frozen at mint. Null on pools minted before
     *  the column existed; those award at the middle rate. */
    difficulty?: string | null;
    /** The licence the contributor's work ships under. This contract is the
     *  surface where they agree to it. */
    license?: string | null;
    licenseUrl?: string | null;
    /** Server-owned audit timing and observed rolling-window progress. */
    humanAudit?: {
      mode: "rolling_window" | "pool_close";
      windowSize: number | null;
      targetCoveragePct: number;
      windowsClosed: number;
      eligibleItems: number;
      selectedItems: number;
      completedDecisions: number;
    };
    /** Versioned, server-owned community-pool state. Never recompute these
     * buckets from user-scoped submissions or legacy clearedItems. */
    poolSummary?: {
      version: number;
      /** The immutable community-policy snapshot. Policy-controlled pools never infer this
       * from audit coverage: a sponsor has no review/sampling control. */
      policy?: {
        validation: "full_human" | "automation_only";
        sponsorDispute: false;
        karmaRelease: "on_final_accept";
      };
      targetItems: number;
      totalSubmitted: number;
      finalAccepted: number;
      capacityReserved: number;
      remainingToTarget: number;
      awaitingNextWindow: number;
      awaitingCurrentWindowOutcome: number;
      validatorReview: number;
      sponsorReview: number;
      processing: number;
      needsFixes: number;
      rejected: number;
      failedAutomatedChecks: number;
      disputed: number;
      window: { mode: "rolling_window" | "pool_close"; size: number | null; coveragePct: number; failureThresholdPct: number; index: number | null; eligibleItems: number; selectedItems: number; validatorDecisions: number; closureReason: string | null };
      /** Server-owned publication block. A community dataset publishes ONCE for
       * the whole pool, once it is complete and every validator decision is in.
       * Optional because older API versions omit it entirely — parse it through
       * `parseDatasetPublication` and render nothing when absent. */
      publication?: DatasetPublication | null;
    } | null;
  };
  datasetType: DatasetType;
  verification: DatasetType["verification"];
  sourceUpload: SourceUploadRequirements;
  /** Scan-ready, admin-approved sponsor examples. Read-only for contributors. */
  sponsorReferences?: ApiArtifact[];
  /** Server-owned `validation.llm.enabled`; absent means treat as off. */
  llmValidationEnabled?: boolean;
  /** Remaining shared pool capacity — a snapshot, never a reservation;
   *  the submit transaction stays the only authority. `yourRemaining` remains
   *  for older clients and is always equal to `poolRemaining`. */
  capacity?: {
    poolRemaining: number;
    yourRemaining: number;
    maxItemsThisCall: number;
    recommendedPath: "submit_pool_items" | "bulk_upload" | "none";
    nextStep: string;
    alternatives: { browsePoolsUrl: string; sponsorDatasetUrl: string };
  };
  /** Live admin-configured caps; read rather than assumed. */
  submitLimits?: { maxItemsPerRequest: number; bulkThresholdItems: number };
}

export async function getPoolContract(bountyId: string): Promise<PoolContract | null> {
  const res = await authedFetch(API.bounties.poolContract(bountyId));
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Could not load this pool. Please try again."));
  }
  return (await res.json()) as PoolContract;
}

export async function submitPoolItemsReal(args: {
  bountyId: string;
  items: Record<string, unknown>[];
  generationMethod?: "human" | "ai_assisted" | "ai_generated";
}): Promise<ApiSubmissionDetail[]> {
  const res = await authedFetch(API.bounties.poolItems(args.bountyId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: args.items, generationMethod: args.generationMethod }),
  });
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Submission failed. Please try again."));
  }
  const data = (await res.json()) as { submissions?: ApiSubmissionDetail[] };
  return data.submissions ?? [];
}

export interface BatchSubmissionPage {
  submissions: Array<{
    id: string;
    title: string;
    status: string;
    duplicateScore: number | null;
    llmScore: number | null;
    issueCount: number;
    actionable: boolean;
    revisionsRemaining: number;
  }>;
  submissionCounts: Record<string, number>;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export async function getBatchSubmissions(
  batchId: string,
  filters: { page?: number; limit?: number; filter?: SubmissionListFilter; search?: string }
): Promise<BatchSubmissionPage> {
  const query = new URLSearchParams({
    page: String(filters.page ?? 1),
    limit: String(filters.limit ?? 10),
    filter: filters.filter ?? "all",
  });
  if (filters.search?.trim()) query.set("search", filters.search.trim());
  const res = await authedFetch(`${API.batches.submissions(batchId)}?${query}`);
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Could not load this batch's submissions."));
  }
  const data = (await res.json()) as Partial<BatchSubmissionPage>;
  return {
    submissions: data.submissions ?? [],
    submissionCounts: data.submissionCounts ?? {},
    total: data.total ?? 0,
    page: data.page ?? filters.page ?? 1,
    limit: data.limit ?? filters.limit ?? 10,
    totalPages: data.totalPages ?? 0,
  };
}

/** Community open-pool equivalent of getBatchSubmissions: the contributor's own
 * submissions to a pool bounty (no ContributorBatch), same paginated shape. */
export async function getPoolSubmissions(
  bountyId: string,
  filters: { page?: number; limit?: number; filter?: SubmissionListFilter; search?: string }
): Promise<BatchSubmissionPage> {
  const query = new URLSearchParams({
    page: String(filters.page ?? 1),
    limit: String(filters.limit ?? 10),
    filter: filters.filter ?? "all",
  });
  if (filters.search?.trim()) query.set("search", filters.search.trim());
  const res = await authedFetch(`${API.bounties.poolSubmissions(bountyId)}?${query}`);
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Could not load your pool submissions."));
  }
  const data = (await res.json()) as Partial<BatchSubmissionPage>;
  return {
    submissions: data.submissions ?? [],
    submissionCounts: data.submissionCounts ?? {},
    total: data.total ?? 0,
    page: data.page ?? filters.page ?? 1,
    limit: data.limit ?? filters.limit ?? 10,
    totalPages: data.totalPages ?? 0,
  };
}

export async function submitBatchItemsReal(args: {
  batchId: string;
  items: Record<string, unknown>[];
  generationMethod?: "human" | "ai_assisted" | "ai_generated";
}): Promise<ApiSubmissionDetail[]> {
  const res = await authedFetch(API.batches.items(args.batchId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: args.items, generationMethod: args.generationMethod }),
  });
  if (!res.ok) {
    let message = "Submission failed. Please check the batch and try again.";
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      const candidate = body.message || body.error;
      if (candidate && !FASTIFY_ROUTE_NOT_FOUND.test(candidate)) message = candidate;
    } catch {
      /* non-JSON body — keep the default message */
    }
    throw new Error(message);
  }
  const data = (await res.json()) as { submissions?: ApiSubmissionDetail[] };
  return data.submissions ?? [];
}

export async function claimAuditReal(auditId: string): Promise<AuditBatch | null> {
  const res = await authedFetch(API.audits.claim(auditId), { method: "POST" });
  if (!res.ok) return null;
  const data = (await res.json()) as { audit?: ApiAuditBatch };
  return data.audit ? mapAudit(data.audit) : null;
}

export async function getAuditDetail(auditId: string): Promise<AuditDetail | null> {
  const res = await authedFetch(API.audits.one(auditId));
  // Reserve `null` for a genuine 404 ("this audit doesn't exist / isn't yours
  // to claim" — the caller renders the claim-it-first empty state). Any other
  // failure (403/500/network) must THROW so the caller shows its real
  // error+retry branch instead of a misleading "not found" empty state.
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, `Failed to load audit (${res.status})`));
  }
  // `sponsorReferences` is a sibling of `audit` in the response — merge it in
  // so the detail object carries the bounty brief alongside the items.
  const data = (await res.json()) as { audit?: AuditDetail; sponsorReferences?: AuditDetail["sponsorReferences"] };
  if (!data.audit) return null;
  return { ...data.audit, sponsorReferences: data.sponsorReferences ?? [] };
}

/** The contributor's own submission with real pipeline evidence, flags, and
 * attached files (GET /v1/submissions/:id). Powers the submission detail page
 * with genuine per-stage results instead of mock store state. */
export async function getSubmission(id: string): Promise<ApiSubmissionDetail | null> {
  const res = await authedFetch(API.submissions.one(id));
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Could not load this submission. Please try again."));
  }
  const data = (await res.json()) as { submission?: ApiSubmissionDetail };
  return data.submission ?? null;
}

/** The sponsor-owned counterpart to `getSubmission` above
 * (GET /v1/bounties/:id/submissions/:submissionId). `getSubmission`'s
 * `GET /v1/submissions/:id` is contributor-or-admin only, so a real sponsor
 * (a pool's requester, not an admin) got a 403 there and the sponsor
 * submission-detail page rendered "Cannot load this submission" for anyone
 * but an admin. This is a SEPARATE, sponsor-scoped read (owner-or-admin,
 * flags redacted to withhold validator identity — see the API's
 * services/sponsor-evidence.ts) rather than a widened gate on `getSubmission`. */
export async function getSponsorSubmissionEvidence(bountyId: string, submissionId: string): Promise<ApiSubmissionDetail | null> {
  const res = await authedFetch(API.bounties.submissionOne(bountyId, submissionId));
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Could not load this submission. Please try again."));
  }
  const data = (await res.json()) as { submission?: ApiSubmissionDetail };
  return data.submission ?? null;
}

export async function reviseSubmissionReal(args: {
  submissionId: string;
  payload: Record<string, unknown>;
  generationMethod?: ApiSubmissionDetail["generationMethod"];
}): Promise<ApiSubmissionDetail> {
  const res = await authedFetch(API.submissions.revise(args.submissionId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item: args.payload, generationMethod: args.generationMethod }),
  });
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Couldn't submit this revision. Please try again."));
  }
  const data = (await res.json()) as { submission?: ApiSubmissionDetail };
  if (!data.submission) throw new Error("revision response did not include the submission");
  return data.submission;
}

/** Requeue a failed automated validation attempt without replacing the item. */
export async function rerunSubmissionValidationReal(submissionId: string): Promise<ApiSubmissionDetail> {
  const res = await authedFetch(API.submissions.rerunValidation(submissionId), { method: "POST" });
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Couldn't rerun validation. Please try again."));
  }
  const data = (await res.json()) as { submission?: ApiSubmissionDetail };
  if (!data.submission) throw new Error("validation rerun response did not include the submission");
  return data.submission;
}

export async function disputeSubmissionReal(submissionId: string, argument: string) {
  const res = await authedFetch(API.submissions.dispute(submissionId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argument }),
  });
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Couldn't file this dispute. Please try again."));
  }
  return res.json();
}

function pickStr(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/**
 * Normalise an LLM rubric score to the 0–1 scale the display contract uses.
 *
 * Two scales genuinely coexist. THIS backend records 0–100: services/llm-client.ts
 * asks the model for a "0-100 integer" and clamps with `Math.min(100, …)`, and
 * services/validation.ts stores that straight into `ValidationResult.score`
 * ("Quality score N/100"). V1 recorded 0–1, which is what `LlmReviewResult`
 * in lib/types.ts still documents ("Overall 0–1 quality score") and what
 * `pct()` in lib/format.ts assumes — so a real 95 rendered as "9500%", and
 * `score >= (passThreshold ?? 0.7)` was trivially true for every score above 1,
 * making a failing verdict read as a pass.
 *
 * Normalised HERE, at the API boundary, rather than in `pct()`: `pct`/`pctOrDash`
 * are shared by callers that really are 0–1 — dedupe `duplicateScore`
 * (sponsor/[id]/view.tsx:503, sponsor-submission-detail.tsx:117,
 * stage-evidence-cards.tsx:60), `llmPassRate`/`duplicateRate`/`executionPassRate`
 * (community-request-card.tsx:186-188), `confirmedIssueRate`/`falseFlagRate`
 * (retired-overview.tsx:200-202) and AI-attribution likelihood
 * (stage-evidence-cards.tsx:124) — so changing `pct` would break all of them.
 *
 * The `> 1` test is the same magnitude rule the already-landed `LlmEvidenceCard`
 * uses (stage-evidence-cards.tsx:203), which reads raw evidence rows and so
 * cannot normalise; both therefore print the same number for the same score.
 * It is a heuristic with one ambiguous point — a literal 1 is read as 1.0
 * (100%), not 1/100 — which is the safe reading for a 0–1 source and a
 * vanishingly rare score for a 0–100 one.
 */
export function llmScoreTo01(n: number): number {
  return n > 1 ? n / 100 : n;
}

/**
 * Map a real API submission into the display `Submission` shape, deriving
 * per-stage scores/execution from `validationResults` and mapping real flags.
 * Shared by the contributor submission-detail view and the validator audit view
 * so both render genuine pipeline evidence.
 */
export function submissionDisplayFromApi(
  sub: ApiSubmissionDetail,
  opts: { language?: string; framework?: string; reward?: number } = {}
): Submission {
  const payload = sub.payloadJson ?? {};
  const validation = sub.validationResults ?? [];
  // Revisions append fresh evidence. Always display the newest result for each
  // stage so an old failure cannot override a later corrected submission.
  const latestByStage = new Map<string, ApiValidationResult>();
  // FIRST-wins, because every API include that feeds this orders
  // `validationResults` by `createdAt: "desc"` (services/submissions.ts,
  // services/sponsor-evidence.ts). The previous last-wins `set` therefore kept
  // the OLDEST row per stage — so on a revised or re-validated item an old
  // failure overrode the later corrected result, which is the exact opposite
  // of the "always display the newest result for each stage" rule stated
  // above. If the API ever switches to ascending, this must flip back.
  for (const result of validation) {
    const key = normalizeValidationStage(result.stage);
    if (!latestByStage.has(key)) latestByStage.set(key, result);
  }
  const latestValidation = [...latestByStage.values()];
  const score = (stage: string) => latestByStage.get(stage)?.score ?? undefined;
  const execution = latestByStage.get("execution");
  const executionDetail = execution?.detailJson ?? {};
  const executionPending = Boolean(execution && !execution.passed && execution.score == null);
  const llm = latestByStage.get("llm");
  const llmDetail = (llm?.detailJson ?? {}) as Record<string, unknown>;
  const llmCriteria = Array.isArray(llmDetail.criteria)
    ? (llmDetail.criteria as Array<Record<string, unknown>>).map((c) => ({
        name: typeof c.name === "string" ? c.name : "",
        score: typeof c.score === "number" ? llmScoreTo01(c.score) : 0,
        note: typeof c.note === "string" ? c.note : "",
      }))
    : [];
  // A real model answer, as opposed to a recorded "nothing ran" row. This
  // backend's llm detailJson carries only `{ reasons, model }` on a real
  // review (services/validation.ts) — no `status`, and no `verdict` — so a
  // genuine FAIL used to arrive here as status "unknown" and render through
  // LlmReviewCard's "no reviewer has scored this item yet" branch: a failed
  // check reading as merely pending. Both are derived from the stored score
  // and `passed` instead.
  const llmReviewScore = typeof llmDetail.score === "number" ? llmDetail.score : llm?.score ?? null;
  const llmReviewed = llm != null && llmReviewScore != null;
  const llmVerdict =
    llmDetail.verdict === "pass" || llmDetail.verdict === "fail" || llmDetail.verdict === "uncertain"
      ? (llmDetail.verdict as "pass" | "fail" | "uncertain")
      : llmReviewed
        ? llm!.passed
          ? "pass"
          : "fail"
        : undefined;
  const stageNote = (result: ApiValidationResult) => {
    const detail = result.detailJson ?? {};
    const missing = Array.isArray(detail.missingRequiredFields) ? detail.missingRequiredFields.join(", ") : "";
    const reason = typeof detail.reason === "string" ? detail.reason : typeof detail.status === "string" ? detail.status : "";
    return `${result.stage}: ${result.passed ? "pass" : result.score == null ? "pending/blocked" : "fail"}${missing ? ` — missing: ${missing}` : reason ? ` — ${reason}` : ""}`;
  };
  const flags: Flag[] = (sub.flags ?? []).map((f) => ({
    id: f.id,
    submissionId: f.submissionId,
    validatorUserId: f.validatorUserId ?? null,
    reason: f.reason as Flag["reason"],
    details: f.details,
    createdAt: f.createdAt,
    status: f.status as Flag["status"],
  }));
  return {
    id: sub.id,
    bountyId: sub.bountyId,
    batchId: sub.contributorBatchId ?? "",
    title: sub.title,
    prompt: pickStr(payload, "prompt", "error_message", "target_code_or_spec", "source_code") || sub.title,
    language: opts.language ?? "",
    framework: opts.framework ?? "",
    difficulty: "intermediate",
    bugType: pickStr(payload, "bug_type"),
    concepts: [],
    brokenCode: pickStr(payload, "broken_code", "starter_code", "target_code_or_spec", "stack_trace", "source_code"),
    fixedCode: pickStr(payload, "fixed_code", "solution_code", "test_code", "suggested_fix", "migrated_code"),
    tests: pickStr(payload, "tests", "test_code"),
    explanation: pickStr(payload, "explanation", "test_rationale", "root_cause_analysis"),
    expectedBehavior: pickStr(payload, "expected_behavior", "expected_output_shape"),
    generationMethod: sub.generationMethod,
    status: sub.status as Submission["status"],
    duplicateScore: sub.duplicateScore ?? score("dedupe"),
    duplicateDecision:
      typeof latestByStage.get("dedupe")?.detailJson?.duplicateDecision === "string"
        ? (latestByStage.get("dedupe")?.detailJson?.duplicateDecision as string)
        : undefined,
    llmScore: sub.llmScore ?? score("llm"),
    execution: execution
      ? {
          brokenCodeFailedTests:
            (executionDetail as { brokenCodeFailedTests?: boolean | null }).brokenCodeFailedTests == null
              ? null
              : Boolean((executionDetail as { brokenCodeFailedTests?: boolean | null }).brokenCodeFailedTests),
          fixedCodePassedTests: execution.passed,
          testsRun: Number((executionDetail as { testsRun?: number }).testsRun ?? 0),
          logs: JSON.stringify(executionDetail, null, 2),
          decision: executionPending ? "pending" : execution.passed ? "pass" : "fail",
          reason:
            typeof executionDetail.reason === "string"
              ? executionDetail.reason
              : executionPending
                ? "Execution has not produced a verdict yet."
                : undefined,
        }
      : undefined,
    llmReview: llm
      ? {
          status: typeof llmDetail.status === "string" ? llmDetail.status : llmReviewed ? "reviewed" : "unknown",
          verdict: llmVerdict,
          score: llmReviewScore == null ? undefined : llmScoreTo01(llmReviewScore),
          passThreshold:
            typeof llmDetail.passThreshold === "number" ? llmScoreTo01(llmDetail.passThreshold) : undefined,
          evidence: typeof llmDetail.evidence === "string" ? llmDetail.evidence : undefined,
          criteria: llmCriteria,
          reason: typeof llmDetail.reason === "string" ? llmDetail.reason : undefined,
        }
      : undefined,
    reviewNotes: latestValidation.map(stageNote),
    flags,
    reward: opts.reward ?? 0,
    submittedAt: sub.createdAt ? new Date(sub.createdAt).toLocaleDateString() : "",
  };
}

export async function submitAuditDecisionReal(args: {
  auditId: string;
  auditItemId: string;
  verdict: "ok" | "flagged";
  flagReason?: string;
  note?: string;
}) {
  const res = await authedFetch(API.audits.decisions(args.auditId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      decisions: [
        {
          auditItemId: args.auditItemId,
          verdict: args.verdict,
          flagReason: args.flagReason,
          note: args.note,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(await errorMessageFromResponse(res, "Couldn't record this decision. Please try again."));
  }
  return res.json();
}
