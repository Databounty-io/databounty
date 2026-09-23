// SPDX-License-Identifier: Apache-2.0

/**
 * Contract coverage for the cache layer (`lib/cache/`).
 *
 * WHY THIS MATTERS MORE THAN THE USUAL TEST FILE: almost none of this code
 * runs on the current deployment. The active driver is the in-process one; the
 * Redis driver, the tiered wrapper and the whole circuit breaker stay dormant
 * until somebody sets `CACHE_DRIVER=redis`. Dormant resilience code is the
 * worst kind to get wrong, because the first time it executes is the first
 * time Redis is in trouble — exactly when nobody wants to find out that the
 * breaker never opens, or that a hung call blocks the request instead of
 * falling through to the database.
 *
 * So the breaker's state machine is asserted directly against a stubbed
 * client, with no Redis process involved: opens after N consecutive failures,
 * fast-fails without touching the client while open, half-opens after the
 * cooldown, closes on a successful probe, and times out a hung call rather
 * than waiting on it.
 *
 * Ported with its harness from v1 `src/lib/cache/cache.test.ts` — the
 * reference implementation this layer came from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NoopCache } from "./noop.js";
import { MemoryCache } from "./memory.js";
import { RedisCache } from "./redis.js";
import { SingleFlight } from "./single-flight.js";

describe("NoopCache", () => {
  const cache = new NoopCache();

  it("always misses and never stores", async () => {
    await cache.set("k", "v", 60);
    expect(await cache.get("k")).toBeNull();
  });

  it("getOrLoad runs the loader every time (no caching)", async () => {
    const load = vi.fn().mockResolvedValue("fresh");
    expect(await cache.getOrLoad("k", 60, load)).toBe("fresh");
    expect(await cache.getOrLoad("k", 60, load)).toBe("fresh");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("incr returns null so callers use their DB fallback", async () => {
    expect(await cache.incr("rl:x", 60)).toBeNull();
  });
});

describe("SingleFlight", () => {
  it("coalesces concurrent calls for the same key into one execution", async () => {
    const flights = new SingleFlight();
    let running = 0;
    let maxRunning = 0;
    const fn = vi.fn(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
      return "result";
    });
    const results = await Promise.all([
      flights.run("k", fn),
      flights.run("k", fn),
      flights.run("k", fn),
    ]);
    expect(results).toEqual(["result", "result", "result"]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(maxRunning).toBe(1);
  });

  it("does not cache failures — next call retries fresh", async () => {
    const flights = new SingleFlight();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("recovered");
    await expect(flights.run("k", fn)).rejects.toThrow("boom");
    expect(await flights.run("k", fn)).toBe("recovered");
  });

  it("keeps different keys independent", async () => {
    const flights = new SingleFlight();
    const a = vi.fn().mockResolvedValue("a");
    const b = vi.fn().mockResolvedValue("b");
    const [ra, rb] = await Promise.all([flights.run("ka", a), flights.run("kb", b)]);
    expect(ra).toBe("a");
    expect(rb).toBe("b");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("MemoryCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stores and retrieves within TTL", async () => {
    const cache = new MemoryCache();
    await cache.set("k", { a: 1 }, 60);
    expect(await cache.get("k")).toEqual({ a: 1 });
  });

  it("expires entries after TTL", async () => {
    const cache = new MemoryCache();
    await cache.set("k", "v", 30);
    vi.advanceTimersByTime(29_000);
    expect(await cache.get("k")).toBe("v");
    vi.advanceTimersByTime(2_000);
    expect(await cache.get("k")).toBeNull();
  });

  it("deletes single keys and arrays of keys", async () => {
    const cache = new MemoryCache();
    await cache.set("a", 1, 60);
    await cache.set("b", 2, 60);
    await cache.set("c", 3, 60);
    await cache.del("a");
    await cache.del(["b", "c"]);
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("c")).toBeNull();
  });

  it("evicts least-recently-used entries past maxEntries", async () => {
    const cache = new MemoryCache(3);
    await cache.set("a", 1, 60);
    await cache.set("b", 2, 60);
    await cache.set("c", 3, 60);
    await cache.get("a"); // refresh a — b is now least recently used
    await cache.set("d", 4, 60);
    expect(await cache.get("a")).toBe(1);
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("d")).toBe(4);
  });

  it("getOrLoad caches the loaded value", async () => {
    const cache = new MemoryCache();
    const load = vi.fn().mockResolvedValue("loaded");
    expect(await cache.getOrLoad("k", 60, load)).toBe("loaded");
    expect(await cache.getOrLoad("k", 60, load)).toBe("loaded");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("getOrLoad single-flights concurrent misses", async () => {
    vi.useRealTimers();
    const cache = new MemoryCache();
    const load = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "loaded";
    });
    const results = await Promise.all([
      cache.getOrLoad("k", 60, load),
      cache.getOrLoad("k", 60, load),
      cache.getOrLoad("k", 60, load),
    ]);
    expect(results).toEqual(["loaded", "loaded", "loaded"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("incr counts atomically within a window and resets after expiry", async () => {
    const cache = new MemoryCache();
    expect(await cache.incr("rl", 60)).toBe(1);
    expect(await cache.incr("rl", 60)).toBe(2);
    expect(await cache.incr("rl", 60)).toBe(3);
    // Later increments must NOT extend the window: only 60s from the FIRST.
    vi.advanceTimersByTime(61_000);
    expect(await cache.incr("rl", 60)).toBe(1);
  });
});

/** Stub standing in for the ioredis client inside RedisCache. */
interface RedisStub {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function stubRedis(overrides: Partial<RedisStub> = {}): RedisStub {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
    disconnect: vi.fn(),
    ...overrides,
  };
}

function redisCacheWith(stub: RedisStub): RedisCache {
  const cache = new RedisCache("redis://localhost:1", { warn: () => {} });
  const internal = cache as unknown as { redis: { disconnect: () => void } };
  // Never let the real lazy client connect anywhere in tests.
  internal.redis.disconnect();
  internal.redis = stub as unknown as { disconnect: () => void };
  return cache;
}

describe("RedisCache (stubbed client)", () => {
  it("round-trips JSON values", async () => {
    const stub = stubRedis();
    const cache = redisCacheWith(stub);
    await cache.set("k", { n: 1, when: "2026-07-17" }, 60);
    expect(stub.set).toHaveBeenCalledWith("k", JSON.stringify({ n: 1, when: "2026-07-17" }), "EX", 60);
    stub.get.mockResolvedValue(JSON.stringify({ n: 1 }));
    expect(await cache.get("k")).toEqual({ n: 1 });
  });

  it("treats any redis error as a miss (fail-open to DB)", async () => {
    const stub = stubRedis({ get: vi.fn().mockRejectedValue(new Error("conn refused")) });
    const cache = redisCacheWith(stub);
    expect(await cache.get("k")).toBeNull();
  });

  it("getOrLoad still returns loader result when redis is down", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("down"));
    const stub = stubRedis({ get: failing, set: failing });
    const cache = redisCacheWith(stub);
    expect(await cache.getOrLoad("k", 60, async () => "from-db")).toBe("from-db");
  });

  it("incr returns null on failure so rate limiting falls back to the DB", async () => {
    const stub = stubRedis({ incr: vi.fn().mockRejectedValue(new Error("down")) });
    const cache = redisCacheWith(stub);
    expect(await cache.incr("rl", 60)).toBeNull();
  });

  it("incr sets the expiry only on the first count of a window", async () => {
    const stub = stubRedis();
    const cache = redisCacheWith(stub);
    stub.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await cache.incr("rl", 120);
    await cache.incr("rl", 120);
    expect(stub.expire).toHaveBeenCalledTimes(1);
    expect(stub.expire).toHaveBeenCalledWith("rl", 120);
  });

  it("opens the circuit after consecutive failures and fast-fails without calling redis", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("down"));
    const stub = stubRedis({ get: failing });
    const cache = redisCacheWith(stub);
    for (let i = 0; i < 5; i++) await cache.get("k");
    expect(cache.circuitOpen).toBe(true);
    const callsWhenOpened = failing.mock.calls.length;
    await cache.get("k");
    await cache.get("k");
    expect(failing.mock.calls.length).toBe(callsWhenOpened); // fast-fail, no calls
  });

  it("half-opens after the cooldown and closes again on a successful probe", async () => {
    vi.useFakeTimers();
    try {
      const failing = vi.fn().mockRejectedValue(new Error("down"));
      const stub = stubRedis({ get: failing });
      const cache = redisCacheWith(stub);
      for (let i = 0; i < 5; i++) await cache.get("k");
      expect(cache.circuitOpen).toBe(true);
      vi.advanceTimersByTime(31_000);
      stub.get = vi.fn().mockResolvedValue(JSON.stringify("v"));
      expect(await cache.get("k")).toBe("v"); // probe succeeds
      expect(cache.circuitOpen).toBe(false);
      expect(await cache.get("k")).toBe("v"); // fully closed again
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out hung redis calls instead of blocking the request", async () => {
    vi.useFakeTimers();
    try {
      const never = vi.fn(() => new Promise(() => {}));
      const stub = stubRedis({ get: never as never });
      const cache = redisCacheWith(stub);
      const pending = cache.get("k");
      await vi.advanceTimersByTimeAsync(300);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
