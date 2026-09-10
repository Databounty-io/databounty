"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";

export function useArtifactStatusPolling(
  hasScanningArtifact: boolean,
  refresh: () => void | Promise<void>
) {
  const refreshRef = useRef(refresh);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!hasScanningArtifact) return;

    let cancelled = false;
    let delayMs = 2_500;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (nextDelayMs: number) => {
      if (cancelled || document.visibilityState === "hidden") return;
      timer = setTimeout(async () => {
        timer = null;
        if (cancelled || document.visibilityState !== "visible") return;
        await Promise.resolve(refreshRef.current()).catch(() => {});
        if (cancelled || document.visibilityState !== "visible") return;
        delayMs = Math.min(delayMs * 2, 10_000);
        schedule(delayMs);
      }, nextDelayMs);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || timer) return;
      schedule(0);
    };

    schedule(delayMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasScanningArtifact]);
}
