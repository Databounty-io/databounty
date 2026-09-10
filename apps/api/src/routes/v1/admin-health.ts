// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { JobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { requireRole, ADMIN_AND_ABOVE_READONLY } from "../../lib/rbac.js";
import { listActiveAlerts } from "../../services/alerts.js";
import { heartbeatStaleAfterMs } from "../../services/worker-heartbeat.js";

/**
 * System health backing community/apps/admin's /health page. Four signals,
 * all schema-backed:
 *  - jobs: real JobQueue aggregate (byStatus, dead-letter count, oldest
 *    runnable pending job).
 *  - workers: real WorkerHeartbeat rows, each with its own staleness verdict
 *    derived from that worker's configured cadence.
 *  - activeAlerts: real SystemAlert rows the watchdog sweep raised.
 *  - providerCircuits: real ExternalProviderCircuit rows (GitHub/ORCID
 *    credential-verification circuit breakers) that are currently open.
 *
 * `workers` and `activeAlerts` previously returned permanently-empty lists
 * because this schema had no heartbeat or alert model at all — honest, but
 * two of four signals were dead. Both are now backed by real tables
 * (migration 20260901123827_add_operational_telemetry).
 *
 * `cache` still reports `driver: "not_configured"`: there is no Redis/cache
 * client in this codebase (searched: no redis import anywhere), so this stays
 * an honest not-configured rather than a breaker that can never open.
 */

export async function adminHealthRoutes(app: FastifyInstance) {
  app.get("/health", { preHandler: [requireRole(...ADMIN_AND_ABOVE_READONLY)] }, async (_req, reply) => {
    const now = new Date();

    const [byStatusRows, deadLetterCount, oldestRunnable, openCircuits, heartbeats, activeAlerts] =
      await Promise.all([
        prisma.jobQueue.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.jobQueue.count({ where: { status: JobStatus.dead } }),
        prisma.jobQueue.findFirst({
          where: { status: JobStatus.pending, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          orderBy: { createdAt: "asc" },
          select: { type: true, createdAt: true },
        }),
        prisma.externalProviderCircuit.findMany({ where: { openUntil: { gt: now } } }),
        prisma.workerHeartbeat.findMany({ orderBy: { name: "asc" } }),
        listActiveAlerts(),
      ]);

    const byStatus: Record<string, number> = {};
    for (const row of byStatusRows) byStatus[row.status] = row._count._all;

    const failedJobs = byStatus[JobStatus.failed] ?? 0;

    const workers = heartbeats.map((hb) => {
      const ageMs = now.getTime() - hb.lastRunAt.getTime();
      return {
        name: hb.name,
        lastRunAt: hb.lastRunAt.toISOString(),
        intervalMs: hb.intervalMs,
        lastError: hb.lastError,
        // Per-worker, not one flat window: a 10-minute sweep is not stale at
        // the same age as a 15-second dispatcher.
        stale: ageMs > heartbeatStaleAfterMs(hb.intervalMs),
        ageMs,
      };
    });

    const staleWorkers = workers.filter((w) => w.stale).length;
    // A worker can keep ticking exactly on schedule while every tick throws:
    // `writeHeartbeat` upserts on success AND failure, so `lastRunAt` stays
    // fresh (`stale: false`) even when the loop's actual job never completes.
    // `lastError` is cleared on the next successful tick, so a non-null value
    // here means the MOST RECENT run failed right now, not stale history —
    // that worker is silently not doing its job and must weigh the same as a
    // fully dead (stale) one, not read as fine just because it is still
    // ticking.
    const erroringWorkers = workers.filter((w) => !w.stale && w.lastError).length;
    const criticalAlerts = activeAlerts.filter((a) => a.severity === "critical").length;

    // NO worker has ever reported. Distinct from "all workers healthy", and the
    // two must not both render green — with the worker process down, nothing
    // drains the job queue, no notification is delivered, no pool is sampled
    // and no audit claim is ever reaped, yet every other signal here looks
    // fine: an empty queue reads as `done`, and a watchdog that never runs
    // raises no alert. Reporting green in that state is the exact dishonest
    // trust claim this project forbids, and it was observed live (API up,
    // worker down, /v1/admin/health -> "green", workers: []).
    //
    // Deliberately amber, not red: a genuinely fresh deployment has no
    // heartbeat until its first tick (15s for `dispatch`, up to 600s for the
    // slow sweeps), so red would cry wolf on every boot. Amber with an explicit
    // reason lets an operator tell "starting up" from "nothing is running",
    // which green never could.
    const noWorkersReporting = workers.length === 0;

    // A dead-lettered job, a dead worker loop, a worker whose last tick
    // errored (still ticking, but not doing its job), or a critical alert is
    // red — each means work is silently not happening. Open circuits, failed
    // (but still retrying) jobs and non-critical alerts are amber.
    const status: "green" | "amber" | "red" =
      deadLetterCount > 0 || staleWorkers > 0 || erroringWorkers > 0 || criticalAlerts > 0
        ? "red"
        : noWorkersReporting || openCircuits.length > 0 || failedJobs > 0 || activeAlerts.length > 0
          ? "amber"
          : "green";

    return reply.send({
      status,
      jobs: {
        byStatus,
        deadLetterCount,
        oldestRunnable: oldestRunnable
          ? { type: oldestRunnable.type, ageMs: now.getTime() - oldestRunnable.createdAt.getTime() }
          : null,
      },
      workers,
      // Explicit, so the console can say WHY it is amber instead of leaving an
      // operator to infer it from an empty list.
      noWorkersReporting,
      // No cache/Redis client exists in this codebase.
      cache: { driver: "not_configured", circuitOpen: false },
      providerCircuits: openCircuits.map((c) => ({
        provider: c.provider,
        consecutiveFailures: c.consecutiveFailures,
        openUntil: c.openUntil!.toISOString(),
      })),
      activeAlerts: activeAlerts.map((a) => ({
        code: a.code,
        dedupeKey: a.dedupeKey,
        severity: a.severity,
        context: (a.context ?? {}) as Record<string, unknown>,
        firstSeenAt: a.firstSeenAt.toISOString(),
        lastSeenAt: a.lastSeenAt.toISOString(),
      })),
    });
  });
}
