// SPDX-License-Identifier: Apache-2.0

/**
 * The three states community karma can be in, mirroring
 * api/src/services/karma-holds.ts.
 */

export type KarmaHoldReason = "dispute_window_open" | "awaiting_publication" | "publication_failed";
export type KarmaHoldRole = "contributor" | "validator" | "sponsor";

export interface KarmaHold {
  bountyId: string;
  bountyTitle: string;
  bountyKind?: string;
  role: KarmaHoldRole;
  amount: number;
  awardCount: number;
  reason: KarmaHoldReason;
  disputeWindowHours: number | null;
  windowClosesAt: string | null;
  publicationStatus: string;
  explanation: string;
}

export interface KarmaReleaseRule {
  summary: string;
  gates: string[];
  securedRelease?: string;
  defaultDisputeWindowHours: number;
  projectionCaveat: string;
}

export function securedReleaseText(rule: KarmaReleaseRule | null | undefined): string {
  return (
    rule?.securedRelease ??
    rule?.gates?.[2] ??
    "It lands once the sponsor's window to raise a problem has closed and that dataset is published. Nothing is needed from you."
  );
}

export interface KarmaHoldsByRole {
  contributor: { pending: number; awardCount: number };
  validator: { pending: number; awardCount: number };
  sponsor: { pending: number; awardCount: number };
}

export const HOLD_REASON_LABEL: Record<KarmaHoldReason, string> = {
  dispute_window_open: "dispute window open",
  awaiting_publication: "awaiting publication",
  publication_failed: "publication failed",
};

export const HOLD_REASON_TONE: Record<KarmaHoldReason, "info" | "warning"> = {
  dispute_window_open: "info",
  awaiting_publication: "info",
  publication_failed: "warning",
};

export const ROLE_LABEL: Record<KarmaHoldRole, string> = {
  contributor: "contributing",
  validator: "validating",
  sponsor: "sponsoring",
};

export function windowCountdown(windowClosesAt: string | null): string | null {
  if (!windowClosesAt) return null;
  const ms = new Date(windowClosesAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = ms / 3_600_000;
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `in ${Math.round(hours)}h`;
  return `in ${Math.round(hours / 24)}d`;
}
