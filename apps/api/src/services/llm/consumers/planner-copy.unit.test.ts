// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetType } from "@prisma/client";

/**
 * `services/llm/consumers/planner-copy.ts` — the bounded-deadline validator
 * and the value-immutability guarantee.
 *
 * The LLM service is mocked, so no provider egress and no database.
 */
const complete = vi.fn();
vi.mock("../service.js", () => ({ llm: { complete } }));

const { generatePlannerCopy, validAiDeadlineChoices, fallbackTitles } = await import("./planner-copy.js");

const FALLBACK = [
  { days: 30, label: "Fastest — 30 days", hint: "shortest preset" },
  { days: 60, label: "Recommended — 60 days", hint: "balanced preset" },
  { days: 90, label: "Comfortable — 90 days", hint: "extra schedule buffer" },
] as const;

const type = {
  id: "type-1",
  version: 1,
  name: "Debugging / Bug Fix",
  difficultyLevels: ["beginner", "intermediate", "advanced"],
  verification: { auditOptions: [0, 25, 100] },
} as unknown as DatasetType;

beforeEach(() => {
  complete.mockReset();
});

describe("validAiDeadlineChoices", () => {
  it("accepts three distinct in-range integers and relabels them", () => {
    const out = validAiDeadlineChoices([35, 55, 80], FALLBACK);
    expect(out.map((c) => c.days)).toEqual([35, 55, 80]);
    expect(out.map((c) => c.label)).toEqual([
      "Fastest — 35 days",
      "Recommended — 55 days",
      "Comfortable — 80 days",
    ]);
  });

  it("sorts an out-of-order but otherwise valid answer rather than discarding it", () => {
    expect(validAiDeadlineChoices([80, 35, 55], FALLBACK).map((c) => c.days)).toEqual([35, 55, 80]);
  });

  it("accepts the inclusive boundaries", () => {
    expect(validAiDeadlineChoices([30, 60, 90], FALLBACK).map((c) => c.days)).toEqual([30, 60, 90]);
  });

  const rejected: Array<[string, number[]]> = [
    ["too few values", [30, 60]],
    ["too many values", [30, 45, 60, 90]],
    ["no values", []],
    ["below the minimum", [1, 60, 90]],
    ["above the maximum", [30, 60, 400]],
    ["non-integer", [30, 60.5, 90]],
    ["NaN", [30, Number.NaN, 90]],
    ["Infinity", [30, 60, Number.POSITIVE_INFINITY]],
    ["duplicates", [60, 60, 90]],
    ["all identical", [60, 60, 60]],
    ["negative", [-30, 60, 90]],
  ];
  for (const [name, values] of rejected) {
    it(`discards the whole answer (${name}) and returns the server's own choices`, () => {
      expect(validAiDeadlineChoices(values, FALLBACK)).toEqual([...FALLBACK]);
    });
  }

  it("returns the fallback unchanged when the caller supplied no choices to bound against", () => {
    expect(validAiDeadlineChoices([30, 60, 90], [])).toEqual([]);
  });
});

describe("generatePlannerCopy — deterministic path", () => {
  it("makes no LLM call and reports source 'deterministic' with no deadline context", async () => {
    const copy = await generatePlannerCopy(type);
    expect(complete).not.toHaveBeenCalled();
    expect(copy.source).toBe("deterministic");
    expect(copy.titles).toEqual(fallbackTitles(type));
  });

  it("omits the deadline step entirely unless the caller offers choices", async () => {
    const copy = await generatePlannerCopy(type);
    expect(copy.steps.map((s) => s.key)).toEqual([
      "title",
      "items",
      "difficulty",
      "audit",
      "license",
      "language",
      "framework",
    ]);
  });

  it("derives audit chip VALUES from the type's stored verification blob", async () => {
    const copy = await generatePlannerCopy(type);
    const audit = copy.steps.find((s) => s.key === "audit")!;
    expect(audit.chips.map((c) => c.value)).toEqual(["0", "25", "100"]);
    expect(audit.chips[0]!.label).toBe("Automated checks only — 0%");
    expect(audit.chips[2]!.label).toBe("Full human audit — 100%");
  });

  it("falls back to the shared coverage presets when the blob has no auditOptions", async () => {
    const bare = { ...type, verification: {} } as unknown as DatasetType;
    const copy = await generatePlannerCopy(bare);
    expect(copy.steps.find((s) => s.key === "audit")!.chips.map((c) => c.value)).toEqual([
      "10", "25", "50", "100",
    ]);
  });

  it("derives difficulty chips from the type's own levels, dropping ones it does not declare", async () => {
    const beginnerOnly = { ...type, difficultyLevels: ["beginner"] } as unknown as DatasetType;
    expect(
      (await generatePlannerCopy(beginnerOnly)).steps.find((s) => s.key === "difficulty")!.chips.map((c) => c.value)
    ).toEqual(["mostly_beginner", "balanced"]);

    const advancedOnly = { ...type, difficultyLevels: ["advanced"] } as unknown as DatasetType;
    expect(
      (await generatePlannerCopy(advancedOnly)).steps.find((s) => s.key === "difficulty")!.chips.map((c) => c.value)
    ).toEqual(["balanced", "mostly_advanced"]);
  });

  it("gives each item-count preset a distinct magnitude-derived hint", async () => {
    const copy = await generatePlannerCopy(type, { itemsPresetCounts: [250, 500, 1_000, 2_000] });
    const hints = copy.steps.find((s) => s.key === "items")!.chips.map((c) => c.hint);
    expect(new Set(hints).size).toBe(4);
    expect(hints).toEqual(["small initial corpus", "mid-size corpus", "large corpus", "benchmark-scale corpus"]);
  });

  it("offers only real SPDX ids from the bundled licence catalog", async () => {
    const copy = await generatePlannerCopy(type);
    const license = copy.steps.find((s) => s.key === "license")!;
    expect(license.chips.length).toBeGreaterThan(0);
    expect(license.chips.map((c) => c.value)).toContain("CC-BY-4.0");
    for (const chip of license.chips) expect(chip.value).toBe(chip.label);
  });
});

describe("generatePlannerCopy — bounded LLM path", () => {
  const liveResult = (deadlineDays: number[]) => ({
    data: { deadlineDays },
    provider: "openrouter",
    model: "anthropic/claude-haiku-4.5",
    usage: { inputTokens: 40, outputTokens: 12, costMicroUsd: 3 },
    fallbackUsed: false,
    failoverUsed: false,
  });

  it("adopts a valid model suggestion and reports source 'llm'", async () => {
    complete.mockResolvedValue(liveResult([31, 62, 88]));
    const copy = await generatePlannerCopy(type, {
      deadlineChoices: FALLBACK,
      deadlineContext: "500 requested items",
    });
    expect(copy.source).toBe("llm");
    expect(copy.steps.find((s) => s.key === "deadline")!.chips.map((c) => c.value)).toEqual(["31", "62", "88"]);
  });

  it("discards an out-of-range model suggestion but still reports source 'llm' honestly", async () => {
    // The model DID answer, so the provenance is 'llm'; its numbers were
    // rejected by the validator, which is a separate fact from who answered.
    complete.mockResolvedValue(liveResult([1, 2, 9_999]));
    const copy = await generatePlannerCopy(type, {
      deadlineChoices: FALLBACK,
      deadlineContext: "500 requested items",
    });
    expect(copy.steps.find((s) => s.key === "deadline")!.chips.map((c) => c.value)).toEqual(["30", "60", "90"]);
    expect(copy.source).toBe("llm");
  });

  it("reports source 'deterministic' when the layer fell back, never 'llm'", async () => {
    complete.mockResolvedValue({
      ...liveResult([30, 60, 90]),
      provider: "fallback",
      model: "deterministic",
      fallbackUsed: true,
    });
    const copy = await generatePlannerCopy(type, {
      deadlineChoices: FALLBACK,
      deadlineContext: "500 requested items",
    });
    expect(copy.source).toBe("deterministic");
  });

  it("leaves every non-deadline chip value untouched on the LLM path", async () => {
    complete.mockResolvedValue(liveResult([31, 62, 88]));
    const deterministic = await generatePlannerCopy(type);
    complete.mockResolvedValue(liveResult([31, 62, 88]));
    const withLlm = await generatePlannerCopy(type, {
      deadlineChoices: FALLBACK,
      deadlineContext: "500 requested items",
    });
    const strip = (steps: { key: string; chips: { value: string }[] }[]) =>
      steps.filter((s) => s.key !== "deadline").map((s) => ({ key: s.key, values: s.chips.map((c) => c.value) }));
    expect(strip(withLlm.steps)).toEqual(strip(deterministic.steps));
    expect(withLlm.titles).toEqual(deterministic.titles);
  });

  it("does not call the model when fewer than three choices bound the range", async () => {
    await generatePlannerCopy(type, {
      deadlineChoices: [FALLBACK[0], FALLBACK[1]],
      deadlineContext: "500 requested items",
    });
    expect(complete).not.toHaveBeenCalled();
  });
});
