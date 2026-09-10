// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { AgentIssueCategory, AgentIssueImpact, AgentIssueSeverity, AgentIssueStatus, type AgentIssue, type AgentIssueEvent, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { enqueueAgentIssueFiledNotification, enqueueDuplicateCandidates } from "./jobs/agent-issue-jobs.js";
import { dbJobQueue } from "./jobs.js";
import { notifyUser } from "./notifications.js";

/**
 * Static, status-keyed copy for the reporter-facing `guidance` field. Written
 * with the same tool-name phrasing an MCP agent caller would need
 * (`get_issue`, `reply_to_issue`) — the web app's `humanizeGuidance()`
 * (apps/web/lib/agent-issues.ts) rewrites those phrases for a human reader.
 * Not a computed trust claim about system state, so a fixed map here is
 * honest. `resources`/`unresolvedIds` ARE computed trust claims, and are read
 * back from the stored `context` snapshot (see `summarizeIssueContext`).
 */
export function issueGuidance(status: AgentIssueStatus): string {
  switch (status) {
    case AgentIssueStatus.received:
      return "Filed. Check back with get_issue when convenient.";
    case AgentIssueStatus.triaged:
      return "Triaged and queued for investigation. Check back with get_issue when convenient.";
    case AgentIssueStatus.investigating:
      return "Under investigation. Check back with get_issue when convenient.";
    case AgentIssueStatus.needs_info:
      return "We need more information to continue — reply using reply_to_issue.";
    case AgentIssueStatus.duplicate:
      return "Merged into another case. Call get_issue on the canonical case for its outcome.";
    case AgentIssueStatus.not_reproducible:
      return "Closed as not reproducible. File a new report if it recurs.";
    case AgentIssueStatus.resolved:
      return "Resolved.";
    case AgentIssueStatus.rejected:
      return "Closed.";
  }
}

export interface IssueResourceDTO {
  kind: string;
  id: string;
  status?: string | null;
  [key: string]: unknown;
}

export interface IssueListRowDTO {
  id: string;
  status: AgentIssueStatus;
  category: AgentIssueCategory;
  impact: AgentIssueImpact;
  summary: string;
  canonicalIssueId: string | null;
  contextCollection: ContextCollectionState;
  createdAt: string;
  updatedAt: string;
  alsoReportedBy: number;
  resources: IssueResourceDTO[];
  guidance: string;
}

/**
 * The three honest states this deployment can actually be in, and the ONLY
 * values `AgentIssue.contextCollection` may hold from here.
 *
 * `pending` is deliberately absent from what intake writes: v1 could write it
 * because a background `agent_issue.enrich` worker was going to resolve the
 * claimed ids later. This rebuild dropped that job (services/jobs.ts) and
 * resolves synchronously at intake, so nothing is ever left "still being
 * collected". The web still renders `pending` (lib/agent-issues.ts) because a
 * row written by an older build may carry it — reading it stays supported,
 * writing it would be a claim about a worker that does not exist.
 */
export type ContextCollectionState = "complete" | "partial" | "pending" | "unavailable";

/**
 * The one place that decides what a case is allowed to CLAIM about its own
 * context. The rule the project invariant demands: `complete` is reserved for
 * "every id the reporter named was resolved AND authorized", and a case with
 * nothing resolved says `unavailable` — never `complete`, which is what the
 * old `@default("complete")` made every single row say regardless of whether
 * a snapshot had ever been taken.
 */
export function contextCollectionFor(resolvedCount: number, unresolvedCount: number): ContextCollectionState {
  if (resolvedCount === 0) return "unavailable";
  if (unresolvedCount > 0) return "partial";
  return "complete";
}

/**
 * Reads the stored `context` snapshot back into the flat shape the reporter
 * (and apps/web `IssueResource`) consumes. Only ids/status/labels — the
 * snapshot never held item content, and nothing is invented here: a case with
 * no stored snapshot yields an empty list, which is then reported alongside a
 * `contextCollection` that says so.
 */
export function summarizeIssueContext(context: Prisma.JsonValue | null | undefined): {
  resources: IssueResourceDTO[];
  unresolvedIds: string[];
} {
  const empty = { resources: [] as IssueResourceDTO[], unresolvedIds: [] as string[] };
  if (!context || typeof context !== "object" || Array.isArray(context)) return empty;
  const root = context as Prisma.JsonObject;

  const rawResources = Array.isArray(root["resources"]) ? (root["resources"] as Prisma.JsonArray) : [];
  const resources: IssueResourceDTO[] = [];
  for (const entry of rawResources) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Prisma.JsonObject;
    const id = typeof row["id"] === "string" ? row["id"] : null;
    // `type` is accepted as an alias for `kind` so a snapshot written by an
    // earlier build still renders instead of silently disappearing.
    const kind = typeof row["kind"] === "string" ? row["kind"] : typeof row["type"] === "string" ? row["type"] : null;
    if (!id || !kind) continue;
    const { type: _type, ...rest } = row as Record<string, unknown>;
    resources.push({ ...rest, kind, id } as IssueResourceDTO);
  }

  const unresolvedIds = Array.isArray(root["unresolvedIds"])
    ? (root["unresolvedIds"] as Prisma.JsonArray).filter((v): v is string => typeof v === "string")
    : [];

  return { resources, unresolvedIds };
}

function serializeIssueRow(issue: AgentIssue, alsoReportedBy: number): IssueListRowDTO {
  return {
    id: issue.id,
    status: issue.status,
    category: issue.category,
    impact: issue.impact,
    summary: issue.summary,
    canonicalIssueId: issue.canonicalIssueId,
    contextCollection: issue.contextCollection as ContextCollectionState,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
    alsoReportedBy,
    // The REAL stored projection, not a hardcoded []. Returning an empty list
    // unconditionally while the row said `contextCollection: "complete"` is
    // what produced a green "Context attached" pill directly above "No
    // resources were named on this case."
    resources: summarizeIssueContext(issue.context).resources,
    guidance: issueGuidance(issue.status),
  };
}

function serializeEvent(event: AgentIssueEvent) {
  return {
    id: event.id,
    type: event.type,
    body: event.body,
    actorRole: event.actorRole,
    createdAt: event.createdAt.toISOString(),
  };
}

function computeFingerprint(params: {
  category: string;
  summary: string;
}): string {
  const norm = `${params.category}:${params.summary.trim().toLowerCase()}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

/** The resource ids a reporter may name on a case. Same set v1 accepts, with
 * v1's `auditBatchId` replaced by this rebuild's `auditWindowId` (human audit
 * windows are the community equivalent). */
export interface LinkedIssueResources {
  bountyId?: string | null;
  submissionId?: string | null;
  auditWindowId?: string | null;
  contributorBatchId?: string | null;
  datasetTypeId?: string | null;
}

export interface CollectedIssueContext {
  /** Exactly what gets stored in `AgentIssue.context`. */
  snapshot: { resources: IssueResourceDTO[]; unresolvedIds: string[] };
  collection: ContextCollectionState;
  /** Every id the caller named, resolved or not — echoed back to the caller as
   * CLAIMS so it can see what it asked for, never as confirmed context. */
  claimed: Array<{ kind: string; id: string }>;
}

/**
 * Bounded, allowlisted resolution of the ids a reporter named. Ports v1's
 * `collectContext` with two deliberate differences:
 *
 *  - It runs SYNCHRONOUSLY at intake. v1 deferred this to an
 *    `agent_issue.enrich` job; this rebuild does not have that job
 *    (services/jobs.ts says why), so deferring would mean the snapshot is
 *    never taken at all — which is exactly the false-completeness bug being
 *    fixed here.
 *  - The resolved bounty carries no `kind`. v1 exposed paid-vs-community
 *    sponsorship on it; this tree has no paid track (AGENTS.md §1), so the
 *    distinction is not reintroduced.
 *
 * Two behaviours kept from v1 verbatim, both load-bearing:
 *  1. An id the caller cannot reach is DROPPED into `unresolvedIds`, never
 *     answered with "no such row" — the difference between those answers is an
 *     enumeration oracle over other people's work.
 *  2. Failure here never fails the report. A case with `unavailable` context
 *     still beats losing the reporter's only channel.
 */
export async function collectIssueContext(
  userId: string,
  linked: LinkedIssueResources,
): Promise<CollectedIssueContext> {
  const named = Object.entries(linked).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
  );
  const claimed = named.map(([key, id]) => ({ kind: key.replace(/Id$/, ""), id }));

  const resources: IssueResourceDTO[] = [];
  const unresolvedIds: string[] = [];

  try {
    for (const [key, id] of named) {
      if (key === "bountyId") {
        const row = await prisma.bounty.findUnique({
          where: { id },
          select: { id: true, title: true, status: true, datasetTypeId: true, communityRequesterUserId: true },
        });
        // Reachable = the reporter requested it, or it is a community pool
        // anyone may work. Everything in this tree is community (AGENTS.md §1).
        if (!row) { unresolvedIds.push(id); continue; }
        resources.push({ kind: "bounty", id: row.id, title: row.title, status: row.status, datasetTypeId: row.datasetTypeId });
        continue;
      }
      if (key === "submissionId") {
        const row = await prisma.submission.findFirst({
          where: { id, contributorUserId: userId },
          select: { id: true, status: true, bountyId: true },
        });
        if (!row) { unresolvedIds.push(id); continue; }
        resources.push({ kind: "submission", id: row.id, status: row.status, bountyId: row.bountyId });
        continue;
      }
      if (key === "auditWindowId") {
        const row = await prisma.humanAuditWindow.findFirst({
          where: { id, claimedByUserId: userId },
          select: { id: true, bountyId: true, settledAt: true },
        });
        if (!row) { unresolvedIds.push(id); continue; }
        resources.push({
          kind: "audit_window",
          id: row.id,
          bountyId: row.bountyId,
          status: row.settledAt ? "settled" : "open",
        });
        continue;
      }
      if (key === "contributorBatchId") {
        const row = await prisma.contributorBatch.findFirst({
          where: { id, contributorUserId: userId },
          select: { id: true, status: true, bountyId: true },
        });
        if (!row) { unresolvedIds.push(id); continue; }
        resources.push({ kind: "contributor_batch", id: row.id, status: row.status, bountyId: row.bountyId });
        continue;
      }
      if (key === "datasetTypeId") {
        // Catalog data is not tenant-scoped. `version` matters most: "the
        // contract changed under me" is a common real report.
        const row = await prisma.datasetType.findUnique({
          where: { id },
          select: { id: true, name: true, status: true, version: true },
        });
        if (!row) { unresolvedIds.push(id); continue; }
        resources.push({ kind: "dataset_type", id: row.id, title: row.name, status: row.status, version: row.version });
      }
    }
  } catch {
    // Collection itself broke. Say so; do not fall back to a value that reads
    // as "we looked and there was nothing".
    return { snapshot: { resources: [], unresolvedIds: named.map(([, id]) => id) }, collection: "unavailable", claimed };
  }

  return {
    snapshot: { resources, unresolvedIds },
    collection: contextCollectionFor(resources.length, unresolvedIds.length),
    claimed,
  };
}

export async function createAgentIssue(params: {
  reporterUserId?: string;
  reporterLabel?: string;
  source: string;
  category: AgentIssueCategory;
  impact: AgentIssueImpact;
  severity?: AgentIssueSeverity;
  summary: string;
  expected: string;
  actual: string;
  steps?: string;
  logExcerpt?: string;
  /** Allowlisted projection of the resources the reporter named AND was
   * confirmed to be allowed to see — ids/status only, never item content.
   * Callers resolve and split it before calling (see the MCP `report_issue`
   * tool); this layer stores what it is given. Absent = no resource named. */
  context?: Prisma.InputJsonValue;
  /** Must be derived from what actually resolved — use `contextCollectionFor`
   * or `collectIssueContext`, never a literal. A case must never present a
   * caller's unverified claim (or an un-taken snapshot) as resolved context. */
  contextCollection?: ContextCollectionState;
  /** Caller-supplied and REQUIRED. Previously the route defaulted this to a
   * fresh `iss_<ts>_<rand>` per call, which made the
   * `@@unique([reporterUserId, idempotencyKey])` constraint unreachable: a
   * retried filing could never match an existing case, so two identical
   * reports opened two cases with the same fingerprint and no dedupe signal. */
  idempotencyKey: string;
}): Promise<{ issue: AgentIssue & { events?: AgentIssueEvent[] }; deduplicated: boolean }> {
  const reporterLabel = params.reporterLabel ?? (params.reporterUserId ? `user-${params.reporterUserId.slice(-4)}` : "agent-anon");
  const fingerprint = computeFingerprint({ category: params.category, summary: params.summary });

  // Transactional outbox, matching v1 (`services/agent-issues.ts` passes `tx`
  // to every enqueue): the case row and the job rows that act on it commit
  // together. Enqueueing after a standalone create leaves a crash window in
  // which the issue exists but its admin fan-out job does not — and nothing
  // re-derives a missing notification from the issue row, so that admin alert
  // would be lost permanently rather than merely delayed.
  const result = await prisma.$transaction(async (tx) => {
    // Idempotency is scoped to the REPORTER, never global (v1 does the same):
    // a globally unique key would hand one reporter another reporter's case on
    // a collision. Skipped only when there is no reporter to scope it to —
    // the unique index cannot fire on a NULL reporter anyway.
    if (params.reporterUserId) {
      const existing = await tx.agentIssue.findUnique({
        where: {
          reporterUserId_idempotencyKey: {
            reporterUserId: params.reporterUserId,
            idempotencyKey: params.idempotencyKey,
          },
        },
        include: { events: true },
      });
      if (existing) return { created: existing, deduplicated: true };
    }

    const created = await tx.agentIssue.create({
      data: {
        reporterUserId: params.reporterUserId,
        reporterLabel,
        source: params.source,
        category: params.category,
        impact: params.impact,
        severity: params.severity,
        summary: params.summary,
        expected: params.expected,
        actual: params.actual,
        steps: params.steps,
        logExcerpt: params.logExcerpt,
        ...(params.context === undefined ? {} : { context: params.context }),
        ...(params.contextCollection === undefined ? {} : { contextCollection: params.contextCollection }),
        fingerprint,
        idempotencyKey: params.idempotencyKey,
        status: AgentIssueStatus.received,
        events: {
          create: {
            actorUserId: params.reporterUserId,
            actorRole: "reporter",
            type: "created",
            body: params.summary,
          },
        },
      },
      include: { events: true },
    });

    // Admin fan-out and the advisory duplicate-fingerprint recompute are both
    // QUEUED, matching v1 (`agent_issue.notify_filed` /
    // `agent_issue.duplicate_candidates`): during an incident every affected
    // agent files at once, and O(admins) notification writes must not sit inside
    // one reporter's request. This replaces a direct in-request `notifyAdmins`
    // call — the queued handler emits the catalog's `admin.agent_issue_filed`
    // event instead, which keys per (admin, issue) so a retry cannot double any
    // admin's inbox, and keeps a security/privacy report admin-only end to end.
    await enqueueAgentIssueFiledNotification(created.id, tx);
    await enqueueDuplicateCandidates(created.id, tx);

    return { created, deduplicated: false };
  });

  return { issue: result.created, deduplicated: result.deduplicated };
}

export interface IssueDetailDTO extends IssueListRowDTO {
  expected: string;
  actual: string;
  steps: string | null;
  resolutionNote: string | null;
  resolutionRef: string | null;
  resolvedAt: string | null;
  mergedOutcome: {
    status: AgentIssueStatus;
    resolutionNote: string | null;
    resolutionRef: string | null;
    resolvedAt: string | null;
  } | null;
  version: number;
  unresolvedIds: string[];
  events: ReturnType<typeof serializeEvent>[];
}

async function alsoReportedByCount(fingerprint: string, excludeId: string): Promise<number> {
  return prisma.agentIssue.count({ where: { fingerprint, id: { not: excludeId } } });
}

/** Batch-computes `alsoReportedBy` for a page of rows with one grouped query
 * instead of one COUNT per row. */
async function attachAlsoReportedBy(issues: AgentIssue[]): Promise<IssueListRowDTO[]> {
  if (issues.length === 0) return [];
  const fingerprints = [...new Set(issues.map((i) => i.fingerprint))];
  const counts = await prisma.agentIssue.groupBy({
    by: ["fingerprint"],
    where: { fingerprint: { in: fingerprints } },
    _count: { _all: true },
  });
  const countByFingerprint = new Map(counts.map((c) => [c.fingerprint, c._count._all]));
  return issues.map((issue) =>
    serializeIssueRow(issue, Math.max(0, (countByFingerprint.get(issue.fingerprint) ?? 1) - 1)),
  );
}

/**
 * Reporter-facing issue detail. `userId` is REQUIRED in practice: the two
 * guards below used to be conditional on it, so calling this with no userId
 * (which the MCP `get_issue` tool did, since MCP tools had no authentication)
 * both skipped the ownership check AND applied no `internalOnly` filter,
 * returning every internal-only event on any issue to an anonymous caller.
 * Both now fail closed. There is no admin caller today; an admin view that
 * needs internal events should get its own explicitly-named function rather
 * than reusing "no user id" as an implicit superuser mode.
 */
export async function getIssueById(issueId: string, userId?: string): Promise<IssueDetailDTO | null> {
  if (!userId) return null;
  const issue = await prisma.agentIssue.findUnique({
    where: { id: issueId },
    include: {
      events: {
        where: { internalOnly: false },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!issue) return null;
  if (issue.reporterUserId !== userId) return null;

  const [alsoReportedBy, canonical] = await Promise.all([
    alsoReportedByCount(issue.fingerprint, issue.id),
    issue.canonicalIssueId
      ? prisma.agentIssue.findUnique({
          where: { id: issue.canonicalIssueId },
          select: { status: true, resolutionNote: true, resolutionRef: true, resolvedAt: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    ...serializeIssueRow(issue, alsoReportedBy),
    expected: issue.expected,
    actual: issue.actual,
    steps: issue.steps,
    resolutionNote: issue.resolutionNote,
    resolutionRef: issue.resolutionRef,
    resolvedAt: issue.resolvedAt ? issue.resolvedAt.toISOString() : null,
    mergedOutcome: canonical
      ? {
          status: canonical.status,
          resolutionNote: canonical.resolutionNote,
          resolutionRef: canonical.resolutionRef,
          resolvedAt: canonical.resolvedAt ? canonical.resolvedAt.toISOString() : null,
        }
      : null,
    version: issue.version,
    // The real stored list of ids the reporter named that could NOT be
    // confirmed — surfaced rather than hidden, so an agent that mistyped a
    // batch id is told instead of believing the case carries that context.
    unresolvedIds: summarizeIssueContext(issue.context).unresolvedIds,
    events: issue.events.map(serializeEvent),
  };
}

export async function listUserIssues(userId: string): Promise<IssueListRowDTO[]> {
  const issues = await prisma.agentIssue.findMany({
    where: { reporterUserId: userId },
    orderBy: { createdAt: "desc" },
  });
  return attachAlsoReportedBy(issues);
}

export interface IssueListFilters {
  status?: AgentIssueStatus | null;
  q?: string | null;
  /** Inclusive lower bound on `createdAt`. */
  since?: Date | null;
  /** Exclusive upper bound on `createdAt`, so adjacent day ranges do not
   * double-count the boundary row. */
  until?: Date | null;
  cursor?: string | null;
  limit?: number;
}

/** A cursor the server cannot parse. Surfaced as a 400 by the route — never as
 * an empty 200, which is byte-identical to "you have no cases". */
export class InvalidIssueCursorError extends Error {}
/** A cursor minted under a different filter. Same reasoning. */
export class IssueCursorFilterMismatchError extends Error {}

/** Identifies the filter a page was issued under. A cursor carries this so a
 * token minted under one filter cannot be replayed under another and silently
 * page the wrong set. */
function reporterFilterKey(filters: IssueListFilters): string {
  return [
    filters.status ?? "",
    filters.q ?? "",
    filters.since?.toISOString() ?? "",
    filters.until?.toISOString() ?? "",
  ].join("|");
}

function encodeIssueCursor(createdAt: Date, id: string, filterKey: string): string {
  return Buffer.from(JSON.stringify({ v: 1, c: createdAt.toISOString(), i: id, f: filterKey }), "utf8").toString(
    "base64url",
  );
}

function decodeIssueCursor(token: string, filterKey: string): { createdAt: Date; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new InvalidIssueCursorError("Invalid issue list cursor.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidIssueCursorError("Invalid issue list cursor.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["v"] !== 1 || typeof obj["c"] !== "string" || typeof obj["i"] !== "string" || typeof obj["f"] !== "string") {
    throw new InvalidIssueCursorError("Invalid issue list cursor.");
  }
  const createdAt = new Date(obj["c"]);
  if (Number.isNaN(createdAt.getTime())) throw new InvalidIssueCursorError("Invalid issue list cursor.");
  if (obj["f"] !== filterKey) {
    throw new IssueCursorFilterMismatchError(
      "Cursor belongs to a different issue filter. Restart paging with the new filter.",
    );
  }
  return { createdAt, id: obj["i"] };
}

export interface IssueListPageDTO {
  items: IssueListRowDTO[];
  nextCursor: string | null;
  hasMore: boolean;
  issueCount: number;
}

/** Server-side filtered/paginated case list backing `GET /v1/issues` — every
 * filter and the keyset cursor are applied in the Prisma `where`/`orderBy`,
 * not client-side, matching the pagination pattern used elsewhere in this
 * API (scalability plan §2.2: no `page` number, no unfiltered fetch-then-slice). */
export async function listUserIssuesPage(userId: string, filters: IssueListFilters): Promise<IssueListPageDTO> {
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 50);
  // Every clause the COUNT must also see. The keyset predicate is deliberately
  // NOT in here: the count answers "how many cases match this filter", which
  // has to read the same on page 3 as on page 1.
  const baseWhere: Prisma.AgentIssueWhereInput = {
    AND: [
      { reporterUserId: userId },
      ...(filters.status ? [{ status: filters.status }] : []),
      ...(filters.q ? [{ summary: { contains: filters.q, mode: "insensitive" as const } }] : []),
      ...(filters.since ? [{ createdAt: { gte: filters.since } }] : []),
      ...(filters.until ? [{ createdAt: { lt: filters.until } }] : []),
    ],
  };

  const filterKey = reporterFilterKey(filters);
  // Explicit keyset predicate rather than Prisma's `cursor` + `skip: 1`, which
  // was wrong twice over: the token was a BARE ROW ID, so a nonexistent id and
  // a filter-changed id both came back as an empty 200 indistinguishable from
  // "you have no cases"; and Prisma requires the cursor row itself to satisfy
  // `where`, so adding a status/search/date filter mid-walk silently emptied
  // the page. Written out against the sort tuple, filter and cursor compose,
  // and a cursor that cannot be honoured throws instead of lying.
  const position = filters.cursor ? decodeIssueCursor(filters.cursor, filterKey) : null;
  const pageWhere: Prisma.AgentIssueWhereInput = position
    ? {
        AND: [
          baseWhere,
          {
            OR: [
              { createdAt: { lt: position.createdAt } },
              { createdAt: position.createdAt, id: { lt: position.id } },
            ],
          },
        ],
      }
    : baseWhere;

  const [issueCount, rows] = await Promise.all([
    prisma.agentIssue.count({ where: baseWhere }),
    prisma.agentIssue.findMany({
      where: pageWhere,
      // Stable sort tuple (createdAt, id) — createdAt alone is not unique and a
      // tie at the page boundary silently drops or repeats a row.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeIssueCursor(last.createdAt, last.id, filterKey) : null;
  const items = await attachAlsoReportedBy(page);

  return { items, nextCursor, hasMore, issueCount };
}

export async function replyToIssue(params: {
  issueId: string;
  actorUserId: string;
  actorRole: string;
  body: string;
  internalOnly?: boolean;
}): Promise<{ event: AgentIssueEvent; status: AgentIssueStatus; guidance: string }> {
  const issue = await prisma.agentIssue.findUnique({ where: { id: params.issueId } });
  if (!issue) throw new Error("Issue not found");

  const event = await prisma.agentIssueEvent.create({
    data: {
      issueId: params.issueId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      type: params.actorRole === "reporter" ? "reporter_reply" : "staff_reply",
      body: params.body,
      internalOnly: params.internalOnly ?? false,
    },
  });

  // A reporter answering a "needs_info" case hands it back to the queue for
  // staff to look at again — a real status write, not a display-only guess.
  let status = issue.status;
  if (params.actorRole === "reporter" && issue.status === AgentIssueStatus.needs_info) {
    status = AgentIssueStatus.received;
    await prisma.agentIssue.update({ where: { id: issue.id }, data: { status } });
  }

  return { event, status, guidance: issueGuidance(status) };
}

const CLOSED_ISSUE_STATUSES: ReadonlySet<AgentIssueStatus> = new Set([
  AgentIssueStatus.resolved,
  AgentIssueStatus.rejected,
  AgentIssueStatus.not_reproducible,
  AgentIssueStatus.duplicate,
]);

export function isIssueClosed(status: AgentIssueStatus): boolean {
  return CLOSED_ISSUE_STATUSES.has(status);
}
