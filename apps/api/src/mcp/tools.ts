// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { type McpTool, PUBLIC_SCOPE } from "./core/contract.js";
import { McpToolError } from "./core/errors.js";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import {
  normalizePublicHandle,
  findAvailableHandleSuggestions,
  suggestAvailableHandles,
} from "../services/public-handles.js";
import { createEmailVerificationToken } from "../lib/email-verification.js";
import { sendVerificationEmail } from "../lib/auth-notify.js";
import { listCommunityPools, getCommunityPool, getCommunityStats, getPoolContractForBounty, PoolCursorError } from "../services/bounties.js";
import { INVALID_FILE_ARTIFACT_REFERENCE } from "../services/artifact-attach.js";
import {
  createPoolSubmission,
  submitPoolBatchItems,
  getSubmissionById,
  listSubmissions,
  reviseSubmission,
  ReviseSubmissionError,
  rerunSubmissionValidation,
  RerunValidationError,
} from "../services/submissions.js";
import {
  listAvailableAudits,
  listMyAuditWindows,
  getClaimedAuditWindowDetail,
  claimAuditWindow,
  submitAuditDecisions,
  AuditWindowNotClaimedError,
  AuditWindowClaimedByOtherError,
  AuditFlagNoteRequiredError,
  AuditWindowNotFoundError,
  AuditWindowSettledError,
  AuditWindowSupersededError,
  AuditItemNotInWindowError,
  AuditOwnSubmissionError,
  AuditItemAlreadyDecidedError,
  MIN_FLAG_NOTE_LENGTH,
  getMyAuditWorkSummary,
} from "../services/audits.js";
import { createUploadReviewDraft, UploadReviewDraftError } from "../services/upload-review-drafts.js";
import { getUploadReviewDraftStatusForOwner } from "../routes/v1/upload-review-drafts.js";
import { getProfileSummary } from "../services/profile-summary.js";
import { getKarmaBreakdown } from "../services/karma.js";
import { fileSubmissionDispute } from "../services/disputes.js";
import {
  createUploadSlot,
  completeUpload,
  createMultipartUpload,
  completeMultipartUpload,
  abortMultipartUpload,
  ArtifactUploadValidationError,
  getArtifactById,
  listUserArtifacts,
  softDeleteArtifact,
} from "../services/artifacts.js";
import { listNotifications, markAllNotificationsRead, markNotificationRead, NotificationCursorError } from "../services/notifications.js";
import { collectIssueContext, createAgentIssue, getIssueById, listUserIssuesPage, replyToIssue,
  isIssueClosed, InvalidIssueCursorError, IssueCursorFilterMismatchError,
} from "../services/issues.js";
import { getAttributionPreference, setAttributionPreference } from "../services/reputation.js";
import { CursorFilterMismatchError, InvalidCursorError, decodeCursor, encodeCursor, filterKeyOf } from "../lib/keyset-cursor.js";
import { SUBMISSION_ITEMS_HARD_MAX } from "./core/limits.js";
import { getPoolSubmitLimits, SubmissionItemLimitError } from "../services/submission-limits.js";
import { ingestBlockFor, processingChecksFor, scanProgressFor, validationEtaForSubmission } from "./core/file-status.js";
import { disputeAcceptedSubmission, listSponsorSubmissionEvidence, SponsorEvidenceError } from "../services/sponsor-evidence.js";
import { phaseSchema, PHASE_STATUSES } from "../lib/public-query.js";
import {
  AgentIssueCategory,
  AgentIssueImpact,
  AgentIssueStatus,
  ApiKeyScope,
  ArtifactKind,
  AuditVerdict,
  BountyStatus,
  DatasetTypeStatus,
  DisputeStatus,
  FlagReason,
  GenerationMethod,
  KarmaEventType,
  SubmissionStatus,
} from "@prisma/client";

/**
 * The paging contract every cursor-paged list tool in this file states, worded
 * identically so an agent reading two tool descriptions cannot conclude they
 * behave differently. Two claims matter and both are load-bearing: `hasMore` is
 * the ONLY authority on whether more rows exist (a short page is not an end of
 * list), and the filters must not change mid-walk (the cursor is bound to them
 * and a mismatch is refused rather than silently re-anchored).
 */
const PAGING =
  "Page with `cursor` while `hasMore` is true — `hasMore` is the server's word on whether more rows exist, so " +
  "never infer the end of the list from a short or empty page. Keep every filter identical across a walk: a " +
  "cursor is bound to the filters it was minted under and a changed filter is refused, not silently " +
  "re-anchored. An error is never proof that there is nothing left.";

/**
 * Surfaces a rejected keyset cursor as an explicit 400, never as an empty page.
 *
 * This is the whole point of the filter-bound cursor: an empty success is
 * byte-identical to "you have no rows", so an agent that replayed a stale or
 * cross-filter cursor would conclude its walk had finished and stop — quietly
 * missing every row after that point. Refusing tells it to restart paging.
 *
 * Also catches `PoolCursorError` (services/bounties.ts, used by
 * list_community_pools) and `NotificationCursorError` (services/
 * notifications.ts, used by list_notifications) — two more per-domain
 * "malformed cursor" error classes with the exact same shape as the keyset
 * pair above. Both tools used to call their service directly, unwrapped:
 * a malformed cursor's domain error was never an `McpToolError`, so
 * `safeMcpErrorMessage()` replaced it with the generic "could not be
 * completed" message, hiding the one actionable fact (the cursor itself is
 * bad) an agent needs to recover by restarting its walk.
 */
async function withCursorErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (
      err instanceof InvalidCursorError ||
      err instanceof CursorFilterMismatchError ||
      err instanceof PoolCursorError ||
      err instanceof NotificationCursorError
    ) {
      throw new McpToolError(err.message, 400);
    }
    throw err;
  }
}

/**
 * Prisma serializes `sizeBytes`/`declaredSizeBytes` on `Artifact` as BigInt
 * (see prisma/schema.prisma). `makeToolHandler` (transport.ts) does a plain
 * `JSON.stringify(result)` on whatever a tool returns — and `JSON.stringify`
 * throws a raw `TypeError` on any BigInt, not an `McpToolError`. That falls
 * through to `safeMcpErrorMessage`'s generic "could not be completed"
 * message, so every artifact-returning tool call (`complete_file_upload`,
 * `complete_large_file_upload`, `get_file_status`, `list_files`) went
 * permanently opaque the moment a real upload set a non-null size — the exact
 * path a real client hits on every completed upload. `routes/v1/artifacts.ts`
 * dodges this with its own `serializeArtifact()`; this is the same fix
 * (Number, not String — file sizes never approach 2^53) applied at the MCP
 * boundary, which returns raw service-layer rows rather than that route's
 * shaped wire contract.
 */
function withoutBigInt<T>(value: T): T {
  if (typeof value === "bigint") return Number(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => withoutBigInt(v)) as unknown as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutBigInt(v)])) as T;
  }
  return value;
}

/**
 * `services/artifacts.ts`'s `createUploadSlot()` returns a relative `url`
 * inside `upload` (e.g. `/v1/artifacts/:id/content?token=...`) ONLY on the
 * local-driver fallback — a real direct-upload target from an object store
 * (`hasDirectUpload`) is already absolute (it points at the bucket host).
 * `routes/v1/artifacts.ts` `POST /upload-slot` is a browser flow that
 * deliberately re-prefixes the relative case with `req.protocol`/
 * `req.headers.host`, with an explicit comment explaining why ("the browser
 * resolves a relative `url` against the WEB app's own origin, not this API's,
 * and 404s").
 *
 * An MCP tool caller is an out-of-process client (a CLI, an agent host) with
 * no notion of "this same origin" at all — there is no page for a relative
 * path to resolve against. Left unprefixed, `prepare_file_upload` /
 * `prepare_large_file_upload` handed back a URL no MCP client outside this
 * process could ever turn into somewhere to PUT/POST bytes. Absolutize it
 * here, the same way that REST route does, using this service's own
 * configured public base URL (`config.publicApiBaseUrl`, env-pinned via
 * `PUBLIC_API_BASE_URL` and boot-guarded against a localhost default in
 * production — see `config.ts`) rather than a request's Host header (an MCP
 * tool call has no inbound "browser page" host to borrow).
 */
function withAbsoluteUploadUrl<T extends { upload?: { url?: string } }>(slot: T): T {
  if (slot.upload?.url && slot.upload.url.startsWith("/")) {
    return { ...slot, upload: { ...slot.upload, url: `${config.publicApiBaseUrl}${slot.upload.url}` } };
  }
  return slot;
}

/**
 * v1 names the id parameter on every file tool `fileId`, not `artifactId`
 * (`databounty-api/src/mcp/tools.ts` — "Tool-facing name/params say 'file' —
 * that's the concept an agent actually reasons about", while the `artifact`
 * SCOPE and the REST path keep the stored enum name). This port renamed the
 * parameter, which silently breaks every agent and prompt written against v1:
 * the call arrives with `fileId`, the tool requires `artifactId`, and the
 * caller gets a schema error naming a parameter it has never heard of.
 *
 * Both names are accepted, `fileId` is the documented one, and the pair is
 * declared as two OPTIONAL fields plus a runtime check rather than a
 * `.refine()` union: `transport.ts`'s `rawShape()` only unwraps a plain
 * `z.ZodObject`, so a refined schema would register with NO advertised
 * parameters at all and `tools/list` would stop describing the tool.
 */
const fileIdShape = {
  fileId: z.string().optional().describe("Id returned by prepare_file_upload or prepare_large_file_upload."),
  artifactId: z.string().optional().describe("Alias of fileId (the stored artifact id). Prefer fileId."),
};

function requireFileId(args: { fileId?: string; artifactId?: string }): string {
  const id = args.fileId ?? args.artifactId;
  if (!id) throw new McpToolError("fileId is required (its alias artifactId is also accepted).", 400);
  return id;
}

/**
 * `HumanAuditWindow` is a genuinely different entity from v1's `AuditBatch` —
 * different table, different lifecycle, different claim semantics — so
 * renaming `windowId` to v1's `auditId` would MISNAME it. `auditId` is
 * accepted as a documented alias instead, so a v1-era client's call still
 * lands, while the canonical, advertised name keeps telling the truth about
 * what it identifies. Same optional-pair mechanics as `fileIdShape` above.
 */
const auditWindowIdShape = {
  windowId: z.string().optional().describe("Human audit window id (canonical)."),
  auditId: z.string().optional().describe("Alias of windowId, for clients written against v1's audit tools."),
};

function requireWindowId(args: { windowId?: string; auditId?: string }): string {
  const id = args.windowId ?? args.auditId;
  if (!id) throw new McpToolError("windowId is required (its alias auditId is also accepted).", 400);
  return id;
}

/**
 * The two artifact kinds an MCP caller may upload.
 *
 * `bulk_submission_source` is deliberately WITHHELD, exactly as v1 withholds
 * it (`databounty-api/src/mcp/tools.ts` — the enum member is kept commented
 * there so re-enabling is a one-line change). The upload target for a bulk
 * source is direct-to-object-storage on the bucket host, which a sandboxed
 * agent behind an egress allowlist generally cannot reach: the slot is
 * issued, the PUT is refused, and the caller is left holding an expiring slot
 * with nothing uploaded. `prepare_large_file_upload` HARD-CODED that kind, so
 * every large upload an agent made through this server was the one kind it
 * was least able to complete. The browser hand-off
 * (`create_upload_review_link`) is the supported bulk route.
 *
 * The other seven `ArtifactKind` members (validation_log, export_bundle,
 * benchmark_*, public_sample, publication_bundle) are server-authored
 * artifact kinds and were never a caller's to create either; the previous
 * `z.nativeEnum(ArtifactKind)` on `prepare_file_upload` accepted all of them.
 */
const MCP_UPLOAD_KINDS = [ArtifactKind.sponsor_reference, ArtifactKind.submission_attachment] as const;

export const tools: McpTool[] = [
  {
    name: "get_pool",
    description:
      "Read one community pool's public details: its dataset type, live progress counters and the karma awarded per accepted item. For the field contract, submit limits and pool summary an agent needs before contributing, call get_pool_contract instead. " +
      "Never derive an earnings figure by multiplying `karmaPerAcceptedItem` by `targetItems` or `acceptedItems` — that is a pool-wide ceiling, not this contributor's karma, and quoting it as theirs is a false promise.",
    scope: "public",
    schema: z.object({ bountyId: z.string().describe("Community pool bounty id returned by list_community_pools") }),
    call: async ({ bountyId }) => {
      const pool = await getCommunityPool(bountyId, { publicOnly: true });
      if (!pool) throw new McpToolError("Dataset pool not found");
      return pool;
    },
  },
  {
    name: "list_dataset_categories",
    description:
      "Discover the LIVE dataset-type catalog grouped by category before browsing individual pools. " +
      "Use this when someone asks what kinds of work or data exist. It returns only ACTIVE dataset types read from the catalog itself; " +
      "a category is not a promise that an open pool currently exists. After the user chooses a returned category, call list_community_pools with that category to see live work.",
    scope: "public",
    schema: z.object({}),
    // Was `Object.values(DatasetCategory)` — the compiled-in Prisma enum, so
    // this advertised every category the SCHEMA has ever declared, including
    // ones with no active dataset type in this deployment at all. An agent
    // that then called list_community_pools with such a category got an empty
    // list and no way to tell "nothing open right now" from "this category
    // does not exist here". v1 serves the live catalog (`/meta/public-catalog`);
    // this reads the same `DatasetType` rows that route does, so a category
    // disappears from the tool the moment its last active type does.
    call: async () => {
      const typeRows = await prisma.datasetType.findMany({
        where: { status: DatasetTypeStatus.active },
        select: { id: true, name: true, description: true, domain: true, category: true, trustTier: true, difficultyLevels: true },
        orderBy: [{ category: "asc" }, { name: "asc" }],
      });
      const categoryIds = Array.from(new Set(typeRows.map((t) => t.category)));
      return {
        categories: categoryIds.map((id) => ({
          id,
          label: String(id).split("_").map((word) => (word[0]?.toUpperCase() ?? "") + word.slice(1)).join(" "),
          datasetTypes: typeRows.filter((t) => t.category === id).map(({ category: _category, ...rest }) => rest),
        })),
      };
    },
  },
  {
    name: "list_community_pools",
    description:
      "Browse active community pools open for contribution. Accepted contributions build your karma balance, tier and public reputation. A pool is open: there is nothing to claim, so read its contract with get_pool_contract, then contribute with submit_pool_items directly. " +
      "Each pool carries `difficulty`: the single level the requester set this pool to be worked at, and the level its karma rate is priced from — the same field, under the same name, that get_pool_contract returns, so a listing and a contract never disagree. Do not confuse it with `datasetType.difficultyLevels`, which is only the menu of levels the template allows. A null `difficulty` means the pool has none declared: say so rather than guessing a middle level. " +
      "Each row already carries everything you need to shortlist without opening anything else: dataset type, `difficulty`, `karmaPerAcceptedItem`, and a `poolSummary` with the same field names and meanings the contract publishes — `finalAccepted` is completed work counting toward dataset completion, karma and publication, `capacityReserved` is occupied room, and `remainingToTarget` is what is left. Do not call get_pool_contract on every row just to compare progress; call it for the pool the operator actually picks. " +
      "`acceptedItems` at the top level is the legacy cleared counter and is NOT the same number as `poolSummary.finalAccepted`. Present `karmaPerAcceptedItem` as the rate per FINAL accepted item, and never multiply it by a target to quote someone a total they have not earned. " +
      "Defaults to active/completed/closing pools. Narrow to one exact lifecycle `status`, or to a named `phase` (open/production/delivered — the same phase vocabulary the public catalog and every other listing here use) when the operator wants delivered/past pools instead of what is open now.",
    scope: "public",
    schema: z.object({
      // v1 exposes `domain` here (coding/legal/healthcare/finance/science) and
      // it was dropped in this port, so the top-level axis an operator
      // actually asks in ("what legal work is there?") had no filter at all —
      // only the narrower `category`. Restored; `language` is a Community
      // addition and is kept alongside it.
      domain: z.string().optional().describe("Dataset-type domain, e.g. coding, legal, healthcare, finance, science"),
      category: z.string().optional(),
      language: z.string().optional(),
      // REST's own `GET /v1/bounties` (routes/v1/bounties.ts, the route this
      // same `listCommunityPools` service backs) accepts both of these and
      // the service has always taken them directly — only this tool's schema
      // never exposed either, so an agent could not narrow to one lifecycle
      // status, or to the named phase groupings (`open`/`production`/
      // `delivered`) the web catalog filters by, without listing everything
      // and filtering client-side. `phase` shares the one vocabulary
      // (lib/public-query.ts PHASE_STATUSES) every public listing in this API
      // already uses, so it cannot name a phase the REST route would reject.
      // A single explicit `status` still wins over `phase`, matching the
      // service's own precedence.
      status: z.nativeEnum(BountyStatus).optional().describe("Narrow to one exact lifecycle status. Wins over `phase` when both are given."),
      phase: phaseSchema.optional().describe("Named lifecycle-phase grouping (open/production/delivered) — the same vocabulary every public listing in this API uses."),
      // Bounded here, not just in the service: `Math.min(limit ?? 50, 100)`
      // lets a negative through, and Prisma reads `take: -1` from the
      // opposite end of the ordering. The REST route already fixed this.
      limit: z.number().int().min(1).max(100).optional(),
      // v1 pages this with an opaque, stable `cursor`. `offset` is kept
      // because existing Community callers pass it, but it is NOT stable —
      // a pool minted between two pages shifts every later row — so `cursor`
      // is the documented way to walk the list and wins when both are given.
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous call's nextCursor"),
      offset: z.number().int().min(0).optional().describe("Legacy, non-stable paging. Prefer cursor."),
    }),
    // Was an unwrapped `listCommunityPools(args)` — a malformed `cursor`
    // throws `PoolCursorError`, which reached the transport uncaught and was
    // replaced with the generic "could not be completed" message instead of
    // the actionable 400 every other cursor-paged list tool in this file
    // gives (see withCursorErrors' updated doc comment above).
    call: async ({ phase, ...args }) =>
      withCursorErrors(() =>
        listCommunityPools({ ...args, statuses: phase ? PHASE_STATUSES[phase] : undefined }),
      ),
  },
  {
    name: "get_community_stats",
    description:
      "Read the live public totals for the community karma program: open pools, published datasets, accepted items, contributors, total karma awarded, the tier ladder and the leaderboard. " +
      "NO ACCOUNT IS NEEDED — this works before sign-in, so it is how you show a prospective contributor what is really here instead of describing it. One call covers the whole pitch. " +
      "Quote only what it returns. Never scale a figure into a projection, never turn karma into money, and never imply a number it did not give you; if the totals are small, say so — the operator can check them in a browser.",
    scope: "public",
    schema: z.object({}),
    call: async () => getCommunityStats(),
  },
  {
    name: "get_pool_contract",
    description:
      "Read the exact field contract, verification requirements, live submitLimits and pool progress for a community pool. ALWAYS call this before contributing. No claim is required — a pool is open, so read the contract and then call submit_pool_items directly. " +
      "`sponsorReferences` contains the sponsor's actual ready, approved work-brief files when they attached any. Each entry has a server-gated download URL; do not expect raw object-storage URLs. `datasetType.sampleAssets` is separate: it is an optional admin-authored template example, not the sponsor's upload. An empty or absent value in either field means that kind of sample does not exist yet, not that the contract failed to load. Never claim samples exist, describe their content, or wait for them before contributing; when absent, derive field shape and task patterns from `datasetType.fields` and `verification` alone. When samples ARE present, learn field shape and task patterns from them but NEVER copy their distinctive content. For multiple items, make a coverage plan across the permitted patterns and vary task intent, context, constraints, edge cases and answer approach where those dimensions apply; do not manufacture variants by changing only names, numbers or wording. Meet only the benchmark requirements this contract explicitly states — never invent scores or passing results. Dataset work defaults to model training; do not ask the operator to choose training versus fine-tuning. " +
      "`difficulty` is the single level this pool is worked at and priced from, and `difficultyRequirement` restates it as an actionable standard: read its `guidance` and its `sampleRule` (\"samples never lower the selected difficulty\") before writing anything. Do not confuse `difficulty` with `datasetType.difficultyLevels`, which is only the menu of levels the template allows. A null `difficulty` means the pool has none declared — `difficultyRequirement` says so explicitly, and you should too rather than guessing a middle level. " +
      "READ THE `capacity` BLOCK before spending a submit call: `poolRemaining` is the room left across all contributors, `maxItemsThisCall` is the most one call should carry, `recommendedPath` is `submit_pool_items`, `bulk_upload` or `none`, and `nextStep` is a plain-language instruction safe to relay verbatim. It is a SNAPSHOT, not a reservation — another contributor can take the last slot before you submit, so never present it as a promise, and it is pool-wide room, not a personal allowance (`yourRemaining` is a compatibility alias for `poolRemaining`). When `recommendedPath` is `none` the pool is full or closed: move on using `alternatives`, and never retry a submit against it. " +
      "`submitLimits.maxItemsPerRequest` is the hard reject cap for one submit_pool_items call; `submitLimits.bulkThresholdItems` is the advisory size above which a browser hand-off via create_upload_review_link is the better path. " +
      "For pool-wide progress read `poolSummary.capacityReserved` (places occupied by work in processing, review, dispute or final acceptance — terminally failed and rejected rows release a place) and `poolSummary.finalAccepted` (completed work that counts toward dataset completion, karma and publication) separately; never present the legacy `clearedItems` counter as the authoritative current capacity. Automated-validation configuration is internal: self-review every item against the contract and rely only on recorded validation results and final status.",
    // A real sponsor work brief is not public catalog data. The REST and MCP
    // contracts expose the same approved files to an authenticated contributor,
    // never to an anonymous MCP client.
    scope: "contribute",
    schema: z.object({ bountyId: z.string().describe("Community pool bounty id returned by list_community_pools") }),
    call: async ({ bountyId }) => {
      // Was returning `pool.datasetType` alone, which threw away the contract
      // the REST route (`GET /v1/bounties/:id/contract`) already serves: the
      // pool progress, difficulty, karma pricing and submit limits. The REST
      // contract also contains internal LLM deployment facts for dashboard
      // rendering; MCP must not disclose those implementation details.
      const contract = await getPoolContractForBounty(bountyId, { includeSponsorReferences: true });
      if (!contract) throw new McpToolError("Dataset pool schema not found");
      const { llmValidationEnabled: _llmValidationEnabled, llmProviderConfigured: _llmProviderConfigured, ...mcpContract } = contract;
      return mcpContract;
    },
  },
  {
    name: "submit_pool_items",
    description:
      "Submit completed dataset items to an open community pool. No claim step exists — read get_pool_contract first, then send items that meet that contract. " +
      "Read the contract's live `submitLimits` before choosing a path. At or below its inline limit, submit once; above it, use create_upload_review_link so the contributor can review parsed rows in the browser. Do not split a normal bulk contribution into repeated inline calls. " +
      "SELF-REVIEW EVERY ITEM against the contract before calling: check the required fields, the declared difficulty, and the verification requirements. Never infer an outcome from a pending or absent validation result; only the recorded final status is authoritative. " +
      "Declare `generationMethod` honestly for each item. " +
      "THE RETURNED `created` COUNT IS ROWS WRITTEN, NOT ITEMS ACCEPTED: duplicates are written straight to `rejected` at intake and are never queued for validation. Inspect each returned submission with check_submission before telling the operator anything was accepted. " +
      "Validation runs asynchronously; karma is awarded per item on final acceptance, never for submitting alone, and where a dispute window applies it is held until that window closes.",
    scope: "contribute",
    schema: z.object({
      bountyId: z.string(),
      // Bounded exactly as v1 bounds it (`.min(1).max(SUBMISSION_ITEMS_HARD_MAX)`).
      // Unbounded, an agent could hand this an array of any length: the whole
      // array is written inside ONE transaction, so an oversized call does not
      // fail cleanly — it times out, having burned a tool call and returned
      // nothing actionable. Rejecting at the schema boundary names the limit
      // instead. The live per-request limit is admin-visible as
      // `submitLimits.maxItemsPerRequest` and may be lower than this bound.
      items: z
        .array(
          z.object({
            // Bounded exactly as this repo's own REST routes bound it
            // (routes/v1/submissions.ts `singleSubmissionBody`/
            // `bulkSubmissionBody`: `.trim().min(3).max(120)`). Was a bare
            // `z.string()`, so an empty or whitespace-only title — or one of
            // unbounded length — could be written through MCP while the
            // dashboard's own upload path would reject it outright.
            title: z.string().trim().min(3).max(120),
            payloadJson: z.record(z.unknown()),
            generationMethod: z.nativeEnum(GenerationMethod).optional(),
          })
        )
        .min(1)
        .max(SUBMISSION_ITEMS_HARD_MAX),
    }),
    call: async ({ bountyId, items }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      try {
        const receipt = await submitPoolBatchItems({
          bountyId: bountyId,
          contributorUserId: context.userId,
          items,
        });
        return {
          ...receipt,
          validation: await Promise.all(
            receipt.submissions.map(async (submission) => ({ submissionId: submission.id, ...(await validationEtaForSubmission(submission.id)) })),
          ),
        };
      } catch (err) {
        // submitPoolBatchItems throws a plain Error (not a domain error class)
        // for three known, deliberate conditions — pool inactive/missing, pool
        // already at its item target, and a file field in an item's payload
        // referencing an artifact that is not this caller's own unattached
        // upload for this pool (services/artifact-attach.ts). This repo's own
        // REST route (routes/v1/submissions.ts POST /bulk) catches ALL of
        // these the same way, unconditionally: `catch (err: any) { return
        // reply.badRequest(err.message); }`.
        //
        // Found during the Pass-3 MCP audit (2026-09-08): this tool had no
        // catch at all, so every one of these three outcomes was replaced by
        // safeMcpErrorMessage()'s generic "could not be completed... try
        // again in a moment" text — actively misleading for a permanently
        // closed or full pool, where retrying can never succeed. Matched to
        // the three known messages (rather than forwarding any Error, the way
        // the REST route does) so an unexpected internal failure still gets
        // the safe generic message instead of a raw stack surfaced to the
        // agent.
        if (
          err instanceof SubmissionItemLimitError ||
          (err instanceof Error &&
          (err.message === "Dataset pool is not active or does not exist" ||
            err.message === "This pool already reached its item target." ||
            err.message === INVALID_FILE_ARTIFACT_REFERENCE))
        ) {
          throw new McpToolError(err.message, 400);
        }
        throw err;
      }
    },
  },
  {
    name: "check_submission",
    description:
      "Read the recorded validation status, per-stage `validationResults`, `flags[]` and revision history for one of your submissions. This is the authority on where an item stands — do not poll it in a tight loop; read the status and act on it. " +
      "`needs_fixes`, `flagged` and `tests_failed` are DIFFERENT IN KIND from the in-progress states: the item is back with YOU and will sit there forever unless you act. Never report one of them as \"still being validated\". Read `flags[]` for the reason and the reviewer's note, and the failing entries in `validationResults`, before deciding what to do. " +
      "Fix the item with revise_submission when the work was actually wrong; use dispute_submission when the work was right and the decision was wrong. " +
      "`in_audit` means a human validator decision is pending. Treat `accepted` as final acceptance. A missing validation stage is not evidence of a pass; report only the recorded validation results and status.",
    scope: "read",
    schema: z.object({
      submissionId: z.string().describe("Submission id returned by submit_pool_items or list_my_submissions"),
    }),
    call: async ({ submissionId }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const sub = await getSubmissionById(submissionId);
      // Ownership, not just existence. `getSubmissionById` includes revisions,
      // flags and validation results, so without this any caller who could
      // guess an id read another contributor's work in full. Mirrors the REST
      // rule in routes/v1/submissions.ts (`GET /v1/submissions/:id`), which
      // also lets an admin through; the "not found" wording is deliberate so
      // this does not become an id-existence oracle.
      if (!sub || sub.contributorUserId !== context.userId) throw new McpToolError("Submission not found");
      return {
        ...sub,
        validation: await validationEtaForSubmission(sub.id),
      };
    },
  },
  {
    name: "revise_submission",
    description:
      "Fix a submission DataBounty sent back to you — one whose status is `needs_fixes`, `flagged` or `tests_failed`. Read its `flags[]` (reason plus reviewer note) and its failing `validationResults` from check_submission FIRST, so the correction addresses the recorded reason. " +
      "SEND THE COMPLETE CORRECTED ITEM, NOT A PATCH: `payloadJson` REPLACES the whole stored payload. Start from the existing payload and edit it; any field you omit is gone. " +
      "Self-review the corrected item against get_pool_contract before sending it. " +
      "A revision can be refused for four reasons: the submission is not yours or does not exist, its status is not revisable, the pool has closed, or the revision attempt budget is exhausted — and exhausting that budget terminally rejects the item, so do not spend attempts on guesses. " +
      "If the item was correct and the decision was wrong, use dispute_submission instead: a dispute does not consume a revision attempt. " +
      "A fixed item that is then accepted still earns the pool's per-item karma — returned items are the fastest karma already in hand.",
    scope: "contribute",
    schema: z.object({
      submissionId: z.string().describe("Submission id in a revisable state (needs_fixes, flagged or tests_failed)"),
      // Bounded to match this repo's own REST route (routes/v1/submissions.ts
      // `reviseBody`: `.trim().min(3).max(120).optional()`) — an MCP caller
      // could otherwise replace the title with an empty/whitespace-only or
      // unbounded string the dashboard's own revise route would refuse.
      title: z.string().trim().min(3).max(120).optional().describe("Replacement title. Omit to keep the stored one."),
      payloadJson: z
        .record(z.unknown())
        .describe("The COMPLETE corrected item payload. This REPLACES the stored payload wholesale — it is not merged, so include every field, not just the ones you changed."),
    }),
    call: async ({ submissionId, title, payloadJson }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      try {
        return await reviseSubmission({
          submissionId,
          contributorUserId: context.userId,
          title,
          payloadJson,
        });
      } catch (err) {
        // reviseSubmission throws a domain ReviseSubmissionError (not_found,
        // not_revisable, pool_closed, revision_cap_exceeded, concurrent_change)
        // carrying an actionable message. Left uncaught, safeMcpErrorMessage()
        // would replace it with the generic "could not be completed" string —
        // the same information loss that used to affect submit_decisions
        // before that tool got its own translation below. Status codes mirror
        // routes/v1/submissions.ts POST /:id/revise exactly (404 for
        // not_found, 409 for everything else).
        if (err instanceof ReviseSubmissionError) {
          throw new McpToolError(err.message, err.code === "not_found" ? 404 : 409, err.code);
        }
        throw err;
      }
    },
  },
  {
    name: "rerun_submission_validation",
    description:
      "Run the full automated validation pipeline again for one of your failed submissions without changing its payload or consuming a revision attempt. " +
      "Use this only when a machine result may have been transient; first call check_submission and confirm a failed automated stage. " +
      "This cannot rerun a validator decision: use revise_submission to correct the item or dispute_submission when the validator was wrong.",
    scope: "contribute",
    schema: z.object({
      submissionId: z.string().describe("Your submission id with a failed automated validation attempt"),
    }),
    call: async ({ submissionId }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      try {
        return await rerunSubmissionValidation({ submissionId, contributorUserId: context.userId });
      } catch (err) {
        if (err instanceof RerunValidationError) {
          throw new McpToolError(err.message, err.code === "not_found" ? 404 : 409, err.code);
        }
        throw err;
      }
    },
  },
  {
    name: "dispute_submission",
    description:
      "Challenge a review verdict on your own submission when the work was correct and the decision was wrong. Only a `flagged` or `rejected` submission can be disputed. " +
      "Explain your argument in detail — an admin arbitrates it and nothing is overturned automatically. Filing a dispute does not consume a revision attempt, and it moves the submission to `disputed`, so file it once with the full argument rather than in pieces. " +
      "When the work really was wrong, use revise_submission instead.",
    scope: "contribute",
    schema: z.object({
      submissionId: z.string().describe("Id of a flagged or rejected submission of yours"),
      // Was missing the upper bound this repo's OWN REST route enforces
      // (routes/v1/submissions.ts POST /:id/dispute: `.trim().min(10).max(2000)`)
      // — an MCP caller could send an unbounded argument the dashboard's own
      // route would reject. Matched to that route, not invented.
      argument: z
        .string()
        .trim()
        .min(10)
        .max(2000)
        .describe("Why the verdict is wrong, in detail (10–2000 characters). An admin reads this; a one-line assertion gives them nothing to act on."),
    }),
    call: async ({ submissionId, argument }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      // Shared with `POST /v1/submissions/:id/dispute` via
      // services/disputes.ts. This tool used to have its own copy with NO
      // state gate, so an agent could dispute a `submitted`, `in_audit` or
      // already-`accepted` item; with no open flag it wrote the literal
      // "Flagged during review" as the validator's argument, asserting a
      // review that never happened; and it neither flipped the submission to
      // `disputed` nor emitted any of the three notifications REST emits.
      const result = await fileSubmissionDispute({
        submissionId,
        contributorUserId: context.userId,
        contributorArgument: argument,
      });
      if (!result.ok) {
        // Same "not found" wording for a missing row and someone else's row,
        // so this does not become an id-existence oracle.
        if (result.reason === "not_found") throw new McpToolError("Submission not found");
        throw new McpToolError(
          `Only a flagged or rejected submission can be disputed; this one is '${result.status}'.`,
          400
        );
      }
      return result.dispute;
    },
  },
  {
    name: "create_upload_review_link",
    description:
      "Create a one-time browser link for a many-item contribution. Open (or have the operator open) the returned `handoffUrl` — never make them copy a raw token. " +
      "It accepts NO file bytes and creates NO submissions itself: the person who opens the link chooses a source file, reviews the parsed rows, and submits from there. " +
      "Declare `generationMethod` honestly for the whole upload; it defaults to `human` when omitted, matching every other submission path here — never assume AI assistance. " +
      "Pass `sourceArtifactId` only if you already uploaded the source file yourself via prepare_file_upload/complete_file_upload; otherwise omit it and the browser attaches one. " +
      "This is NOT the path for a single file attached to work you are already doing — use prepare_file_upload for that.",
    scope: "contribute",
    schema: z.object({
      bountyId: z.string().describe("Community pool bounty id this upload contributes to"),
      sourceArtifactId: z
        .string()
        .optional()
        .describe("Only if you already uploaded the source file yourself. Omit to let the browser attach one."),
      generationMethod: z
        .nativeEnum(GenerationMethod)
        .optional()
        .describe("How the WHOLE upload was produced. Declare honestly; defaults to human when omitted."),
      // Both bounds match this repo's OWN REST route
      // (routes/v1/upload-review-drafts.ts: `expectedItemCount: z.number().int().positive().optional()`,
      // `sourceDescription: z.string().trim().max(500).optional()`), which the
      // service this tool calls is shared with — an MCP caller could send a
      // negative/fractional count or an unbounded description the dashboard's
      // own route would reject.
      expectedItemCount: z.number().int().positive().optional().describe("Display estimate only."),
      sourceDescription: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("Short, relevant description of the source (max 500 characters). Never include source records, secrets, or credentials."),
    }),
    call: async ({ bountyId, sourceArtifactId, generationMethod, expectedItemCount, sourceDescription }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      // Was inlining its own `prisma.submissionUploadDraft.create`, which
      // skipped the REST route's bounty/artifact checks entirely, wrote a
      // status ("ready") no other code path recognises, and hardcoded
      // `generationMethod: "ai_assisted"` on every draft regardless of who
      // actually did the work. Now calls the SAME service the route calls, so
      // an MCP-created draft and a browser-created draft are indistinguishable.
      try {
        return await createUploadReviewDraft({
          ownerUserId: context.userId,
          bountyId,
          sourceArtifactId,
          generationMethod,
          expectedItemCount,
          sourceDescription,
        });
      } catch (err) {
        if (err instanceof UploadReviewDraftError) throw new McpToolError(err.message, err.status);
        throw err;
      }
    },
  },
  {
    name: "get_upload_review_status",
    description:
      "Check what happened to a browser upload-review link you handed off with create_upload_review_link. " +
      "The browser side of that flow is fire-and-forget from your point of view — the person may still be reviewing, may have closed the tab without finishing, may have cancelled, or may have submitted — and this is the only way to find out. " +
      "`status` is one of: awaiting_upload (link opened or not yet, no file chosen), uploading/parsing (file attached, being checked), review_ready (parsed rows waiting on their decision), submitting (rows being added), submitted (done — check `previewSummary.submittedRows`), cancelled (they backed out, nothing was submitted), failed (the source could not be turned into rows — see `previewSummary.error`). " +
      "A draft that sits in awaiting_upload/uploading/parsing/review_ready/submitting past its `draftExpiresAt` has been abandoned — most likely the tab was closed — and can no longer be acted on by anyone; start a fresh draft instead of waiting on it further.",
    scope: "contribute",
    schema: z.object({
      draftId: z.string().describe("The draftId returned by create_upload_review_link."),
    }),
    call: async ({ draftId }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const status = await getUploadReviewDraftStatusForOwner(context.userId, draftId);
      if (!status) throw new McpToolError("No such upload review draft.", 404);
      return status;
    },
  },
  {
    name: "get_file_upload_limits",
    description:
      "Read the server's live upload limits before choosing how to send a file. Use prepare_file_upload only when sizeBytes is below multipartThresholdBytes and no larger than maxUploadBytes. Use prepare_large_file_upload when sizeBytes is at or above multipartThresholdBytes and no larger than maxMultipartUploadBytes, splitting every non-final part to exactly multipartPartSizeBytes. Both are admin/deployment-configurable via STORAGE_* env vars, so read them rather than assuming the defaults. " +
      "Also returns the item-COUNT limits for submit_pool_items: bulkThresholdItems is the count above which an inline submit is the wrong tool (hand off to create_upload_review_link instead), and maxItemsPerRequest is the hard reject cap for one inline call — on a community pool the two are the same number. get_pool_contract's submitLimits reports the identical pair for one specific pool.",
    scope: "public",
    schema: z.object({}),
    call: async () => ({
      maxUploadBytes: config.storage.maxUploadBytes,
      multipartThresholdBytes: config.storage.multipartThresholdBytes,
      multipartPartSizeBytes: config.storage.multipartPartSizeBytes,
      maxMultipartUploadBytes: config.storage.maxMultipartUploadBytes,
      allowedMimeTypes: ["application/json", "application/jsonl", "text/csv", "application/zip", "text/plain"],
      // v1 returns BOTH the byte limits above and these two item-count limits
      // from this same tool (databounty-api/src/mcp/tools.ts
      // get_file_upload_limits) — this port returned only the byte limits, so
      // an agent had no way to learn bulkThresholdItems/maxItemsPerRequest
      // without first calling get_pool_contract for a specific pool. Same
      // constants submit_pool_items' own schema bound is built from
      // (mcp/core/limits.ts) and get_pool_contract's submitLimits already
      // advertises per-pool, so all three can never disagree.
      ...(await getPoolSubmitLimits()),
    }),
  },
  {
    name: "prepare_file_upload",
    description:
      "Prepare a secure single-request file upload. Call get_file_upload_limits first and use this tool only when sizeBytes is below multipartThresholdBytes and no larger than maxUploadBytes. You receive a short-lived upload target for one exact file: execute it exactly as returned with your MCP host/client — either a set of form fields or a set of headers to send with the file bytes. Then call complete_file_upload so DataBounty can verify and scan it. At or above multipartThresholdBytes, use prepare_large_file_upload instead.",
    scope: "artifact",
    schema: z.object({
      filename: z.string(),
      contentType: z.string(),
      kind: z.enum(MCP_UPLOAD_KINDS).default(ArtifactKind.submission_attachment).describe("Why the file is being uploaded."),
      sizeBytes: z.number().int().positive().optional().describe("Exact file size in bytes. Required when the active storage driver supports direct upload — see the error if omitted and needed."),
      checksumSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional()
        .describe("SHA-256 hash of the exact bytes, as 64 hex characters. Required when the active storage driver supports direct upload."),
      // v1 accepts all three targets here. Only `bountyId` survived the port,
      // so an attachment for an EXISTING submission, or for a claimed
      // contributor batch, had no way to say what it belonged to — and
      // `createUploadSlot` refuses a `submission_attachment` that names none
      // of the three.
      bountyId: z.string().optional().describe("Open community pool this attachment belongs to."),
      submissionId: z.string().optional().describe("Existing submission this attachment belongs to."),
      contributorBatchId: z.string().optional().describe("Your claimed contributor batch, for an attachment uploaded before its submission exists."),
    }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      try {
        const slot = withAbsoluteUploadUrl(
          await createUploadSlot({
            ownerUserId: context.userId,
            kind: args.kind,
            filename: args.filename,
            contentType: args.contentType,
            declaredSizeBytes: args.sizeBytes,
            checksumSha256: args.checksumSha256,
            bountyId: args.bountyId,
            submissionId: args.submissionId,
            contributorBatchId: args.contributorBatchId,
          })
        );
        // `fileId` alongside `artifactId`: the id parameter every later file
        // tool takes is called `fileId` (see `fileIdShape`), so returning only
        // `artifactId` here made the round trip inconsistent with itself.
        return { ...slot, fileId: slot.artifactId };
      } catch (err) {
        if (err instanceof ArtifactUploadValidationError) throw new McpToolError(err.message, 400);
        throw err;
      }
    },
  },
  {
    name: "complete_file_upload",
    description:
      "Tell DataBounty the file upload is finished. The platform verifies the bytes and starts its security scan; poll get_file_status until it is ready or quarantined.",
    scope: "artifact",
    schema: z.object({ ...fileIdShape }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const id = requireFileId(args);
      try {
        const artifact = withoutBigInt(await completeUpload(id, context.userId));
        return { ...artifact, fileId: artifact.id };
      } catch (err) {
        // completeUpload throws ArtifactUploadValidationError for slot-state
        // failures (SLOT_NOT_OPEN, SLOT_EXPIRED — no explicit .status, so
        // fall back to 409 exactly as this repo's own REST route's
        // sendUploadValidationError() does for any "SLOT_" prefixed code;
        // ARTIFACT_BYTES_MISSING, ARTIFACT_SIZE_MISMATCH,
        // ARTIFACT_CHECKSUM_MISMATCH, ARTIFACT_CONTENT_TYPE_MISMATCH all carry
        // their own explicit 409) and a plain Error for ownership/not-found
        // ("Artifact not found or access denied"), which that same REST route
        // forwards as a 400 (`return reply.badRequest(err.message)`).
        //
        // Found during the Pass-3 MCP audit (2026-09-08): this tool had NO
        // catch at all, so every one of these outcomes — including "you don't
        // own this slot" and "the bytes never arrived" — was replaced by
        // safeMcpErrorMessage()'s generic "could not be completed" text
        // instead of the specific, actionable reason REST already gives.
        if (err instanceof ArtifactUploadValidationError) {
          throw new McpToolError(err.message, err.status ?? (err.code.startsWith("SLOT_") ? 409 : 400), err.code);
        }
        if (err instanceof Error && err.message === "Artifact not found or access denied") {
          throw new McpToolError(err.message, 400);
        }
        throw err;
      }
    },
  },
  {
    name: "prepare_large_file_upload",
    description:
      "Prepare a large file for upload in PARTS, in parallel and resumably — real chunked multipart, backed by the active storage driver's multipart capability. Call get_file_upload_limits first; use this tool when totalSizeBytes is at or above multipartThresholdBytes and no larger than maxMultipartUploadBytes. " +
      "Split the file into parts of ONE fixed size — every part except the last must be exactly multipartPartSizeBytes; the last part is whatever remains. Compute the SHA-256 of each part and declare them here. You receive one short-lived signed PUT target per part, each already bound to that part's checksum. " +
      "Execute every part PUT with your MCP host/client exactly as returned, capture each response's ETag header, then call complete_large_file_upload with the part-number-to-ETag list. This tool never accepts file bytes itself. " +
      "If the active storage driver has no multipart capability (e.g. local disk in dev), this returns an error — fall back to prepare_file_upload instead.",
    scope: "artifact",
    schema: z.object({
      // Was HARD-CODED to `bulk_submission_source` — the one kind v1
      // deliberately withholds from MCP (see MCP_UPLOAD_KINDS). Same
      // allowlist and same default as prepare_file_upload.
      kind: z.enum(MCP_UPLOAD_KINDS).default(ArtifactKind.submission_attachment).describe("Why the file is being uploaded."),
      filename: z.string(),
      contentType: z.string(),
      totalSizeBytes: z.number().int().positive().describe("Exact size of the whole file in bytes"),
      parts: z
        .array(
          z.object({
            partNumber: z.number().int().min(1).max(10000).describe("1-based, consecutive"),
            sizeBytes: z.number().int().positive().describe("Exact byte size of this part; every part but the last must equal the platform part size (get_file_upload_limits.multipartPartSizeBytes)"),
            checksumSha256Hex: z.string().regex(/^[a-f0-9]{64}$/i).describe("SHA-256 of this part's bytes, 64 hex chars"),
          })
        )
        .min(1)
        .max(10000)
        .describe("The full part manifest, in order"),
      bountyId: z.string().optional().describe("Open community pool this attachment belongs to."),
      submissionId: z.string().optional().describe("Existing submission this attachment belongs to."),
      contributorBatchId: z.string().optional().describe("Your claimed contributor batch, for an attachment uploaded before its submission exists."),
    }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      try {
        const { artifactId, multipart } = await createMultipartUpload({
          ownerUserId: context.userId,
          kind: args.kind,
          filename: args.filename,
          contentType: args.contentType,
          totalSizeBytes: args.totalSizeBytes,
          parts: args.parts,
          bountyId: args.bountyId,
          submissionId: args.submissionId,
          contributorBatchId: args.contributorBatchId,
        });
        // Multipart part targets are only ever issued by a real object-store
        // driver (S3) — never the local-disk fallback (createMultipartUpload
        // throws MULTIPART_UPLOAD_UNSUPPORTED before reaching this line
        // otherwise) — so every URL here is already absolute; unlike
        // prepare_file_upload, there is no relative path to fix up.
        return { artifactId, fileId: artifactId, upload: multipart };
      } catch (err) {
        if (err instanceof ArtifactUploadValidationError) throw new McpToolError(err.message, err.code === "MULTIPART_UPLOAD_UNSUPPORTED" ? 409 : 400);
        throw err;
      }
    },
  },
  {
    name: "complete_large_file_upload",
    description:
      "Finish a multipart (large file) upload started with prepare_large_file_upload. Provide every part's number and the ETag response header returned when you PUT it; DataBounty assembles the file, verifies its size, and starts the security scan. Poll get_file_status until ready or quarantined.",
    scope: "artifact",
    schema: z.object({
      ...fileIdShape,
      parts: z
        .array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1) }))
        .min(1)
        .max(10000),
    }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const id = requireFileId(args);
      try {
        const artifact = withoutBigInt(await completeMultipartUpload(id, context.userId, args.parts));
        return { ...artifact, fileId: artifact.id };
      } catch (err) {
        if (err instanceof ArtifactUploadValidationError) throw new McpToolError(err.message, err.code === "NOT_FOUND" ? 404 : 400);
        throw err;
      }
    },
  },
  {
    name: "abort_large_file_upload",
    description: "Cancel an in-flight multipart (large file) upload started with prepare_large_file_upload — releases the reserved parts so they stop incurring storage cost.",
    scope: "artifact",
    schema: z.object({ ...fileIdShape }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const id = requireFileId(args);
      try {
        await abortMultipartUpload(id, context.userId);
        return { ok: true };
      } catch (err) {
        if (err instanceof ArtifactUploadValidationError) throw new McpToolError(err.message, 404);
        throw err;
      }
    },
  },
  {
    name: "get_file_status",
    description:
      "Check whether an uploaded file is still transferring, being scanned, ready to use, or quarantined. " +
      "DO NOT POLL THIS IN A LOOP: the response carries an `ingest` block with recheckAfterSeconds and estimatedReadyAt, derived from how many jobs are queued ahead of this one and the measured duration of recent runs — wait that long, then check once. A null recheckAfterSeconds means nothing is queued and you should stop. `basis` says how the estimate was reached: \"measured\" from real runs, \"no_samples\" when nothing of this kind has finished yet (a provisional floor, not a deadline), \"settled\" when the work is done, \"not_queued\" when no job exists. " +
      "While the scan is running the response may carry `scanProgress` (attempts, maxAttempts, nextAttemptAt, blocked, message): it distinguishes \"queued, not run yet\" from \"failing and retrying\", and blocked:true means an operator has to intervene — tell the user instead of polling on. " +
      "For a bulk-source file, `ingest` also reports rowCount (lines read), created (items made) and skipped (lines read but unusable). \"done\" with skipped > 0 is a PARTIAL ingest: report the difference rather than treating it as a clean upload. " +
      "IMPORTANT: status \"ready\" means only that the bytes arrived and the malware/file-signature scan cleared — it does NOT mean the modality checks (parsing, preview, similarity) have run or passed. Call get_file_processing_checks for that.",
    scope: "read",
    schema: z.object({ ...fileIdShape }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const art = await getArtifactById(requireFileId(args));
      // Ownership, not just existence — the artifact row carries the storage
      // key, filename and scan verdict for somebody else's upload.
      if (!art || art.ownerUserId !== context.userId) throw new McpToolError("Artifact not found");
      // v1 returns an `ingest` block and `scanProgress` alongside the row;
      // this port returned the bare row, so an agent had nothing to pace its
      // polling with and could not see a partial bulk ingest at all. Both
      // blocks are derived from real persisted state (Artifact.bulkParse*,
      // JobQueue) — see mcp/core/file-status.ts — and are null, with a stated
      // basis, wherever the fact is genuinely not recorded.
      const [ingest, scanProgress] = await Promise.all([ingestBlockFor(art), scanProgressFor(art.id)]);
      return { ...withoutBigInt(art), fileId: art.id, ingest, scanProgress };
    },
  },
  {
    name: "get_file_processing_checks",
    description:
      "Read the per-modality check results for an uploaded file: parsing, preview generation, and similarity/near-duplicate detection. " +
      "Each stage reports one of: passed, failed, not_supported (no checker exists for this file type yet), stale (the checker was upgraded since this ran, so the result no longer reflects current logic), pending (queued, not run yet), or missing (never ran). " +
      "Treat anything other than \"passed\" as NOT verified — in particular, \"not_supported\" and \"stale\" are not passes. Use this before claiming a file has been validated.",
    scope: "read",
    schema: z.object({ ...fileIdShape }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const art = await getArtifactById(requireFileId(args));
      if (!art || art.ownerUserId !== context.userId) throw new McpToolError("Artifact not found");
      // Was three scalars (scanStatus/modality/parserVersion), which cannot
      // express the difference between a stage that PASSED, one that has no
      // checker, one whose checker has since been upgraded, and one that
      // never ran — so an agent reading it could report a file as checked
      // when nothing had checked it. Per-stage, six honest states, as v1.
      return {
        fileId: art.id,
        artifactId: art.id,
        scanStatus: art.scanStatus,
        modality: art.modality,
        parserVersion: art.parserVersion,
        stages: await processingChecksFor(art),
      };
    },
  },
  {
    name: "list_files",
    description:
      "List artifacts owned by the authenticated account, newest first. Narrow with `kind`, with `bountyId` " +
      "(the files attached to one pool), or with `plannerSessionId` (a resumed draft's own reference samples). " + PAGING,
    scope: "artifact",
    schema: z.object({
      kind: z.nativeEnum(ArtifactKind).optional(),
      // v1 exposes this (`list_files` bountyId -> GET /artifacts?bountyId=) and
      // the port dropped it, so an agent holding a pool id had to page the
      // whole account to find that pool's files. Restored. It only ever
      // narrows: the query stays scoped to the caller inside listUserArtifacts.
      bountyId: z.string().optional().describe("Only files attached to this pool/bounty."),
      // REST's own `GET /v1/artifacts` (routes/v1/artifacts.ts) has always
      // accepted this and `listUserArtifacts` has always taken it — only this
      // tool's schema never exposed it, so an agent resuming a sponsor's
      // planner draft (which references reference-sample artifacts before any
      // bounty exists to hold a bountyId) had no narrowing filter at all and
      // had to page the whole account. It only ever narrows, same as
      // `bountyId`: the query stays scoped to the caller regardless.
      plannerSessionId: z.string().optional().describe("Only files attached to one planner draft session (before it became a pool)."),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous call's nextCursor."),
      offset: z.number().int().min(0).optional().describe("Legacy, non-stable paging. Prefer cursor."),
    }),
    call: async ({ kind, bountyId, plannerSessionId, limit, cursor, offset }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      return withoutBigInt(
        await withCursorErrors(() =>
          listUserArtifacts(context.userId!, kind, { bountyId, plannerSessionId, limit, cursor, offset }),
        ),
      );
    },
  },
  {
    name: "delete_file",
    description: "Delete an artifact owned by the authenticated account.",
    scope: "artifact",
    schema: z.object({ ...fileIdShape }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const id = requireFileId(args);
      // Delegates to the SAME function the REST route uses. This was a bare
      // `updateMany({ data: { status: "deleted" } })` on ownership alone, and
      // it diverged from that route in two ways that both mattered: it never
      // stamped `deletedAt` (the sample-gate readers filter on that column, so
      // a deleted sample still counted toward the gate and still published),
      // and it applied none of the freeze gates, so it could remove a sample
      // from an `approved` or minted request that REST refuses with 409 —
      // the same operation allowed or denied purely by transport.
      //
      // Also note the previous `updateMany` reported `{ok: true}` even when it
      // matched zero rows, so a wrong id or another account's artifact looked
      // like a success.
      // `isStaff: false`, unconditionally and on purpose. The MCP context
      // carries only `{ userId, credentialKind }` — there is no role on this
      // surface at all — so an MCP caller is never treated as staff. That is
      // also the right answer rather than a limitation: staff removal of
      // another account's artifact belongs to `admin-artifacts.ts`, where it
      // is audited as an operator action, not to an API-key transport.
      try {
        await softDeleteArtifact({ artifactId: id, actorUserId: context.userId, isStaff: false });
      } catch (error) {
        if (error instanceof ArtifactUploadValidationError) {
          throw new McpToolError(error.message, error.status ?? 400);
        }
        throw error;
      }
      return { ok: true };
    },
  },
  {
    name: "list_audits",
    description:
      "List available community audit windows open for your review. `karmaReward` is the karma paid PER ITEM you decide, not a flat amount for the window — read it together with `itemCount`. Do not describe it as earned until the window is completed. " +
      "The server excludes a window containing your own submission, so you may review another member's window even in a pool you sponsored or also contributed to. `conflictExcluded` is how many were withheld for that reason and `total` is the whole filtered queue. " +
      PAGING,
    scope: "validate",
    // `listAvailableAudits` has always accepted limit/offset/categories/
    // languages/search — the web validator workspace uses all of them. Only
    // `bountyId` was exposed here, so an agent could see `total: 64`, receive
    // the default 20, and have no way to ask for the rest or to narrow the
    // list. Same capability as the UI, same server-side bounds.
    schema: z.object({
      bountyId: z.string().optional(),
      // v1's top-level queue axis (`list_audits` `domains`). This port dropped
      // it for the narrower `bountyId`, so "what legal work is there?" — the
      // question an operator actually asks first — had no filter at all.
      domains: z
        .array(z.string())
        .optional()
        .describe("Dataset-type domains, e.g. coding, legal, healthcare, finance, science."),
      categories: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous call's nextCursor."),
      offset: z.number().int().min(0).optional().describe("Legacy, non-stable paging. Prefer cursor."),
    }),
    call: async ({ bountyId, domains, categories, languages, search, limit, cursor, offset }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      return withCursorErrors(() =>
        listAvailableAudits({
          validatorUserId: context.userId!,
          bountyId, domains, categories, languages, search, limit, cursor, offset,
        }),
      );
    },
  },
  {
    name: "get_audit",
    description:
      "Read the items, submitted content and available evidence in an audit window so you can make a careful decision on each one. " +
      "YOU MUST HOLD THE CLAIM FIRST — call claim_audit before this; an unclaimed window returns a 409 rather than evidence. " +
      "It refuses a window containing your own submitted item; sponsoring or contributing elsewhere in the pool does not block an independent review.",
    scope: "validate",
    schema: z.object({ ...auditWindowIdShape }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const windowId = requireWindowId(args);
      // Claim-gated, exactly as GET /v1/audits/:id is. Calling
      // `getAuditWindowById` directly returned the full evidence bundle —
      // raw item payloads, contributor identities, dedupe/LLM scores,
      // attachments and validation logs — for ANY unsuperseded window that
      // did not contain the caller's own submission. Any `validate`-scoped
      // credential could enumerate window ids with `list_audits` and read
      // every sampled contributor's work across pools it had never claimed:
      // a dataset-content leak and a collusion channel between validators.
      const result = await getClaimedAuditWindowDetail(windowId, context.userId);
      if (result.reason === "not_found") throw new McpToolError("Audit window not found");
      if (result.reason === "forbidden") {
        throw new McpToolError("You cannot view an audit window that conflicts with your own submissions.", 403);
      }
      if (result.reason === "unclaimed") {
        throw new McpToolError("Claim this audit with claim_audit before viewing submission evidence.", 409);
      }
      if (result.reason === "claimed_by_other") {
        throw new McpToolError("This audit is claimed by another validator.", 403);
      }
      return result.detail;
    },
  },
  {
    // Real exclusive claim (T1): this reserves the HumanAuditWindow for the
    // caller for 24h (services/audits.ts claimAuditWindow, mirrors
    // POST /v1/audits/:id/claim). Nobody else can claim or decide it until
    // it either settles or the 24h SLA lapses and the reaper releases it.
    // submit_decisions now requires having claimed first — call this tool
    // before it.
    name: "claim_audit",
    description:
      "Exclusively claim an available community audit window for 24 hours so you can review and decide it. " +
      "While held, no other validator can claim or decide this window. Required before calling submit_decisions " +
      "on it. Returns 409-equivalent if the window is already claimed by someone else (or has nothing left to " +
      "decide), 403-equivalent if the window contains your own submission, " +
      "404-equivalent if the window does not exist. Re-claiming a window you already hold is idempotent and " +
      "returns your existing claim unchanged. " +
      "How many audits you may hold claimed at once is capped by your validator rank: when you are at the cap the " +
      "refusal says so and names both the limit and how many you are already holding — complete or let one lapse " +
      "before claiming another, rather than retrying.",
    scope: "validate",
    schema: z.object({ ...auditWindowIdShape }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const windowId = requireWindowId(args);
      const result = await claimAuditWindow({ windowId, validatorUserId: context.userId });
      if (!result.ok) {
        if (result.reason === "not_found") throw new McpToolError("Audit window not found", 404);
        if (result.reason === "forbidden") {
          throw new McpToolError("You cannot claim an audit window that conflicts with your own submissions", 403);
        }
        // A rank-capacity refusal is NOT a conflict: it is about the caller's
        // own holdings and has a different fix. It used to fall through to the
        // conflict bucket below, so a validator at their cap was told the
        // window "was already claimed by another validator" — wrong, and it
        // sent them looking for a different window that would refuse too.
        if (result.reason === "capacity") {
          throw new McpToolError(
            `You are already holding ${result.activeCount} claimed audit windows, which is the maximum for your validator rank ` +
              `(${result.maxConcurrentAudits}). Complete or release one before claiming another.`,
            409
          );
        }
        // Mirrors REST's single `conflict` (409) bucket for both
        // already-claimed-by-someone-else and settled/nothing-left-to-decide
        // (routes/v1/audits.ts POST /:id/claim) — see claimAuditWindow's
        // `reason: "conflict"` cases.
        throw new McpToolError("Audit window was already claimed by another validator, or has nothing left to claim", 409);
      }
      return {
        ok: true,
        window: {
          id: result.window.id,
          bountyId: result.window.bountyId,
          bountyTitle: result.window.bountyTitle,
          claimedByUserId: result.window.claimedByUserId,
          claimedAt: result.window.claimedAt.toISOString(),
          claimExpiresAt: result.window.claimExpiresAt.toISOString(),
          itemCount: result.window.itemCount,
          karmaReward: result.window.karmaReward,
        },
      };
    },
  },
  {
    name: "submit_decisions",
    description:
      "Submit validator decisions on the items of an audit window you have claimed via claim_audit. " +
      `A REJECTING (\`flagged\`) DECISION IS REFUSED unless its \`note\` is at least ${MIN_FLAG_NOTE_LENGTH} real characters explaining what is wrong. ` +
      "The contributor sees that note as the ONLY explanation for why their work came back, so write it for them. " +
      "If you do not have a specific reason from the operator, ASK for one rather than retrying, padding the note, or restating the reason code. An approving decision needs no note. " +
      "Deciding is not the same as releasing: your own per-decision karma is credited when the window completes, while the contributor's karma for an approved item may be held until its dispute window closes. " +
      "After the response, read the returned remaining-item state or call list_my_audits to tell the operator what is left, then offer the next eligible window.",
    scope: "validate",
    schema: z.object({
      ...auditWindowIdShape,
      decisions: z
        .array(
          z
            .object({
              // v1 accepts EITHER auditItemId or submissionId per decision
              // (databounty-api/src/routes/v1/audits.ts POST /:id/decisions
              // resolves through a `bySubmission` map alongside the `items`
              // map keyed by id) — a real, functioning alias, not dead code.
              // This port required auditItemId only. get_audit's items always
              // carry both ids together, so submissionId is a genuine but
              // secondary path; kept optional (with a runtime translation
              // below) rather than required, matching v1.
              auditItemId: z.string().optional().describe("Item id from get_audit on this window. Alternatively pass submissionId."),
              submissionId: z.string().optional().describe("Submission id from get_audit's items, as an alternative to auditItemId (matches v1)."),
              verdict: z.nativeEnum(AuditVerdict).describe("Your decision for this one item"),
              flagReason: z.nativeEnum(FlagReason).optional().describe("Required category for a rejecting verdict"),
              note: z
                .string()
                .optional()
                .describe(
                  `Why the item is wrong, in the contributor's language. REQUIRED and at least ${MIN_FLAG_NOTE_LENGTH} characters for a flagged verdict; unnecessary for an approving one.`
                ),
            })
            // Mirrored from services/audits.ts so the agent is told the rule by
            // the schema BEFORE spending the call, instead of learning it from
            // a server refusal halfway through a batch of decisions.
            .refine(
              (d) => d.verdict !== AuditVerdict.flagged || (d.note?.trim().length ?? 0) >= MIN_FLAG_NOTE_LENGTH,
              {
                path: ["note"],
                message: `A flagged decision needs a note of at least ${MIN_FLAG_NOTE_LENGTH} characters explaining what is wrong — the contributor sees it as the only explanation.`,
              }
            )
            .refine((d) => Boolean(d.auditItemId || d.submissionId), {
              path: ["auditItemId"],
              message: "Each decision needs auditItemId or submissionId.",
            })
        )
        .min(1)
        .describe("One entry per item you are deciding in this window"),
    }),
    call: async (args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const windowId = requireWindowId(args);
      // Translate a submissionId-only decision into the canonical membership
      // id `submitAuditDecisions` requires, scoped to THIS window via the
      // model's own `@@unique([windowId, submissionId])` — so a submissionId
      // can never resolve against a different window's membership.
      type DecisionInput = { auditItemId?: string; submissionId?: string; verdict: AuditVerdict; flagReason?: FlagReason; note?: string };
      const decisionInputs = args.decisions as DecisionInput[];
      const bySubmissionId = decisionInputs.filter((d) => !d.auditItemId && d.submissionId);
      const resolvedIds = bySubmissionId.length
        ? new Map(
            (
              await prisma.humanAuditWindowMembership.findMany({
                where: { windowId, submissionId: { in: bySubmissionId.map((d) => d.submissionId!) } },
                select: { id: true, submissionId: true },
              })
            ).map((m) => [m.submissionId, m.id]),
          )
        : new Map<string, string>();
      const decisions = decisionInputs.map((d) => {
        if (d.auditItemId) return { ...d, auditItemId: d.auditItemId };
        const resolved = resolvedIds.get(d.submissionId!);
        if (!resolved) {
          throw new McpToolError(`submissionId ${d.submissionId} is not part of this audit window`, 400);
        }
        return { ...d, auditItemId: resolved };
      });
      try {
        return await submitAuditDecisions({
          windowId,
          validatorUserId: context.userId,
          decisions,
        });
      } catch (err) {
        // submitAuditDecisions now requires the caller to hold the window's
        // claim (T1, services/audits.ts) — surface that as a clear, actionable
        // MCP error rather than the generic sanitized message
        // safeMcpErrorMessage() would otherwise give an un-narrowed Error.
        // Status codes mirror routes/v1/audits.ts POST /:id/decisions exactly.
        if (err instanceof AuditWindowNotClaimedError) {
          throw new McpToolError("Claim this audit window with claim_audit before submitting decisions.", 409);
        }
        if (err instanceof AuditWindowClaimedByOtherError) {
          throw new McpToolError("This audit window is claimed by another validator.", 403);
        }
        // Without this the server's flag-note refusal reached the agent as the
        // generic sanitized message, so a validator could not tell a missing
        // note from any other failure.
        if (err instanceof AuditFlagNoteRequiredError) {
          throw new McpToolError(err.message, 400);
        }
        // The remaining typed conditions submitAuditDecisions can throw were
        // previously left to fall through to `throw err` below, which
        // safeMcpErrorMessage() (core/errors.ts) then replaces with its
        // generic "could not be completed" text for ANY non-McpToolError —
        // including these deliberate, actionable ones. An operator deciding
        // an already-decided item, their own submission, a foreign item id,
        // or a settled/superseded window got the same unhelpful message as a
        // genuine server failure, with no way to tell them apart. Status
        // codes mirror routes/v1/audits.ts POST /:id/decisions exactly.
        if (err instanceof AuditWindowNotFoundError) throw new McpToolError(err.message, 404);
        if (err instanceof AuditWindowSettledError) throw new McpToolError(err.message, 409);
        if (err instanceof AuditWindowSupersededError) throw new McpToolError(err.message, 409);
        if (err instanceof AuditItemNotInWindowError) throw new McpToolError(err.message, 400);
        if (err instanceof AuditOwnSubmissionError) throw new McpToolError(err.message, 403);
        if (err instanceof AuditItemAlreadyDecidedError) throw new McpToolError(err.message, 409);
        // Anything else is a genuinely unexpected failure (a raw Prisma/db
        // error, a timeout, an unrelated bug) — deliberately left as a bare
        // Error so safeMcpErrorMessage() replaces it with its generic,
        // non-disclosing fallback rather than handing the agent an internal
        // exception message.
        throw err;
      }
    },
  },
  {
    name: "whoami",
    description:
      "START EVERY CONVERSATION HERE. Returns who the credential belongs to and, critically, the account's SETUP STATE — so advice reflects the real account instead of an assumption. " +
      "`onboarded` and `handle` tell you whether account setup is finished: while `onboarded` is false or `handle` is null, every work tool refuses with a 428, so raise it proactively instead of letting the operator walk into that wall. `emailVerified` false blocks a further set of tools with a 403 — resend_email_verification is the recovery. " +
      "`ranks.contributor` and `ranks.validator` carry the current rank, the counts behind it, `nextRank` (what is left to reach the next one) and the concurrency caps that govern how much work can be held at once. `activity.activeAudits` is the LIVE count against that cap — compare it to `ranks.validator.maxConcurrentAudits` to know whether the operator can claim another audit right now. " +
      "`submissions` is the lifetime funnel. `submissions.needsAttention` is items that came BACK to the operator and are waiting on them — it is NOT part of `inReview`, and it is the first thing to raise. " +
      "`badges` is the operator's own earned badges (id/key/family/label/earnedAt); the full catalog, including badges not yet earned, is on get_karma_details. " +
      "Participation modes are activities, not roles: one verified account can contribute, validate and sponsor, and there is nothing to enable or request first. Every call is still constrained by its credential scope.",
    scope: "read",
    schema: z.object({}),
    call: async (_args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const user = await prisma.user.findUnique({
        where: { id: context.userId },
        // `onboarded` and `emailVerifiedAt` were NOT selected, so the two
        // states that gate nearly every mutating tool (428 onboarding, 403
        // unverified email) were invisible to the one tool the instructions
        // tell every agent to call first. The agent could only discover them
        // by failing a real call, which is exactly what they are meant to
        // prevent.
        select: {
          id: true,
          displayName: true,
          email: true,
          handle: true,
          karmaTotal: true,
          leaderboardRank: true,
          onboarded: true,
          emailVerifiedAt: true,
        },
      });
      if (!user) throw new McpToolError("User not found");
      const { emailVerifiedAt, ...rest } = user;
      // Ranks, next-rank progress, concurrency caps and the submission funnel
      // all already exist in getProfileSummary — the same source the dashboard
      // reads. Reusing it keeps MCP and browser answers from diverging.
      const [summary, activeAudits] = await Promise.all([
        getProfileSummary(context.userId).catch(() => null),
        // v1's whoami returns `activity: {activeBatches, activeAudits}`
        // (databounty-api/src/routes/v1/me.ts) — the live count of work
        // currently held, alongside the CAP already surfaced in
        // `ranks.validator.maxConcurrentAudits`. This port had the cap but
        // never the live count, so an agent could not tell "at the limit" from
        // "nowhere near it" without a separate list_my_audits call.
        // `activeBatches` has no Community equivalent (no claim step / no
        // ContributorBatch model here) and is correctly omitted, not zeroed.
        prisma.humanAuditWindow.count({ where: { claimedByUserId: context.userId, settledAt: null } }),
      ]);
      return {
        ...rest,
        emailVerified: Boolean(emailVerifiedAt),
        ranks: summary?.ranks ?? null,
        submissions: summary?.submissions ?? null,
        activity: { activeAudits },
        // v1's whoami also returns `badges` (earned badges, lean shape) —
        // present in getProfileSummary's own return already; this port
        // computed it and then dropped it before responding.
        badges: summary?.badges ?? null,
      };
    },
  },
  {
    name: "get_karma_details",
    description:
      "Your full karma picture beyond whoami's summary: released balance, tier ladder and progress, the per-event-type breakdown, and a PAGE of your event-by-event karma history (eventType, amount, when). " +
      "PAGING THE HISTORY: `events` is one page, never the whole ledger. Page by passing the returned `nextCursor` back as `cursor`, and keep paging while `hasMore` is true — `hasMore` is the authority on whether more events exist, not whether the page you just read came back non-empty. Keep `eventType`, `since` and `until` IDENTICAL across every page of one walk. " +
      "AN ERROR IS NEVER PROOF OF END-OF-HISTORY: if a continuation call fails, report the failure and offer to retry — never tell the operator they have no more karma events because a page errored. " +
      "`eventCount` is the total number of events matching the CURRENT filter, so \"showing 25 of 340\" is answerable without paging through everything first.",
    scope: "read",
    // Took NO arguments at all: the whole karma history was unreachable and
    // unfilterable from MCP, while v1 exposes cursor/limit/eventType/since/
    // until on the same tool. The keyset cursor is `createdAt|id` base64url —
    // stable under concurrent awards, unlike an offset.
    schema: z.object({
      cursor: z.string().optional().describe("Opaque cursor from a previous call's nextCursor."),
      limit: z.number().int().min(1).max(100).optional(),
      eventType: z.nativeEnum(KarmaEventType).optional(),
      since: z.string().datetime({ offset: true }).optional(),
      until: z.string().datetime({ offset: true }).optional(),
    }),
    call: async ({ cursor, limit, eventType, since, until }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const take = Math.min(Math.max(limit ?? 25, 1), 100);
      const where = {
        userId: context.userId,
        ...(eventType ? { eventType } : {}),
        ...(since || until
          ? { createdAt: { ...(since ? { gte: new Date(since) } : {}), ...(until ? { lt: new Date(until) } : {}) } }
          : {}),
      };
      // The doc comment two lines above this handler always claimed "a cursor
      // is bound to the filter it was issued under" — but this decoded ONLY
      // `createdAt|id`, with no filter fingerprint at all. Replaying a page-2
      // cursor minted under one `eventType`/`since`/`until` against a call
      // that changed any of them did not error the way every other paged tool
      // in this file does (list_files, list_my_submissions, list_audits,
      // list_my_audits, list_my_issues, get_sponsor_submission_evidence all
      // route through the same lib/keyset-cursor.js filter-bound envelope) —
      // it silently returned a page from the NEW filter positioned by the OLD
      // cursor: wrong rows, with a 200, exactly the failure mode
      // CursorFilterMismatchError exists to prevent. Rebuilt on the shared
      // envelope, through withCursorErrors (so a rejected cursor surfaces as
      // the same actionable 400 every other paged tool here gives, not the
      // generic sanitized message), so this tool's own cursor keeps the
      // promise its description already makes.
      const filterKey = filterKeyOf(["karma-history", context.userId, eventType, since, until]);
      return withCursorErrors(async () => {
        const decoded = cursor ? decodeCursor(cursor, filterKey, "karma history") : null;
        const [breakdown, eventCount, rows] = await Promise.all([
          getKarmaBreakdown(context.userId!),
          prisma.karmaEvent.count({ where }),
          prisma.karmaEvent.findMany({
            where: decoded
              ? {
                  ...where,
                  OR: [
                    { createdAt: { lt: new Date(decoded.key) } },
                    { createdAt: new Date(decoded.key), id: { lt: decoded.id } },
                  ],
                }
              : where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: take + 1,
          }),
        ]);
        if (!breakdown) throw new McpToolError("User not found");
        const hasMore = rows.length > take;
        const events = hasMore ? rows.slice(0, take) : rows;
        const last = events[events.length - 1];
        return {
          ...breakdown,
          events,
          eventCount,
          limit: take,
          hasMore,
          nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id, filterKey) : null,
        };
      });
    },
  },
  {
    name: "list_my_submissions",
    description:
      "List submissions made by the authenticated user, newest first. `total` counts the whole filtered set, not this page. " +
      "Statuses needs_fixes, flagged and tests_failed mean the item came BACK to you and nothing further happens until you act — they are NOT 'still being validated'. Read the item with check_submission for its flags and failing stages, then revise_submission with the corrected FULL item, or dispute_submission if the decision was wrong. Resolve these before taking on new work. " +
      "`accepted_pending_sample` is not final acceptance; only `accepted` is. " +
      "Narrow to one pool with `bountyId` when the operator asks about a specific pool rather than their whole history. " +
      PAGING,
    scope: "contribute",
    // `listSubmissions` caps at 50 (max 100) and accepts an offset; neither was
    // reachable from here, so a contributor with hundreds of items could only
    // ever see the newest 50.
    // NOTE: no `search` here. `listSubmissions` has no text filter of any kind
    // (services/submissions.ts) — it filters on bountyId/contributorUserId/
    // status only. Adding a `search` argument to this tool would mean inventing
    // one in the shared service that the REST route does not have; not done.
    schema: z.object({
      status: z.nativeEnum(SubmissionStatus).optional(),
      // REST's own `GET /v1/submissions` (routes/v1/submissions.ts) has always
      // accepted this and `listSubmissions` has always taken it — only this
      // tool's schema never exposed it, so an agent asking "what have I
      // submitted to THIS pool?" had to page the caller's whole history and
      // filter client-side. It only ever narrows: `contributorUserId` stays
      // fixed to the caller regardless.
      bountyId: z.string().optional().describe("Only submissions to this pool/bounty."),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous call's nextCursor."),
      offset: z.number().int().min(0).optional().describe("Legacy, non-stable paging. Prefer cursor."),
    }),
    call: async ({ status, bountyId, limit, cursor, offset }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      return withCursorErrors(() =>
        listSubmissions({ contributorUserId: context.userId!, bountyId, status, limit, cursor, offset }),
      );
    },
  },
  {
    name: "get_my_work_progress",
    description:
      "Read your own work position without paging through history: the contributor funnel (total submitted, in review, needing your attention, accepted, rejected split into system-rejected and human-rejected) and the validator funnel (audit windows claimed and completed, item decisions still pending). " +
      "`needsAttention` is work that came back to YOU and stops until you act — surface it before offering anything new. " +
      "These are YOUR counts only. They are never part of public pool or profile data, so never present them as platform-wide figures.",
    scope: "read",
    schema: z.object({}),
    call: async (_args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      // Was three ad-hoc counts that reported `submitted` as "pending" (missing
      // every other in-flight status), no needs-attention figure at all, and —
      // despite sitting next to list_my_audits in the same catalog — NOTHING
      // about validator work. Both real summaries already existed and are what
      // the dashboard renders.
      const [summary, auditWork, user] = await Promise.all([
        getProfileSummary(context.userId).catch(() => null),
        getMyAuditWorkSummary(context.userId).catch(() => null),
        prisma.user.findUnique({ where: { id: context.userId }, select: { karmaTotal: true, leaderboardRank: true } }),
      ]);
      return {
        contributor: summary?.submissions ?? null,
        validator: auditWork ?? null,
        karmaTotal: user?.karmaTotal ?? 0,
        leaderboardRank: user?.leaderboardRank ?? null,
        // Retained under their original names so a client written against the
        // previous shape keeps working.
        acceptedSubmissions: summary?.submissions.accepted ?? 0,
        pendingSubmissions: summary?.submissions.inReview ?? 0,
      };
    },
  },
  {
    name: "list_my_audits",
    description:
      "List the audit windows you have claimed — each with its item count, how many items you have already decided, your decision deadline, and the karma it pays. Filter by status: `claimed` (open work), `overdue_review` (past your deadline), `completed` (settled). " +
      PAGING,
    scope: "validate",
    // Now returns what the name and description promise: the validator's own
    // AUDIT WINDOWS, via the same `listMyAuditWindows` service the web
    // validator workspace and `GET /v1/me/audits` use. Owner's call
    // (2026-09-02) after the mismatch was raised.
    //
    // WHAT THIS REPLACED, so nobody reinstates it: an UNBOUNDED
    // `prisma.flag.findMany({ where: { validatorUserId } })` — no `take`, and
    // returning FLAGS while the description said "audit windows". Two defects
    // in one call. An agent asking "what audits do I hold?" got a list of
    // every issue it had ever raised, with no way to page it; one validator in
    // the migrated staging data holds 429 flags.
    //
    // The service bounds itself (default 50, ceiling 200) and returns
    // `{ audits, total, limit, skip }`, so paging is well-defined and an agent
    // can see how much work it actually has. `offset` is exposed under that
    // name for consistency with every other list tool here and mapped onto the
    // service's `skip`.
    //
    // A validator's flag history is genuinely useful, but it is a DIFFERENT
    // question ("what have I flagged?") and belongs in its own tool rather
    // than under this name. Not added here — no caller has asked for it.
    schema: z.object({
      status: z.enum(["claimed", "overdue_review", "completed"]).optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous call's nextCursor."),
      offset: z.number().int().min(0).optional().describe("Legacy, non-stable paging. Prefer cursor."),
    }),
    call: async ({ status, search, limit, cursor, offset }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      return withCursorErrors(() =>
        listMyAuditWindows({
          validatorUserId: context.userId!,
          status,
          search,
          limit,
          cursor,
          skip: offset,
        }),
      );
    },
  },
  {
    name: "list_notifications",
    description:
      "Check your notifications — submission results, audit assignments, disputes, and more. Use unreadOnly=true to see only what you have not read yet. " +
      "Page with the returned `nextCursor` while `hasMore` is true: a cursor is stable, so a notification arriving mid-walk cannot make you skip or re-read a row the way `offset` can.",
    scope: "read",
    schema: z.object({
      unreadOnly: z.boolean().optional(),
      // v1 names this parameter `unread` (databounty-api/src/mcp/tools.ts
      // list_notifications), not `unreadOnly`. Accepted as a documented alias,
      // same "both optional, no refine" pattern as `fileIdShape` above — a v1
      // client sending `unread: true` used to fail validation outright since
      // this schema had no such key at all.
      unread: z.boolean().optional().describe("Alias of unreadOnly, for clients written against v1."),
      limit: z.number().int().min(1).max(100).optional(),
      // v1 pages notifications with an opaque stable cursor. `offset` is kept
      // for existing Community callers but is NOT stable — every new
      // notification shifts the whole list — so `cursor` wins when both are
      // supplied.
      cursor: z.string().optional().describe("Opaque cursor from a previous call's nextCursor."),
      offset: z.number().int().min(0).optional().describe("Legacy, non-stable paging. Prefer cursor."),
    }),
    call: async ({ unreadOnly, unread, limit, offset, cursor }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      // Was an unwrapped call — a malformed `cursor` throws
      // `NotificationCursorError`, which reached the transport uncaught and
      // was replaced with the generic "could not be completed" message
      // instead of an actionable 400 (see withCursorErrors' doc comment).
      return withCursorErrors(() =>
        listNotifications(context.userId!, { unreadOnly: unreadOnly ?? unread, limit, offset, cursor }),
      );
    },
  },
  {
    name: "mark_notifications_read",
    description:
      "Mark one notification as read, or EVERY notification at once if you omit `notificationId`. " +
      "The bulk form is not reversible and clears the operator's whole unread list, so do not call it to tidy up — pass the id of the one you have actually dealt with unless the operator asked to clear everything.",
    scope: "account",
    schema: z.object({
      notificationId: z
        .string()
        .optional()
        .describe("The single notification to mark read. OMITTING THIS MARKS EVERY NOTIFICATION READ."),
    }),
    call: async ({ notificationId }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      if (notificationId) await markNotificationRead(context.userId, notificationId);
      else await markAllNotificationsRead(context.userId);
      return { ok: true };
    },
  },
  {
    name: "suggest_handles",
    description:
      "Get available public-handle suggestions, every one of them checked against the database so a suggestion is never one claim_handle would refuse. " +
      "Call it with a `baseName` when the operator has a name in mind, or with NO arguments when they have not thought of one yet — do not leave them staring at a blank prompt. " +
      "It reserves nothing: present the returned names as a numbered list alongside \"or type your own\", and confirm the operator's choice before calling claim_handle.",
    scope: "account",
    // `baseName` was REQUIRED, which made the cold-start case — the operator
    // has no handle in mind, which is exactly when suggestions are wanted —
    // impossible to serve, even though the no-base fallback below already
    // existed. Optional now; the two paths were always both implemented.
    schema: z.object({
      baseName: z
        .string()
        .optional()
        .describe("A name the operator likes, used as the stem. Omit entirely when they have no idea yet."),
      // v1 exposes `count` (1-10, defaults to 8) on this same tool and this
      // port hardcoded 4 regardless of caller input — both underlying
      // generators (services/public-handles.ts) already accept and clamp a
      // count themselves (`suggestAvailableHandles`'s own `Math.min(Math.max(
      // count, 1), 10)` is the exact v1 bound), so this was wiring, not a new
      // capability.
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("How many suggestions to return, 1-10. Defaults to 8."),
    }),
    call: async ({ baseName, count }) => {
      // Was returning invented `${clean}_dev`/`_ai`/`_io` names: underscore is
      // not a legal handle character, and nothing checked the database, so an
      // agent could be handed a suggestion claim_handle would refuse. Now uses
      // the same DB-checked generator the dashboard does.
      const { handle } = baseName ? normalizePublicHandle(baseName) : { handle: "" };
      const fromBase = handle ? await findAvailableHandleSuggestions(handle, count ?? 5) : [];
      if (fromBase.length > 0) return fromBase;
      return suggestAvailableHandles(count ?? 8);
    },
  },
  {
    name: "get_handle_availability",
    description:
      "Check whether a public handle can be claimed, before calling claim_handle and letting it fail. Handles are globally unique and some are reserved. " +
      "Use the answer to show the operator what their public profile address would read as. If they have no handle in mind yet, call suggest_handles instead — it can be called with no arguments.",
    scope: "account",
    schema: z.object({ handle: z.string().describe("Candidate handle to test") }),
    call: async ({ handle }) => {
      // Same normalizer as the REST surface. Without it this reported reserved
      // names (admin, terms, changelog) and charset-invalid names as available.
      const normalized = normalizePublicHandle(handle);
      if (!normalized.handle) return { available: false, reason: normalized.reason };
      const existing = await prisma.user.findUnique({ where: { handle: normalized.handle }, select: { id: true } });
      if (existing) return { handle: normalized.handle, available: false, reason: "That handle is unavailable." };
      return { handle: normalized.handle, available: true };
    },
  },
  {
    name: "claim_handle",
    description:
      "Claim the operator's public handle. It becomes their public profile page and the name every published dataset credit is attributed to. " +
      "ASK THE OPERATOR FIRST and confirm the exact spelling — never pick one for them. Claiming publishes that profile page immediately; they can switch it off, or hide individual sections, from Profile in the dashboard. " +
      "Requires a verified email, and fails if the handle is taken or reserved — check get_handle_availability first.",
    scope: "account",
    schema: z.object({ handle: z.string().describe("The exact handle the operator confirmed they want") }),
    call: async ({ handle }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      // Normalized through the shared validator. Without this the MCP path was
      // a complete bypass of the reserved-handle list and charset rules the
      // REST routes enforce: an agent could claim `admin`, `terms` or
      // `changelog` and shadow a real landing route.
      const check = normalizePublicHandle(handle);
      if (!check.handle) throw new McpToolError(check.reason ?? "Invalid handle");
      const normalized = check.handle;
      const [existing, self] = await Promise.all([
        prisma.user.findUnique({ where: { handle: normalized } }),
        prisma.user.findUniqueOrThrow({ where: { id: context.userId }, select: { handle: true } }),
      ]);
      if (existing && existing.id !== context.userId) throw new McpToolError("Handle already taken");
      // Public-by-default applies only to the very first handle claim
      // (onboarding), never to a later rename — a member who deliberately
      // opted back out of a public profile must not have it silently
      // re-enabled just by changing their handle.
      const isFirstClaim = self.handle === null;
      const user = await prisma.user.update({
        where: { id: context.userId },
        data: { handle: normalized, ...(isFirstClaim ? { profilePublic: true } : {}) },
      });
      return { ok: true, handle: user.handle, profilePublic: user.profilePublic };
    },
  },
  {
    name: "complete_onboarding",
    description:
      "Finish account setup. Call this straight after claim_handle — until it is called, every work tool keeps refusing with a 428. " +
      "It asks the operator nothing beyond the handle they already chose. `persona` is optional and cosmetic: it grants and restricts nothing, because every verified account can contribute, validate and sponsor. Do not ask which dashboard they want to land on or what work they plan to do.",
    scope: "account",
    schema: z.object({
      persona: z
        .enum(["contributor", "validator", "sponsor"])
        .optional()
        .describe("Cosmetic starting preference only. Grants no capability and gates nothing — omit it rather than asking."),
    }),
    call: async ({ persona }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const user = await prisma.user.update({
        where: { id: context.userId },
        data: { onboarded: true, persona },
      });
      return { ok: true, onboarded: user.onboarded };
    },
  },
  {
    name: "resend_email_verification",
    description:
      "Re-send the verification link to the address already on the account. Use it the moment whoami reports `emailVerified` false, or a tool fails because the email is unverified. " +
      "It takes no address (you cannot supply one) and it does NOT verify anything: the operator still has to open the emailed link, after which the blocked tool works with no re-authorization. " +
      "The reply distinguishes `queued` from `already_verified` — an already-verified account is good news, not an error. Do not call it repeatedly; it counts against the shared rate limit.",
    scope: "account",
    schema: z.object({}),
    call: async (_args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      // This used to return `{ ok: true, message: "Verification link sent" }`
      // and send nothing at all. Now it does exactly what
      // POST /v1/auth/resend-verification does, and reports honestly when it
      // cannot: the response distinguishes "queued" from "already verified"
      // rather than claiming success in every case.
      const user = await prisma.user.findUnique({
        where: { id: context.userId },
        select: { id: true, email: true, emailVerifiedAt: true },
      });
      if (!user?.email) throw new McpToolError("No email address is set on this account");
      if (user.emailVerifiedAt) return { ok: true, sent: false, status: "already_verified" as const };
      const token = await createEmailVerificationToken(user.id);
      // Delivery itself is asynchronous and best-effort (same as the REST
      // route), so the honest claim is "queued", not "delivered".
      void sendVerificationEmail(user.email, token).catch((err) => {
      // Fire-and-forget on purpose: the request must not fail, and must not
      // reveal whether an address exists. But an EMPTY catch here hid a broken
      // mailer completely — the user simply never received the verification mail and
      // nothing anywhere recorded it. Log, do not rethrow.
      console.error(`[mail] verification email failed: ${err instanceof Error ? err.message : String(err)}`);
    });
      return { ok: true, sent: true, status: "queued" as const };
    },
  },
  {
    name: "get_attribution_preference",
    description:
      "Read whether your account is publicly credited by name on the community datasets you contribute to. optOut=true means your identity is omitted from public credit (your accepted-item totals and karma are unaffected). " +
      "`profilePublic` is returned alongside it as context only: it is a SEPARATE axis — whether your profile page exists at all — and is not what governs dataset credit.",
    scope: "account",
    schema: z.object({}),
    call: async (_args, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const [{ attributionOptOut }, user] = await Promise.all([
        getAttributionPreference(context.userId),
        prisma.user.findUnique({ where: { id: context.userId }, select: { profilePublic: true, publicProfilePrefs: true } }),
      ]);
      return { optOut: attributionOptOut, attributionOptOut, profilePublic: user?.profilePublic ?? false, publicProfilePrefs: user?.publicProfilePrefs ?? null };
    },
  },
  {
    name: "set_attribution_preference",
    description:
      "Set whether your account is publicly credited by name on community datasets. Pass optOut=true to remove your identity from public credit, false to be credited (the default). This is your own account setting — it cannot be changed by sponsors.",
    scope: "account",
    // SEMANTIC INVERSION, fixed. v1's parameter is `optOut`; this port took
    // `profilePublic` and wrote `User.profilePublic` — so an agent written
    // against v1 sending `optOut: true` ("do not name me") either failed
    // validation or, worse, an agent translating it to `profilePublic: false`
    // hid the operator's whole profile while leaving dataset credit ON.
    // `services/reputation.ts` already carries the correct, separate
    // `attributionOptOut` preference (and its own comment names this exact
    // tool as the thing writing the wrong field); this now calls it.
    schema: z.object({
      optOut: z.boolean().describe("true = omit my identity from public community dataset credit; false = credit me by handle."),
    }),
    call: async ({ optOut }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const { attributionOptOut } = await setAttributionPreference(context.userId, optOut);
      return { optOut: attributionOptOut, attributionOptOut };
    },
  },
  {
    name: "report_issue",
    description:
      "Report a PLATFORM problem and get back a case id plus what was actually stored. Use this only when the platform is at fault; a rejected item you disagree with is a dispute (dispute_submission), not an issue. " +
      "ASK THE OPERATOR BEFORE CALLING THIS: it opens a support case a human will read. It cannot and will not change any submission, audit or karma. " +
      "Name the resources the problem is about (bountyId / submissionId / windowId / contributorBatchId / datasetTypeId): the response splits them into `resources` the server could confirm you may see, and `unresolvedIds` it could not — an unresolved id is recorded as a caller CLAIM, never as a confirmed fact. " +
      "Pass a stable `idempotencyKey` you generate for THIS report and reuse the exact same value if you retry after a timeout, so one problem never becomes two support cases. " +
      "Nothing you send is scrubbed on the way in: do not paste API keys, tokens, cookies, presigned URLs or personal data, in any field including `logExcerpt`. " +
      "Filing an issue never un-rejects your work. You get a case id back immediately; the investigation happens afterwards, and no fix time is offered — do not promise one.",
    scope: "account",
    schema: z.object({
      category: z.nativeEnum(AgentIssueCategory),
      impact: z.nativeEnum(AgentIssueImpact),
      // Bounds matched to this repo's OWN REST route (routes/v1/issues.ts
      // `reportIssueBody`), which this tool's underlying service call mirrors:
      // summary/expected/actual/steps and every context id below were
      // unbounded here, so an MCP caller could submit a report the dashboard's
      // own route would reject outright.
      summary: z.string().trim().min(5).max(200),
      expected: z.string().trim().min(5).max(1000),
      actual: z.string().trim().min(5).max(1000),
      steps: z.string().max(4000).optional().describe("How to reproduce it, if you can state that."),
      logExcerpt: z
        .string()
        .max(4000)
        .optional()
        .describe("A SHORT, relevant log excerpt. Never credentials, tokens or personal data — nothing here is redacted for you."),
      // The service documents this as caller-supplied and REQUIRED, precisely
      // because a per-call default makes the @@unique([reporterUserId,
      // idempotencyKey]) constraint unreachable. This tool was generating one
      // per call from Date.now() + Math.random(), so the retry-after-timeout
      // case the constraint exists for opened a second case every time.
      // Optional in the schema only so existing callers keep working; the
      // generated fallback below is now the documented exception, not the rule.
      idempotencyKey: z
        .string()
        .min(16)
        .max(200)
        .optional()
        .describe("Stable key you generate for THIS report. Reuse the exact same value when retrying after a timeout so one report never becomes two cases."),
      // v1 accepts all five context ids. Dropping them meant every MCP-filed
      // case arrived with no resource attached at all, so triage had to guess
      // which pool/item/window the report was about from free text.
      // `.max(64)` matches the REST route's own bound on these ids
      // (routes/v1/issues.ts `reportIssueBody`) — an id column is never near
      // that long, so this only rejects the caller obviously misusing the
      // field, exactly as REST already does.
      bountyId: z.string().max(64).optional().describe("Related community pool / bounty id, if any."),
      submissionId: z.string().max(64).optional().describe("Your related submission id, if any."),
      windowId: z.string().max(64).optional().describe("Related human audit window id, if any."),
      auditBatchId: z.string().max(64).optional().describe("Alias of windowId, for clients written against v1."),
      contributorBatchId: z.string().max(64).optional().describe("Your related claimed batch id, if any."),
      batchId: z.string().max(64).optional().describe("Alias of contributorBatchId."),
      datasetTypeId: z.string().max(64).optional().describe("Related dataset type id, if the contract is the problem."),
    }),
    call: async (args, context) => {
      // Was scope "read" (which meant "no credential at all") and accepted an
      // undefined reporter, so this was an anonymous, unauthenticated database
      // write. REST requires a session here (routes/v1/issues.ts POST /).
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const userId = context.userId;
      // Resolution/authorization lives in ONE place (services/issues.ts
      // collectIssueContext), shared with POST /v1/issues. This tool used to
      // carry its own copy, which drifted three ways: it emitted `type` where
      // the reporter DTO and apps/web read `kind`, it re-exposed the paid /
      // community `bounty.kind` this tree does not have, and it recorded
      // "partial" even when nothing at all resolved.
      const collected = await collectIssueContext(userId, {
        bountyId: args.bountyId,
        submissionId: args.submissionId,
        auditWindowId: args.windowId ?? args.auditBatchId,
        contributorBatchId: args.contributorBatchId ?? args.batchId,
        datasetTypeId: args.datasetTypeId,
      });
      const { resources, unresolvedIds } = collected.snapshot;
      const { issue } = await createAgentIssue({
        reporterUserId: userId,
        reporterLabel: `user-${userId.slice(-4)}`,
        source: "mcp",
        category: args.category,
        impact: args.impact,
        summary: args.summary,
        expected: args.expected,
        actual: args.actual,
        steps: args.steps,
        logExcerpt: args.logExcerpt,
        context: collected.snapshot as unknown as Prisma.InputJsonValue,
        contextCollection: collected.collection,
        idempotencyKey: args.idempotencyKey ?? `mcp_iss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      });
      return { ...issue, resources, unresolvedIds };
    },
  },
  {
    name: "get_issue",
    description:
      "Read one of your own support cases: its current status, the reporter-visible timeline of replies, the `resources` it concerns with their ids, the `unresolvedIds` recorded only as your claim, and — once staff close it — their explanation. " +
      "Quote the returned `guidance` to the operator rather than inventing what a status means. Returns only your own reports, and no fix time is offered — never promise one.",
    scope: "read",
    schema: z.object({ issueId: z.string().describe("Case id returned by report_issue or list_my_issues") }),
    call: async ({ issueId }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const issue = await getIssueById(issueId, context.userId);
      if (!issue) throw new McpToolError("Issue not found");
      return issue;
    },
  },
  {
    name: "list_my_issues",
    description:
      "List the platform issues you have reported, newest first. Use it before filing a new report to check whether you already reported the same problem — a duplicate costs a human a triage pass. " +
      "Narrow with `status`, a summary substring `q`, and a `since`/`until` reported-date range; `issueCount` is the total matching those filters (not just this page). Page with `cursor` while `hasMore` is true — `hasMore` is the server's word, so do not infer the end of the list from an empty page. An error is never proof that you have no more issues.",
    scope: "read",
    // Took no arguments and called the UNBOUNDED `listUserIssues`, so a
    // prolific reporter's entire case history came back in one response,
    // straight into an agent's context, with no way to filter or page it.
    // `listUserIssuesPage` is the same server-side filtered, cursor-paginated
    // reader `GET /v1/issues` already uses.
    schema: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().optional(),
      status: z.nativeEnum(AgentIssueStatus).optional(),
      q: z.string().min(2).max(80).optional().describe("Case-insensitive substring of the summary."),
      since: z.string().optional().describe("ISO date-time; only issues reported at or after it."),
      until: z.string().optional().describe("ISO date-time; only issues reported before it."),
    }),
    call: async ({ limit, cursor, status, q, since, until }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      const toDate = (value: string | undefined, field: string): Date | null => {
        if (value === undefined) return null;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) throw new McpToolError(`\`${field}\` is not a valid ISO date-time.`, 400);
        return parsed;
      };
      const sinceDate = toDate(since, "since");
      const untilDate = toDate(until, "until");
      if (sinceDate && untilDate && sinceDate >= untilDate) {
        throw new McpToolError("`since` must be earlier than `until`.", 400);
      }
      try {
        return await listUserIssuesPage(context.userId, {
          limit, cursor, status, q, since: sinceDate, until: untilDate,
        });
      } catch (err) {
        // Never let a cursor the server cannot honour degrade into an empty
        // page — an agent would read that as "no more issues" and stop.
        if (err instanceof InvalidIssueCursorError || err instanceof IssueCursorFilterMismatchError) {
          throw new McpToolError(err.message, 400);
        }
        throw err;
      }
    },
  },
  {
    name: "reply_to_issue",
    description:
      "Add a reply to one of your own open support cases. Use it to answer a follow-up when the status is `needs_info` — that is the case actually waiting on you — but also to volunteer new information at any open status. " +
      "Your reply is appended to the immutable case history. From `needs_info` it returns the case to the triage queue; from any other open status the status is deliberately left alone, because a reply is new information, not a transition request. " +
      "A closed case cannot be replied to: file a new report and reference the old id.",
    scope: "account",
    schema: z.object({
      issueId: z.string(),
      // Bounded to match POST /v1/issues/:id/reply (routes/v1/issues.ts:22).
      body: z.string().trim().min(1).max(2000),
    }),
    call: async ({ issueId, body }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      // Ownership and closed-case checks, as the REST route does before
      // calling the same service. `replyToIssue` looks the issue up by id
      // ALONE and, when the issue is in `needs_info`, moves it back to
      // `received` — so without these an `account`-scoped credential could
      // post as the reporter onto a stranger's support case by id, reopen it,
      // and read its status back out of the return value.
      const existing = await getIssueById(issueId, context.userId);
      if (!existing) throw new McpToolError("Issue not found");
      if (isIssueClosed(existing.status)) {
        throw new McpToolError("This issue is closed. Open a new one with report_issue.", 409);
      }
      return replyToIssue({
        issueId,
        actorUserId: context.userId,
        actorRole: "reporter",
        body,
      });
    },
  },
  // ---------------------------------------------------------------------
  // Requester ("sponsor") tools — the `sponsor` API-key scope. Both call the
  // same service functions as `GET /v1/bounties/:id/submissions` and
  // `POST /v1/submissions/:id/dispute-acceptance` (services/sponsor-evidence.ts),
  // so an agent and the dashboard see identical evidence and identical
  // ownership/window rules.
  // ---------------------------------------------------------------------
  {
    name: "get_sponsor_submission_evidence",
    description:
      "Review the work contributed to a community pool you requested, including each item's per-stage validation evidence, flags and current status, plus the dispute window on accepted items. Only the pool's requester can read this. " +
      PAGING,
    scope: "sponsor",
    schema: z.object({
      bountyId: z.string().describe("Community pool bounty id — the pool this account requested."),
      limit: z.number().int().min(1).max(100).optional().describe("Rows per page (maximum 100)."),
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous call's nextCursor."),
      page: z.number().int().min(1).optional().describe("Legacy, non-stable paging. Prefer cursor."),
      pageSize: z.number().int().min(1).max(100).optional().describe("Legacy alias of limit (maximum 100)."),
      status: z.string().optional().describe("Optional submission-status filter (e.g. accepted, in_audit, disputed)."),
      search: z.string().optional().describe("Optional case-insensitive text search over item titles."),
      // v1 names this parameter `q` (databounty-api/src/mcp/tools.ts
      // get_sponsor_submission_evidence), not `search`. Accepted as a
      // documented alias so a v1 client's call still lands; `search` wins when
      // both are given since it is the canonical, advertised name.
      q: z.string().optional().describe("Alias of search, for clients written against v1."),
    }),
    call: async ({ bountyId, limit, cursor, page, pageSize, status, search, q }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      try {
        return await withCursorErrors(() =>
          listSponsorSubmissionEvidence({ bountyId, userId: context.userId!, limit, cursor, page, pageSize, status, search: search ?? q }),
        );
      } catch (err) {
        if (err instanceof SponsorEvidenceError) throw new McpToolError(err.message, err.status, err.code);
        throw err;
      }
    },
  },
  {
    name: "dispute_accepted_submission",
    description:
      "Challenge an accepted item in a community pool you requested, while its dispute window is still open (see disputeWindowClosesAt from get_sponsor_submission_evidence). The item moves to disputed and an admin arbitrates; the contributor's karma for it is only reversed if the admin upholds the dispute. Refused once the window has closed, if the item was never accepted, or if it already has an open dispute.",
    scope: "sponsor",
    schema: z.object({
      submissionId: z.string().describe("Submission id from get_sponsor_submission_evidence"),
      reason: z.nativeEnum(FlagReason).describe("Specific reason the accepted item should be reviewed."),
      argument: z
        .string()
        .trim()
        .min(10)
        .max(2000)
        .describe("Explain in detail why this accepted item should not have passed (10–2000 characters)."),
    }),
    call: async ({ submissionId, reason, argument }, context) => {
      if (!context?.userId) throw new McpToolError("Authentication required", 401);
      // Mirrors the REST route's `requireVerifiedEmail` preHandler and the
      // `AuthedUser.roles` the route hands the service (an admin may dispute
      // any pool's accepted item).
      const user = await prisma.user.findUnique({
        where: { id: context.userId },
        select: { emailVerifiedAt: true, roles: { select: { role: true } } },
      });
      if (!user?.emailVerifiedAt) {
        throw new McpToolError(
          "dispute_accepted_submission needs a verified email address. Call resend_email_verification, then open the link that arrives " +
            "before retrying — nothing was submitted.",
          403,
          "email_unverified",
        );
      }
      // The admin any-pool bypass is a REAL PRIVILEGE, not a fact about the
      // user — REST hands it to the service only because `requireAuth`
      // (routes/v1/submissions.ts) accepts a dashboard session alone and
      // refuses every API key outright (lib/rbac.ts). Passing the caller's
      // real roles here regardless of credential kind meant an admin who
      // minted a `sponsor`-scoped API key for automation silently handed
      // that key the power to dispute ANY pool's accepted item platform-wide
      // — a privilege REST can never grant to an API key. Restated per
      // credential: the bypass travels only with a full session.
      const callerRoles = context.credentialKind === "session" ? user.roles.map((r) => r.role) : [];
      try {
        return await disputeAcceptedSubmission({
          submissionId,
          userId: context.userId,
          callerRoles,
          reason,
          argument,
        });
      } catch (err) {
        if (err instanceof SponsorEvidenceError) throw new McpToolError(err.message, err.status, err.code);
        throw err;
      }
    },
  },
];
