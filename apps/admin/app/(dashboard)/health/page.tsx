"use client";

// SPDX-License-Identifier: Apache-2.0

import { AdminErrorBanner, AdminPageHeader, AdminPill, AdminSectionHeading, AdminStat } from "@/components/admin-shell";
import { useAdminResource } from "@/lib/use-admin-resource";

type SystemStatus = "green" | "amber" | "red";
type AlertSeverity = "info" | "warning" | "critical";

interface HealthData {
  status: SystemStatus;
  jobs: {
    byStatus: Record<string, number>;
    deadLetterCount: number;
    oldestRunnable: { type: string; ageMs: number } | null;
  };
  workers: { name: string; lastRunAt: string; intervalMs: number; lastError: string | null; stale: boolean; ageMs: number }[];
  /** True when NO worker has ever reported a heartbeat — see the empty-state note below. */
  noWorkersReporting?: boolean;
  cache: { driver: string; circuitOpen: boolean };
  providerCircuits: { provider: string; consecutiveFailures: number; openUntil: string }[];
  activeAlerts: { code: string; dedupeKey: string; severity: AlertSeverity; context: Record<string, unknown>; firstSeenAt: string; lastSeenAt: string }[];
}

function age(ms: number): string {
  if (ms < 60_000) return "under 1 min";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function alertTone(severity: AlertSeverity) {
  return severity === "critical" ? "danger" : severity === "warning" ? "warning" : "neutral";
}

export default function SystemHealthPage() {
  const health = useAdminResource<HealthData>("/v1/admin/health", { errorMessage: "System health is unavailable." });
  const data = health.data;
  const tone = data?.status === "red" ? "rose" : data?.status === "amber" ? "amber" : "lime";

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="System health"
        sub="Live operational state from the job queue, worker heartbeats, cache circuit, and active system alerts."
        eyebrow="Operations"
      />

      {health.error && <AdminErrorBanner message={health.error} onRetry={() => void health.refresh()} />}
      {health.loading && <div role="status" className="font-mono text-sm text-dark-soft">Loading system health…</div>}

      {data && <>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <AdminStat label="platform state" value={data.status.toUpperCase()} tone={tone} alert={data.status === "red"} />
          <AdminStat label="active alerts" value={data.activeAlerts.length} tone={data.activeAlerts.some((a) => a.severity === "critical") ? "rose" : data.activeAlerts.length ? "amber" : "lime"} alert={data.activeAlerts.some((a) => a.severity === "critical")} />
          <AdminStat label="dead-letter jobs" value={data.jobs.deadLetterCount} tone={data.jobs.deadLetterCount ? "rose" : "lime"} alert={data.jobs.deadLetterCount > 0} />
          {/* An unconfigured cache is NOT "healthy". This card rendered a lime
              "HEALTHY" over the subtitle "not_configured" — a green trust claim
              for a component that does not exist, which is exactly what the
              project forbids (missing/unconfigured is shown explicitly, never
              presented as passed). There is no cache client in this codebase at
              all, so the honest states are three, not two. */}
          <AdminStat
            label="cache"
            value={
              data.cache.driver === "not_configured"
                ? "NOT CONFIGURED"
                : data.cache.circuitOpen
                  ? "DEGRADED"
                  : "HEALTHY"
            }
            sub={data.cache.driver === "not_configured" ? "no cache client — reads go direct to the database" : data.cache.driver}
            tone={data.cache.driver === "not_configured" ? "default" : data.cache.circuitOpen ? "amber" : "lime"}
          />
          <AdminStat label="credential providers" value={data.providerCircuits.length ? "DEGRADED" : "HEALTHY"} sub={data.providerCircuits.length ? `${data.providerCircuits.length} circuit open` : "GitHub / ORCID"} tone={data.providerCircuits.length ? "amber" : "lime"} />
        </section>

        <section>
          <AdminSectionHeading title="// credential_provider_health" sub="Shared circuit breakers prevent provider outages from blocking workers or reducing user reputation." />
          {data.providerCircuits.length === 0 ? (
            <div className="rounded-xl border border-dark-line bg-dark-card px-4 py-4 text-sm text-dark-soft">GitHub and ORCID provider circuits are healthy.</div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-amber-400/25 bg-dark-card">
              {data.providerCircuits.map((circuit) => (
                <div key={circuit.provider} className="grid gap-2 border-b border-dark-line px-4 py-3 text-xs last:border-b-0 md:grid-cols-[140px_1fr_auto] md:items-center">
                  <span className="font-mono text-dark-text">{circuit.provider}</span>
                  <span className="text-dark-soft">Checks are deferred; verified credentials remain active.</span>
                  <span className="font-mono text-amber-300">retry after {new Date(circuit.openUntil).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <AdminSectionHeading title="// active_alerts" sub="Conditions detected by the watchdog. They remain visible until the condition recovers." />
          {data.activeAlerts.length === 0 ? (
            <div className="rounded-xl border border-dark-line bg-dark-card px-4 py-4 text-sm text-dark-soft">No active system alerts.</div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-dark-line bg-dark-card">
              {data.activeAlerts.map((item) => (
                <article key={item.dedupeKey} className="grid gap-2 border-b border-dark-line px-4 py-3.5 last:border-b-0 md:grid-cols-[auto_1fr_auto] md:items-start">
                  <AdminPill tone={alertTone(item.severity)}>{item.severity}</AdminPill>
                  <div className="min-w-0">
                    <h2 className="font-mono text-sm font-bold text-dark-text">{item.code}</h2>
                    <p className="mt-1 break-words text-xs leading-relaxed text-dark-soft">{Object.entries(item.context ?? {}).map(([key, value]) => `${key}: ${String(value)}`).join(" · ") || "No additional diagnostic context."}</p>
                  </div>
                  <div className="font-mono text-[10px] text-dark-dim">active since {new Date(item.firstSeenAt).toLocaleString()}</div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section>
          <AdminSectionHeading title="// worker_heartbeats" sub="A stale worker needs investigation; a last error is shown without exposing secrets." />
          <div className="overflow-hidden rounded-xl border border-dark-line bg-dark-card">
            {data.noWorkersReporting && (
              // An empty worker list is not "all healthy". With the worker
              // process down nothing drains the job queue, delivers a
              // notification, samples a pool or reaps an audit claim — while
              // every other signal on this page still looks fine. Saying so
              // explicitly is the difference between "starting up" and
              // "nothing is running", which a blank table cannot express.
              <div className="px-4 py-3 text-xs text-amber-300">
                No worker has reported a heartbeat. Either the worker process is not running, or it
                has not completed its first tick yet (up to 15s for dispatch, 10 min for the slow
                sweeps). While this is true, no jobs are being processed.
              </div>
            )}
            {data.workers.map((worker) => {
              // `stale` alone only catches a loop that stopped ticking. A worker
              // upserts its heartbeat on every tick, success OR failure, so one
              // that is failing every run but still ticking on schedule reads as
              // fresh (`stale: false`) while `lastError` is non-null — that is
              // still not "healthy", it just hasn't died outright. `lastError` is
              // cleared on the next successful tick, so seeing it here means the
              // MOST RECENT run failed, not stale history.
              const workerLabel = worker.stale ? "stale" : worker.lastError ? "failing" : "healthy";
              return (
                <div key={worker.name} className="grid gap-2 border-b border-dark-line px-4 py-3 text-xs last:border-b-0 md:grid-cols-[minmax(180px,1fr)_110px_minmax(220px,2fr)] md:items-center">
                  <span className="font-mono text-dark-text">{worker.name}</span>
                  <AdminPill tone={workerLabel === "healthy" ? "success" : "danger"}>{workerLabel}</AdminPill>
                  <span className={worker.lastError ? "break-words text-rose-300" : "text-dark-soft"}>{worker.lastError || `last tick ${age(worker.ageMs)} ago`}</span>
                </div>
              );
            })}
          </div>
        </section>
      </>}
    </div>
  );
}
