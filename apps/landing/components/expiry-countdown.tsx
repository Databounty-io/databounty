"use client";

// SPDX-License-Identifier: Apache-2.0

import { Icon } from "./icons";
import type { ExpiryCountdown as Countdown } from "@/lib/use-expiry-countdown";

/**
 * Renders a live "expires in …" line for any server-issued deadline.
 *
 * Pair it with `useExpiryCountdown` (lib/use-expiry-countdown.ts):
 *
 *   const expiry = useExpiryCountdown(request.expiresAt, serverNow);
 *   …
 *   <ExpiryCountdownLine countdown={expiry} />
 *   <Button disabled={expiry.expired}>Allow access</Button>
 *
 * The hook result is passed IN rather than computed here on purpose. Callers
 * almost always need `expired` themselves — to disable the action the deadline
 * governs — and calling the hook in both places would run two intervals over
 * one deadline. One hook call, one timer, both consumers.
 *
 * Colour comes from the surrounding `className` (light dashboard, dark landing
 * page) rather than being baked in, so the same component works in every app.
 *
 * Accessibility: the value changes every second, which makes a live region
 * unusable — a screen reader would interrupt itself continuously. The ticking
 * text is therefore `aria-hidden` and an equivalent absolute time is exposed
 * to assistive tech once, via `sr-only`.
 */
export function ExpiryCountdownLine({
  countdown,
  /** Copy before the value. "Expires in 9m 04s" by default. */
  prefix = "Expires in",
  /** Shown instead of the countdown once the deadline has passed. */
  expiredLabel = "Expired",
  /** Hide the absolute "· 15:00:19 GMT+5:30" suffix in tight layouts. It stays
   *  available to screen readers either way. */
  showAbsolute = true,
  showIcon = true,
  className = "",
}: {
  countdown: Countdown;
  prefix?: string;
  expiredLabel?: string;
  showAbsolute?: boolean;
  showIcon?: boolean;
  className?: string;
}) {
  return (
    <p className={`flex items-center gap-1.5 ${className}`}>
      {showIcon && <Icon name="clock" size={12} className="shrink-0" />}
      {countdown.expired ? (
        <span>{expiredLabel}</span>
      ) : (
        <>
          <span aria-hidden="true">
            {prefix} {countdown.remainingLabel ?? "—"}
          </span>
          <span className="sr-only">
            Expires at {countdown.absoluteLabel ?? "an unknown time"}
          </span>
          {showAbsolute && countdown.absoluteLabel && (
            <span aria-hidden="true" className="opacity-70">
              · {countdown.absoluteLabel}
            </span>
          )}
        </>
      )}
    </p>
  );
}
