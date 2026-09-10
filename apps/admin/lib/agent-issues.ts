// SPDX-License-Identifier: Apache-2.0

import { adminAuthedFetch } from "@/lib/admin-auth";

/**
 * The ONLY module in this app that knows the agent-issues endpoint paths.
 * Pages consume these functions; they never hand-write a fetch. When the API
 * contract moves, exactly one file changes.
 *
 * Every mutating call carries `expectedVersion` and every response returns the
 * new `version`: two admins on one detail page must collide with a 409 rather
 * than silently overwrite each other's disposition.
 */

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
export type IssueSeverity = "low" | "medium" | "high" | "critical";

/** Queue row. Deliberately narrower than the detail shape: no log excerpt, no
 * credential reference, no reporter identity — a queue is not a directory. */
export interface IssueRow {
  id: string;
  status: IssueStatus;
  category: IssueCategory;
  impact: IssueImpact;
  severity: IssueSeverity | null;
  summary: string;
  source: string;
  reporterLabel: string;
  assignedToUserId: string | null;
  canonicalIssueId: string | null;
  /** `pending` means enrichment has not run yet — an honest fourth state, and
   * the UI must never render it as a clean result. */
  contextCollection: "pending" | "complete" | "partial" | "unavailable";
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface IssueEvent {
  id: string;
  type: string;
  body: string | null;
  actorRole: string;
  internalOnly: boolean;
  metadata: unknown;
  createdAt: string;
}

export interface IssueDetail extends IssueRow {
  expected: string;
  actual: string;
  steps: string | null;
  logExcerpt: string | null;
  context: Record<string, unknown> | null;
  redactionApplied: boolean;
  resolutionNote: string | null;
  resolutionRef: string | null;
  resolvedAt: string | null;
  clientName: string | null;
  toolName: string | null;
  events: IssueEvent[];
  duplicates: { id: string; summary: string; status: IssueStatus; createdAt: string }[];
}

export interface IssueQueuePage {
  items: IssueRow[];
  nextCursor: string | null;
}

export interface IssueQueueFilters {
  status?: IssueStatus | "";
  category?: IssueCategory | "";
  impact?: IssueImpact | "";
  severity?: IssueSeverity | "";
  source?: IssueSource | "";
  /** Bounded server-side search over the redacted summary only. */
  q?: string;
  includeClosed?: boolean;
  cursor?: string | null;
  limit?: number;
}

export type IssueSource = "mcp_oauth" | "api_key" | "session";

/** Raised for a stale write so a page can show "reload and reapply" instead of
 * a generic failure. */
export class IssueConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueConflictError";
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
}

async function send<T>(path: string, init: RequestInit, fallback: string): Promise<T> {
  const res = await adminAuthedFetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 409) throw new IssueConflictError(await readError(res, "This issue changed since you loaded it."));
  if (!res.ok) throw new Error(await readError(res, fallback));
  return (await res.json()) as T;
}

export function issueQueryString(filters: IssueQueueFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.category) params.set("category", filters.category);
  if (filters.impact) params.set("impact", filters.impact);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.source) params.set("source", filters.source);
  // Below the server's 2-char minimum the query is not sent at all, so typing
  // the first letter of a search does not blank the queue.
  if (filters.q && filters.q.trim().length >= 2) params.set("q", filters.q.trim());
  if (filters.includeClosed) params.set("includeClosed", "true");
  if (filters.cursor) params.set("cursor", filters.cursor);
  params.set("limit", String(filters.limit ?? 25));
  return `?${params.toString()}`;
}

/** Shape of the advisory duplicate-suggestion response. The pages read it
 * through `useAdminResource`, so this is a type, not a fetcher. */
export interface DuplicateCandidates {
  candidates: { id: string; summary: string; status: IssueStatus; reporterLabel: string; createdAt: string }[];
  advisory: boolean;
}

/** Admin-only queue/worker health, shown separately from case status so
 * "nothing enriched yet" is never read as "nothing wrong". */
export interface IssueQueueHealth {
  open: number;
  partialContext: number;
  unassigned: number;
}

export function assignIssue(
  id: string,
  input: { expectedVersion: number; assignedToUserId?: string | null; severity?: IssueSeverity | null }
) {
  return send<{ id: string; version: number }>(
    `/v1/admin/issues/${encodeURIComponent(id)}/assign`,
    { method: "POST", body: JSON.stringify(input) },
    "Could not update this issue."
  );
}

export function requestIssueInfo(id: string, input: { expectedVersion: number; question: string }) {
  return send<{ id: string; status: IssueStatus; version: number }>(
    `/v1/admin/issues/${encodeURIComponent(id)}/request-info`,
    { method: "POST", body: JSON.stringify(input) },
    "Could not request more information."
  );
}

export function setIssueStatus(
  id: string,
  input: {
    expectedVersion: number;
    status: IssueStatus;
    reason?: string;
    resolutionRef?: string;
    canonicalIssueId?: string;
  }
) {
  return send<{ id: string; status: IssueStatus; version: number }>(
    `/v1/admin/issues/${encodeURIComponent(id)}/status`,
    { method: "POST", body: JSON.stringify(input) },
    "Could not change this issue's status."
  );
}

export function addIssueNote(id: string, body: string) {
  return send<{ id: string; createdAt: string }>(
    `/v1/admin/issues/${encodeURIComponent(id)}/notes`,
    { method: "POST", body: JSON.stringify({ body }) },
    "Could not save the note."
  );
}

// ── Display helpers ────────────────────────────────────────────────────────
// Status and severity are conveyed with TEXT as well as colour; colour alone
// is not a label.

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  received: "Received",
  triaged: "Triaged",
  investigating: "Investigating",
  needs_info: "Needs info",
  duplicate: "Duplicate",
  not_reproducible: "Not reproducible",
  resolved: "Resolved",
  rejected: "Rejected",
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

export type PillTone = "neutral" | "lime" | "success" | "warning" | "danger" | "info" | "violet";

export function statusTone(status: IssueStatus): PillTone {
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

export function impactTone(impact: IssueImpact): PillTone {
  return impact === "blocked" ? "danger" : impact === "degraded" ? "warning" : "neutral";
}

export function severityTone(severity: IssueSeverity | null): PillTone {
  if (!severity) return "neutral";
  return severity === "critical" || severity === "high" ? "danger" : severity === "medium" ? "warning" : "neutral";
}

/** Terminal states cannot be transitioned out of — the server enforces this;
 * the UI hides the controls so an admin is never offered an action that will
 * only ever 400. */
export function isTerminal(status: IssueStatus): boolean {
  return status === "resolved" || status === "rejected" || status === "not_reproducible" || status === "duplicate";
}

/** Dispositions the API requires a reporter-visible reason for. */
export function requiresReason(status: IssueStatus): boolean {
  return status === "resolved" || status === "rejected" || status === "not_reproducible" || status === "duplicate";
}
