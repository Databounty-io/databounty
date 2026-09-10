"use client";

// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { AdminErrorBanner, AdminPageHeader } from "@/components/admin-shell";
import { AdminDateRangePicker, resolveDateRange, type DateRangeValue } from "@/components/admin-filter-bar";
import { useAdminResource } from "@/lib/use-admin-resource";

type Activity = { day: string; karma: number; events: number; contributors: number };
/** Echoed by the server, not derived from the picker: the caption must describe
 *  the window actually queried, including the default when no range is set. */
type Window = { from: string; to: string; defaulted: boolean };

function windowCaption(window: Window | undefined): string {
  if (!window) return "Rollup derived from immutable karma events; not client-generated heatmap data.";
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (window.defaulted) {
    return "Ninety-day rollup derived from immutable karma events; not client-generated heatmap data.";
  }
  return `${fmt(window.from)} – ${fmt(window.to)}, derived from immutable karma events; not client-generated heatmap data.`;
}

export default function ActivityPage() {
  const [dateRange, setDateRange] = useState<DateRangeValue>({ preset: "all" });
  const path = useMemo(() => {
    const { from, to } = resolveDateRange(dateRange);
    if (!from && !to) return "/v1/admin/community/activity";
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return `/v1/admin/community/activity?${params.toString()}`;
  }, [dateRange]);

  const { data, loading, error, refresh } = useAdminResource<{ window: Window; activity: Activity[] }>(path, {
    errorMessage: "Community activity is unavailable.",
  });
  const max = Math.max(...(data?.activity.map((row) => Math.abs(row.karma)) ?? [1]), 1);

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Community activity"
        sub={windowCaption(data?.window)}
        actions={
          <div className="flex flex-col gap-1">
            <AdminDateRangePicker value={dateRange} onChange={setDateRange} />
            <span className="font-mono text-[9px] text-dark-dim">local calendar days · UTC query</span>
          </div>
        }
      />

      {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}

      {loading ? (
        <p className="text-sm text-dark-dim">Loading activity…</p>
      ) : (
        <div className="rounded-xl border border-dark-line bg-dark-card p-5">
          <div className="space-y-2">
            {data?.activity.length ? (
              data.activity.map((row) => (
                <div key={row.day} className="grid grid-cols-[90px_1fr_120px] items-center gap-3 text-xs">
                  <span className="font-mono text-dark-dim">{new Date(row.day).toLocaleDateString()}</span>
                  <div className="h-3 overflow-hidden rounded bg-dark-deep">
                    <div className="h-full bg-lime" style={{ width: `${Math.max(2, Math.round((Math.abs(row.karma) / max) * 100))}%` }} />
                  </div>
                  <span className="text-right font-mono text-dark-text">
                    {row.karma} karma · {row.contributors} users
                  </span>
                </div>
              ))
            ) : (
              // Names the window that was actually empty rather than a fixed
              // "last 90 days", which stops being true the moment one is set.
              <p className="text-sm text-dark-dim">
                {data?.window && !data.window.defaulted
                  ? "No karma activity in the selected range."
                  : "No karma activity in the last 90 days."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
