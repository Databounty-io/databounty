"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { AdminButton, AdminConfirmDialog, AdminErrorBanner, AdminPageHeader, AdminPill } from "@/components/admin-shell";
import { AdminPagination } from "@/components/admin-filter-bar";
import { useAdminToast } from "@/lib/admin-toast";
import { Icon } from "@/components/icons";
import { FLAG_REASON_LABELS } from "@/lib/format";
import {
  formatStageScore,
  normalizeValidationStage,
  validationStageState,
  VALIDATION_STAGE_STATE_LABEL,
} from "@/lib/validation-state";
import { API_URL } from "@/lib/urls";

interface DisputeArtifact {
  id: string;
  filename: string;
  status: string;
  downloadUrl: string;
}

interface DisputeEvidence {
  payloadJson: Record<string, unknown>;
  status: string;
  revisionCount: number;
  scores: { duplicate: number | null; llm: number | null };
  validationResults: Array<{ id: string; stage: string; passed: boolean; score: number | null; detailJson?: unknown }>;
  revisions: Array<{ id: string; revisionNumber: number; status: string; payloadJson: unknown; validationEvidence: unknown }>;
  flags: Array<{ id: string; reason: string; details?: string | null; status: string; createdAt?: string; validatorUserId?: string | null; validatorLabel?: string | null }>;
  // Mirrors the AuditItem model: the written reason is `note`, and the reason
  // code is `flagReason`. There is no `reason` field — the previous shape
  // declared one, so any render of it would have produced `undefined`.
  auditDecisions: Array<{
    id: string;
    verdict?: string | null;
    flagReason?: string | null;
    note?: string | null;
    decidedAt?: string | null;
    validatorUserId?: string | null;
    validatorLabel?: string | null;
    auditBatch: { id: string; validatorUserId: string | null; status: string };
  }>;
  artifacts: DisputeArtifact[];
}

interface ApiDispute {
  id: string;
  bountyId?: string | null;
  submissionId?: string | null;
  bountyTitle: string;
  submissionTitle: string;
  flagReason: string;
  contributorArgument: string;
  validatorArgument: string;
  status: "open" | "resolved";
  resolution?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
  bounty?: { id: string; title: string } | null;
  evidence?: DisputeEvidence | null;
}

type PipelineResult = DisputeEvidence["validationResults"][number];

/**
 * One row per STAGE, not one row per recorded attempt. `validationResults`
 * arrives with every `validationAttempt` generation of every stage, ordered
 * `createdAt: desc` — so a resubmitted item rendered the same stage two or
 * three times, and the reader had no way to tell which row was current.
 * First-wins over a newest-first list keeps the latest attempt per stage,
 * matching what the API's own stage builders do.
 */
function latestResultPerStage(results: PipelineResult[]): PipelineResult[] {
  const latest = new Map<string, PipelineResult>();
  for (const result of results) {
    const stage = normalizeValidationStage(result.stage);
    if (!latest.has(stage)) latest.set(stage, result);
  }
  return Array.from(latest.values());
}

/**
 * `passed ? "passed" : "failed"` was wrong for three of the four states this
 * sentinel encodes: the score guard gated only the ` · 0.92` suffix, so a stage
 * that never ran (`score == null`) still rendered as a red "failed", and an
 * escalation (ai_attribution flagged, dedupe review_required) rendered the same
 * way as a terminal rejection. Decoded through the shared contract instead.
 * This payload carries `detailJson` but no `outcome`; `pool_capacity` is still
 * caught by its stage name, and the two outcome-less stages are the ones that
 * can only be read from `detailJson` anyway.
 */
function PipelineResultRow({ result }: { result: PipelineResult }) {
  const state = validationStageState({
    stage: result.stage,
    passed: result.passed,
    score: result.score,
    detailJson: (result.detailJson ?? null) as Record<string, unknown> | null,
  });
  const score = formatStageScore(result.stage, result.score);
  const tone =
    state === "passed" ? "text-emerald-400" : state === "flagged" || state === "hold" ? "text-amber-400" : "text-rose-300";
  return (
    <div className="flex items-center justify-between rounded border border-dark-line px-3 py-2 font-mono text-[11px] text-dark-muted">
      <span>{normalizeValidationStage(result.stage).replaceAll("_", " ")}</span>
      <span className={tone}>
        {VALIDATION_STAGE_STATE_LABEL[state]}
        {score == null ? "" : ` · ${score}`}
      </span>
    </div>
  );
}

async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
}

type DisputeStatusFilter = "open" | "resolved" | "all";

const STATUS_FILTERS: { value: DisputeStatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

/** 25 per page, matching every other paged table in this console (see
 *  `users/page.tsx`). The server caps `limit` at 100 and defaults to 50. */
const PAGE_SIZE = 25;

export default function AdminDisputesPage() {
  const [disputes, setDisputes] = useState<ApiDispute[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DisputeStatusFilter>("open");
  const [page, setPage] = useState(0);
  const [rulingConfirm, setRulingConfirm] = useState<{
    dispute: ApiDispute;
    decision: "uphold_flag" | "overturn_flag";
  } | null>(null);
  const { pushToast } = useAdminToast();

  const loadDisputes = useCallback(async (status: DisputeStatusFilter, pageIndex: number) => {
    setLoading(true);
    try {
      // The backend `/v1/admin/disputes` endpoint accepts `status`, `limit`
      // and `offset` — no search or date-range params exist yet — so the
      // filter bar here is limited to what the API actually supports rather
      // than faking client-side search.
      //
      // `offset` IS now sent, one PAGE_SIZE page at a time, driven by the
      // console's shared `AdminPagination`. Previously this query sent a
      // single 100-row cap and no offset, so on a pool with more than 100
      // disputes the rest were unreachable from the UI — there was no pager to
      // reach them with. `routes/v1/admin.ts` (~line 837) reads `offset` on
      // this route and returns `total` alongside `disputes`; verified live
      // 2026-09-08 against `community_test`, where
      // `?status=all&limit=5&offset=3` returns 4 of `total: 7`. An older
      // version of this comment claimed no skip parameter existed at all,
      // which was wrong — V1 carries the same wrong sentence.
      const response = await adminAuthedFetch(
        `/v1/admin/disputes?status=${status}&limit=${PAGE_SIZE}&offset=${pageIndex * PAGE_SIZE}`,
      );
      if (!response.ok) throw new Error(await responseError(response, "Could not load disputes."));
      const data = (await response.json()) as { disputes?: ApiDispute[]; total?: number };
      if (!Array.isArray(data.disputes)) throw new Error("The disputes response was invalid.");
      setDisputes(data.disputes);
      // Fall back to the row count if `total` is absent or not a finite
      // number, so the pager never renders NaN.
      setTotal(
        typeof data.total === "number" && Number.isFinite(data.total)
          ? data.total
          : pageIndex * PAGE_SIZE + data.disputes.length,
      );
      setError(null);
    } catch (e) {
      setDisputes([]);
      setTotal(0);
      setError(e instanceof Error ? e.message : "Could not load disputes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial API synchronization; state changes happen after the request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDisputes(statusFilter, page);
  }, [loadDisputes, statusFilter, page]);

  const resolveDispute = (dispute: ApiDispute, decision: "uphold_flag" | "overturn_flag") => {
    const reason = resolution[dispute.id]?.trim() ?? "";
    if (!reason) {
      setError("Enter a resolution reason before making a ruling.");
      return;
    }
    setRulingConfirm({ dispute, decision });
  };

  const confirmResolveDispute = async () => {
    if (!rulingConfirm) return;
    const { dispute, decision } = rulingConfirm;
    const reason = resolution[dispute.id]?.trim() ?? "";
    setResolving(dispute.id);
    setError(null);
    try {
      const response = await adminAuthedFetch(`/v1/admin/disputes/${dispute.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, resolution: reason }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not resolve dispute."));
      await loadDisputes(statusFilter, page);
      pushToast({
        variant: "success",
        title: decision === "uphold_flag" ? "Flag confirmed" : "Flag overturned",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not resolve dispute.";
      setError(message);
      pushToast({ variant: "error", title: "Could not resolve dispute", body: message });
    } finally {
      setResolving(null);
      setRulingConfirm(null);
    }
  };

  return (
    <div className="space-y-5">
      <AdminPageHeader title="Flags & Disputes" sub="Live escalations requiring a documented platform ruling." />
      {error && <AdminErrorBanner message={error} onRetry={() => void loadDisputes(statusFilter, page)} />}
      <div className="flex items-start gap-2.5 rounded-[10px] border border-dark-line bg-dark-card px-[18px] py-3.5 text-[13px] text-dark-soft">
        <Icon name="shield" size={15} className="mt-0.5 shrink-0" />
        <span>Review the immutable submission payload, validation evidence, uploaded files, validator decisions, and both recorded arguments before ruling.</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-dark-line bg-dark-card p-1.5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            // A filter change must reset the page: page 3 of "open" is
            // routinely out of range for "resolved", which would land the
            // reader on an empty page.
            onClick={() => { setStatusFilter(f.value); setPage(0); }}
            aria-pressed={statusFilter === f.value}
            className={`cursor-pointer rounded-lg px-3 py-2.5 font-mono text-xs transition-colors sm:py-1.5 ${
              statusFilter === f.value ? "bg-lime text-dark" : "text-dark-soft hover:bg-dark-panel hover:text-dark-text"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && <div role="status" className="font-mono text-sm text-dark-soft">Loading live disputes…</div>}
      {!loading && !error && disputes.length === 0 && <div className="rounded-xl border border-dark-line bg-dark-card px-5 py-6 text-sm text-dark-soft">No disputes found.</div>}

      <div className="space-y-4">
        {disputes.map((d) => (
          <article key={d.id} className="rounded-xl border border-dark-line bg-dark-card p-6">
            <div className="mb-[18px] flex flex-wrap items-start justify-between gap-3">
              {/* min-w-0 + break-words: pool titles and submission titles are
                  free text, and without these a single long token stretched the
                  card past the viewport at 375px. */}
              <div className="min-w-0">
                <div className="mb-1.5 break-words font-mono text-[10px] uppercase tracking-[0.05em] text-dark-dim">
                  {d.bounty?.id ? (
                    <Link href={`/details?kind=bounty&id=${encodeURIComponent(d.bounty.id)}`} className="text-lime underline">
                      {d.bounty.title}
                    </Link>
                  ) : (
                    (d.bounty?.title ?? d.bountyTitle)
                  )}
                </div>
                <h2 className="break-words text-base font-bold tracking-tight text-dark-text">{d.submissionTitle}</h2>
                {/* The ids were printed as dead text while the full submission
                    record already had its own page. */}
                <div className="mt-1 break-all font-mono text-[10px] text-dark-dim">
                  dispute {d.id} · submission{" "}
                  {d.submissionId ? (
                    <Link href={`/details?kind=submission&id=${encodeURIComponent(d.submissionId)}`} className="text-lime underline">
                      {d.submissionId}
                    </Link>
                  ) : (
                    "unavailable"
                  )}
                </div>
              </div>
              <AdminPill tone={d.status === "open" ? "warning" : "success"}>{d.status === "open" ? FLAG_REASON_LABELS[d.flagReason] : "resolved"}</AdminPill>
            </div>

            <div className="mb-[18px] grid gap-3.5 md:grid-cols-2">
              <div className="border-l-2 border-emerald-400 pl-3.5"><div className="mb-1.5 font-mono text-[10px] uppercase text-dark-dim">contributor / sponsor argument</div><p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-dark-muted">{d.contributorArgument}</p></div>
              <div className="border-l-2 border-rose-400 pl-3.5"><div className="mb-1.5 font-mono text-[10px] uppercase text-dark-dim">validator evidence</div><p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-dark-muted">{d.validatorArgument}</p></div>
            </div>

            {d.evidence ? <details className="mb-[18px] rounded-lg border border-dark-line-soft bg-dark-field p-4" open>
              <summary className="cursor-pointer font-mono text-[11px] font-bold uppercase tracking-[0.05em] text-dark-muted">Recorded submission evidence</summary>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <div className="mb-1.5 font-mono text-[10px] uppercase text-dark-dim">current payload · revision {d.evidence.revisionCount}</div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-dark-line px-3 py-2 font-mono text-[11px] leading-relaxed text-dark-muted">{JSON.stringify(d.evidence.payloadJson, null, 2)}</pre>
                </div>
                <div className="space-y-3">
                  <div><div className="mb-1.5 font-mono text-[10px] uppercase text-dark-dim">pipeline results</div><div className="space-y-1.5">{d.evidence.validationResults.length ? latestResultPerStage(d.evidence.validationResults).map((result) => <PipelineResultRow key={result.id} result={result} />) : <p className="text-xs text-dark-dim">No validation results recorded.</p>}</div></div>
                  <div><div className="mb-1.5 font-mono text-[10px] uppercase text-dark-dim">files</div><div className="flex flex-wrap gap-2">{d.evidence.artifacts.length ? d.evidence.artifacts.map((artifact) => <a key={artifact.id} href={`${API_URL}${artifact.downloadUrl}`} target="_blank" rel="noreferrer" className="rounded border border-dark-line px-2.5 py-1.5 font-mono text-[11px] text-dark-muted hover:text-dark-text">{artifact.filename} · {artifact.status}</a>) : <span className="text-xs text-dark-dim">No files attached.</span>}</div></div>
                  {/* The decision trail itself. This block used to render only
                      the counts, so an admin ruling on a dispute could see that
                      somebody had rejected the item but not who, on what
                      grounds, or what they wrote. */}
                  <div>
                    <div className="mb-1.5 font-mono text-[10px] uppercase text-dark-dim">who decided, and why</div>
                    <div className="space-y-1.5">
                      {/* Currently unreachable: admin.ts sends
                          `auditDecisions: []` for dispute evidence. Corrected
                          anyway, because it is wrong the moment that is
                          populated. A decision requires BOTH a verdict and a
                          `decidedAt` — keying the label and the colour on the
                          verdict alone made an unsaved/partial row read as a
                          settled ruling. */}
                      {d.evidence.auditDecisions.map((decision) => {
                        const decided = !!decision.verdict && !!decision.decidedAt;
                        return (
                        <div key={decision.id} className="rounded border border-dark-line px-3 py-2 font-mono text-[11px] text-dark-muted">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={!decided ? "text-dark-dim" : decision.verdict === "flagged" ? "text-rose-300" : decision.verdict === "ok" ? "text-emerald-400" : "text-dark-dim"}>
                              {decided ? decision.verdict : "undecided"}
                            </span>
                            <span className="text-dark-dim">·</span>
                            <span>{decision.validatorLabel ?? decision.validatorUserId ?? decision.auditBatch.validatorUserId ?? "unassigned validator"}</span>
                            {decision.decidedAt && <span className="text-dark-dim">· {new Date(decision.decidedAt).toLocaleString()}</span>}
                          </div>
                          {decision.flagReason && (
                            <div className="mt-1 text-dark-soft">
                              {FLAG_REASON_LABELS[decision.flagReason] ?? decision.flagReason.replaceAll("_", " ")}
                            </div>
                          )}
                          {decision.note && <p className="mt-1 whitespace-pre-wrap break-words text-dark-muted">{decision.note}</p>}
                        </div>
                        );
                      })}
                      {d.evidence.flags.map((flag) => (
                        <div key={flag.id} className="rounded border border-dark-line px-3 py-2 font-mono text-[11px] text-dark-muted">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-rose-300">flag · {flag.status}</span>
                            <span className="text-dark-dim">·</span>
                            {/* No validator id means the platform raised it. */}
                            <span>{flag.validatorLabel ?? flag.validatorUserId ?? "automated"}</span>
                          </div>
                          <div className="mt-1 text-dark-soft">
                            {FLAG_REASON_LABELS[flag.reason] ?? flag.reason.replaceAll("_", " ")}
                          </div>
                          {flag.details && <p className="mt-1 whitespace-pre-wrap break-words text-dark-muted">{flag.details}</p>}
                        </div>
                      ))}
                      {!d.evidence.auditDecisions.length && !d.evidence.flags.length && (
                        <p className="text-xs text-amber-300">
                          No validator decision or flag is recorded against this submission. Establish why it was
                          escalated before ruling.
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="font-mono text-[11px] text-dark-dim">{d.evidence.revisions.length} archived revision(s)</div>
                </div>
              </div>
            </details> : <div className="mb-[18px] rounded-lg border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-xs text-amber-200">The linked submission evidence is unavailable. Do not resolve this dispute until the record is restored.</div>}

            {d.status === "open" ? <div className="space-y-3">
              <div><label htmlFor={`resolution-${d.id}`} className="mb-1.5 block font-mono text-[10px] uppercase text-dark-dim">required resolution reason</label><textarea id={`resolution-${d.id}`} value={resolution[d.id] ?? ""} maxLength={4000} rows={3} onChange={(event) => setResolution((prev) => ({ ...prev, [d.id]: event.target.value }))} className="w-full resize-y rounded-lg border border-dark-line-soft bg-dark-field px-3 py-2 text-sm text-dark-text focus:border-dark-hover focus:outline-none" /></div>
              <div className="flex flex-wrap gap-3"><AdminButton variant="danger" disabled={resolving === d.id || !(resolution[d.id]?.trim()) || !d.evidence} onClick={() => resolveDispute(d, "uphold_flag")}>{resolving === d.id ? "Saving…" : "Confirm flag"}</AdminButton><AdminButton variant="ghost" disabled={resolving === d.id || !(resolution[d.id]?.trim()) || !d.evidence} onClick={() => resolveDispute(d, "overturn_flag")}>Overturn and requeue</AdminButton></div>
            </div> : <div className="flex items-start gap-2 rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-4 py-2.5 font-mono text-[12px] text-emerald-400"><Icon name="check" size={14} className="mt-0.5 shrink-0" /><span className="whitespace-pre-wrap">{d.resolution || "Resolved without a recorded explanation."}</span></div>}
          </article>
        ))}
      </div>

      {/* Gated on a real count, matching the audit-logs pager landed the same
          day: on a failed fetch `total` is reset to 0, and an unconditional
          pager would print "0–0 of 0" directly under the error banner —
          which reads as "this pool has no disputes", a claim the response
          never made. (`users/page.tsx` renders its pager unconditionally;
          that is pre-existing and out of scope here.) */}
      {total > 0 && (
        <AdminPagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      )}

      <AdminConfirmDialog
        open={!!rulingConfirm}
        title={
          rulingConfirm?.decision === "uphold_flag"
            ? "Confirm this flag?"
            : "Overturn this flag and requeue?"
        }
        description="This decision affects submission and karma state."
        confirmLabel={rulingConfirm?.decision === "uphold_flag" ? "Confirm flag" : "Overturn and requeue"}
        danger={rulingConfirm?.decision === "uphold_flag"}
        busy={!!rulingConfirm && resolving === rulingConfirm.dispute.id}
        onConfirm={confirmResolveDispute}
        onCancel={() => setRulingConfirm(null)}
      />
    </div>
  );
}
