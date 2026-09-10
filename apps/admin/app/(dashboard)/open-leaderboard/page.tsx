"use client";

// SPDX-License-Identifier: Apache-2.0

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminButton,
  AdminEmptyState,
  AdminErrorBanner,
  AdminPageHeader,
  AdminTable,
  AdminTableSkeletonRows,
  ATd,
} from "@/components/admin-shell";
import { Icon } from "@/components/icons";
import { AutoRefreshControl } from "@/components/auto-refresh";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { num } from "@/lib/format";

type Tier = "dharma" | "bodhi" | "moksha" | "nirvana";

const TIERS: { key: Tier | "all"; label: string }[] = [
  { key: "all", label: "all tiers" },
  { key: "dharma", label: "Dharma" },
  { key: "bodhi", label: "Bodhi" },
  { key: "moksha", label: "Moksha" },
  { key: "nirvana", label: "Nirvana" },
];

interface LeaderboardRow {
  rank: number;
  handle: string;
  /** Returned verbatim, including when it equals the handle — claiming a first
   * handle deliberately sets the display name to match it, so that is the
   * designed starting state rather than a duplicate to hide. Null only for a
   * blank value; `users.display_name` is NOT NULL. */
  displayName: string | null;
  karma: number;
  acceptedItems: number;
}

interface LeaderboardPage {
  leaderboard: LeaderboardRow[];
  nextCursor: string | null;
}

interface ProfileDetail {
  handle: string;
  displayName?: string;
  memberSince: string;
  /** Absent (together with `karma`) when the member hid "karma & tier" (SEC-10). */
  tier?: { id: string; label: string; color: string };
  publishedCredits: { title: string; hfSlug: string; hfUrl: string }[];
  karma?: number;
  badges?: { id: string; family: string; label: string }[];
  datasets?: { id: string; title: string; items: number }[];
  datasetsContributed?: number;
  acceptedItems?: number;
  audits?: number;
}

/* The full, browsable open leaderboard — same public endpoint
 * (GET /v1/community/leaderboard) the member-facing karma page uses, so the
 * ranks an admin sees here can never drift from what a contributor sees.
 * Cursor-paginated (server computes true global rank per row, not
 * rank-within-page), so it's a "load more" list rather than numbered pages. */
export default function AdminOpenLeaderboardPage() {
  const [tier, setTier] = useState<Tier | "all">("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const reqId = useRef(0);
  // Tracks what the last failed request actually asked for, so retrying a
  // failed "load more" resumes from that cursor instead of silently
  // restarting at page 1 (which would happen if retry always replayed the
  // current `cursor` state, since that state is never updated on append).
  const lastAttempt = useRef<{ cursor: string | null; append: boolean }>({ cursor: null, append: false });
  const [expandedHandle, setExpandedHandle] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileDetail | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState("");

  // Same public, anonymous endpoint the landing profile page reads
  // (GET /v1/profiles/handle/:handle) — an admin sees exactly the sections
  // the contributor chose to make visible, nothing more, so this can never
  // leak data the member opted to hide.
  const toggleExpand = async (handle: string) => {
    if (expandedHandle === handle) {
      setExpandedHandle(null);
      setProfile(null);
      return;
    }
    setExpandedHandle(handle);
    setProfile(null);
    setProfileError("");
    setProfileLoading(true);
    try {
      const res = await adminAuthedFetch(`/v1/profiles/handle/${encodeURIComponent(handle)}`);
      if (!res.ok) throw new Error(res.status === 404 ? "Profile not found or not public." : "Profile is unavailable.");
      setProfile((await res.json()) as ProfileDetail);
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : "Profile is unavailable.");
    } finally {
      setProfileLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (nextCursorArg: string | null, append: boolean) => {
      const id = ++reqId.current;
      lastAttempt.current = { cursor: nextCursorArg, append };
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        // No `limit`: the page size is a server decision, from the
        // `community.leaderboard.page_size` admin setting. Paging still reaches
        // every qualifying member by following the cursor.
        const query = new URLSearchParams();
        if (tier !== "all") query.set("tier", tier);
        if (debouncedSearch) query.set("q", debouncedSearch);
        if (nextCursorArg) query.set("cursor", nextCursorArg);
        const res = await adminAuthedFetch(`/v1/community/leaderboard?${query}`);
        if (id !== reqId.current) return;
        if (!res.ok) throw new Error("Leaderboard is unavailable.");
        const body = (await res.json()) as LeaderboardPage;
        setRows((prev) => (append ? [...prev, ...body.leaderboard] : body.leaderboard));
        setNextCursor(body.nextCursor);
        setError("");
      } catch {
        if (id !== reqId.current) return;
        setError("Leaderboard is unavailable.");
        if (!append) setRows([]);
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [tier, debouncedSearch]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(null, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Open leaderboard"
        sub="Top contributors by karma, ranked globally across all community programs — public handles only."
        actions={
          /* Re-reads page 1 and drops any "Load more" pages, same as the member
             dashboard. Deliberate: ranks are global, so a freshly-read page 1
             stitched onto pages fetched before the board moved could show a
             member twice or skip one entirely. */
          <AutoRefreshControl
            refreshing={loading}
            onRefresh={() => load(null, false)}
          />
        }
      />

      {error && (
        <AdminErrorBanner
          message={error}
          onRetry={() => void load(lastAttempt.current.cursor, lastAttempt.current.append)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        {TIERS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTier(t.key)}
            className={`cursor-pointer rounded-full border px-3.5 py-2.5 transition-colors sm:py-1.5 ${
              tier === t.key
                ? "border-lime bg-lime text-dark"
                : "border-dark-line text-dark-soft hover:border-dark-hover hover:text-dark-text"
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="relative ml-auto">
          <Icon
            name="search"
            size={13}
            strokeWidth={2}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dark-dim"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search handle"
            className="w-60 rounded-lg border border-dark-line bg-dark-card py-1.5 pl-8 pr-3 font-mono text-xs text-dark-text placeholder:text-dark-dim focus:border-dark-hover focus:outline-none"
          />
        </div>
      </div>

      <AdminTable headers={["rank", "handle", "name", "accepted items", "karma"]}>
        {loading && rows.length === 0 ? (
          <AdminTableSkeletonRows columns={5} />
        ) : rows.length === 0 ? null : (
          rows.map((row) => (
            <React.Fragment key={`${row.rank}-${row.handle}`}>
              <tr
                onClick={() => void toggleExpand(row.handle)}
                className="cursor-pointer hover:bg-dark-hover/10"
                aria-expanded={expandedHandle === row.handle}
              >
                <ATd className="text-dark-dim">#{row.rank}</ATd>
                <ATd className="font-semibold">@{row.handle}</ATd>
                <ATd className="text-dark-soft">{row.displayName ?? <span className="text-dark-dim">—</span>}</ATd>
                <ATd className="text-dark-soft">{num(row.acceptedItems)}</ATd>
                <ATd className="font-bold text-lime">{num(row.karma)}</ATd>
              </tr>
              {expandedHandle === row.handle && (
                <tr>
                  <ATd colSpan={5} className="bg-dark-panel">
                    {profileLoading ? (
                      <span className="text-dark-dim">loading profile…</span>
                    ) : profileError ? (
                      <span className="text-rose-400">{profileError}</span>
                    ) : profile ? (
                      <div className="grid gap-3 py-1 sm:grid-cols-2 lg:grid-cols-4">
                        <div>
                          <div className="text-dark-dim">member since</div>
                          <div className="text-dark-text">{new Date(profile.memberSince).toLocaleDateString()}</div>
                        </div>
                        <div>
                          <div className="text-dark-dim">tier</div>
                          {profile.tier ? (
                            <div className="inline-flex items-center gap-1.5 text-dark-text">
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: profile.tier.color }} />
                              {profile.tier.label}
                            </div>
                          ) : (
                            <div className="text-dark-text">hidden</div>
                          )}
                        </div>
                        <div>
                          <div className="text-dark-dim">accepted items · audits</div>
                          <div className="text-dark-text">
                            {profile.acceptedItems != null ? num(profile.acceptedItems) : "hidden"}
                            {" · "}
                            {profile.audits != null ? num(profile.audits) : "hidden"}
                          </div>
                        </div>
                        <div>
                          <div className="text-dark-dim">datasets contributed</div>
                          <div className="text-dark-text">
                            {profile.datasetsContributed != null ? num(profile.datasetsContributed) : "hidden"}
                          </div>
                        </div>
                        {profile.badges && profile.badges.length > 0 && (
                          <div className="sm:col-span-2 lg:col-span-4">
                            <div className="text-dark-dim">badges</div>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {profile.badges.map((b) => (
                                <span key={b.id} className="rounded-full border border-dark-line-soft px-2 py-0.5 text-[10px] text-dark-soft">
                                  {b.label}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </ATd>
                </tr>
              )}
            </React.Fragment>
          ))
        )}
      </AdminTable>
      {!loading && rows.length === 0 && <AdminEmptyState message="No contributors match this filter." />}

      {nextCursor && (
        <div className="flex justify-center">
          <AdminButton variant="ghost" disabled={loadingMore} onClick={() => void load(nextCursor, true)}>
            {loadingMore ? "loading…" : "load more"}
          </AdminButton>
        </div>
      )}
    </div>
  );
}
