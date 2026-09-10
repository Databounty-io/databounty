// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_AND_MEMBER, ADMIN_AND_ABOVE_READONLY, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { attestPublication, enqueueCommunityPublish, enqueueCommunityUnpublish } from "../../services/community-publish.js";
import {
  BountyKind,
  BountyStatus,
  CommunityPublicationStatus,
  DatasetCategory,
  DatasetRequestStatus,
  DatasetTypeStatus,
  KarmaEventType,
  Prisma,
  PublicationTarget,
  SubmissionStatus,
} from "@prisma/client";
import { awardKarma, getKarmaRules, KARMA_RULES } from "../../services/karma.js";
import { emitNewWorkMatches, notifyEvent } from "../../services/notifications.js";
import { buildSampleGate } from "../../services/artifacts.js";
import { canonicalLanguageFor } from "../../services/planner.js";
import { BUNDLED_LICENSE_IDS, datasetLicense } from "../../lib/publication/license-texts.js";
import { publicPublicationsOf, buildApprovedSampleAssets, safeToWriteSampleAssetsFor } from "../../services/bounties.js";
import { SAMPLE_LLM_REVIEW_STAGE, SAMPLE_SIMILARITY_STAGE } from "../../services/jobs/sponsor-reference-review.js";

const reviewRequestBody = z.object({
  status: z.enum(["approved", "changes_requested", "declined"]),
  adminNote: z.string().trim().min(5).max(2000),
});

const mintBountyBody = z.object({
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().min(20).max(2000),
  datasetCategory: z.nativeEnum(DatasetCategory).default(DatasetCategory.implementation),
  language: z.string().default("TypeScript"),
  framework: z.string().default("Node.js"),
  targetItems: z.number().int().min(10).max(100_000).default(100),
  // No `.default(25)` and no static `.max()` on purpose. The rate is BOUNDED
  // AT RUNTIME against the platform's own live accepted-item karma scale
  // (getKarmaRules(), which falls back wholesale to KARMA_RULES when no
  // `karma.rules` row is stored) — see the mint handler below. A static
  // `.max()` here would either be a hardcoded 60 that an operator who legally
  // raises `karma.rules.acceptedItem.advanced` can no longer mint against, or
  // a number large enough to be no bound at all. Omitting the value now
  // resolves to the rate for the request's OWN difficulty rather than a flat
  // 25 that silently underpaid advanced pools and overpaid beginner ones.
  karmaPerAcceptedItem: z.number().int().min(1).optional(),
  auditCoveragePct: z.number().int().min(0).max(100).default(10),
  // Validated against the same bundled-licence source of truth the sponsor
  // path uses (`datasetLicense` / `BUNDLED_LICENSE_IDS`), and case-folded, so
  // `cc-by-4.0` resolves rather than being stored as a third spelling.
  //
  // This was `z.string()` with a default and NO validation, on a route that
  // writes `Bounty.communityLicense` directly — the value contributors are
  // shown as their working terms and the one that maps to a publication
  // licence tag. The sponsor-facing path was hardened earlier today after a
  // 1,268-character payload containing an `<img onerror=...>` and a U+202E
  // override was proven to travel create → approve → mint → the ANONYMOUS
  // public API intact; this door was still open.
  //
  // Deliberately STRICTER than V1, which validates neither field here
  // (v1 databounty-api/src/routes/v1/admin-community.ts has no
  // `communityLicense` check at all) — see the deviation note below.
  communityLicense: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .default("CC-BY-4.0")
    .transform((raw, ctx) => {
      const canonical = datasetLicense(raw)?.spdx;
      if (!canonical) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsupported licence. Choose one of: ${BUNDLED_LICENSE_IDS.join(", ")}.`,
        });
        return z.NEVER;
      }
      return canonical;
    }),
});

const attestPubBody = z.object({
  target: z.nativeEnum(PublicationTarget),
  externalId: z.string().min(1),
  url: z.string().url(),
});

/**
 * Legal admin review transitions for a DatasetRequest. Ported from v1
 * (databounty-api routes/v1/community.ts:2088-2105, POST /requests/:id/decision),
 * which is the parity reference for this table; this rebuild had no
 * from-status precondition on EITHER admin decision route at all.
 *
 * Why the absence was not cosmetic: the sponsor-side gates key on status
 * ALONE — routes/v1/community.ts's REQUEST_EDITABLE_STATUSES (edit/withdraw)
 * and services/artifacts.ts's SAMPLE_EDITABLE_REQUEST_STATUSES (reference
 * samples). So flipping an already-`implemented` request back to
 * `under_review` re-opened editing, sample replacement AND delete on a
 * request whose community pool is already LIVE and public: item count,
 * audit coverage and licence could be rewritten behind a running pool (leaving
 * the minted bounty describing terms nobody agreed to), or the request row
 * hard-deleted, orphaning the pool with its approval record unrecoverable.
 *
 * `implemented` and `declined` are terminal HERE, which is not a dead end for
 * the sponsor — both exits are theirs, not an admin's: a declined request is
 * disputed by its own requester (routes/v1/community.ts POST /requests/:id/dispute,
 * `declined -> disputed`) or resubmitted (`changes_requested|declined ->
 * under_review`). The `disputed` row below is what then lets a human handler
 * resolve that dispute (`disputed -> approved | declined`) rather than the
 * platform auto-overturning it; without that row a disputed request would have
 * no exit whatsoever and would be permanently stranded.
 *
 * `approved -> changes_requested` is deliberately the one backwards edge, for
 * the reason v1 documents at that line: approval FREEZES the sample set, and
 * mint re-evaluates the sample gate against the LIVE minimum, so raising that
 * minimum between approval and mint would otherwise leave a request the
 * sponsor cannot repair (samples frozen) and no admin can reopen. It still
 * requires a note, and mint re-checks every gate afterwards, so this reopens
 * the review rather than weakening it. Crucially it does NOT exist on
 * `implemented`: once a pool is live, reopening is exactly the hole above.
 */
const REQUEST_DECISION_TRANSITIONS: Record<DatasetRequestStatus, DatasetRequestStatus[]> = {
  submitted: [
    DatasetRequestStatus.under_review,
    DatasetRequestStatus.changes_requested,
    DatasetRequestStatus.approved,
    DatasetRequestStatus.declined,
  ],
  under_review: [DatasetRequestStatus.changes_requested, DatasetRequestStatus.approved, DatasetRequestStatus.declined],
  changes_requested: [DatasetRequestStatus.approved, DatasetRequestStatus.declined],
  disputed: [DatasetRequestStatus.approved, DatasetRequestStatus.declined],
  approved: [DatasetRequestStatus.changes_requested],
  declined: [],
  implemented: [],
};

/** Fail-closed lookup for {@link REQUEST_DECISION_TRANSITIONS}. `?? []` rather
 *  than a non-null assertion on purpose: a status this build does not know
 *  about (an enum value rolled forward in the database ahead of the deployed
 *  code) must deny EVERY transition, never fall through to "allowed". The
 *  `Record<DatasetRequestStatus, …>` type above additionally makes a status
 *  added to the enum a compile error here rather than a silent gap. */
function canDecideRequest(from: DatasetRequestStatus, to: DatasetRequestStatus): boolean {
  return (REQUEST_DECISION_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Conflict-of-interest gate: a reviewer may not decide, mint or implement
 * their OWN community dataset request.
 *
 * This is the same rule the platform already enforces on the validator side —
 * services/audits.ts throws "You cannot audit your own submission", surfaced
 * as 403 by routes/v1/audits.ts — applied to the review side, where it was
 * missing entirely. Without it an account holding `admin` (or merely `member`,
 * which `ADMIN_AND_MEMBER` also admits) could submit a community request,
 * approve it, collect its 25-karma approval award, and mint the public pool,
 * with no second pair of eyes anywhere in that chain.
 *
 * `DatasetRequest.reviewedBy` and the admin_audit_log rows already RECORD the
 * actor correctly, so the audit trail was never the gap — only the prevention.
 *
 * NOTE this is a deliberate hardening BEYOND v1 parity: v1's own
 * /requests/:id/decision and /requests/:id/implement have no equivalent check.
 * It is kept because a self-approved, self-minted pool awards real karma to
 * the approver, and because the analogous validator rule already exists in
 * this codebase (so this is the established pattern, not a new one).
 */
function isSelfReview(request: { requesterUserId: string }, user: AuthedUser): boolean {
  return request.requesterUserId === user.id;
}

export async function adminCommunityRoutes(app: FastifyInstance) {
  // List dataset requests
  app.get("/dataset-requests", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const query = req.query as { status?: DatasetRequestStatus; limit?: string; offset?: string };
    const take = Math.min(query.limit ? Number(query.limit) : 50, 100);
    const skip = query.offset ? Number(query.offset) : 0;

    const where: Prisma.DatasetRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
    };

    const [requests, total] = await Promise.all([
      prisma.datasetRequest.findMany({
        where,
        include: {
          requester: { select: { id: true, displayName: true, email: true, handle: true } },
          datasetType: { select: { id: true, name: true } },
          mintedBounty: { select: { id: true, title: true, status: true } },
        },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.datasetRequest.count({ where }),
    ]);

    return reply.send({ requests, total, limit: take, offset: skip });
  });

  // Get request details
  app.get("/dataset-requests/:id", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const request = await prisma.datasetRequest.findUnique({
      where: { id },
      include: {
        requester: { select: { id: true, displayName: true, email: true, handle: true } },
        datasetType: true,
        mintedBounty: true,
      },
    });
    if (!request) return reply.notFound("Dataset request not found");
    return reply.send({ request });
  });

  // Review request
  app.post("/dataset-requests/:id/review", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = reviewRequestBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const decision = parsed.data.status as DatasetRequestStatus;

    const result = await prisma.$transaction(async (tx) => {
      // Row lock FIRST, then read, then decide, then write — all in one
      // transaction. The read used to sit outside any transaction while the
      // write had no precondition at all, so this route could not enforce a
      // transition even if it wanted to. Same `SELECT … FOR UPDATE` idiom as
      // /community/requests/:id/implement below, routes/v1/community.ts's
      // sponsor-side edit/withdraw/resubmit/dispute, and v1's own decision
      // route: the transition table is the business boundary, the lock is what
      // makes it hold when two stale admin screens submit at once.
      await tx.$queryRaw`SELECT id FROM dataset_requests WHERE id = ${id} FOR UPDATE`;
      const request = await tx.datasetRequest.findUnique({ where: { id } });
      if (!request) return "not_found" as const;
      if (isSelfReview(request, user)) return "self_review" as const;
      if (!canDecideRequest(request.status, decision)) return { blockedFrom: request.status } as const;

      const reqUpdated = await tx.datasetRequest.update({
        where: { id },
        data: {
          status: decision,
          adminNote: parsed.data.adminNote,
          reviewedBy: user.id,
          reviewedAt: new Date(),
        },
      });

      if (parsed.data.status === "approved") {
        await awardKarma(tx, {
          userId: request.requesterUserId,
          eventType: KarmaEventType.community_request_approved,
          amount: 25,
          sourceType: "DatasetRequest",
          sourceId: request.id,
          metadata: { title: request.title },
        });
      }

      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.dataset_request.reviewed",
        targetType: "DatasetRequest",
        targetId: request.id,
        before: { status: request.status },
        after: { status: parsed.data.status, adminNote: parsed.data.adminNote },
        ip: req.ip,
      });

      return { request: reqUpdated } as const;
    });

    if (result === "not_found") return reply.notFound("Dataset request not found");
    if (result === "self_review") return reply.forbidden("you cannot review your own dataset request");
    if ("blockedFrom" in result) {
      return reply.conflict(
        `A request in "${result.blockedFrom}" cannot be moved to "${decision}". ` +
          (result.blockedFrom === DatasetRequestStatus.implemented
            ? "Its community pool is already live — reopening the request would re-open editing and reference-sample replacement behind a running pool."
            : "See the review transition table in routes/v1/admin-community.ts for the legal transitions.")
      );
    }
    return reply.send({ request: result.request });
  });

  // Mint community dataset pool.
  //
  // NOTE (re-added after a same-session attempt to delete this as a "dead,
  // unused duplicate" of /community/requests/:id/implement): the frontend
  // (apps/admin, apps/web) genuinely never calls this route — but three
  // integration test files in THIS package do (pipeline.integration.test.ts
  // x4, submission-revision.integration.test.ts, and
  // upload-review-drafts.integration.test.ts, 6 call sites total), so it is
  // not actually dead. Deleting it broke those tests. Left in place.
  //
  // UPDATE (authorization-defect fix): rather than consolidate onto
  // /implement — which would have changed this route's request contract
  // (title/description/karma come from the BODY here, from the request row
  // there) and so rewritten every one of those test call sites — this route
  // has been brought up to /implement's gate set in place, because it is
  // reachable with the same credentials and was measurably the weaker door:
  //
  //   1. no `approved` status gate  → an admin could mint a live public pool
  //      from a request that was never reviewed, or that was DECLINED, or that
  //      is mid-dispute, bypassing the review loop entirely;
  //   2. the `mintedBountyId` check sat OUTSIDE the transaction (TOCTOU) →
  //      8 concurrent calls for one request created 8 live public pools, 7 of
  //      them orphaned, versus exactly 1 on /implement;
  //   3. `karmaPerAcceptedItem` was caller-supplied and unbounded → a rate of
  //      50,000 was accepted, so one accepted item granted the top karma tier;
  //   4. `poolDifficulty` was never snapshotted → every pool minted here read
  //      back as the fallback `intermediate` regardless of the requester's mix;
  //   5. no priced-type gate → a pool on an unpriced type.
  //
  // All five are fixed below. Consolidating the two routes onto one internal
  // function remains a reasonable follow-up, but is a contract change, not a
  // security fix, so it stays out of this one.
  app.post("/dataset-requests/:id/mint", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = mintBountyBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    // Read the LIVE karma scale before opening the transaction (getKarmaRules
    // hits admin_settings on its own connection; doing it inside would hold
    // the dataset_requests row lock for the duration of that read). This is
    // the ceiling for the caller-supplied per-item rate: an admin may pick a
    // rate anywhere on the platform's own configured accepted-item scale, and
    // nothing above it. /implement does not take the value from the caller at
    // all, so it needs no such bound; this route does, and had none.
    const { rules: karmaRules } = await getKarmaRules();
    const maxKarmaPerAcceptedItem = Math.max(
      karmaRules.acceptedItem.beginner,
      karmaRules.acceptedItem.intermediate,
      karmaRules.acceptedItem.advanced
    );

    // Prepared OUTSIDE the transaction for the same reason as the karma-rules
    // read above: each sample is a real S3 fetch, and holding the
    // dataset_requests row lock across several of those would be needless.
    // This is a best-effort PREPARATION step only — it never fails the mint.
    // A sponsor attaches reference-example artifacts (kind sponsor_reference)
    // to their own dataset_request when creating it; an admin approves each
    // one individually (POST /v1/artifacts/:id/sponsor-review); but nothing
    // ever copied an approved sample into `DatasetType.sampleAssets`, which is
    // the ONLY field getPoolContractForBounty actually serves to contributors
    // (services/bounties.ts) — so a sponsor who did everything right still
    // produced a pool whose contract honestly, and permanently, said
    // `sampleAssets: null`. This is that missing copy step, done once, here,
    // at the one moment a request's samples are known-final (mint freezes the
    // request into a live bounty) and its dataset_type is known (forked types
    // are 1:1 with their request; only a handful of shared catalog templates
    // are not — the shared-type guard below skips those on purpose, since
    // writing one sponsor's specific samples onto a template two different
    // bounties draw from would silently overwrite what the OTHER bounty's
    // contributors see).
    // Also covers a sample attached BEFORE mint (rare — the live DB shows
    // almost none this way; see buildApprovedSampleAssets's own doc for the
    // far more common post-mint path, handled separately in
    // routes/v1/artifacts.ts's sponsor-review handler).
    const preparedSampleAssets = await buildApprovedSampleAssets(prisma, { datasetRequestId: id }).catch(() => []);

    const result = await prisma.$transaction(async (tx) => {
      // Row lock first, then read, then every gate, then the writes — one
      // transaction. Previously the "already minted?" read and the `Bounty`
      // create were in different transactions with no lock between them, so
      // concurrent callers each saw `mintedBountyId: null` and each minted.
      // Same idiom and same reasoning as /community/requests/:id/implement.
      await tx.$queryRaw`SELECT id FROM dataset_requests WHERE id = ${id} FOR UPDATE`;
      const request = await tx.datasetRequest.findUnique({ where: { id }, include: { datasetType: true } });
      if (!request) return "not_found" as const;
      if (isSelfReview(request, user)) return "self_review" as const;
      // Unlike /implement, an already-minted request is a 409 here rather than
      // an idempotent replay of the existing bounty. Kept deliberately: this
      // route's caller supplies its own title/description/rate, so replaying a
      // bounty minted from a DIFFERENT body would silently ignore what this
      // caller asked for. The post-commit watch alert below depends on this
      // (reaching it always means a bounty was genuinely just created).
      if (request.mintedBountyId) return "already_minted" as const;
      if (request.status !== DatasetRequestStatus.approved) return "not_approved" as const;
      if (!request.datasetType) return "missing_type" as const;
      // A sponsor's fork/custom type sits in `platform_review` until an admin
      // separately activates it; `active` is the only status a live pool may
      // launch on. (This gate already existed — it has just moved inside the
      // transaction, and no longer silently passes when datasetType is null.)
      if (request.datasetType.status !== DatasetTypeStatus.active) return "type_not_active" as const;
      // Same "active ⇒ priced" invariant /implement enforces: NULL is the
      // deliberate "unpriced" sentinel and is never defaulted to a middle
      // score, so a pool must not launch on a type nobody has priced.
      if (!isComplexityScore(request.datasetType.complexityScore) || request.datasetType.verificationUnits === null) {
        return "unpriced_type" as const;
      }
      // Owner decision, 2026-09-09: a pool must never go live with no real
      // reference examples for contributors to build from — no bounty is
      // created at all until at least one sponsor_reference sample has been
      // approved for this specific request. `preparedSampleAssets` is
      // computed above (outside the transaction, from the SAME approved
      // artifacts this gate is checking) — checking its length here, rather
      // than re-querying, keeps the gate and the write it later feeds in sync
      // by construction.
      if (preparedSampleAssets.length === 0) {
        return "no_samples" as const;
      }

      // poolDifficulty snapshot: without it every pool minted here read back
      // as getPoolContractForBounty's `intermediate` fallback, so a requester
      // who asked for a mostly-advanced corpus got a pool that presented and
      // filtered as intermediate. Note the per-item RATE stays whatever the
      // caller passed (bounded above) — `contributorPerItem` in the pool
      // contract is read from `karmaPerAcceptedItem`, not from this field, so
      // this only fixes what the pool honestly says it is.
      const difficulty = resolvePoolDifficulty(request.difficultyMix);
      const karmaPerAcceptedItem = parsed.data.karmaPerAcceptedItem ?? karmaRules.acceptedItem[difficulty];
      if (karmaPerAcceptedItem > maxKarmaPerAcceptedItem) {
        return { karmaAboveScale: maxKarmaPerAcceptedItem } as const;
      }

      // No bounty exists yet at this point, so there is nothing to exclude —
      // the count is already only OTHER bounties on this dataset_type.
      const safeToWriteSampleAssets =
        preparedSampleAssets.length > 0 &&
        (await safeToWriteSampleAssetsFor(tx, request.datasetTypeId!, undefined, request.datasetType.sampleAssets));

      const b = await tx.bounty.create({
        data: {
          requesterUserId: user.id,
          communityRequesterUserId: request.requesterUserId,
          kind: BountyKind.community,
          title: parsed.data.title,
          description: parsed.data.description,
          datasetCategory: parsed.data.datasetCategory,
          // Folded onto the template's own spelling, same as the request
          // routes do on write (services/planner.ts `canonicalLanguageFor`).
          // This is the OTHER writer of `Bounty.language`, and that column is
          // what `GET /v1/community/catalog` GROUPS BY to build its language
          // filter — an admin typing `typescript` in the mint body added a
          // second dropdown entry for a filter that is case-insensitive and
          // returns the same rows. `mintBountyBody.language` is a free string
          // with only a `.default("TypeScript")`, so this is the only thing
          // constraining its casing. Falls back to the supplied value: the
          // helper returns null for an empty string, and this column is
          // non-null.
          language: canonicalLanguageFor(request.datasetType, parsed.data.language) ?? parsed.data.language,
          framework: parsed.data.framework,
          targetItems: BigInt(parsed.data.targetItems),
          karmaPerAcceptedItem,
          auditCoveragePct: parsed.data.auditCoveragePct,
          auditMode: "partial",
          holdDays: 0,
          disputeWindowHours: 48,
          communityLicense: parsed.data.communityLicense,
          // Derived, not caller-supplied: an arbitrary URL beside a validated
          // SPDX id is how a pool ends up linking somewhere the licence does
          // not live. `datasetLicense` cannot return null here — the schema
          // above already rejected anything it does not resolve.
          communityLicenseUrl: datasetLicense(parsed.data.communityLicense)!.url,
          poolDifficulty: difficulty,
          status: BountyStatus.active,
          datasetTypeId: request.datasetTypeId,
        },
      });

      await tx.datasetRequest.update({
        where: { id: request.id },
        data: {
          mintedBountyId: b.id,
          status: DatasetRequestStatus.implemented,
        },
      });

      // The missing copy step: an admin approved these sponsor_reference
      // artifacts already (POST /v1/artifacts/:id/sponsor-review) — until
      // now, approval was the last thing that ever happened to them.
      // getPoolContractForBounty only ever reads DatasetType.sampleAssets, so
      // without this write the sponsor's real, approved examples never
      // reached a single contributor.
      if (safeToWriteSampleAssets) {
        await tx.datasetType.update({
          where: { id: request.datasetTypeId! },
          data: { sampleAssets: preparedSampleAssets },
        });
      }

      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.dataset_pool.minted",
        targetType: "Bounty",
        targetId: b.id,
        after: {
          title: b.title,
          targetItems: parsed.data.targetItems,
          difficulty,
          karmaPerAcceptedItem,
          fromRequestId: request.id,
          sampleAssetsCopied: safeToWriteSampleAssets ? preparedSampleAssets.length : 0,
        },
        ip: req.ip,
      });

      return { bounty: b, domain: request.datasetType.domain } as const;
    }, { timeout: 15_000 });

    if (result === "not_found") return reply.notFound("Dataset request not found");
    if (result === "self_review") return reply.forbidden("you cannot mint a community pool from your own dataset request");
    if (result === "already_minted") return reply.conflict("Bounty already minted for this request");
    if (result === "not_approved") return reply.conflict("Only an approved request can be minted.");
    if (result === "missing_type") {
      return reply.badRequest("This request has no dataset type set — assign one (Open Program → Dataset types, or the request's own type field) before minting.");
    }
    if (result === "type_not_active") {
      return reply.conflict("This request's dataset type has not been activated yet (or was rejected) — review and activate it (Open Program → Dataset types) before minting.");
    }
    if (result === "unpriced_type") {
      return reply.conflict("This dataset type isn't priced for karma yet — an admin must set its complexity score (1–4) and verification units on the type (Open Program → Dataset types) before it can back a community pool.");
    }
    if (result === "no_samples") {
      return reply.conflict(
        "This request has no approved reference example yet — a pool cannot launch until at least one sponsor_reference sample has been reviewed and approved (Open Program → review samples)."
      );
    }
    if ("karmaAboveScale" in result) {
      return reply.conflict(
        `karmaPerAcceptedItem must not exceed the platform's configured accepted-item karma scale (currently ${result.karmaAboveScale} per item). ` +
          "Raise karma.rules.acceptedItem in the admin karma editor if a higher rate is genuinely intended."
      );
    }
    const { bounty } = result;

    // Same v1-parity new-work watch alert as /community/requests/:id/implement
    // below — this route has no idempotent-replay branch (it 409s instead of
    // returning the existing bounty when already minted, per the check
    // above), so reaching here always means a bounty was genuinely just
    // created. Fired post-commit, outside the mint transaction —
    // fanOutWatchers opens its own per-recipient transaction. NOT awaited:
    // fanOutWatchers pages through every matching WatchPref row and opens one
    // transaction PER recipient (services/notifications.ts has no tx-aware
    // job queue to offload this to, unlike v1's `notifications.fanout_watchers`
    // job — see that file's header comment), so its runtime scales with
    // watcher count. Awaiting it inline here would make an admin's mint
    // request hang for as long as the watcher scan takes — observed in this
    // deployment's own fixture-heavy verification database, where thousands
    // of accumulated WatchPref rows turned this into 60s+ request timeouts.
    // A notification must never take down or stall the business action that
    // triggered it (same principle notifyUser's own doc comment states), so
    // the mint response returns immediately and the fan-out proceeds
    // best-effort in the background; per-recipient failures are already
    // caught and logged inside fanOutWatchers itself.
    void emitNewWorkMatches({
      id: bounty.id,
      title: bounty.title,
      datasetCategory: bounty.datasetCategory,
      language: bounty.language,
      requesterUserId: bounty.communityRequesterUserId ?? bounty.requesterUserId,
      // Carried out of the transaction on `result` — the request row is no
      // longer read outside it, and the type is now guaranteed non-null by the
      // `missing_type` gate, so there is nothing left to default to "coding".
      domain: result.domain,
    }).catch((err) => {
      console.error(`[admin-community] emitNewWorkMatches failed for bounty ${bounty.id}`, err);
    });

    // See the /implement route below for why finalAcceptedItems must also be
    // converted: it's a third BigInt column on Bounty that a bare `...bounty`
    // spread leaves raw, crashing JSON serialization on an otherwise-
    // successful mint.
    return reply.status(201).send({
      bounty: {
        ...bounty,
        targetItems: Number(bounty.targetItems),
        acceptedItems: Number(bounty.acceptedItems),
        finalAcceptedItems: Number(bounty.finalAcceptedItems),
      },
    });
  });

  // Attest Publication
  app.post("/publications/:bountyId/attest", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { bountyId } = req.params as { bountyId: string };
    const parsed = attestPubBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const publication = await attestPublication({
      bountyId,
      target: parsed.data.target,
      externalId: parsed.data.externalId,
      url: parsed.data.url,
      adminUserId: user.id,
      context: { ip: req.ip, userAgent: req.headers["user-agent"] },
    });

    return reply.send({ publication });
  });

  // ---------------------------------------------------------------------
  // Below: routes backing community/apps/admin's /open-program and
  // /community-requests pages. These are a newer, page-shaped surface over
  // the same DatasetRequest / Bounty(kind=community) data the routes above
  // already serve under /admin/dataset-requests and /admin/publications —
  // kept separate rather than replacing those (unknown other callers), and
  // registered under the same "/admin" prefix as the rest of this file, so
  // they land at /admin/community/*.
  // ---------------------------------------------------------------------

  const requestDecisionBody = z.object({
    decision: z.enum(["under_review", "approved", "declined", "changes_requested"]),
    adminNote: z.string().trim().min(1).max(2000).optional(),
  });

  /** mostly_beginner | balanced | mostly_advanced (planner presets) resolve to
   * the single difficulty an open pool is worked at (Bounty.poolDifficulty —
   * see its schema comment). Unset/unknown mixes fall back to intermediate,
   * matching the same fallback getPoolContractForBounty already uses for
   * pre-existing pools with no snapshotted difficulty. */
  function resolvePoolDifficulty(mix: string | null): "beginner" | "intermediate" | "advanced" {
    if (mix === "mostly_beginner") return "beginner";
    if (mix === "mostly_advanced") return "advanced";
    return "intermediate";
  }

  /** Real, live-computed karma-pricing preview for a request that has not
   * been minted yet. Uses the same flat KARMA_RULES scale getPoolContractForBounty
   * uses for a minted bounty (services/bounties.ts) — no versioned karma-pricing
   * matrix service is wired up yet, so matrixVersion stays null (never fabricated). */
  function buildKarmaPreview(request: {
    targetItems: number | null;
    difficultyMix: string | null;
    auditCoveragePct: number | null;
  }, datasetType: { complexityScore: number | null; verificationUnits: number | null } | null) {
    if (!datasetType) return null;
    const target = request.targetItems ?? 0;
    const difficulty = resolvePoolDifficulty(request.difficultyMix);
    const contributorPerItem = KARMA_RULES.acceptedItem[difficulty];
    const contributorTotal = contributorPerItem * target;
    const auditCoveragePct = request.auditCoveragePct ?? 10;
    const plannedAuditItems = Math.round((target * auditCoveragePct) / 100);
    const validatorPerAuditedItem = KARMA_RULES.auditItem;
    const validatorTotal = plannedAuditItems * validatorPerAuditedItem;
    return {
      contributorPerItem,
      contributorTotal,
      validatorPerAuditedItem,
      plannedAuditItems,
      validatorTotal,
      matrixVersion: null as number | null,
      complexityScore: datasetType.complexityScore,
      verificationUnits: datasetType.verificationUnits,
      difficulty,
    };
  }

  function requestListQuery() {
    return z.object({
      status: z.nativeEnum(DatasetRequestStatus).optional(),
      search: z.string().trim().max(200).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    });
  }

  // GET /community/requests — page-shaped list backing the Requests tab /
  // /community-requests page. Cursor-paginated, server-filtered.
  app.get("/community/requests", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = requestListQuery().safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const { status, search, cursor } = parsed.data;
    const limit = parsed.data.limit ?? 25;

    const where: Prisma.DatasetRequestWhereInput = {
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" } },
              { description: { contains: search, mode: "insensitive" } },
              { requester: { displayName: { contains: search, mode: "insensitive" } } },
              { requester: { handle: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const rows = await prisma.datasetRequest.findMany({
      where,
      include: {
        requester: { select: { id: true, displayName: true, handle: true } },
        datasetType: { select: { name: true, complexityScore: true, verificationUnits: true } },
        mintedBounty: { select: { id: true, status: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const requests = await Promise.all(
      page.map(async (r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        proposedLicense: r.proposedLicense,
        language: r.language,
        framework: r.framework,
        targetItems: r.targetItems,
        difficultyMix: r.difficultyMix,
        auditCoveragePct: r.auditCoveragePct,
        status: r.status,
        adminNote: r.adminNote,
        requester: r.requester,
        datasetType: r.datasetType ? { name: r.datasetType.name } : null,
        mintedBounty: r.mintedBounty,
        karmaPreview: buildKarmaPreview(r, r.datasetType),
        createdAt: r.createdAt.toISOString(),
        sampleGate: await buildSampleGate(r.id),
      }))
    );

    return reply.send({ requests, nextCursor: hasMore ? page[page.length - 1]!.id : null });
  });

  // POST /community/requests/:id/decision — review-loop transition. Same
  // mechanics as /dataset-requests/:id/review above, plus changes_requested
  // support and a required note for declined/changes_requested (the sponsor
  // is notified with exactly this text, so an empty explanation is refused).
  app.post("/community/requests/:id/decision", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = requestDecisionBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    if ((parsed.data.decision === "declined" || parsed.data.decision === "changes_requested") && !parsed.data.adminNote) {
      return reply.badRequest("A note is required to decline or request changes.");
    }

    const decision = parsed.data.decision as DatasetRequestStatus;

    const result = await prisma.$transaction(async (tx) => {
      // Lock → read → transition check → write, for exactly the reasons given
      // on /dataset-requests/:id/review above and on
      // REQUEST_DECISION_TRANSITIONS itself. This route is the one the admin
      // console actually calls, so it is the one that was live-reproducibly
      // flipping `implemented` requests back to `under_review`.
      await tx.$queryRaw`SELECT id FROM dataset_requests WHERE id = ${id} FOR UPDATE`;
      const request = await tx.datasetRequest.findUnique({ where: { id } });
      if (!request) return "not_found" as const;
      if (isSelfReview(request, user)) return "self_review" as const;
      if (!canDecideRequest(request.status, decision)) return { blockedFrom: request.status } as const;

      const reqUpdated = await tx.datasetRequest.update({
        where: { id },
        data: {
          status: decision,
          adminNote: parsed.data.adminNote ?? request.adminNote,
          reviewedBy: user.id,
          reviewedAt: new Date(),
        },
      });

      if (parsed.data.decision === "approved") {
        await awardKarma(tx, {
          userId: request.requesterUserId,
          eventType: KarmaEventType.community_request_approved,
          amount: KARMA_RULES.requestApproved,
          sourceType: "DatasetRequest",
          sourceId: request.id,
          metadata: { title: request.title },
        });
        await notifyEvent(tx, "community.request_status_changed", {
          userId: request.requesterUserId,
          entityId: request.id,
          keySuffix: `${request.id}:approved`,
          data: { title: request.title, status: "approved" },
        });
      } else if (parsed.data.decision === "declined") {
        await notifyEvent(tx, "community.request_declined", {
          userId: request.requesterUserId,
          entityId: request.id,
          keySuffix: `${request.id}:declined`,
          data: { title: request.title, reason: parsed.data.adminNote },
        });
      } else if (parsed.data.decision === "changes_requested") {
        await notifyEvent(tx, "community.request_changes_requested", {
          userId: request.requesterUserId,
          entityId: request.id,
          keySuffix: `${request.id}:changes_requested`,
          data: { title: request.title },
        });
      }

      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.community_request.decision",
        targetType: "DatasetRequest",
        targetId: request.id,
        before: { status: request.status },
        after: { status: parsed.data.decision, adminNote: parsed.data.adminNote ?? null },
        ip: req.ip,
      });

      return { request: reqUpdated } as const;
    });

    if (result === "not_found") return reply.notFound("Dataset request not found");
    if (result === "self_review") return reply.forbidden("you cannot review your own dataset request");
    if ("blockedFrom" in result) {
      return reply.conflict(
        `A request in "${result.blockedFrom}" cannot be moved to "${decision}". ` +
          (result.blockedFrom === DatasetRequestStatus.implemented
            ? "Its community pool is already live — reopening the request would re-open editing and reference-sample replacement behind a running pool."
            : "See the review transition table in routes/v1/admin-community.ts for the legal transitions.")
      );
    }
    return reply.send({ request: result.request });
  });

  const implementBody = z.object({ targetItems: z.number().int().min(1).max(1_000_000) });

  /** "Active ⇒ priced" invariant, re-checked at mint time (belt-and-suspenders
   * with the same-named gate admin-dataset-types.ts already enforces before a
   * type can even reach `active`). Duplicated rather than imported to avoid a
   * cross-file coupling on a file another session may be concurrently editing;
   * it is a 6-line, unlikely-to-drift check. NULL is the deliberate "unpriced"
   * sentinel (schema.prisma's DatasetType.complexityScore/verificationUnits
   * comment) — never defaulted to a middle score. */
  function isComplexityScore(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4;
  }

  // POST /community/requests/:id/implement — mints exactly one zero-cash
  // community bounty from an approved request. Same core mechanics as
  // /dataset-requests/:id/mint above (title/description/license carried over
  // from the request rather than re-entered), plus the poolDifficulty
  // snapshot that mint route never set (Bounty.poolDifficulty stayed null for
  // every request-minted pool, so every award silently priced at the
  // intermediate rate regardless of the requester's chosen difficulty mix —
  // fixed here by resolving it from difficultyMix at mint time).
  //
  // Concurrency: the "not yet minted" check and the `Bounty` create now share
  // ONE transaction that takes a `SELECT ... FOR UPDATE` lock on the
  // dataset_requests row first — same idiom this file's sibling
  // routes/v1/community.ts already uses for edit/withdraw/resubmit/dispute,
  // and v1's reference /requests/:id/implement (community.ts) uses for this
  // exact mint. Without it, two concurrent /implement calls for the same
  // request could each pass the mintedBountyId check before either write
  // landed and each create its own Bounty — the request ends up pointing at
  // whichever transaction commits last, silently orphaning the other bounty.
  app.post("/community/requests/:id/implement", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = implementBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    // Same missing-copy fix as /dataset-requests/:id/mint above, and the same
    // reason for computing it OUTSIDE the transaction — see that route's own
    // comment. This route is the one the admin console actually calls
    // (line ~927's own note), so the sample gate below has no effect if it is
    // only enforced on the sibling route.
    const preparedSampleAssets = await buildApprovedSampleAssets(prisma, { datasetRequestId: id }).catch(() => []);

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dataset_requests WHERE id = ${id} FOR UPDATE`;
      const request = await tx.datasetRequest.findUnique({ where: { id }, include: { datasetType: true } });
      if (!request) return "not_found" as const;
      // Conflict-of-interest gate BEFORE the idempotent-replay branch below,
      // on purpose: the requester must not be able to reach their own pool
      // through this route at all, not even to re-read an already-minted one.
      if (isSelfReview(request, user)) return "self_review" as const;
      // Idempotent re-play: a caller that lost the race (or retried after a
      // timeout) for a request THIS transaction itself already minted gets
      // the existing bounty back instead of a conflict, same as v1.
      if (request.mintedBountyId) {
        return { bounty: await tx.bounty.findUniqueOrThrow({ where: { id: request.mintedBountyId } }), created: false as const };
      }
      if (request.status !== DatasetRequestStatus.approved) return "not_approved" as const;
      if (!request.datasetType) return "missing_type" as const;
      // Found by a same-day QA audit: this route never checked the dataset
      // type's OWN review status. A sponsor's fork/custom type is created in
      // `platform_review` (routes/v1/planner.ts POST /dataset-types/requests)
      // and needs a separate admin activation (Open Program → Dataset types)
      // before it may back a live pool — without this check, approving +
      // implementing a request could mint a public bounty on a type an admin
      // never actually reviewed, or one that was reviewed and REJECTED,
      // silently defeating the platform-review gate the fork/custom feature
      // exists to feed into. `active` is the only status a pool may launch on.
      if (request.datasetType.status !== DatasetTypeStatus.active) return "type_not_active" as const;
      if (!isComplexityScore(request.datasetType.complexityScore) || request.datasetType.verificationUnits === null) {
        return "unpriced_type" as const;
      }
      // Owner decision, 2026-09-09: no bounty at all without at least one
      // approved reference sample — see the mint route's identical gate for
      // the full rationale.
      if (preparedSampleAssets.length === 0) {
        return "no_samples" as const;
      }

      const difficulty = resolvePoolDifficulty(request.difficultyMix);
      const auditCoveragePct = request.auditCoveragePct ?? 10;
      const karmaPerAcceptedItem = KARMA_RULES.acceptedItem[difficulty];

      // No bounty exists yet at this point, so there is nothing to exclude —
      // the count is already only OTHER bounties on this dataset_type.
      const safeToWriteSampleAssets = await safeToWriteSampleAssetsFor(
        tx,
        request.datasetType.id,
        undefined,
        request.datasetType.sampleAssets
      );

      const b = await tx.bounty.create({
        data: {
          requesterUserId: user.id,
          communityRequesterUserId: request.requesterUserId,
          kind: BountyKind.community,
          title: request.title,
          description: request.description,
          datasetCategory: request.datasetType.category,
          // Canonicalised on the way onto the bounty as well as on the way
          // onto the request. The request's own value is already folded at
          // write time (POST/PATCH /v1/community/requests, planner finalize),
          // but rows created BEFORE that landed are not retroactively fixed —
          // so minting from an older request would still carry a stray casing
          // into the column the catalog's language filter groups by.
          language: canonicalLanguageFor(request.datasetType, request.language) ?? "TypeScript",
          framework: request.framework ?? "Node.js",
          targetItems: BigInt(parsed.data.targetItems),
          // Kept strictly below targetItems, because
          // `bounties_required_sponsor_examples_bounds` (restored from V1 by
          // migration 20260902100000) enforces
          // `required_sponsor_examples < target_items`. Nothing else in this
          // codebase sets the column, so every pool minted here took
          // schema.prisma's `@default(3)` — and `implementBody` allows
          // targetItems as low as 1, so minting a 1-, 2- or 3-item pool hit the
          // CHECK and surfaced as an opaque 500 rather than a validation error.
          // Clamping (rather than rejecting) keeps small pools mintable; the
          // sample-example requirement is a quality gate that cannot exceed the
          // pool's own size, so on a tiny pool it correctly relaxes.
          requiredSponsorExamples: Math.max(0, Math.min(3, parsed.data.targetItems - 1)),
          karmaPerAcceptedItem,
          auditCoveragePct,
          auditMode: "partial",
          holdDays: 0,
          disputeWindowHours: 48,
          communityLicense: request.proposedLicense,
          // Derived, not just carried over, for the same reason the mint
          // route above derives it rather than trusting a caller-supplied
          // URL: this route never took a URL from `implementBody` (only
          // `targetItems`), so leaving this unset meant a live, published
          // program's `Bounty.communityLicenseUrl` stayed NULL forever — the
          // gap this file's mint-route fix left unclosed on the route the
          // admin console actually calls. `request.proposedLicense` is safe
          // to force through `datasetLicense()!` un-checked here: unlike
          // `mintBountyBody.communityLicense` above, it was never this
          // route's own input — it was already canonicalised against this
          // same bundled-licence list at write time (routes/v1/community.ts
          // `proposedLicenseField`, services/planner.ts `plannerLicense`),
          // so a request that reached `approved` cannot hold a value
          // `datasetLicense` fails to resolve.
          communityLicenseUrl: datasetLicense(request.proposedLicense)!.url,
          poolDifficulty: difficulty,
          status: BountyStatus.active,
          datasetTypeId: request.datasetType.id,
          datasetTypeVersion: request.datasetType.version,
        },
      });

      await tx.datasetRequest.update({
        where: { id: request.id },
        data: { mintedBountyId: b.id, status: DatasetRequestStatus.implemented },
      });

      if (safeToWriteSampleAssets) {
        await tx.datasetType.update({
          where: { id: request.datasetType.id },
          data: { sampleAssets: preparedSampleAssets },
        });
      }

      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.community_program.implemented",
        targetType: "Bounty",
        targetId: b.id,
        after: {
          title: b.title,
          targetItems: parsed.data.targetItems,
          difficulty,
          fromRequestId: request.id,
          sampleAssetsCopied: safeToWriteSampleAssets ? preparedSampleAssets.length : 0,
        },
        ip: req.ip,
      });

      return { bounty: b, created: true as const, domain: request.datasetType.domain };
    }, { timeout: 15_000 });

    if (result === "not_found") return reply.notFound("Dataset request not found");
    if (result === "self_review") return reply.forbidden("you cannot implement your own dataset request");
    if (result === "not_approved") return reply.conflict("Only an approved request can be implemented.");
    if (result === "missing_type") {
      return reply.badRequest("This request has no dataset type set — assign one (Open Program → Dataset types, or the request's own type field) before creating a program.");
    }
    if (result === "type_not_active") {
      return reply.conflict("This request's dataset type has not been activated yet (or was rejected) — review and activate it (Open Program → Dataset types) before this request can back a live program.");
    }
    if (result === "unpriced_type") {
      return reply.conflict("This dataset type isn't priced for karma yet — an admin must set its complexity score (1–4) and verification units on the type (Open Program → Dataset types) before it can back a community program.");
    }
    if (result === "no_samples") {
      return reply.conflict(
        "This request has no approved reference example yet — a program cannot launch until at least one sponsor_reference sample has been reviewed and approved (Open Program → review samples)."
      );
    }

    // `bounty` carries THREE BigInt columns (targetItems, acceptedItems,
    // finalAcceptedItems) — spreading all of `bounty` while only converting
    // two of them still leaves a raw BigInt in the response, and
    // JSON.stringify throws ("Do not know how to serialize a BigInt"),
    // turning a mint that actually SUCCEEDED in the DB into a 500 the admin
    // sees as a failure (risking a confused retry / duplicate mint attempt).
    const { bounty } = result;

    // Fire the new-work watch alert only on the transaction that ACTUALLY
    // minted the bounty (v1 parity: databounty-api services/funding.ts fires
    // emitNewWorkMatches once, when a bounty first opens to the pool). The
    // idempotent-replay branch above (`created: false`) returns an
    // already-minted bounty from a prior call — firing again there would not
    // be wrong (per-user eventKey upsert makes it a no-op) but is pointless
    // extra watch-pref scanning on every retried/duplicate request. Fired
    // post-commit, outside the mint transaction, and NOT awaited — see the
    // matching comment on the /dataset-requests/:id/mint route above for why
    // blocking this admin-facing response on a potentially large watcher scan
    // is unsafe (fanOutWatchers opens one transaction per matching recipient
    // with no batching job to offload it to); per-recipient failures are
    // already caught and logged inside fanOutWatchers itself.
    if (result.created) {
      void emitNewWorkMatches({
        id: bounty.id,
        title: bounty.title,
        datasetCategory: bounty.datasetCategory,
        language: bounty.language,
        requesterUserId: bounty.communityRequesterUserId ?? bounty.requesterUserId,
        domain: result.domain,
      }).catch((err) => {
        console.error(`[admin-community] emitNewWorkMatches failed for bounty ${bounty.id}`, err);
      });
    }
    return reply.status(201).send({
      bounty: {
        ...bounty,
        targetItems: Number(bounty.targetItems),
        acceptedItems: Number(bounty.acceptedItems),
        finalAcceptedItems: Number(bounty.finalAcceptedItems),
      },
    });
  });

  // GET /community/activity — 90-day karma rollup, one row per day. Derived
  // directly from immutable karma evidence; not a client heatmap or cache —
  // a day is reproducible from source events.
  app.get("/community/activity", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    // Optional from/to, same contract as the other console filters (the client
    // sends full ISO instants). Absent bounds fall back to the original
    // trailing-90-day window, so an unranged call behaves exactly as before.
    const q = req.query as { from?: string; to?: string };
    const parseBound = (raw: string | undefined, label: string): Date | null => {
      if (raw === undefined || raw === "") return null;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) throw app.httpErrors.badRequest(`Invalid \`${label}\` date: ${raw}`);
      return parsed;
    };
    const to = parseBound(q.to, "to") ?? new Date();
    const from = parseBound(q.from, "from") ?? new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
    if (from > to) throw app.httpErrors.badRequest("`from` must not be after `to`.");

    // Bounds are interpolated as Prisma template parameters, not concatenated
    // into the SQL string.
    const rows = await prisma.$queryRaw<{ day: Date; karma: bigint; events: bigint; contributors: bigint }[]>`
      SELECT date_trunc('day', created_at) AS day,
             COALESCE(SUM(amount), 0)::bigint AS karma,
             COUNT(*)::bigint AS events,
             COUNT(DISTINCT user_id)::bigint AS contributors
      FROM karma_events
      WHERE created_at >= ${from} AND created_at <= ${to}
      GROUP BY date_trunc('day', created_at)
      ORDER BY day ASC`;
    return reply.send({
      // Echoed from the server so the page captions the window actually
      // queried rather than whatever the picker believes it asked for.
      window: { from: from.toISOString(), to: to.toISOString(), defaulted: q.from === undefined && q.to === undefined },
      activity: rows.map((row) => ({ day: row.day.toISOString(), karma: Number(row.karma), events: Number(row.events), contributors: Number(row.contributors) })),
    });
  });

  // GET /community/open — Overview-tab metrics. Every number here is a real
  // aggregate; nothing is derived client-side from unrelated endpoints.
  app.get("/community/open", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (_req, reply) => {
    const [programs, activePrograms, totals, karmaSum, pipelineGroups, requestGroups, leaders] = await Promise.all([
      prisma.bounty.count({ where: { kind: BountyKind.community } }),
      // The overview's "active pools" stat — pools currently open, not the
      // all-time minted total above. The admin dashboard read this exact
      // field name while the endpoint never sent it, so the stat rendered
      // "—" forever.
      prisma.bounty.count({ where: { kind: BountyKind.community, status: BountyStatus.active } }),
      prisma.bounty.aggregate({
        where: { kind: BountyKind.community },
        _sum: { targetItems: true, acceptedItems: true, finalAcceptedItems: true },
      }),
      prisma.karmaEvent.aggregate({ _sum: { amount: true } }),
      prisma.submission.groupBy({
        by: ["status"],
        where: { bounty: { kind: BountyKind.community }, status: { not: SubmissionStatus.draft } },
        _count: { _all: true },
      }),
      prisma.datasetRequest.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.user.findMany({
        where: { karmaTotal: { gt: 0 } },
        select: { id: true, displayName: true, handle: true, karmaTotal: true },
        orderBy: { karmaTotal: "desc" },
        take: 5,
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const g of pipelineGroups) counts[g.status] = g._count._all;
    // Every non-draft submission bucketed into exactly one of three real
    // pipeline stages: not yet picked up, somewhere mid-pipeline/audit, or a
    // terminal verdict. See SubmissionStatus enum (schema.prisma) for the
    // full state list this partitions.
    const pending = counts.submitted ?? 0;
    const inVerification =
      (counts.duplicate_check ?? 0) +
      (counts.running_tests ?? 0) +
      (counts.tests_failed ?? 0) +
      (counts.llm_validation ?? 0) +
      (counts.needs_fixes ?? 0) +
      (counts.provisionally_accepted ?? 0) +
      (counts.in_audit ?? 0) +
      (counts.in_sponsor_review ?? 0) +
      (counts.flagged ?? 0) +
      (counts.disputed ?? 0) +
      (counts.accepted_pending_sample ?? 0);
    const completed = (counts.accepted ?? 0) + (counts.rejected ?? 0);

    const requestCounts: Record<string, number> = {};
    for (const g of requestGroups) requestCounts[g.status] = g._count._all;

    return reply.send({
      programs,
      activePrograms,
      acceptedItems: String(totals._sum.finalAcceptedItems ?? 0n),
      clearedItems: String(totals._sum.acceptedItems ?? 0n),
      targetItems: String(totals._sum.targetItems ?? 0n),
      totalKarma: karmaSum._sum.amount ?? 0,
      pipelineBreakdown: { pending, inVerification, completed },
      requestCounts,
      leaders: leaders.map((u) => ({ user: { id: u.id, displayName: u.displayName, handle: u.handle }, karma: u.karmaTotal })),
    });
  });

  const datasetListQuery = z.object({
    id: z.string().optional(),
    filter: z.enum(["all", "publishable", "published"]).default("all"),
    search: z.string().trim().max(200).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });

  /** Per-bounty pipeline summary — the same real buckets
   * getPoolContractForBounty (services/bounties.ts) computes for the
   * contributor-facing contract, reused here for the admin fill table so the
   * two surfaces can never silently disagree. */
  async function buildPoolSummary(bounty: { id: string; targetItems: bigint; acceptedItems: bigint; finalAcceptedItems: bigint; auditCoveragePct: number; communityValidationMode: string | null }) {
    const statusCounts = await prisma.submission.groupBy({ by: ["status"], where: { bountyId: bounty.id }, _count: { _all: true } });
    const counts: Record<string, number> = {};
    for (const r of statusCounts) counts[r.status] = r._count._all;
    const processing =
      (counts.draft ?? 0) + (counts.submitted ?? 0) + (counts.duplicate_check ?? 0) +
      (counts.running_tests ?? 0) + (counts.llm_validation ?? 0);
    const policy =
      bounty.communityValidationMode === "full_human" || bounty.communityValidationMode === "automation_only"
        ? { validation: bounty.communityValidationMode as "full_human" | "automation_only", sponsorDispute: false as const, karmaRelease: "on_final_accept" as const }
        : undefined;
    return {
      ...(policy ? { policy } : {}),
      capacityReserved: Number(bounty.acceptedItems),
      finalAccepted: Number(bounty.finalAcceptedItems),
      validatorReview: (counts.in_audit ?? 0) + (counts.provisionally_accepted ?? 0),
      processing,
      rejected: counts.rejected ?? 0,
      failedAutomatedChecks: counts.tests_failed ?? 0,
    };
  }

  // GET /community/datasets — per-program fill table backing the "All
  // programs" / "Ready to publish" tabs. Publishable-ratio filtering needs a
  // computed value (cleared/target), so pages are scanned in bounded batches
  // (same shape as admin-artifacts.ts's SCAN_CAP) rather than expressed as a
  // single SQL WHERE; a numeric offset (base64) is the cursor.
  const DATASET_SCAN_CAP = 2000;
  app.get("/community/datasets", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = datasetListQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const { id, filter, search } = parsed.data;
    const limit = parsed.data.limit ?? 25;
    const offset = parsed.data.cursor ? Number(Buffer.from(parsed.data.cursor, "base64url").toString("utf8")) || 0 : 0;

    const where: Prisma.BountyWhereInput = {
      kind: BountyKind.community,
      ...(id ? { id } : {}),
      ...(search
        ? { OR: [{ title: { contains: search, mode: "insensitive" } }, { datasetType: { name: { contains: search, mode: "insensitive" } } }] }
        : {}),
    };

    const all = await prisma.bounty.findMany({
      where,
      include: {
        datasetType: { select: { name: true } },
        publications: { select: { target: true, status: true, url: true, pushedAt: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DATASET_SCAN_CAP,
    });

    const contributorCounts = all.length
      ? await prisma.submission.groupBy({ by: ["bountyId", "contributorUserId"], where: { bountyId: { in: all.map((b) => b.id) } } })
      : [];
    const contributorsByBounty = new Map<string, Set<string>>();
    for (const row of contributorCounts) {
      const set = contributorsByBounty.get(row.bountyId) ?? new Set<string>();
      set.add(row.contributorUserId);
      contributorsByBounty.set(row.bountyId, set);
    }

    const rows = await Promise.all(
      all.map(async (b) => {
        const target = Number(b.targetItems);
        const cleared = Number(b.acceptedItems);
        const ratio = target > 0 ? cleared / target : 0;
        return {
          id: b.id,
          title: b.title,
          datasetTypeName: b.datasetType?.name ?? null,
          acceptedItems: String(b.finalAcceptedItems),
          clearedItems: String(b.acceptedItems),
          targetItems: String(b.targetItems),
          contributors: contributorsByBounty.get(b.id)?.size ?? 0,
          karmaPerAcceptedItem: b.karmaPerAcceptedItem,
          publicationStatus: b.publicationStatus,
          huggingFaceDataset: b.huggingFaceDataset,
          // Every confirmed target beyond Hugging Face — see
          // publicPublicationsOf() in services/bounties.ts.
          publications: publicPublicationsOf(b.publications),
          communityLicense: b.communityLicense,
          poolSummary: await buildPoolSummary(b),
          _ratio: ratio,
        };
      })
    );

    const filtered = rows.filter((r) => {
      if (filter === "published") return r.publicationStatus === CommunityPublicationStatus.published;
      if (filter === "publishable") return r.publicationStatus !== CommunityPublicationStatus.published && r._ratio >= 0.98;
      return true;
    });

    const page = filtered.slice(offset, offset + limit).map(({ _ratio: _r, ...rest }) => rest);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < filtered.length ? Buffer.from(String(nextOffset), "utf8").toString("base64url") : null;

    return reply.send({ datasets: page, nextCursor });
  });

  // GET /community/datasets/:id/audit-routing — backs community/apps/admin's
  // /details?kind=program page. That page was ported from V1's batch-claim
  // validator model, whose display slot expects an "audit batch" status per
  // submission — Community has no AuditBatch model at all (open-pool
  // architecture: HumanAuditWindow + HumanAuditWindowMembership instead), so
  // this honestly maps the real per-submission audit-routing state into that
  // same generic display slot rather than fabricating a batch that doesn't
  // exist. A submission with no membership row genuinely was never routed
  // through an audit window yet (pool hasn't closed) — `routing: null`,
  // which the frontend already renders as "not routed".
  app.get("/community/datasets/:id/audit-routing", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: string };
    const limit = Math.min(query.limit ? Number(query.limit) : 100, 200);

    const bounty = await prisma.bounty.findUnique({ where: { id }, select: { id: true, title: true, kind: true } });
    if (!bounty || bounty.kind !== BountyKind.community) return reply.notFound("Community program not found");

    const submissions = await prisma.submission.findMany({
      where: { bountyId: id },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        status: true,
        duplicateDecision: true,
        llmScore: true,
      },
    });
    const submissionIds = submissions.map((s) => s.id);

    const [memberships, latestFlags] = await Promise.all([
      submissionIds.length
        ? prisma.humanAuditWindowMembership.findMany({
            where: { submissionId: { in: submissionIds } },
            include: { window: { select: { settledAt: true } } },
          })
        : [],
      submissionIds.length
        ? prisma.flag.findMany({ where: { submissionId: { in: submissionIds } }, orderBy: { createdAt: "desc" } })
        : [],
    ]);
    const membershipBySubmission = new Map(memberships.map((m) => [m.submissionId, m]));

    // The AUTHORITATIVE validator decision. The "verdict" column here used to
    // be fed a `Flag.status` (a flag-lifecycle value like `open`/`confirmed`),
    // with `decidedAt` taken from the audit WINDOW's `settledAt` — two
    // unrelated sources presented as one decision. An open flag in an
    // unsettled window therefore rendered its flag status in the verdict
    // column as though a validator had decided the item. A decision is the
    // pair (`verdict`, `decidedAt`) on AuditItem; see isDecidedAuditItem in
    // services/audits.ts.
    const auditItems = submissionIds.length
      ? await prisma.auditItem.findMany({
          where: { submissionId: { in: submissionIds }, verdict: { not: null }, decidedAt: { not: null } },
          orderBy: { decidedAt: "desc" },
          select: { submissionId: true, verdict: true, decidedAt: true },
        })
      : [];
    const decisionBySubmission = new Map<string, (typeof auditItems)[number]>();
    for (const item of auditItems) {
      if (!decisionBySubmission.has(item.submissionId)) decisionBySubmission.set(item.submissionId, item);
    }
    const latestFlagBySubmission = new Map<string, (typeof latestFlags)[number]>();
    for (const f of latestFlags) {
      if (!latestFlagBySubmission.has(f.submissionId)) latestFlagBySubmission.set(f.submissionId, f);
    }

    return reply.send({
      program: { id: bounty.id, title: bounty.title },
      items: submissions.map((s) => {
        const membership = membershipBySubmission.get(s.id);
        const flag = latestFlagBySubmission.get(s.id);
        const routing = membership
          ? {
              auditBatchStatus: !membership.selected
                ? "auto-accepted, no audit"
                : membership.window.settledAt
                  ? "audit window settled"
                  : "in audit window",
              // Both from the same decision row, or both null. `flagStatus` is
              // still reported, but under its own name so it is no longer
              // mistaken for a verdict.
              verdict: decisionBySubmission.get(s.id)?.verdict ?? null,
              decidedAt: decisionBySubmission.get(s.id)?.decidedAt?.toISOString() ?? null,
              flagStatus: flag ? flag.status : null,
              windowSettledAt: membership.window.settledAt ? membership.window.settledAt.toISOString() : null,
            }
          : null;
        return {
          submissionId: s.id,
          submissionStatus: s.status,
          duplicateDecision: s.duplicateDecision,
          llmScore: s.llmScore,
          routing,
        };
      }),
    });
  });

  // GET /sponsor-examples (full path /v1/admin/sponsor-examples) — platform-wide queue of sponsor
  // reference samples ("Artifact.kind === sponsor_reference") awaiting admin
  // review. Ported from v1 (databounty-api/src/routes/v1/admin.ts
  // `GET /sponsor-examples`), which never made it into this rebuild — the
  // review ACTION (`POST /v1/artifacts/:id/sponsor-review`) already existed
  // here with nothing surfacing what needs reviewing.
  //
  // Two owners, one queue: a sample is attached either to an already-minted
  // Bounty (its community pool) or, pre-mint, to a DatasetRequest
  // (`bountyId` null, `datasetRequestId` set — see the Artifact model's
  // INVARIANT comment). A `bounty: {...}` relation filter alone would
  // silently exclude every pre-mint sample, so both owners are queried via
  // `include` and the response's `owner` block tells the console honestly
  // which one it is rather than implying a bounty exists before mint.
  app.get(
    "/sponsor-examples",
    { preHandler: requireRole(...ADMIN_AND_ABOVE_READONLY) },
    async (_req, reply) => {
      const examples = await prisma.artifact.findMany({
        where: {
          kind: "sponsor_reference",
          status: "ready",
          sponsorReviewStatus: { in: ["pending", "needs_changes"] },
          deletedAt: null,
        },
        include: {
          // The CONTRACT the reviewer is judging this sample against, plus
          // the scope the sponsor actually specified — without them the
          // console can only show a filename and a content type, with
          // nothing to judge the sample against.
          bounty: {
            select: {
              id: true, title: true, requesterUserId: true, description: true,
              language: true, framework: true, targetItems: true,
              auditCoveragePct: true,
              datasetType: { select: { id: true, name: true, version: true, fields: true } },
              requester: { select: { displayName: true, handle: true } },
            },
          },
          datasetRequest: {
            select: {
              id: true, title: true, requesterUserId: true, status: true, description: true,
              language: true, framework: true, targetItems: true, difficultyMix: true,
              auditCoveragePct: true,
              datasetType: { select: { id: true, name: true, version: true, fields: true } },
              requester: { select: { displayName: true, handle: true } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
        take: 100,
      });

      // Latest evidence per (artifact, stage), same "ordered desc, keep only
      // the first" idiom admin-artifacts.ts already uses for its per-stage
      // evidence map. Advisory only — a stage that never ran stays `null`
      // rather than defaulting to a pass, so the reviewer is never shown a
      // fabricated verdict.
      const evidenceRows = examples.length
        ? await prisma.artifactProcessingEvent.findMany({
            where: {
              artifactId: { in: examples.map((example) => example.id) },
              stage: { in: [SAMPLE_LLM_REVIEW_STAGE, SAMPLE_SIMILARITY_STAGE] },
            },
            orderBy: { createdAt: "desc" },
          })
        : [];
      const latestEvidence = new Map<string, { stage: string; status: string; detail: unknown; createdAt: Date }>();
      for (const row of evidenceRows) {
        const key = `${row.artifactId}:${row.stage}`;
        if (!latestEvidence.has(key)) {
          latestEvidence.set(key, { stage: row.stage, status: row.status, detail: row.detail, createdAt: row.createdAt });
        }
      }

      return reply.send({
        examples: examples.map((example) => ({
          id: example.id,
          bountyId: example.bountyId,
          // Kept for backward-shape reasons; `owner` below is what the UI
          // should actually use to label the row.
          bountyTitle: example.bounty?.title ?? "Bounty",
          // Explicit owner block so the console can label and link a
          // pre-mint sample honestly instead of showing it under a bounty
          // that does not exist yet.
          owner: example.bounty
            ? { type: "bounty" as const, id: example.bounty.id, title: example.bounty.title }
            : example.datasetRequest
              ? {
                  type: "dataset_request" as const,
                  id: example.datasetRequest.id,
                  title: example.datasetRequest.title,
                  requestStatus: example.datasetRequest.status,
                }
              : null,
          filename: example.filename,
          contentType: example.contentType,
          status: example.sponsorReviewStatus,
          note: example.sponsorReviewNote,
          createdAt: example.createdAt.toISOString(),
          downloadUrl: `/v1/artifacts/${example.id}/content`,
          // What the sponsor specified, and the contract to judge against.
          // Bounty-owned and request-owned samples carry the same shape so
          // the console renders one panel rather than branching on owner
          // type.
          contract: (() => {
            const type = example.bounty?.datasetType ?? example.datasetRequest?.datasetType ?? null;
            return type ? { id: type.id, name: type.name, version: type.version, fields: type.fields } : null;
          })(),
          scope: (() => {
            const source = example.bounty ?? example.datasetRequest ?? null;
            if (!source) return null;
            return {
              description: source.description ?? null,
              language: source.language ?? null,
              framework: source.framework ?? null,
              // BigInt on Bounty, Int on DatasetRequest — normalise, or the
              // JSON serializer throws on the bounty-owned case.
              targetItems: source.targetItems != null ? Number(source.targetItems) : null,
              difficultyMix: "difficultyMix" in source ? (source.difficultyMix ?? null) : null,
              auditCoveragePct: source.auditCoveragePct ?? null,
              requester: source.requester
                ? { displayName: source.requester.displayName, handle: source.requester.handle }
                : null,
            };
          })(),
          // Advisory only — never a verdict the console should present as a
          // decision. `null` means the check has not run, which the UI must
          // show as such rather than as a pass.
          evidence: {
            llmReview: latestEvidence.get(`${example.id}:${SAMPLE_LLM_REVIEW_STAGE}`) ?? null,
            similarity: latestEvidence.get(`${example.id}:${SAMPLE_SIMILARITY_STAGE}`) ?? null,
          },
        })),
      });
    }
  );

  const publicationActionBody = z.object({ action: z.enum(["request_review", "start_publishing", "retry", "retract"]) });

  // POST /community/bounties/:id/publication — the state-machine actions the
  // "status" column on the datasets table drives. request_review is a fully
  // local transition. start_publishing/retry now enqueue the real async
  // `community.publish` job (services/community-publish.ts's
  // enqueueCommunityPublish, consumed by src/worker.ts) that fans out to
  // every configured target (Hugging Face / GitHub) — this route never talks
  // to a provider directly, matching the job-queued pattern the rest of this
  // deployment already uses for anything that calls out to an external
  // system (artifact.scan, pool.sampling). It flips the row to `pending`
  // (queued, waiting on the worker) and returns 202 rather than pretending
  // the push already finished — the job itself records `published`,
  // `failed`, or `not_configured` per target once it actually runs.
  // retract enqueues `community.unpublish`, which withdraws every currently
  // published target through the provider's own `unpublishDataset` (both
  // implement it; both flip the repo private rather than deleting). It returns
  // 202 and leaves `publicationStatus` alone — the status changes only once a
  // provider confirms, so nothing ever reads as retracted while still public.
  // POST /admin/publications/:bountyId/attest remains for recording a manual
  // action taken directly at a provider.
  app.post("/community/bounties/:id/publication", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = publicationActionBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const bounty = await prisma.bounty.findUnique({ where: { id } });
    if (!bounty || bounty.kind !== BountyKind.community) return reply.notFound("Community program not found");

    if (parsed.data.action === "request_review") {
      const allowed: CommunityPublicationStatus[] = [
        CommunityPublicationStatus.not_requested,
        CommunityPublicationStatus.pending,
        CommunityPublicationStatus.retracted,
      ];
      if (!allowed.includes(bounty.publicationStatus)) {
        return reply.conflict(`Cannot request review from status "${bounty.publicationStatus}".`);
      }

      const updated = await prisma.$transaction(async (tx) => {
        const b = await tx.bounty.update({ where: { id }, data: { publicationStatus: CommunityPublicationStatus.manual_review } });
        await writeAuditLog(tx, {
          actorUserId: user.id,
          action: "admin.community_publication.review_requested",
          targetType: "Bounty",
          targetId: id,
          before: { publicationStatus: bounty.publicationStatus },
          after: { publicationStatus: b.publicationStatus },
          ip: req.ip,
        });
        return b;
      });

      return reply.send({ bounty: { id: updated.id, publicationStatus: updated.publicationStatus } });
    }

    if (parsed.data.action === "start_publishing" || parsed.data.action === "retry") {
      // `retry` additionally accepts `published`: `runCommunityPublishJob` loops
      // over EVERY target on each run (not just ones missing a row), and each
      // target's own idempotent-skip guard (community-publish.ts, the
      // `current?.status === published` check before the upsert) means an
      // already-published target is safely re-verified, never downgraded or
      // double-recorded. That is exactly what backfilling a target enabled
      // AFTER a bounty already published needs — e.g. GitHub turned on after a
      // bounty published to Hugging Face only: this bounty has no `github`
      // DatasetPublication row at all yet, and without this, "retry" was the
      // only enqueue path but was blocked from ever running for it.
      // `start_publishing` deliberately keeps the narrower list: it means
      // "this hasn't published yet", which `published` contradicts.
      const allowed: CommunityPublicationStatus[] =
        parsed.data.action === "retry"
          ? [
              CommunityPublicationStatus.manual_review,
              CommunityPublicationStatus.pending,
              CommunityPublicationStatus.failed,
              CommunityPublicationStatus.not_requested,
              CommunityPublicationStatus.published,
            ]
          : [
              CommunityPublicationStatus.manual_review,
              CommunityPublicationStatus.pending,
              CommunityPublicationStatus.failed,
              CommunityPublicationStatus.not_requested,
            ];
      if (!allowed.includes(bounty.publicationStatus)) {
        return reply.conflict(`Cannot ${parsed.data.action === "retry" ? "retry" : "start publishing"} from status "${bounty.publicationStatus}".`);
      }

      const updated = await prisma.$transaction(async (tx) => {
        const b = await tx.bounty.update({ where: { id }, data: { publicationStatus: CommunityPublicationStatus.pending } });
        await writeAuditLog(tx, {
          actorUserId: user.id,
          action:
            parsed.data.action === "retry" ? "admin.community_publication.retry_queued" : "admin.community_publication.publish_queued",
          targetType: "Bounty",
          targetId: id,
          before: { publicationStatus: bounty.publicationStatus },
          after: { publicationStatus: b.publicationStatus },
          ip: req.ip,
        });
        return b;
      });

      // Enqueue after the status-flip transaction commits — enqueueCommunityPublish
      // upserts on a bounty-scoped idempotencyKey, so a repeated retry click is
      // always safe and never creates a second job for the same bounty.
      await enqueueCommunityPublish(id);

      return reply.status(202).send({ bounty: { id: updated.id, publicationStatus: updated.publicationStatus }, queued: true });
    }

    // retract — enqueues the real async withdrawal. Both providers implement
    // `unpublishDataset` (lib/publication/{hugging-face,github}.ts) and both
    // withdraw by flipping the repo PRIVATE rather than deleting it, so the
    // commits and the contributor provenance in them survive and the retraction
    // stays reversible.
    //
    // Deliberately does NOT flip `publicationStatus` here: the dataset is still
    // publicly reachable until a provider confirms otherwise, and showing
    // "retracted" before that would be exactly the false trust claim this
    // platform treats as a defect. `runCommunityUnpublishJob` sets it, per
    // target, only on a confirmed withdrawal.
    const published = await prisma.datasetPublication.count({
      where: { bountyId: id, status: CommunityPublicationStatus.published },
    });
    if (published === 0) {
      return reply.conflict(
        `Nothing to retract: no target is currently published for this program (status "${bounty.publicationStatus}").`
      );
    }

    await prisma.$transaction(async (tx) => {
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.community_publication.retract_queued",
        targetType: "Bounty",
        targetId: id,
        before: { publicationStatus: bounty.publicationStatus, publishedTargets: published },
        after: { publicationStatus: bounty.publicationStatus },
        ip: req.ip,
      });
    });

    await enqueueCommunityUnpublish(id);

    return reply.status(202).send({
      bounty: { id, publicationStatus: bounty.publicationStatus },
      queued: true,
      targets: published,
    });
  });
}
