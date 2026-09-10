"use client";

// SPDX-License-Identifier: Apache-2.0

import { scanStatusState } from "@/lib/api-artifacts";

const TONE: Record<"pending" | "ready" | "danger", string> = {
  pending: "text-amber-700",
  ready: "text-emerald-700",
  danger: "text-rose-700",
};

export function ArtifactScanStatus({
  status,
  scanStatus,
  className = "",
}: {
  status: string;
  /** The artifact's real scan verdict. Required for an honest line: `status`
   *  alone cannot tell a scanned file from an unscanned one, because
   *  `not_required` clears an artifact to `ready` exactly like `clean`. */
  scanStatus?: string | null;
  className?: string;
}) {
  const state = scanStatusState(status, scanStatus);
  return (
    <span role="status" aria-live="polite" className={`${className} ${state ? TONE[state.tone] : ""}`.trim()}>
      {state?.text ?? ""}
    </span>
  );
}
