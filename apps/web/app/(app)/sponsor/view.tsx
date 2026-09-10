"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import Link from "next/link";
import { authedFetch, useDemo } from "@/lib/store";
import { API } from "@/lib/api-endpoints";
import { useDebouncedValue } from "@/lib/use-list-search";
import { PageHeader } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import {
  AsyncState,
  Button,
  ConfirmDialog,
  CursorPager,
  EmptyPitch,
  SearchField,
  Select,
  SkeletonCards,
} from "@/components/ui";
import { StatRail, type StatCell } from "@/components/workspace";
import { type DatasetRequestFull } from "@/components/dataset-request-detail";
import { CommunityRequestCard } from "@/components/community-request-card";
import { num } from "@/lib/format";

interface PlannerSessionDraft {
  id: string;
  answersJson?: {
    title?: string;
    datasetTypeId?: string;
  };
}

type StatusCounts = { total: number; inReview: number; approved: number; declined: number };

export function SponsorView() {
  const { pushToast } = useDemo();
  const [requests, setRequests] = useState<DatasetRequestFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  // The box updates on every keystroke; the request waits. Without this,
  // "regression" was eleven requests to /v1/me/community-requests, each one
  // re-running the same indexed GROUP BY for the stat strip.
  const debouncedSearch = useDebouncedValue(search);
  const [status, setStatus] = useState("");
  // Keyset pagination: a stack of cursors, one per page visited, so
  // "previous" doesn't need a second request — cursorStack[0] is always
  // null (page 1). Matches the sponsor funded-bounty list's pattern.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // Aggregate counts for the stat strip. Served by the API as `statusCounts`
  // (one indexed GROUP BY over the caller's whole request set) on the same
  // paginated response the list below already fetches — the server ignores
  // q/status when computing these, so filtering the list can never move them.
  const [counts, setCounts] = useState<StatusCounts>({ total: 0, inReview: 0, approved: 0, declined: 0 });
  // Bumped by the error state's Retry control.
  const [reload, setReload] = useState(0);
  const [activeSession, setActiveSession] = useState<PlannerSessionDraft | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  useEffect(() => {
    let alive = true;
    // Kicking off a fetch on filter/page change, not a React-state sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(false);
    const params = new URLSearchParams({ limit: "10" });
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (status) params.set("status", status);
    const cursor = cursorStack[pageIndex];
    if (cursor) params.set("cursor", cursor);
    authedFetch(`${API.me.communityRequestsMine}?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          if (alive) setError(true);
          return;
        }
        const data = (await r.json()) as {
          requests?: DatasetRequestFull[];
          nextCursor?: string | null;
          statusCounts?: StatusCounts;
        };
        if (alive) {
          setRequests(data.requests ?? []);
          setNextCursor(data.nextCursor ?? null);
          if (data.statusCounts) setCounts(data.statusCounts);
          setError(false);
        }
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [debouncedSearch, status, pageIndex, cursorStack, reload]);

  useEffect(() => {
    void authedFetch(API.planner.activeSession)
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as { session?: PlannerSessionDraft | null };
        return body.session ?? null;
      })
      .then(setActiveSession)
      .catch(() => {});
  }, []);

  const discardActiveDraft = async () => {
    if (!activeSession) return;
    try {
      await authedFetch(API.planner.session(activeSession.id), { method: "DELETE" });
      setActiveSession(null);
      setShowDiscardConfirm(false);
      pushToast({ variant: "success", title: "Draft discarded" });
    } catch {
      pushToast({ variant: "error", title: "Could not discard draft" });
    }
  };

  // Every cell here is a SERVER total over the caller's whole request set
  // (`statusCounts`, one indexed GROUP BY that ignores q/status/cursor), so
  // the strip never moves when the list is filtered or paged. Two extra cells
  // used to sit here — "items requested (this page)" and "karma released
  // (this page)" — summed only the ten rows the current page happened to hold
  // and were read as account totals; V1 (`sponsor/page.tsx:427-437`) has no
  // such cells, so they are gone rather than re-derived. Labels, icons, tones
  // and titles below match V1 exactly.
  const statCells: StatCell[] = [
    {
      label: "all requests",
      value: num(counts.total),
      icon: "database",
      title: "Every community dataset request on this account, across all statuses.",
    },
    {
      label: "in review",
      value: num(counts.inReview),
      tone: counts.inReview > 0 ? "review" : "neutral",
      icon: "eye",
      title:
        "Still in the review loop: submitted, under review, sent back for changes, or disputed. Every request counts in exactly one of these four cells.",
    },
    {
      label: "approved / live",
      value: num(counts.approved),
      tone: "accepted",
      icon: "check",
      title: "Approved requests, including those already minted into a live community dataset.",
    },
    {
      label: "declined",
      value: num(counts.declined),
      tone: "action",
      icon: "x",
      title: "Declined by review. The reviewer's reason is on each request.",
    },
  ];

  // Idempotent on purpose. `cursorStack` is a fetch dependency, so handing
  // back a NEW `[null]` array on every keystroke re-ran the request even
  // though the debounced query had not changed — ten characters produced ten
  // identical requests. Returning the previous array unchanged makes React
  // bail out of that state update entirely.
  const resetToFirstPage = () => {
    setCursorStack((prev) => (prev.length === 1 && prev[0] === null ? prev : [null]));
    setPageIndex(0);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Community Dataset Requests"
        // "Free for open-source AI researchers" was the last price claim on a
        // sponsor surface. D18 (AGENTS.md §1) allows no money surface and no
        // financial mention in marketing copy anywhere in this tree, and
        // "Free" only reads as a price because it implies a paid alternative
        // that does not exist. The audience clause is the real information in
        // the sentence, so it stays; only the price framing is dropped. No new
        // words were introduced (§3 forbids invented copy) — this needs to
        // join the same owner-approved decision-register row as today's other
        // sponsor copy removals, which is still unwritten (highest id D33).
        sub="Request and sponsor open, public dataset programs — for open-source AI researchers and community builders."
        action={
          <Link href="/sponsor/create">
            <Button size="md">
              <Icon name="plus" size={14} />
              Request a dataset
            </Button>
          </Link>
        }
      />

      {activeSession && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-200 bg-violet-50/80 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
              <Icon name="sparkles" size={18} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">
                You have an unfinished dataset request draft
              </p>
              <p className="break-words text-xs text-ink-soft">
                {activeSession.answersJson?.title || "Untitled community request"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowDiscardConfirm(true)}
              className="px-3 py-1.5 font-mono text-xs text-ink-soft hover:text-ink"
            >
              discard draft
            </button>
            <Link href="/sponsor/create">
              <Button size="sm">
                Resume draft
                <Icon name="chevron-right" size={12} />
              </Button>
            </Link>
          </div>
        </div>
      )}

      {/* `groups`, not `cells`: V1 renders this rail as a single fill-width
          row (`sponsor/page.tsx:427`, `groups={[...]}`), which shares the row
          between however many cells it holds. The flat `cells` grid packs
          fixed 180px columns instead, so at mid widths four cells wrapped
          3 + 1 with the last one stranded beside white space — invisible
          while a sixth page-scoped cell padded the grid to 3 + 3, and the
          reason to match V1's invocation rather than keep the count even.
          Sibling contributor/validator workspaces already pass `groups`. */}
      <StatRail groups={[statCells]} />

      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <SearchField
            value={search}
            onChange={(v) => {
              resetToFirstPage();
              setSearch(v);
            }}
            placeholder="Search requests…"
            className="w-full sm:w-64"
          />
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => {
              resetToFirstPage();
              setStatus(e.target.value);
            }}
            className="sm:w-52"
          >
            <option value="">All statuses</option>
            <option value="submitted">Submitted</option>
            <option value="under_review">In review</option>
            <option value="changes_requested">Changes requested</option>
            <option value="approved">Approved</option>
            <option value="implemented">Approved · minted</option>
            <option value="declined">Declined</option>
            <option value="disputed">Disputed</option>
          </Select>
        </div>

        {loading && requests.length === 0 ? (
          <SkeletonCards cards={3} />
        ) : error ? (
          <>
            <AsyncState
              status="error"
              errorTitle="Could not load your requests"
              errorDescription="There was an issue loading dataset requests. Please try again."
            />
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" onClick={() => setReload((n) => n + 1)}>
                Retry
              </Button>
            </div>
          </>
        ) : requests.length === 0 ? (
          <EmptyPitch
            icon="database"
            title={
              search || status
                ? "No matching dataset requests"
                : "No dataset requests filed yet"
            }
            description={
              search || status
                ? "No requests match your search or filter. Try clearing them."
                : "Plan and submit a specification for an open dataset. Our community contributors and validators will build and verify it."
            }
            action={
              !search && !status ? (
                <Link href="/sponsor/create">
                  <Button size="sm">Plan a dataset request</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          // No result count over this list: it is keyset-paginated, so the only
          // number available client-side is the length of the current page —
          // which rendered as "10 requests" for a sponsor who has more than
          // ten. The honest total is the "all requests" cell above, and V1
          // (`sponsor/page.tsx:613-618`) renders the cards with no count here
          // either.
          <div className="space-y-3">
            {requests.map((req) => (
              <CommunityRequestCard
                key={req.id}
                request={req}
                href={`/sponsor/requests/${req.id}`}
              />
            ))}
          </div>
        )}

        <CursorPager
          pageNumber={pageIndex + 1}
          hasPrev={pageIndex > 0}
          hasNext={Boolean(nextCursor)}
          disabled={loading}
          onPrev={() => setPageIndex((i) => Math.max(0, i - 1))}
          onNext={() => {
            if (!nextCursor) return;
            setCursorStack((stack) => {
              const next = stack.slice(0, pageIndex + 1);
              next.push(nextCursor);
              return next;
            });
            setPageIndex((i) => i + 1);
          }}
        />
      </div>

      <ConfirmDialog
        open={showDiscardConfirm}
        title="Discard dataset request draft?"
        description="Your in-progress community request planner answers will be cleared. This cannot be undone."
        confirmLabel="Discard draft"
        onConfirm={discardActiveDraft}
        onCancel={() => setShowDiscardConfirm(false)}
      />
    </div>
  );
}
