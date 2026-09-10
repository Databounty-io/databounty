// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_METADATA_DEFAULT_TTL_MS,
  CLIENT_METADATA_MAX_TTL_MS,
  CLIENT_METADATA_MIN_TTL_MS,
  CLIENT_METADATA_NEGATIVE_TTL_MS,
  ClientMetadataError,
  clearClientMetadataCache,
  clientMetadataCacheTtl,
  fetchClientIdMetadataDocument,
  isClientIdMetadataUrl,
  isForbiddenAddress,
  isLoopbackRedirectUri,
  setClientMetadataDnsLookup,
  setClientMetadataFetch,
  validateClientIdMetadataDocument,
} from "./mcp-client-metadata.js";

/**
 * Pure unit tests — no database, no network. The HTTP fetch and the DNS
 * lookup are both replaced through the module's own seams, so every SSRF and
 * validation branch is exercised deterministically.
 */

const URL_OK = "https://client.example/oauth/client-metadata";
const PUBLIC_ADDR = [{ address: "93.184.216.34", family: 4 }];

function doc(overrides: Record<string, unknown> = {}, url = URL_OK) {
  return {
    client_id: url,
    client_name: "Example Agent CLI",
    redirect_uris: ["http://127.0.0.1:41234/callback", "https://client.example/cb"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function expectReason(promise: Promise<unknown>, reason: ClientMetadataError["reason"]) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ClientMetadataError);
  expect((caught as ClientMetadataError).reason).toBe(reason);
}

let fetchCalls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  clearClientMetadataCache();
  fetchCalls = [];
  setClientMetadataDnsLookup(async () => PUBLIC_ADDR);
  setClientMetadataFetch(async (url, init) => {
    fetchCalls.push({ url, init });
    return jsonResponse(doc({}, url));
  });
});

afterEach(() => {
  setClientMetadataDnsLookup(null);
  setClientMetadataFetch(null);
  clearClientMetadataCache();
  vi.useRealTimers();
});

describe("isClientIdMetadataUrl", () => {
  it("accepts an https URL with a real path", () => {
    expect(isClientIdMetadataUrl(URL_OK)).toBe(true);
    expect(isClientIdMetadataUrl("https://example.com/a")).toBe(true);
  });

  it("rejects everything that is not a fetchable metadata URL", () => {
    expect(isClientIdMetadataUrl("db_mcp_client_abc123")).toBe(false);
    expect(isClientIdMetadataUrl("")).toBe(false);
    expect(isClientIdMetadataUrl("http://client.example/oauth/client-metadata")).toBe(false); // not https
    expect(isClientIdMetadataUrl("https://client.example")).toBe(false); // root path
    expect(isClientIdMetadataUrl("https://client.example/")).toBe(false); // root path
    expect(isClientIdMetadataUrl("https://user@client.example/meta")).toBe(false); // userinfo
    expect(isClientIdMetadataUrl("https://user:pw@client.example/meta")).toBe(false);
    expect(isClientIdMetadataUrl("https://client.example/meta#frag")).toBe(false); // fragment
    expect(isClientIdMetadataUrl("https://client.example/meta#")).toBe(false);
    expect(isClientIdMetadataUrl("https://client.example/meta?x=1")).toBe(false); // query
    expect(isClientIdMetadataUrl("https://client.example/meta?")).toBe(false);
    expect(isClientIdMetadataUrl("ftp://client.example/meta")).toBe(false);
    expect(isClientIdMetadataUrl("not a url")).toBe(false);
    expect(isClientIdMetadataUrl(`https://client.example/${"a".repeat(2100)}`)).toBe(false);
  });
});

describe("isLoopbackRedirectUri", () => {
  it("recognises the RFC 8252 loopback hosts and nothing else", () => {
    expect(isLoopbackRedirectUri("http://127.0.0.1:1234/cb")).toBe(true);
    expect(isLoopbackRedirectUri("http://localhost/cb")).toBe(true);
    expect(isLoopbackRedirectUri("http://[::1]:5555/cb")).toBe(true);
    expect(isLoopbackRedirectUri("https://client.example/cb")).toBe(false);
    expect(isLoopbackRedirectUri("garbage")).toBe(false);
  });
});

describe("isForbiddenAddress", () => {
  it("forbids loopback, private, link-local, shared, multicast, reserved and unspecified IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.1",
      "10.255.1.2",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "0.1.2.3",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it("forbids loopback, unspecified, ULA, link-local, multicast and embedded-IPv4 IPv6", () => {
    for (const ip of [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%en0",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "::ffff:169.254.169.254",
      "::ffff:192.168.0.10",
      "::127.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b::10.0.0.1",
      "2002:7f00:1::",
      "2002:0a00:0001::1",
      "[::1]",
    ]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.128.0.1", "2606:4700::1111", "2001:db8::1", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
      expect(isForbiddenAddress(ip), ip).toBe(false);
    }
  });

  it("fails closed on garbage", () => {
    expect(isForbiddenAddress("")).toBe(true);
    expect(isForbiddenAddress("not-an-ip")).toBe(true);
    expect(isForbiddenAddress("1.2.3")).toBe(true);
    expect(isForbiddenAddress("1.2.3.4.5")).toBe(true);
    expect(isForbiddenAddress("::ffff:300.1.1.1")).toBe(true);
    expect(isForbiddenAddress("1:2:3:4:5:6:7:8:9")).toBe(true);
    expect(isForbiddenAddress("1::2::3")).toBe(true);
  });
});

describe("fetchClientIdMetadataDocument — SSRF guards", () => {
  it("rejects a non-metadata URL before doing anything", async () => {
    await expectReason(fetchClientIdMetadataDocument("db_mcp_client_x"), "not_a_metadata_url");
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses literal IP hosts without a DNS lookup or a fetch", async () => {
    let lookups = 0;
    setClientMetadataDnsLookup(async () => {
      lookups += 1;
      return PUBLIC_ADDR;
    });
    await expectReason(fetchClientIdMetadataDocument("https://127.0.0.1/meta"), "forbidden_host");
    await expectReason(fetchClientIdMetadataDocument("https://10.0.0.1/meta"), "forbidden_host");
    await expectReason(fetchClientIdMetadataDocument("https://[::1]/meta"), "forbidden_host");
    await expectReason(fetchClientIdMetadataDocument("https://8.8.8.8/meta"), "forbidden_host");
    expect(lookups).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses localhost and internal-looking hostnames", async () => {
    await expectReason(fetchClientIdMetadataDocument("https://localhost/meta"), "forbidden_host");
    await expectReason(fetchClientIdMetadataDocument("https://foo.localhost/meta"), "forbidden_host");
    await expectReason(fetchClientIdMetadataDocument("https://metadata.internal/meta"), "forbidden_host");
    expect(fetchCalls).toHaveLength(0);
  });

  it.each([
    ["127.0.0.1", 4],
    ["10.20.30.40", 4],
    ["169.254.169.254", 4],
    ["172.16.5.5", 4],
    ["192.168.0.1", 4],
    ["::1", 6],
    ["fc00::1", 6],
    ["fd00::abcd", 6],
    ["fe80::1", 6],
    ["::ffff:127.0.0.1", 6],
    ["::ffff:10.0.0.1", 6],
  ])("refuses a hostname that resolves to %s and never fetches it", async (address, family) => {
    setClientMetadataDnsLookup(async () => [{ address, family }]);
    await expectReason(fetchClientIdMetadataDocument(`https://rebinder-${family}.example/meta`), "forbidden_host");
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses when ANY resolved address is forbidden, even alongside a public one", async () => {
    setClientMetadataDnsLookup(async () => [...PUBLIC_ADDR, { address: "10.0.0.9", family: 4 }]);
    await expectReason(fetchClientIdMetadataDocument("https://mixed.example/meta"), "forbidden_host");
    expect(fetchCalls).toHaveLength(0);
  });

  it("maps DNS failure and an empty answer to dns_failed", async () => {
    setClientMetadataDnsLookup(async () => {
      throw new Error("ENOTFOUND");
    });
    await expectReason(fetchClientIdMetadataDocument("https://nx.example/meta"), "dns_failed");
    clearClientMetadataCache();
    setClientMetadataDnsLookup(async () => []);
    await expectReason(fetchClientIdMetadataDocument("https://nx.example/meta"), "dns_failed");
    expect(fetchCalls).toHaveLength(0);
  });

  it("never follows redirects, sets a JSON Accept header and a timeout signal", async () => {
    await fetchClientIdMetadataDocument(URL_OK);
    expect(fetchCalls).toHaveLength(1);
    const { url, init } = fetchCalls[0]!;
    expect(url).toBe(URL_OK);
    expect(init.redirect).toBe("error");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).accept).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps a thrown fetch (e.g. a redirect with redirect=error) to fetch_failed", async () => {
    setClientMetadataFetch(async () => {
      throw new TypeError("fetch failed: redirect");
    });
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "fetch_failed");
  });

  it("maps an aborted fetch to timeout", async () => {
    setClientMetadataFetch(async (_url, init) => {
      // Simulate the request outliving the deadline: the module's own
      // AbortController fires and the fetch rejects with its signal set.
      await new Promise<void>((resolve) => {
        if (init.signal?.aborted) return resolve();
        init.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = fetchClientIdMetadataDocument(URL_OK);
    const settled = expectReason(pending, "timeout");
    await vi.advanceTimersByTimeAsync(5_001);
    await settled;
  });
});

describe("fetchClientIdMetadataDocument — response validation", () => {
  it("requires HTTP 200", async () => {
    setClientMetadataFetch(async (url) => jsonResponse(doc({}, url), { status: 404 }));
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "bad_status");
  });

  it("requires application/json", async () => {
    setClientMetadataFetch(async (url) => new Response(JSON.stringify(doc({}, url)), { status: 200, headers: { "content-type": "text/html" } }));
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "bad_content_type");
  });

  it("accepts application/json with a charset parameter", async () => {
    setClientMetadataFetch(async (url) => new Response(JSON.stringify(doc({}, url)), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));
    const result = await fetchClientIdMetadataDocument(URL_OK);
    expect(result.client_name).toBe("Example Agent CLI");
  });

  it("accepts a +json media type and an absent Content-Type", async () => {
    // JSON.parse is the real gate; the Content-Type check exists to catch an
    // HTML bot-challenge body, not to police the exact media type.
    setClientMetadataFetch(async (url) => new Response(JSON.stringify(doc({}, url)), { status: 200, headers: { "content-type": "application/ld+json" } }));
    expect((await fetchClientIdMetadataDocument(URL_OK)).client_name).toBe("Example Agent CLI");
    clearClientMetadataCache();
    // A Uint8Array body carries no implicit Content-Type, unlike a string.
    setClientMetadataFetch(async (url) => new Response(new TextEncoder().encode(JSON.stringify(doc({}, url))), { status: 200 }));
    expect((await fetchClientIdMetadataDocument(URL_OK)).client_name).toBe("Example Agent CLI");
  });

  it("rejects a body over 64 KiB while streaming it", async () => {
    const huge = JSON.stringify(doc({ client_name: "x".repeat(70 * 1024) }));
    setClientMetadataFetch(async () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } }));
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "too_large");
  });

  it("rejects an oversized declared Content-Length before reading", async () => {
    setClientMetadataFetch(async (url) => jsonResponse(doc({}, url), { headers: { "content-length": String(1024 * 1024) } }));
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "too_large");
  });

  it("rejects malformed JSON", async () => {
    setClientMetadataFetch(async () => jsonResponse("{not json"));
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "bad_json");
  });

  it("rejects a document whose client_id is not exactly the URL", async () => {
    setClientMetadataFetch(async () => jsonResponse(doc({ client_id: "https://client.example/oauth/client-metadata/" })));
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "invalid_document");
    clearClientMetadataCache();
    setClientMetadataFetch(async () => jsonResponse(doc({ client_id: "https://other.example/oauth/client-metadata" })));
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "invalid_document");
    clearClientMetadataCache();
    setClientMetadataFetch(async () => jsonResponse(doc({ client_id: undefined })));
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "invalid_document");
  });

  it("returns the validated document on success and normalises defaults", async () => {
    setClientMetadataFetch(async (url) => jsonResponse({ client_id: url, client_name: "Minimal", redirect_uris: ["https://client.example/cb", "https://client.example/cb"] }));
    const result = await fetchClientIdMetadataDocument(URL_OK);
    expect(result).toEqual({
      client_id: URL_OK,
      client_name: "Minimal",
      redirect_uris: ["https://client.example/cb"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      response_types: ["code"],
    });
  });
});

describe("validateClientIdMetadataDocument", () => {
  const bad = (overrides: Record<string, unknown>) => () => validateClientIdMetadataDocument(URL_OK, doc(overrides));

  it("rejects non-object documents", () => {
    expect(() => validateClientIdMetadataDocument(URL_OK, null)).toThrow(ClientMetadataError);
    expect(() => validateClientIdMetadataDocument(URL_OK, [])).toThrow(ClientMetadataError);
    expect(() => validateClientIdMetadataDocument(URL_OK, "str")).toThrow(ClientMetadataError);
  });

  it("requires a non-empty client_name, truncates a long one, and allows reserved terms", () => {
    // Presence is a MUST in the MCP authorization spec; the 200-char cap is
    // only our display limit, so an over-long name is truncated.
    expect(bad({ client_name: undefined })).toThrow(/client_name/);
    expect(bad({ client_name: "" })).toThrow(/client_name/);
    expect(bad({ client_name: "   " })).toThrow(/client_name/);
    expect(bad({ client_name: 42 })).toThrow(/client_name/);
    expect(validateClientIdMetadataDocument(URL_OK, doc({ client_name: "x".repeat(201) })).client_name).toHaveLength(200);
    expect(validateClientIdMetadataDocument(URL_OK, doc({ client_name: "x".repeat(200) })).client_name).toHaveLength(200);
    // The reserved-term ban belongs to the unauthenticated RFC 7591 endpoint,
    // where anyone can POST any name. A CIMD name is backed by a host we
    // verified we could fetch from and which the consent screen shows, and
    // substring matching would reject "Unofficial …" too.
    expect(validateClientIdMetadataDocument(URL_OK, doc({ client_name: "DataBounty Helper" })).client_name).toBe("DataBounty Helper");
    expect(validateClientIdMetadataDocument(URL_OK, doc({ client_name: "The Official Client" })).client_name).toBe("The Official Client");
  });

  it("validates redirect_uris: non-empty, at most 20, every entry a safe redirect", () => {
    expect(bad({ redirect_uris: undefined })).toThrow(/redirect_uris/);
    expect(bad({ redirect_uris: [] })).toThrow(/redirect_uris/);
    expect(bad({ redirect_uris: "https://client.example/cb" })).toThrow(/redirect_uris/);
    expect(bad({ redirect_uris: [123] })).toThrow(/redirect_uris/);
    expect(bad({ redirect_uris: ["http://client.example/cb"] })).toThrow(/redirect_uris/); // plain http, not loopback
    expect(bad({ redirect_uris: ["https://user@client.example/cb"] })).toThrow(/redirect_uris/); // userinfo
    expect(bad({ redirect_uris: ["https://client.example/cb#x"] })).toThrow(/redirect_uris/); // fragment
    expect(bad({ redirect_uris: ["javascript:alert(1)"] })).toThrow(/redirect_uris/);
    expect(bad({ redirect_uris: ["https://client.example/cb", "http://evil.example/steal"] })).toThrow(/redirect_uris/);
    expect(bad({ redirect_uris: Array.from({ length: 21 }, (_, i) => `https://client.example/cb${i}`) })).toThrow(/redirect_uris/);
    expect(validateClientIdMetadataDocument(URL_OK, doc({ redirect_uris: Array.from({ length: 20 }, (_, i) => `https://client.example/cb${i}`) })).redirect_uris).toHaveLength(20);
    expect(validateClientIdMetadataDocument(URL_OK, doc({ redirect_uris: ["http://localhost:3000/cb", "http://[::1]:3000/cb"] })).redirect_uris).toHaveLength(2);
  });

  it("refuses shared-secret client authentication but accepts every other declaration", () => {
    // Forbidden outright by the CIMD draft §4.1 — a shared symmetric secret.
    expect(bad({ token_endpoint_auth_method: "client_secret_basic" })).toThrow(/token_endpoint_auth_method/);
    expect(bad({ token_endpoint_auth_method: "client_secret_post" })).toThrow(/token_endpoint_auth_method/);
    expect(bad({ token_endpoint_auth_method: "client_secret_jwt" })).toThrow(/token_endpoint_auth_method/);
    expect(bad({ token_endpoint_auth_method: 42 })).toThrow(/token_endpoint_auth_method/);
    // Legal declarations. The field is optional, may be explicitly null, and
    // may name an asymmetric method; none of those may reject a conformant
    // client, and all of them are carried by PKCE as a public client here.
    for (const value of [undefined, null, "none", "private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth"]) {
      expect(validateClientIdMetadataDocument(URL_OK, doc({ token_endpoint_auth_method: value })).token_endpoint_auth_method).toBe("none");
    }
  });

  it("accepts Claude Code's real published client metadata document", () => {
    // Verbatim from https://claude.ai/oauth/claude-code-client-metadata —
    // a regression guard, since this is the document that reaches us most.
    const claudeCodeUrl = "https://claude.ai/oauth/claude-code-client-metadata";
    const document = validateClientIdMetadataDocument(claudeCodeUrl, {
      client_id: claudeCodeUrl,
      client_name: "Claude Code",
      client_uri: "https://claude.ai",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(document.client_name).toBe("Claude Code");
    expect(document.redirect_uris).toEqual(["http://localhost/callback", "http://127.0.0.1/callback"]);
  });

  it("intersects grant_types and response_types with what this server issues", () => {
    // A client's own document lists what it can do everywhere, not what it
    // demands of us — so extra entries are dropped, not fatal. Only having
    // nothing we can serve is.
    expect(bad({ grant_types: ["client_credentials"] })).toThrow(/grant_types/);
    expect(bad({ grant_types: [] })).toThrow(/grant_types/);
    expect(bad({ grant_types: "authorization_code" })).toThrow(/grant_types/);
    expect(bad({ grant_types: ["refresh_token"] })).toThrow(/authorization_code/);
    expect(validateClientIdMetadataDocument(URL_OK, doc({ grant_types: ["authorization_code", "implicit"] })).grant_types).toEqual(["authorization_code"]);
    expect(
      validateClientIdMetadataDocument(URL_OK, doc({ grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:token-exchange"] })).grant_types,
    ).toEqual(["authorization_code", "refresh_token"]);
    expect(validateClientIdMetadataDocument(URL_OK, doc({ grant_types: ["authorization_code"] })).grant_types).toEqual(["authorization_code"]);
    expect(bad({ response_types: ["token"] })).toThrow(/response_types/);
    expect(bad({ response_types: [] })).toThrow(/response_types/);
    expect(validateClientIdMetadataDocument(URL_OK, doc({ response_types: ["code", "code id_token"] })).response_types).toEqual(["code"]);
    expect(validateClientIdMetadataDocument(URL_OK, doc({ response_types: undefined })).response_types).toEqual(["code"]);
  });
});

describe("fetchClientIdMetadataDocument — cache", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
  });

  it("serves the second call from cache with the default 5 minute TTL", async () => {
    await fetchClientIdMetadataDocument(URL_OK);
    await fetchClientIdMetadataDocument(URL_OK);
    expect(fetchCalls).toHaveLength(1);
    expect(clientMetadataCacheTtl(URL_OK)).toBe(CLIENT_METADATA_DEFAULT_TTL_MS);
    vi.setSystemTime(Date.now() + CLIENT_METADATA_DEFAULT_TTL_MS - 1);
    await fetchClientIdMetadataDocument(URL_OK);
    expect(fetchCalls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2);
    await fetchClientIdMetadataDocument(URL_OK);
    expect(fetchCalls).toHaveLength(2);
  });

  it("honours Cache-Control max-age", async () => {
    setClientMetadataFetch(async (url, init) => {
      fetchCalls.push({ url, init });
      return jsonResponse(doc({}, url), { headers: { "cache-control": "public, max-age=120" } });
    });
    await fetchClientIdMetadataDocument(URL_OK);
    expect(clientMetadataCacheTtl(URL_OK)).toBe(120_000);
    vi.setSystemTime(Date.now() + 119_000);
    await fetchClientIdMetadataDocument(URL_OK);
    expect(fetchCalls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2_000);
    await fetchClientIdMetadataDocument(URL_OK);
    expect(fetchCalls).toHaveLength(2);
  });

  it("clamps max-age to the 60 s floor and the 1 h ceiling", async () => {
    setClientMetadataFetch(async (url) => jsonResponse(doc({}, url), { headers: { "cache-control": "max-age=5" } }));
    await fetchClientIdMetadataDocument(URL_OK);
    expect(clientMetadataCacheTtl(URL_OK)).toBe(CLIENT_METADATA_MIN_TTL_MS);
    clearClientMetadataCache();
    setClientMetadataFetch(async (url) => jsonResponse(doc({}, url), { headers: { "cache-control": "max-age=999999" } }));
    await fetchClientIdMetadataDocument(URL_OK);
    expect(clientMetadataCacheTtl(URL_OK)).toBe(CLIENT_METADATA_MAX_TTL_MS);
    clearClientMetadataCache();
    setClientMetadataFetch(async (url) => jsonResponse(doc({}, url), { headers: { "cache-control": "no-store" } }));
    await fetchClientIdMetadataDocument(URL_OK);
    expect(clientMetadataCacheTtl(URL_OK)).toBe(CLIENT_METADATA_MIN_TTL_MS);
  });

  it("caches per URL, not globally", async () => {
    const other = "https://client.example/oauth/other";
    await fetchClientIdMetadataDocument(URL_OK);
    await fetchClientIdMetadataDocument(other);
    expect(fetchCalls.map((c) => c.url)).toEqual([URL_OK, other]);
    expect(clientMetadataCacheTtl(other)).toBe(CLIENT_METADATA_DEFAULT_TTL_MS);
  });

  it("negatively caches a failure for 60 s so a hostile client cannot make the server hammer a URL", async () => {
    let calls = 0;
    setClientMetadataFetch(async (url) => {
      calls += 1;
      return jsonResponse(doc({}, url), { status: 500 });
    });
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "bad_status");
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "bad_status");
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "bad_status");
    expect(calls).toBe(1);
    vi.setSystemTime(Date.now() + CLIENT_METADATA_NEGATIVE_TTL_MS - 1);
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "bad_status");
    expect(calls).toBe(1);
    vi.setSystemTime(Date.now() + 2);
    await expectReason(fetchClientIdMetadataDocument(URL_OK), "bad_status");
    expect(calls).toBe(2);
  });

  it("negatively caches SSRF rejections too, without ever fetching", async () => {
    let lookups = 0;
    setClientMetadataDnsLookup(async () => {
      lookups += 1;
      return [{ address: "10.0.0.1", family: 4 }];
    });
    await expectReason(fetchClientIdMetadataDocument("https://private.example/meta"), "forbidden_host");
    await expectReason(fetchClientIdMetadataDocument("https://private.example/meta"), "forbidden_host");
    expect(lookups).toBe(1);
    expect(fetchCalls).toHaveLength(0);
  });

  it("clearClientMetadataCache drops both caches", async () => {
    await fetchClientIdMetadataDocument(URL_OK);
    clearClientMetadataCache();
    expect(clientMetadataCacheTtl(URL_OK)).toBeNull();
    await fetchClientIdMetadataDocument(URL_OK);
    expect(fetchCalls).toHaveLength(2);
  });
});
