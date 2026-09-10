// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @next/next/no-img-element */
/**
 * DataBounty brand assets — vector marks:
 *  - logo-icon.svg      lime circle + black data-cylinder glyph
 *  - logotype-dark.svg  DATA/BOUNTY letterforms (white, lime slash)
 */

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

/**
 * DATA/BOUNTY logotype. White letterforms with the lime slash — vector SVG asset.
 */
export function Wordmark({
  size = "md",
}: {
  light?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const h = size === "sm" ? 15 : size === "lg" ? 24 : 20;
  return (
    <img
      src="/brand/logotype-dark.svg"
      alt="DATA/BOUNTY"
      height={h}
      className="inline-block w-auto select-none"
      style={{ height: h }}
    />
  );
}
