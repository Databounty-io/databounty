// SPDX-License-Identifier: Apache-2.0

import { Icon } from "./icons";
import type { LlmReviewResult } from "@/lib/types";
import { pctOrDash as pct } from "@/lib/format";

/**
 * Scores here are 0–1: `submissionDisplayFromApi` (lib/api-work.ts) normalises
 * this backend's 0–100 rubric score at the API boundary, because feeding 95
 * through `pct` printed "9500%" — see `llmScoreTo01` there for why the fix is
 * at that layer and not in `pct`.
 *
 * `passThreshold` is only ever rendered when the SERVER reported one. It used
 * to fall back to a hardcoded 0.7, which (a) invented a policy number and
 * presented it as the configured bar, and (b) combined with the unnormalised
 * 0–100 score made `score >= threshold` true for every score above 1 — a
 * failing verdict reading as a pass. This backend has no numeric threshold at
 * all: `passed` is the reviewing model's own pass/fail verdict
 * (services/llm-client.ts), so the verdict — not a comparison this component
 * makes up — decides what reads as a pass.
 */
export function LlmReviewCard({ review, className = "" }: { review: LlmReviewResult; className?: string }) {
  const threshold = review.passThreshold ?? null;
  const criteria = review.criteria ?? [];
  const passedCount = threshold == null ? null : criteria.filter((c) => c.score >= threshold).length;
  // A stored score is what makes this a real review. The status string alone
  // is not: this backend records no `status` on a genuine review, so keying
  // off `=== "reviewed"` sent every real FAIL down the "not scored yet"
  // branch below. api-work now derives status/verdict from the score.
  const reviewed = review.status === "reviewed" || (review.score != null && review.verdict != null);
  const scoreOk = review.verdict === "pass";

  return (
    <div className={`card px-5 py-5 ${className}`}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="text-[15px] font-bold">LLM review</div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[10px] ${
            review.verdict === "pass"
              ? "bg-[#eaf3d6] text-accent-strong"
              : review.verdict === "fail"
                ? "bg-[#fbe4e8] text-danger-strong"
                : "bg-amber-100 text-amber-700"
          }`}
        >
          {reviewed
            ? review.verdict === "pass"
              ? "review pass"
              : review.verdict === "fail"
                ? "review fail"
                : "uncertain"
            : review.status === "skipped_sampling"
              ? "not sampled"
              : // `pending_llm_review` means no reviewer is configured in this
                // environment (the API writes it with outcome
                // `no_provider_configured`), so it must not read as a check
                // that is on its way — same label the LlmEvidenceCard uses.
                review.status === "pending_llm_review"
                ? "not configured"
                : "no decision"}
        </span>
      </div>

      {reviewed ? (
        <>
          <div className="flex flex-col gap-2 font-mono text-[12.5px]">
            <div className="flex items-center justify-between">
              <span className="text-ink-soft">overall quality</span>
              <span
                className={
                  scoreOk ? "font-bold text-accent-strong" : review.verdict === "fail" ? "text-danger-strong" : ""
                }
              >
                {pct(review.score)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-soft">pass threshold</span>
              {threshold == null ? (
                <span className="text-[11.5px] text-ink-faint">not reported by the reviewer</span>
              ) : (
                <span>{pct(threshold)}</span>
              )}
            </div>
            {criteria.length > 0 && passedCount != null && (
              <div className="flex items-center justify-between">
                <span className="text-ink-soft">rubric checks passed</span>
                <span className="font-bold">
                  {passedCount} / {criteria.length}
                </span>
              </div>
            )}
          </div>

          {criteria.length > 0 && (
            <div className="mt-4 space-y-2.5 border-t border-line-soft pt-3">
              {criteria.map((c, i) => {
                // With no reported threshold there is no bar to judge a
                // rubric line against, so it gets a neutral marker rather
                // than a fabricated check or cross.
                const ok = threshold == null ? null : c.score >= threshold;
                return (
                  <div key={i} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                        {ok == null ? (
                          <Icon name="info" size={12} className="text-ink-faint" />
                        ) : (
                          <Icon name={ok ? "check" : "x"} size={12} className={ok ? "text-accent-strong" : "text-danger-strong"} />
                        )}
                        <span className="truncate">{c.name || `Check ${i + 1}`}</span>
                      </div>
                      {c.note && (
                        <p className="mt-0.5 pl-[18px] text-[11.5px] leading-relaxed text-ink-soft">{c.note}</p>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-[12px] text-ink-soft">{pct(c.score)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {review.evidence && (
            <p className="mt-4 border-t border-line-soft pt-3 text-[12px] leading-relaxed text-ink-soft">
              {review.evidence}
            </p>
          )}
        </>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-ink-soft">
          {review.reason ??
            (review.status === "skipped_sampling"
              ? "This item was not selected for machine review by the sampling policy, so no LLM quality score was produced. It is not counted as LLM-verified."
              : review.status === "pending_llm_review"
                ? "No LLM reviewer is configured in this environment, so no model scored this item. It is held for a human validator and is not counted as LLM-verified."
                : "This stage has not produced a reviewer decision, so the item is not counted as LLM-verified.")}
        </p>
      )}
    </div>
  );
}
