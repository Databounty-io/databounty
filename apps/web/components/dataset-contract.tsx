"use client";

// SPDX-License-Identifier: Apache-2.0

import { Pill } from "@/components/ui";
import {
  DATASET_TYPE_CATALOG,
  TRUST_TIER_LABELS,
  pipelineWithPlatformStages,
  stageLabel,
  type DatasetType,
} from "@/lib/dataset-types";
import type { DatasetCategory } from "@/lib/types";

const ROLE_LABELS: Record<string, string> = {
  instruction: "prompt / instruction",
  input_context: "given context",
  input_code: "input code",
  solution_code: "answer code",
  tests: "tests",
  expected_output: "expected output",
  rationale: "rationale",
  enum: "choice",
  list: "list",
  reference: "reference",
};

const V1_TYPE_IDS = new Set([
  "debugging",
  "implementation",
  "test_generation",
  "error_diagnosis",
  "migration",
]);

/** One honest, forward-looking line per pipeline stage, for the contributor /
 *  validator "validation preview". This panel is shown BEFORE an item exists,
 *  so every string describes what the stage WILL do — never a stored verdict.
 *
 *  Driven off the platform-augmented pipeline (see `pipelineWithPlatformStages`)
 *  rather than a hand-picked subset, so the preview lists exactly the stages the
 *  badge row above it does — AI attribution and validator audit included —
 *  and can never silently drop one the platform really runs. */
function stagePreviewCopy(stage: string, type: DatasetType): string {
  switch (stage) {
    case "dedupe":
      return `duplicate identity: ${type.verification.dedupeFields.join(" + ") || "schema-defined fields"}`;
    case "ai_attribution":
      return "declared AI / co-author disclosures are recorded for validator review — never guessed from writing style";
    case "execution":
      return type.verification.executionEnv
        ? `runs in an isolated ${type.verification.executionEnv}; an unresolved run routes to a validator instead of passing`
        : "isolated sandbox run; an unresolved run routes to a validator instead of passing";
    case "llm":
      return "quality evidence gate; an unavailable model holds the item for validator audit";
    case "human_audit":
      return "a human validator reviews sampled items and every flagged one, and makes the final call";
    default:
      return "runs as configured by this dataset contract";
  }
}

export function resolveDatasetType({
  datasetTypeId,
  category,
}: {
  datasetTypeId?: string;
  category?: DatasetCategory;
}): DatasetType {
  return (
    DATASET_TYPE_CATALOG.find((t) => datasetTypeId && t.id === datasetTypeId) ??
    DATASET_TYPE_CATALOG.find((t) => category && t.id === category) ??
    DATASET_TYPE_CATALOG.find((t) => category && t.category === category && V1_TYPE_IDS.has(t.id)) ??
    DATASET_TYPE_CATALOG[0]
  );
}

export function DatasetContractPanel({
  type,
  audience,
  className = "",
  llmEnabled = false,
}: {
  type: DatasetType;
  audience: "contributor" | "validator";
  className?: string;
  /** Server-owned `validation.llm.enabled`. This panel is FORWARD-looking — it
   *  tells a contributor which checks their item will run before it exists, so
   *  unlike the submission-detail cards it cannot infer the answer from stored
   *  `llm`-stage evidence rows. Defaults to false so an unreachable API can
   *  never make the panel promise a stage the platform skips. */
  llmEnabled?: boolean;
}) {
  const required = type.fields.filter((f) => f.required);

  return (
    <div className={`card px-5 py-4 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="micro-label text-ink-faint">dataset contract</div>
          <h2 className="mt-1 text-[16px] font-bold text-ink">{type.name}</h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-soft">
            {type.description}
          </p>
        </div>
        <Pill tone={type.trustTier === "execution_verified" ? "success" : "info"}>
          {TRUST_TIER_LABELS[type.trustTier]}
        </Pill>
      </div>

      {/* Platform-augmented so the badge row matches the stages that really
          run (ai_attribution is enforced for every type, including legacy
          contracts whose stored pipeline predates it). */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {pipelineWithPlatformStages(type.verification.pipeline, { llmEnabled }).map((check) => (
          <Pill key={check} tone={check === "execution" ? "success" : check === "llm" ? "info" : "neutral"}>
            {stageLabel(check)}
          </Pill>
        ))}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-line-soft bg-panel px-3 py-3">
          <div className="micro-label mb-2 text-ink-faint">required item fields</div>
          <div className="space-y-2">
            {required.map((field) => (
              <div key={field.key} className="flex items-start justify-between gap-3 text-[12.5px]">
                <span className="font-medium text-ink">{field.label}</span>
                <span className="shrink-0 font-mono text-[11px] text-ink-soft">
                  {ROLE_LABELS[field.role] ?? field.role}
                  {field.lang ? ` · ${field.lang}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-line-soft bg-panel px-3 py-3">
          <div className="micro-label mb-2 text-ink-faint">validation preview</div>
          {/* One row per stage of the platform-augmented pipeline — the SAME
              list as the badge row above (AI attribution and validator audit
              included), not a hand-picked three. Passing
              `llmEnabled` drops the `llm` stage when the platform switch is
              off, so a disabled stage is never described here as if it will
              run. */}
          <div className="space-y-2 text-[12.5px] leading-snug text-ink-soft">
            {pipelineWithPlatformStages(type.verification.pipeline, { llmEnabled }).map((stage) => (
              <p key={stage}>
                <span className="font-mono font-medium text-ink">{stageLabel(stage)}</span>
                {" — "}
                {stagePreviewCopy(stage, type)}
              </p>
            ))}
          </div>
        </div>
      </div>

      {/* Contributor-facing note dropped as redundant: the required fields and
          the full validation preview above already say what to submit and how
          it's checked. The validator note stays — it carries the one thing not
          shown elsewhere: the approve/reject decision IS the audit record. */}
      {audience === "validator" && (
        <div className="mt-3 rounded-lg border border-line-soft bg-white px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-soft">
          Review the submitted fields against this contract, machine-check
          evidence, and sponsor guidance. LLM output is evidence only; your
          approve/reject decision is the validator-audit record.
        </div>
      )}
    </div>
  );
}
