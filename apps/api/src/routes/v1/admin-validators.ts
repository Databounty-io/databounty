// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { FlagStatus, UserStatus, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_AND_ABOVE_READONLY, ADMIN_AND_MEMBER, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { validatorRankForAudits } from "../../services/reputation.js";
import { revokeLiveUploadReviewDraftCapabilities } from "../../services/upload-review-drafts.js";

/**
 * Admin validator roster backing community/apps/admin's /validators page.
 *
 * Flag.validatorUserId has no Prisma relation back to User (raw FK column
 * only — see prisma/schema.prisma), so "validator" membership is derived by
 * first collecting the distinct validatorUserIds that have ever raised a
 * Flag, then loading those User rows directly (same two-step pattern used
 * by admin.ts's dispute-evidence validator lookup).
 *
 * Per services/profile-summary.ts's own documented schema gap: there is no
 * per-validator claimed-audit record in this build (services/audits.ts
 * posts window-level decisions, not per-validator claims), so
 * `activeAudits` is honestly always 0 rather than fabricated. Confirmed/
 * false-flag rates are real, computed the same way getProfileSummary does
 * (Flag.status confirmed vs dismissed for that validator).
 */

const listQuery = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export async function adminValidatorRoutes(app: FastifyInstance) {
  app.get("/validators", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const take = parsed.data.limit ?? 25;
    const skip = parsed.data.skip ?? 0;
    const dateWhere: Prisma.DateTimeFilter | undefined =
      parsed.data.from || parsed.data.to
        ? { ...(parsed.data.from ? { gte: new Date(parsed.data.from) } : {}), ...(parsed.data.to ? { lt: new Date(parsed.data.to) } : {}) }
        : undefined;

    // Any account that has ever raised a Flag as a validator. No Prisma
    // relation exists on Flag.validatorUserId, so this is a raw distinct
    // scan rather than a `some: {}` filter on User.
    const flaggerIds = await prisma.flag.findMany({
      where: { validatorUserId: { not: null }, ...(dateWhere ? { createdAt: dateWhere } : {}) },
      distinct: ["validatorUserId"],
      select: { validatorUserId: true },
    });
    const validatorIds = Array.from(new Set(flaggerIds.map((f) => f.validatorUserId).filter((id): id is string => !!id)));

    const where: Prisma.UserWhereInput = {
      AND: [
        { id: { in: validatorIds } },
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
        select: { id: true, displayName: true, handle: true, status: true, createdAt: true },
      }),
    ]);

    const userIds = users.map((u) => u.id);

    const [allFlags, decidedFlags, ranks] = await Promise.all([
      prisma.flag.groupBy({
        by: ["validatorUserId", "reason"],
        where: { validatorUserId: { in: userIds } },
        _count: { _all: true },
      }),
      prisma.flag.groupBy({
        by: ["validatorUserId", "status"],
        where: { validatorUserId: { in: userIds }, status: { in: [FlagStatus.confirmed, FlagStatus.dismissed] } },
        _count: { _all: true },
      }),
      prisma.rank.findMany({ where: { userId: { in: userIds } }, select: { userId: true, validatorRank: true, auditsCompleted: true } }),
    ]);

    const flagBreakdownByUser = new Map<string, Record<string, number>>();
    const issuesFlaggedByUser = new Map<string, number>();
    for (const row of allFlags) {
      if (!row.validatorUserId) continue;
      const bucket = flagBreakdownByUser.get(row.validatorUserId) ?? {};
      bucket[row.reason] = row._count._all;
      flagBreakdownByUser.set(row.validatorUserId, bucket);
      issuesFlaggedByUser.set(row.validatorUserId, (issuesFlaggedByUser.get(row.validatorUserId) ?? 0) + row._count._all);
    }

    const decidedByUser = new Map<string, { confirmed: number; dismissed: number }>();
    for (const row of decidedFlags) {
      if (!row.validatorUserId) continue;
      const bucket = decidedByUser.get(row.validatorUserId) ?? { confirmed: 0, dismissed: 0 };
      if (row.status === FlagStatus.confirmed) bucket.confirmed = row._count._all;
      if (row.status === FlagStatus.dismissed) bucket.dismissed = row._count._all;
      decidedByUser.set(row.validatorUserId, bucket);
    }

    const rankByUser = new Map(ranks.map((r) => [r.userId, r]));

    const validators = users.map((u) => {
      const rank = rankByUser.get(u.id);
      const auditsCompleted = rank?.auditsCompleted ?? 0;
      const decided = decidedByUser.get(u.id) ?? { confirmed: 0, dismissed: 0 };
      const decidedTotal = decided.confirmed + decided.dismissed;

      return {
        id: u.id,
        label: u.displayName ?? u.handle ?? u.id,
        handle: u.handle,
        rank: (rank?.validatorRank ?? validatorRankForAudits(auditsCompleted).name) as string,
        restricted: u.status === UserStatus.suspended,
        // Honest 0 — this schema has no per-validator claimed-audit record
        // (see services/audits.ts / me.ts's /validator-dashboard comment).
        activeAudits: 0,
        auditsCompleted,
        issuesFlagged: issuesFlaggedByUser.get(u.id) ?? 0,
        confirmedRate: decidedTotal === 0 ? 0 : decided.confirmed / decidedTotal,
        falseFlagRate: decidedTotal === 0 ? 0 : decided.dismissed / decidedTotal,
        createdAt: u.createdAt,
        auditBreakdown: {},
        flagBreakdown: flagBreakdownByUser.get(u.id) ?? {},
      };
    });

    return reply.send({ total, validators });
  });

  app.post("/validators/:id/restrict", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const body = z.object({ restricted: z.boolean(), reason: z.string().trim().min(10).max(1000) }).safeParse(req.body);
    if (!body.success) return reply.badRequest(body.error.message);

    const existing = await prisma.user.findUnique({ where: { id }, select: { status: true } });
    if (!existing) return reply.notFound("Validator not found");

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
        action: body.data.restricted ? "admin.validator.restricted" : "admin.validator.reinstated",
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
