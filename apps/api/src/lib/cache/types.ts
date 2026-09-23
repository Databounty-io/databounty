// SPDX-License-Identifier: Apache-2.0

/**
 * Pluggable cache seam, mirroring this codebase's existing driver pattern
 * (StorageDriver, ChannelAdapter, execution SandboxProvider): one interface,
 * swappable drivers, selected by configuration rather than by import.
 *
 * Ported from v1 `src/lib/cache/types.ts`. The rebuild had no cache
 * abstraction at all — `ioredis` sat in `package.json` imported by nothing,
 * and the one cache that existed (`lib/public-read-cache.ts`) was a bare
 * in-process Map with no way to reach a shared tier. That is fine for a
 * single instance and becomes wrong the moment a second one runs.
 *
 * THE HARD RULE, unchanged from v1: the cache is never load-bearing for
 * correctness. Enabled, disabled, or DOWN, the application behaves
 * identically — a cache outage is indistinguishable from a miss and falls
 * through to the database path. Every method below is specified so that
 * failure is silent and safe.
 *
 * WHAT MAY BE CACHED: cheap, caller-independent, reconstructible reads —
 * public catalog pages, taxonomy and meta lists, session and API-key
 * verification, rate-limit counters. NEVER validation results, contamination
 * verdicts, execution evidence, or trust badges: those are claims about what
 * the platform verified, and a stale one is a lie rather than a slow answer.
 */
export interface CacheProvider {
  /** The cached value, or null on a miss OR on any cache failure. */
  get<T>(key: string): Promise<T | null>;
  /** Best-effort write. Never throws. */
  set<T>(key: string, val: T, ttlSec: number): Promise<void>;
  /** Best-effort delete — the mechanism invalidation-on-write depends on. */
  del(key: string | string[]): Promise<void>;
  /**
   * Stampede-safe read-through: on a miss exactly one concurrent caller per
   * key runs `load()`, the rest await its result. On any cache failure this
   * degrades to simply running `load()`.
   */
  getOrLoad<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T>;
  /**
   * Atomic counter with a TTL set on the FIRST increment only, so a steady
   * request stream cannot keep extending its own window. Returns the
   * post-increment count, or null when the driver cannot do this atomically
   * (Noop always; Redis while its circuit is open) so the caller falls back
   * to its database path.
   */
  incr(key: string, ttlSec: number): Promise<number | null>;
}
