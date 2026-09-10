"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";

/**
 * Headless live-update for the admin views.
 *
 * Owner instruction 2026-09-07: the visible control — the "Refresh" button and
 * the "Off / 15s / … / 4m" interval picker — is gone; the behaviour stays,
 * fixed at 2 minutes, with no per-user setting. Same treatment as the landing
 * app on 2026-09-06 (CHANGELOG v1.92) and the member app in this change.
 *
 * The earlier per-screen `localStorage` choice is deliberately ignored, and
 * `refreshStorageKey` / `LEADERBOARD_REFRESH_OPTIONS` /
 * `DEFAULT_AUTO_REFRESH_OPTIONS` are no longer exported: an operator who once
 * picked "Off" must not be left without live updates now that there is no
 * control to turn them back on.
 *
 * 120s also sits at or above the community read surface's 30s cache entry
 * (`COMMUNITY_CACHE_TTL_SEC`), so a tick can never promise freshness the cache
 * is unable to deliver — the reason the old leaderboard preset started at 30s.
 *
 * Admin screens read through `adminAuthedFetch` / `useAdminResource` from the
 * client, so `router.refresh()` would re-run a server tree that fetches
 * nothing. Each call site keeps its own refetch and this component only paces
 * it. A tick is skipped while `refreshing` is true so a slow refetch cannot
 * overlap itself, and polling pauses while the tab is hidden, catching up once
 * on return.
 */
export const DEFAULT_REFRESH_SECONDS = 120;

export function AutoRefreshControl({
  onRefresh,
  refreshing = false,
  enabled = true,
  defaultSeconds = DEFAULT_REFRESH_SECONDS,
}: {
  onRefresh: () => void | Promise<void>;
  /** A tick is skipped while a refetch is already in flight. */
  refreshing?: boolean;
  enabled?: boolean;
  defaultSeconds?: number;
}) {
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const refreshingRef = useRef(refreshing);
  useEffect(() => {
    refreshingRef.current = refreshing;
  }, [refreshing]);

  useEffect(() => {
    if (!enabled || defaultSeconds <= 0) return;
    const periodMs = defaultSeconds * 1000;
    let timer: number | undefined;
    let lastRefresh = Date.now();

    const refresh = () => {
      if (refreshingRef.current) return;
      lastRefresh = Date.now();
      void onRefreshRef.current();
    };

    const start = () => {
      if (timer !== undefined) return;
      timer = window.setInterval(refresh, periodMs);
    };
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      if (Date.now() - lastRefresh >= periodMs) refresh();
      start();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [enabled, defaultSeconds]);

  return null;
}
