// SPDX-License-Identifier: Apache-2.0

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { isSafeRedirectUri } from "./mcp-oauth.js";

/**
 * OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-
 * document-00), as required-by-SHOULD in the MCP authorization spec
 * (2025-11-25 and later).
 *
 * A client whose `client_id` is an HTTPS URL is not pre-registered: the
 * authorization server fetches that URL, receives a JSON document describing
 * the client (name, redirect URIs, grant types …) and treats it as the
 * registration. Several agent CLIs identify themselves this way whenever a
 * server advertises `client_id_metadata_document_supported: true`, and fall
 * back to RFC 7591 dynamic registration otherwise.
 *
 * Because the URL is attacker-controlled input that makes THIS server issue an
 * outbound HTTP request, everything here is written as an SSRF surface first
 * and an OAuth feature second:
 *
 *  - `isClientIdMetadataUrl` accepts only https URLs with a real path and no
 *    userinfo / query / fragment, so an opaque `db_mcp_client_*` id — or
 *    anything else — can never be mistaken for a fetchable URL.
 *  - Before any request, the hostname is resolved and EVERY returned address
 *    is checked against loopback, private, link-local, multicast, unspecified
 *    and IPv4-mapped/NAT64/6to4-embedded ranges. Literal IP hosts are refused
 *    outright.
 *  - The validated answer is then PINNED to the connection. `fetch()` would
 *    have re-resolved the hostname inside the transport, giving an
 *    attacker-controlled DNS server a second answer to substitute
 *    (169.254.169.254, 127.0.0.1, 10.x …) after ours passed the range check —
 *    the classic DNS-rebinding TOCTOU. So the default transport is
 *    `pinnedHttpsFetch`: `node:https` connecting to the already-checked IP
 *    LITERAL (`net.connect` performs no DNS for a literal, and the pinned
 *    `lookup` refuses to resolve anything even if it were reached), with the
 *    TLS SNI, `checkServerIdentity` and the `Host` header all still carrying
 *    the ORIGINAL hostname so certificate verification and virtual hosting
 *    are unaffected. Each address is re-checked at connect time, and a
 *    request with no pinned address is REFUSED rather than falling back to
 *    an unpinned fetch. `agent: false` keeps the socket out of a shared,
 *    host-keyed connection pool.
 *  - A redirect is a second, unvetted destination: `redirect: "error"` for an
 *    injected transport, and the pinned transport rejects any 3xx itself
 *    (`node:https` never follows one) before the body is read.
 *  - 5 s timeout, `application/json` only, body capped at 64 KiB while
 *    streaming, so a slow or oversized responder cannot hold a connection or
 *    memory hostage.
 *  - Successful documents are cached per Cache-Control max-age (clamped to
 *    60 s – 1 h, default 5 min); failures are negatively cached for 60 s, so a
 *    hostile client cannot make the authorization server hammer a third-party
 *    URL by retrying `/authorize` in a loop. Both caches are bounded LRUs
 *    (`CLIENT_METADATA_CACHE_MAX_ENTRIES` each) with expired entries swept
 *    before any live one is evicted, so rotating distinct paths on one host
 *    cannot grow process memory without limit.
 *
 * The HTTP fetch and the DNS lookup are both injectable (module-level setters)
 * so tests can exercise every branch with no network at all.
 */

export const CLIENT_METADATA_MAX_BYTES = 64 * 1024;
export const CLIENT_METADATA_TIMEOUT_MS = 5_000;
export const CLIENT_METADATA_MIN_TTL_MS = 60_000;
export const CLIENT_METADATA_MAX_TTL_MS = 60 * 60_000;
export const CLIENT_METADATA_DEFAULT_TTL_MS = 5 * 60_000;
export const CLIENT_METADATA_NEGATIVE_TTL_MS = 60_000;
/**
 * Hard cap on entries per cache (positive and negative each). Both maps are
 * keyed by the attacker-supplied `client_id` URL — up to 2048 bytes, freely
 * variable in its path — so without a cap a single resolvable host could grow
 * process memory without limit simply by rotating paths (each miss costs one
 * negative entry, each 200 costs one positive entry). Realistic legitimate
 * cardinality is tiny: the set of MCP clients that identify by metadata URL
 * (agent CLIs and IDEs) is in the tens, and each one has ONE document URL.
 * 1024 is ~50× that headroom while bounding the worst case at roughly
 * 1024 × (2 KiB key + a few KiB of validated document) ≈ a few MiB per cache.
 */
export const CLIENT_METADATA_CACHE_MAX_ENTRIES = 1024;
const MAX_CLIENT_ID_URL_LENGTH = 2048;
const MAX_REDIRECT_URIS = 20;
/**
 * `token_endpoint_auth_method` values the CIMD draft (§4.1) forbids outright:
 * every method built around a shared symmetric secret. RFC 7591's default is
 * `client_secret_basic`, which is on this list, so an ABSENT field is read as
 * a public client rather than as that default.
 */
const SECRET_BASED_AUTH_METHODS = ["client_secret_post", "client_secret_basic", "client_secret_jwt"];

export class ClientMetadataError extends Error {
  constructor(
    /** Stable machine-readable reason, safe to surface to the OAuth client. */
    public readonly reason:
      | "not_a_metadata_url"
      | "forbidden_host"
      | "dns_failed"
      | "fetch_failed"
      | "timeout"
      | "bad_status"
      | "bad_content_type"
      | "too_large"
      | "bad_json"
      | "invalid_document",
    message: string,
  ) {
    super(message);
    this.name = "ClientMetadataError";
  }
}

export interface ClientIdMetadataDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: "none";
  response_types: string[];
}

// ── URL detection ─────────────────────────────────────────────────────────

/**
 * True iff `clientId` is a URL that the CIMD draft allows as a client
 * identifier: https, a non-root path, and nothing that could smuggle a
 * different destination (userinfo) or vary the document (query, fragment).
 */
export function isClientIdMetadataUrl(clientId: string): boolean {
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > MAX_CLIENT_ID_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  if (url.hash || clientId.includes("#")) return false;
  if (url.search || clientId.includes("?")) return false;
  if (!url.pathname || url.pathname === "/") return false;
  return true;
}

/** Loopback per RFC 8252 §7.3 — the hosts `isSafeRedirectUri` allows over plain http. */
export function isLoopbackRedirectUri(uri: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
}

// ── Address classification ────────────────────────────────────────────────

function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

function isForbiddenIPv4(o: [number, number, number, number]): boolean {
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 unspecified / "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 shared address space
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  return false;
}

/** Expand an IPv6 textual address into eight 16-bit groups, or null. */
function parseIPv6(value: string): number[] | null {
  let text = value.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  // Trailing dotted-quad (e.g. ::ffff:127.0.0.1) becomes two hex groups.
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...tail];
  if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const missing = 8 - groups.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const nums = [...head.map((g) => parseInt(g, 16)), ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail.map((g) => parseInt(g, 16))];
  return nums.length === 8 ? nums : null;
}

function embeddedIPv4(hi: number, lo: number): [number, number, number, number] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isForbiddenIPv6(g: number[]): boolean {
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // IPv4-mapped ::ffff:a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isForbiddenIPv4(embeddedIPv4(g[6]!, g[7]!));
  // IPv4-compatible (deprecated) ::a.b.c.d — treat any embedded private v4 as forbidden too.
  if (g.slice(0, 6).every((x) => x === 0)) return isForbiddenIPv4(embeddedIPv4(g[6]!, g[7]!));
  // NAT64 well-known prefix 64:ff9b::/96
  if (first === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isForbiddenIPv4(embeddedIPv4(g[6]!, g[7]!));
  // 6to4 2002::/16 embeds the v4 address in groups 1–2.
  if (first === 0x2002) return isForbiddenIPv4(embeddedIPv4(g[1]!, g[2]!));
  return false;
}

/**
 * True when `address` must never be the target of a server-initiated fetch.
 * Unparseable input is forbidden too — fail closed.
 */
export function isForbiddenAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isForbiddenIPv4(v4);
  const v6 = parseIPv6(address);
  if (v6) return isForbiddenIPv6(v6);
  return true;
}

// ── Injectable I/O ────────────────────────────────────────────────────────

/** An address that has ALREADY passed `isForbiddenAddress`, plus its family. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * The transport init. `pinnedAddresses` is the validated DNS answer, in
 * resolution order; the default transport requires it and refuses to connect
 * without it, so there is no unpinned code path to fall back to.
 */
export type ClientMetadataFetchInit = RequestInit & { pinnedAddresses?: readonly PinnedAddress[] };

export type ClientMetadataFetch = (url: string, init: ClientMetadataFetchInit) => Promise<Response>;
export type ClientMetadataDnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/** Only the first few addresses of a large answer are ever tried. */
const MAX_PINNED_ADDRESSES = 4;

let fetchImpl: ClientMetadataFetch = (url, init) => pinnedHttpsFetch(url, init);
let lookupImpl: ClientMetadataDnsLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Test seam: replace the HTTP fetch. Returns the previous implementation. */
export function setClientMetadataFetch(fn: ClientMetadataFetch | null): ClientMetadataFetch {
  const previous = fetchImpl;
  fetchImpl = fn ?? ((url, init) => pinnedHttpsFetch(url, init));
  return previous;
}

/** Test seam: replace the DNS lookup. Returns the previous implementation. */
export function setClientMetadataDnsLookup(fn: ClientMetadataDnsLookup | null): ClientMetadataDnsLookup {
  const previous = lookupImpl;
  lookupImpl = fn ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  return previous;
}

// ── Address-pinned HTTPS transport ────────────────────────────────────────

/**
 * A Node `lookup` that never resolves anything: it ignores `hostname` and
 * answers with the single address we already validated, re-checking it first.
 * The pinned address is normally handed to `net.connect` as an IP literal, so
 * this is never called — it exists so that any future code path that DOES
 * reach a resolver still cannot be rebound, and so the pinning is directly
 * testable without a socket.
 */
export function createPinnedLookup(pinned: PinnedAddress) {
  return (
    _hostname: string,
    options: { all?: boolean } | ((err: Error | null, address?: unknown, family?: number) => void),
    callback?: (err: Error | null, address?: unknown, family?: number) => void,
  ): void => {
    const done = typeof options === "function" ? options : callback;
    if (!done) return;
    if (isForbiddenAddress(pinned.address)) {
      done(new Error(`Refusing to connect to ${pinned.address}: private, loopback, link-local or reserved address.`));
      return;
    }
    const family = isIP(pinned.address);
    if (family === 0) {
      done(new Error(`Refusing to connect to ${pinned.address}: not an IP address.`));
      return;
    }
    if (typeof options === "object" && options.all === true) {
      done(null, [{ address: pinned.address, family }]);
      return;
    }
    done(null, pinned.address, family);
  };
}

/**
 * Build the `node:https` options that connect to `pinned` while still
 * presenting — and verifying — the original hostname. Exported so a test can
 * assert the pinning without opening a socket.
 */
export function buildPinnedRequestOptions(
  url: URL,
  pinned: PinnedAddress,
  init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal | null } = {},
): HttpsRequestOptions {
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  // The wire `Host` stays the hostname the client asked for — `setHost: false`
  // stops Node writing the IP literal there — so a virtual host answers the
  // right site and nothing downstream sees a rewritten target.
  headers.host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  // We build the Response by hand, so never accept a body we would not decode.
  headers["accept-encoding"] = "identity";
  headers.connection = "close";
  return {
    // An IP literal: `net.connect` does no DNS for it, so there is no second
    // resolution for a rebinding answer to win.
    host: pinned.address,
    port: url.port ? Number(url.port) : 443,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers,
    setHost: false,
    // TLS names and verifies the ORIGINAL hostname, not the pinned literal,
    // so pinning does not weaken certificate verification.
    servername: hostname,
    checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(hostname, cert),
    family: pinned.family,
    lookup: createPinnedLookup(pinned) as unknown as HttpsRequestOptions["lookup"],
    // Not a shared, host-keyed pool: a pinned socket is never reused for a
    // differently-validated request.
    agent: false,
    signal: init.signal ?? undefined,
    timeout: CLIENT_METADATA_TIMEOUT_MS,
  };
}

function requestPinned(url: URL, pinned: PinnedAddress, init: ClientMetadataFetchInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const req = httpsRequest(
      buildPinnedRequestOptions(url, pinned, {
        method: typeof init.method === "string" ? init.method : "GET",
        headers: (init.headers as Record<string, string> | undefined) ?? {},
        signal: init.signal ?? null,
      }),
    );
    const failWith = (err: Error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };
    req.on("error", failWith);
    req.on("timeout", () => failWith(new Error("Socket timed out.")));
    req.on("response", (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        // Same contract as `redirect: "error"`: a redirect is a second,
        // unvetted destination and is never followed or pinned again.
        res.destroy();
        failWith(new ClientMetadataError("fetch_failed", `Client metadata document responded with a redirect (HTTP ${status}); redirects are never followed.`));
        return;
      }
      if (status < 200 || status > 599) {
        res.destroy();
        failWith(new ClientMetadataError("fetch_failed", `Client metadata document responded with an unusable HTTP status (${status}).`));
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const one of value) headers.append(key, one);
        else headers.set(key, String(value));
      }
      settled = true;
      const nullBody = status === 204 || status === 205 || status === 304;
      if (nullBody) {
        res.resume();
        resolve(new Response(null, { status, headers }));
        return;
      }
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
    });
    req.end();
  });
}

/**
 * The default transport. Fails CLOSED: without a pre-validated pinned address
 * — or with one that no longer passes the range check — it refuses rather than
 * resolving the hostname itself.
 */
export async function pinnedHttpsFetch(url: string, init: ClientMetadataFetchInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new ClientMetadataError("forbidden_host", "Client metadata documents are fetched over https only.");
  }
  const candidates = (init.pinnedAddresses ?? []).slice(0, MAX_PINNED_ADDRESSES);
  if (candidates.length === 0) {
    throw new ClientMetadataError("forbidden_host", "Refusing to fetch a client metadata document without a pre-validated pinned address.");
  }
  for (const candidate of candidates) {
    // Re-checked at connect time, not only at resolution time.
    if (isForbiddenAddress(candidate.address)) {
      throw new ClientMetadataError("forbidden_host", "client_id resolves to a private, loopback, link-local or reserved address.");
    }
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await requestPinned(parsed, candidate, init);
    } catch (err) {
      // A policy refusal, or a deadline we have already blown, is final —
      // only a transport-level failure moves on to the next validated address.
      if (err instanceof ClientMetadataError) throw err;
      if (init.signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Client metadata document could not be fetched.");
}

// ── Cache ─────────────────────────────────────────────────────────────────

/**
 * A bounded LRU keyed by metadata URL. `Map` iterates in insertion order, so
 * "least recently used" is simply the first key once every hit re-inserts its
 * entry at the tail. Expiry stays lazy per entry (a hit past `expiresAt` is a
 * miss, exactly as before) and is additionally swept whenever the map is at
 * capacity, so live entries are only ever evicted after every expired one is
 * gone. Both sweep and eviction are O(n) over at most
 * `CLIENT_METADATA_CACHE_MAX_ENTRIES` entries — cheap, and only paid on the
 * insert that would otherwise overflow.
 */
class BoundedTtlCache<V> {
  private readonly entries = new Map<string, { expiresAt: number; value: V }>();

  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.entries.size;
  }

  /** Live value for `key`, marking it most-recently-used; expired entries are dropped and reported as a miss. */
  get(key: string, now: number): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Remaining TTL in ms without touching recency, or null if absent/expired. */
  ttl(key: string, now: number): number | null {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > now ? entry.expiresAt - now : null;
  }

  set(key: string, value: V, expiresAt: number, now: number): void {
    // Re-inserting an existing key must not count against capacity twice.
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      this.sweepExpired(now);
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { expiresAt, value });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  sweepExpired(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

const positiveCache = new BoundedTtlCache<ClientIdMetadataDocument>(CLIENT_METADATA_CACHE_MAX_ENTRIES);
const negativeCache = new BoundedTtlCache<ClientMetadataError>(CLIENT_METADATA_CACHE_MAX_ENTRIES);

export function clearClientMetadataCache(): void {
  positiveCache.clear();
  negativeCache.clear();
}

/** Exposed for tests: remaining positive-cache TTL in ms, or null if absent/expired. */
export function clientMetadataCacheTtl(url: string, now = Date.now()): number | null {
  return positiveCache.ttl(url, now);
}

/** Exposed for tests: remaining negative-cache TTL in ms, or null if absent/expired. */
export function clientMetadataNegativeCacheTtl(url: string, now = Date.now()): number | null {
  return negativeCache.ttl(url, now);
}

/** Exposed for tests: current entry counts (expired-but-unswept entries included). */
export function clientMetadataCacheSize(): { positive: number; negative: number } {
  return { positive: positiveCache.size, negative: negativeCache.size };
}

/** Exposed for tests and operators: drop every expired entry now. Returns the number removed. */
export function sweepClientMetadataCache(now = Date.now()): number {
  return positiveCache.sweepExpired(now) + negativeCache.sweepExpired(now);
}

function ttlFromCacheControl(header: string | null): number {
  if (!header) return CLIENT_METADATA_DEFAULT_TTL_MS;
  const lower = header.toLowerCase();
  if (/(^|[,\s])no-store([,\s]|$)/.test(lower)) return CLIENT_METADATA_MIN_TTL_MS;
  const match = /(?:^|[,\s])(?:s-maxage|max-age)\s*=\s*(\d+)/.exec(lower);
  if (!match) return CLIENT_METADATA_DEFAULT_TTL_MS;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds)) return CLIENT_METADATA_DEFAULT_TTL_MS;
  return Math.min(CLIENT_METADATA_MAX_TTL_MS, Math.max(CLIENT_METADATA_MIN_TTL_MS, seconds * 1000));
}

// ── Guarded fetch ─────────────────────────────────────────────────────────

/**
 * Resolve `url`'s hostname, refuse the whole answer if ANY address is
 * forbidden, and return the validated answer so the caller can pin it to the
 * connection. The returned addresses are the only ones that may be dialled.
 */
async function assertHostFetchable(url: URL): Promise<PinnedAddress[]> {
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(hostname) !== 0) {
    throw new ClientMetadataError("forbidden_host", "client_id must use a DNS hostname, not a literal IP address.");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new ClientMetadataError("forbidden_host", "client_id points at a local or internal hostname.");
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupImpl(hostname);
  } catch {
    throw new ClientMetadataError("dns_failed", "client_id hostname could not be resolved.");
  }
  if (!addresses.length) throw new ClientMetadataError("dns_failed", "client_id hostname has no addresses.");
  // `isForbiddenAddress` fails closed on anything it cannot parse, so a
  // family-0 / malformed entry is caught here too.
  if (addresses.some((entry) => isForbiddenAddress(entry.address))) {
    throw new ClientMetadataError("forbidden_host", "client_id resolves to a private, loopback, link-local or reserved address.");
  }
  return addresses.map((entry) => ({ address: entry.address, family: isIP(entry.address) === 6 ? 6 : 4 }) as PinnedAddress);
}

async function readBodyCapped(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit) throw new ClientMetadataError("too_large", "Client metadata document exceeds 64 KiB.");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => undefined);
          throw new ClientMetadataError("too_large", "Client metadata document exceeds 64 KiB.");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
}

function fail(reason: ClientMetadataError["reason"], message: string): never {
  throw new ClientMetadataError(reason, message);
}

/** Validate a parsed JSON value as a Client ID Metadata Document for `url`. */
export function validateClientIdMetadataDocument(url: string, value: unknown): ClientIdMetadataDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_document", "Client metadata document must be a JSON object.");
  const doc = value as Record<string, unknown>;

  if (doc.client_id !== url) fail("invalid_document", "client_id in the metadata document must equal the document URL exactly.");

  // `client_name` is required by the MCP authorization spec (2025-11-25:
  // "MUST include at least client_id, client_name, redirect_uris"), so its
  // absence is still a reject — but an over-long one is truncated rather
  // than refused, since the length is our display limit, not the client's
  // error. The reserved-term ban that `registerClient` applies is
  // deliberately NOT applied here: on the unauthenticated RFC 7591 endpoint
  // anyone can POST any name, whereas a CIMD name is backed by a domain we
  // verified we could fetch from, and the consent screen shows that host
  // next to the name. Substring matching there would also reject an honest
  // "Unofficial Foo CLI" — and our own first-party client.
  const name = doc.client_name;
  if (typeof name !== "string" || name.trim().length === 0) {
    fail("invalid_document", "client_name must be a non-empty string.");
  }

  const redirectUris = doc.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    !redirectUris.every((uri): uri is string => typeof uri === "string" && isSafeRedirectUri(uri))
  ) {
    fail("invalid_document", "redirect_uris must be 1–20 safe HTTPS or loopback HTTP URLs.");
  }

  // draft-ietf-oauth-client-id-metadata-document §4.1 forbids only the
  // shared-symmetric-secret methods — a document may legally say "none",
  // omit the field, or name an asymmetric method (`private_key_jwt`,
  // `tls_client_auth`). Requiring an exact "none" rejected conformant
  // clients, so only the secret-based methods are refused here: a client
  // that expects to prove itself with a shared secret has misread a server
  // that advertises `token_endpoint_auth_methods_supported: ["none"]`, and
  // silently accepting it would let it believe it was authenticated when it
  // was not. Anything else is recorded as "none" and carried by PKCE, which
  // this server requires (S256) and the token endpoint verifies — see
  // `routes/mcp.ts` where a presented `client_secret` is refused outright.
  const authMethod = doc.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== null) {
    if (typeof authMethod !== "string") {
      fail("invalid_document", "token_endpoint_auth_method must be a string.");
    }
    if (SECRET_BASED_AUTH_METHODS.includes(authMethod)) {
      fail(
        "invalid_document",
        `token_endpoint_auth_method "${authMethod}" authenticates with a shared client secret; this server issues tokens to public PKCE clients only ("none").`,
      );
    }
  }

  // `grant_types` and `response_types` describe what the CLIENT can do
  // across every authorization server it talks to — not a demand on us. So
  // they are INTERSECTED with what this server issues rather than used to
  // reject the document: a client that also lists `client_credentials` or
  // `code id_token` for some other server is still a perfectly good
  // authorization-code client here. Only the absence of any grant we can
  // serve is fatal, and `/authorize` and `/token` enforce the per-request
  // rules independently.
  const allowedGrants = ["authorization_code", "refresh_token"];
  let grantTypes = allowedGrants;
  if (doc.grant_types !== undefined) {
    if (!Array.isArray(doc.grant_types) || doc.grant_types.some((g) => typeof g !== "string")) {
      fail("invalid_document", "grant_types must be an array of strings.");
    }
    grantTypes = [...new Set(doc.grant_types as string[])].filter((g) => allowedGrants.includes(g));
    if (!grantTypes.includes("authorization_code")) {
      fail("invalid_document", "grant_types must include authorization_code — this server issues no other initial grant.");
    }
  }

  if (doc.response_types !== undefined) {
    if (!Array.isArray(doc.response_types) || doc.response_types.some((t) => typeof t !== "string")) {
      fail("invalid_document", "response_types must be an array of strings.");
    }
    if (!(doc.response_types as string[]).includes("code")) {
      fail("invalid_document", "response_types must include \"code\" — this server supports no other response type.");
    }
  }

  return {
    client_id: url,
    client_name: (name as string).slice(0, 200),
    redirect_uris: [...new Set(redirectUris)],
    grant_types: grantTypes,
    token_endpoint_auth_method: "none",
    response_types: ["code"],
  };
}

async function fetchUncached(url: string): Promise<{ document: ClientIdMetadataDocument; ttlMs: number }> {
  const parsed = new URL(url);
  const pinnedAddresses = await assertHostFetchable(parsed);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_METADATA_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      // Belt and braces: honoured by an injected WHATWG `fetch`, while the
      // default pinned transport rejects a 3xx itself.
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "databounty-community-mcp-authorization-server" },
      // Pin the answer we just validated to the actual connection — without
      // this the default transport refuses to dial at all.
      pinnedAddresses,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new ClientMetadataError("timeout", "Client metadata document did not respond within 5 seconds.");
    throw new ClientMetadataError("fetch_failed", `Client metadata document could not be fetched${err instanceof Error && err.message ? ` (${err.message.slice(0, 120)})` : ""}.`);
  }

  try {
    if (response.status !== 200) fail("bad_status", `Client metadata document responded with HTTP ${response.status}.`);
    // `application/json` is the norm, but a `+json` suffix type is equally
    // JSON and a static host sometimes sends no Content-Type at all — in
    // both cases `JSON.parse` below is the real gate. What this check exists
    // to catch is an HTML body: a bot challenge or captive portal answering
    // 200 with a login page, which must never be read as a registration.
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== "" && contentType !== "application/json" && !contentType.endsWith("+json")) {
      fail("bad_content_type", `Client metadata document must be served as application/json, not ${contentType}.`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > CLIENT_METADATA_MAX_BYTES) fail("too_large", "Client metadata document exceeds 64 KiB.");

    let text: string;
    try {
      text = await readBodyCapped(response, CLIENT_METADATA_MAX_BYTES);
    } catch (err) {
      if (err instanceof ClientMetadataError) throw err;
      if (controller.signal.aborted) throw new ClientMetadataError("timeout", "Client metadata document did not respond within 5 seconds.");
      throw new ClientMetadataError("fetch_failed", "Client metadata document body could not be read.");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      fail("bad_json", "Client metadata document is not valid JSON.");
    }
    return { document: validateClientIdMetadataDocument(url, json), ttlMs: ttlFromCacheControl(response.headers.get("cache-control")) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch, validate and cache the Client ID Metadata Document at `url`.
 * Throws `ClientMetadataError` on any failure; the caller (mcp-oauth's
 * `resolveClient`) maps that to an OAuth `invalid_client`.
 */
export async function fetchClientIdMetadataDocument(url: string): Promise<ClientIdMetadataDocument> {
  if (!isClientIdMetadataUrl(url)) throw new ClientMetadataError("not_a_metadata_url", "client_id is not a valid client metadata URL.");
  const now = Date.now();

  const hit = positiveCache.get(url, now);
  if (hit) return hit;

  const miss = negativeCache.get(url, now);
  if (miss) throw miss;

  try {
    const { document, ttlMs } = await fetchUncached(url);
    positiveCache.set(url, document, now + ttlMs, now);
    return document;
  } catch (err) {
    const error = err instanceof ClientMetadataError ? err : new ClientMetadataError("fetch_failed", "Client metadata document could not be fetched.");
    negativeCache.set(url, error, now + CLIENT_METADATA_NEGATIVE_TTL_MS, now);
    throw error;
  }
}
