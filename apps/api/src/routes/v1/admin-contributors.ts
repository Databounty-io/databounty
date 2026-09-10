// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BountyKind, ContributorBatchStatus, SubmissionStatus, UserStatus, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_AND_ABOVE_READONLY, ADMIN_AND_MEMBER, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { contributorRankForAcceptedItems } from "../../services/reputation.js";
import { revokeLiveUploadReviewDraftCapabilities } from "../../services/upload-review-drafts.js";

/**
 * Admin contributor roster backing community/apps/admin's /contributors
 * page. Every count below is a real, per-contributor Prisma aggregate over
 * Submission/ContributorBatch/Rank rows for the accounts that have claimed
 * or submitted at least once — never a fabricated placeholder.
 */

const IN_FLIGHT_SUBMISSION_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.submitted,
  SubmissionStatus.duplicate_check,
  SubmissionStatus.running_tests,
  SubmissionStatus.tests_failed,
  SubmissionStatus.llm_validation,
  SubmissionStatus.needs_fixes,
  SubmissionStatus.provisionally_accepted,
  SubmissionStatus.in_audit,
  SubmissionStatus.in_sponsor_review,
  SubmissionStatus.flagged,
  SubmissionStatus.disputed,
  SubmissionStatus.accepted_pending_sample,
];

const listQuery = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export async function adminContributorRoutes(app: FastifyInstance) {
  app.get("/contributors", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const take = parsed.data.limit ?? 25;
    const skip = parsed.data.skip ?? 0;
    const dateWhere: Prisma.DateTimeFilter | undefined =
      parsed.data.from || parsed.data.to
        ? { ...(parsed.data.from ? { gte: new Date(parsed.data.from) } : {}), ...(parsed.data.to ? { lt: new Date(parsed.data.to) } : {}) }
        : undefined;

    // "Contributor" = any account that has ever claimed a batch or submitted
    // an item — matches the page's own definition ("Every account that has
    // claimed or submitted to a dataset"). Two top-level `OR` conditions
    // (activity + search) are combined under `AND`, not merged into one
    // `OR` object — a plain object literal can only hold one `OR` key.
    const where: Prisma.UserWhereInput = {
      AND: [
        { OR: [{ submissions: { some: {} } }, { batches: { some: {} } }] },
        ...(parsed.data.search
          ? [
              {
                OR: [
                  { displayName: { contains: parsed.data.search, mode: "insensitive" as const } },
                  { email: { contains: parsed.data.search, mode: "insensitive" as const } },
                  { handle: { contains: parsed.data.search, mode: "insensitive" as const } },
                ],
              },
            ]
          : []),
      ],
    };

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        select: { id: true, displayName: true, handle: true, status: true },
      }),
    ]);

    const userIds = users.map((u) => u.id);
    const submissionDateFilter = dateWhere ? { createdAt: dateWhere } : {};

    const [byStatus, rejectedDuplicate, activeBatches, abandonedInRange, ranks] = await Promise.all([
      prisma.submission.groupBy({
        by: ["contributorUserId", "status"],
        // `bounty: { kind: BountyKind.community } }` explicit for the same
        // reason as admin.ts's /overview counts — Submission has no `kind`
        // column of its own, so the scope is expressed through the parent
        // Bounty relation.
        where: { contributorUserId: { in: userIds }, bounty: { kind: BountyKind.community }, ...submissionDateFilter },
        _count: { _all: true },
      }),
      prisma.submission.groupBy({
        by: ["contributorUserId"],
        where: {
          contributorUserId: { in: userIds },
          bounty: { kind: BountyKind.community },
          status: SubmissionStatus.rejected,
          duplicateDecision: "reject",
          ...submissionDateFilter,
        },
        _count: { _all: true },
      }),
      prisma.contributorBatch.groupBy({
        by: ["contributorUserId"],
        where: { contributorUserId: { in: userIds }, status: ContributorBatchStatus.claimed },
        _count: { _all: true },
      }),
      // ContributorBatch has no "abandonedAt" timestamp — `createdAt` (claim
      // time) is the closest available signal for the date-range filter, an
      // honest approximation rather than a fabricated abandon-time.
      prisma.contributorBatch.groupBy({
        by: ["contributorUserId"],
        where: { contributorUserId: { in: userIds }, status: ContributorBatchStatus.abandoned, ...(dateWhere ? { createdAt: dateWhere } : {}) },
        _count: { _all: true },
      }),
      prisma.rank.findMany({ where: { userId: { in: userIds } }, select: { userId: true, contributorAbandons: true } }),
    ]);

    const inFlight = await prisma.submission.groupBy({
      by: ["contributorUserId"],
      where: {
        contributorUserId: { in: userIds },
        bounty: { kind: BountyKind.community },
        status: { in: IN_FLIGHT_SUBMISSION_STATUSES },
        contributorBatchId: null,
      },
      _count: { _all: true },
    });

    const statusByUser = new Map<string, Record<string, number>>();
    for (const row of byStatus) {
      const bucket = statusByUser.get(row.contributorUserId) ?? {};
      bucket[row.status] = row._count._all;
      statusByUser.set(row.contributorUserId, bucket);
    }
    const dupByUser = new Map(rejectedDuplicate.map((r) => [r.contributorUserId, r._count._all]));
    const activeBatchByUser = new Map(activeBatches.map((r) => [r.contributorUserId, r._count._all]));
    const abandonedRangeByUser = new Map(abandonedInRange.map((r) => [r.contributorUserId, r._count._all]));
    const inFlightByUser = new Map(inFlight.map((r) => [r.contributorUserId, r._count._all]));
    const rankByUser = new Map(ranks.map((r) => [r.userId, r]));

    const contributors = users.map((u) => {
      const breakdown = statusByUser.get(u.id) ?? {};
      const submitted = Object.values(breakdown).reduce((sum, n) => sum + n, 0);
      const accepted = breakdown[SubmissionStatus.accepted] ?? 0;
      const rejected = breakdown[SubmissionStatus.rejected] ?? 0;
      const duplicateRejects = dupByUser.get(u.id) ?? 0;
      const rank = rankByUser.get(u.id);

      return {
        id: u.id,
        label: u.displayName,
        handle: u.handle,
        rank: contributorRankForAcceptedItems(accepted).name,
        restricted: u.status === UserStatus.suspended,
        activeBatches: activeBatchByUser.get(u.id) ?? 0,
        inFlightSubmissions: inFlightByUser.get(u.id) ?? 0,
        submitted,
        accepted,
        rejected,
        duplicateRate: submitted > 0 ? duplicateRejects / submitted : 0,
        // In-range abandon count when a date filter is set (matches the other
        // counts' scoping); the lifetime Rank counter otherwise, since an
        // unscoped query has no "in range" to report.
        abandonments: dateWhere ? (abandonedRangeByUser.get(u.id) ?? 0) : (rank?.contributorAbandons ?? 0),
        submissionBreakdown: breakdown,
      };
    });

    return reply.send({ total, contributors });
  });

  app.post("/contributors/:id/restrict", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const body = z.object({ restricted: z.boolean(), reason: z.string().trim().min(10).max(1000) }).safeParse(req.body);
    if (!body.success) return reply.badRequest(body.error.message);

    const existing = await prisma.user.findUnique({ where: { id }, select: { status: true } });
    if (!existing) return reply.notFound("Contributor not found");

    const newStatus = body.data.restricted ? UserStatus.suspended : UserStatus.active;
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id }, data: { status: newStatus } });
      // SEC-09 follow-up: suspension also revokes every live upload-draft
      // capability in the SAME transaction, mirroring /users/:id/restrict.
      // Re-activation deliberately does not un-revoke — the owner mints fresh
      // capabilities through the normal path.
      const revokedUploadDrafts = body.data.restricted
        ? await revokeLiveUploadReviewDraftCapabilities(tx, id)
        : 0;
      await writeAuditLog(tx, {
        actorUserId: actor.id,
        action: body.data.restricted ? "admin.contributor.restricted" : "admin.contributor.reinstated",
        targetType: "User",
        targetId: id,
        before: { status: existing.status },
        after: { status: newStatus },
        metadata: { reason: body.data.reason, revokedUploadDrafts },
        ip: req.ip,
      });
      return u;
    });

    return reply.send({ ok: true, id: updated.id, restricted: updated.status === UserStatus.suspended });
  });
}
