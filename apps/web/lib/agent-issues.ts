// SPDX-License-Identifier: Apache-2.0

/**
 * Typed client + display helpers for the reporter's own support cases
 * (`/v1/issues`). One module knows these paths; pages consume the functions.
 *
 * Cases are filed by an agent over MCP (`report_issue`) or by the dashboard.
 * A case changes NOTHING about the account's work — no submission, audit,
 * or karma — and the copy here keeps saying so.
 */
import { apiClient } from "@/lib/api-client";
import { API, withQuery } from "@/lib/api-endpoints";
import { authedFetch } from "@/lib/store";
import type { PillTone } from "@/components/ui";

// Fastify's built-in 404 handler writes messages of the exact shape
// "Route POST:/v1/foo/bar not found" whenever a route genuinely doesn't
// exist server-side — a routing implementation detail, never something a
// real handler would phrase that way. Trusting it blindly meant a missing
// backend route displayed that raw string instead of a friendly fallback.
const FASTIFY_ROUTE_NOT_FOUND = /^Route (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):.* not found$/;
function safeMessage(message: string | undefined, fallback: string): string {
  if (!message || FASTIFY_ROUTE_NOT_FOUND.test(message)) return fallback;
  return message;
}

export type IssueStatus =
  | "received"
  | "triaged"
  | "investigating"
  | "needs_info"
  | "duplicate"
  | "not_reproducible"
  | "resolved"
  | "rejected";

export type IssueCategory =
  | "contract"
  | "validation"
  | "mcp"
  | "upload_processing"
  | "data_quality"
  | "security_privacy"
  | "abuse"
  | "other";

export type IssueImpact = "blocked" | "degraded" | "suggestion";

export type ContextCollection = "pending" | "complete" | "partial" | "unavailable";

export interface IssueResource {
  kind: string;
  id: string;
  status?: string | null;
  [key: string]: unknown;
}

export interface IssueListRow {
  id: string;
  status: IssueStatus;
  category: IssueCategory;
  impact: IssueImpact;
  summary: string;
  canonicalIssueId: string | null;
  contextCollection: ContextCollection;
  createdAt: string;
  updatedAt: string;
  alsoReportedBy: number;
  resources: IssueResource[];
  guidance: string;
}

export interface IssueTimelineEvent {
  id: string;
  type: string;
  body: string | null;
  actorRole: string;
  createdAt: string;
}

export interface MergedOutcome {
  status: IssueStatus;
  resolutionNote: string | null;
  resolutionRef: string | null;
  resolvedAt: string | null;
}

export interface IssueDetail extends IssueListRow {
  expected: string;
  actual: string;
  steps: string | null;
  resolutionNote: string | null;
  resolutionRef: string | null;
  resolvedAt: string | null;
  mergedOutcome: MergedOutcome | null;
  version: number;
  unresolvedIds: string[];
  events: IssueTimelineEvent[];
}

export interface IssueListPage {
  items: IssueListRow[];
  nextCursor: string | null;
  hasMore: boolean;
  issueCount: number;
}

export interface IssueListFilters {
  status?: IssueStatus | "";
  q?: string;
  since?: string;
  until?: string;
}

function endOfDayExclusive(day: string): string {
  const start = new Date(`${day}T00:00:00.000Z`);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

/* ---------------- reads ---------------- */

export function fetchMyIssues(opts: { cursor?: string | null } & IssueListFilters = {}) {
  const q = opts.q?.trim();
  return apiClient.get<IssueListPage>(
    withQuery(API.issues.list, {
      limit: 20,
      cursor: opts.cursor ?? undefined,
      status: opts.status || undefined,
      q: q && q.length >= 2 ? q : undefined,
      since: opts.since ? new Date(`${opts.since}T00:00:00.000Z`).toISOString() : undefined,
      until: opts.until ? endOfDayExclusive(opts.until) : undefined,
    }),
  );
}

export function fetchMyIssue(id: string) {
  return apiClient.get<IssueDetail>(API.issues.one(id));
}

/* ---------------- writes ---------------- */

export type ReplyResult =
  | { ok: true; status: IssueStatus; guidance: string }
  | { ok: false; error: string; closed: boolean };

export async function replyToIssue(id: string, body: string): Promise<ReplyResult> {
  const res = await authedFetch(API.issues.replies(id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (res.ok) {
    const data = (await res.json()) as { status: IssueStatus; guidance: string };
    return { ok: true, status: data.status, guidance: data.guidance };
  }
  const payload = (await res.json().catch(() => ({}))) as { message?: string };
  const fallback =
    res.status === 409
      ? "This case is closed. File a new report and reference this one."
      : res.status === 403
        ? "Verify your email address before replying to a case."
        : res.status === 429
          ? "Too many replies in a short window. Wait a moment and try again."
          : res.status === 404
            ? "This case no longer exists."
            : "Could not send your reply.";
  return { ok: false, error: safeMessage(payload.message, fallback), closed: res.status === 409 };
}

/* ---------------- display helpers ---------------- */

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  received: "Received",
  triaged: "Triaged",
  investigating: "Investigating",
  needs_info: "Needs your answer",
  duplicate: "Merged duplicate",
  not_reproducible: "Not reproducible",
  resolved: "Resolved",
  rejected: "Closed",
};

export const ISSUE_CATEGORY_LABELS: Record<IssueCategory, string> = {
  contract: "Contract",
  validation: "Validation",
  mcp: "MCP",
  upload_processing: "Upload processing",
  data_quality: "Data quality",
  security_privacy: "Security / privacy",
  abuse: "Abuse",
  other: "Other",
};

export const ISSUE_IMPACT_LABELS: Record<IssueImpact, string> = {
  blocked: "Blocked",
  degraded: "Degraded",
  suggestion: "Suggestion",
};

export function issueStatusTone(status: IssueStatus): PillTone {
  switch (status) {
    case "received":
      return "info";
    case "triaged":
    case "investigating":
      return "violet";
    case "needs_info":
      return "warning";
    case "resolved":
      return "success";
    case "rejected":
    case "not_reproducible":
      return "danger";
    case "duplicate":
      return "neutral";
  }
}

export function issueImpactTone(impact: IssueImpact): PillTone {
  return impact === "blocked" ? "danger" : impact === "degraded" ? "warning" : "neutral";
}

export function isIssueClosed(status: IssueStatus): boolean {
  return status === "resolved" || status === "rejected" || status === "not_reproducible" || status === "duplicate";
}

export function needsReporterAnswer(status: IssueStatus): boolean {
  return status === "needs_info";
}

export function contextCollectionLabel(state: ContextCollection): { label: string; tone: PillTone } {
  switch (state) {
    case "complete":
      return { label: "Context attached", tone: "success" };
    case "partial":
      return { label: "Context partly attached", tone: "warning" };
    case "pending":
      return { label: "Context still being collected", tone: "info" };
    case "unavailable":
      return { label: "No context attached", tone: "neutral" };
  }
}

const GUIDANCE_TOOL_PHRASES: [RegExp, string][] = [
  [/\breply_to_issue\b/g, "the reply box below"],
  [/\bcheck back with get_issue when convenient\b/g, "check back here when convenient"],
  [/\bcall get_issue\b/g, "reload this page"],
  [/\bget_issue\b/g, "this page"],
];

export function humanizeGuidance(guidance: string): string {
  return GUIDANCE_TOOL_PHRASES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), guidance);
}

const EVENT_LABELS: Record<string, string> = {
  created: "You filed this case",
  reporter_reply: "You replied",
  status_changed: "Status changed",
  info_requested: "Support asked a question",
  assigned: "Assigned to support",
  merged: "Merged into another case",
  unmerged: "Unmerged",
  resolved: "Resolved",
  note: "Support note",
  job_health: "Processing update",
};

export function issueEventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replaceAll("_", " ");
}
