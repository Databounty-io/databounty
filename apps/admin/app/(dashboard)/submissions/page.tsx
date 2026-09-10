"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  AdminPageHeader,
  AdminDateTime,
  AdminErrorBanner,
  AdminPill,
  AdminStat,
  AdminTable,
  AdminTableSkeletonRows,
  ATd,
  type AdminPillTone,
} from "@/components/admin-shell";
import { useAdminResource } from "@/lib/use-admin-resource";
import { FLAG_REASON_LABELS, GENERATION_LABELS, SUBMISSION_STATUS_LABELS, num, pct, pctFromScore100 } from "@/lib/format";
import type { GenerationMethod, SubmissionStatus } from "@/lib/types";
import { qualitySub, qualityValue, type QualityMetric } from "@/lib/quality-metrics";
import { AdminFilterBar, AdminPagination, resolveDateRange, type DateRangeValue } from "@/components/admin-filter-bar";

const PAGE_SIZE = 25;

const STAGE_TONE: Partial<Record<SubmissionStatus, AdminPillTone>> = {
  duplicate_check: "info",
  running_tests: "info",
  llm_validation: "lime",
  needs_fixes: "warning",
  in_audit: "success",
  in_sponsor_review: "violet",
  provisionally_accepted: "success",
  accepted: "success",
  disputed: "danger",
  flagged: "danger",
  rejected: "danger",
};

const GENERATION_TONE: Record<GenerationMethod, AdminPillTone> = {
  human: "success",
  ai_assisted: "info",
  ai_generated: "warning",
};

/** Server-derived answer to "who turned this down and why", present only on
 *  rows that were not accepted. `unrecorded` means the record genuinely holds
 *  no reason and is shown as exactly that. */
interface RejectionSummary {
  decidedBy: "validator" | "automated_check" | "unrecorded";
  decidedByLabel: string | null;
  reasonCode: string | null;
  reasonText: string | null;
  decidedAt: string | null;
}

interface AdminSubmissionRow {
  id: string;
  title: string;
  bountyTitle: string;
  contributor: string;
  stage: SubmissionStatus;
  generationMethod: GenerationMethod;
  createdAt: string;
  unconfiguredStages: string[];
  validationStages: { stage: string; passed: boolean; score: number | null; status: string | null; reason: string | null }[];
  rejection: RejectionSummary | null;
}

/** One line of "why", for the list. The full note, validator, and stage
 *  evidence live on the record's own page. */
function RejectionCell({ rejection }: { rejection: RejectionSummary | null }) {
  if (!rejection) return <span className="text-dark-dim">—</span>;
  if (rejection.decidedBy === "unrecorded") {
    return <span className="text-[11px] text-amber-400">no reason recorded</span>;
  }
  const reason = rejection.reasonCode
    ? FLAG_REASON_LABELS[rejection.reasonCode] ?? rejection.reasonCode.replaceAll("_", " ")
    : rejection.reasonText;
  return (
    <div className="max-w-56 space-y-0.5">
      {/* With no recorded reason, lead with the check that failed — that is the
          real information — and say plainly that no reason text exists. */}
      <div className="text-[11px] leading-snug text-dark-text">{reason ?? rejection.decidedByLabel ?? "not stated"}</div>
      <div className="text-[10px] text-dark-dim">
        {reason
          ? `${rejection.decidedBy === "validator" ? "validator" : "automated"}${rejection.decidedByLabel ? ` · ${rejection.decidedByLabel}` : ""}`
          : "no reason recorded"}
      </div>
    </div>
  );
}

interface SubmissionsData {
  total: number;
  stats: {
    // `null` means the metric had no denominator — NOT a measured zero. The
    // authoritative signal is `qualityMetrics.<metric>.state`; these three
    // stay for response-shape parity with V1.
    duplicateRate: number | null;
    llmPassRate: number | null;
    executionPassRate: number | null;
    // When the API computed the rates. Always present (they are computed live
    // per request, not read from a worker snapshot), so this is a freshness
    // caption only — never the measured-vs-unmeasured test.
    computedAt: string | null;
    qualityMetrics: {
      windowDays: number;
      duplicate: QualityMetric;
      llm: QualityMetric;
      execution: QualityMetric;
    };
  };
  submissions: AdminSubmissionRow[];
}

// Pre-fetch placeholder only. Every rate is `null`/not-measured so that a page
// rendered before the first response can never show a fabricated "0%".
const UNMEASURED: QualityMetric = { rate: null, sampleSize: 0, excluded: 0, excludedByOutcome: {}, state: "not_measured" };
const empty: SubmissionsData = {
  total: 0,
  stats: {
    duplicateRate: null,
    llmPassRate: null,
    executionPassRate: null,
    computedAt: null,
    qualityMetrics: {
      windowDays: 7,
      duplicate: UNMEASURED,
      llm: UNMEASURED,
      execution: UNMEASURED,
    },
  },
  submissions: [],
};
const STAGE_FILTERS: { key: "pipeline" | "all" | SubmissionStatus; label: string }[] = [
  { key: "pipeline", label: "in pipeline" },
  { key: "all", label: "all" },
  { key: "needs_fixes", label: "needs fixes" },
  { key: "in_audit", label: "in audit" },
  { key: "accepted", label: "accepted" },
  { key: "rejected", label: "rejected" },
];

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default function AdminSubmissionsPage() {
  const router = useRouter();
  const [now, setNow] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRangeValue>({ preset: "30d" });
  const [page, setPage] = useState(0);
  const [stageFilter, setStageFilter] = useState<"pipeline" | "all" | SubmissionStatus>("pipeline");

  useEffect(() => {
    // Client-only clock reference for relative "age" formatting — deferred to
    // an effect since Date.now() during prerender would mismatch the
    // server-rendered HTML.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = new URLSearchParams({ limit: String(PAGE_SIZE), skip: String(page * PAGE_SIZE) });
  query.set("stage", stageFilter);
  if (debouncedSearch) query.set("search", debouncedSearch);
  const { from, to } = useMemo(() => resolveDateRange(dateRange), [dateRange]);
  if (from) query.set("from", from);
  if (to) query.set("to", to);

  const { data: fetched, loading, error, refresh } = useAdminResource<SubmissionsData>(
    `/v1/admin/submissions?${query}`,
    { errorMessage: "Submission data is unavailable." }
  );
  const data = fetched ?? empty;

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Validation pipeline"
        sub={`Live view of submissions moving through automated checks and audit — ${num(data.total)} in pipeline now.`}
      />

      {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}

      {/* Trust invariant, rendered by the SAME shared helpers the admin
          overview cards use so the two surfaces cannot disagree: a rate with
          no denominator — nothing submitted yet, or no provider configured to
          run the check — is reported as such, never as a measured "0%". */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminStat
          label="duplicate rate"
          value={qualityValue(data.stats.qualityMetrics.duplicate, pct)}
          sub={qualitySub(data.stats.qualityMetrics.duplicate, data.stats.qualityMetrics.windowDays, data.stats.computedAt, "scored submissions", "avg score across submissions")}
          tone={data.stats.qualityMetrics.duplicate.state === "measured" ? "default" : "amber"}
        />
        <AdminStat
          label="llm pass"
          value={qualityValue(data.stats.qualityMetrics.llm, pctFromScore100)}
          sub={qualitySub(data.stats.qualityMetrics.llm, data.stats.qualityMetrics.windowDays, data.stats.computedAt, "reviewed submissions", "avg rubric score")}
          tone={data.stats.qualityMetrics.llm.state === "measured" ? "default" : "amber"}
        />
        <AdminStat
          label="execution pass"
          value={qualityValue(data.stats.qualityMetrics.execution, pct)}
          sub={qualitySub(data.stats.qualityMetrics.execution, data.stats.qualityMetrics.windowDays, data.stats.computedAt, "sandbox verdicts", "broken fails, fixed passes")}
          tone={data.stats.qualityMetrics.execution.state === "measured" ? "default" : "amber"}
        />
      </div>

      <div className="flex flex-wrap gap-2 font-mono text-xs">
        <span className="self-center text-dark-dim">show:</span>
        {STAGE_FILTERS.map((filter) => (
          <button
            key={filter.key}
            type="button"
            onClick={() => { setStageFilter(filter.key); setPage(0); }}
            className={`cursor-pointer rounded-full border px-3.5 py-2.5 transition-colors sm:py-1.5 ${
              stageFilter === filter.key ? "border-lime bg-lime text-dark" : "border-dark-line text-dark-soft hover:border-dark-hover hover:text-dark-text"
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <AdminFilterBar
        search={search}
        onSearchChange={(v) => {
          setSearch(v);
          setPage(0);
        }}
        searchPlaceholder="search by submission title…"
        dateRange={dateRange}
        onDateRangeChange={(v) => {
          setDateRange(v);
          setPage(0);
        }}
      />

      <AdminTable
        headers={["submission", "pool", "contributor ID", "stage", "why", "generation", "created", "age", "detail"]}
      >
        {data.submissions.map((s) => (
          <tr
            key={s.id}
            role="link"
            tabIndex={0}
            onClick={() => router.push(`/details?kind=submission&id=${encodeURIComponent(s.id)}`)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                router.push(`/details?kind=submission&id=${encodeURIComponent(s.id)}`);
              }
            }}
            className="cursor-pointer transition-colors hover:bg-white/[0.025] focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime"
          >
            <ATd>
              <div className="max-w-64 font-semibold leading-snug text-dark-text">
                {s.title}
              </div>
            </ATd>
            <ATd className="max-w-56 text-dark-soft">{s.bountyTitle}</ATd>
            <ATd>{s.contributor}</ATd>
            <ATd>
              <div className="flex flex-wrap items-center gap-1">
                <AdminPill tone={STAGE_TONE[s.stage] ?? "neutral"}>
                  {SUBMISSION_STATUS_LABELS[s.stage]}
                </AdminPill>
                {s.unconfiguredStages.length > 0 && (
                  <span title={`Skipped/unconfigured: ${s.unconfiguredStages.join(", ")}`}>
                    <AdminPill tone="warning">
                      {s.unconfiguredStages.length} stage{s.unconfiguredStages.length > 1 ? "s" : ""} unconfigured
                    </AdminPill>
                  </span>
                )}
              </div>
            </ATd>
            <ATd>
              <RejectionCell rejection={s.rejection} />
            </ATd>
            <ATd>
              <AdminPill tone={GENERATION_TONE[s.generationMethod] ?? "neutral"}>
                {GENERATION_LABELS[s.generationMethod]}
              </AdminPill>
            </ATd>
            <ATd className="whitespace-nowrap text-dark-soft"><AdminDateTime iso={s.createdAt} /></ATd>
            <ATd className="text-dark-soft">{now ? timeAgo(s.createdAt) : "—"}</ATd>
            <ATd>
              <Link
                href={`/details?kind=submission&id=${encodeURIComponent(s.id)}`}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => event.stopPropagation()}
                className="font-mono text-xs text-lime underline"
              >
                view detail →
              </Link>
            </ATd>
          </tr>
        ))}
        {loading && data.submissions.length === 0 && <AdminTableSkeletonRows columns={9} />}
        {!loading && data.submissions.length === 0 && (
          <tr>
            <ATd colSpan={9} className="text-dark-soft">No submissions match this view.</ATd>
          </tr>
        )}
      </AdminTable>

      <AdminPagination page={page} pageSize={PAGE_SIZE} total={data.total} onPageChange={setPage} />
    </div>
  );
}
