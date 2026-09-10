// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentIssueCategory, AgentIssueImpact, AgentIssueSeverity, AgentIssueStatus, type AgentIssue, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_ONLY, ADMIN_AND_MEMBER, ADMIN_AND_ABOVE_READONLY, type AuthedUser } from "../../lib/rbac.js";
import { isIssueClosed } from "../../services/issues.js";
import { notifyUser } from "../../services/notifications.js";

/**
 * Admin/staff-facing agent-issues queue: community/apps/admin's /issues and
 * /issues/view pages (lib/agent-issues.ts). This is distinct from the
 * reporter-facing `issues.ts` routes at /v1/issues — staff can see and act on
 * every case, not just their own, and every mutation carries optimistic
 * concurrency (`expectedVersion`) matching AgentIssue.version so two admins
 * cannot silently overwrite each other's disposition (409 on mismatch).
 */

function serializeRow(issue: AgentIssue) {
  return {
    id: issue.id,
    status: issue.status,
    category: issue.category,
    impact: issue.impact,
    severity: issue.severity,
    summary: issue.summary,
    source: issue.source,
    reporterLabel: issue.reporterLabel,
    assignedToUserId: issue.assignedToUserId,
    canonicalIssueId: issue.canonicalIssueId,
    contextCollection: issue.contextCollection as "pending" | "complete" | "partial" | "unavailable",
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
    version: issue.version,
  };
}

const listQuery = z.object({
  status: z.nativeEnum(AgentIssueStatus).optional(),
  category: z.nativeEnum(AgentIssueCategory).optional(),
  impact: z.nativeEnum(AgentIssueImpact).optional(),
  severity: z.nativeEnum(AgentIssueSeverity).optional(),
  source: z.enum(["mcp_oauth", "api_key", "session"]).optional(),
  q: z.string().trim().min(2).max(200).optional(),
  includeClosed: z.enum(["true", "false"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const assignBody = z.object({
  expectedVersion: z.number().int(),
  assignedToUserId: z.string().nullable().optional(),
  severity: z.nativeEnum(AgentIssueSeverity).nullable().optional(),
});

const requestInfoBody = z.object({
  expectedVersion: z.number().int(),
  question: z.string().trim().min(5).max(2000),
});

const OPEN_STATUS_ACTIONS: AgentIssueStatus[] = [
  AgentIssueStatus.triaged,
  AgentIssueStatus.investigating,
  AgentIssueStatus.resolved,
  AgentIssueStatus.not_reproducible,
  AgentIssueStatus.rejected,
  AgentIssueStatus.duplicate,
];

const statusBody = z.object({
  expectedVersion: z.number().int(),
  status: z.enum(OPEN_STATUS_ACTIONS as [AgentIssueStatus, ...AgentIssueStatus[]]),
  reason: z.string().trim().max(2000).optional(),
  resolutionRef: z.string().trim().max(500).optional(),
  canonicalIssueId: z.string().trim().optional(),
});

const noteBody = z.object({
  body: z.string().trim().min(2).max(2000),
});

/** Dispositions the reporter must be told why — mirrors the admin console's
 * `requiresReason()` in lib/agent-issues.ts. */
function requiresReason(status: AgentIssueStatus): boolean {
  return (
    status === AgentIssueStatus.resolved ||
    status === AgentIssueStatus.rejected ||
    status === AgentIssueStatus.not_reproducible ||
    status === AgentIssueStatus.duplicate
  );
}

export async function adminIssueRoutes(app: FastifyInstance) {
  // Server-side filtered, cursor-paginated staff queue. Sorted worst-impact
  // first (AgentIssueImpact is declared blocked < degraded < suggestion in
  // schema.prisma, and Postgres orders enum columns by declaration order),
  // then most recent within a tier.
  app.get("/issues", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const q = parsed.data;
    const limit = q.limit ?? 25;
    const includeClosed = q.includeClosed === "true";

    const where: Prisma.AgentIssueWhereInput = {
      ...(q.status ? { status: q.status } : includeClosed ? {} : { status: { notIn: [AgentIssueStatus.resolved, AgentIssueStatus.rejected, AgentIssueStatus.not_reproducible, AgentIssueStatus.duplicate] } }),
      ...(q.category ? { category: q.category } : {}),
      ...(q.impact ? { impact: q.impact } : {}),
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.q ? { summary: { contains: q.q, mode: "insensitive" } } : {}),
    };

    const rows = await prisma.agentIssue.findMany({
      where,
      orderBy: [{ impact: "asc" }, { createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;

    return reply.send({ items: page.map(serializeRow), nextCursor });
  });

  // Queue health: counts about the BACKLOG, not any one case. `unassigned`
  // deliberately counts only brand-new, unowned work (received + no owner),
  // not every open-but-unassigned case further down the pipeline.
  app.get("/issues-health", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (_req, reply) => {
    const closedStatuses = [AgentIssueStatus.resolved, AgentIssueStatus.rejected, AgentIssueStatus.not_reproducible, AgentIssueStatus.duplicate];
    const [open, partialContext, unassigned] = await Promise.all([
      prisma.agentIssue.count({ where: { status: { notIn: closedStatuses } } }),
      prisma.agentIssue.count({ where: { status: { notIn: closedStatuses }, contextCollection: { not: "complete" } } }),
      prisma.agentIssue.count({ where: { status: AgentIssueStatus.received, assignedToUserId: null } }),
    ]);
    return reply.send({ open, partialContext, unassigned });
  });

  app.get("/issues/:id", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = await prisma.agentIssue.findUnique({
      where: { id },
      include: { events: { orderBy: { createdAt: "asc" } } },
    });
    if (!issue) return reply.notFound("Issue not found");

    const duplicates = await prisma.agentIssue.findMany({
      where: { canonicalIssueId: id },
      select: { id: true, summary: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return reply.send({
      ...serializeRow(issue),
      expected: issue.expected,
      actual: issue.actual,
      steps: issue.steps,
      logExcerpt: issue.logExcerpt,
      context: (issue.context as Record<string, unknown> | null) ?? null,
      redactionApplied: issue.redactionApplied,
      resolutionNote: issue.resolutionNote,
      resolutionRef: issue.resolutionRef,
      resolvedAt: issue.resolvedAt ? issue.resolvedAt.toISOString() : null,
      clientName: issue.clientName,
      toolName: issue.toolName,
      events: issue.events.map((e) => ({
        id: e.id,
        type: e.type,
        body: e.body,
        actorRole: e.actorRole,
        internalOnly: e.internalOnly,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
      })),
      duplicates: duplicates.map((d) => ({ id: d.id, summary: d.summary, status: d.status, createdAt: d.createdAt.toISOString() })),
    });
  });

  // Advisory-only fingerprint match — never auto-merged. Excludes the case
  // itself and anything already merged under it.
  app.get("/issues/:id/duplicate-candidates", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = await prisma.agentIssue.findUnique({ where: { id }, select: { fingerprint: true } });
    if (!issue) return reply.notFound("Issue not found");

    const candidates = await prisma.agentIssue.findMany({
      where: { fingerprint: issue.fingerprint, id: { not: id }, canonicalIssueId: null },
      select: { id: true, summary: true, status: true, reporterLabel: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    return reply.send({
      candidates: candidates.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
      advisory: true,
    });
  });

  app.post("/issues/:id/assign", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = assignBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const issue = await prisma.agentIssue.findUnique({ where: { id } });
    if (!issue) return reply.notFound("Issue not found");
    if (issue.version !== parsed.data.expectedVersion) {
      return reply.status(409).send({ statusCode: 409, error: "Conflict", message: "This issue changed since you loaded it." });
    }

    const data: Prisma.AgentIssueUpdateInput = { version: { increment: 1 } };
    if (parsed.data.assignedToUserId !== undefined) data.assignedTo = parsed.data.assignedToUserId ? { connect: { id: parsed.data.assignedToUserId } } : { disconnect: true };
    if (parsed.data.severity !== undefined) data.severity = parsed.data.severity;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.agentIssue.update({ where: { id }, data });
      await tx.agentIssueEvent.create({
        data: {
          issueId: id,
          actorUserId: user.id,
          actorRole: "staff",
          // Internal housekeeping — not new information for the reporter.
          internalOnly: true,
          type: parsed.data.severity !== undefined ? "severity_changed" : "assigned",
          body:
            parsed.data.assignedToUserId !== undefined
              ? parsed.data.assignedToUserId
                ? `Assigned to ${parsed.data.assignedToUserId}`
                : "Assignment cleared"
              : parsed.data.severity !== undefined
                ? `Severity set to ${parsed.data.severity ?? "unset"}`
                : null,
        },
      });
      return row;
    });

    return reply.send({ id: updated.id, version: updated.version });
  });

  app.post("/issues/:id/request-info", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = requestInfoBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const issue = await prisma.agentIssue.findUnique({ where: { id } });
    if (!issue) return reply.notFound("Issue not found");
    if (isIssueClosed(issue.status)) return reply.status(409).send({ statusCode: 409, error: "Conflict", message: "This case is closed." });
    if (issue.version !== parsed.data.expectedVersion) {
      return reply.status(409).send({ statusCode: 409, error: "Conflict", message: "This issue changed since you loaded it." });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.agentIssue.update({
        where: { id },
        data: { status: AgentIssueStatus.needs_info, version: { increment: 1 } },
      });
      await tx.agentIssueEvent.create({
        data: {
          issueId: id,
          actorUserId: user.id,
          actorRole: "staff",
          type: "info_requested",
          body: parsed.data.question,
          internalOnly: false,
        },
      });
      return row;
    });

    if (issue.reporterUserId) {
      await notifyUser({
        userId: issue.reporterUserId,
        type: "agent_issue.info_requested",
        title: "More information needed on your report",
        body: parsed.data.question,
        entityType: "AgentIssue",
        entityId: id,
      });
    }

    return reply.send({ id: updated.id, status: updated.status, version: updated.version });
  });

  app.post("/issues/:id/status", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = statusBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const { status, reason, resolutionRef, canonicalIssueId } = parsed.data;

    if (status === AgentIssueStatus.duplicate && (!canonicalIssueId || canonicalIssueId.length === 0)) {
      return reply.badRequest("canonicalIssueId is required to merge as a duplicate");
    }
    if (requiresReason(status) && (!reason || reason.trim().length < 3)) {
      return reply.badRequest("A reporter-visible reason is required for this disposition");
    }
    // Merging duplicates is deliberately gated tighter (admin-only) than the
    // other dispositions (admin or member) — matches the console's isAdmin
    // check gating that button.
    if (status === AgentIssueStatus.duplicate) {
      const has = user.roles.includes("admin");
      if (!has) return reply.forbidden("Merging duplicates requires the admin role.");
    }

    const issue = await prisma.agentIssue.findUnique({ where: { id } });
    if (!issue) return reply.notFound("Issue not found");
    if (isIssueClosed(issue.status)) return reply.status(409).send({ statusCode: 409, error: "Conflict", message: "This case is already closed." });
    if (issue.version !== parsed.data.expectedVersion) {
      return reply.status(409).send({ statusCode: 409, error: "Conflict", message: "This issue changed since you loaded it." });
    }

    if (status === AgentIssueStatus.duplicate) {
      const canonical = await prisma.agentIssue.findUnique({ where: { id: canonicalIssueId! }, select: { id: true } });
      if (!canonical) return reply.badRequest("canonicalIssueId does not refer to an existing issue");
      if (canonical.id === id) return reply.badRequest("An issue cannot be a duplicate of itself");
    }

    const closed = isIssueClosed(status);
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.agentIssue.update({
        where: { id },
        data: {
          status,
          version: { increment: 1 },
          ...(closed
            ? {
                resolvedAt: new Date(),
                resolutionNote: reason ?? null,
                resolutionRef: resolutionRef ?? null,
              }
            : {}),
          ...(status === AgentIssueStatus.duplicate ? { canonicalIssueId } : {}),
        },
      });
      await tx.agentIssueEvent.create({
        data: {
          issueId: id,
          actorUserId: user.id,
          actorRole: "staff",
          type: status === AgentIssueStatus.duplicate ? "merged" : "status_changed",
          body: reason ?? null,
          internalOnly: false,
        },
      });
      return row;
    });

    if (issue.reporterUserId) {
      await notifyUser({
        userId: issue.reporterUserId,
        type: "agent_issue.status_changed",
        title: `Your report was marked ${status.replace(/_/g, " ")}`,
        body: reason ?? "No additional detail was recorded.",
        entityType: "AgentIssue",
        entityId: id,
      });
    }

    return reply.send({ id: updated.id, status: updated.status, version: updated.version });
  });

  // Internal note. No expectedVersion: unlike the disposition/assignment
  // actions, a note never changes state another admin could race against —
  // it only appends to the internal-only timeline.
  app.post("/issues/:id/notes", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = noteBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const issue = await prisma.agentIssue.findUnique({ where: { id }, select: { id: true } });
    if (!issue) return reply.notFound("Issue not found");

    const event = await prisma.agentIssueEvent.create({
      data: {
        issueId: id,
        actorUserId: user.id,
        actorRole: "staff",
        type: "note",
        body: parsed.data.body,
        internalOnly: true,
      },
    });

    return reply.status(201).send({ id: event.id, createdAt: event.createdAt.toISOString() });
  });
}
