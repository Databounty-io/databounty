// SPDX-License-Identifier: Apache-2.0

import type { Redis } from "ioredis";
import { config } from "../../config.js";
import type { CacheProvider } from "./types.js";
import { NoopCache } from "./noop.js";
import { MemoryCache } from "./memory.js";
import { RedisCache } from "./redis.js";
import { TieredCache } from "./tiered.js";

export type { CacheProvider } from "./types.js";
export { MemoryCache } from "./memory.js";
export { NoopCache } from "./noop.js";
export { RedisCache } from "./redis.js";
export { TieredCache } from "./tiered.js";

function buildCache(): CacheProvider {
  switch (config.cache.driver) {
    case "memory":
      return new MemoryCache();
    case "redis":
      if (!config.cache.redisUrl) {
        // A misconfiguration must not take the application down — the whole
        // point of this layer is that "no cache" is always a valid state.
        // Loud at boot, then behave exactly as if the driver were off.
        console.warn("CACHE_DRIVER=redis but REDIS_URL is empty — cache disabled (NoopCache).");
        return new NoopCache();
      }
      // L1 in front of L2: a key this instance served moments ago answers
      // from process memory instead of paying a Redis round trip. See
      // tiered.ts for the staleness bound that makes L1 safe.
      return new TieredCache(new RedisCache(config.cache.redisUrl, console));
    default:
      return new NoopCache();
  }
}

/**
 * The process-wide cache. With `CACHE_DRIVER` unset this is a `NoopCache` and
 * every consumer behaves exactly as it did before this layer existed.
 */
export const cache: CacheProvider = buildCache();

/** Health-panel view: which driver is live, and whether Redis's circuit
 *  breaker is currently open (degraded to the database path). */
export function cacheStatus(): { driver: "noop" | "memory" | "redis"; circuitOpen: boolean } {
  const l2 = cache instanceof TieredCache ? cache.l2 : cache;
  return {
    driver: config.cache.driver,
    circuitOpen: l2 instanceof RedisCache ? l2.circuitOpen : false,
  };
}

/**
 * The shared Redis connection, or null when the active driver is not
 * Redis-backed. The single accessor for code that genuinely needs the
 * concrete client rather than the `CacheProvider` abstraction — a rate-limit
 * store, for instance. Everything else goes through `cache`; nobody
 * constructs `new Redis()` outside this module.
 */
export function sharedRedisClient(): Redis | null {
  const l2 = cache instanceof TieredCache ? cache.l2 : cache;
  return l2 instanceof RedisCache ? l2.client : null;
}
