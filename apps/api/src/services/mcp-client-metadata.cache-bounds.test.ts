// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_METADATA_CACHE_MAX_ENTRIES,
  CLIENT_METADATA_DEFAULT_TTL_MS,
  CLIENT_METADATA_NEGATIVE_TTL_MS,
  ClientMetadataError,
  clearClientMetadataCache,
  clientMetadataCacheSize,
  clientMetadataCacheTtl,
  clientMetadataNegativeCacheTtl,
  fetchClientIdMetadataDocument,
  setClientMetadataDnsLookup,
  setClientMetadataFetch,
  sweepClientMetadataCache,
} from "./mcp-client-metadata.js";

/**
 * Regression cover for the unbounded-cache (availability) finding recorded
 * against `mcp-client-metadata.ts`: `positiveCache` / `negativeCache` were
 * plain `Map`s keyed by the attacker-supplied `client_id` URL with lazy
 * per-entry expiry only — no size cap and no sweep — so rotating distinct
 * paths on one resolvable host grew process memory without limit.
 *
 * Pure unit tests: no database, no network. Fetch and DNS are replaced via
 * the module's own seams. Keys are distinct paths on ONE host, which is
 * exactly the cheap attacker shape (one DNS name, unlimited URLs).
 */

const CAP = CLIENT_METADATA_CACHE_MAX_ENTRIES;
const PUBLIC_ADDR = [{ address: "93.184.216.34", family: 4 }];

function urlFor(i: number): string {
  return `https://client.example/oauth/meta-${i}`;
}

function doc(url: string) {
  return {
    client_id: url,
    client_name: "Example Agent CLI",
    redirect_uris: ["https://client.example/cb"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

function jsonResponse(url: string, status = 200) {
  return new Response(JSON.stringify(doc(url)), { status, headers: { "content-type": "application/json" } });
}

async function expectFailure(promise: Promise<unknown>): Promise<ClientMetadataError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ClientMetadataError);
  return caught as ClientMetadataError;
}

let fetchCount: number;

beforeEach(() => {
  clearClientMetadataCache();
  fetchCount = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
  setClientMetadataDnsLookup(async () => PUBLIC_ADDR);
  setClientMetadataFetch(async (url) => {
    fetchCount += 1;
    return jsonResponse(url);
  });
});

afterEach(() => {
  setClientMetadataDnsLookup(null);
  setClientMetadataFetch(null);
  clearClientMetadataCache();
  vi.useRealTimers();
});

describe("cache bounds — positive cache", () => {
  it("exposes a sane cap: a fixed module constant, well above realistic MCP client counts", () => {
    expect(Number.isInteger(CAP)).toBe(true);
    expect(CAP).toBeGreaterThanOrEqual(256);
    expect(CAP).toBeLessThanOrEqual(10_000);
  });

  it("never exceeds the cap under cap + k distinct keys on one host", async () => {
    const extra = 250;
    for (let i = 0; i < CAP + extra; i += 1) {
      await fetchClientIdMetadataDocument(urlFor(i));
      expect(clientMetadataCacheSize().positive).toBeLessThanOrEqual(CAP);
    }
    expect(fetchCount).toBe(CAP + extra);
    expect(clientMetadataCacheSize().positive).toBe(CAP);
    // Exactly the oldest `extra` keys are gone; the newest CAP survive.
    for (let i = 0; i < extra; i += 1) expect(clientMetadataCacheTtl(urlFor(i))).toBeNull();
    for (let i = extra; i < CAP + extra; i += 1) expect(clientMetadataCacheTtl(urlFor(i))).toBe(CLIENT_METADATA_DEFAULT_TTL_MS);
  });

  it("evicts the LEAST RECENTLY USED entry, not merely the oldest inserted", async () => {
    for (let i = 0; i < CAP; i += 1) await fetchClientIdMetadataDocument(urlFor(i));
    expect(clientMetadataCacheSize().positive).toBe(CAP);

    // Touch key 0 — a cache hit, no fetch — making key 1 the LRU entry.
    const before = fetchCount;
    await fetchClientIdMetadataDocument(urlFor(0));
    expect(fetchCount).toBe(before);

    await fetchClientIdMetadataDocument(urlFor(CAP)); // one over capacity
    expect(clientMetadataCacheSize().positive).toBe(CAP);
    expect(clientMetadataCacheTtl(urlFor(0))).not.toBeNull(); // survived: recently used
    expect(clientMetadataCacheTtl(urlFor(1))).toBeNull(); // evicted: least recently used
    expect(clientMetadataCacheTtl(urlFor(CAP))).not.toBeNull();
  });

  it("re-caching an existing key does not consume a second slot", async () => {
    for (let i = 0; i < CAP; i += 1) await fetchClientIdMetadataDocument(urlFor(i));
    // Expire everything, then re-fetch key 0: it is re-inserted, not duplicated.
    vi.setSystemTime(Date.now() + CLIENT_METADATA_DEFAULT_TTL_MS + 1);
    await fetchClientIdMetadataDocument(urlFor(0));
    expect(clientMetadataCacheSize().positive).toBeLessThanOrEqual(CAP);
    expect(clientMetadataCacheTtl(urlFor(0))).toBe(CLIENT_METADATA_DEFAULT_TTL_MS);
  });

  it("sweeps expired entries before evicting any live one when the cache is full", async () => {
    const stale = 100;
    for (let i = 0; i < stale; i += 1) await fetchClientIdMetadataDocument(urlFor(i));
    // Let the first `stale` entries expire, then fill the rest with live ones.
    vi.setSystemTime(Date.now() + CLIENT_METADATA_DEFAULT_TTL_MS + 1);
    for (let i = stale; i < CAP; i += 1) await fetchClientIdMetadataDocument(urlFor(i));
    expect(clientMetadataCacheSize().positive).toBe(CAP); // lazy expiry: stale rows still occupy slots

    // The overflowing insert sweeps ALL expired rows, so no live row is lost
    // and the map shrinks well below the cap instead of evicting one-by-one.
    await fetchClientIdMetadataDocument(urlFor(CAP));
    expect(clientMetadataCacheSize().positive).toBe(CAP - stale + 1);
    for (let i = stale; i <= CAP; i += 1) expect(clientMetadataCacheTtl(urlFor(i))).not.toBeNull();
    for (let i = 0; i < stale; i += 1) expect(clientMetadataCacheTtl(urlFor(i))).toBeNull();
  });

  it("sweepClientMetadataCache drops expired rows on demand and reports the count", async () => {
    for (let i = 0; i < 10; i += 1) await fetchClientIdMetadataDocument(urlFor(i));
    expect(sweepClientMetadataCache()).toBe(0);
    vi.setSystemTime(Date.now() + CLIENT_METADATA_DEFAULT_TTL_MS + 1);
    for (let i = 10; i < 15; i += 1) await fetchClientIdMetadataDocument(urlFor(i));
    expect(clientMetadataCacheSize().positive).toBe(15);
    expect(sweepClientMetadataCache()).toBe(10);
    expect(clientMetadataCacheSize().positive).toBe(5);
  });

  it("an expired hit is a miss that re-fetches, exactly as before the cap", async () => {
    await fetchClientIdMetadataDocument(urlFor(0));
    vi.setSystemTime(Date.now() + CLIENT_METADATA_DEFAULT_TTL_MS - 1);
    await fetchClientIdMetadataDocument(urlFor(0));
    expect(fetchCount).toBe(1);
    vi.setSystemTime(Date.now() + 2);
    await fetchClientIdMetadataDocument(urlFor(0));
    expect(fetchCount).toBe(2);
    expect(clientMetadataCacheSize().positive).toBe(1);
  });
});

describe("cache bounds — negative cache", () => {
  it("never exceeds the cap under cap + k distinct failing keys, and evicts the oldest", async () => {
    setClientMetadataFetch(async (url) => {
      fetchCount += 1;
      return jsonResponse(url, 500);
    });
    const extra = 50;
    for (let i = 0; i < CAP + extra; i += 1) {
      const err = await expectFailure(fetchClientIdMetadataDocument(urlFor(i)));
      expect(err.reason).toBe("bad_status");
      expect(clientMetadataCacheSize().negative).toBeLessThanOrEqual(CAP);
    }
    expect(clientMetadataCacheSize().negative).toBe(CAP);
    expect(clientMetadataCacheSize().positive).toBe(0);
    for (let i = 0; i < extra; i += 1) expect(clientMetadataNegativeCacheTtl(urlFor(i))).toBeNull();
    for (let i = extra; i < CAP + extra; i += 1) expect(clientMetadataNegativeCacheTtl(urlFor(i))).toBe(CLIENT_METADATA_NEGATIVE_TTL_MS);
  });

  it("SSRF rejections are bounded too, still without ever fetching", async () => {
    setClientMetadataDnsLookup(async () => [{ address: "10.0.0.1", family: 4 }]);
    for (let i = 0; i < CAP + 10; i += 1) {
      const err = await expectFailure(fetchClientIdMetadataDocument(`https://private-${i}.example/meta`));
      expect(err.reason).toBe("forbidden_host");
    }
    expect(fetchCount).toBe(0);
    expect(clientMetadataCacheSize().negative).toBe(CAP);
  });

  it("negative TTL semantics are unchanged: served from cache for 60 s, then re-tried", async () => {
    let calls = 0;
    setClientMetadataFetch(async (url) => {
      calls += 1;
      return jsonResponse(url, 500);
    });
    await expectFailure(fetchClientIdMetadataDocument(urlFor(0)));
    await expectFailure(fetchClientIdMetadataDocument(urlFor(0)));
    expect(calls).toBe(1);
    vi.setSystemTime(Date.now() + CLIENT_METADATA_NEGATIVE_TTL_MS + 1);
    await expectFailure(fetchClientIdMetadataDocument(urlFor(0)));
    expect(calls).toBe(2);
    expect(clientMetadataCacheSize().negative).toBe(1);
  });

  it("a success after a negative entry expires moves the key to the positive cache only", async () => {
    let fail = true;
    setClientMetadataFetch(async (url) => jsonResponse(url, fail ? 500 : 200));
    await expectFailure(fetchClientIdMetadataDocument(urlFor(0)));
    expect(clientMetadataCacheSize()).toEqual({ positive: 0, negative: 1 });
    vi.setSystemTime(Date.now() + CLIENT_METADATA_NEGATIVE_TTL_MS + 1);
    fail = false;
    await fetchClientIdMetadataDocument(urlFor(0));
    expect(clientMetadataCacheSize().positive).toBe(1);
    // The stale negative row is gone (dropped on the expired lookup).
    expect(clientMetadataCacheSize().negative).toBe(0);
  });

  it("clearClientMetadataCache empties both caches", async () => {
    await fetchClientIdMetadataDocument(urlFor(0));
    setClientMetadataFetch(async (url) => jsonResponse(url, 500));
    await expectFailure(fetchClientIdMetadataDocument(urlFor(1)));
    expect(clientMetadataCacheSize()).toEqual({ positive: 1, negative: 1 });
    clearClientMetadataCache();
    expect(clientMetadataCacheSize()).toEqual({ positive: 0, negative: 0 });
  });
});
