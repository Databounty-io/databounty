"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  AdminEmptyState,
  AdminErrorBanner,
  AdminLoadingState,
  AdminPageHeader,
  AdminSectionHeading,
  AdminStat,
} from "@/components/admin-shell";
import { Icon, type IconName } from "@/components/icons";
import { AutoRefreshControl } from "@/components/auto-refresh";
import { AdminDateRangePicker, resolveDateRange, type DateRangeValue } from "@/components/admin-filter-bar";
import { useAdminResource } from "@/lib/use-admin-resource";
import { num, pct, pctFromScore100 } from "@/lib/format";
import { qualitySub, qualityValue, type QualityMetric } from "@/lib/quality-metrics";

interface CommunityMetrics {
  activePrograms: number;
  requestCounts: Record<string, number>;
}

/** Only the metrics that are genuinely "things that happened between two
 *  dates". Null unless a range is set. Everything else on Overview is an
 *  all-time total or a point-in-time snapshot and is not range-filterable. */
interface OverviewRange {
  from: string | null;
  to: string | null;
  newUsers: number;
  newDatasets: number;
  newKarma: number;
  submissions: number;
  /** Submitted in range and accepted as of now — NOT "accepted in range".
   *  Submission has no accepted-at column, so that stricter reading is not
   *  available and must not be captioned as if it were. */
  acceptedOfSubmittedInRange: number;
  publishedDatasets: number;
}

interface Overview {
  range: OverviewRange | null;
  typesInReview: number;
  tasksClaimed: number;
  submissionsPendingValidation: number;
  auditBatchesPending: number;
  overdueContributorBatches: number;
  overdueAuditBatches: number;
  // Rolling-7-day quality rates. `null` means the metric has no denominator —
  // it is NOT a measured zero and must never be rendered as "0%". The
  // authoritative signal is `qualityMetrics.<metric>.state`; these three
  // top-level fields are kept for V1 response-shape parity.
  duplicateRate: number | null;
  llmPassRate: number | null;
  executionPassRate: number | null;
  // When the API computed the rates. Always present now (they are computed
  // live per request, not read from a worker snapshot), so this is a
  // freshness caption only — never the measured/unmeasured test.
  qualityMetricsComputedAt: string | null;
  qualityMetrics: {
    windowDays: number;
    duplicate: QualityMetric;
    llm: QualityMetric;
    execution: QualityMetric;
  };
  pipeline: { stage: string; count: number }[];
  aiAttributionHolds: number;
  // Signup + dataset growth.
  totalUsers: number;
  newUsers7d: number;
  newUsers30d: number;
  totalDatasets: number;
  newDatasets7d: number;
  newDatasets30d: number;
  // Community platform metrics:
  // Platform totals. Karma is net (awards minus reversals).
  totalKarma: number;
  newKarma7d: number;
  newKarma30d: number;
  totalSubmissions: number;
  acceptedSubmissions: number;
  publishedDatasets: number;
}

interface NotificationHealth {
  byChannel: Record<string, { sent: number; failed: number; dead: number; total: number }>;
  deadLetterCount: number;
}

interface ApiKeySummary {
  activeCount: number;
}

interface AttentionItem {
  icon: IconName;
  text: string;
  href: string;
  tone: "amber" | "rose";
}

const PIPELINE_STYLE: Record<string, { label: string; color: string }> = {
  submitted: { label: "queued for validation", color: "#94a3b8" },
  duplicate_check: { label: "duplicate", color: "#60a5fa" },
  running_tests: { label: "running tests", color: "#a78bfa" },
  llm_validation: { label: "llm validation", color: "#c6ff3d" },
  needs_fixes: { label: "needs fixes", color: "#fbbf24" },
  provisionally_accepted: { label: "provisionally accepted", color: "#22c55e" },
  in_audit: { label: "awaiting validator audit", color: "#34d399" },
};

/** Human caption for the active range. An open end is stated as such rather
 *  than silently substituting today, so an open-ended range never reads as a
 *  closed one. */
function rangeCaption(range: OverviewRange): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (range.from && range.to) return `${fmt(range.from)} and ${fmt(range.to)}`;
  if (range.from) return `${fmt(range.from)} and now`;
  if (range.to) return `the beginning and ${fmt(range.to)}`;
  return "all time";
}

export default function AdminOverviewPage() {
  const [dateRange, setDateRange] = useState<DateRangeValue>({ preset: "all" });
  const overviewPath = useMemo(() => {
    const { from, to } = resolveDateRange(dateRange);
    if (!from && !to) return "/v1/admin/overview";
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return `/v1/admin/overview?${params.toString()}`;
  }, [dateRange]);
  const overview = useAdminResource<Overview>(overviewPath, { pollMs: 0, errorMessage: "Overview is unavailable." });
  const health = useAdminResource<NotificationHealth>("/v1/admin/notifications/health?hours=168", { pollMs: 0, errorMessage: "Notification health is unavailable." });
  const apiKeys = useAdminResource<ApiKeySummary>("/v1/admin/api-keys/summary", { pollMs: 0, errorMessage: "API key summary is unavailable." });
  const community = useAdminResource<CommunityMetrics>("/v1/admin/community/open", { pollMs: 0, errorMessage: "Community metrics are unavailable." });
  const [refreshing, setRefreshing] = useState(false);

  const refreshAll = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        overview.refresh(),
        health.refresh(),
        apiKeys.refresh(),
        community.refresh(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [apiKeys, community, health, overview, refreshing]);

  // The overview is the only required first-paint resource. Notification
  // health and API-key counts enhance individual widgets and should not hold
  // the entire dashboard behind the slowest request.
  if (overview.loading) {
    return <AdminLoadingState label="Loading live platform operations…" />;
  }
  if (overview.error || !overview.data) {
    return <AdminErrorBanner message={overview.error || "Overview is unavailable."} onRetry={() => void overview.refresh()} />;
  }

  const s = overview.data;
  const communityRequestsAwaitingReview = community.data?.requestCounts.submitted ?? 0;
  const pipelineTotal = s.pipeline.reduce((sum, row) => sum + row.count, 0);
  const channels = health.data ? Object.values(health.data.byChannel) : [];
  const sent7d = channels.reduce((sum, channel) => sum + channel.sent, 0);
  const attention: AttentionItem[] = [
    ...(s.typesInReview ? [{ icon: "file" as IconName, text: `${s.typesInReview} dataset type${s.typesInReview === 1 ? "" : "s"} awaiting review`, href: "/datasets", tone: "amber" as const }] : []),
    ...(communityRequestsAwaitingReview ? [{ icon: "award" as IconName, text: `${communityRequestsAwaitingReview} community request${communityRequestsAwaitingReview === 1 ? "" : "s"} awaiting review`, href: "/open-program", tone: "amber" as const }] : []),
    ...(s.overdueContributorBatches ? [{ icon: "layers" as IconName, text: `${s.overdueContributorBatches} stalled pool${s.overdueContributorBatches === 1 ? "" : "s"}`, href: "/contributors", tone: "amber" as const }] : []),
    ...(s.overdueAuditBatches ? [{ icon: "shield" as IconName, text: `${s.overdueAuditBatches} overdue audit batch${s.overdueAuditBatches === 1 ? "" : "es"}`, href: "/validators", tone: "amber" as const }] : []),
    ...(health.data?.deadLetterCount ? [{ icon: "bell" as IconName, text: `${health.data.deadLetterCount} notification dead letter${health.data.deadLetterCount === 1 ? "" : "s"} need requeue or investigation`, href: "/notifications", tone: "rose" as const }] : []),
  ];
  const attentionIncomplete = Boolean(community.error || health.error);
  const activeApiKeys = apiKeys.data?.activeCount;
  const healthPending = health.loading ? "Loading…" : "Unavailable";
  const apiKeysPending = apiKeys.loading ? "Loading…" : "Unavailable";

  // One derived note, appended to every section that is NOT the range block.
  // Deliberately not a hardcoded list of "the all-time cards": such a list goes
  // silently wrong the first time a card is added and nothing fails. Defaulting
  // every section to "unfiltered" means a future rangeable section has to opt
  // in — under-claiming rather than over-claiming, which is the safe direction.
  // The quality rates below are the sharpest case: they are computed over a
  // rolling `qualityMetrics.windowDays` window that is independent of from/to,
  // so without this they would read as filtered while ignoring the filter.
  const unfilteredNote = s.range ? " Not affected by the date filter." : "";

  return (
    <div className="space-y-9">
      <AdminPageHeader
        title="Platform overview"
        sub="Live operational state from the platform database."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Same picker + caption pairing the list pages use via
              *  AdminFilterBar, so the timezone contract reads identically
              *  wherever the picker appears. */}
            <div className="flex flex-col gap-1">
              <AdminDateRangePicker value={dateRange} onChange={setDateRange} />
              <span className="font-mono text-[9px] text-dark-dim">local calendar days · UTC query</span>
            </div>
            <AutoRefreshControl refreshing={refreshing} onRefresh={refreshAll} />
          </div>
        }
      />

      {/* Shown only when a range is set. Kept as its own section rather than
        *  rewriting the cards below, because everything below is either an
        *  all-time total or a live state snapshot — a filter that changed some
        *  of those numbers and silently left others would make the two
        *  indistinguishable. */}
      {s.range && (
        <section className="space-y-3">
          <AdminSectionHeading
            title="Activity in selected range"
            sub={`Counted between ${rangeCaption(s.range)}. Only these six numbers respond to the date filter.`}
          />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <AdminStat label="new accounts" value={num(s.range.newUsers)} tone="lime" sub="signed up in range" />
            <AdminStat label="new datasets" value={num(s.range.newDatasets)} tone="lime" sub="programs minted in range" />
            <AdminStat label="karma awarded" value={num(s.range.newKarma)} tone="lime" sub="net of reversals, in range" />
            <AdminStat label="submissions" value={num(s.range.submissions)} sub="submitted in range" />
            <AdminStat
              label="accepted"
              value={num(s.range.acceptedOfSubmittedInRange)}
              sub="submitted in range, accepted as of now"
            />
            <AdminStat
              label="datasets published"
              value={num(s.range.publishedDatasets)}
              sub="pushed to Hugging Face in range"
            />
          </div>
        </section>
      )}

      <AdminSectionHeading
        title="Growth"
        sub={`Signups and datasets — all-time totals with rolling 7-day and 30-day gains.${unfilteredNote}`}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminStat label="total accounts" value={num(s.totalUsers)} sub="every signup, all time" />
        <AdminStat
          label="new signups"
          value={num(s.newUsers30d)}
          tone="lime"
          sub={`last 30d · ${num(s.newUsers7d)} in last 7d`}
        />
        <AdminStat
          label="total datasets"
          value={num(s.totalDatasets)}
          sub="programs minted, all time"
        />
        <AdminStat
          label="new datasets"
          value={num(s.newDatasets30d)}
          tone="lime"
          sub={`last 30d · ${num(s.newDatasets7d)} in last 7d`}
        />
      </div>

      <AdminSectionHeading title="Platform totals" sub={`All-time cumulative activity across the platform.${unfilteredNote}`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminStat
          label="total karma awarded"
          value={num(s.totalKarma)}
          tone="lime"
          sub={`net · +${num(s.newKarma30d)} last 30d · +${num(s.newKarma7d)} last 7d`}
        />
        <AdminStat
          label="submissions"
          value={num(s.totalSubmissions)}
          sub={`${num(s.acceptedSubmissions)} accepted, all time`}
        />
        <AdminStat
          label="accepted submissions"
          value={num(s.acceptedSubmissions)}
          sub="items that cleared the pipeline"
        />
        <AdminStat
          label="datasets published"
          value={num(s.publishedDatasets)}
          sub="live on Hugging Face"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <AdminStat
          label="active pools"
          value={community.data ? num(community.data.activePrograms) : community.loading ? "Loading…" : "Unavailable"}
          sub="community pools still running — includes pools full and in validation, not just open to new items"
        />
        <AdminStat
          label="contributors active"
          value={num(s.tasksClaimed)}
          sub="submission still in-flight, no claim step in the open-pool model"
        />
        <AdminStat label="submissions pending" value={num(s.submissionsPendingValidation)} />
        <AdminStat label="audit batches pending" value={num(s.auditBatchesPending)} />
        <AdminStat
          label="stalled pools"
          value={num(s.overdueContributorBatches)}
          tone="amber"
          sub="past deadline, not yet reached its item target — closes on the next sweep"
        />
        <AdminStat label="overdue audit batches" value={num(s.overdueAuditBatches)} tone="amber" />
        {/* Trust invariant: a rate with no denominator — nothing submitted
            yet, or no provider configured to run the check — is reported as
            such, never as a measured 0%. */}
        <AdminStat
          label="duplicate rate"
          value={qualityValue(s.qualityMetrics.duplicate, pct)}
          sub={qualitySub(s.qualityMetrics.duplicate, s.qualityMetrics.windowDays, s.qualityMetricsComputedAt, "scored submissions")}
          tone={s.qualityMetrics.duplicate.state === "measured" ? "default" : "amber"}
        />
        <AdminStat
          label="llm pass rate"
          value={qualityValue(s.qualityMetrics.llm, pctFromScore100)}
          sub={qualitySub(s.qualityMetrics.llm, s.qualityMetrics.windowDays, s.qualityMetricsComputedAt, "reviewed submissions")}
          tone={s.qualityMetrics.llm.state === "measured" ? "default" : "amber"}
        />
        <AdminStat
          label="execution pass rate"
          value={qualityValue(s.qualityMetrics.execution, pct)}
          sub={qualitySub(s.qualityMetrics.execution, s.qualityMetrics.windowDays, s.qualityMetricsComputedAt, "sandbox verdicts")}
          tone={s.qualityMetrics.execution.state === "measured" ? "default" : "amber"}
        />
      </div>

      <section>
        <AdminSectionHeading title="// needs_attention" sub={`Live items that require platform intervention.${unfilteredNote}`} />
        <div className="overflow-hidden rounded-xl border border-dark-line bg-dark-card">
          {attention.length === 0 ? (
            // Two of the five attention sources come from `community` and
            // `health`. If either failed, "nothing needs attention" would be
            // asserting something this page cannot actually determine.
            attentionIncomplete ? (
              <AdminEmptyState message="This list is incomplete — community and/or notification-health metrics could not be loaded, so items from those sources are not counted here." />
            ) : (
              <AdminEmptyState message="No platform interventions are currently reported." />
            )
          ) : attention.map((item) => (
            <Link key={`${item.href}-${item.text}`} href={item.href} className="flex items-center gap-3.5 border-b border-dark-nav-hover px-5 py-4 last:border-b-0 hover:bg-dark-row-hover">
              <Icon name={item.icon} size={15} className={item.tone === "rose" ? "text-rose-400" : "text-amber-400"} />
              <span className="flex-1 text-sm text-dark-text">{item.text}</span>
              <Icon name="arrow-right" size={15} className="text-dark-soft" />
            </Link>
          ))}
        </div>
      </section>

      <section>
        <AdminSectionHeading title="// notifications & api" sub={`Live platform-wide delivery and access-key state.${unfilteredNote}`} />
        {(health.error || apiKeys.error) && <div className="mb-3"><AdminErrorBanner message={health.error || apiKeys.error} onRetry={() => { void health.refresh(); void apiKeys.refresh(); }} /></div>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          <AdminStat label="delivery channels active (7d)" value={health.data ? num(channels.filter((channel) => channel.total > 0).length) : healthPending} />
          <AdminStat label="deliveries sent (7d)" value={health.data ? num(sent7d) : healthPending} />
          <AdminStat label="dead letters (7d)" value={health.data ? num(health.data.deadLetterCount) : healthPending} tone="rose" alert={Boolean(health.data?.deadLetterCount)} />
          <AdminStat label="active api keys" value={activeApiKeys === undefined ? apiKeysPending : num(activeApiKeys)} />
        </div>
      </section>

      <section>
        <AdminSectionHeading
          title="// pipeline_snapshot"
          sub={`${num(pipelineTotal)} submissions currently in flight.${s.aiAttributionHolds > 0 ? ` ${num(s.aiAttributionHolds)} held for AI-attribution review.` : ""}${unfilteredNote}`}
        />
        <div className="rounded-xl border border-dark-line bg-dark-card p-[22px]">
          {pipelineTotal === 0 ? <AdminEmptyState message="No submissions are currently in the validation pipeline." /> : <>
            <div className="mb-4 flex h-2.5 overflow-hidden rounded-full">
              {s.pipeline.map((row) => <div key={row.stage} style={{ width: `${(row.count / pipelineTotal) * 100}%`, background: PIPELINE_STYLE[row.stage]?.color ?? "#94a3b8" }} title={`${PIPELINE_STYLE[row.stage]?.label ?? row.stage}: ${row.count}`} />)}
            </div>
            <div className="grid grid-cols-3 gap-3 font-mono sm:grid-cols-6">
              {s.pipeline.map((row) => <div key={row.stage}><div className="text-sm font-bold text-dark-text">{num(row.count)}</div><div className="text-[11px] text-dark-dim">{PIPELINE_STYLE[row.stage]?.label ?? row.stage.replaceAll("_", " ")}</div></div>)}
            </div>
            {s.aiAttributionHolds > 0 && (
              <div className="mt-4 border-t border-dark-line pt-3 font-mono text-xs text-rose-400">
                {num(s.aiAttributionHolds)} AI attribution hold{s.aiAttributionHolds === 1 ? "" : "s"} routed to validator audit
              </div>
            )}
          </>}
        </div>
      </section>
    </div>
  );
}
