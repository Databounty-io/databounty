// SPDX-License-Identifier: Apache-2.0

import { LlmReviewCard } from "./llm-review-card";
import { AiAttributionEvidenceCard, DedupeEvidenceCard, ExecutionProviderStrip, LlmEvidenceCard, ModalityCheckCard } from "./stage-evidence-cards";
import { fieldRows, stringValue } from "./dynamic-item-fields";
import { FLAG_REASON_LABELS, humanizeKey, pctOrDash as pct } from "@/lib/format";
import { Button } from "@/components/ui";
import type { DatasetType } from "@/lib/dataset-types";
import type { Submission } from "@/lib/types";
import {
  llmScoreTo01,
  normalizeValidationStage,
  validationStageState,
  VALIDATION_STAGE_STATE_LABEL,
  type ApiSubmissionDetail,
  type ApiValidationResult,
  type ValidationStageState,
} from "@/lib/api-work";
import type { ApiArtifact, ArtifactProcessingEventsResponse } from "@/lib/api-artifacts";

const isCodeLike = (role?: string) =>
  role === "input_code" || role === "solution_code" || role === "tests" || role === "list";

const PIPELINE_LABELS: Record<string, string> = {
  dedupe: "Duplicate check",
  ai_attribution: "Automated AI attribution",
  execution: "Sandbox execution",
  llm: "LLM validation",
  human_audit: "Human audit",
};

export function ValidationPipelineCard({
  datasetType,
  validationResults,
  auditItems = [],
  llmValidationEnabled,
}: {
  datasetType?: DatasetType | null;
  validationResults: ApiValidationResult[];
  auditItems?: NonNullable<ApiSubmissionDetail["auditItems"]>;
  llmValidationEnabled?: boolean;
}) {
  const latest = new Map<string, ApiValidationResult>();
  for (const result of validationResults) latest.set(normalizeValidationStage(result.stage), result);
  const configured = new Set<string>(datasetType?.verification.pipeline ?? []);
  // dedupe and ai_attribution are unconditional backend stages (every
  // submission runs both, regardless of dataset-type pipeline config — see
  // services/validation.ts), so they're always shown here, matching the
  // contributor submission-detail view's equivalent forced pair.
  // Deviation requested 2026-09-03 (owner-approved deviation, recorded in the parity decision register): the `llm` row is
  // additionally dropped when the platform has reported the flag explicitly
  // `false` and this submission has no recorded llm evidence of its own —
  // matching the same-day change to LlmEvidenceCard and the contributor
  // submission view's Pipeline component, which this file used to diverge
  // from (this card had no `llmValidationEnabled` prop at all before now).
  const stages = ["dedupe", "ai_attribution", "execution", "llm", "human_audit"].filter(
    (stage) => {
      if (stage === "llm" && llmValidationEnabled === false && !latest.has("llm")) return false;
      return stage === "dedupe" || stage === "ai_attribution" || configured.has(stage) || latest.has(stage) || (stage === "human_audit" && auditItems.length > 0);
    },
  );

  return (
    <div className="card px-5 py-5">
      <div className="mb-4 text-sm font-bold">Validation pipeline</div>
      <div className="space-y-2.5 font-mono text-[12.5px]">
        {stages.map((stage) => {
          const result = latest.get(stage);
          const isConfigured = stage === "dedupe" || stage === "ai_attribution" || configured.has(stage);
          // A decision writes `verdict` and `decidedAt` together, and
          // reopenAuditItemForReview clears them together, so requiring both
          // is what "actually decided" means. The old `.find(decidedAt !=
          // null)` alone disagreed with AuditHistoryPanel below, which keys
          // off `verdict` — on any item carrying more than one AuditItem the
          // two panels reported different outcomes for the same audit. The
          // API now returns these decided-first, newest-first, so the first
          // match is the latest decision rather than the oldest.
          const audit =
            stage === "human_audit"
              ? auditItems.find((item) => item.decidedAt != null && item.verdict != null)
              : undefined;

          let label: string;
          let tone: string;
          if (stage === "human_audit") {
            const passed = audit?.verdict === "ok";
            const flagged = Boolean(audit && audit.verdict !== "ok");
            label = passed ? "passed" : flagged ? "flagged" : auditItems.length > 0 || isConfigured ? "pending / blocked" : "not configured";
            tone = passed ? "text-accent-strong" : flagged ? "text-danger-strong" : "text-ink-faint";
          } else if (result) {
            // Shared decoder: an escalated stage (AI-attribution flag, failing
            // LLM verdict, dedupe review_required) is NOT a terminal failure.
            // Rendering it as "failed" is what contradicted the pending status
            // pill on this same screen.
            const state = validationStageState(result);
            label = VALIDATION_STAGE_STATE_LABEL[state];
            tone =
              state === "passed"
                ? "text-accent-strong"
                : state === "failed" || state === "review_fail"
                  ? "text-danger-strong"
                  : state === "flagged"
                    ? "text-amber-700"
                    : "text-ink-faint";
          } else {
            label = isConfigured ? "pending / blocked" : "not configured";
            tone = "text-ink-faint";
          }
          return (
            <div key={stage} className="flex items-center justify-between gap-3">
              <span className="text-ink-soft">{PIPELINE_LABELS[stage]}</span>
              <span className={tone}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SponsorSubmissionDetail({
  display,
  payload,
  datasetType,
  validationResults = [],
  auditItems = [],
  attachments = [],
  modalityEvents = {},
  llmValidationEnabled,
}: {
  display: Submission;
  payload: Record<string, unknown>;
  datasetType?: DatasetType | null;
  validationResults?: ApiValidationResult[];
  auditItems?: NonNullable<ApiSubmissionDetail["auditItems"]>;
  attachments?: ApiArtifact[];
  modalityEvents?: Record<string, ArtifactProcessingEventsResponse | null | undefined>;
  /** Server-reported `validation.llm.enabled`. Left `undefined` when the
   * caller has no server value for it — the LLM evidence card then says the
   * flag was not reported instead of inventing "off" or "on". */
  llmValidationEnabled?: boolean;
}) {
  const hasFileField = Boolean(datasetType && fieldRows(datasetType).some((f) => f.role === "file"));
  const rows = datasetType ? fieldRows(datasetType).filter((f) => f.role !== "file") : [];
  const latestByStage = new Map<string, ApiValidationResult>();
  for (const result of validationResults) latestByStage.set(normalizeValidationStage(result.stage), result);
  const configuredStages = new Set(
    datasetType?.verification.pipeline ?? validationResults.map((result) => result.stage),
  );
  const showDedupe = configuredStages.has("dedupe");
  // Deviation requested 2026-09-03: also hidden when the platform reports
  // LLM review as explicitly off and this item has no real score of its own —
  // mirrors the contributor submission view's `showLlmSignal`.
  const showLlm = configuredStages.has("llm") && (llmValidationEnabled !== false || display.llmScore != null);
  const openFlags = display.flags.filter((flag) =>
    flag.status === "open" || flag.status === "disputed",
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        <aside className="space-y-4">
          <ValidationPipelineCard
            datasetType={datasetType}
            validationResults={validationResults}
            auditItems={auditItems}
            llmValidationEnabled={llmValidationEnabled}
          />
          {(showDedupe || showLlm) && (
            <div className="card px-5 py-5">
              <div className="mb-3.5 text-sm font-bold">Machine signals</div>
              <div className="flex flex-col gap-3 font-mono text-[12.5px]">
                {showDedupe && (
                  <div className="flex items-center justify-between">
                    <span className="text-ink-soft">duplicate similarity</span>
                    <span>{pct(display.duplicateScore)}</span>
                  </div>
                )}
                {showLlm && (
                  <div className="flex items-center justify-between">
                    <span className="text-ink-soft">LLM quality</span>
                    <span>{display.llmScore == null ? "—" : `${Math.round(display.llmScore)}%`}</span>
                  </div>
                )}
              </div>
              <p className="mt-4 border-t border-line-soft pt-3 text-[11px] leading-relaxed text-ink-soft">
                {showDedupe ? "For duplicate similarity, lower is safer. " : ""}
                {showLlm ? "For LLM quality, higher is better. " : ""}
                “—” means the stage did not produce a score.
              </p>
            </div>
          )}

          <DedupeEvidenceCard result={latestByStage.get("dedupe")} />
          <AiAttributionEvidenceCard result={latestByStage.get("ai_attribution")} />
          {/* Rendered even with no `llm` row: a sponsor reading delivered
              evidence must see that the machine quality review did not run,
              rather than an omitted card that reads as a clean pass. */}
          <LlmEvidenceCard result={latestByStage.get("llm")} llmEnabled={llmValidationEnabled} />

          {hasFileField &&
            attachments.map((artifact) => (
              <ModalityCheckCard
                key={artifact.id}
                filename={artifact.filename}
                data={modalityEvents[artifact.id] ?? null}
                loading={modalityEvents[artifact.id] === undefined}
              />
            ))}
        </aside>

        <div className="min-w-0 space-y-4">
          {display.execution && (
            <div className="overflow-hidden rounded-[12px] border border-dark-line bg-dark">
              <div className="flex items-center justify-between border-b border-dark-line px-[18px] py-3">
                <span className="font-mono text-xs text-dark-soft">sandbox execution</span>
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
                    display.execution.decision === "pass"
                      ? "bg-[rgba(52,211,153,.1)] text-[#34d399]"
                      : display.execution.decision === "fail"
                        ? "bg-[rgba(251,113,133,.1)] text-[#fb7185]"
                        : "bg-[rgba(251,191,36,.1)] text-[#fbbf24]"
                  }`}
                >
                  {display.execution.decision === "pass" ? "execution pass" : display.execution.decision === "fail" ? "execution fail" : "not attempted"}
                </span>
              </div>
              <ExecutionProviderStrip result={latestByStage.get("execution")} />
              <pre className="code-scroll overflow-x-auto px-[18px] py-4 font-mono text-[12px] leading-relaxed text-dark-muted">
                {display.execution.logs}
              </pre>
            </div>
          )}

          {display.llmReview && <LlmReviewCard review={display.llmReview} />}

          {openFlags.map((flag) => (
            <div key={flag.id} className="card border-amber-300 bg-amber-50/70 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-bold text-amber-900">Validator flag · {FLAG_REASON_LABELS[flag.reason] ?? flag.reason}</div>
                <span className="rounded-full bg-amber-200 px-2 py-0.5 font-mono text-[10px] text-amber-900">{flag.status}</span>
              </div>
              {flag.details && <p className="mt-2 text-xs leading-relaxed text-amber-800">{flag.details}</p>}
            </div>
          ))}

          <div className="card space-y-5 p-6">
            <div className="border-b border-line-soft pb-4">
              <div className="micro-label text-ink-faint">delivered item content</div>
              <h2 className="mt-1 break-words text-base font-bold text-ink">{display.title}</h2>
            </div>

            {rows.map((field) => {
              const value = stringValue(payload[field.key]);
              return (
                <div key={field.key} className="space-y-1.5">
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-xs font-semibold text-ink-soft">{field.label}</span>
                    <span className="font-mono text-[10px] text-ink-faint">{humanizeKey(field.role)}</span>
                  </div>
                  {isCodeLike(field.role) ? (
                    <pre className="code-scroll overflow-x-auto rounded-lg border border-line-soft bg-panel p-3.5 font-mono text-xs text-ink">
                      <code>{value || "—"}</code>
                    </pre>
                  ) : (
                    <p className="break-words text-sm leading-relaxed text-ink">{value || "—"}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function evidenceLabel(stage: string) {
  return ({ dedupe: "Duplicate check", execution: "Sandbox execution", llm: "LLM validation" } as Record<string, string>)[stage] ?? humanizeKey(stage);
}

const EVIDENCE_STATE_TONE: Record<ValidationStageState, string> = {
  passed: "text-success",
  failed: "text-danger-strong",
  flagged: "text-amber-700",
  // Danger tone, matching stage-evidence-cards.tsx's own "review fail" pill —
  // the verdict really did fail, it just does not gate acceptance.
  review_fail: "text-danger-strong",
  hold: "text-amber-700",
};

function EvidenceRows({
  results,
}: {
  results: Array<{
    id?: string;
    stage: string;
    passed: boolean;
    score: number | null;
    outcome?: string | null;
    detail?: Record<string, unknown> | null;
    detailJson?: Record<string, unknown> | null;
    createdAt: string;
  }>;
}) {
  // Revision snapshots are written as a JSON column and were written as `{}`
  // for a period (services/submissions.ts), so a stored value can still be a
  // non-array. `{}.length` is `undefined`, which is not `=== 0`, so the old
  // guard fell through to `.map` and threw — taking down the whole drawer for
  // any submission that had ever been revised. Normalize before both checks.
  const rows = Array.isArray(results) ? results : [];
  if (rows.length === 0) return <p className="text-xs text-ink-faint">No machine-stage evidence was recorded for this version.</p>;
  return (
    <ol className="space-y-2">
      {rows.map((result, index) => {
        const state = validationStageState(result);
        return (
          <li key={result.id ?? `${result.stage}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line-soft bg-panel px-3 py-2 font-mono text-xs">
            <span className="capitalize text-ink">{evidenceLabel(result.stage)}</span>
            <span className={EVIDENCE_STATE_TONE[state]}>
              {VALIDATION_STAGE_STATE_LABEL[state]}
              {/* `llm` stores its score 0–100 while dedupe/execution store 0–1
                  (measured in community_test: llm 35..92, the others 0..1), so
                  the bare `score * 100` here printed a real llm row as
                  "4500%". llmScoreTo01 is the existing shared normalizer —
                  its own doc comment says every surface must use it so the
                  same score prints the same number everywhere. */}
              {result.score != null ? ` · ${Math.round(llmScoreTo01(result.score) * 100)}%` : ""}
            </span>
            <time className="text-[10px] text-ink-faint">{new Date(result.createdAt).toLocaleString()}</time>
          </li>
        );
      })}
    </ol>
  );
}

export function AuditHistoryPanel({
  validationResults,
  revisions,
  auditItems = [],
  flags = [],
}: {
  validationResults: ApiValidationResult[];
  revisions: NonNullable<ApiSubmissionDetail["revisions"]>;
  auditItems?: NonNullable<ApiSubmissionDetail["auditItems"]>;
  flags?: NonNullable<ApiSubmissionDetail["flags"]>;
}) {
  return (
    <section>
      <p className="mb-5 text-xs leading-relaxed text-ink-soft">A complete, immutable record of verification, failed attempts, resubmissions, and validator audit decisions.</p>
      <div className="mb-5 rounded-lg border border-line-soft bg-panel p-3">
        <div className="mb-2 font-mono text-xs font-semibold text-ink">Validator audit</div>
        {auditItems.length === 0 ? (
          <p className="text-xs text-ink-soft">No validator audit has been assigned yet.</p>
        ) : (
          <ol className="space-y-2">
            {auditItems.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
                {/* Keyed on the same "verdict AND decidedAt" pair the pipeline
                    card above uses, so the two panels cannot report different
                    outcomes for the same audit item. */}
                <span>{item.decidedAt != null && item.verdict === "ok" ? "Validator accepted" : item.decidedAt != null && item.verdict === "flagged" ? "Validator flagged" : "Awaiting validator decision"}</span>
                <time className="text-[10px] text-ink-faint">{item.decidedAt ? new Date(item.decidedAt).toLocaleString() : "pending"}</time>
              </li>
            ))}
          </ol>
        )}
      </div>
      {flags.length > 0 && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="mb-2 font-mono text-xs font-semibold text-amber-900">Flag history</div>
          <ol className="space-y-2">
            {flags.map((flag) => (
              <li key={flag.id} className="font-mono text-xs text-amber-900">
                <span className="font-semibold">{humanizeKey(flag.reason)}</span> · {humanizeKey(flag.status)}
                {flag.details ? <p className="mt-1 font-sans text-xs text-amber-800">{flag.details}</p> : null}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="mb-2 text-[15px] font-bold">Verification & resubmission history</div>
      {revisions.length > 0 && (
        <div className="mb-4 space-y-3">
          {[...revisions].sort((a, b) => a.revisionNumber - b.revisionNumber).map((revision) => (
            <div key={revision.id} className="rounded-lg border border-line-soft p-3">
              <div className="mb-2 flex flex-wrap justify-between gap-2 font-mono text-xs">
                <span className="font-semibold text-ink">Version {revision.revisionNumber} · {humanizeKey(revision.status)}</span>
                <time className="text-ink-faint">replaced {new Date(revision.createdAt).toLocaleString()}</time>
              </div>
              <EvidenceRows results={revision.validationEvidence} />
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-line-soft pt-3">
        <div className="mb-2 font-mono text-xs font-semibold text-ink">Current version</div>
        <EvidenceRows results={validationResults} />
      </div>
    </section>
  );
}

export function SubmissionAuditHistoryDrawer({
  open,
  onClose,
  validationResults,
  revisions,
  auditItems = [],
  flags = [],
}: {
  open: boolean;
  onClose: () => void;
  validationResults: ApiValidationResult[];
  revisions: NonNullable<ApiSubmissionDetail["revisions"]>;
  auditItems?: NonNullable<ApiSubmissionDetail["auditItems"]>;
  flags?: NonNullable<ApiSubmissionDetail["flags"]>;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Audit history">
      <button aria-label="Close audit history" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="relative h-full w-full max-w-xl overflow-y-auto border-l border-line bg-white p-5 shadow-2xl sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4 border-b border-line-soft pb-4">
          <div>
            <div className="micro-label text-ink-faint">submission record</div>
            <h2 className="mt-1 text-lg font-bold">Audit history</h2>
          </div>
          <Button variant="secondary" size="sm" onClick={onClose}>close</Button>
        </div>
        <AuditHistoryPanel
          validationResults={validationResults}
          revisions={revisions}
          auditItems={auditItems}
          flags={flags}
        />
      </aside>
    </div>
  );
}
