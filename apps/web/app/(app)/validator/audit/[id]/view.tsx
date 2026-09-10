"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DatasetContractPanel,
  resolveDatasetType,
} from "@/components/dataset-contract";
import { Icon } from "@/components/icons";
import { Button, CodeBlock, DetailHeader, Empty, PageHeader, Pill, Select } from "@/components/ui";
import { AutoRefreshControl } from "@/components/auto-refresh";
import { ArtifactList, SponsorReferenceExamples } from "@/components/artifacts";
import { LlmReviewCard } from "@/components/llm-review-card";
import { PublicationStatus } from "@/components/publication-status";
import { parseDatasetPublication } from "@/lib/publication";
import {
  AiAttributionEvidenceCard,
  DedupeEvidenceCard,
  LlmEvidenceCard,
} from "@/components/stage-evidence-cards";
import { useDemo } from "@/lib/store";
import { FLAG_REASON_LABELS, GENERATION_LABELS, num } from "@/lib/format";
import {
  claimAuditReal,
  getAuditDetail,
  llmScoreTo01,
  normalizeValidationStage,
  submissionDisplayFromApi,
  submitAuditDecisionReal,
  validationStageState,
  VALIDATION_STAGE_STATE_LABEL,
  type ApiSubmissionDetail,
  type ApiValidationResult,
  type AuditDetail,
  type ValidationStageState,
} from "@/lib/api-work";
import type { TypeField } from "@/lib/dataset-types";
import type { AuditBatch, AuditItem, FlagReason, Submission } from "@/lib/types";

const inputCls =
  "w-full rounded-lg border border-line bg-white px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none";

const AUDIT_FLAG_REASONS = [
  "duplicate",
  "contaminated",
  "tests_invalid",
  "solution_incorrect",
  "too_trivial",
  "low_quality",
  "off_spec",
  "other",
] as const;
type AuditFlagReason = (typeof AUDIT_FLAG_REASONS)[number];

const REJECT_NOTE_MIN = 10;

function StateMarker({
  decision,
  index,
}: {
  decision: AuditItem["decision"];
  index: number;
}) {
  if (decision === "ok") {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft">
        <Icon name="check" size={11} strokeWidth={3.5} className="text-success" />
      </span>
    );
  }
  if (decision === "flagged") {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-danger-soft">
        <Icon name="x" size={11} strokeWidth={3} className="text-danger-strong" />
      </span>
    );
  }
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-line-soft font-mono text-[10px] text-ink-soft">
      {index}
    </span>
  );
}

function executionLine(sub: Submission): string {
  const e = sub.execution;
  if (!e) return "no execution record";
  if (e.decision === "pending") return `execution not attempted/pending${e.reason ? ` — ${e.reason}` : ""}`;
  const testWord = `${e.testsRun} test${e.testsRun === 1 ? "" : "s"} run`;
  const brokenLabel =
    e.brokenCodeFailedTests === null
      ? "broken/fixed distinction not applicable"
      : e.brokenCodeFailedTests
        ? "broken code failed as expected"
        : "broken code did NOT fail (unexpected)";
  const fixedLabel = e.fixedCodePassedTests ? "fixed code passed" : "fixed code did NOT pass";
  return `${testWord} · ${brokenLabel} · ${fixedLabel} — ${e.decision}`;
}

const STAGE_LABELS: Record<string, string> = {
  dedupe: "Duplicate check",
  ai_attribution: "AI attribution",
  execution: "Sandbox execution",
  llm: "LLM validation",
};

type StageTone = "green" | "red" | "amber" | "neutral";

/** Tone per decoded state. `review_fail` is red like a real failure — the LLM
 *  verdict genuinely failed — while `flagged` stays amber, because an escalated
 *  item is still being carried forward to a human, not rejected. */
const STATE_TONE: Record<ValidationStageState, StageTone> = {
  passed: "green",
  failed: "red",
  flagged: "amber",
  review_fail: "red",
  hold: "amber",
};

function deriveStageState(
  stage: string,
  result: ApiValidationResult | undefined,
  configured: boolean,
): { label: string; tone: StageTone } {
  if (!result) {
    return configured
      ? { label: "not reached yet", tone: "neutral" }
      : { label: "not configured", tone: "neutral" };
  }
  const detail = (result.detailJson ?? {}) as Record<string, unknown>;
  const status = typeof detail.status === "string" ? detail.status : undefined;
  // `llm` stores its score 0–100 while dedupe/execution store 0–1, so the bare
  // `score * 100` here printed a real llm score of 45 as "4500%". The same fix
  // already landed in sponsor-submission-detail.tsx; `llmScoreTo01` is the one
  // shared normalizer, so the same score now prints the same number on both.
  const scoreNote = result.score != null ? ` · ${Math.round(llmScoreTo01(result.score) * 100)}%` : "";

  // Classification is DELEGATED to the one shared decoder rather than
  // re-derived here. This page's private copy got `dedupe` review_required and
  // `ai_attribution` flagged right but had no `llm` arm at all, so an
  // `llm_fail` row fell through to the generic "score present ⇒ failed" line
  // and rendered a red "failed" for a verdict that gates nothing (the API
  // "never changes the accept/reject OUTCOME") — while the sponsor drawer
  // printed "review fail" for that identical row. It also read a terminal
  // `pool_capacity` rejection (score null) as "pending / blocked".
  const state = validationStageState(result);

  // Only the wording is kept local: the decoder collapses every never-ran case
  // to one "hold", and this page has the repo's most precise per-status copy.
  if (state === "hold") {
    switch (status) {
      case "not_attempted":
        return { label: "not attempted", tone: "neutral" };
      case "queued":
        return { label: "queued", tone: "neutral" };
      case "skipped_sampling":
        return { label: "skipped — not sampled", tone: "neutral" };
      case "pending_llm_review":
        return { label: "awaiting model review", tone: "amber" };
      case "no_provider_configured":
      case "all_providers_failed":
      case "no_executable_harness":
      case "requires_configured_corpus":
      case "requires_healthy_corpus":
        return { label: "not configured", tone: "neutral" };
      default:
        return { label: VALIDATION_STAGE_STATE_LABEL.hold, tone: "amber" };
    }
  }

  const tone = STATE_TONE[state];
  // A passing attribution check found nothing to disclose — "passed" would read
  // as "this item is AI-attributed and that's fine". Kept from the old copy.
  if (state === "passed" && stage === "ai_attribution") return { label: "no attribution found", tone };
  // Which duplicate this was is the whole point of a dedupe rejection; the
  // stage's other terminal failures keep the plain label.
  if (state === "failed" && stage === "dedupe" && detail.duplicateDecision === "rejected") {
    return { label: `failed — duplicate${scoreNote}`, tone };
  }
  // The attribution likelihood is a fixed 1 on a flagged row, so appending
  // "· 100%" there would only look like a confidence claim. Every other state
  // carries its real score.
  const showScore = !(state === "flagged" && stage === "ai_attribution");
  return { label: `${VALIDATION_STAGE_STATE_LABEL[state]}${showScore ? scoreNote : ""}`, tone };
}

function StageMatrix({
  results,
  configuredStages,
  executionNote,
  llmValidationEnabled,
}: {
  results: ApiValidationResult[];
  configuredStages: string[];
  executionNote?: string;
  llmValidationEnabled?: boolean;
}) {
  const latest = new Map<string, ApiValidationResult>();
  for (const r of results) latest.set(normalizeValidationStage(r.stage), r);
  const configured = new Set(configuredStages);
  const order = ["dedupe", "ai_attribution", "execution", "llm"];
  // Deviation requested 2026-09-03 (owner-approved deviation, recorded in the parity decision register): `llm` is also
  // dropped here when the platform reports it explicitly off and this item
  // has no llm evidence of its own — matches the same-day change to the
  // contributor and sponsor submission views.
  const stages = order.filter(
    (s) => {
      if (s === "llm" && llmValidationEnabled === false && !latest.has("llm")) return false;
      return s === "dedupe" || configured.has(s) || latest.has(s);
    },
  );

  const toneCls: Record<StageTone, string> = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    red: "border-rose-200 bg-rose-50 text-rose-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    neutral: "border-line bg-panel text-ink-soft",
  };

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-line">
      <div className="border-b border-line-soft bg-panel px-3 py-2">
        <div className="micro-label text-ink-faint">validation pipeline</div>
      </div>
      <div className="divide-y divide-line-soft">
        {stages.map((stage) => {
          const state = deriveStageState(stage, latest.get(stage), configured.has(stage));
          const note = stage === "execution" ? executionNote : undefined;
          return (
            <div key={stage} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink">{STAGE_LABELS[stage] ?? stage}</div>
                {note && <div className="mt-0.5 font-mono text-[11px] text-ink-soft">{note}</div>}
              </div>
              <span
                className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium ${toneCls[state.tone]}`}
              >
                {state.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.some((item) => item !== null && typeof item === "object")
      ? JSON.stringify(value, null, 2)
      : value.map(String).join("\n");
  }
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * One audit item as this page reads it. `decidedAt` is the API's own
 * `AuditItem.decidedAt` (ISO string, or null while undecided) and is declared
 * here rather than on the shared `AuditDetail` because the audit payload is
 * still rolling it out — an older build sends no such field at all, which is
 * why every read below treats `undefined` (field absent) differently from
 * `null` (field present, nothing decided).
 *
 * `verdictSource` is the API's own honesty signal for a window with no linked
 * `AuditBatch` (every window closed before that alignment — see
 * services/audits.ts's `isDecidedAuditItem` doc and
 * docs/engineering/VALIDATOR_PLAN.md's "Audit verdicts" section): `verdict`
 * there is legitimately decided but reconstructed from `Submission.status`,
 * and NO real `decidedAt` exists to report for it while the window itself is
 * still `in_progress` (unsettled) — the API sends `decidedAt: null` in that
 * exact case because inventing a timestamp would be worse than omitting one.
 */
type AuditDetailItem = AuditDetail["items"][number] & {
  decidedAt?: string | null;
  verdictSource?: "audit_item" | "derived_from_status" | null;
};

/**
 * A decision needs a verdict the server actually vetted — not necessarily a
 * timestamp alongside it.
 *
 * `verdict` alone used to be an overloaded sentinel — this one value drives
 * the item-rail markers, the four footer counts, `allDecided`, and the "this
 * decision is final" banner, so a verdict present without a committed
 * decision would have shown a validator a closed, final-looking item with its
 * Approve/Reject controls already gone. Requiring `decidedAt` alongside it
 * fixed that — but then over-corrected: for a legacy (no-`AuditBatch`) window
 * that is still `in_progress`, a genuinely decided item's `decidedAt` is
 * honestly `null` (no real timestamp exists yet — the window hasn't settled),
 * so this page showed "0 of 4 reviewed" on a window where item 1 was already
 * `accepted`, with live Approve/Reject buttons the server correctly refuses
 * (400 "This item has already been decided" — confirmed live, no side
 * effect, but a dead-end control is still a real defect).
 *
 * `verdictSource` is exactly the signal the API computed to distinguish
 * these: when present, the server has already decided whether this verdict is
 * real, so trust `verdict` alone. Only fall back to the dual-field rule for a
 * payload shape that predates `verdictSource` entirely (`undefined`, not
 * `null` — the field is genuinely absent, not "no source").
 */
function itemDecision(item: AuditDetailItem): AuditItem["decision"] {
  const decided =
    item.verdictSource !== undefined
      ? item.verdict != null
      : item.decidedAt === undefined
        ? item.verdict != null
        : item.verdict != null && item.decidedAt != null;
  if (!decided) return "pending";
  return item.verdict === "ok" ? "ok" : item.verdict === "flagged" ? "flagged" : "pending";
}

function codeLikeField(field: TypeField): boolean {
  return ["input_code", "solution_code", "tests", "expected_output"].includes(field.role);
}

export default function AuditReviewView() {
  const params = useParams<{ id: string }>();
  const { pushToast } = useDemo();
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionSaving, setDecisionSaving] = useState(false);
  const decisionLockRef = useRef(false);
  // Auto-refresh: v1 has no equivalent on this specific page (checked —
  // neither app polls the validator audit view), but every other detail page
  // in this app (contributor submission, sponsor submission, karma) has one
  // via the shared `AutoRefreshControl`, and this page can go stale exactly
  // the same way — another validator's window can close underneath the
  // viewer, or a contributor can submit a fix, while this one sits open.
  // Added 2026-09-03 on request. Silent: never touches `loading`/`detail`
  // reset, so an in-progress decision or open item selection is undisturbed.
  const [refreshing, setRefreshing] = useState(false);
  // Defense-in-depth: the list page claims before it ever links here, but a
  // stale bookmark, a browser back/forward, or a genuine race can still land
  // someone on an unclaimed audit, where GET /v1/audits/:id 409s with "claim
  // the audit before viewing submission evidence". Rather than leaving that
  // as a dead "Try again" loop, offer the real claim action right here.
  const [claiming, setClaiming] = useState(false);

  const audit: AuditBatch | undefined = useMemo(
    () =>
      detail
        ? {
            id: detail.id,
            bountyId: detail.bountyId,
            bountyTitle: detail.bounty.title,
            itemCount: detail.itemCount,
            karmaReward: detail.karmaReward ?? 0,
            deadline: detail.deadline ?? "",
            status: detail.status as AuditBatch["status"],
            items: detail.items.map((item) => ({
              id: item.id,
              submissionId: item.submissionId,
              decision: itemDecision(item),
              flagReason: item.flagReason as FlagReason | undefined,
              notes: item.note ?? undefined,
            })),
            category: detail.bounty.category,
            language: detail.bounty.language,
            kind: "community",
          }
        : undefined,
    [detail]
  );
  const datasetType = detail?.bounty.datasetType ?? (audit ? resolveDatasetType({ category: audit.category }) : null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState<AuditFlagReason | "">("");
  const [note, setNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    getAuditDetail(params.id as string)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Couldn’t reach the server.";
          setLoadError(message);
          pushToast({
            variant: "error",
            title: message,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params.id, pushToast, loadAttempt]);

  // Silent background refresh for AutoRefreshControl: never flips `loading`
  // (which would blank the page back to the skeleton) and never clears
  // `detail`/`selectedId` on failure, so a transient network error during a
  // poll tick doesn't discard whatever the validator is looking at. Failures
  // are swallowed rather than toasted — an interval tick failing quietly is
  // preferable to a toast firing every N seconds while offline.
  const refreshAuditSilently = async () => {
    setRefreshing(true);
    try {
      const next = await getAuditDetail(params.id as string);
      setDetail(next);
    } catch {
      // swallow — see comment above
    } finally {
      setRefreshing(false);
    }
  };

  const handleClaimHere = async () => {
    if (claiming) return;
    setClaiming(true);
    try {
      const claimed = await claimAuditReal(params.id as string);
      if (!claimed) {
        pushToast({
          variant: "error",
          title: "Audit claim failed",
          body: "This audit may already be claimed, or you may not be eligible (you can't audit your own submissions).",
        });
        return;
      }
      // Refetch instead of navigating — the window is now ours, so the same
      // GET that just 409'd will succeed.
      setLoading(true);
      setLoadError(null);
      setDetail(null);
      setLoadAttempt((value) => value + 1);
    } finally {
      setClaiming(false);
    }
  };

  const rows = useMemo(() => {
    if (!audit || !detail) return [];
    return audit.items
      .map((item) => {
        const real = detail?.items.find((candidate) => candidate.id === item.id);
        return {
          item,
          apiSubmission: real?.submission,
          attachments: real?.attachments ?? [],
          validationLogs: real?.validationLogs ?? [],
          submission: real
            ? submissionDisplayFromApi(real.submission, {
                language: detail.bounty.language,
                framework: detail.bounty.framework,
                reward: detail.karmaReward ?? 0,
              })
            : undefined,
        };
      })
      .filter(
        (
          r
        ): r is {
          item: AuditItem;
          submission: Submission;
          apiSubmission: ApiSubmissionDetail | undefined;
          attachments: NonNullable<AuditDetail["items"][number]["attachments"]>;
          validationLogs: NonNullable<AuditDetail["items"][number]["validationLogs"]>;
        } => !!r.submission
      );
  }, [audit, detail]);

  if (loading) {
    return (
      <>
        <PageHeader title="Audit batch" />
        <Empty>Loading audit details...</Empty>
      </>
    );
  }

  if (!audit) {
    if (loadError) {
      return (
        <>
          <PageHeader title="Audit batch" />
          <Empty
            icon="alert"
            title="Couldn’t load this audit"
            description={loadError}
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {/* Most 409s here mean nobody has claimed this window yet
                    (stale bookmark, back/forward, or a genuine race with
                    another validator) — offer the real fix, not just a retry
                    that will 409 again. */}
                <button
                  type="button"
                  disabled={claiming}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 font-mono text-xs font-semibold text-white hover:bg-ink-light disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void handleClaimHere()}
                >
                  {claiming ? "Claiming…" : "Claim this audit"}
                </button>
                <button
                  type="button"
                  disabled={claiming}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 font-mono text-xs font-semibold text-ink hover:bg-panel disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    setLoading(true);
                    setLoadError(null);
                    setDetail(null);
                    setLoadAttempt((value) => value + 1);
                  }}
                >
                  Try again
                </button>
              </div>
            }
          />
        </>
      );
    }
    return (
      <>
        <PageHeader title="Audit batch" />
        <Empty
          icon="alert"
          title="Audit batch not found"
          description="This audit doesn't exist, is already settled, or contains a submission you authored yourself — validators can never audit their own work. Open a different one from the Validator dashboard."
          action={
            <Link
              href="/validator"
              className="inline-flex items-center gap-1.5 font-mono text-sm font-medium text-ink hover:underline"
            >
              Back to Validator dashboard
              <Icon name="arrow-right" size={14} />
            </Link>
          }
        />
      </>
    );
  }

  const total = rows.length;
  const decidedCount = rows.filter((r) => r.item.decision !== "pending").length;
  const approvedCount = rows.filter((r) => r.item.decision === "ok").length;
  const rejectedCount = rows.filter((r) => r.item.decision === "flagged").length;
  const pendingCount = total - decidedCount;
  const allDecided = total > 0 && decidedCount === total;
  const completed = audit.status === "completed";

  const currentIndex = Math.max(
    0,
    selectedId ? rows.findIndex((r) => r.item.id === selectedId) : 0
  );
  const current = rows[currentIndex];

  const goto = (index: number) => {
    const clamped = Math.min(Math.max(index, 0), total - 1);
    const next = rows[clamped];
    if (next) {
      setSelectedId(next.item.id);
      setReason("");
      setNote("");
    }
  };

  const advanceToNextUndecided = (fromIndex: number) => {
    for (let i = fromIndex + 1; i < total; i++) {
      if (rows[i].item.decision === "pending") return goto(i);
    }
    for (let i = 0; i < fromIndex; i++) {
      if (rows[i].item.decision === "pending") return goto(i);
    }
    setReason("");
    setNote("");
  };

  const handleDecisionError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : "Decision failed";
    setDecisionError(msg);
    pushToast({ variant: "error", title: msg });
  };

  // Applied immediately once the decision-submit call itself has succeeded —
  // independent of whatever happens to the follow-up `getAuditDetail` refetch
  // below. Without this, a failed refetch left `detail` (and therefore
  // `current.item.decision`) untouched, so the just-decided item kept
  // rendering as "pending": no confirmation banner, and — worse — its
  // Approve/Reject controls stayed live, so re-selecting it from the item
  // rail invited a second decision on a submission the server already closed
  // out. Patching the local item's verdict here means the UI reflects the
  // real, already-committed outcome even if the refetch never lands.
  const applyOptimisticDecision = (
    itemId: string,
    verdict: "ok" | "flagged",
    flagReason?: AuditFlagReason,
    note?: string
  ) => {
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.id === itemId
                ? {
                    ...it,
                    verdict,
                    // Stamped alongside the verdict because a decision is now
                    // read as verdict AND `decidedAt` (see `itemDecision`).
                    // Setting only the verdict would leave the just-committed
                    // item rendering as pending — exactly the state this
                    // optimistic patch exists to prevent. The server HAS
                    // recorded it by this point; the refetch below replaces
                    // this with the authoritative timestamp.
                    decidedAt: new Date().toISOString(),
                    flagReason: flagReason ?? it.flagReason,
                    note: note ?? it.note,
                  }
                : it
            ),
          }
        : prev
    );
  };

  const approve = async () => {
    if (!current || decisionSaving || decisionLockRef.current) return;
    decisionLockRef.current = true;
    setDecisionError(null);
    setDecisionSaving(true);
    try {
      await submitAuditDecisionReal({ auditId: audit.id, auditItemId: current.item.id, verdict: "ok" });
      applyOptimisticDecision(current.item.id, "ok");
      try {
        const next = await getAuditDetail(audit.id);
        if (next) setDetail(next);
      } catch {
        pushToast({
          variant: "info",
          title: "Approved. Rest of this page may be stale — reload to refresh the full view.",
        });
      }
      advanceToNextUndecided(currentIndex);
    } catch (err) {
      handleDecisionError(err);
    } finally {
      setDecisionSaving(false);
      decisionLockRef.current = false;
    }
  };

  const rejectNote = note.trim();
  const rejectNoteMissing = rejectNote.length < REJECT_NOTE_MIN;
  const rejectBlocked = reason === "" || rejectNoteMissing;
  const rejectHint =
    reason === ""
      ? "Pick a reason, then add a note so the contributor can fix it."
      : rejectNoteMissing
        ? `Add a reason so the contributor can fix it — at least ${REJECT_NOTE_MIN} characters.`
        : null;

  const confirmReject = async () => {
    if (!current || rejectBlocked || decisionSaving || decisionLockRef.current) return;
    decisionLockRef.current = true;
    setDecisionError(null);
    setDecisionSaving(true);
    try {
      await submitAuditDecisionReal({
        auditId: audit.id,
        auditItemId: current.item.id,
        verdict: "flagged",
        flagReason: reason,
        note: rejectNote,
      });
      applyOptimisticDecision(current.item.id, "flagged", reason, rejectNote);
      try {
        const next = await getAuditDetail(audit.id);
        if (next) setDetail(next);
      } catch {
        pushToast({
          variant: "info",
          title: "Rejected. Rest of this page may be stale — reload to refresh the full view.",
        });
      }
      advanceToNextUndecided(currentIndex);
    } catch (err) {
      handleDecisionError(err);
    } finally {
      setDecisionSaving(false);
      decisionLockRef.current = false;
    }
  };

  const publication =
    parseDatasetPublication(detail?.publication) ??
    parseDatasetPublication(detail?.poolSummary?.publication) ??
    parseDatasetPublication(detail?.bounty.poolSummary?.publication);

  if (completed) {
    return (
      <>
        <AuditHeader
          audit={audit}
          decided={decidedCount}
          total={total}
          karmaReward={detail?.karmaReward}
          onRefresh={refreshAuditSilently}
          refreshing={refreshing}
          pollingEnabled={false}
        />
        <PublicationStatus publication={publication} className="mb-5" />
        <div className="card px-6 py-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-success-soft text-success">
            <Icon name="check" size={22} />
          </div>
          <h2 className="mt-3 font-mono text-base font-bold">Audit complete</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-soft">
            Your karma for this audit is already in your balance. Rejected items return to their contributors for revision.
          </p>
          <Link
            href="/validator"
            className="mt-4 inline-flex items-center gap-1.5 font-mono text-sm font-medium text-ink hover:underline"
          >
            Back to Validator dashboard
            <Icon name="arrow-right" size={14} />
          </Link>
        </div>
      </>
    );
  }

  const sub = current?.submission;

  return (
    <>
      <AuditHeader
        audit={audit}
        decided={decidedCount}
        total={total}
        karmaReward={detail?.karmaReward}
        onRefresh={refreshAuditSilently}
        refreshing={refreshing}
        pollingEnabled={audit.status !== "submitted"}
      />

      <PublicationStatus publication={publication} className="mb-5" />

      {detail?.contributorBatch && (
        <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-lime-200 bg-lime-50/30 px-4 py-3 text-xs text-ink-soft">
          <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent-strong" />
          <div>
            <span className="font-semibold text-ink">Contributor Batch Progress:</span>{" "}
            {detail.contributorBatch.submittedCount < detail.contributorBatch.itemCount ? (
              <span>
                {detail.contributorBatch.submittedCount} of {detail.contributorBatch.itemCount} items submitted ({detail.contributorBatch.itemCount - detail.contributorBatch.submittedCount} remaining). You are auditing the {total} item{total === 1 ? "" : "s"} submitted so far.
              </span>
            ) : (
              <span>All {detail.contributorBatch.itemCount} items submitted.</span>
            )}
          </div>
        </div>
      )}

      {datasetType && (
        <DatasetContractPanel
          type={datasetType}
          audience="validator"
          className="mb-5"
        />
      )}

      {detail?.sponsorReferences && detail.sponsorReferences.length > 0 && (
        <SponsorReferenceExamples artifacts={detail.sponsorReferences} type={datasetType} />
      )}

      {decisionError && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 font-mono text-xs text-rose-700">
          {decisionError}
        </div>
      )}

      {/* Narrow-screen chip strip */}
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
        {rows.map((r, i) => {
          const active = r.item.id === current?.item.id;
          return (
            <button
              key={r.item.id}
              onClick={() => goto(i)}
              className={`flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-[12px] transition-colors ${
                active
                  ? "border-l-4 border-line border-l-lime bg-brand-soft font-bold text-ink"
                  : "border-line bg-white text-ink-soft hover:bg-panel"
              }`}
            >
              <StateMarker decision={r.item.decision} index={i + 1} />
              {i + 1}
            </button>
          );
        })}
      </div>

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        {/* Left rail — item list (desktop) */}
        <aside className="hidden lg:block">
          <div className="micro-label mb-2 text-ink-faint">items</div>
          <div className="space-y-1.5">
            {rows.map((r, i) => {
              const active = r.item.id === current?.item.id;
              return (
                <button
                  key={r.item.id}
                  onClick={() => goto(i)}
                  className={`flex w-full items-center gap-2.5 rounded-lg border py-2 pl-3 pr-2.5 text-left transition-colors ${
                    active
                      ? "border-l-4 border-line border-l-lime bg-brand-soft"
                      : "border-line bg-white hover:bg-panel"
                  }`}
                >
                  <StateMarker decision={r.item.decision} index={i + 1} />
                  <span
                    className={`min-w-0 flex-1 truncate text-[13px] ${
                      active ? "font-semibold text-ink" : "text-ink-soft"
                    }`}
                  >
                    {r.submission.title}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Main pane — one selected item */}
        <div>
          {sub && current && (
            <div className="card px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="micro-label text-ink-faint">
                    item {currentIndex + 1} of {total}
                  </div>
                  <h2 className="mt-1 text-[17px] font-bold leading-snug">
                    {sub.title}
                  </h2>
                </div>
                <Pill
                  tone={sub.generationMethod === "human" ? "neutral" : "info"}
                >
                  {GENERATION_LABELS[sub.generationMethod]}
                </Pill>
              </div>

              {current.attachments.length > 0 && (
                <div className="mt-4">
                  <div className="micro-label mb-2 text-ink-faint">Contributor attachments</div>
                  <ArtifactList artifacts={current.attachments} />
                </div>
              )}
              {current.validationLogs.length > 0 && (
                <div className="mt-4">
                  <div className="micro-label mb-2 text-ink-faint">Sandbox validation logs</div>
                  <ArtifactList artifacts={current.validationLogs} />
                </div>
              )}

              <StageMatrix
                results={current.apiSubmission?.validationResults ?? []}
                configuredStages={datasetType?.verification.pipeline ?? []}
                executionNote={sub.execution ? executionLine(sub) : undefined}
                llmValidationEnabled={current.apiSubmission?.llmValidationEnabled}
              />

              {(() => {
                const latestByStage = new Map<string, ApiValidationResult>();
                for (const r of current.apiSubmission?.validationResults ?? []) {
                  latestByStage.set(normalizeValidationStage(r.stage), r);
                }
                return (
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    <DedupeEvidenceCard result={latestByStage.get("dedupe")} />
                    <AiAttributionEvidenceCard result={latestByStage.get("ai_attribution")} />
                    {/* Rendered even with no `llm` row — an auditor deciding this
                        item must be told the machine review never happened, not
                        shown an absent card. `llmValidationEnabled` is passed
                        straight through, so it is `undefined` (and reported as
                        "not reported") whenever the API omits it. */}
                    <LlmEvidenceCard
                      result={latestByStage.get("llm")}
                      llmEnabled={current.apiSubmission?.llmValidationEnabled}
                    />
                  </div>
                );
              })()}

              {sub.llmReview && <LlmReviewCard review={sub.llmReview} className="mt-4" />}

              {datasetType && current.apiSubmission ? (
                <div className="mt-4 space-y-3">
                  {datasetType.fields.map((field) => {
                    const text = displayValue(current.apiSubmission?.payloadJson?.[field.key]);
                    return codeLikeField(field) ? (
                      <CodeBlock
                        key={field.key}
                        code={text || "// empty"}
                        label={`${field.key} — ${field.label}`}
                      />
                    ) : (
                      <div key={field.key}>
                        <div className="micro-label mb-1.5 text-ink-faint">
                          {field.key} — {field.label}
                        </div>
                        <p className="break-words rounded-lg border border-line-soft bg-panel px-3 py-2 text-[13px] leading-relaxed text-ink-soft">
                          {text || "empty"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <>
                  <div className="mt-4">
                    <div className="micro-label mb-1.5 text-ink-faint">prompt</div>
                    <p className="text-[13.5px] leading-relaxed">{sub.prompt}</p>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <CodeBlock
                      code={sub.brokenCode}
                      label="broken_code — must FAIL tests"
                      tone="danger"
                    />
                    <CodeBlock
                      code={sub.fixedCode}
                      label="fixed_code — must PASS tests"
                      tone="success"
                    />
                  </div>
                  <CodeBlock className="mt-3" code={sub.tests} label="tests" />

                  {sub.explanation && (
                    <div className="mt-4">
                      <div className="micro-label mb-1.5 text-ink-faint">
                        explanation
                      </div>
                      <p className="text-[13px] leading-relaxed text-ink-soft">
                        {sub.explanation}
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* Current decision state */}
              {current.item.decision === "ok" && (
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-success-border bg-success-soft px-3.5 py-2.5 font-mono text-[12px] text-success">
                  <Icon name="check" size={14} strokeWidth={2.5} />
                  approved and saved — this decision is final
                </div>
              )}
              {current.item.decision === "flagged" && (
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-danger-border bg-danger-soft px-3.5 py-2.5 font-mono text-[12px] text-danger-strong">
                  <Icon name="x" size={14} strokeWidth={2.5} />
                  rejected:{" "}
                  {FLAG_REASON_LABELS[current.item.flagReason ?? "other"]} — saved
                </div>
              )}

              {/* Actions */}
              <div className="mt-4 border-t border-line-soft pt-4">
                {current.item.decision === "pending" && (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      variant="success"
                      size="lg"
                      disabled={decisionSaving}
                      onClick={approve}
                    >
                      <Icon name="check" size={15} strokeWidth={2.5} />
                      {decisionSaving ? "Saving…" : "Approve item"}
                    </Button>
                  </div>
                )}

                {current.item.decision === "pending" && (
                  <div className="mt-3.5 space-y-2.5 rounded-lg border border-line bg-panel px-4 py-3.5">
                    <div>
                      <label className="mb-1 block font-mono text-[11px] font-medium text-ink">
                        flag reason
                      </label>
                      <Select
                        value={reason}
                        aria-label="Flag reason"
                        onChange={(e) =>
                          setReason(e.target.value as AuditFlagReason | "")
                        }
                      >
                        <option value="" disabled>
                          Select a reason…
                        </option>
                        {AUDIT_FLAG_REASONS.map(
                          (value) => (
                            <option key={value} value={value}>
                              {FLAG_REASON_LABELS[value]}
                            </option>
                          )
                        )}
                      </Select>
                    </div>
                    <div>
                      <label
                        htmlFor="reject-note"
                        className="mb-1 block font-mono text-[11px] font-medium text-ink"
                      >
                        note (required)
                      </label>
                      <textarea
                        id="reject-note"
                        className={inputCls}
                        rows={2}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="What should the contributor fix?"
                        required
                        aria-describedby="reject-note-hint"
                        aria-invalid={rejectNoteMissing || undefined}
                      />
                    </div>
                    <p
                      id="reject-note-hint"
                      aria-live="polite"
                      className={`font-mono text-[11px] leading-relaxed ${rejectHint ? "text-amber-700" : "text-ink-faint"}`}
                    >
                      {rejectHint ??
                        "The contributor sees this note with the rejection — it is the only thing telling them what to change."}
                    </p>
                    <Button
                      size="lg"
                      variant="danger"
                      disabled={rejectBlocked || decisionSaving}
                      aria-describedby="reject-note-hint"
                      onClick={confirmReject}
                    >
                      <Icon name="x" size={15} strokeWidth={2.5} />
                      {decisionSaving ? "Saving…" : "Reject item"}
                    </Button>
                  </div>
                )}

                {/* Prev / Next */}
                <div className="mt-4 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={currentIndex === 0 || decisionSaving}
                    onClick={() => goto(currentIndex - 1)}
                    className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-3 py-1.5 font-mono text-xs font-semibold text-ink hover:bg-panel disabled:opacity-40"
                  >
                    <Icon
                      name="chevron-right"
                      size={13}
                      className="rotate-180"
                    />
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={currentIndex === total - 1 || decisionSaving}
                    onClick={() => goto(currentIndex + 1)}
                    className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-3 py-1.5 font-mono text-xs font-semibold text-ink hover:bg-panel disabled:opacity-40"
                  >
                    Next
                    <Icon name="chevron-right" size={13} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sticky footer */}
      <div className="sticky bottom-0 z-20 mt-6 -mx-4 border-t border-dark-line bg-dark px-4 py-3.5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-mono text-xs text-dark-soft">
            {allDecided ? (
              <span className="flex items-center gap-1.5 text-lime">
                <Icon name="check" size={14} />
                All {total} decisions recorded — this audit closes automatically
              </span>
            ) : (
              <span>{pendingCount} item{pendingCount === 1 ? "" : "s"} left · each decision saves immediately</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            <span className="rounded-full border border-emerald-700/60 px-2.5 py-1 text-emerald-300">{approvedCount} approved</span>
            <span className="rounded-full border border-rose-700/60 px-2.5 py-1 text-rose-300">{rejectedCount} rejected</span>
            <span className="rounded-full border border-dark-line px-2.5 py-1 text-dark-soft">{pendingCount} pending</span>
            <span className="ml-1 text-lime font-mono">
              +{num((detail?.karmaReward ?? 0) * total)} karma on completion
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

function AuditHeader({
  audit,
  decided,
  total,
  karmaReward,
  onRefresh,
  refreshing = false,
  pollingEnabled = true,
}: {
  audit: AuditBatch;
  decided: number;
  total: number;
  karmaReward?: number | null;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  pollingEnabled?: boolean;
}) {
  return (
    <DetailHeader
      backHref="/validator"
      backLabel="Validator dashboard"
      title={`Audit: ${audit.bountyTitle}`}
      meta={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-ink-soft">
          {audit.deadline && (
            <>
              <span className="flex items-center gap-1.5">
                <Icon name="clock" size={12} />
                {audit.deadline}
              </span>
              <span aria-hidden>·</span>
            </>
          )}
          <span className="font-bold text-karma">+{num(karmaReward ?? 0)} karma / item</span>
          <span aria-hidden>·</span>
          <span>up to +{num((karmaReward ?? 0) * total)} karma for this audit</span>
        </div>
      }
      right={
        <div className="flex items-center gap-2">
          {onRefresh && (
            <AutoRefreshControl
              onRefresh={onRefresh}
              refreshing={refreshing}
              enabled={pollingEnabled}
            />
          )}
          <span className="font-mono text-xs text-ink-soft">
            {decided} of {total} reviewed
          </span>
        </div>
      }
    />
  );
}
