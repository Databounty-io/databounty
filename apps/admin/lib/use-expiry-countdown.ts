"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";

/**
 * Live countdown to a server-issued expiry instant.
 *
 * Deliberately generic — it knows nothing about MCP, OAuth, or any page. Any
 * surface with a server-side TTL can use it (MCP authorization requests,
 * artifact upload slots, invite and password-reset tokens). Give it the ISO
 * timestamp the API sent and, when available, the server's own clock reading.
 *
 * Two properties matter and neither is free:
 *
 * 1. **Wall-clock immunity.** Ticking with `Date.now()` means a user (or an
 *    NTP correction, or a DST jump) changing the machine clock mid-countdown
 *    makes the timer leap or freeze. So we measure elapsed time with
 *    `performance.now()`, a monotonic source that is unaffected by clock
 *    changes, and only consult wall time once to establish the anchor.
 *
 * 2. **Skew correction.** If the device clock is simply wrong — minutes or
 *    hours off — a countdown computed from local time is wrong from the first
 *    frame. `serverNowMs` (read from the response's `Date` header) removes
 *    that: remaining time is measured against the clock that will actually
 *    enforce the deadline. Without it we fall back to local time and can only
 *    be as right as the device is.
 *
 * The server remains the sole authority either way — this drives presentation
 * and lets the UI disable an action before a doomed request, never the
 * decision itself. A skewed client can show a wrong number but cannot act
 * past the real deadline.
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

/** "9m 04s" / "48s" — seconds are zero-padded only when minutes are shown, so
 *  the string does not change width every tick and jitter the layout. */
function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Local time plus a timezone name. A bare "14:53:23" is ambiguous the moment
 *  two people in different zones compare notes on the same request. */
function formatAbsolute(expiresAtMs: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).format(new Date(expiresAtMs));
  } catch {
    // Intl options can throw on very old engines; an ISO string is still
    // truthful, just less friendly.
    return new Date(expiresAtMs).toISOString();
  }
}

export function useExpiryCountdown(
  expiresAt: string | null | undefined,
  serverNowMs?: number | null,
): ExpiryCountdown {
  // Parse once. An unparseable timestamp must not render "NaN" — treat it as
  // nothing to count and let the caller fall back.
  const expiresAtMs = useMemo(() => {
    if (!expiresAt) return null;
    const parsed = new Date(expiresAt).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }, [expiresAt]);

  // `Date.now()` and `performance.now()` are impure, so they may not be read
  // during render (react-hooks/purity, enforced in this repo). Every clock
  // read therefore lives inside the effect or a timer callback.
  const [measured, setMeasured] = useState<number | null>(null);

  useEffect(() => {
    if (expiresAtMs === null) return;
    const now = typeof serverNowMs === "number" && Number.isFinite(serverNowMs) ? serverNowMs : Date.now();
    const anchor = { remaining: expiresAtMs - now, mono: performance.now() };

    // Re-derived from the anchor on every read rather than decremented, so a
    // tick that fired late — throttled background tab, machine asleep — self
    // corrects instead of accumulating error.
    const read = () => Math.max(0, anchor.remaining - (performance.now() - anchor.mono));

    let interval = 0;
    const pump = () => {
      const next = read();
      setMeasured(next);
      // Stop at zero: a countdown still firing on a dead deadline is pure
      // battery cost.
      if (next <= 0 && interval) window.clearInterval(interval);
    };

    // First measurement runs from a callback, not the effect body — the same
    // purity rule forbids seeding state synchronously here.
    const kick = window.setTimeout(pump, 0);
    interval = window.setInterval(pump, 1000);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(interval);
    };
  }, [expiresAtMs, serverNowMs]);

  // Gate the stored measurement on the current deadline so a cleared
  // `expiresAt` reports "nothing to count" immediately, without waiting for a
  // tick and without writing state from the effect body.
  const msRemaining = expiresAtMs === null ? null : measured;

  return {
    msRemaining,
    expired: expiresAtMs !== null && msRemaining !== null && msRemaining <= 0,
    remainingLabel: msRemaining === null ? null : formatRemaining(msRemaining),
    absoluteLabel: expiresAtMs === null ? null : formatAbsolute(expiresAtMs),
  };
}

/** Server clock reading from a fetch Response, for `serverNowMs` above.
 *  Returns null when the header is absent or unparseable so the caller
 *  degrades to local time rather than to NaN. */
export function serverNowFromResponse(response: Response): number | null {
  const header = response.headers.get("date");
  if (!header) return null;
  const parsed = new Date(header).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a server-supplied ISO clock reading (e.g. an API's `serverTime`) for
 *  `serverNowMs`. Prefer this over {@link serverNowFromResponse}: the `Date`
 *  response header is not CORS-safelisted, so a cross-origin caller cannot
 *  read it unless the server explicitly exposes it. Returns null on anything
 *  unparseable so the caller degrades to local time rather than to NaN. */
export function parseServerTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
