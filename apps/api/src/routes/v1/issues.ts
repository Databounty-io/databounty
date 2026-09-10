// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth, requireVerifiedEmail, type AuthedUser } from "../../lib/rbac.js";
import {
  collectIssueContext,
  createAgentIssue,
  getIssueById,
  InvalidIssueCursorError,
  issueGuidance,
  isIssueClosed,
  IssueCursorFilterMismatchError,
  listUserIssuesPage,
  replyToIssue,
} from "../../services/issues.js";
import { AgentIssueCategory, AgentIssueImpact, AgentIssueSeverity, AgentIssueStatus, type Prisma } from "@prisma/client";

const reportIssueBody = z
  .object({
    category: z.nativeEnum(AgentIssueCategory),
    impact: z.nativeEnum(AgentIssueImpact),
    severity: z.nativeEnum(AgentIssueSeverity).optional(),
    summary: z.string().trim().min(5).max(200),
    expected: z.string().trim().min(5).max(1000),
    actual: z.string().trim().min(5).max(1000),
    steps: z.string().max(4000).optional(),
    logExcerpt: z.string().max(4000).optional(),
    // The resources the report is ABOUT. Every one is resolved and authorized
    // server-side before it is stored (services/issues.ts collectIssueContext);
    // an id that does not resolve is kept as an unconfirmed claim, never as
    // context. Dropping these entirely — as this route used to — meant every
    // case arrived with nothing attached and triage had to guess.
    bountyId: z.string().max(64).optional(),
    submissionId: z.string().max(64).optional(),
    auditWindowId: z.string().max(64).optional(),
    contributorBatchId: z.string().max(64).optional(),
    datasetTypeId: z.string().max(64).optional(),
  })
  // .strict() so a typo'd field is a 400 the caller can correct, not a silently
  // dropped piece of the report it believes it filed.
  .strict();

/**
 * Full query validation. Without it `?limit=abc` reached Prisma as
 * `take: NaN` (`Number("abc")` is NaN, and NaN survives a `?? 20` guard) and
 * came back as a 500 whose body carried the Prisma error text — absolute
 * source paths and a code snippet included. `?since=garbage` did the same via
 * `new Date()`. Both are caller mistakes and must be 400s that leak nothing.
 */
const listIssuesQuery = z
  .object({
    // Wide enough for the encoded, filter-bound cursor token.
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    // z.nativeEnum, not a manual includes() that dropped the value: an
    // unrecognized status used to be ignored and the caller silently received
    // the UNFILTERED set.
    status: z.nativeEnum(AgentIssueStatus).optional(),
    // Bounded search over the summary only — a search box must not become a
    // way to grep evidence bodies.
    q: z.string().trim().min(2).max(80).optional(),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
  })
  // An inverted range is a caller mistake, not an empty result set. Saying so
  // beats returning zero rows that read as "you have no cases".
  .refine((value) => !(value.since && value.until) || value.since < value.until, {
    message: "`since` must be earlier than `until`.",
  });

const replyBody = z.object({
  body: z.string().trim().min(1).max(2000),
});

export async function issueRoutes(app: FastifyInstance) {
  // Report an issue
  app.post("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = reportIssueBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid issue report.");

    // Caller-supplied, matching v1. It used to be a body field with a
    // per-call random default, so the (reporter, key) unique index could never
    // match and a retried filing always opened a second case.
    const idempotencyKey = String(req.headers["idempotency-key"] ?? "").trim();
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) {
      return reply.badRequest("A valid Idempotency-Key header is required.");
    }

    const { bountyId, submissionId, auditWindowId, contributorBatchId, datasetTypeId, ...fields } = parsed.data;
    const collected = await collectIssueContext(user.id, {
      bountyId,
      submissionId,
      auditWindowId,
      contributorBatchId,
      datasetTypeId,
    });

    const { issue, deduplicated } = await createAgentIssue({
      reporterUserId: user.id,
      reporterLabel: user.displayName,
      source: "session",
      ...fields,
      context: collected.snapshot as unknown as Prisma.InputJsonValue,
      contextCollection: collected.collection,
      idempotencyKey,
    });

    // A deliberately NARROW projection. Returning the raw Prisma row leaked
    // reporterUserId, credentialRef, fingerprint, idempotencyKey, the whole
    // context blob, redactionApplied and version, plus every raw event with its
    // actorUserId, internalOnly flag and metadata. GET has always been
    // projected; only create was not.
    return reply.status(deduplicated ? 200 : 201).send({
      id: issue.id,
      status: issue.status,
      version: issue.version,
      createdAt: issue.createdAt.toISOString(),
      deduplicated,
      redactionApplied: issue.redactionApplied,
      contextCollection: issue.contextCollection,
      // Echoed as CLAIMS, not as resolved resources — what the caller asked
      // for, so it can tell which of them the server could confirm by reading
      // `contextCollection` and then GET /v1/issues/:id.
      claimedResources: collected.claimed,
      guidance: issueGuidance(issue.status),
      message:
        "Filed as a support case. It changes no submission, audit, or karma, and it is not a dispute. " +
        (collected.claimed.length > 0
          ? "Call get_issue to see which of the resources you named the server could confirm."
          : "Call get_issue for its current status."),
    });
  });

  // List my issues — server-side filtered, cursor-paginated. The web app's
  // /issues page (lib/agent-issues.ts fetchMyIssues) reads the page shape
  // directly (`{items, nextCursor, hasMore, issueCount}`), not `{issues}`.
  app.get("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = listIssuesQuery.safeParse(req.query);
    if (!query.success) return reply.badRequest(query.error.issues[0]?.message ?? "Invalid query.");

    try {
      const page = await listUserIssuesPage(user.id, {
        status: query.data.status ?? null,
        q: query.data.q ?? null,
        since: query.data.since ?? null,
        until: query.data.until ?? null,
        cursor: query.data.cursor ?? null,
        limit: query.data.limit,
      });
      return reply.send(page);
    } catch (err) {
      // A cursor the server cannot honour is a 400 the caller can act on,
      // never a 200 with an empty page — that shape is byte-identical to the
      // end of history and tells a reporter they have no cases when we have
      // merely lost their place.
      if (err instanceof InvalidIssueCursorError || err instanceof IssueCursorFilterMismatchError) {
        return reply.badRequest(err.message);
      }
      throw err;
    }
  });

  // Get issue details — the web app's fetchMyIssue() reads the detail object
  // directly (apiClient.get<IssueDetail>), not wrapped under `{issue}`.
  app.get("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };

    const issue = await getIssueById(id, user.id);
    if (!issue) return reply.notFound("Issue not found or access denied");
    return reply.send(issue);
  });

  // Reply to issue
  app.post("/:id/reply", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = replyBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const existing = await getIssueById(id, user.id);
    if (!existing) return reply.notFound("Issue not found or access denied");
    if (isIssueClosed(existing.status)) {
      return reply.status(409).send({
        statusCode: 409,
        error: "Conflict",
        message: "This case is closed. File a new report and reference this one.",
      });
    }

    const { status, guidance } = await replyToIssue({
      issueId: id,
      actorUserId: user.id,
      actorRole: "reporter",
      body: parsed.data.body,
    });

    return reply.status(201).send({ status, guidance });
  });
}
