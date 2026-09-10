"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AdminButton,
  AdminDate,
  AdminErrorBanner,
  AdminModal,
  AdminPageHeader,
  AdminPill,
  AdminTable,
  AdminTableSkeletonRows,
  ATd,
  type AdminPillTone,
} from "@/components/admin-shell";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { useAdminResource } from "@/lib/use-admin-resource";
import { useAdminToast } from "@/lib/admin-toast";
import { num, pct } from "@/lib/format";
import { AdminFilterBar, AdminPagination, resolveDateRange, type DateRangeValue } from "@/components/admin-filter-bar";

const PAGE_SIZE = 25;

interface Validator {
  id: string;
  label: string;
  /** Public handle, null until the member claims one. */
  handle: string | null;
  rank: string | null;
  restricted: boolean;
  activeAudits: number;
  auditsCompleted: number;
  issuesFlagged: number;
  confirmedRate: number;
  falseFlagRate: number;
  createdAt: string;
  auditBreakdown: Record<string, number>;
  flagBreakdown: Record<string, number>;
}

interface ValidatorsData {
  total: number;
  validators: Validator[];
}

const empty: ValidatorsData = { total: 0, validators: [] };

function rateTone(value: number): AdminPillTone {
  return value > 0.15 ? "danger" : value > 0.1 ? "warning" : "success";
}

export default function AdminValidatorsPage() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRangeValue>({ preset: "30d" });
  const [page, setPage] = useState(0);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [restrictTarget, setRestrictTarget] = useState<{ id: string; label: string; restricted: boolean } | null>(null);
  const [restrictReason, setRestrictReason] = useState("");
  const { pushToast } = useAdminToast();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE), skip: String(page * PAGE_SIZE) });
  if (debouncedSearch) query.set("search", debouncedSearch);
  const { from, to } = useMemo(() => resolveDateRange(dateRange), [dateRange]);
  if (from) query.set("from", from);
  if (to) query.set("to", to);

  const { data: fetched, loading, error, refresh } = useAdminResource<ValidatorsData>(
    `/v1/admin/validators?${query}`,
    { errorMessage: "Validator data is unavailable." }
  );
  const data = fetched ?? empty;

  const submitRestrict = async () => {
    const target = restrictTarget;
    const reason = restrictReason.trim();
    if (!target || reason.length < 10) return;
    setPendingAction(target.id);
    try {
      const response = await adminAuthedFetch(`/v1/admin/validators/${target.id}/restrict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restricted: target.restricted, reason }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null) as { message?: string } | null)?.message ?? "Account action failed.");
      pushToast({ variant: "success", title: target.restricted ? "Validator restricted" : "Validator reinstated" });
      await refresh();
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
        title="Validators"
        sub="Real audit workforce health — persisted flag accuracy and account actions."
      />

      {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}

      <AdminFilterBar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(0);
        }}
        searchPlaceholder="search by name, email, or handle…"
        dateRange={dateRange}
        onDateRangeChange={(value) => {
          setDateRange(value);
          setPage(0);
        }}
      />

      <AdminTable
        headers={[
          "validator", "joined", "rank", "active", "completed", "flagged",
          "confirmed", "false flag", "actions",
        ]}
        caption="Validator roster"
      >
        {data.validators.map((v) => (
          <tr key={v.id}>
            <ATd className="max-w-48 truncate font-semibold">
              {v.label}
              {v.handle && <span className="block text-xs font-normal text-dark-soft">@{v.handle}</span>}
            </ATd>
            <ATd className="whitespace-nowrap text-dark-soft"><AdminDate iso={v.createdAt} /></ATd>
            <ATd>{v.rank ? <AdminPill tone="info">{v.rank}</AdminPill> : <span className="text-dark-dim">unranked</span>}</ATd>
            <ATd>{num(v.activeAudits)}</ATd>
            <ATd>{num(v.auditsCompleted)}</ATd>
            <ATd>{num(v.issuesFlagged)}</ATd>
            <ATd><AdminPill tone={rateTone(v.confirmedRate)}>{pct(v.confirmedRate)}</AdminPill></ATd>
            <ATd><AdminPill tone={v.falseFlagRate > 0.15 ? "danger" : v.falseFlagRate > 0.1 ? "warning" : "neutral"}>{pct(v.falseFlagRate)}</AdminPill></ATd>
            <ATd>
              <div className="flex flex-wrap items-center gap-1.5">
              <Link href={`/details?kind=validator&id=${encodeURIComponent(v.id)}`} className="font-mono text-xs text-lime underline">
                view detail →
              </Link>
              {v.restricted ? (
                <AdminButton variant="ghost" tooltip="Reinstate this validator so they can receive audit work again." disabled={pendingAction === v.id} onClick={() => { setRestrictTarget({ id: v.id, label: v.label, restricted: false }); setRestrictReason(""); }}>
                  Reinstate
                </AdminButton>
              ) : (
                <AdminButton variant="ghost" tooltip="Restrict this validator account from receiving new audit work." disabled={pendingAction === v.id} onClick={() => { setRestrictTarget({ id: v.id, label: v.label, restricted: true }); setRestrictReason(""); }}>
                  Restrict
                </AdminButton>
              )}
              </div>
            </ATd>
          </tr>
        ))}
        {loading && data.validators.length === 0 && <AdminTableSkeletonRows columns={9} />}
        {!loading && data.validators.length === 0 && (
          <tr><ATd colSpan={9} className="text-dark-soft">No validators match this search.</ATd></tr>
        )}
      </AdminTable>

      <AdminPagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />

      <AdminModal
        open={restrictTarget !== null}
        onClose={pendingAction ? undefined : () => setRestrictTarget(null)}
        panelClassName="w-full max-w-lg rounded-xl border border-dark-line bg-dark-panel p-5 shadow-2xl"
      >
        <h2 className="font-mono text-base font-bold text-dark-text">
          {restrictTarget?.restricted ? "Restrict this validator" : "Reinstate this validator"}
        </h2>
        <p className="mt-2 text-sm text-dark-soft">
          {restrictTarget?.restricted ? (
            <>This blocks <span className="font-mono text-dark-text">{restrictTarget?.label}</span> from receiving new audit work until reinstated.</>
          ) : (
            <>This restores <span className="font-mono text-dark-text">{restrictTarget?.label}</span>&rsquo;s ability to receive audit work.</>
          )}
        </p>
        <label className="mt-4 block text-xs font-medium text-dark-text" htmlFor="validator-restrict-reason">
          Reason <span className="text-rose-300">(minimum 10 characters)</span>
        </label>
        <textarea
          id="validator-restrict-reason"
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
