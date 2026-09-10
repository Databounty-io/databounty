// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { JobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_ONLY, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";

/**
 * Background-job operator surface backing community/apps/admin's
 * /audit-logs page (the "Failed and dead-letter jobs" panel). Real
 * JobQueue rows (see dbJobQueue in services/jobs.ts) — nothing here is
 * simulated. Every retry/resolve is itself written to AdminAuditLog so the
 * privileged-action chain covers job-queue operator actions too.
 */

const FAILURE_STATUSES: JobStatus[] = [JobStatus.failed, JobStatus.dead];

const reasonBody = z.object({
  reason: z.string().trim().min(10).max(1000),
});

export async function adminJobRoutes(app: FastifyInstance) {
  app.get("/jobs/health", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (_req, reply) => {
    const [byStatus, failures] = await Promise.all([
      prisma.jobQueue.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.jobQueue.findMany({
        where: { status: { in: FAILURE_STATUSES } },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: { id: true, type: true, status: true, attempts: true, maxAttempts: true, lastError: true, updatedAt: true },
      }),
    ]);

    return reply.send({
      byStatus: byStatus.map((row) => ({ status: row.status, _count: { _all: row._count._all } })),
      failures: failures.map((f) => ({ ...f, updatedAt: f.updatedAt.toISOString() })),
    });
  });

  // Requeues a failed/dead job. `lastError` is deliberately preserved (not
  // cleared) so the retried job's history still shows what went wrong last
  // time, and a dead job (attempts already >= maxAttempts) gets exactly one
  // more attempt by raising maxAttempts rather than resetting the counter —
  // the attempt history stays honest.
  app.post("/jobs/:id/retry", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = reasonBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const job = await prisma.jobQueue.findUnique({ where: { id } });
    if (!job) return reply.notFound("Job not found");
    if (!FAILURE_STATUSES.includes(job.status)) return reply.badRequest("Only failed or dead jobs can be retried");

    await prisma.$transaction(async (tx) => {
      await tx.jobQueue.update({
        where: { id },
        data: {
          status: JobStatus.pending,
          nextAttemptAt: null,
          maxAttempts: Math.max(job.maxAttempts, job.attempts + 1),
        },
      });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.job.retried",
        targetType: "JobQueue",
        targetId: id,
        metadata: { reason: parsed.data.reason, jobType: job.type, priorStatus: job.status },
        ip: req.ip,
      });
    });

    return reply.send({ ok: true, id });
  });

  // Closes a terminal failure without retrying it. Uses `cancelled` (not
  // `done`) — the job never actually ran successfully, so marking it "done"
  // would be a false success claim.
  app.post("/jobs/:id/resolve", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = reasonBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const job = await prisma.jobQueue.findUnique({ where: { id } });
    if (!job) return reply.notFound("Job not found");
    if (!FAILURE_STATUSES.includes(job.status)) return reply.badRequest("Only failed or dead jobs can be resolved");

    await prisma.$transaction(async (tx) => {
      await tx.jobQueue.update({
        where: { id },
        data: { status: JobStatus.cancelled, finishedAt: new Date() },
      });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.job.resolved",
        targetType: "JobQueue",
        targetId: id,
        metadata: { reason: parsed.data.reason, jobType: job.type, priorStatus: job.status },
        ip: req.ip,
      });
    });

    return reply.send({ ok: true, id });
  });
}
