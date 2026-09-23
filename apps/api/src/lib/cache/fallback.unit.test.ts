// SPDX-License-Identifier: Apache-2.0

/**
 * The fallback contract: what this service does when the cache is off, or up
 * and then suddenly not.
 *
 * `types.ts` states the rule the whole layer rests on — "the cache is never
 * load-bearing for correctness: enabled, disabled, or DOWN, the app behaves
 * identically". `cache.test.ts` proves each driver honours that in isolation.
 * This file asserts the two things a driver test cannot: that the composition
 * we actually deploy degrades correctly, and that degrading does not quietly
 * undo the reason the cache was added.
 *
 * That second point is the one worth spelling out. A cache existing purely for
 * speed may fail open to "no cache" with no consequence. This one exists to
 * stop a measured ~10 GB/day of database egress. If a Redis outage turned it
 * into a straight pass-through, every request would hit Postgres again and a
 * cache incident would become a database incident — the same shape of
 * cascading failure the circuit breaker exists to prevent, one layer up. The
 * tiered driver is what stops that: L1 keeps absorbing reads (bounded to
 * L1_TTL_CAP_SEC) while L2 is unreachable.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./memory.js";
import { NoopCache } from "./noop.js";
import { RedisCache } from "./redis.js";
import { TieredCache } from "./tiered.js";

/** A RedisCache whose client is replaced before it can reach a real server. */
function deadRedis(): RedisCache {
  const cache = new RedisCache("redis://127.0.0.1:1", { warn: () => {} });
  const internal = cache as unknown as { redis: { disconnect: () => void } };
  internal.redis.disconnect();
  const rejecting = () => Promise.reject(new Error("ECONNREFUSED"));
  internal.redis = {
    get: rejecting,
    set: rejecting,
    del: rejecting,
    incr: rejecting,
    expire: rejecting,
    on: () => {},
    disconnect: () => {},
  } as unknown as { disconnect: () => void };
  return cache;
}

describe("cache fallback", () => {
  it("serves correct data with the cache switched off entirely", async () => {
    // The default deployment state. Every read is a miss and the loader runs,
    // so behaviour is identical to having no cache layer at all.
    const cache = new NoopCache();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return { value: calls };
    };

    expect(await cache.getOrLoad("k", 60, load)).toEqual({ value: 1 });
    expect(await cache.getOrLoad("k", 60, load)).toEqual({ value: 2 });
    expect(calls).toBe(2);
  });

  it("serves correct data when Redis is unreachable", async () => {
    // Fail-open: every Redis operation rejects, and the caller still gets the
    // right answer from the database path rather than an error.
    const cache = deadRedis();
    expect(await cache.getOrLoad("k", 60, async () => "from-db")).toBe("from-db");
    expect(await cache.get("k")).toBeNull();
    await expect(cache.set("k", "v", 60)).resolves.toBeUndefined();
    await expect(cache.del("k")).resolves.toBeUndefined();
  });

  it("returns null from incr when Redis is down, so rate limiting falls back", async () => {
    // `incr` must NOT invent a count. A fabricated low number would silently
    // disable a rate limit; null tells the caller to use its database path,
    // which is what `lib/mcp-rate-limit.ts` already does.
    const cache = deadRedis();
    expect(await cache.incr("rl", 60)).toBeNull();
  });

  it("keeps absorbing reads from L1 while Redis is unreachable", async () => {
    // THE IMPORTANT ONE. With Redis down the tiered driver must not become a
    // pass-through, or a cache outage turns straight into a database outage —
    // every request that the cache was added to absorb lands on Postgres at
    // once.
    const cache = new TieredCache(deadRedis());
    const load = vi.fn(async () => "expensive");

    expect(await cache.getOrLoad("hot", 60, load)).toBe("expensive");
    expect(await cache.getOrLoad("hot", 60, load)).toBe("expensive");
    expect(await cache.getOrLoad("hot", 60, load)).toBe("expensive");

    // One database read for three requests, despite L2 being dead throughout.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("caps how stale an L1 answer can be, since L2 cannot invalidate it", async () => {
    // L1 is per-process and no other instance can clear it, so the tier
    // shortens any TTL it is given. A caller asking for 10 minutes gets at
    // most L1_TTL_CAP_SEC of staleness out of this tier.
    const l2 = new MemoryCache();
    const cache = new TieredCache(l2);
    await cache.set("k", "v", 600);

    const l1 = (cache as unknown as { l1: MemoryCache }).l1;
    const entry = (l1 as unknown as { store: Map<string, { expiresAtMs: number }> }).store.get("k");

    expect(entry).toBeDefined();
    const ttlMs = entry!.expiresAtMs - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(10_000);
    // L2 keeps the full TTL — only the un-invalidatable tier is shortened.
    const l2Entry = (l2 as unknown as { store: Map<string, { expiresAtMs: number }> }).store.get("k");
    expect(l2Entry!.expiresAtMs - Date.now()).toBeGreaterThan(60_000);
  });

  it("never lets a cache failure surface as a request failure", async () => {
    // Every method is best-effort by contract. A caller must never need a
    // try/catch around a cache call.
    const cache = deadRedis();
    await expect(
      Promise.all([cache.get("a"), cache.set("a", 1, 60), cache.del("a"), cache.incr("a", 60)]),
    ).resolves.toBeDefined();
  });
});
