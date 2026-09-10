"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { adminAuthedFetch } from "@/lib/admin-auth";
import {
  AdminErrorBanner,
  AdminPageHeader,
  AdminPill,
  AdminTable,
  ATd,
  type AdminPillTone,
} from "@/components/admin-shell";
import { Icon } from "@/components/icons";
import {
  DOMAINS,
  TRUST_TIER_LABELS,
  type DatasetType,
  type TrustTier,
  type TypeStatus,
} from "@/lib/dataset-types";
import { AdminPagination } from "@/components/admin-filter-bar";

const PAGE_SIZE = 25;
type OriginFilter = "" | "platform" | "sponsor";
type StatusFilter = "" | TypeStatus;
type TierFilter = "" | TrustTier;

/* ---------- pills ---------- */

const TIER_TONE: Record<TrustTier, AdminPillTone> = {
  execution_verified: "lime",
  llm_verified: "info",
  expert_audited: "violet",
};

function TierPill({ tier }: { tier: TrustTier }) {
  return <AdminPill tone={TIER_TONE[tier]}>{TRUST_TIER_LABELS[tier]}</AdminPill>;
}

const STATUS_LABEL: Record<TypeStatus, string> = {
  active: "active",
  draft: "draft",
  coming_soon: "coming soon",
  platform_review: "needs review",
};

function TypeStatusPill({ status }: { status: TypeStatus }) {
  const tone =
    status === "active"
      ? "success"
      : status === "platform_review"
        ? "warning"
        : status === "coming_soon"
          ? "info"
          : "neutral";
  return <AdminPill tone={tone}>{STATUS_LABEL[status]}</AdminPill>;
}

/* ---------- page ---------- */

export default function AdminDatasetsPage() {
  const router = useRouter();
  const [liveTypes, setLiveTypes] = useState<DatasetType[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [domain, setDomain] = useState<"" | DatasetType["domain"]>("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [origin, setOrigin] = useState<OriginFilter>("");
  const [trustTier, setTrustTier] = useState<TierFilter>("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), skip: String(page * PAGE_SIZE) });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (domain) params.set("domain", domain);
    if (status) params.set("status", status);
    if (origin) params.set("origin", origin);
    if (trustTier) params.set("trustTier", trustTier);
    return params.toString();
  }, [debouncedSearch, domain, status, origin, trustTier, page]);

  const loadTypes = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminAuthedFetch(`/v1/admin/dataset-types?${query}`);
      const body = (await response.json().catch(() => null)) as { datasetTypes?: DatasetType[]; total?: number; message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "Could not load dataset types.");
      if (!Array.isArray(body?.datasetTypes) || typeof body.total !== "number") throw new Error("The dataset-type response was invalid.");
      setLiveTypes(body.datasetTypes);
      setTotal(body.total);
      setError(null);
    } catch (cause) {
      setLiveTypes([]);
      setTotal(0);
      setError(cause instanceof Error ? cause.message : "Could not load dataset types.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTypes(), 0);
    return () => window.clearTimeout(timer);
  }, [loadTypes]);

  const visibleTypes = liveTypes;

  const active = visibleTypes.filter((t) => t.status === "active").length;
  const inReview = visibleTypes.filter((t) => t.status === "platform_review");

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Dataset types"
        sub={`${total} matching types across ${DOMAINS.length} domains, ${active} active on this page. Every type renders its three surfaces from field roles.`}
        actions={(
          <Link
            href="/datasets/new"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-lime px-3.5 py-2 font-mono text-xs font-medium text-dark transition-colors hover:bg-lime-bright"
          >
            <Icon name="plus" size={13} strokeWidth={2.5} />
            new dataset type
          </Link>
        )}
      />

      {loading && <div role="status" className="font-mono text-sm text-dark-soft">Loading live dataset types…</div>}
      {error && (
        <AdminErrorBanner message={`${error} No demo catalog is being shown.`} onRetry={() => void loadTypes()} />
      )}
      <div className="flex flex-col gap-3 rounded-xl border border-dark-line bg-dark-card p-3 lg:flex-row lg:items-center">
        <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Search name, id, or description…" className="min-w-0 flex-1 rounded-lg border border-dark-line-soft bg-dark-panel px-3 py-2 font-mono text-xs text-dark-text placeholder:text-dark-dim focus:border-dark-hover focus:outline-none" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <select aria-label="Filter by domain" value={domain} onChange={(e) => { setDomain(e.target.value as typeof domain); setPage(0); }} className="w-full min-w-0 rounded-lg border border-dark-line-soft bg-dark-panel px-2 py-2 font-mono text-xs text-dark-text"><option value="">All domains</option>{DOMAINS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(0); }} className="w-full min-w-0 rounded-lg border border-dark-line-soft bg-dark-panel px-2 py-2 font-mono text-xs text-dark-text"><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="Filter by origin" value={origin} onChange={(e) => { setOrigin(e.target.value as OriginFilter); setPage(0); }} className="w-full min-w-0 rounded-lg border border-dark-line-soft bg-dark-panel px-2 py-2 font-mono text-xs text-dark-text"><option value="">All origins</option><option value="platform">Platform</option><option value="sponsor">Sponsor</option></select>
          <select aria-label="Filter by trust tier" value={trustTier} onChange={(e) => { setTrustTier(e.target.value as TierFilter); setPage(0); }} className="w-full min-w-0 rounded-lg border border-dark-line-soft bg-dark-panel px-2 py-2 font-mono text-xs text-dark-text"><option value="">All tiers</option>{Object.entries(TRUST_TIER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </div>
      </div>
      {!loading && !error && visibleTypes.length === 0 && <div className="rounded-xl border border-dark-line bg-dark-card px-5 py-6 text-sm text-dark-soft">No dataset types have been configured.</div>}

      {inReview.length > 0 && (
        <div className="flex items-start gap-3 rounded-[11px] border border-dark-warn-border bg-amber-400/10 p-[18px]">
          <Icon
            name="alert"
            size={16}
            strokeWidth={2}
            className="mt-0.5 shrink-0 text-amber-400"
          />
          <div className="font-mono text-xs leading-relaxed">
            <span className="font-bold text-amber-400">
              {inReview.length} sponsor-submitted type
              {inReview.length > 1 ? "s" : ""} awaiting platform review
            </span>
            <span className="text-dark-soft">
              {". "}
              Pools on these types can&apos;t launch until approved.{" "}
            </span>
            {inReview.map((t, i) => (
              <span key={t.id}>
                {i > 0 && <span className="text-dark-dim"> · </span>}
                <Link
                  href={`/datasets/view?id=${encodeURIComponent(t.id)}`}
                  className="text-amber-400 underline underline-offset-2 hover:text-amber-300"
                >
                  {t.name}
                </Link>
              </span>
            ))}
          </div>
        </div>
      )}

      {!loading && !error && visibleTypes.length > 0 && <section>
            <AdminTable
              headers={[
                "type",
                "trust tier",
                "status",
                "origin",
                "fields",
                "usage",
              ]}
            >
              {visibleTypes.map((t: DatasetType) => (
                <tr
                  key={t.id}
                  onClick={() => router.push(`/datasets/view?id=${encodeURIComponent(t.id)}`)}
                  className="cursor-pointer"
                >
                  <ATd>
                    <Link
                      href={`/datasets/view?id=${encodeURIComponent(t.id)}`}
                      className="block"
                      onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
                    >
                      <div className="max-w-64 font-semibold leading-snug text-dark-text">
                        {t.name}
                      </div>
                      <div className="mt-0.5 text-[10px] text-dark-dim">
                        {t.id} · v{t.version}
                      </div>
                    </Link>
                  </ATd>
                  <ATd>
                    <TierPill tier={t.trustTier} />
                  </ATd>
                  <ATd>
                    <TypeStatusPill status={t.status} />
                  </ATd>
                  <ATd className="text-dark-soft">{t.origin}</ATd>
                  <ATd className="text-dark-soft">{t.fields.length}</ATd>
                  <ATd
                    className={
                      t.usageCount > 0 ? "text-dark-text" : "text-dark-dim"
                    }
                  >
                    {t.usageCount > 0
                      ? `used by ${t.usageCount} pool${t.usageCount > 1 ? "s" : ""}`
                      : "unused"}
                  </ATd>
                </tr>
              ))}
            </AdminTable>
          </section>}
      {!loading && !error && <AdminPagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />}
    </div>
  );
}
