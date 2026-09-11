// SPDX-License-Identifier: Apache-2.0

/**
 * Shapes and pure resolvers for the three admin-configurable karma settings:
 * `karma.tiers`, `karma.rules`, and `karma.matrix`.
 *
 * Dependency-free leaf module on purpose. `services/karma.ts` holds the code
 * defaults and does the `admin_settings` I/O; `services/admin-settings.ts`
 * owns the Zod schemas used on the WRITE path. This module is what the read
 * path uses to decide whether a value that is already stored is still usable.
 *
 * Why a second, non-Zod check on read at all: the write-path schema is the
 * gate, but a row can predate the current schema (hand-inserted, restored from
 * a backup, written before a field was added). Validating on read means a
 * malformed row falls back to the code default instead of throwing on a hot
 * path or — far worse — being spread into a live tier/price calculation with
 * missing fields. The fallback is the *code default*, never a partial merge:
 * half a stored tier table and half the constants is a configuration nobody
 * chose and nobody can see.
 */

import { CANONICAL_DIFFICULTY_LEVELS, type ItemDifficulty } from "./difficulty.js";

export interface KarmaTierConfig {
  tier: string;
  label: string;
  minKarma: number;
  color: string;
  blurb: string;
  perks: string[];
  earlyAccessHours: number;
  concurrencyBonus: number;
}

export interface KarmaRulesConfig {
  acceptedItem: { beginner: number; intermediate: number; advanced: number };
  auditItem: number;
  confirmedFlag: number;
  requestApproved: number;
  publishBonus: number;
  bountyPublished: number;
}

export interface KarmaMatrixEntry {
  /** 1–4, "what it takes to verify an item is correct". */
  complexityScore: number;
  /** Template fields that undergo automated, machine-run verification. */
  verificationUnits: number;
}

export type KarmaMatrixConfig = Readonly<Record<string, KarmaMatrixEntry>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * A stored tier table is usable only if EVERY row carries every field, the
 * table is in strictly ascending `minKarma` order, and the first row starts at
 * 0. The ordering and the zero-floor are not cosmetic: `karmaTierForBalanceIn`
 * walks the list and keeps the last match, so an out-of-order table silently
 * resolves the wrong tier, and a table whose floor is above 0 leaves every new
 * member with no tier at all.
 */
export function isKarmaTierConfigList(value: unknown): value is KarmaTierConfig[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const row of value) {
    if (!isRecord(row)) return false;
    if (typeof row.tier !== "string" || row.tier.length === 0) return false;
    if (typeof row.label !== "string" || row.label.length === 0) return false;
    if (!isNonNegativeInt(row.minKarma)) return false;
    if (typeof row.color !== "string" || row.color.length === 0) return false;
    if (typeof row.blurb !== "string") return false;
    if (!Array.isArray(row.perks) || row.perks.some((p) => typeof p !== "string")) return false;
    if (!isNonNegativeInt(row.earlyAccessHours)) return false;
    if (!isNonNegativeInt(row.concurrencyBonus)) return false;
  }
  const rows = value as KarmaTierConfig[];
  if (rows[0]!.minKarma !== 0) return false;
  if (new Set(rows.map((r) => r.tier)).size !== rows.length) return false;
  return rows.every((row, i) => i === 0 || row.minKarma > rows[i - 1]!.minKarma);
}

export function isKarmaRulesConfig(value: unknown): value is KarmaRulesConfig {
  if (!isRecord(value)) return false;
  const accepted = value.acceptedItem;
  if (!isRecord(accepted)) return false;
  if (!isPositiveInt(accepted.beginner) || !isPositiveInt(accepted.intermediate) || !isPositiveInt(accepted.advanced)) {
    return false;
  }
  return (
    isPositiveInt(value.auditItem) &&
    isPositiveInt(value.confirmedFlag) &&
    isPositiveInt(value.requestApproved) &&
    isPositiveInt(value.publishBonus) &&
    isPositiveInt(value.bountyPublished)
  );
}

/**
 * An entry is REQUIRED to be complete. A category present with one axis missing
 * is an unpriced category masquerading as a priced one — it must fall back to
 * the code seed rather than default the missing axis to a middle value.
 */
export function isKarmaMatrixConfig(value: unknown): value is KarmaMatrixConfig {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  for (const key of keys) {
    const entry = value[key];
    if (!isRecord(entry)) return false;
    if (!isPositiveInt(entry.complexityScore) || entry.complexityScore > 4) return false;
    if (!isNonNegativeInt(entry.verificationUnits)) return false;
  }
  return true;
}

/** Last tier whose floor the balance reaches. Pure; the caller supplies the
 *  table so this works identically against the stored rows and the defaults. */
export function karmaTierForBalanceIn<T extends { minKarma: number }>(tiers: readonly T[], balance: number): T {
  let current = tiers[0]!;
  for (const candidate of tiers) {
    if (balance >= candidate.minKarma) current = candidate;
  }
  return current;
}

/** The first tier strictly above this balance, or null at the summit. */
export function nextKarmaTierIn<T extends { minKarma: number }>(tiers: readonly T[], balance: number): T | null {
  return tiers.find((t) => t.minKarma > balance) ?? null;
}

/** Pricing inputs for one registry category, or null when the category is
 *  deliberately unpriced. Unpriced must stay unpriced — never a middle score. */
export function matrixEntryFor(matrix: KarmaMatrixConfig, datasetTypeId: string | null | undefined): KarmaMatrixEntry | null {
  if (!datasetTypeId) return null;
  return Object.hasOwn(matrix, datasetTypeId) ? matrix[datasetTypeId]! : null;
}

/* ------------------------------------------------------------------------ *
 * Pricing kernel: ladder cell lookup for contributor/validator karma.
 *
 * Ported from v1 (`databounty-api/src/lib/karma-matrix.ts`), which restates
 * `KARMA_PRICING_MATRIX_PLAN.md` §2. This tree diverged from v1 by storing
 * ONLY the two per-category pricing axes (`KarmaMatrixConfig` above /
 * `DatasetType.complexityScore` + `verificationUnits`) as admin-editable
 * state; the ladder/contributor/validator cell tables that turn those axes
 * (plus difficulty and review load) into an actual karma amount never got
 * ported, which is why the award paths fell back to a flat `|| 25` and the
 * member karma page's pricing sections had nothing to render.
 *
 * The cell tables are code constants here, not a third admin-editable
 * setting — this tree has no versioned `BountyKarmaQuote.matrix` snapshot to
 * pin an edit against (see `BountyKarmaQuote` in services/karma.ts), so
 * making the ladder itself editable would let an admin reprice already
 * accepted work retroactively. If the ladder needs to become admin-editable
 * later, it should get the same version+snapshot treatment v1 gives its
 * `karma.matrix` setting, not be spliced in here.
 * ------------------------------------------------------------------------ */

/** Complexity scores the ladder prices. Fixed per dataset category. */
export const COMPLEXITY_SCORES = [1, 2, 3, 4] as const;
export type ComplexityScore = (typeof COMPLEXITY_SCORES)[number];

/** True when `score` is one of the four the ladder prices. Narrow before
 * indexing — an unpriced/out-of-range score must fail closed to the flat
 * scale, never index the ladder to a default cell. Canonical copy: the two
 * former duplicates in routes/v1/admin-community.ts and
 * routes/v1/admin-dataset-types.ts now both import this instead of keeping
 * their own private closures. */
export function isComplexityScore(value: unknown): value is ComplexityScore {
  return typeof value === "number" && Number.isInteger(value) && (COMPLEXITY_SCORES as readonly number[]).includes(value);
}

/** How much machine verification an item's template actually requires. */
export const VERIFICATION_BANDS = ["standard", "elevated", "heavy"] as const;
export type VerificationBand = (typeof VERIFICATION_BANDS)[number];

/** How many fields a validator must read to judge one item. */
export const REVIEW_LOADS = ["light", "standard", "heavy"] as const;
export type ReviewLoad = (typeof REVIEW_LOADS)[number];

/** The rung values every contributor cell is drawn from, ascending. A cell is
 * never a literal — it is `ladder[index]`. */
export const DEFAULT_KARMA_LADDER = [10, 15, 20, 25, 30, 40, 50, 60, 75] as const;

type ComplexityKey = "1" | "2" | "3" | "4";

export interface KarmaPricingTable {
  ladder: readonly number[];
  /** Ladder index per (complexity, difficulty) at the Standard band. */
  contributor: Record<ComplexityKey, Record<ItemDifficulty, number>>;
  bandShifts: Record<VerificationBand, number>;
  /** Verification units at which a template leaves Standard / enters Heavy. */
  bandThresholds: { elevatedMinUnits: number; heavyMinUnits: number };
  validator: Record<ComplexityKey, Record<ReviewLoad, number>>;
  /** Field counts at which review load leaves Light / enters Heavy. */
  reviewLoadThresholds: { standardMinFields: number; heavyMinFields: number };
}

/** The source document's model as shipped defaults (same numbers as v1's
 * DEFAULT_KARMA_MATRIX). */
export const DEFAULT_KARMA_PRICING_TABLE: KarmaPricingTable = {
  ladder: DEFAULT_KARMA_LADDER,
  contributor: {
    "1": { beginner: 0, intermediate: 1, advanced: 2 }, // 10 / 15 / 20
    "2": { beginner: 1, intermediate: 2, advanced: 4 }, // 15 / 20 / 30
    "3": { beginner: 1, intermediate: 3, advanced: 5 }, // 15 / 25 / 40
    "4": { beginner: 2, intermediate: 4, advanced: 6 }, // 20 / 30 / 50
  },
  bandShifts: { standard: 0, elevated: 1, heavy: 2 },
  bandThresholds: { elevatedMinUnits: 3, heavyMinUnits: 5 },
  validator: {
    "1": { light: 10, standard: 15, heavy: 20 },
    "2": { light: 15, standard: 20, heavy: 25 },
    "3": { light: 20, standard: 25, heavy: 30 },
    "4": { light: 25, standard: 30, heavy: 40 },
  },
  reviewLoadThresholds: { standardMinFields: 5, heavyMinFields: 8 },
};

function complexityKey(score: ComplexityScore): ComplexityKey {
  return String(score) as ComplexityKey;
}

/**
 * Which band a template's declared verification units fall in. Units are
 * declared on the TEMPLATE (never counted per submission — a per-item count
 * would be contributor-influenced and therefore gameable). Zero units is a
 * valid, priced state (Standard).
 */
export function bandForVerificationUnits(units: number, table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE): VerificationBand {
  const { elevatedMinUnits, heavyMinUnits } = table.bandThresholds;
  if (units >= heavyMinUnits) return "heavy";
  if (units >= elevatedMinUnits) return "elevated";
  return "standard";
}

/** Which review load a template's field count falls in. */
export function reviewLoadForFieldCount(fields: number, table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE): ReviewLoad {
  const { standardMinFields, heavyMinFields } = table.reviewLoadThresholds;
  if (fields >= heavyMinFields) return "heavy";
  if (fields >= standardMinFields) return "standard";
  return "light";
}

/** Karma for one accepted item: `ladder[base + bandShift]`, clamped to the
 * top rung. A pure lookup by construction. */
export function contributorKarma(
  complexity: ComplexityScore,
  difficulty: ItemDifficulty,
  band: VerificationBand,
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE
): number {
  const base = table.contributor[complexityKey(complexity)][difficulty];
  const index = Math.min(base + table.bandShifts[band], table.ladder.length - 1);
  return table.ladder[Math.max(0, index)]!;
}

/** Karma for one audited item. */
export function validatorKarma(
  complexity: ComplexityScore,
  load: ReviewLoad,
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE
): number {
  return table.validator[complexityKey(complexity)][load];
}

/** One accepted-item cell, with the axes that produced it. Rendered on member
 * surfaces so a rate can always be explained, never just stated. */
export interface ContributorPricingCell {
  complexity: ComplexityScore;
  difficulty: ItemDifficulty;
  band: VerificationBand;
  karma: number;
}

/** All 36 contributor cells, ordered complexity -> difficulty -> band. Used to
 * compute the member-facing lowest/highest karma range. */
export function contributorMatrixCells(table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE): ContributorPricingCell[] {
  const cells: ContributorPricingCell[] = [];
  for (const complexity of COMPLEXITY_SCORES) {
    for (const difficulty of CANONICAL_DIFFICULTY_LEVELS) {
      for (const band of VERIFICATION_BANDS) {
        cells.push({ complexity, difficulty, band, karma: contributorKarma(complexity, difficulty, band, table) });
      }
    }
  }
  return cells;
}
