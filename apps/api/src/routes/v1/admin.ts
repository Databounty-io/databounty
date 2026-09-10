// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_ONLY, ADMIN_AND_MEMBER, ADMIN_AND_ABOVE_READONLY, type AuthedUser } from "../../lib/rbac.js";
import { listAdminSettingsForApi, setAdminSetting, getAdminSettingHistory, validateAdminSettingValue } from "../../services/admin-settings.js";
import { adminListApiKeys, adminRevokeApiKey, adminCountActiveApiKeys } from "../../services/api-keys.js";
import { createAdminInvite } from "../../lib/admin-invite.js";
import { sendAdminInviteEmail } from "../../lib/auth-notify.js";
import { writeAuditLog, verifyAuditChainIntegrity } from "../../lib/audit-log.js";
import { grantBadge, revokeBadge } from "../../services/badges.js";
import { reverseAcceptedSubmissionKarma } from "../../services/karma.js";
import { awardOrHoldAcceptedItemKarma } from "../../services/karma-holds.js";
import { createWindowAuditBatch, reopenAuditItemForReview } from "../../services/audit-routing.js";
import { notifyEvent, subscribeAdminNotificationStream } from "../../services/notifications.js";
import { getCommunityQualityMetrics } from "../../services/admin-quality-metrics.js";
import { recomputeAcceptedItemCounters } from "../../services/submission-acceptance.js";
import { revokeLiveUploadReviewDraftCapabilities } from "../../services/upload-review-drafts.js";
import { config } from "../../config.js";
import {
  BountyKind,
  CommunityPublicationStatus,
  ContributorBatchStatus,
  DatasetCategory,
  DatasetTypeOrigin,
  DatasetTypeStatus,
  DisputeStatus,
  DomainId,
  FlagStatus,
  KarmaEventType,
  Prisma,
  PublicationTarget,
  Role,
  SubmissionStatus,
  TrustTier,
  UserStatus,
} from "@prisma/client";

// The 7 canonical, still-in-progress submission statuses the admin overview's
// pipeline widget (community/apps/admin/app/(dashboard)/page.tsx, PIPELINE_STYLE)
// is designed to visualize. `draft` (not submitted yet) and the terminal
// states (accepted, accepted_pending_sample, rejected) are intentionally
// excluded — the widget shows work still moving through automated checks.
const PIPELINE_STATUSES: SubmissionStatus[] = [
  SubmissionStatus.submitted,
  SubmissionStatus.duplicate_check,
  SubmissionStatus.running_tests,
  SubmissionStatus.llm_validation,
  SubmissionStatus.needs_fixes,
  SubmissionStatus.provisionally_accepted,
  SubmissionStatus.in_audit,
];

// Broader "still active" set used for the standalone "submissions pending"
// stat: everything that has been submitted but hasn't reached a terminal
// outcome yet (terminal = accepted / accepted_pending_sample / rejected;
// accepted_pending_sample is excluded too because it already cleared every
// automated stage and is just waiting on pool close-out, not "pending
// validation"). `draft` is excluded because it was never submitted.
const ACTIVE_NON_TERMINAL_STATUSES: SubmissionStatus[] = [
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
];

// POST /users/:id/restrict — the admin console only ever sends the two real
// `UserStatus` members. Validated here (previously an unchecked cast) so an
// unknown value is a 400, not a Prisma enum failure inside the transaction.
const restrictUserBody = z.object({
  status: z.nativeEnum(UserStatus),
  reason: z.string().optional(),
});

const createInviteBody = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  role: z.enum(["admin", "member", "support"]),
});

// Both admin console callers (community/apps/admin's disputes list page and
// its details page) send `{ decision: "uphold_flag" | "overturn_flag" }` —
// "uphold_flag" means the validator's flag was right (dispute dismissed,
// submission stays rejected); "overturn_flag" means the contributor's
// dispute wins (submission accepted, karma awarded). This maps that wire
// contract onto the internal upheld/dismissed vocabulary used below and
// stored on the row.
const resolveDisputeBody = z.object({
  decision: z.enum(["uphold_flag", "overturn_flag"]),
  resolution: z.string().trim().min(5).max(2000),
});
const RESOLVE_DECISION_MAP: Record<"uphold_flag" | "overturn_flag", "dismissed" | "upheld"> = {
  uphold_flag: "dismissed",
  overturn_flag: "upheld",
};

// The admin console's details page (community/apps/admin/app/(dashboard)/details/page.tsx,
// setBountyStatus) sends `{ action: "pause" | "resume", reason }` — it only
// ever offers those two actions (pause an active-ish pool, resume a paused
// one back to active) — not a raw BountyStatus value.
const bountyStatusBody = z.object({
  action: z.enum(["pause", "resume"]),
  reason: z.string().optional(),
});
const BOUNTY_ACTION_STATUS: Record<"pause" | "resume", "paused" | "active"> = {
  pause: "paused",
  resume: "active",
};

export async function adminRoutes(app: FastifyInstance) {
  // Overview metrics
  //
  // Flat response shape — the admin dashboard root
  // (community/apps/admin/app/(dashboard)/page.tsx, `Overview` interface)
  // reads every field off the top level of this object, not nested under
  // `stats`. Every value below is a genuine Prisma query/aggregate; fields
  // with no real backing data yet return an honest 0/null with a comment
  // explaining why, rather than a fabricated number.
  app.get("/overview", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const now = new Date();

    // Optional date range for the console's filter bar. The console sends full
    // ISO instants (components/admin-filter-bar.tsx `resolveDateRange` already
    // converts inclusive local calendar days into UTC bounds), so no
    // end-of-day fudging belongs here.
    //
    // The range deliberately does NOT apply to every number below. Most of
    // this endpoint is either an all-time total (totalUsers, totalKarma) or a
    // point-in-time state snapshot (pipeline, auditBatchesPending,
    // overdueContributorBatches) — neither of which has a meaningful "between
    // two dates" reading. Silently applying a filter to some cards and not
    // others would make the filtered ones indistinguishable from the ignored
    // ones, so range-scoped counts are returned in their own `range` block and
    // the console labels the rest as unfiltered. Nothing that already existed
    // changes shape or meaning, so callers that send no range are unaffected.
    const rangeQuery = req.query as { from?: string; to?: string };
    const parseBound = (raw: string | undefined, label: string): Date | null => {
      if (raw === undefined || raw === "") return null;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw app.httpErrors.badRequest(`Invalid \`${label}\` date: ${raw}`);
      }
      return parsed;
    };
    const rangeFrom = parseBound(rangeQuery.from, "from");
    const rangeTo = parseBound(rangeQuery.to, "to");
    if (rangeFrom && rangeTo && rangeFrom > rangeTo) {
      throw app.httpErrors.badRequest("`from` must not be after `to`.");
    }
    const rangeActive = rangeFrom !== null || rangeTo !== null;
    const createdInRange = {
      ...(rangeFrom ? { gte: rangeFrom } : {}),
      ...(rangeTo ? { lte: rangeTo } : {}),
    };
    const cutoff7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      newUsers7d,
      newUsers30d,
      totalDatasets,
      newDatasets7d,
      newDatasets30d,
      totalKarmaAgg,
      newKarma7dAgg,
      newKarma30dAgg,
      totalSubmissions,
      acceptedSubmissions,
      publishedDatasets,
      typesInReview,
      pipelineGroups,
      activeContributorGroups,
      submissionsPendingValidation,
      auditBatchesPending,
      overdueContributorBatches,
      qualityMetrics,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: cutoff7d } } }),
      prisma.user.count({ where: { createdAt: { gte: cutoff30d } } }),
      // `kind: BountyKind.community` is explicit here even though the enum
      // has exactly one member today (funded/paid work lives entirely in the
      // separate `enterprise` service, bridged only by a signed cross-service
      // identity protocol — it is never a second row in this table). Every
      // other Bounty/Submission aggregate in this codebase already states
      // this scope explicitly (see services/bounties.ts, admin-community.ts);
      // leaving it off here would make these three counts "correct by
      // accident" rather than correct by construction, and silently wrong the
      // moment BountyKind ever grows a second member.
      prisma.bounty.count({ where: { kind: BountyKind.community } }),
      prisma.bounty.count({ where: { kind: BountyKind.community, createdAt: { gte: cutoff7d } } }),
      prisma.bounty.count({ where: { kind: BountyKind.community, createdAt: { gte: cutoff30d } } }),
      prisma.karmaEvent.aggregate({ _sum: { amount: true } }),
      prisma.karmaEvent.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: cutoff7d } } }),
      prisma.karmaEvent.aggregate({ _sum: { amount: true }, where: { createdAt: { gte: cutoff30d } } }),
      // Submission has no `kind` column of its own — the discriminator lives
      // on its parent Bounty, so the same explicit scope is expressed via the
      // `bounty` relation filter, matching services/bounties.ts's
      // `submission.groupBy({ where: { bounty: { kind: BountyKind.community } } } })`.
      prisma.submission.count({ where: { bounty: { kind: BountyKind.community } } }),
      prisma.submission.count({ where: { bounty: { kind: BountyKind.community }, status: SubmissionStatus.accepted } }),
      prisma.datasetPublication.count({ where: { target: PublicationTarget.huggingface, status: CommunityPublicationStatus.published } }),
      prisma.datasetType.count({ where: { status: DatasetTypeStatus.platform_review } }),
      prisma.submission.groupBy({
        by: ["status"],
        where: { bounty: { kind: BountyKind.community }, status: { in: PIPELINE_STATUSES } },
        _count: { _all: true },
      }),
      // Distinct contributors with an in-flight submission. There is no
      // "claim" step in the open-pool model (a pool has no per-contributor
      // reservation), so "active contributors" is approximated as contributors
      // who currently have at least one non-terminal submission.
      prisma.submission.groupBy({
        by: ["contributorUserId"],
        where: { bounty: { kind: BountyKind.community }, status: { in: ACTIVE_NON_TERMINAL_STATUSES } },
      }),
      prisma.submission.count({ where: { bounty: { kind: BountyKind.community }, status: { in: ACTIVE_NON_TERMINAL_STATUSES } } }),
      // "Pending" audit batch = a HumanAuditWindow that hasn't been settled
      // yet (mirrors listAvailableAudits in services/audits.ts) and hasn't
      // been superseded (a superseded window no longer governs routing).
      prisma.humanAuditWindow.count({ where: { settledAt: null, supersededAt: null } }),
      // "Stalled pool" = a ContributorBatch still open for claims whose
      // deadline has already passed; it hasn't reached its item target and is
      // waiting on the next sweep to close it out.
      prisma.contributorBatch.count({ where: { status: ContributorBatchStatus.available, deadline: { lt: now } } }),
      // Rolling-7-day duplicate / llm / execution rates, ported definition for
      // definition from V1's services/admin-metrics.ts (community scope) —
      // see services/admin-quality-metrics.ts for the exact numerator and
      // denominator of each, and for the two honesty departures from V1.
      getCommunityQualityMetrics(now),
    ]);

    const pipeline = pipelineGroups.map((row) => ({ stage: row.status, count: row._count._all }));

    // Range-scoped activity counts. Only metrics that are genuinely "things
    // that happened between two dates" appear here; a second round-trip is
    // deliberate — it runs only when a range is actually set, so the unfiltered
    // dashboard pays nothing for it.
    const range = rangeActive
      ? await (async () => {
          const [newUsers, newDatasets, karmaAgg, submissions, acceptedSubmissions, publishedDatasets] = await Promise.all([
            prisma.user.count({ where: { createdAt: createdInRange } }),
            prisma.bounty.count({ where: { kind: BountyKind.community, createdAt: createdInRange } }),
            prisma.karmaEvent.aggregate({ _sum: { amount: true }, where: { createdAt: createdInRange } }),
            prisma.submission.count({ where: { bounty: { kind: BountyKind.community }, createdAt: createdInRange } }),
            // Submitted in range AND accepted as of now. Submission has no
            // accepted-at column, so this cannot be "accepted in range" —
            // naming it `acceptedOfSubmittedInRange` keeps the console from
            // captioning it as the acceptance date it isn't.
            prisma.submission.count({
              where: { bounty: { kind: BountyKind.community }, createdAt: createdInRange, status: SubmissionStatus.accepted },
            }),
            // `pushedAt` is the real completion timestamp for a publication
            // ("when this target last completed successfully"); rows published
            // before that column was populated have it null and are therefore
            // absent from a ranged count rather than silently dated by
            // createdAt, which is when the row was queued, not published.
            prisma.datasetPublication.count({
              where: {
                target: PublicationTarget.huggingface,
                status: CommunityPublicationStatus.published,
                pushedAt: createdInRange,
              },
            }),
          ]);
          return {
            from: rangeFrom ? rangeFrom.toISOString() : null,
            to: rangeTo ? rangeTo.toISOString() : null,
            newUsers,
            newDatasets,
            newKarma: karmaAgg._sum.amount ?? 0,
            submissions,
            acceptedOfSubmittedInRange: acceptedSubmissions,
            publishedDatasets,
          };
        })()
      : null;

    return reply.send({
      // Range-scoped activity, or null when no range is set. Everything
      // else on this response is all-time or point-in-time by definition and
      // is NOT affected by `from`/`to` — see the note on the handler.
      range,
      // Growth
      totalUsers,
      newUsers7d,
      newUsers30d,
      totalDatasets,
      newDatasets7d,
      newDatasets30d,
      // Platform totals (karma is net: awards minus reversals, same as the
      // reverseAcceptedSubmissionKarma path that writes a negative amount).
      totalKarma: totalKarmaAgg._sum.amount ?? 0,
      newKarma7d: newKarma7dAgg._sum.amount ?? 0,
      newKarma30d: newKarma30dAgg._sum.amount ?? 0,
      totalSubmissions,
      acceptedSubmissions,
      publishedDatasets,
      typesInReview,
      tasksClaimed: activeContributorGroups.length,
      submissionsPendingValidation,
      auditBatchesPending,
      // No deadline/SLA field exists on HumanAuditWindow (or anywhere in the
      // schema) for "how long is too long" — unlike ContributorBatch, which
      // has a real `deadline` column. Rather than invent a threshold, this
      // stays an honest 0 until an admin-configurable audit-window SLA is
      // added.
      overdueAuditBatches: 0,
      overdueContributorBatches,
      pipeline,
      // The schema has no dedicated "AI attribution hold" tracking. The
      // closest concept, Submission.pendingHumanReview, is a single flag that
      // conflates several different forced-escalation reasons (near-dup
      // review, execution pending, AI-attribution flag, LLM
      // uncertain — see the field's doc comment in schema.prisma). Isolating
      // "held specifically for AI attribution" from that flag would be a
      // guess, not a measurement, so this stays an honest 0 until attribution
      // holds get their own queryable state.
      aiAttributionHolds: 0,
      // duplicateRate/llmPassRate/executionPassRate — REAL aggregates over
      // stored validation evidence, rolling 7 days, community-scoped, ported
      // from V1's services/admin-metrics.ts (see
      // services/admin-quality-metrics.ts for the ported definitions).
      //
      // These were previously pinned to a placeholder 0 on the claim that
      // "the execution and llm stages in services/validation.ts are still
      // hardcoded stubs (always passed: true)". That claim is stale and the
      // comment has been removed: services/validation.ts stage 3 runs real
      // sandbox providers via runExecution (services/execution.ts, E2B) and
      // records what actually happened in `ValidationResult.outcome` /
      // `.isolationVerified`, and stage 4 calls OpenRouter through
      // reviewSubmissionWithLlm when configured. Neither fabricates a pass:
      // both write explicit non-verdict states instead
      // (`no_provider_configured`, `no_executable_harness`,
      // `provider_error`, `runtime_unavailable`, ...). Real evidence exists,
      // so reporting a permanent 0% was itself the dishonest reading.
      //
      // Each rate is `number | null`: null means the denominator was empty,
      // never a measured zero. `qualityMetrics` carries the per-metric state
      // (measured / not_measured / not_configured), the sample size, and the
      // excluded no-verdict runs, so the console can render "not configured"
      // and "not measured" distinctly from a real "0%". A stage that did not
      // run is never counted as a pass: `executionPassRate`'s denominator is
      // restricted to rows where a sandbox actually returned a verdict.
      duplicateRate: qualityMetrics.duplicate.rate,
      llmPassRate: qualityMetrics.llm.rate,
      executionPassRate: qualityMetrics.execution.rate,
      // Computed live per request (this schema has no AdminMetricsSnapshot
      // table), so this is an honest "as of now" and is always present — the
      // per-metric `state` below, not this timestamp, is what distinguishes
      // measured from unmeasured.
      qualityMetricsComputedAt: qualityMetrics.computedAt.toISOString(),
      qualityMetrics: {
        windowDays: qualityMetrics.windowDays,
        duplicate: qualityMetrics.duplicate,
        llm: qualityMetrics.llm,
        execution: qualityMetrics.execution,
      },
    });
  });

  // Settings
  app.get("/settings", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (_req, reply) => {
    const { settings, catalog } = await listAdminSettingsForApi();
    return reply.send({ settings, catalog });
  });

  app.put("/settings/:key", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { key } = req.params as { key: string };
    const body = req.body as { value: unknown } | null | undefined;
    if (!body || typeof body !== "object" || !("value" in body)) {
      return reply.badRequest("Body must be an object with a `value` property.");
    }

    // Validate BEFORE writing. Previously this route upserted whatever it was
    // handed under whatever key was in the path — no catalog-membership check
    // and no per-key schema — so a typo'd key created a permanent row nothing
    // reads, and an out-of-range value was accepted by the console and then
    // silently discarded by whichever reader clamps it. Both now fail with a
    // 400 that says why, and nothing is persisted or audit-logged.
    const validated = validateAdminSettingValue(key, body.value);
    if (!validated.ok) return reply.badRequest(validated.message);

    const result = await setAdminSetting({
      key,
      value: validated.value,
      updatedByUserId: user.id,
      context: { ip: req.ip, userAgent: req.headers["user-agent"] },
    });

    return reply.send(result);
  });

  // Wire shape matches SettingsHistorySection's `body.history` read (the
  // console's SettingsHistoryEntry also expects `changedBy` as a resolved
  // {id, email, displayName} object, not the raw user-id string stored on
  // the row) — getAdminSettingHistory itself is left untouched (it may have
  // other callers), this route just adapts its output at the boundary.
  app.get("/settings-history", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const query = req.query as { key?: string; limit?: string; offset?: string };
    const { items, total, limit, offset } = await getAdminSettingHistory({
      key: query.key,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });

    const changedByIds = Array.from(
      new Set(items.map((row) => row.changedBy).filter((id): id is string => !!id))
    );
    const changedByUsers = changedByIds.length
      ? await prisma.user.findMany({
          where: { id: { in: changedByIds } },
          select: { id: true, email: true, displayName: true },
        })
      : [];
    const changedByMap = new Map(changedByUsers.map((u) => [u.id, u]));

    const history = items.map((row) => ({
      id: row.id,
      key: row.key,
      action: row.action,
      oldValue: row.oldValue,
      newValue: row.newValue,
      changedBy: row.changedBy ? (changedByMap.get(row.changedBy) ?? { id: row.changedBy, email: null, displayName: null }) : null,
      createdAt: row.createdAt,
    }));

    return reply.send({ history, total, limit, offset });
  });

  // Audit logs
  app.get("/audit-logs", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const query = req.query as { limit?: string; offset?: string; action?: string; targetType?: string };
    const take = Math.min(query.limit ? Number(query.limit) : 50, 100);
    const skip = query.offset ? Number(query.offset) : 0;

    const where: Prisma.AdminAuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
    };

    const [logs, total, integrity] = await Promise.all([
      prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.adminAuditLog.count({ where }),
      verifyAuditChainIntegrity(),
    ]);

    return reply.send({ logs, total, limit: take, offset: skip, integrity });
  });

  // Users Roster
  //
  // Response shape matches the admin console's `/users` page (AdminUser +
  // UsersSummary interfaces): each row carries a real `activity` sub-object
  // (sponsoredBounties/openDatasetRequests/submissions/acceptedSubmissions/
  // audits/distinctDatasetsContributed) computed from actual work records —
  // sponsor/contributor/validator are not granted roles in this schema (see
  // the Role enum's deprecation comments), they are counted, not stored.
  // `summary` is a second, unfiltered-by-pagination set of platform-wide
  // tallies the page renders as stat tiles above the table.
  app.get("/users", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const query = req.query as {
      search?: string;
      limit?: string;
      offset?: string;
      skip?: string;
      role?: string;
      status?: string;
      activity?: string;
      sort?: string;
      from?: string;
      to?: string;
    };
    const take = Math.min(query.limit ? Number(query.limit) : 50, 100);
    // The console's filter bar sends `skip`; `offset` stays supported for any
    // other caller (MCP/scripts) that used the original param name.
    const skip = query.skip ? Number(query.skip) : query.offset ? Number(query.offset) : 0;

    const andClauses: Prisma.UserWhereInput[] = [];

    if (query.search) {
      andClauses.push({
        OR: [
          { email: { contains: query.search, mode: "insensitive" } },
          { displayName: { contains: query.search, mode: "insensitive" } },
          { handle: { contains: query.search, mode: "insensitive" } },
        ],
      });
    }

    // UserStatus only has active/suspended in the schema — "closed" is a
    // console-side filter option with no matching account state today, so it
    // deliberately matches nothing rather than silently falling back to "all".
    if (query.status && query.status !== "all") {
      andClauses.push({ status: query.status as "active" | "suspended" | "closed" as any });
    }

    if (query.role && query.role !== "all") {
      if (query.role === "any") andClauses.push({ roles: { some: {} } });
      else if (query.role === "none") andClauses.push({ roles: { none: {} } });
      else andClauses.push({ roles: { some: { role: query.role as Role } } });
    }

    if (query.activity && query.activity !== "all") {
      const sponsorClause: Prisma.UserWhereInput = { OR: [{ bounties: { some: {} } }, { datasetRequests: { some: {} } }] };
      const contributorClause: Prisma.UserWhereInput = { submissions: { some: {} } };
      const validatorClause: Prisma.UserWhereInput = {
        karmaEvents: { some: { eventType: KarmaEventType.community_audit_completed } },
      };
      if (query.activity === "sponsor") andClauses.push(sponsorClause);
      else if (query.activity === "contributor") andClauses.push(contributorClause);
      else if (query.activity === "validator") andClauses.push(validatorClause);
      else if (query.activity === "none") {
        andClauses.push({
          NOT: [
            { bounties: { some: {} } },
            { datasetRequests: { some: {} } },
            { submissions: { some: {} } },
            { karmaEvents: { some: { eventType: KarmaEventType.community_audit_completed } } },
          ],
        });
      }
    }

    if (query.from || query.to) {
      andClauses.push({
        createdAt: {
          ...(query.from ? { gte: new Date(query.from) } : {}),
          ...(query.to ? { lte: new Date(query.to) } : {}),
        },
      });
    }

    const where: Prisma.UserWhereInput = andClauses.length ? { AND: andClauses } : {};

    const orderBy: Prisma.UserOrderByWithRelationInput =
      query.sort === "oldest"
        ? { createdAt: "asc" }
        : query.sort === "active"
          ? { lastSeenAt: "desc" }
          : query.sort === "karma"
            ? { karmaTotal: "desc" }
            : { createdAt: "desc" };

    const [users, total, allTimeTotal, admins, members, support, emailVerified, onboarded] =
      await Promise.all([
        prisma.user.findMany({ where, include: { roles: true }, orderBy, take, skip }),
        prisma.user.count({ where }),
        // Everything below is deliberately unfiltered (the summary tiles read
        // "all time · filters do not apply") except `matching`, which reuses
        // the same `total` computed above.
        prisma.user.count(),
        prisma.userRole.count({ where: { role: Role.admin } }),
        prisma.userRole.count({ where: { role: Role.member } }),
        prisma.userRole.count({ where: { role: Role.support } }),
        prisma.user.count({ where: { emailVerifiedAt: { not: null } } }),
        prisma.user.count({ where: { onboarded: true } }),
        // The three platform-wide "have sponsored / contributed / validated"
        // counts that used to live here were removed with the console tiles
        // that rendered them. Each was a correlated EXISTS subquery over
        // bounties / submissions / karmaEvents run on every page load, so
        // leaving them would have been three of the most expensive queries on
        // this endpoint computing a value nothing displays. The per-user
        // activity figures the roster actually shows are the `groupBy`
        // aggregates below, which are scoped to the current page of users.
      ]);

    const userIds = users.map((u) => u.id);

    const [sponsoredBountyGroups, openRequestGroups, submissionGroups, acceptedGroups, auditGroups, distinctDatasetRows] =
      userIds.length
        ? await Promise.all([
            prisma.bounty.groupBy({
              by: ["requesterUserId"],
              where: { requesterUserId: { in: userIds }, kind: BountyKind.community },
              _count: { _all: true },
            }),
            // "Not yet minted into a bounty" — an implemented request becomes
            // its bounty and is counted there instead (see comment on the
            // console's UserActivity.openDatasetRequests field).
            prisma.datasetRequest.groupBy({
              by: ["requesterUserId"],
              where: { requesterUserId: { in: userIds }, mintedBountyId: null },
              _count: { _all: true },
            }),
            prisma.submission.groupBy({
              by: ["contributorUserId"],
              where: { contributorUserId: { in: userIds }, bounty: { kind: BountyKind.community } },
              _count: { _all: true },
            }),
            prisma.submission.groupBy({
              by: ["contributorUserId"],
              where: { contributorUserId: { in: userIds }, bounty: { kind: BountyKind.community }, status: SubmissionStatus.accepted },
              _count: { _all: true },
            }),
            // One `community_audit_completed` KarmaEvent per validator per
            // settled HumanAuditWindow (services/audits.ts, submitAuditDecisions)
            // — the row is unique on (userId, eventType, sourceType, sourceId),
            // so a plain count is already a distinct-window count.
            prisma.karmaEvent.groupBy({
              by: ["userId"],
              where: { userId: { in: userIds }, eventType: KarmaEventType.community_audit_completed },
              _count: { _all: true },
            }),
            prisma.submission.findMany({
              where: { contributorUserId: { in: userIds }, bounty: { kind: BountyKind.community } },
              select: { contributorUserId: true, bountyId: true },
              distinct: ["contributorUserId", "bountyId"],
            }),
          ])
        : [[], [], [], [], [], []];

    const toMap = (rows: Array<{ _count: { _all: number } } & Record<string, unknown>>, key: string) =>
      new Map(rows.map((r) => [r[key] as string, r._count._all]));

    const sponsoredMap = toMap(sponsoredBountyGroups as any, "requesterUserId");
    const openRequestMap = toMap(openRequestGroups as any, "requesterUserId");
    const submissionMap = toMap(submissionGroups as any, "contributorUserId");
    const acceptedMap = toMap(acceptedGroups as any, "contributorUserId");
    const auditMap = toMap(auditGroups as any, "userId");
    const distinctDatasetMap = new Map<string, number>();
    for (const row of distinctDatasetRows as Array<{ contributorUserId: string }>) {
      distinctDatasetMap.set(row.contributorUserId, (distinctDatasetMap.get(row.contributorUserId) ?? 0) + 1);
    }

    return reply.send({
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        handle: u.handle,
        authMethod: u.authMethod,
        status: u.status,
        onboarded: u.onboarded,
        emailVerified: !!u.emailVerifiedAt,
        createdAt: u.createdAt,
        lastSeenAt: u.lastSeenAt,
        karmaTotal: u.karmaTotal,
        persona: u.persona,
        roles: u.roles.map((r) => r.role),
        activity: {
          sponsoredBounties: sponsoredMap.get(u.id) ?? 0,
          openDatasetRequests: openRequestMap.get(u.id) ?? 0,
          submissions: submissionMap.get(u.id) ?? 0,
          acceptedSubmissions: acceptedMap.get(u.id) ?? 0,
          audits: auditMap.get(u.id) ?? 0,
          distinctDatasetsContributed: distinctDatasetMap.get(u.id) ?? 0,
        },
      })),
      total,
      limit: take,
      offset: skip,
      summary: {
        matching: total,
        allTimeTotal,
        admins: { admin: admins, member: members, support, total: admins + members + support },
        emailVerified,
        onboarded,
      },
    });
  });

  // Suspend / Activate User
  app.post("/users/:id/restrict", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = restrictUserBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const body = parsed.data;

    const { updated, revokedUploadDrafts } = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id },
        data: { status: body.status },
      });

      // SEC-09 follow-up: the upload-review-draft capability tokens
      // (routes/v1/upload-review-drafts.ts — the one-time handoff `tokenHash`
      // and the longer-lived `accessTokenHash`) are minted while the owner is
      // eligible and would otherwise stay redeemable for their whole TTL. The
      // drafts route already refuses a non-active owner on every action; this
      // defines the outstanding capabilities as REVOKED at the moment of
      // suspension so a later re-activation cannot resurrect them. Same
      // transaction as the status change, so there is no window in which the
      // user is suspended but a token still resolves. The draft rows and their
      // uploaded data are NOT cancelled or deleted — only the capability dies:
      // `revokedAt` is what `resolveDraftAccess`/redeem filter on, and
      // `accessTokenHash` is cleared the way cancel/submit already do so a
      // leaked value can never be replayed. Only still-live drafts are touched;
      // cancelled/submitted ones already burned their capability themselves.
      //
      // Re-activation deliberately does NOT un-revoke: a re-activated user gets
      // fresh capabilities through the normal mint path (POST /upload-review-drafts).
      const revokedUploadDrafts =
        body.status === UserStatus.active ? 0 : await revokeLiveUploadReviewDraftCapabilities(tx, id);

      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: body.status === UserStatus.suspended ? "admin.user.suspended" : "admin.user.activated",
        targetType: "user",
        targetId: id,
        metadata: { reason: body.reason, revokedUploadDrafts },
        ip: req.ip,
      });
      return { updated: u, revokedUploadDrafts };
    });

    // Never echo the raw Prisma row: it carries `passwordHash`, `googleId` and
    // other internals. QA on 2026-09-05 found this route returning the bcrypt
    // hash to the admin caller (P1). Project only what the console needs.
    return reply.send({
      ok: true,
      user: {
        id: updated.id,
        email: updated.email,
        handle: updated.handle,
        displayName: updated.displayName,
        status: updated.status,
      },
      revokedUploadDrafts,
    });
  });

  // Admin Invites
  app.get("/invites", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (_req, reply) => {
    const invites = await prisma.adminInvite.findMany({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      include: { invitedBy: { select: { id: true, displayName: true, handle: true } } },
    });
    // The admin console's InvitesSection reads `inv.invitedBy.displayName` —
    // a raw `invitedById` string previously left that undefined and crashed
    // the whole /settings page (not just this section) on render the moment
    // any invite existed. `tokenHash` is dropped too: it's an
    // invite-acceptance secret's hash, and this list view has no reason to
    // ship it to the browser at all.
    return reply.send({
      invites: invites.map(({ tokenHash: _tokenHash, ...inv }) => inv),
    });
  });

  app.post("/invites", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = createInviteBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const token = await createAdminInvite(
      parsed.data.email,
      parsed.data.role as any,
      user.id,
      { ip: req.ip, userAgent: req.headers["user-agent"] }
    );

    void sendAdminInviteEmail(parsed.data.email, token, parsed.data.role as any, user.displayName).catch((err) => {
      // Fire-and-forget on purpose: the request must not fail, and must not
      // reveal whether an address exists. But an EMPTY catch here hid a broken
      // mailer completely — the user simply never received the admin invite mail and
      // nothing anywhere recorded it. Log, do not rethrow.
      console.error(`[mail] admin invite email failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return reply.status(201).send({ ok: true, email: parsed.data.email });
  });

  // DELETE /invites/:id — the settings page's "Revoke" button on a pending
  // invite row had no backend route at all (404 on every click); this closes
  // that gap the same way user/contributor/validator restriction does: flip
  // a status field, write the audit log, done.
  app.delete("/invites/:id", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };

    const existing = await prisma.adminInvite.findUnique({ where: { id } });
    if (!existing) return reply.notFound("Invite not found");
    if (existing.revokedAt) return reply.conflict("Invite is already revoked.");
    if (existing.acceptedAt) return reply.conflict("Invite has already been accepted and can no longer be revoked.");

    await prisma.$transaction(async (tx) => {
      await tx.adminInvite.update({ where: { id }, data: { revokedAt: new Date() } });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.invite.revoked",
        targetType: "AdminInvite",
        targetId: id,
        before: { revokedAt: null },
        after: { revokedAt: new Date() },
        metadata: { email: existing.email },
        ip: req.ip,
      });
    });

    return reply.send({ ok: true });
  });

  // Count-only overview metric. Do not make the dashboard fetch the
  // cross-user roster just to render one number.
  app.get("/api-keys/summary", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (_req, reply) => {
    return reply.send({ activeCount: await adminCountActiveApiKeys() });
  });

  // Admin API Keys
  app.get("/api-keys", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const query = req.query as { userId?: string; limit?: string; offset?: string };
    const keys = await adminListApiKeys({
      userId: query.userId,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
    return reply.send(keys);
  });

  app.post("/api-keys/:id/revoke", { preHandler: [requireRole(...ADMIN_ONLY)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const revoked = await adminRevokeApiKey(id, user.id, { ip: req.ip, userAgent: req.headers["user-agent"] });
    if (!revoked) return reply.notFound("API key not found");
    return reply.send({ ok: true, key: revoked });
  });

  // Admin Disputes
  app.get("/disputes", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const query = req.query as { status?: DisputeStatus | "all"; limit?: string; offset?: string };
    const take = Math.min(query.limit ? Number(query.limit) : 50, 100);
    const skip = query.offset ? Number(query.offset) : 0;

    // "all" is a real value the admin console's filter sends to mean "no
    // status filter" — it is not a Prisma DisputeStatus enum member, so it
    // must be translated to undefined before it reaches the where clause
    // (passing the literal string "all" straight to Prisma throws "Invalid
    // value for argument status").
    const status = query.status === "all" ? undefined : query.status;
    const where: Prisma.DisputeWhereInput = {
      ...(status ? { status } : {}),
    };

    const [disputes, total] = await Promise.all([
      prisma.dispute.findMany({
        where,
        include: {
          bounty: { select: { id: true, title: true } },
          raisedBy: { select: { id: true, displayName: true, handle: true } },
        },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.dispute.count({ where }),
    ]);

    // The admin console's disputes list and details pages (`ApiDispute.evidence`
    // / `DisputeEvidence`) render the full submission record next to each
    // dispute — payload, validation-pipeline results, revision history,
    // flags, and attached files — so a ruling can be made without a second
    // lookup. Batch-fetch it here rather than have the frontend guess at a
    // second endpoint.
    const submissionIds = Array.from(
      new Set(disputes.map((d) => d.submissionId).filter((id): id is string => !!id))
    );

    const [submissions, artifactRows] = submissionIds.length
      ? await Promise.all([
          prisma.submission.findMany({
            where: { id: { in: submissionIds } },
            include: {
              validationResults: { orderBy: { createdAt: "desc" } },
              revisions: { orderBy: { revisionNumber: "desc" } },
              flags: { orderBy: { createdAt: "desc" } },
            },
          }),
          prisma.artifact.findMany({
            where: { submissionId: { in: submissionIds } },
            select: { id: true, filename: true, status: true, submissionId: true },
          }),
        ])
      : [[], []];

    const submissionMap = new Map(submissions.map((s) => [s.id, s]));
    const artifactsBySubmission = new Map<string, typeof artifactRows>();
    for (const a of artifactRows) {
      if (!a.submissionId) continue;
      const list = artifactsBySubmission.get(a.submissionId) ?? [];
      list.push(a);
      artifactsBySubmission.set(a.submissionId, list);
    }

    const validatorIds = Array.from(
      new Set(submissions.flatMap((s) => s.flags.map((f) => f.validatorUserId).filter((id): id is string => !!id)))
    );
    const validators = validatorIds.length
      ? await prisma.user.findMany({ where: { id: { in: validatorIds } }, select: { id: true, displayName: true, handle: true } })
      : [];
    const validatorMap = new Map(validators.map((v) => [v.id, v.displayName ?? v.handle ?? v.id]));

    const disputesWithEvidence = disputes.map((d) => {
      const submission = d.submissionId ? submissionMap.get(d.submissionId) : undefined;
      if (!submission) return { ...d, evidence: null };

      return {
        ...d,
        evidence: {
          payloadJson: submission.payloadJson,
          status: submission.status,
          revisionCount: submission.revisionCount,
          scores: {
            duplicate: submission.duplicateScore,
            llm: submission.llmScore,
          },
          validationResults: submission.validationResults.map((r) => ({
            id: r.id,
            stage: r.stage,
            passed: r.passed,
            score: r.score,
            // `outcome` was missing here, so the dispute evidence list could
            // not distinguish the four states `passed: false` encodes and
            // rendered every one of them as a red "failed" — including a
            // stage that never ran. See lib/validation-state.ts.
            outcome: r.outcome,
            detailJson: r.detailJson,
            // Lets the consumer collapse to latest-per-stage instead of
            // listing every validationAttempt generation as its own row.
            validationAttempt: r.validationAttempt,
            createdAt: r.createdAt.toISOString(),
          })),
          revisions: submission.revisions.map((r) => ({
            id: r.id,
            revisionNumber: r.revisionNumber,
            status: r.status,
            payloadJson: r.payloadJson,
            validationEvidence: r.validationEvidence,
          })),
          flags: submission.flags.map((f) => ({
            id: f.id,
            reason: f.reason,
            details: f.details,
            status: f.status,
            createdAt: f.createdAt,
            validatorUserId: f.validatorUserId,
            validatorLabel: f.validatorUserId ? (validatorMap.get(f.validatorUserId) ?? null) : null,
          })),
          // The schema has no per-decision record with a verdict/note beyond
          // the Flag row already surfaced above (see Flag/HumanAuditWindowMembership
          // in prisma/schema.prisma — a membership tracks selection/rank only,
          // not a validator's verdict or written reasoning). Rather than
          // fabricate a decision trail the platform doesn't record, this stays
          // an honest empty array until decisions get their own queryable state.
          auditDecisions: [] as unknown[],
          artifacts: (artifactsBySubmission.get(submission.id) ?? []).map((a) => ({
            id: a.id,
            filename: a.filename,
            status: a.status,
            downloadUrl: `/v1/artifacts/${a.id}/content`,
          })),
        },
      };
    });

    return reply.send({ disputes: disputesWithEvidence, total, limit: take, offset: skip });
  });

  // Resolve Dispute
  //
  // Concurrency: the "still open" precondition and the resolution writes now
  // share ONE transaction that takes a `SELECT ... FOR UPDATE` lock on the
  // disputes row first — same idiom this file's own
  // /community/requests/:id/implement route (and community.ts's
  // edit/withdraw/resubmit/dispute routes) already use. Without it, two
  // concurrent /resolve calls on the same dispute (double-click, retry, or
  // two admins racing with different verdicts) could both pass the
  // `status !== "open"` check before either write landed, and both commit —
  // double-incrementing `Bounty.finalAcceptedItems` and leaving the
  // submission's terminal status non-deterministic depending on write order.
  app.post("/disputes/:id/resolve", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = resolveDisputeBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const resolutionDecision = RESOLVE_DECISION_MAP[parsed.data.decision];

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM disputes WHERE id = ${id} FOR UPDATE`;

      const dispute = await tx.dispute.findUnique({
        where: { id },
        include: { bounty: true },
      });

      if (!dispute) return "not_found" as const;
      if (dispute.status !== DisputeStatus.open) return "already_resolved" as const;

      await tx.dispute.update({
        where: { id },
        data: {
          status: DisputeStatus.resolved,
          resolutionDecision,
          resolution: parsed.data.resolution,
          resolvedByUserId: user.id,
          resolvedAt: new Date(),
        },
      });

      if (dispute.submissionId) {
        if (resolutionDecision === "upheld") {
          // Contributor wins: the FLAG is overturned, so the item goes BACK TO
          // HUMAN AUDIT — it is not accepted here.
          //
          // ALIGNED WITH V1 (routes/v1/admin.ts, the `overturn_flag` branch),
          // and a deliberate behaviour change from this codebase's previous
          // straight-to-accepted. The two questions are different and are
          // answered by different people: an admin rules on whether the
          // VALIDATOR'S STATED REASON holds; a validator rules on whether the
          // ITEM IS GOOD. Overturning "too_trivial" does not establish that the
          // submission passes — it establishes that the given reason does not.
          // Accepting directly had an admin make a quality call the audit
          // pipeline exists to make, bypassed the bounty's audit coverage
          // policy, and awarded karma on an admin's signature.
          //
          // Karma is therefore NOT awarded here. It flows through the normal
          // path when the re-audit accepts (services/audits.ts
          // submitAuditDecisions -> awardOrHoldAcceptedItemKarma), so there is
          // exactly one award site and no double-award to reconcile.
          await tx.submission.update({
            where: { id: dispute.submissionId },
            data: { status: SubmissionStatus.in_audit, acceptedAt: null },
          });

          // The overturned flag(s) are closed out: the contributor's
          // issueCount badge reads `flags: { where: { status: "open" } }`, so a
          // dismissed flag left open would contradict the item's new state.
          await tx.flag.updateMany({
            where: { submissionId: dispute.submissionId, status: FlagStatus.open },
            data: { status: FlagStatus.dismissed },
          });

          // Re-open the audit item(s) so the item is genuinely re-reviewable.
          // Per item, never by flipping the whole batch back to `available` —
          // that re-offers settled verdicts as fresh work and lets a second
          // validator complete a batch someone else already worked (v1 saw 12
          // batches pay two validators that way). See reopenAuditItemForReview.
          const auditItems = await tx.auditItem.findMany({
            where: { submissionId: dispute.submissionId },
            select: { id: true, auditBatchId: true },
          });
          for (const item of auditItems) {
            const reopened = await reopenAuditItemForReview(tx, item);
            // Only the validator who still HOLDS the batch is told. A batch
            // that went back to the pool has no owner to notify, and telling a
            // validator whose hold was released would be a lie about the state
            // of their queue. Uses the existing `audit.reopened` catalog event
            // (notifications/events.ts:225), whose copy already says the rest
            // of their decisions stand — which is exactly the guarantee
            // reopenAuditItemForReview provides.
            if (!reopened.returnedToPool && reopened.retainedValidatorUserId) {
              await notifyEvent(tx, "audit.reopened", {
                userId: reopened.retainedValidatorUserId,
                entityId: reopened.auditBatchId,
                // One notification per dispute resolution, not per retry of it.
                keySuffix: `dispute:${id}:${item.id}`,
                data: { bounty: dispute.bounty?.title ?? "a dataset" },
              });
            }
          }

          // No audit item exists when the flag predates the AuditBatch/AuditItem
          // alignment (migration 20260901132334). Without something here the
          // submission sits in `in_audit` with nothing able to review it:
          // stranded, invisible, never resolvable.
          //
          // A BATCH ALONE IS NOT ENOUGH, and an earlier version of this block
          // made exactly that mistake. The validator surface
          // (`GET /v1/audits` -> `listAvailableAudits`) lists HumanAuditWindows,
          // not AuditBatches, so a batch with no window is still invisible to
          // every validator — the same unreachable state, one layer up. Caught
          // by walking the flow over HTTP: the item reached `in_audit` with
          // `audit_items=1` and an `available` batch, and `GET /v1/audits` still
          // did not show it.
          //
          // So mint the pair the rest of the system expects: a window, its
          // batch, and a selected membership joining them.
          //
          // Labelled honestly, the same way the v1 cutover backfill is
          // (infra/operations/v1-to-community-cutover/02c): this is NOT a
          // sampling draw, so it must not claim the `hmac-sha256-v1`
          // `selectionVersion` default. `eligibleCount`/`quota` are 1 because
          // exactly one item is being sent back — there was no draw for it to
          // be a fraction of.
          if (auditItems.length === 0 && dispute.bounty) {
            const reauditBatchId = await createWindowAuditBatch(tx, {
              bountyId: dispute.bounty.id,
              submissionIds: [dispute.submissionId],
            });
            const nextIndex =
              ((
                await tx.humanAuditWindow.aggregate({
                  where: { bountyId: dispute.bounty.id },
                  _max: { windowIndex: true },
                })
              )._max.windowIndex ?? 0) + 1;
            await tx.humanAuditWindow.create({
              data: {
                bountyId: dispute.bounty.id,
                windowIndex: nextIndex,
                eligibleCount: 1,
                quota: 1,
                carryNumerator: 0,
                closureReason: "dispute_overturn_reaudit",
                selectionVersion: "dispute-overturn-reaudit",
                auditBatchId: reauditBatchId,
                memberships: {
                  create: [
                    {
                      submissionId: dispute.submissionId,
                      selected: true,
                      rank: `dispute:${id}`,
                    },
                  ],
                },
              },
            });
          }
        } else {
          // Flag confirmed: validator was right
          await tx.submission.update({
            where: { id: dispute.submissionId },
            data: { status: SubmissionStatus.rejected },
          });
          await tx.flag.updateMany({
            where: { submissionId: dispute.submissionId, status: FlagStatus.open },
            data: { status: FlagStatus.confirmed },
          });
        }

        // Either branch changed the pool's counted set: `rejected` releases
        // the item's capacity slot for good, and `in_audit` (re-audit) takes
        // one back if the flag had released it. Recount both bounty counters
        // in this same transaction so the pool's capacity is honest the moment
        // the dispute resolves (COMMUNITY_OPEN_POOL_PLAN_V2 §3.2b/§3.2d).
        const disputedSubmission = await tx.submission.findUnique({
          where: { id: dispute.submissionId },
          select: { bountyId: true },
        });
        if (disputedSubmission) await recomputeAcceptedItemCounters(tx, disputedSubmission.bountyId);
      }

      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.dispute.resolved",
        targetType: "Dispute",
        targetId: dispute.id,
        after: { decision: resolutionDecision, resolution: parsed.data.resolution },
        ip: req.ip,
      });

      return "resolved" as const;
    });

    if (result === "not_found") return reply.notFound("Dispute not found");
    if (result === "already_resolved") return reply.badRequest("This dispute has already been resolved");

    return reply.send({ ok: true, disputeId: id });
  });

  // Admin Bounty Status Update
  app.post("/bounties/:id/status", { preHandler: [requireRole(...ADMIN_AND_MEMBER)] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = bountyStatusBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const bounty = await prisma.bounty.findUnique({ where: { id } });
    if (!bounty) return reply.notFound("Dataset pool not found");

    const status = BOUNTY_ACTION_STATUS[parsed.data.action];

    const updated = await prisma.$transaction(async (tx) => {
      const b = await tx.bounty.update({
        where: { id },
        data: {
          status,
          revisionNote: parsed.data.reason,
        },
      });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "admin.bounty.status_changed",
        targetType: "Bounty",
        targetId: id,
        before: { status: bounty.status },
        after: { status },
        ip: req.ip,
      });
      return b;
    });

    // Bounty.targetItems/acceptedItems are BigInt columns (see the mint
    // routes above for the same fix) — JSON.stringify throws on a raw
    // BigInt, so this response 500'd every time despite the status update
    // itself succeeding.
    return reply.send({
      bounty: {
        ...updated,
        targetItems: Number(updated.targetItems),
        acceptedItems: Number(updated.acceptedItems),
        finalAcceptedItems: Number(updated.finalAcceptedItems),
      },
    });
  });

  // Admin Notification Stream SSE
  app.get("/notifications/stream", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    // Writing straight to reply.raw bypasses Fastify's normal reply
    // lifecycle, so the @fastify/cors plugin (which stages its headers via
    // reply.header() for Fastify's own send path) never gets a chance to
    // apply them here — the browser then blocks the cross-origin EventSource
    // outright. Set the same allow-origin decision manually before flushing.
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      reply.raw.setHeader("Vary", "Origin");
    }
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    reply.raw.write(`data: ${JSON.stringify({ type: "admin_connected" })}\n\n`);

    const unsubscribe = subscribeAdminNotificationStream((notification) => {
      reply.raw.write(`data: ${JSON.stringify(notification)}\n\n`);
    });

    const interval = setInterval(() => {
      reply.raw.write(": keep-alive\n\n");
    }, 25000);

    req.raw.on("close", () => {
      clearInterval(interval);
      unsubscribe();
    });
  });
}
