// SPDX-License-Identifier: Apache-2.0

import { VALIDATION_STAGE_STATE_LABEL, validationStageState, type ApiValidationResult, type ValidationStageState } from "@/lib/api-work";
import type { ArtifactProcessingEventsResponse } from "@/lib/api-artifacts";
import { humanizeKey, pctOrDash as pct } from "@/lib/format";

/** Pill colour per decoded state. `flagged` gets the amber this file already
 *  uses for every "a human still has to judge this" row (the dedupe
 *  `review_required` decision line, the media "not checked" line), and
 *  `review_fail` keeps the danger colour `LlmEvidenceCard` already paints its
 *  own "review fail" pill with — the verdict really did fail, it just gates
 *  nothing. */
const STATE_PILL_CLS: Record<ValidationStageState, string> = {
  passed: "bg-[#eaf3d6] text-accent-strong",
  failed: "bg-[#fbe4e8] text-danger-strong",
  flagged: "bg-amber-100 text-amber-700",
  review_fail: "bg-[#fbe4e8] text-danger-strong",
  hold: "bg-amber-100 text-amber-700",
};

/**
 * `passed === false` is four different states, so a pill derived from
 * `passed` + "is there a score" was the forbidden `!passed && score != null ⇒
 * failed` rule: the dedupe card printed a red "failed" pill directly above its
 * OWN decision row reading "flagged for validator review", and the attribution
 * card did the same for a flagged disclosure. Decode with the one shared
 * decoder (lib/api-work.ts) and take its wording, so this pill, that decision
 * row, and the sponsor/validator surfaces all say the same thing.
 */
function statusPill(result: ApiValidationResult) {
  const state = validationStageState(result);
  return { label: VALIDATION_STAGE_STATE_LABEL[state], cls: STATE_PILL_CLS[state] };
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-soft">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function CardShell({
  title,
  pill,
  children,
}: {
  title: string;
  /** The already-decoded pill. Every caller either runs `statusPill` on its own
   *  result row or, like `LlmEvidenceCard`, has richer per-status wording of its
   *  own — the old `passed`/`hasScore` pair only existed to re-derive the state
   *  here, and `LlmEvidenceCard` always overrode it anyway. */
  pill: { label: string; cls: string };
  children: React.ReactNode;
}) {
  return (
    <div className="card px-5 py-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="text-[15px] font-bold">{title}</div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[10px] ${pill.cls}`}>{pill.label}</span>
      </div>
      <div className="flex flex-col gap-2 font-mono text-[12.5px]">{children}</div>
    </div>
  );
}

export function DedupeEvidenceCard({ result }: { result?: ApiValidationResult }) {
  if (!result) return null;
  const detail = (result.detailJson ?? {}) as Record<string, unknown>;
  const decision = typeof detail.duplicateDecision === "string" ? detail.duplicateDecision : undefined;
  const method = typeof detail.duplicateMethod === "string" ? detail.duplicateMethod : null;
  const dupOfId = typeof detail.duplicateOfSubmissionId === "string" ? detail.duplicateOfSubmissionId : null;
  const fields = Array.isArray(detail.dedupeFields) ? (detail.dedupeFields as string[]) : [];
  const media = (detail.mediaDedupe ?? null) as
    | { status?: string; comparedSiblings?: number; truncated?: boolean; unsupportedModalities?: string[]; reason?: string }
    | null;
  const mediaCompared = media?.status === "compared";

  return (
    <CardShell title="Duplicate check" pill={statusPill(result)}>
      <Row label="similarity score" value={pct(result.score)} />
      <Row
        label="decision"
        value={
          decision === "rejected"
            ? <span className="text-danger-strong">rejected — exact/near duplicate</span>
            : decision === "review_required"
              ? <span className="text-amber-700">flagged for validator review</span>
              : decision === "accepted"
                ? <span className="text-accent-strong">accepted — no match</span>
                : "—"
        }
      />
      {method && <Row label="match method" value={humanizeKey(method)} />}
      {fields.length > 0 && <Row label="fields compared" value={fields.join(", ")} />}
      {dupOfId && (
        <Row label="matched submission" value={<span className="break-all text-[11px] text-ink-faint">{dupOfId}</span>} />
      )}
      {media && media.status !== "no_media_fields" && (
        <>
          <Row
            label="media compared"
            value={
              mediaCompared ? (
                <span className={media.truncated ? "text-amber-700" : "text-accent-strong"}>
                  {media.comparedSiblings ?? 0} sibling{media.comparedSiblings === 1 ? "" : "s"}
                  {media.truncated ? " · partial coverage" : ""}
                </span>
              ) : (
                <span className="text-amber-700">not checked — {humanizeKey(media.status ?? "unknown")}</span>
              )
            }
          />
          {!mediaCompared && media.reason && (
            <p className="mt-2 border-t border-line-soft pt-3 text-[11.5px] leading-relaxed text-amber-700">
              {media.reason}
            </p>
          )}
        </>
      )}
      {media && mediaCompared && media.truncated && media.reason && (
        <p className="mt-2 border-t border-line-soft pt-3 text-[11.5px] leading-relaxed text-amber-700">
          {media.reason}
        </p>
      )}
      {!decision && (
        <p className="mt-2 border-t border-line-soft pt-3 text-[11.5px] leading-relaxed text-ink-soft">
          This stage has not produced a decision yet.
        </p>
      )}
    </CardShell>
  );
}

export function AiAttributionEvidenceCard({ result }: { result?: ApiValidationResult }) {
  if (!result) return null;
  const detail = (result.detailJson ?? {}) as Record<string, unknown>;
  const decision = typeof detail.decision === "string" ? detail.decision : undefined;
  const score = typeof detail.score === "number" ? detail.score : result.score;
  const method = typeof detail.method === "string" ? detail.method : null;

  return (
    // `detail.score` is only ever the DISPLAY likelihood; the pill is decoded
    // from the stored row itself (a flagged disclosure is written as
    // `passed: false, score: 1, detail.status: "flagged"`), so the pill now
    // reads "flagged for review" instead of contradicting the classification
    // row below it with a red "failed".
    <CardShell title="Automated AI attribution" pill={statusPill(result)}>
      <Row label="likelihood score" value={pct(score)} />
      <Row
        label="classification"
        value={
          decision === "ai_generated"
            ? <span className="text-danger-strong">likely AI generated</span>
            : decision === "ai_assisted"
              ? <span className="text-amber-700">likely AI assisted</span>
              : decision === "human"
                ? <span className="text-accent-strong">likely human authored</span>
                : "unclassified"
        }
      />
      {method && <Row label="detection engine" value={humanizeKey(method)} />}
    </CardShell>
  );
}

/**
 * LLM quality-review evidence — the ONLY card in this file that deliberately
 * renders when `result` is `undefined`.
 *
 * Every sibling card starts `if (!result) return null`, which is correct for
 * them: a dedupe/attribution row always exists once the item was processed.
 * The LLM stage is different. It is the one stage that can be absent because
 * the platform turned it OFF, or because no provider was ever configured —
 * and in that case the reader saw NO row, NO label and NO explanation, which
 * silently reads as "nothing to worry about here". That is the exact failure
 * the project's trust-honesty invariant forbids: a missing, skipped,
 * unsupported, stale or unconfigured check must be shown explicitly and must
 * never be presented as passed. So an absent row is itself a state this card
 * has to say out loud.
 *
 * Honest outcome strings this handles, all read from real write sites:
 *  - `services/validation.ts` (this API) writes exactly three shapes on the
 *    `llm` stage: a real verdict (`detailJson.model` + `reasons`, score 0–100),
 *    `no_provider_configured` (`detailJson.status = "pending_llm_review"`), and
 *    `provider_error` (`detailJson.reason`, score null). `outcome` itself is
 *    NOT serialized to this client (the sponsor/contributor selects list only
 *    id/stage/passed/score/detailJson/createdAt), so the discrimination below
 *    is deliberately driven by detailJson + score, not by `outcome`.
 *  - V1's `llm/consumers/review.ts` and `validation-pipeline.ts` additionally
 *    write `status: "reviewed"` (with `verdict`/`passThreshold`/`evidence`/
 *    `criteria`, score 0–1) and `status: "skipped_sampling"` (with
 *    `sampleRate`/`samplingMode`). Both are kept for parity, since V1 rows
 *    survive in retained evidence.
 *
 * `llmEnabled` is the platform's `validation.llm.enabled` as reported by the
 * server. It is OPTIONAL and `undefined` means "this page was not told" — the
 * card then renders one honest "no LLM review recorded" state rather than
 * inventing a distinction between "off" and "on but nothing ran".
 */
export function LlmEvidenceCard({
  result,
  llmEnabled,
  className = "",
}: {
  result?: ApiValidationResult;
  llmEnabled?: boolean;
  className?: string;
}) {
  const detail = (result?.detailJson ?? {}) as Record<string, unknown>;
  const status = typeof detail.status === "string" ? detail.status : null;
  const model = typeof detail.model === "string" ? detail.model : null;
  const reason = typeof detail.reason === "string" ? detail.reason : null;
  const evidence = typeof detail.evidence === "string" ? detail.evidence : null;
  const verdict =
    detail.verdict === "pass" || detail.verdict === "fail" || detail.verdict === "uncertain"
      ? (detail.verdict as "pass" | "fail" | "uncertain")
      : null;
  const reasons = Array.isArray(detail.reasons) ? (detail.reasons as unknown[]).filter((r): r is string => typeof r === "string") : [];
  const threshold = typeof detail.passThreshold === "number" ? detail.passThreshold : null;
  const sampleRate = typeof detail.sampleRate === "number" ? detail.sampleRate : null;
  const samplingMode = typeof detail.samplingMode === "string" ? detail.samplingMode : null;

  // Two score scales coexist in stored evidence: this API records 0–100
  // ("Quality score N/100" in services/validation.ts), V1 recorded 0–1.
  // Passing a 0–100 value through `pct` would print "9500%", so pick by
  // magnitude instead of assuming one scale.
  const scoreLabel = (n?: number | null) => (n == null ? "—" : n > 1 ? `${Math.round(n)}%` : pct(n));

  // A real model verdict is the ONLY thing that may read as a pass. It needs
  // both a score and evidence that a model actually answered.
  const reviewed = result != null && result.score != null && (model != null || status === "reviewed" || verdict != null);
  const realPass = reviewed && result!.passed && verdict !== "fail";

  // Deviation from this file's own documented trust-honesty invariant (see
  // the docblock above): requested explicitly, 2026-09-03, to hide this card
  // entirely when the platform has switched LLM review off, rather than
  // showing the "not enabled" honesty notice this card was originally built
  // to never omit. Every OTHER absent-evidence state below (unconfigured
  // provider, not sampled, pending, provider error) is intentionally left
  // showing — only the "administrator turned the feature off" case is now
  // silent. This is a real regression against the invariant this file's own
  // comment describes; flagging it here (and in the parity decision register) rather than
  // deleting the historical reasoning above.
  if (!result && llmEnabled === false) {
    return null;
  }

  const amber = "bg-amber-100 text-amber-700";
  let pill: { label: string; cls: string };
  let notice: string | null = null;

  if (!result) {
    // The whole point of this card: nothing was recorded at all.
    if (llmEnabled === false) {
      pill = { label: "not enabled", cls: amber };
      notice =
        "LLM quality review is switched off for this platform, so no model reviewed this item. It is NOT LLM-verified — this item's trust rests on the other stages and the human validator audit.";
    } else if (llmEnabled === true) {
      pill = { label: "not run", cls: amber };
      notice =
        "LLM quality review is enabled, but no review evidence was recorded for this item — it may not have reached this stage yet, or an earlier gate stopped the pipeline. It is NOT LLM-verified.";
    } else {
      pill = { label: "no evidence", cls: amber };
      notice =
        "No LLM review is recorded for this item, so it is NOT LLM-verified. Whether the platform's LLM stage is switched on is not reported to this page, so this card cannot tell you which of the two happened.";
    }
  } else if (status === "pending_llm_review") {
    pill = { label: "not configured", cls: amber };
    notice =
      reason ??
      "No LLM reviewer is configured in this environment, so the item is held for review and is NOT counted as LLM-verified.";
  } else if (status === "skipped_sampling") {
    pill = { label: "not sampled", cls: amber };
    notice =
      reason ??
      "The sampling policy did not select this item for machine review, so no LLM quality score was produced. It is NOT counted as LLM-verified.";
  } else if (!reviewed) {
    // Recorded, but no model answer: `provider_error`, a queued row, or any
    // future status this client has not been taught. Never a pass.
    pill = { label: status ? humanizeKey(status).toLowerCase() : "pending", cls: amber };
    notice =
      reason ??
      "This stage has not produced a reviewer decision yet, so the item is NOT counted as LLM-verified.";
  } else if (realPass) {
    pill = { label: "review pass", cls: "bg-[#eaf3d6] text-accent-strong" };
  } else if (verdict === "uncertain") {
    pill = { label: "uncertain", cls: amber };
  } else {
    pill = { label: "review fail", cls: "bg-[#fbe4e8] text-danger-strong" };
  }

  return (
    <div className={className}>
      {/* This card keeps its OWN pill: it is the one stage that must speak for
          an absent row (off / unconfigured / not sampled / provider error), and
          its "review pass" / "uncertain" / "review fail" wording is finer than
          the shared decoder's single label. Unchanged behaviour — the old
          `pillOverride` always won here anyway. */}
      <CardShell title="LLM review" pill={pill}>
        {reviewed ? (
          <>
            <Row
              label="overall quality"
              value={<span className={realPass ? "font-bold text-accent-strong" : "text-danger-strong"}>{scoreLabel(result!.score)}</span>}
            />
            {threshold != null && <Row label="pass threshold" value={scoreLabel(threshold)} />}
            <Row
              label="verdict"
              value={
                realPass ? (
                  <span className="text-accent-strong">passed the configured rubric</span>
                ) : verdict === "uncertain" ? (
                  <span className="text-amber-700">reviewer uncertain — escalated to validator audit</span>
                ) : (
                  <span className="text-danger-strong">did not meet the configured rubric</span>
                )
              }
            />
            {model && <Row label="reviewer model" value={<span className="break-all text-[11px] text-ink-faint">{model}</span>} />}
            {reasons.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 border-t border-line-soft pl-5 pt-3 text-[11.5px] leading-relaxed text-ink-soft">
                {reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
            {evidence && (
              <p className="mt-2 border-t border-line-soft pt-3 text-[11.5px] leading-relaxed text-ink-soft">{evidence}</p>
            )}
          </>
        ) : (
          <>
            {sampleRate != null && (
              <Row
                label="sampling rate"
                value={
                  <span className="text-amber-700">
                    {sampleRate}% of items reviewed{samplingMode ? ` (${humanizeKey(samplingMode).toLowerCase()} inspection)` : ""}
                  </span>
                }
              />
            )}
            {/* A row can carry a score without any evidence a model answered
                (no model, no status, no verdict). That is not a pass, but the
                stored number is still shown rather than denied. */}
            <Row
              label="quality score"
              value={
                result?.score != null ? (
                  <span className="text-amber-700">{scoreLabel(result.score)} — unverified reviewer</span>
                ) : (
                  <span className="text-amber-700">none recorded</span>
                )
              }
            />
            {notice && <p className="mt-2 border-t border-line-soft pt-3 text-[11.5px] leading-relaxed text-amber-700">{notice}</p>}
          </>
        )}
      </CardShell>
    </div>
  );
}

export function ExecutionProviderStrip({ result }: { result?: ApiValidationResult }) {
  if (!result) return null;
  const detail = (result.detailJson ?? {}) as Record<string, unknown>;
  const runner = typeof detail.runner === "string" ? detail.runner : null;
  const durationMs = typeof detail.durationMs === "number" ? detail.durationMs : null;

  return (
    <div className="flex flex-wrap items-center justify-between border-b border-dark-line bg-dark px-[18px] py-2 font-mono text-[11px] text-dark-soft">
      <span>{runner ? `environment: ${runner}` : "sandbox execution"}</span>
      {durationMs != null && <span>{durationMs}ms</span>}
    </div>
  );
}

export function ModalityCheckCard({
  filename,
  data,
  loading = false,
}: {
  filename: string;
  data: ArtifactProcessingEventsResponse | null;
  loading?: boolean;
}) {
  const events = data?.events ?? [];
  return (
    <div className="card px-5 py-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs font-bold text-ink">{filename}</span>
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">
          {loading ? "checking…" : data?.modality ?? "artifact"}
        </span>
      </div>
      {events.length > 0 ? (
        <div className="space-y-1.5 font-mono text-[11.5px]">
          {events.map((e) => (
            <div key={e.stage} className="flex items-center justify-between">
              <span className="text-ink-soft">{humanizeKey(e.stage)}</span>
              <span className={e.status === "passed" ? "text-accent-strong" : e.status === "failed" ? "text-danger-strong" : "text-amber-700"}>
                {e.status}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11.5px] text-ink-faint">{loading ? "Running checks…" : "No format-check events recorded."}</p>
      )}
    </div>
  );
}
