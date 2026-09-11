// SPDX-License-Identifier: Apache-2.0

import { KarmaEventType, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getAdminSetting } from "./admin-settings.js";
import { notifyEvent } from "./notifications.js";
import { enqueueLeaderboardRankCheck } from "./jobs/leaderboard-movement.js";
import { CATEGORY_PRICING_SEED } from "../lib/karma-category-scores.js";
import { CANONICAL_DIFFICULTY_LEVELS, resolveItemDifficulty, type ItemDifficulty } from "../lib/difficulty.js";
import {
  bandForVerificationUnits,
  contributorKarma,
  contributorMatrixCells,
  DEFAULT_KARMA_PRICING_TABLE,
  isComplexityScore,
  isKarmaMatrixConfig,
  isKarmaRulesConfig,
  isKarmaTierConfigList,
  karmaTierForBalanceIn,
  matrixEntryFor,
  nextKarmaTierIn,
  reviewLoadForFieldCount,
  validatorKarma,
  type ComplexityScore,
  type KarmaMatrixConfig,
  type KarmaPricingTable,
  type KarmaRulesConfig,
  type KarmaTierConfig,
  type ReviewLoad,
  type VerificationBand,
} from "../lib/karma-matrix.js";

export type KarmaTier = "dharma" | "bodhi" | "moksha" | "nirvana";

export const KARMA_TIERS: {
  tier: KarmaTier;
  label: string;
  minKarma: number;
  color: string;
  blurb: string;
  perks: string[];
  earlyAccessHours: number;
  concurrencyBonus: number;
}[] = [
  {
    tier: "dharma",
    label: "Dharma",
    minKarma: 0,
    color: "#8a9382",
    blurb: "The path is taken. Every accepted item carries the contributor's name.",
    perks: ["Leaderboard listing", "Tier badge on profile", "Named credit on published dataset cards you contributed to"],
    earlyAccessHours: 0,
    concurrencyBonus: 0,
  },
  {
    tier: "bodhi",
    label: "Bodhi",
    minKarma: 5_000,
    color: "#d4a24e",
    blurb: "Awakening. The platform sees you before the crowd.",
    perks: ["Everything in Dharma", "24h early access to new community dataset pools", "Batch sizes up to 25 items"],
    earlyAccessHours: 24,
    concurrencyBonus: 1,
  },
  {
    tier: "moksha",
    label: "Moksha",
    minKarma: 50_000,
    color: "#b6ff1c",
    blurb: "Liberation. Work recognized across domains.",
    perks: ["Everything in Bodhi", "48h early access", "Claim priority queue", "Validator qualification fast-track"],
    earlyAccessHours: 48,
    concurrencyBonus: 2,
  },
  {
    tier: "nirvana",
    label: "Nirvana",
    minKarma: 500_000,
    color: "#b9a6f2",
    blurb: "The summit. Direct invites to featured dataset programs.",
    perks: ["Everything in Moksha", "72h first look", "Direct invites to featured dataset programs"],
    earlyAccessHours: 72,
    concurrencyBonus: 3,
  },
];

export function karmaTierForBalance(balance: number): (typeof KARMA_TIERS)[number] {
  let current = KARMA_TIERS[0]!;
  for (const candidate of KARMA_TIERS) {
    if (balance >= candidate.minKarma) current = candidate;
  }
  return current;
}

export const KARMA_RULES = {
  acceptedItem: {
    beginner: 10,
    intermediate: 25,
    advanced: 60,
  },
  auditItem: 8,
  confirmedFlag: 25,
  requestApproved: 25,
  publishBonus: 150,
  bountyPublished: 50,
} as const;

/* ------------------------------------------------------------------------ *
 * Runtime karma configuration
 *
 * `KARMA_TIERS`, `KARMA_RULES` and `CATEGORY_PRICING_SEED` above are the CODE
 * DEFAULTS, not the source of truth. The admin console's karma editor writes
 * `karma.tiers` / `karma.rules` / `karma.matrix` into `admin_settings`, and
 * until these readers existed the editor controlled nothing: every surface
 * rendered the module constants no matter what an operator saved.
 *
 * Three properties this deliberately keeps:
 *  - **Additive.** The synchronous constants and `karmaTierForBalance` are
 *    still exported unchanged, so every existing caller keeps compiling and
 *    behaving exactly as before. New callers use the async readers.
 *  - **Fail-safe.** An absent row, or a stored row that no longer satisfies
 *    its shape, falls back WHOLESALE to the code default. Never a partial
 *    merge — half a saved tier table spliced into half the constants is a
 *    configuration nobody chose and nobody can inspect.
 *  - **Live.** Read per call through `getAdminSetting`, so an operator's save
 *    takes effect on the next request with no deploy and no cache to bust.
 * ------------------------------------------------------------------------ */

export const KARMA_SETTING_KEYS = {
  tiers: "karma.tiers",
  rules: "karma.rules",
  matrix: "karma.matrix",
} as const;

export interface KarmaRuntimeSettings {
  tiers: KarmaTierConfig[];
  rules: KarmaRulesConfig;
  matrix: KarmaMatrixConfig;
  /** Which of the three came from `admin_settings` rather than the code
   *  defaults. Surfaced so an admin screen can say "this is the default"
   *  honestly instead of implying every value was configured. */
  source: { tiers: "stored" | "default"; rules: "stored" | "default"; matrix: "stored" | "default" };
}

export async function getKarmaTiers(): Promise<{ tiers: KarmaTierConfig[]; source: "stored" | "default" }> {
  const stored = await getAdminSetting<unknown>(KARMA_SETTING_KEYS.tiers);
  if (isKarmaTierConfigList(stored)) return { tiers: stored, source: "stored" };
  return { tiers: KARMA_TIERS.map((t) => ({ ...t, perks: [...t.perks] })), source: "default" };
}

export async function getKarmaRules(): Promise<{ rules: KarmaRulesConfig; source: "stored" | "default" }> {
  const stored = await getAdminSetting<unknown>(KARMA_SETTING_KEYS.rules);
  if (isKarmaRulesConfig(stored)) return { rules: stored, source: "stored" };
  return {
    rules: {
      acceptedItem: { ...KARMA_RULES.acceptedItem },
      auditItem: KARMA_RULES.auditItem,
      confirmedFlag: KARMA_RULES.confirmedFlag,
      requestApproved: KARMA_RULES.requestApproved,
      publishBonus: KARMA_RULES.publishBonus,
      bountyPublished: KARMA_RULES.bountyPublished,
    },
    source: "default",
  };
}

export async function getKarmaMatrix(): Promise<{ matrix: KarmaMatrixConfig; source: "stored" | "default" }> {
  const stored = await getAdminSetting<unknown>(KARMA_SETTING_KEYS.matrix);
  if (isKarmaMatrixConfig(stored)) return { matrix: stored, source: "stored" };
  return { matrix: CATEGORY_PRICING_SEED, source: "default" };
}

/** All three at once — one round trip per key, resolved in parallel. */
export async function getKarmaRuntimeSettings(): Promise<KarmaRuntimeSettings> {
  const [tiers, rules, matrix] = await Promise.all([getKarmaTiers(), getKarmaRules(), getKarmaMatrix()]);
  return {
    tiers: tiers.tiers,
    rules: rules.rules,
    matrix: matrix.matrix,
    source: { tiers: tiers.source, rules: rules.source, matrix: matrix.source },
  };
}

/* ------------------------------------------------------------------------ *
 * Contributor / validator per-item karma resolution.
 *
 * Ported from v1's services/karma.ts, adapted to this tree's simpler
 * `KarmaMatrixConfig` (per-category axis overrides, keyed by dataset-type id)
 * instead of v1's fully versioned `KarmaMatrix` document — see
 * lib/karma-matrix.ts's kernel-vs-config split comment for why the ladder
 * itself stays a code constant here rather than a third admin setting.
 *
 * Resolution order for an accepted item, most-authoritative first:
 *
 *  1. A community program that names its own per-item amount at mint time
 *     keeps it (`Bounty.karmaPerAcceptedItem > 0`) — quoted to contributors
 *     when they started work and must never change under them.
 *  2. A frozen `Bounty.karmaQuote` snapshot (axes captured at mint) prices the
 *     ladder cell from (complexity, difficulty, verification band) using the
 *     SAME axes the contributor was quoted, immune to a later admin edit of
 *     the dataset type or the live `karma.matrix` override map.
 *  3. The live axes — the admin `karma.matrix` per-category override
 *     (`getKarmaMatrix()`) when present, else the dataset type's own
 *     `complexityScore`/`verificationUnits` columns — price the same ladder
 *     cell. This is the branch that was entirely missing before: nothing in
 *     this codebase turned those two live axes into a karma amount, so every
 *     zero `karmaPerAcceptedItem` (the "auto-price from the matrix" sentinel)
 *     fell through to a bare `|| 25` instead.
 *  4. Otherwise the flat `karma.rules.acceptedItem[difficulty]` scale — an
 *     unpriced type, or a category with neither a quote nor live axes.
 *
 * Never throws: callers run inside accept/award transactions, where raising
 * would abort acceptance of an already-good submission — strictly worse than
 * pricing it at the safe flat fallback.
 */

/** The two pricing axes for one dataset type/category, as read from either
 * the live catalog row or a live `karma.matrix` override. Both nullable —
 * an unscored category is deliberately unpriced, never defaulted. */
export interface TypePricingInputs {
  complexityScore: number | null;
  verificationUnits: number | null;
}

/** Immutable pricing inputs captured on a bounty at mint time. Deliberately
 * NOT a full versioned ladder snapshot (contrast v1's `BountyKarmaQuote`,
 * which embeds the whole `KarmaMatrix` document): this tree's ladder is a
 * code constant (`DEFAULT_KARMA_PRICING_TABLE`), not admin-edited, so there
 * is nothing further to pin against future drift beyond the two axes and the
 * field count themselves. */
export interface BountyKarmaQuote {
  version: 1;
  complexityScore: ComplexityScore;
  verificationUnits: number;
  fieldCount: number;
}

/** Build a fresh quote from a dataset type's live axes, e.g. at bounty mint.
 * Returns null when the type is unpriced — callers must not mint a quote for
 * an unpriced type. */
export function createBountyKarmaQuote(type: {
  complexityScore: number | null;
  verificationUnits: number | null;
  fields: unknown;
}): BountyKarmaQuote | null {
  if (!isComplexityScore(type.complexityScore) || type.verificationUnits === null || type.verificationUnits < 0) return null;
  return {
    version: 1,
    complexityScore: type.complexityScore,
    verificationUnits: type.verificationUnits,
    fieldCount: Array.isArray(type.fields) ? type.fields.length : 0,
  };
}

/** Validate a stored `Bounty.karmaQuote` JSON value before trusting it. A row
 * can predate this shape, be hand-edited, or be malformed — falls back to
 * "no quote" (never a partial read) so the caller moves to the next
 * resolution tier instead of pricing off missing fields. */
function asBountyKarmaQuote(value: unknown): BountyKarmaQuote | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const quote = value as Partial<BountyKarmaQuote>;
  if (
    quote.version !== 1 ||
    !isComplexityScore(quote.complexityScore) ||
    !Number.isInteger(quote.verificationUnits) ||
    (quote.verificationUnits ?? -1) < 0 ||
    !Number.isInteger(quote.fieldCount) ||
    (quote.fieldCount ?? -1) < 0
  ) {
    return null;
  }
  return quote as BountyKarmaQuote;
}

/** The live per-category axes for one dataset type: the admin `karma.matrix`
 * override when the category has one, else the catalog row's own
 * `complexityScore`/`verificationUnits`. Wires the previously-dead
 * `KarmaMatrixConfig`/`matrixEntryFor` into an actual pricing read. */
export function effectiveTypePricing(
  datasetTypeId: string | null | undefined,
  datasetType: { complexityScore: number | null; verificationUnits: number | null } | null | undefined,
  matrixConfig: KarmaMatrixConfig
): TypePricingInputs {
  const override = matrixEntryFor(matrixConfig, datasetTypeId);
  if (override) return { complexityScore: override.complexityScore, verificationUnits: override.verificationUnits };
  return { complexityScore: datasetType?.complexityScore ?? null, verificationUnits: datasetType?.verificationUnits ?? null };
}

/** Karma for one accepted item, tiers 1/3/4 of the resolution order above
 * (tier 2, the frozen quote, is `acceptedItemKarmaForBounty` below — this is
 * the pure fallback used both by that function and anywhere a bounty has no
 * quote at all yet). */
export function acceptedItemKarma(
  karmaPerAcceptedItem: number,
  difficulty: string | null | undefined,
  rules: KarmaRulesConfig,
  typePricing: TypePricingInputs | null,
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE
): number {
  // (1) Frozen program rate wins over everything.
  if (karmaPerAcceptedItem > 0) return karmaPerAcceptedItem;

  const resolved = resolveItemDifficulty(difficulty);

  // (3) Live matrix branch — only when both axes are present. Narrowed with
  // `isComplexityScore` so an out-of-range score fails closed to the flat
  // scale rather than indexing the ladder to nothing.
  if (typePricing && isComplexityScore(typePricing.complexityScore) && typePricing.verificationUnits !== null) {
    const band = bandForVerificationUnits(typePricing.verificationUnits, table);
    return contributorKarma(typePricing.complexityScore, resolved.level, band, table);
  }

  // (4) Flat difficulty scale — an unpriced type.
  return rules.acceptedItem[resolved.level];
}

/** Karma for one accepted item on a specific bounty — tiers 1/2/3/4 in full,
 * preferring the bounty's own frozen quote (tier 2) over live axes so a
 * contributor's price can never move under them after they started work.
 * Returns the quote alongside the amount so callers (`communityPricingSummary`)
 * can report which axes actually priced the item. */
export function acceptedItemKarmaForBounty(
  karmaPerAcceptedItem: number,
  difficulty: string | null | undefined,
  quoteValue: unknown,
  rules: KarmaRulesConfig,
  legacyTypePricing: TypePricingInputs | null,
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE
): { amount: number; quote: BountyKarmaQuote | null } {
  const quote = asBountyKarmaQuote(quoteValue);
  if (karmaPerAcceptedItem > 0) return { amount: karmaPerAcceptedItem, quote };
  if (quote) {
    const band = bandForVerificationUnits(quote.verificationUnits, table);
    return { amount: contributorKarma(quote.complexityScore, resolveItemDifficulty(difficulty).level, band, table), quote };
  }
  return { amount: acceptedItemKarma(karmaPerAcceptedItem, difficulty, rules, legacyTypePricing, table), quote: null };
}

/** Karma for one audited item, mirroring `acceptedItemKarma`'s fail-closed
 * pattern on the validator's (complexity, review-load) axis pair instead. */
export function auditItemKarma(
  rules: KarmaRulesConfig,
  typePricing: { complexityScore: number | null; fieldCount: number } | null,
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE
): number {
  if (typePricing && isComplexityScore(typePricing.complexityScore)) {
    const load = reviewLoadForFieldCount(typePricing.fieldCount, table);
    return validatorKarma(typePricing.complexityScore, load, table);
  }
  return rules.auditItem;
}

/** Karma for one audited item on a specific bounty: the frozen quote when
 * present, else the live dataset-type axes, else the flat `auditItem` rate. */
export function auditItemKarmaForBounty(
  quoteValue: unknown,
  rules: KarmaRulesConfig,
  legacyTypePricing: { complexityScore: number | null; fieldCount: number } | null,
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE
): { amount: number; quote: BountyKarmaQuote | null } {
  const quote = asBountyKarmaQuote(quoteValue);
  if (quote) {
    const load = reviewLoadForFieldCount(quote.fieldCount, table);
    return { amount: validatorKarma(quote.complexityScore, load, table), quote };
  }
  return { amount: auditItemKarma(rules, legacyTypePricing, table), quote: null };
}

/**
 * The validator's real per-item audit rate for a community bounty — what a
 * completed audit decision actually pays. Thin wrapper over
 * `auditItemKarmaForBounty` so every surface (audit list/detail, the pool
 * contract, MCP) derives the SAME number the award path computes, instead of
 * each re-deriving field count independently or quoting the contributor's
 * per-accepted-item rate as if it were the validator's (a real bug: the two
 * are priced on different axes — contributor by complexity x difficulty x
 * verification-band, validator by complexity x review-load).
 */
export function validatorAuditKarmaPerItem(
  bounty: { karmaQuote: unknown; datasetType: { complexityScore: number | null; fields: unknown } | null },
  rules: KarmaRulesConfig,
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE
): number {
  const fieldCount = Array.isArray(bounty.datasetType?.fields) ? bounty.datasetType!.fields.length : 0;
  return auditItemKarmaForBounty(
    bounty.karmaQuote,
    rules,
    { complexityScore: bounty.datasetType?.complexityScore ?? null, fieldCount },
    table
  ).amount;
}

/** One server-owned, display-safe pricing snapshot for a community program.
 * Every UI/MCP surface must consume this instead of presenting the `0`
 * auto-pricing sentinel or reimplementing ladder arithmetic. */
export function communityPricingSummary(
  input: {
    karmaPerAcceptedItem: number;
    difficulty: string | null | undefined;
    karmaQuote: unknown;
    targetItems: number;
    auditCoveragePct: number;
    typePricing: TypePricingInputs;
    fieldCount: number;
  },
  rules: KarmaRulesConfig,
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE
) {
  const contributor = acceptedItemKarmaForBounty(
    input.karmaPerAcceptedItem,
    input.difficulty,
    input.karmaQuote,
    rules,
    input.typePricing,
    table
  );
  const validator = auditItemKarmaForBounty(
    input.karmaQuote,
    rules,
    { complexityScore: input.typePricing.complexityScore, fieldCount: input.fieldCount },
    table
  );
  const plannedAuditItems = Math.ceil((input.targetItems * input.auditCoveragePct) / 100);
  return {
    contributorPerItem: contributor.amount,
    contributorTotal: contributor.amount * input.targetItems,
    validatorPerAuditedItem: validator.amount,
    plannedAuditItems,
    validatorTotal: validator.amount * plannedAuditItems,
    // No versioned ladder config exists in this tree (see lib/karma-matrix.ts) —
    // `matrixVersion` stays null rather than claiming one that cannot drift.
    matrixVersion: null as number | null,
    complexityScore: contributor.quote?.complexityScore ?? input.typePricing.complexityScore,
    verificationUnits: contributor.quote?.verificationUnits ?? input.typePricing.verificationUnits,
    difficulty: resolveItemDifficulty(input.difficulty).level,
  };
}

const PUBLISHED_DIFFICULTY_LABELS: Record<ItemDifficulty, string> = {
  beginner: "Beginner",
  intermediate: "Balanced",
  advanced: "Advanced",
};
const REVIEW_LOAD_LABELS: Record<ReviewLoad, string> = { light: "Light", standard: "Standard", heavy: "Heavy" };
const BAND_LABELS: Record<VerificationBand, string> = { standard: "Standard", elevated: "Elevated", heavy: "Heavy" };

function bandRules(table: KarmaPricingTable): { band: VerificationBand; label: string; rule: string }[] {
  const { elevatedMinUnits, heavyMinUnits } = table.bandThresholds;
  return [
    { band: "standard", label: BAND_LABELS.standard, rule: `${elevatedMinUnits - 1} or fewer verification units` },
    {
      band: "elevated",
      label: BAND_LABELS.elevated,
      rule: heavyMinUnits - 1 > elevatedMinUnits ? `${elevatedMinUnits}–${heavyMinUnits - 1} units` : `${elevatedMinUnits} units`,
    },
    { band: "heavy", label: BAND_LABELS.heavy, rule: `${heavyMinUnits} or more units` },
  ];
}

/** One real, live worked example for the member karma page — not the whole
 * rate table (which is admin-editable and lives in the admin console). Built
 * from a real, priced dataset type so the numbers shown are ones the platform
 * would actually pay for that category. */
export interface KarmaPricingExample {
  datasetTypeId: string;
  datasetTypeName: string;
  complexity: ComplexityScore;
  verificationUnits: number;
  band: VerificationBand;
  bandLabel: string;
  bandRule: string;
  difficulties: { level: ItemDifficulty; label: string; publishedLabel: string; karma: number }[];
  validator: { reviewLoad: ReviewLoad; reviewLoadLabel: string; fields: number; karma: number };
}

export function karmaPricingExample(
  type: { id: string; name: string; complexityScore: number | null; verificationUnits: number | null; fieldCount: number },
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE
): KarmaPricingExample | null {
  if (!isComplexityScore(type.complexityScore) || type.verificationUnits === null) return null;
  const band = bandForVerificationUnits(type.verificationUnits, table);
  const reviewLoad = reviewLoadForFieldCount(type.fieldCount, table);
  return {
    datasetTypeId: type.id,
    datasetTypeName: type.name,
    complexity: type.complexityScore,
    verificationUnits: type.verificationUnits,
    band,
    bandLabel: BAND_LABELS[band],
    bandRule: bandRules(table).find((entry) => entry.band === band)?.rule ?? "",
    difficulties: CANONICAL_DIFFICULTY_LEVELS.map((level) => ({
      level,
      label: level.charAt(0).toUpperCase() + level.slice(1),
      publishedLabel: PUBLISHED_DIFFICULTY_LABELS[level],
      karma: contributorKarma(type.complexityScore as ComplexityScore, level, band, table),
    })),
    validator: {
      reviewLoad,
      reviewLoadLabel: REVIEW_LOAD_LABELS[reviewLoad],
      fields: type.fieldCount,
      karma: validatorKarma(type.complexityScore, reviewLoad, table),
    },
  };
}

export interface KarmaMatrixView {
  version: number;
  pricingActive: boolean;
  activeScale: "difficulty_scale" | "matrix";
  bands: { band: VerificationBand; label: string; rule: string }[];
  example: KarmaPricingExample | null;
  lowestKarma: number;
  highestKarma: number;
  catalogMaxKarma: number | null;
}

/** Build the render model the member karma page's `PricingSection` expects.
 * `activeScale` is always "matrix" in this tree: unlike v1, there is no
 * admin toggle to cut the award path back to the flat difficulty scale while
 * still publishing the matrix as configuration — the matrix branch fires
 * whenever a category carries both live axes (see `acceptedItemKarma`
 * above), full stop. */
export function karmaMatrixView(
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE,
  catalogMaxKarma: number | null = null,
  example: KarmaPricingExample | null = null
): KarmaMatrixView {
  const cells = contributorMatrixCells(table);
  return {
    version: 1,
    pricingActive: true,
    activeScale: "matrix",
    bands: bandRules(table),
    example,
    lowestKarma: Math.min(...cells.map((cell) => cell.karma)),
    highestKarma: Math.max(...cells.map((cell) => cell.karma)),
    catalogMaxKarma,
  };
}

/** How many accepted items each tier takes, at a given karma-per-item rate.
 * Computed from the live ladder and live tier thresholds so the two can never
 * disagree after an admin edits either one. `ceil`, not round. */
export interface TierItemEstimate {
  tier: string;
  label: string;
  minKarma: number;
  items: number | null;
}

export function itemsNeededPerTier(karmaPerItem: number, tiers: readonly KarmaTierConfig[]): TierItemEstimate[] {
  return tiers
    .filter((tier) => tier.minKarma > 0)
    .map((tier) => ({
      tier: tier.tier,
      label: tier.label,
      minKarma: tier.minKarma,
      items: karmaPerItem > 0 ? Math.ceil(tier.minKarma / karmaPerItem) : null,
    }));
}

/**
 * Two facts the member karma page needs from the live catalog, in one read:
 * the highest accepted-item karma any active dataset type could actually pay
 * today (read from catalog rows, not the ladder's top rung — the top rung
 * needs more verification units than any category currently declares, so
 * quoting it as reachable would overstate what a contributor can earn), and
 * one real priced category to build the worked example from.
 */
export async function catalogPricingFacts(
  table: KarmaPricingTable = DEFAULT_KARMA_PRICING_TABLE
): Promise<{ maxKarma: number | null; example: KarmaPricingExample | null }> {
  const { matrix: liveMatrix } = await getKarmaMatrix();
  const priced = await prisma.datasetType.findMany({
    where: { status: "active", complexityScore: { not: null } },
    select: { id: true, name: true, complexityScore: true, verificationUnits: true, fields: true, usageCount: true },
    orderBy: [{ usageCount: "desc" }, { id: "asc" }],
  });
  const amounts = priced.flatMap((type) => {
    const pricing = effectiveTypePricing(type.id, type, liveMatrix);
    if (!isComplexityScore(pricing.complexityScore) || pricing.verificationUnits === null) return [];
    const band = bandForVerificationUnits(pricing.verificationUnits, table);
    return [contributorKarma(pricing.complexityScore, "advanced", band, table)];
  });
  const exampleRow = priced.find((type) => {
    const pricing = effectiveTypePricing(type.id, type, liveMatrix);
    return isComplexityScore(pricing.complexityScore) && pricing.verificationUnits !== null;
  });
  return {
    maxKarma: amounts.length > 0 ? Math.max(...amounts) : null,
    example: exampleRow
      ? karmaPricingExample(
          {
            id: exampleRow.id,
            name: exampleRow.name,
            ...effectiveTypePricing(exampleRow.id, exampleRow, liveMatrix),
            fieldCount: Array.isArray(exampleRow.fields) ? exampleRow.fields.length : 0,
          },
          table
        )
      : null,
  };
}

/** Live-configured counterpart to the synchronous `karmaTierForBalance`. Use
 *  this anywhere the answer is shown to a member or gates a capability, so an
 *  operator's tier edit is actually the tier the member gets. */
export async function resolveKarmaTier(
  balance: number
): Promise<{ current: KarmaTierConfig; next: KarmaTierConfig | null; progress: number }> {
  const { tiers } = await getKarmaTiers();
  const current = karmaTierForBalanceIn(tiers, balance);
  const next = nextKarmaTierIn(tiers, balance);
  const progress = next ? Math.min(1, Math.max(0, (balance - current.minKarma) / (next.minKarma - current.minKarma))) : 1;
  return { current, next, progress };
}

export async function awardKarma(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    eventType: KarmaEventType;
    amount: number;
    sourceType: string;
    sourceId: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ id: string; amount: number; total: number } | null> {
  const existing = await tx.karmaEvent.findUnique({
    where: {
      userId_eventType_sourceType_sourceId: {
        userId: params.userId,
        eventType: params.eventType,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
      },
    },
  });

  if (existing) {
    return null;
  }

  const event = await tx.karmaEvent.create({
    data: {
      userId: params.userId,
      eventType: params.eventType,
      amount: params.amount,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      metadata: params.metadata as Prisma.InputJsonValue,
    },
  });

  const updatedUser = await tx.user.update({
    where: { id: params.userId },
    data: {
      karmaTotal: { increment: params.amount },
    },
    select: { karmaTotal: true },
  });

  // The `karma.awarded` event has been in the catalog
  // (services/notifications/events.ts) with no emitter, so a member's balance
  // moved with nothing telling them. Emitted INSIDE the `existing` guard above,
  // so it inherits this function's idempotency exactly: a retried award writes
  // no event and therefore sends nothing. Same transaction as the balance
  // change — a transactional outbox write, not a side effect that can survive a
  // rolled-back award. Its catalog cadence is "digest" on purpose, so an active
  // contributor gets one line a day rather than one push per accepted item.
  await notifyEvent(tx, "karma.awarded", {
    userId: params.userId,
    entityId: event.id,
    keySuffix: `${params.sourceType}:${params.sourceId}`,
    data: { amount: String(params.amount), reason: params.eventType.replaceAll("_", " ") },
  });

  // The balance just moved, so the member's Open-leaderboard position may have
  // too. QUEUED rather than computed here: a rank is a range COUNT over users,
  // and this function runs once per accepted item — inline it would add that
  // count to every item of a bulk acceptance, inside this open transaction.
  // Sits after the `existing` guard so it inherits this function's idempotency
  // exactly: a retried award enqueues nothing.
  await enqueueLeaderboardRankCheck(params.userId, new Date(), tx);

  return { id: event.id, amount: params.amount, total: updatedUser.karmaTotal };
}

export async function reverseAcceptedSubmissionKarma(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    sourceType: string;
    sourceId: string;
    reason?: string;
  }
): Promise<boolean> {
  const original = await tx.karmaEvent.findUnique({
    where: {
      userId_eventType_sourceType_sourceId: {
        userId: params.userId,
        eventType: KarmaEventType.community_item_accepted,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
      },
    },
  });

  if (!original) return false;

  await tx.karmaEvent.create({
    data: {
      userId: params.userId,
      eventType: KarmaEventType.community_item_reversed,
      amount: -original.amount,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      metadata: { originalEventId: original.id, reason: params.reason ?? "dispute_upheld" },
    },
  });

  await tx.user.update({
    where: { id: params.userId },
    data: {
      karmaTotal: { decrement: original.amount },
    },
  });

  return true;
}

export async function getKarmaBreakdown(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      karmaTotal: true,
      leaderboardRank: true,
      leaderboardRankPrev: true,
      leaderboardRankMovedAt: true,
    },
  });

  if (!user) return null;

  const events = await prisma.karmaEvent.groupBy({
    by: ["eventType"],
    where: { userId },
    _sum: { amount: true },
    _count: { id: true },
  });

  // Live-configured tier lookup (resolveKarmaTier), not the static
  // KARMA_TIERS/karmaTierForBalance code defaults — this is the shared root
  // GET /v1/community/karma, GET /v1/me/karma, and MCP get_karma_details all
  // read through, so fixing it here makes an admin's karma.tiers edit reach
  // every one of those surfaces without touching them individually.
  const { current: tier, next: nextTier, progress } = await resolveKarmaTier(user.karmaTotal);

  const breakdown: Record<string, { total: number; count: number }> = {};
  for (const ev of events) {
    breakdown[ev.eventType] = {
      total: ev._sum.amount ?? 0,
      count: ev._count.id,
    };
  }

  return {
    totalKarma: user.karmaTotal,
    tier: {
      current: tier,
      next: nextTier,
      progress,
    },
    leaderboardRank: user.leaderboardRank,
    leaderboardRankPrev: user.leaderboardRankPrev,
    leaderboardRankMovedAt: user.leaderboardRankMovedAt,
    breakdown,
  };
}

export async function getKarmaHistory(
  userId: string,
  params?: { limit?: number; offset?: number }
) {
  const take = Math.min(params?.limit ?? 50, 100);
  const skip = params?.offset ?? 0;

  const [events, total] = await Promise.all([
    prisma.karmaEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.karmaEvent.count({ where: { userId } }),
  ]);

  return { events, total, limit: take, offset: skip };
}

// Opaque cursor: base64(`${karmaTotal}:${id}`) — matches the compound
// orderBy below (karmaTotal desc, id asc as a stable tiebreak) so a cursor
// unambiguously identifies "everyone after this row" even when many users
// share the same karmaTotal.
function encodeLeaderCursor(karmaTotal: number, id: string): string {
  return Buffer.from(`${karmaTotal}:${id}`, "utf8").toString("base64url");
}

function decodeLeaderCursor(cursor: string): { karmaTotal: number; id: string } | null {
  try {
    const [karmaTotalRaw, id] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
    const karmaTotal = Number(karmaTotalRaw);
    if (!id || !Number.isFinite(karmaTotal)) return null;
    return { karmaTotal, id };
  } catch {
    return null;
  }
}

export async function getLeaderboard(params?: {
  limit?: number;
  cursor?: string | null;
  tier?: KarmaTier;
  q?: string;
}) {
  const take = Math.min(params?.limit ?? 50, 100);

  // SEC-10: `profilePublic` gates whether a profile is public at all, but a
  // member can separately hide "karma & tier" (`publicProfilePrefs.showKarma
  // === false`, same preference GET /v1/handle/:handle honors) while keeping
  // the rest of their profile public. Before this, the open/anonymous
  // leaderboard ignored that preference entirely and still published the
  // member's exact karma total and rank — the same class of leak the
  // single-profile fix closed, just reachable through a different, bulk
  // endpoint. Default (no stored prefs, or a non-boolean value) is
  // showKarma: true, matching profiles.ts/me.ts, so this only excludes an
  // explicit `false`.
  const showKarmaOnly: Prisma.UserWhereInput = {
    OR: [
      { publicProfilePrefs: { equals: Prisma.DbNull } },
      { NOT: { publicProfilePrefs: { path: ["showKarma"], equals: false } } },
    ],
  };

  const where: Prisma.UserWhereInput = {
    profilePublic: true,
    handle: { not: null },
    karmaTotal: { gt: 0 },
    status: "active" as const,
    // Nested under `AND` (its own array entry), not spread onto `where`
    // directly: both the `q` search below and the cursor branch further down
    // also assign the top-level `where.OR` key, and the cursor branch
    // OVERWRITES rather than merges (pre-existing, out of scope here). A
    // sibling `OR` from `showKarmaOnly` would have been clobbered by either
    // one; `AND` is a distinct key so it survives both.
    AND: [showKarmaOnly],
    ...(params?.q ? { OR: [{ handle: { contains: params.q, mode: "insensitive" } }, { displayName: { contains: params.q, mode: "insensitive" } }] } : {}),
  };
  if (params?.tier) {
    const tierIndex = KARMA_TIERS.findIndex((t) => t.tier === params.tier);
    const floor = KARMA_TIERS[tierIndex]!.minKarma;
    const ceilingTier = KARMA_TIERS[tierIndex + 1];
    where.karmaTotal = ceilingTier ? { gte: floor, lt: ceilingTier.minKarma } : { gte: floor };
  }

  const cursor = params?.cursor ? decodeLeaderCursor(params.cursor) : null;
  if (cursor) {
    where.OR = [
      { karmaTotal: { lt: cursor.karmaTotal } },
      { karmaTotal: cursor.karmaTotal, id: { gt: cursor.id } },
    ];
  }

  // +1 to detect "is there another page" without a second count query.
  const users = await prisma.user.findMany({
    where,
    select: { id: true, displayName: true, handle: true, karmaTotal: true },
    orderBy: [{ karmaTotal: "desc" }, { id: "asc" }],
    take: take + 1,
  });
  const hasMore = users.length > take;
  const page = hasMore ? users.slice(0, take) : users;

  // Real accepted-item counts, batched in one groupBy rather than N+1 queries.
  const acceptedByUser = page.length
    ? await prisma.submission.groupBy({
        by: ["contributorUserId"],
        where: { contributorUserId: { in: page.map((u) => u.id) }, status: "accepted" },
        _count: { _all: true },
      })
    : [];
  const acceptedMap = new Map(acceptedByUser.map((row) => [row.contributorUserId, row._count._all]));

  // Rank is a global position, not just this page's index — computed via a
  // count of users who genuinely rank strictly above each row (more karma,
  // or equal karma with a lower tiebreak id).
  const leaderboard = await Promise.all(
    page.map(async (u) => ({
      rank:
        1 +
        (await prisma.user.count({
          where: {
            profilePublic: true,
            handle: { not: null },
            status: "active" as const,
            AND: [showKarmaOnly],
            OR: [{ karmaTotal: { gt: u.karmaTotal } }, { karmaTotal: u.karmaTotal, id: { lt: u.id } }],
          },
        })),
      handle: u.handle!,
      displayName: u.displayName,
      karma: u.karmaTotal,
      acceptedItems: acceptedMap.get(u.id) ?? 0,
    })),
  );

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeLeaderCursor(last.karmaTotal, last.id) : null;

  return { leaderboard, nextCursor };
}
