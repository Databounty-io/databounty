// SPDX-License-Identifier: Apache-2.0

import { config } from "../config.js";
import { cache, MemoryCache, type CacheProvider } from "./cache/index.js";

/**
 * Read-through cache for unauthenticated, caller-independent public reads.
 *
 * WHY THIS EXISTS (2026-09-22): the two public routes behind the landing site
 * — `GET /v1/community/catalog` and `GET /v1/community/stats` — were recomputed
 * from Postgres on every request. A catalog call returns every active dataset
 * type plus a page of bounties plus four grouped rollups, roughly 200 KB of
 * database egress each. Measured with `pg_stat_statements` on both Supabase
 * projects, those two routes were 85%+ of a steady ~10 GB/day, and the callers
 * were not people: the landing container's own health probe re-rendered the
 * SSR homepage every 15 seconds.
 *
 * SCOPE, deliberately narrow:
 *  - Only responses that do not depend on the caller. Keys are built from
 *    validated query parameters alone — never headers, cookies or the session
 *    — so a cached body is safe to hand to anyone.
 *  - Time-bounded staleness, plus explicit invalidation on the writes that
 *    change these bodies (see `clearPublicReadCache`).
 *  - Errors are never cached: a failed load is rethrown and the key stays
 *    empty, so one database blip cannot become a minute of outage.
 *
 * STORAGE: this goes through the `CacheProvider` seam (`lib/cache/`), so
 * setting `CACHE_DRIVER=redis` makes it shared across instances with no change
 * here. When no driver is configured the global cache is a `NoopCache`, which
 * would silently switch this off and hand back the egress problem — so this
 * consumer falls back to its own bounded `MemoryCache` instead. The cache being
 * off is a valid state for the layer in general; it is not a valid state for
 * the one thing that exists to stop a known 10 GB/day leak.
 */
const DEFAULT_TTL_MS = 60_000;
const FALLBACK_MAX_ENTRIES = 512;

/** The store this consumer reads through. See the note on `NoopCache` above. */
const store: CacheProvider = config.cache.driver === "noop" ? new MemoryCache(FALLBACK_MAX_ENTRIES) : cache;

/**
 * Generation counter, mixed into every key. Bumping it orphans every entry of
 * the previous generation at once.
 *
 * THIS IS THE INVALIDATION MECHANISM, and it is a generation rather than a
 * "delete everything" for one specific reason: a `clear` that only emptied the
 * store could be immediately undone by a read that was ALREADY in flight when
 * the write committed. That read never saw the write, and when it resolves it
 * writes its pre-write body back under the same key — so an admin who just
 * minted a pool still waits out the full TTL, exactly the bug invalidation was
 * added to fix, and only under load, which is when it matters. A completed
 * fill writes under the generation it started in, so a stale fill lands on a
 * key nobody will read again.
 */
let generation = 0;

export function publicReadCacheTtlMs(): number {
  const raw = process.env.PUBLIC_READ_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === "") {
    // 0 under test so the integration suite sees a write on the very next read.
    return process.env.NODE_ENV === "test" ? 0 : DEFAULT_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TTL_MS;
  return Math.floor(parsed);
}

/**
 * Build a cache key from validated parameters. Order-independent, and
 * `undefined` is skipped so `{a: 1, b: undefined}` and `{a: 1}` share an entry.
 * Values are JSON-encoded, so a parameter containing `&` or `=` cannot forge a
 * second parameter and collide with another caller's key.
 */
export function publicReadCacheKey(route: string, params: Record<string, unknown> = {}): string {
  const parts = Object.keys(params)
    .filter((k) => params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${JSON.stringify(params[k])}`);
  return `${route}?${parts.join("&")}`;
}

export async function cachedPublicRead<T>(
  key: string,
  compute: () => Promise<T>,
  ttlMs: number = publicReadCacheTtlMs(),
): Promise<T> {
  if (ttlMs <= 0) return compute();
  // The generation is part of the key, so an invalidation mid-flight simply
  // moves every future reader to a new key rather than racing the writer.
  return store.getOrLoad(`pr:v${generation}:${key}`, Math.ceil(ttlMs / 1000), compute);
}

/**
 * Invalidate every public-read entry. Called from the write paths that change
 * what these routes return, so someone who just acted sees the result instead
 * of waiting out the TTL.
 *
 * Bumping the generation is O(1) and needs no key enumeration, which is what
 * makes it work over Redis too — where a `KEYS`/`SCAN` sweep would be both slow
 * and racy. Old entries are never read again and expire on their own TTL.
 */
export function clearPublicReadCache(): void {
  generation += 1;
  // The generation bump alone makes old entries unreachable; when this
  // consumer owns its store, also reclaim them rather than waiting out their
  // TTL in a fixed-size map. Never attempted against a shared store — see
  // MemoryCache.clear for why.
  if (store instanceof MemoryCache) store.clear();
}

/** Observability hook for tests: live entries, when this consumer owns its store. */
export function publicReadCacheSize(): number {
  return store instanceof MemoryCache ? store.size : -1;
}
