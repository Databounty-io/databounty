"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import { AsyncState, Button, CursorPager, Modal, Pill, SearchField, Select, Table, Td } from "@/components/ui";
import { DateRangePicker, type DateRangeSelection } from "@/components/date-range-picker";
import { useDebouncedValue } from "@/lib/use-list-search";
import IssueDetailView from "./[id]/view";
import {
  ISSUE_CATEGORY_LABELS,
  ISSUE_IMPACT_LABELS,
  ISSUE_STATUS_LABELS,
  contextCollectionLabel,
  fetchMyIssues,
  issueImpactTone,
  issueStatusTone,
  needsReporterAnswer,
  type IssueListRow,
  type IssueStatus,
} from "@/lib/agent-issues";

const STATUS_OPTIONS: (IssueStatus | "")[] = [
  "",
  "needs_info",
  "received",
  "triaged",
  "investigating",
  "resolved",
  "duplicate",
  "not_reproducible",
  "rejected",
];

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 7 ? `${days}d ago` : `${Math.floor(days / 7)}w ago`;
}


/** Local calendar day as yyyy-mm-dd — the format fetchMyIssues expects,
 *  matching what the previous native date inputs produced. */
function toYmd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function IssuesView() {
  const [status, setStatus] = useState<IssueStatus | "">("");
  const [search, setSearch] = useState("");
  // Shared debounce (lib/use-list-search) — this page had the only *named*
  // copy of the 300ms constant; it now lives with the hook so there is one
  // number for every search box in the app.
  const q = useDebouncedValue(search);
  // null = all time. The shared range picker can't produce a backwards range
  // (react-day-picker normalizes from/to), so the old inverted-range warning
  // state is unreachable and gone.
  const [dateRange, setDateRange] = useState<DateRangeSelection | null>(null);
  const since = dateRange ? toYmd(dateRange.from) : "";
  const until = dateRange ? toYmd(dateRange.to) : "";
  const [rows, setRows] = useState<IssueListRow[]>([]);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [issueCount, setIssueCount] = useState(0);

  function resetPaging() {
    setCursors([null]);
    setPage(0);
  }


  const cursor = cursors[page] ?? null;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setState("loading");
    }, 0);

    void fetchMyIssues({ cursor, status, q, since, until })
      .then((data) => {
        if (cancelled) return;
        setRows(data.items);
        setNextCursor(data.nextCursor);
        setHasMore(data.hasMore);
        setIssueCount(data.issueCount);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cursor, status, q, since, until]);

  const filtered = Boolean(status || q || since || until);
  const waitingOnYou = rows.filter((row) => needsReporterAnswer(row.status)).length;

  return (
    <>
      <PageHeader
        title="Support cases"
        sub="Platform problems you or your agent reported. A case is a support channel — it never changes a submission, audit, or karma on its own."
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <SearchField
          value={search}
          onChange={(next) => {
            setSearch(next);
            resetPaging();
          }}
          placeholder="Search case summaries…"
          className="sm:w-80"
        />
        <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
          Status
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as IssueStatus | "");
              resetPaging();
            }}
            aria-label="Filter cases by status"
            className="w-[190px]"
          >
            {STATUS_OPTIONS.map((value) => (
              <option key={value || "all"} value={value}>
                {value ? ISSUE_STATUS_LABELS[value] : "All cases"}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
          Reported
          <DateRangePicker
            value={dateRange}
            onChange={(selection) => {
              setDateRange(selection);
              resetPaging();
            }}
          />
        </div>
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setStatus("");
              // `q` is derived from `search` (useDebouncedValue) and settles
              // an empty value on the next tick — nothing else to reset.
              setSearch("");
              setDateRange(null);
              resetPaging();
            }}
            className="h-9 rounded-lg border border-line px-3 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-soft transition-colors hover:border-ink hover:text-ink"
          >
            Clear filters
          </button>
        )}
      </div>

      {state === "ready" && (
        <p className="mb-3 font-mono text-[11.5px] text-ink-faint">
          {issueCount === 0
            ? filtered
              ? "No cases match these filters."
              : "You have filed no support cases."
            : `${filtered ? "Matching" : "Filed"}: ${issueCount} ${issueCount === 1 ? "case" : "cases"}${
                issueCount > rows.length ? ` · showing ${rows.length} on this page` : ""
              }`}
        </p>
      )}

      {waitingOnYou > 0 && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[13px] text-amber-800">
          <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
          <p>
            <span className="font-semibold">
              {waitingOnYou} {waitingOnYou === 1 ? "case is" : "cases are"} waiting on your answer.
            </span>{" "}
            An unanswered question is the most common reason a real defect stalls.
          </p>
        </div>
      )}

      <AsyncState
        status={state === "ready" && rows.length === 0 ? "empty" : state}
        icon="alert"
        loadingText="Loading your support cases…"
        errorTitle="Could not load your support cases"
        errorDescription="The support service did not respond. Refresh to try again."
        emptyTitle={filtered ? "No cases match these filters" : "No support cases filed"}
        emptyDescription={
          filtered
            ? "Clear the filters to see every case you have filed."
            : "When you or your agent hits a platform problem — a contract that will not accept valid work, a stage that never finishes — report it with the report_issue tool over MCP and it appears here with its status."
        }
      >
        <Table headers={["Status", "Case", "Kind", "Impact", "Context", "Updated"]}>
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-panel">
              <Td>
                <Pill tone={issueStatusTone(row.status)}>{ISSUE_STATUS_LABELS[row.status]}</Pill>
              </Td>
              <Td className="max-w-[380px]">
                <button
                  type="button"
                  onClick={() => setOpenCaseId(row.id)}
                  className="text-left font-medium text-ink hover:underline"
                >
                  {row.summary}
                </button>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-ink-faint">
                  <span>{row.id}</span>
                  <Link href={`/issues/${row.id}`} className="text-ink-soft hover:text-ink hover:underline">
                    · open full page
                  </Link>
                  {row.alsoReportedBy > 0 && (
                    <span className="text-ink-soft">
                      · {row.alsoReportedBy} other{row.alsoReportedBy === 1 ? "" : "s"} hit this too
                    </span>
                  )}
                  {row.resources.length > 0 && (
                    <span className="text-ink-soft">
                      · about {row.resources.map((r) => r.kind).join(", ")}
                    </span>
                  )}
                </div>
              </Td>
              <Td className="whitespace-nowrap text-[12.5px] text-ink-soft">
                {ISSUE_CATEGORY_LABELS[row.category]}
              </Td>
              <Td>
                <Pill tone={issueImpactTone(row.impact)}>{ISSUE_IMPACT_LABELS[row.impact]}</Pill>
              </Td>
              <Td>
                <Pill tone={contextCollectionLabel(row.contextCollection).tone}>
                  {contextCollectionLabel(row.contextCollection).label}
                </Pill>
              </Td>
              <Td className="whitespace-nowrap font-mono text-[11.5px] text-ink-soft">
                {relTime(row.updatedAt)}
              </Td>
            </tr>
          ))}
        </Table>
      </AsyncState>

      <CursorPager
        className="mt-4"
        pageNumber={page + 1}
        hasPrev={page > 0}
        hasNext={hasMore}
        disabled={state === "loading"}
        onPrev={() => setPage((p) => Math.max(0, p - 1))}
        onNext={() => {
          if (!nextCursor) return;
          setCursors((prev) => {
            const next = prev.slice(0, page + 1);
            next.push(nextCursor);
            return next;
          });
          setPage((p) => p + 1);
        }}
      />
      <Modal
        open={Boolean(openCaseId)}
        onClose={() => setOpenCaseId(null)}
        align="right"
        panelClassName="relative h-full w-full max-w-2xl overflow-y-auto border-l border-line bg-paper p-5 shadow-2xl sm:p-6"
      >
        {openCaseId && (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-4 border-b border-line-soft pb-3 pr-14">
              <div className="micro-label text-ink-faint">support case</div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/issues/${openCaseId}`}
                  className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-soft hover:text-ink hover:underline"
                >
                  open full page
                </Link>
                <Button variant="secondary" size="sm" onClick={() => setOpenCaseId(null)}>
                  close
                </Button>
              </div>
            </div>
            <IssueDetailView issueId={openCaseId} />
          </>
        )}
      </Modal>
    </>
  );
}

export default function IssuesPage() {
  return <IssuesView />;
}
