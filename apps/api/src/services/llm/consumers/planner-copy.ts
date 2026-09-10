// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { DatasetType } from "@prisma/client";
import { BUNDLED_LICENSE_IDS } from "../../../lib/publication/license-texts.js";
import { llm } from "../service.js";

/**
 * Create-request planner copy. Ported from v1's
 * `services/llm/consumers/planner-copy.ts`.
 *
 * THE INVARIANT, restated because it is the whole point of this consumer:
 * only WORDING may come from a model. Every chip VALUE here is server-owned
 * and derived from real stored configuration (the DatasetType's own
 * `difficultyLevels` and `verification.auditOptions`, the bundled SPDX license
 * catalog). The single structured thing a model is allowed to influence — the
 * same one v1 allows and no more — is three bounded delivery-window integers,
 * and `validAiDeadlineChoices` re-validates them (count, integrality, range,
 * uniqueness, ordering) and discards the model's answer wholesale if any check
 * fails. A model can neither add, remove, rename, reorder nor reinterpret a
 * value, and cannot touch karma, audit coverage, licensing, or session state.
 *
 * Deliberate divergences from v1, because this deployment's planner is a
 * different (smaller) funnel:
 *  - Steps mirror `services/planner.ts`'s real `PLANNER_STEPS` (category,
 *    title, items, difficulty, audit, license, language, framework). v1's
 *    `budget` and `funding` steps have no counterpart: there is no $ budget,
 *    no pilot tranche, and no platform fee in this deployment.
 *  - v1's `license` step sells resale-hold windows priced by platform fee.
 *    Here a license is a real SPDX id from the bundled catalog
 *    (`lib/publication/license-texts.ts`) and nothing is priced.
 *  - The `deadline` step is emitted ONLY when a caller supplies
 *    `deadlineChoices`. This deployment's community pools are open-ended and
 *    `GET /v1/planner/catalog` says so explicitly, so inventing a mandatory
 *    delivery-deadline step would be fabricating a product rule.
 *
 * Like v1, this consumer does NOT ask a model to rewrite question/label/hint
 * text even though its system prompt permits it — v1 never wired that either,
 * and paraphrasing questions is the one place where a model could quietly
 * change what a requester thinks they are answering. The prompt keeps the
 * permission scoped so it can be turned on later without loosening the
 * value-immutability rule.
 */

export interface PlannerChip {
  value: string;
  label: string;
  hint?: string;
}

export interface PlannerStepCopy {
  key: string;
  question: string;
  chips: PlannerChip[];
  freeText: boolean;
}

export type DeadlineChoice = { days: number; label: string; hint: string };

const deadlineDaysSchema = z.object({ deadlineDays: z.array(z.number().int()).length(3) });

/**
 * Re-validate a model's three suggested delivery windows. Rejects the whole
 * answer (returning the caller's deterministic choices) unless it is exactly
 * three distinct integers inside the caller's own [min, max] envelope. Sorting
 * happens after validation so an out-of-order-but-valid answer is accepted and
 * normalised rather than discarded.
 */
export function validAiDeadlineChoices(
  values: number[],
  fallback: readonly DeadlineChoice[]
): DeadlineChoice[] {
  const min = fallback[0]?.days;
  const max = fallback[fallback.length - 1]?.days;
  if (min === undefined || max === undefined) return [...fallback];
  if (
    values.length !== 3 ||
    values.some((value) => !Number.isInteger(value) || value < min || value > max)
  ) {
    return [...fallback];
  }
  const ordered = [...values].sort((a, b) => a - b);
  if (new Set(ordered).size !== 3) return [...fallback];
  return ordered.map((days, index) => ({
    days,
    label: index === 0 ? `Fastest — ${days} days` : index === 1 ? `Recommended — ${days} days` : `Comfortable — ${days} days`,
    hint: "AI delivery estimate within the configured range",
  }));
}

/** Catalog-derived working titles — the deterministic default. */
export function fallbackTitles(type: Pick<DatasetType, "name">): string[] {
  const base = type.name.replace(/\s*\/\s*/g, " & ");
  return [`${base} Dataset`, `${base} Verified Set`, `${base} Corpus`];
}

/** Read `auditOptions` off a type's stored `verification` blob, mirroring
 * `routes/v1/planner.ts`'s `auditOptionsFor` so the two cannot disagree. */
function auditOptionsFor(verification: unknown): number[] {
  if (verification && typeof verification === "object" && !Array.isArray(verification)) {
    const opts = (verification as { auditOptions?: unknown }).auditOptions;
    if (Array.isArray(opts) && opts.every((n) => typeof n === "number")) return opts as number[];
  }
  return [10, 25, 50, 100];
}

export interface PlannerCopyOptions {
  /** Item-count presets to offer. Server-owned. */
  itemsPresetCounts?: readonly number[];
  /** When supplied, a `deadline` step is emitted with these choices; a model
   * may refine the day counts only if `deadlineContext` is also supplied. */
  deadlineChoices?: readonly DeadlineChoice[];
  /** Free-text context (item count, difficulty, coverage) that lets a model
   * suggest better day counts. Without it the deadline step is deterministic. */
  deadlineContext?: string;
  userId?: string;
  accountId?: string;
}

const DEFAULT_ITEM_PRESETS = [250, 500, 1_000, 2_000] as const;

function canonicalSteps(
  type: DatasetType,
  itemsPresetCounts: readonly number[],
  deadlineChoices?: readonly DeadlineChoice[]
): PlannerStepCopy[] {
  const levels = type.difficultyLevels?.length ? type.difficultyLevels : ["beginner", "intermediate", "advanced"];
  const has = (level: string) => levels.includes(level);

  const difficulty: PlannerChip[] = [];
  if (has("beginner")) {
    difficulty.push({ value: "mostly_beginner", label: "Mostly beginner", hint: "approachable items, higher volume" });
  }
  difficulty.push({ value: "balanced", label: "Balanced", hint: "even distribution across this type's configured levels" });
  if (has("advanced") || has("expert")) {
    difficulty.push({ value: "mostly_advanced", label: "Mostly advanced", hint: "harder items, more karma per accepted item" });
  }

  const audit = auditOptionsFor(type.verification).map((pct) => ({
    value: String(pct),
    label:
      pct === 0
        ? "Automated checks only — 0%"
        : pct === 100
          ? "Full human audit — 100%"
          : `Partial human audit — ${pct}%`,
    hint:
      pct === 0
        ? "no human-review allocation"
        : pct === 100
          ? "every accepted item receives validator review"
          : "a defined sample receives validator review",
  }));

  const itemCounts = [...itemsPresetCounts].sort((a, b) => a - b);

  const steps: PlannerStepCopy[] = [
    { key: "title", freeText: true, question: "What is the working title for this dataset?", chips: [] },
    {
      key: "items",
      freeText: true,
      question: "How many items should the dataset contain?",
      // The hint is derived from the count's magnitude, not its position in the
      // list — an index-based label gives every middle preset the identical
      // "mid-size corpus" text. Fixed thresholds keep each chip distinct
      // regardless of how many presets are configured.
      chips: itemCounts.map((count) => ({
        value: String(count),
        label: count.toLocaleString("en-US"),
        hint:
          count < 500
            ? "small initial corpus"
            : count < 1_000
              ? "mid-size corpus"
              : count < 2_000
                ? "large corpus"
                : "benchmark-scale corpus",
      })),
    },
    { key: "difficulty", freeText: false, question: "What difficulty mix are you after?", chips: difficulty },
    { key: "audit", freeText: false, question: "How much human validator review is required?", chips: audit },
    {
      key: "license",
      freeText: true,
      question: "Which license should the published dataset carry?",
      // Real SPDX ids from the bundled license catalog — the same set the
      // publication pipeline can attach a full licence text for.
      chips: BUNDLED_LICENSE_IDS.map((spdx) => ({
        value: spdx,
        label: spdx,
        hint: spdx === "CC-BY-4.0" ? "platform default · attribution required" : "full licence text is bundled for publication",
      })),
    },
    { key: "language", freeText: true, question: "What is the primary language the items target?", chips: [] },
    { key: "framework", freeText: true, question: "Any specific framework or runtime?", chips: [] },
  ];

  if (deadlineChoices?.length) {
    steps.push({
      key: "deadline",
      freeText: true,
      question: "By when would you like this delivered?",
      chips: deadlineChoices.map(({ days, label, hint }) => ({ value: String(days), label, hint })),
    });
  }

  return steps;
}

export interface PlannerCopy {
  titles: string[];
  steps: PlannerStepCopy[];
  /** Honest provenance. `"deterministic"` means no model contributed anything
   * to this response — it is never reported as `"llm"`. */
  source: "deterministic" | "llm";
}

export async function generatePlannerCopy(
  type: DatasetType,
  opts: PlannerCopyOptions = {}
): Promise<PlannerCopy> {
  const itemsPresetCounts = opts.itemsPresetCounts?.length ? opts.itemsPresetCounts : DEFAULT_ITEM_PRESETS;
  const fallbackChoices = opts.deadlineChoices;

  // Nothing a model is allowed to influence -> fully deterministic, no egress.
  if (!fallbackChoices?.length || fallbackChoices.length !== 3 || !opts.deadlineContext) {
    return {
      titles: fallbackTitles(type),
      steps: canonicalSteps(type, itemsPresetCounts, fallbackChoices),
      source: "deterministic",
    };
  }

  const res = await llm.complete({
    feature: "planner_copy",
    userId: opts.userId,
    accountId: opts.accountId,
    idempotencyKey: `planner-deadline:v1:${type.id}:${type.version}:${opts.deadlineContext}:${fallbackChoices
      .map((choice) => choice.days)
      .join(",")}`,
    schema: deadlineDaysSchema,
    messages: [
      {
        role: "user",
        content:
          `Return only JSON: {"deadlineDays":[integer,integer,integer]}. ` +
          `Suggest exactly three ascending delivery windows in days for this dataset request. ` +
          `All values must be within ${fallbackChoices[0]!.days} and ${fallbackChoices[2]!.days}, inclusive. ` +
          `Dataset type: ${type.name}. ${opts.deadlineContext}`,
      },
    ],
    fallback: { deadlineDays: fallbackChoices.map((choice) => choice.days) },
  });

  const deadlineChoices = validAiDeadlineChoices(res.data.deadlineDays, fallbackChoices);
  return {
    titles: fallbackTitles(type),
    steps: canonicalSteps(type, itemsPresetCounts, deadlineChoices),
    source: res.fallbackUsed ? "deterministic" : "llm",
  };
}
