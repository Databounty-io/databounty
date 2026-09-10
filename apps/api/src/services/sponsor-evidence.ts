// SPDX-License-Identifier: Apache-2.0

import { DisputeStatus, FlagReason, Prisma, SubmissionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decodeDateCursor, encodeCursor, filterKeyOf, takePage } from "../lib/keyset-cursor.js";
import { defaultDisputeWindowHours, holdReleasesAt } from "./karma-holds.js";
import { notifyAdminsEvent, notifyEvent } from "./notifications.js";
import { llmValidationEnabled } from "./admin-settings.js";
import { openRouterConfigured } from "./llm-client.js";

/**
 * Requester-side ("sponsor") evidence and dispute operations for a community
 * pool. This is the single implementation behind two surfaces:
 *
 *   - REST: `GET /v1/bounties/:id/submissions` and
 *           `POST /v1/submissions/:id/dispute-acceptance`
 *   - MCP:  `get_sponsor_submission_evidence` and `dispute_accepted_submission`
 *
 * The logic used to live inline in the two route handlers. It was moved here
 * unchanged so the MCP tools — which call the service layer in-process rather
 * than the REST routes (see mcp/tool-gate.ts) — cannot drift from what the
 * dashboard sees. Any authorization outcome is reported through
 * `SponsorEvidenceError` so each surface maps it to its own wire shape
 * (`reply.forbidden` / `McpToolError(…, 403)`) without re-deciding it.
 */

/** Error carrying the HTTP shape a caller should reply with, same pattern as
 * `ReviseSubmissionError` in services/submissions.ts. */
export class SponsorEvidenceError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "SponsorEvidenceError";
  }

  get status(): 403 | 404 | 409 {
    switch (this.code) {
      case "not_found":
        return 404;
      case "forbidden":
        return 403;
      case "conflict":
        return 409;
    }
  }
}

export interface ListSponsorSubmissionEvidenceInput {
  bountyId: string;
  /** The caller — must be the pool's requester (`requesterUserId`, or
   *  `communityRequesterUserId` for a pool an admin minted on their behalf). */
  userId: string;
  /** 1-based page; `undefined` means page 1. Clamped to `>= 1`. */
  page?: number;
  /** Rows per page; `undefined` means 50. Clamped to 1..100. */
  pageSize?: number;
  /** A `SubmissionStatus` value filters; anything else (including `"all"`) is
   * ignored, exactly as the query-string route treated it. */
  status?: string;
  /** Case-insensitive `title contains` filter; blank is ignored. */
  search?: string;
  /** Page size for the cursor walk. Alias of `pageSize`; clamped 1..100. */
  limit?: number;
  /** Opaque keyset cursor from a previous call's `nextCursor`. Stable where
   * `page` is not: a submission arriving mid-walk shifts every later row of an
   * offset page, so a page walk repeats or skips evidence. Wins over `page`
   * when both are given. */
  cursor?: string;
}

export function sponsorEvidenceFilterKey(params: { bountyId: string; status?: SubmissionStatus; search?: string }): string {
  return filterKeyOf(["sponsor-evidence", params.bountyId, params.status ?? "", params.search?.trim() ?? ""]);
}

/**
 * The owner check runs BEFORE the submission query on purpose — a non-owner
 * must not cause the rows to be read at all. Returns the exact body the REST
 * route sends: `{ submissions, total, page, pageSize, totalPages }`, each
 * submission carrying `disputeWindowClosesAt` computed from the SAME anchor
 * (`holdReleasesAt`) that gates `disputeAcceptedSubmission` server-side.
 */
export async function listSponsorSubmissionEvidence(input: ListSponsorSubmissionEvidenceInput) {
  const { bountyId, userId } = input;
  const owner = await prisma.bounty.findUnique({
    where: { id: bountyId },
    select: { requesterUserId: true, communityRequesterUserId: true },
  });
  if (!owner) throw new SponsorEvidenceError("not_found", "bounty not found");
  // Admin-minted pools record the minting admin as `requesterUserId` and the
  // real requester as `communityRequesterUserId` (routes/v1/admin-community.ts);
  // the dispute path already accepts either, so evidence must too or the
  // person who asked for the pool cannot read their own pool's evidence.
  if (owner.requesterUserId !== userId && owner.communityRequesterUserId !== userId) {
    throw new SponsorEvidenceError("forbidden", "only the bounty owner can inspect submissions");
  }

  const pageSize = Math.min(Math.max(input.limit ?? input.pageSize ?? 50, 1), 100);
  const page = Math.max(input.page ?? 1, 1);
  const skip = (page - 1) * pageSize;

  const statusFilter =
    input.status && input.status !== "all" && (Object.values(SubmissionStatus) as string[]).includes(input.status)
      ? (input.status as SubmissionStatus)
      : undefined;

  // Bound to the EFFECTIVE filter, not the raw input: `status: "all"` and
  // `status: "bogus"` both mean "no status filter", so a cursor minted under
  // one must stay valid under the other. Binding the raw string would refuse a
  // walk whose result set never changed.
  const filterKey = sponsorEvidenceFilterKey({ bountyId, status: statusFilter, search: input.search });
  const position = input.cursor ? decodeDateCursor(input.cursor, filterKey, "submission evidence") : null;

  const where: Prisma.SubmissionWhereInput = {
    bountyId,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(input.search?.trim() ? { title: { contains: input.search.trim(), mode: "insensitive" } } : {}),
  };

  const [bounty, rows, total] = await Promise.all([
    prisma.bounty.findUnique({
      where: { id: bountyId },
      select: { disputeWindowHours: true, disputeCycleWindowOpensAt: true },
    }),
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
      select: {
        id: true,
        title: true,
        status: true,
        generationMethod: true,
        payloadJson: true,
        duplicateScore: true,
        llmScore: true,
        contributor: { select: { id: true, displayName: true, handle: true } },
        createdAt: true,
        acceptedAt: true,
        flags: { select: { reason: true, details: true, status: true } },
        validationResults: {
          // `outcome` and `validationAttempt` were both missing. Without
          // `outcome`, an `llm` row arrives as `{passed:false, score:87}` and
          // is indistinguishable from a terminal failure, and
          // `{passed:false, score:null}` cannot be told apart from "provider
          // errored" / "not configured" / "never ran" — so a sponsor (and the
          // get_sponsor_submission_evidence MCP tool, whose description
          // promises "per-stage validation evidence") had no way to decode it.
          // `check_submission` never had this defect; the asymmetry was the bug.
          select: { id: true, stage: true, passed: true, score: true, outcome: true, detailJson: true, validationAttempt: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageSize + 1,
      ...(position ? {} : { skip }),
    }),
    prisma.submission.count({ where }),
  ]);
  const { items, hasMore } = takePage(rows, pageSize);

  // `disputeWindowClosesAt`: lets the requester UI show/hide the dispute
  // action without a round trip, using the SAME anchor
  // (services/karma-holds.ts `holdReleasesAt`) that actually gates
  // `disputeAcceptedSubmission` below — the server remains the source of
  // truth; this is UX only.
  const defaultWindowHours = bounty ? await defaultDisputeWindowHours() : 0;
  const submissions = items.map((sub) => ({
    ...sub,
    disputeWindowClosesAt:
      bounty && sub.status === SubmissionStatus.accepted
        ? holdReleasesAt(
            { sourceType: "submission", createdAt: sub.createdAt },
            { disputeWindowHours: bounty.disputeWindowHours, disputeCycleWindowOpensAt: bounty.disputeCycleWindowOpensAt },
            sub.acceptedAt,
            defaultWindowHours
          ).toISOString()
        : null,
  }));

  const lastRow = items[items.length - 1];
  return {
    submissions,
    total,
    // `page`/`totalPages` describe the offset walk only. On a cursor walk they
    // are not meaningful positions, and reporting `page: 1` for every page
    // would be a lie an agent could build a loop on — `hasMore` is the
    // authority on whether more rows exist.
    page: position ? null : page,
    pageSize,
    totalPages: position ? null : Math.max(1, Math.ceil(total / pageSize)),
    hasMore,
    nextCursor: hasMore && lastRow ? encodeCursor(lastRow.createdAt, lastRow.id, filterKey) : null,
  };
}

/**
 * Sponsor-scoped read of ONE submission — the pool owner's counterpart to the
 * contributor-only `GET /v1/submissions/:id`.
 *
 * `GET /v1/submissions/:id` (routes/v1/submissions.ts) is gated
 * contributor-or-admin, so a real sponsor (a pool's `requesterUserId` /
 * `communityRequesterUserId`, not an admin) got a 403 and the sponsor
 * submission-detail page rendered "Cannot load this submission" for anyone
 * but an admin. The fix is NOT to widen that endpoint's gate:
 * `getSubmissionById` includes `flags: true` — every Flag column, including
 * `validatorUserId` — and this file's own list endpoint (`listSponsorSubmissionEvidence`
 * above) deliberately selects only `{reason, details, status}` from flags, on
 * purpose, so a sponsor is never told which validator flagged an item. Adding
 * the pool owner to that endpoint's gate would silently undo that redaction.
 * This function applies the SAME ownership predicate `disputeAcceptedSubmission`
 * below already uses and documents (owner OR admin), and the SAME flag
 * redaction the list endpoint uses, so a single-submission read cannot leak
 * more than the list already deliberately allows.
 *
 * Throws `SponsorEvidenceError`:
 *   - `not_found` — no such submission, OR it does not belong to this bounty
 *   - `forbidden` — caller is neither the pool's owner nor an admin
 */
export async function getSponsorSubmissionEvidence(input: {
  bountyId: string;
  submissionId: string;
  userId: string;
  callerRoles: readonly string[];
}) {
  const { bountyId, submissionId, userId, callerRoles } = input;

  const sub = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      bountyId: true,
      contributorBatchId: true,
      title: true,
      payloadJson: true,
      generationMethod: true,
      status: true,
      duplicateScore: true,
      llmScore: true,
      createdAt: true,
      bounty: { select: { requesterUserId: true, communityRequesterUserId: true } },
      validationResults: {
        select: { id: true, stage: true, passed: true, score: true, outcome: true, detailJson: true, validationAttempt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
      // Redacted exactly as listSponsorSubmissionEvidence redacts it —
      // `validatorUserId` is deliberately excluded so a sponsor cannot learn
      // which validator flagged their item. `id`/`submissionId` are structural
      // (the client's ApiFlag type requires them), not identity.
      flags: { select: { id: true, reason: true, details: true, status: true, createdAt: true } },
      revisions: {
        select: { id: true, revisionNumber: true, title: true, status: true, validationEvidence: true, createdAt: true },
        orderBy: { revisionNumber: "desc" },
      },
      auditItems: {
        select: { id: true, verdict: true, decidedAt: true },
        orderBy: { decidedAt: { sort: "desc", nulls: "last" } },
      },
      artifacts: {
        where: { kind: "submission_attachment", status: { not: "deleted" } },
        select: { id: true, kind: true, filename: true, contentType: true, sizeBytes: true, status: true, scanStatus: true, createdAt: true },
      },
    },
  });
  if (!sub || sub.bountyId !== bountyId) throw new SponsorEvidenceError("not_found", "Submission not found");

  const isOwner = sub.bounty.requesterUserId === userId || sub.bounty.communityRequesterUserId === userId;
  if (!isOwner && !callerRoles.includes("admin")) {
    throw new SponsorEvidenceError("forbidden", "only the bounty owner can inspect submissions");
  }

  const [llmEnabled, providerConfigured] = await Promise.all([llmValidationEnabled(), openRouterConfigured()]);

  const { bounty: _bounty, flags, artifacts, ...rest } = sub;
  return {
    ...rest,
    // `validatorUserId: null` on every row — never the real value — matching
    // the list endpoint's redaction while satisfying the client's ApiFlag
    // shape, which declares the field (nullable) structurally.
    flags: flags.map((f: (typeof flags)[number]) => ({ ...f, submissionId: sub.id, validatorUserId: null as string | null })),
    attachments: artifacts,
    llmValidationEnabled: llmEnabled,
    llmProviderConfigured: providerConfigured,
  };
}

export interface DisputeAcceptedSubmissionInput {
  submissionId: string;
  /** The caller raising the dispute. */
  userId: string;
  /** The caller's roles (`AuthedUser.roles`); an `admin` may dispute any
   * pool's accepted item, exactly as the REST route allows. */
  callerRoles: readonly string[];
  reason: FlagReason;
  argument: string;
}

/**
 * Dispute an ACCEPTED submission — the requester's counterpart to the
 * contributor `/dispute` route. The contributor disputes a flagged/rejected
 * verdict; the requester (community "sponsor") disputes an `ok` verdict that
 * already went through, during the post-accept hold window. Gated to the
 * pool's owner (`requesterUserId` or `communityRequesterUserId`) or an admin.
 * Reuses the SAME hold-window anchor (`holdReleasesAt`/
 * `defaultDisputeWindowHours` from services/karma-holds.ts) that gates when a
 * submission's karma award releases, rather than inventing a second,
 * possibly-inconsistent window calculation — see karma-holds.ts's
 * `holdReleasesAt` doc comment for why the anchor is
 * `max(bounty.disputeCycleWindowOpensAt, submission.acceptedAt)`.
 *
 * On success: a `Dispute` row, the submission flips to `disputed`, and the
 * interested parties are notified in the SAME transaction (transactional
 * outbox): the contributor (`issue.sponsor_disputed`) and operators
 * (`admin.dispute_filed` — a dispute is always admin-arbitrated, never
 * auto-resolved by either side). Does NOT claw back karma here — that only
 * happens if/when an admin upholds the dispute.
 *
 * Throws `SponsorEvidenceError`:
 *   - `not_found`  — no such submission
 *   - `forbidden`  — caller is neither the pool's requester nor an admin
 *   - `conflict`   — not accepted / already has an open dispute / window closed
 */
export async function disputeAcceptedSubmission(input: DisputeAcceptedSubmissionInput) {
  const { submissionId, userId, callerRoles, reason, argument } = input;

  const sub = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      title: true,
      status: true,
      acceptedAt: true,
      createdAt: true,
      contributorUserId: true,
      bountyId: true,
      bounty: {
        select: {
          id: true,
          title: true,
          requesterUserId: true,
          communityRequesterUserId: true,
          disputeWindowHours: true,
          disputeCycleWindowOpensAt: true,
        },
      },
    },
  });
  if (!sub) throw new SponsorEvidenceError("not_found", "Submission not found");

  const isOwner = sub.bounty.requesterUserId === userId || sub.bounty.communityRequesterUserId === userId;
  if (!isOwner && !callerRoles.includes("admin")) {
    throw new SponsorEvidenceError("forbidden", "Only this pool's requester can dispute an accepted item.");
  }

  if (sub.status !== SubmissionStatus.accepted) {
    throw new SponsorEvidenceError(
      "conflict",
      `Submission in status '${sub.status}' has nothing to dispute — it was never accepted.`,
    );
  }

  const existingOpen = await prisma.dispute.findFirst({ where: { submissionId, status: DisputeStatus.open } });
  if (existingOpen) throw new SponsorEvidenceError("conflict", "This submission already has an open dispute.");

  const defaultWindowHours = await defaultDisputeWindowHours();
  const windowClosesAt = holdReleasesAt(
    { sourceType: "submission", createdAt: sub.createdAt },
    { disputeWindowHours: sub.bounty.disputeWindowHours, disputeCycleWindowOpensAt: sub.bounty.disputeCycleWindowOpensAt },
    sub.acceptedAt,
    defaultWindowHours
  );
  if (windowClosesAt.getTime() <= Date.now()) {
    throw new SponsorEvidenceError("conflict", "The dispute window for this submission has closed.");
  }

  // 15s, not Prisma's 5s default: `notifyAdminsEvent` below fans out one
  // notify() write (each its own `pg_advisory_xact_lock` + upsert) per
  // admin/member/support user, all inside this one transaction.
  return prisma.$transaction(async (tx) => {
    const disp = await tx.dispute.create({
      data: {
        bountyId: sub.bountyId,
        submissionId: sub.id,
        raisedByUserId: userId,
        bountyTitle: sub.bounty.title,
        submissionTitle: sub.title,
        flagReason: reason,
        contributorArgument: argument,
        validatorArgument: "Accepted without a validator flag; disputed by the requester after acceptance.",
        status: DisputeStatus.open,
      },
    });

    await tx.submission.update({
      where: { id: sub.id },
      data: { status: SubmissionStatus.disputed },
    });

    const notifyData = { item: sub.title, bounty: sub.bounty.title, reason };

    // 1. The contributor whose accepted work is being contested.
    if (sub.contributorUserId !== userId) {
      await notifyEvent(tx, "issue.sponsor_disputed", {
        userId: sub.contributorUserId,
        entityId: sub.id,
        linkBountyId: sub.bountyId,
        keySuffix: disp.id,
        data: notifyData,
      });
    }

    // 2. Operators — admin-arbitrated, never auto-resolved by either side.
    await notifyAdminsEvent(tx, "admin.dispute_filed", {
      entityId: sub.id,
      keySuffix: disp.id,
      data: notifyData,
    });

    return disp;
  }, { timeout: 15_000 });
}
