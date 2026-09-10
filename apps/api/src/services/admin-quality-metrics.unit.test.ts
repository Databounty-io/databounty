// SPDX-License-Identifier: Apache-2.0

/**
 * The crux of the admin-overview quality-metrics fix: telling "0%" apart from
 * "not measured" / "not configured".
 *
 * Before this fix, GET /v1/admin/overview pinned duplicateRate, llmPassRate
 * and executionPassRate to a literal 0 on the (stale) claim that the
 * execution and LLM stages were hardcoded stubs. They are not — services/
 * validation.ts runs real sandbox providers and a real OpenRouter review, and
 * records explicit non-verdict outcomes when it cannot. So the rates are now
 * computed for real, and the honesty rule moves into the value itself: a rate
 * with no denominator must be `null` with a state, never a zero that reads as
 * a measured "every item failed".
 *
 * Pure logic only — no database, no Prisma. The two functions under test are
 * the whole decision surface for that distinction.
 */
import { describe, expect, it } from "vitest";
import { deriveQualityMetric, foldExecutionRows } from "./admin-quality-metrics.js";

describe("deriveQualityMetric — not-measured is never a measured zero", () => {
  it("keeps a genuinely measured 0 as a measurement", () => {
    // 138 scored submissions that all scored 0 duplicate similarity: this IS
    // 0%, and must render as 0%.
    const metric = deriveQualityMetric({ rate: 0, sampleSize: 138 });
    expect(metric.state).toBe("measured");
    expect(metric.rate).toBe(0);
    expect(metric.sampleSize).toBe(138);
  });

  it("returns null (not 0) when the denominator is empty", () => {
    const metric = deriveQualityMetric({ rate: null, sampleSize: 0 });
    expect(metric.state).toBe("not_measured");
    expect(metric.rate).toBeNull();
    // Explicitly guard the exact regression: a consumer must not be able to
    // read a falsy-but-numeric 0 out of an unmeasured metric.
    expect(metric.rate).not.toBe(0);
  });

  it("never trusts a rate that arrives with an empty sample", () => {
    // Defensive: even if an upstream aggregate handed back a number for an
    // empty set, sampleSize === 0 wins and the metric is unmeasured.
    const metric = deriveQualityMetric({ rate: 0.42, sampleSize: 0 });
    expect(metric.state).toBe("not_measured");
    expect(metric.rate).toBeNull();
  });

  it("reports not_configured — not not_measured — when evidence says no provider is configured", () => {
    const metric = deriveQualityMetric({ rate: null, sampleSize: 0, unconfiguredCount: 17 });
    expect(metric.state).toBe("not_configured");
    expect(metric.rate).toBeNull();
  });

  it("prefers a real measurement over the unconfigured signal when both exist", () => {
    // Mixed window: some submissions were reviewed by a configured provider,
    // some rows recorded no_provider_configured. A real rate exists, so it is
    // reported as measured (the excluded runs are still surfaced separately).
    const metric = deriveQualityMetric({
      rate: 40.54,
      sampleSize: 102,
      unconfiguredCount: 17,
    });
    expect(metric.state).toBe("measured");
    expect(metric.rate).toBeCloseTo(40.54);
  });

  it("totals the excluded no-verdict runs so the UI can disclose them", () => {
    const metric = deriveQualityMetric({
      rate: 122 / 136,
      sampleSize: 136,
      excludedByOutcome: { no_provider_configured: 1, no_executable_harness: 1 },
    });
    expect(metric.state).toBe("measured");
    expect(metric.excluded).toBe(2);
    expect(metric.excludedByOutcome).toEqual({ no_provider_configured: 1, no_executable_harness: 1 });
  });
});

describe("foldExecutionRows — a run that produced no verdict is never a failure", () => {
  it("counts only runner_completed rows in the pass-rate denominator", () => {
    // Shape of the real community_test window: 136 real sandbox verdicts (122
    // passed), plus 2 rows that recorded that nothing ran.
    const folded = foldExecutionRows([
      { outcome: "runner_completed", passed: true, count: 122 },
      { outcome: "runner_completed", passed: false, count: 14 },
      { outcome: "no_provider_configured", passed: false, count: 1 },
      { outcome: "no_executable_harness", passed: false, count: 1 },
    ]);
    expect(folded.verdicts).toBe(136);
    expect(folded.passed).toBe(122);
    expect(folded.excludedByOutcome).toEqual({ no_provider_configured: 1, no_executable_harness: 1 });
    // V1's query divides by every execution row (138 here) and so reports
    // 122/138 = 88.4%, silently treating "no sandbox configured" as a failed
    // execution. The verdict-only denominator reports 122/136 = 89.7%.
    expect(folded.passed / folded.verdicts).toBeCloseTo(122 / 136);
    expect(folded.passed / folded.verdicts).not.toBeCloseTo(122 / 138);
  });

  it("yields an unmeasured metric — not 0% — when nothing was ever executed", () => {
    const folded = foldExecutionRows([{ outcome: "no_provider_configured", passed: false, count: 9 }]);
    expect(folded.verdicts).toBe(0);
    const metric = deriveQualityMetric({
      rate: folded.verdicts > 0 ? folded.passed / folded.verdicts : null,
      sampleSize: folded.verdicts,
      excludedByOutcome: folded.excludedByOutcome,
      unconfiguredCount: folded.excludedByOutcome.no_provider_configured ?? 0,
    });
    // The defect this whole change fixes: 9 recorded rows, all passed:false,
    // must NOT become "execution pass rate 0%".
    expect(metric.state).toBe("not_configured");
    expect(metric.rate).toBeNull();
  });

  it("excludes a legacy row whose outcome was never recorded rather than crediting it", () => {
    const folded = foldExecutionRows([
      { outcome: null, passed: true, count: 4 },
      { outcome: "runner_completed", passed: true, count: 1 },
    ]);
    // A NULL-outcome row cannot be shown to have come from a real sandbox run,
    // so it counts neither as a pass nor as a failure — fail closed.
    expect(folded.verdicts).toBe(1);
    expect(folded.passed).toBe(1);
    expect(folded.excludedByOutcome).toEqual({ outcome_not_recorded: 4 });
  });

  it("reports a real 0% when every genuine verdict failed", () => {
    const folded = foldExecutionRows([{ outcome: "runner_completed", passed: false, count: 12 }]);
    const metric = deriveQualityMetric({
      rate: folded.verdicts > 0 ? folded.passed / folded.verdicts : null,
      sampleSize: folded.verdicts,
      excludedByOutcome: folded.excludedByOutcome,
    });
    expect(metric.state).toBe("measured");
    expect(metric.rate).toBe(0);
  });
});
