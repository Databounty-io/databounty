// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { contractIntegrityError } from "../../../routes/v1/admin-dataset-types.js";

/**
 * `services/llm/consumers/dataset-type-draft.ts`.
 *
 * The load-bearing property is that a drafted contract is UNTRUSTED INPUT: it
 * must survive the same `contractIntegrityError` gate admin activation uses,
 * and a model's near-miss JSON must either be normalised in FORM only or be
 * rejected outright — never silently reinterpreted in meaning.
 */
const complete = vi.fn();
vi.mock("../service.js", () => ({ llm: { complete } }));

const {
  fallbackDraft,
  datasetTypeDraftSchema,
  draftCustomDatasetType,
  titleCaseFromBrief,
  normalizeDraftDifficultyLevels,
  PIPELINE_STAGES,
} = await import("./dataset-type-draft.js");

const integrityOf = (d: { fields: unknown; pipeline: unknown; dedupeFields: unknown; auditOptions: unknown }) =>
  contractIntegrityError(d.fields, {
    pipeline: d.pipeline,
    dedupeFields: d.dedupeFields,
    auditOptions: d.auditOptions,
  });

beforeEach(() => {
  complete.mockReset();
});

describe("PIPELINE_STAGES", () => {
  it("names only stages this deployment's contract gate actually allows", () => {
    // contamination / ai_attribution are hard rejections here; drafting them
    // would produce a contract that could never be activated.
    expect([...PIPELINE_STAGES]).toEqual(["schema", "dedupe", "execution", "llm", "human_audit"]);
  });
});

describe("fallbackDraft", () => {
  it("produces a contract that passes the real integrity gate", () => {
    expect(integrityOf(fallbackDraft("A dataset of off-by-one loop bugs and their fixes."))).toBeNull();
  });

  it("derives a readable name from the brief without a dangling stopword", () => {
    expect(titleCaseFromBrief("buggy python functions and their fixes")).toBe(
      "Buggy Python Functions And Their Fixes"
    );
    // Trailing filler IS trimmed when the six-word window ends on it.
    expect(titleCaseFromBrief("buggy python functions and")).toBe("Buggy Python Functions");
    expect(titleCaseFromBrief("broken loops with")).toBe("Broken Loops");
    // ...but never below two words.
    expect(titleCaseFromBrief("loops and")).toBe("Loops And");
    expect(titleCaseFromBrief("!!")).toBe("Custom Dataset Type");
  });

  it("never dedupes on a file field when forking a media template", () => {
    const draft = fallbackDraft("swap the label vocabulary", {
      name: "Image Annotation",
      fields: [
        { key: "image", label: "Image", role: "file", required: true },
        { key: "instruction", label: "Instruction", role: "instruction", required: true },
      ],
    });
    expect(draft.dedupeFields).toEqual(["instruction"]);
    expect(integrityOf(draft)).toBeNull();
  });

  it("marks a forked draft as adapted and says no AI was involved", () => {
    const draft = fallbackDraft("tweak it", {
      name: "Debugging",
      fields: [
        { key: "instruction", label: "Instruction", role: "instruction", required: true },
        { key: "fix", label: "Fix", role: "solution_code", required: true },
      ],
    });
    expect(draft.name).toBe("Debugging (adapted)");
    expect(draft.notes[0]).toContain("Drafted without AI");
  });
});

describe("datasetTypeDraftSchema coercion — FORM only", () => {
  const base = {
    name: "Loop Bug Fixes",
    description: "Broken loops paired with a corrected implementation.",
    fields: [
      { key: "instruction", label: "Instruction", role: "instruction", required: true, type: "string" },
      { key: "fix", label: "Fix", role: "metadata", required: true },
    ],
    pipeline: ["schema", "dedupe", "llm", "human_audit"],
    dedupeFields: ["instruction"],
    auditOptions: { partial: 25, full: "100" },
    difficultyLevels: "expert",
    notes: "edit before review",
  };

  it("drops an invented `type` key instead of failing the whole draft", () => {
    const parsed = datasetTypeDraftSchema.parse(base);
    expect(parsed.fields[0]).not.toHaveProperty("type");
  });

  it("maps an unrecognised role to the inert `reference` role", () => {
    expect(datasetTypeDraftSchema.parse(base).fields[1]!.role).toBe("reference");
  });

  it("wraps scalars that should be lists", () => {
    const parsed = datasetTypeDraftSchema.parse(base);
    expect(parsed.notes).toEqual(["edit before review"]);
    expect(parsed.difficultyLevels).toEqual(["advanced"]); // `expert` normalised
  });

  it("turns an auditOptions object into a numeric list", () => {
    expect(datasetTypeDraftSchema.parse(base).auditOptions).toEqual([25, 100]);
  });

  it("still rejects a draft that is wrong in MEANING, not just form", () => {
    // A stage this platform does not run cannot be laundered by coercion.
    expect(
      datasetTypeDraftSchema.safeParse({ ...base, pipeline: ["schema", "dedupe", "contamination"] }).success
    ).toBe(false);
    // Fewer than two fields is a contract, not a formatting, problem.
    expect(datasetTypeDraftSchema.safeParse({ ...base, fields: [base.fields[0]] }).success).toBe(false);
    // A field key that is not lower_snake_case.
    expect(
      datasetTypeDraftSchema.safeParse({
        ...base,
        fields: [{ key: "Instruction", label: "x", role: "instruction" }, base.fields[1]],
      }).success
    ).toBe(false);
  });
});

describe("normalizeDraftDifficultyLevels", () => {
  it("maps expert -> advanced and de-duplicates", () => {
    expect(normalizeDraftDifficultyLevels(["Beginner", "expert", "advanced"])).toEqual(["beginner", "advanced"]);
  });
});

describe("draftCustomDatasetType — provenance honesty", () => {
  it("reports source 'fallback' when the layer fell back", async () => {
    const deterministic = fallbackDraft("Broken loops and their fixes for review.");
    complete.mockResolvedValue({
      data: deterministic,
      provider: "fallback",
      model: "deterministic",
      usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
      fallbackUsed: true,
      failoverUsed: false,
    });
    const { source } = await draftCustomDatasetType("Broken loops and their fixes for review.");
    expect(source).toBe("fallback");
  });

  it("reports source 'llm' only when a live model answered, and passes a callable fallback", async () => {
    const live = fallbackDraft("Broken loops and their fixes for review.");
    complete.mockResolvedValue({
      data: live,
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      usage: { inputTokens: 200, outputTokens: 400, costMicroUsd: 50 },
      fallbackUsed: false,
      failoverUsed: false,
    });
    const { source } = await draftCustomDatasetType("Broken loops and their fixes for review.");
    expect(source).toBe("llm");
    const req = complete.mock.calls[0]![0] as { feature: string; fallback: () => unknown };
    expect(req.feature).toBe("dataset_type_draft");
    expect(integrityOf(req.fallback() as never)).toBeNull();
  });
});
