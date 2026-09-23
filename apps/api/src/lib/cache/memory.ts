// SPDX-License-Identifier: Apache-2.0

import type { CacheProvider } from "./types.js";
import { SingleFlight } from "./single-flight.js";

interface Entry {
  val: unknown;
  expiresAtMs: number;
}

/**
 * In-process LRU + TTL cache, for single-instance deployments and as the L1
 * tier in front of Redis. Not shared between instances — see `tiered.ts` for
 * the staleness bound that makes that safe.
 *
 * Values are stored BY REFERENCE, with no serialization round trip. That is
 * what makes this tier cheap, and it means a caller must treat a cached value
 * as immutable: mutating it mutates what every later reader sees. Ported from
 * v1 `src/lib/cache/memory.ts`, which carries the same contract.
 */
export class MemoryCache implements CacheProvider {
  private store = new Map<string, Entry>();
  private flights = new SingleFlight();

  constructor(private maxEntries = 10_000) {}

  private read(key: string): Entry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    // Map iteration order doubles as LRU order: re-insert on read so the
    // eviction loop in `set` drops the least recently USED, not the oldest
    // written.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.read(key);
    return entry ? (entry.val as T) : null;
  }

  async set<T>(key: string, val: T, ttlSec: number): Promise<void> {
    if (ttlSec <= 0) return;
    this.store.delete(key);
    this.store.set(key, { val, expiresAtMs: Date.now() + ttlSec * 1000 });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  async del(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) this.store.delete(k);
  }

  async getOrLoad<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    return this.flights.run(key, async () => {
      // Re-check inside the flight: a concurrent winner may have populated it
      // between the miss above and this callback running.
      const again = await this.get<T>(key);
      if (again !== null) return again;
      const val = await load();
      // Never store null/undefined — a negative result would be
      // indistinguishable from a miss on read, and caching "not found" can
      // outlive the thing being created.
      if (val !== null && val !== undefined) await this.set(key, val, ttlSec);
      return val;
    });
  }

  async incr(key: string, ttlSec: number): Promise<number | null> {
    const entry = this.read(key);
    if (!entry || typeof entry.val !== "number") {
      // The first increment sets the TTL; later ones must NOT extend it, or a
      // steady stream keeps its own rate-limit window alive forever.
      this.store.set(key, { val: 1, expiresAtMs: Date.now() + ttlSec * 1000 });
      return 1;
    }
    const next = (entry.val as number) + 1;
    entry.val = next;
    return next;
  }

  /** Visible for tests and the health panel. */
  get size(): number {
    return this.store.size;
  }

  /**
   * Drop every entry. Only meaningful for a store the caller owns — there is
   * deliberately no equivalent on `CacheProvider`, because "clear everything"
   * over a shared Redis would be both slow (`SCAN`) and wrong (it would evict
   * other consumers). Shared invalidation uses a generation counter instead.
   */
  clear(): void {
    this.store.clear();
  }
}
