// SPDX-License-Identifier: Apache-2.0

/**
 * Typed client for the credential/reputation API (`/v1/me/profile-sources`)
 * on databounty-api.
 */
import { authedFetch, type ProfileSource, type SourceId } from "@/lib/store";
import { API } from "@/lib/api-endpoints";

// Fastify's built-in 404 handler writes messages of the exact shape
// "Route POST:/v1/foo/bar not found" whenever a route genuinely doesn't
// exist server-side — a routing implementation detail, never something a
// real handler would phrase that way. Trusting it blindly (as this used to)
// meant a missing backend route displayed that raw string to the user
// instead of the caller's own fallback. A handler's own
// `reply.notFound("...")`-style message never matches this pattern, so it
// still passes through untouched.
const FASTIFY_ROUTE_NOT_FOUND = /^Route (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):.* not found$/;

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (!parsed.message || FASTIFY_ROUTE_NOT_FOUND.test(parsed.message)) return fallback;
    return parsed.message;
  } catch {
    return FASTIFY_ROUTE_NOT_FOUND.test(text) ? fallback : text;
  }
}

interface ApiProfileSource {
  source: SourceId;
  handleOrUrl: string;
  verified: boolean;
  verifiedAt: string | null;
  connectedAt: string;
  verificationState?: "unverified" | "verified" | "pending_recheck" | "invalid";
  lastCheckedAt?: string | null;
  nextCheckAt?: string | null;
  oauthCapable: boolean;
  verifyChallenge: string | null;
  verifyLastError: string | null;
}

export interface NextRankProgress {
  name: string;
  itemsToGo: number;
}

export interface ProfileSummary {
  reputation: {
    score: number;
    tier: string;
    verifiedSources: number;
    connectedSources: number;
    maxConcurrentBatches: number;
    profilePublic: boolean;
  };
  ranks: {
    contributor: {
      rank: string;
      acceptedItems: number;
      missedDeadlines: number;
      abandons: number;
      consecutiveCleanDeliveries: number;
      maxConcurrentBatches: number;
      nextRank: NextRankProgress | null;
    };
    validator: {
      rank: string;
      auditsCompleted: number;
      missedDeadlines: number;
      falseFlagRate: number | null;
      decidedFlags: number;
      dismissedFlags: number;
      nextRank: NextRankProgress | null;
      maxConcurrentAudits: number;
    };
  };
  badges: {
    id: string;
    key: string;
    family: "build" | "audit" | "platform";
    icon: "check" | "code" | "shield" | "clock" | "eye" | "award" | "flag" | "sparkles" | "zap" | "users" | "database" | "layers" | "coins" | "beaker";
    label: string;
    criteria: string;
    earnedAt: string | null;
    manual: boolean;
  }[];
  submissions: {
    total: number;
    accepted: number;
    inReview: number;
    needsAttention: number;
    rejected: {
      total: number;
      bySystem: number;
      byHuman: number;
    };
  };
}

export const DEFAULT_PROFILE_SUMMARY: ProfileSummary = {
  reputation: {
    score: 52,
    tier: "Unproven",
    verifiedSources: 0,
    connectedSources: 0,
    maxConcurrentBatches: 1,
    profilePublic: false,
  },
  ranks: {
    contributor: {
      rank: "Scout",
      acceptedItems: 0,
      missedDeadlines: 0,
      abandons: 0,
      consecutiveCleanDeliveries: 0,
      maxConcurrentBatches: 1,
      nextRank: { name: "Apprentice", itemsToGo: 25 },
    },
    validator: {
      rank: "Observer",
      auditsCompleted: 0,
      missedDeadlines: 0,
      falseFlagRate: null,
      decidedFlags: 0,
      dismissedFlags: 0,
      nextRank: { name: "Reviewer", itemsToGo: 10 },
      maxConcurrentAudits: 1,
    },
  },
  badges: [],
  submissions: {
    total: 0,
    accepted: 0,
    inReview: 0,
    needsAttention: 0,
    rejected: { total: 0, bySystem: 0, byHuman: 0 },
  },
};

function toProfileSource(row: ApiProfileSource): ProfileSource {
  return {
    connected: true,
    handle: row.handleOrUrl,
    verified: row.verified,
    verificationState: row.verificationState ?? (row.verified ? "verified" : "unverified"),
    lastCheckedAt: row.lastCheckedAt ?? undefined,
    nextCheckAt: row.nextCheckAt ?? undefined,
    oauthCapable: row.oauthCapable,
    verifyChallenge: row.verifyChallenge ?? undefined,
    verifyLastError: row.verifyLastError ?? undefined,
  };
}

export async function fetchProfileSources(): Promise<{
  sources: Partial<Record<SourceId, ProfileSource>>;
  reputationScore: number;
  summary: ProfileSummary;
  oauthCapableKinds: SourceId[];
}> {
  const res = await authedFetch(API.me.profileSources);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Could not load your reputation profile."));
  }
  const body = (await res.json()) as {
    sources: ApiProfileSource[];
    reputationScore: number;
    reputation?: ProfileSummary["reputation"];
    ranks?: ProfileSummary["ranks"];
    badges?: ProfileSummary["badges"];
    submissions?: ProfileSummary["submissions"];
    oauthCapableKinds?: SourceId[];
  };
  const sources: Partial<Record<SourceId, ProfileSource>> = {};
  for (const row of body.sources) sources[row.source] = toProfileSource(row);
  return {
    sources,
    reputationScore: body.reputationScore,
    summary: {
      reputation: body.reputation ?? DEFAULT_PROFILE_SUMMARY.reputation,
      ranks: body.ranks ?? DEFAULT_PROFILE_SUMMARY.ranks,
      badges: body.badges ?? DEFAULT_PROFILE_SUMMARY.badges,
      submissions: body.submissions ?? DEFAULT_PROFILE_SUMMARY.submissions,
    },
    oauthCapableKinds: body.oauthCapableKinds ?? [],
  };
}

export async function startProfileSourceConnect(id: SourceId): Promise<string | null> {
  const res = await authedFetch(API.me.profileSourceConnect(id), { method: "POST" });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Could not start credential connect."));
  }
  const body = (await res.json()) as { url: string };
  return body.url;
}

export async function addManualProfileSource(id: SourceId, handleOrUrl: string): Promise<ProfileSource | null> {
  const res = await authedFetch(API.me.profileSource(id), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handleOrUrl }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Could not save credential source."));
  }
  const body = (await res.json()) as { source: ApiProfileSource };
  return toProfileSource(body.source);
}

export async function startWebsiteVerification(handleOrUrl: string): Promise<{ source: ProfileSource; token: string }> {
  const res = await authedFetch(API.me.websiteStart, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handleOrUrl }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Could not start website verification."));
  }
  const body = (await res.json()) as { source: ApiProfileSource; token: string };
  return { source: toProfileSource(body.source), token: body.token };
}

export async function verifyWebsiteSource(): Promise<ProfileSource> {
  const res = await authedFetch(API.me.websiteVerify, { method: "POST" });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Could not verify website."));
  }
  const body = (await res.json()) as { source: ApiProfileSource };
  return toProfileSource(body.source);
}

export async function disconnectProfileSource(id: SourceId): Promise<boolean> {
  const res = await authedFetch(API.me.profileSource(id), { method: "DELETE" });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Could not disconnect credential source."));
  }
  return res.ok;
}

export async function updateProfileVisibility(profilePublic: boolean): Promise<boolean> {
  const res = await authedFetch(API.me.profileSourcesVisibility, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profilePublic }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Could not update profile visibility."));
  }
  const body = (await res.json()) as { profilePublic: boolean };
  return body.profilePublic;
}
