"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";

/**
 * Live countdown to a server-issued expiry instant.
 */
export interface ExpiryCountdown {
  /** Milliseconds left, clamped at 0. Null when there is nothing to count. */
  msRemaining: number | null;
  /** True once the deadline has passed. False when `expiresAt` is absent. */
  expired: boolean;
  /** Relative label, e.g. "9m 04s" or "48s". Null when nothing to count. */
  remainingLabel: string | null;
  /** Absolute local time with timezone, so it reads unambiguously. */
  absoluteLabel: string | null;
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatAbsolute(expiresAtMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).format(new Date(expiresAtMs));
  } catch {
    return new Date(expiresAtMs).toISOString();
  }
}

export function useExpiryCountdown(
  expiresAt: string | null | undefined,
  serverNowMs?: number | null,
): ExpiryCountdown {
  const expiresAtMs = useMemo(() => {
    if (!expiresAt) return null;
    const parsed = new Date(expiresAt).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }, [expiresAt]);

  const [measured, setMeasured] = useState<number | null>(null);

  useEffect(() => {
    if (expiresAtMs === null) return;
    const now = typeof serverNowMs === "number" && Number.isFinite(serverNowMs) ? serverNowMs : Date.now();
    const anchor = { remaining: expiresAtMs - now, mono: performance.now() };

    const read = () => Math.max(0, anchor.remaining - (performance.now() - anchor.mono));

    let interval = 0;
    const pump = () => {
      const next = read();
      setMeasured(next);
      if (next <= 0 && interval) window.clearInterval(interval);
    };

    const kick = window.setTimeout(pump, 0);
    interval = window.setInterval(pump, 1000);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(interval);
    };
  }, [expiresAtMs, serverNowMs]);

  const msRemaining = expiresAtMs === null ? null : measured;

  return {
    msRemaining,
    expired: expiresAtMs !== null && msRemaining !== null && msRemaining <= 0,
    remainingLabel: msRemaining === null ? null : formatRemaining(msRemaining),
    absoluteLabel: expiresAtMs === null ? null : formatAbsolute(expiresAtMs),
  };
}

export function serverNowFromResponse(response: Response): number | null {
  const header = response.headers.get("date");
  if (!header) return null;
  const parsed = new Date(header).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseServerTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
