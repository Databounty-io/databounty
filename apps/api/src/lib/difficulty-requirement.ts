// SPDX-License-Identifier: Apache-2.0

import { resolveItemDifficulty } from "./difficulty.js";

/**
 * The selected work level is a contract requirement, not a property
 * contributors should guess from an example. This deliberately gives
 * modality-neutral guidance: a template's field schema and verification
 * profile remain the source of format-specific requirements.
 */
export interface DifficultyRequirement {
  selectedDifficulty: string | null;
  guidance: string;
  sampleRule: string;
}

const GUIDANCE: Record<"beginner" | "intermediate" | "advanced", string> = {
  beginner:
    "Create approachable, self-contained work that tests the stated core requirement clearly. Do not add complexity that makes the item ambiguous or changes the schema.",
  intermediate:
    "Create non-trivial work with realistic constraints and at least one meaningful boundary, variation, or interaction relevant to this dataset type.",
  advanced:
    "Create challenging work with multiple interacting constraints, meaningful edge or failure cases, and enough context for a validator to verify the result against the contract.",
};

export function difficultyRequirement(selectedDifficulty: string | null | undefined): DifficultyRequirement {
  if (!selectedDifficulty?.trim()) {
    return {
      selectedDifficulty: null,
      guidance:
        "This work has no selected difficulty. Follow the explicit schema and verification contract; do not invent a difficulty level from a reference example.",
      sampleRule:
        "Samples show structure and permitted quality only; they are not a substitute for an absent difficulty requirement.",
    };
  }

  const selected = selectedDifficulty.trim();
  const resolved = resolveItemDifficulty(selected);
  return {
    selectedDifficulty: selected,
    guidance:
      resolved.source === "exact" || resolved.source === "alias"
        ? GUIDANCE[resolved.level]
        : `Create work at the requester-selected "${selected}" level. The schema and verification contract remain binding; if that level is not concrete enough to assess, a validator must request clarification rather than accepting a simple sample as the standard.`,
    sampleRule:
      "Samples define field shape and style only. They never lower the selected difficulty; create original items that satisfy this requirement even when a sample is simpler.",
  };
}
