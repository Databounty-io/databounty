// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { BountyKind, SubmissionStatus, FlagStatus, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { findRejectingStage, formatStageScoreSuffix } from "../../lib/validation-state.js";
import { requireRole, ADMIN_AND_ABOVE_READONLY } from "../../lib/rbac.js";
import { contributorRankForAcceptedItems, validatorRankForAudits } from "../../services/reputation.js";

/**
 * Internal detail lookups backing community/apps/admin's /details page
 * (`GET /v1/admin/internal/:kind/:id` for kind = contributor | validator |
 * submission | bounty; `program` is a separate, not-yet-built lookup here —
 * it already has its own route at
 * /admin/community/datasets/:id/audit-routing).
 *
 * Reuses the same schema-gap honesty already established elsewhere in this
 * codebase:
 *  - no per-validator claimed-audit record exists (services/audits.ts posts
 *    window-level decisions, not per-validator claims — see me.ts's
 *    /validator-dashboard and /audits comments), so a validator's `audits`
 *    array is honestly always empty rather than fabricated.
 *  - no per-decision record with a verdict/note beyond the Flag row exists
 *    (see admin.ts's dispute-evidence `auditDecisions: []` comment), so a
 *    submission's `auditDecisions` is the same honest empty array.
 *  - Flag.validatorUserId has no Prisma relation back to User, so validator
 *    labels are resolved with a second lookup, same pattern used throughout
 *    admin-submissions.ts and admin.ts.
 */

type ContractField = { key: string; label: string; role: string | null };
type Contract = { fields: ContractField[]; pipeline: string[]; llmValidationEnabled?: boolean };

function parseContract(datasetType: { fields: Prisma.JsonValue; verification: Prisma.JsonValue } | null | undefined): Contract | undefined {
  if (!datasetType) return undefined;
  const rawFields = Array.isArray(datasetType.fields) ? datasetType.fields : [];
  const fields: ContractField[] = rawFields
    .filter((f) => !!f && typeof f === "object" && !Array.isArray(f))
    .map((f) => f as Record<string, unknown>)
    .map((f) => ({
      key: typeof f.key === "string" ? f.key : "",
      label: typeof f.label === "string" ? f.label : typeof f.key === "string" ? f.key : "",
      role: typeof f.role === "string" ? f.role : null,
    }))
    .filter((f) => f.key !== "");

  const verification =
    datasetType.verification && typeof datasetType.verification === "object" && !Array.isArray(datasetType.verification)
      ? (datasetType.verification as Record<string, unknown>)
      : {};
  const pipeline = Array.isArray(verification.pipeline)
    ? verification.pipeline.filter((p): p is string => typeof p === "string")
    : [];
  const auditOptions =
    verification.auditOptions && typeof verification.auditOptions === "object" && !Array.isArray(verification.auditOptions)
      ? (verification.auditOptions as Record<string, unknown>)
      : {};
  const llmValidationEnabled = typeof auditOptions.llmValidationEnabled === "boolean" ? auditOptions.llmValidationEnabled : undefined;

  return { fields, pipeline, llmValidationEnabled };
}

function bountyRef(bounty: { id: string; title: string; kind?: string; datasetCategory?: string; datasetType?: { id: string; name: string; fields: Prisma.JsonValue; verification: Prisma.JsonValue } | null }) {
  return {
    id: bounty.id,
    title: bounty.title,
    ...(bounty.kind ? { kind: bounty.kind } : {}),
    ...(bounty.datasetCategory ? { datasetCategory: bounty.datasetCategory } : {}),
    datasetType: bounty.datasetType ? { id: bounty.datasetType.id, name: bounty.datasetType.name } : null,
  };
}

async function buildValidationStages(submissionId: string) {
  const results = await prisma.validationResult.findMany({
    where: { submissionId },
    orderBy: { createdAt: "desc" },
  });
  const latestByStage = new Map<string, (typeof results)[number]>();
  for (const r of results) if (!latestByStage.has(r.stage)) latestByStage.set(r.stage, r);
  return Array.from(latestByStage.values()).map((r) => ({
    stage: r.stage,
    passed: r.passed,
    score: r.score,
    status: r.outcome,
    // `detailJson` is REQUIRED to classify two stages: `ai_attribution` and a
    // passing `dedupe` are written with no `outcome` column at all
    // (services/validation.ts:92,144), so a consumer given only `outcome`
    // cannot tell a flagged attribution from a terminal failure. Shipping
    // `outcome` alone is what made the admin pill render an AI-attribution
    // flag as "recorded" and a terminal dedupe rejection as an amber hold.
    detailJson: r.detailJson,
    // `createdAt` so a consumer can order/date a stage row.
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function adminInternalRoutes(app: FastifyInstance) {
  // `user` is the whole-ACCOUNT record behind the /users roster
  // (community/apps/admin's /users/view page) — one person across every hat
  // they have worn (sponsor of a dataset request, contributor, validator).
  // Deliberately distinct from the `contributor` / `validator` kinds below,
  // which stay as single-track work histories reached from their own
  // rosters. Counts mirror the same groupBy shape already computed for the
  // roster's per-row `activity` summary above (`/users`), just for one id
  // instead of a page of them.
  app.get("/internal/user/:id", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        displayName: true,
        email: true,
        handle: true,
        authMethod: true,
        status: true,
        onboarded: true,
        persona: true,
        profilePublic: true,
        emailVerifiedAt: true,
        createdAt: true,
        lastSeenAt: true,
        karmaTotal: true,
        roles: { select: { role: true } },
        rank: {
          select: {
            contributorRank: true,
            validatorRank: true,
            acceptedItems: true,
            auditsCompleted: true,
            contributorAbandons: true,
            contributorMissedDeadlines: true,
            validatorMissedDeadlines: true,
          },
        },
      },
    });
    if (!user) return reply.notFound("User not found");

    const [
      sponsoredBounties,
      datasetRequests,
      submissions,
      flags,
      karmaEvents,
      submissionStatusRows,
      bountyTotal,
      requestTotal,
      flagTotal,
      openRequestTotal,
      karmaEventTotal,
      distinctBounties,
    ] = await Promise.all([
      prisma.bounty.findMany({
        // `kind` explicit here too (see admin.ts's /overview comment) even
        // though it's also selected below for display — selecting a field
        // and filtering on it are different guarantees, and this profile
        // list must not silently start including a future non-community
        // bounty kind just because nothing else in the where clause excludes it.
        where: { requesterUserId: id, kind: BountyKind.community },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { id: true, title: true, kind: true, status: true, datasetCategory: true, datasetType: { select: { id: true, name: true } }, targetItems: true, acceptedItems: true, createdAt: true },
      }),
      prisma.datasetRequest.findMany({
        where: { requesterUserId: id },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { id: true, title: true, status: true, targetItems: true, proposedLicense: true, createdAt: true },
      }),
      prisma.submission.findMany({
        where: { contributorUserId: id },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { bounty: { include: { datasetType: true } } },
      }),
      prisma.flag.findMany({
        where: { validatorUserId: id },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { submission: { include: { bounty: { include: { datasetType: true } } } } },
      }),
      prisma.karmaEvent.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { id: true, eventType: true, amount: true, sourceType: true, sourceId: true, createdAt: true },
      }),
      // Counted, not derived from the capped lists above — a 100-row page
      // must never be presented as the account's whole history.
      prisma.submission.groupBy({
        by: ["status"],
        where: { contributorUserId: id, bounty: { kind: BountyKind.community } },
        _count: { _all: true },
      }),
      prisma.bounty.count({ where: { requesterUserId: id, kind: BountyKind.community } }),
      prisma.datasetRequest.count({ where: { requesterUserId: id } }),
      prisma.flag.count({ where: { validatorUserId: id } }),
      // An implemented request already appears as its minted bounty (see the
      // roster's own openDatasetRequests count above), so this headline
      // figure counts only requests that have not become one yet.
      prisma.datasetRequest.count({ where: { requesterUserId: id, mintedBountyId: null } }),
      prisma.karmaEvent.count({ where: { userId: id } }),
      // Distinct datasets/bounties this account has submitted to — not the
      // raw submission count (many submissions can land in one dataset).
      prisma.submission.findMany({
        where: { contributorUserId: id, bounty: { kind: BountyKind.community } },
        distinct: ["bountyId"],
        select: { bountyId: true },
      }),
    ]);

    const submissionByStatus = Object.fromEntries(submissionStatusRows.map((r) => [r.status, r._count._all]));
    const acceptedCount = submissionByStatus[SubmissionStatus.accepted] ?? 0;
    const submissionTotal = submissionStatusRows.reduce((sum, r) => sum + r._count._all, 0);

    return reply.send({
      profile: {
        id: user.id,
        label: user.displayName ?? user.handle ?? user.id,
        email: user.email,
        handle: user.handle,
        authMethod: user.authMethod,
        status: user.status,
        onboarded: user.onboarded,
        emailVerified: user.emailVerifiedAt !== null,
        profilePublic: user.profilePublic,
        // A landing preference, not a permission — see the /users route.
        persona: user.persona,
        createdAt: user.createdAt.toISOString(),
        lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
        karmaTotal: user.karmaTotal,
        roles: user.roles.map((r) => r.role as string),
        contributorRank: user.rank?.contributorRank ?? null,
        validatorRank: user.rank?.validatorRank ?? null,
      },
      metrics: {
        sponsoredBounties: bountyTotal,
        datasetRequests: requestTotal,
        openDatasetRequests: openRequestTotal,
        submissions: submissionTotal,
        acceptedSubmissions: acceptedCount,
        rejectedSubmissions: submissionByStatus[SubmissionStatus.rejected] ?? 0,
        submissionsByStatus: submissionByStatus,
        // Explicitly null, not `{}`. The console renders an "Audit outcomes"
        // section from this, and `{}` there would render as "this account has
        // never been assigned an audit batch" — a claim about the ACCOUNT that
        // this schema cannot support. There is no per-validator claimed-audit
        // record anywhere to group by (same gap documented on the `audits: []`
        // array below), so the truthful answer is "not available", which null
        // carries and an empty object does not. Previously this key was absent
        // altogether, which crashed the page on Object.keys(undefined).
        auditsByStatus: null,
        auditsCompleted: user.rank?.auditsCompleted ?? 0,
        acceptedItems: user.rank?.acceptedItems ?? 0,
        flagsRaised: flagTotal,
        abandons: user.rank?.contributorAbandons ?? 0,
        contributorMissedDeadlines: user.rank?.contributorMissedDeadlines ?? 0,
        validatorMissedDeadlines: user.rank?.validatorMissedDeadlines ?? 0,
        karmaEvents: karmaEventTotal,
        distinctDatasetsContributed: distinctBounties.length,
      },
      sponsored: {
        bounties: sponsoredBounties.map((b) => ({ ...b, targetItems: Number(b.targetItems), acceptedItems: Number(b.acceptedItems) })),
        datasetRequests,
      },
      // `validationStages` is REQUIRED here, not optional decoration: the
      // client's `Stages` component (apps/admin/app/(dashboard)/users/view/view.tsx)
      // does `stages.length` on it unconditionally with no undefined guard.
      // This field was missing entirely (unlike the sibling
      // `/internal/contributor/:id` route below, which already calls
      // `buildValidationStages` per submission) — every submission on this
      // page carried no `validationStages` key, so opening the Contributor
      // tab on ANY account with at least one submission threw
      // "Cannot read properties of undefined (reading 'length')" and crashed
      // the whole page to Next.js's error boundary. Found live 2026-09-05
      // against a real 100-submission account.
      submissions: await Promise.all(
        submissions.map(async (s) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          createdAt: s.createdAt.toISOString(),
          bounty: bountyRef(s.bounty),
          validationStages: await buildValidationStages(s.id),
        }))
      ),
      // Honest empty — see the `validator` kind below. No per-validator
      // claimed-audit record exists anywhere in this schema to read one back
      // from (services/audits.ts posts window-level decisions, not
      // per-validator claims).
      audits: [] as unknown[],
      flags: flags.map((f) => ({
        id: f.id,
        reason: f.reason,
        status: f.status,
        createdAt: f.createdAt.toISOString(),
        submission: { id: f.submission.id, title: f.submission.title, bounty: bountyRef(f.submission.bounty) },
      })),
      karmaEvents: karmaEvents.map((k) => ({ ...k, createdAt: k.createdAt.toISOString() })),
    });
  });

  app.get("/internal/contributor/:id", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, displayName: true, handle: true, status: true } });
    if (!user) return reply.notFound("Contributor not found");

    const submissions = await prisma.submission.findMany({
      where: { contributorUserId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { bounty: { include: { datasetType: true } } },
    });

    const acceptedItems = submissions.filter((s) => s.status === SubmissionStatus.accepted).length;

    const history = await Promise.all(
      submissions.map(async (s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        createdAt: s.createdAt.toISOString(),
        bounty: bountyRef(s.bounty),
        validationStages: await buildValidationStages(s.id),
      }))
    );

    return reply.send({
      profile: {
        id: user.id,
        label: user.displayName ?? user.handle ?? user.id,
        status: user.status,
        rank: contributorRankForAcceptedItems(acceptedItems).name,
      },
      history,
    });
  });

  app.get("/internal/validator/:id", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [user, rank] = await Promise.all([
      prisma.user.findUnique({ where: { id }, select: { id: true, displayName: true, handle: true, status: true } }),
      prisma.rank.findUnique({ where: { userId: id }, select: { validatorRank: true, auditsCompleted: true } }),
    ]);
    if (!user) return reply.notFound("Validator not found");

    const flags = await prisma.flag.findMany({
      where: { validatorUserId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { submission: { include: { bounty: { include: { datasetType: true } } } } },
    });

    return reply.send({
      profile: {
        id: user.id,
        label: user.displayName ?? user.handle ?? user.id,
        status: user.status,
        rank: rank?.validatorRank ?? validatorRankForAudits(rank?.auditsCompleted ?? 0).name,
      },
      // Honest empty — see file header. No per-validator claimed-audit record
      // exists anywhere in this schema to read one back from.
      audits: [] as unknown[],
      flags: flags.map((f) => ({
        id: f.id,
        reason: f.reason,
        status: f.status,
        createdAt: f.createdAt.toISOString(),
        submission: { id: f.submission.id, title: f.submission.title, bounty: bountyRef(f.submission.bounty) },
      })),
    });
  });

  app.get("/internal/submission/:id", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const submission = await prisma.submission.findUnique({
      where: { id },
      include: {
        bounty: { include: { datasetType: true } },
        flags: { orderBy: { createdAt: "desc" } },
        artifacts: true,
      },
    });
    if (!submission) return reply.notFound("Submission not found");

    const [validationStages, disputes] = await Promise.all([
      buildValidationStages(submission.id),
      prisma.dispute.findMany({ where: { submissionId: submission.id }, orderBy: { createdAt: "desc" } }),
    ]);

    const validatorIds = Array.from(new Set(submission.flags.map((f) => f.validatorUserId).filter((v): v is string => !!v)));
    const validators = validatorIds.length
      ? await prisma.user.findMany({ where: { id: { in: validatorIds } }, select: { id: true, displayName: true, handle: true } })
      : [];
    const validatorLabel = new Map(validators.map((v) => [v.id, v.displayName ?? v.handle ?? v.id]));

    let rejection = null as null | {
      decidedBy: "validator" | "automated_check" | "unrecorded";
      decidedByLabel: string | null;
      reasonCode: string | null;
      reasonText: string | null;
      decidedAt: string | null;
    };
    if (submission.status === SubmissionStatus.rejected) {
      const decisiveFlag = submission.flags.find((f) => f.status === FlagStatus.confirmed) ?? submission.flags[0];
      if (decisiveFlag) {
        rejection = {
          decidedBy: "validator",
          decidedByLabel: decisiveFlag.validatorUserId ? (validatorLabel.get(decisiveFlag.validatorUserId) ?? null) : null,
          reasonCode: decisiveFlag.reason,
          reasonText: decisiveFlag.details,
          decidedAt: decisiveFlag.createdAt.toISOString(),
        };
      } else {
        const failing = findRejectingStage(validationStages);
        rejection = failing
          ? {
              decidedBy: "automated_check",
              decidedByLabel: null,
              reasonCode: null,
              reasonText: `Automated ${failing.stage.replaceAll("_", " ")} did not pass${formatStageScoreSuffix(failing)}.`,
              // The stage row that rejected the item IS the decision record —
              // same timestamp admin-submissions.ts reports for the identical
              // case. Sending null here made the two admin pages disagree
              // about when the same submission was decided. (Already an ISO
              // string — buildValidationStages serializes it.)
              decidedAt: failing.createdAt,
            }
          : { decidedBy: "unrecorded", decidedByLabel: null, reasonCode: null, reasonText: null, decidedAt: null };
      }
    }

    return reply.send({
      submission: {
        id: submission.id,
        title: submission.title,
        status: submission.status,
        createdAt: submission.createdAt.toISOString(),
        bounty: bountyRef(submission.bounty),
        validationStages,
        generationMethod: submission.generationMethod,
        revisionCount: submission.revisionCount,
        validationAttempt: submission.validationAttempt,
        duplicateScore: submission.duplicateScore,
        llmScore: submission.llmScore,
        contributor: {
          id: submission.contributorUserId,
          // Keep the companion detail view aligned with the list: this is an
          // immutable submission owner ID, not mutable profile presentation.
          label: submission.contributorUserId,
        },
        payload: submission.payloadJson,
        contract: parseContract(submission.bounty.datasetType),
        attachments: submission.artifacts.map((a) => ({
          id: a.id,
          filename: a.filename,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes != null ? Number(a.sizeBytes) : null,
          status: a.status,
          modality: a.modality,
          scanStatus: a.scanStatus,
          createdAt: a.createdAt.toISOString(),
        })),
        disputes: disputes.map((d) => ({
          id: d.id,
          flagReason: d.flagReason,
          contributorArgument: d.contributorArgument,
          validatorArgument: d.validatorArgument,
          status: d.status,
          resolution: d.resolution,
          createdAt: d.createdAt.toISOString(),
          resolvedAt: d.resolvedAt ? d.resolvedAt.toISOString() : null,
        })),
        flags: submission.flags.map((f) => ({
          id: f.id,
          reason: f.reason,
          details: f.details,
          status: f.status,
          createdAt: f.createdAt.toISOString(),
          validatorUserId: f.validatorUserId,
          validatorLabel: f.validatorUserId ? (validatorLabel.get(f.validatorUserId) ?? null) : null,
        })),
        // Honest empty — see file header.
        auditDecisions: [] as unknown[],
        rejection,
      },
    });
  });

  app.get("/internal/bounty/:id", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const bounty = await prisma.bounty.findUnique({ where: { id }, include: { datasetType: true } });
    if (!bounty) return reply.notFound("Bounty not found");

    const submissions = await prisma.submission.findMany({
      where: { bountyId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { contributor: { select: { id: true, displayName: true, handle: true } } },
    });

    const contract = parseContract(bounty.datasetType);
    const dedupeConfigured = contract?.pipeline.includes("dedupe") ?? false;
    const scored = submissions.filter((s) => s.duplicateScore != null);
    const scores = scored.map((s) => s.duplicateScore as number);

    const contributorCounts = new Map<string, { id: string; label: string; submissionCount: number }>();
    for (const s of submissions) {
      const label = s.contributor.displayName ?? s.contributor.handle ?? s.contributor.id;
      const existing = contributorCounts.get(s.contributor.id);
      if (existing) existing.submissionCount++;
      else contributorCounts.set(s.contributor.id, { id: s.contributor.id, label, submissionCount: 1 });
    }

    return reply.send({
      bounty: {
        id: bounty.id,
        title: bounty.title,
        kind: bounty.kind,
        status: bounty.status,
        datasetCategory: bounty.datasetCategory,
        datasetType: bounty.datasetType ? { id: bounty.datasetType.id, name: bounty.datasetType.name } : null,
        targetItems: Number(bounty.targetItems),
        acceptedItems: Number(bounty.acceptedItems),
        createdAt: bounty.createdAt.toISOString(),
      },
      // Measured over the whole bounty's stored duplicateScore values — never
      // fabricated. `dedupeConfigured: false` (this type's pipeline never
      // runs dedupe) is reported outright rather than showing a misleading
      // zero/100% variety figure.
      similarity: {
        dedupeConfigured,
        total: submissions.length,
        scored: scored.length,
        mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        max: scores.length ? Math.max(...scores) : null,
        nearDuplicates: scores.filter((s) => s >= 0.8).length,
        identical: scores.filter((s) => s >= 0.999).length,
      },
      submissions: submissions.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        createdAt: s.createdAt.toISOString(),
        duplicateScore: s.duplicateScore,
        llmScore: s.llmScore,
        // Dataset-upload rows are operational submission records. Keep their
        // contributor display stable and cross-referenceable after a profile
        // rename by using the immutable contributor ID.
        contributor: { id: s.contributor.id, label: s.contributor.id },
      })),
      contributors: Array.from(contributorCounts.values()).sort((a, b) => b.submissionCount - a.submissionCount),
    });
  });
}
