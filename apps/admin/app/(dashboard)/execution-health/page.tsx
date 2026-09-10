"use client";

// SPDX-License-Identifier: Apache-2.0

import { AdminErrorBanner, AdminPageHeader, AdminPill, AdminSectionHeading, AdminStat, AdminTable, ATd } from "@/components/admin-shell";
import { useAdminResource } from "@/lib/use-admin-resource";

/**
 * Execution health — DataBounty's answer to E2B's sandbox dashboard, plus the
 * dimensions E2B has no concept of because it only runs infra: WHY a verdict
 * failed, whether isolation was verified, and a provider-vs-provider compare.
 *
 * The headline honesty this view exists to fix: the old single "execution pass
 * rate" folded held-for-human-audit runs into "failed". Here `held` is its own
 * bucket, and a run with no recorded isolation posture is never counted as
 * verified.
 */

interface ExecutionHealth {
  windowDays: number;
  computedAt: string;
  totalRuns: number;
  passed: number;
  failed: number;
  held: number;
  unknown: number;
  isolationVerifiedRate: number | null;
  isolationRunsWithPosture: number;
  durationMsP50: number | null;
  durationMsP95: number | null;
  durationSampleSize: number;
  byOutcome: { outcome: string; count: number }[];
  byProvider: { provider: string; total: number; passed: number; failed: number; held: number; p50: number | null }[];
  /** Optional: an API deployed before this field existed has not measured it. */
  fallbackRuns?: number;
}

/** Human labels for the coarse outcome codes. */
const OUTCOME_LABEL: Record<string, string> = {
  runner_completed: "Judged (passed or failed its tests)",
  runtime_unavailable: "Held — no runtime for this language",
  all_providers_failed: "Held — every provider failed",
  no_provider_configured: "Held — no provider configured",
  no_executable_harness: "Held — no test harness",
  not_attempted: "Held — earlier stage blocked it",
  execution_held_for_review: "Held — isolation/verdict could not be trusted",
  execution_unavailable: "Held — provider unavailable",
  execution_at_capacity: "Held — provider at capacity",
  execution_unverifiable: "Held — fixed code couldn't run (infra fault, not a test failure)",
  unknown: "Unknown (legacy run, no recorded outcome)",
};

function pct(n: number, d: number): string {
  if (d <= 0) return "—";
  return `${Math.round((n / d) * 100)}%`;
}
function ms(v: number | null): string {
  return v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

export default function ExecutionHealthPage() {
  const health = useAdminResource<ExecutionHealth>("/v1/admin/execution-health?windowDays=7", {
    errorMessage: "Execution health is unavailable.",
  });
  const d = health.data;

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Execution health"
        sub="How the execution stage is doing over the last 7 days — runs, pass/fail, and the runs held for human audit (not failures). Includes why runs were held, isolation-verified rate, and a provider comparison."
        eyebrow="System"
      />

      {health.error && <AdminErrorBanner message={health.error} onRetry={() => void health.refresh()} />}
      {health.loading && <div role="status" className="font-mono text-sm text-dark-soft">Loading execution health…</div>}

      {d && d.totalRuns === 0 && (
        <div className="rounded-xl border border-dark-line bg-dark-card px-4 py-4 font-mono text-sm text-dark-soft">
          No execution runs recorded in the last {d.windowDays} days.
        </div>
      )}

      {d && d.totalRuns > 0 && <>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <AdminStat label="execution runs (7d)" value={d.totalRuns.toLocaleString()} />
          <AdminStat label="passed" value={pct(d.passed, d.passed + d.failed)} sub={`${d.passed.toLocaleString()} judged & passed`} tone="lime" />
          <AdminStat label="failed" value={pct(d.failed, d.passed + d.failed)} sub={`${d.failed.toLocaleString()} judged & failed`} tone={d.failed > 0 ? "amber" : "default"} />
          {/* Held is the honesty stat — these are NOT failures. */}
          <AdminStat label="held for human audit" value={d.held.toLocaleString()} sub="no machine verdict — a validator reviews these" tone={d.held > 0 ? "amber" : "default"} />
        </section>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <AdminStat
            label="isolation verified"
            value={d.isolationVerifiedRate == null ? "not measured" : `${Math.round(d.isolationVerifiedRate * 100)}%`}
            sub={d.isolationRunsWithPosture > 0 ? `of ${d.isolationRunsWithPosture.toLocaleString()} runs with a recorded posture` : "no run recorded an isolation posture"}
            tone={d.isolationVerifiedRate != null && d.isolationVerifiedRate < 1 ? "amber" : "default"}
          />
          <AdminStat label="run time p50" value={ms(d.durationMsP50)} sub={d.durationSampleSize > 0 ? `${d.durationSampleSize.toLocaleString()} timed runs` : "no timing yet"} />
          <AdminStat label="run time p95" value={ms(d.durationMsP95)} />
          {/* The provider table credits a fallback run to whoever produced the
              verdict, so without this the first provider's failure is invisible
              — a self-hosted provider can look healthy purely because E2B keeps
              covering for it. `?? null` (not `?? 0`): an older API that doesn't
              send the field has not measured this, and must not read as zero. */}
          <AdminStat
            label="fell back to another provider"
            value={d.fallbackRuns == null ? "not measured" : d.fallbackRuns.toLocaleString()}
            sub="passed only after an earlier provider failed — counted under the provider that ran it"
            tone={(d.fallbackRuns ?? 0) > 0 ? "amber" : "default"}
          />
          {d.unknown > 0 && <AdminStat label="unclassified (legacy)" value={d.unknown.toLocaleString()} sub="pre-instrumentation runs" />}
        </section>

        <section className="space-y-2">
          <AdminSectionHeading title="// why_runs_ended_as_they_did" sub="The verdict-reason breakdown E2B cannot produce — it only runs infrastructure, with no concept of a trust verdict or a held run." />
          <AdminTable headers={["Outcome", "Runs", "Share"]} caption="Execution outcomes">
            {d.byOutcome.map((o) => (
              <tr key={o.outcome}>
                <ATd>
                  {OUTCOME_LABEL[o.outcome] ?? o.outcome}
                  {o.outcome === "runner_completed"
                    ? <AdminPill tone="lime" className="ml-2">judged</AdminPill>
                    : o.outcome === "unknown"
                      ? <AdminPill tone="neutral" className="ml-2">legacy</AdminPill>
                      : <AdminPill tone="warning" className="ml-2">held</AdminPill>}
                </ATd>
                <ATd>{o.count.toLocaleString()}</ATd>
                <ATd>{pct(o.count, d.totalRuns)}</ATd>
              </tr>
            ))}
          </AdminTable>
        </section>

        <section className="space-y-2">
          <AdminSectionHeading title="// by_provider" sub="Managed (e2b) vs self-hosted (ec2) vs whole-service runner, side by side — the shadow comparison the sandbox migration is built around." />
          <AdminTable headers={["Provider", "Runs", "Passed", "Failed", "Held", "p50"]} caption="Execution by provider">
            {d.byProvider.length === 0 ? (
              <tr>
                <ATd colSpan={6} className="text-dark-soft">No provider breakdown recorded for this window.</ATd>
              </tr>
            ) : d.byProvider.map((p) => (
              <tr key={p.provider}>
                <ATd><span className="font-medium text-dark-text">{p.provider}</span></ATd>
                <ATd>{p.total.toLocaleString()}</ATd>
                <ATd>{p.passed.toLocaleString()} <span className="text-dark-dim">({pct(p.passed, p.passed + p.failed)})</span></ATd>
                <ATd>{p.failed.toLocaleString()}</ATd>
                <ATd>{p.held.toLocaleString()}</ATd>
                <ATd>{ms(p.p50)}</ATd>
              </tr>
            ))}
          </AdminTable>
        </section>

        <p className="font-mono text-[10px] text-dark-dim">computed {new Date(d.computedAt).toLocaleString()} · live query over the last {d.windowDays} days</p>
      </>}
    </div>
  );
}
