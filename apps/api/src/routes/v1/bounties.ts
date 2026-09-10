// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PHASE_STATUSES, phaseSchema, publicText } from "../../lib/public-query.js";
import { prisma } from "../../lib/prisma.js";
import { getCommunityPool, getPoolContractForBounty, listCommunityPools } from "../../services/bounties.js";
import { createBountyPoolItems, listContributorPoolSubmissions } from "../../services/submissions.js";
import { awardOrHoldAcceptedItemKarma } from "../../services/karma-holds.js";
import { listSponsorSubmissionEvidence, getSponsorSubmissionEvidence, SponsorEvidenceError } from "../../services/sponsor-evidence.js";
import { notifyUser } from "../../services/notifications.js";
import { recomputeAcceptedItemCounters } from "../../services/submission-acceptance.js";
import { enqueuePoolSampling } from "../../services/pool-lifecycle.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { requireAnyScope, requireAuth, requireScope, requireVerifiedEmail, type AuthedUser } from "../../lib/rbac.js";
import { ApiKeyScope, BountyKind, BountyStatus, FlagReason, GenerationMethod, KarmaEventType, SubmissionStatus } from "@prisma/client";

const poolItemsBody = z.object({
  items: z.array(z.record(z.unknown())).min(1).max(100),
  generationMethod: z.nativeEnum(GenerationMethod).default(GenerationMethod.human),
});

const sponsorReviewBody = z.object({
  decision: z.enum(["accept", "reject"]),
  note: z.string().trim().min(1).max(2000).optional(),
});

export async function bountyRoutes(app: FastifyInstance) {
  // List bounties / community pools.
  //
  // Every param is validated: this route previously passed `Number(query.limit)`
  // straight into Prisma, so `?limit=abc` (NaN) and `?offset=-1` were
  // unauthenticated 500s that echoed an absolute source path back to the
  // caller, and `?limit=-1` silently returned a page read from the WRONG END of
  // the ordering. Phase names come from the one shared vocabulary so this route
  // and the community catalog cannot drift apart.
  const listQuery = z
    .object({
      category: publicText(60).optional(),
      language: publicText(60).optional(),
      status: z.nativeEnum(BountyStatus).optional(),
      phase: phaseSchema.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).max(100000).optional(),
    })
    .strip();

  app.get("/", async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid query.");
    const { category, language, status, phase, limit, pageSize, offset } = parsed.data;
    const pools = await listCommunityPools({
      category,
      language,
      status,
      statuses: phase ? PHASE_STATUSES[phase] : undefined,
      limit: limit ?? pageSize,
      offset,
    });
    return reply.send(pools);
  });

  // Get Bounty by ID
  app.get("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const pool = await getCommunityPool(id);
    if (!pool) return reply.notFound("Dataset pool not found");
    return reply.send({ bounty: pool });
  });

  // Get Submissions for Bounty — backs the sponsor review queue
  // (apps/web app/(app)/sponsor/[id]/view.tsx). That page reads
  // `{submissions, total, page, pageSize, totalPages}` and filters by
  // status/search client-side-triggered-but-server-applied query params;
  // the previous version of this route ignored both and hardcoded
  // `status: "accepted"`, which meant a sponsor could never see (or
  // act on) an `in_sponsor_review` submission through this list.
  // SPONSOR-ONLY, OWNER-ONLY. This returns every submission's `payloadJson` --
  // the actual work product -- plus contributor identity, the internal
  // llm/duplicate scores and full per-stage validation evidence. It shipped
  // with no preHandler and no ownership check, so any unauthenticated caller
  // holding a bounty id could download a whole dataset and read contributor
  // PII, bypassing the licensing model entirely. Restored to V1's contract
  // (`databounty-api/src/routes/v1/bounties.ts`): `requireScope("sponsor")`
  // plus an explicit owner comparison. `GET /:id/my-submissions` below is the
  // contributor-facing view and stays scoped to the caller's own rows.
  //
  // The owner check runs BEFORE the submission query on purpose -- a
  // non-owner must not cause the rows to be read at all.
  //
  // The query/response logic lives in services/sponsor-evidence.ts so the MCP
  // tool `get_sponsor_submission_evidence` shares it byte-for-byte.
  app.get("/:id/submissions", { preHandler: requireScope(ApiKeyScope.sponsor) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = req.query as { page?: string; pageSize?: string; status?: string; search?: string };
    try {
      const result = await listSponsorSubmissionEvidence({
        bountyId: id,
        userId: user.id,
        page: query.page ? Number(query.page) : undefined,
        pageSize: query.pageSize ? Number(query.pageSize) : undefined,
        status: query.status,
        search: query.search,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof SponsorEvidenceError) {
        if (err.code === "not_found") return reply.notFound(err.message);
        if (err.code === "forbidden") return reply.forbidden(err.message);
        return reply.conflict(err.message);
      }
      throw err;
    }
  });

  // Get ONE submission's full evidence — the sponsor-owned counterpart to
  // `GET /v1/submissions/:id` (contributor-or-admin only). A real sponsor
  // (a pool's `requesterUserId`/`communityRequesterUserId`, not an admin) got
  // a 403 from that endpoint, so the sponsor submission-detail page rendered
  // "Cannot load this submission" for anyone but an admin.
  //
  // Deliberately NOT a wider gate on `/v1/submissions/:id` — see
  // services/sponsor-evidence.ts's `getSponsorSubmissionEvidence` doc comment
  // for why that would leak validator identity to sponsors.
  //
  // Unlike `/:id/submissions` above (list, owner-only, no admin bypass), this
  // single-item read DOES allow admin — matching `disputeAcceptedSubmission`'s
  // existing owner-or-admin rule below, and preserving the sponsor page's
  // current admin-reachable behavior (previously via the contributor
  // endpoint's admin branch) rather than narrowing it as a side effect of
  // this fix.
  app.get("/:id/submissions/:submissionId", { preHandler: requireScope(ApiKeyScope.sponsor) }, async (req, reply) => {
    const { id, submissionId } = req.params as { id: string; submissionId: string };
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    try {
      const submission = await getSponsorSubmissionEvidence({
        bountyId: id,
        submissionId,
        userId: user.id,
        callerRoles: user.roles,
      });
      return reply.send({ submission });
    } catch (err) {
      if (err instanceof SponsorEvidenceError) {
        if (err.code === "not_found") return reply.notFound(err.message);
        if (err.code === "forbidden") return reply.forbidden(err.message);
        return reply.conflict(err.message);
      }
      throw err;
    }
  });

  // Get Pool Progress
  app.get("/:id/progress", async (req, reply) => {
    const { id } = req.params as { id: string };
    const bounty = await prisma.bounty.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        status: true,
        targetItems: true,
        acceptedItems: true,
        finalAcceptedItems: true,
        karmaPerAcceptedItem: true,
        publicationStatus: true,
      },
    });

    if (!bounty) return reply.notFound("Dataset pool not found");

    const target = Number(bounty.targetItems);
    const accepted = Number(bounty.finalAcceptedItems);
    const pct = target > 0 ? Math.min(100, Math.round((accepted / target) * 100)) : 0;

    return reply.send({
      progress: {
        targetItems: target,
        acceptedItems: accepted,
        percentage: pct,
        status: bounty.status,
        publicationStatus: bounty.publicationStatus,
      },
    });
  });

  // Get open-pool contract — backs the "contribute directly" pool page
  // (apps/web app/(app)/contributor/pool/[bountyId]/view.tsx). The contract
  // includes approved sponsor work-brief artifacts, so it must use the same
  // authenticated contributor scope as V1 rather than leaking file metadata
  // from an anonymous pool-detail route.
  app.get("/:id/contract", { preHandler: requireScope(ApiKeyScope.contribute) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const contract = await getPoolContractForBounty(id, { includeSponsorReferences: true });
    if (!contract) return reply.notFound("This pool could not be found.");
    return reply.send(contract);
  });

  // Submit items directly to an open community pool — no ContributorBatch
  // claim step (COMMUNITY_OPEN_POOL_PLAN_V2). Reuses the same dedupe +
  // validation-job-enqueue mechanics as POST /v1/submissions.
  app.post("/:id/items", { preHandler: [requireAnyScope(ApiKeyScope.contribute), requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = poolItemsBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    try {
      const created = await createBountyPoolItems({
        bountyId: id,
        contributorUserId: user.id,
        items: parsed.data.items as Record<string, unknown>[],
        generationMethod: parsed.data.generationMethod,
      });
      return reply.status(201).send({ submissions: created });
    } catch (err: any) {
      return reply.badRequest(err.message);
    }
  });

  // The caller's own submissions to this pool — paginated, filterable,
  // searchable. Backs the "Your submissions to this pool" section of the
  // pool page.
  app.get("/:id/my-submissions", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const query = req.query as { page?: string; limit?: string; filter?: string; search?: string };
    const page = Math.max(query.page ? Number(query.page) : 1, 1);
    const limit = Math.min(Math.max(query.limit ? Number(query.limit) : 10, 1), 100);
    const filter = (["all", "action_needed", "in_review", "accepted"] as const).includes(query.filter as any)
      ? (query.filter as "all" | "action_needed" | "in_review" | "accepted")
      : "all";

    const result = await listContributorPoolSubmissions({
      bountyId: id,
      contributorUserId: user.id,
      page,
      limit,
      filter,
      search: query.search,
    });
    return reply.send(result);
  });

  // Sponsor accept/reject on a submission held in `in_sponsor_review`
  // (COMMUNITY_OPEN_POOL_PLAN_V2 §3.3c "Piece 2" — a pool with no validators,
  // auditCoveragePct === 0, routes every cleared item to the requester
  // instead of a validator). Accept mirrors the real final-accept path
  // (services/validation.ts / the dispute-upheld path in admin.ts): status
  // -> accepted, bounty.finalAcceptedItems +1, karma awarded-or-held (idempotent —
  // awardOrHoldAcceptedItemKarma dedupes on userId+eventType+sourceType+sourceId). Reject sends
  // the item back to the contributor as `needs_fixes` with the sponsor's note
  // recorded as an open Flag, and frees the capacity slot the item was
  // holding (bounty.acceptedItems -1) since a needs_fixes item re-enters the
  // pipeline on resubmit and would otherwise double-count capacity.
  app.post("/:id/sponsor-review/:submissionId", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id, submissionId } = req.params as { id: string; submissionId: string };
    const parsed = sponsorReviewBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const bounty = await prisma.bounty.findUnique({ where: { id } });
    if (!bounty) return reply.notFound("Dataset pool not found");

    const isOwner =
      bounty.requesterUserId === user.id ||
      bounty.communityRequesterUserId === user.id;
    if (!isOwner && !user.roles.includes("admin")) {
      return reply.forbidden("Only this pool's requester can review submissions.");
    }

    const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
    if (!submission || submission.bountyId !== id) return reply.notFound("Submission not found");
    if (submission.status !== SubmissionStatus.in_sponsor_review) {
      return reply.badRequest("This submission is not awaiting sponsor review.");
    }

    if (parsed.data.decision === "reject" && !parsed.data.note) {
      return reply.badRequest("A note explaining the rejection is required.");
    }

    if (parsed.data.decision === "accept") {
      await prisma.$transaction(async (tx) => {
        await tx.submission.update({
          where: { id: submission.id },
          data: { status: SubmissionStatus.accepted, acceptedAt: new Date() },
        });
        // Recount, not increment: `in_sponsor_review` -> `accepted` keeps the
        // capacity slot and adds one final acceptance; deriving both from the
        // submission rows means a retry cannot double-count.
        await recomputeAcceptedItemCounters(tx, bounty.id);
        await awardOrHoldAcceptedItemKarma(tx, {
          bountyId: bounty.id,
          userId: submission.contributorUserId,
          eventType: KarmaEventType.community_item_accepted,
          amount: bounty.karmaPerAcceptedItem || 25,
          sourceType: "Submission",
          sourceId: submission.id,
          metadata: { bountyId: bounty.id, title: submission.title },
        });
      });

      await notifyUser({
        userId: submission.contributorUserId,
        type: "submission.accepted",
        title: "Submission accepted",
        body: `Your submission "${submission.title}" was accepted by the pool requester.`,
        entityType: "Submission",
        entityId: submission.id,
        linkBountyId: bounty.id,
      });
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.submission.update({
          where: { id: submission.id },
          data: { status: SubmissionStatus.needs_fixes },
        });
        // This item was already counted as "cleared" (bounty.acceptedItems)
        // when it passed automation and reserved a pool slot; sending it back
        // for revision releases that slot so a resubmit-and-repass doesn't
        // double-count capacity. Recounted from the submission rows rather
        // than decremented, so a retry cannot release the slot twice.
        await recomputeAcceptedItemCounters(tx, bounty.id);
        await tx.flag.create({
          data: {
            submissionId: submission.id,
            reason: FlagReason.other,
            details: parsed.data.note,
            status: "open",
          },
        });
      });

      await notifyUser({
        userId: submission.contributorUserId,
        type: "submission.needs_fixes",
        title: "Submission needs changes",
        body: `The pool requester sent back "${submission.title}": ${parsed.data.note}`,
        entityType: "Submission",
        entityId: submission.id,
        linkBountyId: bounty.id,
      });
    }

    return reply.send({ ok: true });
  });

  // Sponsor-initiated early close (owner decision, 2026-09-10). By default an
  // under-target community pool REOPENS when its dispute window elapses
  // (services/pool-lifecycle.ts `settleDueCommunityPools`) — only a genuine
  // sponsor "stop taking contributions now" or an actually-reached target
  // settles it for good. This route is how a sponsor records that intent.
  //
  // Sets `Bounty.sponsorClosedAt` (one-shot; never cleared by this route or
  // by settle/reopen). If the pool's own intake window is still open
  // (`poolClosedAt` null), this ALSO force-closes it right now — same
  // close-out semantics `checkAndClosePoolIfTargetReached` /
  // `recomputeAcceptedItemCounters`'s close branch already use (stamp
  // `poolClosedAt`/`disputeCycleWindowOpensAt`, enqueue `pool.sampling`).
  // Factoring that close-out into one shared helper alongside those two
  // existing call sites was judged too invasive for this route's scope; the
  // duplication here follows their exact pattern (same CAS idiom, same
  // fields) rather than inventing a new one.
  //
  // Idempotent: a second call is not an error. The CAS on
  // `sponsorClosedAt: null` means only the first call actually writes
  // anything; every call after that returns 200 with `alreadyClosed: true`
  // so the frontend can render "already closing" rather than an error.
  app.post("/:id/close-pool", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };

    const bounty = await prisma.bounty.findUnique({ where: { id } });
    // 404 (never 403) for both "no such pool" and "not this caller's pool" —
    // deliberately do not confirm to a non-owner that a given bounty id
    // exists, matching the route contract handed to the frontend agent.
    if (!bounty) return reply.notFound("Dataset pool not found");
    const isOwner = bounty.requesterUserId === user.id || bounty.communityRequesterUserId === user.id;
    if (!isOwner && !user.roles.includes("admin")) {
      return reply.notFound("Dataset pool not found");
    }
    if (bounty.kind !== BountyKind.community) {
      return reply.badRequest("Only community pools can be closed early.");
    }

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      // CAS on sponsorClosedAt: null — only the caller that actually wins
      // this update proceeds to (maybe) force-close the pool and write the
      // audit log; every other caller (including a genuine concurrent
      // double-click) sees count === 0 and is told the pool is already
      // closing, without erroring.
      const claim = await tx.bounty.updateMany({
        where: { id, sponsorClosedAt: null },
        data: { sponsorClosedAt: now },
      });
      if (claim.count === 0) return { alreadyClosed: true as const };

      const current = await tx.bounty.findUniqueOrThrow({ where: { id } });
      const poolWasOpen = current.poolClosedAt === null;

      if (poolWasOpen) {
        const closeClaim = await tx.bounty.updateMany({
          where: { id, poolClosedAt: null },
          data: { poolClosedAt: now, disputeCycleWindowOpensAt: now },
        });
        if (closeClaim.count === 1) {
          await enqueuePoolSampling(id, tx);
        }
      }

      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "community_pool.sponsor_closed",
        targetType: "bounty",
        targetId: id,
        before: { sponsorClosedAt: null, poolClosedAt: current.poolClosedAt ? current.poolClosedAt.toISOString() : null },
        after: { sponsorClosedAt: now.toISOString(), poolClosedAt: poolWasOpen ? now.toISOString() : (current.poolClosedAt?.toISOString() ?? null) },
        metadata: {
          trigger: "sponsor_close_pool_early",
          forcedPoolClose: String(poolWasOpen),
          targetItems: String(bounty.targetItems),
          acceptedItems: String(bounty.acceptedItems),
          finalAcceptedItems: String(bounty.finalAcceptedItems),
        },
      });

      return { alreadyClosed: false as const };
    });

    const pool = await getCommunityPool(id);
    return reply.send({ bounty: pool, alreadyClosed: result.alreadyClosed });
  });
}
