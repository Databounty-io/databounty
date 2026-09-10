"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import { Button, CursorPager, Empty, Pill, Progress, SearchField, Select, Stat } from "@/components/ui";
import { CommunityRequestCard } from "@/components/community-request-card";
import { type DatasetRequestFull } from "@/components/dataset-request-detail";
import { num } from "@/lib/format";
import { useDebouncedValue, useLatestRequest } from "@/lib/use-list-search";
import { API } from "@/lib/api-endpoints";
import { authedFetch } from "@/lib/store";
import { getCommunityOpenPools, type CommunityOpenPool } from "@/lib/api-work";

type KarmaTier = {
  name: string;
  label: string;
  color: string;
  earlyAccessHours: number;
  concurrencyBonus: number;
};
type NextTier = { name: string; label: string; minKarma: number; karmaToGo: number };

export function CommunityView() {
  const [requests, setRequests] = useState<DatasetRequestFull[]>([]);
  const [pools, setPools] = useState<CommunityOpenPool[]>([]);
  const [karma, setKarma] = useState(0);
  const [tier, setTier] = useState<KarmaTier | null>(null);
  const [nextTier, setNextTier] = useState<NextTier | null>(null);
  const [rank, setRank] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workSearch, setWorkSearch] = useState("");
  // The `setTimeout(…, 0)` around loadPools below defers to the next tick; it
  // is NOT a debounce, so this box was issuing one /v1/community/pools request
  // per keystroke. The request now waits for typing to settle, and the list
  // ignores a superseded response.
  const debouncedWorkSearch = useDebouncedValue(workSearch);
  const beginPoolsRequest = useLatestRequest();
  // Idempotent: `workCursorStack` is a fetch dependency, so a fresh `[null]`
  // array per keystroke re-ran the request even when the debounced query was
  // unchanged. Returning the same array makes React skip the update.
  const resetWorkPaging = () => {
    setWorkCursorStack((prev) => (prev.length === 1 && prev[0] === null ? prev : [null]));
    setWorkPageIndex(0);
  };
  const [workDifficulty, setWorkDifficulty] = useState("");
  const [workCursorStack, setWorkCursorStack] = useState<(string | null)[]>([null]);
  const [workPageIndex, setWorkPageIndex] = useState(0);
  const [workNextCursor, setWorkNextCursor] = useState<string | null>(null);
  const [workLoading, setWorkLoading] = useState(true);
  const [workError, setWorkError] = useState(false);

  const load = async () => {
    const [requestRes, karmaRes] = await Promise.all([
      authedFetch(API.me.communityRequestsMine),
      authedFetch(API.me.communityKarma),
    ]);
    if (requestRes.ok) setRequests((await requestRes.json()).requests);
    if (karmaRes.ok) {
      const body = (await karmaRes.json()) as {
        total: number;
        tier: KarmaTier;
        nextTier: NextTier | null;
        openLeaderboardRank: number | null;
      };
      setKarma(body.total);
      setTier(body.tier);
      setNextTier(body.nextTier);
      setRank(body.openLeaderboardRank ?? null);
    }
    if (!karmaRes.ok) {
      setNotice("Couldn't load your community data right now — refresh to try again.");
    }
  };

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void load().catch(() => {
        if (!cancelled) setNotice("Community features are not enabled yet.");
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const loadPools = useCallback(async () => {
    const isStale = beginPoolsRequest();
    setWorkLoading(true);
    const cursor = workCursorStack[workPageIndex];
    try {
      const body = await getCommunityOpenPools({
        limit: 12,
        cursor,
        search: debouncedWorkSearch,
        difficulty: workDifficulty || undefined,
      });
      if (isStale()) return;
      setPools(body.pools);
      setWorkNextCursor(body.nextCursor ?? null);
      setWorkError(false);
    } catch {
      if (isStale()) return;
      setWorkError(true);
    } finally {
      if (!isStale()) setWorkLoading(false);
    }
  }, [debouncedWorkSearch, workDifficulty, workPageIndex, workCursorStack, beginPoolsRequest]);

  useEffect(() => {
    const t = setTimeout(() => {
      void loadPools();
    }, 0);
    return () => clearTimeout(t);
  }, [loadPools]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Community datasets"
        sub="Open datasets, verified contribution karma, and reviewable dataset requests."
      />
      {notice && (
        <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-800">
          {notice}
        </p>
      )}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="verified karma" value={karma} sub={tier ? `${tier.label} tier` : undefined} />
        <Stat
          label="next tier"
          value={nextTier ? nextTier.karmaToGo : "—"}
          sub={nextTier ? `karma to ${nextTier.label}` : "top tier reached"}
        />
        <Stat
          label="leaderboard rank"
          value={rank != null ? `#${rank}` : "—"}
          sub={rank != null ? "opt-in leaderboard" : "not on leaderboard"}
        />
        <Stat label="your requests" value={requests.length} sub="submitted" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="text-xs text-ink-soft">Karma is written only after an accepted item or completed community audit.</p>
        {tier && tier.earlyAccessHours > 0 && <Pill>{tier.earlyAccessHours}h early access</Pill>}
        {tier && tier.concurrencyBonus > 0 && (
          <Pill>
            +{tier.concurrencyBonus} concurrent batch{tier.concurrencyBonus === 1 ? "" : "es"}
          </Pill>
        )}
      </div>

      <section className="mt-5">
        <h2 className="font-semibold">Open community work</h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="sm:flex-1">
            <SearchField
              value={workSearch}
              placeholder="Search open datasets"
              onChange={(v) => {
                resetWorkPaging();
                setWorkSearch(v);
              }}
            />
          </div>
          <Select
            aria-label="Filter by difficulty"
            value={workDifficulty}
            onChange={(e) => {
              resetWorkPaging();
              setWorkDifficulty(e.target.value);
            }}
            className="sm:w-52"
          >
            <option value="">All difficulties</option>
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="expert">Expert</option>
          </Select>
        </div>
        {workError ? (
          /* A failed request is not an empty list — say so, and offer the one
             action that can change it. */
          <div className="mt-3">
            <Empty
              icon="alert"
              title="Couldn’t load open work"
              description="The open-pool list could not be fetched."
              action={
                <Button variant="secondary" size="sm" disabled={workLoading} onClick={() => void loadPools()}>
                  Retry
                </Button>
              }
            />
          </div>
        ) : workLoading && pools.length === 0 ? (
          <div className="mt-3">
            <Empty title="Loading…" description="Fetching open community work." />
          </div>
        ) : pools.length === 0 ? (
          <div className="mt-3">
            <Empty
              title={workSearch || workDifficulty ? "No matching work" : "No community work is open"}
              description={
                workSearch || workDifficulty
                  ? "Try a different search or difficulty."
                  : "New approved community datasets will appear here."
              }
            />
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {pools.map((pool) => {
              const target = Number(pool.targetItems) || 0;
              const accepted = Number(pool.acceptedItems) || 0;
              // How FULL the pool is is the cleared/intake count, not the
              // finally-accepted count: items that passed automation already
              // hold capacity and are what close the pool.
              const cleared = pool.poolSummary?.capacityReserved ?? (pool.clearedItems == null ? accepted : Number(pool.clearedItems) || 0);
              const pct = target > 0 ? Math.min(100, Math.round((cleared / target) * 100)) : 0;
              const perItem = pool.karmaPricing?.contributorPerItem ?? pool.karmaPerAcceptedItem;
              const upToTotal = pool.karmaPricing?.contributorTotal ?? pool.karmaPerAcceptedItem * target;
              return (
                <Link key={pool.id} href={`/contributor/pool/${pool.id}`} className="card group block p-4 transition-colors hover:border-ink sm:p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-[14px] font-bold text-ink">{pool.title}</span>
                      <Pill tone="karma">direct submit</Pill>
                    </div>
                    <Icon name="arrow-right" size={15} className="shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden="true" />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 font-mono text-[10px] text-ink-soft">
                    <span className="shrink-0" title="Items in processing, human review, or finally accepted reserve capacity. Failed or rejected items release it.">{num(cleared)} / {num(target)} capacity reserved</span>
                    <Progress value={cleared} max={target} tone="ink" track="line" className="h-1 min-w-[80px] flex-1 rounded-full" />
                    <span className="shrink-0 font-bold text-ink">{pct}%</span>
                  </div>
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
          </div>
        )}
        <CursorPager
          pageNumber={workPageIndex + 1}
          hasPrev={workPageIndex > 0}
          hasNext={Boolean(workNextCursor)}
          disabled={workLoading}
          onPrev={() => setWorkPageIndex((i) => Math.max(0, i - 1))}
          onNext={() => {
            if (!workNextCursor) return;
            setWorkCursorStack((stack) => {
              const next = stack.slice(0, workPageIndex + 1);
              next.push(workNextCursor);
              return next;
            });
            setWorkPageIndex((i) => i + 1);
          }}
          className="mt-4"
        />
      </section>

      <section className="card mt-6 p-5">
        <h2 className="font-semibold">Request a dataset</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Answer a few questions in the planner and we&apos;ll review it. Admin review is required before a request opens to the community.
        </p>
        <div className="mt-4">
          <Link href="/sponsor/create">
            <Button>start a dataset request</Button>
          </Link>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="font-semibold">Your requests</h2>
        {requests.length ? (
          <div className="mt-3 space-y-2">
            {requests.map((request) => (
              <CommunityRequestCard
                key={request.id}
                request={request}
                href={`/sponsor/requests/${request.id}?from=community`}
              />
            ))}
          </div>
        ) : (
          <div className="mt-3">
            <Empty title="No dataset requests" description="Submitted requests appear here." />
          </div>
        )}
      </section>
    </div>
  );
}
