// SPDX-License-Identifier: Apache-2.0

export const FUNNEL_BUCKETS = ["in_pipeline", "needs_fixes", "rejected", "accepted"] as const;
export type FunnelBucket = (typeof FUNNEL_BUCKETS)[number];

export const FUNNEL_BUCKET_LABELS: Record<FunnelBucket, string> = {
  in_pipeline: "In pipeline (all)",
  needs_fixes: "Needs fixes (all)",
  rejected: "Rejected",
  accepted: "Accepted",
};

export function isFunnelBucket(value: string | null | undefined): value is FunnelBucket {
  return value != null && (FUNNEL_BUCKETS as readonly string[]).includes(value);
}

export function submissionsHref(bountyId: string, filter: FunnelBucket | "all"): string {
  const query = new URLSearchParams({ section: "submissions" });
  if (filter !== "all") query.set("status", filter);
  return `/sponsor/${bountyId}?${query.toString()}`;
}

export function explainSubmissionOverage(input: {
  totalSubmitted: number;
  holdingPlace: number;
  needsFixes: number;
  rejected: number;
  targetItems: number;
}): { overage: number; notCounted: number; reconciles: boolean; sentence: string } | null {
  const notCounted = input.needsFixes + input.rejected;
  const overage = input.totalSubmitted - input.targetItems;
  if (input.targetItems <= 0 || overage <= 0) return null;
  const reconciles = input.holdingPlace + notCounted === input.totalSubmitted;
  const parts = [
    input.needsFixes > 0 ? `${input.needsFixes.toLocaleString()} sent back for fixes` : null,
    input.rejected > 0 ? `${input.rejected.toLocaleString()} rejected` : null,
  ].filter(Boolean);
  return {
    overage,
    notCounted,
    reconciles,
    sentence:
      `${input.totalSubmitted.toLocaleString()} items were submitted for ${input.targetItems.toLocaleString()} places because ` +
      `only work that passes takes one${parts.length ? ` — ${parts.join(" and ")} occupy nothing` : ""}. ` +
      (reconciles
        ? `${input.holdingPlace.toLocaleString()} hold a place and ${notCounted.toLocaleString()} do not count toward the target.`
        : `The rest do not count toward the target.`),
  };
}
