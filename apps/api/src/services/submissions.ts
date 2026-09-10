// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
// `Prisma` is a value import (not `type`) because the atomic revision claim in
// reviseSubmission builds its status list with Prisma.sql/Prisma.join, and
// because the dedupe-race guard below (isSubmissionDedupeConflict) checks
// `instanceof Prisma.PrismaClientKnownRequestError`.
import { BountyKind, BountyStatus, GenerationMethod, Prisma, SubmissionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decodeDateCursor, encodeCursor, filterKeyOf, takePage } from "../lib/keyset-cursor.js";
import { acquireBountyLock } from "../lib/bounty-lock.js";
import { getAdminSetting } from "./admin-settings.js";
import { getPoolSubmitLimits, SubmissionItemLimitError } from "./submission-limits.js";
import { dbJobQueue } from "./jobs.js";
import { notifyEvent, notifyUser } from "./notifications.js";
import { bandsFromSignature, computeMinHashSignature, LSH_CONFIG } from "./dedup-lsh.js";
import {
  attachFileArtifacts,
  fileFieldsForBounty,
  type AttachRow,
  type ContractFieldLike,
} from "./artifact-attach.js";

/**
 * Name of the raw-SQL partial unique index that is the real, DB-level
 * backstop against two concurrent open-pool submissions landing with the
 * same (bounty, batch, dedupeKey) — see `20260902170000_init`'s "Partial
 * unique index: race-free duplicate guard" section. It is declared only in
 * raw SQL (Prisma cannot express a partial/expression index in
 * schema.prisma), so it is invisible to Prisma's own conflict resolution and
 * always surfaces to the caller as a raw P2002 unless explicitly caught.
 */
const DEDUPE_UNIQUE_INDEX = "submissions_bounty_batch_dedupe_key_active_unique";

/**
 * True iff `err` is exactly the P2002 this module's partial unique index
 * throws — never a false match on some other unrelated unique-constraint
 * violation, which must keep propagating unchanged.
 *
 * Shape verified empirically against this repo's actual Prisma 7.9.1 +
 * `@prisma/adapter-pg` combination (a raw-SQL, schema-undeclared index gets
 * no `err.meta.target` at all — the field Prisma populates for a
 * schema-declared `@@unique` — because Prisma's own conflict map has no entry
 * for it): `err.code === "P2002"`, `err.meta.modelName === "Submission"`, and
 * the actual index name lives one level down, inside the underlying pg driver
 * error the adapter forwards: `err.meta.driverAdapterError.cause.constraint.index`.
 * All three must match; do not loosen this to `code === "P2002"` alone, or a
 * genuinely different constraint violation would be silently reinterpreted as
 * "duplicate, reject" instead of propagating as the real error it is.
 */
function isDedupeUniqueConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== "P2002") return false;
  const meta = err.meta as
    | { modelName?: unknown; driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } }
    | undefined;
  if (meta?.modelName !== "Submission") return false;
  return meta.driverAdapterError?.cause?.constraint?.index === DEDUPE_UNIQUE_INDEX;
}

/**
 * The contributor-actionable statuses a submission may be revised from, at
 * parity with v1 (databounty-api routes/v1/submissions.ts REVISABLE).
 *
 * Before this, `reviseSubmission` gated on `needs_fixes` ALONE — and
 * `needs_fixes` is written in exactly one place (the sponsor-review reject
 * path, which only runs when a pool sets `auditCoveragePct === 0`). The two
 * rejection paths that actually occur in the community pipeline —
 * `tests_failed` (services/validation.ts) and validator-`flagged`
 * (services/audits.ts) — were therefore dead ends: the contributor could file
 * a dispute but could never simply fix the item and resubmit it.
 *
 * Widening the gate here is deliberately the whole fix: routing those two
 * states INTO `needs_fixes` instead would mean editing the validation and
 * audit services (which other owners hold) and would erase the distinction
 * between "automation failed you" and "a human flagged you" that the
 * contributor UI and the dispute path both read.
 */
export const REVISABLE_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.needs_fixes,
  SubmissionStatus.flagged,
  SubmissionStatus.rejected,
  SubmissionStatus.tests_failed,
];

/** Admin key holding the revision cap. Owned by services/admin-settings.ts;
 * read here through `getAdminSetting` with an explicit fallback so this path
 * behaves identically whether or not the catalog entry exists yet. */
const MAX_REVISIONS_KEY = "submissions.max_revisions";
/** Cap applied when the setting is absent or unusable. `0` means unlimited. */
export const DEFAULT_MAX_REVISIONS = 3;

/**
 * Revision attempts one submission gets before it is terminally rejected.
 * `0` = unlimited. Any non-integer/negative/unreadable value falls back to the
 * default rather than letting a bad settings row remove the cap entirely.
 */
export async function getMaxRevisions(): Promise<number> {
  try {
    const value = await getAdminSetting<unknown>(MAX_REVISIONS_KEY, DEFAULT_MAX_REVISIONS);
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_REVISIONS;
  } catch {
    // A database blip must not decide the cap.
    return DEFAULT_MAX_REVISIONS;
  }
}

/** Error carrying the HTTP shape the revise route should reply with, so the
 * route can answer 409 for a state/cap conflict instead of flattening every
 * failure into 400. */
export class ReviseSubmissionError extends Error {
  constructor(
    readonly code: "not_found" | "not_revisable" | "pool_closed" | "revision_cap_exceeded" | "concurrent_change",
    message: string,
  ) {
    super(message);
    this.name = "ReviseSubmissionError";
  }
}

/** Automated terminal outcomes that a contributor may ask the worker to run
 * again without changing the item. `flagged` is deliberately absent: it is a
 * validator decision and must stay on the revise/dispute path. */
export const AUTOMATED_RERUNNABLE_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.needs_fixes,
  SubmissionStatus.tests_failed,
  SubmissionStatus.rejected,
];

export class RerunValidationError extends Error {
  constructor(
    readonly code: "not_found" | "not_rerunnable" | "pool_closed" | "concurrent_change",
    message: string,
  ) {
    super(message);
    this.name = "RerunValidationError";
  }
}

export function computeDedupeKey(payload: unknown): string {
  const normalized = typeof payload === "string" ? payload.trim() : JSON.stringify(payload);
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Near-duplicate scoring on top of exact-hash dedup (see module header note
 * on `SubmissionLshBand`, dedup-lsh.ts). Finds every OTHER submission in the
 * same bounty that shares at least one LSH band with `bands`, then estimates
 * a real similarity per candidate directly from how many of the 16 bands it
 * shares — under the standard LSH banding model, P(band match) ≈ s^ROWS,
 * so `sharedBands / NUM_BANDS` inverted by that power is a real (not
 * fabricated) similarity estimate, not a fixed 0.0/1.0 flag. Returns the max
 * across all candidates, or 0 when there are none.
 *
 * This intentionally only needs each submission's own stored bands (not a
 * full signature column), matching what `SubmissionLshBand` already stores —
 * the sharedBands count IS the intersection size directly, since the query
 * below only matches rows whose (bandIndex, bandHash) equals one of ours.
 */
async function computeNearDupScore(
  bountyId: string,
  bands: { bandIndex: number; bandHash: string }[],
  excludeSubmissionId?: string,
  // Reads must run on the SAME client as the inserts they are interleaved
  // with: once a submit path is wrapped in an interactive transaction, a read
  // issued on the global client takes a different connection and cannot see
  // this call's own uncommitted rows, so item 2 of a bulk submit would score
  // as if item 1 had never been written.
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  if (bands.length === 0) return 0;
  const matches = await client.submissionLshBand.findMany({
    where: {
      OR: bands.map((b) => ({ bandIndex: b.bandIndex, bandHash: b.bandHash })),
      submission: {
        bountyId,
        // V1 parity (contamination.ts ~line 520): a rejected submission's
        // bands must never count as a near-dup candidate — otherwise a
        // legitimate, unrelated future item (or a corrected resubmission of
        // the same idea) gets its duplicateScore inflated by comparison
        // against content that was never actually accepted, for however
        // long its now-useless SubmissionLshBand rows happen to survive.
        status: { not: SubmissionStatus.rejected },
        ...(excludeSubmissionId ? { id: { not: excludeSubmissionId } } : {}),
      },
    },
    select: { submissionId: true },
  });
  if (matches.length === 0) return 0;

  const sharedBandsBySubmission = new Map<string, number>();
  for (const m of matches) {
    sharedBandsBySubmission.set(m.submissionId, (sharedBandsBySubmission.get(m.submissionId) ?? 0) + 1);
  }
  let maxShared = 0;
  for (const count of sharedBandsBySubmission.values()) {
    if (count > maxShared) maxShared = count;
  }
  if (maxShared === 0) return 0;

  const fraction = maxShared / LSH_CONFIG.numBands;
  return Math.pow(fraction, 1 / LSH_CONFIG.rowsPerBand);
}

/** Persists a newly-created submission's own LSH bands so future
 * submissions in the same bounty can find it as a near-dup candidate.
 * `skipDuplicates` makes this safe to call even if bands were somehow
 * already written for this submission id. */
async function writeLshBands(
  submissionId: string,
  bands: { bandIndex: number; bandHash: string }[],
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  if (bands.length === 0) return;
  await client.submissionLshBand.createMany({
    data: bands.map((b) => ({ submissionId, bandIndex: b.bandIndex, bandHash: b.bandHash })),
    skipDuplicates: true,
  });
}

/** Best-effort human-readable title for a raw dataset-field payload — the
 * open-pool item route (POST /v1/bounties/:id/items) takes bare payload
 * objects, not {title, payloadJson} like /v1/submissions, so nothing supplies
 * a title. Never fabricated content: picks an existing string field's real
 * value, or falls back to a generic ordinal label. */
function deriveItemTitle(payload: Record<string, unknown>, index: number): string {
  for (const key of ["title", "prompt", "name", "question", "task"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  const firstString = Object.values(payload).find((v) => typeof v === "string" && v.trim()) as string | undefined;
  if (firstString) return firstString.trim().slice(0, 120);
  return `Community submission ${index + 1}`;
}

/**
 * How long one intake transaction may hold its connection.
 *
 * Every open-pool intake path below now runs inside ONE interactive
 * transaction, because v1 attaches file artifacts in the same transaction as
 * the submission insert (submission-row-insert.ts:213) and an attach that
 * commits separately can leave accepted items whose files never bound. The
 * cost is that a large bulk submit (the REST bulk route caps at 500 items)
 * does its per-item work inside that transaction; Prisma's 5s default would
 * abort it with P2028 well before the route's own item cap is reached, which
 * would be a regression introduced by the fix rather than by the request.
 * 60s is above the slowest observed 500-item local run and still fails fast
 * on a genuine hang.
 */
const INTAKE_TRANSACTION_TIMEOUT_MS = 60_000;

/** Direct, no-claim submission to a community open pool
 * (COMMUNITY_OPEN_POOL_PLAN_V2) — backs POST /v1/bounties/:id/items. Reuses
 * the same dedupe-then-enqueue mechanics as createPoolSubmission/
 * submitPoolBatchItems below; the only difference is the request shape (raw
 * payload objects with one shared generationMethod, not per-item title/method). */
export async function createBountyPoolItems(params: {
  bountyId: string;
  contributorUserId: string;
  items: Record<string, unknown>[];
  generationMethod: GenerationMethod;
}) {
  const bounty = await prisma.bounty.findUnique({ where: { id: params.bountyId } });
  if (!bounty) throw new Error("This pool could not be found.");
  if (bounty.status !== BountyStatus.active) {
    throw new Error("This pool is not accepting contributions right now.");
  }
  const target = Number(bounty.targetItems);
  if (target > 0 && Number(bounty.acceptedItems) >= target) {
    throw new Error("This pool already reached its item target.");
  }

  return prisma.$transaction(async (tx) => {
    // C10 fix, layer 1: a per-bounty Postgres advisory transaction lock
    // (v1 parity — `withBountyDedupeLock`, services/contamination.ts there;
    // ported here as `acquireBountyLock`, lib/bounty-lock.ts). Held for the
    // rest of this transaction, so a second concurrent call against the SAME
    // bounty blocks here until this one commits or rolls back — by the time
    // it runs its own `existingDup` check below, this call's insert (or its
    // absence) is already visible, closing the READ COMMITTED TOCTOU gap.
    // Namespaced "dedupe" so this never queues behind the unrelated
    // "auditbatch" lock (services/audit-routing.ts) for the same bounty.
    // Different bounties never contend with each other.
    await acquireBountyLock(tx, params.bountyId, "dedupe");

    const fileFields = await fileFieldsForBounty(tx, params.bountyId);
    const createdSubmissions = [];
    const attachRows: AttachRow[] = [];

    for (let i = 0; i < params.items.length; i += 1) {
      const payload = params.items[i]!;
      const title = deriveItemTitle(payload, i);
      const dedupeKey = computeDedupeKey(payload);
      const existingDup = await tx.submission.findFirst({
        where: { bountyId: params.bountyId, dedupeKey, status: { not: SubmissionStatus.rejected } },
        select: { id: true },
      });
      const lshBands = bandsFromSignature(computeMinHashSignature(payload));
      const nearDupScore = existingDup ? 1.0 : await computeNearDupScore(params.bountyId, lshBands, undefined, tx);

      let sub;
      try {
        sub = await tx.submission.create({
          data: {
            bountyId: params.bountyId,
            contributorUserId: params.contributorUserId,
            title,
            payloadJson: payload as Prisma.InputJsonValue,
            generationMethod: params.generationMethod,
            dedupeKey,
            status: existingDup ? SubmissionStatus.rejected : SubmissionStatus.submitted,
            duplicateScore: nearDupScore,
            duplicateOfSubmissionId: existingDup?.id,
          },
        });
      } catch (err) {
        // C10 fix, layer 2 (defensive backstop only — with layer 1's lock
        // above, this branch should never execute in normal operation).
        // Anything that is not exactly this partial-unique-index conflict
        // must keep propagating unchanged, never be silently swallowed.
        if (!isDedupeUniqueConflict(err)) throw err;
        const winner = await tx.submission.findFirst({
          where: { bountyId: params.bountyId, dedupeKey, status: { not: SubmissionStatus.rejected } },
          select: { id: true },
        });
        sub = await tx.submission.create({
          data: {
            bountyId: params.bountyId,
            contributorUserId: params.contributorUserId,
            title,
            payloadJson: payload as Prisma.InputJsonValue,
            generationMethod: params.generationMethod,
            // The colliding dedupeKey belongs to whichever row just won the
            // race; persisting it again here would either re-violate the
            // same index (if that row is still active) or misrepresent this
            // row as the canonical holder of that key. Store no dedupeKey on
            // the loser instead of guessing.
            dedupeKey: null,
            status: SubmissionStatus.rejected,
            duplicateScore: 1.0,
            duplicateOfSubmissionId: winner?.id,
          },
        });
      }
      await writeLshBands(sub.id, lshBands, tx);

      // Read the actually-persisted status, not the pre-insert `existingDup`
      // read — the layer-2 catch above can flip this row to `rejected` after
      // that read was taken, and enqueueing a validation run for a row the
      // race just rejected would be wrong.
      if (sub.status === SubmissionStatus.submitted) {
        await dbJobQueue.enqueue(
          {
            type: "validation.run",
            idempotencyKey: `val:${sub.id}:0`,
            payload: { submissionId: sub.id, validationAttempt: 0 },
          },
          tx,
        );
      }

      createdSubmissions.push(sub);
      attachRows.push({ id: sub.id, payload });
    }

    // Bind the uploaded files to the rows that reference them, in the same
    // transaction as the inserts (v1 parity, see services/artifact-attach.ts).
    await attachFileArtifacts(tx, {
      rows: attachRows,
      fields: fileFields,
      bountyId: params.bountyId,
      // Open-pool contributions have no ContributorBatch
      // (COMMUNITY_OPEN_POOL_PLAN_V2); v1 passes the same NULL from
      // pool-submission.ts and the guard uses IS NOT DISTINCT FROM for it.
      contributorBatchId: null,
      userId: params.contributorUserId,
    });

    return createdSubmissions;
  }, { timeout: INTAKE_TRANSACTION_TIMEOUT_MS });
}

/** One member's submissions across every open pool they've contributed to,
 * grouped by bounty — backs GET /v1/me/pool-submissions (the contributor
 * dashboard's cross-pool "Recent activity" history, distinct from
 * listContributorPoolSubmissions below which scopes to a single pool). */
export async function listMyPoolSubmissionGroups(params: {
  contributorUserId: string;
  filter?: "all" | "action_needed" | "in_review" | "accepted";
  search?: string;
  page?: number;
  limit?: number;
}) {
  const ACTION_NEEDED: SubmissionStatus[] = [SubmissionStatus.needs_fixes, SubmissionStatus.tests_failed, SubmissionStatus.flagged, SubmissionStatus.rejected];
  const AUTOMATED: SubmissionStatus[] = [
    SubmissionStatus.draft,
    SubmissionStatus.submitted,
    SubmissionStatus.duplicate_check,
    SubmissionStatus.running_tests,
    SubmissionStatus.llm_validation,
  ];
  const VALIDATOR_AUDIT: SubmissionStatus[] = [SubmissionStatus.in_audit, SubmissionStatus.provisionally_accepted, SubmissionStatus.in_sponsor_review];

  const FILTER_STATUSES: Record<string, SubmissionStatus[] | undefined> = {
    all: undefined,
    action_needed: ACTION_NEEDED,
    in_review: [...AUTOMATED, ...VALIDATOR_AUDIT, SubmissionStatus.accepted_pending_sample, SubmissionStatus.disputed],
    accepted: [SubmissionStatus.accepted],
  };
  const statuses = FILTER_STATUSES[params.filter ?? "all"];
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(25, Math.max(1, params.limit ?? 6));
  const baseWhere: Prisma.SubmissionWhereInput = {
    contributorUserId: params.contributorUserId,
    // Open-pool contributions have no ContributorBatch (COMMUNITY_OPEN_POOL_PLAN_V2).
    contributorBatchId: null,
    bounty: {
      is: {
        kind: BountyKind.community,
      },
    },
  };
  const where: Prisma.SubmissionWhereInput = {
    ...baseWhere,
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(params.search?.trim()
      ? { bounty: { is: { kind: BountyKind.community, title: { contains: params.search.trim(), mode: "insensitive" } } } }
      : {}),
  };

  // Page pool groups in the database. The previous implementation loaded every
  // submission row into the API process and grouped it in memory.
  const [allGroups, pagedGroups, allStatusGroups] = await Promise.all([
    prisma.submission.groupBy({ by: ["bountyId"], where }),
    prisma.submission.groupBy({
      by: ["bountyId"],
      where,
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.submission.groupBy({
      by: ["status"],
      where: baseWhere,
      _count: { _all: true },
    }),
  ]);
  const allCounts = new Map(allStatusGroups.map((group) => [group.status, group._count._all]));
  const countAllStatuses = (values: SubmissionStatus[]) =>
    values.reduce((sum, status) => sum + (allCounts.get(status) ?? 0), 0);
  const allSubmissionTotal = Array.from(allCounts.values()).reduce((sum, count) => sum + count, 0);
  const allAccepted = allCounts.get(SubmissionStatus.accepted) ?? 0;
  const allActionNeeded = countAllStatuses(ACTION_NEEDED);
  const allDisputed = allCounts.get(SubmissionStatus.disputed) ?? 0;
  const allSummary = {
    submitted: allSubmissionTotal,
    accepted: allAccepted,
    actionNeeded: allActionNeeded,
    inReview: Math.max(0, allSubmissionTotal - allAccepted - allActionNeeded - allDisputed),
    disputed: allDisputed,
  };
  const total = allGroups.length;
  const bountyIds = pagedGroups.map((group) => group.bountyId);
  if (bountyIds.length === 0) {
    return { pools: [], total, page, limit, totalPages: Math.ceil(total / limit), allSummary };
  }

  const [bounties, statusGroups] = await Promise.all([
    prisma.bounty.findMany({
      where: { id: { in: bountyIds } },
      select: {
        id: true,
        title: true,
        datasetCategory: true,
        language: true,
        karmaPerAcceptedItem: true,
        status: true,
        poolClosedAt: true,
        publicationStatus: true,
      },
    }),
    prisma.submission.groupBy({
      by: ["bountyId", "status"],
      where: { ...where, bountyId: { in: bountyIds } },
      _count: { _all: true },
    }),
  ]);
  const bountyById = new Map(bounties.map((bounty) => [bounty.id, bounty]));
  const countsByBounty = new Map<string, Map<SubmissionStatus, number>>();
  for (const group of statusGroups) {
    const counts = countsByBounty.get(group.bountyId) ?? new Map<SubmissionStatus, number>();
    counts.set(group.status, group._count._all);
    countsByBounty.set(group.bountyId, counts);
  }

  const pools = bountyIds.flatMap((bountyId) => {
    const bounty = bountyById.get(bountyId);
    if (!bounty) return [];
    const counts = countsByBounty.get(bountyId) ?? new Map<SubmissionStatus, number>();
    const countStatuses = (values: SubmissionStatus[]) =>
      values.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
    const submissionTotal = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
    const accepted = counts.get(SubmissionStatus.accepted) ?? 0;
    const actionNeeded = countStatuses(ACTION_NEEDED);
    const disputed = counts.get(SubmissionStatus.disputed) ?? 0;
    const automatedChecks = countStatuses(AUTOMATED);
    const validatorAudit = countStatuses(VALIDATOR_AUDIT);
    const poolCloseReview = counts.get(SubmissionStatus.accepted_pending_sample) ?? 0;
    const inReview = Math.max(0, submissionTotal - accepted - actionNeeded - disputed);

    return [{
      bountyId: bounty.id,
      bountyTitle: bounty.title,
      category: bounty.datasetCategory,
      language: bounty.language,
      karmaPerAcceptedItem: bounty.karmaPerAcceptedItem,
      poolClosed: Boolean(bounty.poolClosedAt) || bounty.status !== "active",
      publicationStatus: bounty.publicationStatus,
      submissionTotal,
      summary: { accepted, actionNeeded, inReview, disputed },
      review: { automatedChecks, validatorAudit, poolCloseReview },
    }];
  });

  return { pools, total, page, limit, totalPages: Math.ceil(total / limit), allSummary };
}

/** The contributor's own submissions to one open pool — paginated, same
 * page shape as getBatchSubmissions on the funded/external track (backs
 * GET /v1/bounties/:id/my-submissions). `submissionCounts` is a raw
 * status->count map; the frontend's own poolReviewSummary() aggregates it. */
export async function listContributorPoolSubmissions(params: {
  bountyId: string;
  contributorUserId: string;
  page: number;
  limit: number;
  filter?: "all" | "action_needed" | "in_review" | "accepted";
  search?: string;
}) {
  const skip = (params.page - 1) * params.limit;

  const FILTER_STATUSES: Record<string, SubmissionStatus[] | undefined> = {
    all: undefined,
    action_needed: [SubmissionStatus.needs_fixes, SubmissionStatus.tests_failed, SubmissionStatus.flagged, SubmissionStatus.rejected],
    in_review: [
      SubmissionStatus.draft,
      SubmissionStatus.submitted,
      SubmissionStatus.duplicate_check,
      SubmissionStatus.running_tests,
      SubmissionStatus.llm_validation,
      SubmissionStatus.in_audit,
      SubmissionStatus.provisionally_accepted,
      SubmissionStatus.in_sponsor_review,
      SubmissionStatus.accepted_pending_sample,
      SubmissionStatus.disputed,
    ],
    accepted: [SubmissionStatus.accepted],
  };
  const statuses = FILTER_STATUSES[params.filter ?? "all"];

  const where: Prisma.SubmissionWhereInput = {
    bountyId: params.bountyId,
    contributorUserId: params.contributorUserId,
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(params.search?.trim() ? { title: { contains: params.search.trim(), mode: "insensitive" } } : {}),
  };

  const [rows, total, countsRaw, maxRevisions] = await Promise.all([
    prisma.submission.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        duplicateScore: true,
        llmScore: true,
        revisionCount: true,
        flags: { where: { status: "open" }, select: { id: true } },
      },
      orderBy: { createdAt: "desc" },
      take: params.limit,
      skip,
    }),
    prisma.submission.count({ where }),
    prisma.submission.groupBy({
      by: ["status"],
      where: { bountyId: params.bountyId, contributorUserId: params.contributorUserId },
      _count: { _all: true },
    }),
    getMaxRevisions(),
  ]);

  const submissionCounts: Record<string, number> = {};
  for (const row of countsRaw) submissionCounts[row.status] = row._count._all;

  return {
    submissions: rows.map((r) => {
      // Mirrors reviseSubmission's real gate below — a row is actionable when
      // its status is revisable AND it still has an attempt left, so the UI
      // never offers a "revise" the server would refuse.
      const remaining = maxRevisions === 0 ? 9999 : Math.max(0, maxRevisions - r.revisionCount);
      const actionable = REVISABLE_STATUSES.includes(r.status) && remaining > 0;
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        duplicateScore: r.duplicateScore,
        llmScore: r.llmScore,
        issueCount: r.flags.length,
        actionable,
        // The REAL remaining count, not a fixed 9999. 9999 is reserved for the
        // genuine unlimited case (`submissions.max_revisions` = 0), which is
        // the frontend's existing convention for "no cap".
        revisionsRemaining: actionable ? remaining : 0,
      };
    }),
    submissionCounts,
    total,
    page: params.page,
    limit: params.limit,
    totalPages: Math.max(1, Math.ceil(total / params.limit)),
  };
}

export async function createPoolSubmission(params: {
  bountyId: string;
  contributorUserId: string;
  title: string;
  payloadJson: Record<string, unknown>;
  generationMethod: GenerationMethod;
}) {
  const bounty = await prisma.bounty.findUnique({ where: { id: params.bountyId } });
  if (!bounty || bounty.status !== "active") {
    throw new Error("Dataset pool is not active or does not exist");
  }

  const dedupeKey = computeDedupeKey(params.payloadJson);

  return prisma.$transaction(async (tx) => {
    // C10 fix, layer 1 — see the identical comment in createBountyPoolItems
    // above for the full rationale. Held for the rest of this transaction.
    await acquireBountyLock(tx, params.bountyId, "dedupe");

    const fileFields = await fileFieldsForBounty(tx, params.bountyId);

    // Check intra-pool duplicate
    const existingDup = await tx.submission.findFirst({
      where: {
        bountyId: params.bountyId,
        dedupeKey,
        status: { not: SubmissionStatus.rejected },
      },
      select: { id: true },
    });
    const lshBands = bandsFromSignature(computeMinHashSignature(params.payloadJson));
    const nearDupScore = existingDup ? 1.0 : await computeNearDupScore(params.bountyId, lshBands, undefined, tx);

    let submission;
    try {
      submission = await tx.submission.create({
        data: {
          bountyId: params.bountyId,
          contributorUserId: params.contributorUserId,
          title: params.title,
          payloadJson: params.payloadJson as Prisma.InputJsonValue,
          generationMethod: params.generationMethod,
          dedupeKey,
          status: existingDup ? SubmissionStatus.rejected : SubmissionStatus.submitted,
          duplicateScore: nearDupScore,
          duplicateOfSubmissionId: existingDup?.id,
        },
      });
    } catch (err) {
      // C10 fix, layer 2 (defensive backstop only) — see createBountyPoolItems
      // above for the full rationale. Should never fire with layer 1 in place.
      if (!isDedupeUniqueConflict(err)) throw err;
      const winner = await tx.submission.findFirst({
        where: { bountyId: params.bountyId, dedupeKey, status: { not: SubmissionStatus.rejected } },
        select: { id: true },
      });
      submission = await tx.submission.create({
        data: {
          bountyId: params.bountyId,
          contributorUserId: params.contributorUserId,
          title: params.title,
          payloadJson: params.payloadJson as Prisma.InputJsonValue,
          generationMethod: params.generationMethod,
          dedupeKey: null,
          status: SubmissionStatus.rejected,
          duplicateScore: 1.0,
          duplicateOfSubmissionId: winner?.id,
        },
      });
    }
    await writeLshBands(submission.id, lshBands, tx);

    // Read the actually-persisted status, not the pre-insert `existingDup`
    // read — see createBountyPoolItems above for why.
    if (submission.status === SubmissionStatus.submitted) {
      // Enqueue automated validation job
      await dbJobQueue.enqueue(
        {
          type: "validation.run",
          idempotencyKey: `val:${submission.id}:0`,
          payload: { submissionId: submission.id, validationAttempt: 0 },
        },
        tx,
      );
    }

    // Same-transaction file binding as v1 (services/artifact-attach.ts).
    await attachFileArtifacts(tx, {
      rows: [{ id: submission.id, payload: params.payloadJson }],
      fields: fileFields,
      bountyId: params.bountyId,
      contributorBatchId: null,
      userId: params.contributorUserId,
    });

    return submission;
  }, { timeout: INTAKE_TRANSACTION_TIMEOUT_MS });
}

export async function submitPoolBatchItems(params: {
  bountyId: string;
  contributorUserId: string;
  items: Array<{
    title: string;
    payloadJson: Record<string, unknown>;
    generationMethod?: GenerationMethod;
  }>;
}) {
  const submitLimits = await getPoolSubmitLimits();
  if (params.items.length > submitLimits.maxItemsPerRequest) {
    throw new SubmissionItemLimitError(params.items.length, submitLimits.maxItemsPerRequest);
  }
  const bounty = await prisma.bounty.findUnique({ where: { id: params.bountyId } });
  if (!bounty || bounty.status !== "active") {
    throw new Error("Dataset pool is not active or does not exist");
  }
  // Same advisory upfront gate as createBountyPoolItems above — this is NOT
  // the real enforcement point (that's the atomic accept-time UPDATE in
  // pool-lifecycle.ts; see its doc comment for why an intake-time check can
  // only ever be best-effort). Closing this gap matters anyway: before this,
  // this bulk path had NO capacity check at all, unlike its sibling.
  const target = Number(bounty.targetItems);
  if (target > 0 && Number(bounty.acceptedItems) >= target) {
    throw new Error("This pool already reached its item target.");
  }

  return prisma.$transaction(async (tx) => {
    // C10 fix, layer 1 — see the identical comment in createBountyPoolItems
    // above for the full rationale. Held for the rest of this transaction,
    // so this whole bulk call is serialized against any other concurrent
    // call (single or bulk) targeting the same bounty.
    await acquireBountyLock(tx, params.bountyId, "dedupe");

    const fileFields = await fileFieldsForBounty(tx, params.bountyId);
    const createdSubmissions = [];
    const attachRows: AttachRow[] = [];
    // The upfront check above only reads capacity ONCE, before this loop —
    // fine for the single/small-batch caller, but a bulk call (this
    // function's other caller, the /bulk route and the bulk-source-parse
    // ingest job, can carry up to hundreds of items in one call) could
    // otherwise try to create every one of them even when only a handful of
    // slots remain. Track how many genuinely NEW (non-duplicate) items this
    // call has created so far and stop early once they'd exceed the
    // target — still advisory/best-effort, not a lock, same as above.
    // Duplicates are exempt: they're written with status `rejected` and
    // never occupy a pool slot, so they must never count against the budget.
    let nonDuplicateCreated = 0;
    let stoppedAtCapacity = false;

    for (const item of params.items) {
      const dedupeKey = computeDedupeKey(item.payloadJson);
      const existingDup = await tx.submission.findFirst({
        where: {
          bountyId: params.bountyId,
          dedupeKey,
          status: { not: SubmissionStatus.rejected },
        },
        select: { id: true },
      });

      if (!existingDup && target > 0 && Number(bounty.acceptedItems) + nonDuplicateCreated >= target) {
        stoppedAtCapacity = true;
        break;
      }

      const lshBands = bandsFromSignature(computeMinHashSignature(item.payloadJson));
      const nearDupScore = existingDup ? 1.0 : await computeNearDupScore(params.bountyId, lshBands, undefined, tx);

      let sub;
      try {
        sub = await tx.submission.create({
          data: {
            bountyId: params.bountyId,
            contributorUserId: params.contributorUserId,
            title: item.title,
            payloadJson: item.payloadJson as Prisma.InputJsonValue,
            generationMethod: item.generationMethod ?? GenerationMethod.human,
            dedupeKey,
            status: existingDup ? SubmissionStatus.rejected : SubmissionStatus.submitted,
            duplicateScore: nearDupScore,
            duplicateOfSubmissionId: existingDup?.id,
          },
        });
      } catch (err) {
        // C10 fix, layer 2 (defensive backstop only) — see createBountyPoolItems
        // above for the full rationale. Should never fire with layer 1 in place.
        // Critically, this must NOT abort the whole bulk call: every other,
        // unrelated item in this same request must still land — that is the
        // entire point of catching this here instead of letting it propagate
        // out of the transaction.
        if (!isDedupeUniqueConflict(err)) throw err;
        const winner = await tx.submission.findFirst({
          where: { bountyId: params.bountyId, dedupeKey, status: { not: SubmissionStatus.rejected } },
          select: { id: true },
        });
        sub = await tx.submission.create({
          data: {
            bountyId: params.bountyId,
            contributorUserId: params.contributorUserId,
            title: item.title,
            payloadJson: item.payloadJson as Prisma.InputJsonValue,
            generationMethod: item.generationMethod ?? GenerationMethod.human,
            dedupeKey: null,
            status: SubmissionStatus.rejected,
            duplicateScore: 1.0,
            duplicateOfSubmissionId: winner?.id,
          },
        });
      }
      await writeLshBands(sub.id, lshBands, tx);

      // Read the actually-persisted status, not the pre-insert `existingDup`
      // read — see createBountyPoolItems above for why. A race-detected
      // duplicate must not draw against the capacity budget either, for the
      // same reason a pre-detected one doesn't: it is written `rejected` and
      // never occupies a pool slot.
      if (sub.status === SubmissionStatus.submitted) {
        nonDuplicateCreated += 1;
        await dbJobQueue.enqueue(
          {
            type: "validation.run",
            idempotencyKey: `val:${sub.id}:0`,
            payload: { submissionId: sub.id, validationAttempt: 0 },
          },
          tx,
        );
      }

      createdSubmissions.push(sub);
      attachRows.push({ id: sub.id, payload: item.payloadJson });
    }

    // Same-transaction file binding as v1 (services/artifact-attach.ts). All
    // or nothing: one bad reference anywhere in this submit rolls back every
    // row it created rather than accepting items with missing attachments.
    await attachFileArtifacts(tx, {
      rows: attachRows,
      fields: fileFields,
      bountyId: params.bountyId,
      contributorBatchId: null,
      userId: params.contributorUserId,
    });

    return { created: createdSubmissions.length, submissions: createdSubmissions, stoppedAtCapacity };
  }, { timeout: INTAKE_TRANSACTION_TIMEOUT_MS });
}

export async function getSubmissionById(id: string) {
  return prisma.submission.findUnique({
    where: { id },
    include: {
      bounty: { select: { id: true, title: true, status: true, karmaPerAcceptedItem: true } },
      contributor: { select: { id: true, displayName: true, handle: true } },
      validationResults: { orderBy: { createdAt: "desc" } },
      revisions: { orderBy: { revisionNumber: "desc" } },
      // The real validator decisions on this item. `validationResults` never
      // carries a "human_audit" row (services/validation.ts writes machine
      // stages only), so without this the dashboard had no source at all for
      // the human-audit stage: the pipeline card's `human_audit` row was
      // pinned to "pending / blocked" and the audit-history drawer always
      // read "No validator audit has been assigned yet" — on flagged and
      // accepted items alike, while the status pill beside it already said
      // the item had been decided. Ordered decided-first, newest-first, so a
      // consumer taking the first decided row gets the latest decision
      // rather than whichever `AuditItem` happened to be inserted first.
      auditItems: {
        select: { id: true, verdict: true, decidedAt: true },
        orderBy: { decidedAt: { sort: "desc", nulls: "last" } },
      },
      flags: true,
    },
  });
}

export function submissionsFilterKey(params?: {
  bountyId?: string;
  contributorUserId?: string;
  status?: SubmissionStatus;
}): string {
  return filterKeyOf(["submissions", params?.bountyId, params?.contributorUserId, params?.status]);
}

/**
 * Submissions, newest first.
 *
 * `offset` is kept for the REST route (`GET /v1/submissions`) but is NOT
 * stable — a submission created between two pages shifts every later row, so
 * an offset walk repeats or skips items. `cursor` is the stable way to walk
 * the list and wins when both are supplied (lib/keyset-cursor.ts). `total`
 * still counts the whole filtered set, not the page.
 */
export async function listSubmissions(params?: {
  bountyId?: string;
  contributorUserId?: string;
  status?: SubmissionStatus;
  limit?: number;
  offset?: number;
  cursor?: string;
}) {
  const take = Math.min(Math.max(params?.limit ?? 50, 1), 100);
  const skip = Math.max(params?.offset ?? 0, 0);
  const filterKey = submissionsFilterKey(params);
  const position = params?.cursor ? decodeDateCursor(params.cursor, filterKey, "submission") : null;

  const where: Prisma.SubmissionWhereInput = {
    ...(params?.bountyId ? { bountyId: params.bountyId } : {}),
    ...(params?.contributorUserId ? { contributorUserId: params.contributorUserId } : {}),
    ...(params?.status ? { status: params.status } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.submission.findMany({
      where: {
        ...where,
        // Strictly-after predicate for `createdAt desc, id desc`.
        ...(position
          ? {
              OR: [
                { createdAt: { lt: position.createdAt } },
                { createdAt: position.createdAt, id: { lt: position.id } },
              ],
            }
          : {}),
      },
      include: {
        bounty: { select: { id: true, title: true, status: true, karmaPerAcceptedItem: true } },
        contributor: { select: { id: true, displayName: true, handle: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(position ? {} : { skip }),
    }),
    prisma.submission.count({ where }),
  ]);

  const { items, hasMore } = takePage(rows, take);
  const last = items[items.length - 1];
  return {
    items,
    total,
    limit: take,
    offset: position ? null : skip,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id, filterKey) : null,
  };
}

export async function reviseSubmission(params: {
  submissionId: string;
  contributorUserId: string;
  title?: string;
  payloadJson: Record<string, unknown>;
}) {
  const sub = await prisma.submission.findUnique({
    where: { id: params.submissionId },
    include: {
      bounty: {
        select: {
          id: true,
          title: true,
          kind: true,
          poolClosedAt: true,
          requesterUserId: true,
          communityRequesterUserId: true,
        },
      },
      // Needed for the revision snapshot written below, which is the only
      // record of why the previous version was replaced once this row's own
      // evidence has moved on to the next validation attempt.
      validationResults: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!sub || sub.contributorUserId !== params.contributorUserId) {
    throw new ReviseSubmissionError("not_found", "Submission not found or access denied");
  }

  if (!REVISABLE_STATUSES.includes(sub.status)) {
    throw new ReviseSubmissionError(
      "not_revisable",
      `Submission in status '${sub.status}' cannot be revised`,
    );
  }

  // A revision flips the row back to `submitted`, which re-enters the normal
  // acceptance path. Widening the revisable set above therefore opens a door
  // that only `needs_fixes` kept shut: an item revised after its pool has
  // closed would be accepted against a settled pool and awarded karma for it.
  // v1 closes exactly this door on its own revise path.
  if (sub.bounty.kind === BountyKind.community && sub.bounty.poolClosedAt) {
    throw new ReviseSubmissionError(
      "pool_closed",
      "This community pool has closed; its submissions can no longer be revised",
    );
  }

  const maxRevisions = await getMaxRevisions();
  const isUnlimited = maxRevisions === 0;

  // Bound the reject -> revise -> re-validate cycle. Without a cap a
  // contributor (or an agent driving the API) can revise forever, which is an
  // unbounded free-labour loop for the validators and an unbounded cost loop
  // for the pipeline.
  //
  // The attempt is RESERVED with a single atomic conditional UPDATE before any
  // other work happens. Postgres serialises concurrent UPDATEs on the same
  // row, so of two concurrent revise calls at revisionCount == maxRevisions-1
  // exactly one can match `revision_count < maxRevisions`; the loser's WHERE
  // re-evaluates against the already-incremented row and updates zero rows. A
  // read-then-check (read revisionCount, decide, increment later) would let
  // BOTH callers pass the check and push the count past the cap.
  //
  // RETURNING (rather than `updateMany` + a follow-up read) is what makes the
  // winner's own post-increment number available: `SubmissionRevision` is
  // unique on (submissionId, revisionNumber), so two concurrent winners
  // re-reading the row afterwards could read the same value and collide.
  // The status list is built from REVISABLE_STATUSES rather than spelled out
  // in SQL, so the gate checked above and the gate enforced here can never
  // drift apart.
  const claimed = await prisma.$queryRaw<{ revision_count: number }[]>(Prisma.sql`
    UPDATE submissions
       SET revision_count = revision_count + 1
     WHERE id = ${sub.id}
       AND contributor_user_id = ${params.contributorUserId}
       AND status::text IN (${Prisma.join(REVISABLE_STATUSES.map((s) => Prisma.sql`${s}`))})
       AND (${isUnlimited} OR revision_count < ${maxRevisions})
    RETURNING revision_count
  `);

  if (claimed.length !== 1) {
    const fresh = await prisma.submission.findUnique({
      where: { id: sub.id },
      select: { revisionCount: true, status: true },
    });
    if (!isUnlimited && fresh && fresh.revisionCount >= maxRevisions) {
      // Cap exhausted: terminal rejection, mirroring v1. Community has no
      // escrow/bond to unwind, so the transition is status + notifications.
      await prisma.$transaction(async (tx) => {
        if (fresh.status !== SubmissionStatus.rejected) {
          await tx.submission.update({
            where: { id: sub.id },
            data: { status: SubmissionStatus.rejected },
          });
        }
        await notifyEvent(tx, "submission.rejected", {
          userId: params.contributorUserId,
          entityId: sub.id,
          linkBountyId: sub.bountyId,
          keySuffix: `${sub.id}:revision-cap`,
          data: { item: sub.title, reason: `exceeded ${maxRevisions} revision attempts` },
        });
        const requesterUserId = sub.bounty.communityRequesterUserId ?? sub.bounty.requesterUserId;
        if (requesterUserId && requesterUserId !== params.contributorUserId) {
          await notifyEvent(tx, "submission.rejected_final", {
            userId: requesterUserId,
            entityId: sub.id,
            linkBountyId: sub.bountyId,
            keySuffix: `${sub.id}:revision-cap:sponsor`,
            data: {
              item: sub.title,
              bounty: sub.bounty.title,
              reason: `exceeded ${maxRevisions} revision attempts`,
            },
          });
        }
      });
      throw new ReviseSubmissionError(
        "revision_cap_exceeded",
        `Submission has been revised ${maxRevisions} times and is now rejected`,
      );
    }
    throw new ReviseSubmissionError(
      "concurrent_change",
      "Submission state changed concurrently — retry the revise",
    );
  }

  const nextRevision = Number(claimed[0]!.revision_count);

  // Snapshot the pre-revision state under the number this caller just claimed.
  await prisma.submissionRevision.create({
    data: {
      submissionId: sub.id,
      revisionNumber: nextRevision,
      title: sub.title,
      payloadJson: sub.payloadJson as Prisma.InputJsonValue,
      generationMethod: sub.generationMethod,
      status: sub.status,
      duplicateScore: sub.duplicateScore,
      llmScore: sub.llmScore,
      // An ARRAY, in the same shape services/jobs/benchmark-jobs.ts writes and
      // the only shape any consumer reads. This was `{}`, which was wrong
      // twice over: the snapshot is documented as "immutable evidence" of the
      // replaced version and recorded none of it, and the audit-history
      // drawer's EvidenceRows does `results.length === 0` then `results.map`,
      // so `{}` (length `undefined`, so not `=== 0`) threw on `.map` and took
      // down the whole drawer for every submission that had ever been revised.
      validationEvidence: sub.validationResults.map((r) => ({
        id: r.id,
        stage: r.stage,
        passed: r.passed,
        score: r.score,
        detail: r.detailJson,
        createdAt: r.createdAt.toISOString(),
      })) as Prisma.InputJsonValue,
    },
  });

  const dedupeKey = computeDedupeKey(params.payloadJson);

  // C10 follow-up: this function does not run the same dedupe-then-insert
  // sequence as the three intake functions above (no `existingDup` lookup at
  // all — it just recomputes `dedupeKey` from the revised payload and writes
  // it), so there is no check-then-act TOCTOU here for a layer-1 advisory
  // lock to close, and v1's own equivalent path (routes/v1/submissions.ts
  // revise handler) does not take `withBountyDedupeLock` either — only this
  // layer-2-shaped P2002 catch, which v1 already has at this exact call site.
  // But the WRITE below still touches the same partial unique index
  // (`DEDUPE_UNIQUE_INDEX` covers UPDATEs, not just INSERTs): if the revised
  // payload's new dedupeKey collides with another active submission in the
  // same bounty+batch — matching content, or an unlucky race against a
  // concurrent intake insert — this update violates it exactly like a
  // colliding `tx.submission.create()` would, and without this catch that
  // raw P2002 would propagate uncaught to the route's generic
  // `catch (err: any) => badRequest(err.message)`, the same class of leak
  // C10 describes for the intake path.
  let updated;
  try {
    updated = await prisma.submission.update({
      where: { id: sub.id },
      data: {
        title: params.title ?? sub.title,
        payloadJson: params.payloadJson as Prisma.InputJsonValue,
        dedupeKey,
        status: SubmissionStatus.submitted,
        // revisionCount was already incremented by the atomic claim above —
        // re-writing it here would undo a concurrent claimer's increment.
        validationAttempt: { increment: 1 },
      },
    });
  } catch (err) {
    if (!isDedupeUniqueConflict(err)) throw err;
    const winner = await prisma.submission.findFirst({
      where: { bountyId: sub.bountyId, dedupeKey, status: { not: SubmissionStatus.rejected }, id: { not: sub.id } },
      select: { id: true },
    });
    updated = await prisma.submission.update({
      where: { id: sub.id },
      data: {
        title: params.title ?? sub.title,
        payloadJson: params.payloadJson as Prisma.InputJsonValue,
        // Do not persist the colliding key — see the identical reasoning in
        // createBountyPoolItems above.
        dedupeKey: null,
        status: SubmissionStatus.rejected,
        duplicateScore: 1.0,
        duplicateOfSubmissionId: winner?.id,
        validationAttempt: { increment: 1 },
      },
    });
  }

  // A revision the race above just rejected must not re-enter the pipeline —
  // matching how the three intake functions skip enqueueing for a
  // race-detected duplicate.
  if (updated.status === SubmissionStatus.submitted) {
    await dbJobQueue.enqueue({
      type: "validation.run",
      idempotencyKey: `val:${updated.id}:${nextRevision}`,
      payload: { submissionId: updated.id, validationAttempt: updated.validationAttempt },
    });
  }

  return updated;
}

/**
 * Requeue one completed *automated* validation attempt without changing the
 * payload or spending a contributor revision. Historical ValidationResult
 * rows are append-only and the new attempt number makes every new result
 * unambiguously attributable to this explicit rerun.
 */
export async function rerunSubmissionValidation(params: {
  submissionId: string;
  contributorUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const sub = await tx.submission.findUnique({
      where: { id: params.submissionId },
      include: {
        bounty: { select: { kind: true, poolClosedAt: true } },
        validationResults: { select: { validationAttempt: true, stage: true, passed: true } },
        auditItems: { select: { decidedAt: true } },
      },
    });
    if (!sub || sub.contributorUserId !== params.contributorUserId) {
      throw new RerunValidationError("not_found", "Submission not found or access denied");
    }
    if (!AUTOMATED_RERUNNABLE_STATUSES.includes(sub.status)) {
      throw new RerunValidationError("not_rerunnable", `Submission in status '${sub.status}' cannot be rerun`);
    }
    if (sub.bounty.kind === BountyKind.community && sub.bounty.poolClosedAt) {
      throw new RerunValidationError("pool_closed", "This community pool has closed; its submissions can no longer be rerun");
    }
    // Never offer a way around a validator verdict, even if a future status
    // transition happens to reuse `rejected`.
    if (sub.auditItems.some((item) => item.decidedAt != null)) {
      throw new RerunValidationError("not_rerunnable", "A validator decision cannot be rerun; revise the item or dispute the decision instead");
    }
    // A terminal status alone is insufficient: e.g. an intake-time duplicate
    // can be rejected before a worker ran. Require failed evidence for the
    // exact current attempt so the action means rerun, not first-run bypass.
    const failedAutomatedStage = sub.validationResults.some(
      (result) => result.validationAttempt === sub.validationAttempt && result.stage !== "human_audit" && !result.passed,
    );
    if (!failedAutomatedStage) {
      throw new RerunValidationError("not_rerunnable", "This submission has no failed automated validation attempt to rerun");
    }

    const claimed = await tx.submission.updateMany({
      where: {
        id: sub.id,
        contributorUserId: params.contributorUserId,
        status: { in: AUTOMATED_RERUNNABLE_STATUSES },
        validationAttempt: sub.validationAttempt,
      },
      data: { status: SubmissionStatus.submitted, pendingHumanReview: false, validationAttempt: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw new RerunValidationError("concurrent_change", "Submission state changed concurrently — retry the validation rerun");
    }
    const validationAttempt = sub.validationAttempt + 1;
    await dbJobQueue.enqueue({
      type: "validation.run",
      idempotencyKey: `val:${sub.id}:attempt:${validationAttempt}`,
      payload: { submissionId: sub.id, validationAttempt },
    }, tx);
    return tx.submission.findUniqueOrThrow({ where: { id: sub.id } });
  });
}
