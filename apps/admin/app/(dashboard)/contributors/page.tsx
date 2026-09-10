"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AdminButton,
  AdminErrorBanner,
  AdminModal,
  AdminPageHeader,
  AdminPill,
  AdminTable,
  AdminTableSkeletonRows,
  ATd,
} from "@/components/admin-shell";
import { useAdminResource } from "@/lib/use-admin-resource";
import { useAdminToast } from "@/lib/admin-toast";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { num, pct } from "@/lib/format";
import { AdminFilterBar, AdminPagination, resolveDateRange, type DateRangeValue } from "@/components/admin-filter-bar";

const PAGE_SIZE = 25;

interface Contributor {
  id: string;
  label: string;
  /** Public handle, null until the member claims one. */
  handle: string | null;
  rank: string | null;
  restricted: boolean;
  activeBatches: number;
  // Open-pool contributions never claim a ContributorBatch, so activeBatches
  // alone undercounts in-flight work — this covers submissions not yet
  // resolved.
  inFlightSubmissions: number;
  submitted: number;
  accepted: number;
  rejected: number;
  duplicateRate: number;
  abandonments: number;
  submissionBreakdown: Record<string, number>;
}

interface ContributorsData {
  total: number;
  contributors: Contributor[];
}

const empty: ContributorsData = { total: 0, contributors: [] };

export default function AdminContributorsPage() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRangeValue>({ preset: "30d" });
  const [page, setPage] = useState(0);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [restrictTarget, setRestrictTarget] = useState<{ id: string; label: string; restricted: boolean } | null>(null);
  const [restrictReason, setRestrictReason] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE), skip: String(page * PAGE_SIZE) });
  if (debouncedSearch) query.set("search", debouncedSearch);
  const { from, to } = useMemo(() => resolveDateRange(dateRange), [dateRange]);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const path = `/v1/admin/contributors?${query}`;

  const { data: fetched, loading, error, refresh } = useAdminResource<ContributorsData>(path, {
    errorMessage: "Contributor data is unavailable.",
  });
  const data = fetched ?? empty;
  const { pushToast } = useAdminToast();

  const submitRestrict = async () => {
    const target = restrictTarget;
    const reason = restrictReason.trim();
    if (!target || reason.length < 10) return;
    setPendingAction(target.id);
    try {
      const response = await adminAuthedFetch(`/v1/admin/contributors/${target.id}/restrict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restricted: target.restricted, reason }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null) as { message?: string } | null)?.message ?? "Account action failed.");
      await refresh();
      pushToast({ variant: "success", title: target.restricted ? "Contributor restricted" : "Contributor reinstated" });
      setRestrictTarget(null);
      setRestrictReason("");
    } catch (actionError) {
      pushToast({
        variant: "error",
        title: "Account action failed",
        body: actionError instanceof Error ? actionError.message : undefined,
      });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Contributors"
        sub="Every account that has claimed or submitted to a dataset — identity and quality signals."
      />

      {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}

      <AdminFilterBar
        search={search}
        onSearchChange={(v) => {
          setSearch(v);
          setPage(0);
        }}
        searchPlaceholder="search by name, email, or handle…"
        dateRange={dateRange}
        onDateRangeChange={(v) => {
          setDateRange(v);
          setPage(0);
        }}
      />

      <AdminTable
        headers={[
          "contributor",
          "rank",
          "active",
          "submitted",
          "accepted",
          "rejected",
          "dup rate",
          "abandon",
          "profile",
          "actions",
        ]}
      >
        {data.contributors.map((c) => (
          <tr key={c.id}>
            <ATd className="font-semibold">
              {c.label}
              {c.handle && <span className="block text-xs font-normal text-dark-soft">@{c.handle}</span>}
            </ATd>
            <ATd>{c.rank ? <AdminPill tone="lime">{c.rank}</AdminPill> : <span className="text-dark-dim">unranked</span>}</ATd>
            <ATd>
              <span title={`${num(c.activeBatches)} claimed batch(es) · ${num(c.inFlightSubmissions)} open-pool submission(s) still in flight`}>
                {num(c.activeBatches + c.inFlightSubmissions)}
              </span>
            </ATd>
            <ATd>{num(c.submitted)}</ATd>
            <ATd>{num(c.accepted)}</ATd>
            <ATd>{num(c.rejected)}</ATd>
            <ATd className={c.duplicateRate > 0.15 ? "text-amber-400" : ""}>
              {pct(c.duplicateRate)}
            </ATd>
            <ATd className={c.abandonments > 0 ? "text-rose-400" : ""}>
              {num(c.abandonments)}
            </ATd>
            <ATd>
              <Link href={`/details?kind=contributor&id=${encodeURIComponent(c.id)}`} className="font-mono text-xs text-lime underline">
                view detail →
              </Link>
            </ATd>
            <ATd>
              {c.restricted ? (
                <AdminButton
                  variant="ghost"
                  tooltip="Reinstate this contributor so their account can participate again."
                  disabled={pendingAction === c.id}
                  onClick={() => { setRestrictTarget({ id: c.id, label: c.label, restricted: false }); setRestrictReason(""); }}
                >
                  Reinstate
                </AdminButton>
              ) : (
                <AdminButton
                  variant="ghost"
                  tooltip="Restrict this contributor account from participating in new work."
                  disabled={pendingAction === c.id}
                  onClick={() => { setRestrictTarget({ id: c.id, label: c.label, restricted: true }); setRestrictReason(""); }}
                >
                  Restrict
                </AdminButton>
              )}
            </ATd>
          </tr>
        ))}
        {loading && data.contributors.length === 0 && <AdminTableSkeletonRows columns={10} />}
        {!loading && data.contributors.length === 0 && (
          <tr>
            <ATd colSpan={10} className="text-dark-soft">No contributors match this search.</ATd>
          </tr>
        )}
      </AdminTable>

      <AdminPagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />

      <AdminModal
        open={restrictTarget !== null}
        onClose={pendingAction ? undefined : () => setRestrictTarget(null)}
        panelClassName="w-full max-w-lg rounded-xl border border-dark-line bg-dark-panel p-5 shadow-2xl"
      >
        <h2 className="font-mono text-base font-bold text-dark-text">
          {restrictTarget?.restricted ? "Restrict this contributor" : "Reinstate this contributor"}
        </h2>
        <p className="mt-2 text-sm text-dark-soft">
          {restrictTarget?.restricted ? (
            <>This blocks <span className="font-mono text-dark-text">{restrictTarget?.label}</span> from claiming or submitting new work until reinstated.</>
          ) : (
            <>This restores <span className="font-mono text-dark-text">{restrictTarget?.label}</span>&rsquo;s ability to participate in new work.</>
          )}
        </p>
        <label className="mt-4 block text-xs font-medium text-dark-text" htmlFor="contributor-restrict-reason">
          Reason <span className="text-rose-300">(minimum 10 characters)</span>
        </label>
        <textarea
          id="contributor-restrict-reason"
          value={restrictReason}
          onChange={(event) => setRestrictReason(event.target.value)}
          rows={4}
          maxLength={1000}
          placeholder={restrictTarget?.restricted ? "Describe why this account is being restricted…" : "Describe why this account is being reinstated…"}
          className="mt-2 w-full resize-y rounded-lg border border-dark-line-soft bg-dark-card px-3 py-2 text-sm text-dark-text outline-none focus:border-lime"
        />
        <div className="mt-5 flex justify-end gap-2">
          <AdminButton variant="ghost" disabled={pendingAction === restrictTarget?.id} onClick={() => setRestrictTarget(null)}>
            Cancel
          </AdminButton>
          <AdminButton
            disabled={restrictReason.trim().length < 10 || pendingAction === restrictTarget?.id}
            onClick={() => void submitRestrict()}
          >
            {pendingAction === restrictTarget?.id ? "Saving…" : restrictTarget?.restricted ? "Restrict" : "Reinstate"}
          </AdminButton>
        </div>
      </AdminModal>
    </div>
  );
}
