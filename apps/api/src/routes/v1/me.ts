// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireVerifiedEmail, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import {
  normalizePublicHandle,
  findAvailableHandleSuggestions,
  suggestAvailableHandles,
} from "../../services/public-handles.js";
import { displayNameSchema } from "../../lib/display-name.js";
import {
  getKarmaBreakdown,
  getKarmaHistory,
  getKarmaRules,
  getKarmaMatrix,
  acceptedItemKarmaForBounty,
  effectiveTypePricing,
} from "../../services/karma.js";
import { getMemberAnalytics, weekStartsBetween, MIN_WEEKS, MAX_WEEKS, MAX_RANGE_WEEKS, DEFAULT_WEEKS, type AnalyticsWindow } from "../../services/analytics.js";
import { getWatchPref, updateWatchPref } from "../../services/notifications.js";
import { listApiKeys, issueApiKey, rotateApiKey, revokeApiKey } from "../../services/api-keys.js";
import { getUserBadges } from "../../services/badges.js";
import { getProfileSummary, IN_REVIEW_SUBMISSION_STATUSES, ACCEPTED_SUBMISSION_STATUSES, NEEDS_ATTENTION_SUBMISSION_STATUSES } from "../../services/profile-summary.js";
import { listAvailableAudits, listMyAuditWindows, getMyAuditWorkSummary } from "../../services/audits.js";
import { listMyPoolSubmissionGroups } from "../../services/submissions.js";
import { ApiKeyScope, ContributorBatchStatus, Prisma } from "@prisma/client";
import { buildAuthorizeUrl, oauthCapableKinds, type OAuthCapableKind } from "../../services/profile-source-oauth.js";

// Statuses where a claimed batch is still active work for its contributor —
// terminal batches (accepted/partially_accepted/abandoned) belong in the
// independently server-paginated submission history, not this dashboard.
const ACTIVE_CLAIM_STATUSES: readonly ContributorBatchStatus[] = [
  ContributorBatchStatus.claimed,
  ContributorBatchStatus.submitted,
  ContributorBatchStatus.needs_fixes,
];

function parseCsv(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}


const updateProfileBody = z.object({
  displayName: displayNameSchema.optional(),
  profilePublic: z.boolean().optional(),
  publicProfilePrefs: z.record(z.unknown()).optional(),
});

const updatePublicProfileBody = z.object({
  profilePublic: z.boolean().optional(),
  prefs: z
    .object({
      showKarma: z.boolean().optional(),
      showBadges: z.boolean().optional(),
      showDatasets: z.boolean().optional(),
      showActivity: z.boolean().optional(),
    })
    .optional(),
});

const sponsorScopeBody = z.object({
  domains: z.array(z.string()).default([]),
  datasetTypeIds: z.array(z.string()).default([]),
  categories: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  volume: z.string().nullable().optional(),
  uses: z.array(z.string()).default([]),
  note: z.string().optional(),
});

const claimHandleBody = z.object({
  // Shape check only. `normalizePublicHandle` is the single authority on
  // length, charset and reserved names — duplicating a regex here would let
  // the two disagree, and the old one did: it rejected the hyphens V1 allows
  // and permitted underscores V1 forbids, so it refused valid handles before
  // the normalizer was ever reached.
  handle: z.string().trim().min(1, "A handle is required."),
});

// GET /me/analytics. A window shorter than four weeks is a chart with three
// points, and one longer than a year is a query nobody reads to the end of.
// Two accepted shapes, because the dashboard now picks a DATE RANGE while
// older callers (and the default) still pass a trailing week count:
//   ?weeks=12                       -> the 12 Monday-start weeks ending today
//   ?from=2026-07-01&to=2026-08-15  -> the weeks CONTAINING those two dates
// `from`/`to` win when both are supplied. Dates are plain ISO days, not
// instants: the window is bucketed in UTC and a timezone-qualified value would
// imply the API buckets in the caller's zone, which it does not.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const analyticsQuery = z.object({
  weeks: z.coerce.number().int().min(MIN_WEEKS).max(MAX_WEEKS).default(DEFAULT_WEEKS),
  from: z.string().regex(ISO_DAY).optional(),
  to: z.string().regex(ISO_DAY).optional(),
}).strip();

const createApiKeyBody = z.object({
  scopes: z.array(z.nativeEnum(ApiKeyScope)).min(1),
});

const watchPrefBody = z.object({
  enabled: z.boolean().optional(),
  domains: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
});

const poolSubmissionGroupsQuery = z.object({
  filter: z.enum(["all", "action_needed", "in_review", "accepted"]).default("all"),
  // Retained for compatibility with the shared v1 client. Open pools are
  // community-only, so "all" and "community" have the same result here.
  workType: z.enum(["all", "community"]).default("all"),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(25).default(6),
}).strip();

export async function meRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Profile details
  app.get("/profile", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const profile = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        displayName: true,
        handle: true,
        profilePublic: true,
        publicProfilePrefs: true,
        karmaTotal: true,
        leaderboardRank: true,
        onboarded: true,
        persona: true,
        createdAt: true,
      },
    });
    return reply.send({ profile });
  });

  // Update profile
  app.patch("/profile", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = updateProfileBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
        ...(parsed.data.profilePublic !== undefined ? { profilePublic: parsed.data.profilePublic } : {}),
        ...(parsed.data.publicProfilePrefs ? { publicProfilePrefs: parsed.data.publicProfilePrefs as Prisma.InputJsonValue } : {}),
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        handle: true,
        profilePublic: true,
        publicProfilePrefs: true,
        karmaTotal: true,
        leaderboardRank: true,
      },
    });

    return reply.send({ profile: updated });
  });

  // ── Public-profile handle surface, at V1's paths ────────────────────────
  //
  // `apps/web` was ported faithfully from V1 and calls
  // /v1/me/public-profile/handle-availability, …/handle-suggestions and
  // …/handle. This API previously exposed only /v1/me/handle/availability and
  // /v1/me/handle/claim, so every one of those client calls 404'd: the
  // availability check failed, the claim button never enabled, and onboarding
  // step 1 could not be completed in the UI at all. These four routes restore
  // V1's paths, validator, reserved list, suggestions and rate limits. The
  // legacy /handle/* pair below is kept for the MCP claim_handle tool and its
  // existing integration test, and now shares the same normalizer.

  const HANDLE_READ_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: "1 minute" } };
  const HANDLE_WRITE_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: "1 minute" } };

  app.get("/public-profile/handle-availability", { config: HANDLE_READ_RATE_LIMIT }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { handle: candidate } = req.query as { handle?: string };
    if (!candidate) return reply.badRequest("handle is required");
    const normalized = normalizePublicHandle(candidate);
    if (!normalized.handle) {
      return reply.send({ handle: candidate.trim().toLowerCase(), available: false, reason: normalized.reason });
    }
    const row = await prisma.user.findUnique({ where: { handle: normalized.handle }, select: { id: true } });
    if (!row) return reply.send({ handle: normalized.handle, available: true });
    // A returning onboarding user may have already claimed this exact handle
    // before pressing Back. It stays valid for that owner and is unavailable
    // to every other account.
    if (row.id === user.id) return reply.send({ handle: normalized.handle, available: true, claimed: true });
    const suggestions = await findAvailableHandleSuggestions(normalized.handle);
    return reply.send({ handle: normalized.handle, available: false, reason: "That handle is unavailable.", suggestions });
  });

  // Starter suggestions for someone who has not thought of a handle yet.
  // Read-only and reserves nothing — the claim below is still the only thing
  // that takes a name, so two people can be shown the same suggestion and the
  // unique index decides.
  app.get("/public-profile/handle-suggestions", { config: HANDLE_READ_RATE_LIMIT }, async (req, reply) => {
    const { count } = req.query as { count?: string };
    const parsed = Number.parseInt(count ?? "", 10);
    const suggestions = await suggestAvailableHandles(Number.isFinite(parsed) ? parsed : 8);
    return reply.send({ suggestions });
  });

  app.post("/public-profile/handle", { preHandler: [requireVerifiedEmail], config: HANDLE_WRITE_RATE_LIMIT }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = claimHandleBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("A handle is required.");
    const normalized = normalizePublicHandle(parsed.data.handle);
    if (!normalized.handle) return reply.badRequest(normalized.reason ?? "Invalid handle.");

    const current = await prisma.user.findUnique({ where: { id: user.id }, select: { handle: true } });
    if (!current) return reply.unauthorized("Sign in required.");
    if (current.handle === normalized.handle) return reply.send({ handle: current.handle });
    // POST is the FIRST claim only. A rename goes through PUT, which must never
    // silently re-publish a page its owner switched off.
    if (current.handle) return reply.conflict("Your handle has already been claimed.");

    try {
      const claimed = await prisma.$transaction(async (tx) => {
        // Claiming the first handle turns the public page on. The page cannot
        // exist without a handle, so this is the first moment the choice is
        // even available — and a member who picks a name and is then told
        // their page is private has been handed a URL that 404s with nothing
        // explaining why. Every section stays individually toggleable and the
        // whole page can be switched off from Profile; only the STARTING
        // position changes. Scoped to `handle: null` so PUT cannot reach it.
        const result = await tx.user.updateMany({
          where: { id: user.id, handle: null },
          data: { handle: normalized.handle, profilePublic: true },
        });
        if (result.count !== 1) return null;
        await writeAuditLog(tx, {
          actorUserId: user.id,
          action: "public_profile.handle_claimed",
          targetType: "user",
          targetId: user.id,
          after: { handle: normalized.handle, profilePublic: true },
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.id,
        });
        return normalized.handle;
      });
      if (!claimed) return reply.conflict("Your handle has already been claimed.");
      return reply.code(201).send({ handle: claimed, profilePublic: true });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.conflict("That handle is unavailable.");
      }
      throw error;
    }
  });

  // A handle is deliberately replaceable from Profile. The same normalization,
  // unique constraint, rate limit and audit trail as the initial claim apply —
  // but `profilePublic` is left exactly as the owner set it.
  app.put("/public-profile/handle", { preHandler: [requireVerifiedEmail], config: HANDLE_WRITE_RATE_LIMIT }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = claimHandleBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("A handle is required.");
    const normalized = normalizePublicHandle(parsed.data.handle);
    if (!normalized.handle) return reply.badRequest(normalized.reason ?? "Invalid handle.");

    const current = await prisma.user.findUnique({ where: { id: user.id }, select: { handle: true } });
    if (!current) return reply.unauthorized("Sign in required.");
    if (current.handle === normalized.handle) return reply.send({ handle: current.handle });

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.user.update({
          where: { id: user.id },
          data: { handle: normalized.handle },
          select: { handle: true },
        });
        await writeAuditLog(tx, {
          actorUserId: user.id,
          action: "public_profile.handle_changed",
          targetType: "user",
          targetId: user.id,
          before: { handle: current.handle },
          after: { handle: row.handle },
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.id,
        });
        return row;
      });
      return reply.send({ handle: updated.handle });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.conflict("That handle is unavailable.");
      }
      throw error;
    }
  });

  // PUT /public-profile/display-name — found missing by a same-day QA audit:
  // `apps/web/app/(app)/profile/page.tsx`'s dedicated name-editor has always
  // called this exact path/method, but the route never existed here (only
  // the general-purpose `PATCH /profile` above accepted `displayName`, under
  // a different response shape the profile page's editor never expected).
  // Every click of the profile page's "change name" → "save" 404'd. Mirrors
  // the `/public-profile/handle` PUT route immediately above: verified-email
  // gate, its own audit-log action, returns `{displayName}` to match what
  // the frontend already reads.
  const changeDisplayNameBody = z.object({ displayName: displayNameSchema });
  app.put("/public-profile/display-name", { preHandler: [requireVerifiedEmail], config: HANDLE_WRITE_RATE_LIMIT }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = changeDisplayNameBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "A display name is required.");

    const current = await prisma.user.findUnique({ where: { id: user.id }, select: { displayName: true } });
    if (!current) return reply.unauthorized("Sign in required.");
    if (current.displayName === parsed.data.displayName) return reply.send({ displayName: current.displayName });

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: user.id },
        data: { displayName: parsed.data.displayName },
        select: { displayName: true },
      });
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "public_profile.display_name_changed",
        targetType: "user",
        targetId: user.id,
        before: { displayName: current.displayName },
        after: { displayName: row.displayName },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        requestId: req.id,
      });
      return row;
    });
    return reply.send({ displayName: updated.displayName });
  });

  // Handle availability
  app.get("/handle/availability", async (req, reply) => {
    const query = req.query as { handle?: string };
    if (!query.handle) return reply.send({ available: false, reason: "handle is required" });
    // Same normalizer as the /public-profile/* surface above, so the MCP
    // claim_handle path cannot take a reserved name or a handle the browser
    // flow would have refused. Previously this used a looser local regex
    // (underscores allowed, hyphens rejected, 30 chars) with no reserved list.
    const normalized = normalizePublicHandle(query.handle);
    if (!normalized.handle) return reply.send({ available: false, reason: normalized.reason });
    const existing = await prisma.user.findUnique({ where: { handle: normalized.handle }, select: { id: true } });
    if (!existing) return reply.send({ available: true });
    return reply.send({ available: false, reason: "That handle is unavailable." });
  });

  // Claim handle
  app.post("/handle/claim", { config: HANDLE_WRITE_RATE_LIMIT }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = claimHandleBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    // Normalized through the shared validator: this route was previously the
    // one place a reserved name could be claimed, and it had no rate limit at
    // all, so a handle could be rotated without bound.
    const normalized = normalizePublicHandle(parsed.data.handle);
    if (!normalized.handle) return reply.badRequest(normalized.reason ?? "Invalid handle.");
    const handle = normalized.handle;
    const [existing, self] = await Promise.all([
      prisma.user.findUnique({ where: { handle } }),
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { handle: true } }),
    ]);
    if (existing && existing.id !== user.id) {
      return reply.conflict("Handle is already taken");
    }

    // Public-by-default applies only to the very first handle claim (onboarding),
    // never to a later rename — otherwise a member who deliberately opted back
    // out of a public profile would have it silently re-enabled just by
    // changing their handle.
    const isFirstClaim = self.handle === null;

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { handle, ...(isFirstClaim ? { profilePublic: true } : {}) },
    });

    return reply.send({ ok: true, handle: updated.handle, profilePublic: updated.profilePublic });
  });

  // Cross-pool submission history, grouped by bounty — backs the
  // contributor dashboard's "Recent activity" section (getMyPoolSubmissions).
  app.get("/pool-submissions", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = poolSubmissionGroupsQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid pool submission filters.");
    }
    const result = await listMyPoolSubmissionGroups({
      contributorUserId: user.id,
      filter: parsed.data.filter,
      search: parsed.data.search,
      page: parsed.data.page,
      limit: parsed.data.limit,
    });
    return reply.send(result);
  });

  // Karma breakdown
  app.get("/karma", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const breakdown = await getKarmaBreakdown(user.id);
    return reply.send(breakdown);
  });

  // Karma history
  app.get("/karma/history", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = req.query as { limit?: string; offset?: string };
    const history = await getKarmaHistory(user.id, {
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
    return reply.send(history);
  });

  // Weekly activity series for this member's own workspace charts. Read-only
  // aggregates over the member's own rows; `notes` in the payload carries the
  // caveats the numbers cannot carry themselves, and the UI renders them.
  //
  // ON by default, with an explicit off-switch. V1 has no member analytics
  // surface — no /v1/me/analytics route, no chart anywhere in
  // databounty-web — so this route has no V1 counterpart and is a real parity
  // divergence, owed a deviation row. It was gated off for exactly that reason
  // earlier on 2026-09-04; the owner then asked for the dashboard section to
  // be visible, which reverses that. The switch stays so the divergence can be
  // closed again in one environment variable rather than a revert:
  // MEMBER_ANALYTICS_ENABLED=false unregisters the route.
  //
  // Read at registration time, not through `config`, so a test can flip it
  // before calling buildApp() without depending on module import order.
  if (process.env.MEMBER_ANALYTICS_ENABLED !== "false") {
    app.get("/analytics", async (req, reply) => {
      const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
      const parsed = analyticsQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_query",
          message:
            `weeks must be a whole number between ${MIN_WEEKS} and ${MAX_WEEKS}, ` +
            `or pass from and to as YYYY-MM-DD dates.`,
        });
      }
      const { weeks, from, to } = parsed.data;

      // One side of a range is a caller error, not something to guess at:
      // defaulting the missing end would return a window nobody asked for and
      // the chart would look authoritative about it.
      if ((from && !to) || (to && !from)) {
        return reply.code(400).send({
          error: "invalid_query",
          message: "from and to must be supplied together.",
        });
      }

      let window: AnalyticsWindow = weeks;
      if (from && to) {
        const fromDate = new Date(`${from}T00:00:00.000Z`);
        const toDate = new Date(`${to}T00:00:00.000Z`);
        if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
          return reply.code(400).send({ error: "invalid_query", message: "from and to must be real dates." });
        }
        if (fromDate > toDate) {
          return reply.code(400).send({ error: "invalid_query", message: "from must not be after to." });
        }
        // Same ceiling a trailing window has, so an explicit range cannot be
        // used to ask for an unbounded scan.
        const bucketCount = weekStartsBetween(fromDate, toDate).length;
        if (bucketCount > MAX_RANGE_WEEKS) {
          return reply.code(400).send({
            error: "invalid_query",
            message: `that range covers ${bucketCount} weeks; the maximum is ${MAX_RANGE_WEEKS}.`,
          });
        }
        window = { from: fromDate, to: toDate };
      }

      const analytics = await getMemberAnalytics(user.id, window);
      return reply.send(analytics);
    });
  }

  // API Keys
  app.get("/api-keys", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const keys = await listApiKeys(user.id);
    return reply.send({ keys });
  });

  app.post("/api-keys", { preHandler: requireVerifiedEmail }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = createApiKeyBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const result = await issueApiKey({
      userId: user.id,
      scopes: parsed.data.scopes,
      ip: req.ip,
    });

    // The web app's reveal-once modal (developers/page.tsx's IssuedKey type)
    // reads the raw secret and summary fields off one flat object — it never
    // unwraps a nested `summary`, so returning `{rawKey, summary}` as-is left
    // `issued.scopes`/`issued.key` undefined and crashed the modal with
    // "Cannot read properties of undefined (reading 'join')" on every single
    // key creation, even though the key itself was created correctly.
    return reply.status(201).send({ ...result.summary, key: result.rawKey });
  });

  app.post("/api-keys/:id/rotate", { preHandler: requireVerifiedEmail }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };

    const result = await rotateApiKey({
      id,
      userId: user.id,
      ip: req.ip,
    });

    if (!result) return reply.notFound("API key not found");
    // Same flattening as POST /api-keys above.
    return reply.send({ ...result.summary, key: result.rawKey });
  });

  app.delete("/api-keys/:id", { preHandler: requireVerifiedEmail }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };

    const result = await revokeApiKey({
      id,
      userId: user.id,
      ip: req.ip,
    });

    if (!result) return reply.notFound("API key not found");
    return reply.send({ ok: true, key: result });
  });

  // Earned Badges
  app.get("/badges", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const badges = await getUserBadges(user.id);
    return reply.send({ badges });
  });

  // Credential/reputation summary (profile page "Boost your reputation" +
  // rank/badge/submission-funnel surfaces). Sources will read back empty
  // until the OAuth-connect / manual-entry mutation routes exist in this
  // API (schema gap: ProfileSource has no write path here yet — see
  // services/profile-summary.ts header comment) — this route only reads
  // what is genuinely stored.
  app.get("/profile-sources", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const [sources, summary] = await Promise.all([
      prisma.profileSource.findMany({ where: { userId: user.id } }),
      getProfileSummary(user.id),
    ]);
    const capable = oauthCapableKinds();

    return reply.send({
      sources: sources.map((row) => ({
        source: row.source,
        handleOrUrl: row.handleOrUrl,
        verified: row.verified,
        verifiedAt: row.verifiedAt,
        connectedAt: row.connectedAt,
        verificationState: row.verificationState,
        lastCheckedAt: row.lastCheckedAt,
        nextCheckAt: row.nextCheckAt,
        oauthCapable: capable.includes(row.source as OAuthCapableKind),
        verifyChallenge: row.verifyChallenge,
        verifyLastError: row.verifyLastError,
      })),
      oauthCapableKinds: capable,
      reputationScore: summary.reputationScore,
      reputation: summary.reputation,
      ranks: summary.ranks,
      submissions: summary.submissions,
      badges: summary.badges,
    });
  });

  // Start an OAuth credential connect (GitHub, ORCID). Returns the provider's
  // authorize URL; the frontend does a full-page redirect to it, the user
  // consents on the provider's own site, and the provider redirects back to
  // the public GET /v1/profile-sources/:provider/callback (not under this
  // /me prefix — that leg has no session to check, only the signed state).
  app.post("/profile-sources/:id/connect", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    if (!oauthCapableKinds().includes(id as OAuthCapableKind)) {
      return reply.badRequest(`${id} does not support OAuth connect.`);
    }
    const url = buildAuthorizeUrl(req, id as OAuthCapableKind, user.id);
    if (!url) return reply.badRequest(`${id} does not support OAuth connect.`);
    return reply.send({ url });
  });

  const manualSourceBody = z.object({ handleOrUrl: z.string().trim().min(1).max(300) });

  // Manual (non-OAuth) credential entry — LinkedIn/Scholar/Kaggle/X have no
  // OAuth app registered here, so the user just pastes the profile URL/handle.
  // Never marked `verified`: nothing has checked it belongs to them.
  app.put("/profile-sources/:id", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    if (oauthCapableKinds().includes(id as OAuthCapableKind)) {
      return reply.badRequest(`${id} connects via OAuth — use connect, not manual entry.`);
    }
    const parsed = manualSourceBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const row = await prisma.profileSource.upsert({
      where: { userId_source: { userId: user.id, source: id as Prisma.ProfileSourceCreateInput["source"] } },
      create: { userId: user.id, source: id as Prisma.ProfileSourceCreateInput["source"], handleOrUrl: parsed.data.handleOrUrl },
      update: { handleOrUrl: parsed.data.handleOrUrl },
    });
    return reply.send({
      source: {
        source: row.source,
        handleOrUrl: row.handleOrUrl,
        verified: row.verified,
        verifiedAt: row.verifiedAt,
        connectedAt: row.connectedAt,
        verificationState: row.verificationState,
        lastCheckedAt: row.lastCheckedAt,
        nextCheckAt: row.nextCheckAt,
        oauthCapable: false,
        verifyChallenge: row.verifyChallenge,
        verifyLastError: row.verifyLastError,
      },
    });
  });

  app.delete("/profile-sources/:id", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    await prisma.profileSource.deleteMany({ where: { userId: user.id, source: id as Prisma.ProfileSourceCreateInput["source"] } });
    return reply.send({ ok: true });
  });

  const visibilityBody = z.object({ profilePublic: z.boolean() });

  app.patch("/profile-sources/visibility", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = visibilityBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const updated = await prisma.user.update({ where: { id: user.id }, data: { profilePublic: parsed.data.profilePublic } });
    return reply.send({ profilePublic: updated.profilePublic });
  });

  // Public-profile handle/display-name/visibility settings (profile page +
  // app-shell "signed in as" surfaces). This is deliberately the same
  // handle/displayName/profilePublic state as PATCH /v1/me/profile above —
  // a dedicated read here matches the frontend's dedicated endpoint
  // (`API.me.publicProfile`) rather than requiring every caller to know
  // about the more general /profile route.
  app.get("/public-profile", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const profile = await prisma.user.findUnique({
      where: { id: user.id },
      select: { handle: true, displayName: true, profilePublic: true, publicProfilePrefs: true },
    });
    if (!profile) return reply.notFound("User not found");

    const prefs = (profile.publicProfilePrefs as Record<string, unknown> | null) ?? {};
    return reply.send({
      handle: profile.handle,
      displayName: profile.displayName,
      profilePublic: profile.profilePublic,
      prefs: {
        showKarma: typeof prefs.showKarma === "boolean" ? prefs.showKarma : true,
        showBadges: typeof prefs.showBadges === "boolean" ? prefs.showBadges : true,
        showDatasets: typeof prefs.showDatasets === "boolean" ? prefs.showDatasets : true,
        showActivity: typeof prefs.showActivity === "boolean" ? prefs.showActivity : true,
      },
    });
  });

  // PATCH /public-profile — the profile page's "Make profile public" master
  // toggle sends {profilePublic}, its four section switches send {prefs};
  // this route never existed at all, so every one of those five toggles
  // 404'd on click. Prefs are merged onto the existing stored value (not
  // replaced wholesale) so toggling one switch can never silently reset the
  // other three back to their defaults.
  app.patch("/public-profile", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = updatePublicProfileBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { publicProfilePrefs: true } });
    if (!existing) return reply.notFound("User not found");
    const currentPrefs = (existing.publicProfilePrefs as Record<string, unknown> | null) ?? {};

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(parsed.data.profilePublic !== undefined ? { profilePublic: parsed.data.profilePublic } : {}),
        ...(parsed.data.prefs ? { publicProfilePrefs: { ...currentPrefs, ...parsed.data.prefs } as Prisma.InputJsonValue } : {}),
      },
      select: { profilePublic: true, publicProfilePrefs: true },
    });

    const prefs = (updated.publicProfilePrefs as Record<string, unknown> | null) ?? {};
    return reply.send({
      profilePublic: updated.profilePublic,
      prefs: {
        showKarma: typeof prefs.showKarma === "boolean" ? prefs.showKarma : true,
        showBadges: typeof prefs.showBadges === "boolean" ? prefs.showBadges : true,
        showDatasets: typeof prefs.showDatasets === "boolean" ? prefs.showDatasets : true,
        showActivity: typeof prefs.showActivity === "boolean" ? prefs.showActivity : true,
      },
    });
  });

  // GET/PUT /sponsor-scope — the profile page's "Set interests" modal and
  // the onboarding flow's sponsor-intake step both read and write this
  // (`API.me.sponsorScope`), and the schema's own SponsorScope model has
  // existed the whole time — this route just never did, so the data always
  // silently reverted to local-only React state on reload ("previously
  // this only ever lived in local React state" per the store's own
  // comment). One row per user (schema enforces `userId @unique`), upserted
  // on write.
  app.get("/sponsor-scope", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const scope = await prisma.sponsorScope.findUnique({ where: { userId: user.id } });
    if (!scope) return reply.notFound("No sponsor scope saved yet");
    return reply.send({
      domains: scope.domains,
      datasetTypeIds: scope.datasetTypeIds,
      categories: scope.categories,
      languages: scope.languages,
      volume: scope.volume,
      uses: scope.uses,
      note: scope.note ?? "",
    });
  });

  app.put("/sponsor-scope", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = sponsorScopeBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const scope = await prisma.sponsorScope.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        domains: parsed.data.domains,
        datasetTypeIds: parsed.data.datasetTypeIds,
        categories: parsed.data.categories,
        languages: parsed.data.languages,
        volume: parsed.data.volume ?? null,
        uses: parsed.data.uses,
        note: parsed.data.note,
      },
      update: {
        domains: parsed.data.domains,
        datasetTypeIds: parsed.data.datasetTypeIds,
        categories: parsed.data.categories,
        languages: parsed.data.languages,
        volume: parsed.data.volume ?? null,
        uses: parsed.data.uses,
        note: parsed.data.note,
      },
    });

    return reply.send({
      domains: scope.domains,
      datasetTypeIds: scope.datasetTypeIds,
      categories: scope.categories,
      languages: scope.languages,
      volume: scope.volume,
      uses: scope.uses,
      note: scope.note ?? "",
    });
  });

  // Contributor workspace dashboard: this contributor's active legacy
  // per-contributor claimed batches (open-pool community bounties never
  // create a ContributorBatch row at all — see the schema comment on
  // Bounty.poolDifficulty — so `batches` is honestly empty for anyone who
  // has only worked open pools) plus the same profileSummary/workSummary
  // shape `/validator-dashboard` returns, so the two role dashboards stay
  // consistent.
  app.get("/contributor-dashboard", { preHandler: requireAuth }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const [batches, profileSummary, { rules: karmaRules }, { matrix: liveKarmaMatrix }] = await Promise.all([
      prisma.contributorBatch.findMany({
        where: { contributorUserId: user.id, status: { in: [...ACTIVE_CLAIM_STATUSES] } },
        include: {
          bounty: {
            select: {
              title: true,
              language: true,
              datasetCategory: true,
              datasetTypeId: true,
              karmaPerAcceptedItem: true,
              karmaQuote: true,
              datasetType: { select: { name: true, domain: true, complexityScore: true, verificationUnits: true } },
              _count: { select: { batches: true } },
            },
          },
          submissions: { select: { status: true } },
        },
        orderBy: { claimedAt: "desc" },
      }),
      getProfileSummary(user.id),
      getKarmaRules(),
      getKarmaMatrix(),
    ]);

    return reply.send({
      batches: batches.map((batch) => {
        const statuses = batch.submissions.map((s) => s.status);
        const accepted = statuses.filter((s) => ACCEPTED_SUBMISSION_STATUSES.includes(s)).length;
        const inReview = statuses.filter((s) => IN_REVIEW_SUBMISSION_STATUSES.includes(s)).length;
        const actionNeeded = statuses.filter((s) => NEEDS_ATTENTION_SUBMISSION_STATUSES.includes(s)).length;
        const disputed = statuses.filter((s) => s === "disputed").length;
        return {
          id: batch.id,
          bountyId: batch.bountyId,
          bountyTitle: batch.bounty.title,
          slotName: batch.slotName,
          category: batch.category,
          difficulty: batch.difficulty,
          itemCount: Number(batch.itemCount),
          submittedCount: batch.submittedCount,
          karmaPerAcceptedItem: batch.bounty.karmaPerAcceptedItem,
          // Real per-item pricing rather than the raw `karmaPerAcceptedItem`
          // column times item count: that column is 0 for every auto-priced
          // pool, which previously projected an expected reward of $0 for a
          // priced-category batch.
          expectedReward:
            acceptedItemKarmaForBounty(
              batch.bounty.karmaPerAcceptedItem,
              batch.difficulty,
              batch.bounty.karmaQuote,
              karmaRules,
              effectiveTypePricing(batch.bounty.datasetTypeId, batch.bounty.datasetType, liveKarmaMatrix)
            ).amount * Number(batch.itemCount),
          deadline: batch.deadline ? batch.deadline.toISOString() : null,
          status: batch.status,
          language: batch.bounty.language,
          datasetTypeId: batch.bounty.datasetTypeId,
          datasetTypeName: batch.bounty.datasetType?.name ?? "Legacy dataset",
          domain: batch.bounty.datasetType?.domain ?? null,
          bountyTotalBatchCount: batch.bounty._count.batches,
          claimedAt: batch.claimedAt ? batch.claimedAt.toISOString() : null,
          createdAt: batch.createdAt.toISOString(),
          validationSummary: { accepted, actionNeeded, inReview, disputed },
        };
      }),
      submissions: [],
      profileSummary,
      workSummary: {
        contributor: {
          submitted: profileSummary.submissions.total,
          processing: profileSummary.submissions.inReview,
          awaitingDecision: 0,
          finalAccepted: profileSummary.submissions.accepted,
          needsAttention: profileSummary.submissions.needsAttention,
          terminalFailed: profileSummary.submissions.rejected.total,
        },
        validator: {
          claimedBatches: 0,
          completedBatches: 0,
          pendingDecisions: 0,
          decidedItems: profileSummary.ranks.validator.auditsCompleted,
          activeClaimedBatches: 0,
        },
      },
    });
  });

  // Validator workspace dashboard: rank/karma summary + the open
  // HumanAuditWindow queue this validator can act on, plus this validator's
  // own claimed/completed/pending counts (workSummary.validator) — now backed
  // by getMyAuditWorkSummary now that HumanAuditWindow carries a real
  // claimedByUserId (T1). Previously hardcoded to all-zero for the same
  // reason GET /me/audits used to return `[]`: no claim column existed yet.
  app.get("/validator-dashboard", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = req.query as {
      limit?: string;
      skip?: string;
      domains?: string;
      categories?: string;
      languages?: string;
      kind?: string;
      q?: string;
    };

    const [profileSummary, available, rank, myWork] = await Promise.all([
      getProfileSummary(user.id),
      listAvailableAudits({
        validatorUserId: user.id,
        categories: parseCsv(query.categories),
        languages: parseCsv(query.languages),
        search: query.q,
        limit: query.limit ? Number(query.limit) : undefined,
        offset: query.skip ? Number(query.skip) : undefined,
      }),
      prisma.rank.findUnique({ where: { userId: user.id }, select: { auditsCompleted: true } }),
      getMyAuditWorkSummary(user.id),
    ]);

    return reply.send({
      audits: [],
      availableAudits: available.audits,
      availableTotal: available.total,
      conflictExcluded: available.conflictExcluded,
      conflictExcludedByReason: available.conflictExcludedByReason,
      profileSummary,
      workSummary: {
        contributor: {
          submitted: profileSummary.submissions.total,
          processing: profileSummary.submissions.inReview,
          awaitingDecision: 0,
          finalAccepted: profileSummary.submissions.accepted,
          needsAttention: profileSummary.submissions.needsAttention,
          terminalFailed: profileSummary.submissions.rejected.total,
        },
        validator: {
          claimedBatches: myWork.claimedBatches,
          completedBatches: myWork.completedBatches,
          pendingDecisions: myWork.pendingDecisions,
          decidedItems: rank?.auditsCompleted ?? 0,
          activeClaimedBatches: myWork.activeClaimedBatches,
        },
      },
    });
  });

  // A validator's own claimed/decided audit history — real HumanAuditWindow
  // rows scoped to `claimedByUserId`. Previously this always returned an empty
  // page: that was honest at the time it was written (the schema had no
  // per-validator claim column at all), but the schema has since grown
  // `claimedByUserId`/`claimedAt`/`claimExpiresAt` specifically for this (T1,
  // see services/audits.ts claimAuditWindow), so returning empty here is now
  // stale, not honest — every validator with an active or past claim got a
  // silently-empty "My Audit History" and no claim-expiry countdown. See
  // listMyAuditWindows for the status-bucketing (claimed / overdue_review /
  // completed) this schema derives instead of reading a stored status column.
  app.get("/audits", async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = req.query as { status?: string; q?: string; limit?: string; skip?: string };
    const result = await listMyAuditWindows({
      validatorUserId: user.id,
      status: query.status,
      search: query.q,
      limit: query.limit ? Number(query.limit) : undefined,
      skip: query.skip ? Number(query.skip) : undefined,
    });
    return reply.send(result);
  });
}

// Registered separately from meRoutes at top-level `/watch-prefs` (not under
// `/me`), matching V1's own registration (`routes/v1/index.ts`:
// `app.register(watchPrefRoutes, { prefix: "/watch-prefs" })`) and the
// frontend's `API.watchPrefs = "/v1/watch-prefs"` constant, which does not
// have a `/me` segment.
export async function watchPrefRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: requireAuth }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const pref = await getWatchPref(user.id);
    return reply.send({ watchPrefs: pref });
  });

  app.put("/", { preHandler: requireAuth }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = watchPrefBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const updated = await updateWatchPref(user.id, parsed.data);
    return reply.send({ watchPrefs: updated });
  });
}
