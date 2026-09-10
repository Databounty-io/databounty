"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";

/**
 * Headless live-update for the member app.
 *
 * Owner instruction 2026-09-07: the visible control — the "Refresh" button and
 * the "Off / 15s / … / 2m" interval picker — is gone; the behaviour stays,
 * fixed at 2 minutes, with no per-user setting. This mirrors the treatment
 * already shipped for the landing app on 2026-09-06 (CHANGELOG v1.92).
 *
 * The earlier per-page `localStorage` choice (`databounty.autorefresh.v1:*`)
 * is deliberately ignored, and `refreshStorageKey` /
 * `LEADERBOARD_REFRESH_OPTIONS` / `DEFAULT_AUTO_REFRESH_OPTIONS` are no longer
 * exported: a member who once picked "Off" must not be left without live
 * updates now that there is no control to turn them back on.
 *
 * Unlike the landing app, these are CLIENT-side data pages — every screen
 * loads through `useEffect` + `authedFetch`, so `router.refresh()` would
 * re-run a server tree that fetches nothing and the page would silently stop
 * updating. Each call site therefore keeps the refetch it already had and this
 * component only drives it on the timer.
 *
 * Pauses while the tab is hidden and catches up once on return, so a
 * backgrounded tab does not hammer the API and a returning member sees fresh
 * data immediately. A tick is skipped while `refreshing` is true so a slow
 * refetch cannot overlap itself.
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
  /** Pages switch polling off for terminal/settled records. */
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
