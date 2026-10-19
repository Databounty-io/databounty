// SPDX-License-Identifier: Apache-2.0

import type { Badge } from "@prisma/client";

/**
 * Turning a catalog label into the text a person reads.
 *
 * Admins write labels with a `{value}` token ("{value} items accepted"), and the
 * token must never reach a browser: a member's own badges, their public profile
 * and the "all possible badges" list all render through here. The admin console
 * is the one place the raw template belongs, because that is where it is edited.
 *
 * Kept free of database and notification imports so a route can render a label
 * without loading the badge evaluator.
 */

type LabelledBadge = Pick<Badge, "label" | "metric" | "threshold">;

/** Substitutes the measured amount into a catalog label. Admins write labels
 *  like "{value} accepted items"; a label without the token renders verbatim. */
export function renderLabel(label: string, measured: number | null | undefined): string {
  if (measured === null || measured === undefined) return label;
  return label.replaceAll("{value}", measured.toLocaleString("en-US"));
}

/** The amount a badge certifies when nothing was measured for a particular
 *  member: its threshold, which is what the criteria text beside it states. A
 *  manual badge has no metric, so it certifies no amount. */
function certifiedValue(badge: LabelledBadge): number | null {
  return badge.metric === "manual" ? null : badge.threshold;
}

/** Drops a token that nothing could fill (a manual badge granted without a
 *  value) instead of showing it, and tidies the spacing it leaves behind. */
function withoutUnfilledToken(label: string): string {
  return label.includes("{value}") ? label.replaceAll("{value}", "").replace(/\s{2,}/g, " ").trim() : label;
}

/** One member's badge. `{value}` is the amount measured when it was awarded,
 *  or, for an award recorded without one (a manual grant, or a row older than
 *  the measured_value column), the threshold the badge certifies. */
export function awardLabel(badge: LabelledBadge, measuredValue: number | null | undefined): string {
  return withoutUnfilledToken(renderLabel(badge.label, measuredValue ?? certifiedValue(badge)));
}

/** A catalog entry that nobody in particular holds, as in the karma page's
 *  "view all possible badges": `{value}` is the threshold, matching the
 *  criteria text shown under it. */
export function catalogLabel(badge: LabelledBadge): string {
  return withoutUnfilledToken(renderLabel(badge.label, certifiedValue(badge)));
}
