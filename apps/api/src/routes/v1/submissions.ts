// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { fileSubmissionDispute } from "../../services/disputes.js";
import { requireAuth, requireVerifiedEmail, requireScope, requireAnyScope, type AuthedUser } from "../../lib/rbac.js";
import {
  createPoolSubmission,
  submitPoolBatchItems,
  getSubmissionById,
  listSubmissions,
  reviseSubmission,
  ReviseSubmissionError,
  rerunSubmissionValidation,
  RerunValidationError,
} from "../../services/submissions.js";
import { notifyAdminsEvent, notifyEvent } from "../../services/notifications.js";
import { GenerationMethod, FlagReason, DisputeStatus, SubmissionStatus, ApiKeyScope } from "@prisma/client";
import { disputeAcceptedSubmission, SponsorEvidenceError } from "../../services/sponsor-evidence.js";
import { llmValidationEnabled } from "../../services/admin-settings.js";
import { openRouterConfigured } from "../../services/llm-client.js";

const singleSubmissionBody = z.object({
  bountyId: z.string().min(1),
  title: z.string().trim().min(3).max(120),
  payloadJson: z.record(z.unknown()),
  generationMethod: z.nativeEnum(GenerationMethod).default(GenerationMethod.human),
});

const bulkSubmissionBody = z.object({
  bountyId: z.string().min(1),
  items: z.array(
    z.object({
      title: z.string().trim().min(3).max(120),
      payloadJson: z.record(z.unknown()),
      generationMethod: z.nativeEnum(GenerationMethod).optional(),
    })
  ).min(1).max(500),
});

const reviseBody = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  payloadJson: z.record(z.unknown()),
});

const disputeBody = z.object({
  contributorArgument: z.string().trim().min(10).max(2000),
});

const disputeAcceptanceBody = z.object({
  reason: z.nativeEnum(FlagReason),
  argument: z.string().trim().min(10).max(2000),
});

export async function submissionRoutes(app: FastifyInstance) {
  // Single submission intake
  app.post("/", { preHandler: [requireAnyScope(ApiKeyScope.contribute), requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = singleSubmissionBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    try {
      const submission = await createPoolSubmission({
        bountyId: parsed.data.bountyId,
        contributorUserId: user.id,
        title: parsed.data.title,
        payloadJson: parsed.data.payloadJson,
        generationMethod: parsed.data.generationMethod,
      });

      return reply.status(201).send({ submission });
    } catch (err: any) {
      return reply.badRequest(err.message);
    }
  });

  // Bulk submission intake
  app.post("/bulk", { preHandler: [requireAnyScope(ApiKeyScope.contribute), requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = bulkSubmissionBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    try {
      const result = await submitPoolBatchItems({
        bountyId: parsed.data.bountyId,
        contributorUserId: user.id,
        items: parsed.data.items,
      });

      return reply.status(201).send(result);
    } catch (err: any) {
      return reply.badRequest(err.message);
    }
  });

  // List Submissions
  app.get("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = req.query as { bountyId?: string; status?: SubmissionStatus; limit?: string; offset?: string };

    const submissions = await listSubmissions({
      bountyId: query.bountyId,
      contributorUserId: user.id,
      status: query.status,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });

    return reply.send(submissions);
  });

  // Get Submission Details
  app.get("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };

    const sub = await getSubmissionById(id);
    if (!sub) return reply.notFound("Submission not found");

    if (sub.contributorUserId !== user.id && !user.roles.includes("admin")) {
      return reply.forbidden("Access denied");
    }

    // Same field name and same placement as v1 (routes/v1/submissions.ts:252
    // puts `llmValidationEnabled` inside the `submission` object), so the
    // dashboard's submission-detail view needs no translation layer.
    //
    // Without this the frontend could not tell "LLM review is switched off"
    // apart from "LLM review is on but nothing has been recorded yet" — an
    // absent `llm` ValidationResult row means both. The pair below resolves it:
    //   llmValidationEnabled === false           ⇒ switched off; the stage is
    //                                              not part of the pipeline
    //                                              and no row will ever appear.
    //   true  + no `llm` row yet                 ⇒ on, still in flight.
    //   true  + row with outcome
    //           "no_provider_configured"         ⇒ on, but no provider wired
    //                                              up; held for human review.
    // `llmProviderConfigured` reports that second fact directly, so the
    // distinction holds even before the first evidence row is written. The two
    // are never merged into one "effective" boolean.
    return reply.send({
      submission: {
        ...sub,
        llmValidationEnabled: await llmValidationEnabled(),
        llmProviderConfigured: openRouterConfigured(),
      },
    });
  });

  // Revise Submission
  app.post("/:id/revise", { preHandler: [requireAnyScope(ApiKeyScope.contribute), requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = reviseBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    try {
      const revised = await reviseSubmission({
        submissionId: id,
        contributorUserId: user.id,
        title: parsed.data.title,
        payloadJson: parsed.data.payloadJson,
      });

      return reply.send({ submission: revised });
    } catch (err: any) {
      // A refused revise is a state conflict, not a malformed request: the
      // body was fine, the submission just isn't (or is no longer) revisable.
      // Flattening all of these into 400 gave an agent no way to tell "fix
      // your payload" from "you are out of attempts".
      if (err instanceof ReviseSubmissionError) {
        if (err.code === "not_found") return reply.notFound(err.message);
        return reply.conflict(err.message);
      }
      return reply.badRequest(err.message);
    }
  });

  // Re-run a completed automated attempt without replacing the contributor's
  // item. Human-validator decisions intentionally have no route here.
  app.post("/:id/rerun-validation", { preHandler: [requireAnyScope(ApiKeyScope.contribute), requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    try {
      const submission = await rerunSubmissionValidation({ submissionId: id, contributorUserId: user.id });
      return reply.status(202).send({ submission });
    } catch (err) {
      if (err instanceof RerunValidationError) {
        if (err.code === "not_found") return reply.notFound(err.message);
        return reply.conflict(err.message);
      }
      throw err;
    }
  });

  // Dispute Submission
  app.post("/:id/dispute", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = disputeBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    // Shared with the `dispute_submission` MCP tool via services/disputes.ts.
    // The two used to be separate implementations and the MCP copy had no
    // state gate, fabricated a validator note, and skipped both the status
    // flip and all three notifications — see that file's header.
    const result = await fileSubmissionDispute({
      submissionId: id,
      contributorUserId: user.id,
      contributorArgument: parsed.data.contributorArgument,
    });

    if (!result.ok) {
      return result.reason === "not_found"
        ? reply.notFound("Submission not found or access denied")
        : reply.badRequest("Only flagged or rejected submissions can be disputed");
    }

    return reply.status(201).send({ dispute: result.dispute });
  });

  // Dispute an ACCEPTED submission — the requester's counterpart to the
  // contributor `/dispute` route above. The contributor disputes a
  // flagged/rejected verdict; the requester (community "sponsor") disputes an
  // `ok` verdict that already went through, during the post-accept hold
  // window. Gated to the pool's owner the same way as
  // `POST /:id/sponsor-review/:submissionId` in routes/v1/bounties.ts
  // (`requireAuth` + a manual `communityRequesterUserId ?? requesterUserId`
  // ownership check; the `sponsor` API-key scope gates the MCP tool and the
  // evidence route, an admin may also dispute). Reuses the SAME hold-window anchor
  // (`holdReleasesAt`/`defaultDisputeWindowHours` from services/karma-holds.ts)
  // that gates when a submission's karma award releases, rather than
  // inventing a second, possibly-inconsistent window calculation — see
  // karma-holds.ts's `holdReleasesAt` doc comment for why the anchor is
  // `max(bounty.disputeCycleWindowOpensAt, submission.acceptedAt)`.
  //
  // On success: same shape as the contributor path — a `Dispute` row, the
  // submission flips to `disputed`, and the three interested parties are
  // notified in the SAME transaction (transactional outbox): the contributor
  // (`issue.sponsor_disputed`), and operators (`admin.dispute_filed` — a
  // dispute is always admin-arbitrated, never auto-resolved by either side).
  // Does NOT claw back karma here — that only happens if/when an admin
  // upholds the dispute (a separate, not-yet-built resolution route mirroring
  // v1's admin.ts `resolveDispute`), matching v1's own file-a-dispute route
  // which also defers the clawback to resolution time.
  //
  // The validation, window check, transaction and notifications live in
  // services/sponsor-evidence.ts `disputeAcceptedSubmission`, shared with the
  // MCP tool `dispute_accepted_submission`.
  app.post("/:id/dispute-acceptance", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = disputeAcceptanceBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("Provide a reason and an explanation of why this accepted item is disputed.");

    try {
      const dispute = await disputeAcceptedSubmission({
        submissionId: id,
        userId: user.id,
        callerRoles: user.roles,
        reason: parsed.data.reason,
        argument: parsed.data.argument,
      });
      return reply.status(201).send({ dispute });
    } catch (err) {
      if (err instanceof SponsorEvidenceError) {
        if (err.code === "not_found") return reply.notFound(err.message);
        if (err.code === "forbidden") return reply.forbidden(err.message);
        return reply.conflict(err.message);
      }
      throw err;
    }
  });
}
