// SPDX-License-Identifier: Apache-2.0

import type { CacheProvider } from "./types.js";
import { MemoryCache } from "./memory.js";

/**
 * L1 (in-process) in front of an L2 driver (Redis in production). A hot key
 * this instance served moments ago answers from process memory instead of
 * paying a network round trip every time; only a genuine L1 miss falls
 * through to L2, and then to L2's own database fallback.
 *
 * Ported from v1 `src/lib/cache/tiered.ts`.
 *
 * CORRECTNESS BOUND — the reason this class exists rather than just using
 * Redis directly: L1 is per-process and is NOT invalidated by writes on OTHER
 * instances, so its TTL is capped at L1_TTL_CAP_SEC regardless of what the
 * caller asked for. That is the same "the cache is never load-bearing for
 * correctness" rule as the rest of this layer, applied to cross-instance
 * staleness instead of to a Redis outage. `del()` clears both tiers on THIS
 * instance immediately; other instances' L1 copies expire within the cap.
 *
 * This cap is exactly what the rebuild's standalone `lib/public-read-cache.ts`
 * lacked: it ran a 60-second in-process TTL with no shared tier, which is safe
 * only while a single instance runs.
 *
 * `incr` is deliberately NOT tiered — an atomic counter (rate limits, version
 * counters) needs one shared source of truth. Tiering it would let each
 * instance count independently and silently break the semantics documented on
 * `CacheProvider#incr`. It passes straight through to L2.
 */
const L1_TTL_CAP_SEC = 10;

export class TieredCache implements CacheProvider {
  private l1 = new MemoryCache();

  /** Visible so a health panel can see through this wrapper to the real L2
   *  and report its circuit-breaker state. */
  constructor(readonly l2: CacheProvider) {}

  async get<T>(key: string): Promise<T | null> {
    const l1Hit = await this.l1.get<T>(key);
    if (l1Hit !== null) return l1Hit;
    const l2Hit = await this.l2.get<T>(key);
    if (l2Hit !== null) await this.l1.set(key, l2Hit, L1_TTL_CAP_SEC);
    return l2Hit;
  }

  async set<T>(key: string, val: T, ttlSec: number): Promise<void> {
    await Promise.all([
      this.l1.set(key, val, Math.min(ttlSec, L1_TTL_CAP_SEC)),
      this.l2.set(key, val, ttlSec),
    ]);
  }

  async del(key: string | string[]): Promise<void> {
    await Promise.all([this.l1.del(key), this.l2.del(key)]);
  }

  async getOrLoad<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
    const l1Hit = await this.l1.get<T>(key);
    if (l1Hit !== null) return l1Hit;
    const val = await this.l2.getOrLoad(key, ttlSec, load);
    if (val !== null && val !== undefined) {
      await this.l1.set(key, val, Math.min(ttlSec, L1_TTL_CAP_SEC));
    }
    return val;
  }

  /** Deliberately not tiered — see the class comment. Always the shared counter. */
  async incr(key: string, ttlSec: number): Promise<number | null> {
    return this.l2.incr(key, ttlSec);
  }
}
