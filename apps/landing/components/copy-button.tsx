"use client";

// SPDX-License-Identifier: Apache-2.0

import React from "react";
import { Icon } from "./icons";

/**
 * Copy-to-clipboard button for the dark public surfaces.
 */
export function CopyButton({
  value,
  label,
  className = "",
}: {
  value: string;
  /** What is being copied, for the accessible name: "Copy MCP endpoint". */
  label: string;
  className?: string;
}) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        ok = true;
      }
    } catch {
      ok = false;
    }
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  };

  const copied = state === "copied";
  const failed = state === "failed";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? "copied" : failed ? "copy failed" : `Copy ${label}`}
      className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] border px-2 py-1.5 font-mono text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime ${
        copied
          ? "border-lime bg-lime/10 text-lime"
          : failed
            ? "border-red-400 bg-red-500/10 text-red-300"
            : "border-dark-line-strong bg-dark-card text-dark-soft hover:border-lime hover:text-lime"
      } ${className}`}
    >
      <Icon name={copied ? "check" : "copy"} size={11} />
      <span aria-hidden>{copied ? "copied" : failed ? "failed" : "copy"}</span>
    </button>
  );
}
