"use client";
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The ONE debounce delay for every list search box in this app. It was
 * duplicated as a literal `300` in five pages (and named only in
 * `app/(app)/issues`), so two of them simply never got one — the validator
 * workspace fired a request per keystroke against `/v1/me/audits` and
 * `/v1/me/validator-dashboard`. Keep the constant here and there is one number
 * to change.
 */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Trailing-edge debounce of a value that becomes a server query.
 *
 * The raw value stays in the caller's own `useState`, so the input never lags
 * behind typing; only the returned value settles, and only the returned value
 * belongs in a fetch dependency list. Strings are trimmed, because a trailing
 * space is not a different query and re-fetching for one is pure waste.
 */
function normalize<T>(value: T): T {
  return typeof value === "string" ? (value.trim() as unknown as T) : value;
}

export function useDebouncedValue<T>(value: T, delay: number = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState<T>(() => normalize(value));

  useEffect(() => {
    const next = normalize(value);
    // Nothing to wait for when the normalized value already matches — this
    // also stops a re-render caused by an unrelated state change from
    // restarting the timer and delaying a query that was ready to go.
    if (next === settled) return;
    // Clearing settles on the next tick instead of waiting out the delay.
    // Emptying a search box is a deliberate single action — the field's own
    // clear control, or a "Clear filters" button — never a keystroke stream,
    // so there is nothing to coalesce, and holding the unfiltered list back by
    // 300ms only makes the page feel broken. It also stops a Clear-filters
    // control that resets several axes at once from firing two requests, one
    // per settling delay. Scheduled rather than set synchronously: a bare
    // setState in an effect body is a cascading render (and the lint rule that
    // says so is right).
    const timer = setTimeout(() => setSettled(next), next === "" ? 0 : delay);
    return () => clearTimeout(timer);
    // `settled` is read as a comparison guard only; adding it as a dependency
    // is intentional and cannot loop, because the effect only ever sets it to
    // a value that then makes the guard return early.
  }, [value, settled, delay]);

  return settled;
}

/**
 * Guards a list against an out-of-order response.
 *
 * Every one of these pages fires a fresh request on each filter, search or
 * page change and assigns whatever comes back. Without a sequence check a slow
 * early response can land AFTER a newer one and repaint the list with results
 * for a query the reader has already typed past — the list then contradicts
 * the controls above it, which is worse than being slow. An `AbortController`
 * would cancel the socket but not the assignment, and several of these calls
 * go through helpers that take no signal; this guards the assignment, which is
 * the part that is actually wrong.
 *
 * Usage: `const settled = useLatestRequest();` then at the top of the fetch
 * `const isStale = settled();` and before EVERY `setState` `if (isStale())
 * return;` — including the ones in `catch` and `finally`, or a stale failure
 * will clear a good list.
 */
export function useLatestRequest(): () => () => boolean {
  const seq = useRef(0);
  return useCallback(() => {
    const mine = ++seq.current;
    return () => mine !== seq.current;
  }, []);
}
