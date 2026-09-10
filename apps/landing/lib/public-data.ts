// SPDX-License-Identifier: Apache-2.0

import type { DatasetType } from "./dataset-types";
import type { Bounty, BountyStatus, DatasetCategory, DatasetTypeSampleAsset, PublicSampleArtifact, SamplePreviewMedia } from "./types";

export const PUBLIC_API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export function serverApiUrl(): string {
  const configured = typeof window === "undefined" ? process.env.INTERNAL_API_URL : undefined;
  return (configured ?? PUBLIC_API_URL).replace(/\/+$/, "");
}

type ApiBounty = Record<string, unknown>;

/** A number only when the API actually sent one. Unlike number(), this never
 * substitutes 0 for "the API did not measure this" — the two must not render
 * the same. */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function number(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function publicSamples(value: unknown): PublicSampleArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PublicSampleArtifact[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const sample = row.sample;
    if (!sample || typeof sample !== "object") return [];
    const sampleRow = sample as Record<string, unknown>;
    const id = text(row.id);
    const filename = text(row.filename);
    const contentType = text(row.contentType);
    const downloadUrl = text(row.downloadUrl);
    if (!id || !filename || !contentType || !downloadUrl || typeof sampleRow.available !== "boolean") return [];
    return [{
      id,
      filename,
      contentType,
      downloadUrl,
      sample: {
        available: sampleRow.available,
        content: typeof sampleRow.content === "string" ? sampleRow.content : undefined,
        truncated: sampleRow.truncated === true,
        reason: text(sampleRow.reason) || undefined,
      },
    }];
  });
}

const SAMPLE_MEDIA_KINDS = new Set(["image", "audio", "video", "file"]);

function sampleAssetMedia(value: unknown): SamplePreviewMedia[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((entry): SamplePreviewMedia[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const key = text(row.key);
    const url = text(row.url);
    const kind = typeof row.kind === "string" ? row.kind : "";
    if (!key || !url || !SAMPLE_MEDIA_KINDS.has(kind)) return [];
    return [{ key, url, kind: kind as SamplePreviewMedia["kind"], alt: typeof row.alt === "string" ? row.alt : undefined }];
  });
  return out.length > 0 ? out : undefined;
}

function sampleAssetFields(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof fieldValue === "string") out[key] = fieldValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `DatasetType.sampleAssets` — admin-authored illustrative samples, distinct
 * from `publicSamples` (real per-pool submitted/approved artifacts). Most
 * dataset types have none, so a missing, null, or malformed value quietly
 * yields `undefined` rather than a crash or a fabricated placeholder. */
function datasetTypeSampleAssets(value: unknown): DatasetTypeSampleAsset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((entry): DatasetTypeSampleAsset[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const fields = sampleAssetFields(row.fields);
    const media = sampleAssetMedia(row.media);
    const caption = typeof row.caption === "string" ? row.caption : undefined;
    if (!fields && !media && !caption) return [];
    return [{ fields, media, caption }];
  });
  return out.length > 0 ? out : undefined;
}

function communityLanguageFallback(row: ApiBounty): string {
  const dt = row.datasetType as { domain?: string; name?: string } | undefined;
  return text(row.language) || dt?.domain || "";
}

function communityFrameworkFallback(row: ApiBounty): string {
  const dt = row.datasetType as { domain?: string; name?: string } | undefined;
  return text(row.framework) || dt?.name || "";
}

export function mapPublicBounty(row: ApiBounty): Bounty {
  const poolSummary = row.poolSummary as { policy?: unknown } | null | undefined;
  const rawPolicy = poolSummary?.policy;
  const communityPolicy = rawPolicy && typeof rawPolicy === "object"
    && ((rawPolicy as Record<string, unknown>).validation === "full_human" || (rawPolicy as Record<string, unknown>).validation === "automation_only")
    && (rawPolicy as Record<string, unknown>).sponsorDispute === false
    && (rawPolicy as Record<string, unknown>).karmaRelease === "on_final_accept"
    ? {
        validation: (rawPolicy as { validation: "full_human" | "automation_only" }).validation,
        sponsorDispute: false as const,
        karmaRelease: "on_final_accept" as const,
      }
    : null;

  return {
    id: text(row.id),
    title: text(row.title),
    description: text(row.description),
    category: text(row.datasetCategory, "debugging") as DatasetCategory,
    // The catalog serializer nests this as `datasetType`; older payloads send a
    // flat `datasetTypeId`. Read both, or the page silently falls back to
    // guessing the type from the legacy category and names the wrong one.
    datasetTypeId:
      typeof row.datasetTypeId === "string"
        ? row.datasetTypeId
        : typeof (row.datasetType as { id?: unknown } | undefined)?.id === "string"
          ? String((row.datasetType as { id: string }).id)
          : undefined,
    datasetTypeName:
      typeof (row.datasetType as { name?: unknown } | undefined)?.name === "string"
        ? String((row.datasetType as { name: string }).name)
        : undefined,
    datasetTypeTrustTier:
      typeof (row.datasetType as { trustTier?: unknown } | undefined)?.trustTier === "string"
        ? String((row.datasetType as { trustTier: string }).trustTier)
        : undefined,
    datasetTypeSampleAssets: datasetTypeSampleAssets(
      (row.datasetType as { sampleAssets?: unknown } | undefined)?.sampleAssets
    ),
    language: communityLanguageFallback(row),
    framework: communityFrameworkFallback(row),
    targetItems: number(row.targetItems),
    acceptedItems: number(row.finalAcceptedItems ?? row.acceptedItems),
    clearedItems: row.clearedItems === undefined ? number(row.acceptedItems) : number(row.clearedItems),
    submittedItems: number(row.submittedItems),
    needsFixesItems: number(row.needsFixesItems),
    rejectedItems: number(row.rejectedItems),
    status: text(row.status) as BountyStatus,
    auditMode: text(row.auditMode, "full") as Bounty["auditMode"],
    deadline: text(row.deadline),
    requesterNickname: text(row.requesterNickname, "Platform"),
    slots: [],
    duplicateRate: optionalNumber(row.duplicateRate),
    llmPassRate: optionalNumber(row.llmPassRate),
    executionPassRate: optionalNumber(row.executionPassRate),
    contributorCount: optionalNumber(row.contributorCount),
    validatorCount: optionalNumber(row.validatorCount),
    poolClosedAt: typeof row.poolClosedAt === "string" ? row.poolClosedAt : null,
    // Only a real publication timestamp. `updatedAt` was used here, which
    // moves on every edit, so a "delivered" label showed a last-touched date.
    deliveredAt: typeof row.deliveredAt === "string" ? row.deliveredAt : undefined,
    kind: "community",
    communityPolicy,
    communityProgress: poolSummary && typeof poolSummary === "object" ? {
      totalSubmitted:
        typeof (poolSummary as Record<string, unknown>).totalSubmitted === "number"
          ? ((poolSummary as Record<string, number>).totalSubmitted)
          : undefined,
      capacityReserved: number((poolSummary as Record<string, unknown>).capacityReserved),
      finalAccepted: number((poolSummary as Record<string, unknown>).finalAccepted),
      validatorReview: number((poolSummary as Record<string, unknown>).validatorReview),
      processing: number((poolSummary as Record<string, unknown>).processing),
      rejected: number((poolSummary as Record<string, unknown>).rejected),
      failedAutomatedChecks: number((poolSummary as Record<string, unknown>).failedAutomatedChecks),
      flagged: number((poolSummary as Record<string, unknown>).flagged),
      disputed: number((poolSummary as Record<string, unknown>).disputed),
    } : null,
    karmaPerItem: number((row.karmaPricing as { contributorPerItem?: unknown } | undefined)?.contributorPerItem ?? row.resolvedKarmaPerAcceptedItem ?? row.karmaPerAcceptedItem) || undefined,
    karmaPerAuditedItem:
      number((row.karmaPricing as { validatorPerAuditedItem?: unknown } | undefined)?.validatorPerAuditedItem) || undefined,
    auditCoveragePct: typeof row.auditCoveragePct === "number" ? row.auditCoveragePct : undefined,
    openLicense: text(row.communityLicense) || undefined,
    hfSlug: text(row.huggingFaceDataset) || undefined,
    publications: Array.isArray(row.publications)
      ? (row.publications as unknown[])
          .map((p) => p as { target?: unknown; url?: unknown; pushedAt?: unknown })
          .filter((p) => p.target !== "huggingface" && typeof p.target === "string" && typeof p.url === "string")
          .map((p) => ({
            target: p.target as string,
            url: p.url as string,
            pushedAt: typeof p.pushedAt === "string" ? p.pushedAt : undefined,
          }))
      : undefined,
    publicSamples: publicSamples(row.publicSamples),
  };
}

async function readJson(path: string): Promise<unknown> {
  const apiUrl = serverApiUrl();
  if (!apiUrl) throw new Error("Live public API is not configured.");
  const response = await fetch(`${apiUrl}${path}`, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((body as { message?: string }).message ?? "Could not load live public data.") as ApiError;
    error.status = response.status;
    throw error;
  }
  return body;
}

/** An error carrying the HTTP status, so a caller can tell a rejected request
 * (bad input — the user's fault, fixable in the UI) from a real outage. */
type ApiError = Error & { status?: number };

export async function fetchLandingCatalog() {
  const [live, delivered, catalog, communityResult] = await Promise.all([
    readJson("/v1/bounties?phase=production&pageSize=100").catch(() => ({ bounties: [] })),
    // Delivered corpora come from the community catalog rather than
    // /v1/bounties: it is the only listing that carries the real per-pool
    // submission rollup (`withPoolSummary`), which the delivered card needs to
    // show a submitted count instead of inventing one. /v1/bounties stays the
    // fallback so a deployment without the phase param still renders.
    readJson("/v1/community/catalog?phase=delivered&withPoolSummary=true&limit=100")
      .catch(() => readJson("/v1/bounties?phase=delivered&pageSize=100"))
      .catch(() => ({ bounties: [] })),
    readJson("/v1/meta/public-catalog").catch(() => ({ datasetTypes: [], domains: [] })),
    readJson("/v1/community/catalog?limit=100&withPoolSummary=true")
      .then((data) => ({ data, error: false }))
      .catch(() => ({ data: { bounties: [] }, error: true })),
  ]);
  const liveRows = rowsOf(live);
  const deliveredRows = rowsOf(delivered).filter(isDeliveredRow);
  return {
    communityError: communityResult.error,
    // Both sources list the same community pools in this deployment (BountyKind
    // has only `community`), so they are merged by id rather than concatenated
    // — otherwise every pool rendered twice, with the two copies disagreeing
    // wherever the leaner /v1/bounties row lacks a field. Catalog rows win:
    // they carry licence, karma rates and the pool rollup.
    bounties: dedupeById([
      ...((communityResult.data as { bounties?: unknown[] }).bounties ?? []),
      ...liveRows,
    ]).map((row) => mapPublicBounty(row as ApiBounty)),
    delivered: deliveredRows.map((row) => mapPublicBounty(row as ApiBounty)),
    datasetTypes: ((catalog as { datasetTypes?: unknown[] }).datasetTypes ?? []) as DatasetType[],
    liveDomainIds: new Set(
      (Array.isArray((catalog as { domains?: unknown[] }).domains) ? (catalog as { domains: { id: string }[] }).domains : []).map(
        (d) => d.id
      )
    ),
  };
}

/** GET /v1/bounties returns `bounties` (V1's key); the sibling pool listing
 * returns `items`. Accept either so a grid can never silently render empty
 * against an API build serving the other shape. */
function rowsOf(payload: unknown): unknown[] {
  const body = payload as { bounties?: unknown[]; items?: unknown[] };
  if (Array.isArray(body?.bounties)) return body.bounties;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}

/** First row wins for a given id. Callers pass the richer source first. */
function dedupeById(rows: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const row of rows) {
    const id = (row as { id?: unknown }).id;
    const key = typeof id === "string" ? id : "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(row);
  }
  return out;
}

/** Belt-and-braces re-check of the delivered phase, so an API build that does
 * not honour `?phase=` can never leak in-flight pools into a delivered grid.
 * Mirrors PHASE_STATUSES.delivered on the API side. */
const DELIVERED_STATUSES = new Set(["export_ready", "completed", "partially_completed"]);
function isDeliveredRow(row: unknown): boolean {
  return DELIVERED_STATUSES.has(String((row as { status?: unknown }).status ?? ""));
}

export type ValidationQueue = {
  bounties: Bounty[];
  /** Totals across EVERY open pool with audit work, not just the returned
   * cards — the home page must never derive a backlog figure from the page it
   * happens to have fetched. */
  totals: { items: number; pools: number };
  loadError: boolean;
};

/** Open pools with items awaiting a human validator, deepest queue first. */
export async function fetchValidationQueue(limit = 6): Promise<ValidationQueue> {
  try {
    const body = (await readJson(`/v1/community/validation-queue?limit=${limit}`)) as {
      bounties?: unknown[];
      totals?: { items?: unknown; pools?: unknown };
    };
    return {
      bounties: rowsOf(body).map((row) => mapPublicBounty(row as ApiBounty)),
      totals: {
        items: typeof body.totals?.items === "number" ? body.totals.items : 0,
        pools: typeof body.totals?.pools === "number" ? body.totals.pools : 0,
      },
      loadError: false,
    };
  } catch {
    return { bounties: [], totals: { items: 0, pools: 0 }, loadError: true };
  }
}

export type PoolsQuery = {
  q?: string;
  category?: string;
  language?: string;
  datasetTypeId?: string;
  page?: number;
  pageSize?: number;
  /** Which lifecycle phase to browse. "open" is work still taking
   * contributions; "delivered" is published corpora. */
  phase?: "open" | "delivered";
};

export type PoolsPage = {
  bounties: Bounty[];
  /** null when the request failed — the total is UNKNOWN, not zero. Rendering
   * a fabricated 0 next to an error message is exactly the kind of unbacked
   * claim the trust-honesty rule forbids. */
  total: number | null;
  page: number;
  pageSize: number;
  pageCount: number;
  languages: string[];
  datasetTypes: { id: string; name: string; domain: string }[];
  loadError: boolean;
  /** True when the API rejected the query (4xx) rather than failing. A search
   * term the reader typed is their input to fix, not a backend outage.
   * Deliberately excludes 429, which says nothing about the query — see
   * `rateLimited`. */
  invalidQuery: boolean;
  /** True when the API rate-limited the request (429). Distinct from
   * `invalidQuery` because it is neither the reader's input nor an outage:
   * telling them "the search term or a filter value wasn't accepted" — and
   * offering `clear_all` as the fix — is false, and clearing the filters does
   * not help. Waiting does. */
  rateLimited: boolean;
};

/**
 * One page of the public pool browser. Every filter, the search term and the
 * page offset are sent to the API as query params — the browser is never
 * handed the full set to filter or slice itself, which is both the project
 * rule and the only way this stays correct past 100 pools.
 */
export async function fetchPoolsPage(query: PoolsQuery): Promise<PoolsPage> {
  const pageSize = Math.min(Math.max(query.pageSize ?? 12, 1), 48);
  const requested = Math.max(query.page ?? 1, 1);

  async function load(page: number): Promise<PoolsPage> {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String((page - 1) * pageSize),
      phase: query.phase ?? "open",
      withPoolSummary: "true",
    });
    if (query.q) params.set("q", query.q);
    if (query.category) params.set("category", query.category);
    if (query.language) params.set("language", query.language);
    if (query.datasetTypeId) params.set("datasetTypeId", query.datasetTypeId);

    const body = (await readJson(`/v1/community/catalog?${params.toString()}`)) as {
      bounties?: unknown[];
      items?: unknown[];
      total?: number;
      filterOptions?: { languages?: unknown };
      datasetTypes?: unknown[];
    };
    const rows = rowsOf(body);
    const total = typeof body.total === "number" ? body.total : rows.length;
    const languages = Array.isArray(body.filterOptions?.languages)
      ? (body.filterOptions.languages as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const datasetTypes = (Array.isArray(body.datasetTypes) ? body.datasetTypes : [])
      .map((t) => t as { id?: unknown; name?: unknown; domain?: unknown })
      .filter((t) => typeof t.id === "string" && typeof t.name === "string")
      .map((t) => ({ id: String(t.id), name: String(t.name), domain: String(t.domain ?? "") }));
    return {
      bounties: rows.map((row) => mapPublicBounty(row as ApiBounty)),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      languages,
      datasetTypes,
      loadError: false,
      invalidQuery: false,
      rateLimited: false,
    };
  }

  // The API caps `offset`, so a page number far past the end would be rejected
  // and — through a blanket catch — reported to the reader as "the catalog
  // service didn't respond". A page number the reader typed is not an outage.
  const maxPage = Math.floor(MAX_CATALOG_OFFSET / pageSize) + 1;
  const first = Math.min(requested, maxPage);

  try {
    const result = await load(first);
    // Past the last page: re-fetch the real last page rather than showing an
    // empty grid under a header that says N are open. The caller redirects to
    // the corrected URL so the address bar agrees with what is on screen.
    if ((result.total ?? 0) > 0 && first > result.pageCount) {
      return await load(result.pageCount);
    }
    return result;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return {
      bounties: [], total: null, page: first, pageSize, pageCount: 0,
      languages: [], datasetTypes: [], loadError: true,
      invalidQuery: typeof status === "number" && status >= 400 && status < 500 && status !== 429,
      rateLimited: status === 429,
    };
  }
}

/** Matches the `offset` ceiling the catalog route validates against. */
const MAX_CATALOG_OFFSET = 100000;

/** One page of the validation queue. Same shape as PoolsPage so a single
 * listing view can render either, plus the whole-queue backlog totals. */
export type ValidationPage = PoolsPage & { totals: { items: number; pools: number } };

export async function fetchValidationPage(query: { q?: string; page?: number; pageSize?: number }): Promise<ValidationPage> {
  const pageSize = Math.min(Math.max(query.pageSize ?? 12, 1), 48);
  const page = Math.max(query.page ?? 1, 1);

  async function load(target: number): Promise<ValidationPage> {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String((target - 1) * pageSize) });
    if (query.q) params.set("q", query.q);
    const body = (await readJson(`/v1/community/validation-queue?${params.toString()}`)) as {
      bounties?: unknown[];
      total?: number;
      totals?: { items?: unknown; pools?: unknown };
    };
    const rows = rowsOf(body);
    const total = typeof body.total === "number" ? body.total : rows.length;
    return {
      bounties: rows.map((row) => mapPublicBounty(row as ApiBounty)),
      total,
      page: target,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      languages: [],
      datasetTypes: [],
      loadError: false,
      invalidQuery: false,
      rateLimited: false,
      totals: {
        items: typeof body.totals?.items === "number" ? body.totals.items : 0,
        pools: typeof body.totals?.pools === "number" ? body.totals.pools : 0,
      },
    };
  }

  const first = Math.min(page, Math.floor(MAX_CATALOG_OFFSET / pageSize) + 1);
  try {
    const result = await load(first);
    // Same clamp as the pool browser: a page past the end must land on the real
    // last page, not on an empty grid under a header claiming N are queued.
    if ((result.total ?? 0) > 0 && first > result.pageCount) return await load(result.pageCount);
    return result;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return {
      bounties: [], total: null, page: first, pageSize, pageCount: 0,
      languages: [], datasetTypes: [], loadError: true,
      invalidQuery: typeof status === "number" && status >= 400 && status < 500 && status !== 429,
      rateLimited: status === 429,
      totals: { items: 0, pools: 0 },
    };
  }
}

export type CommunityStatsResult = { available: true; data: Record<string, unknown> } | { available: false; data: null };

export async function fetchCommunityStats(): Promise<CommunityStatsResult> {
  if (!serverApiUrl()) return { available: false, data: null };
  try {
    return { available: true, data: (await readJson("/v1/community/stats")) as Record<string, unknown> };
  } catch {
    return { available: false, data: null };
  }
}

export async function fetchBounty(id: string): Promise<Bounty | null> {
  const apiUrl = serverApiUrl();
  if (!apiUrl || !id) return null;
  const encoded = encodeURIComponent(id);
  try {
    const res = await fetch(`${apiUrl}/v1/community/catalog/${encoded}`, { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as { bounty?: ApiBounty };
      if (body.bounty) return mapPublicBounty(body.bounty);
    }
  } catch {
    // fall through
  }
  try {
    const res = await fetch(`${apiUrl}/v1/bounties/${encoded}`, { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as { bounty?: ApiBounty };
      if (body.bounty) return mapPublicBounty(body.bounty);
    }
  } catch {
    // no match
  }
  return null;
}

export interface PublicProfile {
  handle: string;
  displayName?: string;
  memberSince?: string;
  /** Optional since SEC-10: the API's "karma & tier" disclosure preference
   *  gates `tier` and `karma` together, so a member who turned that toggle
   *  off gets a payload with neither field. Never render this without a
   *  guard — it used to be unconditional and was dereferenced directly. */
  tier?: { id: string; label: string; color: string };
  karma?: number;
  badges?: { id: string; family: string; label: string }[];
  datasets?: { id: string; title: string; items: number }[];
  datasetsContributed?: number;
  datasetsSponsored?: number;
  acceptedItems?: number;
  audits?: number;
  publishedCredits: { title: string; hfSlug: string; hfUrl: string }[];
}

export type PublicProfileResult =
  | { status: "ok"; profile: PublicProfile }
  | { status: "missing" }
  | { status: "unavailable" };

export async function fetchPublicProfile(handle: string): Promise<PublicProfileResult> {
  const apiUrl = serverApiUrl();
  if (!apiUrl) return { status: "unavailable" };
  if (!handle) return { status: "missing" };
  try {
    const res = await fetch(`${apiUrl}/v1/profiles/handle/${encodeURIComponent(handle)}`, { cache: "no-store" });
    if (res.status === 404) return { status: "missing" };
    if (!res.ok) return { status: "unavailable" };
    return { status: "ok", profile: (await res.json()) as PublicProfile };
  } catch {
    return { status: "unavailable" };
  }
}

export type SurfaceScope =
  | "public"
  | "read"
  | "contribute"
  | "validate"
  | "artifact"
  | "sponsor"
  | "account";

export interface DeveloperSurface {
  baseUrl: string;
  mcpRemoteUrl: string;
  rateLimitPerMinute: number;
  /** The real `validation.llm.enabled` platform switch, read live from
   *  `/v1/meta/developer-surface`. It fails closed to `false` server-side, so
   *  a public surface must never present LLM review as a check that runs
   *  unless this is `true`. */
  llmValidationEnabled: boolean;
  /** The independent provider-key fact, kept separate on purpose: switched-on
   *  but unconfigured is a different honest state from switched-off, and the
   *  API deliberately does not collapse the two. */
  llmProviderConfigured: boolean;
  endpoints: { method: string; path: string; purpose: string; scope: SurfaceScope }[];
  mcpTools: { name: string; description: string; scope: SurfaceScope }[];
}

export async function fetchDeveloperSurface(): Promise<DeveloperSurface | null> {
  if (!serverApiUrl()) return null;
  try {
    const surface = (await readJson("/v1/meta/developer-surface")) as Partial<DeveloperSurface>;
    if (!surface.mcpRemoteUrl || !surface.baseUrl) return null;
    return {
      baseUrl: surface.baseUrl,
      mcpRemoteUrl: surface.mcpRemoteUrl,
      rateLimitPerMinute: number(surface.rateLimitPerMinute),
      // Fail closed on anything that is not an explicit `true`: an absent or
      // malformed field must not become a trust claim.
      llmValidationEnabled: surface.llmValidationEnabled === true,
      llmProviderConfigured: surface.llmProviderConfigured === true,
      endpoints: Array.isArray(surface.endpoints) ? surface.endpoints : [],
      mcpTools: Array.isArray(surface.mcpTools) ? surface.mcpTools : [],
    };
  } catch {
    return null;
  }
}

export async function fetchWaitlistCount(domain: string): Promise<number> {
  const apiUrl = serverApiUrl();
  if (!apiUrl) return 0;
  try {
    const res = await fetch(`${apiUrl}/v1/waitlist/${encodeURIComponent(domain)}/count`, { cache: "no-store" });
    if (!res.ok) return 0;
    const body = (await res.json()) as { count?: number };
    return typeof body.count === "number" ? body.count : 0;
  } catch {
    return 0;
  }
}
