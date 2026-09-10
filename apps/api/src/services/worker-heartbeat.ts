// SPDX-License-Identifier: Apache-2.0

import { prisma } from "../lib/prisma.js";
import {
  createNotificationWorker,
  type NotificationWorker,
  type NotificationWorkerOptions,
} from "./notifications/worker.js";

/**
 * Heartbeat-wrapped worker loop: every tick — success OR failure — upserts a
 * `worker_heartbeats` row. The watchdog alerts on the ABSENCE of a fresh row,
 * which catches the one failure mode that emits no error at all: a fully
 * dead/never-scheduled worker. A failing-but-ticking worker stays "alive" here
 * and surfaces through `lastError` instead.
 *
 * The heartbeat write itself is best-effort: a DB blip must not turn a healthy
 * tick into a failed one.
 *
 * Ported from v1 `src/services/worker-heartbeat.ts`. This rebuild had no
 * heartbeat table at all, so `routes/v1/admin-health.ts` reported an
 * permanently-empty `workers` list.
 */
export function createHeartbeatWorker(
  opts: NotificationWorkerOptions & { name: string; tickTimeoutMs?: number }
): NotificationWorker {
  const intervalMs = Math.max(opts.intervalMs ?? 15_000, 1_000);
  const tickTimeoutMs = opts.tickTimeoutMs ?? defaultTickTimeoutMs(intervalMs);
  return createNotificationWorker({
    ...opts,
    runOnce: async () => {
      try {
        const result = await withTickTimeout(opts.name, opts.runOnce(), tickTimeoutMs);
        await writeHeartbeat(opts.name, intervalMs, null);
        return result;
      } catch (err) {
        await writeHeartbeat(opts.name, intervalMs, errorMessage(err));
        throw err; // keep the worker runtime's onError reporting intact
      }
    },
  });
}

/**
 * A tick that never SETTLES is the one failure this heartbeat could not report.
 * The runtime is self-rescheduling and guards against overlap with an in-flight
 * promise, so a `runOnce` that hangs forever (a query blocked on a row lock with
 * no `statement_timeout`, a socket with no deadline) both stops the loop
 * permanently and writes no heartbeat and no error — the worker is dead, and
 * only the watchdog's ABSENCE alert fires, minutes later, with nothing naming
 * the cause. Racing the tick against a deadline converts that silent death into
 * a loud, attributable failure.
 *
 * The abandoned promise keeps running — JS cannot cancel it — so the next tick
 * may overlap with it. That is safe for these workers by construction: the job
 * queue claim is a conditional single-row update, which is the same property
 * that lets several worker processes run concurrently. Overlap is the
 * documented model, not a new risk.
 */
async function withTickTimeout<T>(name: string, work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `worker tick exceeded ${timeoutMs}ms and was abandoned; it may still be running (check for a blocked query or a request without a timeout)`
              )
            ),
          timeoutMs
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // An abandoned tick that later rejects must not surface as an
    // unhandledRejection and take the process down with it.
    void work.catch((err) => {
      console.warn(`[worker-heartbeat] abandoned tick for ${name} later failed:`, errorMessage(err));
    });
  }
}

/**
 * Generous by design: the deadline exists to catch a hang, not to police a slow
 * tick. Anything doing legitimately long work should report progress through
 * `touchWorkerHeartbeat` below rather than have this lowered for it.
 */
function defaultTickTimeoutMs(intervalMs: number): number {
  const raw = Number(process.env.WORKER_TICK_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw; // 0 disables the deadline
  return Math.max(20 * intervalMs, 600_000);
}

/**
 * Mark a worker alive MID-tick, for a loop whose single tick can legitimately
 * run longer than its staleness window.
 *
 * The wrapper above writes only after `runOnce` returns, and staleness is
 * `max(3 × intervalMs, 120s)` — so a worker doing real long work (a harness
 * proof run is up to `MAX_PROOF_SAMPLES × execution timeout`) would be reported
 * stale while it was working correctly, and a false operational alert costs an
 * operator the same attention a real one does.
 */
export async function touchWorkerHeartbeat(name: string, intervalMs: number): Promise<void> {
  await writeHeartbeat(name, intervalMs, null);
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

async function writeHeartbeat(name: string, intervalMs: number, lastError: string | null): Promise<void> {
  const now = new Date();
  await prisma.workerHeartbeat
    .upsert({
      where: { name },
      create: { name, lastRunAt: now, intervalMs, lastError },
      update: { lastRunAt: now, intervalMs, lastError },
    })
    .catch((err) => {
      console.warn(`[worker-heartbeat] failed to record heartbeat for ${name}:`, errorMessage(err));
    });
}

/**
 * A worker is stale once it has missed several consecutive ticks. The 3×
 * multiplier tolerates one slow/skipped tick; the 2-minute floor stops tight
 * cadences (15s dispatch) from flapping on ordinary GC/deploy pauses.
 */
export function heartbeatStaleAfterMs(intervalMs: number): number {
  return Math.max(3 * intervalMs, 120_000);
}
