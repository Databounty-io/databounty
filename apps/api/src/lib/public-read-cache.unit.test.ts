// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedPublicRead,
  clearPublicReadCache,
  publicReadCacheKey,
  publicReadCacheSize,
  publicReadCacheTtlMs,
} from "./public-read-cache.js";

describe("public-read-cache", () => {
  const savedTtl = process.env.PUBLIC_READ_CACHE_TTL_MS;
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    clearPublicReadCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedTtl === undefined) delete process.env.PUBLIC_READ_CACHE_TTL_MS;
    else process.env.PUBLIC_READ_CACHE_TTL_MS = savedTtl;
    process.env.NODE_ENV = savedNodeEnv;
  });

  it("defaults to 0 (bypass) under NODE_ENV=test and 60s elsewhere", () => {
    delete process.env.PUBLIC_READ_CACHE_TTL_MS;
    process.env.NODE_ENV = "test";
    expect(publicReadCacheTtlMs()).toBe(0);
    process.env.NODE_ENV = "production";
    expect(publicReadCacheTtlMs()).toBe(60_000);
    process.env.PUBLIC_READ_CACHE_TTL_MS = "1500";
    expect(publicReadCacheTtlMs()).toBe(1500);
    process.env.PUBLIC_READ_CACHE_TTL_MS = "not-a-number";
    expect(publicReadCacheTtlMs()).toBe(60_000);
    process.env.PUBLIC_READ_CACHE_TTL_MS = "-5";
    expect(publicReadCacheTtlMs()).toBe(60_000);
  });

  it("keys are order-independent and ignore undefined params", () => {
    expect(publicReadCacheKey("r", { b: 2, a: "x" })).toBe(publicReadCacheKey("r", { a: "x", b: 2 }));
    expect(publicReadCacheKey("r", { a: "x", b: undefined })).toBe(publicReadCacheKey("r", { a: "x" }));
    expect(publicReadCacheKey("r", { a: "x" })).not.toBe(publicReadCacheKey("other", { a: "x" }));
    expect(publicReadCacheKey("r", { limit: 24 })).not.toBe(publicReadCacheKey("r", { limit: "24" }));
  });

  it("serves the cached value inside the TTL and recomputes after it", async () => {
    const compute = vi.fn(async () => ({ n: Math.random() }));
    const first = await cachedPublicRead("k", compute, 1000);
    const second = await cachedPublicRead("k", compute, 1000);
    expect(second).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1001);
    const third = await cachedPublicRead("k", compute, 1000);
    expect(third).not.toBe(first);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("ttl 0 bypasses the cache entirely and stores nothing", async () => {
    const compute = vi.fn(async () => "v");
    await cachedPublicRead("k", compute, 0);
    await cachedPublicRead("k", compute, 0);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(publicReadCacheSize()).toBe(0);
  });

  it("collapses concurrent misses into one computation (single-flight)", async () => {
    let release!: (v: string) => void;
    const compute = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const a = cachedPublicRead("k", compute, 1000);
    const b = cachedPublicRead("k", compute, 1000);
    // Let the pending microtasks run before asserting. The read now goes
    // through the CacheProvider seam (lib/cache/), whose `getOrLoad` awaits a
    // store lookup before invoking the loader and another inside the
    // single-flight, so the call lands a few microtasks later than it did when
    // this module owned a bare Map. `advanceTimersByTimeAsync` drains them
    // under the fake timers this suite installs (a real `setTimeout` would
    // never fire); the contract asserted here — ONE computation shared by both
    // callers — is unchanged.
    await vi.advanceTimersByTimeAsync(0);
    expect(compute).toHaveBeenCalledTimes(1);
    release("shared");
    expect(await a).toBe("shared");
    expect(await b).toBe("shared");
  });

  it("never caches a failure: the error reaches every waiter and the next call recomputes", async () => {
    let calls = 0;
    const compute = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return "ok";
    });
    await expect(cachedPublicRead("k", compute, 1000)).rejects.toThrow("boom");
    expect(publicReadCacheSize()).toBe(0);
    expect(await cachedPublicRead("k", compute, 1000)).toBe("ok");
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("bounds the number of live entries", async () => {
    for (let i = 0; i < 600; i += 1) {
      await cachedPublicRead(`k${i}`, async () => i, 60_000);
    }
    expect(publicReadCacheSize()).toBeLessThanOrEqual(512);
    // The newest key survives eviction; the oldest does not.
    expect(await cachedPublicRead("k599", async () => -1, 60_000)).toBe(599);
    expect(await cachedPublicRead("k0", async () => -1, 60_000)).toBe(-1);
  });
});
