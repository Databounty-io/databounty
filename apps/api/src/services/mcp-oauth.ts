// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ApiKeyScope, OAuthClient, OAuthAuthorizationRequest } from "@prisma/client";
import { config, MCP_RESOURCE_PATH } from "../config.js";
import { getUserFromSessionToken } from "../lib/session.js";
import { sessionTokenFrom } from "../lib/session-cookie.js";
import { prisma } from "../lib/prisma.js";
import { ClientMetadataError, fetchClientIdMetadataDocument, isClientIdMetadataUrl } from "./mcp-client-metadata.js";

/**
 * MCP OAuth 2.1 authorization server for the Community API.
 *
 * Ported from the v1 implementation (`databounty-api/src/services/
 * mcp-oauth.ts`) with two deliberate differences, both forced by what this
 * service actually has:
 *
 *  - No verified-token cache. Community has no `lib/cache` abstraction, so
 *    `verifyMcpAccessToken` reads the row on every call. Slower, never less
 *    correct: a revoked token stops working on the very next request with no
 *    TTL window at all.
 *  - Public URLs come from env (`MCP_PUBLIC_URL`, `APP_URL`) rather than a
 *    `config.dashboardUrl`, which Community does not define. See
 *    `mcpPublicBaseUrl()` below — an operator MUST set MCP_PUBLIC_URL in any
 *    real deployment or every issued credential is bound to a localhost
 *    audience. The consent page path is always `${config.appUrl}/mcp/authorize`
 *    — v1 hardcodes the same path with no env override, and a prior
 *    `MCP_CONSENT_URL` override here let a stale deployed value (pointed at a
 *    nonexistent `/settings/api`) silently break every OAuth connect on dev;
 *    removed rather than fixed, since there is no legitimate reason for this
 *    path to differ from the one page that serves it.
 *
 * Everything else — PKCE S256, single-use codes, bounded refresh-reuse
 * recovery, resource-indicator normalisation, and the OAuthAuditEvent trail —
 * follows the v1 contract.
 */

/** Scope names this authorization server issues. Mirrors the `ApiKeyScope`
 *  enum exactly, so one credential path cannot grant what the other cannot. */
export const MCP_SCOPES = ["read", "contribute", "validate", "artifact", "sponsor", "account"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Streamable HTTP uses the single public MCP endpoint. Defined next to the
 *  `MCP_PUBLIC_URL` normaliser in config.ts so both agree; re-exported here
 *  for existing importers. */
export { MCP_RESOURCE_PATH };

const CLIENT_ID_PREFIX = "db_mcp_client_";
const CODE_PREFIX = "db_mcp_code_";
const ACCESS_PREFIX = "db_mcp_at_";
/** Exported so the per-credential rate limiter (app.ts) can recognise OAuth
 *  MCP access tokens and bucket them by (userId, clientId) rather than by IP. */
export const MCP_ACCESS_TOKEN_PREFIX = ACCESS_PREFIX;
const REFRESH_PREFIX = "db_mcp_rt_";

const CODE_TTL_MS = 60_000;
/** Access tokens are opaque and re-validated against the database on every
 *  request, so this bounds refresh churn, not revocation latency. */
const ACCESS_TTL_MS = 8 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
/**
 * A rotation-retired refresh token may be reused briefly when two client
 * processes race or the winning response is lost in flight. The grace never
 * applies to explicit revocation and requires a live successor for the same
 * grant, so disconnect and suspension remain fail-closed.
 *
 * This matches the V1 recovery contract for Codex-class clients that share a
 * credential store across processes.
 */
const REFRESH_REUSE_GRACE_MS = 60_000;
export type AuthorizationRequestFailure = "not_found" | "expired" | "already_completed";

export class McpOAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    /** Machine-readable detail for the consent screen; never sent to the OAuth
     *  client itself, which only ever sees `code` in its redirect. */
    public readonly reason?: AuthorizationRequestFailure,
  ) {
    super(message);
    this.name = "McpOAuthError";
  }
}

function opaque(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function hash(value: string): string {
  return createHmac("sha256", config.sessionSecret).update(value).digest("hex");
}

function withinReuseGrace(rotatedAt: Date | null): boolean {
  return rotatedAt !== null && Date.now() - rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS;
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time compare of two hex digests. Exported for the session-binding
 *  check in the transport, which compares an HMAC the same way. */
export function equalHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Public origin this MCP server is reached at. Bound into every issued
 * credential as its RFC 8707 audience, so it must be the URL clients actually
 * configure. There is no safe way to derive it from the request (the Host
 * header is attacker-controlled and would let a credential be minted for
 * someone else's audience), so it is `config.mcpPublicUrl` — env-pinned via
 * `MCP_PUBLIC_URL` and boot-guarded against a localhost default in production
 * (see `config.ts`); the fallback is only ever right for local development.
 */
function mcpPublicBaseUrl(): string {
  return trimSlashes(config.mcpPublicUrl);
}

/** Where the browser is sent to approve a consent request: the Community web
 *  app's own `/mcp/authorize` page. No env override — see the module-level
 *  comment above for why one existed and why it was removed. */
function consentBaseUrl(): string {
  return `${trimSlashes(config.appUrl)}/mcp/authorize`;
}

export function mcpResourceUrl(): string {
  return `${mcpPublicBaseUrl()}${MCP_RESOURCE_PATH}`;
}

export function authorizationServerUrl(): string {
  return `${mcpPublicBaseUrl()}${MCP_RESOURCE_PATH}`;
}

/**
 * RFC 8414 / RFC 9728 path insertion for an issuer/resource that carries a
 * path. The `/mcp/.well-known/...` aliases stay registered for previously
 * configured clients, but this canonical URL is what WWW-Authenticate
 * advertises.
 */
export function protectedResourceMetadataUrl(): string {
  return `${mcpPublicBaseUrl()}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
}

/**
 * RFC 8707 resource indicators are compared after normalisation, not by raw
 * string equality: a client whose configured server URL carries a trailing
 * slash sends that as its `resource`, and byte-equality turned an otherwise
 * perfect authorization into an undiagnosable `invalid_target`. Scheme and
 * host are case-insensitive per RFC 3986; the path is not, so only its
 * trailing slashes are trimmed. A fragment is forbidden (RFC 8707 §2) and
 * anything unparseable returns null so callers fail closed.
 */
export function canonicalResource(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hash) return null;
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.search ? url.toString() : trimSlashes(url.toString());
}

/** The one audience this authorization server issues credentials for. */
function canonicalMcpResource(): string {
  return canonicalResource(mcpResourceUrl()) ?? mcpResourceUrl();
}

/** Older clients omit `resource` entirely; this server protects exactly one
 *  resource, so an omitted value means that resource. An unparseable value is
 *  null, never a silent default. */
function requestedResource(value: string | undefined): string | null {
  return value === undefined ? canonicalMcpResource() : canonicalResource(value);
}

function storedResource(value: string | null): string {
  return value === null ? canonicalMcpResource() : canonicalResource(value) ?? value;
}

export function parseScopes(
  value: string | string[] | undefined,
  fallback: readonly string[] = MCP_SCOPES,
): McpScope[] {
  const raw = Array.isArray(value)
    ? value.flatMap((item) => item.split(/[ ,]+/))
    : (value ?? fallback.join(" ")).split(/[ ,]+/);
  const unique = [...new Set(raw.filter(Boolean))];
  if (unique.length === 0) throw new McpOAuthError("invalid_scope", "At least one MCP scope is required.");
  if (unique.some((scope) => !(MCP_SCOPES as readonly string[]).includes(scope))) {
    throw new McpOAuthError("invalid_scope", "Requested MCP scope is not supported.");
  }
  return unique as McpScope[];
}

const MAX_REDIRECT_URI_LENGTH = 2048;

export function isSafeRedirectUri(value: string): boolean {
  if (value.length > MAX_REDIRECT_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || !url.protocol || !url.hostname) return false;
  // Reject embedded userinfo (`https://user:pass@host/...` or
  // `https://trusted-looking-name@evil.example/`) — a classic phishing /
  // open-redirect trick with no legitimate redirect_uri use case.
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function redirectMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  try {
    const a = new URL(requested);
    const b = new URL(registered);
    // Loopback redirect URIs use an ephemeral port the client picks at run
    // time (RFC 8252 §7.3), so the port is the one component allowed to vary.
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(a.hostname) && a.hostname === b.hostname;
    return loopback && a.protocol === "http:" && b.protocol === "http:" && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

function record(action: string, data: { clientId?: string; userId?: string; ip?: string; userAgent?: string; metadata?: object }) {
  return prisma.oAuthAuditEvent
    .create({
      data: {
        action,
        clientId: data.clientId,
        userId: data.userId,
        ip: data.ip,
        userAgent: data.userAgent,
        metadata: data.metadata,
      },
    })
    .catch((err) => {
      // The OAuth flow must not fail because its audit trail hiccuped, but a
      // dropped audit event is a compliance-relevant loss — always surface it.
      console.error(`[mcp-oauth] failed to record audit event "${action}":`, err instanceof Error ? err.message : err);
      return undefined;
    });
}

// Reserved/brand terms a third-party MCP client name must not contain — this
// is a public, unauthenticated registration endpoint (RFC 7591), so nothing
// here should let a client name itself into looking like a trusted
// first-party app on a real user's consent screen.
export const RESERVED_CLIENT_NAME_TERMS = ["databounty", "official"] as const;

export async function registerClient(input: {
  redirectUris: string[];
  clientName?: string;
  grantTypes?: string[];
  tokenEndpointAuthMethod?: string;
  ownerUserId?: string;
}) {
  if (!input.redirectUris.length || input.redirectUris.length > 20 || input.redirectUris.some((uri) => !isSafeRedirectUri(uri))) {
    // RFC 7591 §3.2.2 defines a dedicated code for this. Reporting the generic
    // `invalid_client_metadata` left a client unable to tell a rejected
    // redirect URI apart from a rejected grant type or auth method.
    throw new McpOAuthError("invalid_redirect_uri", "redirect_uris must contain safe HTTPS or loopback HTTP URLs.");
  }
  if (input.clientName) {
    const lowerName = input.clientName.toLowerCase();
    if (RESERVED_CLIENT_NAME_TERMS.some((term) => lowerName.includes(term))) {
      throw new McpOAuthError(
        "invalid_client_metadata",
        `client_name must not contain reserved terms: ${RESERVED_CLIENT_NAME_TERMS.join(", ")}.`,
      );
    }
  }
  // Intersect rather than reject, matching the CIMD path. A client's
  // `grant_types` describes what it can do across every authorization server
  // it talks to, not what it demands of us: VS Code's registration body lists
  // `urn:ietf:params:oauth:grant-type:device_code` alongside the two we serve,
  // and rejecting the whole registration over it locked VS Code out entirely.
  // RFC 7591 §3.2.1 lets the server register its own values and report them
  // back in the response, which is what happens here. Only having nothing we
  // can serve is fatal.
  const requestedGrants = input.grantTypes ?? ["authorization_code", "refresh_token"];
  const grantTypes = [...new Set(requestedGrants)].filter((grant) => ["authorization_code", "refresh_token"].includes(grant));
  if (!grantTypes.includes("authorization_code")) {
    throw new McpOAuthError("invalid_client_metadata", "grant_types must include authorization_code — this server issues no other initial grant.");
  }
  if (input.tokenEndpointAuthMethod && input.tokenEndpointAuthMethod !== "none") {
    throw new McpOAuthError("invalid_client_metadata", "MCP clients must use PKCE public-client authentication.");
  }
  const clientId = opaque(CLIENT_ID_PREFIX);
  const client: OAuthClient = await prisma.oAuthClient.create({
    data: {
      clientId,
      clientName: input.clientName?.slice(0, 200),
      redirectUris: input.redirectUris,
      grantTypes,
      tokenEndpointAuthMethod: "none",
      ownerUserId: input.ownerUserId,
    },
  });
  await record("client.registered", { clientId, userId: input.ownerUserId, metadata: { clientName: client.clientName } });
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    client_name: client.clientName ?? undefined,
  };
}

export async function getClient(clientId: string): Promise<OAuthClient> {
  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client) throw new McpOAuthError("invalid_client", "Unknown OAuth client.", 401);
  return client;
}

/**
 * Resolve a client-PRESENTED `client_id` — the one arriving on `/authorize`
 * or `/token` — to an `OAuthClient` row.
 *
 *  - An opaque `db_mcp_client_*` id is a dynamic registration: plain lookup.
 *  - An https URL is an OAuth Client ID Metadata Document (see
 *    `mcp-client-metadata.ts`). The document is fetched (SSRF-guarded,
 *    cached) and mirrored into `oauth_clients` via upsert, keyed on the URL,
 *    so every FK-linked authorization request, code, token and audit event
 *    keeps working unchanged and the dashboard grant list can show the
 *    client's name. The row is refreshed on every successful fetch, so a
 *    client that rotates its redirect URIs is picked up within one cache TTL.
 *
 * `fallbackToStored` is for the token and refresh endpoints only: there the
 * code/refresh row is already bound to this exact clientId and PKCE does the
 * real proof, so a transient failure to re-fetch the document must not wedge
 * a client mid-exchange. `/authorize` never falls back — a fresh document is
 * the registration, and without it there is nothing to validate the
 * redirect_uri against.
 *
 * `getClient` stays as-is for consent-page reads of an already-stored
 * request, which must never trigger an outbound fetch.
 */
export async function resolveClient(clientId: string, options: { fallbackToStored?: boolean } = {}): Promise<OAuthClient> {
  if (!isClientIdMetadataUrl(clientId)) return getClient(clientId);
  let document: Awaited<ReturnType<typeof fetchClientIdMetadataDocument>>;
  try {
    document = await fetchClientIdMetadataDocument(clientId);
  } catch (err) {
    if (options.fallbackToStored) {
      const stored = await prisma.oAuthClient.findUnique({ where: { clientId } });
      if (stored) return stored;
    }
    const detail = err instanceof ClientMetadataError ? err.message : "Client metadata document could not be fetched.";
    throw new McpOAuthError("invalid_client", `Client ID metadata document rejected: ${detail}`, 401);
  }
  const existing = await prisma.oAuthClient.findUnique({ where: { clientId }, select: { id: true } });
  const client = await prisma.oAuthClient.upsert({
    where: { clientId },
    create: {
      clientId,
      clientName: document.client_name.slice(0, 200),
      redirectUris: document.redirect_uris,
      grantTypes: document.grant_types,
      tokenEndpointAuthMethod: "none",
    },
    update: {
      clientName: document.client_name.slice(0, 200),
      redirectUris: document.redirect_uris,
      grantTypes: document.grant_types,
      tokenEndpointAuthMethod: "none",
    },
  });
  if (!existing) {
    await record("client.metadata_document_registered", { clientId, metadata: { clientName: client.clientName, host: new URL(clientId).host } });
  }
  return client;
}

export async function createAuthorizationRequest(input: {
  clientId: string;
  redirectUri: string;
  scope: McpScope[];
  state?: string;
  codeChallenge: string;
  resource?: string;
}) {
  const client = await resolveClient(input.clientId);
  const resource = requestedResource(input.resource);
  if (resource === null || resource !== canonicalMcpResource()) {
    throw new McpOAuthError("invalid_target", "OAuth resource must be the DataBounty Community MCP endpoint.");
  }
  if (!client.redirectUris.some((uri) => redirectMatches(input.redirectUri, uri))) {
    throw new McpOAuthError("invalid_request", "redirect_uri is not registered.");
  }
  if (!input.codeChallenge || !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) {
    throw new McpOAuthError("invalid_request", "A valid S256 PKCE code_challenge is required.");
  }
  const request = await prisma.oAuthAuthorizationRequest.create({
    data: {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scope: input.scope,
      state: input.state,
      codeChallenge: input.codeChallenge,
      resource,
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    },
  });
  return { request, client };
}

export async function getAuthorizationRequest(id: string): Promise<OAuthAuthorizationRequest> {
  const request = await prisma.oAuthAuthorizationRequest.findUnique({ where: { id } });
  if (!request) throw new McpOAuthError("invalid_request", "Authorization request is missing.", 400, "not_found");
  // Completed is checked BEFORE expired on purpose: a request approved five
  // minutes ago and now past its TTL is both, and "you already approved this"
  // is the fact the person in front of the screen needs.
  if (request.approvedAt || request.deniedAt) {
    throw new McpOAuthError("invalid_request", "Authorization request is already completed.", 400, "already_completed");
  }
  if (request.expiresAt < new Date()) {
    throw new McpOAuthError("invalid_request", "Authorization request has expired.", 400, "expired");
  }
  return request;
}

export async function approveAuthorizationRequest(
  requestId: string,
  userId: string,
  selectedScopes: McpScope[],
  context?: { ip?: string; userAgent?: string },
) {
  const code = opaque(CODE_PREFIX);
  const request = await prisma.$transaction(async (tx) => {
    const row = await tx.oAuthAuthorizationRequest.findUnique({ where: { id: requestId } });
    if (!row) throw new McpOAuthError("invalid_request", "Authorization request is missing.", 400, "not_found");
    if (row.approvedAt || row.deniedAt) {
      throw new McpOAuthError("invalid_request", "Authorization request is already completed.", 400, "already_completed");
    }
    if (row.expiresAt < new Date()) {
      throw new McpOAuthError("invalid_request", "Authorization request has expired.", 400, "expired");
    }
    if (selectedScopes.length === 0) throw new McpOAuthError("invalid_scope", "Choose at least one permission to continue.");
    if (selectedScopes.some((scope) => !row.scope.includes(scope))) {
      throw new McpOAuthError("invalid_scope", "A selected permission was not requested by this MCP client.");
    }
    const updated = await tx.oAuthAuthorizationRequest.updateMany({
      where: { id: requestId, approvedAt: null, deniedAt: null, expiresAt: { gt: new Date() } },
      data: { userId, scope: selectedScopes, approvedAt: new Date() },
    });
    if (updated.count !== 1) throw new McpOAuthError("invalid_request", "Authorization request was already completed.");
    await tx.oAuthAuthorizationCode.create({
      data: {
        codeHash: hash(code),
        clientId: row.clientId,
        userId,
        redirectUri: row.redirectUri,
        scope: selectedScopes,
        codeChallenge: row.codeChallenge,
        resource: row.resource,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    return row;
  });
  await record("authorization.approved", { clientId: request.clientId, userId, ...context, metadata: { scopes: selectedScopes } });
  return { code, redirectUri: request.redirectUri, state: request.state, issuer: authorizationServerUrl() };
}

export async function denyAuthorizationRequest(requestId: string, userId: string, context?: { ip?: string; userAgent?: string }) {
  const request = await getAuthorizationRequest(requestId);
  if (request.userId && request.userId !== userId) {
    throw new McpOAuthError("access_denied", "Authorization request belongs to another account.", 403);
  }
  await prisma.oAuthAuthorizationRequest.updateMany({
    where: { id: requestId, deniedAt: null, approvedAt: null },
    data: { userId, deniedAt: new Date() },
  });
  await record("authorization.denied", { clientId: request.clientId, userId, ...context });
  return { redirectUri: request.redirectUri, state: request.state, issuer: authorizationServerUrl() };
}

function tokenResponse(accessToken: string, refreshToken: string, scope: string[]) {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: scope.join(" "),
  };
}

export async function exchangeAuthorizationCode(
  input: { clientId: string; code: string; codeVerifier: string; redirectUri: string; resource?: string },
  context?: { ip?: string; userAgent?: string },
) {
  const client = await resolveClient(input.clientId, { fallbackToStored: true });
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
    throw new McpOAuthError("invalid_grant", "PKCE code_verifier is invalid.");
  }
  const row = await prisma.oAuthAuthorizationCode.findUnique({
    where: { codeHash: hash(input.code) },
    include: { user: { select: { status: true } } },
  });
  // OAuth 2.1 §4.1.3 / §7.5.3: a code presented a second time after it was
  // already consumed is a replay, and replay of a one-time code is the
  // textbook signal that it was intercepted in transit. The spec's own words
  // are that the server SHOULD then revoke every token issued from that
  // code — leaving them alive turned a real interception signal into a
  // no-op refusal. Detected and handled BEFORE the other validation checks,
  // and — deliberately — the client still sees the exact same
  // `invalid_grant` message as an unknown or expired code: no oracle should
  // exist telling an attacker their replay was recognized as such.
  if (row && row.usedAt) {
    await revokeTokensFromAuthorizationCode(row.id, { clientId: row.clientId, userId: row.userId, ...context });
    throw new McpOAuthError("invalid_grant", "Authorization code is invalid or expired.");
  }
  if (!row || row.clientId !== client.clientId || row.expiresAt < new Date() || row.redirectUri !== input.redirectUri) {
    throw new McpOAuthError("invalid_grant", "Authorization code is invalid or expired.");
  }
  if (row.user.status !== "active") throw new McpOAuthError("invalid_grant", "Account is not active.");
  if (sha256Base64Url(input.codeVerifier) !== row.codeChallenge) throw new McpOAuthError("invalid_grant", "PKCE verification failed.");
  const resource = requestedResource(input.resource);
  if (resource === null || storedResource(row.resource) !== resource) {
    throw new McpOAuthError("invalid_grant", "OAuth resource does not match.");
  }
  const access = opaque(ACCESS_PREFIX);
  const refresh = opaque(REFRESH_PREFIX);
  await prisma.$transaction(async (tx) => {
    const used = await tx.oAuthAuthorizationCode.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) throw new McpOAuthError("invalid_grant", "Authorization code has already been used.");
    await tx.oAuthAccessToken.create({
      data: {
        tokenHash: hash(access),
        clientId: row.clientId,
        userId: row.userId,
        scope: row.scope,
        resource,
        expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
        authorizationCodeId: row.id,
      },
    });
    await tx.oAuthRefreshToken.create({
      data: {
        tokenHash: hash(refresh),
        clientId: row.clientId,
        userId: row.userId,
        scope: row.scope,
        resource,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        authorizationCodeId: row.id,
      },
    });
  });
  await record("token.issued", { clientId: row.clientId, userId: row.userId, ...context });
  return tokenResponse(access, refresh, row.scope);
}

export async function exchangeRefreshToken(
  input: { clientId: string; refreshToken: string; scope?: McpScope[]; resource?: string },
  context?: { ip?: string; userAgent?: string },
) {
  const client = await resolveClient(input.clientId, { fallbackToStored: true });
  const existing = await prisma.oAuthRefreshToken.findUnique({
    where: { tokenHash: hash(input.refreshToken) },
    include: { user: { select: { status: true } } },
  });
  if (!existing || existing.clientId !== client.clientId || existing.expiresAt < new Date()) {
    throw new McpOAuthError("invalid_grant", "Refresh token is invalid or expired.");
  }
  // A refresh retired by rotation gets a short recovery window for ordinary
  // client races and lost responses. Explicit revocation leaves rotatedAt
  // null and never qualifies. Past the window the replay is rejected, but it
  // must not burn the healthy successor grant held by the winning process.
  const replayed = existing.revokedAt !== null;
  if (replayed && !withinReuseGrace(existing.rotatedAt)) {
    await record("refresh.replay_rejected", { clientId: existing.clientId, userId: existing.userId, ...context });
    throw new McpOAuthError("invalid_grant", "Refresh token is invalid or has already been used.");
  }
  if (existing.user.status !== "active") throw new McpOAuthError("invalid_grant", "Account is not active.");
  const resource = requestedResource(input.resource);
  if (resource === null || storedResource(existing.resource) !== resource) {
    throw new McpOAuthError("invalid_grant", "OAuth resource does not match.");
  }
  // OAuth 2.1 §4.3.3: "If a new refresh token is issued, the refresh token
  // scope MUST be identical to that of the refresh token included by the
  // client in the request." A client MAY narrow what its ACCESS token can do
  // on a given refresh, but that must not permanently shrink the grant — a
  // client that narrows once (e.g. to request a background task's minimum
  // scope) and later needs the rest of what it was originally approved for
  // must still be able to get it, without the user re-consenting. Storing
  // the narrowed value on the new refresh token did exactly that: the grant
  // shrank on every refresh and never grew back.
  const accessScope = input.scope ?? (existing.scope as McpScope[]);
  if (accessScope.some((item) => !existing.scope.includes(item))) {
    throw new McpOAuthError("invalid_scope", "Cannot increase scope during refresh.");
  }
  const refreshScope = existing.scope as McpScope[];
  const access = opaque(ACCESS_PREFIX);
  const refresh = opaque(REFRESH_PREFIX);
  let graced = replayed;
  await prisma.$transaction(async (tx) => {
    if (!graced) {
      const rotated = await tx.oAuthRefreshToken.updateMany({
        where: { id: existing.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date(), rotatedAt: new Date() },
      });
      if (rotated.count !== 1) {
        // A concurrent caller can lose the guarded write after both requests
        // read the token as live. Re-read the winning rotation and converge
        // through the same bounded grace path.
        const current = await tx.oAuthRefreshToken.findUnique({ where: { id: existing.id }, select: { rotatedAt: true } });
        if (!current || !withinReuseGrace(current.rotatedAt)) {
          throw new McpOAuthError("invalid_grant", "Refresh token has already been rotated.");
        }
        graced = true;
      }
    }
    if (graced) {
      const live = await tx.oAuthRefreshToken.findFirst({
        where: {
          userId: existing.userId,
          clientId: existing.clientId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!live) {
        throw new McpOAuthError("invalid_grant", "Refresh token is invalid or has already been used.");
      }
    }
    await tx.oAuthAccessToken.create({
      data: { tokenHash: hash(access), clientId: existing.clientId, userId: existing.userId, scope: accessScope, resource, expiresAt: new Date(Date.now() + ACCESS_TTL_MS) },
    });
    await tx.oAuthRefreshToken.create({
      data: { tokenHash: hash(refresh), clientId: existing.clientId, userId: existing.userId, scope: refreshScope, resource, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    });
  });
  await record(graced ? "refresh.grace_reissued" : "refresh.rotated", { clientId: existing.clientId, userId: existing.userId, ...context });
  return tokenResponse(access, refresh, accessScope);
}

export interface VerifiedMcpAccessToken {
  userId: string;
  clientId: string;
  scopes: ApiKeyScope[];
}

export async function verifyMcpAccessToken(token: string): Promise<VerifiedMcpAccessToken | null> {
  if (!token.startsWith(ACCESS_PREFIX)) return null;
  const tokenHash = hash(token);
  const row = await prisma.oAuthAccessToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { status: true } } },
  });
  if (
    !row ||
    row.revokedAt ||
    row.expiresAt < new Date() ||
    row.user.status !== "active" ||
    storedResource(row.resource) !== canonicalMcpResource()
  ) {
    return null;
  }
  return { userId: row.userId, clientId: row.clientId, scopes: row.scope as ApiKeyScope[] };
}

/**
 * OAuth 2.1 §4.1.3 / §7.5.3 replay response: every access and refresh token
 * ever minted from `authorizationCodeId` is revoked, not just the most
 * recent pair — a code can only be exchanged once by design, so in practice
 * there is exactly one pair, but the query does not assume that.
 * `authorizationCodeId` is null on every token minted before this column
 * existed and on every refresh-minted token, so this is a pure addition: it
 * can only find MORE to revoke than the old code did, never less.
 */
async function revokeTokensFromAuthorizationCode(
  authorizationCodeId: string,
  context: { clientId: string; userId: string; ip?: string; userAgent?: string },
) {
  const now = new Date();
  const [access, refresh] = await prisma.$transaction([
    prisma.oAuthAccessToken.updateMany({ where: { authorizationCodeId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.oAuthRefreshToken.updateMany({ where: { authorizationCodeId, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  if (access.count || refresh.count) {
    await record("token.revoked_code_replay", {
      clientId: context.clientId,
      userId: context.userId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { authorizationCodeId, revokedAccessTokens: access.count, revokedRefreshTokens: refresh.count },
    });
  }
}

/**
 * RFC 7009 single-token revocation.
 *
 * `requestingClientId` is REQUIRED by §2.1: "the authorization server ...
 * verifies whether the token was issued to the client making the revocation
 * request. If this validation fails, the request is refused." Without it any
 * party who observed a token value could revoke it — an unauthenticated
 * denial-of-service handle over someone else's session. A token belonging to
 * a different client is left untouched, and the route still answers 200
 * (§2.2) so the endpoint never becomes a token-validity oracle.
 *
 * §2.1 also says the server SHOULD invalidate all access tokens based on the
 * same authorization grant when a refresh token is revoked. Returning after
 * the first matching table left the grant's access token live for the rest of
 * its TTL after the client believed the whole grant was gone, so a refresh
 * revocation now sweeps the grant's access tokens too.
 */
export async function revokeMcpToken(token: string, requestingClientId?: string) {
  const tokenHash = hash(token);
  // Read the owning client/user BEFORE revoking so the single-token
  // revocation leaves the same audit trail the per-client grant revoke does —
  // updateMany returns only a count, not the rows.
  const accessRow = await prisma.oAuthAccessToken.findFirst({ where: { tokenHash, revokedAt: null }, select: { clientId: true, userId: true } });
  if (accessRow) {
    if (requestingClientId && accessRow.clientId !== requestingClientId) return;
    const access = await prisma.oAuthAccessToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } });
    if (access.count) {
      await record("token.revoked", { clientId: accessRow.clientId, userId: accessRow.userId, metadata: { kind: "access" } });
    }
    return;
  }
  const refreshRow = await prisma.oAuthRefreshToken.findFirst({
    where: { tokenHash, revokedAt: null },
    select: { clientId: true, userId: true, resource: true },
  });
  if (!refreshRow) return;
  if (requestingClientId && refreshRow.clientId !== requestingClientId) return;
  const now = new Date();
  const refresh = await prisma.oAuthRefreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: now } });
  if (!refresh.count) return;
  // The grant, not just the presented token: same client, same user, same
  // audience. Scoping on `resource` keeps a revocation from reaching across
  // to a grant minted for a different resource, if this server ever protects
  // more than one.
  const cascaded = await prisma.oAuthAccessToken.updateMany({
    where: { clientId: refreshRow.clientId, userId: refreshRow.userId, resource: refreshRow.resource, revokedAt: null },
    data: { revokedAt: now },
  });
  await record("token.revoked", {
    clientId: refreshRow.clientId,
    userId: refreshRow.userId,
    metadata: { kind: "refresh", cascadedAccessTokens: cascaded.count },
  });
}

export async function listMcpGrants(userId: string) {
  const [access, refresh] = await Promise.all([
    prisma.oAuthAccessToken.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, include: { client: true }, orderBy: { createdAt: "desc" } }),
    prisma.oAuthRefreshToken.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, include: { client: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const clients = new Map<string, { clientId: string; clientName: string; scopes: string[]; lastUsedAt: Date }>();
  for (const row of [...access, ...refresh]) {
    const existing = clients.get(row.clientId);
    if (!existing || row.createdAt > existing.lastUsedAt) {
      clients.set(row.clientId, {
        clientId: row.clientId,
        clientName: row.client.clientName ?? row.client.clientId,
        scopes: row.scope,
        lastUsedAt: row.createdAt,
      });
    }
  }
  return [...clients.values()];
}

export async function revokeMcpGrant(userId: string, clientId: string) {
  const [access, refresh] = await prisma.$transaction([
    prisma.oAuthAccessToken.updateMany({ where: { userId, clientId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.oAuthRefreshToken.updateMany({ where: { userId, clientId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await record("grant.revoked", { clientId, userId, metadata: { accessTokens: access.count, refreshTokens: refresh.count } });
  return { revoked: access.count + refresh.count > 0 };
}

/**
 * User-level "disconnect every MCP client" — the revoke-all counterpart to the
 * per-client revokeMcpGrant. Unlike account suspension (which only gates
 * future requests via the per-user status check and leaves revokedAt null)
 * this hard-revokes, so the tokens never resume working.
 */
export async function revokeAllMcpGrants(userId: string) {
  const [access, refresh] = await prisma.$transaction([
    prisma.oAuthAccessToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.oAuthRefreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await record("grant.revoked_all", { userId, metadata: { accessTokens: access.count, refreshTokens: refresh.count } });
  return { revoked: access.count + refresh.count > 0, accessTokens: access.count, refreshTokens: refresh.count };
}

/**
 * Per-tool-call audit trail for the hosted MCP server. OAuth auth-state
 * transitions are audited above (token.issued, grant.revoked, …); this covers
 * the individual tool invocations that ride on those credentials.
 * Fire-and-forget (record() self-catches) so auditing never blocks or fails a
 * tool call. Records the tool name, principal, outcome and latency — never the
 * argument payload, which may carry submission content or personal data.
 */
export function recordMcpToolInvocation(input: {
  principal?: { userId: string; clientId?: string; keyId?: string };
  tool: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  ip?: string;
  userAgent?: string;
}) {
  return record("tool.invoked", {
    // clientId is only set for OAuth principals (FK to OAuthClient); API-key
    // principals leave it null and carry keyId in metadata instead.
    clientId: input.principal?.clientId,
    userId: input.principal?.userId,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: {
      tool: input.tool,
      ok: input.ok,
      durationMs: input.durationMs,
      ...(input.principal?.keyId ? { keyId: input.principal.keyId } : {}),
      ...(input.error ? { error: input.error.slice(0, 300) } : {}),
    },
  });
}

export async function userFromDashboardSession(req: FastifyRequest) {
  const token = sessionTokenFrom(req);
  return token ? getUserFromSessionToken(token) : null;
}

/**
 * How long a client registration is kept once it has no live child row at
 * all — no pending authorization request, no code, no access or refresh
 * token, ever. Long enough that a client mid-flow (registered, waiting on
 * the person to approve in their browser) is never at risk: the longest any
 * of those rows can stay pending is `REQUEST_TTL_MS` (10 minutes) before it
 * is deleted above in the same run, so a day of headroom is generous, not
 * tight.
 */
const ORPHAN_CLIENT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Periodic cleanup of expired OAuth rows, plus orphaned client registrations.
 * Safe to run concurrently.
 *
 * `POST /mcp/oauth/register` (RFC 7591) is unauthenticated, rate-limited only
 * by the global per-IP bucket, and every registration is a permanent
 * `oauth_clients` row — this was never pruned. That is not only an abuse
 * surface: Zed re-runs DCR on every single connection because its OAuth
 * callback binds an ephemeral port that changes each time, so ordinary,
 * well-behaved use of one real client can grow this table without bound.
 * A client is pruned only once it has NO row left in any of the four
 * relations that make it "in use" — none pending, none ever issued, or
 * every one already expired-and-deleted above — and is older than the grace
 * period, so nothing mid-flow is ever touched. Deleting a client sets
 * `clientId` to null on its `oauth_audit_events` rows (schema `onDelete:
 * SetNull`) rather than deleting them, so the audit trail survives.
 */
export async function cleanupMcpOAuth() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ORPHAN_CLIENT_GRACE_MS);
  await prisma.$transaction([
    prisma.oAuthAuthorizationRequest.deleteMany({ where: { expiresAt: { lt: now } } }),
    // Expired tokens FIRST — the authorization-code delete right after this
    // reads the post-delete state of these two tables in the same
    // transaction, which is what lets a used code become prunable the
    // moment its last token is gone rather than waiting out a second sweep.
    prisma.oAuthAccessToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.oAuthRefreshToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    // An UNUSED expired code carries no revocation value — nothing was ever
    // minted from it — so it is deleted on the original schedule. A USED
    // code is deliberately NOT deleted just because `expiresAt` has passed:
    // `revokeTokensFromAuthorizationCode` needs the row to still exist when
    // a replay arrives, and `CODE_TTL_MS` is only 60 seconds, so an
    // unconditional delete-on-expiry would sever that link within the very
    // first sweep after nearly every legitimate exchange — silently making
    // the replay-revocation feature inert for the realistic case of a
    // delayed replay. A used code is instead kept until it has genuinely
    // nothing left to protect: every token it ever minted is either revoked
    // or has itself expired (and been deleted above in this same
    // transaction). At that point revoking-on-replay would be a no-op
    // anyway, so the row is safe to prune immediately — no separate grace
    // period is needed, because a used code can never be exchanged again.
    prisma.oAuthAuthorizationCode.deleteMany({
      where: {
        OR: [
          { usedAt: null, expiresAt: { lt: now } },
          {
            usedAt: { not: null },
            accessTokens: { none: { revokedAt: null, expiresAt: { gt: now } } },
            refreshTokens: { none: { revokedAt: null, expiresAt: { gt: now } } },
          },
        ],
      },
    }),
    prisma.oAuthClient.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        updatedAt: { lt: cutoff },
        authorizationRequests: { none: {} },
        authorizationCodes: { none: {} },
        accessTokens: { none: {} },
        refreshTokens: { none: {} },
      },
    }),
  ]);
}

export { consentBaseUrl };
