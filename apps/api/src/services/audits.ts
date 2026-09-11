// SPDX-License-Identifier: Apache-2.0

import {
  AuditVerdict,
  ArtifactKind,
  ArtifactStatus,
  DatasetCategory,
  DomainId,
  FlagReason,
  FlagStatus,
  KarmaEventType,
  SubmissionStatus,
  type Artifact,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decodeCursor, encodeCursor, filterKeyOf, InvalidCursorError, takePage } from "../lib/keyset-cursor.js";
import { awardKarma, KARMA_RULES, acceptedItemKarmaForBounty, effectiveTypePricing, getKarmaMatrix, getKarmaRules, validatorAuditKarmaPerItem } from "./karma.js";
import { awardOrHoldAcceptedItemKarma } from "./karma-holds.js";
import { recomputeAcceptedItemCounters } from "./submission-acceptance.js";
import { notifyUser } from "./notifications.js";
import { validatorRankForAudits } from "./reputation.js";
import { llmValidationEnabled } from "./admin-settings.js";
import { openRouterConfigured } from "./llm-client.js";
import { listBountyBriefArtifacts } from "./artifacts.js";

/**
 * Flat fallback karma per validator decision (`KARMA_RULES.auditItem`) — the
 * rate paid when a bounty's dataset type carries no priced axes and no frozen
 * `karmaQuote`. `decideAuditItems` (below) now resolves the REAL, per-bounty
 * rate via `validatorAuditKarmaPerItem` (KARMA_PRICING_MATRIX_PLAN.md:
 * complexity x review-load) before awarding, falling back to this constant
 * only inside that resolver's own fail-closed branch. The list/detail
 * `karmaReward` projections elsewhere in this file still show this flat
 * constant rather than the resolved per-bounty rate — a known display-only
 * gap (they would need the same bounty+datasetType context threaded through
 * their own queries), not a mismatch in what actually gets awarded.
 */
export const VALIDATOR_KARMA_PER_DECISION = KARMA_RULES.auditItem;

/**
 * A rejecting decision's note is the ONLY explanation the contributor ever
 * receives, so it has to say something. Exported because the MCP tool mirrors
 * the rule in its own schema and description: enforcing it only here meant an
 * agent learned the rule by failing a call.
 */
export const MIN_FLAG_NOTE_LENGTH = 10;

/**
 * `submitAuditDecisions` writes a claimed window in one transaction —
 * per-decision submission flip + verdict row + flag/karma/notification prep,
 * then a once-per-call rank/counter recount and window settlement check.
 * `community.human_audit_window_size` is documented as "the batch a
 * validator claims. 50-100" (see HumanAuditWindow's own schema comment), so
 * a full window can run dozens of these round trips inside one open
 * transaction.
 *
 * Same shape, same fix as `INTAKE_TRANSACTION_TIMEOUT_MS` in
 * services/submissions.ts and the disputes.ts resolve transaction: Prisma's
 * 5s interactive-transaction default is tuned for local Postgres, not a
 * remote pooled connection (Supabase session pooler in every deployed
 * environment). There the per-query round trip is high enough that even a
 * SINGLE decision on a real deployment can outlive 5s — confirmed live
 * against dev-api.databounty.io, where a one-item decision failed with
 * "A query cannot be executed on an expired transaction ... 5717ms passed".
 * Whichever query happened to be in flight when the timeout fired surfaced
 * whatever error it threw — including `enqueueLeaderboardRankCheck`'s
 * `dbJobQueue.enqueue()`, whose own catch (services/jobs.ts) reports any
 * in-transaction failure as "failed to enqueue leaderboard.rank_check"
 * regardless of cause, which is what made an unrelated timeout look like a
 * job-queue defect. Raising the budget fixes the real cause for every query
 * in this transaction at once, not just the one that happened to be caught
 * looking.
 */
const AUDIT_DECISIONS_TRANSACTION_TIMEOUT_MS = 60_000;

// Statuses a selected HumanAuditWindowMembership's submission can be in once a
// validator decision has landed on it (as opposed to `in_audit`, which means
// still awaiting a decision).
const DECIDED_SUBMISSION_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.flagged,
  SubmissionStatus.disputed,
  SubmissionStatus.rejected,
  SubmissionStatus.accepted,
];

/**
 * THE definition of "a validator decided this item".
 *
 * `AuditItem` has no status column — a decision is the PAIR
 * (`verdict`, `decidedAt`), written together by submitAuditDecisions and
 * cleared together by reopenAuditItemForReview. Requiring both is what makes
 * every surface agree; keying on one alone is how two panels on the same page
 * came to report different outcomes for the same item.
 *
 * This deliberately does NOT consult `Submission.status`. A status can reach
 * `flagged`/`rejected`/`accepted` with no human involved at all (machine
 * rejection, pool sampling, dispute resolution, an admin action), so status is
 * evidence that SOMETHING happened — never evidence that a validator decided.
 */
export function isDecidedAuditItem(
  item: { verdict: AuditVerdict | null; decidedAt: Date | null } | null | undefined
): boolean {
  return item != null && item.verdict != null && item.decidedAt != null;
}

/**
 * Submission ids that carry a real validator decision, for the list endpoints.
 * One query for a whole page of windows rather than per-window, and it asks
 * exactly the question isDecidedAuditItem defines.
 */
async function decidedSubmissionIds(submissionIds: string[]): Promise<Set<string>> {
  if (submissionIds.length === 0) return new Set();
  const rows = await prisma.auditItem.findMany({
    where: { submissionId: { in: submissionIds }, verdict: { not: null }, decidedAt: { not: null } },
    select: { submissionId: true },
  });
  return new Set(rows.map((r) => r.submissionId));
}

function toApiArtifact(a: Artifact) {
  return {
    id: a.id,
    kind: a.kind,
    visibility: a.visibility,
    status: a.status,
    scanStatus: a.scanStatus,
    modality: a.modality,
    detectedMimeType: a.detectedMimeType,
    parserVersion: a.parserVersion,
    filename: a.filename,
    contentType: a.contentType,
    // BigInt does not survive JSON.stringify; every other numeric-ish field
    // on Artifact is already a plain Int/Float.
    sizeBytes: a.sizeBytes == null ? null : Number(a.sizeBytes),
    submissionId: a.submissionId,
    createdAt: a.createdAt.toISOString(),
    downloadUrl: `/v1/artifacts/${a.id}/content`,
  };
}

/**
 * Reasons a user may not audit a given window. `own_submission` is a validator
 * who authored at least one of the window's selected items;
 * `duplicate_of_own_work` is the
 * near-duplicate conflict `hasDuplicateOfOwnWorkConflict` below computes —
 * kept as a distinct value (never collapsed into `own_submission`) so a log
 * line or a future UI can say which of the two actually applied.
 */
export type AuditConflictReason = "own_submission" | "duplicate_of_own_work";

/** The minimum window shape the conflict predicate needs. Deliberately
 * structural so every caller can select just these columns. */
export type AuditConflictWindow = {
  memberships: Array<{ submission: { contributorUserId: string } }>;
};

/**
 * THE single source of truth for "this user may not audit this window".
 *
 * The list and claim share this predicate, so anything the list offers is
 * claimable and anything the claim refuses is never offered. An account may
 * sponsor, contribute, and validate. The only direct ownership conflict is a
 * window containing that account's own submitted item; validating that item
 * would be self-approval.
 */
export function auditConflictReasonFor(
  window: AuditConflictWindow,
  validatorUserId: string
): AuditConflictReason | null {
  if (window.memberships.some((m) => m.submission.contributorUserId === validatorUserId)) {
    return "own_submission";
  }
  return null;
}

/** Boolean convenience over {@link auditConflictReasonFor}. */
export function hasAuditConflict(window: AuditConflictWindow, validatorUserId: string): boolean {
  return auditConflictReasonFor(window, validatorUserId) !== null;
}

/**
 * A membership's minimum submission shape for the near-duplicate-of-own-work
 * check below: the item's own id, plus whatever the dedupe engine recorded
 * for it.
 */
export type AuditDuplicateConflictItem = {
  submissionId: string;
  duplicateOfSubmissionId: string | null;
};

/** The two id-sets {@link hasDuplicateOfOwnWorkConflict} needs, loaded once
 * per validator (by {@link loadValidatorDuplicateConflictSets}) rather than
 * once per window or per claim. */
export type ValidatorDuplicateConflictSets = {
  ownSubmissionIds: Set<string>;
  duplicateTargetIds: Set<string>;
};

/**
 * Bounds both scans in {@link loadValidatorDuplicateConflictSets} the same
 * way v1 bounds its equivalent (`CONFLICT_SCAN_LIMIT`, routes/v1/audits.ts):
 * a soft cap on a query keyed to one validator's own submission history,
 * not an argument that the history is actually that large in practice.
 */
const DUPLICATE_CONFLICT_SCAN_LIMIT = 2000;

/**
 * Loads, once per validator per list/claim call, the two submission id-sets
 * {@link hasDuplicateOfOwnWorkConflict} checks an audit window's items
 * against:
 *  - `ownSubmissionIds` — every submission this validator authored (bounded);
 *  - `duplicateTargetIds` — every submission id THIS validator's own
 *    submissions point at via `duplicateOfSubmissionId` (i.e. something the
 *    validator later submitted that the dedupe engine matched to an
 *    existing, earlier item).
 *
 * Two queries rather than one: the first answers "is the item under audit a
 * copy of something I submitted" (direction a below), the second answers "did
 * I later submit something that copies the item under audit" (direction b).
 */
export async function loadValidatorDuplicateConflictSets(
  validatorUserId: string
): Promise<ValidatorDuplicateConflictSets> {
  const [ownRows, targetRows] = await Promise.all([
    prisma.submission.findMany({
      where: { contributorUserId: validatorUserId },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: DUPLICATE_CONFLICT_SCAN_LIMIT,
    }),
    prisma.submission.findMany({
      where: { contributorUserId: validatorUserId, duplicateOfSubmissionId: { not: null } },
      select: { duplicateOfSubmissionId: true },
      orderBy: { createdAt: "desc" },
      take: DUPLICATE_CONFLICT_SCAN_LIMIT,
    }),
  ]);
  return {
    ownSubmissionIds: new Set(ownRows.map((r) => r.id)),
    duplicateTargetIds: new Set(
      targetRows.map((r) => r.duplicateOfSubmissionId).filter((id): id is string => Boolean(id))
    ),
  };
}

/**
 * Near-duplicate-of-own-work conflict — the guard v1 names
 * `auditDuplicateOfValidatorConflict` (routes/v1/audits.ts) and this port
 * previously had no equivalent of (found auditing v1 parity). The
 * self-audit checks in {@link auditConflictReasonFor} only catch a
 * submission literally ATTRIBUTED to the validator's own account
 * (`contributorUserId === validatorUserId`). They miss the case where a
 * DIFFERENT contributor's submission is a documented near/exact duplicate of
 * content the validator themselves authored: the dedupe engine's
 * review-required band does not reject such a submission, it forces it into
 * human audit while still recording `duplicateOfSubmissionId` — so a
 * near-copy of a validator's own prior work can reach their OWN audit queue
 * with zero conflict signal otherwise.
 *
 * Checked in both directions, matching v1 exactly, since either one is a
 * genuine incentive to rubber-stamp rather than judge honestly:
 *   (a) an item under audit carries `duplicateOfSubmissionId` pointing at a
 *       submission the validator themselves authored (their own work was
 *       copied/matched into the window); or
 *   (b) the validator later submitted something that was itself flagged
 *       (via ITS OWN `duplicateOfSubmissionId`) as a near/exact duplicate of
 *       an item now in the window.
 *
 * Deliberately scoped to the `duplicateOfSubmissionId` evidence the real
 * dedupe engine already computed and persisted (see `computeNearDupScore` /
 * the exact-hash path in `services/submissions.ts`) rather than re-running a
 * live similarity scan against every submission the validator has ever
 * made — that evidence already exists at real computed cost, and (like v1's
 * own version of this fix) was previously written but read by nothing
 * outside the pipeline that computed it.
 */
export function hasDuplicateOfOwnWorkConflict(
  items: AuditDuplicateConflictItem[],
  sets: ValidatorDuplicateConflictSets
): boolean {
  return items.some(
    (item) =>
      (item.duplicateOfSubmissionId != null && sets.ownSubmissionIds.has(item.duplicateOfSubmissionId)) ||
      sets.duplicateTargetIds.has(item.submissionId)
  );
}

/**
 * List HumanAuditWindows this validator can actually act on: still open
 * (not settled/superseded), with at least one selected member still awaiting
 * a decision, and carrying no audit conflict for this validator — see
 * {@link auditConflictReasonFor}, which is the same predicate
 * `claimAuditWindow` enforces, so every window listed here is genuinely
 * claimable. A window with even one self-authored item is hidden in full
 * rather than partially filtered (mirroring the funded product's audit-batch
 * rule this frontend copy already promises), so "claimed" review coverage
 * never quietly excludes just one row. `conflictExcluded` reports how many
 * otherwise-actionable windows were withheld for a conflict, sponsor
 * conflicts included.
 *
 * There is no per-validator claim on a window in this schema (see
 * HumanAuditWindow/HumanAuditWindowMembership) — any verified validator can
 * open and decide any window returned here. Pagination/exclusion are
 * necessarily computed in memory (they depend on this specific validator's
 * own submissions), so this loads full membership+submission rows for every
 * open window rather than paging at the SQL level. Acceptable at this
 * product's current scale; would need a materialized per-validator queue to
 * hold up at very high open-window counts.
 */
export function availableAuditsFilterKey(params: {
  validatorUserId: string;
  bountyId?: string;
  domains?: string[];
  categories?: string[];
  languages?: string[];
  search?: string;
}): string {
  return filterKeyOf([
    "available-audits",
    params.validatorUserId,
    params.bountyId,
    [...(params.domains ?? [])].sort().join(","),
    [...(params.categories ?? [])].sort().join(","),
    [...(params.languages ?? [])].sort().join(","),
    params.search?.trim() ?? "",
  ]);
}

export async function listAvailableAudits(params: {
  validatorUserId: string;
  bountyId?: string;
  /** v1's top-level queue axis (`list_audits` `domains`, GET /audits?domains=)
   * — coding / legal / healthcare / finance / science. Dropped in this port in
   * favour of `bountyId`, so the question an operator actually asks ("what
   * legal work can I review?") had no filter at all. Restored; `bountyId`
   * stays alongside it. */
  domains?: string[];
  categories?: string[];
  languages?: string[];
  search?: string;
  limit?: number;
  offset?: number;
  /** Stable keyset cursor over `closedAt desc, id desc`. `offset` remains for
   * existing REST callers but is NOT stable — a window closing mid-walk shifts
   * every later row. */
  cursor?: string;
}) {
  const where: Prisma.HumanAuditWindowWhereInput = {
    settledAt: null,
    supersededAt: null,
    // A claimed window is no longer available to anyone else (T1) — mirrors
    // v1's listing `where: { status: "available", validatorUserId: null }`
    // (routes/v1/audits.ts:222-223). This also hides a window the CALLER
    // themselves is holding: same as v1, "available" is deliberately not
    // "mine"; a validator's own claimed work is surfaced elsewhere (the
    // claim response, or GET /:id), never re-listed here as if unclaimed.
    claimedByUserId: null,
    ...(params.bountyId ? { bountyId: params.bountyId } : {}),
    ...(params.domains?.length || params.categories?.length || params.languages?.length || params.search
      ? {
          bounty: {
            ...(params.domains?.length ? { datasetType: { domain: { in: params.domains as DomainId[] } } } : {}),
            ...(params.categories?.length ? { datasetCategory: { in: params.categories as DatasetCategory[] } } : {}),
            ...(params.languages?.length ? { language: { in: params.languages } } : {}),
            ...(params.search ? { title: { contains: params.search, mode: "insensitive" } } : {}),
          },
        }
      : {}),
  };

  const windows = await prisma.humanAuditWindow.findMany({
    where,
    include: {
      bounty: {
        select: {
          id: true,
          title: true,
          datasetCategory: true,
          language: true,
        },
      },
      memberships: {
        where: { selected: true },
        // duplicateOfSubmissionId feeds hasDuplicateOfOwnWorkConflict below —
        // the near-dup-of-own-work guard alongside auditConflictReasonFor.
        include: { submission: { select: { status: true, contributorUserId: true, duplicateOfSubmissionId: true } } },
      },
    },
    // `id` tiebreaker added so the ordering is TOTAL. Without it two windows
    // closed in the same millisecond have no defined relative order, and a
    // keyset cursor naming one of them cannot say which rows come after.
    orderBy: [{ closedAt: "desc" }, { id: "desc" }],
  });

  const decidedIds = await decidedSubmissionIds(windows.flatMap((w) => w.memberships.map((m) => m.submissionId)));
  // One query pair for the whole page, not one per window — see
  // loadValidatorDuplicateConflictSets.
  const dupSets = await loadValidatorDuplicateConflictSets(params.validatorUserId);

  let conflictExcluded = 0;
  // Per-reason breakdown of the same count above, so a caller can say WHICH
  // conflict applies instead of a single opaque number — a sponsor-only
  // conflict (every window withheld belongs to a pool this validator
  // requested) reads very differently from an own-submission conflict, and
  // collapsing them produced a UI message that was flatly wrong for a
  // validator who has never submitted anything (QA: support@databounty.io,
  // sponsor of every community pool, saw "items you submitted as a
  // contributor" despite never contributing one).
  const conflictExcludedByReason: Record<AuditConflictReason, number> = {
    own_submission: 0,
    duplicate_of_own_work: 0,
  };
  const rows = windows
    .map((w) => {
      // DISPLAYED progress comes from real AuditItem decisions. It used to be
      // `status !== in_audit`, i.e. "anything not awaiting audit", which
      // counted `needs_fixes`, `accepted_pending_sample`, `tests_failed`,
      // `submitted` (a revision resets to it) and more as decided — so this
      // card claimed "3 / 3 (100%)" while the detail page, which used a
      // stricter four-status allowlist, said "2 of 3 reviewed".
      // Same authoritative-where-possible rule as the detail path: AuditItems
      // only exist for a window with a linked AuditBatch. Without this the
      // count read 0 for every legacy window (all of them today).
      const decidedCount = w.auditBatchId != null
        ? w.memberships.filter((m) => decidedIds.has(m.submissionId)).length
        : w.memberships.filter((m) => DECIDED_SUBMISSION_STATUSES.includes(m.submission.status)).length;
      // CLAIMABILITY is a separate question and stays on `in_audit`, matching
      // the claim path's own guard in claimAuditWindow — the two must agree or
      // a window would advertise as claimable and then refuse the claim.
      const claimablePending = w.memberships.filter((m) => m.submission.status === SubmissionStatus.in_audit).length;
      // The SAME predicates claimAuditWindow enforces — own-submission
      // conflicts plus the near-dup-of-own-work conflict below.
      // Never re-implement either rule here.
      const conflict =
        auditConflictReasonFor(w, params.validatorUserId) ??
        (hasDuplicateOfOwnWorkConflict(
          w.memberships.map((m) => ({ submissionId: m.submissionId, duplicateOfSubmissionId: m.submission.duplicateOfSubmissionId })),
          dupSets
        )
          ? "duplicate_of_own_work"
          : null);
      return { w, pendingCount: claimablePending, decidedCount, conflict };
    })
    .filter((row) => {
      if (row.pendingCount === 0) return false; // nothing left for anyone to decide
      if (row.conflict) {
        // `conflictExcluded` stays a truthful count of windows withheld for a
        // conflict, and now counts sponsor conflicts too.
        conflictExcluded++;
        conflictExcludedByReason[row.conflict]++;
        return false;
      }
      return true;
    });

  const total = rows.length;
  const take = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const skip = Math.max(params.offset ?? 0, 0);
  const filterKey = availableAuditsFilterKey(params);

  // Conflict exclusion depends on THIS validator's own submissions, so the
  // page is necessarily cut in memory (see the note above the function). The
  // cursor is applied to the same already-ordered, already-filtered array, so
  // it is exactly as stable as a SQL keyset would be: it names the last row
  // served rather than a count of rows to skip, and a window that closes or
  // settles mid-walk can no longer shift the rows after it.
  let windowed: typeof rows;
  let hasMore: boolean;
  if (params.cursor) {
    const position = decodeCursor(params.cursor, filterKey, "audit");
    const anchor = Number(position.key);
    const after = rows.filter((r) => {
      const closed = r.w.closedAt.getTime();
      if (closed !== anchor) return closed < anchor;
      return r.w.id < position.id;
    });
    const split = takePage(after.slice(0, take + 1), take);
    windowed = split.items;
    hasMore = after.length > take;
  } else {
    windowed = rows.slice(skip, skip + take);
    hasMore = rows.length > skip + take;
  }
  const page = windowed;
  const lastRow = page[page.length - 1];

  return {
    audits: page.map(({ w, pendingCount, decidedCount }) => ({
      id: w.id,
      bountyId: w.bountyId,
      bountyTitle: w.bounty.title,
      // A real membership count. `pendingCount + decidedCount` would be wrong
      // now that the two answer different questions (claimability vs decided).
      itemCount: w.memberships.length,
      // HumanAuditWindow has no due-by field (closedAt is when the window's
      // selection was locked in, not a deadline for validators to decide by)
      // — null rather than a fabricated date.
      deadline: null,
      status: decidedCount > 0 ? "in_progress" : "available",
      decidedCount,
      category: w.bounty.datasetCategory,
      language: w.bounty.language,
      kind: "community" as const,
      karmaReward: VALIDATOR_KARMA_PER_DECISION,
    })),
    total,
    conflictExcluded,
    conflictExcludedByReason,
    limit: take,
    offset: params.cursor ? null : skip,
    hasMore,
    nextCursor:
      hasMore && lastRow
        ? encodeCursor(String(lastRow.w.closedAt.getTime()), lastRow.w.id, filterKey)
        : null,
  };
}

/** Bucket names GET /v1/me/audits accepts on `status` and returns on each
 * row — chosen to match `lib/types.ts` `AuditBatchStatus` on the web client
 * (`claimed` | `overdue_review` | `completed`), not the raw `HumanAuditWindow`
 * columns underneath. "overdue" (no `_review` suffix) is accepted as an alias
 * on the query param, since that is the label the validator workspace's
 * PillTabs filter sends (`app/(app)/validator/view.tsx` AUDIT_HISTORY_STATUSES),
 * while the value actually stamped on a row is the fuller `overdue_review`. */
export type MyAuditWindowStatus = "claimed" | "overdue_review" | "completed";

function myAuditWindowStatusWhere(status: string | undefined, now: Date): Prisma.HumanAuditWindowWhereInput {
  if (status === "completed") return { settledAt: { not: null } };
  if (status === "overdue" || status === "overdue_review") {
    return { settledAt: null, claimExpiresAt: { lt: now } };
  }
  if (status === "claimed" || status === "in_progress") {
    return { settledAt: null, OR: [{ claimExpiresAt: null }, { claimExpiresAt: { gte: now } }] };
  }
  return {};
}

/**
 * A validator's own claimed/decided audit history — GET /v1/me/audits.
 * Direct port of v1's `GET /me/audits` (v1 databounty-api routes/v1/me.ts:976,
 * `AuditBatch.validatorUserId`) onto this schema's `HumanAuditWindow`, now
 * that T1 (claimAuditWindow above) gives every window real
 * `claimedByUserId`/`claimedAt`/`claimExpiresAt` columns to scope by. Bucketing
 * has no stored status column to filter on (unlike v1's `AuditBatch.status`
 * string), so it is derived from `settledAt`/`claimExpiresAt` at query time —
 * see `myAuditWindowStatusWhere`. A window whose claim was fully released by
 * the reaper (`releaseOverdueAudits`, `claimedByUserId` cleared) correctly
 * drops out of this list entirely: it is no longer this validator's claim, the
 * same way v1's row disappears once `AuditBatch.validatorUserId` is nulled.
 */
export function myAuditWindowsFilterKey(params: {
  validatorUserId: string;
  status?: string;
  search?: string;
}): string {
  // `status` is bucketed, not stored: "overdue" and "overdue_review" select the
  // same rows, and anything unrecognised means "no filter". Bind the cursor to
  // the EFFECTIVE bucket so a walk is not refused for a spelling that changed
  // nothing.
  const bucket =
    params.status === "completed"
      ? "completed"
      : params.status === "overdue" || params.status === "overdue_review"
        ? "overdue"
        : params.status === "claimed" || params.status === "in_progress"
          ? "claimed"
          : "";
  return filterKeyOf(["my-audits", params.validatorUserId, bucket, (params.search ?? "").trim().slice(0, 160)]);
}

/**
 * Strictly-after predicate for the ordering
 * `[settledAt asc, claimedAt desc, id desc]`.
 *
 * Three keys, two of them nullable, so this cannot be a single comparison.
 * Postgres puts NULLs LAST for ASC and FIRST for DESC, and Prisma inherits
 * that, so:
 *  - settled rows (settledAt non-null) come before unsettled ones;
 *  - within a settledAt group, a null claimedAt sorts before any timestamp.
 * Each OR branch below is one "we are past this key, so everything in the next
 * key's range qualifies" step. Getting this wrong is not a cosmetic bug: a
 * missing branch silently DROPS rows from a walk, which reads to the caller
 * exactly like "there was no more work".
 */
function myAuditWindowsAfter(position: {
  settledAt: Date | null;
  claimedAt: Date | null;
  id: string;
}): Prisma.HumanAuditWindowWhereInput[] {
  const withinGroup = (group: Prisma.HumanAuditWindowWhereInput): Prisma.HumanAuditWindowWhereInput[] =>
    position.claimedAt === null
      ? [
          // Cursor row has no claimedAt, so it is at the FRONT of its group:
          // the rest of the null-claimedAt rows (by id), then every timestamped one.
          { ...group, claimedAt: null, id: { lt: position.id } },
          { ...group, claimedAt: { not: null } },
        ]
      : [
          { ...group, claimedAt: { lt: position.claimedAt } },
          { ...group, claimedAt: position.claimedAt, id: { lt: position.id } },
        ];

  if (position.settledAt === null) {
    // Unsettled rows are the LAST group; nothing follows it.
    return withinGroup({ settledAt: null });
  }
  return [
    ...withinGroup({ settledAt: position.settledAt }),
    { settledAt: { gt: position.settledAt } },
    { settledAt: null },
  ];
}

export async function listMyAuditWindows(params: {
  validatorUserId: string;
  status?: string;
  search?: string;
  limit?: number;
  skip?: number;
  /** Stable keyset cursor. `skip` is kept for existing REST callers but is NOT
   * stable — a window settling mid-walk re-buckets it and shifts every later
   * row, so an offset walk repeats or skips audits. */
  cursor?: string;
}) {
  const now = new Date();
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const skip = Math.max(params.skip ?? 0, 0);
  const search = (params.search ?? "").trim().slice(0, 160);
  const filterKey = myAuditWindowsFilterKey(params);
  const position = params.cursor ? decodeMyAuditCursor(params.cursor, filterKey) : null;

  const where: Prisma.HumanAuditWindowWhereInput = {
    claimedByUserId: params.validatorUserId,
    ...myAuditWindowStatusWhere(params.status, now),
    ...(search ? { bounty: { title: { contains: search, mode: "insensitive" } } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.humanAuditWindow.findMany({
      where: position ? { ...where, OR: myAuditWindowsAfter(position) } : where,
      include: {
        bounty: { select: { title: true, datasetCategory: true, language: true } },
        memberships: {
          where: { selected: true },
          select: { submissionId: true, submission: { select: { status: true } } },
        },
      },
      // Active claims first (most actionable), newest claim within each
      // bucket first — mirrors v1's `orderBy: [{ status: "asc" }, { claimedAt:
      // "desc" }]` (v1 me.ts:1018) as closely as a derived-status model allows.
      // `id` appended so the ordering is TOTAL — two windows claimed in the
      // same millisecond otherwise have no defined relative order and a keyset
      // cursor naming one of them cannot say which rows follow.
      orderBy: [{ settledAt: "asc" }, { claimedAt: "desc" }, { id: "desc" }],
      ...(position ? {} : { skip }),
      take: limit + 1,
    }),
    prisma.humanAuditWindow.count({ where }),
  ]);

  const { items: windows, hasMore } = takePage(rows, limit);
  const lastWindow = windows[windows.length - 1];
  const decidedIds = await decidedSubmissionIds(windows.flatMap((w) => w.memberships.map((m) => m.submissionId)));

  return {
    audits: windows.map((w) => {
      // Real decisions, not `status !== in_audit` — see the note in
      // listAvailableAudits. This is the third of three definitions of
      // "decided" that used to disagree with each other; all three now read
      // the same table through the same predicate.
      const decidedCount = w.auditBatchId != null
        ? w.memberships.filter((m) => decidedIds.has(m.submissionId)).length
        : w.memberships.filter((m) => DECIDED_SUBMISSION_STATUSES.includes(m.submission.status)).length;
      const status: MyAuditWindowStatus = w.settledAt
        ? "completed"
        : w.claimExpiresAt && w.claimExpiresAt < now
          ? "overdue_review"
          : "claimed";
      return {
        id: w.id,
        bountyId: w.bountyId,
        bountyTitle: w.bounty.title,
        itemCount: w.memberships.length,
        deadline: w.claimExpiresAt ? w.claimExpiresAt.toISOString() : null,
        status,
        decidedCount,
        category: w.bounty.datasetCategory,
        language: w.bounty.language,
        kind: "community" as const,
        karmaReward: VALIDATOR_KARMA_PER_DECISION,
        // A superseded window is still YOUR claim and stays listed — deleting
        // it from the validator's own history would erase the record that they
        // ever held it. But `loadWindowDetailForValidator` hard-rejects it
        // (`if (!window || window.supersededAt) return null`), so the detail
        // route 404s. Without this flag the client cannot tell the difference
        // and renders a live "Start audit" link onto a guaranteed dead end,
        // whose 404 copy then blames three causes that are all wrong ("doesn't
        // exist, already settled, or contains a submission you authored").
        // Surfaced so the client can render it as a tombstone instead. Not
        // folded into `status`: that union is the user-facing filter
        // (claimed / overdue_review / completed) and superseding is orthogonal
        // to it — a window can be superseded in any of those states.
        supersededAt: w.supersededAt ? w.supersededAt.toISOString() : null,
        supersededReason: w.supersededReason,
      };
    }),
    total,
    limit,
    skip: position ? null : skip,
    hasMore,
    nextCursor:
      hasMore && lastWindow
        ? encodeCursor(
            `${lastWindow.settledAt ? lastWindow.settledAt.toISOString() : ""}~${lastWindow.claimedAt ? lastWindow.claimedAt.toISOString() : ""}`,
            lastWindow.id,
            filterKey,
          )
        : null,
  };
}

/** Decodes the composite `settledAt~claimedAt` key `listMyAuditWindows` mints. */
function decodeMyAuditCursor(token: string, filterKey: string) {
  const { key, id } = decodeCursor(token, filterKey, "audit");
  const [settledRaw = "", claimedRaw = ""] = key.split("~");
  const toDate = (raw: string): Date | null => {
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new InvalidCursorError("Invalid audit cursor.");
    return parsed;
  };
  return { settledAt: toDate(settledRaw), claimedAt: toDate(claimedRaw), id };
}

/**
 * Cheap counts for the validator-dashboard stat rail — same
 * `claimedByUserId` scoping as `listMyAuditWindows` but as three aggregate
 * queries instead of loading full rows, since the dashboard only needs the
 * numbers (`GET /v1/me/validator-dashboard` `workSummary.validator`). Was
 * previously hardcoded to `{ claimedBatches: 0, completedBatches: 0,
 * pendingDecisions: 0 }` for the same reason `listMyAuditWindows` used to
 * return `[]` — no claim column existed yet to count against.
 */
export async function getMyAuditWorkSummary(validatorUserId: string) {
  const [claimedBatches, completedBatches, pendingDecisions, activeClaimedBatches] = await Promise.all([
    // Lifetime "TOTAL CLAIMED" stat (view.tsx) — every window this validator
    // has ever claimed, superseded or not. A corrective backfill retiring a
    // window does not erase the historical fact that they claimed it.
    prisma.humanAuditWindow.count({ where: { claimedByUserId: validatorUserId } }),
    prisma.humanAuditWindow.count({ where: { claimedByUserId: validatorUserId, settledAt: { not: null } } }),
    prisma.humanAuditWindowMembership.count({
      where: {
        selected: true,
        submission: { status: SubmissionStatus.in_audit },
        // A superseded window's items were re-routed into a later one and
        // the detail route hard-rejects the window itself, so nothing under
        // it can actually be decided by this validator any more — counting
        // it here would tell them decisions are "pending" that they have no
        // way to ever make.
        window: { claimedByUserId: validatorUserId, settledAt: null, supersededAt: null },
      },
    }),
    // The client's capacity-gate display (`claimedAuditCount`, view.tsx) must
    // use the SAME predicate the server enforces in `activeClaimedWindowWhere`
    // (claimAuditWindow's capacity check), not a `claimedBatches -
    // completedBatches` approximation — that subtraction still counted a
    // superseded-but-unsettled window as an occupied slot, which is exactly
    // how a validator holding one retired window could read "at capacity"
    // with no new work claimable and no way to free the slot themselves.
    prisma.humanAuditWindow.count({
      where: activeClaimedWindowWhere(validatorUserId, new Date()),
    }),
  ]);
  return { claimedBatches, completedBatches, pendingDecisions, activeClaimedBatches };
}

/**
 * Shared window-detail loader. Returns `null` when the window doesn't exist,
 * is no longer active, or contains any of this validator's own submissions
 * (see listAvailableAudits for why that hides the whole window rather than
 * just those rows) — the same three cases the old `getAuditWindowById`
 * folded into one `null`. Kept private: `getAuditWindowById` below preserves
 * that exact null-or-detail contract for existing callers (src/mcp/tools.ts),
 * while `getClaimedAuditWindowDetail` layers claim-gating on the same data
 * with distinct, honest reasons for the REST route (409 unclaimed vs 403
 * someone-else's, mirroring v1 routes/v1/audits.ts:339-340) — a distinction
 * MCP's `get_audit`/`claim_audit` tools have no way to surface without a
 * matching MCP-side claim tool, which is out of this file's scope (src/mcp/**
 * is owned by another agent). MCP therefore keeps its pre-claim visibility
 * behavior unchanged: any non-conflicted validator can still view any window
 * through MCP, claimed or not. That is a real, pre-existing REST/MCP parity
 * gap, not something newly introduced here.
 */
async function loadWindowDetailForValidator(windowId: string, validatorUserId: string) {
  const window = await prisma.humanAuditWindow.findUnique({
    where: { id: windowId },
    include: {
      bounty: { include: { datasetType: true } },
      memberships: {
        where: { selected: true },
        include: {
          submission: {
            include: {
              validationResults: { orderBy: { createdAt: "desc" } },
              flags: { orderBy: { createdAt: "desc" } },
            },
          },
        },
      },
    },
  });
  if (!window || window.supersededAt) return null;
  if (window.memberships.some((m) => m.submission.contributorUserId === validatorUserId)) return null;

  const submissionIds = window.memberships.map((m) => m.submissionId);

  // The AUTHORITATIVE record of a validator decision. `AuditItem` has no
  // status column: a decision is the PAIR (`verdict`, `decidedAt`), written
  // together at submitAuditDecisions and cleared together by
  // reopenAuditItemForReview. This read used to skip the table entirely and
  // re-derive the verdict from `Submission.status` (see the note at the
  // mapping below), which reported machine rejections as human verdicts.
  // Ordered decided-first/newest-first so the first row per submission is the
  // latest real decision.
  const auditItems = submissionIds.length
    ? await prisma.auditItem.findMany({
        where: { submissionId: { in: submissionIds } },
        orderBy: { decidedAt: { sort: "desc", nulls: "last" } },
      })
    : [];
  const decisionBySubmission = new Map<string, (typeof auditItems)[number]>();
  for (const item of auditItems) {
    // First-wins over the descending order above = the latest decision.
    if (!decisionBySubmission.has(item.submissionId)) decisionBySubmission.set(item.submissionId, item);
  }

  const artifacts = submissionIds.length
    ? await prisma.artifact.findMany({
        where: {
          submissionId: { in: submissionIds },
          kind: { in: [ArtifactKind.submission_attachment, ArtifactKind.validation_log] },
          status: { not: ArtifactStatus.deleted },
        },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const attachmentsBySubmission = new Map<string, Artifact[]>();
  const logsBySubmission = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    if (!a.submissionId) continue;
    const bucket = a.kind === ArtifactKind.validation_log ? logsBySubmission : attachmentsBySubmission;
    const list = bucket.get(a.submissionId) ?? [];
    list.push(a);
    bucket.set(a.submissionId, list);
  }

  // "Decided" means a real validator decision exists — NOT a submission
  // status. Three different status-based definitions used to coexist
  // (`!== in_audit` in listAvailableAudits and listMyAuditWindows, a
  // four-status allowlist here), so a membership in `needs_fixes` counted
  // decided in the list and pending on this page: the card said "3 / 3 (100%)"
  // while the header said "2 of 3 reviewed". All three now agree because they
  // all ask the same question of the same table.
  // A window only HAS AuditItems when it has a linked AuditBatch — the same
  // condition submitAuditDecisions guards its AuditItem write with. Read and
  // write must agree on that, or one of them is talking about rows that
  // cannot exist:
  //   - linked   ⇒ AuditItem is authoritative, and its ABSENCE genuinely
  //                means "no validator decided this".
  //   - unlinked ⇒ no AuditItem can ever exist (every window closed before
  //                the batch alignment, which as of 2026-09-04 is ALL 11
  //                windows and all 0 audit_items in community_test). Falling
  //                back to the status derivation keeps those readable instead
  //                of relabelling every settled legacy window as pending.
  // `verdictSource` is reported per item so a surface can tell a real
  // recorded decision from a derived one rather than presenting both as
  // equally certain. See the gap note in
  // docs/engineering/AI_ATTRIBUTION_AND_PROVENANCE.md.
  const hasAuditItems = window.auditBatchId != null;
  const decidedCount = hasAuditItems
    ? window.memberships.filter((m) => isDecidedAuditItem(decisionBySubmission.get(m.submissionId))).length
    : window.memberships.filter((m) => DECIDED_SUBMISSION_STATUSES.includes(m.submission.status)).length;

  // The validator audit view renders an LLM evidence card for every item even
  // when no `llm` ValidationResult row exists — an auditor deciding an item
  // must be TOLD the machine review never happened rather than shown an
  // absent card. That card needs the platform switch to say WHY it never
  // happened, and an absent row alone cannot distinguish "switched off" from
  // "on but nothing recorded yet". Read once per window (a settings row, not
  // per submission) and attached to each item's submission object below, which
  // is exactly where the UI reads it from
  // (apps/web/app/(app)/validator/audit/[id]/view.tsx: `apiSubmission?.
  // llmValidationEnabled`). `llmProviderConfigured` is the separate
  // provider-key fact; the two are never merged.
  const llmEnabled = await llmValidationEnabled();
  const llmProviderConfigured = openRouterConfigured();
  // Validators use the same sponsor-owned brief as contributors. Keep this
  // query on the shared artifact policy so only ready, approved, released
  // reference files reach the audit UI; never derive a preview from a
  // DatasetType-level catalog example.
  const sponsorReferences = await listBountyBriefArtifacts(window.bountyId);

  return {
    id: window.id,
    bountyId: window.bountyId,
    itemCount: window.memberships.length,
    // Real claim-to-decision SLA now that the window is claimable (T1) —
    // previously always null.
    deadline: window.claimExpiresAt ? window.claimExpiresAt.toISOString() : null,
    claimedByUserId: window.claimedByUserId,
    claimedAt: window.claimedAt ? window.claimedAt.toISOString() : null,
    claimExpiresAt: window.claimExpiresAt ? window.claimExpiresAt.toISOString() : null,
    status: window.settledAt
      ? "completed"
      : decidedCount > 0
        ? "in_progress"
        : window.claimedByUserId
          ? "claimed"
          : "available",
    kind: "community" as const,
    karmaReward: VALIDATOR_KARMA_PER_DECISION,
    // No ContributorBatch backs a community open-pool submission — nothing
    // honest to report here.
    contributorBatch: null,
    bounty: {
      id: window.bounty.id,
      title: window.bounty.title,
      category: window.bounty.datasetCategory,
      language: window.bounty.language,
      framework: window.bounty.framework,
      datasetType: window.bounty.datasetType,
      poolSummary: null,
    },
    publication: null,
    poolSummary: null,
    items: window.memberships.map((m) => {
      const sub = m.submission;
      // Read the AuditItem, never re-derive from `Submission.status`. The old
      // derivation mapped `DECIDED_SUBMISSION_STATUSES` (flagged | disputed |
      // rejected | accepted) onto a verdict, so:
      //   - an item auto-rejected by machine (execution fail, dedupe
      //     `rejected`, or the pool-full path validation.ts itself calls "not
      //     a quality rejection") was reported as `verdict: "flagged"` — a
      //     human verdict that was never cast;
      //   - an item ACCEPTED by pool sampling was reported as `verdict: "ok"`;
      //   - an item under active DISPUTE rendered as decided, with its
      //     Approve/Reject controls hidden and no AuditItem backing it.
      // `flagReason`/`note` came off `sub.flags[0]` for the same reason, so an
      // unrelated or stale flag was attributed to a decision that never
      // happened; they now come off the decision row itself.
      const decision = decisionBySubmission.get(sub.id);
      const recorded = isDecidedAuditItem(decision);
      // Legacy fallback ONLY where no AuditItem can exist (see above). Where
      // one can, a missing decision means undecided — never a verdict
      // reconstructed from `Submission.status`, which is what wrongly reported
      // machine rejections and pool-sampling acceptances as human verdicts.
      const derivedDecided = !hasAuditItems && DECIDED_SUBMISSION_STATUSES.includes(sub.status);
      const verdict = recorded
        ? decision!.verdict
        : derivedDecided
          ? sub.status === SubmissionStatus.accepted
            ? AuditVerdict.ok
            : AuditVerdict.flagged
          : null;
      const decided = recorded || derivedDecided;
      const flag = sub.flags[0];
      return {
        id: m.id,
        submissionId: sub.id,
        verdict,
        // Sent so a client can apply the same both-fields rule instead of
        // keying on `verdict` alone (it previously had no way to).
        decidedAt: recorded ? decision!.decidedAt!.toISOString() : derivedDecided ? (window.settledAt?.toISOString() ?? null) : null,
        // Which of the two the caller is looking at. Never merged into one
        // "decided" boolean — a derived verdict is an inference, not a record.
        verdictSource: recorded ? ("audit_item" as const) : derivedDecided ? ("derived_from_status" as const) : null,
        flagReason:
          verdict === AuditVerdict.flagged ? (recorded ? (decision!.flagReason ?? null) : (flag?.reason ?? null)) : null,
        note: verdict === AuditVerdict.flagged ? (recorded ? (decision!.note ?? null) : (flag?.details ?? null)) : null,
        submission: { ...sub, llmValidationEnabled: llmEnabled, llmProviderConfigured },
        attachments: (attachmentsBySubmission.get(sub.id) ?? []).map(toApiArtifact),
        validationLogs: (logsBySubmission.get(sub.id) ?? []).map(toApiArtifact),
      };
    }),
    sponsorReferences: sponsorReferences.map(toApiArtifact),
    // Also at the top level, for a caller that wants the window-wide answer
    // without picking an arbitrary item — same value, one read.
    llmValidationEnabled: llmEnabled,
    llmProviderConfigured,
  };
}

/**
 * Full detail for one HumanAuditWindow, shaped for the validator review UI.
 * Returns null when the window doesn't exist, is no longer active, or
 * contains any of this validator's own submissions. UNCHANGED contract —
 * still no claim-gating — because src/mcp/tools.ts (owned elsewhere) calls
 * this directly and treats null as its only failure signal; see the comment
 * on loadWindowDetailForValidator for why REST gets the stricter
 * getClaimedAuditWindowDetail instead.
 */
export async function getAuditWindowById(windowId: string, validatorUserId: string) {
  return loadWindowDetailForValidator(windowId, validatorUserId);
}

export type ClaimedAuditWindowDetailResult =
  | { reason: "ok"; detail: NonNullable<Awaited<ReturnType<typeof loadWindowDetailForValidator>>> }
  | { reason: "not_found" }
  | { reason: "forbidden" }
  | { reason: "unclaimed" }
  | { reason: "claimed_by_other" };

/**
 * REST-only detail lookup that gates evidence behind the claim (T1): a
 * validator must hold this window before seeing item payloads/attachments/
 * validation logs. `not_found`/`forbidden` cover the same not-exists/
 * superseded/self-conflict cases `getAuditWindowById` folds into `null`;
 * `unclaimed` (409) and `claimed_by_other` (403) are new, mirroring v1
 * routes/v1/audits.ts:339-340 exactly (`!audit.validatorUserId` → conflict,
 * `audit.validatorUserId !== user.id` → forbidden).
 */
export async function getClaimedAuditWindowDetail(
  windowId: string,
  validatorUserId: string
): Promise<ClaimedAuditWindowDetailResult> {
  const detail = await loadWindowDetailForValidator(windowId, validatorUserId);
  if (!detail) return { reason: "not_found" };
  if (!detail.claimedByUserId) return { reason: "unclaimed" };
  if (detail.claimedByUserId !== validatorUserId) return { reason: "claimed_by_other" };
  return { reason: "ok", detail };
}

/** 24h claim-to-decision SLA (owner requirement / VALIDATOR_PLAN.md parity
 * with v1's AuditBatch.deadline). */
export const CLAIM_SLA_MS = 24 * 60 * 60 * 1000;

export type ClaimAuditWindowResult =
  | {
      ok: true;
      window: {
        id: string;
        bountyId: string;
        bountyTitle: string;
        claimedByUserId: string;
        claimedAt: Date;
        claimExpiresAt: Date;
        itemCount: number;
        karmaReward: number;
      };
    }
  | { ok: false; reason: "not_found" | "forbidden" | "conflict" }
  | { ok: false; reason: "capacity"; maxConcurrentAudits: number; activeCount: number };

/**
 * Same predicate the "claimed slots" bucket on GET /v1/me/audits uses
 * (`myAuditWindowStatusWhere("claimed", now)` above) — a window this
 * validator holds that is neither settled nor past its claim SLA. This is
 * deliberately the exact query the validator workspace UI already reads to
 * render "N / M slots used" (`app/(app)/validator/view.tsx` activeAudits,
 * which folds its "claimed" and "in_progress" filter values onto this same
 * bucket), so server-side enforcement can never disagree with what the
 * validator is shown. An overdue-but-not-yet-reaped window (claimExpiresAt
 * in the past, claimedByUserId still set) is intentionally NOT counted here,
 * matching the UI's own "overdue_review" bucket being separate from
 * "claimed" — the reaper (`releaseOverdueAudits`) is what frees that slot for
 * real, this just mirrors the same live-state view the UI already commits to.
 */
function activeClaimedWindowWhere(validatorUserId: string, now: Date): Prisma.HumanAuditWindowWhereInput {
  return {
    claimedByUserId: validatorUserId,
    settledAt: null,
    // A corrective backfill re-routes a superseded window's items into a
    // later one and the validator can never open it again (the detail route
    // hard-rejects `supersededAt`, see loadWindowDetailForValidator) — so it
    // must not go on costing them a concurrent-claim slot. Before this, a
    // validator holding one retired window could be stuck at capacity unable
    // to claim any new work, with no way to ever release the slot themselves.
    supersededAt: null,
    OR: [{ claimExpiresAt: null }, { claimExpiresAt: { gte: now } }],
  };
}

/**
 * POST /v1/audits/:id/claim (T1). Ports v1's exclusive-claim semantics
 * (routes/v1/audits.ts:410-550, AuditBatch.validatorUserId) onto this
 * schema's HumanAuditWindow via the new nullable claimedByUserId/claimedAt/
 * claimExpiresAt columns:
 *
 *  - conflict-of-interest (own submission, or own bounty) is checked first
 *    and is never racy — a validator's own items don't change underneath
 *    a claim attempt.
 *  - exclusive ownership is a single conditional `updateMany` keyed on
 *    `claimedByUserId: null`, not a read-then-write: Postgres serializes
 *    concurrent UPDATEs to the same row, so exactly one of two racing
 *    validators sees `count === 1`. This is the identical shape v1 uses
 *    (`AuditBatch.updateMany({ where: { status: "available", validatorUserId:
 *    null }, ... })`, v1 audits.ts:482) — no capacity-cap/rank-lock layer is
 *    ported here since this schema/product has no validator-rank concurrency
 *    cap to enforce (KARMA_RULES has no such limit).
 *  - a caller who already holds the window gets an idempotent success
 *    (re-clicking claim does not re-arm the SLA) rather than a spurious
 *    conflict — same as v1's `claimed.count !== 1 && audit.validatorUserId
 *    !== user.id` fallthrough.
 *  - a lost race always re-reads live state rather than trusting the
 *    pre-write snapshot, so the loser's response is never a lie even under
 *    a true concurrent double-claim attempt.
 *
 * CAPACITY (rank concurrency cap): the doc comment above used to say this
 * schema had no validator-rank concurrency cap to enforce — that was wrong.
 * `services/reputation.ts` VALIDATOR_RANK_TIERS/`validatorRankForAudits` IS
 * the real per-rank `maxConcurrentAudits` limit, and it is exactly what
 * `services/profile-summary.ts` (`ranks.validator.maxConcurrentAudits`)
 * already surfaces to the validator workspace UI as "claimed slots N/M".
 * Until now that UI-side gate was frontend-only decoration (see the removed
 * comment that used to sit on `activeAudits` in
 * `app/(app)/validator/view.tsx`): the claim route itself never checked it,
 * so a second tab, a direct API call, or an MCP client could claim past the
 * limit. The count-then-claim shape below is therefore made race-safe the
 * same way `claimPoolAcceptanceSlot` (services/pool-lifecycle.ts) makes its
 * counter race-safe — except the count here is derived from sibling
 * `HumanAuditWindow` rows rather than a single counter column, so a plain
 * conditional `UPDATE ... WHERE count < limit` isn't expressible in one
 * statement. Instead this serializes concurrent claim attempts BY THE SAME
 * VALIDATOR with a transaction-scoped Postgres advisory lock keyed on the
 * validator's own id (`pg_advisory_xact_lock(hashtext(...))`, the same
 * idiom already used by `lib/audit-log.ts` and `services/notifications.ts`
 * for other cross-row invariants). Two claims for two different windows
 * from the same validator now take that lock one at a time — the second
 * transaction blocks until the first COMMITs, then re-counts and sees the
 * first's newly-claimed window, so it correctly refuses if that pushed the
 * validator to their cap. Per-window exclusivity (the `updateMany` above)
 * still applies unchanged for the cross-validator race — Postgres already
 * serializes concurrent writers of the same row without any lock needed.
 */
export async function claimAuditWindow(params: {
  windowId: string;
  validatorUserId: string;
}): Promise<ClaimAuditWindowResult> {
  const window = await prisma.humanAuditWindow.findUnique({
    where: { id: params.windowId },
    select: {
      id: true,
      bountyId: true,
      settledAt: true,
      supersededAt: true,
      claimedByUserId: true,
      claimedAt: true,
      claimExpiresAt: true,
      bounty: { select: { title: true } },
      memberships: {
        where: { selected: true },
        // submissionId + duplicateOfSubmissionId feed the near-dup-of-own-work
        // check below, alongside the sponsor/own-submission check above.
        select: { submissionId: true, submission: { select: { status: true, contributorUserId: true, duplicateOfSubmissionId: true } } },
      },
    },
  });
  if (!window || window.supersededAt) return { ok: false, reason: "not_found" };

  // Shared with listAvailableAudits so the list can never offer a window this
  // returns a reason for.
  if (hasAuditConflict(window, params.validatorUserId)) return { ok: false, reason: "forbidden" };

  // Near-dup-of-own-work conflict — same predicate listAvailableAudits
  // applies (hasDuplicateOfOwnWorkConflict), so nothing the list withholds
  // for this reason can be claimed by going around it directly.
  const dupSets = await loadValidatorDuplicateConflictSets(params.validatorUserId);
  if (
    hasDuplicateOfOwnWorkConflict(
      window.memberships.map((m) => ({ submissionId: m.submissionId, duplicateOfSubmissionId: m.submission.duplicateOfSubmissionId })),
      dupSets
    )
  ) {
    return { ok: false, reason: "forbidden" };
  }

  const itemCount = window.memberships.length;
  const buildOk = (claimedByUserId: string, claimedAt: Date, claimExpiresAt: Date): ClaimAuditWindowResult => ({
    ok: true,
    window: {
      id: window.id,
      bountyId: window.bountyId,
      bountyTitle: window.bounty.title,
      claimedByUserId,
      claimedAt,
      claimExpiresAt,
      itemCount,
      karmaReward: VALIDATOR_KARMA_PER_DECISION,
    },
  });

  if (window.claimedByUserId === params.validatorUserId && window.claimedAt && window.claimExpiresAt) {
    // Idempotent re-claim: report the real stored claim, do not re-write it.
    return buildOk(params.validatorUserId, window.claimedAt, window.claimExpiresAt);
  }

  if (window.settledAt) return { ok: false, reason: "conflict" };
  const pendingCount = window.memberships.filter((m) => m.submission.status === SubmissionStatus.in_audit).length;
  if (pendingCount === 0) return { ok: false, reason: "conflict" }; // nothing left for anyone to claim/decide

  return prisma.$transaction(async (tx) => {
    // Serialize concurrent claim attempts BY THIS VALIDATOR (across any
    // windows) so the capacity check below can never race with itself — see
    // the CAPACITY section of this function's doc comment.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`audit-claim:${params.validatorUserId}`}))`;

    const rank = await tx.rank.findUnique({
      where: { userId: params.validatorUserId },
      select: { auditsCompleted: true },
    });
    const maxConcurrentAudits = validatorRankForAudits(rank?.auditsCompleted ?? 0).maxConcurrentAudits;

    const now = new Date();
    const activeCount = await tx.humanAuditWindow.count({
      where: activeClaimedWindowWhere(params.validatorUserId, now),
    });
    if (activeCount >= maxConcurrentAudits) {
      return { ok: false, reason: "capacity", maxConcurrentAudits, activeCount };
    }

    const claimedAt = new Date();
    const claimExpiresAt = new Date(claimedAt.getTime() + CLAIM_SLA_MS);

    const result = await tx.humanAuditWindow.updateMany({
      where: { id: window.id, claimedByUserId: null, settledAt: null, supersededAt: null },
      data: { claimedByUserId: params.validatorUserId, claimedAt, claimExpiresAt },
    });

    if (result.count === 1) return buildOk(params.validatorUserId, claimedAt, claimExpiresAt);

    // Lost the race (or the window was settled/superseded between the read
    // above and this write) — re-check live state rather than trust the
    // pre-write snapshot.
    const fresh = await tx.humanAuditWindow.findUnique({
      where: { id: window.id },
      select: { claimedByUserId: true, claimedAt: true, claimExpiresAt: true },
    });
    if (fresh?.claimedByUserId === params.validatorUserId && fresh.claimedAt && fresh.claimExpiresAt) {
      return buildOk(params.validatorUserId, fresh.claimedAt, fresh.claimExpiresAt);
    }
    return { ok: false, reason: "conflict" };
  });
}

/** Thrown by submitAuditDecisions when nobody has claimed the window yet.
 * The route maps this to 409, mirroring v1's `!audit.validatorUserId` ->
 * conflict (routes/v1/audits.ts:601). */
export class AuditWindowNotClaimedError extends Error {}
/** Thrown when the caller is not the window's claimant. The route maps this
 * to 403, mirroring v1's `audit.validatorUserId !== user.id` -> forbidden
 * (routes/v1/audits.ts:600). */
export class AuditWindowClaimedByOtherError extends Error {}
/** Thrown when a `flagged` verdict arrives without a usable note. The route
 *  and the MCP tool both map this to 400: it is a caller mistake with an
 *  obvious fix, and the message names the rule. */
export class AuditFlagNoteRequiredError extends Error {}
/** Thrown when the window id itself doesn't resolve. The route maps this to
 * 404; a caller-visible, actionable condition, not an internal failure. */
export class AuditWindowNotFoundError extends Error {}
/** Thrown once the window has already been settled — decisions are final.
 * The route maps this to 409. */
export class AuditWindowSettledError extends Error {}
/** Thrown when the window was superseded (e.g. by a later pool/pilot
 * transition) before these decisions landed. The route maps this to 409. */
export class AuditWindowSupersededError extends Error {}
/** Thrown when a decision names an item id that isn't part of this window —
 * a caller mistake (stale/foreign id), not a server failure. The route maps
 * this to 400. */
export class AuditItemNotInWindowError extends Error {}
/** Thrown when a validator tries to decide their own submission. The route
 * maps this to 403, mirroring the same conflict-of-interest rule enforced at
 * claim time. */
export class AuditOwnSubmissionError extends Error {}
/** Thrown when the targeted item was already decided (by this validator, a
 * concurrent request, or a previous call) before this one landed. The route
 * maps this to 409 — a real current-state conflict, not a bad request. */
export class AuditItemAlreadyDecidedError extends Error {}

/**
 * Every error thrown by this function's pre-flight checks (before the write
 * transaction) is one of the typed classes above — deliberate, actionable,
 * caller-facing conditions that both the REST route and the MCP tool need to
 * tell apart from a genuinely unexpected failure (see safeMcpErrorMessage()
 * in mcp/core/errors.ts and the app's global setErrorHandler in app.ts,
 * which is the ONLY place a bare, unclassified Error should ever surface its
 * raw message). A bare `throw new Error(...)` here would be indistinguishable
 * from an unrelated internal failure (a DB timeout, a Prisma error) at every
 * call site, which is exactly what let one such failure — the
 * AUDIT_DECISIONS_TRANSACTION_TIMEOUT_MS incident's underlying transaction
 * timeout — reach the browser UI and the MCP client as a raw, unexplained
 * string instead of either a safe curated message or the generic
 * "unexpected error" fallback both surfaces already have for exactly that
 * case.
 */
export async function submitAuditDecisions(params: {
  windowId: string;
  validatorUserId: string;
  decisions: Array<{
    auditItemId: string;
    verdict: AuditVerdict;
    flagReason?: FlagReason;
    note?: string;
  }>;
}) {
  const window = await prisma.humanAuditWindow.findUnique({
    where: { id: params.windowId },
    include: {
      bounty: { include: { datasetType: true } },
      memberships: {
        where: { selected: true },
        include: { submission: { select: { id: true, status: true, contributorUserId: true, title: true } } },
      },
    },
  });

  if (!window) throw new AuditWindowNotFoundError("Audit window not found");
  if (window.settledAt) throw new AuditWindowSettledError("Audit window has already been settled");
  if (window.supersededAt) throw new AuditWindowSupersededError("Audit window is no longer active");
  // T1: decisions may only be recorded by the window's claimant — the same
  // ownership check the claim endpoint enforces, applied again here so a
  // second validator can never decide items in a window someone else holds
  // (v1 routes/v1/audits.ts:600-601).
  if (!window.claimedByUserId) throw new AuditWindowNotClaimedError("claim the audit window before submitting decisions");
  if (window.claimedByUserId !== params.validatorUserId) {
    throw new AuditWindowClaimedByOtherError("audit window is claimed by another validator");
  }

  const membershipById = new Map(window.memberships.map((m) => [m.id, m]));

  // Validate every decision before writing any of them, so a bad item in the
  // middle of a batch can never leave earlier ones half-applied.
  for (const dec of params.decisions) {
    const membership = membershipById.get(dec.auditItemId);
    if (!membership) throw new AuditItemNotInWindowError(`Item ${dec.auditItemId} is not part of this audit`);
    if (membership.submission.contributorUserId === params.validatorUserId) {
      throw new AuditOwnSubmissionError("You cannot audit your own submission");
    }
    if (membership.submission.status !== SubmissionStatus.in_audit) {
      throw new AuditItemAlreadyDecidedError("This item has already been decided");
    }
    if (dec.verdict === AuditVerdict.flagged && (!dec.note || dec.note.trim().length < MIN_FLAG_NOTE_LENGTH)) {
      // A bare Error here is sanitized to a generic "could not be completed"
      // on the MCP path, so the validator was told nothing about the rule they
      // had just broken. Typed so every caller can surface the real reason.
      throw new AuditFlagNoteRequiredError(
        `A rejection note of at least ${MIN_FLAG_NOTE_LENGTH} characters is required, explaining what is wrong with the item.`
      );
    }
  }

  let rejectedCount = 0;
  let appliedCount = 0;
  const notifications: Array<() => Promise<unknown>> = [];

  // The claimable batch that carries this window's per-item verdict rows. Null
  // for any window closed before the AuditBatch alignment — those windows have
  // no batch and never will; their decisions apply normally and simply record
  // no historical row (see the write below).
  const auditBatchId = window.auditBatchId;

  // Real per-item pricing (KARMA_PRICING_MATRIX_PLAN.md) rather than the flat
  // `|| 25` / `KARMA_RULES.auditItem` fallbacks: `karmaPerAcceptedItem === 0`
  // on this pool means "auto-price this from the matrix". Computed once for
  // the whole decision batch — every item in a window belongs to the same
  // bounty, so the amount is identical for each accept in the loop below.
  const [{ rules: karmaRules }, { matrix: liveKarmaMatrix }] = await Promise.all([getKarmaRules(), getKarmaMatrix()]);
  const contributorTypePricing = effectiveTypePricing(window.bounty.datasetTypeId, window.bounty.datasetType, liveKarmaMatrix);
  const { amount: acceptedItemKarmaAmount } = acceptedItemKarmaForBounty(
    window.bounty.karmaPerAcceptedItem,
    window.bounty.poolDifficulty,
    window.bounty.karmaQuote,
    karmaRules,
    contributorTypePricing
  );
  const validatorKarmaPerDecision = validatorAuditKarmaPerItem(window.bounty, karmaRules);

  await prisma.$transaction(async (tx) => {
    for (const dec of params.decisions) {
      const membership = membershipById.get(dec.auditItemId)!;

      // Re-check-and-flip atomically inside the transaction: the pre-flight
      // validation above ran outside it, so a second validator (or a
      // duplicate click) deciding the same item between that check and this
      // write is still possible. Guarding the update with `status: in_audit`
      // and checking the affected-row count means only the first writer for
      // a given item wins; a loser skips its flag/counter/karma writes for
      // that item entirely instead of double-applying them.
      const newStatus = dec.verdict === AuditVerdict.flagged ? SubmissionStatus.flagged : SubmissionStatus.accepted;
      const claim = await tx.submission.updateMany({
        where: { id: membership.submissionId, status: SubmissionStatus.in_audit },
        data:
          newStatus === SubmissionStatus.accepted
            ? { status: newStatus, acceptedAt: new Date() }
            : { status: newStatus },
      });
      if (claim.count === 0) continue; // another writer already decided this item

      appliedCount++;

      // Record the decision itself, not just its consequence.
      //
      // Until this landed, a verdict was never stored: it was re-derived from
      // `submissions.status` (see stageView/`AuditVerdict` usage below), and
      // the validator's `note` was used ONLY on the flagged branch — where it
      // becomes `Flag.details`. An APPROVING validator's note was accepted by
      // this function's own input schema and then silently discarded, because
      // `flags` has no row for an accepted submission and nothing else had a
      // field for it. That is not hypothetical: the 16,988 audit items migrated
      // from v1 carry 1,287 notes, and 422 of them are on `verdict: ok` items
      // that this deployment could not have represented at all.
      //
      // `updateMany` guarded on `decidedAt: null` rather than `update`: the
      // submission-status flip above is the authority on who won the race, but
      // this write must not clobber an already-recorded decision if the guard
      // above is ever loosened. A batch whose window has no linked AuditBatch
      // (every window closed before this alignment) simply matches nothing —
      // the decision still applies, it just has no historical row, which is
      // honest rather than back-filled with an invented timestamp.
      if (auditBatchId) {
        await tx.auditItem.updateMany({
          where: { auditBatchId, submissionId: membership.submissionId, decidedAt: null },
          data: {
            verdict: dec.verdict,
            flagReason: dec.verdict === AuditVerdict.flagged ? (dec.flagReason ?? FlagReason.other) : null,
            note: dec.note ?? null,
            decidedAt: new Date(),
          },
        });
      }

      if (dec.verdict === AuditVerdict.flagged) {
        rejectedCount++;
        await tx.flag.create({
          data: {
            submissionId: membership.submissionId,
            validatorUserId: params.validatorUserId,
            reason: dec.flagReason ?? FlagReason.other,
            details: dec.note,
            status: FlagStatus.open,
          },
        });

        // Contributor previously had no way to learn a validator rejected
        // their item short of polling their submissions list — the audit UI
        // tells the validator "rejected items return to their contributor
        // for revision" but nothing actually told the contributor.
        notifications.push(() =>
          notifyUser({
            userId: membership.submission.contributorUserId,
            type: "submission.flagged",
            title: "A validator flagged your submission",
            body: dec.note
              ? `Your submission was flagged for review: ${dec.note}`
              : "Your submission was flagged for review by a validator.",
            entityType: "Submission",
            entityId: membership.submissionId,
            linkBountyId: window.bountyId,
          })
        );
      } else {
        // Bounty counters are recounted once after this loop (see below),
        // never incremented per item.

        // A validator-approved item is a real final acceptance — the
        // contributor's karma must land here too, same amount/idempotency
        // pattern as the pool-sampling "unselected → accepted" path in
        // services/pool-lifecycle.ts. This was previously missing: only the
        // validator got karma for a decision, never the contributor whose
        // work was actually accepted. Routed through the hold-then-release
        // gate so this validator-approve path also respects the sponsor's
        // dispute window instead of paying out immediately.
        const karmaResult = await awardOrHoldAcceptedItemKarma(tx, {
          bountyId: window.bountyId,
          userId: membership.submission.contributorUserId,
          eventType: KarmaEventType.community_item_accepted,
          amount: acceptedItemKarmaAmount,
          sourceType: "Submission",
          sourceId: membership.submissionId,
          metadata: { bountyId: window.bountyId, windowId: window.id, title: membership.submission.title },
        });

        notifications.push(() =>
          notifyUser({
            userId: membership.submission.contributorUserId,
            type: "submission.accepted",
            title: "Your submission was accepted",
            body: karmaResult.held
              ? "A validator reviewed and accepted your submission. Karma is held until the dispute window closes, then credited to your balance."
              : "A validator reviewed and accepted your submission. Karma has been credited to your balance.",
            entityType: "Submission",
            entityId: membership.submissionId,
            linkBountyId: window.bountyId,
          })
        );
      }

      // Keyed per membership (audit item), not per window: the review UI
      // submits one decision at a time, so a per-window sourceId would make
      // awardKarma's (userId, eventType, sourceType, sourceId) idempotency
      // guard silently swallow every decision after the first one on the
      // same window.
      await awardKarma(tx, {
        userId: params.validatorUserId,
        eventType: KarmaEventType.community_audit_completed,
        amount: validatorKarmaPerDecision,
        sourceType: "HumanAuditWindowMembership",
        sourceId: membership.id,
        metadata: { bountyId: window.bountyId, windowId: window.id, submissionId: membership.submissionId },
      });
    }

    // Closes the schema-documented gap in services/profile-summary.ts: until
    // now nothing incremented Rank.auditsCompleted, so validator rank/next-rank
    // progress read 0 for every account no matter how much real audit work
    // they did. Only counts decisions that actually won their race above.
    if (appliedCount > 0) {
      await tx.rank.upsert({
        where: { userId: params.validatorUserId },
        update: { auditsCompleted: { increment: appliedCount } },
        create: { userId: params.validatorUserId, auditsCompleted: appliedCount },
      });

      // Every decision above changed the pool's counted set: an accept moves
      // an item into `finalAcceptedItems`, and a flag moves an `in_audit`
      // item OUT of the capacity set so its slot is released immediately
      // (COMMUNITY_OPEN_POOL_PLAN_V2 §3.2b). One recount for the whole batch
      // keeps both counters honest in one write instead of a per-item
      // increment that could only ever go up.
      await recomputeAcceptedItemCounters(tx, window.bountyId);
    }

    // Settle the window once every selected item has a decision. This call
    // may only complete part of it — nothing "claims" a window, so another
    // validator (or this one, in an earlier call) may have already decided
    // the rest — so re-check the live count rather than assuming this call
    // finished it.
    const remainingPending = await tx.humanAuditWindowMembership.count({
      where: { windowId: window.id, selected: true, submission: { status: SubmissionStatus.in_audit } },
    });

    if (remainingPending === 0) {
      const totalFlagged = await tx.humanAuditWindowMembership.count({
        where: {
          windowId: window.id,
          selected: true,
          submission: { status: { in: [SubmissionStatus.flagged, SubmissionStatus.disputed, SubmissionStatus.rejected] } },
        },
      });
      const failureThresholdPct = window.bounty.humanAuditFailureThresholdPct ?? 20;
      const isWindowFailed = window.quota > 0 && (totalFlagged / window.quota) * 100 >= failureThresholdPct;

      await tx.humanAuditWindow.update({
        where: { id: window.id },
        data: {
          settledAt: new Date(),
          rejectedSelectedCount: totalFlagged,
          failedAt: isWindowFailed ? new Date() : null,
        },
      });
    }
  }, { timeout: AUDIT_DECISIONS_TRANSACTION_TIMEOUT_MS });

  for (const send of notifications) await send();

  return { ok: true, windowId: window.id, decisionsCount: appliedCount, rejectedCount };
}
