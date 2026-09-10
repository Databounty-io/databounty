// SPDX-License-Identifier: Apache-2.0

import { JobStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { emitAlert, resolveAlert } from "./alerts.js";
import { heartbeatStaleAfterMs } from "./worker-heartbeat.js";

/**
 * Watchdog sweep: the periodic detector that turns silent failure modes into
 * explicit admin alerts, and clears them when the condition ends. Every check
 * is condition → emitAlert / resolveAlert, so a persisting problem pages once
 * and recovery is announced.
 *
 * Checks:
 * - job backlog      — pending/failed depth, and oldest runnable job age
 * - dead-letter      — any job in the terminal `dead` state (needs a human)
 * - stale heartbeat  — a worker loop that stopped ticking entirely
 * - provider circuit — GitHub/ORCID outage isolated from credential checks
 * - stuck submission — awaiting validation with no live job behind it
 *
 * Ported from v1 `src/services/watchdog.ts` with ONE deliberate omission: v1
 * also alerts on a Redis cache circuit breaker (`cache_circuit_open`). This API
 * has no cache client at all — there is no redis import anywhere in the
 * codebase — so that check is not ported rather than faked. `admin-health.ts`
 * continues to report cache as `driver: "not_configured"`, which is the honest
 * state, not a breaker that can never open.
 */

const BACKLOG_DEPTH_WARNING = 500;
const BACKLOG_DEPTH_CRITICAL = 5_000;
const OLDEST_PENDING_WARNING_MS = 15 * 60_000;
const OLDEST_PENDING_CRITICAL_MS = 60 * 60_000;
/** A submission awaiting validation longer than this with no live job is stuck. */
const STUCK_SUBMISSION_AFTER_MS = 30 * 60_000;

export interface WatchdogReport {
  backlogDepth: number;
  oldestPendingAgeMs: number | null;
  deadLetterCount: number;
  staleWorkers: string[];
  providerCircuitsOpen: string[];
  stuckSubmissionCount: number;
}

export async function runWatchdogSweep(): Promise<WatchdogReport> {
  const now = Date.now();

  const [backlogDepth, oldestRunnable, deadLetterCount, heartbeats, providerCircuits, stuckSubmissions] =
    await Promise.all([
      prisma.jobQueue.count({
        where: { status: { in: [JobStatus.pending, JobStatus.failed] } },
      }),
      prisma.jobQueue.findFirst({
        where: {
          status: { in: [JobStatus.pending, JobStatus.failed] },
          nextAttemptAt: { lte: new Date(now) },
        },
        // Measured by `nextAttemptAt` — when the job became DUE — not by
        // `createdAt`, which is when the ROW was inserted. Enqueue sites that
        // re-arm an existing row by stable idempotency key leave `createdAt`
        // at the original insert, so for those two values diverge without
        // bound: a row created nine days ago and re-armed one second ago
        // reported a nine-day backlog and paged critical on every re-arm,
        // flapping back to resolved as soon as a worker claimed it. Measuring
        // from the due time also stops retry backoff counting as backlog — a
        // failed job is "waiting" only once it is eligible to run again.
        orderBy: { nextAttemptAt: "asc" },
        select: { nextAttemptAt: true },
      }),
      prisma.jobQueue.count({ where: { status: JobStatus.dead } }),
      prisma.workerHeartbeat.findMany(),
      prisma.externalProviderCircuit.findMany(),
      // The state a dead/lost validation job actually leaves behind: a
      // submission stuck in `submitted` with no live job to move it. The
      // dead-letter count above does NOT catch this — a job that
      // acked-then-crashed, or whose recovery declined, has no `dead` row.
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
        FROM submissions s
        WHERE s.status = 'submitted'
          AND s.updated_at < ${new Date(now - STUCK_SUBMISSION_AFTER_MS)}
          AND NOT EXISTS (
            SELECT 1 FROM job_queue j
            WHERE j.type = 'validation.run'
              AND j.status IN ('pending','failed','processing')
              AND j.payload->>'submissionId' = s.id
          )
      `,
    ]);
  const stuckSubmissionCount = Number(stuckSubmissions[0]?.count ?? 0n);

  // ── Job backlog ──────────────────────────────────────────────────────
  // `nextAttemptAt` is nullable in the schema, but the `lte` filter above can
  // only match a non-null value, so a returned row always carries one. The
  // optional chain keeps that a type-level fact rather than a non-null `!`.
  const oldestPendingAgeMs = oldestRunnable?.nextAttemptAt
    ? now - oldestRunnable.nextAttemptAt.getTime()
    : null;
  const backlogCritical =
    backlogDepth > BACKLOG_DEPTH_CRITICAL ||
    (oldestPendingAgeMs !== null && oldestPendingAgeMs > OLDEST_PENDING_CRITICAL_MS);
  const backlogWarning =
    backlogDepth > BACKLOG_DEPTH_WARNING ||
    (oldestPendingAgeMs !== null && oldestPendingAgeMs > OLDEST_PENDING_WARNING_MS);
  if (backlogCritical || backlogWarning) {
    await emitAlert({
      code: "job_backlog",
      severity: backlogCritical ? "critical" : "warning",
      dedupeKey: "job_backlog",
      summary: `Job queue backlog: ${backlogDepth} runnable job(s), oldest waiting ${
        oldestPendingAgeMs === null ? "n/a" : Math.round(oldestPendingAgeMs / 60_000) + " min"
      }.`,
      context: { backlogDepth, oldestPendingAgeMs },
    });
  } else {
    await resolveAlert("job_backlog", "Job queue backlog has drained back below thresholds.");
  }

  // ── Profile-provider circuit breakers ────────────────────────────────
  const providerCircuitsOpen = providerCircuits
    .filter((circuit) => circuit.openUntil && circuit.openUntil.getTime() > now)
    .map((circuit) => circuit.provider);
  for (const circuit of providerCircuits) {
    const dedupeKey = `profile_provider_circuit_open:${circuit.provider}`;
    if (circuit.openUntil && circuit.openUntil.getTime() > now) {
      await emitAlert({
        code: "profile_provider_circuit_open",
        severity: "warning",
        dedupeKey,
        summary: `${circuit.provider} credential provider is temporarily unavailable; checks are deferred without affecting reputation.`,
        context: {
          provider: circuit.provider,
          openUntil: circuit.openUntil.toISOString(),
          consecutiveFailures: circuit.consecutiveFailures,
        },
      });
    } else {
      await resolveAlert(dedupeKey, `${circuit.provider} credential provider circuit has closed.`);
    }
  }

  // ── Dead-letter queue ────────────────────────────────────────────────
  if (deadLetterCount > 0) {
    await emitAlert({
      code: "job_dead_letter",
      severity: "critical",
      dedupeKey: "job_dead_letter",
      summary: `${deadLetterCount} job(s) are dead-lettered and need manual retry (admin → jobs).`,
      context: { deadLetterCount },
    });
  } else {
    await resolveAlert("job_dead_letter", "Dead-letter queue is empty again.");
  }

  // ── Worker heartbeats (total worker death — the errorless failure) ────
  const staleWorkers: string[] = [];
  for (const hb of heartbeats) {
    const staleAfter = heartbeatStaleAfterMs(hb.intervalMs);
    const ageMs = now - hb.lastRunAt.getTime();
    const dedupeKey = `worker_stale:${hb.name}`;
    if (ageMs > staleAfter) {
      staleWorkers.push(hb.name);
      await emitAlert({
        code: "worker_stale",
        severity: "critical",
        dedupeKey,
        summary: `Worker "${hb.name}" has not ticked for ${Math.round(
          ageMs / 60_000
        )} min (expected every ${Math.round(hb.intervalMs / 1000)}s).`,
        context: { worker: hb.name, ageMs, intervalMs: hb.intervalMs, lastError: hb.lastError },
      });
    } else {
      await resolveAlert(dedupeKey, `Worker "${hb.name}" is ticking again.`);
    }
  }

  // ── Stuck submissions (a lost validation job leaves no dead-letter row) ──
  if (stuckSubmissionCount > 0) {
    await emitAlert({
      code: "submissions_stuck",
      severity: "critical",
      dedupeKey: "submissions_stuck",
      summary: `${stuckSubmissionCount} submission(s) have been awaiting validation for over ${Math.round(
        STUCK_SUBMISSION_AFTER_MS / 60_000
      )} min with no live job — likely a lost or crashed validation run (admin → jobs → requeue).`,
      context: { stuckSubmissionCount },
    });
  } else {
    await resolveAlert("submissions_stuck", "No submissions are stuck awaiting validation.");
  }

  return {
    backlogDepth,
    oldestPendingAgeMs,
    deadLetterCount,
    staleWorkers,
    providerCircuitsOpen,
    stuckSubmissionCount,
  };
}
