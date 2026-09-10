// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { InfoTip } from "@/components/ui";
import { explainSubmissionOverage, submissionsHref, type FunnelBucket } from "@/lib/submission-funnel";

export interface FunnelCountsProps {
  bountyId: string;
  totalSubmitted: number;
  inPipeline: number;
  needsFixes: number;
  rejected: number;
  holdingPlace?: number;
  targetItems?: number;
  size?: "sm" | "md";
  liftAboveOverlay?: boolean;
  className?: string;
}

export function FunnelCounts({
  bountyId,
  totalSubmitted,
  inPipeline,
  needsFixes,
  rejected,
  holdingPlace,
  targetItems,
  size = "md",
  liftAboveOverlay = false,
  className = "",
}: FunnelCountsProps) {
  if (totalSubmitted <= 0) return null;
  const overage =
    holdingPlace != null && targetItems != null
      ? explainSubmissionOverage({ totalSubmitted, holdingPlace, needsFixes, rejected, targetItems })
      : null;
  const cells: { label: string; filter: FunnelBucket | "all"; value: number; action?: boolean }[] = [
    { label: "submitted", filter: "all", value: totalSubmitted },
    { label: "in pipeline", filter: "in_pipeline", value: inPipeline },
    { label: "needs fixes", filter: "needs_fixes", value: needsFixes, action: true },
    { label: "rejected", filter: "rejected", value: rejected, action: true },
  ];
  const text = size === "sm" ? "text-[10px]" : "text-[11px]";

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 font-mono ${text} text-ink-soft ${
        liftAboveOverlay ? "pointer-events-auto relative z-30" : ""
      } ${className}`}
    >
      {cells.map((cell) => (
        <span key={cell.label} className="inline-flex items-center">
          <Link
            href={submissionsHref(bountyId, cell.filter)}
            className="group/funnel inline-flex items-baseline gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
            aria-label={`Show the ${cell.label} items`}
            title={`Show the ${cell.label} items`}
          >
            <span className="text-ink-soft group-hover/funnel:text-ink">{cell.label}</span>
            <span
              className={`font-bold underline decoration-dotted decoration-from-font underline-offset-[3px] group-hover/funnel:decoration-solid ${
                cell.action && cell.value > 0 ? "text-[#9a5b12]" : "text-ink"
              }`}
            >
              {cell.value.toLocaleString()}
            </span>
          </Link>
          {cell.label === "submitted" && overage && (
            <span className="ml-1 inline-flex align-middle">
              <InfoTip label="why more items were submitted than the program's size" text={overage.sentence} />
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
