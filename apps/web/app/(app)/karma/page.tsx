"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import type { KarmaHold, KarmaHoldsByRole, KarmaReleaseRule } from "@/lib/karma-state";
import { useDebouncedValue } from "@/lib/use-list-search";
import { KarmaStateCard } from "@/components/karma-state";
import { AsyncState, Button, Empty, Pill, SearchField, Select, Table, Td, type PillTone } from "@/components/ui";
import { DateRangePicker, resolveApiRange, type DateRangeSelection } from "@/components/date-range-picker";
import { humanizeKey, shadeHex } from "@/lib/format";
import { API } from "@/lib/api-endpoints";
import { authedFetch, useDemo } from "@/lib/store";
import { LANDING_URL } from "@/lib/urls";
import { AutoRefreshControl } from "@/components/auto-refresh";

type Tier = {
  name: string;
  label: string;
  minKarma: number;
  color: string;
  blurb: string;
  perks: string[];
  earlyAccessHours: number;
  concurrencyBonus: number;
  state: "current" | "unlocked" | "locked";
};
type CurrentTier = Omit<Tier, "minKarma" | "state">;
type NextTier = { name: string; label: string; minKarma: number; karmaToGo: number; perks: string[] };
type KarmaRules = {
  auditItem: number;
  confirmedFlag: number;
  requestApproved: number;
  publishBonus: number;
};
type KarmaEarnRule = {
  key: string;
  label: string;
  description: string;
  amount: number | null;
  perProgram: boolean;
};
type KarmaEvent = {
  id: string;
  eventType: string;
  label: string;
  amount: number;
  sourceType: string;
  sourceId: string;
  sourceLabel: string | null;
  createdAt: string;
};
type KarmaHistoryBody = {
  events: KarmaEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  eventCount: number;
};
type Difficulty = "beginner" | "intermediate" | "advanced";
type Band = "standard" | "elevated" | "heavy";
type ReviewLoad = "light" | "standard" | "heavy";
type KarmaMatrix = {
  version: number;
  pricingActive: boolean;
  activeScale: "difficulty_scale" | "matrix";
  bands: { band: Band; label: string; rule: string }[];
  example: {
    datasetTypeId: string;
    datasetTypeName: string;
    complexity: number;
    verificationUnits: number;
    band: Band;
    bandLabel: string;
    bandRule: string;
    difficulties: { level: Difficulty; label: string; publishedLabel: string; karma: number }[];
    validator: { reviewLoad: ReviewLoad; reviewLoadLabel: string; fields: number; karma: number };
  } | null;
  lowestKarma: number;
  highestKarma: number;
  catalogMaxKarma: number | null;
};
type TierItemRow = { tier: string; label: string; minKarma: number; items: number | null };
type TierItemEstimates = {
  lowest: { karmaPerItem: number; tiers: TierItemRow[] };
  catalogHighest: { karmaPerItem: number; tiers: TierItemRow[] } | null;
};
type BadgeFamily = "build" | "audit" | "platform";
type BadgeCatalogEntry = {
  key: string;
  family: BadgeFamily;
  icon: string;
  label: string;
  criteria: string;
  earned: boolean;
};
type KarmaBody = {
  total: number;
  pendingTotal?: number;
  holds?: KarmaHold[];
  holdsByRole?: KarmaHoldsByRole;
  releaseRule?: KarmaReleaseRule;
  inReview?: { items: number; projectedKarma: number };
  inReviewValidator?: { openAudits: number; openItems: number; projectedKarma: number };
  reversedTotal?: number;
  openLeaderboardRank?: number | null;
  handle?: string | null;
  events: KarmaEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  eventCount: number;
  tier: CurrentTier;
  nextTier: NextTier | null;
  tiers: Tier[];
  rules?: KarmaRules;
  earnRules?: KarmaEarnRule[];
  matrix?: KarmaMatrix;
  tierItemEstimates?: TierItemEstimates;
  badgeCatalog?: BadgeCatalogEntry[];
  eventTypeFilters: { value: string; label: string }[];
};
type LeaderRow = { rank: number; handle: string; displayName: string | null; karma: number; acceptedItems: number };
type LeaderboardBody = { leaderboard: LeaderRow[]; nextCursor: string | null };

/** Rows per history page. Also sent as ?limit= so the server's hasMore /
 * nextCursor line up with what "Load more" shows.
 *
 * 100 on owner instruction (2026-09-07), where V1's karma page fetches 25.
 * 100 is also the server's hard ceiling — `GET /v1/community/karma` clamps
 * `limit` to `Math.min(..., 100)` — so this is the largest page the endpoint
 * will serve; asking for more would be silently reduced and would then
 * disagree with what the button appears to promise. */
const HISTORY_PAGE_SIZE = 100;

const EVENT_META: Record<string, { label: string; tone: PillTone }> = {
  community_item_accepted: { label: "accepted item", tone: "success" },
  community_item_reversed: { label: "reversed item", tone: "danger" },
  community_audit_completed: { label: "audit", tone: "info" },
  community_request_approved: { label: "approved request", tone: "info" },
  community_bounty_published: { label: "published", tone: "violet" },
  community_flag_confirmed: { label: "confirmed flag", tone: "warning" },
  community_publish_bonus: { label: "publish bonus", tone: "violet" },
  admin_adjustment: { label: "adjustment", tone: "neutral" },
};

function SectionTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-3.5">
      <h2 className="font-mono text-base font-bold tracking-tight">{title}</h2>
      <p className="mt-1 text-[13px] text-ink-soft">{sub}</p>
    </div>
  );
}

function TierChip({ tier }: { tier: Pick<Tier, "label" | "color"> }) {
  return (
    <span
      className="rounded-full px-2.5 py-[3px] font-mono text-[11px] font-medium"
      style={{ backgroundColor: `${tier.color}26`, color: shadeHex(tier.color, 0.55) }}
    >
      {tier.label}
    </span>
  );
}

function eventMeta(event: Pick<KarmaEvent, "eventType" | "label">) {
  const curated = EVENT_META[event.eventType];
  if (curated) return curated;
  return { label: event.label || humanizeKey(event.eventType), tone: "neutral" as PillTone };
}

/** Detail page for the resource a karma event points at, or null when that
 * kind has no member-facing detail page (link nothing rather than dumping the
 * user on a generic list they'd have to search themselves). */
function eventHref(event: Pick<KarmaEvent, "sourceType" | "sourceId">): string | null {
  switch (event.sourceType) {
    case "Submission":
      return `/contributor/submissions/${event.sourceId}`;
    case "DatasetRequest":
      return `/sponsor/requests/${event.sourceId}`;
    default:
      return null;
  }
}

/** Groups newest-first events into contiguous per-day buckets, preserving
 * order. Keyed on the LOCAL calendar day so the header matches the date the
 * member actually saw the event happen. */
function groupEventsByDay(events: KarmaEvent[]): { day: string; label: string; events: KarmaEvent[] }[] {
  const groups: { day: string; label: string; events: KarmaEvent[] }[] = [];
  for (const event of events) {
    const date = new Date(event.createdAt);
    const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.events.push(event);
    } else {
      groups.push({
        day,
        label: date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
        events: [event],
      });
    }
  }
  return groups;
}

function PricingSection({ matrix }: { matrix: KarmaMatrix }) {
  const live = matrix.activeScale === "matrix";
  const example = matrix.example;
  return (
    <section className="mt-8">
      <SectionTitle
        title="How an accepted item is priced"
        sub="Three things set the rate: how hard the dataset category is to verify, the difficulty the sponsor chose, and how much of each item the platform machine-checks. Rates are set by an administrator."
      />

      <div
        className={`mb-3.5 flex items-start gap-2.5 rounded-[10px] border px-5 py-3.5 text-[13px] ${
          live ? "border-[#d7e8c4] bg-[#f4faee] text-[#4a6b32]" : "border-amber-200 bg-amber-50 text-amber-800"
        }`}
      >
        <Icon name={live ? "check" : "info"} size={15} className="mt-0.5 shrink-0" />
        <p className="leading-relaxed">
          {live ? (
            <>
              <span className="font-semibold">Live.</span> Your karma is added to your balance as soon as your work is finally accepted. Publishing the completed dataset is what makes your contribution public and creditable — it does not gate your karma.
            </>
          ) : (
            <>
              <span className="font-semibold">Coming, not yet paying.</span> Accepted items are currently priced on the
              flat difficulty scale under <span className="font-semibold">How karma works</span> below. The example here
              is how pricing will work; no karma has been awarded from it yet.
            </>
          )}
        </p>
      </div>

      {example ? (
        <div className="card px-5 py-4">
          <div className="font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">example</div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
            <span className="font-semibold text-ink">{example.datasetTypeName}</span> is a complexity-{example.complexity}{" "}
            category and {example.verificationUnits === 0 ? "has no machine-verified fields" : `has ${example.verificationUnits} machine-verified field${example.verificationUnits === 1 ? "" : "s"}`}
            {" "}({example.bandLabel} band — {example.bandRule}). One accepted item of it is worth:
          </p>
          <div className="mt-3.5 flex flex-wrap gap-2">
            {example.difficulties.map((difficulty) => (
              <span
                key={difficulty.level}
                className={`inline-flex flex-col rounded-[10px] border px-3.5 py-2 ${live ? "border-line bg-white" : "border-line-soft"}`}
              >
                <span className="font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">
                  {difficulty.label}
                  {difficulty.publishedLabel !== difficulty.label && (
                    <span className="ml-1 normal-case tracking-normal">({difficulty.publishedLabel})</span>
                  )}
                </span>
                <span className={`font-mono text-[15px] font-bold ${live ? "text-karma" : "text-ink-faint"}`}>
                  {difficulty.karma} karma
                </span>
              </span>
            ))}
          </div>
          <p className="mt-3.5 border-t border-line-soft pt-3 text-[12px] leading-relaxed text-ink-soft">
            Auditing one item of the same category pays a validator{" "}
            <span className={`font-mono font-bold ${live ? "text-karma" : "text-ink-faint"}`}>{example.validator.karma} karma</span> — a{" "}
            {example.validator.reviewLoadLabel.toLowerCase()} review load, because there are {example.validator.fields} fields
            to read.
          </p>
        </div>
      ) : (
        <Empty
          title="No category priced yet"
          description="An administrator assigns each dataset category its complexity score. Until one is set, no per-item rate can be quoted."
        />
      )}

      <p className="mt-2.5 font-mono text-[11px] leading-relaxed text-ink-faint">
        {matrix.catalogMaxKarma !== null ? (
          <>
            Across the whole catalogue, accepted items range from{" "}
            <span className="text-ink-soft">{matrix.lowestKarma}</span> to{" "}
            <span className="text-ink-soft">{matrix.catalogMaxKarma} karma</span>. Harder categories and harder difficulty
            pay more; a category never pays less than an easier one at the same difficulty. The exact figure for a given
            batch or pool is always shown on the work itself.
          </>
        ) : (
          <>Rates are set per category by an administrator. The exact figure for a given batch or pool is shown on the work itself.</>
        )}
      </p>
    </section>
  );
}

function TierItemsSection({ estimates }: { estimates: TierItemEstimates }) {
  const columns = [estimates.lowest, ...(estimates.catalogHighest ? [estimates.catalogHighest] : [])];
  return (
    <section className="mt-8">
      <SectionTitle
        title="Accepted items per tier"
        sub="The same karma total either way — the spread exists because higher-value items genuinely take more skill or more verification."
      />
      <Table
        headers={[
          "tier",
          <span key="threshold" className="block text-right">karma required</span>,
          ...columns.map((column, index) => (
            <span key={column.karmaPerItem} className="block text-right">
              at {column.karmaPerItem}/item{index === 0 ? " (lowest)" : " (highest today)"}
            </span>
          )),
        ]}
      >
        {estimates.lowest.tiers.map((row, rowIndex) => (
          <tr key={row.tier} className="hover:bg-panel">
            <Td className="text-[13px] font-medium">{row.label}</Td>
            <Td className="text-right font-mono text-[12px] text-ink-soft">{row.minKarma.toLocaleString()}</Td>
            {columns.map((column) => {
              const items = column.tiers[rowIndex]?.items;
              return (
                <Td key={column.karmaPerItem} className="text-right font-mono text-[12.5px]">
                  {items === null || items === undefined ? (
                    <span className="text-ink-faint">—</span>
                  ) : (
                    items.toLocaleString()
                  )}
                </Td>
              );
            })}
          </tr>
        ))}
      </Table>
      <p className="mt-2.5 font-mono text-[11px] leading-relaxed text-ink-faint">
        Counted against the tier thresholds live on this page right now, at the rates shown above.
        {estimates.catalogHighest === null && " No category carries a complexity score yet, so only the ladder floor can be quoted."}
      </p>
    </section>
  );
}

export function KarmaView() {
  const { profileSummary } = useDemo();
  const [data, setData] = useState<KarmaBody | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([]);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [attempt, setAttempt] = useState(0);
  const [eventType, setEventType] = useState("");
  // Date range for the history list. null = all time. Filtered server-side —
  // see resolveApiRange for the local-day → UTC-instant conversion.
  const [historyDateRange, setHistoryDateRange] = useState<DateRangeSelection | null>(null);
  // Free-text history search. `historySearch` is what the field shows;
  // `historyQ` is the debounced value actually sent to the server, which
  // matches on source title, event-kind label, and exact source id. Both this
  // and the leaderboard box below debounce through the one shared hook
  // (lib/use-list-search) rather than a private timer per page.
  const [historySearch, setHistorySearch] = useState("");
  const historyQ = useDebouncedValue(historySearch);
  const [showCatalog, setShowCatalog] = useState(false);
  const [history, setHistory] = useState<KarmaEvent[]>([]);
  const [historyReload, setHistoryReload] = useState(0);
  const [historyStatus, setHistoryStatus] = useState<"loading" | "error" | "ready">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [eventCount, setEventCount] = useState<number | null>(null);
  const [historyError, setHistoryError] = useState<{ message: string; recover: "retry" | "restart" } | null>(null);
  const [leaderCursor, setLeaderCursor] = useState<string | null>(null);
  const [leaderRefreshTick, setLeaderRefreshTick] = useState(0);
  const [leaderLoadingMore, setLeaderLoadingMore] = useState(false);
  const [leaderStatus, setLeaderStatus] = useState<"loading" | "error" | "ready">("loading");
  const [leaderLoadMoreError, setLeaderLoadMoreError] = useState(false);
  const [leaderTier, setLeaderTier] = useState("");
  const [leaderQ, setLeaderQ] = useState("");
  const leaderQApplied = useDebouncedValue(leaderQ);

  const historyFiltered = Boolean(eventType || historyDateRange || historyQ);


  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setStatus("loading");
    }, 0);

    // Summary only — the history list below owns its own filtered, paged
    // request (`?view=history`), so filtering or paging history never re-runs
    // this heavier tier/badge/matrix query. limit=1 because this call's own
    // events array is unused.
    const query = new URLSearchParams({ limit: "1" });
    void authedFetch(`${API.me.communityKarma}?${query.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("karma");
        const body = (await res.json()) as KarmaBody;
        if (!cancelled) {
          setData(body);
          setStatus("ready");
        }
      })
      .catch(() => !cancelled && setStatus("error"));

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt]);


  /** Builds the history query for a page. `cursor` null = the first page. */
  const historyQuery = (cursor: string | null) => {
    const query = new URLSearchParams({ view: "history", limit: String(HISTORY_PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    if (eventType) query.set("eventType", eventType);
    if (historyQ) query.set("q", historyQ);
    const apiRange = resolveApiRange(historyDateRange);
    if (apiRange.from) query.set("from", apiRange.from);
    if (apiRange.to) query.set("to", apiRange.to);
    return query;
  };

  // First page of history. Filters (kind · period · search) are server-side, so
  // any change here re-reads from the top and drops whatever "Load more" had
  // appended — the appended pages were keyed to the previous filter set.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setHistoryStatus("loading");
    }, 0);

    void authedFetch(`${API.me.communityKarma}?${historyQuery(null).toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("fetch");
        const body = (await res.json()) as KarmaHistoryBody;
        if (cancelled) return;
        setHistory(body.events);
        setNextCursor(body.nextCursor);
        setHasMore(body.hasMore ?? Boolean(body.nextCursor));
        setEventCount(body.eventCount ?? null);
        setHistoryError(null);
        setHistoryStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setHistoryError({ message: "Couldn't load your karma history.", recover: "restart" });
        setHistoryStatus("error");
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- historyQuery is rebuilt from exactly these inputs
  }, [attempt, eventType, historyDateRange, historyQ, historyReload]);

  /** Appends the next page. A 400 here means the server rejected the cursor
   *  (the row it pointed at is gone), which only a reload from the top fixes. */
  const loadMoreHistory = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setHistoryError(null);
    try {
      const res = await authedFetch(`${API.me.communityKarma}?${historyQuery(nextCursor).toString()}`);
      if (!res.ok) throw new Error(res.status === 400 ? "cursor" : "fetch");
      const body = (await res.json()) as KarmaHistoryBody;
      setHistory((current) => [...current, ...body.events]);
      setNextCursor(body.nextCursor);
      setHasMore(body.hasMore ?? Boolean(body.nextCursor));
      setEventCount(body.eventCount ?? null);
    } catch (error) {
      setHistoryError(
        error instanceof Error && error.message === "cursor"
          ? { message: "This page of history was out of date, so the server refused it — there is more to show.", recover: "restart" }
          : { message: "Couldn't load more history. Nothing below is missing from what is already shown.", recover: "retry" },
      );
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setLeaderStatus("loading");
    });
    const query = new URLSearchParams();
    if (leaderTier) query.set("tier", leaderTier);
    if (leaderQApplied) query.set("q", leaderQApplied);
    void authedFetch(`${API.community.leaderboard}?${query.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("leaderboard");
        const body = (await res.json()) as LeaderboardBody;
        if (!cancelled && Array.isArray(body.leaderboard)) {
          setLeaderboard(body.leaderboard);
          setLeaderCursor(body.nextCursor);
          setLeaderStatus("ready");
          setLeaderLoadMoreError(false);
        }
      })
      .catch(() => !cancelled && setLeaderStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [attempt, leaderTier, leaderQApplied, leaderRefreshTick]);

  const loadMoreLeaders = async () => {
    if (!leaderCursor || leaderLoadingMore) return;
    setLeaderLoadingMore(true);
    setLeaderLoadMoreError(false);
    try {
      const query = new URLSearchParams({ cursor: leaderCursor });
      if (leaderTier) query.set("tier", leaderTier);
      if (leaderQApplied) query.set("q", leaderQApplied);
      const res = await authedFetch(`${API.community.leaderboard}?${query.toString()}`);
      if (!res.ok) throw new Error("leaderboard");
      const body = (await res.json()) as LeaderboardBody;
      setLeaderboard((current) => [...current, ...body.leaderboard]);
      setLeaderCursor(body.nextCursor);
    } catch {
      setLeaderLoadMoreError(true);
    } finally {
      setLeaderLoadingMore(false);
    }
  };

  if (status === "loading") {
    return (
      <div>
        <PageHeader title="Karma" sub="Your reputation on DataBounty. Earned through verified contribution and audit work." />
        <AsyncState status="loading" loadingText="Loading your karma…" />
      </div>
    );
  }

  if (status === "error" || !data) {
    return (
      <div>
        <PageHeader title="Karma" sub="Your reputation on DataBounty. Earned through verified contribution and audit work." />
        <AsyncState status="error" errorTitle="Could not load your karma" errorDescription="The karma service did not respond." />
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
        </div>
      </div>
    );
  }

  const { total, pendingTotal = 0, tier, nextTier, tiers, matrix, tierItemEstimates, eventTypeFilters } = data;
  const securedByRole = data.holdsByRole ?? {
    contributor: { pending: 0, awardCount: 0 },
    validator: { pending: 0, awardCount: 0 },
    sponsor: { pending: 0, awardCount: 0 },
  };
  const badgeCatalog = data.badgeCatalog ?? [];
  const viewerHandle = data.handle ?? null;
  const earnedBadges = profileSummary.badges;
  const badgeFamilies = Array.from(
    new Set<BadgeFamily>([...badgeCatalog.map((b) => b.family), ...earnedBadges.map((b) => b.family)])
  );
  const progressPct = nextTier && nextTier.minKarma > 0 ? Math.min(100, (total / nextTier.minKarma) * 100) : 100;
  const nextPerks = nextTier?.perks ?? [];

  const inReviewItems = (data.inReview?.items ?? 0) + (data.inReviewValidator?.openItems ?? 0);
  const inReviewProjected = (data.inReview?.projectedKarma ?? 0) + (data.inReviewValidator?.projectedKarma ?? 0);
  const inReviewParts = [
    data.inReview?.items ? `${data.inReview.items.toLocaleString()} submitted` : null,
    data.inReviewValidator?.openItems ? `${data.inReviewValidator.openItems.toLocaleString()} in open audits` : null,
  ].filter(Boolean);
  const inReviewCombined = inReviewItems > 0
    ? { items: inReviewItems, projected: inReviewProjected, label: inReviewParts.join(" · ") }
    : null;

  const tierForKarma = (karma: number): Pick<Tier, "label" | "color"> => {
    const ladder = [...tiers].sort((a, b) => a.minKarma - b.minKarma);
    let match: Pick<Tier, "label" | "color"> = ladder[0] ?? tier;
    for (const candidate of ladder) if (karma >= candidate.minKarma) match = candidate;
    return match;
  };

  return (
    <div>
      <PageHeader
        title="Karma"
        sub="Karma is your reputation, earned on community work. Tiers unlock priority and platform perks."
      />

      <div className="card px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-karma-soft text-karma">
              <Icon name="sparkles" size={20} />
            </div>
            <div>
              <div className="flex flex-wrap items-end gap-2.5">
                <span className="font-mono text-[38px] font-bold leading-none tracking-tight">{total.toLocaleString()}</span>
                <span className="mb-1 font-mono text-xs text-ink-faint">karma</span>
                <span className="mb-0.5"><TierChip tier={tier} /></span>
              </div>
              <p className="mt-1.5 text-xs text-ink-soft">{tier.blurb}</p>
            </div>
          </div>
          {data.openLeaderboardRank !== null && data.openLeaderboardRank !== undefined && (
            <div className="font-mono text-[11px] text-ink-soft">
              rank #{data.openLeaderboardRank} on the open leaderboard
            </div>
          )}
        </div>

        {nextTier ? (
          <>
            <div className="mt-5 flex items-center justify-between font-mono text-[11px] text-ink-soft">
              <span>progress toward {nextTier.label}</span>
              <span className="text-ink">{nextTier.karmaToGo.toLocaleString()} to {nextTier.label}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line-soft">
              <div className="h-full rounded-full bg-karma transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          </>
        ) : (
          <p className="mt-5 font-mono text-[11px] text-ink-soft">Highest tier reached.</p>
        )}
      </div>

      <KarmaStateCard
        className="mt-4"
        earned={total}
        secured={pendingTotal}
        inReview={inReviewCombined}
        reversedTotal={data.reversedTotal ?? 0}
        holds={data.holds ?? []}
        byRole={securedByRole}
        releaseRule={data.releaseRule ?? null}
        variant="full"
      />

      {nextTier && (
        <div className="mt-4 flex items-start gap-2.5 rounded-[10px] border border-[#e2d9f3] bg-[#f7f4fc] px-5 py-3.5 text-[13px] text-[#5b4a86]">
          <Icon name="sparkles" size={15} className="mt-0.5 shrink-0" />
          <p className="leading-relaxed">
            <span className="font-semibold">Next for you:</span> {nextTier.karmaToGo.toLocaleString()} more karma reaches <span className="font-semibold">{nextTier.label}</span>{nextPerks.length ? ` and unlocks ${nextPerks.join(", ").toLowerCase()}.` : "."}
          </p>
        </div>
      )}

      <section className="mt-8">
        <SectionTitle title="Tiers & perks" sub="What each tier unlocks." />
        {tiers.length === 0 && (
          <Empty title="Tiers not configured" description="An administrator has not published the karma tier ladder yet." />
        )}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiers.map((item) => {
            const current = item.state === "current";
            const locked = item.state === "locked";
            return (
              <div key={item.name} className={`card flex flex-col px-5 py-4 ${current ? "border-[1.5px] border-[#c8b8ea]" : ""} ${locked ? "opacity-55" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <TierChip tier={item} />
                  <span className="font-mono text-[10px] text-ink-faint">{item.state}</span>
                </div>
                <div className="mt-2.5 font-mono text-xs text-ink-soft">{item.minKarma === 0 ? "0+" : `${item.minKarma.toLocaleString()}+`} karma</div>
                <ul className="mt-3 flex flex-col gap-1.5 text-[12px] leading-snug text-ink-soft">
                  {item.perks.map((perk) => (
                    <li key={perk} className="flex items-start gap-1.5"><Icon name="check" size={11} className={`mt-[3px] shrink-0 ${locked ? "text-ink-faint" : "text-karma"}`} />{perk}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-8">
        <SectionTitle title="Badges" sub="Badges record milestones. Perks come from tiers." />
        <div className="card px-5 py-4">
          <div className="flex flex-col gap-3.5">
            {badgeFamilies.map((family) => {
              const inFamily = earnedBadges.filter((b) => b.family === family);
              if (inFamily.length === 0) return null;
              return (
                <div key={family} className="flex flex-wrap items-center gap-2">
                  <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">{family}</span>
                  {inFamily.map((b) => (
                    <span key={b.id} title={b.criteria} className="inline-flex items-center rounded-full border border-line bg-white px-3 py-1.5 font-mono text-[11.5px] text-ink-soft">
                      {b.label}
                    </span>
                  ))}
                </div>
              );
            })}
            {earnedBadges.length === 0 && (
              <span className="text-sm text-ink-soft">No badges yet. They arrive as your accepted work adds up.</span>
            )}
          </div>

          {badgeCatalog.length > 0 && (
            <>
              <button
                onClick={() => setShowCatalog(!showCatalog)}
                className="mt-4 inline-flex cursor-pointer items-center gap-1 font-mono text-[12px] font-medium text-ink-soft hover:underline"
              >
                {showCatalog ? "hide all possible badges" : "view all possible badges"}
                <Icon name={showCatalog ? "x" : "arrow-right"} size={12} />
              </button>

              {showCatalog && (
                <div className="mt-4 flex flex-col gap-3.5 border-t border-line-soft pt-4">
                  {badgeFamilies.map((family) => {
                    const rules = badgeCatalog.filter((r) => r.family === family);
                    if (rules.length === 0) return null;
                    return (
                      <div key={family} className="flex flex-wrap items-start gap-2">
                        <span className="mt-2 w-16 shrink-0 font-mono text-[10px] uppercase tracking-[.05em] text-ink-faint">{family}</span>
                        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                          {rules.map((rule) => (
                            <span
                              key={rule.key}
                              title={rule.criteria}
                              className={`inline-flex flex-col rounded-[10px] border px-3 py-1.5 font-mono ${rule.earned ? "border-line bg-white text-ink-soft" : "border-line-soft text-ink-faint opacity-70"}`}
                            >
                              <span className="text-[11.5px]">{rule.label}</span>
                              <span className="text-[10px] text-ink-faint">{rule.criteria}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {matrix && <PricingSection matrix={matrix} />}
      {matrix && tierItemEstimates && <TierItemsSection estimates={tierItemEstimates} />}

      <section className="mt-8">
        <SectionTitle
          title="History"
          sub={
            eventCount !== null && eventCount > history.length
              ? `Newest first. Showing ${history.length.toLocaleString()} of ${eventCount.toLocaleString()}${historyFiltered ? " matching" : ""} event${eventCount === 1 ? "" : "s"}.`
              : "Newest first."
          }
        />
        {/* Search · kind · period are all server-side filters — the same
            control set, in the same order, as the other filtered lists in this
            app (see app/(app)/issues/page.tsx). Any change re-reads page one. */}
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <SearchField
            value={historySearch}
            onChange={setHistorySearch}
            placeholder="Search karma history…"
            className="sm:w-72"
          />
          {eventTypeFilters.length > 1 && (
            <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
              Kind
              <Select
                value={eventType}
                onChange={(event) => setEventType(event.target.value)}
                aria-label="Filter karma history by event kind"
                className="w-[190px]"
              >
                <option value="">All verified events</option>
                {eventTypeFilters.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
              </Select>
            </label>
          )}
          <div className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
            Period
            <DateRangePicker
              value={historyDateRange}
              onChange={(selection) => {
                setHistoryDateRange(selection);
              }}
            />
          </div>
          {historyFiltered && (
            <button
              type="button"
              onClick={() => {
                setEventType("");
                // `historyQ` is derived (useDebouncedValue) and settles an
                // empty value immediately, so clearing the box here is enough
                // — there is no second state to reset.
                setHistorySearch("");
                setHistoryDateRange(null);
              }}
              className="h-9 rounded-lg border border-line px-3 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-soft transition-colors hover:border-ink hover:text-ink"
            >
              Clear filters
            </button>
          )}
        </div>
        {history.length ? (
          <div className="card">
            {groupEventsByDay(history).map((group) => (
              <div key={group.day}>
                <div className="flex items-center justify-between border-b border-line-soft bg-panel px-5 py-2 font-mono text-[10.5px] uppercase tracking-[0.05em] text-ink-faint first:rounded-t-[inherit]">
                  <span>{group.label}</span>
                  <span>
                    {(() => {
                      const dayTotal = group.events.reduce((sum, e) => sum + e.amount, 0);
                      return `${dayTotal > 0 ? "+" : ""}${dayTotal.toLocaleString()} karma · ${group.events.length} event${group.events.length === 1 ? "" : "s"}`;
                    })()}
                  </span>
                </div>
                <div className="divide-y divide-line-soft">
                  {group.events.map((event) => {
                    const meta = eventMeta(event);
                    const href = eventHref(event);
                    const title = event.sourceLabel ?? humanizeKey(event.sourceType);
                    return (
                      <div key={event.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3">
                        <Pill tone={meta.tone}>{meta.label}</Pill>
                        {href ? (
                          <Link href={href} className="min-w-0 flex-1 truncate text-[13px] text-ink underline decoration-line-strong decoration-dotted underline-offset-2 hover:decoration-ink">
                            {title}
                          </Link>
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{title}</span>
                        )}
                        <span className={`w-20 text-right font-mono text-[13px] font-bold ${event.amount < 0 ? "text-rose-600" : "text-karma"}`}>{event.amount > 0 ? "+" : ""}{event.amount.toLocaleString()}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : historyStatus === "loading" ? (
          <div className="card px-5 py-8 text-center font-mono text-[12px] text-ink-faint">Loading history…</div>
        ) : historyStatus === "error" ? null : (
          <Empty
            title={historyFiltered ? "No matching karma events" : "No karma yet"}
            description={historyFiltered ? "No verified events match these server-side filters." : "Submit into an open pool and get accepted work to start earning."}
          />
        )}
        {historyError && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-amber-200 bg-amber-50 px-5 py-3.5 text-[13px] text-amber-800">
            <div className="flex min-w-0 items-start gap-2.5">
              <Icon name="info" size={15} className="mt-0.5 shrink-0" />
              <p className="leading-relaxed">{historyError.message}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={loadingMore || historyStatus === "loading"}
              onClick={() => {
                if (historyError.recover === "restart") setHistoryReload((tick) => tick + 1);
                else void loadMoreHistory();
              }}
            >
              {loadingMore || historyStatus === "loading"
                ? (historyError.recover === "restart" ? "Reloading…" : "Retrying…")
                : (historyError.recover === "restart" ? "Reload history" : "Retry")}
            </Button>
          </div>
        )}
        {hasMore && !historyError && (
          <div className="mt-3 flex justify-center">
            <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMoreHistory()}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </section>

      <section className="mt-8">
        <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
          <SectionTitle title="Open leaderboard" sub="Top contributors across all DataBounty Open datasets." />
          <AutoRefreshControl
            refreshing={leaderStatus === "loading"}
            onRefresh={() => setLeaderRefreshTick((tick) => tick + 1)}
          />
        </div>
        {(leaderboard.length > 0 || leaderTier || leaderQApplied) && (
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="sm:flex-1">
              <SearchField value={leaderQ} onChange={setLeaderQ} placeholder="Search handle" />
            </div>
            <Select
              value={leaderTier}
              onChange={(event) => setLeaderTier(event.target.value)}
              className="sm:w-52"
              aria-label="Filter leaderboard by tier"
            >
              <option value="">All tiers</option>
              {tiers.map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
            </Select>
          </div>
        )}
        {leaderboard.length ? (
          <Table
            headers={[
              "rank",
              "handle",
              "name",
              "tier",
              <span key="accepted" className="block text-right">accepted items</span>,
              <span key="karma" className="block text-right">karma</span>,
            ]}
          >
            {leaderboard.map((row) => {
              const isYou = Boolean(viewerHandle) && row.handle === viewerHandle;
              return (
              <tr key={row.handle} className={isYou ? "bg-karma/[.06] hover:bg-karma/[.09]" : "hover:bg-panel"}>
                <Td className="font-mono text-[12px] text-ink-soft">#{row.rank}</Td>
                <Td className="text-[13px] font-medium">
                  <a
                    href={`${LANDING_URL}/${encodeURIComponent(row.handle)}${isYou ? "?me=1" : ""}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-karma hover:underline"
                  >
                    {row.handle}
                  </a>
                  {isYou && (
                    <span className="ml-1.5 rounded-full bg-karma/15 px-1.5 py-[1px] font-mono text-[10px] font-medium text-karma">
                      you
                    </span>
                  )}
                </Td>
                <Td className="text-[13px] text-ink-soft">{row.displayName ?? <span className="text-ink-faint">—</span>}</Td>
                <Td><TierChip tier={tierForKarma(row.karma)} /></Td>
                <Td className="text-right font-mono text-[12px] text-ink-soft">{row.acceptedItems.toLocaleString()}</Td>
                <Td className="text-right font-mono text-[13px] font-bold text-karma">{row.karma.toLocaleString()}</Td>
              </tr>
              );
            })}
          </Table>
        ) : leaderStatus === "error" ? (
          <Empty
            title="Couldn't load the leaderboard"
            description="Something went wrong fetching the open leaderboard. This is a load error, not an empty board."
            action={<Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
          />
        ) : leaderStatus === "loading" ? (
          <Empty title="Loading leaderboard…" description="Fetching the top contributors across all DataBounty Open datasets." />
        ) : (leaderTier || leaderQApplied)
          ? <Empty title="No matching contributors" description="No public contributors match this tier or handle. Clear the filter to see the full board." />
          : <Empty title="Leaderboard is quiet" description="Contributors who make their karma public appear here." />}
        {leaderLoadMoreError && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-amber-200 bg-amber-50 px-5 py-3.5 text-[13px] text-amber-800">
            <div className="flex min-w-0 items-start gap-2.5">
              <Icon name="info" size={15} className="mt-0.5 shrink-0" />
              <p className="leading-relaxed">Couldn&apos;t load more of the leaderboard. What&apos;s already shown is unaffected.</p>
            </div>
            <Button variant="secondary" size="sm" disabled={leaderLoadingMore} onClick={() => void loadMoreLeaders()}>
              {leaderLoadingMore ? "Retrying…" : "Retry"}
            </Button>
          </div>
        )}
        {leaderCursor && !leaderLoadMoreError && (
          <div className="mt-3 flex justify-center"><Button variant="secondary" size="sm" disabled={leaderLoadingMore} onClick={() => void loadMoreLeaders()}>{leaderLoadingMore ? "Loading…" : "Load more"}</Button></div>
        )}
        <Link href="/contributor" className="mt-3 inline-flex items-center gap-1 font-mono text-[12px] font-medium text-karma hover:underline">find community work<Icon name="arrow-right" size={12} /></Link>
      </section>
    </div>
  );
}

export default function KarmaPage() {
  return <KarmaView />;
}
