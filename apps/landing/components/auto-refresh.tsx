"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Headless live-update for the public pages.
 *
 * Owner instruction 2026-09-06: the visible "auto-refresh: off / 30s / 1m / 2m"
 * control is gone; the behaviour stays, fixed at 2 minutes, with no per-user
 * setting. The earlier per-page localStorage choice is deliberately ignored —
 * a visitor who once picked "off" must not have live updates silently stay
 * off now that there is no control to turn them back on.
 *
 * Refreshing calls `router.refresh()`, which re-runs the whole server
 * component tree for the route. Every `lib/public-data` fetch is
 * `cache: "no-store"`, so a tick reloads ALL of the page's data — stats,
 * catalog, validation queue, pools, waitlist counts — not one section.
 *
 * Pauses while the tab is hidden and catches up once on return, so a
 * backgrounded tab does not hammer the API and a returning visitor sees
 * fresh numbers immediately.
 */
export const DEFAULT_REFRESH_SECONDS = 120;

export function AutoRefresh({
  defaultSeconds = DEFAULT_REFRESH_SECONDS,
}: {
  /** Kept for call-site compatibility; the interval is no longer per-source. */
  source?: string;
  defaultSeconds?: number;
} = {}) {
  const router = useRouter();

  useEffect(() => {
    if (defaultSeconds <= 0) return;
    const periodMs = defaultSeconds * 1000;
    let timer: number | undefined;
    let lastRefresh = Date.now();

    const refresh = () => {
      lastRefresh = Date.now();
      router.refresh();
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
  }, [defaultSeconds, router]);

  return null;
}
