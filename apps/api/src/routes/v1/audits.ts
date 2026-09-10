// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireVerifiedEmail, requireAnyScope, type AuthedUser } from "../../lib/rbac.js";
import {
  listAvailableAudits,
  getClaimedAuditWindowDetail,
  claimAuditWindow,
  submitAuditDecisions,
  AuditWindowNotClaimedError,
  AuditWindowClaimedByOtherError,
  AuditWindowNotFoundError,
  AuditWindowSettledError,
  AuditWindowSupersededError,
  AuditItemNotInWindowError,
  AuditOwnSubmissionError,
  AuditItemAlreadyDecidedError,
  AuditFlagNoteRequiredError,
} from "../../services/audits.js";
import { AuditVerdict, FlagReason, ApiKeyScope } from "@prisma/client";

function parseCsv(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

const decisionsBody = z.object({
  decisions: z.array(
    z.object({
      auditItemId: z.string().min(1),
      verdict: z.nativeEnum(AuditVerdict),
      flagReason: z.nativeEnum(FlagReason).optional(),
      note: z.string().trim().optional(),
    })
  ).min(1),
});

export async function auditRoutes(app: FastifyInstance) {
  // List available audit windows — real HumanAuditWindow rows this validator
  // may still act on (open, unclaimed, with pending items, and free of any
  // audit conflict for the caller). A window claimed by anyone (including the
  // caller) is no longer "available" — see services/audits.ts
  // listAvailableAudits. The conflict rule is services/audits.ts
  // auditConflictReasonFor, the SAME predicate POST /:id/claim enforces: a
  // window containing the caller's own contribution is withheld here and
  // refused there, so this listing never advertises work the claim would
  // reject with a 403.
  app.get("/", { preHandler: [requireAnyScope(ApiKeyScope.validate, ApiKeyScope.read)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = req.query as {
      bountyId?: string;
      domains?: string;
      categories?: string;
      languages?: string;
      search?: string;
      q?: string;
      limit?: string;
      offset?: string;
      skip?: string;
    };
    const result = await listAvailableAudits({
      validatorUserId: user.id,
      bountyId: query.bountyId,
      // v1's `GET /audits?domains=` axis, restored alongside the narrower
      // category filter (see listAvailableAudits).
      domains: parseCsv(query.domains),
      categories: parseCsv(query.categories),
      languages: parseCsv(query.languages),
      search: query.search ?? query.q,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset != null ? Number(query.offset) : query.skip != null ? Number(query.skip) : undefined,
    });
    return reply.send(result);
  });

  // POST /v1/audits/:id/claim (T1). Exclusive per-validator claim on a
  // HumanAuditWindow — the batch the owner's requirement describes ("the
  // validator claims a batch, 50–100, adjustable from admin"). See
  // services/audits.ts claimAuditWindow for the atomic-updateMany exclusivity
  // mechanism (mirrors v1 routes/v1/audits.ts:482).
  app.post("/:id/claim", { preHandler: [requireAnyScope(ApiKeyScope.validate), requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const result = await claimAuditWindow({ windowId: id, validatorUserId: user.id });
    if (!result.ok) {
      if (result.reason === "not_found") return reply.notFound("Audit window not found");
      if (result.reason === "forbidden") return reply.forbidden("cannot claim an audit window that conflicts with your own submissions");
      if (result.reason === "capacity") {
        // A real, legitimate current-state conflict (409), not a bad request:
        // enforced by the same atomic per-validator capacity check inside
        // services/audits.ts claimAuditWindow that this rejection reason
        // comes from — never a silent failure or a generic message.
        return reply.conflict(
          `you are already holding your maximum of ${result.maxConcurrentAudits} concurrent audits for your rank`
        );
      }
      return reply.conflict("audit window was claimed by another validator");
    }
    return reply.send({
      audit: {
        ...result.window,
        claimedAt: result.window.claimedAt.toISOString(),
        claimExpiresAt: result.window.claimExpiresAt.toISOString(),
        deadline: result.window.claimExpiresAt.toISOString(),
        kind: "community" as const,
        status: "claimed" as const,
      },
    });
  });

  // Get Audit Window Details — evidence (item payloads, attachments,
  // validation logs) is gated behind the claim (T1): 409 if nobody has
  // claimed it yet, 403 if someone else holds it, mirroring v1
  // routes/v1/audits.ts:339-340.
  app.get("/:id", { preHandler: [requireAnyScope(ApiKeyScope.validate, ApiKeyScope.read)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const result = await getClaimedAuditWindowDetail(id, user.id);
    if (result.reason === "not_found") return reply.notFound("Audit window not found");
    if (result.reason === "forbidden") return reply.forbidden("cannot view an audit window that conflicts with your own submissions");
    if (result.reason === "unclaimed") return reply.conflict("claim the audit before viewing submission evidence");
    if (result.reason === "claimed_by_other") return reply.forbidden("audit is claimed by another validator");
    return reply.send({ audit: result.detail, sponsorReferences: result.detail.sponsorReferences });
  });

  // Submit Decisions for Audit Window — one or more items at once, keyed by
  // HumanAuditWindowMembership id (`auditItemId`). Only the window's
  // claimant may decide its items (T1) — see AuditWindowNotClaimedError /
  // AuditWindowClaimedByOtherError below.
  app.post("/:id/decisions", { preHandler: [requireAnyScope(ApiKeyScope.validate), requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = decisionsBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    try {
      const result = await submitAuditDecisions({
        windowId: id,
        validatorUserId: user.id,
        decisions: parsed.data.decisions,
      });

      return reply.send(result);
    } catch (err) {
      // Only the deliberate, typed conditions submitAuditDecisions throws are
      // caller-facing here — each mapped to the same status v1 used for the
      // equivalent state. Anything else (a raw Prisma/db error, a timeout, an
      // unrelated bug) is deliberately NOT caught: it falls through to the
      // app's global setErrorHandler (app.ts), which logs the real error and
      // returns a generic "An unexpected error occurred" 500 — never the
      // exception's own message. Catching every Error here and replying
      // badRequest(err.message) unconditionally is what previously let an
      // internal transaction-timeout failure ("failed to enqueue
      // leaderboard.rank_check") reach the browser as a raw 400 body.
      if (err instanceof AuditWindowNotFoundError) return reply.notFound(err.message);
      if (err instanceof AuditWindowSettledError) return reply.conflict(err.message);
      if (err instanceof AuditWindowSupersededError) return reply.conflict(err.message);
      if (err instanceof AuditWindowNotClaimedError) return reply.conflict(err.message);
      if (err instanceof AuditWindowClaimedByOtherError) return reply.forbidden(err.message);
      if (err instanceof AuditItemNotInWindowError) return reply.badRequest(err.message);
      if (err instanceof AuditOwnSubmissionError) return reply.forbidden(err.message);
      if (err instanceof AuditItemAlreadyDecidedError) return reply.conflict(err.message);
      if (err instanceof AuditFlagNoteRequiredError) return reply.badRequest(err.message);
      throw err;
    }
  });
}
