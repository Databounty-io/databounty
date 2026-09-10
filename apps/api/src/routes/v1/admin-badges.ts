// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BadgeFamily, BadgeIcon, BadgeMetric } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_ONLY, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";

/**
 * Badge catalog CRUD backing community/apps/admin's /karma page. Real Badge
 * rows plus a real per-badge award count (UserBadge groupBy) for `earnedBy`
 * — never fabricated. Metric/family/icon option lists are derived from the
 * Prisma enums themselves (single source of truth with schema.prisma), not
 * duplicated constants that could drift from what the enum actually allows.
 */

const METRIC_LABELS: Record<BadgeMetric, { label: string; thresholdMeans: string; autoGrantable: boolean }> = {
  verified_credentials: { label: "Verified credentials", thresholdMeans: "Number of verified profile-source credentials.", autoGrantable: true },
  accepted_items: { label: "Accepted items", thresholdMeans: "Lifetime accepted submissions across all bounties.", autoGrantable: true },
  clean_delivery_streak: { label: "Clean delivery streak", thresholdMeans: "Consecutive accepted submissions with no rejection.", autoGrantable: true },
  completed_audits: { label: "Completed audits", thresholdMeans: "Validator audits completed.", autoGrantable: true },
  confirmed_flags: { label: "Confirmed flags", thresholdMeans: "Validator flags upheld on dispute or review.", autoGrantable: true },
  karma_total: { label: "Karma total", thresholdMeans: "Lifetime karma balance.", autoGrantable: true },
  published_datasets: { label: "Published datasets", thresholdMeans: "Community programs the member contributed to that reached publication status \"published\".", autoGrantable: true },
  flag_accuracy_pct: { label: "Flag accuracy %", thresholdMeans: "Percentage of decided flags the platform confirmed (minimum sample applies).", autoGrantable: true },
  leaderboard_rank: { label: "Leaderboard rank", thresholdMeans: "All-time open leaderboard position at or below this rank (10 = top 10).", autoGrantable: true },
  zero_abandons: { label: "Zero abandons", thresholdMeans: "Minimum accepted items required before a spotless abandon record counts.", autoGrantable: true },
  zero_dismissed_flags: { label: "Zero dismissed flags", thresholdMeans: "Minimum decided flags required before a spotless flag record counts.", autoGrantable: true },
  manual: { label: "Manual (admin-granted)", thresholdMeans: "Nothing is measured — granted by hand from this console.", autoGrantable: false },
};

const badgeBody = z.object({
  key: z.string().trim().min(1).max(64).regex(/^[a-z0-9_]+$/, "key must be lowercase snake_case"),
  family: z.nativeEnum(BadgeFamily),
  label: z.string().trim().min(1).max(200),
  criteria: z.string().trim().min(1).max(400),
  icon: z.nativeEnum(BadgeIcon),
  metric: z.nativeEnum(BadgeMetric),
  threshold: z.number().int().min(1).default(1),
  minSample: z.number().int().min(0).default(0),
  autoGranted: z.boolean().optional(),
  active: z.boolean().default(true),
});

const badgePatchBody = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  criteria: z.string().trim().min(1).max(400).optional(),
  icon: z.nativeEnum(BadgeIcon).optional(),
  threshold: z.number().int().min(1).optional(),
  minSample: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const grantBody = z.object({
  userId: z.string().trim().min(1),
  /** Optional evidence figure to record alongside a manual grant. Never
   *  invented by the server: a manual badge has no measured value unless an
   *  admin supplies one. */
  measuredValue: z.number().int().min(0).optional(),
  note: z.string().trim().max(400).optional(),
});

export async function adminBadgeRoutes(app: FastifyInstance) {
  app.get("/badges", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (_req, reply) => {
    const badges = await prisma.badge.findMany({ orderBy: [{ family: "asc" }, { sortOrder: "asc" }] });
    const counts = await prisma.userBadge.groupBy({ by: ["badgeId"], _count: { _all: true } });
    const countByBadge = new Map(counts.map((c) => [c.badgeId, c._count._all]));

    return reply.send({
      badges: badges.map((b) => ({
        id: b.id,
        key: b.key,
        family: b.family,
        label: b.label,
        criteria: b.criteria,
        icon: b.icon,
        metric: b.metric,
        threshold: b.threshold,
        minSample: b.minSample,
        autoGranted: b.autoGranted,
        active: b.active,
        sortOrder: b.sortOrder,
        earnedBy: countByBadge.get(b.id) ?? 0,
      })),
      metrics: Object.entries(METRIC_LABELS).map(([metric, info]) => ({ metric, ...info })),
      families: Object.values(BadgeFamily),
      icons: Object.values(BadgeIcon),
    });
  });

  app.post("/badges", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = badgeBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const existing = await prisma.badge.findUnique({ where: { key: parsed.data.key } });
    if (existing) return reply.conflict("A badge with this key already exists");

    const metricInfo = METRIC_LABELS[parsed.data.metric];
    const maxSort = await prisma.badge.aggregate({ _max: { sortOrder: true } });

    const badge = await prisma.$transaction(async (tx) => {
      const row = await tx.badge.create({
        data: {
          key: parsed.data.key,
          family: parsed.data.family,
          label: parsed.data.label,
          criteria: parsed.data.criteria,
          icon: parsed.data.icon,
          metric: parsed.data.metric,
          threshold: parsed.data.threshold,
          minSample: parsed.data.minSample,
          autoGranted: parsed.data.autoGranted ?? metricInfo.autoGrantable,
          active: parsed.data.active,
          sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
        },
      });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.badge.created",
        targetType: "Badge",
        targetId: row.id,
        after: { key: row.key, label: row.label, metric: row.metric, threshold: row.threshold },
        ip: req.ip,
      });
      return row;
    });

    return reply.status(201).send({ badge });
  });

  app.patch("/badges/:id", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = badgePatchBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    if (Object.keys(parsed.data).length === 0) return reply.badRequest("No fields to update");

    const existing = await prisma.badge.findUnique({ where: { id } });
    if (!existing) return reply.notFound("Badge not found");
    // A "manual" badge's threshold is not a measured cutoff — locking it here
    // matches the console's own disabled threshold input for metric==="manual".
    if (parsed.data.threshold !== undefined && existing.metric === BadgeMetric.manual) {
      return reply.badRequest("Manual badges have no measured threshold to set");
    }

    const badge = await prisma.$transaction(async (tx) => {
      const row = await tx.badge.update({ where: { id }, data: parsed.data });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.badge.updated",
        targetType: "Badge",
        targetId: id,
        before: existing,
        after: parsed.data,
        ip: req.ip,
      });
      return row;
    });

    return reply.send({ badge });
  });

  /**
   * Grant a badge to one member by hand.
   *
   * `grantBadge`/`revokeBadge` have existed in services/badges.ts the whole
   * time and are imported by routes/v1/admin.ts, but no route ever called
   * either — a dead import, and no way at all to award the `manual` badges the
   * catalog ships (e.g. founding contributor). This is that route.
   *
   * `grantedByUserId` is what makes the award show as manual everywhere it is
   * rendered, so an administrative grant is never presented as measured work.
   * Upsert, so re-granting is idempotent rather than a 409 on a double click.
   */
  app.post("/badges/:id/grant", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = grantBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const [badge, target] = await Promise.all([
      prisma.badge.findUnique({ where: { id } }),
      prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } }),
    ]);
    if (!badge) return reply.notFound("Badge not found");
    if (!target) return reply.notFound("User not found");
    // An inactive badge is one an admin deliberately withdrew from the
    // catalog. Granting it would put a badge on a profile that the console
    // itself no longer lists, with no way to see where it came from.
    if (!badge.active) return reply.badRequest("Cannot grant an inactive badge — reactivate it first");

    const award = await prisma.$transaction(async (tx) => {
      const row = await tx.userBadge.upsert({
        where: { userId_badgeId: { userId: parsed.data.userId, badgeId: id } },
        create: {
          userId: parsed.data.userId,
          badgeId: id,
          grantedByUserId: actor.id,
          measuredValue: parsed.data.measuredValue,
        },
        update: { grantedByUserId: actor.id, measuredValue: parsed.data.measuredValue },
      });
      await writeAuditLog(tx, {
        actorUserId: actor.id,
        action: "admin.badge.granted",
        targetType: "UserBadge",
        targetId: row.id,
        after: { badgeId: id, badgeKey: badge.key, userId: parsed.data.userId, note: parsed.data.note },
        ip: req.ip,
      });
      return row;
    });

    return reply.status(201).send({ award: { ...award, badge: { id: badge.id, key: badge.key, label: badge.label } } });
  });

  /**
   * Revoke one member's badge. Deliberately hard-deletes the award row (the
   * same thing `revokeBadge` does) rather than deactivating it: `UserBadge` has
   * no revoked flag, and inventing one in a JSON field would leave a badge that
   * looks held to any query that does not know about the convention. The audit
   * log is the record that it was ever held.
   */
  app.delete("/badges/:id/grant/:userId", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id, userId } = req.params as { id: string; userId: string };

    const existing = await prisma.userBadge.findUnique({
      where: { userId_badgeId: { userId, badgeId: id } },
      include: { badge: { select: { key: true, label: true } } },
    });
    if (!existing) return reply.notFound("This member does not hold that badge");

    await prisma.$transaction(async (tx) => {
      await tx.userBadge.delete({ where: { userId_badgeId: { userId, badgeId: id } } });
      await writeAuditLog(tx, {
        actorUserId: actor.id,
        action: "admin.badge.revoked",
        targetType: "UserBadge",
        targetId: existing.id,
        before: {
          badgeId: id,
          badgeKey: existing.badge.key,
          userId,
          earnedAt: existing.earnedAt.toISOString(),
          wasManual: existing.grantedByUserId != null,
        },
        ip: req.ip,
      });
    });

    // An auto-granted badge the member still qualifies for will be re-awarded
    // by the evaluator on their next profile read. Said plainly rather than
    // letting an admin believe a revoke of a measured badge is permanent.
    return reply.send({ ok: true, reGrantsAutomatically: existing.grantedByUserId == null });
  });

  app.delete("/badges/:id", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };

    const existing = await prisma.badge.findUnique({ where: { id } });
    if (!existing) return reply.notFound("Badge not found");

    await prisma.$transaction(async (tx) => {
      await tx.userBadge.deleteMany({ where: { badgeId: id } });
      await tx.badge.delete({ where: { id } });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.badge.deleted",
        targetType: "Badge",
        targetId: id,
        before: { key: existing.key, label: existing.label },
        ip: req.ip,
      });
    });

    return reply.send({ ok: true });
  });
}
