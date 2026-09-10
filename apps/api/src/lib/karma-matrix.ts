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
