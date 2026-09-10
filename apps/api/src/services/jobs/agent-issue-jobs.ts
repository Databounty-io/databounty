// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-issues support-channel jobs.
 *
 * Ported from v1 `databounty-api/src/services/agent-issue-jobs.ts`
 * (`purgeExpiredAgentIssues`, `escalationLevel`, `runEscalationSweep`,
 * `runEscalation`, `runCanonicalOutcomeFanout`, `runFingerprint`,
 * `runFiledNotification`, and the sweep enqueuers). v1's `agent_issue.enrich`
 * is deliberately NOT ported — see the note on
 * `runDuplicateCandidatesJob` below.
 */
import { AgentIssueCategory, AgentIssueStatus, Prisma, type AgentIssueImpact } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { notifyAdminsEvent, notifyEvent } from "../notifications.js";
import { enqueueJob } from "../jobs.js";

/** Bounded per run: a sweep that tried to delete years of backlog in one
 * statement would hold locks long enough to matter. */
const PURGE_BATCH = 500;
/** Aging cases escalated per sweep tick. The sweep re-runs hourly, so a large
 * backlog drains over several ticks instead of enqueueing thousands at once. */
const ESCALATION_BATCH = 200;
/** Reporters of merged duplicates notified per run. A canonical can absorb a
 * lot of reports during an incident; this fan-out must not become one
 * unbounded transaction. */
const CANONICAL_FANOUT_BATCH = 500;

/**
 * Bumping this re-arms every escalation alert. Do it when the POLICY changes
 * (which statuses escalate, how levels are cut) — NOT when an operator
 * retunes the hour thresholds, which are live settings and take effect on the
 * next sweep on their own.
 */
export const ESCALATION_POLICY_VERSION = 1;

/** Bumping this re-arms fingerprint recomputation for every case. */
export const FINGERPRINT_VERSION = 1;

const TERMINAL_STATUSES = [
  AgentIssueStatus.resolved,
  AgentIssueStatus.rejected,
  AgentIssueStatus.not_reproducible,
  AgentIssueStatus.duplicate,
] as const;

/**
 * Statuses the escalation sweep considers "waiting on staff".
 *
 * `needs_info` is excluded on purpose, and it is the whole reason this is a
 * list rather than "not terminal": a case in needs_info is waiting on the
 * REPORTER. Alerting staff that it is aging would page someone who cannot move
 * it, and would make the aging signal meaningless by filling it with cases
 * whose next action belongs to somebody else.
 */
const ESCALATABLE_STATUSES = [
  AgentIssueStatus.received,
  AgentIssueStatus.triaged,
  AgentIssueStatus.investigating,
] as const;

/** Deleted content is gone; make sure that is a decision an operator made
 * rather than a default nobody noticed. A missing/invalid value falls back to
 * the catalog default (730 days), never to "purge everything". */
async function retentionDays(): Promise<number> {
  const row = await prisma.adminSetting.findUnique({ where: { key: "agent_issues.retention_days" } });
  const value = row?.value as unknown;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 730;
}

/**
 * `agent_issue.purge_expired` handler. Three deliberate limits on what this
 * deletes:
 *   1. **Only terminal cases.** An open case is never deleted by age — a case
 *      unresolved for two years is an operations failure to look at, not
 *      something to quietly erase.
 *   2. **Never the audit trail.** `AdminAuditLog` rows are the compliance
 *      record and live in a different table on purpose; untouched here.
 *   3. **Bounded per run** (see PURGE_BATCH).
 */
export async function purgeExpiredAgentIssues(): Promise<{ deleted: number }> {
  const days = await retentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const doomed = await prisma.agentIssue.findMany({
    where: {
      status: { in: [...TERMINAL_STATUSES] },
      updatedAt: { lt: cutoff },
      // A canonical case outlives its children: deleting it first would leave
      // a duplicate pointing at nothing. Children age out on their own, and
      // the parent becomes eligible once none remain.
      duplicates: { none: {} },
    },
    orderBy: { updatedAt: "asc" },
    take: PURGE_BATCH,
    select: { id: true },
  });
  if (doomed.length === 0) return { deleted: 0 };

  const ids = doomed.map((row) => row.id);
  // Events cascade on the FK, but deleting them explicitly keeps the intent
  // visible at the call site rather than depending on a schema detail.
  await prisma.agentIssueEvent.deleteMany({ where: { issueId: { in: ids } } });
  const result = await prisma.agentIssue.deleteMany({ where: { id: { in: ids } } });
  return { deleted: result.count };
}

/** Live thresholds, in hours, per impact. Each falls back to the catalog
 * default on a missing or malformed row — never to 0, which would escalate
 * every open case on the next tick. */
async function escalationThresholds(): Promise<Record<AgentIssueImpact, number>> {
  const keys = {
    blocked: "agent_issues.escalate_blocked_hours",
    degraded: "agent_issues.escalate_degraded_hours",
    suggestion: "agent_issues.escalate_suggestion_hours",
  } as const;
  const defaults: Record<AgentIssueImpact, number> = { blocked: 24, degraded: 72, suggestion: 336 };

  const rows = await prisma.adminSetting.findMany({ where: { key: { in: Object.values(keys) } } });
  const byKey = new Map(rows.map((row) => [row.key, row.value as unknown]));
  const out = { ...defaults };
  for (const [impact, key] of Object.entries(keys) as [AgentIssueImpact, string][]) {
    const value = byKey.get(key);
    if (typeof value === "number" && Number.isInteger(value) && value > 0) out[impact] = value;
  }
  return out;
}

/**
 * Escalation LEVEL rather than a per-tick alert: level 1 at the threshold, 2
 * at 2x, 3 at 4x, and so on. The notification's idempotency key carries the
 * level, so a case that stays open raises a small number of escalating alerts
 * instead of one every hour forever — an aging signal nobody can silence is
 * one everybody learns to ignore.
 *
 * Pure and exported: this is the rule the whole escalation stage rests on.
 */
export function escalationLevel(ageHours: number, thresholdHours: number): number {
  if (thresholdHours <= 0) return 0;
  if (ageHours < thresholdHours) return 0;
  return Math.floor(Math.log2(ageHours / thresholdHours)) + 1;
}

/** `agent_issue.escalation_sweep` handler. Finds open cases past their
 * threshold and enqueues one `escalate` job each — reads only; it changes
 * nothing about any case. One job per case so a single bad row cannot fail the
 * whole sweep. */
export async function runEscalationSweep(): Promise<{ enqueued: number }> {
  const thresholds = await escalationThresholds();
  const now = Date.now();
  let enqueued = 0;

  for (const [impact, hours] of Object.entries(thresholds) as [AgentIssueImpact, number][]) {
    const cutoff = new Date(now - hours * 3_600_000);
    const aging = await prisma.agentIssue.findMany({
      where: {
        impact,
        status: { in: [...ESCALATABLE_STATUSES] },
        // Age is measured from when the case was FILED, not from its last
        // touch: a case staff keep re-reading without resolving is exactly the
        // one an aging signal should surface, and `updatedAt` would keep
        // resetting its clock.
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: "asc" },
      take: ESCALATION_BATCH,
      select: { id: true, createdAt: true },
    });

    for (const issue of aging) {
      // The level belongs in the key. Without it the key is per (case,
      // policy), so ONE row serves a case for its whole life: the sweep keeps
      // addressing that same row every tick for as long as the case stays
      // open, and its `createdAt` ages into weeks. Two things went wrong
      // downstream. The watchdog reads `createdAt` as queue wait and pages a
      // false critical backlog; and `runEscalation` appends an `escalated`
      // timeline event on every run with no idempotency guard of its own
      // (only its notification is keyed by level), so the case's timeline
      // fills with duplicates — v1's dev database reached 646 such rows
      // across six cases, 108 apiece.
      //
      // Keyed by level, the row is created once PER ESCALATION STEP: the
      // sweep's enqueue is a genuine no-op until the case ages into the next
      // level, and each level then gets a fresh row with an honest
      // `createdAt` and exactly one timeline event.
      const ageHours = Math.floor((now - issue.createdAt.getTime()) / 3_600_000);
      const level = escalationLevel(ageHours, hours);
      // `createdAt < cutoff` above already implies level >= 1; re-checked so
      // a threshold change between query and loop cannot key a job at 0.
      if (level < 1) continue;
      await enqueueJob(
        "agent_issue.escalate",
        { issueId: issue.id, policyVersion: ESCALATION_POLICY_VERSION },
        {
          idempotencyKey: `agent_issue.escalate:${issue.id}:${ESCALATION_POLICY_VERSION}:${level}`,
          maxAttempts: 3,
        }
      );
      enqueued += 1;
    }
  }
  return { enqueued };
}

/**
 * `agent_issue.escalate` handler. Raises the aging alert for ONE case. Two
 * invariants, both from v1's job table ("must not alter issue disposition"):
 * status/severity/assignment/version are NOT touched, and the timeline entry
 * is internal-only, because an automated age signal is an operations fact
 * about staff's queue, not news for the reporter.
 */
export async function runEscalation(issueId: string): Promise<void> {
  const issue = await prisma.agentIssue.findUnique({
    where: { id: issueId },
    select: { id: true, status: true, impact: true, category: true, summary: true, createdAt: true },
  });
  if (!issue) return;
  // Re-checked at RUN time, not just at sweep time: staff may have triaged,
  // answered or closed the case in between. Escalating then would alert on a
  // case that is no longer waiting on anyone.
  if (!(ESCALATABLE_STATUSES as readonly AgentIssueStatus[]).includes(issue.status)) return;

  const thresholds = await escalationThresholds();
  const thresholdHours = thresholds[issue.impact];
  const ageHours = Math.floor((Date.now() - issue.createdAt.getTime()) / 3_600_000);
  const level = escalationLevel(ageHours, thresholdHours);
  if (level < 1) return;

  await prisma.$transaction(async (tx) => {
    await notifyAdminsEvent(tx, "admin.agent_issue_aging", {
      entityId: issue.id,
      // Security/privacy reports stay admin-only end to end.
      adminOnly: issue.category === AgentIssueCategory.security_privacy,
      // Level in the key, so level 1 and level 2 are two alerts and a hundred
      // sweep ticks in between are none.
      keySuffix: `${issue.id}:${ESCALATION_POLICY_VERSION}:${level}`,
      data: {
        impact: issue.impact,
        category: issue.category,
        status: issue.status,
        summary: issue.summary,
        ageHours: String(ageHours),
        thresholdHours: String(thresholdHours),
      },
    });
    await tx.agentIssueEvent.create({
      data: {
        issueId: issue.id,
        actorUserId: null,
        actorRole: "system",
        type: "escalated",
        internalOnly: true,
        metadata: { level, ageHours, thresholdHours, policyVersion: ESCALATION_POLICY_VERSION },
      },
    });
  }, { timeout: 15_000 });
}

/**
 * `agent_issue.notify_canonical_outcome` handler. Tells the reporters of every
 * case merged into `canonicalIssueId` what the outcome was. Their own rows
 * stay `duplicate` and never transition again, so this is the ONLY thing that
 * can deliver what the duplicate guidance promises.
 *
 * `entityId` is each reporter's OWN case id — the canonical belongs to someone
 * else, and a case that is not yours correctly 404s, so deep-linking the
 * canonical would send them to a dead page.
 */
export async function runCanonicalOutcomeFanout(canonicalIssueId: string, version: number): Promise<void> {
  const canonical = await prisma.agentIssue.findUnique({
    where: { id: canonicalIssueId },
    select: { id: true, status: true, resolutionNote: true, resolutionRef: true },
  });
  if (!canonical) return;
  // Only a terminal canonical has an outcome to report.
  if (!(TERMINAL_STATUSES as readonly AgentIssueStatus[]).includes(canonical.status)) return;

  const children = await prisma.agentIssue.findMany({
    where: { canonicalIssueId, reporterUserId: { not: null } },
    take: CANONICAL_FANOUT_BATCH,
    select: { id: true, reporterUserId: true },
  });
  if (children.length === 0) return;

  await prisma.$transaction(async (tx) => {
    for (const child of children) {
      await notifyEvent(tx, "agent_issue.canonical_outcome", {
        userId: child.reporterUserId!,
        entityId: child.id,
        // Keyed on the canonical's version so a retry cannot double-notify,
        // but a LATER outcome change still reaches them.
        keySuffix: `${child.id}:${canonicalIssueId}:${version}`,
        data: {
          status: canonical.status,
          reason: canonical.resolutionNote ?? "",
          resolutionRef: canonical.resolutionRef ?? "",
        },
      });
    }
  });
}

/**
 * `agent_issue.duplicate_candidates` handler. Recomputes the ADVISORY dedupe
 * fingerprint for one case. Advisory forever: nothing here merges or closes
 * anything — it only makes staff's "also reported by N" suggestion reflect the
 * current fingerprint rule.
 *
 * This is the one place v1's `agent_issue.enrich` would have fed: there, the
 * fingerprint incorporated the resource ids that enrichment had RESOLVED from
 * the reporter's claims. This rebuild's intake stores no claimed-resource
 * context and has no ContextCollector, so there is nothing to resolve and the
 * fingerprint is (category, summary) only — the same rule the intake path uses.
 * Porting `enrich` would have produced a handler with nothing to read.
 */
export async function runDuplicateCandidatesJob(issueId: string): Promise<void> {
  const issue = await prisma.agentIssue.findUnique({
    where: { id: issueId },
    select: { id: true, category: true, summary: true, fingerprint: true },
  });
  if (!issue) return;
  const fingerprint = fingerprintFor({ category: issue.category, summary: issue.summary });
  if (fingerprint === issue.fingerprint) return; // nothing changed; no event worth writing
  await prisma.$transaction(async (tx) => {
    await tx.agentIssue.update({ where: { id: issueId }, data: { fingerprint } });
    await tx.agentIssueEvent.create({
      data: {
        issueId,
        actorUserId: null,
        actorRole: "system",
        type: "note",
        internalOnly: true,
        metadata: { fingerprintVersion: FINGERPRINT_VERSION, previousFingerprint: issue.fingerprint },
      },
    });
  });
}

/** The advisory fingerprint rule. Must stay identical to the one intake uses
 * (services/issues.ts `computeFingerprint`) or a recompute would reshuffle
 * every case's duplicate suggestions for no reason. */
export function fingerprintFor(params: { category: string; summary: string }): string {
  const norm = `${params.category}:${params.summary.trim().toLowerCase()}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

/**
 * `agent_issue.notify_filed` handler. Admin fan-out for a newly filed case,
 * off the reporter's request path: during an incident every affected agent
 * files at once, and O(admins) notification writes must not sit inside one
 * reporter's request.
 *
 * One transaction so the fan-out is all-or-nothing and the job can retry
 * cleanly; `notifyAdminsEvent` keys each row per (admin, issue), so a retry
 * after a partial failure cannot double-notify anyone.
 */
export async function runFiledNotification(issueId: string): Promise<void> {
  const issue = await prisma.agentIssue.findUnique({
    where: { id: issueId },
    select: { id: true, category: true, impact: true, summary: true },
  });
  if (!issue) return;
  await prisma.$transaction((tx) =>
    notifyAdminsEvent(tx, "admin.agent_issue_filed", {
      entityId: issue.id,
      // Security/privacy reports stay admin-only end to end — queue, detail,
      // and this notification.
      adminOnly: issue.category === AgentIssueCategory.security_privacy,
      keySuffix: issue.id,
      data: { category: issue.category, impact: issue.impact, summary: issue.summary },
    })
  );
}

/* ==========================================================================
 * Producers
 * ======================================================================== */

/** Hourly idempotency key: many workers ticking together still enqueue one
 * sweep per hour, not one per worker per tick. */
export async function enqueueAgentIssueRetentionSweep(): Promise<void> {
  await enqueueJob("agent_issue.purge_expired", {} as Record<string, never>, {
    idempotencyKey: `agent_issue.purge_expired:${Math.floor(Date.now() / 3_600_000)}`,
    maxAttempts: 3,
  });
}

/** Hourly aging sweep. Deliberately a SEPARATE job from the purge: a retention
 * failure must never stop staff being told a blocked case has sat for a day,
 * and a full support queue must never stop old content being deleted on time. */
export async function enqueueAgentIssueEscalationSweep(): Promise<void> {
  await enqueueJob("agent_issue.escalation_sweep", {} as Record<string, never>, {
    idempotencyKey: `agent_issue.escalation_sweep:${Math.floor(Date.now() / 3_600_000)}`,
    maxAttempts: 3,
  });
}

/** Producer for the admin fan-out. Exported for the intake path to call after
 * it commits the case (see the follow-up note in the task report — intake
 * lives in services/issues.ts, which this change does not own). */
export async function enqueueAgentIssueFiledNotification(
  issueId: string,
  tx?: Prisma.TransactionClient
): Promise<void> {
  await enqueueJob("agent_issue.notify_filed", { issueId }, {
    idempotencyKey: `agent_issue.notify_filed:${issueId}`,
    maxAttempts: 5,
    tx,
  });
}

/** Producer for one case's fingerprint recompute. */
export async function enqueueDuplicateCandidates(
  issueId: string,
  tx?: Prisma.TransactionClient
): Promise<void> {
  await enqueueJob(
    "agent_issue.duplicate_candidates",
    { issueId, fingerprintVersion: FINGERPRINT_VERSION },
    { idempotencyKey: `agent_issue.duplicate_candidates:${issueId}:${FINGERPRINT_VERSION}`, maxAttempts: 3, tx }
  );
}

/**
 * Sweep producer for canonical-outcome fan-out.
 *
 * v1 enqueued this from the admin merge/resolve route. That route is not part
 * of this change, so the producer here is a bounded sweep instead: any
 * terminal canonical that HAS duplicate children gets one job per (canonical,
 * version). Both layers of dedupe make that safe — the queue key collapses
 * repeat sweeps, and `notifyEvent`'s per-recipient event key means a reporter
 * is told once per outcome version however often the sweep runs.
 */
export async function enqueueCanonicalOutcomeFanouts(limit = 100): Promise<{ enqueued: number }> {
  const canonicals = await prisma.agentIssue.findMany({
    where: { status: { in: [...TERMINAL_STATUSES] }, duplicates: { some: { reporterUserId: { not: null } } } },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, version: true },
  });
  for (const canonical of canonicals) {
    await enqueueJob(
      "agent_issue.notify_canonical_outcome",
      { canonicalIssueId: canonical.id, version: canonical.version },
      {
        idempotencyKey: `agent_issue.notify_canonical_outcome:${canonical.id}:${canonical.version}`,
        maxAttempts: 3,
      }
    );
  }
  return { enqueued: canonicals.length };
}

/** The periodic work this channel needs enqueued each tick. One call site for
 * the worker so adding a fourth sweep later does not mean remembering to edit
 * the worker too. */
export async function enqueueAgentIssueSweeps(): Promise<void> {
  await enqueueAgentIssueRetentionSweep();
  await enqueueAgentIssueEscalationSweep();
  await enqueueCanonicalOutcomeFanouts();
}
