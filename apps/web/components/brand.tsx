// SPDX-License-Identifier: Apache-2.0

import Image from "next/image";
import { LANDING_URL } from "@/lib/urls";

const WORDMARK_ASPECT = 483 / 60;

/** The official DataBounty data-cylinder mark. */
export function Brandmark({
  size = 26,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src="/brand/logo-icon.svg"
      alt=""
      aria-hidden
      width={size}
      height={size}
      unoptimized
      className={`inline-block shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** Official DATA/BOUNTY wordmark for light or dark application chrome. */
export function Wordmark({
  light = false,
  size = "md",
}: {
  light?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const height = size === "sm" ? 15 : size === "lg" ? 24 : 20;
  const width = Math.round(height * WORDMARK_ASPECT);
  return (
    <Image
      src={light ? "/brand/logotype-light.svg" : "/brand/logotype-dark.svg"}
      alt="DATA/BOUNTY"
      width={width}
      height={height}
      unoptimized
      className="inline-block w-auto select-none"
      style={{ height }}
    />
  );
}

/** Brand lockup linking back to the public site. */
export function Logo({
  light = false,
  size = "md",
  className = "",
}: {
  light?: boolean;
  size?: "sm" | "md" | "lg";
  /** Extra classes on the anchor. The mobile shell passes `TOUCH_TARGET`
   * here: the lockup is only 26px tall, so the link itself misses the 44x44
   * touch minimum even though it is 198px wide. Left off the desktop sidebar
   * deliberately — pointer targets are not size-constrained there, and the
   * collapse control sits close by. */
  className?: string;
}) {
  const brandmarkSize = size === "lg" ? 38 : size === "sm" ? 20 : 26;
  const gap = size === "lg" ? "gap-3" : size === "sm" ? "gap-2" : "gap-[11px]";
  return (
    <a href={LANDING_URL} className={`flex items-center ${gap} ${className}`}>
      <Brandmark size={brandmarkSize} />
      <Wordmark light={light} size={size} />
    </a>
  );
}
