// SPDX-License-Identifier: Apache-2.0

/**
 * Central registry of every databounty-api endpoint the web app calls.
 *
 * This is the single source of truth for API paths. Nothing else in the app
 * should hand-write a `/v1/...` string — import `API` (constant paths) or call
 * one of the builder functions (parameterized paths) from here instead. When
 * the backend renames or moves a route, this is the only file that changes.
 *
 * Conventions:
 *  - Static paths live in the `API` constant object, grouped by domain.
 *  - Paths with an id/param are functions returning the path.
 *  - Query strings are built with {@link withQuery} so callers never manually
 *    concatenate `?a=b&c=d` (and encoding is handled for them).
 *
 * All paths are API-relative (no origin); {@link authedFetch}/{@link apiClient}
 * prepend `API_URL`.
 */

/** Values accepted for a query-string param before encoding. */
type QueryValue = string | number | boolean | null | undefined;

/**
 * Append a query string to a path, skipping null/undefined/"" values and
 * URL-encoding the rest. `withQuery("/v1/bounties", { phase: "active", page: 1 })`
 * → `/v1/bounties?phase=active&page=1`. Returns the bare path when nothing
 * survives filtering, so it's safe to call unconditionally.
 */
export function withQuery(
  path: string,
  params?: Record<string, QueryValue>,
): string {
  if (!params) return path;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

export const API = {
  auth: {
    login: "/v1/auth/login",
    logout: "/v1/auth/logout",
    signup: "/v1/auth/signup",
    me: "/v1/auth/me",
    // Marks the account onboarded and stores the landing-dashboard preference.
    // Replaced "/v1/auth/roles", which granted participation role rows; that
    // path still exists as a deprecated alias for older deployed bundles.
    onboardingComplete: "/v1/auth/onboarding-complete",
    changePassword: ["/v1/auth/change-password"][0],
    setPassword: ["/v1/auth/set-password"][0],
    requestSetPassword: ["/v1/auth/request-set-password"][0],
    resendVerification: "/v1/auth/resend-verification",
    forgotPassword: ["/v1/auth/forgot-password"][0],
    resetPassword: ["/v1/auth/reset-password"][0],
    verifyEmail: "/v1/auth/verify-email",
  },

  planner: {
    catalog: "/v1/planner/catalog",
    preview: "/v1/planner/preview",
    // Single typed LLM/deterministic assist surface. Pass an `intent`
    // ("title" | "planner_copy" | "draft_type"); replaces the former
    // suggest / script / dataset-types/draft (and the retired recommend /
    // extract / interpret-edit) endpoints.
    assist: "/v1/planner/assist",
    datasetTypeRequests: "/v1/planner/dataset-types/requests",
    sessions: "/v1/planner/sessions",
    activeSession: "/v1/planner/sessions/active",
    session: (id: string) => `/v1/planner/sessions/${id}`,
    sessionAnswers: (id: string) => `/v1/planner/sessions/${id}/answers`,
    sessionFinalize: (id: string) => `/v1/planner/sessions/${id}/finalize`,
  },

  bounties: {
    list: "/v1/bounties",
    one: (id: string) => `/v1/bounties/${id}`,
    submissions: (id: string) => `/v1/bounties/${id}/submissions`,
    submissionOne: (id: string, submissionId: string) => `/v1/bounties/${id}/submissions/${submissionId}`,
    sponsorReview: (id: string, submissionId: string) => `/v1/bounties/${id}/sponsor-review/${submissionId}`,
    // Sponsor-initiated early close of an open community pool: stop
    // accepting new contributions and settle with whatever was accepted so
    // far, even under the original target. Idempotent — a second call is
    // safe and returns 200 with `alreadyClosed: true` instead of erroring.
    closePool: (id: string) => `/v1/bounties/${id}/close-pool`,
    // Direct, no-claim contribution to a community open pool
    // (COMMUNITY_OPEN_POOL_PLAN_V2) — distinct from batches.items below,
    // which requires a claimed ContributorBatch first.
    poolItems: (id: string) => `/v1/bounties/${id}/items`,
    poolContract: (id: string) => `/v1/bounties/${id}/contract`,
    poolSubmissions: (id: string) => `/v1/bounties/${id}/my-submissions`,
  },

  batches: {
    list: "/v1/batches",
    count: "/v1/batches/count",
    claim: (id: string) => `/v1/batches/${id}/claim`,
    contract: (id: string) => `/v1/batches/${id}/contract`,
    submissions: (id: string) => `/v1/batches/${id}/submissions`,
    items: (id: string) => `/v1/batches/${id}/items`,
  },

  audits: {
    list: "/v1/audits",
    one: (id: string) => `/v1/audits/${id}`,
    claim: (id: string) => `/v1/audits/${id}/claim`,
    decisions: (id: string) => `/v1/audits/${id}/decisions`,
  },

  submissions: {
    one: (id: string) => `/v1/submissions/${id}`,
    revise: (id: string) => `/v1/submissions/${id}/revise`,
    rerunValidation: (id: string) => `/v1/submissions/${id}/rerun-validation`,
    dispute: (id: string) => `/v1/submissions/${id}/dispute`,
    disputeAcceptance: (id: string) => `/v1/submissions/${id}/dispute-acceptance`,
  },

  artifacts: {
    list: "/v1/artifacts",
    uploadSlot: "/v1/artifacts/upload-slot",
    multipartSlot: "/v1/artifacts/multipart-slot",
    multipartComplete: (id: string) => `/v1/artifacts/${id}/multipart-complete`,
    multipartAbort: (id: string) => `/v1/artifacts/${id}/multipart-abort`,
    one: (id: string) => `/v1/artifacts/${id}`,
    complete: (id: string) => `/v1/artifacts/${id}/complete`,
    processingEvents: (id: string) => `/v1/artifacts/${id}/processing-events`,
  },

  uploadReviewDrafts: {
    redeem: "/v1/upload-review-drafts/redeem",
    one: (id: string) => `/v1/upload-review-drafts/${id}`,
    attachSource: (id: string) => `/v1/upload-review-drafts/${id}/attach-source`,
    rejectedRows: (id: string) => `/v1/upload-review-drafts/${id}/rejected-rows`,
    submit: (id: string) => `/v1/upload-review-drafts/${id}/submit`,
    sourceSlot: (id: string) => `/v1/upload-review-drafts/${id}/source-slot`,
    sourceComplete: (id: string) => `/v1/upload-review-drafts/${id}/source-complete`,
    cancel: (id: string) => `/v1/upload-review-drafts/${id}/cancel`,
  },

  notifications: {
    list: "/v1/notifications",
    readAll: "/v1/notifications/read-all",
    read: (id: string) => `/v1/notifications/${id}/read`,
    channels: "/v1/notifications/channels",
    channel: (id: string) => `/v1/notifications/channels/${id}`,
    channelConnect: (id: string) => `/v1/notifications/channels/${id}/connect`,
    channelVerify: (id: string) => `/v1/notifications/channels/${id}/verify`,
    channelTest: (id: string) => `/v1/notifications/channels/${id}/test`,
    integrationConnect: "/v1/integrations/connect",
    slackChannels: "/v1/notifications/slack/channels",
    slackSelectChannel: "/v1/notifications/slack/select-channel",
  },

  telegram: {
    linkStart: "/v1/telegram/link/start",
  },

  // Support cases the account (or its agent, over MCP) filed about the
  // platform. Reporter-scoped: these return the caller's OWN cases only — the
  // staff queue is a separate `/v1/admin/issues` surface the console owns.
  issues: {
    list: "/v1/issues",
    one: (id: string) => `/v1/issues/${encodeURIComponent(id)}`,
    replies: (id: string) => `/v1/issues/${encodeURIComponent(id)}/replies`,
  },

  watchPrefs: "/v1/watch-prefs",

  me: {
    contributorDashboard: "/v1/me/contributor-dashboard",
    poolSubmissions: "/v1/me/pool-submissions",
    validatorDashboard: "/v1/me/validator-dashboard",
    // GET /v1/me/audits (routes/v1/me.ts) — the validator's OWN claimed /
    // overdue / completed windows, server-paginated; the ownership source the
    // validator workspace reads (validator-dashboard's `audits` is always []).
    audits: "/v1/me/audits",
    profileSources: "/v1/me/profile-sources",
    profileSourcesVisibility: "/v1/me/profile-sources/visibility",
    publicProfile: "/v1/me/public-profile",
    publicProfileHandle: "/v1/me/public-profile/handle",
    publicProfileDisplayName: "/v1/me/public-profile/display-name",
    publicProfileHandleAvailability: (handle: string) => `/v1/me/public-profile/handle-availability?handle=${encodeURIComponent(handle)}`,
    publicProfileHandleSuggestions: (count = 8) => `/v1/me/public-profile/handle-suggestions?count=${count}`,
    communityKarma: "/v1/community/karma",
    communityRequestsMine: "/v1/community/requests/mine",
    profileSource: (id: string) => `/v1/me/profile-sources/${id}`,
    profileSourceConnect: (id: string) => `/v1/me/profile-sources/${id}/connect`,
    websiteStart: "/v1/me/profile-sources/website/start",
    websiteVerify: "/v1/me/profile-sources/website/verify",
    sponsorScope: "/v1/me/sponsor-scope",
    // Weekly activity series for the member's own workspace charts. `weeks`
    // is validated server-side (4–52); the client never sends a bare path so
    // the window is always explicit in the request log.
    // Either shape the endpoint accepts: a trailing week count, or an explicit
    // date range (`from`/`to` as YYYY-MM-DD). The dashboard picks a range; the
    // week count remains the default and the fallback.
    analytics: (window: number | { from: string; to: string }) =>
      typeof window === "number"
        ? withQuery("/v1/me/analytics", { weeks: window })
        : withQuery("/v1/me/analytics", { from: window.from, to: window.to }),
    apiKeys: "/v1/me/api-keys",
    apiKeyRotate: (id: string) => `/v1/me/api-keys/${id}/rotate`,
    apiKey: (id: string) => `/v1/me/api-keys/${id}`,
  },

  community: {
    requests: "/v1/community/requests",
    request: (id: string) => `/v1/community/requests/${id}`,
    requestComments: (id: string) => `/v1/community/requests/${id}/comments`,
    requestResubmit: (id: string) => `/v1/community/requests/${id}/resubmit`,
    catalog: "/v1/community/catalog",
    catalogDataset: (id: string) => `/v1/community/catalog/${id}`,
    batches: "/v1/community/batches",
    batchesCount: "/v1/community/batches/count",
    pools: "/v1/community/pools",
    stats: "/v1/community/stats",
    leaderboard: "/v1/community/leaderboard",
  },

  meta: {
    developerSurface: "/v1/meta/developer-surface",
    taxonomy: "/v1/meta/taxonomy",
    launchFlags: "/v1/meta/launch-flags",
    uploadLimits: "/v1/meta/upload-limits",
  },
} as const;
