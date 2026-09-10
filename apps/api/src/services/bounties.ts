// SPDX-License-Identifier: Apache-2.0

import { BountyStatus, BountyKind, CommunityPublicationStatus, DatasetCategory, DomainId, ArtifactKind, SponsorExampleReviewStatus, SubmissionStatus, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { PUBLIC_DATASET_TYPE_SELECT } from "../lib/public-query.js";
import { KARMA_RULES, getKarmaRules, getKarmaTiers, getLeaderboard } from "./karma.js";
import { buildPublicSamples, listBountyBriefArtifacts, serializeArtifact } from "./artifacts.js";
import { llmValidationEnabled } from "./admin-settings.js";
import { openRouterConfigured } from "./llm-client.js";
import { difficultyRequirement } from "../lib/difficulty-requirement.js";
import { sourceUploadRequirements } from "../lib/dataset-source-upload.js";
import { poolCapacityFor } from "./pool-capacity.js";
import { getPoolSubmitLimits } from "./submission-limits.js";
import { getArtifactData } from "./storage.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

export type PreparedSampleAsset = { fields: Record<string, string> };

/**
 * Fetch up to 5 admin-approved sponsor_reference artifacts matching `where`,
 * parse each as one flat {field: value} example, and return them in the exact
 * shape `DatasetType.sampleAssets` expects (admin-dataset-types.ts's own
 * `sampleAssetSchema`). Never throws — every write site that calls this
 * (mint, sponsor-example approval) is a real state transition that must still
 * succeed even if a sample can't be read, so one unreadable/malformed
 * artifact is skipped rather than failing the whole call.
 */
export async function buildApprovedSampleAssets(
  client: DbClient,
  where: Prisma.ArtifactWhereInput
): Promise<PreparedSampleAsset[]> {
  const approved = await client.artifact.findMany({
    where: {
      ...where,
      kind: ArtifactKind.sponsor_reference,
      sponsorReviewStatus: SponsorExampleReviewStatus.approved,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    take: 5, // sampleAssetSchema caps the array at 5 (admin-dataset-types.ts)
    select: { storageKey: true },
  });
  const out: PreparedSampleAsset[] = [];
  for (const artifact of approved) {
    try {
      const parsed: unknown = JSON.parse((await getArtifactData(artifact.storageKey)).toString("utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" && key.length <= 80 && value.length <= 2000) fields[key] = value;
      }
      if (Object.keys(fields).length > 0) out.push({ fields });
    } catch {
      // One unreadable/malformed sample must not block the others.
    }
  }
  return out;
}

/**
 * True when writing `sampleAssets` onto `datasetTypeId` right now is safe:
 * it doesn't already carry samples (never silently overwrite an existing,
 * possibly hand-curated, set — admin-dataset-types.ts's manual editor is
 * still a legitimate way to set this), and no OTHER community bounty already
 * draws on the same type (writing would silently overwrite what THAT
 * bounty's own contributors see — two sponsors' pools can share one catalog
 * template, e.g. competitive_programming, code_translation, as of this
 * writing). `excludeBountyId` is the bounty being minted/approved right now,
 * so it never counts against itself.
 */
export async function safeToWriteSampleAssetsFor(
  client: DbClient,
  datasetTypeId: string,
  excludeBountyId: string | undefined,
  currentSampleAssets: unknown
): Promise<boolean> {
  if (currentSampleAssets != null) return false;
  const otherBounties = await client.bounty.count({
    where: {
      datasetTypeId,
      kind: BountyKind.community,
      ...(excludeBountyId ? { id: { not: excludeBountyId } } : {}),
    },
  });
  return otherBounties === 0;
}

/**
 * Escape the characters Postgres treats as wildcards inside an ILIKE pattern.
 *
 * Prisma compiles `contains` and `equals + mode:"insensitive"` to ILIKE with
 * the value interpolated as a parameter, so a user-supplied `%` or `_` is a
 * live wildcard, not a literal: `q=%` matched the entire catalog and
 * `language=%` defeated an exact filter. A lone trailing `\\` additionally
 * made Postgres reject the pattern outright (22025) and surfaced as a 500.
 * Escaping here keeps the search literal, which is what a search box means.
 */
/**
 * The single `poolSummary` (version 1) shape.
 *
 * It is built here, once, because the catalog grid and the pool contract
 * previously each assembled their own object under the SAME `version: 1`:
 * the catalog gained `accepted`/`flagged` while the contract kept
 * `awaitingCurrentWindowOutcome`, so a client reading the contract saw buckets
 * that under-summed `totalSubmitted` (an accepted-but-unsettled item was
 * invisible) and had no way to detect the discrepancy from the version number.
 */
export function buildPoolSummary(params: {
  counts: Record<string, number>;
  targetItems: number;
  clearedItems: number;
  finalAccepted: number;
}) {
  const c = params.counts;
  return {
    version: 1 as const,
    targetItems: params.targetItems,
    totalSubmitted: Object.values(c).reduce((sum, n) => sum + n, 0),
    finalAccepted: params.finalAccepted,
    capacityReserved: params.clearedItems,
    remainingToTarget: Math.max(0, params.targetItems - params.clearedItems),
    // No pool-close/rolling-window sampler runs in this deployment, so nothing
    // is ever actually "awaiting" a window; accepted_pending_sample is the
    // honest analog of "cleared automation, awaiting resolution".
    awaitingNextWindow: c.accepted_pending_sample ?? 0,
    awaitingCurrentWindowOutcome: 0,
    validatorReview: (c.in_audit ?? 0) + (c.provisionally_accepted ?? 0),
    sponsorReview: c.in_sponsor_review ?? 0,
    processing:
      (c.draft ?? 0) + (c.submitted ?? 0) + (c.duplicate_check ?? 0) + (c.running_tests ?? 0) + (c.llm_validation ?? 0),
    needsFixes: c.needs_fixes ?? 0,
    rejected: c.rejected ?? 0,
    failedAutomatedChecks: c.tests_failed ?? 0,
    disputed: c.disputed ?? 0,
    accepted: c.accepted ?? 0,
    flagged: c.flagged ?? 0,
  };
}

/**
 * A keyset cursor that no longer addresses a row inside the current query.
 *
 * Raised rather than paged over, because Prisma answers an unknown `cursor`
 * with an empty page — which a client cannot tell apart from "you have reached
 * the end". A caller that persisted a cursor across a deletion, a status
 * change, or a filter change would silently render an empty catalog and
 * conclude there was nothing there. A 400 tells it to restart paging.
 */
export class InvalidCursorError extends Error {
  constructor() {
    super("That pagination cursor is no longer valid. Restart from the first page.");
    this.name = "InvalidCursorError";
  }
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Opaque keyset cursor for the pool listing: base64url(`${createdAt}|${id}`)
 *  over the `[createdAt desc, id desc]` ordering below. Offset paging shifts
 *  under a newly minted pool; v1's catalog pages by cursor for that reason.
 *  `offset` is retained for existing callers and `cursor` wins over it. */
function encodePoolCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

export class PoolCursorError extends Error {}

function decodePoolCursor(cursor: string): { createdAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const createdAt = at ? new Date(at) : null;
  if (!id || !createdAt || Number.isNaN(createdAt.getTime())) throw new PoolCursorError("Invalid pool cursor.");
  return { createdAt, id };
}

export async function listCommunityPools(params?: {
  /** Dataset-type domain (coding / legal / healthcare / finance / science).
   * v1 exposes this on the same listing; it was missing here, so the broadest
   * axis an operator asks in had no filter. */
  domain?: string;
  category?: string;
  language?: string;
  cursor?: string;
  status?: BountyStatus;
  /** Lifecycle-phase filter (see PHASE_STATUSES in routes/v1/bounties.ts).
   * Replaces the default active/completed/closing set; a single explicit
   * `status` still wins over it. */
  statuses?: BountyStatus[];
  limit?: number;
  offset?: number;
}) {
  const take = Math.min(params?.limit ?? 50, 100);
  const skip = params?.offset ?? 0;

  const where: Prisma.BountyWhereInput = {
    kind: BountyKind.community,
    ...(params?.status
      ? { status: params.status }
      : params?.statuses
        ? { status: { in: params.statuses } }
        : { status: { in: [BountyStatus.active, BountyStatus.completed, BountyStatus.closing] } }),
    ...(params?.category ? { datasetCategory: params.category as any } : {}),
    ...(params?.domain ? { datasetType: { domain: params.domain as any } } : {}),
    ...(params?.language ? { language: { equals: escapeLikePattern(params.language), mode: "insensitive" } } : {}),
  };

  const decoded = params?.cursor ? decodePoolCursor(params.cursor) : null;
  const pageWhere: Prisma.BountyWhereInput = decoded
    ? { ...where, OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }] }
    : where;

  const [rows, total] = await Promise.all([
    prisma.bounty.findMany({
      where: pageWhere,
      include: {
        datasetType: {
          select: {
            id: true,
            name: true,
            domain: true,
            trustTier: true,
            fields: true,
          },
        },
        publications: { select: { target: true, status: true, url: true, pushedAt: true } },
        _count: {
          select: {
            submissions: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(decoded ? {} : { skip }),
    }),
    prisma.bounty.count({ where }),
  ]);

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const lastRow = items[items.length - 1];

  // Progress for the WHOLE page in one grouped query, not one per pool.
  // Without it a client wanting to know how far along each pool is had to call
  // the contract endpoint once per row — 50 round-trips to render one list —
  // and MCP agents were doing exactly that. One extra query here removes N.
  const statusRows = items.length
    ? await prisma.submission.groupBy({
        by: ["bountyId", "status"],
        where: { bountyId: { in: items.map((b) => b.id) } },
        _count: { _all: true },
      })
    : [];
  const countsByBounty = new Map<string, Record<string, number>>();
  for (const row of statusRows) {
    const bucket = countsByBounty.get(row.bountyId) ?? {};
    bucket[row.status] = row._count._all;
    countsByBounty.set(row.bountyId, bucket);
  }

  const serialized = items.map((b) => ({
    id: b.id,
    // Every row here is already scoped to `kind: community` (see `where`
    // above), but neither Landing app's `mapPublicBounty()` can tell —
    // it reads `row.kind` and defaults anything else to "paid", so a
    // community pool's card silently rendered with paid-bounty USDC copy.
    kind: BountyKind.community,
    title: b.title,
    description: b.description,
    datasetCategory: b.datasetCategory,
    language: b.language,
    framework: b.framework,
    targetItems: Number(b.targetItems),
    acceptedItems: Number(b.acceptedItems),
    finalAcceptedItems: Number(b.finalAcceptedItems),
    karmaPerAcceptedItem: b.karmaPerAcceptedItem,
    // The single level this pool is worked at and priced from, snapshotted
    // at mint. It was missing here while `get_pool_contract` returned it, so
    // the listing and the contract disagreed and the MCP listing description
    // claimed a `difficulty` the payload never carried. Null when the pool
    // declares none — deliberately NOT defaulted to a middle level.
    difficulty: b.poolDifficulty,
    status: b.status,
    publicationStatus: b.publicationStatus,
    huggingFaceDataset: b.huggingFaceDataset,
    publications: publicPublicationsOf(b.publications),
    publication: buildDatasetPublicationSummary(b.publicationStatus, b.publications, {
      finalAccepted: Number(b.finalAcceptedItems),
      targetItems: Number(b.targetItems),
    }),
    datasetType: b.datasetType,
    submissionCount: b._count.submissions,
    // Same shape, same field names and same meanings the contract endpoint
    // publishes, so a listing and a contract can never tell a different story
    // about the same pool.
    poolSummary: buildPoolSummary({
      counts: countsByBounty.get(b.id) ?? {},
      targetItems: Number(b.targetItems),
      clearedItems: Number(b.acceptedItems),
      finalAccepted: Number(b.finalAcceptedItems),
    }),
    createdAt: b.createdAt,
    deadline: b.deadline,
  }));

  // `bounties` is the key V1's GET /v1/bounties returns and the key the
  // Landing app reads; `items` is kept for existing callers of this service.
  return {
    bounties: serialized,
    items: serialized,
    total,
    limit: take,
    offset: decoded ? null : skip,
    hasMore,
    nextCursor: hasMore && lastRow ? encodePoolCursor(lastRow) : null,
  };
}

/** Public community-dataset grid backing GET /v1/community/catalog's
 * `bounties` payload — the listing V1's `/v1/community/catalog` returns and
 * that both `apps/web/app/datasets` and Landing's `fetchLandingCatalog()`
 * read. Ported from V1 `databounty-api/src/routes/v1/community.ts`
 * (`catalogQuery` + `CATALOG_SELECT` + `serializeCatalogBounty`, V1 lines
 * 305/542/558/594): same server-side filters (domain / category /
 * publicationStatus), same `[createdAt desc, id desc]` ordering, and the same
 * keyset pagination this codebase uses everywhere (Prisma `cursor:{id},
 * skip:1` over an opaque last-row id — never OFFSET).
 *
 * Two deliberate deviations from the V1 query, both because the V1 predicate
 * would be dead code here rather than a filter:
 *  - V1 also required `visibility: "public"`. Community bounties in THIS app
 *    are minted without ever setting `visibility` (see
 *    routes/v1/admin-community.ts's mint path), so every row keeps the schema
 *    default `"private"` and that predicate would return the empty set
 *    forever. The sibling public community listings here
 *    (`listCommunityPools`, `listOpenPoolsForContributor`) likewise scope on
 *    `kind: community` alone; this follows them.
 *  - V1's per-row `karmaPricing`/`poolSummary` came from
 *    `communityPricingSummary()` / `getCommunityPoolProgress()`, neither of
 *    which exists in this codebase. The karma figures below are computed the
 *    same way `listOpenPoolsForContributor` already computes them from real
 *    stored columns; nothing is invented for a field we cannot back.
 *
 * Karma-only by construction: no money, escrow, bond or payout field is
 * selected or emitted. */
const COMMUNITY_CATALOG_SELECT = {
  id: true,
  title: true,
  description: true,
  kind: true,
  datasetCategory: true,
  language: true,
  framework: true,
  status: true,
  targetItems: true,
  acceptedItems: true,
  finalAcceptedItems: true,
  karmaPerAcceptedItem: true,
  auditCoveragePct: true,
  communityLicense: true,
  communityLicenseUrl: true,
  publicationStatus: true,
  huggingFaceDataset: true,
  poolDifficulty: true,
  // A pool with poolClosedAt set has hit its target and takes no more
  // contributions, while its status stays "active" (it is still being
  // audited). Without this the Landing grid invited contributions to full
  // pools — and, sorting most-filled first, put them at the very top.
  poolClosedAt: true,
  createdAt: true,
  // A real delivery timestamp: when a publication target last completed
  // successfully. `updatedAt` was used for this at first, but it also moves on
  // every failure and retry, so a card labelled "delivered" was showing a
  // last-touched date. Null (row omitted by the client) is the honest answer
  // when nothing has actually been published.
  publications: { select: { pushedAt: true, target: true, status: true, url: true } },
  // `sampleAssets` added alongside the identity fields already here: the
  // public pool detail page renders admin-authored samples when present, and
  // this select — shared by the catalog list and the by-id detail route
  // below — was the only public-facing datasetType projection missing it
  // (getCommunityPool's own datasetType select already uses the full
  // PUBLIC_DATASET_TYPE_SELECT, which has carried this field since it was
  // introduced). Same allowlist discipline: a field already public via that
  // select and via /v1/meta/public-catalog, not a new disclosure.
  datasetType: { select: { id: true, name: true, domain: true, trustTier: true, sampleAssets: true } },
} satisfies Prisma.BountySelect;

type CommunityCatalogRow = Prisma.BountyGetPayload<{ select: typeof COMMUNITY_CATALOG_SELECT }>;

/** One catalog row, shared by the list and the by-id detail so the grid and
 * the detail page can never disagree about a field — V1 shares its
 * `serializeCatalogBounty` between `/catalog` and `/catalog/:id` for the same
 * reason. */
/** Real per-pool submission rollup, keyed by bounty id. Batched by
 * `communityPoolRollups()` below so the grid never issues one query per card.
 * Absent (undefined) means "not looked up", which the serializer reports as a
 * null `poolSummary` rather than as zeros — a missing count and a genuine zero
 * must not look alike. */
export type CommunityPoolRollup = {
  counts: Record<string, number>;
  /** Distinct people who have submitted to this pool. A real count, not a
   * default: the detail page previously rendered `0` for every pool because
   * the field was simply absent from the payload. */
  contributorCount: number;
  /** Distinct validators who have claimed an audit batch on this pool. */
  validatorCount: number;
  /** avg(Submission.duplicateScore) over this pool's scored submissions.
   * `null` when none have been scored yet — never a default 0, which would
   * read as "measured clean" rather than "not measured". */
  duplicateRate: number | null;
};

/** One grouped query for a whole page of pools. Mirrors the per-status maths
 * `getPoolContractForBounty()` already does for a single pool, so a card and
 * the pool page it opens can never disagree about what is awaiting a human
 * validator. */
export async function communityPoolRollups(bountyIds: string[]): Promise<Map<string, CommunityPoolRollup>> {
  const out = new Map<string, CommunityPoolRollup>();
  if (bountyIds.length === 0) return out;
  const [rows, contributorRows, validatorRows, duplicateRows] = await Promise.all([
    prisma.submission.groupBy({
      by: ["bountyId", "status"],
      where: { bountyId: { in: bountyIds } },
      _count: { _all: true },
    }),
    // Distinct people per pool: one grouped query, then counted in memory —
    // Prisma cannot express COUNT(DISTINCT x) grouped by another column.
    prisma.submission.groupBy({
      by: ["bountyId", "contributorUserId"],
      where: { bountyId: { in: bountyIds } },
    }),
    prisma.auditBatch.groupBy({
      by: ["bountyId", "validatorUserId"],
      where: { bountyId: { in: bountyIds } },
    }),
    // Same aggregate the admin console already runs globally
    // (admin-quality-metrics.ts), scoped per pool instead: avg(duplicateScore)
    // over submissions that have actually been scored.
    prisma.submission.groupBy({
      by: ["bountyId"],
      where: { bountyId: { in: bountyIds }, duplicateScore: { not: null } },
      _avg: { duplicateScore: true },
    }),
  ]);
  const byBounty = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const counts = byBounty.get(row.bountyId) ?? {};
    counts[row.status] = row._count._all;
    byBounty.set(row.bountyId, counts);
  }
  const contributors = new Map<string, number>();
  for (const row of contributorRows) contributors.set(row.bountyId, (contributors.get(row.bountyId) ?? 0) + 1);
  const validators = new Map<string, number>();
  for (const row of validatorRows) validators.set(row.bountyId, (validators.get(row.bountyId) ?? 0) + 1);
  const duplicateRates = new Map<string, number>();
  for (const row of duplicateRows) {
    if (row._avg.duplicateScore != null) duplicateRates.set(row.bountyId, row._avg.duplicateScore);
  }
  for (const id of bountyIds) {
    out.set(id, {
      counts: byBounty.get(id) ?? {},
      contributorCount: contributors.get(id) ?? 0,
      validatorCount: validators.get(id) ?? 0,
      duplicateRate: duplicateRates.get(id) ?? null,
    });
  }
  return out;
}

/** The most recent successful publication push, or null when nothing has been
 * published yet. Never falls back to a last-touched timestamp. */
function deliveredAtOf(publications: { pushedAt: Date | null }[]): string | null {
  const pushed = publications.map((p) => p.pushedAt).filter((d): d is Date => !!d);
  if (pushed.length === 0) return null;
  return new Date(Math.max(...pushed.map((d) => d.getTime()))).toISOString();
}

/**
 * Generic, public-safe projection of a bounty's publication fan-out. One
 * shared shape for every public serializer, so a future publication target
 * (the schema already reserves `aikosh` alongside `huggingface`/`github`)
 * appears everywhere a bounty's publications are shown without a second
 * per-target field and a second UI branch to add each time — the mistake this
 * replaces was adding a bespoke `githubDataset` field next to the existing
 * bespoke `huggingFaceDataset` one, which does not scale past two targets.
 * Only `published` rows with a confirmed `url` are included, and only the
 * fields a public caller should ever see — `lastError`, `attemptCount`,
 * `publishedByUserId` and `bundleArtifactId` are operational/admin detail,
 * never exposed here.
 */
export function publicPublicationsOf(
  publications: { target: string; status: string; url: string | null; pushedAt: Date | null }[]
): { target: string; url: string; pushedAt: string | null }[] {
  return publications
    .filter((p) => p.status === "published" && p.url)
    .map((p) => ({ target: p.target, url: p.url as string, pushedAt: p.pushedAt ? p.pushedAt.toISOString() : null }));
}

/** Human name per target, shared everywhere a publication is displayed. */
const PUBLICATION_TARGET_NAMES: Record<string, string> = {
  huggingface: "Hugging Face",
  github: "GitHub",
  aikosh: "AIKosh",
};

/** `CommunityPublicationStatus` (8 values, includes per-target-only states
 * like `not_configured`) collapsed onto the 5-state public vocabulary the
 * web app's `DatasetPublication`/`PublicationStatus` component already
 * defines. `not_configured` reads as "not published" rather than "failed":
 * nothing was attempted, so nothing actually failed — see the schema
 * comment on that enum value for why the two must stay distinct. */
function toPublicationState(raw: CommunityPublicationStatus): "not_published" | "queued" | "publishing" | "published" | "failed" {
  switch (raw) {
    case CommunityPublicationStatus.published:
      return "published";
    case CommunityPublicationStatus.publishing:
      return "publishing";
    case CommunityPublicationStatus.pending:
    case CommunityPublicationStatus.manual_review:
      return "queued";
    case CommunityPublicationStatus.failed:
      return "failed";
    case CommunityPublicationStatus.not_requested:
    case CommunityPublicationStatus.retracted:
    case CommunityPublicationStatus.not_configured:
    default:
      return "not_published";
  }
}

/**
 * The full public `DatasetPublication` contract the web app's
 * `parseDatasetPublication`/`PublicationStatus` component and the
 * `/datasets` gallery page already expect, but that nothing server-side has
 * ever populated — `publication` (or `poolSummary.publication`) was read
 * everywhere and produced everywhere by NOTHING, so every consumer of it
 * silently rendered as if nothing had ever published. This is that producer.
 *
 * `state`/`label`/`detail`/`datasetUrl`/`target` describe the bounty's
 * OVERALL publication (its most-published target, for a single compact
 * pill); `targets[]` carries the honest per-target breakdown `targets.find`
 * and `.map` calls in the frontend already rely on. Only a `published` row
 * with a confirmed `url` is ever linked — never a slug or URL guessed ahead
 * of a real push, same rule `huggingFaceDataset` already follows.
 */
export function buildDatasetPublicationSummary(
  publicationStatus: CommunityPublicationStatus,
  publications: { target: string; status: string; url: string | null }[],
  progress?: { finalAccepted: number; targetItems: number },
): {
  state: "not_published" | "queued" | "publishing" | "published" | "failed";
  label: string;
  detail: string;
  datasetUrl: string | null;
  target: string | null;
  targets: { target: string; name: string; state: "not_published" | "queued" | "publishing" | "published" | "failed"; url: string | null; attested: boolean }[];
  progress: { finalAccepted: number; targetItems: number; remainingToTarget: number } | null;
} {
  const targets = publications.map((p) => ({
    target: p.target,
    name: PUBLICATION_TARGET_NAMES[p.target] ?? p.target,
    state: toPublicationState(p.status as CommunityPublicationStatus),
    url: p.status === CommunityPublicationStatus.published ? p.url : null,
    // No `assisted_manual` provider is wired yet (both huggingface and
    // github are `kind: "automated"` — see lib/publication/*.ts); this stays
    // false until an AIKosh (or similar) admin-attested path exists.
    attested: false,
  }));

  const primary = targets.find((t) => t.state === "published") ?? null;
  const state = primary ? "published" : toPublicationState(publicationStatus);
  const label =
    state === "published"
      ? "Published"
      : state === "publishing"
        ? "Publishing…"
        : state === "queued"
          ? "Queued"
          : state === "failed"
            ? "Publish failed"
            : "Not yet published";
  const targetNames = targets.filter((t) => t.state === "published").map((t) => t.name);
  const detail =
    state === "published"
      ? `Live on ${targetNames.join(" and ")}, with DataBounty credit and contributor attribution.`
      : state === "publishing"
        ? "Uploading the accepted items to its publication target right now."
        : state === "queued"
          ? "Queued for publication — the push hasn't started yet."
          : state === "failed"
            ? "The push failed. An admin can retry it; nothing about the dataset itself is lost."
            : "This dataset has not been published yet.";

  return {
    state,
    label,
    detail,
    datasetUrl: primary?.url ?? null,
    target: (primary?.target as "huggingface" | "github" | "aikosh" | undefined) ?? null,
    targets,
    progress: progress ? { ...progress, remainingToTarget: Math.max(0, progress.targetItems - progress.finalAccepted) } : null,
  };
}

function serializeCommunityCatalogBounty(b: CommunityCatalogRow, rollup?: CommunityPoolRollup) {
  // BigInt columns must be converted before the reply is serialized: a raw
  // BigInt in the payload throws ("Do not know how to serialize a BigInt")
  // and turns the whole catalog into a 500 (V1 carries the same warning).
  const target = Number(b.targetItems);
  const cleared = Number(b.acceptedItems);
  const finalAccepted = Number(b.finalAcceptedItems);
  const plannedAuditItems = Math.round((target * b.auditCoveragePct) / 100);
  return {
    id: b.id,
    // Every row is scoped to `kind: community` by the queries below, but the
    // field is stated explicitly because Landing's mapPublicBounty() reads
    // `row.kind` and defaults anything else to "paid" — the same reason
    // listCommunityPools sets it.
    kind: b.kind,
    title: b.title,
    description: b.description,
    datasetCategory: b.datasetCategory,
    language: b.language,
    framework: b.framework,
    status: b.status,
    targetItems: String(target),
    // FINAL acceptance only (validator-passed / published), matching V1's
    // serializer: the stored `acceptedItems` column is the intake/capacity
    // counter and is exposed under its honest name, `clearedItems`.
    acceptedItems: String(finalAccepted),
    clearedItems: String(cleared),
    karmaPerAcceptedItem: b.karmaPerAcceptedItem,
    karmaPricing: {
      contributorPerItem: b.karmaPerAcceptedItem,
      contributorTotal: b.karmaPerAcceptedItem * target,
      validatorPerAuditedItem: KARMA_RULES.auditItem,
      plannedAuditItems,
      validatorTotal: plannedAuditItems * KARMA_RULES.auditItem,
    },
    auditCoveragePct: b.auditCoveragePct,
    communityLicense: b.communityLicense,
    communityLicenseUrl: b.communityLicenseUrl,
    publicationStatus: b.publicationStatus,
    huggingFaceDataset: b.huggingFaceDataset,
    publications: publicPublicationsOf(b.publications),
    // The full DatasetPublication contract apps/web's /datasets gallery and
    // PublicationStatus component already expect. `publications` above stays
    // for the simpler generic-link renders added alongside it.
    publication: buildDatasetPublicationSummary(b.publicationStatus, b.publications, { finalAccepted, targetItems: target }),
    // Renamed, not duplicated (V1 does the same): `difficulty` is the name
    // the pool contract uses. Null stays null — a pool minted before the
    // column existed has no declared difficulty.
    difficulty: b.poolDifficulty,
    datasetType: b.datasetType,
    poolClosedAt: b.poolClosedAt ? b.poolClosedAt.toISOString() : null,
    createdAt: b.createdAt,
    deliveredAt: deliveredAtOf(b.publications),
    // Real, or absent. Never a zero standing in for "not measured".
    ...(rollup
      ? { contributorCount: rollup.contributorCount, validatorCount: rollup.validatorCount, duplicateRate: rollup.duplicateRate }
      : {}),
    // Real counts from the submission table, never derived by subtracting two
    // capacity counters. `null` when no rollup was requested for this call, so
    // a consumer can tell "not looked up" from "looked up and zero".
    poolSummary: rollup
      ? buildPoolSummary({ counts: rollup.counts, targetItems: target, clearedItems: cleared, finalAccepted })
      : null,
  };
}

export async function listCommunityCatalog(params: {
  cursor?: string;
  /** Row offset for page-numbered navigation (the public /pools browser).
   * Ignored when `cursor` is supplied — keyset paging stays the default for
   * the infinite-scroll callers that already use it. */
  offset?: number;
  limit?: number;
  domain?: DomainId;
  category?: DatasetCategory;
  publicationStatus?: CommunityPublicationStatus;
  /** Free-text search over title/description. Server-side: the client is
   * never handed an unfiltered set to filter itself. */
  q?: string;
  language?: string;
  datasetTypeId?: string;
  /** Restrict to these lifecycle statuses (e.g. the delivered phase). */
  statuses?: BountyStatus[];
  /** Attach the real submission rollup to every row (one extra grouped
   * query). Off by default so existing callers pay nothing for it. */
  withPoolSummary?: boolean;
}) {
  const take = Math.min(params.limit ?? 24, 100);
  const skip = params.cursor ? 0 : Math.max(0, params.offset ?? 0);
  const q = params.q?.trim();

  const where: Prisma.BountyWhereInput = {
    kind: BountyKind.community,
    ...(params.statuses
      ? { status: { in: params.statuses } }
      : { status: { notIn: [BountyStatus.cancelled] } }),
    ...(params.category ? { datasetCategory: params.category } : {}),
    ...(params.domain ? { datasetType: { domain: params.domain } } : {}),
    ...(params.publicationStatus ? { publicationStatus: params.publicationStatus } : {}),
    ...(params.language ? { language: { equals: escapeLikePattern(params.language), mode: "insensitive" } } : {}),
    ...(params.datasetTypeId ? { datasetTypeId: params.datasetTypeId } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: escapeLikePattern(q), mode: "insensitive" as const } },
            { description: { contains: escapeLikePattern(q), mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  // A cursor must still address a row that this exact query would return.
  // Checking it up front is what makes "your cursor is stale" distinguishable
  // from "there is nothing left" — see InvalidCursorError.
  if (params.cursor) {
    const anchorRow = await prisma.bounty.findFirst({
      where: { ...where, id: params.cursor },
      select: { id: true },
    });
    if (!anchorRow) throw new InvalidCursorError();
  }

  const [rows, total] = await Promise.all([
    prisma.bounty.findMany({
      where,
      select: COMMUNITY_CATALOG_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : { skip }),
      take: take + 1,
    }),
    // Total for the CURRENT filter set, so the pager can say how many pages
    // exist instead of only "there is more".
    prisma.bounty.count({ where }),
  ]);

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const rollups = params.withPoolSummary
    ? await communityPoolRollups(page.map((row) => row.id))
    : undefined;

  return {
    bounties: page.map((row) => serializeCommunityCatalogBounty(row, rollups?.get(row.id))),
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    total,
    limit: take,
    offset: skip,
    hasMore,
  };
}

/** One public community dataset by id, backing GET /v1/community/catalog/:id's
 * `bounty` payload. Ported from V1 `databounty-api/src/routes/v1/community.ts`
 * (`GET /catalog/:id`, V1 line 635): same community-kind scope, same
 * cancelled-exclusion, and the same serializer as the grid above, so the
 * detail view and the card it was opened from agree field for field.
 *
 * Returns null (never a partially-populated object) when no community dataset
 * matches, so the route can 404 rather than answer with a hollow row. Carries
 * the same intentional `visibility` deviation documented on
 * listCommunityCatalog: community bounties are minted here without ever
 * setting `visibility`, so V1's `visibility: "public"` predicate would 404
 * every real row. */
export async function getCommunityCatalogDataset(id: string) {
  const row = await prisma.bounty.findFirst({
    where: { id, kind: BountyKind.community, status: { notIn: [BountyStatus.cancelled] } },
    select: COMMUNITY_CATALOG_SELECT,
  });
  if (!row) return null;
  // A single row, so the extra grouped query this costs is negligible —
  // unlike the list route, there's no per-page multiplier to gate behind
  // `withPoolSummary`. Without this, a pool's own permalink showed less
  // information (every count dashed out) than the card that linked to it.
  const rollups = await communityPoolRollups([row.id]);
  return serializeCommunityCatalogBounty(row, rollups.get(row.id));
}

function encodePoolsCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodePoolsCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Open-pool browse list for the contributor dashboard — the shape
 * app/(app)/contributor/view.tsx's OpenPool actually reads (karmaPricing,
 * poolSummary capacity fields, datasetType), with opaque-cursor paging
 * (GET /v1/community/pools). Distinct from listCommunityPools/getCommunityPool
 * above, which back other already-shipped callers and keep their existing
 * `{items,total,limit,offset}` shape untouched. */
export async function listOpenPoolsForContributor(params: {
  limit?: number;
  cursor?: string;
  q?: string;
  difficulty?: string;
  domain?: string;
  datasetTypeId?: string;
}) {
  const take = Math.min(params.limit ?? 12, 50);
  const skip = decodePoolsCursor(params.cursor);

  const where: Prisma.BountyWhereInput = {
    kind: BountyKind.community,
    status: BountyStatus.active,
    // A pool with poolClosedAt set has already hit its target and is closed
    // to new contributions (checkAndClosePoolIfTargetReached) — status stays
    // "active" (it's still being sampled/audited), so status alone isn't
    // enough. Without this, a 100%-full pool stayed listed here inviting a
    // submission the atomic claim in claimPoolAcceptanceSlot() would reject.
    poolClosedAt: null,
    ...(params.q?.trim() ? { title: { contains: params.q.trim(), mode: "insensitive" } } : {}),
    ...(params.difficulty && params.difficulty !== "all" ? { poolDifficulty: params.difficulty } : {}),
    ...(params.datasetTypeId ? { datasetTypeId: params.datasetTypeId } : {}),
    ...(params.domain ? { datasetType: { domain: params.domain as never } } : {}),
  };

  const [rows, datasetTypes] = await Promise.all([
    prisma.bounty.findMany({
      where,
      include: {
        datasetType: { select: { id: true, name: true, domain: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: take + 1,
      skip,
    }),
    // Options describe the whole open-pool queue rather than only the current
    // page, so selecting a domain/type can never hide a valid later page.
    prisma.datasetType.findMany({
      where: {
        status: "active",
        bounties: {
          some: {
            kind: BountyKind.community,
            status: BountyStatus.active,
            poolClosedAt: null,
          },
        },
      },
      select: { id: true, name: true, domain: true },
      orderBy: [{ domain: "asc" }, { name: "asc" }],
    }),
  ]);
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  const pools = page.map((b) => {
    const target = Number(b.targetItems);
    const cleared = Number(b.acceptedItems);
    const finalAccepted = Number(b.finalAcceptedItems);
    const plannedAuditItems = Math.round((target * b.auditCoveragePct) / 100);
    return {
      id: b.id,
      title: b.title,
      datasetCategory: b.datasetCategory,
      karmaPerAcceptedItem: b.karmaPerAcceptedItem,
      karmaPricing: {
        contributorPerItem: b.karmaPerAcceptedItem,
        contributorTotal: b.karmaPerAcceptedItem * target,
        validatorPerAuditedItem: KARMA_RULES.auditItem,
        plannedAuditItems,
        validatorTotal: plannedAuditItems * KARMA_RULES.auditItem,
      },
      communityLicense: b.communityLicense,
      targetItems: String(target),
      acceptedItems: String(finalAccepted),
      clearedItems: String(cleared),
      poolSummary: {
        capacityReserved: cleared,
        finalAccepted,
      },
      datasetType: b.datasetType,
    };
  });

  const nextCursor = hasMore ? encodePoolsCursor(skip + take) : null;
  return { pools, nextCursor, filterOptions: { datasetTypes } };
}

/** Submission statuses that mean "sitting with a human validator right now".
 * Same definition communityPoolRollups() and getPoolContractForBounty() use. */
const VALIDATOR_REVIEW_STATUSES = [SubmissionStatus.in_audit, SubmissionStatus.provisionally_accepted];

/**
 * Open pools that have items awaiting a human validator, deepest queue first,
 * plus the TRUE totals across every such pool.
 *
 * This exists because the caller (the Landing home page) can only render a
 * handful of cards but must not state a backlog figure derived from the page
 * it happens to have fetched — with 300+ pools, summing one page of 100
 * understated the real queue several-fold and could even claim "nothing is
 * waiting" while later pools had work. The aggregate is computed over the
 * whole set here; the cards are the top `limit` of it.
 */
export async function listValidationQueuePools(params?: {
  limit?: number;
  offset?: number;
  /** Free-text search over title/description, applied server-side to the same
   * set the totals are computed from. */
  q?: string;
}) {
  const take = Math.min(Math.max(params?.limit ?? 6, 1), 50);
  const skip = Math.max(params?.offset ?? 0, 0);
  const q = params?.q?.trim();

  // Depth lives in the submission table, so the queue has to be aggregated
  // before it can be ordered or paged. This groups every pool with audit work
  // (31 rows today) and slices in memory. That is fine at this size and is the
  // only way to report an honest backlog total, but it is the piece to replace
  // with a maintained per-bounty counter if the number of pools with open
  // audit work ever reaches the thousands.
  const grouped = await prisma.submission.groupBy({
    by: ["bountyId"],
    where: {
      status: { in: VALIDATOR_REVIEW_STATUSES },
      bounty: {
        kind: BountyKind.community,
        status: BountyStatus.active,
        ...(q
          ? {
              OR: [
                { title: { contains: escapeLikePattern(q), mode: "insensitive" as const } },
                { description: { contains: escapeLikePattern(q), mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
    },
    _count: { _all: true },
  });

  // Totals describe the whole matching set, never the page.
  const totalItems = grouped.reduce((sum, row) => sum + row._count._all, 0);
  const totalPools = grouped.length;

  const pageIds = grouped
    .slice()
    .sort((a, b) => b._count._all - a._count._all || a.bountyId.localeCompare(b.bountyId))
    .slice(skip, skip + take)
    .map((row) => row.bountyId);

  if (pageIds.length === 0) {
    return { bounties: [], totals: { items: totalItems, pools: totalPools }, total: totalPools, limit: take, offset: skip };
  }

  const [rows, rollups] = await Promise.all([
    prisma.bounty.findMany({ where: { id: { in: pageIds } }, select: COMMUNITY_CATALOG_SELECT }),
    communityPoolRollups(pageIds),
  ]);

  // findMany does not honour the order of an `in` list; re-apply the queue
  // ordering so "deepest queue first" is true of what the caller renders.
  const order = new Map(pageIds.map((id, i) => [id, i]));
  const bounties = rows
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((row) => serializeCommunityCatalogBounty(row, rollups.get(row.id)));

  return { bounties, totals: { items: totalItems, pools: totalPools }, total: totalPools, limit: take, offset: skip };
}

/**
 * `publicOnly` restricts the read to what a caller with NO credential may
 * see: a community pool in a publicly-listed status. Without it this was a
 * bare `findUnique` on the id, so the two PUBLIC_SCOPE MCP tools (`get_pool`,
 * `get_pool_contract`) served the full spec of a `draft`, `planning`,
 * `platform_review`, `paused` or `cancelled` pool — an unannounced dataset
 * contract, pre-approval — to anyone holding an id.
 *
 * The predicate is status + kind, deliberately NOT `visibility`. This app
 * mints community bounties without ever setting `visibility`, so every row
 * carries the schema default `private` (verified: 414/414 rows locally) and
 * V1's `visibility: "public"` predicate would 404 every pool here — the
 * intentional deviation already documented above. The status set is the same
 * one `listCommunityPools` uses for its public listing, so the detail view
 * and the list view agree on what "public" means.
 *
 * Internal callers (the community-request flows, which have already
 * authorized the caller) omit the flag and keep unrestricted access.
 */
export async function getCommunityPool(id: string, options?: { publicOnly?: boolean }) {
  const b = await prisma.bounty.findFirst({
    where: options?.publicOnly
      ? {
          id,
          kind: BountyKind.community,
          status: { in: [BountyStatus.active, BountyStatus.completed, BountyStatus.closing] },
        }
      : { id },
    include: {
      // Allowlisted: this row is served to anonymous callers by
      // GET /v1/bounties/:id, and the full model carries the curator-only
      // authorUserId / reviewNote / sponsorHarnessNote columns.
      datasetType: { select: PUBLIC_DATASET_TYPE_SELECT },
      requester: { select: { id: true, displayName: true, handle: true } },
      communityRequester: { select: { id: true, displayName: true, handle: true } },
      publications: { select: { target: true, status: true, url: true, pushedAt: true } },
      _count: {
        select: {
          submissions: true,
        },
      },
    },
  });

  if (!b) return null;

  const publicSamples = await buildPublicSamples(b.id);
  // Sponsor-side "reference examples" gate for the tracking page
  // (apps/web app/(app)/sponsor/[id]/view.tsx `needsSponsorExamples`). Same
  // approved-count definition `buildPublicSamples` above and
  // `sampleGateFromCounts` (services/artifacts.ts) already use for this
  // bounty's own reference samples — kept as a separate one-off count here
  // rather than reusing `buildSampleGate` because that helper is keyed by
  // `datasetRequestId` (pre-mint), and this is post-mint, keyed by `bountyId`.
  const approvedSponsorExamples = await prisma.artifact.count({
    where: {
      bountyId: b.id,
      kind: ArtifactKind.sponsor_reference,
      sponsorReviewStatus: SponsorExampleReviewStatus.approved,
      deletedAt: null,
    },
  });

  // Same distinct-people rollup the catalog card already shows
  // (communityPoolRollups, consumed by serializeCommunityCatalogBounty) —
  // this detail endpoint just never called it, so the sponsor's own
  // tracking page always showed 0 contributors/0 validators regardless of
  // real activity.
  const rollup = (await communityPoolRollups([b.id])).get(b.id);

  return {
    id: b.id,
    requiredSponsorExamples: Number(b.requiredSponsorExamples),
    approvedSponsorExamples,
    // See listCommunityPools' identical field for why this matters:
    // mapPublicBounty() on both Landing apps reads `row.kind` and defaults
    // to "paid" for anything else, so an unlabeled community pool silently
    // rendered with paid-bounty USDC copy.
    kind: b.kind,
    title: b.title,
    description: b.description,
    datasetCategory: b.datasetCategory,
    language: b.language,
    framework: b.framework,
    targetItems: Number(b.targetItems),
    acceptedItems: Number(b.acceptedItems),
    finalAcceptedItems: Number(b.finalAcceptedItems),
    karmaPerAcceptedItem: b.karmaPerAcceptedItem,
    // Distinct contributors/validators, all-time — same definition as the
    // catalog card, never scoped to "currently active" (see comment above).
    contributorCount: rollup?.contributorCount ?? 0,
    validatorCount: rollup?.validatorCount ?? 0,
    // Same rollup, same fix: this was computed two lines up and silently
    // dropped. null (not 0) when no submission has been scored yet — the
    // sponsor request-card reads it with a `!= null` guard specifically so
    // "not measured" and "measured at zero" stay distinguishable.
    duplicateRate: rollup?.duplicateRate ?? null,
    status: b.status,
    publicationStatus: b.publicationStatus,
    huggingFaceDataset: b.huggingFaceDataset,
    communityLicense: b.communityLicense,
    communityLicenseUrl: b.communityLicenseUrl,
    datasetType: b.datasetType,
    requester: b.communityRequester ?? b.requester,
    publications: publicPublicationsOf(b.publications),
    // Nested under poolSummary (not flat) because that is where
    // parseDatasetPublication/PublicationStatus in apps/web already read it
    // from (dataset-request-detail.tsx, community-request-card.tsx) — this
    // endpoint backs `request.mintedBounty` for a sponsor's own request
    // tracking, which predates and does not use serializeCommunityCatalogBounty's
    // flat `publication` field.
    poolSummary: {
      publication: buildDatasetPublicationSummary(b.publicationStatus, b.publications, {
        finalAccepted: Number(b.finalAcceptedItems),
        targetItems: Number(b.targetItems),
      }),
    },
    submissionCount: b._count.submissions,
    createdAt: b.createdAt,
    deadline: b.deadline,
    // Landing's `apps/landing/lib/public-data.ts#mapPublicBounty()` reads
    // this directly onto `Bounty.publicSamples`; see buildPublicSamples()
    // (services/artifacts.ts) for the honest availability gate.
    publicSamples,
  };
}

/** Real contributor-facing contract for an open community pool
 * (COMMUNITY_OPEN_POOL_PLAN_V2) — backs GET /v1/bounties/:id/contract.
 * `bounty.acceptedItems` in this DB row is the CLEARED/capacity-reserved
 * counter (incremented on every clean automated pass — see
 * services/validation.ts), never the final-accept counter, so it is exposed
 * here as `clearedItems`; `bounty.finalAcceptedItems` is exposed as the
 * honest `acceptedItems` (final acceptance only). */
/**
 * The pool submit limits, in ONE place. The capacity block picks
 * `recommendedPath` from `bulkThresholdItems` while `submitLimits` publishes
 * both numbers, so a literal in each spot is a guaranteed future drift.
 *
 * `maxItemsPerRequest` is the hard reject cap and must stay equal to the Zod
 * bound on the submit route and to SUBMISSION_ITEMS_HARD_MAX in
 * `mcp/core/limits.ts`. `bulkThresholdItems` is advisory only.
 */
export async function getPoolContractForBounty(bountyId: string, options?: { includeSponsorReferences?: boolean }) {
  const bounty = await prisma.bounty.findUnique({
    where: { id: bountyId },
    include: { datasetType: true },
  });
  if (!bounty || bounty.kind !== BountyKind.community || !bounty.datasetType) return null;

  const [llmEnabled, sponsorReferences, submitLimits] = await Promise.all([
    llmValidationEnabled(),
    options?.includeSponsorReferences ? listBountyBriefArtifacts(bountyId) : Promise.resolve([]),
    getPoolSubmitLimits(),
  ]);
  const target = Number(bounty.targetItems);
  const cleared = Number(bounty.acceptedItems);
  const finalAccepted = Number(bounty.finalAcceptedItems);

  const statusCounts = await prisma.submission.groupBy({
    by: ["status"],
    where: { bountyId },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const row of statusCounts) counts[row.status] = row._count._all;
  const totalSubmitted = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const processing =
    (counts.draft ?? 0) +
    (counts.submitted ?? 0) +
    (counts.duplicate_check ?? 0) +
    (counts.running_tests ?? 0) +
    (counts.llm_validation ?? 0);

  // Derived from the live flat KARMA_RULES constant and this bounty's own
  // snapshot fields — no versioned karma-pricing-matrix service is wired up
  // yet, so `matrixVersion` stays null rather than claiming one.
  const plannedAuditItems = Math.round((target * bounty.auditCoveragePct) / 100);
  const contributorPerItem = bounty.karmaPerAcceptedItem;
  const contributorTotal = contributorPerItem * target;
  const validatorPerAuditedItem = KARMA_RULES.auditItem;
  const validatorTotal = plannedAuditItems * validatorPerAuditedItem;

  const policy =
    bounty.communityValidationMode === "full_human" || bounty.communityValidationMode === "automation_only"
      ? { validation: bounty.communityValidationMode, sponsorDispute: false as const, karmaRelease: "on_final_accept" as const }
      : undefined;

  return {
    bounty: {
      id: bounty.id,
      title: bounty.title,
      description: bounty.description,
      category: bounty.datasetCategory,
      language: bounty.language,
      framework: bounty.framework,
      karmaPerAcceptedItem: bounty.karmaPerAcceptedItem,
      karmaPricing: {
        contributorPerItem,
        contributorTotal,
        validatorPerAuditedItem,
        plannedAuditItems,
        validatorTotal,
        matrixVersion: null,
        complexityScore: bounty.datasetType.complexityScore,
        verificationUnits: bounty.datasetType.verificationUnits,
        difficulty: bounty.poolDifficulty ?? "intermediate",
      },
      targetItems: String(target),
      acceptedItems: String(finalAccepted),
      clearedItems: String(cleared),
      poolClosedAt: bounty.poolClosedAt ? bounty.poolClosedAt.toISOString() : null,
      deadline: bounty.deadline ? bounty.deadline.toISOString() : null,
      status: bounty.status,
      auditCoveragePct: bounty.auditCoveragePct,
      difficulty: bounty.poolDifficulty,
      // The selected level restated as an actionable requirement, so a
      // contributor is not left inferring the standard from a sample. Null
      // difficulty gets the explicit "none declared" branch rather than a
      // fabricated middle level.
      difficultyRequirement: difficultyRequirement(bounty.poolDifficulty),
      license: bounty.communityLicense,
      licenseUrl: bounty.communityLicenseUrl,
      // humanAudit (rolling-window scheduling progress) is intentionally
      // omitted: no HumanAuditWindow scheduler is wired up in this deployment,
      // so there is nothing real to report instead of a fabricated window.
      poolSummary: {
        ...buildPoolSummary({ counts, targetItems: target, clearedItems: cleared, finalAccepted }),
        ...(policy ? { policy } : {}),
      },
    },
    datasetType: bounty.datasetType,
    verification: bounty.datasetType.verification,
    sourceUpload: sourceUploadRequirements(bounty.datasetType),
    // The sponsor's actual approved uploads, served through the artifact
    // endpoint rather than raw object-storage URLs. DatasetType.sampleAssets
    // remains a catalog example and is deliberately not substituted here.
    ...(options?.includeSponsorReferences ? { sponsorReferences: sponsorReferences.map(serializeArtifact) } : {}),
    // Two SEPARATE facts, deliberately not collapsed into one "effective"
    // boolean — the contributor UI renders three distinct honest states from
    // the pair, and this surface is read BEFORE any submission exists, so it
    // cannot infer either one from evidence rows:
    //
    //   llmValidationEnabled  = the `validation.llm.enabled` platform switch
    //                           alone (services/admin-settings.ts, fails
    //                           closed to false). Off ⇒ services/validation.ts
    //                           skips the stage entirely and writes no row.
    //   llmProviderConfigured = whether an actual provider key is present.
    //                           Flag on + this false ⇒ the stage runs and
    //                           records honest `no_provider_configured`
    //                           evidence; it is never a pass.
    llmValidationEnabled: llmEnabled,
    llmProviderConfigured: openRouterConfigured(),
    // Pool room as a snapshot, so a client can plan a contribution BEFORE
    // spending a submit call. Derived from the same counter the submit path
    // gates on, so `capacity.poolRemaining === bounty.poolSummary.remainingToTarget`
    // always holds within one response.
    capacity: poolCapacityFor({
      targetItems: target,
      capacityReserved: cleared,
      bulkThresholdItems: submitLimits.bulkThresholdItems,
      acceptingContributions: bounty.status === BountyStatus.active && !bounty.poolClosedAt,
    }),
    submitLimits,
  };
}

/**
 * Public landing-page contract (`/v1/community/stats`). Both Community's and
 * Enterprise's landing apps port the same V1 `/open` page verbatim, which
 * reads `programs`/`targetItems`/`clearedItems`/`acceptedItems`/`contributors`/
 * `publishedDatasets`/`tiers`/`leaderboard` — this used to return an
 * unrelated flat shape (`totalPools`/`totalAcceptedItems`/`totalKarmaAwarded`/
 * `totalContributors`), so every one of those fields read `undefined` and the
 * page rendered all-zero totals despite real bounties existing. `cleared` vs
 * `accepted` mirrors the same distinction the admin `/community/open`
 * overview already makes: `acceptedItems` (Bounty column) is automation-
 * cleared pool-fill capacity, `finalAcceptedItems` is validator-passed.
 */
export async function getCommunityStats() {
  // Excludes cancelled bounties from every count/sum below — same scope
  // `listCommunityCatalog`/`getCommunityPool` already use — so a paused/
  // cancelled test fixture (e.g. the 2026-09-03 QA-fixture cleanup) can't
  // keep inflating the public "N open dataset specs" headline after it's
  // been removed from the catalog itself. Before this fix, `programs`
  // counted all 16 community bounties (15 cancelled test fixtures + 1 real)
  // even though the catalog showed only 1 — a live trust-honesty mismatch
  // between the hero stat and the actual open-dataset list.
  const communityLiveWhere: Prisma.BountyWhereInput = { kind: BountyKind.community, status: { notIn: [BountyStatus.cancelled] } };
  const [programs, totals, karmaSum, contributorGroups, publishedDatasets, { leaderboard }, { tiers: liveTiers }, { rules: liveRules }] =
    await Promise.all([
      prisma.bounty.count({ where: communityLiveWhere }),
      prisma.bounty.aggregate({
        where: communityLiveWhere,
        _sum: { targetItems: true, acceptedItems: true, finalAcceptedItems: true },
      }),
      prisma.karmaEvent.aggregate({ _sum: { amount: true } }),
      prisma.submission.groupBy({ by: ["contributorUserId"], where: { bounty: communityLiveWhere } }),
      prisma.bounty.count({ where: { ...communityLiveWhere, publicationStatus: CommunityPublicationStatus.published } }),
      getLeaderboard({ limit: 10 }),
      // Admin-configurable, not the code default: an operator's saved tier
      // edit must reach this public page the same request it reaches the
      // logged-in karma page on (getCommunityStats/community/karma routes
      // previously disagreed — one read admin_settings, the other the
      // KARMA_TIERS module constant, forever).
      getKarmaTiers(),
      getKarmaRules(),
    ]);

  return {
    programs,
    targetItems: Number(totals._sum.targetItems ?? 0n),
    clearedItems: Number(totals._sum.acceptedItems ?? 0n),
    acceptedItems: Number(totals._sum.finalAcceptedItems ?? 0n),
    contributors: contributorGroups.length,
    publishedDatasets,
    totalKarmaAwarded: karmaSum._sum.amount ?? 0,
    tiers: liveTiers.map((t) => ({
      name: t.tier,
      label: t.label,
      minKarma: t.minKarma,
      color: t.color,
      earlyAccessHours: t.earlyAccessHours,
      concurrencyBonus: t.concurrencyBonus,
    })),
    leaderboard: leaderboard.map((l) => ({ rank: l.rank, handle: l.handle, displayName: l.displayName, karma: l.karma })),
    // This deployment's real model is one flat rate per validated item
    // (KARMA_RULES.auditItem / getKarmaRules().rules.auditItem), not a
    // complexity matrix — `activeScale: "difficulty_scale"` is the shape the
    // landing page already renders honestly for exactly that model.
    validatorKarma: { activeScale: "difficulty_scale" as const, flatRate: liveRules.auditItem },
  };
}
