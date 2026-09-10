// SPDX-License-Identifier: Apache-2.0

import { AdminDateTime } from "@/components/admin-shell";
import { num } from "@/lib/format";

/**
 * Shared rendering for the three rolling-window pipeline quality rates
 * (duplicate / llm / execution), used by BOTH the admin overview
 * (app/(dashboard)/page.tsx) and the validation-pipeline page
 * (app/(dashboard)/submissions/page.tsx).
 *
 * Shared on purpose: both pages read the same numbers from the same API
 * aggregation (the API's services/admin-quality-metrics.ts), and a local copy
 * of these two helpers on each page is exactly how the two surfaces would
 * drift into presenting the same measurement differently. No new card and no
 * new styling lives here — callers still render `AdminStat` themselves, with
 * the same labels, tones and layout as before.
 */

/** Mirrors `QualityMetric` in the API's services/admin-quality-metrics.ts. */
export interface QualityMetric {
  /** `null` unless `state === "measured"`. Never zero-filled by the API. */
  rate: number | null;
  /** Denominator size the rate was computed over. */
  sampleSize: number;
  /** Runs deliberately excluded from the denominator (produced no verdict). */
  excluded: number;
  excludedByOutcome: Record<string, number>;
  state: "measured" | "not_measured" | "not_configured";
}

/**
 * Trust invariant: a rate with no denominator is reported as unmeasured, never
 * as "0%". A genuinely measured 0 (a non-empty sample that scored zero) still
 * renders as "0%" — the two mean opposite things to whoever is reading the
 * dashboard.
 */
export function qualityValue(metric: QualityMetric, render: (rate: number) => string): string {
  if (metric.state === "measured" && metric.rate !== null) return render(metric.rate);
  return metric.state === "not_configured" ? "not configured" : "not measured";
}

/**
 * Caption for a quality rate: window, sample size and freshness when there is
 * a measurement; the specific reason there isn't when there isn't. Runs
 * excluded from the denominator (an unconfigured or failed sandbox) are named
 * rather than silently lowering the pass rate.
 *
 * `unit` names what `sampleSize` counts for this particular metric, and
 * `measures` is the existing per-page description of what the number means.
 */
export function qualitySub(
  metric: QualityMetric,
  windowDays: number,
  computedAt: string | null,
  unit: string,
  measures?: string,
): React.ReactNode {
  if (metric.state === "not_configured") {
    return "no provider configured in this environment — nothing was checked";
  }
  if (metric.state === "not_measured") return `nothing measured in the last ${windowDays} days`;
  const excludedNote =
    metric.excluded > 0 ? ` · ${num(metric.excluded)} run${metric.excluded === 1 ? "" : "s"} produced no verdict (excluded)` : "";
  return (
    <>
      {`rolling ${windowDays} days · ${num(metric.sampleSize)} ${unit}`}
      {computedAt ? (
        <>
          {" · as of "}
          <AdminDateTime iso={computedAt} />
        </>
      ) : null}
      {measures ? ` · ${measures}` : ""}
      {excludedNote}
    </>
  );
}
