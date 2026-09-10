// SPDX-License-Identifier: Apache-2.0

import { SubmissionStatus, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getAdminSetting } from "./admin-settings.js";

/**
 * Contributor/validator reputation and rank ladders.
 *
 * Ported from the tier shapes used across the DataBounty product line
 * (same tier names/thresholds as the funded-track API) so a member's rank
 * reads the same way everywhere. Score base/multiplier are admin-configurable
 * via the same `admin_settings` table every other runtime knob in this repo
 * uses (see services/admin-settings.ts); the numbers below are only the
 * fallback defaults.
 */
export interface ReputationTier {
  name: string;
  minScore: number;
  maxConcurrentBatches: number;
}

export const RANK_TIERS: readonly ReputationTier[] = [
  { name: "Unproven", minScore: 0, maxConcurrentBatches: 1 },
  { name: "Starter", minScore: 60, maxConcurrentBatches: 3 },
  { name: "Reliable", minScore: 75, maxConcurrentBatches: 5 },
  { name: "Expert", minScore: 85, maxConcurrentBatches: 10 },
];

export const CONTRIBUTOR_RANK_TIERS = [
  { name: "Scout", minAcceptedItems: 0, maxConcurrentBatches: 1 },
  { name: "Apprentice", minAcceptedItems: 25, maxConcurrentBatches: 2 },
  { name: "Builder", minAcceptedItems: 75, maxConcurrentBatches: 3 },
  { name: "Specialist", minAcceptedItems: 150, maxConcurrentBatches: 5 },
  { name: "Craftsman", minAcceptedItems: 300, maxConcurrentBatches: 7 },
  { name: "Senior Builder", minAcceptedItems: 600, maxConcurrentBatches: 10 },
  { name: "Expert", minAcceptedItems: 1000, maxConcurrentBatches: 15 },
  { name: "Architect", minAcceptedItems: 2000, maxConcurrentBatches: 15 },
  { name: "Principal", minAcceptedItems: 4000, maxConcurrentBatches: 15 },
  { name: "Master Builder", minAcceptedItems: 8000, maxConcurrentBatches: 15 },
] as const;

export const VALIDATOR_RANK_TIERS = [
  { name: "Observer", minAudits: 0, maxConcurrentAudits: 1 },
  { name: "Reviewer", minAudits: 10, maxConcurrentAudits: 2 },
  { name: "Inspector", minAudits: 25, maxConcurrentAudits: 3 },
  { name: "Auditor", minAudits: 50, maxConcurrentAudits: 5 },
  { name: "Senior Auditor", minAudits: 100, maxConcurrentAudits: 7 },
  { name: "Quality Lead", minAudits: 200, maxConcurrentAudits: 10 },
  { name: "Verifier", minAudits: 400, maxConcurrentAudits: 15 },
  { name: "Principal Verifier", minAudits: 800, maxConcurrentAudits: 15 },
  { name: "Arbiter", minAudits: 1500, maxConcurrentAudits: 15 },
  { name: "Master Arbiter", minAudits: 3000, maxConcurrentAudits: 15 },
] as const;

export interface NextRankProgress {
  name: string;
  itemsToGo: number;
}

export function rankForScore(score: number, tiers: readonly ReputationTier[] = RANK_TIERS): ReputationTier {
  let rank: ReputationTier = tiers[0]!;
  for (const tier of tiers) {
    if (score >= tier.minScore) rank = tier;
  }
  return rank;
}

export function contributorRankForAcceptedItems(acceptedItems: number): (typeof CONTRIBUTOR_RANK_TIERS)[number] {
  let rank: (typeof CONTRIBUTOR_RANK_TIERS)[number] = CONTRIBUTOR_RANK_TIERS[0];
  for (const tier of CONTRIBUTOR_RANK_TIERS) {
    if (acceptedItems >= tier.minAcceptedItems) rank = tier;
  }
  return rank;
}

export function validatorRankForAudits(auditsCompleted: number): (typeof VALIDATOR_RANK_TIERS)[number] {
  let rank: (typeof VALIDATOR_RANK_TIERS)[number] = VALIDATOR_RANK_TIERS[0];
  for (const tier of VALIDATOR_RANK_TIERS) {
    if (auditsCompleted >= tier.minAudits) rank = tier;
  }
  return rank;
}

export function contributorNextRank(acceptedItems: number): NextRankProgress | null {
  const next = CONTRIBUTOR_RANK_TIERS.find((tier) => tier.minAcceptedItems > acceptedItems);
  return next ? { name: next.name, itemsToGo: next.minAcceptedItems - acceptedItems } : null;
}

export function validatorNextRank(auditsCompleted: number): NextRankProgress | null {
  const next = VALIDATOR_RANK_TIERS.find((tier) => tier.minAudits > auditsCompleted);
  return next ? { name: next.name, itemsToGo: next.minAudits - auditsCompleted } : null;
}

/* ------------------------------------------------------------------------ *
 * Public attribution / dataset credit
 *
 * The product promises this in the Dharma tier's own perk text
 * (`services/karma.ts`): "Named credit on published dataset cards". Nothing in
 * this API implemented it — no preference, no read/write endpoint, and no
 * credit manifest on the publish path — so the promise was unbacked.
 *
 * `attributionOptOut` lives in the existing `User.publicProfilePrefs` JSON
 * column alongside the four section-visibility toggles. NO SCHEMA CHANGE IS
 * NEEDED: the column is already `Json?`, already merged (not replaced) by
 * PATCH /v1/me/public-profile, and already read by routes/v1/profiles.ts.
 *
 * It is a separate axis from `profilePublic` on purpose. A member may keep a
 * public profile and still decline to be named on a dataset card, or run a
 * private profile and be happy to be credited. Collapsing the two — which is
 * what the MCP `set_attribution_preference` tool does today, writing
 * `profilePublic` when it claims to write attribution — silently changes the
 * wrong thing.
 *
 * Default is OPT-IN (`attributionOptOut: false`), matching the perk text: a
 * contributor is credited unless they say otherwise.
 * ------------------------------------------------------------------------ */

export interface PublicProfilePrefs {
  showKarma: boolean;
  showBadges: boolean;
  showDatasets: boolean;
  showActivity: boolean;
  attributionOptOut: boolean;
}

export const DEFAULT_PUBLIC_PROFILE_PREFS: PublicProfilePrefs = {
  showKarma: true,
  showBadges: true,
  showDatasets: true,
  showActivity: true,
  attributionOptOut: false,
};

/** Normalises the stored JSON blob into the full pref set. Any missing or
 *  wrongly-typed key falls back to its default individually — unlike the karma
 *  settings, these are independent booleans, so one bad key must not discard a
 *  member's other four deliberate choices. */
export function parsePublicProfilePrefs(value: Prisma.JsonValue | null | undefined): PublicProfilePrefs {
  const record = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Record<
    string,
    unknown
  >;
  const bool = (key: keyof PublicProfilePrefs) =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : DEFAULT_PUBLIC_PROFILE_PREFS[key];
  return {
    showKarma: bool("showKarma"),
    showBadges: bool("showBadges"),
    showDatasets: bool("showDatasets"),
    showActivity: bool("showActivity"),
    attributionOptOut: bool("attributionOptOut"),
  };
}

/** Read one member's attribution preference. Backs `GET /v1/me/attribution`
 *  and the MCP `get_attribution_preference` tool. */
export async function getAttributionPreference(userId: string): Promise<{ attributionOptOut: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { publicProfilePrefs: true } });
  if (!user) throw new Error(`No such user: ${userId}`);
  return { attributionOptOut: parsePublicProfilePrefs(user.publicProfilePrefs).attributionOptOut };
}

/**
 * Set ONLY the attribution opt-out, merged onto the member's existing prefs.
 *
 * Contributor-owned: there is deliberately no sponsor or admin write path to
 * this preference, because a sponsor being able to un-hide a contributor who
 * asked not to be named is exactly the failure the opt-out exists to prevent.
 */
export async function setAttributionPreference(
  userId: string,
  optOut: boolean
): Promise<{ attributionOptOut: boolean }> {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { publicProfilePrefs: true } });
  if (!existing) throw new Error(`No such user: ${userId}`);
  const prefs = { ...parsePublicProfilePrefs(existing.publicProfilePrefs), attributionOptOut: optOut };
  await prisma.user.update({
    where: { id: userId },
    data: { publicProfilePrefs: prefs as unknown as Prisma.InputJsonValue },
  });
  return { attributionOptOut: prefs.attributionOptOut };
}

export interface ContributorCredits {
  /** Handles of contributors who are credited, sorted for a stable manifest. */
  credited: string[];
  /** Contributors excluded from `credited`, reported only as a count so the
   *  manifest stays honest about coverage without naming anyone who opted out
   *  (or who has no handle to name). */
  anonymizedCount: number;
}

/**
 * The credited-contributor list for one published dataset.
 *
 * Returns null for a non-community dataset: supported/funded work is not
 * publicly credited, and an empty list would be read as "nobody contributed"
 * rather than "credit does not apply here".
 *
 * The preference is read LIVE at build time, not snapshotted at acceptance, so
 * a contributor who opts out before a dataset is published is genuinely left
 * out of that dataset's card.
 */
export async function buildContributorCredits(
  bountyId: string,
  kind: string | null | undefined
): Promise<ContributorCredits | null> {
  if (kind !== "community") return null;
  const rows = await prisma.submission.findMany({
    where: { bountyId, status: SubmissionStatus.accepted },
    select: { contributor: { select: { handle: true, publicProfilePrefs: true } } },
    distinct: ["contributorUserId"],
  });

  const credited: string[] = [];
  let anonymizedCount = 0;
  for (const row of rows) {
    const handle = row.contributor?.handle;
    const optedOut = parsePublicProfilePrefs(row.contributor?.publicProfilePrefs ?? null).attributionOptOut;
    // No handle is as un-nameable as an opt-out: crediting a display name or a
    // user id would name someone the platform has no public identifier for.
    if (handle && !optedOut) credited.push(handle);
    else anonymizedCount += 1;
  }
  return { credited: credited.sort(), anonymizedCount };
}

/**
 * The Contributors block of a dataset card, as Markdown.
 *
 * Server-owned copy so the API, the publish job and any future export all say
 * the same thing. The empty case is an explicit sentence rather than a blank
 * section: a card with a silent gap where credits should be reads as an
 * oversight, not as a fact about what contributors chose.
 */
export function renderContributorCredits(credits: ContributorCredits | null): string {
  if (!credits) return "";
  const lines = credits.credited.length
    ? credits.credited.map((handle) => `- @${handle}`).join("\n")
    : "_No contributors opted into public credit._";
  const anonymized = credits.anonymizedCount
    ? `\n\n_and ${credits.anonymizedCount} contributor(s) who opted out of public credit._`
    : "";
  return `${lines}${anonymized}`;
}

/** Admin-configurable score formula: `base + perVerifiedCredential * verifiedSources`, capped at 100. */
export async function computeReputationScore(userId: string): Promise<{ score: number; verifiedSources: number; connectedSources: number }> {
  const [base, perVerified, sources] = await Promise.all([
    getAdminSetting<number>("reputation.score.base", 52),
    getAdminSetting<number>("reputation.score.per_verified_credential", 12),
    prisma.profileSource.findMany({ where: { userId }, select: { verified: true } }),
  ]);
  const verifiedSources = sources.filter((s) => s.verified).length;
  const score = Math.min(100, base + perVerified * verifiedSources);
  return { score, verifiedSources, connectedSources: sources.length };
}
