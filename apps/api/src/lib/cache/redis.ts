// SPDX-License-Identifier: Apache-2.0

import { Redis } from "ioredis";
import type { CacheProvider } from "./types.js";
import { SingleFlight } from "./single-flight.js";

/**
 * Real Redis behind a circuit breaker. Ported from v1 `src/lib/cache/redis.ts`.
 *
 * THE BREAKER IS NOT OPTIONAL. Every operation has a hard timeout and is
 * wrapped so any error or timeout logs once and returns a miss/no-op. After
 * FAILURE_THRESHOLD consecutive failures the breaker OPENS and every call
 * fast-fails straight to the database path for OPEN_MS. Without it a SLOW
 * Redis is worse than no Redis: every request would burn the timeout BEFORE
 * reaching the database, turning a cache outage into a full outage. After
 * OPEN_MS exactly one probe is let through (half-open); success closes it.
 */
const FAILURE_THRESHOLD = 5;
const OPEN_MS = 30_000;
const OP_TIMEOUT_MS = 250;

type Logger = { warn: (obj: unknown, msg: string) => void };

export class RedisCache implements CacheProvider {
  private redis: Redis;
  private flights = new SingleFlight();
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private probing = false;
  private ready: Promise<void>;

  constructor(
    redisUrl: string,
    private logger: Logger = { warn: () => {} },
  ) {
    this.redis = new Redis(redisUrl, {
      // The breaker owns retry policy; ioredis must not queue commands
      // forever while disconnected or block on its own long retries.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    // ioredis emits 'error' on connection problems and an unhandled listener
    // would take the process down. The breaker already accounts for failures
    // at each call site, so this is deliberately swallowed.
    this.redis.on("error", () => {});
    // `lazyConnect` + `enableOfflineQueue: false` means the socket is not
    // connected yet AND commands issued before it is are rejected rather than
    // queued. Starting connect() here is not enough on its own — the first
    // real call can still race ahead of it — so `guarded()` awaits this,
    // bounded by the same per-op timeout. A healthy Redis is therefore
    // connected before the first command; an unreachable one degrades within
    // OP_TIMEOUT_MS instead of blocking for the full connectTimeout.
    this.ready = this.redis.connect().catch(() => {});
  }

  /**
   * The underlying connection, for the one kind of consumer that needs a
   * concrete client rather than this interface (a rate-limit store, say).
   * This module stays the sole owner of Redis lifecycle: callers borrow, they
   * never construct or close it.
   */
  get client(): Redis {
    return this.redis;
  }

  /** Visible for tests and the health panel. */
  get circuitOpen(): boolean {
    if (this.consecutiveFailures < FAILURE_THRESHOLD) return false;
    return Date.now() - this.openedAtMs < OPEN_MS;
  }

  private allowCall(): boolean {
    if (this.consecutiveFailures < FAILURE_THRESHOLD) return true;
    if (Date.now() - this.openedAtMs >= OPEN_MS && !this.probing) {
      // Half-open: exactly one probe goes through, everyone else fast-fails
      // until it settles.
      this.probing = true;
      return true;
    }
    return false;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.probing = false;
  }

  private recordFailure(op: string, err: unknown): void {
    this.consecutiveFailures += 1;
    this.probing = false;
    if (this.consecutiveFailures === FAILURE_THRESHOLD) {
      this.openedAtMs = Date.now();
      this.logger.warn({ op, err }, "cache: circuit opened — Redis unavailable, degrading to the database path");
    }
  }

  /** Run one operation with timeout + breaker; any failure resolves `fallback`. */
  private async guarded<T>(op: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    if (!this.allowCall()) return fallback;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.ready.then(fn),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("cache op timeout")), OP_TIMEOUT_MS);
        }),
      ]);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(op, err);
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    return this.guarded(
      "get",
      async () => {
        const raw = await this.redis.get(key);
        return raw === null ? null : (JSON.parse(raw) as T);
      },
      null,
    );
  }

  async set<T>(key: string, val: T, ttlSec: number): Promise<void> {
    if (ttlSec <= 0) return;
    await this.guarded(
      "set",
      async () => {
        await this.redis.set(key, JSON.stringify(val), "EX", ttlSec);
      },
      undefined,
    );
  }

  async del(key: string | string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key];
    if (keys.length === 0) return;
    await this.guarded(
      "del",
      async () => {
        await this.redis.del(...keys);
      },
      undefined,
    );
  }

  async getOrLoad<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    // Single-flight is per-instance; across instances the short TTL bounds
    // how many duplicate loads a cold key can cause.
    return this.flights.run(key, async () => {
      const again = await this.get<T>(key);
      if (again !== null) return again;
      const val = await load();
      if (val !== null && val !== undefined) await this.set(key, val, ttlSec);
      return val;
    });
  }

  async incr(key: string, ttlSec: number): Promise<number | null> {
    return this.guarded(
      "incr",
      async () => {
        const count = await this.redis.incr(key);
        // Expiry is set only on the first increment of a window, so a steady
        // stream cannot extend its own window indefinitely.
        if (count === 1) await this.redis.expire(key, ttlSec);
        return count;
      },
      // null means "no atomic counter available" → the caller falls back.
      null,
    );
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
