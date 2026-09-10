// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BountyKind, SubmissionStatus, FlagStatus, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_AND_ABOVE_READONLY } from "../../lib/rbac.js";
import { getCommunityQualityMetrics } from "../../services/admin-quality-metrics.js";
import { findRejectingStage, formatStageScoreSuffix } from "../../lib/validation-state.js";

/**
 * Admin validation-pipeline roster backing community/apps/admin's
 * /submissions page.
 *
 * `stats` come from the SHARED services/admin-quality-metrics.ts aggregation —
 * the same rolling-7-day, community-scoped, V1-ported definitions the admin
 * overview (routes/v1/admin.ts, GET /overview) reports, deliberately called
 * rather than reimplemented so the two admin surfaces cannot drift into
 * disagreeing about the same three numbers. There is no "admin-metrics
 * worker" snapshot table in this schema, so they are computed live and
 * `computedAt` is the query's own timestamp — an honest "as of right now".
 *
 * That freshness stamp is NOT a measured-ness signal, and this route used to
 * treat it as one: it zero-filled every rate when the window was empty
 * (`dupRows.length ? … : 0`) while still stamping `computedAt`, so the
 * console rendered a fabricated "0%" — reading as "every item is failing the
 * gate" — for a window in which nothing had been measured at all. It also
 * divided the execution pass rate by EVERY execution row, counting rows that
 * honestly recorded that nothing ran (`no_provider_configured`,
 * `no_executable_harness`, …) as failed executions. Both are fixed by the
 * shared function: each rate is `null` with an explicit
 * `measured | not_measured | not_configured` state, and the execution
 * denominator is restricted to rows where a sandbox actually returned a
 * verdict, with the excluded runs disclosed rather than hidden.
 *
 * `unconfiguredStages` reuses admin-execution-health's OUTCOME_HELD set —
 * the only place this schema records "a stage ran but had nothing configured
 * to check with" is ValidationResult.outcome on the execution stage.
 *
 * `rejection` distinguishes a validator's decision (Flag.validatorUserId
 * present) from an automated-pipeline rejection (no Flag row — validation.ts
 * flips status to rejected directly on duplicate_check failure) from a truly
 * unrecorded case (rejected status, no Flag, no failing ValidationResult to
 * point to) — matching profile-summary.ts's documented byHuman/bySystem
 * split for the same reason.
 */

const OUTCOME_HELD = new Set([
  "runtime_unavailable",
  "all_providers_failed",
  "no_provider_configured",
  "no_executable_harness",
  "not_attempted",
  "execution_held_for_review",
  "execution_unavailable",
  "execution_at_capacity",
  "execution_unverifiable",
]);

// (The metrics window itself now lives with the shared aggregation as
// QUALITY_METRICS_WINDOW_DAYS in services/admin-quality-metrics.ts — a local
// copy here is exactly how the two admin surfaces would drift apart again.)

const IN_FLIGHT_SUBMISSION_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.submitted,
  SubmissionStatus.duplicate_check,
  SubmissionStatus.running_tests,
  SubmissionStatus.tests_failed,
  SubmissionStatus.llm_validation,
  SubmissionStatus.needs_fixes,
  SubmissionStatus.provisionally_accepted,
  SubmissionStatus.in_audit,
  SubmissionStatus.in_sponsor_review,
  SubmissionStatus.flagged,
  SubmissionStatus.disputed,
  SubmissionStatus.accepted_pending_sample,
];

const listQuery = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  stage: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export async function adminSubmissionRoutes(app: FastifyInstance) {
  app.get("/submissions", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const take = parsed.data.limit ?? 25;
    const skip = parsed.data.skip ?? 0;
    const dateWhere: Prisma.DateTimeFilter | undefined =
      parsed.data.from || parsed.data.to
        ? { ...(parsed.data.from ? { gte: new Date(parsed.data.from) } : {}), ...(parsed.data.to ? { lt: new Date(parsed.data.to) } : {}) }
        : undefined;

    const stageFilter = parsed.data.stage ?? "pipeline";
    const statusWhere: Prisma.SubmissionWhereInput =
      stageFilter === "all"
        ? {}
        : stageFilter === "pipeline"
          ? { status: { in: IN_FLIGHT_SUBMISSION_STATUSES } }
          : { status: stageFilter as SubmissionStatus };

    const where: Prisma.SubmissionWhereInput = {
      AND: [
        // Explicit even though every Submission's parent Bounty is `community`
        // today (funded work is a wholly separate `enterprise` service/DB,
        // never a row here) — matches the discipline used everywhere else in
        // this codebase that queries Submission/Bounty (see services/bounties.ts,
        // admin-community.ts, admin.ts's /overview handler).
        { bounty: { kind: BountyKind.community } },
        statusWhere,
        ...(dateWhere ? [{ createdAt: dateWhere }] : []),
        ...(parsed.data.search ? [{ title: { contains: parsed.data.search, mode: "insensitive" as const } }] : []),
      ],
    };

    const [total, submissions, qualityMetrics] = await Promise.all([
      prisma.submission.count({ where }),
      prisma.submission.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: {
          bounty: { select: { title: true } },
          flags: { orderBy: { createdAt: "desc" } },
          validationResults: { orderBy: { createdAt: "desc" } },
        },
      }),
      // Same shared aggregation the admin overview uses — NOT a second copy of
      // the definitions. See the `stats` note in this file's header for why.
      getCommunityQualityMetrics(),
    ]);

    // Validator labels for rejection attribution — Flag.validatorUserId has
    // no Prisma relation to User (raw FK column), so a second lookup is
    // required, same as admin.ts's dispute-evidence path.
    const validatorIds = Array.from(
      new Set(submissions.flatMap((s) => s.flags.map((f) => f.validatorUserId).filter((id): id is string => !!id)))
    );
    const validators = validatorIds.length
      ? await prisma.user.findMany({ where: { id: { in: validatorIds } }, select: { id: true, displayName: true, handle: true } })
      : [];
    const validatorLabel = new Map(validators.map((v) => [v.id, v.displayName ?? v.handle ?? v.id]));

    const rows = submissions.map((s) => {
      const latestByStage = new Map<string, (typeof s.validationResults)[number]>();
      for (const r of s.validationResults) {
        if (!latestByStage.has(r.stage)) latestByStage.set(r.stage, r);
      }
      const unconfiguredStages = Array.from(latestByStage.values())
        .filter((r) => r.stage === "execution" && r.outcome && OUTCOME_HELD.has(r.outcome))
        .map((r) => r.stage);

      const validationStages = Array.from(latestByStage.values()).map((r) => ({
        stage: r.stage,
        passed: r.passed,
        score: r.score,
        status: r.outcome,
        // See lib/validation-state.ts: `ai_attribution` and a passing `dedupe`
        // carry NO `outcome` column, so `detailJson` is the only way a
        // consumer can tell a flagged attribution from a terminal failure.
        // `reason` used to be sent here as a hardcoded `null`, which left a
        // dead per-stage "reason" block in the admin console that could never
        // render — removed on both sides rather than left as a false promise.
        detailJson: r.detailJson,
        createdAt: r.createdAt.toISOString(),
      }));

      let rejection = null as null | {
        decidedBy: "validator" | "automated_check" | "unrecorded";
        decidedByLabel: string | null;
        reasonCode: string | null;
        reasonText: string | null;
        decidedAt: string | null;
      };

      if (s.status === SubmissionStatus.rejected) {
        const decisiveFlag = s.flags.find((f) => f.status === FlagStatus.confirmed) ?? s.flags[0];
        if (decisiveFlag) {
          rejection = {
            decidedBy: "validator",
            decidedByLabel: decisiveFlag.validatorUserId ? (validatorLabel.get(decisiveFlag.validatorUserId) ?? null) : null,
            reasonCode: decisiveFlag.reason,
            reasonText: decisiveFlag.details,
            decidedAt: decisiveFlag.createdAt.toISOString(),
          };
        } else {
          const failingResult = findRejectingStage(Array.from(latestByStage.values()));
          if (failingResult) {
            rejection = {
              decidedBy: "automated_check",
              decidedByLabel: null,
              reasonCode: null,
              reasonText: `Automated ${failingResult.stage.replaceAll("_", " ")} did not pass${formatStageScoreSuffix(failingResult)}.`,
              decidedAt: failingResult.createdAt.toISOString(),
            };
          } else {
            rejection = { decidedBy: "unrecorded", decidedByLabel: null, reasonCode: null, reasonText: null, decidedAt: null };
          }
        }
      }

      return {
        id: s.id,
        title: s.title,
        bountyTitle: s.bounty.title,
        // Admin submission records are identified by their immutable owner ID.
        // Do not substitute a mutable display name or handle in this operational
        // queue: it makes the record harder to cross-reference and can mislead
        // an admin after a profile rename.
        contributor: s.contributorUserId,
        stage: s.status,
        generationMethod: s.generationMethod,
        createdAt: s.createdAt.toISOString(),
        unconfiguredStages,
        validationStages,
        rejection,
      };
    });

    return reply.send({
      total,
      stats: {
        // `number | null` — null means the metric had no denominator. Never
        // zero-filled: a fabricated "0%" reads as "every item is failing the
        // gate", the opposite of "nothing has been measured".
        duplicateRate: qualityMetrics.duplicate.rate,
        llmPassRate: qualityMetrics.llm.rate,
        executionPassRate: qualityMetrics.execution.rate,
        // Freshness caption only. These are computed live per request, so this
        // is always present and is NOT the measured-vs-unmeasured test — the
        // per-metric `state` below is.
        computedAt: qualityMetrics.computedAt.toISOString(),
        qualityMetrics: {
          windowDays: qualityMetrics.windowDays,
          duplicate: qualityMetrics.duplicate,
          llm: qualityMetrics.llm,
          execution: qualityMetrics.execution,
        },
      },
      submissions: rows,
    });
  });
}
