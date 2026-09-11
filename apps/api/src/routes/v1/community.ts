// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PHASE_STATUSES, phaseSchema, queryBoolean, publicText, PUBLIC_DATASET_TYPE_SELECT, PUBLIC_HARNESS_SELECT } from "../../lib/public-query.js";
import { prisma } from "../../lib/prisma.js";
import {
  getKarmaBreakdown,
  getLeaderboard,
  resolveKarmaTier,
  getKarmaTiers,
  getKarmaRules,
  getKarmaMatrix,
  catalogPricingFacts,
  karmaMatrixView,
  itemsNeededPerTier,
  acceptedItemKarmaForBounty,
  effectiveTypePricing,
} from "../../services/karma.js";
import { getCommunityStats, getCommunityPool, listOpenPoolsForContributor, listCommunityCatalog, getCommunityCatalogDataset, listValidationQueuePools, InvalidCursorError } from "../../services/bounties.js";
import { IN_REVIEW_SUBMISSION_STATUSES } from "../../services/profile-summary.js";
import { getAdminSetting } from "../../services/admin-settings.js";
import { karmaHoldsEnabled } from "../../services/karma-holds.js";
import { listBadges, syncAndListBadges } from "../../services/badges.js";
import { requireAuth, requireRole, requireVerifiedEmail, ADMIN_AND_ABOVE_READONLY, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { notifyAdmins, notifyUser } from "../../services/notifications.js";
import { listDatasetRequestSamples, sampleGateFromSamples, serializeArtifact } from "../../services/artifacts.js";
import { BUNDLED_LICENSE_IDS, datasetLicense } from "../../lib/publication/license-texts.js";
import { PLANNER_DIFFICULTY_MIXES, canonicalLanguageFor, coherenceProblems, isLaunchableType } from "../../services/planner.js";
import type { DatasetType } from "@prisma/client";
import { DomainId, DatasetCategory, DatasetRequestStatus, ContributorBatchStatus, CommunityPublicationStatus, KarmaEventType, UserStatus, BountyKind, BountyStatus, Prisma } from "@prisma/client";

function parseCsv(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

type KarmaHoldRole = "contributor" | "validator" | "sponsor";

/** Maps a karma award's eventType to the role it was earned in, for the
 * per-role hold breakdown. Mirrors how each eventType is actually awarded
 * in services/karma.ts, services/audits.ts, services/validation.ts, and
 * routes/v1/admin-community.ts today. */
function roleForKarmaEventType(eventType: KarmaEventType): KarmaHoldRole {
  switch (eventType) {
    case KarmaEventType.community_audit_completed:
    case KarmaEventType.community_flag_confirmed:
      return "validator";
    case KarmaEventType.community_request_approved:
    case KarmaEventType.community_bounty_published:
      return "sponsor";
    default:
      return "contributor";
  }
}

// Human-readable labels for every KarmaEventType, used both to label a
// member's own karma-history rows and to build the /karma eventTypeFilters
// dropdown. Static display copy for a fixed enum — not fabricated data.
const KARMA_EVENT_LABELS: Record<KarmaEventType, string> = {
  community_item_accepted: "Accepted item",
  community_item_reversed: "Reversed item",
  community_audit_completed: "Completed audit",
  community_request_approved: "Approved request",
  community_bounty_published: "Bounty published",
  community_flag_confirmed: "Confirmed flag",
  community_publish_bonus: "Publish bonus",
  admin_adjustment: "Admin adjustment",
};

/** Thrown when a caller-supplied KarmaEvent cursor no longer resolves to a
 * row (deleted, or simply garbage) — the route maps this to 400 so the web
 * app's "this page of history was out of date" recovery copy fires instead
 * of a generic 500. */
class KarmaCursorError extends Error {}

function serializeKarmaEvent(row: {
  id: string;
  eventType: KarmaEventType;
  amount: number;
  sourceType: string;
  sourceId: string;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}) {
  const meta = (row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {}) as Record<string, unknown>;
  const sourceLabel = typeof meta.title === "string" ? meta.title : null;
  return {
    id: row.id,
    eventType: row.eventType,
    label: KARMA_EVENT_LABELS[row.eventType],
    amount: row.amount,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceLabel,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Server-side free-text filter for a member's karma history. Matches the
 * same two things the row actually renders — the source title (stored in
 * KarmaEvent.metadata.title, which is what `sourceLabel` serializes) and the
 * event-kind label ("Accepted item", "Completed audit", …) — plus an exact
 * source id, so pasting an id from a link lands on its award. Returns
 * undefined for an empty term so callers can spread it away entirely.
 *
 * Label matching happens here in JS against KARMA_EVENT_LABELS rather than in
 * SQL because the label is display copy for an enum, not a stored column. */
function karmaSearchFilter(term: string | undefined): Prisma.KarmaEventWhereInput | undefined {
  const q = term?.trim();
  if (!q) return undefined;
  const lowered = q.toLowerCase();
  const labelMatches = (Object.entries(KARMA_EVENT_LABELS) as [KarmaEventType, string][])
    .filter(([, label]) => label.toLowerCase().includes(lowered))
    .map(([eventType]) => eventType);
  return {
    OR: [
      { metadata: { path: ["title"], string_contains: q, mode: "insensitive" } },
      ...(labelMatches.length ? [{ eventType: { in: labelMatches } }] : []),
      { sourceId: q },
    ],
  };
}

/** Real cursor-paginated KarmaEvent query for one member, shared by the
 * initial /karma load and the "load more history" follow-up request. */
async function getKarmaEventsPage(
  userId: string,
  opts: { eventType?: KarmaEventType; cursor?: string; limit: number; from?: Date; to?: Date; q?: string },
) {
  const search = karmaSearchFilter(opts.q);
  const where: Prisma.KarmaEventWhereInput = {
    userId,
    ...(opts.eventType ? { eventType: opts.eventType } : {}),
    ...(opts.from || opts.to
      ? { createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
      : {}),
    ...(search ?? {}),
  };

  const eventCount = await prisma.karmaEvent.count({ where });

  // Resolve the cursor row explicitly before using it. Prisma does NOT raise
  // P2025 for a `cursor` that matches nothing on findMany — measured, not
  // assumed: it returns an empty page with a 200, which the client reads as
  // "you have reached the end" instead of "reload from the top". That silently
  // truncates a member's history at a stale page boundary, so the anchor is
  // checked here (scoped to this member, so one member's cursor can never
  // address another's row) and the caller gets the 400 the route documents.
  // The P2025 catch below stays as a belt-and-braces guard for a row deleted
  // between this check and the query.
  if (opts.cursor) {
    const anchor = await prisma.karmaEvent.findFirst({ where: { id: opts.cursor, userId }, select: { id: true } });
    if (!anchor) throw new KarmaCursorError();
  }

  let rows;
  try {
    rows = await prisma.karmaEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw new KarmaCursorError();
    }
    throw err;
  }

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  return { events: page.map(serializeKarmaEvent), nextCursor, hasMore, eventCount };
}

/** Characters that must never survive into a stored string this API later
 * serves to anonymous readers: C0/C1 controls (NUL, CR/LF — log and header
 * injection) and the Unicode bidi overrides/isolates, which reorder RENDERED
 * text so a stored value can display as something other than what it is.
 *
 * Checked explicitly rather than left to a length bound or to the licence
 * allowlist below, because `language`/`framework` are free text by design and
 * are projected by `PUBLIC_DATASET_TYPE_SELECT` — they reach an unauthenticated
 * catalog reader once the request is minted, so the rejection has to be
 * deterministic rather than incidental. Verified live before this change: a
 * `proposedLicense` of `\u202eCC-BY-4.0` was accepted, stored, and served
 * verbatim by `GET /v1/bounties/:id`. */
const UNSAFE_TEXT_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** Bounded, control/bidi-free free text. Every string field on this endpoint
 * needs a `.max()`: without one `language` was stored at 2,500,000 characters
 * (verified live), and `language` is public post-mint. */
function safeText(max: number, min = 1) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !UNSAFE_TEXT_CHARS.test(v), {
      message: "Value must not contain control or bidirectional-override characters.",
    });
}

/** Closed licence allowlist, canonicalised to its SPDX spelling.
 *
 * This was `z.string().trim().min(2)` — no allowlist, no case folding and no
 * upper bound at all — on BOTH create and edit. The value is what contributors
 * are told they are working under and what publication maps to a licence tag,
 * and it is served to anonymous callers by `GET /v1/bounties/:id` once the
 * request is minted, so an unrecognised value is a trust problem rather than a
 * cosmetic one. Verified live before this change: script tags, path traversal,
 * SQL fragments, a 200,000-character string and a bidi-overridden id were all
 * accepted and carried through PATCH -> approve -> mint -> public read.
 *
 * The set is DERIVED from `BUNDLED_LICENSE_IDS` (lib/publication/
 * license-texts.ts) rather than hand-listed a second time: those are exactly
 * the licences whose full text this deployment can actually ship with a
 * published dataset, so a value outside them could never be honoured anyway.
 * `datasetLicense()` is that module's own case-insensitive lookup, which is
 * what folds `cc-by-4.0` onto `CC-BY-4.0` instead of rejecting it — existing
 * rows hold both spellings. Mirrors v1's `COMMUNITY_LICENSES` +
 * case-canonicalising transform (databounty-api/src/routes/v1/community.ts),
 * with the list shared instead of duplicated so it cannot drift from what
 * publication can serve. */
const proposedLicenseField = safeText(60, 3).transform((raw, ctx) => {
  const canonical = datasetLicense(raw)?.spdx;
  if (!canonical) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unsupported licence. Choose one of: ${BUNDLED_LICENSE_IDS.join(", ")}.`,
    });
    return z.NEVER;
  }
  return canonical;
});

/** The named presets the planner offers, and the only values
 * `resolvePoolDifficulty` (routes/v1/admin-community.ts) can actually resolve.
 * This was a bare `z.string()`: `"qa_api_freeform_difficulty"` stored fine
 * (verified live) and then resolved to `intermediate` at mint time, pricing
 * karma as though intermediate had been chosen with nothing on the record
 * saying it never was. Shared with the planner's own `answersSchema`
 * (services/planner.ts `PLANNER_DIFFICULTY_MIXES`), which already used an
 * enum, so the two entry points into the same column agree.
 *
 * Unlike v1 there is deliberately NO `custom:<a>/<b>/<c>` spec here: this
 * deployment has no `deriveSlots`, and `resolvePoolDifficulty` collapses the
 * mix to one pool difficulty, so a custom weight spec has nothing to act on
 * and would be silently flattened. */
const difficultyMixField = z.enum(PLANNER_DIFFICULTY_MIXES);

/** Bounded id, matching v1's `datasetTypeId: z.string().trim().min(1).max(100)`.
 * Was unbounded; a 200KB value was accepted and stored (verified live). */
const datasetTypeIdField = safeText(100);

const requestDatasetBody = z.object({
  title: safeText(120, 5),
  description: z.string().trim().min(20).max(2000),
  datasetTypeId: datasetTypeIdField.optional(),
  domain: z.nativeEnum(DomainId).default(DomainId.coding),
  proposedLicense: proposedLicenseField.default("CC-BY-4.0"),
  language: safeText(60).optional(),
  framework: safeText(60).optional(),
  targetItems: z.number().int().min(10).max(100_000).default(100),
  difficultyMix: difficultyMixField.optional(),
  auditCoveragePct: z.number().int().min(0).max(100).default(10),
  // Bounded too: this is a client-supplied uniqueness key, and it was
  // `z.string().min(1)` with no ceiling.
  idempotencyKey: safeText(200).default(() => `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
});

// Edit body (PATCH /requests/:id): every field the requester supplied on
// create, all optional so a caller only sends what changed. Each field reuses
// the SAME validator as create above — the two shapes were previously written
// out twice and had already drifted (edit's `proposedLicense` was as unchecked
// as create's, and a PATCH is exactly how the carry-through to the public read
// was reproduced).
const editRequestBody = z.object({
  title: safeText(120, 5),
  description: z.string().trim().min(20).max(2000),
  datasetTypeId: datasetTypeIdField,
  domain: z.nativeEnum(DomainId),
  proposedLicense: proposedLicenseField,
  language: safeText(60),
  framework: safeText(60),
  targetItems: z.number().int().min(10).max(100_000),
  difficultyMix: difficultyMixField,
  auditCoveragePct: z.number().int().min(0).max(100),
}).partial().strict();

// Statuses where the requester can still change what they asked for. Once a
// reviewer has moved a request past initial triage (approved/implemented) or
// it's under dispute, the request text must stay what was actually reviewed.
const REQUEST_EDITABLE_STATUSES: DatasetRequestStatus[] = [
  DatasetRequestStatus.submitted,
  DatasetRequestStatus.under_review,
  DatasetRequestStatus.changes_requested,
  DatasetRequestStatus.declined,
];

const requestsMineQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(200).optional(),
  status: z.nativeEnum(DatasetRequestStatus).optional(),
});

const resubmitBody = z.object({ note: z.string().trim().max(4_000).optional() }).strict();
const disputeBody = z.object({ reason: z.string().trim().min(1).max(4_000) }).strict();
const commentBody = z.object({ body: z.string().trim().min(1).max(4_000), internalOnly: z.boolean().optional() }).strict();

/** One option per case-folded language, labelled with the spelling most rows
 * actually use, sorted alphabetically.
 *
 * KEPT deliberately after write-time canonicalisation landed (2026-09-07,
 * `canonicalLanguageFor` in services/planner.ts, now applied on request
 * create/edit/finalize and on both admin mint doors). Folding on write fixes
 * the common case at the source but does NOT make this redundant, for two
 * independent reasons:
 *
 *  1. Canonicalisation is intentionally incomplete. A template whose language
 *     support is `any` or `none` declares no spelling to fold onto, and
 *     inventing one would fabricate a contract value — so `canonicalLanguageFor`
 *     returns such input verbatim. `Bounty.language` on those templates is
 *     therefore still free text, and two casings of one language remain
 *     reachable through a supported path (covered by
 *     community.language-canonicalisation.integration.test.ts, which stores
 *     `hAskell` and asserts it survives).
 *  2. Existing rows are not rewritten. Write-time folding is not retroactive,
 *     and normalising history is a backfill migration, not a code change.
 *
 * The data as of 2026-09-07 happens to hold no case-collision in either the
 * local dev database or the verification database (checked with
 * `select lower(language), count(distinct language) ... having count > 1` on
 * `bounties` and `dataset_requests`; both empty), so removing this today would
 * not have surfaced a duplicate immediately — it would just have removed the
 * guard shortly before reason 1 reintroduced one. Note also that the
 * `language` filter matches case-insensitively (services/bounties.ts), so two
 * entries here are two dropdown rows for one filter returning identical rows,
 * not two real choices. */
function dedupeLanguagesByCase(rows: { language: string | null; _count: { _all: number } }[]): string[] {
  const best = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    const label = row.language?.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    const current = best.get(key);
    if (!current || row._count._all > current.count) best.set(key, { label, count: row._count._all });
  }
  return [...best.values()].map((v) => v.label).sort((a, b) => a.localeCompare(b));
}

export async function communityRoutes(app: FastifyInstance) {
  // Global Community Stats
  app.get("/stats", async (_req, reply) => {
    const stats = await getCommunityStats();
    return reply.send(stats);
  });

  // Open Leaderboard
  app.get("/leaderboard", async (req, reply) => {
    const query = req.query as { limit?: string; cursor?: string; tier?: string; q?: string };
    const validTiers = new Set(["dharma", "bodhi", "moksha", "nirvana"]);
    const tier = query.tier && validTiers.has(query.tier) ? (query.tier as "dharma" | "bodhi" | "moksha" | "nirvana") : undefined;
    const leaderboard = await getLeaderboard({
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor ?? null,
      tier,
      q: query.q,
    });
    return reply.send(leaderboard);
  });

  // List Community Pools — the contributor dashboard's "Open pools" browse
  // list (app/(app)/contributor/view.tsx). Returns {pools, nextCursor} with
  // karmaPricing/poolSummary/datasetType per pool; opaque cursor, not offset.
  app.get("/pools", async (req, reply) => {
    const parsed = z.object({
      limit: z.coerce.number().int().min(1).max(50).optional(),
      cursor: z.string().trim().min(1).max(200).optional(),
      q: z.string().trim().max(120).optional(),
      difficulty: z.string().trim().max(50).optional(),
      domain: z.nativeEnum(DomainId).optional(),
      datasetTypeId: z.string().trim().min(1).max(120).optional(),
    }).strip().safeParse(req.query);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid pools query.");
    }
    const query = parsed.data;
    const result = await listOpenPoolsForContributor({
      limit: query.limit,
      cursor: query.cursor,
      q: query.q,
      difficulty: query.difficulty,
      domain: query.domain,
      datasetTypeId: query.datasetTypeId,
    });
    return reply.send(result);
  });

  // Public list query params, ported from V1's `catalogQuery`
  // (databounty-api/src/routes/v1/community.ts:305). `cursor` is the opaque
  // last-row id — this codebase's keyset convention, never OFFSET. Filters are
  // applied server-side; the client never receives an unfiltered set to filter
  // itself. `.strip()` (not `.strict()`) so an unknown param is ignored rather
  // than 400-ing an existing caller.
  const catalogQuery = z
    .object({
      cursor: publicText(100).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(24),
      offset: z.coerce.number().int().min(0).max(100000).optional(),
      domain: z.nativeEnum(DomainId).optional(),
      category: z.nativeEnum(DatasetCategory).optional(),
      publicationStatus: z.nativeEnum(CommunityPublicationStatus).optional(),
      // Server-side search/filters for the public browser. Bounded lengths so
      // a pathological `q` can't be turned into an expensive scan.
      q: publicText(120).optional(),
      language: publicText(60).optional(),
      datasetTypeId: publicText(100).optional(),
      phase: phaseSchema.optional(),
      withPoolSummary: queryBoolean,
    })
    .strip();


  // GET /v1/community/catalog — public community-dataset grid.
  //
  // `bounties` + `nextCursor` is the payload V1 serves from this exact path
  // (V1 community.ts:594) and the shape its two real consumers read:
  // `apps/web/app/datasets/page.tsx` and Landing's `fetchLandingCatalog()`
  // (`apps/landing/lib/public-data.ts:127`). It was missing here — this route
  // only listed dataset-TYPE templates — so both surfaces read `bounties` off
  // a `{datasetTypes}` body, got `undefined`, and rendered permanently empty.
  //
  // `datasetTypes` is kept alongside it, unchanged: it is not V1's shape for
  // this path, but it is what this deployment's already-shipped callers and
  // integration tests (admin-dataset-types, boot) assert on, and dropping it
  // would break them for no parity gain. `domain`/`category` filter both
  // lists; `cursor`/`limit`/`publicationStatus` page and filter the dataset
  // listing only (the type catalog is small and unpaginated, as before).
  app.get("/catalog", async (req, reply) => {
    const parsed = catalogQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid catalog query.");
    const { cursor, offset, limit, domain, category, publicationStatus, q, language, datasetTypeId, phase, withPoolSummary } =
      parsed.data;

    const where: Prisma.DatasetTypeWhereInput = {
      status: "active",
      ...(domain ? { domain } : {}),
      ...(category ? { category } : {}),
    };

    let catalogResult;
    try {
      catalogResult = await listCommunityCatalog({
        cursor,
        offset,
        limit,
        domain,
        category,
        publicationStatus,
        q,
        language,
        datasetTypeId,
        statuses: phase ? PHASE_STATUSES[phase] : undefined,
        withPoolSummary,
      });
    } catch (error) {
      // A stale cursor is the caller's state to fix, not a server fault.
      if (error instanceof InvalidCursorError) return reply.badRequest(error.message);
      throw error;
    }

    const [types, catalog, languageCounts] = await Promise.all([
      prisma.datasetType.findMany({ where, select: PUBLIC_DATASET_TYPE_SELECT, orderBy: { usageCount: "desc" } }),
      Promise.resolve(catalogResult),
      // Language options describe the whole community catalog, not the current
      // page or the current filter — selecting one must never be able to hide
      // a valid later page (same rule listOpenPoolsForContributor follows).
      prisma.bounty.groupBy({
        by: ["language"],
        where: { kind: BountyKind.community, status: { notIn: [BountyStatus.cancelled] } },
        _count: { _all: true },
      }),
    ]);

    return reply.send({
      bounties: catalog.bounties,
      nextCursor: catalog.nextCursor,
      total: catalog.total,
      limit: catalog.limit,
      offset: catalog.offset,
      hasMore: catalog.hasMore,
      datasetTypes: types,
      filterOptions: {
        // Folded by case, because the `language` filter itself is
        // case-insensitive: listing both "typescript" and "TypeScript" offered
        // two dropdown entries that are the same filter and return the same
        // rows. The most-used spelling wins as the label.
        languages: dedupeLanguagesByCase(languageCounts),
      },
    });
  });

  // GET /v1/community/validation-queue — open pools that have items waiting on
  // a human validator, deepest queue first, plus the true totals across every
  // such pool (not just the returned page). Public and unauthenticated: it
  // reports only counts already visible on each pool's public page.
  app.get("/validation-queue", async (req, reply) => {
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).default(6),
        offset: z.coerce.number().int().min(0).max(100000).optional(),
        q: publicText(120).optional(),
      })
      .strip()
      .safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid query.");
    const result = await listValidationQueuePools(parsed.data);
    return reply.send(result);
  });

  // GET /v1/community/catalog/:id — public community-dataset detail.
  //
  // Same defect and same fix as the list route above: V1 serves `{ bounty }`
  // from this path (V1 community.ts:635), which is what Landing's
  // `fetchBounty()` reads (apps/landing/lib/public-data.ts:161). This route
  // only ever looked the id up as a dataset-TYPE id, so every community
  // dataset detail request 404'd and Landing silently fell through to its
  // paid-bounty fallback.
  //
  // `datasetType` is kept alongside `bounty` — the two lookups have disjoint
  // id spaces (a Bounty cuid can never be a DatasetType slug), so at most one
  // is ever populated and neither can shadow the other. No shipped caller or
  // test reads `datasetType` from this path today, but this is the only public
  // route that exposes a dataset type's VERIFIED harnesses, and quietly
  // deleting that capability while here to fix an unrelated shape bug would be
  // a second regression, not a cleanup. 404 only when NEITHER resolves.
  app.get("/catalog/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [bounty, datasetType] = await Promise.all([
      getCommunityCatalogDataset(id),
      prisma.datasetType.findUnique({
        where: { id },
        select: {
          ...PUBLIC_DATASET_TYPE_SELECT,
          harnesses: { where: { status: "verified" }, select: PUBLIC_HARNESS_SELECT },
        },
      }),
    ]);
    if (!bounty && !datasetType) return reply.notFound("Community dataset not found.");
    return reply.send({
      ...(bounty ? { bounty } : {}),
      ...(datasetType ? { datasetType } : {}),
    });
  });

  // Request a Dataset
  //
  // Rate-limited like its own PATCH/DELETE/resubmit/dispute siblings below,
  // which all carry one. This route did not: 40 sequential creates returned
  // 40x 201 with no 429 (verified live), and each one lands a row in the admin
  // review queue. Matched to `resubmit`'s 20/hour rather than the edit routes'
  // 30, since both of those put NEW work in front of a reviewer. Static
  // because this deployment has no `getRateLimitSettings()` equivalent of
  // v1's admin-configurable `ratelimit.community_requests.*`.
  app.post("/requests", { preHandler: [requireAuth, requireVerifiedEmail], config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = requestDatasetBody.safeParse(req.body);
    // `issues[0].message` — the single actionable line — not
    // `error.message`, which is the whole serialized ZodError array. Matches
    // what PATCH /requests/:id and the other routes in this file already do.
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid dataset request.");

    const data = parsed.data;

    // `datasetTypeId` is `.optional()` on this schema (unlike the PATCH body's
    // required field), but nothing downstream can proceed without one — an
    // omitted id previously reached `findUnique({ where: { id: undefined } })`
    // unguarded, which Prisma throws on synchronously with its full schema
    // dumped into the error, and that raw exception reached the client as an
    // unhandled 500 (verified live). A missing id is a client input error, not
    // a server fault.
    if (!data.datasetTypeId) return reply.badRequest("datasetTypeId is required.");

    // Coherence against the type this request names — the check this door
    // never had. It previously wrote `datasetTypeId`, `language`,
    // `difficultyMix` and `auditCoveragePct` straight through without so much
    // as loading the type, so a direct API call could create a request whose
    // difficulty mix the type does not offer and whose language its contract
    // cannot verify. The planner UI blocks all of that client-side; this is
    // the same rule server-side, shared with `validateAnswers` so the two
    // creation paths cannot drift.
    //
    // Also closes a related gap: `datasetTypeId` had no existence or status
    // check here at all, so a `platform_review` type was accepted and could
    // be approved, failing only much later at mint with "not activated yet".
    const datasetType = await prisma.datasetType.findUnique({ where: { id: data.datasetTypeId } });
    if (!datasetType) return reply.badRequest("That dataset template does not exist.");
    if (!isLaunchableType(datasetType)) {
      return reply.badRequest("This dataset type is not open for new requests yet.");
    }
    const incoherent = coherenceProblems(datasetType, data);
    if (incoherent.length > 0) return reply.badRequest(incoherent[0]!);

    // Fold the language onto the template's own spelling before storing it
    // (see canonicalLanguageFor) so listings do not accumulate one row per
    // casing of the same language.
    const canonicalLanguage = canonicalLanguageFor(datasetType, data.language);

    const request = await prisma.datasetRequest.create({
      data: {
        requesterUserId: user.id,
        title: data.title,
        description: data.description,
        datasetTypeId: data.datasetTypeId,
        domain: data.domain,
        proposedLicense: data.proposedLicense,
        language: canonicalLanguage,
        framework: data.framework,
        targetItems: data.targetItems,
        difficultyMix: data.difficultyMix,
        auditCoveragePct: data.auditCoveragePct,
        idempotencyKey: data.idempotencyKey,
        status: DatasetRequestStatus.submitted,
      },
    });

    return reply.status(201).send({ request });
  });

  // List Dataset Requests -- ADMIN-ONLY, and a duplicate.
  //
  // This shipped with no preHandler, returning every dataset request across
  // all users (including `requesterUserId`) to any unauthenticated caller.
  // V1's counterpart gates the same listing behind
  // `requireRole(...ADMIN_AND_ABOVE_READONLY)`, and so does this deployment's
  // own canonical copy at `admin-community.ts` (`GET /v1/admin/community/
  // requests`) -- which is the one the admin console actually calls. Every
  // other `/requests*` route in this file already requires auth, including
  // `GET /requests/:id`: listing every request anonymously while needing a
  // session to read ONE is incoherent, which is what marks this as a dropped
  // guard rather than a deliberate public endpoint.
  //
  // Gated rather than deleted: it is reachable today, so a 403 is a clearer
  // answer than a 404 for anything already calling it. It has no caller in
  // web, admin or landing, and the guarded admin route supersedes it -- so
  // removing it outright is the tidier end state, left as an owner call.
  // Members read their own via `GET /requests/mine` (auth'd), which is what
  // the member UI uses.
  app.get("/requests", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (req, reply) => {
    const query = req.query as { limit?: string; offset?: string; status?: DatasetRequestStatus };
    const take = Math.min(query.limit ? Number(query.limit) : 50, 100);
    const skip = query.offset ? Number(query.offset) : 0;

    const where: Prisma.DatasetRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.datasetRequest.findMany({
        where,
        include: {
          requester: { select: { id: true, displayName: true, handle: true } },
          datasetType: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.datasetRequest.count({ where }),
    ]);

    return reply.send({ requests: items, total, limit: take, offset: skip });
  });

  // GET /v1/community/requests/mine — the caller's own dataset requests,
  // keyset-paginated over (createdAt desc, id desc) so the cursor stays
  // stable when two requests share a timestamp.
  app.get("/requests/mine", { preHandler: requireAuth }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsedQ = requestsMineQuery.safeParse(req.query);
    if (!parsedQ.success) return reply.badRequest(parsedQ.error.issues[0]?.message ?? "Invalid request query.");
    const { cursor, limit, q, status } = parsedQ.data;
    const requesterUserId = actor.id;
    const where: Prisma.DatasetRequestWhereInput = {
      requesterUserId,
      ...(status ? { status } : {}),
      ...(q ? { title: { contains: q, mode: Prisma.QueryMode.insensitive } } : {}),
    };
    const rows = await prisma.datasetRequest.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const requests = rows.slice(0, limit);
    const nextCursor = hasMore ? requests[requests.length - 1]?.id ?? null : null;
    // Aggregate status counts for the caller's WHOLE request set, ignoring
    // `q`/`status`/`cursor` so a filter can never change the totals.
    const grouped = await prisma.datasetRequest.groupBy({
      by: ["status"],
      where: { requesterUserId },
      _count: { _all: true },
    });
    const countOf = (...statuses: DatasetRequestStatus[]) =>
      grouped.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0);
    const statusCounts = {
      total: grouped.reduce((sum, row) => sum + row._count._all, 0),
      inReview: countOf(
        DatasetRequestStatus.submitted,
        DatasetRequestStatus.under_review,
        DatasetRequestStatus.changes_requested,
        DatasetRequestStatus.disputed,
      ),
      approved: countOf(DatasetRequestStatus.approved, DatasetRequestStatus.implemented),
      declined: countOf(DatasetRequestStatus.declined),
    };
    const mintedIds = [...new Set(requests.map((r) => r.mintedBountyId).filter((x): x is string => Boolean(x)))];
    const mintedPools = await Promise.all(mintedIds.map((id) => getCommunityPool(id)));
    const mintedById = new Map(mintedIds.map((id, i) => [id, mintedPools[i] ?? null]));
    return reply.send({
      requests: requests.map((r) => ({
        ...r,
        mintedBounty: r.mintedBountyId ? mintedById.get(r.mintedBountyId) ?? null : null,
      })),
      nextCursor,
      statusCounts,
    });
  });

  // GET /v1/community/requests/:id — a requester's own single request, for
  // the detail/edit page. Owner-scoped (404 otherwise so it can't be used to
  // probe other users' requests). Also carries `samples`/`sampleGate` — the
  // web detail page (components/dataset-request-detail.tsx) requires
  // `sampleGate` to be non-null before it renders the reference-samples
  // section at all, so omitting these here made that section invisible for
  // every request regardless of status. Reuses the exact same
  // services/artifacts.ts helpers the admin request-list route
  // (routes/v1/admin-community.ts) uses for its own sampleGate column, so the
  // sponsor and an admin never see different counts for the same request.
  app.get("/requests/:id", { preHandler: requireAuth }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const id = (req.params as { id: string }).id;
    const request = await prisma.datasetRequest.findUnique({
      where: { id },
      include: { datasetType: { select: { name: true, version: true } } },
    });
    if (!request || request.requesterUserId !== actor.id) return reply.notFound("Dataset request not found.");
    const mintedBounty = request.mintedBountyId ? await getCommunityPool(request.mintedBountyId) : null;
    const samples = await listDatasetRequestSamples(request.id);
    return reply.send({
      request: {
        ...request,
        datasetTypeName: request.datasetType?.name ?? null,
        datasetTypeVersion: request.datasetType?.version ?? null,
        mintedBounty,
      },
      samples: samples.map(serializeArtifact),
      sampleGate: sampleGateFromSamples(samples),
    });
  });

  // Requester edits their own request's content while it's still open to
  // change. Owner-only; gated to REQUEST_EDITABLE_STATUSES so a request
  // already approved can't be rewritten out from under the reviewer who
  // signed off on it. Does NOT change status or resubmitCount.
  app.patch("/requests/:id", { preHandler: [requireAuth, requireVerifiedEmail], config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = editRequestBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "Invalid dataset request edit.");
    if (Object.keys(parsed.data).length === 0) return reply.badRequest("No fields to update.");
    const id = (req.params as { id: string }).id;
    // Whole row, not `select: { id: true }`: canonicalising the language below
    // needs the type's `fields` (that is what `languageSupportFor` reads), and
    // this lookup already had to happen to prove the type exists.
    let patchedType: DatasetType | null = null;
    if (parsed.data.datasetTypeId) {
      patchedType = await prisma.datasetType.findUnique({ where: { id: parsed.data.datasetTypeId } });
      if (!patchedType) return reply.badRequest("Unknown dataset type.");
    }
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dataset_requests WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.datasetRequest.findUnique({ where: { id } });
      if (!existing) return null;
      if (existing.requesterUserId !== actor.id) return "forbidden" as const;
      if (!REQUEST_EDITABLE_STATUSES.includes(existing.status)) return "invalid_transition" as const;

      // Same write-time canonicalisation `POST /requests` applies, because an
      // edit is the OTHER door onto the same stored column: a PATCH is how the
      // mixed-casing carry-through to the public read was reproduced in the
      // first place. The template to fold onto is the one the row will END UP
      // naming — the patched type when the caller changed it, the stored one
      // otherwise — so a caller who switches type and language in one PATCH is
      // canonicalised against the type they switched TO.
      const data = { ...parsed.data };
      const effectiveType =
        patchedType ??
        (existing.datasetTypeId ? await tx.datasetType.findUnique({ where: { id: existing.datasetTypeId } }) : null);

      // Coherence on the EDIT path too, not only on create.
      //
      // This was initially left out as a behaviour change ("edits accepted
      // before would start failing"), but V1 settles it: `editRequestBody` is
      // `z.object(requestBodyShape).partial().strict()`
      // (v1 databounty-api/src/routes/v1/community.ts:158) — literally the
      // create shape — so every validation create applies, the edit path
      // applies too. Gating here is parity; leaving it ungated was the
      // deviation, and it left a real hole: a direct PATCH could store a
      // language the template cannot verify on a type whose trust tier claims
      // execution verification, which is the exact incoherence create now
      // refuses.
      //
      // Merged view, not the patch alone: a partial edit is coherent only
      // against the row it produces. Checking `parsed.data` in isolation would
      // pass a language-only edit that contradicts the stored difficulty mix,
      // and vice versa.
      if (effectiveType) {
        const merged = {
          language: data.language !== undefined ? data.language : existing.language,
          difficultyMix: data.difficultyMix !== undefined ? data.difficultyMix : existing.difficultyMix,
        };
        const incoherent = coherenceProblems(effectiveType, merged);
        if (incoherent.length > 0) return { badRequest: incoherent[0]! } as const;
      }

      if (data.language !== undefined && effectiveType) {
        data.language = canonicalLanguageFor(effectiveType, data.language) ?? undefined;
      }

      const updated = await tx.datasetRequest.update({ where: { id }, data });
      await writeAuditLog(tx, {
        actorUserId: actor.id,
        action: "community_request.edited",
        targetType: "dataset_request",
        targetId: id,
        before: Object.fromEntries(Object.keys(data).map((k) => [k, (existing as Record<string, unknown>)[k]])),
        // The values actually STORED, casing included — an audit row saying
        // `typescript` for a write that landed `TypeScript` would misreport it.
        after: data,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.id,
      });
      return updated;
    });
    if (!result) return reply.notFound("Dataset request not found.");
    if (result === "forbidden") return reply.forbidden("Only the requester can edit this request.");
    if (result === "invalid_transition") return reply.conflict("This request can no longer be edited — it's past the point a reviewer signed off on its terms.");
    // Must precede the success send: this result union now carries a rejection
    // object, and without this branch an incoherent edit fell through to a
    // 200 whose body was `{request: {badRequest: "..."}}` — a silent success
    // for a write that never happened. `tsc` does not catch it, because the
    // union member is structurally a valid `result`.
    if (typeof result === "object" && result !== null && "badRequest" in result) {
      return reply.badRequest(result.badRequest);
    }
    return reply.send({ request: result });
  });

  // Requester withdraws (deletes) their own request while it's still pending
  // a decision. Same status gate as edit.
  app.delete("/requests/:id", { preHandler: [requireAuth, requireVerifiedEmail], config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const id = (req.params as { id: string }).id;
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dataset_requests WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.datasetRequest.findUnique({ where: { id } });
      if (!existing) return null;
      if (existing.requesterUserId !== actor.id) return "forbidden" as const;
      if (!REQUEST_EDITABLE_STATUSES.includes(existing.status)) return "invalid_transition" as const;
      // DatasetRequestComment.request is onDelete: Cascade, so the review
      // thread goes with it.
      await tx.datasetRequest.delete({ where: { id } });
      await writeAuditLog(tx, { actorUserId: actor.id, action: "community_request.withdrawn", targetType: "dataset_request", targetId: id, before: { status: existing.status, title: existing.title }, ip: req.ip, userAgent: req.headers["user-agent"], requestId: req.id });
      return "ok" as const;
    });
    if (!result) return reply.notFound("Dataset request not found.");
    if (result === "forbidden") return reply.forbidden("Only the requester can withdraw this request.");
    if (result === "invalid_transition") return reply.conflict("This request can no longer be withdrawn — it's past the point a reviewer signed off on its terms.");
    return reply.code(204).send();
  });

  // Requester resubmits after changes_requested (or a plain declined).
  // Uncapped loop; rate-limited as the only anti-abuse. Owner-only. Sends
  // the request back to under_review.
  app.post("/requests/:id/resubmit", { preHandler: [requireAuth, requireVerifiedEmail], config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = resubmitBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("Invalid resubmission.");
    const id = (req.params as { id: string }).id;
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dataset_requests WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.datasetRequest.findUnique({ where: { id } });
      if (!existing) return null;
      if (existing.requesterUserId !== actor.id) return "forbidden" as const;
      if (existing.status !== DatasetRequestStatus.changes_requested && existing.status !== DatasetRequestStatus.declined) {
        return "invalid_transition" as const;
      }
      const updated = await tx.datasetRequest.update({
        where: { id },
        data: { status: DatasetRequestStatus.under_review, resubmitCount: { increment: 1 } },
      });
      if (parsed.data.note) {
        await tx.datasetRequestComment.create({ data: { requestId: id, authorUserId: actor.id, authorRole: "sponsor", body: parsed.data.note } });
      }
      await writeAuditLog(tx, { actorUserId: actor.id, action: "community_request.resubmitted", targetType: "dataset_request", targetId: id, before: { status: existing.status }, after: { status: updated.status, resubmitCount: updated.resubmitCount }, ip: req.ip, userAgent: req.headers["user-agent"], requestId: req.id });
      return updated;
    });
    if (!result) return reply.notFound("Dataset request not found.");
    if (result === "forbidden") return reply.forbidden("Only the requester can resubmit this request.");
    if (result === "invalid_transition") return reply.conflict("This request cannot be resubmitted from its current state.");
    await notifyAdmins({
      type: "community.request_resubmitted",
      title: "Dataset request resubmitted",
      body: `"${result.title}" was resubmitted for review.`,
      entityType: "dataset_request",
      entityId: id,
      eventKey: `${id}:resubmit:${result.resubmitCount}`,
    });
    return reply.send({ request: result });
  });

  // Requester disputes a decline. Escalates to a handler; never
  // auto-overturns. Owner-only, from a declined decision.
  app.post("/requests/:id/dispute", { preHandler: [requireAuth, requireVerifiedEmail], config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = disputeBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("A dispute reason is required.");
    const id = (req.params as { id: string }).id;
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dataset_requests WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.datasetRequest.findUnique({ where: { id } });
      if (!existing) return null;
      if (existing.requesterUserId !== actor.id) return "forbidden" as const;
      if (existing.status !== DatasetRequestStatus.declined) return "invalid_transition" as const;
      const updated = await tx.datasetRequest.update({ where: { id }, data: { status: DatasetRequestStatus.disputed } });
      await tx.datasetRequestComment.create({ data: { requestId: id, authorUserId: actor.id, authorRole: "sponsor", body: parsed.data.reason } });
      await writeAuditLog(tx, { actorUserId: actor.id, action: "community_request.disputed", targetType: "dataset_request", targetId: id, before: { status: existing.status }, after: { status: updated.status }, ip: req.ip, userAgent: req.headers["user-agent"], requestId: req.id });
      return updated;
    });
    if (!result) return reply.notFound("Dataset request not found.");
    if (result === "forbidden") return reply.forbidden("Only the requester can dispute this request.");
    if (result === "invalid_transition") return reply.conflict("Only a declined request can be disputed.");
    await notifyAdmins({
      type: "community.request_disputed",
      title: "Dataset request disputed",
      body: `"${result.title}"'s decline was disputed.`,
      entityType: "dataset_request",
      entityId: id,
      eventKey: `${id}:disputed`,
    });
    return reply.send({ request: result });
  });

  // Threaded, append-only review conversation. Visible to the requester and
  // platform reviewers only; the requester never sees internal-only notes.
  app.get("/requests/:id/comments", { preHandler: requireAuth }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const id = (req.params as { id: string }).id;
    const request = await prisma.datasetRequest.findUnique({ where: { id }, select: { requesterUserId: true } });
    if (!request) return reply.notFound("Dataset request not found.");
    const isReviewer = actor.roles.some((r) => r === "admin" || r === "member" || r === "support");
    if (request.requesterUserId !== actor.id && !isReviewer) return reply.forbidden("You cannot view this request's conversation.");
    const comments = await prisma.datasetRequestComment.findMany({
      where: { requestId: id, ...(isReviewer ? {} : { internalOnly: false }) },
      orderBy: { createdAt: "asc" },
      select: { id: true, authorUserId: true, authorRole: true, body: true, internalOnly: true, createdAt: true },
    });
    return reply.send({ comments });
  });

  app.post("/requests/:id/comments", { preHandler: [requireAuth, requireVerifiedEmail], config: { rateLimit: { max: 60, timeWindow: "1 hour" } } }, async (req, reply) => {
    const actor = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = commentBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("A comment body is required.");
    const id = (req.params as { id: string }).id;
    const request = await prisma.datasetRequest.findUnique({ where: { id }, select: { requesterUserId: true, title: true } });
    if (!request) return reply.notFound("Dataset request not found.");
    const isReviewer = actor.roles.some((r) => r === "admin" || r === "member" || r === "support");
    const isRequester = request.requesterUserId === actor.id;
    if (!isRequester && !isReviewer) return reply.forbidden("You cannot comment on this request.");
    const internalOnly = isReviewer ? (parsed.data.internalOnly ?? false) : false;
    const comment = await prisma.datasetRequestComment.create({
      data: { requestId: id, authorUserId: actor.id, authorRole: isReviewer ? "reviewer" : "sponsor", body: parsed.data.body, internalOnly },
    });
    if (!internalOnly) {
      if (isRequester) {
        await notifyAdmins({
          type: "community.request_comment_added",
          title: "New reply on a dataset request",
          body: `"${request.title}" has a new message from the requester.`,
          entityType: "dataset_request",
          entityId: id,
          eventKey: `${id}:comment:${comment.id}`,
        });
      } else {
        await notifyUser({
          userId: request.requesterUserId,
          type: "community.request_comment_added",
          title: "New reply on your dataset request",
          body: `"${request.title}" has a new message from a reviewer.`,
          entityType: "dataset_request",
          entityId: id,
          eventKey: `${id}:comment:${comment.id}`,
        });
      }
    }
    return reply.code(201).send({ comment });
  });

  // GET /v1/community/batches — the legacy per-contributor claimed-batch
  // listing (contributor/community workspace "Claimable community batches"
  // section). No code path in this deployment creates a ContributorBatch row
  // — bounty creation is open-pool-only (see the schema comment on
  // Bounty.poolDifficulty) — so `batches` is honestly always empty and
  // `claimsEnabled` is honestly false (there is no POST .../claim route to
  // enable). This exists for API-shape parity with the funded listing so the
  // shared frontend client can call it uniformly rather than 404ing.
  app.get("/batches", async (req, reply) => {
    const query = req.query as { cursor?: string; limit?: string; q?: string; difficulty?: string };
    const limit = Math.min(Math.max(query.limit ? Number(query.limit) : 50, 1), 200);
    const where: Prisma.ContributorBatchWhereInput = {
      status: ContributorBatchStatus.available,
      ...(query.difficulty ? { difficulty: query.difficulty } : {}),
      ...(query.q ? { bounty: { title: { contains: query.q, mode: Prisma.QueryMode.insensitive } } } : {}),
    };
    const rows = await prisma.contributorBatch.findMany({
      where,
      include: { bounty: { select: { id: true, title: true, karmaPerAcceptedItem: true, communityLicense: true, datasetType: { select: { name: true, domain: true } } } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return reply.send({
      claimsEnabled: false,
      batches: page.map((batch) => ({
        id: batch.id,
        itemCount: batch.itemCount.toString(),
        difficulty: batch.difficulty,
        deadline: batch.deadline,
        bounty: batch.bounty,
        claimableAt: null,
        claimable: null,
        claimableLabel: null,
        claimableOnLabel: null,
      })),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    });
  });

  // GET /v1/community/batches/count — open ContributorBatch rows on karma-only
  // community bounties, matching a contributor's watch-filter categories/
  // languages. Note: open-pool community bounties (the current default
  // creation path — COMMUNITY_OPEN_POOL_PLAN_V2) deliberately never create a
  // ContributorBatch row at all (see the schema comment on Bounty.poolDifficulty),
  // so this count only reflects legacy/slotted community bounties that still
  // use per-contributor batch claiming. That's a genuine, not fabricated,
  // reflection of this deployment's current bounty-creation architecture.
  app.get("/batches/count", { preHandler: [requireAuth] }, async (req, reply) => {
    const query = req.query as { categories?: string; languages?: string };
    const categories = parseCsv(query.categories) as DatasetCategory[];
    const languages = parseCsv(query.languages);

    const where: Prisma.ContributorBatchWhereInput = {
      status: ContributorBatchStatus.available,
      ...(categories.length ? { category: { in: categories } } : {}),
      ...(languages.length ? { bounty: { language: { in: languages } } } : {}),
    };

    const total = await prisma.contributorBatch.count({ where });
    return reply.send({ total });
  });

  // Public Member Profile
  app.get("/members/:handle", async (req, reply) => {
    const { handle } = req.params as { handle: string };
    const user = await prisma.user.findUnique({
      where: { handle: handle.toLowerCase() },
      select: {
        id: true,
        displayName: true,
        handle: true,
        profilePublic: true,
        publicProfilePrefs: true,
        karmaTotal: true,
        leaderboardRank: true,
        badges: {
          include: { badge: true },
          orderBy: { earnedAt: "desc" },
        },
        _count: {
          select: {
            submissions: { where: { status: "accepted" } },
          },
        },
        createdAt: true,
      },
    });

    if (!user || (!user.profilePublic && !user.handle)) {
      return reply.notFound("Member not found or profile is private");
    }

    return reply.send({
      member: {
        id: user.id,
        displayName: user.displayName,
        handle: user.handle,
        karmaTotal: user.karmaTotal,
        tier: (await resolveKarmaTier(user.karmaTotal)).current,
        leaderboardRank: user.leaderboardRank,
        acceptedItemsCount: user._count.submissions,
        badges: user.badges.map((b) => ({ badge: b.badge, earnedAt: b.earnedAt })),
        joinedAt: user.createdAt,
      },
    });
  });

  // Karma summary for the signed-in member's own dashboard/karma page:
  // balance, tier progress, secured-vs-in-review breakdown, and any
  // not-yet-released holds.
  //
  // Schema/architecture note: this API awards karma IMMEDIATELY on
  // acceptance (services/validation.ts / services/audits.ts call
  // `awardKarma` straight into KarmaEvent + User.karmaTotal — there is no
  // dispute-window hold-then-release cycle wired up yet, even though the
  // `PendingKarmaAward` table exists in the schema for it). So `pendingTotal`
  // and `holds` below are genuine queries against that table, and they will
  // honestly read empty/zero until a hold-and-release pipeline is built —
  // this is not a stub, it is what the server actually does today.
  // Similarly, `inReviewValidator` is 0: nothing in this codebase tracks a
  // per-validator claimed-audit count (audit windows are shared/quota-based,
  // not claimed), so there is no "open audits" figure to report honestly
  // other than zero.
  app.get("/karma", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = req.query as {
      view?: string;
      limit?: string;
      cursor?: string;
      eventType?: string;
      from?: string;
      to?: string;
      q?: string;
    };

    const isHistoryView = query.view === "history";
    const limit = Math.min(Math.max(query.limit ? Number(query.limit) : 25, 1), 100);
    const eventType =
      query.eventType && (Object.values(KarmaEventType) as string[]).includes(query.eventType)
        ? (query.eventType as KarmaEventType)
        : undefined;
    // Unparseable dates are dropped (filter simply not applied) rather than
    // erroring — a malformed ?from= in a shared/bookmarked URL should degrade
    // to the unfiltered view, not a 400 on the whole karma page.
    const parseDate = (value?: string) => {
      if (!value) return undefined;
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : undefined;
    };
    const from = parseDate(query.from);
    const to = parseDate(query.to);

    let page: Awaited<ReturnType<typeof getKarmaEventsPage>>;
    try {
      page = await getKarmaEventsPage(user.id, { eventType, cursor: query.cursor, limit, from, to, q: query.q });
    } catch (err) {
      if (err instanceof KarmaCursorError) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "This page of karma history is out of date. Reload from the start.",
        });
      }
      throw err;
    }

    // The "load more history" follow-up request only needs the page of
    // events — skip the rest of the summary work entirely.
    if (isHistoryView) {
      return reply.send({ events: page.events, nextCursor: page.nextCursor, hasMore: page.hasMore, eventCount: page.eventCount });
    }

    // Ensure any badge the member newly qualifies for is granted BEFORE we
    // read which ones are earned below. Without this, a member who just
    // crossed a threshold (e.g. accepted-items count) would see that badge
    // rendered as not-earned on their own karma page until some unrelated
    // surface happened to trigger the sync first — the exact bug this route
    // must not have, since this is the one page whose whole job is showing
    // the member their real badge state.
    await syncAndListBadges(user.id);

    const [breakdown, pendingAgg, reversedAgg, inReviewSubs, holdRows, disputeWindowHoursDefault, holdsEnabled, eventTypeGroups, viewerUser, badges, earnedBadgeRows, { tiers: liveTiers }, catalogFacts, { rules: karmaRules }, { matrix: liveKarmaMatrix }] = await Promise.all([
      getKarmaBreakdown(user.id),
      prisma.pendingKarmaAward.aggregate({
        where: { userId: user.id, releasedAt: null, reversedAt: null },
        _sum: { amount: true },
      }),
      prisma.karmaEvent.aggregate({
        where: { userId: user.id, eventType: KarmaEventType.community_item_reversed },
        _sum: { amount: true },
      }),
      prisma.submission.findMany({
        where: { contributorUserId: user.id, status: { in: [...IN_REVIEW_SUBMISSION_STATUSES] } },
        select: {
          bounty: {
            select: {
              karmaPerAcceptedItem: true,
              poolDifficulty: true,
              karmaQuote: true,
              datasetTypeId: true,
              datasetType: { select: { complexityScore: true, verificationUnits: true } },
            },
          },
        },
      }),
      prisma.pendingKarmaAward.findMany({
        where: { userId: user.id, releasedAt: null, reversedAt: null },
        include: {
          bounty: {
            select: {
              id: true,
              title: true,
              kind: true,
              disputeCycleWindowOpensAt: true,
              disputeWindowHours: true,
              publicationStatus: true,
            },
          },
        },
      }),
      getAdminSetting<number>("community.dispute_window_hours", 48),
      karmaHoldsEnabled(),
      // Real distinct eventType values that exist for THIS member — the
      // filter dropdown only ever offers options that actually have history
      // behind them, so it can never lead to a dead "no matches" filter.
      prisma.karmaEvent.groupBy({ by: ["eventType"], where: { userId: user.id }, _count: { id: true } }),
      prisma.user.findUnique({ where: { id: user.id }, select: { handle: true, profilePublic: true, status: true } }),
      listBadges(),
      prisma.userBadge.findMany({ where: { userId: user.id }, select: { badgeId: true } }),
      getKarmaTiers(),
      catalogPricingFacts(),
      getKarmaRules(),
      getKarmaMatrix(),
    ]);

    if (!breakdown) return reply.notFound("User not found");

    // A member only actually appears on GET /v1/community/leaderboard when
    // they meet all of getLeaderboard()'s where-clause conditions — surface
    // a rank here only when that's genuinely true, not just because
    // User.leaderboardRank happens to hold a stale value.
    const openLeaderboardRank =
      viewerUser?.profilePublic && viewerUser.handle && viewerUser.status === UserStatus.active && breakdown.totalKarma > 0
        ? breakdown.leaderboardRank
        : null;

    const earnedBadgeIds = new Set(earnedBadgeRows.map((b) => b.badgeId));
    const badgeCatalog = badges.map((b) => ({
      key: b.key,
      family: b.family,
      icon: b.icon,
      label: b.label,
      criteria: b.criteria,
      earned: earnedBadgeIds.has(b.id),
    }));

    // liveTiers is the admin-configured `karma.tiers` (or the code default
    // when nothing is stored) — not the static KARMA_TIERS constant — so this
    // ladder matches whatever tier resolveKarmaTier() just picked above via
    // getKarmaBreakdown().
    const tiers = liveTiers.map((t) => ({
      name: t.tier,
      label: t.label,
      minKarma: t.minKarma,
      color: t.color,
      blurb: t.blurb,
      perks: t.perks,
      earlyAccessHours: t.earlyAccessHours,
      concurrencyBonus: t.concurrencyBonus,
      state: (t.tier === breakdown.tier.current.tier
        ? "current"
        : breakdown.totalKarma >= t.minKarma
          ? "unlocked"
          : "locked") as "current" | "unlocked" | "locked",
    }));

    const eventTypeFilters = eventTypeGroups
      .map((g) => ({ value: g.eventType as string, label: KARMA_EVENT_LABELS[g.eventType] }))
      .sort((a, b) => a.label.localeCompare(b.label));

    // Only the KarmaEventType/amount pairs that a real awardKarma(...) call
    // site in this codebase actually pays today (services/validation.ts,
    // services/audits.ts, routes/v1/admin-community.ts) — community_flag_confirmed,
    // community_bounty_published, and community_publish_bonus are declared
    // enum members with no live award path, so they're left out rather than
    // listed as if they currently pay.
    const earnRules = [
      {
        key: KarmaEventType.community_item_accepted,
        label: "Accepted item",
        description:
          "Awarded the moment your submitted item is finally accepted. The rate is set per bounty (its karma-per-accepted-item value) and shown on the bounty itself.",
        amount: null,
        perProgram: true,
      },
      {
        key: KarmaEventType.community_audit_completed,
        label: "Completed audit",
        // Not always this flat rate any more: a priced dataset type pays the
        // complexity x review-load matrix cell instead (see the pricing
        // section above); `amount` here is only the fallback for an unpriced
        // type, same caveat as `community_item_accepted`'s per-bounty rate.
        description: "Per item you audit as a validator — the priced rate for that category, or this flat rate for an unpriced one.",
        amount: 8,
        perProgram: false,
      },
      {
        key: KarmaEventType.community_request_approved,
        label: "Approved dataset request",
        description: "Awarded once when an admin approves a dataset request you filed.",
        amount: 25,
        perProgram: false,
      },
    ];

    // Real per-item pricing rather than the raw `karmaPerAcceptedItem` column:
    // that column is 0 for every auto-priced pool (the matrix sentinel), which
    // previously projected 0 karma for in-review work on any priced category.
    const inReviewProjected = inReviewSubs.reduce((sum, s) => {
      if (!s.bounty) return sum;
      const typePricing = effectiveTypePricing(s.bounty.datasetTypeId, s.bounty.datasetType, liveKarmaMatrix);
      const { amount } = acceptedItemKarmaForBounty(
        s.bounty.karmaPerAcceptedItem,
        s.bounty.poolDifficulty,
        s.bounty.karmaQuote,
        karmaRules,
        typePricing
      );
      return sum + amount;
    }, 0);

    // Server-owned pricing render model (KARMA_PRICING_MATRIX_PLAN.md) for
    // the member karma page's PricingSection/TierItemsSection — previously
    // absent, so both sections had nothing to render. `example`/`catalogMaxKarma`
    // come from a real, live-priced dataset type (`catalogPricingFacts`), never
    // a hypothetical one.
    const matrix = karmaMatrixView(undefined, catalogFacts.maxKarma, catalogFacts.example);
    const tierItemEstimates = {
      lowest: { karmaPerItem: matrix.lowestKarma, tiers: itemsNeededPerTier(matrix.lowestKarma, liveTiers) },
      catalogHighest:
        catalogFacts.maxKarma !== null
          ? { karmaPerItem: catalogFacts.maxKarma, tiers: itemsNeededPerTier(catalogFacts.maxKarma, liveTiers) }
          : null,
    };

    // Group unresolved PendingKarmaAward rows by (bounty, role) — a bounty
    // could in principle carry both a contributor and a validator hold for
    // the same member.
    const groups = new Map<string, { bountyId: string; bountyTitle: string; bountyKind: string; role: KarmaHoldRole; amount: number; awardCount: number; disputeWindowHours: number | null; windowOpensAt: Date | null; publicationStatus: string }>();
    for (const row of holdRows) {
      const role = roleForKarmaEventType(row.eventType);
      const key = `${row.bountyId}:${role}`;
      const existing = groups.get(key);
      if (existing) {
        existing.amount += row.amount;
        existing.awardCount += 1;
      } else {
        groups.set(key, {
          bountyId: row.bountyId,
          bountyTitle: row.bounty.title,
          bountyKind: row.bounty.kind,
          role,
          amount: row.amount,
          awardCount: 1,
          disputeWindowHours: row.bounty.disputeWindowHours,
          windowOpensAt: row.bounty.disputeCycleWindowOpensAt,
          publicationStatus: row.bounty.publicationStatus,
        });
      }
    }

    const holds = Array.from(groups.values()).map((g) => {
      const windowHours = g.disputeWindowHours ?? disputeWindowHoursDefault;
      const windowClosesAt =
        g.windowOpensAt && windowHours ? new Date(g.windowOpensAt.getTime() + windowHours * 3_600_000) : null;
      const disputeWindowOpen = windowClosesAt !== null && windowClosesAt.getTime() > Date.now();
      const reason = disputeWindowOpen
        ? "dispute_window_open"
        : g.publicationStatus === "failed"
          ? "publication_failed"
          : "awaiting_publication";
      const explanation =
        reason === "dispute_window_open"
          ? `Held while the sponsor's ${windowHours}h window to raise a problem with "${g.bountyTitle}" is open.`
          : reason === "publication_failed"
            ? `"${g.bountyTitle}" failed to publish — this award is held until it's resolved.`
            : `Held until "${g.bountyTitle}" is published.`;
      return {
        bountyId: g.bountyId,
        bountyTitle: g.bountyTitle,
        bountyKind: g.bountyKind,
        role: g.role,
        amount: g.amount,
        awardCount: g.awardCount,
        reason,
        disputeWindowHours: g.disputeWindowHours,
        windowClosesAt: windowClosesAt ? windowClosesAt.toISOString() : null,
        publicationStatus: g.publicationStatus,
        explanation,
      };
    });

    const holdsByRole: Record<KarmaHoldRole, { pending: number; awardCount: number }> = {
      contributor: { pending: 0, awardCount: 0 },
      validator: { pending: 0, awardCount: 0 },
      sponsor: { pending: 0, awardCount: 0 },
    };
    for (const h of holds) {
      holdsByRole[h.role].pending += h.amount;
      holdsByRole[h.role].awardCount += h.awardCount;
    }

    return reply.send({
      total: breakdown.totalKarma,
      handle: viewerUser?.handle ?? null,
      openLeaderboardRank,
      tier: {
        name: breakdown.tier.current.tier,
        label: breakdown.tier.current.label,
        color: breakdown.tier.current.color,
        blurb: breakdown.tier.current.blurb,
        perks: breakdown.tier.current.perks,
        earlyAccessHours: breakdown.tier.current.earlyAccessHours,
        concurrencyBonus: breakdown.tier.current.concurrencyBonus,
      },
      nextTier: breakdown.tier.next
        ? {
            name: breakdown.tier.next.tier,
            label: breakdown.tier.next.label,
            minKarma: breakdown.tier.next.minKarma,
            karmaToGo: breakdown.tier.next.minKarma - breakdown.totalKarma,
            perks: breakdown.tier.next.perks,
          }
        : null,
      tiers,
      events: page.events,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      eventCount: page.eventCount,
      eventTypeFilters,
      earnRules,
      matrix,
      tierItemEstimates,
      badgeCatalog,
      pendingTotal: pendingAgg._sum.amount ?? 0,
      reversedTotal: Math.abs(reversedAgg._sum.amount ?? 0),
      inReview: { items: inReviewSubs.length, projectedKarma: inReviewProjected },
      // Structural gap noted above: no per-validator claimed-audit tracking
      // exists yet, so this is honestly zero rather than fabricated.
      inReviewValidator: { openAudits: 0, openItems: 0, projectedKarma: 0 },
      holds,
      holdsByRole,
      releaseRule: {
        // Mirrors the live `community.karma_holds.enabled` setting rather than
        // a hardcoded claim — this text used to say holds were the exception
        // ("a small number of bounties") from before the hold/release engine
        // was wired into any real accept path. Now that it is (all four
        // accept-item call sites route through awardOrHoldAcceptedItemKarma),
        // holds are the default for everyone unless an admin turns the
        // setting off, and the copy has to track that or it actively lies.
        summary: holdsEnabled
          ? "Karma from an accepted item is held until the sponsor's dispute window closes, then it lands in your balance."
          : "Karma from an accepted item lands in your balance as soon as it's accepted.",
        gates: [
          "Automated checks and, if sampled, a human validator pass the item.",
          "If a PendingKarmaAward hold exists for the bounty, the sponsor's dispute window must close with no upheld dispute.",
          "The dataset publishes (community bounties only) before any hold is released.",
        ],
        securedRelease: holdsEnabled
          ? "Accepted work is held until the sponsor's dispute window closes and, for community bounties, the dataset publishes. Nothing further is needed from you — it releases on its own once the window passes with no upheld dispute."
          : "Most accepted items award karma immediately — nothing further is needed from you. A small number of bounties place accepted work on hold until the sponsor's dispute window closes and the dataset publishes.",
        defaultDisputeWindowHours: disputeWindowHoursDefault,
        projectionCaveat: "In-review projections use each bounty's current karma-per-item rate and are not a promise — the final award depends on acceptance.",
      },
    });
  });
}
