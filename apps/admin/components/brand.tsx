// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @next/next/no-img-element */

/** The official DataBounty data-cylinder mark. */
export function Brandmark({
  size = 26,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src="/brand/logo-icon.svg"
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={`inline-block shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** Official DATA/BOUNTY wordmark for the dark admin console chrome. */
export function Wordmark({
  size = "md",
}: {
  light?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const height = size === "sm" ? 15 : size === "lg" ? 24 : 20;
  // Intrinsic SVG is 483x60 (aspect ratio ~8.05) — pass an explicit width
  // derived from that ratio (not just height) so the browser can reserve
  // the right box before the SVG loads and avoid a layout shift.
  const width = Math.round(height * (483 / 60));
  return (
    <img
      src="/brand/logotype-dark.svg"
      alt="DATA/BOUNTY"
      width={width}
      height={height}
      className="inline-block w-auto select-none"
      style={{ height }}
    />
  );
}
