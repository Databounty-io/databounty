"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import {
  Button,
  CodeBlock,
  CopyButton,
  DetailHeader,
  Empty,
  InfoTip,
  Pill,
  SubmissionStatusPill,
} from "@/components/ui";
import { FLAG_REASON_LABELS, GENERATION_LABELS, humanizeKey, num } from "@/lib/format";
import {
  disputeSubmissionReal,
  getBatchContract,
  getPoolContract,
  getSubmission,
  normalizeValidationStage,
  reviseSubmissionReal,
  rerunSubmissionValidationReal,
  submissionDisplayFromApi,
  validationStageState,
  VALIDATION_STAGE_STATE_LABEL,
  type ApiSubmissionDetail,
  type ApiValidationResult,
} from "@/lib/api-work";
import { ArtifactList } from "@/components/artifacts";
import { AutoRefreshControl } from "@/components/auto-refresh";
import { LlmReviewCard } from "@/components/llm-review-card";
import { AiAttributionEvidenceCard, DedupeEvidenceCard, ExecutionProviderStrip, LlmEvidenceCard, ModalityCheckCard } from "@/components/stage-evidence-cards";
import { SubmissionAuditHistoryDrawer } from "@/components/sponsor-submission-detail";
import { fieldRows, payloadFromValues, requiredMissing, stringValue, valuesFromPayload } from "@/components/dynamic-item-fields";
import { getArtifactProcessingEvents, type ApiArtifact, type ArtifactProcessingEventsResponse } from "@/lib/api-artifacts";
import type { DatasetType } from "@/lib/dataset-types";
import type { Submission, SubmissionStatus } from "@/lib/types";
import { useDemo } from "@/lib/store";

// Only ever mounted once the contributor opens the revision editor, so keep
// it out of this route's initial chunk rather than loading it for everyone
// who just views a submission.
const DynamicFieldsEditor = dynamic(
  () => import("@/components/dynamic-item-fields").then((m) => m.DynamicFieldsEditor),
  { ssr: false },
);

const ACTIVE_POLL_STATUSES: SubmissionStatus[] = [
  "submitted",
  "duplicate_check",
  "running_tests",
  "llm_validation",
  "provisionally_accepted",
  "in_audit",
];
const ACTIVE_VALIDATION_REFRESH_SECONDS = 15;

type StageState = "done" | "current" | "pending" | "blocked" | "failed" | "warn" | "skipped";
type StageKey =
  | "submitted"
  | "dedupe"
  | "ai_attribution"
  | "execution"
  | "llm"
  | "human_audit"
  | "final"
  | "karma";

/**
 * Community validation timeline ending on this item's karma milestone.
 *
 * The terminal row is labelled "Karma" — NOT "Karma released" (F-008). Karma
 * for an accepted community item goes through
 * `awardOrHoldAcceptedItemKarma` (api/src/services/karma-holds.ts), which
 * HOLDS the award as a `PendingKarmaAward` row until the sponsor's dispute
 * window closes. `GET /v1/submissions/:id` does not report that hold state at
 * all (see `stageView("karma")`), so a static "Karma released" label asserted
 * an outcome this page cannot know and which, on every held item, had not
 * happened. The word "released" is now only ever printed when the API says
 * `karma.state === "released"`.
 *
 * "schema" stays out on purpose: `admin-dataset-types.ts` requires every
 * dataset type's stored `verification.pipeline` config to literally start
 * with `["schema", "dedupe", ...]`, but that is a config-shape rule only —
 * `services/validation.ts` never emits a `ValidationResult` row with
 * stage `"schema"` (its real stages are `duplicate_check`/`ai_attribution`/
 * `execution`/`llm`/`human_audit`/`pool_capacity`). Showing "schema" here
 * would leave it permanently "pending / blocked" since nothing ever resolves
 * it — the same failure a removed external-corpus stage would cause (there is
 * no corpus wired here, and `services/validation.ts` never produces it).
 */
function pipelineStages(): Array<{ key: StageKey; label: string }> {
  return [
    { key: "submitted", label: "Submitted" },
    { key: "dedupe", label: "Duplicate check" },
    { key: "ai_attribution", label: "Automated AI attribution" },
    { key: "execution", label: "Sandboxing" },
    { key: "llm", label: "LLM review" },
    { key: "human_audit", label: "Validator audit" },
    { key: "final", label: "Final decision" },
    { key: "karma", label: "Karma" },
  ];
}

/**
 * FIRST-wins, not last. Every API include that ships `validationResults`
 * orders them `createdAt: "desc"`, so `results[0]` is the NEWEST row for a
 * stage — the old last-wins `set()` therefore kept the OLDEST result per
 * stage, which is visible on any revised/re-validated item as an earlier
 * failure overriding the later corrected result. If the API ever switches to
 * ascending order, this has to flip back to last-wins.
 */
function latestStageResults(results: ApiValidationResult[]): Map<string, ApiValidationResult> {
  const latest = new Map<string, ApiValidationResult>();
  for (const result of results) {
    const stage = normalizeValidationStage(result.stage);
    if (!latest.has(stage)) latest.set(stage, result);
  }
  return latest;
}

/**
 * The machine stages whose verdict can actually GATE this item, and the test
 * for one having gated it. Both go through `validationStageState` rather than
 * re-deriving `!passed && score != null`:
 *
 *   - `review_fail` (a failing `llm` verdict) is deliberately NOT a gating
 *     failure. services/validation.ts states an LLM verdict "never changes the
 *     accept/reject OUTCOME" — counting it made a rejected item claim its
 *     validator audit was "Not reached", and picked the issue title off a
 *     verdict that gated nothing.
 *   - `hold` is not one either: nothing ran.
 *   - `flagged` IS one: a dedupe `review_required` / AI-attribution flag is a
 *     real escalation the validator has to resolve.
 *
 * `normalizeValidationStage` is essential here: `result.stage` is the RAW
 * backend column, so a dedupe row arrives as "duplicate_check" and never
 * matched the display-vocabulary `"dedupe"` this list is written in — which is
 * why a genuine duplicate rejection never got its own issue title.
 */
const GATING_MACHINE_STAGES = ["dedupe", "ai_attribution", "execution", "llm"];

function isGatingMachineFailure(result: ApiValidationResult): boolean {
  if (!GATING_MACHINE_STAGES.includes(normalizeValidationStage(result.stage))) return false;
  const state = validationStageState(result);
  return state === "failed" || state === "flagged";
}

/**
 * Which stages this dataset type actually runs — the same set the pipeline
 * list is built from, so a stage the pipeline reports as "Not configured for
 * this dataset type" can never also appear as a bare "—" score elsewhere on
 * the page. Falls back to the stages that produced evidence while the
 * contract is still loading, rather than assuming a stage ran.
 */
function configuredStageSet(
  datasetType: DatasetType | null | undefined,
  validationResults: ApiValidationResult[],
): Set<string> {
  // Normalized: `verification.pipeline` is written in the display vocabulary
  // ("dedupe"), so the evidence-derived fallback has to be too — otherwise a
  // raw "duplicate_check" row makes `has("dedupe")` false and the dedupe
  // signal/score row disappears for as long as the contract is loading.
  return new Set(
    datasetType?.verification.pipeline ?? validationResults.map((result) => normalizeValidationStage(result.stage)),
  );
}

/** Artifact ids held by one file-role field. Multi-file fields serialize their
 *  ids as a JSON array string; single-file fields store the bare id. Mirrors
 *  parseFileIds in components/dynamic-item-fields.tsx. */
function fileIdsFromValue(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // not JSON — a single bare artifact id
  }
  return [raw];
}

/**
 * Why a stage the shared decoder classified `hold` has not produced a verdict.
 * This does NOT classify — `validationStageState` does, and `stageView` only
 * calls this for a `hold` row.
 *
 * The old `if (result.score != null) return "Failed"` line lived here. It was
 * already unreachable (its one caller sat inside a `score == null` branch) AND
 * it was the wrong rule — exactly the overloaded-sentinel read the shared
 * decoder exists to replace, since a failing `llm` verdict and a dedupe
 * `review_required` both carry a score without being terminal failures. It is
 * removed rather than corrected: classification belongs to the decoder, and
 * this function only names the reason a held stage is held.
 */
function shortStageNote(result: ApiValidationResult): string {
  const decision = result.detailJson?.duplicateDecision ?? result.detailJson?.decision;
  if (decision === "review_required" || decision === "flag") return "Needs validator review";
  if (normalizeValidationStage(result.stage) === "ai_attribution" && result.detailJson?.status === "flagged") {
    return "Needs validator review";
  }
  if (result.passed) return "Passed";
  const status = result.detailJson?.status;
  if (status === "not_attempted") return "Not attempted";
  if (status === "requires_configured_corpus" || status === "requires_healthy_corpus") return "Configuration missing";
  if (status === "no_provider_configured") return "Sandbox not configured";
  if (status === "no_executable_harness") return "No harness for this type";
  if (status === "all_providers_failed") return "Sandbox unavailable";
  // `pending_llm_review` is written by the LLM stage's else-branch in the
  // API's services/validation.ts with outcome `no_provider_configured` — it
  // means no reviewer EXISTS in this environment, not that one is on its way.
  // "Awaiting model review" read as in-progress for a check that will never
  // run on this item.
  if (status === "pending_llm_review") return "No reviewer configured";
  if (status === "queued") return "Queued";
  if (status === "awaiting_pool_close_sample" || status === "deferred_pending_pool_close_out") {
    return "Waiting for pool close";
  }
  return "Pending / blocked";
}

function detailedStageNote(result: ApiValidationResult): string {
  const detail = result.detailJson ?? {};
  const missing = Array.isArray(detail.missingRequiredFields)
    ? detail.missingRequiredFields.join(", ")
    : "";
  const reason = typeof detail.reason === "string" ? detail.reason : "";
  // Only ever resolves a real validation stage (dedupe/ai_attribution/…),
  // never the terminal reward step, so the track passed here is immaterial.
  // Normalized first: `pipelineStages()` keys are the display vocabulary, so
  // looking up the RAW stage made a `duplicate_check` row print the raw string
  // "duplicate_check" instead of "Duplicate check". `pool_capacity` has no
  // pipeline row at all and falls through to the shared humanizer.
  const stageKey = normalizeValidationStage(result.stage);
  const label = pipelineStages().find((stage) => stage.key === stageKey)?.label ?? humanizeKey(stageKey);
  // Shared decoder, never a re-derived `!passed && score != null`. That read
  // printed "LLM review: failed" for an advisory verdict that gates nothing,
  // printed "Duplicate check: failed" for a `review_required` escalation
  // (the interception `shortStageNote` had was missing here), and printed a
  // terminal `pool_capacity` rejection as "pending / blocked".
  const outcome = VALIDATION_STAGE_STATE_LABEL[validationStageState(result)];
  const suffix = missing ? " — missing: " + missing : reason ? " — " + reason : "";
  return label + ": " + outcome + suffix;
}

function stageEvidence(result: ApiValidationResult): string | null {
  const detail = result.detailJson ?? {};
  const reason = typeof detail.reason === "string" ? detail.reason : "";
  const decision = detail.duplicateDecision ?? detail.decision;
  if (decision === "review_required") {
    const score = typeof result.score === "number" ? ` Similarity: ${Math.round(result.score * 100)}%.` : "";
    return `This item is similar to another submission and must be reviewed by a validator.${score}`;
  }
  if (decision === "flag") {
    const score = typeof result.score === "number" ? ` Similarity: ${Math.round(result.score * 100)}%.` : "";
    return `This item needs review because it is similar to a protected reference.${score}`;
  }
  if (reason) return reason;
  if (result.passed) return "Completed using this dataset type's configured validation profile.";
  return null;
}

function activeStageForStatus(status: SubmissionStatus): StageKey | null {
  if (status === "draft" || status === "submitted") return "dedupe";
  if (status === "duplicate_check") return "dedupe";
  if (status === "running_tests" || status === "tests_failed") return "execution";
  if (status === "llm_validation" || status === "needs_fixes") return "llm";
  if (["provisionally_accepted", "in_audit", "flagged", "disputed"].includes(status)) return "human_audit";
  return null;
}

/** A single pipeline dot in the mockup's style: 18px round badge. */
function StageDot({ state }: { state: StageState }) {
  if (state === "done") {
    return (
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-success-soft">
        <Icon name="check" size={10} strokeWidth={3.5} className="text-success" />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-danger-soft">
        <Icon name="x" size={10} strokeWidth={3} className="text-danger-strong" />
      </span>
    );
  }
  if (state === "warn") {
    return (
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#fbf3e0]">
        <Icon name="alert" size={10} strokeWidth={2.6} className="text-warn-strong" />
      </span>
    );
  }
  if (state === "blocked") {
    return (
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#fbf3e0]">
        <Icon name="clock" size={10} strokeWidth={2.5} className="text-[#9a6b00]" />
      </span>
    );
  }
  if (state === "skipped") {
    return (
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-canvas">
        <Icon name="x" size={10} strokeWidth={2.5} className="text-ink-faint" />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className="pulse-soft flex h-[18px] w-[18px] items-center justify-center rounded-full bg-ink">
        <span className="h-2 w-2 rounded-full bg-lime" />
      </span>
    );
  }
  // pending
  return <span className="h-[18px] w-[18px] rounded-full bg-line-soft" />;
}

function pipelineTextClass(state: StageState, accepted: boolean): string {
  if (state === "pending") return "text-ink-faint";
  if (state === "skipped") return "text-ink-soft";
  if (state === "failed") return "font-bold text-danger-strong";
  if (state === "warn" || state === "blocked") return "font-bold text-warn-strong";
  if (state === "current" || accepted) return "font-bold text-ink";
  return "text-ink";
}

function Pipeline({
  status,
  validationResults,
  auditItems,
  datasetType,
  llmEnabled,
  karma,
}: {
  status: SubmissionStatus;
  validationResults: ApiValidationResult[];
  auditItems?: Array<{ verdict: string | null; decidedAt: string | null }>;
  datasetType?: DatasetType | null;
  /** The platform's `validation.llm.enabled` exactly as the server reported
   *  it. `undefined` means it was NOT reported — never "on". */
  llmEnabled?: boolean;
  karma?: ApiSubmissionDetail["karma"];
}) {
  const latest = latestStageResults(validationResults);
  const activeStage = activeStageForStatus(status);
  // Normalized fallback, same reason as configuredStageSet above: a raw
  // "duplicate_check" row would otherwise leave "dedupe" out of the set.
  const configuredStages = new Set(
    datasetType?.verification.pipeline ?? validationResults.map((result) => normalizeValidationStage(result.stage)),
  );
  configuredStages.add("ai_attribution");
  const validatorDecided = (auditItems ?? []).some((item) => item.decidedAt != null);
  // `latest` is already keyed by normalized stage, so these lookups hit.
  const hasMachineFailure = GATING_MACHINE_STAGES.some((stage) => {
    const result = latest.get(stage);
    return Boolean(result && isGatingMachineFailure(result));
  });
  const failedMachineStageIndex = GATING_MACHINE_STAGES.findIndex((stage) => {
    const result = latest.get(stage);
    return Boolean(result && isGatingMachineFailure(result));
  });

  const stageView = (key: StageKey): { state: StageState; note?: string; label?: string; evidence?: string | null } => {
    if (key === "submitted") return { state: "done" };
    if (key === "final") {
      if (status === "accepted") return { state: "done", label: "Accepted" };
      if (status === "rejected") return { state: "failed", note: "Rejected", label: "Rejected" };
      if (["tests_failed", "needs_fixes", "flagged"].includes(status)) {
        return { state: "warn", note: "Action required", label: "Action required" };
      }
      if (status === "disputed") return { state: "warn", note: "Platform review", label: "Under review" };
      return { state: "pending" };
    }

    const result = latest.get(key);
    if (key !== "karma" && key !== "dedupe" && !configuredStages.has(key) && !result) {
      return { state: "blocked", note: "Not configured for this dataset type" };
    }
    if (key === "dedupe" && result?.detailJson?.duplicateDecision === "review_required") {
      return { state: "warn", note: "Needs validator review", evidence: stageEvidence(result) };
    }
    if (key === "ai_attribution" && result && !result.passed) {
      return { state: "warn", note: "Explicit attribution found — validator review", evidence: stageEvidence(result) };
    }
    // No LLM evidence recorded. Which of the three honest cases this is
    // depends entirely on the flag AS REPORTED — a bare grey `pending` dot for
    // a stage that will never run was the defect. (A stage missing from this
    // dataset type's pipeline is already handled above, and that message is
    // the more specific one, so this deliberately sits after it.)
    if (key === "llm" && !result) {
      if (llmEnabled === false) {
        return {
          state: "blocked",
          note: "Switched off — not run",
          evidence:
            "LLM quality review is switched off for this platform, so no model reviewed this item. It is not LLM-verified.",
        };
      }
      if (llmEnabled === undefined) {
        return {
          state: "blocked",
          note: "Enabled state not reported",
          evidence:
            "This page was not told whether the platform's LLM review stage is switched on, so it cannot say whether this check will run. No LLM review is recorded for this item, and it is not LLM-verified.",
        };
      }
      // Reported ON: "running now" / "not reached yet" are then truthful, and
      // fall through to the shared handling below.
    }
    if (key === "human_audit") {
      if (status === "disputed") {
        return { state: "warn", note: "Paused for platform review" };
      }
      if (status === "accepted_pending_sample") {
        return {
          state: "blocked",
          note: "Awaiting next audit window",
          evidence:
            "Passed automated checks. When the pool closes, a sample of accepted items (and every flagged item) is sent to a validator.",
        };
      }
      if (status === "accepted") {
        return validatorDecided
          ? { state: "done", note: "Approved" }
          : { state: "done", note: "Not required — auto-accepted" };
      }
      if (status === "in_audit" || status === "provisionally_accepted") return { state: "current", note: "Queued" };
      if (status === "flagged") return { state: "warn", note: "Needs review" };
      if (status === "rejected") {
        return hasMachineFailure
          ? { state: "skipped", note: "Not reached" }
          : { state: "failed", note: "Rejected by validator" };
      }
    }
    // Terminal step: community karma.
    //
    // F-008. Only the API may say the word "released". `karma` is the
    // server-resolved position for THIS item; when it is present the label
    // states the real milestone and the note/evidence come from the server.
    //
    // When it is ABSENT the page knows nothing: this build's
    // `GET /v1/submissions/:id` (api/src/routes/v1/submissions.ts) returns the
    // raw submission row plus `llmValidationEnabled`/`llmProviderConfigured`
    // and NOTHING about `PendingKarmaAward`, so an accepted item whose karma
    // is held is indistinguishable here from one already credited. Saying
    // "Karma released" in that case is the same class of defect as a grey
    // `pending` dot on a stage that will never run, and it is handled the same
    // way as the `llmEnabled === undefined` branch above: state the gap.
    // Closing it needs the API to send a `karma` object — v1's route builds one
    // with `getSubmissionKarmaState` (v1 api/src/services/karma-holds.ts), which
    // this build's karma-holds.ts does not export.
    if (key === "karma") {
      if (karma?.state === "released") {
        return { state: "done", note: "In your balance", label: "Karma released", evidence: karma.explanation };
      }
      if (karma?.state === "secured") {
        return { state: "current", note: "Held", label: "Karma held", evidence: karma.explanation };
      }
      if (karma?.state === "projected") {
        return { state: "pending", note: undefined, evidence: karma.explanation };
      }
      if (karma?.state === "none") {
        return { state: "pending", note: undefined, evidence: karma.explanation };
      }
      if (status === "accepted") {
        return {
          state: "blocked",
          note: "Release not reported",
          evidence:
            "This item was accepted. Accepted-item karma can be held until the sponsor's dispute window closes before it is credited to your balance, and this page was not told whether that has happened for this item — so it cannot say the karma is released. Your karma balance is the authority.",
        };
      }
      if (status === "rejected") return { state: "skipped", note: "Not awarded" };
      return { state: "pending" };
    }
    if (result) {
      // Shared decoder — never a re-derived `!passed && score != null`. That
      // read gave an `llm` `llm_fail` row a red X dot and a bold danger-red
      // "Failed" on the "LLM review" line for a verdict that gates nothing,
      // and read a terminal `pool_capacity` rejection (`score: null`) as
      // "pending / blocked". `dedupe review_required` and a flagged
      // `ai_attribution` are still intercepted further up with their own,
      // more specific notes; the `flagged` branch here is the general case.
      const state = validationStageState(result);
      const evidence = stageEvidence(result);
      if (state === "passed") return { state: "done", note: "Passed", evidence };
      if (state === "hold") return { state: "blocked", note: shortStageNote(result), evidence };
      if (state === "flagged") return { state: "warn", note: "Needs validator review", evidence };
      // Non-terminal: the advisory verdict really did fail, but it did not
      // reject the item, so it gets the warn presentation rather than the
      // failed dot plus danger-red "Failed" a terminal rejection gets.
      if (state === "review_fail") {
        return { state: "warn", note: VALIDATION_STAGE_STATE_LABEL.review_fail, evidence };
      }
      return { state: "failed", note: "Failed", evidence };
    }
    // A terminal automated failure prevents only LATER automated checks from
    // running. Render those rows with a muted cross, not an empty/pending dot:
    // no verdict exists because the pipeline deliberately stopped, not because
    // the page lost its state.
    const machineStageIndex = GATING_MACHINE_STAGES.indexOf(key);
    if (status === "rejected" && machineStageIndex > failedMachineStageIndex && failedMachineStageIndex >= 0) {
      return { state: "skipped", note: "Not reached" };
    }
    if (activeStage === key) return { state: "current", note: "Running now…" };
    return { state: "pending" };
  };

  return (
    <div className="flex flex-col gap-0.5 font-mono text-[12.5px]">
      {/* Deviation from the trust-honesty fix described below, requested
          explicitly 2026-09-03: when LLM review is switched off platform-wide,
          the row is hidden again rather than shown via stageView("llm")'s
          "Switched off — not run" honesty state. This is exactly the previous
          behavior the comment two lines down says was a defect — see
          the parity decision register for the flagged deviation. Every other stage, and
          every OTHER off-but-absent LLM case (enabled-but-no-evidence,
          enabled-state-not-reported), is still shown honestly; only the
          administrator-disabled case is now silent.

          Original comment, kept for context: "Every configured stage is
          listed, the LLM row included. It used to be filtered out whenever
          the (defaulted) enabled flag was false, so a switched-off check
          rendered as nothing at all — the same 'reads as fine' failure as a
          grey `pending` dot. `stageView("llm")` states the three honest cases
          instead." */}
      {pipelineStages()
        .filter((stage) => !(stage.key === "llm" && llmEnabled === false))
        .map((stage) => {
        const view = stageView(stage.key);
        const accepted = stage.key === "final" && view.state === "done";
        return (
          <div key={stage.key} className="flex items-center gap-[11px] py-1.5">
            <div className="shrink-0">
              {accepted ? (
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-ink">
                  <Icon name="check" size={10} strokeWidth={3.5} className="text-lime" />
                </span>
              ) : (
                <StageDot state={view.state} />
              )}
            </div>
            <div className="min-w-0">
              <span className={pipelineTextClass(view.state, accepted)}>
                {view.label ?? stage.label}
              </span>
              {view.note && (
                <span
                  className={
                    view.state === "failed"
                      ? "ml-2 text-[11px] text-danger-strong"
                      : view.state === "done"
                        ? "ml-2 text-[11px] text-success"
                        : "ml-2 text-[11px] text-[#9a6b00]"
                  }
                >
                  {view.note}
                </span>
              )}
              {view.evidence && (
                <p className="mt-1 max-w-[240px] text-[10.5px] leading-relaxed text-ink-soft">
                  {view.evidence}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** What this item's karma actually is right now. */
const KARMA_STATE_LABEL: Record<"released" | "secured" | "projected" | "none", string> = {
  released: "karma earned",
  secured: "karma secured",
  projected: "karma if accepted",
  none: "karma",
};

const KARMA_STATE_TONE: Record<"released" | "secured" | "projected" | "none", string> = {
  released: "text-accent-strong",
  secured: "text-karma",
  // An estimate must not look like the two real states beside it.
  projected: "text-ink-soft",
  none: "text-ink-faint",
};

export default function SubmissionDetailPage() {
  const params = useParams<{ id: string }>();
  const { pushToast } = useDemo();
  // Evidence pages fail closed: only the real API submission may render.
  const [apiSub, setApiSub] = useState<Submission | null>(null);
  const [revisionAccess, setRevisionAccess] = useState<{ actionable: boolean; remaining: number; reason: string | null } | null>(null);
  // This item's karma position (community work). See services/karma-holds.ts
  const [itemKarma, setItemKarma] = useState<ApiSubmissionDetail["karma"]>(null);
  const [rawPayload, setRawPayload] = useState<Record<string, unknown> | null>(null);
  const [datasetType, setDatasetType] = useState<DatasetType | null>(null);
  const [attachments, setAttachments] = useState<ApiArtifact[]>([]);
  // undefined = not fetched yet (render as loading); null = fetch failed
  // (render as "status unknown"); present = the real per-stage evidence.
  const [modalityEvents, setModalityEvents] = useState<Record<string, ArtifactProcessingEventsResponse | null | undefined>>({});
  const [validationResults, setValidationResults] = useState<ApiValidationResult[]>([]);
  // The platform's `validation.llm.enabled` EXACTLY as the server reported it:
  // `undefined` means this page was never told. It is the ONLY source of truth
  // for the flag on this page. There used to be a second, defaulted
  // `llmValidationEnabled` state seeded `useState(true)` and refreshed with
  // `real.llmValidationEnabled !== false` — and because this API does not send
  // the field on a submission at all, `undefined !== false` made it `true`:
  // the page silently claimed "LLM review is on" when it had no idea, and the
  // pipeline strip then drew an "LLM review" row in a bare grey `pending`
  // state for a stage that may never run. Unknown must stay a real third
  // state, both before and after the API starts sending the field.
  const [llmFlagReported, setLlmFlagReported] = useState<boolean | undefined>(undefined);
  const [auditItems, setAuditItems] = useState<ApiSubmissionDetail["auditItems"]>([]);
  const [revisions, setRevisions] = useState<NonNullable<ApiSubmissionDetail["revisions"]>>([]);
  const [flags, setFlags] = useState<NonNullable<ApiSubmissionDetail["flags"]>>([]);
  const [disputes, setDisputes] = useState<NonNullable<ApiSubmissionDetail["disputes"]>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionValues, setRevisionValues] = useState<Record<string, string>>({});
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [revisionSaving, setRevisionSaving] = useState(false);
  const [rerunSaving, setRerunSaving] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeText, setDisputeText] = useState("");
  const [disputeError, setDisputeError] = useState<string | null>(null);
  const [disputeSaving, setDisputeSaving] = useState(false);
  // Synchronous locks — `revisionSaving`/`disputeSaving` are state and only
  // block the next render, so a double-click fires two requests. Revisions are
  // a capped resource (a duplicate burns an attempt) and a duplicate dispute
  // creates a second record the UI never shows. These refs flip immediately.
  const revisionLockRef = useRef(false);
  const rerunLockRef = useRef(false);
  const disputeLockRef = useRef(false);

  const refreshSubmission = useCallback(async (initial = false) => {
    if (initial) {
      setLoading(true);
      setLoadError(null);
    } else {
      setRefreshing(true);
      setRefreshError(null);
    }
    try {
      const real = await getSubmission(params.id);
      if (!real) throw new Error("This submission could not be found in your account.");
      setApiSub(submissionDisplayFromApi(real));
      setRevisionAccess({ actionable: real.actionable ?? false, remaining: real.revisionsRemaining ?? 0, reason: real.notActionableReason ?? null });
      setItemKarma(real.karma ?? null);
      setRawPayload(real.payloadJson ?? {});
      setAttachments(real.attachments ?? []);
      setValidationResults(real.validationResults ?? []);
      setLlmFlagReported(typeof real.llmValidationEnabled === "boolean" ? real.llmValidationEnabled : undefined);
      setAuditItems(real.auditItems ?? []);
      setRevisions(real.revisions ?? []);
      setFlags(real.flags ?? []);
      setDisputes(real.disputes ?? []);
      if (real.contributorBatchId) {
        const contract = await getBatchContract(real.contributorBatchId);
        setDatasetType(contract?.datasetType ?? null);
      } else {
        // Community open-pool submissions intentionally have no ContributorBatch.
        // Their contract belongs to the pool/bounty, so loading it only through
        // getBatchContract left Item content in a permanent loading state even
        // when the API had already returned the contributor's payload.
        const contract = await getPoolContract(real.bountyId);
        setDatasetType(contract?.datasetType ?? null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load this submission. Please try again.";
      if (initial) setLoadError(message);
      else setRefreshError(message);
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }, [params.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSubmission(true), 0);
    return () => window.clearTimeout(timer);
  }, [refreshSubmission]);

  // Modality checks only apply to items with a file-role field — text/code
  // only submissions have nothing for the format-registry pipeline to check.
  const hasFileField = Boolean(datasetType && fieldRows(datasetType).some((f) => f.role === "file"));
  useEffect(() => {
    if (!hasFileField || attachments.length === 0) return;
    let alive = true;
    Promise.all(
      attachments.map(async (artifact) => [artifact.id, await getArtifactProcessingEvents(artifact.id)] as const),
    ).then((entries) => {
      if (!alive) return;
      setModalityEvents(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
    // attachments is a fresh array each refresh; keying on the id list keeps
    // this from refetching every time an unrelated field on the submission changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFileField, attachments.map((a) => a.id).join(",")]);

  const activeStatus = apiSub?.status;
  const isSubmissionActive = !!activeStatus && ACTIVE_POLL_STATUSES.includes(activeStatus);

  const submission = apiSub;

  if (loading && !submission) {
    return (
      <>
        <PageHeader title="Submission" />
        <Empty>Loading submission…</Empty>
      </>
    );
  }

  if (!submission) {
    return (
      <>
        <PageHeader title="Submission" />
        <Empty
          icon="alert"
          title={loadError ? "Could not load submission" : "Submission not found"}
          description={loadError ?? "This submission does not exist in your account."}
          action={
            loadError ? (
              <Button variant="secondary" onClick={() => void refreshSubmission(true)}>
                <Icon name="refresh" size={14} />
                Try again
              </Button>
            ) : (
              <Link
                href="/contributor"
                className="inline-flex items-center gap-1.5 font-mono text-sm font-medium text-ink hover:underline"
              >
                Back to Contributor dashboard
                <Icon name="arrow-right" size={14} />
              </Link>
            )
          }
        />
      </>
    );
  }

  const sub = submission;
  const openFlags = sub.flags.filter(
    (f) => f.status === "open"
  );
  const showFlags =
    sub.flags.length > 0 &&
    (sub.status === "flagged" || sub.status === "needs_fixes" || sub.status === "disputed");
  const accepted = sub.status === "accepted";
  const configuredStages = configuredStageSet(datasetType, validationResults);
  const showDedupeSignal = configuredStages.has("dedupe");
  // Shown when the stage is part of this dataset type's pipeline AND either
  // the flag is not a reported `false`, or a real score exists anyway (the
  // flag can be flipped off after an item was already reviewed). The score
  // cell itself renders "—" when nothing scored, and the pipeline strip above
  // says which honest case that is.
  const showLlmSignal =
    configuredStages.has("llm") && (llmFlagReported !== false || sub.llmScore != null);
  const canRevise = revisionAccess?.actionable ?? false;
  const canDispute = sub.status !== "disputed" && openFlags.length > 0;
  const latestValidation = [...latestStageResults(validationResults).values()];
  const failedMachineStages = latestValidation.filter(isGatingMachineFailure);
  const canRerunValidation = ["tests_failed", "needs_fixes", "rejected"].includes(sub.status) && failedMachineStages.length > 0;
  // Normalized, so `failedStage === "dedupe"` below can actually be true: the
  // row's own `stage` is still the raw "duplicate_check", which is why a
  // genuine duplicate rejection never got its "Duplicate check rejected this
  // item" title or its follow-up explanation.
  const firstFailedMachineStage = failedMachineStages[0];
  const failedStage = firstFailedMachineStage
    ? normalizeValidationStage(firstFailedMachineStage.stage)
    : undefined;
  const validationIssueNotes = latestValidation
    .filter((result) => {
      const state = validationStageState(result);
      // A passed stage is not an issue, and neither is a `hold`: a stage that
      // never ran (queued, no provider configured, deferred to pool close) is
      // nothing the contributor can fix, and the naive `!passed` filter listed
      // every one of them here as "pending / blocked". `pool_capacity` looks
      // like a hold to that filter (`score: null`) but the shared decoder
      // classifies it `failed` — it stays, because it IS the rejection.
      if (state === "passed" || state === "hold") return false;
      // A validator's own rejection is already explained by the machine
      // failure listed above it; don't repeat the human_audit row.
      return !(
        sub.status === "rejected" &&
        normalizeValidationStage(result.stage) === "human_audit" &&
        failedMachineStages.length > 0
      );
    })
    .map(detailedStageNote);
  const displayedReviewNotes =
    validationIssueNotes.length > 0 ? validationIssueNotes : sub.reviewNotes ?? [];
  const issueTitle =
    sub.status === "tests_failed"
      ? "Execution check failed"
      : failedStage === "dedupe"
        ? "Duplicate check rejected this item"
        : failedStage === "ai_attribution"
          ? "AI attribution requires validator review"
          : sub.status === "rejected"
            ? "This item was rejected"
            : "Fixes required";

  const openRevisionEditor = () => {
    setRevisionError(null);
    setRevisionValues(datasetType ? valuesFromPayload(datasetType, rawPayload) : {});
    setRevisionOpen(true);
  };

  const revisionPayload = datasetType ? payloadFromValues(datasetType, revisionValues) : null;
  const revisionMissing = datasetType && revisionPayload ? requiredMissing(datasetType, revisionPayload) : [];

  const saveRevision = async () => {
    if (!apiSub || !rawPayload) return;
    let payload: Record<string, unknown>;
    if (datasetType && revisionPayload) {
      if (revisionMissing.length > 0) {
        setRevisionError(`Missing required field${revisionMissing.length > 1 ? "s" : ""}: ${revisionMissing.join(", ")}`);
        return;
      }
      payload = revisionPayload;
    } else {
      setRevisionError("This item's dataset type could not be loaded. Please try again.");
      return;
    }
    if (revisionLockRef.current) return;
    revisionLockRef.current = true;
    setRevisionSaving(true);
    setRevisionError(null);
    try {
      const updated = await reviseSubmissionReal({ submissionId: apiSub.id, payload, generationMethod: apiSub.generationMethod });
      setApiSub(submissionDisplayFromApi(updated));
      setRevisionAccess({ actionable: false, remaining: Math.max(0, (revisionAccess?.remaining ?? 1) - 1), reason: revisionAccess?.reason ?? null });
      setRawPayload(updated.payloadJson ?? payload);
      setValidationResults(updated.validationResults ?? []);
      setAuditItems(updated.auditItems ?? []);
      setRevisions(updated.revisions ?? []);
      setFlags(updated.flags ?? []);
      setRevisionOpen(false);
      pushToast({ variant: "success", title: "Item resubmitted", body: "It's back in the validation pipeline." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not resubmit this item";
      setRevisionError(message);
      pushToast({ variant: "error", title: "Couldn't resubmit item", body: message });
    } finally {
      setRevisionSaving(false);
      revisionLockRef.current = false;
    }
  };

  const rerunValidation = async () => {
    if (!apiSub || rerunLockRef.current) return;
    rerunLockRef.current = true;
    setRerunSaving(true);
    try {
      const updated = await rerunSubmissionValidationReal(apiSub.id);
      setApiSub(submissionDisplayFromApi(updated));
      setValidationResults(updated.validationResults ?? []);
      setAuditItems(updated.auditItems ?? []);
      setFlags(updated.flags ?? []);
      pushToast({ variant: "success", title: "Validation rerun queued", body: "The unchanged item is back in the automated validation pipeline." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not rerun validation";
      pushToast({ variant: "error", title: "Couldn't rerun validation", body: message });
    } finally {
      setRerunSaving(false);
      rerunLockRef.current = false;
    }
  };

  const submitDispute = async () => {
    if (!apiSub || !disputeText.trim()) {
      setDisputeError("Explain why the validator decision is incorrect.");
      return;
    }
    if (disputeLockRef.current) return;
    disputeLockRef.current = true;
    setDisputeSaving(true);
    setDisputeError(null);
    try {
      await disputeSubmissionReal(apiSub.id, disputeText.trim());
      const updated = await getSubmission(apiSub.id);
      if (updated) {
        setApiSub(submissionDisplayFromApi(updated));
        setRevisionAccess({ actionable: updated.actionable ?? false, remaining: updated.revisionsRemaining ?? 0, reason: updated.notActionableReason ?? null });
        setItemKarma(updated.karma ?? null);
        setValidationResults(updated.validationResults ?? []);
        setAuditItems(updated.auditItems ?? []);
        setRevisions(updated.revisions ?? []);
        setFlags(updated.flags ?? []);
      }
      setDisputeOpen(false);
      pushToast({ variant: "success", title: "Dispute submitted", body: "An admin will review the validator decision." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open a dispute";
      setDisputeError(message);
      pushToast({ variant: "error", title: "Couldn't submit dispute", body: message });
    } finally {
      setDisputeSaving(false);
      disputeLockRef.current = false;
    }
  };

  return (
    <>
      <DetailHeader
        backHref="/contributor"
        backLabel="contributor dashboard"
        title={sub.title}
        meta={
          <>
            <SubmissionStatusPill status={sub.status} />
            <Pill tone={sub.generationMethod === "human" ? "neutral" : "info"}>
              {GENERATION_LABELS[sub.generationMethod]}
            </Pill>
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-faint">
              <Icon name="clock" size={11} />
              submitted {sub.submittedAt}
            </span>
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-faint">
              {sub.id}
              <CopyButton value={sub.id} label="submission id" iconOnly />
            </span>
          </>
        }
        right={
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            {/* Headless, like every other AutoRefreshControl call site in this
                app (karma, sponsor, validator/audit) -- the owner removed the
                visible "Refresh"/interval control app-wide on 2026-09-07 and
                the behaviour stays silent. This page previously showed its
                own static "auto-refresh · 15s" badge, which never actually
                counted down (a fixed label, not a live timer) and vanished
                whenever the submission left an active status -- both read as
                bugs, and it duplicated a pattern the shared component already
                owns. Removed rather than fixed in place. */}
            <AutoRefreshControl
              onRefresh={() => refreshSubmission(false)}
              refreshing={refreshing}
              enabled={isSubmissionActive}
              defaultSeconds={ACTIVE_VALIDATION_REFRESH_SECONDS}
            />
            <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}>
              <Icon name="clock" size={14} />
              Audit history
            </Button>
            {/* Community work pays karma: states the item's real karma position with server explanation. */}
            {itemKarma ? (
              <div className="min-w-[154px] rounded-lg border border-line-soft bg-panel px-4 py-2 text-right">
                <div className="flex items-center justify-end gap-1">
                  <div className="micro-label text-ink-faint">{KARMA_STATE_LABEL[itemKarma.state]}</div>
                  <InfoTip text={itemKarma.explanation} label="karma for this item" />
                </div>
                <div className={`mt-0.5 font-mono text-lg font-bold ${KARMA_STATE_TONE[itemKarma.state]}`}>
                  {itemKarma.state === "none" ? "—" : `+${num(itemKarma.amount)}`}
                  <span className="ml-1 text-[11px] font-normal text-ink-faint">karma</span>
                </div>
                {/* The program rate is real in every state, including `none`,
                    so "what is this worth if I fix it" is always answerable. */}
                <div className="mt-0.5 font-mono text-[10px] text-ink-faint">
                  {itemKarma.state === "projected" ? "if accepted" : `${num(itemKarma.perItem)} / accepted item`}
                </div>
              </div>
            ) : (
              /* F-008. No `karma` object on the API response means this page
                 has NO figure for the item — `submissionDisplayFromApi` leaves
                 `sub.reward` at its 0 default (lib/api-work.ts), so the old
                 "+0 karma" here was not a zero award, it was a missing one,
                 rendered in the earned-karma colour on items whose karma is
                 held. An unknown amount instead shows an explicit unavailable
                 state, never a number or reward claim. */
              <div className="flex min-w-[184px] items-center gap-3 rounded-lg border border-line-soft bg-panel px-4 py-3 text-left">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-canvas text-ink-faint" aria-hidden="true">
                  <Icon name="alert" size={15} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1">
                    <div className="micro-label text-ink-faint">karma</div>
                    <InfoTip
                      text="This page was not told this item's karma position, so it shows no amount. Your karma balance is the authority on what has been credited."
                      label="karma for this item"
                    />
                  </div>
                  <div className="mt-0.5 text-sm font-medium text-ink-soft">Status unavailable</div>
                  <div className="mt-0.5 text-[10px] text-ink-faint">Check your karma balance</div>
                </div>
              </div>
            )}
          </div>
        }
      />

      {refreshError && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900" role="alert">
          <span className="flex items-center gap-2">
            <Icon name="alert" size={14} />
            {refreshError} The status shown above may be stale.
          </span>
          <Button variant="secondary" size="sm" onClick={() => void refreshSubmission(false)} disabled={refreshing}>
            Retry refresh
          </Button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        {/* Left column: pipeline + scores */}
        <div className="space-y-4">
          <div className="card px-5 py-5">
            <div className="mb-4 text-sm font-bold">Validation pipeline</div>
            <Pipeline status={sub.status} validationResults={validationResults} auditItems={auditItems} datasetType={datasetType} llmEnabled={llmFlagReported} karma={itemKarma} />
          </div>

          {/* Only stages this dataset type actually runs get a row. A stage the
              pipeline above already reports as "Not configured for this dataset
              type" must not reappear here as a bare "—", which reads as a check
              that ran and scored nothing. Media-only types (no llm in their
              pipeline) therefore show neither row. */}
          {(showDedupeSignal || showLlmSignal) && (
            <div className="card px-5 py-5">
              <div className="mb-3.5 text-sm font-bold">Machine signals</div>
              <div className="flex flex-col gap-3 font-mono text-[12.5px]">
                {showDedupeSignal && (
                  <div className="flex items-center justify-between">
                    <span className="text-ink-soft" title="Higher means more similar to another live submission">duplicate similarity</span>
                    <span>{sub.duplicateScore == null ? "—" : `${Math.round(sub.duplicateScore * 100)}%`}</span>
                  </div>
                )}
                {showLlmSignal && (
                  <div className="flex items-center justify-between">
                    <span className="text-ink-soft" title="Higher means better quality against the configured rubric">LLM quality</span>
                    <span className={accepted ? "text-accent-strong" : ""}>
                      {sub.llmScore == null ? "—" : `${Math.round(sub.llmScore)}%`}
                    </span>
                  </div>
                )}
              </div>
              <p className="mt-4 border-t border-line-soft pt-3 text-[11px] leading-relaxed text-ink-soft">
                {showDedupeSignal ? "For duplicate similarity, lower is safer. " : ""}
                {showLlmSignal ? "For LLM quality, higher is better. " : ""}
                “—” does not mean zero—it means the stage did not produce a score. The pipeline above shows whether a check was pending, skipped, blocked, or failed.
              </p>
            </div>
          )}

          <DedupeEvidenceCard result={latestStageResults(validationResults).get("dedupe")} />
          <AiAttributionEvidenceCard result={latestStageResults(validationResults).get("ai_attribution")} />
          {/* Always rendered, even with no `llm` evidence row: a skipped or
              switched-off LLM check used to render nothing at all here, which
              read as "fine" instead of "never checked". */}
          <LlmEvidenceCard result={latestStageResults(validationResults).get("llm")} llmEnabled={llmFlagReported} />

          {/* Rendered whenever this dataset type takes a file, even with zero
              attachments: the API only returns artifacts whose scan finished
              ("ready"), so an omitted card would silently hide a file the
              contributor did upload. An empty state says so instead. */}
          {(attachments.length > 0 || hasFileField) && (
            <div className="card px-5 py-5">
              <div className="mb-3 text-sm font-bold">Attached files</div>
              <ArtifactList
                artifacts={attachments}
                emptyLabel="No file is attached to this item right now. If you uploaded one, it is still being scanned or was held by security verification."
              />
            </div>
          )}

          {hasFileField &&
            attachments.map((artifact) => (
              <ModalityCheckCard
                key={artifact.id}
                filename={artifact.filename}
                data={modalityEvents[artifact.id] ?? null}
                loading={modalityEvents[artifact.id] === undefined}
              />
            ))}
        </div>

        {/* Right column */}
        <div className="min-w-0 space-y-4">
          {/* Needs fixes / tests failed panel */}
          {(sub.status === "tests_failed" || sub.status === "needs_fixes" || sub.status === "rejected") && (
            <div className="rounded-[12px] border border-amber-300 bg-amber-50 px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-bold text-amber-800">
                <Icon name="alert" size={16} />
                {issueTitle}
              </div>
              {failedStage === "dedupe" && (
                <p className="mt-2 text-sm leading-relaxed text-amber-900">
                  This item matches an existing live submission. Change the duplicate-defining
                  content only if this is genuinely a different item; resubmitting the same
                  payload will be rejected again.
                </p>
              )}
              {displayedReviewNotes.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-amber-900">
                  {displayedReviewNotes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              )}
              {canRevise || canRerunValidation ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {canRerunValidation && (
                    <Button size="sm" variant="secondary" disabled={rerunSaving} onClick={rerunValidation}>
                      <Icon name="refresh" size={14} />
                      {rerunSaving ? "Queuing…" : "Rerun validation"}
                    </Button>
                  )}
                  {canRevise && <>
                    <Button size="sm" onClick={openRevisionEditor}>
                      <Icon name="refresh" size={14} />
                      Revise &amp; resubmit
                    </Button>
                    <span className="font-mono text-[11px] text-amber-800">
                      {revisionAccess?.remaining && revisionAccess.remaining >= 9999
                        ? "unlimited revisions"
                        : `${revisionAccess?.remaining ?? 0} revision attempt${revisionAccess?.remaining === 1 ? "" : "s"} remaining`}
                    </span>
                  </>}
                </div>
              ) : (
                /* The old copy guessed at three reasons with "or" — including
                   two that cannot apply to a community pool item, which has no
                   batch and no deadline. The server now names the actual reason
                   (`notActionableReason`), so a contributor on a CLOSED pool is
                   told the pool closed instead of being left to wonder which of
                   three things happened. */
                <p className="mt-3 text-xs font-medium text-amber-900">
                  {revisionAccess?.reason ??
                    "This item is no longer eligible for revision because its batch settled, its deadline passed, or its revision limit was reached."}
                </p>
              )}
              {canRerunValidation && (
                <p className="mt-2 text-[11px] leading-relaxed text-amber-800">
                  Rerun validation keeps this item unchanged and does not use a revision attempt. Revise only when you need to correct the item.
                </p>
              )}
              {revisionOpen && apiSub && (
                <div className="mt-4 border-t border-amber-200 pt-4">
                  <div className="mb-2 text-xs font-bold text-amber-900">Corrected item</div>
                  {datasetType ? (
                    <DynamicFieldsEditor
                      type={datasetType}
                      submissionId={apiSub.id}
                      values={revisionValues}
                      onChange={(key, value) => setRevisionValues((prev) => ({ ...prev, [key]: value }))}
                    />
                  ) : (
                    <p className="text-xs text-amber-800">Loading this item&apos;s field schema…</p>
                  )}
                  {revisionMissing.length > 0 && (
                    <div className="mt-2 rounded-lg border border-amber-300 bg-amber-100 px-3 py-2 font-mono text-xs text-amber-800">
                      Missing required field{revisionMissing.length > 1 ? "s" : ""}: {revisionMissing.join(", ")}
                    </div>
                  )}
                  {revisionError && <p className="mt-2 text-xs text-danger-strong">{revisionError}</p>}
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" disabled={revisionSaving || !datasetType} onClick={saveRevision}>
                      {revisionSaving ? "Checking…" : "Check & resubmit"}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={revisionSaving} onClick={() => setRevisionOpen(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Flags */}
          {showFlags &&
            (openFlags.length > 0 ? openFlags : sub.flags).map((flag) => (
              <div
                key={flag.id}
                className="rounded-[12px] border border-amber-300 bg-amber-50 px-5 py-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Icon name="flag" size={15} className="text-amber-700" />
                  <span className="text-sm font-bold text-amber-800">
                    {FLAG_REASON_LABELS[flag.reason] ?? flag.reason}
                  </span>
                  {/* No reviewer name: the API sends only `validatorUserId`, and
                      the reviewer's identity is deliberately not disclosed to the
                      submitter (disputes are admin-arbitrated so it need not be).
                      This line previously read `flagged by {flag.validator}` — a
                      mock-era field with no server counterpart — so it rendered
                      as "flagged by " followed by nothing. The date is real. */}
                  <span className="font-mono text-[11px] text-amber-700">
                    flagged by a validator{flag.createdAt ? ` · ${new Date(flag.createdAt).toLocaleDateString()}` : ""}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-amber-900">
                  {/* A rejecting decision cannot be filed without a note, but the
                      column is nullable — say so rather than showing a blank. */}
                  {flag.details?.trim() || "No written explanation was recorded with this flag. If you cannot tell what to change, dispute it and an admin will review the decision."}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {canRevise && openFlags.some((openFlag) => openFlag.id === flag.id) && (
                    <Button size="sm" onClick={openRevisionEditor}>
                      <Icon name="refresh" size={14} />
                      Fix &amp; resubmit
                    </Button>
                  )}
                  {canDispute && openFlags.some((openFlag) => openFlag.id === flag.id) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setDisputeError(null);
                        setDisputeOpen(true);
                      }}
                    >
                      <Icon name="shield" size={14} />
                      Dispute flag
                    </Button>
                  )}
                </div>
                {canDispute ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-800">
                    Fix and resubmit when the item is incorrect. Dispute only when the submitted evidence is correct and the validator decision should be reviewed.
                  </p>
                ) : sub.status === "disputed" ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-800">
                    This flag is under platform review. No further revision or duplicate dispute can be filed until it is resolved.
                  </p>
                ) : null}
                {disputeOpen && apiSub && (
                  <div className="mt-4 border-t border-amber-200 pt-4">
                    <label className="text-xs font-bold text-amber-900" htmlFor="dispute-argument">
                      Why should the platform review this flag?
                    </label>
                    <textarea
                      id="dispute-argument"
                      className="mt-2 min-h-24 w-full rounded-lg border border-amber-300 bg-white p-3 text-sm text-ink focus:border-ink focus:outline-none"
                      value={disputeText}
                      onChange={(event) => setDisputeText(event.target.value)}
                      placeholder="Point to the submitted field, reference, or validator decision that should be reconsidered."
                    />
                    {disputeError && <p className="mt-2 text-xs text-danger-strong">{disputeError}</p>}
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" disabled={disputeSaving} onClick={submitDispute}>
                        {disputeSaving ? "Sending…" : "Send for review"}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={disputeSaving} onClick={() => setDisputeOpen(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

          {revisionOpen && apiSub && !(sub.status === "tests_failed" || sub.status === "needs_fixes") && (
            <div className="rounded-[12px] border border-amber-300 bg-amber-50 px-5 py-4">
              <div className="mb-2 text-sm font-bold text-amber-800">Corrected item</div>
              {datasetType ? (
                <DynamicFieldsEditor
                  type={datasetType}
                  submissionId={apiSub.id}
                  values={revisionValues}
                  onChange={(key, value) => setRevisionValues((prev) => ({ ...prev, [key]: value }))}
                />
              ) : (
                <p className="text-xs text-amber-800">Loading this item&apos;s field schema…</p>
              )}
              {revisionMissing.length > 0 && (
                <div className="mt-2 rounded-lg border border-amber-300 bg-amber-100 px-3 py-2 font-mono text-xs text-amber-800">
                  Missing required field{revisionMissing.length > 1 ? "s" : ""}: {revisionMissing.join(", ")}
                </div>
              )}
              {revisionError && <p className="mt-2 text-xs text-danger-strong">{revisionError}</p>}
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={revisionSaving || !datasetType} onClick={saveRevision}>{revisionSaving ? "Checking…" : "Check & resubmit"}</Button>
                <Button size="sm" variant="secondary" disabled={revisionSaving} onClick={() => setRevisionOpen(false)}>Cancel</Button>
              </div>
            </div>
          )}

          {disputes.length > 0 && (() => {
            const dispute = disputes[0];
            if (dispute.status === "open") {
              return (
                <div className="flex items-start gap-3 rounded-[12px] border border-sky-200 bg-sky-50 px-5 py-4 text-sm text-sky-900">
                  <Icon name="shield" size={16} className="mt-0.5 shrink-0 text-sky-600" />
                  <div className="leading-relaxed">
                    <p className="font-semibold">Dispute under platform review</p>
                    <p className="mt-1">An admin will resolve it within 48h — your item stays locked until then.</p>
                    <p className="mt-2 text-[12px] text-sky-800">Your argument: &ldquo;{dispute.contributorArgument}&rdquo;</p>
                  </div>
                </div>
              );
            }
            const overturned = dispute.resolutionDecision === "overturn_flag";
            return (
              <div
                className={`flex items-start gap-3 rounded-[12px] border px-5 py-4 text-sm ${
                  overturned
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : "border-amber-200 bg-amber-50 text-amber-900"
                }`}
              >
                <Icon name={overturned ? "check" : "shield"} size={16} className="mt-0.5 shrink-0" />
                <div className="leading-relaxed">
                  <p className="font-semibold">
                    {overturned ? "Dispute upheld — flag overturned" : "Flag upheld after review"}
                  </p>
                  <p className="mt-1">
                    {overturned
                      ? "The validator flag was dismissed and your item was sent back for a fresh audit."
                      : "After review, the validator flag stands. You can still fix and resubmit if revisions remain."}
                  </p>
                  {dispute.resolution && (
                    <p className="mt-2 text-[12px] opacity-80">Reviewer note: &ldquo;{dispute.resolution}&rdquo;</p>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Execution — dark terminal strip */}
          {sub.execution && (
            <div className="overflow-hidden rounded-[12px] border border-dark-line bg-dark">
              <div className="flex items-center justify-between border-b border-dark-line px-[18px] py-3">
                <span className="font-mono text-xs text-dark-soft">
                  sandbox execution
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
                    sub.execution.decision === "pass"
                      ? "bg-[rgba(52,211,153,.1)] text-[#34d399]"
                      : sub.execution.decision === "fail"
                        ? "bg-[rgba(251,113,133,.1)] text-[#fb7185]"
                        : "bg-[rgba(251,191,36,.1)] text-[#fbbf24]"
                  }`}
                >
                  {sub.execution.decision === "pass"
                    ? "execution pass"
                    : sub.execution.decision === "fail"
                      ? "execution fail"
                      : "not attempted"}
                </span>
              </div>
              <ExecutionProviderStrip result={latestStageResults(validationResults).get("execution")} />
              <pre className="code-scroll overflow-x-auto px-[18px] py-4 font-mono text-[12px] leading-relaxed text-dark-muted">
                {sub.execution.logs}
              </pre>
              {sub.execution.decision === "pending" ? (
                <div className="border-t border-dark-line px-[18px] py-3 font-mono text-[11.5px] text-[#fbbf24]">
                  No test verdict was produced. {sub.execution.reason ?? "This stage is awaiting a prerequisite or runner."}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5 border-t border-dark-line px-[18px] py-3 font-mono text-[11.5px] text-dark-muted">
                  {sub.execution.brokenCodeFailedTests !== null && (
                    <div className="flex justify-between">
                      <span>broken_code failed tests</span>
                      <span
                        className={
                          sub.execution.brokenCodeFailedTests
                            ? "text-[#34d399]"
                            : "text-[#fb7185]"
                        }
                      >
                        {sub.execution.brokenCodeFailedTests ? "yes" : "no"}{" "}
                        (required: yes)
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span>execution passed</span>
                    <span
                      className={
                        sub.execution.fixedCodePassedTests
                          ? "text-[#34d399]"
                          : "text-[#fb7185]"
                      }
                    >
                      {sub.execution.fixedCodePassedTests ? "yes" : "no"}{" "}
                      (required: yes)
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* LLM review — rubric breakdown so the contributor sees WHAT the
              judge checked and how many rubric lines passed, not just the bare
              "LLM quality" percentage in the Machine signals card. */}
          {sub.llmReview && <LlmReviewCard review={sub.llmReview} />}

          {/* Item content — rendered from this bounty's actual dataset-type
              field contract (fieldRows), never a hardcoded debugging-only
              shape. A dataset type with different fields (e.g. SQL
              generation's schema_definition/sql_query) must never be shown
              through the Debugging & Bug Fix broken_code/fixed_code labels. */}
          <div className="card px-5 py-5">
            <div className="mb-4 text-[15px] font-bold">Item content</div>
            {!datasetType || !rawPayload ? (
              <p className="text-[13px] text-ink-soft">Loading item content…</p>
            ) : (
              <div className="space-y-4">
                {fieldRows(datasetType)
                  .map((field) => {
                    const raw = rawPayload[field.key];
                    // File fields used to be dropped from this list entirely,
                    // so a contributor could see filenames in "Attached files"
                    // with no way to tell which contract field each one
                    // satisfied — and an empty file field showed nothing at
                    // all. Name the field, then name its file(s).
                    if (field.role === "file") {
                      const ids = fileIdsFromValue(raw);
                      const matched = ids
                        .map((id) => attachments.find((artifact) => artifact.id === id))
                        .filter((artifact): artifact is ApiArtifact => artifact != null);
                      return (
                        <div key={field.key}>
                          <div className="micro-label mb-1.5 text-ink-faint">
                            {field.label} ({field.key})
                          </div>
                          {ids.length === 0 ? (
                            <p className="text-[13.5px] text-ink-soft">No file submitted for this field.</p>
                          ) : matched.length === ids.length ? (
                            <ArtifactList artifacts={matched} />
                          ) : (
                            <>
                              {matched.length > 0 && <ArtifactList artifacts={matched} />}
                              <p className="mt-1.5 text-[12px] leading-relaxed text-amber-700">
                                {ids.length - matched.length} of {ids.length} file
                                {ids.length === 1 ? "" : "s"} submitted for this field cannot be shown — still
                                scanning, or held by security verification.
                              </p>
                            </>
                          )}
                        </div>
                      );
                    }
                    if (field.role === "list" || field.role === "input_code" || field.role === "solution_code" || field.role === "tests") {
                      const text = field.role === "list" && Array.isArray(raw) ? raw.join("\n") : stringValue(raw);
                      return (
                        <CodeBlock
                          key={field.key}
                          code={text}
                          label={`${field.label} (${field.key})`}
                          tone={field.role === "solution_code" ? "success" : field.role === "input_code" ? "danger" : "neutral"}
                        />
                      );
                    }
                    return (
                      <div key={field.key}>
                        <div className="micro-label mb-1.5 text-ink-faint">
                          {field.label} ({field.key})
                        </div>
                        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">
                          {stringValue(raw) || "—"}
                        </p>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </div>
      </div>

      <SubmissionAuditHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        validationResults={validationResults}
        revisions={revisions}
        auditItems={auditItems ?? []}
        flags={flags}
      />
    </>
  );
}
