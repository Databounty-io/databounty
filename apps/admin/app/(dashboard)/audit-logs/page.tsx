"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { AdminButton, AdminModal, AdminPageHeader, AdminPill } from "@/components/admin-shell";
import { AdminPagination } from "@/components/admin-filter-bar";
import { useAdminResource } from "@/lib/use-admin-resource";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { useAdminToast } from "@/lib/admin-toast";

interface AuditLog {
  id: string;
  action: string;
  result: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
}

interface AuditData {
  total: number;
  logs: AuditLog[];
  integrity: { valid: boolean; checked: number; brokenAt?: string | null };
}

interface JobFailure {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  updatedAt: string;
}

interface JobHealth {
  byStatus: Array<{ status: string; _count: { _all: number } }>;
  failures: JobFailure[];
}

/** Owner-approved deviation from V1, 2026-09-08: V1's admin audit-logs page has
 *  this same 50-row server cap and no pager, so the rows past the first page are
 *  unreachable there too. The pager is added because the records are otherwise
 *  unreadable, not because V1 was misread. 50 keeps the visible page size as-is. */
const PAGE_SIZE = 50;

export default function AuditAndJobsPage() {
  const [action, setAction] = useState("");
  const [page, setPage] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryTarget, setRetryTarget] = useState<JobFailure | null>(null);
  const [retryReason, setRetryReason] = useState("");
  const [resolveTarget, setResolveTarget] = useState<JobFailure | null>(null);
  const [resolveReason, setResolveReason] = useState("");
  const [resolving, setResolving] = useState(false);
  const { pushToast } = useAdminToast();
  // The endpoint's page controls are `limit` / `offset` (not `skip`), and it
  // caps `limit` at 100 server-side, so PAGE_SIZE must stay at or below that.
  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
  if (action.trim()) query.set("action", action.trim());
  const audit = useAdminResource<AuditData>(`/v1/admin/audit-logs?${query.toString()}`, { errorMessage: "Audit records are unavailable. Admin access is required." });
  const jobs = useAdminResource<JobHealth>("/v1/admin/jobs/health", { errorMessage: "Job health is unavailable." });
  // `total` is missing on an errored or empty response; without this the pager
  // would render "of NaN" and could compute a negative offset.
  const auditTotal = Number.isFinite(audit.data?.total) ? Number(audit.data?.total) : 0;

  const retry = async () => {
    const job = retryTarget;
    const reason = retryReason.trim();
    if (!job || reason.length < 10) return;
    setRetrying(job.id);
    try {
      const response = await adminAuthedFetch(`/v1/admin/jobs/${job.id}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
      const body = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "The job could not be retried.");
      await jobs.refresh();
      await audit.refresh();
      setRetryTarget(null);
      setRetryReason("");
      pushToast({ variant: "success", title: "Job requeued", body: "The worker will retry it using the recorded reason." });
    } catch (error) {
      pushToast({
        variant: "error",
        title: "The job could not be retried.",
        body: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setRetrying(null);
    }
  };

  const resolve = async () => {
    const job = resolveTarget;
    const reason = resolveReason.trim();
    if (!job || reason.length < 10) return;
    setResolving(true);
    try {
      const response = await adminAuthedFetch(`/v1/admin/jobs/${job.id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
      const body = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "The job could not be resolved.");
      await jobs.refresh();
      await audit.refresh();
      setResolveTarget(null);
      setResolveReason("");
      pushToast({ variant: "success", title: "Job resolved", body: "The terminal failure was closed and preserved in the audit trail." });
    } catch (error) {
      pushToast({ variant: "error", title: "The job could not be resolved.", body: error instanceof Error ? error.message : undefined });
    } finally {
      setResolving(false);
    }
  };

  return <div className="space-y-6">
    <AdminPageHeader title="Audit logs & background jobs" sub="Tamper-evident privileged-action history and operational failure recovery." />

    <section className="rounded-xl border border-dark-line bg-dark-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-mono text-sm font-bold">Audit-chain integrity</h2><p className="mt-1 text-xs text-dark-soft">Every new row is chained to the prior privileged event.</p></div>
        {audit.data?.integrity && <AdminPill tone={audit.data.integrity.valid ? "success" : "danger"}>{audit.data.integrity.valid ? `verified · ${audit.data.integrity.checked}` : `broken · ${audit.data.integrity.brokenAt ?? "unknown row"}`}</AdminPill>}
      </div>
      <div className="mt-4 flex gap-2"><input value={action} onChange={(event) => { setAction(event.target.value); setPage(0); }} placeholder="Exact action filter" className="min-w-0 flex-1 rounded-lg border border-dark-line-soft bg-dark-card px-3 py-2 font-mono text-xs text-dark-text" /><AdminButton variant="ghost" onClick={() => void audit.refresh()}>Refresh</AdminButton></div>
      {audit.error && <p role="alert" className="mt-3 text-xs text-rose-300">{audit.error}</p>}
      <div className="mt-4 max-h-[520px] divide-y divide-dark-line-soft overflow-auto">
        {(audit.data?.logs ?? []).map((log) => <div key={log.id} className="grid gap-2 py-3 text-xs md:grid-cols-[180px_1fr_1fr_170px]">
          <span className="break-all font-mono text-dark-text">{log.action}</span><span className="break-all text-dark-soft">{log.actorUserId ?? "system"}</span><span className="break-all text-dark-soft">{log.targetType ?? "—"} · {log.targetId ?? "—"}</span><span className="font-mono text-dark-dim">{new Date(log.createdAt).toLocaleString()}</span>
        </div>)}
        {!audit.loading && !audit.error && (audit.data?.logs.length ?? 0) === 0 && <p className="py-5 text-sm text-dark-soft">No matching audit events.</p>}
      </div>
    </section>

    {/* Only shown once the server has reported a real count, so an errored
        response cannot read as "0 of 0" audit records. */}
    {auditTotal > 0 && <AdminPagination page={page} pageSize={PAGE_SIZE} total={auditTotal} onPageChange={(next) => setPage(Math.max(0, next))} />}

    <section className="rounded-xl border border-dark-line bg-dark-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-mono text-sm font-bold">Failed and dead-letter jobs</h2><p className="mt-1 text-xs text-dark-soft">Retries require a recorded reason and preserve the prior error.</p></div><div className="flex flex-wrap gap-2">{(jobs.data?.byStatus ?? []).map((row) => <AdminPill key={row.status} tone={row.status === "dead" || row.status === "failed" ? "danger" : "neutral"}>{row.status} · {row._count._all}</AdminPill>)}</div></div>
      {jobs.error && <p role="alert" className="mt-3 text-xs text-rose-300">{jobs.error}</p>}
      <div className="mt-4 divide-y divide-dark-line-soft">{(jobs.data?.failures ?? []).map((job) => <div key={job.id} className="flex flex-wrap items-center gap-3 py-3"><div className="min-w-0 flex-1"><div className="font-mono text-xs text-dark-text">{job.type} · {job.status} · {job.attempts}/{job.maxAttempts}</div><p className="mt-1 break-words text-xs text-rose-200">{job.lastError ?? "No error detail recorded."}</p></div><AdminButton variant="ghost" disabled={retrying === job.id || resolving} onClick={() => { setRetryTarget(job); setRetryReason(""); }}>{retrying === job.id ? "Retrying…" : "Retry"}</AdminButton><AdminButton variant="ghost" disabled={retrying !== null || resolving} onClick={() => { setResolveTarget(job); setResolveReason(""); }}>Resolve</AdminButton></div>)}{!jobs.loading && !jobs.error && (jobs.data?.failures.length ?? 0) === 0 && <p className="py-5 text-sm text-dark-soft">No failed jobs.</p>}</div>
    </section>

    <AdminModal open={retryTarget !== null} onClose={retrying ? undefined : () => setRetryTarget(null)} panelClassName="w-full max-w-lg rounded-xl border border-dark-line bg-dark-panel p-5 shadow-2xl">
      <h2 className="font-mono text-base font-bold text-dark-text">Retry failed job</h2>
      <p className="mt-2 text-sm text-dark-soft">This requeues <span className="font-mono text-dark-text">{retryTarget?.type}</span>. Fix the root cause first; retrying does not bypass permissions or validation safeguards.</p>
      <label className="mt-4 block text-xs font-medium text-dark-text" htmlFor="retry-reason">Reason for retry <span className="text-rose-300">(minimum 10 characters)</span></label>
      <textarea id="retry-reason" value={retryReason} onChange={(event) => setRetryReason(event.target.value)} rows={4} maxLength={1000} placeholder="Describe what was fixed before retrying…" className="mt-2 w-full resize-y rounded-lg border border-dark-line-soft bg-dark-card px-3 py-2 text-sm text-dark-text outline-none focus:border-lime" />
      <div className="mt-5 flex justify-end gap-2">
        <AdminButton variant="ghost" disabled={Boolean(retrying)} onClick={() => setRetryTarget(null)}>Cancel</AdminButton>
        <AdminButton disabled={retryReason.trim().length < 10 || Boolean(retrying)} onClick={() => void retry()}>{retrying ? "Requeueing…" : "Retry job"}</AdminButton>
      </div>
    </AdminModal>

    <AdminModal open={resolveTarget !== null} onClose={resolving ? undefined : () => setResolveTarget(null)} panelClassName="w-full max-w-xl rounded-2xl border border-rose-400/25 bg-dark-panel p-6 shadow-2xl">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-rose-400/25 bg-rose-400/10 font-mono text-rose-300">!</div>
        <div><h2 className="text-lg font-bold tracking-tight text-dark-text">Resolve failed job</h2><p className="mt-1 text-sm leading-relaxed text-dark-soft">Close this terminal failure without retrying it.</p></div>
      </div>
      <div className="mt-5 rounded-xl border border-dark-line bg-dark-card px-4 py-3"><div className="font-mono text-xs text-dark-text">{resolveTarget?.type}</div><p className="mt-1 text-xs leading-relaxed text-dark-soft">The job and original error stay in the audit trail. This does not change stored records or delete evidence.</p></div>
      <label className="mt-5 block text-sm font-medium text-dark-text" htmlFor="resolve-reason">Why is it safe to close?</label>
      <p className="mt-1 text-xs text-dark-soft">This reason is permanent audit evidence. Minimum 10 characters.</p>
      <textarea id="resolve-reason" value={resolveReason} onChange={(event) => setResolveReason(event.target.value)} rows={3} maxLength={1000} placeholder="Example: Duplicate check timed out; the item was re-scanned manually and confirmed unique." className="mt-3 w-full resize-y rounded-xl border border-dark-line-soft bg-dark-card px-3 py-2.5 text-sm text-dark-text outline-none placeholder:text-dark-dim focus:border-lime focus:ring-1 focus:ring-lime/30" />
      <div className="mt-6 flex justify-end gap-2"><AdminButton variant="ghost" disabled={resolving} onClick={() => setResolveTarget(null)}>Keep job open</AdminButton><AdminButton disabled={resolveReason.trim().length < 10 || resolving} onClick={() => void resolve()}>{resolving ? "Resolving…" : "Resolve job"}</AdminButton></div>
    </AdminModal>
  </div>;
}
