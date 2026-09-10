// SPDX-License-Identifier: Apache-2.0

/**
 * Notification dispatch worker runtime — the scheduling/lifecycle layer.
 *
 * Ported verbatim-in-spirit from v1's services/notifications/worker.ts. It
 * knows nothing about channels, Prisma, or how a tick does its work: the unit
 * of work is injected as `runOnce`. That keeps the loop (scheduling,
 * non-overlap, error isolation, shutdown) fully decoupled from dispatch
 * logic, so the same runtime drives the dispatch poller and the digest
 * flusher.
 *
 * Horizontal scaling: run N of these. Concurrency safety comes from the DB
 * layer — each delivery is claimed with a lease before it is sent (see
 * `dispatchPendingNotifications`), so overlapping workers never double-send.
 */

export interface NotificationWorkerOptions {
  /** One unit of work. Injected, not imported. */
  runOnce: () => Promise<unknown>;
  /** Poll cadence in ms (floored at 1s to avoid a hot loop). */
  intervalMs?: number;
  /** Tick error sink. Defaults to console.error; a thrown tick is never fatal. */
  onError?: (err: unknown) => void;
  /** Optional label for logs when running several workers. */
  name?: string;
}

export interface NotificationWorker {
  /** Begin polling. Idempotent. */
  start(): void;
  /** Stop polling; resolves once any in-flight tick settles. */
  stop(): Promise<void>;
  /** True while a tick is executing (for tests/health). */
  readonly isBusy: boolean;
}

export function createNotificationWorker(opts: NotificationWorkerOptions): NotificationWorker {
  const intervalMs = Math.max(opts.intervalMs ?? 15_000, 1_000);
  const label = opts.name ? `[notifications:${opts.name}]` : "[notifications]";
  const onError = opts.onError ?? ((err) => console.error(`${label} dispatch tick failed`, err));

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    // Non-overlapping: a tick never runs concurrently with itself, so a
    // backlog of runs cannot pile up against a slow mailer.
    if (inFlight) return;
    inFlight = (async () => {
      try {
        await opts.runOnce();
      } catch (err) {
        onError(err);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };

  // Self-rescheduling instead of setInterval: with a fixed interval a tick
  // that overran the period had the NEXT firing dropped by the `inFlight`
  // guard, silently halving the poll rate exactly when the queue was most
  // backed up. Here the next tick is scheduled once the previous settles.
  const scheduleNext = (delayMs: number) => {
    if (!running) return;
    timer = setTimeout(() => {
      void (async () => {
        const startedAt = Date.now();
        await tick();
        scheduleNext(Math.max(0, intervalMs - (Date.now() - startedAt)));
      })();
    }, delayMs);
    // Don't hold the event loop open on shutdown.
    timer.unref?.();
  };

  return {
    start() {
      if (running) return;
      running = true;
      scheduleNext(0);
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
    },
    get isBusy() {
      return inFlight !== null;
    },
  };
}
