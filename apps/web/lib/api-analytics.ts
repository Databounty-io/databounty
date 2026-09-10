// SPDX-License-Identifier: Apache-2.0

/**
 * Typed client for GET /v1/me/analytics — the weekly activity series behind
 * the contributor and validator workspace charts.
 *
 * Every field is a count or a sum of the member's own rows. There is no
 * client-side derivation here beyond picking a maximum for the y-scale: if a
 * number is not in this payload, the chart does not draw it.
 */
import { authedFetch } from "@/lib/store";
import { API } from "@/lib/api-endpoints";

export interface SubmissionWeek {
  weekStart: string;
  submitted: number;
  accepted: number;
  rejected: number;
  needsFixes: number;
  inReview: number;
}

export interface KarmaWeek {
  weekStart: string;
  karma: number;
  events: number;
}

export interface AuditWeek {
  weekStart: string;
  audited: number;
  flagged: number;
  flagsConfirmed: number;
  flagsDismissed: number;
  flagsPending: number;
}

export interface MemberAnalytics {
  range: {
    weeks: number;
    from: string;
    to: string;
    bucket: "week";
    weekStartsOn: "monday";
    timezone: "UTC";
  };
  contributor: {
    submissions: SubmissionWeek[];
    karma: KarmaWeek[];
    totals: {
      submitted: number;
      accepted: number;
      rejected: number;
      needsFixes: number;
      inReview: number;
      karma: number;
    };
  };
  validator: {
    audits: AuditWeek[];
    totals: {
      audited: number;
      flagged: number;
      flagsConfirmed: number;
      flagsDismissed: number;
      flagsPending: number;
    };
  };
  /** Caveats the numbers cannot carry themselves. Rendered, never dropped. */
  notes: { field: string; note: string }[];
}

/** Windows the range selector offers. The server accepts 4–52. */
export const ANALYTICS_WINDOWS = [8, 12, 26, 52] as const;
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];
export const DEFAULT_ANALYTICS_WINDOW: AnalyticsWindow = 12;

export async function getMemberAnalytics(
  window: number | { from: string; to: string },
): Promise<MemberAnalytics> {
  const res = await authedFetch(API.me.analytics(window));
  if (!res.ok) throw new Error(`Analytics request failed (${res.status})`);
  return (await res.json()) as MemberAnalytics;
}
