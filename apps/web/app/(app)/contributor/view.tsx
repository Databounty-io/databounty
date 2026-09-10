"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import {
  AsyncState,
  Button,
  EmptyPitch,
  Pill,
  PillTabs,
  Pagination,
  Progress,
  SearchField,
  SectionHeader,
  Select,
} from "@/components/ui";
import {
  FilterBar,
  StatRail,
  WorkspaceFirstRun,
  WorkspaceStatusBar,
  type FirstRunStep,
  type StatCell,
} from "@/components/workspace";
import {
  humanizeKey,
  karmaPerItemLabel,
  num,
  completionPct,
  CONTRIBUTOR_RANKS,
} from "@/lib/format";
import { useCommunityKarma } from "@/lib/use-community-karma";
import { useDebouncedValue, useLatestRequest } from "@/lib/use-list-search";
import { securedReleaseText } from "@/lib/karma-state";
import {
  getMyPoolSubmissions,
  getCommunityOpenPools,
  type CommunityOpenPool,
  type PoolSubmissionGroup,
  type PoolSubmissionGroupPage,
  type SubmissionListFilter,
} from "@/lib/api-work";
import { PublicationStatus } from "@/components/publication-status";
import { fetchProfileSources, DEFAULT_PROFILE_SUMMARY } from "@/lib/api-profile-sources";

/** The single difficulty an open pool is worked at (`Bounty.poolDifficulty`).
 * The pools endpoint filters on it server-side but does not return the list of
 * distinct values, so the select is the platform's fixed ladder. */
const POOL_DIFFICULTIES = ["beginner", "intermediate", "expert"];

function SubmissionOutcomeChips({
  summary,
  review,
  closed = false,
}: {
  summary: { accepted: number; actionNeeded: number; inReview: number; disputed: number };
  /** Per-stage breakdown of the in-review items. Each stage names what is
   * still outstanding — never that the stage passed. When the breakdown is
   * absent we say only that a final result is still pending. */
  review?: { automatedChecks: number; validatorAudit: number; poolCloseReview: number };
  closed?: boolean;
}) {
  const reviewStates = review
    ? [
        review.automatedChecks > 0
          ? { label: `${num(review.automatedChecks)} being checked`, title: "Automated checks are still running on these items. No check has passed yet." }
          : null,
        review.validatorAudit > 0
          ? { label: `${num(review.validatorAudit)} waiting for a validator`, title: "A human validator must make the final decision on these items — because a safety check was unavailable, skipped or inconclusive, or the item was sampled for audit." }
          : null,
        review.poolCloseReview > 0
          ? { label: `${num(review.poolCloseReview)} waiting for final review`, title: "Automated checks cleared, but these are not final accepts yet — pool-close sampling has still to run." }
          : null,
      ].filter((state): state is { label: string; title: string } => Boolean(state))
    : summary.inReview > 0
      ? [
          {
            label: `${num(summary.inReview)} waiting for a final result`,
            title: "A per-stage breakdown isn't available for these items — only that no final decision has been recorded yet.",
          },
        ]
      : [];

  return (
    <span className="font-mono text-[10px] text-ink-soft">
      <span className="font-medium text-ink">Validation:</span>
      <span aria-hidden> · </span>
      <span title="Final accepted items count toward the pool target and earn karma.">
        {num(summary.accepted)} accepted
      </span>
      {summary.actionNeeded > 0 && (
        <>
          <span aria-hidden> · </span>
          <span
            className={closed ? "text-ink-soft" : "font-medium text-[#a16207]"}
            title={
              closed
                ? "This pool has closed, so these items can no longer be revised."
                : "Rejected or flagged items you can still fix and resubmit."
            }
          >
            {num(summary.actionNeeded)} {closed ? "did not pass" : "need action"}
          </span>
        </>
      )}
      {reviewStates.map((state) => (
        <span key={state.label}>
          <span aria-hidden> · </span>
          <span className="text-ink-soft" title={state.title}>
            {state.label}
          </span>
        </span>
      ))}
      {summary.disputed > 0 && (
        <>
          <span aria-hidden> · </span>
          <span className="text-[#a16207]" title="Disputes awaiting admin resolution.">
            {num(summary.disputed)} disputed
          </span>
        </>
      )}
    </span>
  );
}

export function ContributorView() {
  const karmaData = useCommunityKarma(true);

  // Direct-submit community pools. An open pool has no contributor batch row
  // and nothing to claim — the row links straight to /contributor/pool/[id].
  const [openPools, setOpenPools] = useState<CommunityOpenPool[]>([]);
  const [openPoolsLoading, setOpenPoolsLoading] = useState(true);
  const [openPoolsError, setOpenPoolsError] = useState<string | null>(null);
  const [openPoolsCursor, setOpenPoolsCursor] = useState<string | null>(null);
  const [openPoolsLoadingMore, setOpenPoolsLoadingMore] = useState(false);
  const [openPoolsAttempt, setOpenPoolsAttempt] = useState(0);

  const [search, setSearch] = useState("");
  const [datasetType, setDatasetType] = useState("all");
  const [difficulty, setDifficulty] = useState("all");
  const [datasetTypeOptions, setDatasetTypeOptions] = useState<Array<{ id: string; name: string; domain: string }>>([]);

  const [historyFilter, setHistoryFilter] = useState<SubmissionListFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  const [poolGroups, setPoolGroups] = useState<PoolSubmissionGroup[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [historyData, setHistoryData] = useState<PoolSubmissionGroupPage>({
    pools: [], total: 0, page: 1, limit: 6, totalPages: 0,
    allSummary: { submitted: 0, accepted: 0, actionNeeded: 0, inReview: 0, disputed: 0 },
  });

  const [contributorRank, setContributorRank] = useState(DEFAULT_PROFILE_SUMMARY.ranks.contributor);

  useEffect(() => {
    let cancelled = false;
    fetchProfileSources()
      .then(({ summary }) => {
        if (!cancelled) setContributorRank(summary.ranks.contributor);
      })
      .catch(() => {
        /* status bar falls back to the default rank shape above */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Both boxes debounce through the one shared hook (lib/use-list-search) —
  // this page used to carry its own copy of the timer, as four others did.
  const debouncedSearch = useDebouncedValue(search);
  const debouncedHistorySearch = useDebouncedValue(historySearch);
  // Each list guards its own assignment: the debounce makes an out-of-order
  // response unlikely, not impossible (a slow first request still overlaps a
  // fast second), and a list showing results for a superseded query
  // contradicts the filter row above it.
  const beginPoolsRequest = useLatestRequest();
  const beginMorePoolsRequest = useLatestRequest();
  const beginHistoryRequest = useLatestRequest();

  /**
   * The work filters (search, dataset type, difficulty) are sent to the
   * server. Filtering in the browser over whatever single page came back is
   * not a slower version of the same answer — it is a wrong one: a pool
   * matching the search past that page would be invisible and the section
   * would render a confident "no matching work".
   */
  const loadOpenPools = useCallback(async () => {
    const isStale = beginPoolsRequest();
    setOpenPoolsLoading(true);
    try {
      const body = await getCommunityOpenPools({
        limit: 12,
        search: debouncedSearch,
        datasetTypeId: datasetType,
        difficulty,
      });
      if (isStale()) return;
      setOpenPools(body.pools ?? []);
      setOpenPoolsCursor(body.nextCursor ?? null);
      setDatasetTypeOptions(body.filterOptions.datasetTypes);
      setOpenPoolsError(null);
    } catch (error) {
      if (isStale()) return;
      setOpenPools([]);
      setOpenPoolsCursor(null);
      setOpenPoolsError(error instanceof Error ? error.message : "Could not load open community pools.");
    } finally {
      if (!isStale()) setOpenPoolsLoading(false);
    }
    // `openPoolsAttempt` is the Retry trigger; it has no other reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, datasetType, difficulty, openPoolsAttempt, beginPoolsRequest]);

  /** Appends the next keyset page rather than replacing the list, so the queue
   * is not capped at whatever fitted in the first response. Dedupes by id
   * because a pool can shift page as rows are accepted underneath us. */
  const loadMoreOpenPools = useCallback(async () => {
    if (openPoolsLoadingMore || !openPoolsCursor) return;
    const isStale = beginMorePoolsRequest();
    setOpenPoolsLoadingMore(true);
    try {
      const body = await getCommunityOpenPools({
        limit: 12,
        cursor: openPoolsCursor,
        search: debouncedSearch,
        datasetTypeId: datasetType,
        difficulty,
      });
      // Appending a superseded page would MIX two result sets in one list, so
      // this guard matters more here than on a plain replace.
      if (isStale()) return;
      setOpenPools((prev) => {
        const known = new Set(prev.map((pool) => pool.id));
        return [...prev, ...(body.pools ?? []).filter((pool) => !known.has(pool.id))];
      });
      setOpenPoolsCursor(body.nextCursor ?? null);
      setOpenPoolsError(null);
    } catch (error) {
      if (isStale()) return;
      setOpenPoolsError(error instanceof Error ? error.message : "Could not load more pools.");
    } finally {
      if (!isStale()) setOpenPoolsLoadingMore(false);
    }
  }, [openPoolsCursor, openPoolsLoadingMore, debouncedSearch, datasetType, difficulty, beginMorePoolsRequest]);

  const loadHistory = useCallback(async () => {
    const isStale = beginHistoryRequest();
    setHistoryLoading(true);
    try {
      const groups = await getMyPoolSubmissions({
        filter: historyFilter,
        search: debouncedHistorySearch || undefined,
        page: historyPage,
        limit: 6,
      });
      if (isStale()) return;
      setHistoryData(groups);
      setPoolGroups(groups.pools);
      setHistoryError(null);
    } catch (error) {
      if (isStale()) return;
      setPoolGroups([]);
      setHistoryError(error instanceof Error ? error.message : "Could not load your submissions.");
    } finally {
      if (!isStale()) setHistoryLoading(false);
    }
    // `historyAttempt` is the Retry trigger; it has no other reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyFilter, debouncedHistorySearch, historyPage, historyAttempt, beginHistoryRequest]);

  useEffect(() => {
    // One-shot data load on mount/filter change, not a React-state sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadOpenPools();
  }, [loadOpenPools]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadHistory();
  }, [loadHistory]);

  /** The reader's own standing in each listed pool, keyed by bounty id, so an
   * open-pool row can say "You submitted N items" without a second request.
   * Private to the reader; never part of the public pool total. */
  const personalPoolProgressByBounty = useMemo(
    () => new Map(poolGroups.map((group) => [group.bountyId, group])),
    [poolGroups]
  );

  const submissionCount = historyData.allSummary.submitted;
  const acceptedCount = historyData.allSummary.accepted;
  const needsActionCount = historyData.allSummary.actionNeeded;
  const inReviewCount = historyData.allSummary.inReview;

  const hasActiveFilters = Boolean(search) || datasetType !== "all" || difficulty !== "all";
  const historyHasActiveFilters = historyFilter !== "all" || Boolean(historySearch);
  const noWorkAnywhere = !openPoolsLoading && !openPoolsError && openPools.length === 0 && !hasActiveFilters;
  const historyIsEmptyFirstRun =
    !historyLoading && !historyError && poolGroups.length === 0 && !historyHasActiveFilters && historyData.total === 0;
  const isFirstRun = submissionCount === 0 && !historyLoading && !historyError;

  const submissionCells: StatCell[] = [
    {
      label: "submitted",
      value: num(submissionCount),
      icon: "upload",
      title: "Total items you've submitted across open community pools.",
    },
    {
      label: "accepted",
      value: num(acceptedCount),
      tone: "accepted",
      icon: "check",
      title: "Final accepted items that count toward dataset targets and earn karma.",
    },
    {
      label: "needs your fix",
      value: num(needsActionCount),
      tone: needsActionCount > 0 ? "action" : "neutral",
      icon: "refresh",
      title: "Flagged or rejected items waiting for your revision.",
      href: needsActionCount > 0 ? "#submission-history" : undefined,
    },
    {
      label: "in validation",
      value: num(inReviewCount),
      tone: "review",
      icon: "clock",
      title: "Items currently undergoing automated checks or validator review.",
    },
  ];

  const karmaCells: StatCell[] = [
    {
      label: "secured karma",
      value: num(karmaData.securedTotal),
      unit: "karma",
      icon: "shield",
      tone: karmaData.securedTotal > 0 ? "accepted" : "neutral",
      sub:
        karmaData.securedTotal > 0
          ? "Waiting on dispute window"
          : "Released upon window close",
      title: securedReleaseText(karmaData.releaseRule),
    },
    {
      label: "in-review items",
      value: num(karmaData.inReviewItems),
      icon: "clock",
      sub:
        karmaData.inReviewProjected > 0
          ? `+${num(karmaData.inReviewProjected)} karma projected`
          : "No items in review",
      title: "Items submitted but not yet decided.",
    },
  ];

  const firstRunSteps: FirstRunStep[] = [
    {
      icon: "search",
      title: "Explore open pools",
      body: "Find community datasets that match your expertise and contribute sample data.",
    },
    {
      icon: "upload",
      title: "Submit single or bulk items",
      body: "Submit items following the dataset contract and open license terms.",
    },
    {
      icon: "sparkles",
      title: "Earn community karma",
      body: "Karma is awarded when items pass automated verification and validator review.",
    },
  ];

  const clearFilters = () => {
    setSearch("");
    setDatasetType("all");
    setDifficulty("all");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contributor workspace"
        sub="Open community pools, validation pipeline signals, and verified karma progress."
      />

      <WorkspaceStatusBar
        icon="sparkles"
        rank={contributorRank.rank}
        rankIndex={Math.max(0, CONTRIBUTOR_RANKS.indexOf(contributorRank.rank))}
        ranks={CONTRIBUTOR_RANKS}
        nextRank={contributorRank.nextRank}
        progressLabel="karma progress"
        progressValue={karmaData.total ?? 0}
        progressMax={karmaData.nextTier?.minKarma ?? (karmaData.total || 100)}
        metrics={[]}
        karma={{
          total: karmaData.total ?? 0,
          tier: karmaData.tier,
          nextTier: karmaData.nextTier,
          secured:
            karmaData.securedTotal > 0
              ? {
                  amount: karmaData.securedTotal,
                  label: "secured",
                  title: securedReleaseText(karmaData.releaseRule),
                }
              : undefined,
        }}
      />

      <StatRail
        groups={[karmaCells, submissionCells]}
      />

      {isFirstRun && openPools.length > 0 && (
        <WorkspaceFirstRun
          sub="Welcome to the contributor workspace. Here is how to get started:"
          steps={firstRunSteps}
          ctaHref="#open-pools"
          ctaLabel="Browse open pools"
        />
      )}

      {/* Available work — direct-submit community pools on one filtered
          browse surface. */}
      <div className="mt-7" id="open-pools">
        <SectionHeader
          title="Available work"
          /* Don't describe filters that aren't on screen. The filter row is
             suppressed when there's nothing to filter, so the sentence about
             them goes with it. */
          sub={
            openPools.length > 0 || hasActiveFilters
              ? "Direct-submit community pools. Filters apply to every open pool."
              : "Community pools you can submit straight into — nothing to claim."
          }
        />

        {/* One filter row: search grows, selects hold a fixed width, count and
            reset anchor right. No filter row when there is nothing to filter —
            it still renders whenever a filter IS active, because that's exactly
            when the reader needs the way back out. */}
        {(openPools.length > 0 || hasActiveFilters) && (
        <FilterBar
          onClear={hasActiveFilters ? clearFilters : undefined}
          meta={`${openPools.length} shown${openPoolsCursor ? " · more available" : ""}`}
        >
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Search bounty or dataset type…"
            className="min-w-[190px] flex-1 sm:w-auto sm:max-w-xs"
          />
          <Select
            aria-label="Filter by dataset type"
            className="sm:w-48"
            value={datasetType}
            onChange={(e) => setDatasetType(e.target.value)}
          >
            <option value="all">All dataset types</option>
            {datasetTypeOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </Select>
          <Select
            aria-label="Filter by difficulty"
            className="sm:w-52"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
          >
            <option value="all">All difficulty levels</option>
            {POOL_DIFFICULTIES.map((level) => (
              <option key={level} value={level}>{humanizeKey(level)}</option>
            ))}
          </Select>
        </FilterBar>
        )}

        {openPoolsLoading ? (
          <AsyncState status="loading" loadingText="Loading available work…" />
        ) : openPoolsError ? (
          /* A failed request is not an empty queue. Say it failed, and offer
             the one action that can change it. */
          <>
            <AsyncState
              status="error"
              errorTitle="Could not load available work"
              errorDescription={openPoolsError}
            />
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" onClick={() => setOpenPoolsAttempt((attempt) => attempt + 1)}>Retry</Button>
            </div>
          </>
        ) : noWorkAnywhere ? (
          /* First-run / genuinely-empty queue gets the pitch, not a flat
             "nothing here" line. A *filtered* empty set still uses the plain
             `AsyncState` below; the reader already knows what the list is
             there. */
          <EmptyPitch
            icon="code"
            eyebrow="contributor queue"
            title="No work available right now"
            description="No community pool is open yet. Community pools appear here as sponsors publish them."
            points={[
              {
                icon: "database",
                title: "nothing to claim",
                body: "Open a community pool and submit straight into it — nothing to claim, nothing to reserve, and you can stop any time.",
              },
              {
                icon: "code",
                title: "build to the contract",
                body: "Each dataset type publishes the exact fields and checks your items must satisfy, shown right on the submit page as you work.",
              },
              {
                icon: "check",
                title: "get validated, then rewarded",
                body: "Items run the automated pipeline and may go to a human validator. Karma lands when an item is accepted, not when it's submitted.",
              },
            ]}
            action={
              <>
                <Button href="/community" variant="secondary" size="sm">
                  browse the open program
                  <Icon name="arrow-right" size={13} />
                </Button>
                {!isFirstRun && (
                  <Button href="/karma" variant="secondary" size="sm">
                    how karma works
                    <Icon name="arrow-right" size={13} />
                  </Button>
                )}
              </>
            }
          />
        ) : openPools.length === 0 ? (
          <AsyncState
            status="empty"
            emptyChildren="No work matches these filters."
            emptyAction={
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                <Icon name="x" size={13} />
                clear filters
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {openPools.map((pool) => {
              const target = Number(pool.targetItems) || 0;
              const accepted = Number(pool.acceptedItems) || 0;
              // How FULL the pool is is the cleared/intake count, not the
              // finally-accepted count: items that passed automation already
              // hold capacity and are what close the pool. Driving the bar off
              // `acceptedItems` would show an empty 0% pool that the server is
              // simultaneously rejecting submissions for. Falls back to
              // `accepted` only for an API old enough not to send the field.
              const cleared = pool.poolSummary?.capacityReserved ?? (pool.clearedItems == null ? accepted : Number(pool.clearedItems) || 0);
              const pct = completionPct(cleared, target);
              const perItem = pool.karmaPricing?.contributorPerItem ?? pool.karmaPerAcceptedItem;
              const upToTotal = pool.karmaPricing?.contributorTotal ?? pool.karmaPerAcceptedItem * target;
              const personalProgress = personalPoolProgressByBounty.get(pool.id);
              const personalStatus = personalProgress
                ? [
                    `${num(personalProgress.submissionTotal)} submitted`,
                    personalProgress.review?.automatedChecks
                      ? `${num(personalProgress.review.automatedChecks)} in automated checks`
                      : null,
                    personalProgress.review?.validatorAudit
                      ? `${num(personalProgress.review.validatorAudit)} awaiting validator`
                      : null,
                    personalProgress.review?.poolCloseReview
                      ? `${num(personalProgress.review.poolCloseReview)} in final review`
                      : null,
                  ].filter((part): part is string => Boolean(part))
                : [];
              return (
                <Link key={pool.id} href={`/contributor/pool/${pool.id}`} className="card group block p-4 transition-colors hover:border-ink sm:p-5">
                  {/* Identity row: title + tone pill on the left, the arrow on
                      the right. Direct-submit pools have no expand step, so the
                      row must read clearly at a glance. */}
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-[14px] font-bold text-ink">{pool.title}</span>
                      <Pill tone="karma">direct submit</Pill>
                    </div>
                    <Icon name="arrow-right" size={15} className="shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden="true" />
                  </div>

                  {/* Progress inline, one row. */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 font-mono text-[10px] text-ink-soft">
                    {personalStatus.length > 0 && personalProgress && (
                      <span
                        className="shrink-0 font-medium text-ink"
                        title="Your private contribution status in this pool. It is not part of the public pool total."
                      >
                        You submitted {num(personalProgress.submissionTotal)} item{personalProgress.submissionTotal === 1 ? "" : "s"}
                        {personalStatus.length > 1 ? ` — ${personalStatus.slice(1).join(" · ")}` : ""}
                      </span>
                    )}
                    {personalStatus.length > 0 && <span aria-hidden>·</span>}
                    <span className="shrink-0" title="Items in processing, human review, or finally accepted reserve capacity. Failed or rejected items release it.">{num(cleared)} / {num(target)} capacity reserved</span>
                    <Progress value={cleared} max={target} tone="ink" track="line" className="h-1 min-w-[80px] flex-1 rounded-full" />
                    <span className="shrink-0 font-bold text-ink">{pct}%</span>
                  </div>

                  {/* Meta line: rate, then what the data is. */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-ink-soft">
                    <span className="font-medium text-karma">+{num(perItem)} karma / item · up to +{num(upToTotal)} total</span>
                    {pool.datasetType && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{pool.datasetType.name}</span>
                      </>
                    )}
                    {pool.poolSummary && (
                      <><span aria-hidden>·</span><span title="Only validator-approved items count toward dataset completion and karma.">{num(pool.poolSummary.finalAccepted ?? accepted)} final accepted</span></>
                    )}
                  </div>
                </Link>
              );
            })}

            {/* Keyset-paginated, so the queue is not capped at whatever fitted
                in the first response. */}
            {openPoolsCursor && (
              <div className="flex justify-center pt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={openPoolsLoadingMore}
                  onClick={() => void loadMoreOpenPools()}
                >
                  {openPoolsLoadingMore ? "Loading…" : "Load more community work"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pool-first submission history. Individual evidence lives inside the
          pool detail page instead of flooding this dashboard. `id` is the
          drill-down target for the "needs your fix" stat cell. */}
      <div className="mt-7" id="submission-history">
        <SectionHeader
          title="My submissions"
          sub={
            historyIsEmptyFirstRun
              ? "Your pool contributions land here once you submit."
              : "Community-pool contributions. Open any row to review its items, validation evidence, issues, and available resubmissions."
          }
        />
        {/* Status tabs, a search box and a result count are hidden while
            there is nothing to filter — but reappear the moment a filter is
            active, so a zero-result filter is always escapable. */}
        {!historyIsEmptyFirstRun && (
        <FilterBar
          onClear={
            historyHasActiveFilters
              ? () => {
                  setHistoryFilter("all");
                  setHistorySearch("");
                  setHistoryPage(1);
                }
              : undefined
          }
          meta={
            historyLoading
              ? "loading…"
              : `${historyData.total} ${historyData.total === 1 ? "submission" : "submissions"}`
          }
        >
          <PillTabs
            value={historyFilter}
            onChange={(next) => {
              setHistoryFilter(next as SubmissionListFilter);
              setHistoryPage(1);
            }}
            items={[
              { key: "all", label: "all" },
              { key: "action_needed", label: "needs action" },
              { key: "in_review", label: "needs final outcome" },
              { key: "accepted", label: "final accepted" },
            ]}
          />
          <SearchField
            value={historySearch}
            onChange={(next) => {
              setHistorySearch(next);
              setHistoryPage(1);
            }}
            placeholder="Search your submissions…"
            className="min-w-[190px] flex-1 sm:w-auto sm:max-w-xs"
          />
        </FilterBar>
        )}
        {historyLoading ? (
          <AsyncState status="loading" loadingText="Loading your submissions…" />
        ) : historyError ? (
          <>
            <AsyncState
              status="error"
              errorTitle="Could not load your submissions"
              errorDescription={historyError}
            />
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" onClick={() => setHistoryAttempt((attempt) => attempt + 1)}>Retry</Button>
            </div>
          </>
        ) : poolGroups.length === 0 ? (
          <AsyncState
            status="empty"
            emptyChildren={
              <span className="text-center">
                {historyHasActiveFilters
                  ? "No submissions match these filters."
                  : noWorkAnywhere
                    ? "Nothing submitted yet. There's no open work right now, so check the open program for pools as they publish."
                    : "Nothing submitted yet. Pick up an open pool above to get started."}
              </span>
            }
          />
        ) : (
          <>
            <div className="grid gap-3">
              {poolGroups.map((pool) => (
                <Link
                  key={`pool-${pool.bountyId}`}
                  href={`/contributor/pool/${pool.bountyId}`}
                  className="card group block px-4 py-3 transition-colors hover:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 sm:px-5"
                  aria-label={`Open your submissions to community pool ${pool.bountyTitle || "Untitled dataset"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-[14px] font-bold text-ink group-hover:underline">
                        {/* Community track calls it a dataset, not a bounty. */}
                        {pool.bountyTitle || "Untitled dataset"}
                      </span>
                      <span className="font-mono text-[10px] text-ink-soft">
                        community pool{pool.language ? ` · ${pool.language}` : ""}
                      </span>
                      {pool.summary.disputed > 0 && <Pill tone="warning">{pool.summary.disputed} disputed</Pill>}
                      <Pill tone="karma">{karmaPerItemLabel(pool.karmaPerAcceptedItem)} / item</Pill>
                      {/* The pool's ONE publication event, server-owned. A pool
                          publishes as a whole dataset once it is complete and
                          cleared — never per item — so this belongs on the pool
                          row, not on any submission inside it. */}
                      <PublicationStatus publication={pool.publication} compact />
                    </div>
                    <Icon name="arrow-right" size={15} className="shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-[10px]">
                    <SubmissionOutcomeChips summary={pool.summary} review={pool.review} closed={pool.poolClosed} />
                    <span className="text-ink-soft">{pool.submissionTotal} submitted</span>
                    {pool.poolClosed && <Pill tone="neutral">pool closed</Pill>}
                    <span className="ml-auto text-ink-faint">
                      {pool.poolClosed && pool.summary.actionNeeded > 0
                        ? "read failed-item evidence"
                        : "pool submissions"}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
            {historyData.totalPages > 1 && (
              <Pagination
                page={historyData.page}
                totalPages={historyData.totalPages}
                disabled={historyLoading}
                onPrev={() => setHistoryPage((page) => Math.max(1, page - 1))}
                onNext={() => setHistoryPage((page) => Math.min(historyData.totalPages, page + 1))}
                className="mt-4"
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
