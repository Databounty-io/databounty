// SPDX-License-Identifier: Apache-2.0

/**
 * The canonical difficulty scale and the one place a free-text label is
 * resolved onto it.
 *
 * ONE shared leaf module on purpose. A second, divergent copy of the same
 * alias table already exists inside `services/llm/consumers/dataset-type-draft.ts`,
 * and a third is exactly how a mislabelled level gets silently mispriced in
 * one code path while resolving correctly in another.
 */

/** The three levels the platform prices. Ordered easiest → hardest. */
export const CANONICAL_DIFFICULTY_LEVELS = ["beginner", "intermediate", "advanced"] as const;

export type ItemDifficulty = (typeof CANONICAL_DIFFICULTY_LEVELS)[number];

/**
 * Where an unrecognized label lands. Deliberately the middle level: the top
 * would hand a free upgrade to any template that mislabels its levels.
 *
 * This is a resolution fallback for a NON-EMPTY label only. An ABSENT
 * difficulty is reported as `source: "absent"` and callers on the read path
 * must say "none declared" rather than presenting this default as the pool's
 * level — `Bounty.poolDifficulty` is nullable and null means null.
 */
export const DEFAULT_ITEM_DIFFICULTY: ItemDifficulty = "intermediate";

/**
 * Labels that mean a canonical level under a different name.
 *
 * `expert` is the historical spelling of the third level. Kept as a PERMANENT
 * alias: `difficultyLevels` is admin-writable free text, so the old spelling
 * can always reappear, and an alias prices it correctly instead of silently
 * discounting it to the default.
 */
export const ITEM_DIFFICULTY_ALIASES: Readonly<Record<string, ItemDifficulty>> = {
  expert: "advanced",
};

/**
 * How a label resolved — recorded so a mispriced item is visible in evidence
 * rather than inferred from a number.
 *
 * - `exact`   — matched a canonical level.
 * - `alias`   — matched a known alias (e.g. `expert` → `advanced`).
 * - `absent`  — nothing supplied.
 * - `unknown` — a non-empty label matching neither. A real mislabelling.
 */
export type ItemDifficultySource = "exact" | "alias" | "absent" | "unknown";

export interface ResolvedItemDifficulty {
  level: ItemDifficulty;
  source: ItemDifficultySource;
  /** The input as written, trimmed — null when nothing was supplied. */
  raw: string | null;
}

function lookupCanonical(normalized: string): ItemDifficulty | undefined {
  // `Array.includes`, NOT `key in object`: `in` walks the prototype chain, so a
  // template declaring a level named `constructor` or `toString` would resolve
  // to that key and index a rate table to a FUNCTION.
  return (CANONICAL_DIFFICULTY_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as ItemDifficulty)
    : undefined;
}

/**
 * Resolve a difficulty label onto the canonical scale, reporting HOW it
 * resolved. Never throws: callers run inside accept/award transactions, where
 * raising would abort acceptance of a legitimately good submission — strictly
 * worse than pricing it at the default. Unrecognized labels are surfaced
 * through `source` instead of an exception.
 */
export function resolveItemDifficulty(difficulty: string | null | undefined): ResolvedItemDifficulty {
  const raw = typeof difficulty === "string" ? difficulty.trim() : "";
  if (!raw) return { level: DEFAULT_ITEM_DIFFICULTY, source: "absent", raw: null };
  const normalized = raw.toLowerCase();
  const exact = lookupCanonical(normalized);
  if (exact) return { level: exact, source: "exact", raw };
  if (Object.hasOwn(ITEM_DIFFICULTY_ALIASES, normalized)) {
    return { level: ITEM_DIFFICULTY_ALIASES[normalized]!, source: "alias", raw };
  }
  return { level: DEFAULT_ITEM_DIFFICULTY, source: "unknown", raw };
}
