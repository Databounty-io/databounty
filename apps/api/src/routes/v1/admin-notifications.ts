// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { NotificationDeliveryStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_ONLY, ADMIN_AND_ABOVE_READONLY, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";

/**
 * Operator surface backing community/apps/admin's /notifications page:
 * delivery health (real NotificationDelivery rows, grouped by channel and
 * status) and dead-letter retry. `rotate-keys` is the one action this route
 * does NOT implement for real — there is no encrypted-secret store to
 * rotate. NotificationChannel has no secret column at all (its own schema
 * comment: "Never store provider response bodies, webhook URLs, OAuth
 * tokens, or other secrets here"), and nothing under src/lib or src/services
 * implements envelope encryption or a key-version field for ProfileSource's
 * accessTokenEnc/refreshTokenEnc either (searched: no crypto/encrypt module
 * exists). Rotating keys that were never encrypted with a versioned key is
 * not a real operation, so this responds honestly with 501 rather than
 * faking a rotation count.
 */

const healthQuery = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 90).optional(),
});

const retryBody = z.object({
  reason: z.string().trim().min(10).max(1000),
});

// Same deep-link convention used elsewhere in this console (see
// components/admin-shell.tsx's BountyCell / users/view/view.tsx) — a real
// URL built from the notification's own stored entity reference, not a
// fabricated one. Falls back to the bell's own page when there's nothing
// more specific to link to.
function adminNotificationHref(n: { entityType: string | null; entityId: string | null; linkBountyId: string | null }): string {
  if (n.linkBountyId) return `/details?kind=bounty&id=${encodeURIComponent(n.linkBountyId)}`;
  if (n.entityType && n.entityId) return `/details?kind=${encodeURIComponent(n.entityType)}&id=${encodeURIComponent(n.entityId)}`;
  return "/notifications";
}

export async function adminNotificationOpsRoutes(app: FastifyInstance) {
  // Admin's own bell-feed: Notification rows are per-recipient (one row per
  // admin, per event — see notifyAdmins() in services/notifications.ts).
  // Scoped to `type` starting with "admin." (every admin-audience event in
  // the catalog — admin.dispute_filed, admin.new_signup, etc. — uses this
  // prefix consistently) so this stays the admin-scoped feed the page's own
  // copy promises ("Platform events addressed to admins — disputes,
  // signups, and escalations"), not this admin user's full personal
  // notification history from whatever other roles they also hold. Without
  // this, an account with both admin and contributor/validator roles (the
  // only kind of admin account local dev has) sees their own submission/
  // karma/audit notifications leak into what's supposed to be an
  // admin-only operations feed.
  app.get("/notifications", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = req.query as { limit?: string; unread?: string };
    const take = Math.min(query.limit ? Number(query.limit) : 50, 100);
    const where = {
      userId: user.id,
      type: { startsWith: "admin." },
      ...(query.unread === "true" ? { read: false } : {}),
    };

    const [rows, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take }),
      prisma.notification.count({ where: { userId: user.id, type: { startsWith: "admin." }, read: false } }),
    ]);

    return reply.send({
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
        href: adminNotificationHref(n),
      })),
      unreadCount,
    });
  });

  app.post("/notifications/:id/read", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    await prisma.notification.updateMany({ where: { id, userId: user.id }, data: { read: true } });
    return reply.send({ ok: true });
  });

  app.post("/notifications/read-all", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    await prisma.notification.updateMany({
      where: { userId: user.id, type: { startsWith: "admin." }, read: false },
      data: { read: true },
    });
    return reply.send({ ok: true });
  });

  app.get("/notifications/health", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = healthQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const windowHours = parsed.data.hours ?? 24;
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const [grouped, deadLetterCount, deadLetters] = await Promise.all([
      prisma.notificationDelivery.groupBy({
        by: ["channel", "status"],
        where: { createdAt: { gte: cutoff } },
        _count: { _all: true },
      }),
      prisma.notificationDelivery.count({ where: { status: NotificationDeliveryStatus.dead } }),
      prisma.notificationDelivery.findMany({
        where: { status: NotificationDeliveryStatus.dead },
        orderBy: { updatedAt: "desc" },
        take: 100,
        include: { notification: { select: { userId: true, type: true, title: true } } },
      }),
    ]);

    const byChannel: Record<string, { pending: number; processing: number; sent: number; failed: number; dead: number; total: number }> = {};
    for (const row of grouped) {
      const bucket = (byChannel[row.channel] ??= { pending: 0, processing: 0, sent: 0, failed: 0, dead: 0, total: 0 });
      bucket[row.status as "pending" | "processing" | "sent" | "failed" | "dead"] += row._count._all;
      bucket.total += row._count._all;
    }

    return reply.send({
      windowHours,
      byChannel,
      deadLetterCount,
      deadLettersTruncated: deadLetterCount > deadLetters.length,
      deadLetters: deadLetters.map((d) => ({
        id: d.id,
        channel: d.channel,
        attempts: d.attempts,
        lastError: d.lastError,
        updatedAt: d.updatedAt.toISOString(),
        notification: d.notification,
      })),
    });
  });

  app.post("/notifications/dead-letters/:id/retry", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = retryBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const delivery = await prisma.notificationDelivery.findUnique({ where: { id } });
    if (!delivery) return reply.notFound("Delivery not found");
    if (delivery.status !== NotificationDeliveryStatus.dead) return reply.badRequest("Only dead-lettered deliveries can be retried");

    await prisma.$transaction(async (tx) => {
      await tx.notificationDelivery.update({
        where: { id },
        data: { status: NotificationDeliveryStatus.pending, nextAttemptAt: null },
      });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.notification_delivery.retried",
        targetType: "NotificationDelivery",
        targetId: id,
        metadata: { reason: parsed.data.reason, channel: delivery.channel, priorAttempts: delivery.attempts },
        ip: req.ip,
      });
    });

    return reply.send({ ok: true, id });
  });

  // Honest 501: no versioned-key encryption exists for either candidate
  // secret store (NotificationChannel has no secret column; ProfileSource's
  // accessTokenEnc/refreshTokenEnc are stored with no key-version field and
  // no encrypt/rotate module implements them). A fabricated rotation count
  // would be a false trust claim, so this reports the real gap instead.
  app.post("/notifications/rotate-keys", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (_req, reply) => {
    return reply.status(501).send({
      statusCode: 501,
      error: "Not Implemented",
      message:
        "Key rotation is not implemented. NotificationChannel stores no secret to rotate, and ProfileSource's encrypted tokens have no key-version field or rotation module backing them yet.",
    });
  });
}
