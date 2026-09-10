"use client";

// SPDX-License-Identifier: Apache-2.0

import { Icon } from "./icons";
import type { ExpiryCountdown as Countdown } from "@/lib/use-expiry-countdown";

export function ExpiryCountdownLine({
  countdown,
  prefix = "Expires in",
  expiredLabel = "Expired",
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
