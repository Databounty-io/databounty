// SPDX-License-Identifier: Apache-2.0

/* ------------------------------------------------------------------ */
/* Karma: THE reputation record of DataBounty Community.             */
/* Community work releases karma after verified acceptance/publication;*/
/* Tiers ascend the path (dharma → bodhi → moksha → nirvana) and       */
/* unlock priority and public recognition.                            */
/* ------------------------------------------------------------------ */

import { completionPct } from "./format";

export type KarmaTier = "dharma" | "bodhi" | "moksha" | "nirvana";

export interface KarmaTierDef {
  id: KarmaTier;
  name: string;
  min: number;
  blurb: string;
  perks: string[];
  /** Accent hex used wherever the tier is rendered. */
  color: string;
}

export const KARMA_TIERS: KarmaTierDef[] = [
  {
    id: "dharma",
    name: "Dharma",
    min: 0,
    blurb: "You've taken up the path. Every accepted item carries your name.",
    color: "#8a9382",
    perks: [
      "Leaderboard listing",
      "Tier badge on profile",
      "Named credit on published dataset cards you contributed to",
    ],
  },
  {
    id: "bodhi",
    name: "Bodhi",
    min: 5000,
    blurb: "Awakening. The platform sees you before the crowd.",
    color: "#d4a24e",
    perks: [
      "Everything in Dharma",
      "24h early access to new datasets",
      "Batch sizes up to 25 items",
    ],
  },
  {
    id: "moksha",
    name: "Moksha",
    min: 50000,
    blurb: "Liberation. High-standing contributor recognized across datasets.",
    color: "#b6ff1c",
    perks: [
      "Everything in Bodhi",
      "48h early access",
      "Claim priority queue",
      "Validator qualification fast-track",
    ],
  },
  {
    id: "nirvana",
    name: "Nirvana",
    min: 500000,
    blurb: "The summit. Top tier recognition and first look at everything.",
    color: "#b9a6f2",
    perks: [
      "Everything in Moksha",
      "72h first look",
      "Direct invites to new dataset programs",
    ],
  },
];

export interface KarmaEvent {
  id: string;
  type: "accepted_item" | "audit_item" | "confirmed_flag" | "publish_bonus";
  points: number;
  note: string; // e.g. "3 items accepted, Python async bug-fix pairs"
  date: string; // e.g. "2026-07-18"
}

/** The tier a karma balance currently sits in. */
export function tierFor(points: number): KarmaTierDef {
  let current = KARMA_TIERS[0];
  for (const t of KARMA_TIERS) {
    if (points >= t.min) current = t;
  }
  return current;
}

/**
 * Progress toward the next tier. `pct` measures progress from the current
 * tier's floor to the next tier's threshold (0-100). Nirvana returns
 * `next: null`, `remaining: 0`, `pct: 100`.
 */
export function nextTierProgress(points: number): {
  next: KarmaTierDef | null;
  remaining: number;
  pct: number;
} {
  const current = tierFor(points);
  const idx = KARMA_TIERS.findIndex((t) => t.id === current.id);
  const next = KARMA_TIERS[idx + 1] ?? null;
  if (!next) return { next: null, remaining: 0, pct: 100 };
  const span = next.min - current.min;
  const into = Math.max(0, points - current.min);
  return {
    next,
    remaining: Math.max(0, next.min - points),
    pct: completionPct(into, span),
  };
}

/**
 * Shape of `GET /v1/community/stats`'s `tiers` field (community.ts) — the
 * live, admin-editable tier ladder. `KARMA_TIERS` above is a build-time
 * fallback for when the API is unreachable; it must never be the primary
 * render source once live data is available, or a tier name/color/threshold
 * an admin changes in the DB would silently disagree with what the public
 * site shows.
 */
export interface ApiKarmaTier {
  name: string;
  label: string;
  minKarma: number;
  color: string;
  earlyAccessHours: number;
  concurrencyBonus: number;
}

/** The tier a karma balance sits in, given the LIVE tier ladder. Falls back
 * to the static ladder only when `tiers` is empty (API unavailable). */
export function tierForLive(points: number, tiers: ApiKarmaTier[]): ApiKarmaTier | KarmaTierDef {
  if (tiers.length === 0) return tierFor(points);
  let current = tiers[0];
  for (const t of tiers) {
    if (points >= t.minKarma) current = t;
  }
  return current;
}

/** Perks derived purely from a live tier's numeric fields — never a
 * hardcoded per-tier prose list, so it can't drift from what an admin set. */
export function perksForLiveTier(tier: ApiKarmaTier, previousLabel: string | null): string[] {
  const perks = previousLabel ? [`Everything in ${previousLabel}`] : ["Leaderboard listing", "Tier badge on profile"];
  if (tier.earlyAccessHours > 0) perks.push(`${tier.earlyAccessHours}h early access to new datasets`);
  if (tier.concurrencyBonus > 0) perks.push(`+${tier.concurrencyBonus} concurrent contribution batch${tier.concurrencyBonus === 1 ? "" : "es"}`);
  return perks;
}

/** Single most-notable perk, for compact one-line tier bands (home page). */
export function headlinePerkForLiveTier(tier: ApiKarmaTier): string {
  if (tier.concurrencyBonus > 0) return `+${tier.concurrencyBonus} concurrent batch${tier.concurrencyBonus === 1 ? "" : "es"}`;
  if (tier.earlyAccessHours > 0) return `${tier.earlyAccessHours}h early access to new datasets`;
  return "Leaderboard listing + tier badge";
}
