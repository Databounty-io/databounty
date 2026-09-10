"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { adminAuthedFetch } from "@/lib/admin-auth";

/* One place for "fetch an admin JSON resource and keep it live." This hook
 * refetches on window focus, tab visibility, and a light poll, and hands back
 * refresh() for post-action refetch — so every admin surface stays current
 * without duplicating boilerplate on each page. */

interface UseAdminResourceOptions {
  /** Background poll interval in ms. Defaults to 30s; pass 0 to disable. */
  pollMs?: number;
  /** Error text surfaced when the fetch fails or returns non-OK. */
  errorMessage?: string;
  /** Skip network activity until the caller has a complete resource path. */
  enabled?: boolean;
}

export function useAdminResource<T>(
  path: string,
  { pollMs = 30_000, errorMessage = "Data is unavailable.", enabled = true }: UseAdminResourceOptions = {}
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    // Focus and visibilitychange commonly arrive as a pair. Reuse the active
    // refresh for this hook instead of issuing an identical second request.
    if (inFlight.current) return inFlight.current;
    const request = (async () => {
      try {
        const r = await adminAuthedFetch(path);
        if (!r.ok) throw new Error(errorMessage);
        setData((await r.json()) as T);
        setError("");
      } catch {
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    })();
    inFlight.current = request;
    void request.finally(() => {
      if (inFlight.current === request) inFlight.current = null;
    });
    return request;
  }, [path, errorMessage]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();

    const onFocus = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    const timer =
      pollMs > 0
        ? setInterval(() => {
            if (document.visibilityState === "visible") void refresh();
          }, pollMs)
        : null;

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearInterval(timer);
    };
  }, [refresh, pollMs, enabled]);

  return { data, loading, error, refresh };
}
