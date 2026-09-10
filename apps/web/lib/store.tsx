"use client";

// SPDX-License-Identifier: Apache-2.0

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { API_URL } from "./urls";
import { API } from "./api-endpoints";
import { SEARCH_DEBOUNCE_MS } from "./use-list-search";
import * as notifApi from "./api-notifications";
import * as profileSourceApi from "./api-profile-sources";
import type { ProfileSummary } from "./api-profile-sources";
import {
  claimAuditReal,
  claimBatchReal,
  getAvailableAuditsCount,
  getAvailableBatchesCount,
  getContributorDashboard,
  getValidatorDashboard,
  getMyAuditsPage,
  type PersonalWorkSummary,
} from "./api-work";
import type {
  AuditBatch,
  Bounty,
  ContributorBatch,
  DatasetCategory,
  Dispute,
  FlagReason,
  Notification,
  Submission,
  SubmissionStatus,
  Toast,
} from "./types";
import {
  DELIVERED_BOUNTIES,
  DISPUTES,
  MY_SUBMISSIONS,
  SAMPLE_PASSING_LOGS,
} from "./mock-data";
import { deadlineLabel } from "./format";
import type { DatasetType, DomainId } from "./dataset-types";
import { DOMAINS } from "./dataset-types";

// Fastify's built-in 404 handler writes messages of the exact shape
// "Route POST:/v1/foo/bar not found" whenever a route genuinely doesn't
// exist server-side — a routing implementation detail, never something a
// real handler would phrase that way. Trusting a response body's `message`
// blindly meant a missing backend route displayed that raw string to the
// user instead of the caller's own friendly fallback. A handler's own
// `reply.notFound("...")`-style message never matches this pattern, so it
// still passes through untouched. Exported because most pages build their
// own inline fetch/error-handling rather than going through api-*.ts.
const FASTIFY_ROUTE_NOT_FOUND = /^Route (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):.* not found$/;
export function safeMessage(message: string | undefined | null, fallback: string): string {
  if (!message || FASTIFY_ROUTE_NOT_FOUND.test(message)) return fallback;
  return message;
}

// Module-level, not per-call — several authedFetch calls can be in flight at
// once (e.g. a dashboard page firing a few requests on mount); without this
// guard every one of them would independently clear storage and reload on
// the same expired token.
let reloadingForExpiredSession = false;
let profileHydrationInFlight: Promise<void> | null = null;
let profileHydratedAt = 0;
let notificationPollInFlight: Promise<void> | null = null;
let notificationPolledAt = 0;

// Marker (survives the reload via sessionStorage) so a genuinely-expired
// session can't put us in an infinite reload loop: we reload AT MOST once to
// try to recover a live session, and if the very next load still 401s we stop
// reloading and let the normal signed-out UI (SignInCard) render instead.
const RELOADED_MARKER = "db_reloaded_for_expired_session";

/**
 * Thrown by {@link authedFetch} when the request never reached the server
 * (server down, DNS/connection failure, offline). Distinct from an HTTP error
 * response: this means "no answer", not "an answer we didn't like". Call sites
 * can catch it to show a recoverable "can't reach the server" state instead of
 * treating a transient outage like a hard bug. `fetch()` throws a bare
 * `TypeError: Failed to fetch` for these, which is indistinguishable from a
 * real programming TypeError — wrapping it gives callers something typed.
 */
export class ApiUnreachableError extends Error {
  constructor(public readonly path: string, cause?: unknown) {
    super(`Could not reach the API (${path}). It may be starting up or offline.`);
    this.name = "ApiUnreachableError";
    this.cause = cause;
  }
}

/**
 * fetch() wrapper for authenticated calls (real Google-backed sessions
 * only). On a 401 — expired or revoked, and there's no refresh token to
 * silently renew it with — reloads the current page ONCE so the app falls back
 * to its normal unauthenticated state (SignInCard on /overview/*) instead of
 * leaving authenticated-looking UI up while every call underneath it silently
 * fails. A network-level failure (server unreachable) is re-thrown as a typed
 * {@link ApiUnreachableError} so callers can tell "server down" (transient,
 * retryable) apart from a real bug.
 */
/**
 * A {@link Response} from {@link authedFetch}, tagged with `forbidden: true`
 * when the server answered with 403. A 403 means "you're authenticated but
 * not allowed to see this" (e.g. ownership mismatch) — categorically
 * different from a 200 with an empty body, which just means "nothing here."
 * Callers that only check `res.ok`/`res.status` (the existing convention)
 * keep working unchanged; callers that care can additionally check
 * `res.forbidden` to show a specific "you don't have access" state instead of
 * silently rendering an empty list.
 */
export type AuthedResponse = Response & { forbidden?: boolean };

export async function authedFetch(path: string, init?: RequestInit): Promise<AuthedResponse> {
  let res: AuthedResponse;
  try {
    res = (await fetch(`${API_URL}${path}`, { ...init, credentials: "include" })) as AuthedResponse;
  } catch (cause) {
    // Only genuine network/transport failures reject here; wrap them so a
    // brief API outage surfaces as a recoverable state, not a raw TypeError
    // (which Next.js renders as a full-page dev error overlay).
    throw new ApiUnreachableError(path, cause);
  }
  if (typeof window !== "undefined") {
    if (res.status === 401) {
      // Don't loop: only reload if we haven't already reloaded once for this.
      const alreadyReloaded = sessionStorage.getItem(RELOADED_MARKER) === "1";
      if (!alreadyReloaded && !reloadingForExpiredSession) {
        reloadingForExpiredSession = true;
        sessionStorage.setItem(RELOADED_MARKER, "1");
        window.location.reload();
      }
    } else if (res.ok) {
      // Any successful authed response proves the session is live again —
      // clear the marker so a future genuine expiry can reload once more.
      sessionStorage.removeItem(RELOADED_MARKER);
    }
  }
  if (res.status === 403) {
    res.forbidden = true;
  }
  return res;
}

/**
 * Fetch the dataset-type catalog from the live DB (GET /v1/planner/catalog)
 * and map it into the frontend `DatasetType` shape. This is the real source of
 * truth for the planner. Returns [] on failure so callers can show an empty or
 * loading state instead of silently using stale in-memory templates.
 */
export async function hydrateDatasetCatalog(): Promise<DatasetType[]> {
  try {
    const res = await authedFetch(API.planner.catalog);
    if (!res.ok) return [];
    const data = (await res.json()) as { datasetTypes?: ApiDatasetType[] };
    return (data.datasetTypes ?? []).map(mapApiDatasetType);
  } catch {
    return [];
  }
}

export interface PlannerDeadlineSettings {
  presetDays: number[];
  maxDays: number;
  extensionPct: number;
}

const DEFAULT_DEADLINE_SETTINGS: PlannerDeadlineSettings = { presetDays: [30, 60, 90], maxDays: 365, extensionPct: 75 };

/** Admin-configurable delivery-deadline chip presets / cap / extension %
 * (`planner.deadline.*` in admin_settings) for the create-bounty planner. */
export async function hydratePlannerDeadlineSettings(): Promise<PlannerDeadlineSettings> {
  try {
    const res = await authedFetch(API.planner.catalog);
    if (!res.ok) return DEFAULT_DEADLINE_SETTINGS;
    const data = (await res.json()) as { deadlineSettings?: PlannerDeadlineSettings };
    return data.deadlineSettings ?? DEFAULT_DEADLINE_SETTINGS;
  } catch {
    return DEFAULT_DEADLINE_SETTINGS;
  }
}

/** Reference-sample bounds the server actually enforces
 * (`planner.sample_gate.min` / `.max`). Mirrors the API's own code defaults so
 * an unreachable catalog collects a valid number rather than none at all. */
export interface PlannerSampleGate {
  min: number;
  max: number;
}
export const DEFAULT_SAMPLE_GATE: PlannerSampleGate = { min: 2, max: 3 };

export async function hydratePlannerCatalog(): Promise<{
  datasetTypes: DatasetType[];
  deadlineSettings: PlannerDeadlineSettings;
  /** Server-owned `validation.llm.enabled`. False means the planner must not
   * present LLM review as a check the sponsor's items will run. Defaults to
   * false on any failure so an unreachable API can never make the UI claim a
   * stage that is off. */
  llmValidationEnabled: boolean;
  sampleGate: PlannerSampleGate;
}> {
  const empty = {
    datasetTypes: [],
    deadlineSettings: DEFAULT_DEADLINE_SETTINGS,
    llmValidationEnabled: false,
    sampleGate: DEFAULT_SAMPLE_GATE,
  };
  try {
    const res = await authedFetch(API.planner.catalog);
    if (!res.ok) return empty;
    const data = (await res.json()) as {
      datasetTypes?: ApiDatasetType[];
      deadlineSettings?: PlannerDeadlineSettings;
      llmValidationEnabled?: boolean;
      sampleGate?: Partial<PlannerSampleGate>;
    };
    // Clamp defensively: a max below the min would make the step impossible to
    // satisfy, which is a worse failure than accepting one extra sample.
    const min = Number.isInteger(data.sampleGate?.min) ? (data.sampleGate!.min as number) : DEFAULT_SAMPLE_GATE.min;
    const max = Number.isInteger(data.sampleGate?.max) ? (data.sampleGate!.max as number) : DEFAULT_SAMPLE_GATE.max;
    return {
      datasetTypes: (data.datasetTypes ?? []).map(mapApiDatasetType),
      deadlineSettings: data.deadlineSettings ?? DEFAULT_DEADLINE_SETTINGS,
      llmValidationEnabled: data.llmValidationEnabled === true,
      sampleGate: { min, max: Math.max(min, max) },
    };
  } catch {
    return empty;
  }
}

/** A domain in the real catalog — same shape as the old static `Domain`
 * interface in dataset-types.ts, but sourced from live DatasetType rows so a
 * domain going live needs zero frontend changes. */
export interface TaxonomyDomain {
  id: DomainId;
  name: string;
  status: "live" | "coming_soon";
  tagline: string;
  expertPitch: string;
  waitlistCount: number;
}
export interface TaxonomyCategory {
  id: DatasetCategory;
  label: string;
}
export interface TaxonomyDatasetType {
  id: string;
  name: string;
  domain: DomainId;
  category: DatasetCategory;
  status: string;
}
export interface Taxonomy {
  domains: TaxonomyDomain[];
  categories: TaxonomyCategory[];
  datasetTypes: TaxonomyDatasetType[];
  languages: string[];
}
const EMPTY_TAXONOMY: Taxonomy = { domains: [], categories: [], datasetTypes: [], languages: [] };

/** Server-side filters on the available audit queue. `kind` narrows the one
 * shared queue to karma or karma work, mirroring the contributor workspace's
 * All/Community control. */
export interface AuditFilters {
  domain: string;
  category: string;
  language: string;
  kind: "all" | "community" | "enterprise";
  /** Free-text bounty-title search. Sent to the server (not applied to the
   * loaded page) because the queue is paginated — see `auditFilterParams`. */
  search: string;
}

/** "all" is the unfiltered sentinel used by every filter dropdown — map it to
 * an empty (omitted) query param rather than sending the literal string. */
function auditFilterParams(filters: AuditFilters) {
  return {
    domains: filters.domain === "all" ? undefined : [filters.domain],
    categories: filters.category === "all" ? undefined : [filters.category],
    languages: filters.language === "all" ? undefined : [filters.language],
    kind: filters.kind === "all" ? undefined : filters.kind,
    // Empty string omits the param entirely. Filtering titles in the client
    // would only ever search the pages already fetched, so a match further
    // down the queue would render as "no audit work matches these filters".
    q: filters.search.trim() ? filters.search.trim() : undefined,
  };
}

/** GET /v1/meta/taxonomy — the real, DB-driven source for every "what kind
 * of data" picker (onboarding, watch prefs, sponsor scope). Replaces the
 * static DOMAINS/CATEGORY_LABELS/WATCH_LANGUAGES constants. */
export async function hydrateTaxonomy(): Promise<Taxonomy> {
  try {
    const res = await authedFetch(API.meta.taxonomy);
    if (!res.ok) return EMPTY_TAXONOMY;
    const data = (await res.json()) as Partial<Taxonomy>;
    return {
      domains: data.domains ?? [],
      categories: data.categories ?? [],
      datasetTypes: data.datasetTypes ?? [],
      languages: data.languages ?? [],
    };
  } catch {
    return EMPTY_TAXONOMY;
  }
}

interface ApiDatasetType {
  id: string;
  version: number;
  domain: DomainId;
  name: string;
  description: string;
  status: DatasetType["status"];
  origin?: DatasetType["origin"];
  category: DatasetType["category"];
  trustTier: DatasetType["trustTier"];
  difficultyLevels?: string[];
  auditOptions?: number[];
  fields?: DatasetType["fields"];
  verification?: DatasetType["verification"];
  sampleAssets?: DatasetType["sampleAssets"];
  languageSupport?: DatasetType["languageSupport"];
  usageCount?: number;
}

function mapApiDatasetType(t: ApiDatasetType): DatasetType {
  return {
    id: t.id,
    version: t.version,
    domain: t.domain,
    name: t.name,
    description: t.description,
    status: t.status,
    origin: t.origin ?? "platform",
    category: t.category,
    fields: t.fields ?? [],
    verification:
      t.verification ?? {
        pipeline: [],
        dedupeFields: [],
        auditOptions: t.auditOptions ?? [],
      },
    trustTier: t.trustTier,
    difficultyLevels: t.difficultyLevels ?? [],
    usageCount: t.usageCount ?? 0,
    sampleAssets: t.sampleAssets ?? null,
    // Left undefined, not defaulted: the planner treats "absent" as "the server
    // hasn't told me, keep asking" and falls back to the old free-text step. A
    // fabricated `{ mode: "any", languages: [] }` here would be indistinguishable
    // from a real answer.
    languageSupport: t.languageSupport,
  };
}

/** Which dashboard the user prefers to land on. Server-backed on
 * `User.persona` as of 2026-08-03.
 *
 * This is the ONLY participation concept left. It replaced a `Roles` record
 * (`{sponsor, contributor, validator}` booleans) mirroring role rows that the
 * API granted on signup and gated ~22 routes on. Those gates are gone: they
 * were never an authorization boundary — the API also checks a verified email
 * and ownership of the row — and they produced false negatives, 403ing real
 * contributors who never ticked the onboarding checkbox.
 *
 * So: never branch UI capability on this. Any signed-in, email-verified user
 * may sponsor, contribute and validate. Use it only to choose a landing route
 * or a default tab. If you find yourself writing `persona === "contributor" ?
 * canSubmit : cannot`, you are rebuilding the bug this removed. */
export type Persona = "sponsor" | "contributor" | "validator" | null;

const PERSONA_STORAGE_KEY = "databounty:persona";

function normalizePersona(raw: unknown): Persona {
  // "builder" was the old localStorage spelling of the contributor persona.
  if (raw === "builder") return "contributor";
  return raw === "sponsor" || raw === "contributor" || raw === "validator" ? raw : null;
}

/** Optimistic seed so the first paint after a reload doesn't flash the wrong
 * dashboard. The server value from /v1/auth/me overwrites it on hydration. */
function readStoredPersona(): Persona {
  if (typeof window === "undefined") return null;
  return normalizePersona(window.localStorage.getItem(PERSONA_STORAGE_KEY));
}

export type ChannelId = "email" | "telegram" | "discord" | "slack" | "google_chat" | "microsoft_teams";
export interface Channel {
  connected: boolean;
  address: string;
  deliver: boolean;
  /** Ownership confirmed (email code entered / webhook probed). A connected but
   * unverified email is pending its one-time code and does not deliver yet. */
  verified: boolean;
  /** Slack only: the selected channel's display name (`#general`), or null
   * when connected via bot-token OAuth but no channel has been picked yet. */
  channelLabel?: string | null;
  /** Safe server-provided delivery health; no provider tokens or URLs. */
  lastError?: string | null;
  lastFailureAt?: string | null;
  lastSuccessAt?: string | null;
}

const DEFAULT_CHANNELS: Record<ChannelId, Channel> = {
  email: { connected: true, address: "sponsor@gmail.com", deliver: true, verified: true },
  telegram: { connected: false, address: "@databounty_contributor", deliver: false, verified: false },
  discord: { connected: false, address: "Discord webhook URL", deliver: false, verified: false },
  slack: { connected: false, address: "Slack webhook URL", deliver: false, verified: false },
  google_chat: { connected: false, address: "Google Chat app", deliver: false, verified: false },
  microsoft_teams: { connected: false, address: "Microsoft Teams webhook URL", deliver: false, verified: false },
};

const CHANNEL_LABEL: Record<ChannelId, string> = {
  email: "Email/Gmail",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  google_chat: "Google Chat",
  microsoft_teams: "Microsoft Teams",
};

const deliveringCount = (ch: Record<ChannelId, Channel>) =>
  (Object.keys(ch) as ChannelId[]).filter((k) => ch[k].connected && ch[k].deliver)
    .length;

/**
 * Contributor/validator "don't miss out" alert preferences.
 *
 * MUST stay identical to WATCH_LANGUAGES in the API
 * (databounty-api/src/services/notifications.ts). The server only persists
 * languages it knows, so any extra entry here is read back as `false` and can
 * never be turned on. That made `allLanguagesOn` permanently false, so
 * /notifications always sent an explicit `languages=` filter — and the
 * new-work preview reported "No open work matches your filters" while the
 * contributor page (which sends no language filter) happily listed the same
 * batches. This list previously added Kotlin/Swift and dropped SQL.
 */
export const WATCH_LANGUAGES = [
  "TypeScript",
  "JavaScript",
  "Python",
  "Java",
  "Go",
  "Rust",
  "SQL",
];

export interface WatchPrefs {
  enabled: boolean;
  categories: Record<DatasetCategory, boolean>;
  languages: Record<string, boolean>;
}

const DEFAULT_WATCH: WatchPrefs = {
  enabled: true,
  categories: {
    debugging: true,
    implementation: true,
    test_generation: true,
    error_diagnosis: true,
    migration: true,
  },
  languages: Object.fromEntries(WATCH_LANGUAGES.map((l) => [l, true])),
};

/** Does a bounty match the watch prefs? Language absent from the tracked set = allowed. */
export function watchMatches(prefs: WatchPrefs, b: Bounty): boolean {
  if (!prefs.enabled) return false;
  if (!prefs.categories[b.category]) return false;
  if (prefs.languages[b.language] === false) return false;
  return true;
}

/* ---------- auth ---------- */

export type AuthMethod = "google" | "email";
export interface AuthUser {
  name: string;
  email: string;
  /** Whether this account has a password set — Google-only accounts don't,
   * until they use set-password. Drives change-password vs set-password UI. */
  hasPassword: boolean;
  /** Google accounts are verified at creation; email/password accounts start
   * false until they click the emailed verification link. */
  emailVerified: boolean;
}

/** Dataset-scoping answers a sponsor gives during onboarding — used to pre-fill the create-bounty planner. */
export interface SponsorScope {
  domains: DomainId[];
  datasetTypeIds: string[];
  categories: DatasetCategory[];
  languages: string[];
  volume: string | null;
  uses: string[];
  note: string;
}

/* ---------- reputation / profile sources ---------- */

export type SourceId =
  | "linkedin"
  | "github"
  | "scholar"
  | "orcid"
  | "kaggle"
  | "x"
  | "website";

export interface ProfileSource {
  connected: boolean;
  handle: string;
  /** True only once the backend has actually verified this credential
   * (real OAuth for github/orcid). Manual entries (scholar/kaggle/linkedin/
   * x/website — no verification API available, or one not built yet) stay
   * false forever; the UI must render those as "Added", never "Verified". */
  verified: boolean;
  /** Server-owned credential health projection. `pending_recheck` requires a
   * reconnect; a verified source with verifyLastError was deferred because its
   * provider was unavailable, not because the user did anything wrong. */
  verificationState?: "unverified" | "verified" | "pending_recheck" | "invalid";
  lastCheckedAt?: string;
  nextCheckAt?: string;
  /** Whether this kind supports a real OAuth connect flow, vs. a manual
   * handle/URL entry. Server-authoritative for a real session — hydrated
   * per-request from GET /v1/me/profile-sources' `oauthCapableKinds` (see
   * hydrateProfileSources), not a hardcoded frontend copy of the backend's
   * provider registry. These defaults are only the prototype-mode (no
   * session) placeholder, same as DEFAULT_SOURCES itself. */
  oauthCapable: boolean;
  verifyChallenge?: string;
  verifyLastError?: string;
}

const DEFAULT_SOURCES: Record<SourceId, ProfileSource> = {
  linkedin: { connected: false, handle: "linkedin.com/in/you", verified: false, oauthCapable: false },
  github: { connected: false, handle: "github.com/you", verified: false, verificationState: "unverified", oauthCapable: true },
  scholar: { connected: false, handle: "Google Scholar profile", verified: false, oauthCapable: false },
  orcid: { connected: false, handle: "0000-0002-1825-0097", verified: false, verificationState: "unverified", oauthCapable: true },
  kaggle: { connected: false, handle: "kaggle.com/you", verified: false, oauthCapable: false },
  x: { connected: false, handle: "@you", verified: false, oauthCapable: false },
  website: { connected: false, handle: "yoursite.dev", verified: false, oauthCapable: false },
};

interface DemoState {
  authReady: boolean;
  signedIn: boolean;
  authMethod: AuthMethod | null;
  user: AuthUser | null;
  onboarded: boolean;
  hasRealSession: boolean;
  sponsorScope: SponsorScope | null;
  sessionConnected: boolean;
  sessionAddress: string;
  /** The launch is karma-only (single server flag `launch.community.enabled`, default
   * off, gating community activity) — session-connect CTAs
   * across the app read this instead of each duplicating the
   * /v1/meta/launch-flags fetch. */
  liveStatus: boolean;
  /** Server flag: may items be submitted from the dashboard UI at all?
   *  False today — contributions come in through the API / an MCP client, and
   *  the submit routes reject a dashboard session either way. */
  dashboardSubmissionsLive: boolean;
  telegramLinked: boolean;
  telegramHandle: string;
  channels: Record<ChannelId, Channel>;
  watchPrefs: WatchPrefs;
  sources: Record<SourceId, ProfileSource>;
  /** Server-computed once signed in (see hydrateProfileSources); the
   * prototype-mode default of 52 until hydration completes. */
  reputationScore: number;
  profileSummary: ProfileSummary;
  /** False until the first profile-sources hydration settles. */
  profileSourcesLoaded: boolean;
  /** Set when the last hydrateProfileSources() fetch failed — the profile
   * page must surface this rather than silently showing stale/default data
   * as if it were a real reputation summary. Cleared on next successful
   * fetch; call refreshProfileSources() to retry. */
  profileSourcesError: string | null;
  profilePublic: boolean;
  /** Landing-dashboard preference, persisted server-side on `User.persona`
   * and mirrored to localStorage for a flash-free first paint. Grants nothing
   * — see the `Persona` type for why there is no `roles` record beside it. */
  persona: Persona;
  /** Persists to the API and updates local state; false if the write failed
   * (state is left untouched so the UI never claims a save that didn't land). */
  setPersona: (p: Persona) => Promise<boolean>;
  /** True once the account may act: signed in with a verified email. This is
   * the real gate the API enforces, and the only one the UI should mirror. */
  canParticipate: boolean;
  bounties: Bounty[];
  delivered: Bounty[];
  availableBatches: ContributorBatch[];
  myBatches: ContributorBatch[];
  submissions: Submission[];
  availableAudits: AuditBatch[];
  /** Total open audit batches matching the queue filters (may exceed
   * availableAudits.length — the queue is paginated). */
  availableAuditsTotal: number;
  /** Open audit batches hidden for a conflict of interest — the validator's
   * own submission, a pool they sponsored themselves, or a near-duplicate of
   * their own work — surfaced so the UI can explain a gap instead of going
   * silent (these are real conflict-of-interest rules, not a bug). */
  availableAuditsConflictExcluded: number;
  /** The same count broken down by reason, so the UI can say WHICH conflict
   * applies instead of a single generic message that may not match this
   * validator's actual situation (e.g. a pool sponsor who never submitted
   * anything as a contributor). */
  availableAuditsConflictExcludedByReason: { ownSubmission: number; duplicateOfOwnWork: number };
  loadMoreAvailableAudits: () => Promise<void>;
  loadingMoreAudits: boolean;
  /** Current server-side filters applied to the available audit queue.
   * `kind` is the work type: "all", "enterprise" (karma) or "community" (karma). */
  auditFilters: AuditFilters;
  /** Replaces the audit filters and refetches the available queue from page
   * one — a distinct, lighter-weight call from refreshRoleDashboard so
   * changing a filter never re-fetches myAudits/profile too. */
  setAuditFilters: (filters: Partial<AuditFilters>) => void;
  myAudits: AuditBatch[];
  /** Private server-derived status buckets for this account's contributor and validator work. */
  workSummary: PersonalWorkSummary | null;
  roleDashboardLoading: { contributor: boolean; validator: boolean };
  roleDashboardError: { contributor: string | null; validator: string | null };
  refreshRoleDashboard: (role: "contributor" | "validator") => Promise<void>;
  notifications: Notification[];
  /** True once the inbox has more pages past what's currently loaded. */
  notifHasMore: boolean;
  /** True while a loadMoreNotifications() fetch is in flight. */
  loadingMoreNotifications: boolean;
  /** Server-computed total unread count (spans all pages) — always use this
   * instead of `notifications.filter(n => !n.read).length`. */
  unreadCount: number;
  /** Current inbox tab. */
  notifFilter: "all" | "unread";
  /** Switches the inbox tab, fetching the "unread" tab's first page from the
   * server (?unread=true) on first switch. */
  setNotifFilter: (filter: "all" | "unread") => void;
  /** Server-filtered (?unread=true) unread-only notification list — populated
   * once the "unread" tab has been opened at least once this session. */
  unreadNotifications: Notification[];
  unreadHasMore: boolean;
  loadingMoreUnread: boolean;
  loadMoreUnreadNotifications: () => void;
  /** Server-computed "matches right now" counts for the new-work alerts strip. */
  matchCounts: { batches: number; audits: number };
  disputes: Dispute[];
  /** Auth adapter is active. */
  
  applyAuthedSession: (
    method: AuthMethod,
    backendUser: {
      email: string | null;
      displayName: string;
      onboarded: boolean;
      roles: string[];
      hasPassword: boolean;
      emailVerified: boolean;
      sessionAddress?: string | null;
      accountChain?: string | null;
    }
  ) => void;
  /** Real email/password sign-up. Throws with a user-facing message on failure. */
  signUpWithEmail: (email: string, password: string, displayName: string) => Promise<void>;
  /** Real email/password sign-in. Throws with a user-facing message on failure. */
  signInWithEmail: (email: string, password: string) => Promise<void>;
  /** For accounts with a password already (change) — throws on failure. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** For a Google-only account adding its first password: mails a `set`-purpose
   * link (POST /v1/auth/request-set-password) that lands on /reset-password,
   * which submits token + new password. Since SEC-07 the API refuses to set a
   * first password from a bare session, so this is the only route. */
  requestSetPasswordEmail: () => Promise<void>;
  /** Re-sends the email/password signup's verification email. */
  resendVerification: () => Promise<void>;
  signOut: () => void;
  /** Resolves once the backend persona/onboarded state is persisted (or the
   * best-effort attempt has failed) — callers that navigate right after
   * onboarding must await this or the navigation can abort the in-flight
   * request and silently revert the onboarded flag. A null persona is valid:
   * the user is onboarded without a landing preference. */
  completeOnboarding: (persona: Persona, scope?: SponsorScope) => Promise<boolean>;
  /** OAuth-capable kinds (github/orcid) redirect to the provider and ignore
   * `handle`; other kinds store `handle` as an honest, unverified entry.
   * No-op in prototype mode without `handle` supplied for non-OAuth kinds. */
  connectSource: (id: SourceId, handle?: string) => Promise<void>;
  verifyWebsiteSource: () => Promise<void>;
  disconnectSource: (id: SourceId) => Promise<void>;
  /** Retries the last failed profile-sources fetch (see profileSourcesError). */
  refreshProfileSources: () => void;
  setProfilePublic: (on: boolean) => Promise<void>;
  noopConnect: () => Promise<void>;
  disnoopConnect: () => Promise<void>;
  linkTelegram: () => void;
  unlinkTelegram: () => void;
  startTelegramLink: () => Promise<notifApi.TelegramLink | null>;
  connectChannel: (id: ChannelId, address?: string) => Promise<{ ok: boolean; error?: string }>;
  connectSlack: () => Promise<boolean>;
  /** Re-pulls channel state from the server (used after the Slack OAuth redirect). */
  refreshChannels: () => Promise<void>;
  /** Lists channels the connected Slack bot token can see, for the picker. */
  fetchSlackChannelOptions: () => Promise<notifApi.SlackChannelList>;
  /** Picks (or switches) which Slack channel notifications deliver to. */
  selectSlackChannel: (channelId: string, channelName?: string) => Promise<{ ok: boolean; error?: string }>;
  /** Confirm the emailed one-time code; returns false on a bad/expired code. */
  verifyEmailCode: (id: ChannelId, code: string) => Promise<boolean>;
  /** Returns false if blocked (would leave zero delivery channels). */
  disconnectChannel: (id: ChannelId) => boolean;
  /** Returns false if blocked (must keep at least one delivery channel). */
  setChannelDeliver: (id: ChannelId, on: boolean) => boolean;
  testChannel: (id: ChannelId) => Promise<{ ok: boolean; error?: string }>;
  setWatchEnabled: (on: boolean) => void;
  toggleWatchCategory: (cat: DatasetCategory) => void;
  toggleWatchLanguage: (lang: string) => void;
  /** Records (or re-asks) the sponsor's dataset interests. This used to also
   * flip on a `sponsor` role row; there is no such role any more, so it now
   * only persists the scope. Returns true only if the write landed. */
  saveSponsorScope: (scope: SponsorScope) => Promise<boolean>;
  claimBatch: (id: string) => Promise<{ ok: boolean; error?: string }>;
  submitToBatch: (batchId: string, sub: Partial<Submission>) => string | null;
  reviseSubmission: (id: string) => void;
  respondToFlag: (submissionId: string, action: "fix" | "dispute") => void;
  claimAudit: (id: string) => Promise<boolean>;
  auditDecide: (
    auditId: string,
    itemId: string,
    decision: "ok" | "flagged",
    reason?: FlagReason
  ) => void;
  completeAudit: (auditId: string) => void;
  resolveDispute: (id: string, resolution: string) => void;
  datasetTypes: DatasetType[];
  /** Add a type to the catalog (admin: active/draft; sponsor: platform_review). Returns the id. */
  addDatasetType: (t: Omit<DatasetType, "version" | "usageCount">) => string;
  /** Patch a type; bumps its version. Live bounties keep the version they launched with. */
  updateDatasetType: (id: string, patch: Partial<DatasetType>) => void;
  /** Admin ruling on a platform_review type. Approving unblocks any bounty waiting on it. */
  decideTypeReview: (typeId: string, approved: boolean) => void;
  waitlisted: Partial<Record<DomainId, boolean>>;
  joinWaitlist: (domain: DomainId, email?: string) => void;
  /** Real domains/categories/languages/dataset types (GET /v1/meta/taxonomy).
   * Empty until hydrated — callers should treat [] as "loading", not "no
   * domains exist". */
  taxonomy: Taxonomy;
  /** Fetch-on-demand for surfaces that render outside the /onboarding route
   * (e.g. the OnboardingModal gate, shown on any page pre-onboarding). */
  refreshTaxonomy: () => Promise<void>;
  adminSetBountyStatus: (bountyId: string, status: Bounty["status"]) => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
  pushNotification: (n: Omit<Notification, "id" | "time" | "read">) => void;
  /** Fetches and appends the next page of older notifications. No-op if
   * already loading or there's nothing more. */
  loadMoreNotifications: () => void;
  /** Live transient toasts (see {@link Toast}). Rendered by the app-shell's
   * `<Toaster>`; use `pushToast` to raise one and let it auto-dismiss. */
  toasts: Toast[];
  /** Raise a transient toast. Returns its id. Errors default to a longer
   * on-screen lifetime so the user has time to read them. */
  pushToast: (t: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;
}

const DemoContext = createContext<DemoState | null>(null);

let idCounter = 100;
const nextId = (prefix: string) => `${prefix}-${idCounter++}`;

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname().replace(/\/+$/, "") || "/";
  const [authReady, setAuthReady] = useState(false);
  const [liveStatus, setLiveStatus] = useState(false);
  // Submitting items from the dashboard is currently API/MCP-only. Fails closed
  // to false so a failed flag read hides the form rather than showing one the
  // server would reject.
  const [dashboardSubmissionsLive, setDashboardSubmissionsLive] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [authMethod, setAuthMethod] = useState<AuthMethod | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [onboarded, setOnboarded] = useState(false);
  // Real backend session token (Google sign-in only, for now) — null means
  // "no real session," i.e. email/account sign-in, which stay mock-only.
  // True only for a real backend-verified session (Google or email) — the
  // session itself lives in an httpOnly cookie the page can't read.
  const [hasRealSession, setHasRealSession] = useState(false);
  const [sponsorScope, setSponsorScope] = useState<SponsorScope | null>(null);
  const [sessionConnected, setSessionConnected] = useState(false);
  const [sessionAddress, setSessionAddress] = useState("");
  const [sources, setSources] =
    useState<Record<SourceId, ProfileSource>>(DEFAULT_SOURCES);
  const [reputationScore, setReputationScore] = useState(52);
  const [profileSummary, setProfileSummary] = useState<ProfileSummary>(
    profileSourceApi.DEFAULT_PROFILE_SUMMARY
  );
  const [profileSourcesError, setProfileSourcesError] = useState<string | null>(null);
  // False until the first hydrateProfileSources settles, so surfaces reading
  // profileSummary (ranks/badges) can show a loading state instead of flashing
  // the DEFAULT_PROFILE_SUMMARY zeros as if they were the member's real data.
  const [profileSourcesLoaded, setProfileSourcesLoaded] = useState(false);
  const [profilePublic, setProfilePublic] = useState(false);
  const [channels, setChannels] =
    useState<Record<ChannelId, Channel>>(DEFAULT_CHANNELS);
  const [watchPrefs, setWatchPrefs] = useState<WatchPrefs>(DEFAULT_WATCH);
  const [watchPrefsReady, setWatchPrefsReady] = useState(false);
  const telegramLinked = channels.telegram.connected;
  const telegramHandle = channels.telegram.address || "@databounty_contributor";
  const [persona, setPersonaState] = useState<Persona>(() => readStoredPersona());
  const mirrorPersona = useCallback((p: Persona) => {
    setPersonaState(p);
    if (typeof window === "undefined") return;
    if (p === null) window.localStorage.removeItem(PERSONA_STORAGE_KEY);
    else window.localStorage.setItem(PERSONA_STORAGE_KEY, p);
  }, []);
  // Sponsor and pool pages hydrate their own authoritative API rows. Keep this
  // shared collection empty until a live workflow populates it; obsolete
  // lifecycle fixtures do not belong in the Community build.
  const [bounties, setBounties] = useState<Bounty[]>([]);
  // Hydrated from the live DB (GET /v1/batches) on session load — see the
  // effect below. Starts empty so the contributor browse page and the new-work
  // alert counts never show fabricated mock rows before the real fetch lands.
  const [availableBatches, setAvailableBatches] = useState<ContributorBatch[]>([]);
  const [myBatches, setMyBatches] = useState<ContributorBatch[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  // Hydrated from the live DB (GET /v1/audits) — see the effect below.
  // Legitimately empty until the validator pipeline creates AuditBatch rows.
  const [availableAudits, setAvailableAudits] = useState<AuditBatch[]>([]);
  const [availableAuditsTotal, setAvailableAuditsTotal] = useState(0);
  const [availableAuditsConflictExcluded, setAvailableAuditsConflictExcluded] = useState(0);
  const [availableAuditsConflictExcludedByReason, setAvailableAuditsConflictExcludedByReason] = useState({
    ownSubmission: 0,
    duplicateOfOwnWork: 0,
  });
  const [loadingMoreAudits, setLoadingMoreAudits] = useState(false);
  // Synchronous in-flight guard — the `loadingMoreAudits` state update isn't
  // visible until the next render, so two calls issued in the same tick (an
  // IntersectionObserver can fire more than once while the sentinel is still
  // visible) would both read loadingMoreAudits as false and double-fetch.
  const loadingMoreAuditsRef = useRef(false);
  const [auditFilters, setAuditFiltersState] = useState<AuditFilters>({
    domain: "all",
    category: "all",
    language: "all",
    kind: "all",
    search: "",
  });
  const auditFiltersRef = useRef(auditFilters);
  auditFiltersRef.current = auditFilters;
  // Pending debounce timer and request sequence for the available-audits
  // queue. The queue is refetched on every filter change, and the search axis
  // is a text input: without the timer it fired one request per keystroke
  // ("python" = 6 requests), and without the sequence a slow early response
  // could land after a newer one and repaint the list for a query the
  // validator had already typed past.
  const auditFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auditFetchSeqRef = useRef(0);
  const [myAudits, setMyAudits] = useState<AuditBatch[]>([]);
  const [workSummary, setWorkSummary] = useState<PersonalWorkSummary | null>(null);
  const [roleDashboardLoading, setRoleDashboardLoading] = useState({
    contributor: false,
    validator: false,
  });
  const [roleDashboardError, setRoleDashboardError] = useState<{
    contributor: string | null;
    validator: string | null;
  }>({ contributor: null, validator: null });
  const roleDashboardInFlight = useRef<Partial<Record<"contributor" | "validator", Promise<void>>>>({});
  const roleDashboardLoadedAt = useRef({ contributor: 0, validator: 0 });
  const [notifications, setNotifications] = useState<Notification[]>([]);
  // Cursor-pagination state for the inbox (GET /v1/notifications). `null`
  // cursor + `hasMore: false` after the first load means "fully caught up";
  // `null` cursor + `hasMore: true` is the pre-hydration default so the
  // very first render doesn't show a premature "no more" state.
  const [notifCursor, setNotifCursor] = useState<string | null>(null);
  const [notifHasMore, setNotifHasMore] = useState(true);
  const [loadingMoreNotifications, setLoadingMoreNotifications] = useState(false);
  // Server-computed total unread count (GET /v1/notifications `unreadCount`)
  // — spans ALL of a user's notifications, not just the loaded page, so
  // this is what the sidebar/mobile badges and inbox header must read.
  // Never derive unread count from `notifications.filter(n => !n.read)`,
  // which only reflects whatever pages have been fetched/loaded so far.
  const [unreadCount, setUnreadCount] = useState(0);
  // Inbox tab ("all" | "unread"). The "unread" tab is its own server-fetched,
  // cursor-paginated list (`?unread=true`) — never a client-side `.filter()`
  // over the "all" page's `notifications` array, which can be stale/partial.
  const [notifFilter, setNotifFilter] = useState<"all" | "unread">("all");
  const [unreadNotifications, setUnreadNotifications] = useState<Notification[]>([]);
  const [unreadCursor, setUnreadCursor] = useState<string | null>(null);
  const [unreadHasMore, setUnreadHasMore] = useState(true);
  const [loadingMoreUnread, setLoadingMoreUnread] = useState(false);
  const [unreadTabLoaded, setUnreadTabLoaded] = useState(false);
  // Server-computed "matches right now" counts for the new-work alerts strip
  // (GET /v1/batches|/v1/audits with categories/languages filters, reading
  // `total`) — never derived from availableBatches/availableAudits arrays.
  const [matchCounts, setMatchCounts] = useState<{ batches: number; audits: number }>({
    batches: 0,
    audits: 0,
  });
  const [disputes, setDisputes] = useState<Dispute[]>(DISPUTES);
  // Hydrated from the live DB catalog (GET /v1/planner/catalog). Starts empty
  // so create-bounty choices never come from stale local templates.
  const [datasetTypes, setDatasetTypes] =
    useState<DatasetType[]>([]);
  const [waitlisted, setWaitlisted] = useState<
    Partial<Record<DomainId, boolean>>
  >({});
  const [taxonomy, setTaxonomy] = useState<Taxonomy>(EMPTY_TAXONOMY);
  const refreshTaxonomy = useCallback(async () => {
    const t = await hydrateTaxonomy();
    if (t.domains.length || t.datasetTypes.length) setTaxonomy(t);
  }, []);
  const timeouts = useRef<ReturnType<typeof setTimeout>[]>([]);

  const pushNotification = useCallback(
    (n: Omit<Notification, "id" | "time" | "read">) => {
      setNotifications((prev) => [
        { ...n, id: nextId("n"), time: "just now", read: false },
        ...prev,
      ]);
    },
    []
  );

  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (t: Omit<Toast, "id">): string => {
      const id = nextId("toast");
      setToasts((prev) => [...prev, { ...t, id }]);
      // Errors linger (8s) so the user can actually read the reason; success/
      // info are briefer (4s). Timer is tracked so cleanup can clear it.
      const ttl = t.variant === "error" ? 8000 : 4000;
      const handle = setTimeout(() => dismissToast(id), ttl);
      timeouts.current.push(handle);
      return id;
    },
    [dismissToast]
  );

  const hydrateLiveNotifications = useCallback((options?: { includeSettings?: boolean }) => {
    setNotifications([]);
    setNotifCursor(null);
    setNotifHasMore(true);
    setUnreadNotifications([]);
    setUnreadCursor(null);
    setUnreadHasMore(true);
    setUnreadTabLoaded(false);
    setNotifFilter("all");
    notifApi
      .fetchNotifications()
      .then(({ notifications: fetched, nextCursor, unreadCount: count }) => {
        setNotifications(fetched);
        setNotifCursor(nextCursor);
        setNotifHasMore(nextCursor !== null);
        setUnreadCount(count);
      })
      .catch(() => {
        setNotifications([]);
        setNotifHasMore(false);
    });
    if (options?.includeSettings !== false) {
      notifApi.fetchChannels().then(setChannels).catch(() => {});
      notifApi
        .fetchWatchPrefs()
        .then((prefs) => {
          setWatchPrefs(prefs);
          setWatchPrefsReady(true);
        })
        .catch(() => {
          setWatchPrefsReady(true);
        });
    }
  }, []);

  // Background refresh so new notifications show up without a page reload.
  // Unlike hydrateLiveNotifications (one-shot, used right after sign-in —
  // clears first so nothing stale from a previous account lingers), this
  // MERGES onto the existing list rather than replacing it: markRead/
  // markAllRead update `read` optimistically and fire the PATCH in the
  // background (see below) without waiting for it, so a poll tick can land
  // before that PATCH does. Taking the server's `read` value as gospel would
  // then flash an already-read row back to unread for a moment. Since
  // nothing in this app ever marks a notification unread, "read" is
  // monotonic — keeping it true locally once set, regardless of what the
  // server says on any given tick, is both simpler and correct.
  //
  // This only ever refetches the newest page — older rows loaded via
  // loadMoreNotifications() are appended past the end of that page and kept
  // as-is, so a poll tick never truncates infinite-scroll progress. Cursor/
  // hasMore (which track the boundary AFTER the last loaded page) are left
  // untouched here for the same reason.
  const pollNotifications = useCallback(() => {
    const now = Date.now();
    if (notificationPollInFlight || now - notificationPolledAt < 1_000) return;
    notificationPollInFlight = notifApi
      .fetchNotifications()
      .then(({ notifications: fetched, unreadCount: count }) => {
        setNotifications((prev) => {
          const wasReadLocally = new Map(prev.map((n) => [n.id, n.read]));
          const merged = fetched.map((n) => ({ ...n, read: n.read || wasReadLocally.get(n.id) === true }));
          const mergedIds = new Set(merged.map((n) => n.id));
          const olderLoaded = prev.filter((n) => !mergedIds.has(n.id));
          return [...merged, ...olderLoaded];
        });
        setUnreadCount(count);
      })
      .catch(() => {})
      .finally(() => {
        notificationPolledAt = Date.now();
        notificationPollInFlight = null;
      });
  }, []);

  // Fetches the next page past `notifCursor` and appends it. Guards against
  // overlapping calls (rapid scroll-triggered intersections) and calling
  // past the end once the server has said there's nothing more.
  const loadMoreNotifications = useCallback(() => {
    if (!notifHasMore || !notifCursor || loadingMoreNotifications) return;
    setLoadingMoreNotifications(true);
    notifApi
      .fetchNotifications(notifCursor)
      .then(({ notifications: fetched, nextCursor }) => {
        setNotifications((prev) => {
          const existingIds = new Set(prev.map((n) => n.id));
          return [...prev, ...fetched.filter((n) => !existingIds.has(n.id))];
        });
        setNotifCursor(nextCursor);
        setNotifHasMore(nextCursor !== null);
      })
      .catch(() => setNotifHasMore(false))
      .finally(() => setLoadingMoreNotifications(false));
  }, [notifCursor, notifHasMore, loadingMoreNotifications]);

  // Fetches the first page of the "unread" tab (?unread=true) — a real
  // server-side filter. No-op if already loaded; hydrateLiveNotifications
  // resets unreadTabLoaded so a fresh sign-in re-fetches it.
  const loadUnreadTab = useCallback(() => {
    if (unreadTabLoaded) return;
    setUnreadTabLoaded(true);
    notifApi
      .fetchNotifications(undefined, true)
      .then(({ notifications: fetched, nextCursor }) => {
        setUnreadNotifications(fetched);
        setUnreadCursor(nextCursor);
        setUnreadHasMore(nextCursor !== null);
      })
      .catch(() => {
        setUnreadNotifications([]);
        setUnreadHasMore(false);
      });
  }, [unreadTabLoaded]);

  const setNotifFilterAndLoad = useCallback(
    (filter: "all" | "unread") => {
      setNotifFilter(filter);
      if (filter === "unread") loadUnreadTab();
    },
    [loadUnreadTab]
  );

  // Fetches the next page past `unreadCursor` and appends it (unread tab).
  const loadMoreUnreadNotifications = useCallback(() => {
    if (!unreadHasMore || !unreadCursor || loadingMoreUnread) return;
    setLoadingMoreUnread(true);
    notifApi
      .fetchNotifications(unreadCursor, true)
      .then(({ notifications: fetched, nextCursor }) => {
        setUnreadNotifications((prev) => {
          const existingIds = new Set(prev.map((n) => n.id));
          return [...prev, ...fetched.filter((n) => !existingIds.has(n.id))];
        });
        setUnreadCursor(nextCursor);
        setUnreadHasMore(nextCursor !== null);
      })
      .catch(() => setUnreadHasMore(false))
      .finally(() => setLoadingMoreUnread(false));
  }, [unreadCursor, unreadHasMore, loadingMoreUnread]);

  // Real credential/reputation state (GET /v1/me/profile-sources) — merges
  // server rows onto DEFAULT_SOURCES so unconnected kinds keep their
  // placeholder copy, and replaces the mock reputation estimate with the
  // server-computed score (real verified-credential count, not a client
  // toggle count).
  const hydrateProfileSources = useCallback(() => {
    const now = Date.now();
    if (profileHydrationInFlight || now - profileHydratedAt < 5_000) return;
    profileHydrationInFlight = profileSourceApi
      .fetchProfileSources()
      .then(({ sources: fetched, reputationScore: score, summary, oauthCapableKinds }) => {
        setSources((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(DEFAULT_SOURCES) as SourceId[]) {
            // oauthCapable is server truth for every kind (connected or not) —
            // never fall back to a hardcoded frontend copy of the provider
            // registry, so a kind added on the backend shows up correctly
            // here with zero frontend changes.
            next[key] = fetched[key]
              ? { ...fetched[key], oauthCapable: oauthCapableKinds.includes(key) }
              : { ...DEFAULT_SOURCES[key], oauthCapable: oauthCapableKinds.includes(key) };
          }
          return next;
        });
        setReputationScore(score);
        setProfileSummary(summary);
        setProfilePublic(summary.reputation.profilePublic);
        setProfileSourcesError(null);
        profileHydratedAt = Date.now();
      })
      .catch((err) => {
        setProfileSourcesError(err instanceof Error ? err.message : "Could not load your reputation profile.");
        profileHydratedAt = 0;
      })
      .finally(() => {
        profileHydrationInFlight = null;
        setProfileSourcesLoaded(true);
      });
  }, []);

  const refreshRoleDashboard = useCallback((role: "contributor" | "validator") => {
    const lastLoadedAt = roleDashboardLoadedAt.current[role];
    if (lastLoadedAt > 0 && Date.now() - lastLoadedAt < 30_000) return Promise.resolve();
    const existing = roleDashboardInFlight.current[role];
    if (existing) return existing;
    const request = (async () => {
      // Preserve already-rendered data during later freshness checks. Only a
      // user's first visit needs a blocking loading state.
      if (lastLoadedAt === 0) {
        setRoleDashboardLoading((current) => ({ ...current, [role]: true }));
      }
      setRoleDashboardError((current) => ({ ...current, [role]: null }));
      try {
        if (role === "contributor") {
          const data = await getContributorDashboard();
          if (!data) throw new Error("Contributor dashboard data is unavailable.");
          setMyBatches(data.batches);
          setSubmissions(data.submissions);
          setProfileSummary(data.profileSummary);
          setReputationScore(data.profileSummary.reputation.score);
          setProfilePublic(data.profileSummary.reputation.profilePublic);
          setWorkSummary(data.workSummary);
        } else {
          // Two requests, not one: GET /v1/me/validator-dashboard returns
          // `audits: []` by design (routes/v1/me.ts) — the queue, rank and
          // aggregate counts live there, but the validator's OWN claimed rows
          // come from GET /v1/me/audits. Treating that empty array as the
          // owned list emptied `myAudits` on every refresh, which is what made
          // the workspace lose active claims. Ordered unsettled-first and
          // capped at 200 (the API page cap) while the largest rank cap is 15
          // concurrent audits, so one page holds every active claim.
          const [data, owned] = await Promise.all([
            getValidatorDashboard(auditFilterParams(auditFiltersRef.current)),
            getMyAuditsPage({ limit: 200, skip: 0 }).catch(() => null),
          ]);
          if (!data) throw new Error("Validator dashboard data is unavailable.");
          // If the owned-audit call failed, keep what we already hold rather
          // than replacing it with the dashboard's intentionally-empty list.
          if (owned) setMyAudits(owned.audits);
          setAvailableAudits(data.availableAudits);
          setAvailableAuditsTotal(data.availableTotal);
          setAvailableAuditsConflictExcluded(data.conflictExcluded);
          setAvailableAuditsConflictExcludedByReason(data.conflictExcludedByReason);
          setProfileSummary(data.profileSummary);
          setReputationScore(data.profileSummary.reputation.score);
          setProfilePublic(data.profileSummary.reputation.profilePublic);
          setWorkSummary(data.workSummary);
        }
        roleDashboardLoadedAt.current[role] = Date.now();
      } catch (error) {
        if (lastLoadedAt === 0) {
          setRoleDashboardError((current) => ({
            ...current,
            [role]: error instanceof Error ? error.message : "Dashboard data is unavailable.",
          }));
        }
      } finally {
        setRoleDashboardLoading((current) => ({ ...current, [role]: false }));
      }
    })();
    roleDashboardInFlight.current[role] = request;
    void request.finally(() => {
      if (roleDashboardInFlight.current[role] === request) {
        delete roleDashboardInFlight.current[role];
      }
    });
    return request;
  }, []);

  // Pages the open audit queue past the first `availableAudits.length` rows
  // (the validator-dashboard endpoint caps a single response at 50). Appends
  // rather than replaces so scroll position and already-rendered cards stay
  // stable.
  const loadMoreAvailableAudits = useCallback(async () => {
    if (loadingMoreAuditsRef.current) return;
    loadingMoreAuditsRef.current = true;
    setLoadingMoreAudits(true);
    try {
      const data = await getValidatorDashboard({
        skip: availableAudits.length,
        ...auditFilterParams(auditFiltersRef.current),
      });
      if (!data) return;
      setAvailableAudits((current) => [...current, ...data.availableAudits]);
      setAvailableAuditsTotal(data.availableTotal);
      setAvailableAuditsConflictExcluded(data.conflictExcluded);
      setAvailableAuditsConflictExcludedByReason(data.conflictExcludedByReason);
    } finally {
      loadingMoreAuditsRef.current = false;
      setLoadingMoreAudits(false);
    }
  }, [availableAudits.length]);

  // Replaces the audit filters and refetches the available queue from page
  // one. Deliberately separate from refreshRoleDashboard/loadMoreAvailableAudits
  // — a filter change must reset pagination and never touches myAudits/profile.
  const setAuditFilters = useCallback(
    (filters: Partial<AuditFilters>) => {
      const previous = auditFiltersRef.current;
      const next = { ...previous, ...filters };
      auditFiltersRef.current = next;
      // The control stays fully responsive: state is applied on this tick, so
      // the text the validator typed is on screen immediately. Only the
      // REQUEST waits.
      setAuditFiltersState(next);

      const run = () => {
        auditFetchTimerRef.current = null;
        const mine = ++auditFetchSeqRef.current;
        const isStale = () => mine !== auditFetchSeqRef.current;
        setLoadingMoreAudits(true);
        void getValidatorDashboard(auditFilterParams(next))
          .then((data) => {
            if (!data || isStale()) return;
            setAvailableAudits(data.availableAudits);
            setAvailableAuditsTotal(data.availableTotal);
            setAvailableAuditsConflictExcluded(data.conflictExcluded);
            setAvailableAuditsConflictExcludedByReason(data.conflictExcludedByReason);
          })
          .finally(() => {
            // A stale request must not clear the spinner the newest one set,
            // or the list reads "ready" while a fetch is still running.
            if (!isStale()) setLoadingMoreAudits(false);
          });
      };

      if (auditFetchTimerRef.current) clearTimeout(auditFetchTimerRef.current);
      // Debounce only the free-text axis. A select (domain/category/language)
      // is one deliberate click, not a keystroke stream, so making it wait
      // 300ms would be latency with nothing to coalesce.
      if (next.search !== previous.search) {
        auditFetchTimerRef.current = setTimeout(run, SEARCH_DEBOUNCE_MS);
      } else {
        run();
      }
    },
    []
  );

  // Drop a pending queue refetch if the provider unmounts mid-debounce.
  useEffect(() => () => {
    if (auditFetchTimerRef.current) clearTimeout(auditFetchTimerRef.current);
  }, []);

  // Runs for the lifetime of a real session (refresh triggers: on focus, on
  // tab visibility, and a light poll) — not tied to
  // any one page, since the sidebar unread badge (components/app-shell.tsx)
  // needs live counts everywhere, not just on /notifications.
  useEffect(() => {
    if (!hasRealSession) return;
    const onFocus = () => pollNotifications();
    const onVisible = () => {
      if (document.visibilityState === "visible") pollNotifications();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") pollNotifications();
    }, 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [hasRealSession, pollNotifications]);

  // New-work alerts "matches right now" strip: server-computed counts, not a
  // client-side .filter() over availableBatches/availableAudits. Refetches
  // (debounced) whenever watch prefs change or on sign-in. Language filter
  // is omitted entirely when every watched language is on — equivalent to
  // "any language" — since the /v1/batches|/v1/audits `languages` param is
  // an inclusive allowlist and can't express "unlisted languages also
  // match", which only matters once at least one language has been toggled
  // off.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (!hasRealSession || !watchPrefsReady || !watchPrefs.enabled) {
        setMatchCounts({ batches: 0, audits: 0 });
        return;
      }
      const categories = (Object.keys(watchPrefs.categories) as DatasetCategory[]).filter(
        (cat) => watchPrefs.categories[cat]
      );
      const knownLanguages = taxonomy.languages.length > 0 ? taxonomy.languages : WATCH_LANGUAGES;
      const allLanguagesOn = knownLanguages.every((l) => watchPrefs.languages[l] !== false);
      const languages = allLanguagesOn
        ? undefined
        : knownLanguages.filter((l) => watchPrefs.languages[l] !== false);
      Promise.all([
        getAvailableBatchesCount({ categories, languages }),
        getAvailableAuditsCount({ categories, languages }),
      ]).then(([batches, audits]) => {
        if (!cancelled) setMatchCounts({ batches, audits });
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasRealSession, watchPrefs, watchPrefsReady, taxonomy.languages]);

  const setSubmissionStatus = useCallback(
    (id: string, status: SubmissionStatus, patch?: Partial<Submission>) => {
      setSubmissions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status, ...patch } : s))
      );
    },
    []
  );

  const createAuditForSubmission = useCallback(
    (submissionId: string) => {
      setSubmissions((subs) => {
        const sub = subs.find((s) => s.id === submissionId);
        if (!sub) return subs;
        setAvailableAudits((prev) => {
          if (prev.some((a) => a.items.some((it) => it.submissionId === submissionId))) {
            return prev;
          }
          const bounty = bounties.find((b) => b.id === sub.bountyId);
          const audit: AuditBatch = {
            id: nextId("ab"),
            bountyId: sub.bountyId,
            bountyTitle: bounty?.title ?? sub.bountyId,
            itemCount: 1,
            kind: "community",
            karmaReward: bounty?.karmaPerAcceptedItem ?? null,
            deadline: "24h after claim",
            status: "available",
            category: bounty?.category,
            language: bounty?.language,
            items: [{ id: nextId("ai"), submissionId, decision: "pending" }],
          };
          return [audit, ...prev];
        });
        pushNotification({
          type: "audit_available",
          title: "Validator audit available",
          body: `${sub.title} passed automated checks and is ready for validator audit.`,
          href: "/validator",
        });
        return subs;
      });
    },
    [bounties, pushNotification]
  );

  /** Simulate the validation pipeline stage-by-stage. */
  const runPipeline = useCallback(
    (id: string) => {
      const stages: [SubmissionStatus, number, Partial<Submission>?][] = [
        ["duplicate_check", 1200],
        ["running_tests", 3600, { duplicateScore: 0.11 }],
        [
          "llm_validation",
          5400,
          {
            execution: {
              brokenCodeFailedTests: true,
              fixedCodePassedTests: true,
              testsRun: 2,
              logs: SAMPLE_PASSING_LOGS,
              decision: "pass",
            },
          },
        ],
        ["provisionally_accepted", 7200, { llmScore: 0.84 }],
        ["in_audit", 8400],
      ];
      for (const [status, delay, patch] of stages) {
        timeouts.current.push(
          setTimeout(() => setSubmissionStatus(id, status, patch), delay)
        );
      }
      timeouts.current.push(
        setTimeout(() => {
          pushNotification({
            type: "submission_provisional",
            title: "Submission provisionally accepted",
            body: "Your item passed duplicate, execution, and LLM checks. It is now in the audit pool.",
            href: `/contributor/submissions/${id}`,
          });
          createAuditForSubmission(id);
        }, 7300)
      );
    },
    [createAuditForSubmission, pushNotification, setSubmissionStatus]
  );

  const noopConnect = useCallback(async () => {
    throw new Error("Account action not available.");
  }, []);

  const disnoopConnect = useCallback(async () => {
    setSessionConnected(false);
    setSessionAddress("");
  }, []);

  const signIn = useCallback((method: "google" | "email") => {
    void method;
    throw new Error("Sign-in method is disabled.");
  }, []);

  const signOut = useCallback(() => {
    // Revoke the session server-side too — the API clears the httpOnly
    // session cookie and deletes the session row. Fire-and-forget: this
    // must not block the client-side sign-out below.
    fetch(`${API_URL}${API.auth.logout}`, { method: "POST", credentials: "include" }).catch(() => {
      // Non-fatal — this device signs out either way.
    });
    setSignedIn(false);
    setAuthReady(true);
    setAuthMethod(null);
    setUser(null);
    setOnboarded(false);
    setSessionConnected(false);
    setSessionAddress("");
    setHasRealSession(false);
    setWatchPrefsReady(false);
    setSources(DEFAULT_SOURCES);
    setReputationScore(52);
    setProfileSummary(profileSourceApi.DEFAULT_PROFILE_SUMMARY);
    roleDashboardLoadedAt.current = { contributor: 0, validator: 0 };
    setMyBatches([]);
    setSubmissions([]);
    setMyAudits([]);
    setAvailableAudits([]);
    setWorkSummary(null);
  }, []);


  /** Apply a real backend session — sets signed-in state from the verified
   * user the API returned, not mock data. The session itself travels in an
   * httpOnly cookie the API just set, so there's no token to persist here;
   * a page refresh restores via GET /v1/auth/me with that cookie. Shared by
   * Google and email/password. */
  const applyAuthedSession = useCallback(
    (
      method: AuthMethod,
      backendUser: {
        email: string | null;
        displayName: string;
        onboarded: boolean;
        // Admin tiers only, and empty for an ordinary account — never read
        // this as "may not participate". See Persona in this file.
        roles: string[];
        persona?: string | null;
        hasPassword: boolean;
        emailVerified: boolean;
        sessionAddress?: string | null;
        accountChain?: string | null;
      }
    ) => {
      setAuthReady(true);
      setHasRealSession(true);
      setUser({
        name: backendUser.displayName,
        email: backendUser.email ?? "",
        hasPassword: backendUser.hasPassword,
        emailVerified: backendUser.emailVerified,
      });
      setAuthMethod(method);
      setSignedIn(true);
      setOnboarded(backendUser.onboarded);
      setSessionAddress(backendUser.sessionAddress ?? "");
      setSessionConnected(!!backendUser.sessionAddress);
      mirrorPersona(normalizePersona(backendUser.persona));
      hydrateLiveNotifications();
      hydrateProfileSources();
    },
    [mirrorPersona, hydrateLiveNotifications, hydrateProfileSources]
  );

  type BackendUser = {
    email: string | null;
    displayName: string;
    onboarded: boolean;
    roles: string[];
    persona?: string | null;
    hasPassword: boolean;
    emailVerified: boolean;
    authMethod: AuthMethod;
    sessionAddress?: string | null;
    accountChain?: string | null;
  };

  /** Shared POST helper for the auth endpoints below — parses the error
   * body into a clean thrown message instead of duplicating that dance
   * per call site. */
  const postAuth = useCallback(
    async (path: string, body: unknown): Promise<{ user: BackendUser }> => {
      const res = await fetch(`${API_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 429) {
          throw new Error("Too many attempts. Please wait a minute and try again.");
        }
        const parsed = await res.json().catch(() => ({}));
        throw new Error(safeMessage(parsed.message, "Something went wrong."));
      }
      return res.json();
    },
    []
  );

  const signUpWithEmail = useCallback(
    async (email: string, password: string, displayName: string) => {
      const data = await postAuth(API.auth.signup, { email, password, displayName });
      applyAuthedSession("email", data.user);
    },
    [postAuth, applyAuthedSession]
  );

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      const data = await postAuth(API.auth.login, { email, password });
      applyAuthedSession("email", data.user);
    },
    [postAuth, applyAuthedSession]
  );

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (!hasRealSession) throw new Error("You must be signed in to change your password.");
      const res = await authedFetch(API.auth.changePassword, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(safeMessage(body.message, "Couldn't change your password."));
      // The API revoked every session and set a fresh cookie on this response.
      setUser((u) => (u ? { ...u, hasPassword: true } : u));
    },
    [hasRealSession]
  );

  const requestSetPasswordEmail = useCallback(async () => {
    if (!hasRealSession) throw new Error("You must be signed in to request this.");
    const res = await authedFetch(API.auth.requestSetPassword, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(safeMessage(body.message, "Couldn't send that email."));
  }, [hasRealSession]);

  const resendVerification = useCallback(async () => {
    if (!hasRealSession) throw new Error("You must be signed in to request this.");
    const res = await authedFetch(API.auth.resendVerification, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(safeMessage(body.message, "Couldn't send that email."));
  }, [hasRealSession]);

  // Restore a real session on load (e.g. after a page refresh) — the session
  // lives in an httpOnly cookie, so just ask /me; a 401 (no/expired cookie)
  // simply means "not signed in". Never applies to the mock account sign-in.
  useEffect(() => {
    fetch(`${API_URL}${API.auth.me}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data: { user: BackendUser }) => {
        setAuthReady(true);
        setHasRealSession(true);
        setUser({
          name: data.user.displayName,
          email: data.user.email ?? "",
          hasPassword: data.user.hasPassword,
          emailVerified: data.user.emailVerified,
        });
        setAuthMethod(data.user.authMethod);
        setSignedIn(true);
        setOnboarded(data.user.onboarded);
        // Restore the persisted account connection so a page reload doesn't
        // re-prompt "connect" for an already-linked account (mirrors
        // applyAuthedSession — the sign-in path already does this).
        setSessionAddress(data.user.sessionAddress ?? "");
        setSessionConnected(!!data.user.sessionAddress);
        mirrorPersona(normalizePersona(data.user.persona));
        // Only the inbox count belongs to the persistent shell. Role history,
        // catalog, profile, channel settings, and work queues are loaded by
        // the route-scoped effect below so an Overview visit no longer starts
        // a platform-wide request storm.
        hydrateLiveNotifications({ includeSettings: false });
      })
      .catch(() => {
        // No/expired session cookie — stay signed out.
        setAuthReady(true);
      });
  }, [mirrorPersona, hydrateLiveNotifications]);

  // Public, session-independent — one fetch for every session-connect CTA in
  // the app shell instead of each duplicating the request. Fails closed to
  // false (no account nudge) on error, matching the server's own fail-closed default.
  useEffect(() => {
    fetch(`${API_URL}${API.meta.launchFlags}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data: { live?: boolean; dashboardSubmissions?: boolean }) => {
        setLiveStatus(Boolean(data.live));
        setDashboardSubmissionsLive(Boolean(data.dashboardSubmissions));
      })
      .catch(() => {});
  }, []);

  // Page-owned hydration: every route requests only the data it renders.
  // Internal navigation re-runs this effect, so direct loads and sidebar
  // clicks have identical behavior without speculative global preloading.
  useEffect(() => {
    if (!hasRealSession) return;
    let cancelled = false;

    // `/overview` is retired: it now only redirects, so hydrating its former
    // dashboard payload here would be three wasted requests per visit.
    // Hydrated for anyone signed in — these dashboards are no longer behind a
    // role, so gating the fetch on one would leave the page permanently empty
    // for a user who never ticked the old onboarding checkbox.
    if (pathname === "/contributor") {
      void refreshRoleDashboard("contributor");
    } else if (pathname === "/validator") {
      void refreshRoleDashboard("validator");
      // The audit queue's domain/category/language filter dropdowns read
      // options from the shared taxonomy, otherwise unhydrated outside /onboarding.
      void hydrateTaxonomy().then((t) => {
        if (!cancelled && (t.domains.length || t.categories.length)) setTaxonomy(t);
      });
    } else if (pathname === "/profile" || pathname === "/karma") {
      // `/karma`'s Badges section reads `profileSummary.badges` from this
      // exact same hydration call (app/(app)/karma/page.tsx:505) but was
      // missing from this branch — found live 2026-09-03: a real account
      // with 2 earned badges showed "No badges yet" whenever `/karma` was
      // the first authenticated page visited in a session, because nothing
      // had populated `profileSummary` yet. The backend was always correct
      // (confirmed via GET /v1/me/profile-sources returning both badges);
      // this was purely a missing trigger on the frontend.
      hydrateProfileSources();
    } else if (pathname === "/notifications") {
      void notifApi.fetchChannels().then((next) => {
        if (!cancelled) setChannels(next);
      }).catch(() => {});
      void notifApi
        .fetchWatchPrefs()
        .then((next) => {
          if (!cancelled) setWatchPrefs(next);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setWatchPrefsReady(true);
        });
    } else if (pathname.startsWith("/sponsor/") && pathname !== "/sponsor/create") {
      void hydrateDatasetCatalog().then((types) => {
        if (!cancelled && types.length) setDatasetTypes(types);
      });
    } else if (pathname === "/onboarding") {
      void hydrateTaxonomy().then((t) => {
        if (!cancelled) setTaxonomy(t);
      });
    } else if (pathname === "/sponsor/create") {
      void authedFetch(API.me.sponsorScope)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: SponsorScope | null) => {
          if (!cancelled && data) setSponsorScope(data);
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [hasRealSession, pathname, hydrateProfileSources, refreshRoleDashboard]);

  const completeOnboarding = useCallback(
    async (chosenPersona: Persona, scope?: SponsorScope): Promise<boolean> => {
      // Persona/scope UI state is cheap to re-derive and does NOT gate the
      // onboarding modal, so it's safe to reflect optimistically for a
      // responsive UI. The `onboarded` flag is the gate, and it must NOT be
      // flipped until the backend has actually recorded it — otherwise a
      // failed/aborted persist leaves the client thinking onboarding is done
      // while the server still has onboarded=false, and the modal silently
      // gets skipped or re-shown on the next load.
      mirrorPersona(chosenPersona);
      if (scope) setSponsorScope(scope);

      // Demo / mock sign-in: no server to persist to, so completion is local
      // only. Flip the gate and report success.
      if (!hasRealSession) {
        setOnboarded(true);
        return true;
      }

      try {
        // Unlike the retired roles POST, this succeeds with no persona at all:
        // a user who skips the choice is still onboarded, and lands on the
        // default dashboard. Nothing is gated on the answer.
        const res = await authedFetch(API.auth.onboardingComplete, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ persona: chosenPersona }),
        });
        // A non-2xx means the server did NOT record onboarded=true. Do not
        // flip the local gate. (A 401 is handled inside authedFetch, which
        // clears the session and reloads.)
        if (!res.ok) return false;
      } catch {
        // Network/transport failure — nothing was persisted. Fail closed.
        return false;
      }

      // Persist the sponsor intake too — previously this only ever lived
      // in local React state, so it silently reverted to nothing on
      // reload and the planner pre-fill (seedFromScope) never actually
      // fired for a returning sponsor. This is non-fatal to onboarding
      // itself (the POST above already committed onboarded=true), so a
      // failure here does not block completion.
      if (scope) {
        try {
          await authedFetch(API.me.sponsorScope, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(scope),
          });
        } catch {
          // Non-fatal — local sponsorScope state is already set above.
        }
      }

      // Backend confirmed onboarded=true; now it's safe to flip the gate.
      setOnboarded(true);
      // Onboarding claimed a handle, and claiming the first handle turns the
      // public page ON server-side. This store's `profilePublic` was hydrated
      // BEFORE that happened, so without a re-read /profile shows the master
      // toggle as "Off. Only you can see this page." while the page is in fact
      // live. Clearing the freshness stamp defeats the 5s throttle so the
      // refetch actually runs.
      profileHydratedAt = 0;
      hydrateProfileSources();
      return true;
    },
    [hasRealSession, mirrorPersona, hydrateProfileSources]
  );

  const connectSource = useCallback(
    async (id: SourceId, handle?: string) => {
      if (!hasRealSession) {
        throw new Error("Sign in to connect a real credential.");
      }
      if (sources[id].oauthCapable) {
        const url = await profileSourceApi.startProfileSourceConnect(id);
        if (url) window.location.assign(url);
        return;
      }
      if (id !== "website") {
        throw new Error("Verification for this credential is not available yet.");
      }
      if (!handle) return;
      const source = (await profileSourceApi.startWebsiteVerification(handle)).source;
      if (source) setSources((prev) => ({ ...prev, [id]: source }));
    },
    [hasRealSession, sources]
  );

  const verifyWebsiteSource = useCallback(async () => {
    if (!hasRealSession) {
      throw new Error("Sign in to verify a website.");
    }
    const source = await profileSourceApi.verifyWebsiteSource();
    setSources((prev) => ({ ...prev, website: source }));
    hydrateProfileSources();
  }, [hasRealSession, hydrateProfileSources]);

  const disconnectSource = useCallback(
    async (id: SourceId) => {
      if (!hasRealSession) {
        setSources((prev) => ({ ...prev, [id]: { ...prev[id], connected: false } }));
        return;
      }
      const ok = await profileSourceApi.disconnectProfileSource(id);
      if (!ok) return;
      setSources((prev) => ({ ...prev, [id]: { ...DEFAULT_SOURCES[id] } }));
      hydrateProfileSources();
    },
    [hasRealSession, hydrateProfileSources]
  );

  const updateProfilePublic = useCallback(
    async (on: boolean) => {
      const previous = profilePublic;
      setProfilePublic(on);
      if (!hasRealSession) return;
      try {
        const response = await authedFetch(API.me.publicProfile, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profilePublic: on }),
        });
        const saved = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(safeMessage(saved.message, "Could not update profile visibility."));
        setProfilePublic(saved.profilePublic === true);
      } catch (err) {
        setProfilePublic(previous);
        throw err;
      }
    },
    [hasRealSession, profilePublic]
  );

  const connectChannel = useCallback(
    async (id: ChannelId, address?: string): Promise<{ ok: boolean; error?: string }> => {
      const resolved = address || channels[id].address || DEFAULT_CHANNELS[id].address;
      // Email now requires an emailed code before it delivers (server-side), so
      // don't optimistically mark it delivering for a real session — reconcile
      // with the authoritative map instead. Prototype (no session) keeps the
      // old instant-on behavior. Webhooks are verified at connect server-side.
      if (hasRealSession) {
        const connected = await notifApi.connectChannel(id, resolved);
        if (!connected.ok) return connected;
        setChannels(connected.channels);
        // Email: a code was just emailed — tell the user to confirm it.
        if (id === "email") {
          pushNotification({
            type: "channel_connected",
            title: `Confirm your ${CHANNEL_LABEL[id]}`,
            body: `We emailed a verification code to ${resolved}. Enter it to start delivery.`,
            href: "/notifications",
          });
          return { ok: true };
        }
      } else {
        setChannels((prev) => ({
          ...prev,
          [id]: { connected: true, address: resolved, deliver: true, verified: true },
        }));
      }
      pushNotification({
        type: "channel_connected",
        title: `${CHANNEL_LABEL[id]} connected`,
        body: `Notifications will be delivered to your ${CHANNEL_LABEL[id]}. Manage channels in the notification center.`,
        href: "/notifications",
      });
      return { ok: true };
    },
    [channels, hasRealSession, pushNotification]
  );

  const connectSlack = useCallback(async (): Promise<boolean> => {
    if (!hasRealSession) {
      connectChannel("slack", DEFAULT_CHANNELS.slack.address);
      return true;
    }
    const url = await notifApi.startSlackConnect().catch(() => null);
    if (!url) return false;
    window.location.assign(url);
    return true;
  }, [connectChannel, hasRealSession]);

  // Confirm the emailed one-time code for the email channel. Returns false on a
  // bad/expired code so the UI can prompt again. No-op success in prototype mode.
  const verifyEmailCode = useCallback(
    async (id: ChannelId, code: string): Promise<boolean> => {
      if (!hasRealSession) {
        setChannels((prev) => ({ ...prev, [id]: { ...prev[id], deliver: true, verified: true } }));
        return true;
      }
      const next = await notifApi.verifyChannel(id, code).catch(() => null);
      if (!next) return false;
      setChannels(next);
      return true;
    },
    [hasRealSession]
  );

  // Re-pulls the authoritative channel list from the server — used after the
  // Slack OAuth redirect lands back on /notifications, since that's a full
  // page navigation whose outcome (connected vs error) the client can't know
  // without asking the server what actually got persisted.
  const refreshChannels = useCallback(async () => {
    if (!hasRealSession) return;
    const next = await notifApi.fetchChannels().catch(() => null);
    if (next) setChannels(next);
  }, [hasRealSession]);

  // Slack bot-token OAuth completes with no channel picked yet — list the
  // workspace's channels for the in-app picker (prototype mode has nothing to list).
  const fetchSlackChannelOptions = useCallback(async (): Promise<notifApi.SlackChannelList> => {
    if (!hasRealSession) return { channels: [], privateChannelsUnavailable: false };
    return notifApi
      .fetchSlackChannels()
      .catch(() => ({ channels: [], privateChannelsUnavailable: false, error: "Couldn't reach Slack — try again." }));
  }, [hasRealSession]);

  const selectSlackChannel = useCallback(
    async (channelId: string, channelName?: string): Promise<{ ok: boolean; error?: string }> => {
      if (!hasRealSession) {
        setChannels((prev) => ({
          ...prev,
          slack: { ...prev.slack, verified: true, deliver: true, channelLabel: channelName ? `#${channelName}` : null },
        }));
        return { ok: true };
      }
      const res = await notifApi.selectSlackChannel(channelId, channelName).catch(
        () => ({ ok: false as const, error: "Could not select that channel." })
      );
      if (res.ok) setChannels(res.channels);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
    [hasRealSession]
  );

  const disconnectChannel = useCallback(
    (id: ChannelId): boolean => {
      // can't remove the last channel that's actively delivering
      if (channels[id].deliver && deliveringCount(channels) === 1) return false;
      setChannels((prev) => ({
        ...prev,
        [id]: { ...prev[id], connected: false, deliver: false },
      }));
      // Persist + reconcile with the API's authoritative view (it enforces the
      // same last-channel rule server-side).
      if (hasRealSession) {
        notifApi.disconnectChannel(id).then((next) => next && setChannels(next)).catch(() =>
          pushToast({ variant: "error", title: "Couldn't disconnect channel", body: "Your change wasn't saved. Please try again." })
        );
      }
      return true;
    },
    [channels, hasRealSession, pushToast]
  );

  const setChannelDeliver = useCallback(
    (id: ChannelId, on: boolean): boolean => {
      if (!channels[id].connected) return false;
      // must keep at least one delivery channel enabled
      if (!on && channels[id].deliver && deliveringCount(channels) === 1)
        return false;
      setChannels((prev) => ({ ...prev, [id]: { ...prev[id], deliver: on } }));
      if (hasRealSession) {
        notifApi.patchChannel(id, { deliver: on }).then((next) => next && setChannels(next)).catch(() =>
          pushToast({ variant: "error", title: "Couldn't update delivery", body: "Your change wasn't saved. Please try again." })
        );
      }
      return true;
    },
    [channels, hasRealSession, pushToast]
  );

  // Send a real one-off test alert to a single channel. In prototype mode
  // (no session) there's no backend to deliver, so report success optimistically.
  const testChannel = useCallback(
    async (id: ChannelId): Promise<{ ok: boolean; error?: string }> => {
      if (!channels[id].connected || !channels[id].verified) {
        return { ok: false, error: "Connect and verify this channel first." };
      }
      if (!hasRealSession) return { ok: true };
      const result: { ok: boolean; error?: string; channels?: Record<ChannelId, Channel> } = await notifApi
        .sendChannelTest(id)
        .catch(() => ({ ok: false, error: "Test delivery failed." }));
      // The API clears lastError and can re-enable a channel after a healthy
      // test. Apply its authoritative state immediately rather than leaving
      // the old warning visible until the next page hydration.
      if (result.ok && result.channels) setChannels(result.channels);
      return result;
    },
    [channels, hasRealSession]
  );

  const persistWatch = useCallback(
    (prev: WatchPrefs, next: WatchPrefs) => {
      if (!hasRealSession) return;
      notifApi
        .putWatchPrefs(next)
        .then((res) => {
          if (!res.ok) {
            setWatchPrefs(prev);
            pushToast({
              variant: "error",
              title: "Couldn't save alert preferences",
              body: "Your change wasn't saved. Please try again.",
            });
          }
        })
        .catch(() => {
          setWatchPrefs(prev);
          pushToast({
            variant: "error",
            title: "Couldn't save alert preferences",
            body: "Your change wasn't saved. Please try again.",
          });
        });
    },
    [hasRealSession, pushToast]
  );
  const setWatchEnabled = useCallback(
    (on: boolean) => {
      setWatchPrefs((p) => {
        const next = { ...p, enabled: on };
        persistWatch(p, next);
        return next;
      });
    },
    [persistWatch]
  );
  const toggleWatchCategory = useCallback(
    (cat: DatasetCategory) => {
      setWatchPrefs((p) => {
        const next = { ...p, categories: { ...p.categories, [cat]: !p.categories[cat] } };
        persistWatch(p, next);
        return next;
      });
    },
    [persistWatch]
  );
  const toggleWatchLanguage = useCallback(
    (lang: string) => {
      setWatchPrefs((p) => {
        const next = { ...p, languages: { ...p.languages, [lang]: !(p.languages[lang] ?? true) } };
        persistWatch(p, next);
        return next;
      });
    },
    [persistWatch]
  );

  const linkTelegram = useCallback(
    () => connectChannel("telegram"),
    [connectChannel]
  );
  const unlinkTelegram = useCallback(
    () => {
      disconnectChannel("telegram");
    },
    [disconnectChannel]
  );
  // Telegram can't be connected with an address like the others — it needs the
  // bot link flow. Start it (real session) to get a code the user sends to the
  // bot; the webhook then links the channel. Returns null in demo/no-session.
  const startTelegramLink = useCallback(async (): Promise<notifApi.TelegramLink | null> => {
    if (!hasRealSession) {
      connectChannel("telegram");
      return null;
    }
    return notifApi.startTelegramLink();
  }, [hasRealSession, connectChannel]);
  // Toggle a participation mode (sponsor/contributor/validator). These are
  // Landing-dashboard preference. The server stays authoritative: don't move
  // the visible selection until the write lands, so an offline database can't
  // leave the UI showing a preference that was never saved.
  //
  // This replaced toggleRole(). That function enabled/disabled a participation
  // role and had to sequence a dashboard refetch after it, because reading the
  // dashboard could race the grant and 403. Nothing is granted here, so there
  // is no race and no refetch to order.
  const setPersona = useCallback(
    async (next: Persona): Promise<boolean> => {
      if (!hasRealSession) {
        pushToast({
          variant: "error",
          title: "Can't save that right now",
          body: "Sign in again, then choose your default dashboard.",
        });
        return false;
      }
      const previous = persona;
      try {
        const response = await authedFetch(API.auth.onboardingComplete, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ persona: next }),
        });
        if (!response.ok) throw new Error("The database could not save your preference.");
        mirrorPersona(next);
        return true;
      } catch (error) {
        // A 401 is handled inside authedFetch (clears session + reloads).
        mirrorPersona(previous);
        pushToast({
          variant: "error",
          title: "Couldn't save your default dashboard",
          body: error instanceof Error ? error.message : "The database is unavailable. Please try again.",
        });
        return false;
      }
    },
    [persona, hasRealSession, pushToast, mirrorPersona]
  );

  // Records (or re-asks) the sponsor's dataset interests, so a sponsor who
  // skipped the questions at onboarding — or wants to change them — never
  // leaves language/dataset-type preferences unset for the planner pre-fill.
  //
  // Formerly enableSponsorRole: it saved the scope AND flipped on a `sponsor`
  // role row, ordered carefully so a mid-flight failure couldn't leave an
  // enabled role with no intake data. There is no sponsor role now, so this is
  // a single write and that failure mode is gone.
  const saveSponsorScope = useCallback(
    async (scope: SponsorScope) => {
      if (!hasRealSession) {
        pushToast({
          variant: "error",
          title: "Can't save that right now",
          body: "Sign in again, then set your dataset interests.",
        });
        return false;
      }
      try {
        const scopeResponse = await authedFetch(API.me.sponsorScope, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(scope),
        });
        if (!scopeResponse.ok) throw new Error("The database could not save your dataset scope.");
        setSponsorScope(scope);
        return true;
      } catch (error) {
        pushToast({
          variant: "error",
          title: "Couldn't save your dataset interests",
          body: error instanceof Error ? error.message : "The database is unavailable. Please try again.",
        });
        return false;
      }
    },
    [hasRealSession, pushToast]
  );

  // Mirrors the only gate the API actually applies to work actions
  // (requireVerifiedEmail). Nothing about sponsor/contributor/validator enters
  // it — those are landing preferences, not permissions.
  const canParticipate = signedIn && !!user?.emailVerified;

  const claimBatch = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      // No client-side role precheck: claiming needs a verified email and an
      // unclaimed batch, both of which only the server can judge. The old
      // `roles.contributor` guard blocked the request outright and showed
      // "Contributor role required" to users who were perfectly entitled.
      // Real claim only — a rejected claim (concurrency limit, lost race,
      // already claimed) must surface the backend's reason, never be faked
      // as a success.
      const result = await claimBatchReal(id);
      if (!result.ok) {
        pushToast({ variant: "error", title: "Couldn't claim batch", body: result.error });
        return { ok: false, error: result.error };
      }
      const claimed = result.batch;
      setAvailableBatches((prev) => prev.filter((b) => b.id !== id));
      setMyBatches((prev) => [claimed, ...prev.filter((b) => b.id !== id)]);
      pushNotification({
        type: "task_claimed",
        title: "Task batch claimed",
        body: `${claimed.bountyTitle} — ${claimed.slotName}: ${claimed.itemCount} items. Expected reward ${claimed.expectedReward} karma.`,
        href: "/contributor",
      });
      pushToast({
        variant: "success",
        title: "Task batch claimed",
        body: `${claimed.slotName} — ${claimed.itemCount} items reserved.`,
      });
      return { ok: true };
    },
    [pushNotification, pushToast]
  );

  const submitToBatch = useCallback(
    (batchId: string, sub: Partial<Submission>): string | null => {
      // Mock/prototype path only (the real submit goes through the API and is
      // gated there). No role precheck — see claimBatch above.
      const id = nextId("sub");
      const base = MY_SUBMISSIONS[0];
      const full: Submission = {
        ...base,
        ...sub,
        id,
        batchId,
        status: "submitted",
        duplicateScore: undefined,
        llmScore: undefined,
        execution: undefined,
        flags: [],
        submittedAt: "2026-07-05",
      } as Submission;
      setSubmissions((prev) => [full, ...prev]);
      setMyBatches((prev) =>
        prev.map((b) =>
          b.id === batchId
            ? { ...b, submittedCount: Math.min(b.itemCount, b.submittedCount + 1) }
            : b
        )
      );
      runPipeline(id);
      return id;
    },
    [runPipeline]
  );

  const reviseSubmission = useCallback(
    (id: string) => {
      setSubmissionStatus(id, "submitted", {
        reviewNotes: [],
        execution: undefined,
      });
      runPipeline(id);
    },
    [runPipeline, setSubmissionStatus]
  );

  const respondToFlag = useCallback(
    (submissionId: string, action: "fix" | "dispute") => {
      if (action === "fix") {
        setSubmissions((prev) =>
          prev.map((s) =>
            s.id === submissionId
              ? {
                  ...s,
                  status: "submitted",
                  flags: s.flags.map((f) => ({ ...f, status: "fixed" as const })),
                }
              : s
          )
        );
        runPipeline(submissionId);
      } else {
        setSubmissions((prev) =>
          prev.map((s) =>
            s.id === submissionId
              ? {
                  ...s,
                  status: "disputed",
                  flags: s.flags.map((f) => ({ ...f, status: "disputed" as const })),
                }
              : s
          )
        );
        // the dispute actually lands in the admin queue
        const s = submissions.find((x) => x.id === submissionId);
        if (s) {
          const bounty = bounties.find((b) => b.id === s.bountyId);
          setDisputes((prev) => [
            {
              id: nextId("disp"),
              bountyTitle: bounty?.title ?? s.bountyId,
              submissionTitle: s.title,
              flagReason: s.flags[0]?.reason ?? "solution_incorrect",
              contributorArgument:
                "Contributor disputes the flag: the submitted fix satisfies the prompt as written and passes the executable tests.",
              validatorArgument:
                s.flags[0]?.details ?? "Validator flagged the item during audit.",
              status: "open",
            },
            ...prev,
          ]);
        }
        pushNotification({
          type: "issue_disputed",
          title: "Flag disputed",
          body: "Your dispute was sent to platform review. An admin will resolve it within 48h.",
          href: `/contributor/submissions/${submissionId}`,
        });
      }
    },
    [pushNotification, runPipeline, submissions, bounties]
  );

  const claimAudit = useCallback(
    async (id: string) => {
      const audit = availableAudits.find((a) => a.id === id);
      if (!audit) return false;
      const realAudit = await claimAuditReal(id);
      if (!realAudit) {
        pushToast({
          variant: "error",
          title: "Audit claim failed",
          body: "This audit may already be claimed, or you may not be eligible (you can't audit your own submissions).",
        });
        return false;
      }
        setAvailableAudits((prev) => prev.filter((a) => a.id !== id));
      setMyAudits((prev) => [realAudit, ...prev.filter((a) => a.id !== id)]);
      const karmaReward = realAudit.karmaReward ?? audit.karmaReward;
      const rewardLine = karmaReward == null
        ? ""
        : `Earns ${karmaReward} karma per accepted item.`;
      // Real deadline from the claim response rather than a hardcoded "24h" —
      // the window is set server-side on claim and differs per bounty. Formatted
      // (not the raw ISO string the API returns) via the shared helper.
      const deadlineLine = realAudit.deadline ? `${deadlineLabel(realAudit.deadline)}.` : "";
        pushNotification({
          type: "audit_claimed",
          title: "Audit batch claimed",
          body: [`${audit.bountyTitle}: review ${audit.itemCount} items.`, deadlineLine, rewardLine]
            .filter(Boolean)
            .join(" "),
          href: `/validator/audit/${audit.id}`,
        });
      pushToast({
        variant: "success",
        title: "Audit batch claimed",
        body: [`Review ${audit.itemCount} items.`, deadlineLine].filter(Boolean).join(" "),
      });
      return true;
    },
    [availableAudits, pushNotification, pushToast]
  );

  const auditDecide = useCallback(
    (auditId: string, itemId: string, decision: "ok" | "flagged", reason?: FlagReason) => {
      const audit = myAudits.find((a) => a.id === auditId);
      const item = audit?.items.find((it) => it.id === itemId);
      const submission = item ? submissions.find((s) => s.id === item.submissionId) : undefined;
      setMyAudits((prev) =>
        prev.map((a) =>
          a.id === auditId
            ? {
                ...a,
                items: a.items.map((it) =>
                  it.id === itemId ? { ...it, decision, flagReason: reason } : it
                ),
              }
            : a
        )
      );
      if (item) {
        if (decision === "ok") {
          setSubmissions((prev) =>
            prev.map((s) =>
              s.id === item.submissionId
                ? { ...s, status: "accepted", flags: [] }
                : s
            )
          );
          if (submission) {
            setBounties((prev) =>
              prev.map((b) =>
                b.id === submission.bountyId
                  ? { ...b, acceptedItems: b.acceptedItems + 1 }
                  : b
              )
            );
          }
        } else {
          setSubmissions((prev) =>
            prev.map((s) =>
              s.id === item.submissionId
                ? {
                    ...s,
                    status: "flagged",
                    flags: [
                      {
                        id: nextId("flag"),
                        submissionId: s.id,
                        validatorUserId: null,
                        reason: reason ?? "other",
                        details: "Flagged during validator audit.",
                        status: "open",
                      },
                    ],
                  }
                : s
            )
          );
        }
      }
      if (decision === "flagged") {
        pushNotification({
          type: "issue_flagged",
          title: "Item flagged",
          body: `${submission?.title ?? "An audited item"} was flagged during audit.${reason ? ` Reason: ${reason}.` : ""}`,
          href: submission ? `/contributor/submissions/${submission.id}` : "/validator",
        });
      }
    },
    [myAudits, pushNotification, submissions]
  );

  const completeAudit = useCallback(
    (auditId: string) => {
      setMyAudits((prev) =>
        prev.map((a) => (a.id === auditId ? { ...a, status: "completed" } : a))
      );
      const audit = myAudits.find((a) => a.id === auditId);
      const approved = audit?.items.filter((it) => it.decision === "ok") ?? [];
      for (const item of approved) {
        const sub = submissions.find((s) => s.id === item.submissionId);
        if (!sub) continue;
        const bounty = bounties.find((b) => b.id === sub.bountyId);
        if (bounty?.status === "active") {
          pushNotification({
            type: "sample_items_ready",
            title: "Sample items ready for review",
            body: `${bounty.title}: accepted items are ready for review.`,
            href: `/sponsor/${bounty.id}`,
          });
        }
      }
      pushNotification({
        type: "audit_completed",
        title: "Audit completed",
        body: "Karma for approved work is pending. Confirmed issues are recorded with the audit.",
        href: "/validator",
      });
    },
    [bounties, myAudits, pushNotification, submissions]
  );

  const resolveDispute = useCallback(
    (id: string, resolution: string) => {
      setDisputes((prev) =>
        prev.map((d) =>
          d.id === id ? { ...d, status: "resolved", resolution } : d
        )
      );
      pushNotification({
        type: "dispute_resolved",
        title: "Dispute resolved by platform review",
        body: `Ruling: ${resolution}`,
        href: "/contributor",
      });
    },
    [pushNotification]
  );

  const addDatasetType = useCallback(
    (t: Omit<DatasetType, "version" | "usageCount">): string => {
      const full: DatasetType = { ...t, version: 1, usageCount: 0 };
      setDatasetTypes((prev) => [full, ...prev]);
      if (t.status === "platform_review") {
        pushNotification({
          type: "type_in_review",
          title: "Custom dataset type submitted for review",
          body: `"${t.name}" is with the platform team. Your bounty can launch as soon as the type is approved (usually < 24h).`,
          href: "/sponsor",
        });
      }
      return full.id;
    },
    [pushNotification]
  );

  const updateDatasetType = useCallback(
    (id: string, patch: Partial<DatasetType>) => {
      setDatasetTypes((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, ...patch, version: t.version + 1 } : t
        )
      );
    },
    []
  );

  const decideTypeReview = useCallback(
    (typeId: string, approved: boolean) => {
      const t = datasetTypes.find((x) => x.id === typeId);
      setDatasetTypes((prev) =>
        prev.map((x) =>
          x.id === typeId
            ? { ...x, status: approved ? "active" : "draft", version: x.version + 1 }
            : x
        )
      );
      if (approved) {
        // unblock any bounty that was waiting on this type
        const blocked = bounties.filter(
          (b) => b.datasetTypeId === typeId && b.status === "platform_review"
        );
        setBounties((prev) =>
          prev.map((b) =>
            b.datasetTypeId === typeId && b.status === "platform_review"
              ? {
                  ...b,
                  status: "active",
                }
              : b
          )
        );
        if (blocked.length > 0) {
          for (const b of blocked) {
            pushNotification({
              type: "type_approved",
              title: `Dataset type approved — "${t?.name ?? typeId}"`,
              body: `${b.title} is now active.`,
              href: `/sponsor/${b.id}`,
            });
          }
        } else {
          pushNotification({
            type: "type_approved",
            title: `Dataset type approved — "${t?.name ?? typeId}"`,
            body: "The type is now live in the catalog.",
            href: "/sponsor",
          });
        }
      } else {
        pushNotification({
          type: "type_rejected",
          title: `Dataset type needs changes — "${t?.name ?? typeId}"`,
          body: "Platform review moved it back to draft. Revise the schema and resubmit.",
          href: "/sponsor",
        });
      }
    },
    [datasetTypes, bounties, pushNotification]
  );

  const joinWaitlist = useCallback(
    (domain: DomainId, email?: string) => {
      setWaitlisted((prev) => ({ ...prev, [domain]: true }));
      const d = DOMAINS.find((x) => x.id === domain);
      pushNotification({
        type: "waitlist_joined",
        title: `You're on the ${d?.name ?? domain} expert waitlist`,
        body: `${
          email ? `We'll write to ${email}` : "We'll notify you"
        } the moment this domain opens for bounties and validator work.`,
        href: `/domains/${domain}`,
      });
    },
    [pushNotification]
  );

  const adminSetBountyStatus = useCallback(
    (bountyId: string, status: Bounty["status"]) => {
      setBounties((prev) =>
        prev.map((b) => (b.id === bountyId ? { ...b, status } : b))
      );
    },
    []
  );

  const markAllRead = useCallback(() => {
    const prevSnapshot = notifications;
    const prevUnreadCount = unreadCount;
    const prevUnreadTab = unreadNotifications;
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    setUnreadNotifications([]);
    if (hasRealSession) {
      notifApi.markAllRead().catch(() => {
        setNotifications(prevSnapshot);
        setUnreadCount(prevUnreadCount);
        setUnreadNotifications(prevUnreadTab);
      });
    }
  }, [hasRealSession, notifications, unreadCount, unreadNotifications]);

  const markRead = useCallback(
    (id: string) => {
      const prevSnapshot = notifications;
      const prevUnreadCount = unreadCount;
      const prevUnreadTab = unreadNotifications;
      const wasUnread = notifications.some((n) => n.id === id && !n.read);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n))
      );
      setUnreadNotifications((prev) => prev.filter((n) => n.id !== id));
      if (wasUnread) setUnreadCount((c) => Math.max(0, c - 1));
      if (hasRealSession) {
        notifApi.markRead(id).catch(() => {
          setNotifications(prevSnapshot);
          setUnreadCount(prevUnreadCount);
          setUnreadNotifications(prevUnreadTab);
        });
      }
    },
    [hasRealSession, notifications, unreadCount, unreadNotifications]
  );

  const value = useMemo<DemoState>(
    () => ({
      signedIn,
      authMethod,
      authReady,
      liveStatus,
      dashboardSubmissionsLive,
      user,
      onboarded,
      hasRealSession,
      sponsorScope,
      sessionConnected,
      sessionAddress,
      telegramLinked,
      telegramHandle,
      channels,
      watchPrefs,
      sources,
      reputationScore,
      profileSummary,
      profileSourcesLoaded,
      profileSourcesError,
      profilePublic,
      persona,
      setPersona,
      canParticipate,
      bounties,
      delivered: DELIVERED_BOUNTIES,
      availableBatches,
      myBatches,
      submissions,
      availableAudits,
      availableAuditsTotal,
      availableAuditsConflictExcluded,
      availableAuditsConflictExcludedByReason,
      loadMoreAvailableAudits,
      loadingMoreAudits,
      auditFilters,
      setAuditFilters,
      myAudits,
      workSummary,
      roleDashboardLoading,
      roleDashboardError,
      refreshRoleDashboard,
      notifications,
      notifHasMore,
      loadingMoreNotifications,
      unreadCount,
      notifFilter,
      setNotifFilter: setNotifFilterAndLoad,
      unreadNotifications,
      unreadHasMore,
      loadingMoreUnread,
      loadMoreUnreadNotifications,
      matchCounts,
      disputes,
      datasetTypes,
      addDatasetType,
      updateDatasetType,
      decideTypeReview,
      waitlisted,
      joinWaitlist,
      taxonomy,
      refreshTaxonomy,
      signIn,
      applyAuthedSession,
      signUpWithEmail,
      signInWithEmail,
      changePassword,
      requestSetPasswordEmail,
      resendVerification,
      signOut,
      completeOnboarding,
      connectSource,
      verifyWebsiteSource,
      disconnectSource,
      refreshProfileSources: hydrateProfileSources,
      setProfilePublic: updateProfilePublic,
      noopConnect,
      disnoopConnect,
      linkTelegram,
      unlinkTelegram,
      startTelegramLink,
      connectChannel,
      connectSlack,
      refreshChannels,
      fetchSlackChannelOptions,
      selectSlackChannel,
      verifyEmailCode,
      disconnectChannel,
      setChannelDeliver,
      testChannel,
      setWatchEnabled,
      toggleWatchCategory,
      toggleWatchLanguage,
      saveSponsorScope,
      claimBatch,
      submitToBatch,
      reviseSubmission,
      respondToFlag,
      claimAudit,
      auditDecide,
      completeAudit,
      resolveDispute,
      adminSetBountyStatus,
      markAllRead,
      markRead,
      pushNotification,
      loadMoreNotifications,
      toasts,
      pushToast,
      dismissToast,
    }),
    [
      signedIn, authMethod, authReady, liveStatus, dashboardSubmissionsLive, user, onboarded, hasRealSession, sponsorScope,
      sessionConnected, sessionAddress, telegramLinked,
      telegramHandle, channels, watchPrefs, sources, reputationScore, profileSummary, profileSourcesLoaded, profileSourcesError, profilePublic,
      persona, setPersona, canParticipate,
      bounties, availableBatches, myBatches, submissions, availableAudits,
      availableAuditsTotal, availableAuditsConflictExcluded, availableAuditsConflictExcludedByReason, loadMoreAvailableAudits, loadingMoreAudits,
      auditFilters, setAuditFilters,
      myAudits, workSummary, roleDashboardLoading, roleDashboardError, refreshRoleDashboard,
      notifications, notifHasMore, loadingMoreNotifications, unreadCount,
      notifFilter, setNotifFilterAndLoad, unreadNotifications, unreadHasMore, loadingMoreUnread, loadMoreUnreadNotifications,
      matchCounts,
      disputes, signIn, applyAuthedSession, signUpWithEmail,
      signInWithEmail, changePassword, requestSetPasswordEmail, resendVerification,
      signOut, completeOnboarding,
      connectSource, verifyWebsiteSource, disconnectSource, hydrateProfileSources, updateProfilePublic, noopConnect, disnoopConnect,
      linkTelegram, unlinkTelegram, startTelegramLink, connectChannel, connectSlack, refreshChannels, fetchSlackChannelOptions, selectSlackChannel, verifyEmailCode, disconnectChannel,
      setChannelDeliver, testChannel, setWatchEnabled, toggleWatchCategory, toggleWatchLanguage,
      saveSponsorScope, claimBatch, submitToBatch, reviseSubmission, respondToFlag,
      claimAudit, auditDecide, completeAudit, resolveDispute,
      adminSetBountyStatus, markAllRead, markRead,
      pushNotification, loadMoreNotifications, datasetTypes, addDatasetType, updateDatasetType,
      decideTypeReview, waitlisted, joinWaitlist, taxonomy, refreshTaxonomy,
      toasts, pushToast, dismissToast,
    ]
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo(): DemoState {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error("useDemo must be used within DemoProvider");
  return ctx;
}
