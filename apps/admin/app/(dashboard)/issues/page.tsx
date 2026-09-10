"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AdminEmptyState,
  AdminErrorBanner,
  AdminPageHeader,
  AdminPill,
  AdminTable,
  AdminTableSkeletonRows,
  AdminDateTime,
} from "@/components/admin-shell";
import { useAdminResource } from "@/lib/use-admin-resource";
import { useAdminRoleGates } from "@/lib/admin-auth";
import {
  impactTone,
  ISSUE_CATEGORY_LABELS,
  ISSUE_IMPACT_LABELS,
  ISSUE_STATUS_LABELS,
  severityTone,
  statusTone,
  type IssueCategory,
  type IssueImpact,
  issueQueryString,
  type IssueQueueHealth,
  type IssueQueuePage,
  type IssueSource,
  type IssueRow,
  type IssueSeverity,
  type IssueStatus,
} from "@/lib/agent-issues";

/**
 * Agent Issues queue — platform defects reported by agents over MCP.
 *
 * This is a SUPPORT queue, not an adjudication surface: nothing done here
 * changes a submission, audit, or karma balance. Flags and disputes
 * remain the only route for those.
 *
 * Filters are server-side and mirrored into the URL so a triage view can be
 * shared or reloaded. Every filter change resets the cursor and cancels the
 * stale request, because a slow first response must never land on top of a
 * newer filter's results.
 */

const STATUS_OPTIONS: (IssueStatus | "")[] = [
  "",
  "received",
  "triaged",
  "investigating",
  "needs_info",
  "resolved",
  "rejected",
  "not_reproducible",
  "duplicate",
];

const CATEGORY_OPTIONS: (IssueCategory | "")[] = [
  "",
  "contract",
  "validation",
  "mcp",
  "upload_processing",
  "data_quality",
  "security_privacy",
  "abuse",
  "other",
];

const IMPACT_OPTIONS: (IssueImpact | "")[] = ["", "blocked", "degraded", "suggestion"];
const SOURCE_OPTIONS: (IssueSource | "")[] = ["", "mcp_oauth", "api_key", "session"];
const SOURCE_LABELS: Record<IssueSource, string> = {
  mcp_oauth: "MCP (OAuth)",
  api_key: "API key",
  session: "Dashboard",
};
const SEVERITY_OPTIONS: (IssueSeverity | "")[] = ["", "critical", "high", "medium", "low"];

const selectClass =
  "rounded-[8px] border border-dark-line bg-dark-bg px-2.5 py-2.5 font-mono text-[12px] text-dark-text sm:py-1.5 sm:text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/60";

export default function AdminIssuesPage() {
  const [status, setStatus] = useState<IssueStatus | "">("");
  const [category, setCategory] = useState<IssueCategory | "">("");
  const [impact, setImpact] = useState<IssueImpact | "">("");
  const [severity, setSeverity] = useState<IssueSeverity | "">("");
  const [source, setSource] = useState<IssueSource | "">("");
  const [search, setSearch] = useState("");
  const [includeClosed, setIncludeClosed] = useState(false);
  const { isAdmin } = useAdminRoleGates();

  const [cursor, setCursor] = useState<string | null>(null);

  // The query string IS the request identity, so a filter change swaps the
  // resource rather than racing the previous one: a slow earlier response can
  // never land on top of a newer filter's results.
  const { data, loading, error, refresh } = useAdminResource<IssueQueuePage>(
    `/v1/admin/issues${issueQueryString({ status, category, impact, severity, source, q: search, includeClosed, cursor })}`,
    { errorMessage: "The issue queue is unavailable." }
  );
  // Admin-only, and shown as its own line rather than mixed into the rows:
  // queue health is a statement about the BACKLOG, not about any one case.
  const { data: health } = useAdminResource<IssueQueueHealth>("/v1/admin/issues-health", {
    enabled: isAdmin,
    errorMessage: "Queue health is unavailable.",
  });
  const rows: IssueRow[] = data?.items ?? [];
  const nextCursor = data?.nextCursor ?? null;

  // Any filter change starts a fresh page — keeping an old cursor would page
  // into a result set that no longer exists.
  function onFilterChange<T>(setter: (value: T) => void) {
    return (value: T) => {
      setCursor(null);
      setter(value);
    };
  }

  const sharedUrl =
    typeof window !== "undefined"
      ? `${window.location.pathname}?${new URLSearchParams({
          ...(status ? { status } : {}),
          ...(category ? { category } : {}),
          ...(impact ? { impact } : {}),
          ...(severity ? { severity } : {}),
          ...(source ? { source } : {}),
          ...(search.trim().length >= 2 ? { q: search.trim() } : {}),
          ...(includeClosed ? { includeClosed: "true" } : {}),
        }).toString()}`
      : "";

  // Keep the address bar in step with the filters, without adding a history
  // entry per keystroke-equivalent change.
  useEffect(() => {
    if (typeof window === "undefined" || !sharedUrl) return;
    window.history.replaceState(null, "", sharedUrl);
  }, [sharedUrl]);

  return (
    <div className="space-y-5">
      <AdminPageHeader
        eyebrow="Operations"
        title="Agent issues"
        sub="Platform defects reported by agents. Support cases only — nothing here changes a submission, audit, or karma balance."
      />

      {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Issue filters">
        <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
          Status
          <select
            className={selectClass}
            value={status}
            onChange={(e) => onFilterChange(setStatus)(e.target.value as IssueStatus | "")}
            aria-label="Filter by status"
          >
            {STATUS_OPTIONS.map((value) => (
              <option key={value || "any"} value={value}>
                {value ? ISSUE_STATUS_LABELS[value] : "Open work"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
          Category
          <select
            className={selectClass}
            value={category}
            onChange={(e) => onFilterChange(setCategory)(e.target.value as IssueCategory | "")}
            aria-label="Filter by category"
          >
            {CATEGORY_OPTIONS.map((value) => (
              <option key={value || "any"} value={value}>
                {value ? ISSUE_CATEGORY_LABELS[value] : "Any category"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
          Impact
          <select
            className={selectClass}
            value={impact}
            onChange={(e) => onFilterChange(setImpact)(e.target.value as IssueImpact | "")}
            aria-label="Filter by impact"
          >
            {IMPACT_OPTIONS.map((value) => (
              <option key={value || "any"} value={value}>
                {value ? ISSUE_IMPACT_LABELS[value] : "Any impact"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
          Severity
          <select
            className={selectClass}
            value={severity}
            onChange={(e) => onFilterChange(setSeverity)(e.target.value as IssueSeverity | "")}
            aria-label="Filter by severity"
          >
            {SEVERITY_OPTIONS.map((value) => (
              <option key={value || "any"} value={value}>
                {value ? value : "Any severity"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
          Source
          <select
            className={selectClass}
            value={source}
            onChange={(e) => onFilterChange(setSource)(e.target.value as IssueSource | "")}
            aria-label="Filter by how the report arrived"
          >
            {SOURCE_OPTIONS.map((value) => (
              <option key={value || "any"} value={value}>
                {value ? SOURCE_LABELS[value] : "Any source"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
          Search
          <input
            type="search"
            className={selectClass}
            value={search}
            onChange={(e) => onFilterChange(setSearch)(e.target.value)}
            placeholder="summary contains…"
            aria-label="Search issue summaries"
          />
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
          <input
            type="checkbox"
            className="h-5 w-5 accent-lime sm:h-3.5 sm:w-3.5"
            checked={includeClosed}
            onChange={(e) => onFilterChange(setIncludeClosed)(e.target.checked)}
          />
          Include closed
        </label>
      </div>

      {isAdmin && health && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-dark-line bg-dark-card px-3.5 py-2.5 font-mono text-[11px] text-dark-soft">
          <span className="uppercase tracking-[0.06em] text-dark-dim">Queue health</span>
          <span>{health.open} open</span>
          {/* The endpoint counts NEW work nobody owns, not every unassigned
              case — the label says exactly that rather than implying a wider count. */}
          <span>{health.unassigned} new &amp; unassigned</span>
          {/* Named plainly: incomplete evidence is a fact about the case, not a
              failure to hide behind a green tick. */}
          <span className={health.partialContext > 0 ? "text-amber-400" : undefined}>
            {health.partialContext} with incomplete context
          </span>
        </div>
      )}


      <AdminTable
        caption="Agent-reported platform issues, blocked impact first"
        headers={["Issue", "Status", "Impact", "Severity", "Category", "Reporter", "Context", "Updated", ""]}
      >
        {loading && rows.length === 0 ? (
          <AdminTableSkeletonRows columns={9} />
        ) : rows.length === 0 ? (
          <tr>
            <td colSpan={9}>
              <AdminEmptyState
                message={
                  status || category || impact || severity || source || search
                    ? "No issues match these filters."
                    : "No open agent issues. Reports filed over MCP land here."
                }
              />
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr key={row.id} className="border-t border-dark-line-soft">
              <td className="px-3 py-2.5 align-top">
                <div className="text-[13px] text-dark-text">{row.summary}</div>
                <div className="mt-0.5 font-mono text-[10px] text-dark-dim">{row.id}</div>
              </td>
              <td className="px-3 py-2.5 align-top">
                <AdminPill tone={statusTone(row.status)}>{ISSUE_STATUS_LABELS[row.status]}</AdminPill>
              </td>
              <td className="px-3 py-2.5 align-top">
                <AdminPill tone={impactTone(row.impact)}>{ISSUE_IMPACT_LABELS[row.impact]}</AdminPill>
              </td>
              <td className="px-3 py-2.5 align-top">
                {row.severity ? (
                  <AdminPill tone={severityTone(row.severity)}>{row.severity}</AdminPill>
                ) : (
                  <span className="font-mono text-[10px] text-dark-dim">unset</span>
                )}
              </td>
              <td className="px-3 py-2.5 align-top font-mono text-[11px] text-dark-soft">
                {ISSUE_CATEGORY_LABELS[row.category]}
              </td>
              <td className="px-3 py-2.5 align-top font-mono text-[11px] text-dark-soft">
                {row.reporterLabel}
                <div className="text-[10px] text-dark-dim">{row.source}</div>
              </td>
              <td className="px-3 py-2.5 align-top">
                {/* Honest evidence state: "partial" never renders as a clean tick. */}
                {row.contextCollection === "complete" ? (
                  <AdminPill tone="neutral">complete</AdminPill>
                ) : row.contextCollection === "pending" ? (
                  // Not an error and not a pass: evidence collection simply
                  // has not run yet.
                  <AdminPill tone="info">pending</AdminPill>
                ) : (
                  <AdminPill tone="warning">{row.contextCollection}</AdminPill>
                )}
              </td>
              <td className="px-3 py-2.5 align-top font-mono text-[11px] text-dark-soft">
                <AdminDateTime iso={row.updatedAt} />
              </td>
              <td className="px-3 py-2.5 align-top">
                {/* A real link, not a row click: keyboard and middle-click work. */}
                <Link
                  href={`/issues/view?id=${encodeURIComponent(row.id)}`}
                  className="font-mono text-[11px] text-lime underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/60"
                >
                  Open issue
                </Link>
              </td>
            </tr>
          ))
        )}
      </AdminTable>

      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] text-dark-dim">
          {loading ? "Loading…" : `${rows.length} issue${rows.length === 1 ? "" : "s"} on this page`}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-[8px] border border-dark-line px-3 py-2.5 font-mono text-[11px] text-dark-soft disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/60 sm:py-1.5"
            onClick={() => setCursor(null)}
            disabled={!cursor || loading}
          >
            First page
          </button>
          <button
            type="button"
            className="rounded-[8px] border border-dark-line px-3 py-2.5 font-mono text-[11px] text-dark-soft disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/60 sm:py-1.5"
            onClick={() => setCursor(nextCursor)}
            disabled={!nextCursor || loading}
          >
            Next page
          </button>
        </div>
      </div>
    </div>
  );
}
