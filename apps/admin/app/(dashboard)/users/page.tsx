"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AdminDate,
  AdminErrorBanner,
  AdminPageHeader,
  AdminPill,
  AdminSkeleton,
  AdminStat,
  AdminTable,
  AdminTableSkeletonRows,
  ATd,
} from "@/components/admin-shell";
import { useAdminResource } from "@/lib/use-admin-resource";
import { num } from "@/lib/format";
import { AdminFilterBar, AdminPagination, resolveDateRange, type DateRangeValue } from "@/components/admin-filter-bar";

const PAGE_SIZE = 25;

type RoleFilter = "all" | "any" | "none" | "admin" | "member" | "support";
type StatusFilter = "all" | "active" | "suspended" | "closed";
type ActivityFilter = "all" | "sponsor" | "contributor" | "validator" | "none";
type SortKey = "recent" | "oldest" | "active" | "karma";

interface UserActivity {
  sponsoredBounties: number;
  /** Requests not yet minted into a bounty; an implemented one is its bounty. */
  openDatasetRequests: number;
  submissions: number;
  acceptedSubmissions: number;
  audits: number;
  /** Distinct datasets/bounties submitted to, not raw submission count. */
  distinctDatasetsContributed: number;
}

interface AdminUser {
  id: string;
  email: string | null;
  displayName: string;
  handle: string | null;
  authMethod: string;
  status: string;
  onboarded: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  karmaTotal: number;
  persona: string | null;
  roles: string[];
  activity: UserActivity;
}

interface UsersSummary {
  matching: number;
  allTimeTotal: number;
  admins: { admin: number; member: number; support: number; total: number };
  emailVerified: number;
  onboarded: number;
}

interface UsersData {
  total: number;
  users: AdminUser[];
  /** null only until the first response arrives; the server always sends one. */
  summary: UsersSummary | null;
}

const empty: UsersData = { total: 0, users: [], summary: null };

const ROLE_OPTIONS: { key: RoleFilter; label: string }[] = [
  { key: "all", label: "all accounts" },
  { key: "any", label: "any admin tier" },
  { key: "admin", label: "admin" },
  { key: "member", label: "member" },
  { key: "support", label: "support" },
  { key: "none", label: "no admin tier" },
];

const ACTIVITY_OPTIONS: { key: ActivityFilter; label: string }[] = [
  { key: "all", label: "any activity" },
  { key: "sponsor", label: "sponsored" },
  { key: "contributor", label: "contributed" },
  { key: "validator", label: "validated" },
  { key: "none", label: "never participated" },
];

const selectClass =
  "cursor-pointer rounded-lg border border-dark-line bg-dark-panel px-3 py-2 font-mono text-xs text-dark-text focus:border-dark-hover focus:outline-none";

/** Per-column visibility for the 13-column roster: persona, signed up,
 *  datasets and audited drop below lg. Applied to the headers, the ATds, and
 *  the loading skeleton so all three stay in step. */
const HIDE_BELOW_LG = "hidden lg:table-cell";
const USERS_COLUMN_CLASSES: Array<string | undefined> = [
  undefined, undefined, HIDE_BELOW_LG, undefined, HIDE_BELOW_LG, undefined,
  undefined, undefined, undefined, HIDE_BELOW_LG, HIDE_BELOW_LG, undefined, undefined,
];

function ChipRow<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-dark-dim">{label}</span>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`cursor-pointer rounded-full border px-3.5 py-2.5 font-mono text-xs transition-colors sm:py-1.5 ${
            value === o.key
              ? "border-lime bg-lime/15 text-lime"
              : "border-dark-line text-dark-soft hover:border-dark-hover hover:text-dark-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function AdminUsersPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRangeValue>({ preset: "all" });
  const [role, setRole] = useState<RoleFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activity, setActivity] = useState<ActivityFilter>("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { from, to } = useMemo(() => resolveDateRange(dateRange), [dateRange]);

  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    skip: String(page * PAGE_SIZE),
    role,
    status: statusFilter,
    activity,
    sort,
  });
  if (debouncedSearch) query.set("search", debouncedSearch);
  if (from) query.set("from", from);
  if (to) query.set("to", to);

  const { data: fetched, loading, error, refresh } = useAdminResource<UsersData>(`/v1/admin/users?${query}`, {
    errorMessage: "User data is unavailable.",
  });
  const data = fetched ?? empty;
  // null only means "no response yet" — the server always sends a summary.
  // Rendered as skeletons below rather than zeros, which would read as a
  // platform with no accounts.
  const summary = data.summary;
  // A date filter narrows the roster to a signup window — say so, rather than
  // letting the tiles read as the platform's whole population.
  const filtered = Boolean(from || to) || role !== "all" || statusFilter !== "all" || activity !== "all" || !!debouncedSearch;

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Users"
        sub="Every account on the platform — admin tiers, signup window, and what each account has actually done."
      />

      {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}

      {summary ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <AdminStat label="total accounts" value={num(summary.allTimeTotal)} sub="all time · filters do not apply" />
            <AdminStat
              label={filtered ? "matching filters" : "matching"}
              value={num(summary.matching)}
              tone="lime"
              sub={filtered ? "current filter set" : "no filters applied"}
            />
            <AdminStat
              label="admin accounts"
              value={num(summary.admins.total)}
              sub={`all time · ${num(summary.admins.admin)} admin · ${num(summary.admins.member)} member · ${num(summary.admins.support)} support`}
            />
            <AdminStat
              label="email verified"
              value={num(summary.emailVerified)}
              sub={`all time · ${num(summary.onboarded)} onboarded`}
            />
          </div>
        </>
      ) : (
        // No summary yet (first load, or it failed): show skeletons. Zero-filled
        // tiles would read as a platform with no accounts.
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <AdminSkeleton key={i} className="h-[92px] rounded-[11px]" />
          ))}
        </div>
      )}

      <p className="font-mono text-[10px] leading-relaxed text-dark-dim">
        Sponsor, contributor and validator are not granted roles — they are counted from real work records
        (pools, submissions, audits). Only admin / member / support appear in the roles column.
      </p>

      <div className="flex flex-col gap-3 rounded-xl border border-dark-line bg-dark-card p-3">
        <ChipRow label="tier" options={ROLE_OPTIONS} value={role} onChange={(v) => { setRole(v); setPage(0); }} />
        <ChipRow label="activity" options={ACTIVITY_OPTIONS} value={activity} onChange={(v) => { setActivity(v); setPage(0); }} />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-dark-dim">status</span>
            <select
              className={selectClass}
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setPage(0); }}
            >
              <option value="all">all</option>
              <option value="active">active</option>
              <option value="suspended">suspended</option>
              <option value="closed">closed</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-dark-dim">sort</span>
            <select
              className={selectClass}
              value={sort}
              onChange={(e) => { setSort(e.target.value as SortKey); setPage(0); }}
            >
              <option value="recent">newest signup</option>
              <option value="oldest">oldest signup</option>
              <option value="active">last seen</option>
              <option value="karma">karma</option>
            </select>
          </label>
        </div>
      </div>

      <AdminFilterBar
        search={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        searchPlaceholder="search by name, email, or handle…"
        dateRange={dateRange}
        onDateRangeChange={(v) => { setDateRange(v); setPage(0); }}
      />
      <p className="font-mono text-[10px] text-dark-dim">
        The date range filters accounts by signup date. Activity columns are lifetime totals.
      </p>

      <AdminTable
        // Thirteen columns is ~4 screen-widths of drag on a phone, over rows
        // that are themselves navigation targets. The four lowest-value columns
        // drop below lg; each is paired with the same class on its ATd.
        headers={[
          "account",
          "roles",
          { label: "persona", className: "hidden lg:table-cell" },
          "status",
          { label: "signed up", className: "hidden lg:table-cell" },
          "last seen",
          "sponsored",
          "submitted",
          "accepted",
          { label: "datasets", className: "hidden lg:table-cell" },
          { label: "audited", className: "hidden lg:table-cell" },
          "karma",
          "record",
        ]}
      >
        {data.users.map((u) => (
          <tr
            key={u.id}
            role="link"
            tabIndex={0}
            onClick={() => router.push(`/users/view?id=${encodeURIComponent(u.id)}`)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                router.push(`/users/view?id=${encodeURIComponent(u.id)}`);
              }
            }}
            className="cursor-pointer transition-colors hover:bg-white/[0.025] focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime"
          >
            <ATd className="font-semibold">
              <div className="text-dark-text">{u.displayName}</div>
              <div className="text-[10px] text-dark-dim">
                {u.email ?? "no email"}
                {u.handle ? ` · @${u.handle}` : ""}
                {!u.emailVerified && <span className="text-amber-400"> · unverified</span>}
              </div>
            </ATd>
            <ATd>
              {u.roles.length ? (
                <div className="flex flex-wrap gap-1">
                  {u.roles.map((r) => (
                    <AdminPill key={r} tone={r === "admin" ? "lime" : "neutral"}>{r}</AdminPill>
                  ))}
                </div>
              ) : (
                <span className="text-dark-dim">—</span>
              )}
            </ATd>
            <ATd className="hidden text-dark-soft lg:table-cell">{u.persona ?? <span className="text-dark-dim">—</span>}</ATd>
            <ATd>
              <AdminPill tone={u.status === "active" ? "lime" : u.status === "suspended" ? "danger" : "neutral"}>
                {u.status}
              </AdminPill>
            </ATd>
            <ATd className="hidden lg:table-cell"><AdminDate iso={u.createdAt} /></ATd>
            <ATd>{u.lastSeenAt ? <AdminDate iso={u.lastSeenAt} /> : <span className="text-dark-dim">never</span>}</ATd>
            <ATd>
              <span title={`${num(u.activity.sponsoredBounties)} minted pool(s) · ${num(u.activity.openDatasetRequests)} request(s) not yet minted. An implemented request is counted once, as its pool.`}>
                {num(u.activity.sponsoredBounties + u.activity.openDatasetRequests)}
              </span>
            </ATd>
            <ATd>{num(u.activity.submissions)}</ATd>
            <ATd>{num(u.activity.acceptedSubmissions)}</ATd>
            <ATd className="hidden lg:table-cell">
              <span title="Distinct datasets/pools this account has submitted to.">
                {num(u.activity.distinctDatasetsContributed)}
              </span>
            </ATd>
            <ATd className="hidden lg:table-cell">{num(u.activity.audits)}</ATd>
            <ATd>{num(u.karmaTotal)}</ATd>
            <ATd>
              <Link
                href={`/users/view?id=${encodeURIComponent(u.id)}`}
                onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
                className="font-mono text-xs text-lime underline"
              >
                open →
              </Link>
            </ATd>
          </tr>
        ))}
        {loading && data.users.length === 0 && (
          // Same per-column classes as the headers/ATds above, so the loading
          // rows drop the same four columns below lg instead of rendering
          // thirteen cells under a nine-column header.
          <AdminTableSkeletonRows columns={13} columnClassNames={USERS_COLUMN_CLASSES} />
        )}
        {!loading && data.users.length === 0 && (
          <tr>
            <ATd colSpan={13} className="text-dark-soft">No accounts match these filters.</ATd>
          </tr>
        )}
      </AdminTable>

      <AdminPagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />
    </div>
  );
}
