// SPDX-License-Identifier: Apache-2.0

/**
 * Contract coverage for public-read cache INVALIDATION.
 *
 * WHY THIS EXISTS. The cache shipped with `clearPublicReadCache()` exported
 * and a comment offering it to "any future write path" — and no write path
 * ever called it. Every caller was a test. That made the public catalog
 * purely TTL-stale: an admin who minted a pool, or a publish that flipped a
 * dataset to published, would not appear on the public page for up to a
 * minute, with nothing to do but wait and wonder whether the action worked.
 *
 * v1 does not accept that. Its cache layer invalidates explicitly on write,
 * and its in-process tier is additionally capped at 10 seconds
 * (`lib/cache/tiered.ts`, L1_TTL_CAP_SEC) precisely because a per-process
 * cache cannot be invalidated from another instance. This port has only the
 * in-process tier, at 60 seconds, so wiring invalidation is what keeps it
 * from being a downgrade on freshness.
 *
 * These are unit tests on purpose: the invariants are about the cache's own
 * behaviour, and asserting them here means they hold for every call site
 * rather than for whichever route a test happened to exercise.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cachedPublicRead,
  clearPublicReadCache,
  publicReadCacheKey,
  publicReadCacheSize,
} from "./public-read-cache.js";

const TTL = 60_000;

afterEach(() => clearPublicReadCache());

describe("public read cache invalidation", () => {
  it("serves a second read from cache, then a fresh value after invalidation", async () => {
    // The whole point: a write happens, the cache is cleared, and the very
    // next read reflects the write instead of the minute-old body.
    let computed = 0;
    const read = () => cachedPublicRead("catalog", async () => ++computed, TTL);

    expect(await read()).toBe(1);
    expect(await read()).toBe(1); // cached — no recompute
    expect(computed).toBe(1);

    clearPublicReadCache();

    expect(await read()).toBe(2); // invalidated — recomputed
  });

  it("clears every key, not just one route", async () => {
    // The catalog and the stats body are separate keys but share a source of
    // truth: minting a pool changes both. A partial clear would leave one of
    // them contradicting the other.
    await cachedPublicRead(publicReadCacheKey("community.catalog", { limit: 5 }), async () => "a", TTL);
    await cachedPublicRead(publicReadCacheKey("community.stats"), async () => "b", TTL);
    expect(publicReadCacheSize()).toBe(2);

    clearPublicReadCache();

    expect(publicReadCacheSize()).toBe(0);
  });

  it("does not cache a failed computation", async () => {
    // A transient database error must not be pinned as the answer for the
    // rest of the TTL — that would turn one blip into a minute of outage.
    await expect(
      cachedPublicRead("boom", async () => {
        throw new Error("db down");
      }, TTL),
    ).rejects.toThrow("db down");

    expect(publicReadCacheSize()).toBe(0);
    expect(await cachedPublicRead("boom", async () => "recovered", TTL)).toBe("recovered");
  });

  it("collapses concurrent misses into one computation", async () => {
    // Single-flight. Without it, a burst on a cold key (exactly what a health
    // probe or a link going round a team produces) is N identical database
    // reads instead of one.
    let computed = 0;
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return ++computed;
    };

    const results = await Promise.all([
      cachedPublicRead("hot", slow, TTL),
      cachedPublicRead("hot", slow, TTL),
      cachedPublicRead("hot", slow, TTL),
    ]);

    expect(computed).toBe(1);
    expect(results).toEqual([1, 1, 1]);
  });

  it("treats a zero TTL as a full bypass", async () => {
    // How the integration suite sees writes immediately, and the operator's
    // escape hatch if the cache ever needs switching off in production.
    let computed = 0;
    const read = () => cachedPublicRead("nocache", async () => ++computed, 0);

    expect(await read()).toBe(1);
    expect(await read()).toBe(2);
    expect(publicReadCacheSize()).toBe(0);
  });

  it("builds the same key regardless of parameter order, and ignores undefined", async () => {
    // Key stability is what makes the cache hit at all. If `{a,b}` and `{b,a}`
    // produced different keys the cache would quietly degrade to a miss on
    // every request while still looking healthy.
    expect(publicReadCacheKey("r", { b: 2, a: 1 })).toBe(publicReadCacheKey("r", { a: 1, b: 2 }));
    expect(publicReadCacheKey("r", { a: 1, b: undefined })).toBe(publicReadCacheKey("r", { a: 1 }));
    // Distinct values must NOT collide — a string that looks like a separator
    // is the classic way a hand-rolled key builder starts serving one
    // caller's body to another.
    expect(publicReadCacheKey("r", { a: "1&b=2" })).not.toBe(publicReadCacheKey("r", { a: "1", b: "2" }));
  });
});
