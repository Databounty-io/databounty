// SPDX-License-Identifier: Apache-2.0

import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isLegacyRequest } from "@modelcontextprotocol/server";
import { toWebRequest } from "@modelcontextprotocol/node";
import { config } from "../config.js";
import { positiveIntEnv } from "../lib/env-int.js";
import { checkTokenEndpoint } from "../lib/mcp-rate-limit.js";
import { SESSION_COOKIE, ADMIN_SESSION_COOKIE } from "../lib/session-cookie.js";
import { verifyApiKey } from "../services/api-keys.js";
import { createMcpServer } from "../mcp/transport.js";
import { modernMcpNodeHandler, setModernScopeChallenge } from "../mcp/modern.js";
import { MCP_SERVER_METADATA } from "../mcp/server.js";
import { runWithMcpPrincipal } from "../lib/mcp-context.js";
import {
  MCP_SCOPES,
  McpOAuthError,
  approveAuthorizationRequest,
  authorizationServerUrl,
  consentBaseUrl,
  createAuthorizationRequest,
  denyAuthorizationRequest,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  getAuthorizationRequest,
  getClient,
  listMcpGrants,
  mcpResourceUrl,
  parseScopes,
  protectedResourceMetadataUrl,
  registerClient,
  revokeAllMcpGrants,
  revokeMcpGrant,
  revokeMcpToken,
  userFromDashboardSession,
  redirectMatches,
  verifyMcpAccessToken,
} from "../services/mcp-oauth.js";
import { isClientIdMetadataUrl, isLoopbackRedirectUri } from "../services/mcp-client-metadata.js";

/**
 * Hosted MCP: OAuth 2.1 authorization server + the streamable-HTTP transport,
 * both mounted at the service root so `/mcp` is the single public MCP URL.
 *
 * Ported from `databounty-api/src/routes/mcp.ts`. One deliberate difference
 * from v1, stated plainly rather than papered over, and one point of parity:
 *
 *  1. NO `/mcp/sse`. v1 removed that compatibility endpoint on purpose and so
 *     does this port.
 *  2. TWO protocol eras, as in v1. `handleMcpByEra` classifies each request
 *     with the SDK's own `isLegacyRequest` and serves either the sessionful
 *     (`Mcp-Session-Id`) streamable-HTTP server from `@modelcontextprotocol/sdk`
 *     — what Claude Code, Codex, Cursor and Gemini CLI speak today — or the
 *     stateless 2026-07-28 server from `@modelcontextprotocol/server` +
 *     `@modelcontextprotocol/node` (`../mcp/modern.ts`). Both eras share one
 *     tool catalog, one tool handler, one authorization boundary and one
 *     audit trail; only the wire protocol differs.
 */

const MCP_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * How often idle sessions are swept when NO traffic is arriving. Expiry used to
 * be checked only inside `handleMcp`, which meant a client that stopped sending
 * requests — or one stuck in a failing auth/refresh loop — left its transport
 * resident until the next unrelated request happened to come in. Set to 0 to
 * go back to request-driven-only sweeping.
 */
const MCP_SESSION_SWEEP_INTERVAL_MS = positiveIntEnv("MCP_SESSION_SWEEP_INTERVAL_MS", 60_000, true);

/**
 * Upper bound on concurrent sessions per credential, and across the process.
 *
 * A session is only ever created by a POST that carries no id this process
 * recognises, so a client that loses its session id (restart, a sweep it did
 * not see, a broken refresh loop that re-handshakes every attempt) mints a new
 * one on every single request. Without a cap that is unbounded: each session
 * pins a `StreamableHTTPServerTransport`, an `McpServer` with the whole tool
 * catalog registered, the open response socket underneath it, AND a keep-alive
 * `setInterval` per live SSE stream (see `webStandardStreamableHttp.js`) that
 * goes on firing at a socket nobody is reading. Observed in production
 * 2026-09-22 as hundreds of held connections that only a container restart
 * cleared.
 *
 * Eviction is least-recently-used, NOT oldest-created: `expiresAt` is pushed
 * forward on every request, so ordering by it ascending puts the genuinely
 * idle sessions first and leaves a long-lived busy one alone. Evicting by
 * creation time would have killed the most active session in the set, and
 * could have aborted a request still streaming on it.
 */
const MCP_MAX_SESSIONS_PER_CREDENTIAL = positiveIntEnv("MCP_MAX_SESSIONS_PER_CREDENTIAL", 8);
const MCP_MAX_SESSIONS_TOTAL = positiveIntEnv("MCP_MAX_SESSIONS_TOTAL", 500);

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  credentialBinding: string;
  /** Last activity + TTL. Refreshed on every request, so it doubles as the LRU key. */
  expiresAt: number;
};

const sessions = new Map<string, McpSession>();

/**
 * The raw bearer secret is never retained in the session map. Binding a session
 * to its credential stops a leaked session id being reused by a different API
 * key or OAuth client, while still allowing OAuth token refresh for the same
 * approved client (the binding is over the principal, not the token).
 */
function credentialBinding(input: {
  apiKey: { id: string } | null;
  oauth: { userId: string; clientId: string } | null;
}): string {
  const principal = input.apiKey ? `api-key:${input.apiKey.id}` : `oauth:${input.oauth!.userId}:${input.oauth!.clientId}`;
  return createHmac("sha256", config.sessionSecret).update(principal).digest("hex");
}

/**
 * Drop a session AND release what it holds.
 *
 * Deleting the map entry on its own was the leak: the entry became
 * unreachable, but the transport kept its hijacked response socket open, so
 * the socket, the transport and the `McpServer` behind it stayed alive for the
 * life of the process. `transport.close()` is what actually ends the stream;
 * the map delete here makes the removal synchronous rather than waiting on the
 * `onclose` callback, and `onclose` deleting an already-absent key is a no-op.
 *
 * Never allowed to throw: a transport whose socket is already gone must not
 * abort a sweep that still has other sessions to reap.
 */
function closeSession(id: string, entry: McpSession): void {
  sessions.delete(id);
  void Promise.resolve()
    .then(() => entry.transport.close())
    .catch(() => {});
  void Promise.resolve()
    .then(() => entry.server.close())
    .catch(() => {});
}

function pruneExpiredSessions(now = Date.now()) {
  for (const [id, entry] of sessions) {
    if (entry.expiresAt <= now) closeSession(id, entry);
  }
}

/**
 * Evict oldest-first until this credential is under its cap and the process is
 * under the global one. Runs immediately before a new session is admitted, so
 * the caps are on sessions that already exist and the incoming handshake
 * always gets its slot.
 */
function enforceSessionCaps(binding: string): void {
  // Ascending `expiresAt` == least recently used first (see the cap constants).
  const idlestFirst = (entries: [string, McpSession][]) =>
    entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);

  const mine = idlestFirst([...sessions].filter(([, e]) => e.credentialBinding === binding));
  while (mine.length >= MCP_MAX_SESSIONS_PER_CREDENTIAL) {
    const victim = mine.shift();
    if (!victim) break;
    closeSession(victim[0], victim[1]);
  }

  const all = idlestFirst([...sessions]);
  while (sessions.size >= MCP_MAX_SESSIONS_TOTAL) {
    const victim = all.shift();
    if (!victim) break;
    if (sessions.has(victim[0])) closeSession(victim[0], victim[1]);
  }
}

function bearer(req: FastifyRequest): string | null {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7).trim() || null : null;
}

function requestContext(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers["user-agent"] };
}

function bearerChallenge(
  input: { error?: "invalid_token" | "insufficient_scope"; scope?: string; description?: string } = {},
): string {
  const parts = [
    `resource_metadata="${protectedResourceMetadataUrl()}"`,
    // A first-time interactive MCP connection should let the operator make one
    // informed choice over the full capability set. The consent page still
    // permits deselection, and scoped API keys are unaffected.
    `scope="${input.scope ?? MCP_SCOPES.join(" ")}"`,
  ];
  if (input.error) parts.push(`error="${input.error}"`);
  if (input.description) parts.push(`error_description="${input.description.replace(/"/g, "'")}"`);
  return `Bearer ${parts.join(", ")}`;
}

function oauthError(reply: FastifyReply, err: unknown) {
  reply.header("Cache-Control", "no-store");
  if (err instanceof McpOAuthError) {
    // `reason` is only ever read by the consent screen (those routes are
    // session-gated); the OAuth client sees `error`/`error_description` only.
    return reply
      .code(err.status)
      .send({ error: err.code, error_description: err.message, ...(err.reason ? { reason: err.reason } : {}) });
  }
  throw err;
}

function redirectError(uri: string, state: string | undefined, error: string, description: string): string {
  const url = new URL(uri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  // RFC 9207: every authorization response — success or error — names its
  // issuer so a client talking to several servers cannot be mix-up attacked.
  // The consent page adds the same `iss` on approve/deny from `issuer`.
  url.searchParams.set("iss", authorizationServerUrl());
  return url.toString();
}

async function isRegisteredRedirectSafe(uri: string, clientId?: string): Promise<boolean> {
  if (!clientId) return false;
  try {
    const client = await getClient(clientId);
    // `redirectMatches`, not string equality — the same comparison the happy
    // path uses. Exact matching here meant a loopback client calling back on
    // an ephemeral port (Claude Code, Zed, mcp-remote, VS Code) was refused a
    // post-validation error redirect and got an opaque JSON 400 instead, so it
    // never learned why authorization failed. RFC 6749 §4.1.2.1 wants the
    // error delivered to a redirect_uri that IS registered, and RFC 8252 §7.3
    // makes a loopback URI registered at any port.
    return client.redirectUris.some((registered) => redirectMatches(uri, registered));
  } catch {
    return false;
  }
}

function parseForm(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function requireDashboardUser(req: FastifyRequest, reply: FastifyReply) {
  const user = await userFromDashboardSession(req);
  if (!user) {
    await reply.code(401).send({ error: "login_required", message: "Sign in to DataBounty Community first." });
    return null;
  }
  return user;
}

/**
 * CSRF guard for the two consent-decision endpoints. `sessionTokenFrom`
 * (lib/session-cookie.ts) accepts either a Bearer header or the session
 * cookie, and there is no CSRF token anywhere in this codebase — protection
 * rests entirely on `sameSite`. Under the `lax` default a cross-site POST
 * never carries the cookie, so this was safe; but `COOKIE_SAMESITE=none`,
 * which a split-origin deployment needs, made it a real forged-request
 * surface. The specific payoff for an attacker here is worse than a generic
 * CSRF: `/approve` falls back to the CLIENT'S FULL REQUESTED SCOPE SET
 * whenever `body.scopes` is absent (`approve`, below) — and Fastify's
 * default `text/plain` body parser accepts a cross-site POST with no
 * preflight, so a forged request with no body at all still approves
 * everything the client asked for. A Bearer credential is never sent
 * involuntarily by a browser, so only cookie-authenticated requests need
 * the check.
 */
function hasCookieOrigin(req: FastifyRequest): boolean {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return true;
  const hasCookie = Boolean(req.cookies?.[SESSION_COOKIE] || req.cookies?.[ADMIN_SESSION_COOKIE]);
  if (!hasCookie) return true;
  const origin = req.headers.origin;
  return Boolean(origin && config.corsOrigins.includes(origin));
}

/**
 * Sessionful streamable-HTTP MCP. Accepts BOTH credential kinds:
 *  - an OAuth access token, best for interactive clients that can run a
 *    browser consent flow, and
 *  - a scoped developer API key, for automation.
 * An API key is never turned into an OAuth token or vice versa: revocation,
 * expiry, rate limits and audit history must stay tied to the original
 * credential.
 */
async function handleMcp(req: FastifyRequest, reply: FastifyReply) {
  const token = bearer(req);
  const apiKey = token ? await verifyApiKey(token) : null;
  const oauth = apiKey ? null : token ? await verifyMcpAccessToken(token) : null;
  if (!apiKey && !oauth) {
    reply.header(
      "WWW-Authenticate",
      bearerChallenge({ error: "invalid_token", description: "A valid MCP OAuth access token or scoped API key is required." }),
    );
    return reply
      .code(401)
      .send({ error: "invalid_token", message: "A valid MCP OAuth access token or scoped API key is required." });
  }

  const sessionIdHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
  const now = Date.now();
  pruneExpiredSessions(now);
  const binding = credentialBinding({ apiKey, oauth });
  let entry = sessionId ? sessions.get(sessionId) : undefined;
  if (entry && entry.credentialBinding !== binding) {
    return reply.code(401).send({ error: "invalid_token", message: "MCP session belongs to a different credential." });
  }
  // A session id this process does not recognise — swept for idleness, evicted
  // by the caps, terminated, or left over from a previous container.
  //
  // MCP 2025-06-18, Streamable HTTP §Session Management: "The server MAY
  // terminate the session at any time, after which it MUST respond to requests
  // containing that session ID with HTTP 404 Not Found", and on 404 the client
  // "MUST start a new session by sending a new InitializeRequest without a
  // session ID attached". 404 is therefore the signal that makes a client
  // recover; the 400 this used to return is not, and a compliant client had no
  // instruction to re-initialize — it just retried the dead id.
  //
  // Worse, the old order let a POST fall through to session creation while the
  // client was still presenting the stale id. The SDK rejects a non-initialize
  // request on a transport that has not been initialized, so the client got an
  // error AND the freshly built transport stayed behind as an orphan — a new
  // one on every retry. That is the amplifier that turned one stuck client
  // into hundreds of held connections. Answering 404 before the creation
  // branch removes the path entirely.
  if (sessionId && !entry) {
    return reply
      .code(404)
      .send({ error: "session_not_found", message: "MCP session is unknown or expired. Start a new session." });
  }
  if (req.method === "POST" && !entry) {
    // Before admitting another one. A client that mints a session per request
    // would otherwise grow this map without limit — see the cap constants.
    enforceSessionCaps(binding);
    let session: McpSession;
    let server: McpServer;
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Fires from inside `handleRequest` at the foot of this function, long
      // after `session` is assigned. Registering THAT object rather than a
      // fresh copy matters: the request path refreshes `entry.expiresAt`, and
      // with two separate objects the map's copy never saw it — so the LRU key
      // the caps and the sweep both read would have gone stale the moment a
      // session was created.
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    server = createMcpServer({ scopeChallenge: (input) => bearerChallenge({ error: "insufficient_scope", ...input }) });
    session = { transport, server, credentialBinding: binding, expiresAt: now + MCP_SESSION_TTL_MS };
    entry = session;
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    try {
      await server.connect(transport);
    } catch (err) {
      // `onsessioninitialized` has not fired, so nothing is in the map and the
      // sweep will never see this transport — release it here or it is the leak
      // this change exists to close, just on the failure path.
      closeSession("", session);
      throw err;
    }
  }
  // Reached only with NO session id on a non-POST. Spec §Session Management:
  // "Servers that require a session ID SHOULD respond to requests without an
  // Mcp-Session-Id header (other than initialization) with HTTP 400 Bad
  // Request" — so 400, not 404, is correct for this one case.
  if (!entry) return reply.code(400).send({ error: "invalid_session", message: "MCP session id is required." });
  entry.expiresAt = now + MCP_SESSION_TTL_MS;

  const principal = apiKey
    ? { userId: apiKey.userId, keyId: apiKey.id, scopes: apiKey.scopes as string[] }
    : { userId: oauth!.userId, clientId: oauth!.clientId, scopes: oauth!.scopes as string[] };

  reply.hijack();
  // AsyncLocalStorage, not a field on the transport: one process serves many
  // concurrent MCP clients, and a shared mutable "current principal" would leak
  // one connection's identity into another's tool call.
  await runWithMcpPrincipal({ ...principal, ip: req.ip, userAgent: req.headers["user-agent"] }, () =>
    entry!.transport.handleRequest(req.raw, reply.raw, req.body),
  );
}

// Scope refusals over the modern era carry the same challenge the sessionful
// era emits (see `createMcpServer(...)` in `handleMcp`).
setModernScopeChallenge((input) => bearerChallenge({ error: "insufficient_scope", ...input }));

/**
 * Modern (2026-07-28) stateless MCP. Same two credential kinds, same
 * verification order and same 401 challenge as `handleMcp`; the only
 * difference is that there is no session to create or bind — every request
 * carries its own `_meta` envelope and is served by a fresh server instance.
 */
async function handleModernMcp(req: FastifyRequest, reply: FastifyReply) {
  const token = bearer(req);
  const apiKey = token ? await verifyApiKey(token) : null;
  const oauth = apiKey ? null : token ? await verifyMcpAccessToken(token) : null;
  if (!apiKey && !oauth) {
    reply.header(
      "WWW-Authenticate",
      bearerChallenge({ error: "invalid_token", description: "A valid MCP OAuth access token or scoped API key is required." }),
    );
    return reply
      .code(401)
      .send({ error: "invalid_token", message: "A valid MCP OAuth access token or scoped API key is required." });
  }

  const principal = apiKey
    ? { userId: apiKey.userId, keyId: apiKey.id, scopes: apiKey.scopes as string[] }
    : { userId: oauth!.userId, clientId: oauth!.clientId, scopes: oauth!.scopes as string[] };

  reply.hijack();
  await runWithMcpPrincipal({ ...principal, ip: req.ip, userAgent: req.headers["user-agent"] }, () =>
    modernMcpNodeHandler(req.raw, reply.raw, req.body),
  );
}

/**
 * Protocol-era classifier.
 *
 * A plain, unauthenticated GET with no session id used to be answered with a
 * 200 server-identity document — a health-check convenience left over from
 * when `GET /mcp/` served that role on its own. That contradicted this
 * server's own documented contract (`docs/mcp.md`: "An unauthenticated
 * request to /mcp answers 401 with a WWW-Authenticate: Bearer header"), and
 * it is a real interop problem, not just a doc mismatch: several MCP
 * clients (Zed, Cline, mcp-remote) start their OAuth flow from a 401 on
 * ANY unauthenticated request — including a bare GET probe — not only a
 * POST. Answering 200 here meant those clients never learned they needed to
 * authenticate. Dedicated health checks belong at `/health` / `/healthz`
 * (`routes/health.ts`), which this endpoint never needs to double as.
 *
 * Everything is classified by the SDK's own `isLegacyRequest` — the exact
 * predicate `createMcpHandler` uses internally, so this branch can never
 * disagree with the modern handler's view of a request. Legacy (2025-era:
 * `initialize` handshake, no `_meta` envelope, GET/DELETE session operations)
 * goes to the sessionful transport; modern goes to `handleModernMcp`.
 */
async function handleMcpByEra(req: FastifyRequest, reply: FastifyReply) {
  // DNS-rebinding / cross-origin defense-in-depth, checked when Origin is
  // PRESENT only — never required. `/mcp` accepts nothing but a Bearer
  // credential (no cookie fallback, unlike the dashboard-facing routes), so a
  // malicious page cannot submit a credential it never had regardless of
  // this check; most real MCP clients (Claude Code, Codex, mcp-remote) are
  // not browser-embedded and never send an Origin at all. This closes the
  // remaining case: a BROWSER-embedded client (a future web-based MCP
  // frontend, or a rebound-DNS attack against one) whose Origin the browser
  // attaches automatically. The SDK's own `enableDnsRebindingProtection` /
  // `allowedOrigins` options are deprecated in favor of exactly this kind of
  // external check.
  // Checked against corsOrigins PLUS `mcpAllowedOrigins`. The second list
  // exists because a hosted MCP connector (ChatGPT, claude.ai) attaches its own
  // Origin automatically, and gating `/mcp` on the credentialed-CORS allowlist
  // meant the only way to admit one was to grant it cookie-bearing access to
  // the entire API. `/mcp` reads no cookie, so admitting an origin here grants
  // nothing beyond reaching a route that still demands a Bearer token.
  const origin = req.headers.origin;
  if (origin && !config.corsOrigins.includes(origin) && !config.mcpAllowedOrigins.includes(origin)) {
    return reply.code(403).send({ error: "invalid_request", message: "This request's origin is not allowed." });
  }
  if (req.method === "GET" && !req.headers.authorization && !req.headers["mcp-session-id"]) {
    reply.header(
      "WWW-Authenticate",
      bearerChallenge({ error: "invalid_token", description: "A valid MCP OAuth access token or scoped API key is required." }),
    );
    return reply
      .code(401)
      .send({ error: "invalid_token", message: "A valid MCP OAuth access token or scoped API key is required." });
  }
  // Every real MCP client posts `application/json` (the spec requires it).
  // Fastify ships a built-in `text/plain` body parser alongside its JSON one,
  // so without this a POST declaring `Content-Type: text/plain` reaches the
  // classifier with `req.body` as a raw string rather than a parsed JSON-RPC
  // envelope — exactly the shape that made the OAuth consent endpoints a CSRF
  // vector (a `text/plain` POST is a CORS-simple request needing no
  // preflight). `/mcp` requires a Bearer credential regardless, so this is
  // hygiene and spec-conformance rather than a live escalation, but a
  // malformed body should fail with a clear 415, not an opaque JSON-RPC
  // parse error two layers down.
  if (req.method === "POST") {
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== "application/json") {
      return reply.code(415).send({ error: "invalid_request", message: "Content-Type must be application/json." });
    }
  }
  // Fastify has already parsed the JSON body. Passing it avoids consuming the
  // raw stream while the classifier inspects a modern per-request `_meta`
  // envelope, and leaves `req.raw` untouched for whichever era serves it.
  const webRequest = await toWebRequest(req.raw, req.body);
  if (await isLegacyRequest(webRequest, req.body)) return handleMcp(req, reply);
  return handleModernMcp(req, reply);
}

export async function mcpRoutes(app: FastifyInstance) {
  // Sweep on a timer, not only on the next inbound request. `unref()` so an
  // idle process can still exit; `onClose` both stops the timer and releases
  // every live session, so a SIGTERM shutdown does not leave sockets hanging.
  if (MCP_SESSION_SWEEP_INTERVAL_MS > 0) {
    const sweep = setInterval(() => pruneExpiredSessions(), MCP_SESSION_SWEEP_INTERVAL_MS);
    sweep.unref();
    app.addHook("onClose", async () => {
      clearInterval(sweep);
      for (const [id, entry] of sessions) closeSession(id, entry);
    });
  }

  const authorizationServerMetadata = async () => ({
    issuer: authorizationServerUrl(),
    authorization_endpoint: `${authorizationServerUrl()}/oauth/authorize`,
    token_endpoint: `${authorizationServerUrl()}/oauth/token`,
    registration_endpoint: `${authorizationServerUrl()}/oauth/register`,
    revocation_endpoint: `${authorizationServerUrl()}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    response_modes_supported: ["query"],
    scopes_supported: MCP_SCOPES,
    // OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-
    // document): a client may present an https URL as its client_id and this
    // server fetches its registration from there. CIMD-capable agent CLIs
    // switch from dynamic registration to their CIMD URL when they see this.
    client_id_metadata_document_supported: true,
    // RFC 9207: both the consent page (approve/deny) and the API's own error
    // redirects carry `iss`.
    authorization_response_iss_parameter_supported: true,
  });
  const protectedResourceMetadata = async () => ({
    resource: mcpResourceUrl(),
    authorization_servers: [authorizationServerUrl()],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
  });

  // Canonical RFC 8414 / RFC 9728 path-insertion discovery endpoints. The
  // `/mcp/.well-known/*` aliases keep previously configured clients working
  // while every new client receives the canonical URL in WWW-Authenticate.
  app.get("/.well-known/oauth-authorization-server/mcp", authorizationServerMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
  app.get("/mcp/.well-known/oauth-authorization-server", authorizationServerMetadata);
  app.get("/mcp/.well-known/oauth-protected-resource", protectedResourceMetadata);
  // Root (un-suffixed) documents: the MCP authorization spec tells clients to
  // try RFC 8414 path insertion first and fall back to the root well-known
  // URL, and several clients only ever try the root. Same documents.
  app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);

  // ── OAuth 2.1, public PKCE clients only ─────────────────────────────────
  app.post("/mcp/oauth/register", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((v): v is string => typeof v === "string")
        : [];
      return reply.code(201).send(
        await registerClient({
          redirectUris,
          clientName: typeof body.client_name === "string" ? body.client_name : undefined,
          grantTypes: Array.isArray(body.grant_types) ? body.grant_types.filter((v): v is string => typeof v === "string") : undefined,
          tokenEndpointAuthMethod:
            typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : undefined,
        }),
      );
    } catch (err) {
      return oauthError(reply, err);
    }
  });

  app.get("/mcp/oauth/authorize", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const q = req.query as Record<string, string | undefined>;
    let created: Awaited<ReturnType<typeof createAuthorizationRequest>>;
    try {
      // RFC 6749 §4.1.2.1 separates these two: a response type this server
      // cannot serve is `unsupported_response_type`, while a missing or
      // malformed parameter is `invalid_request`. Folding both into
      // `invalid_request` told a client its request was malformed when in fact
      // its flow type was simply not offered.
      if (q.response_type !== undefined && q.response_type !== "code") {
        throw new McpOAuthError("unsupported_response_type", "Only response_type=code is supported.");
      }
      if (!q.response_type || !q.client_id || !q.redirect_uri || !q.code_challenge || q.code_challenge_method !== "S256") {
        throw new McpOAuthError(
          "invalid_request",
          "response_type=code, client_id, redirect_uri, an S256 PKCE code_challenge, and code_challenge_method=S256 are required.",
        );
      }
      // Least privilege: a client that omits `scope` is offered read-only
      // access on the consent screen, not the full scope set.
      created = await createAuthorizationRequest({
        clientId: q.client_id,
        redirectUri: q.redirect_uri,
        scope: parseScopes(q.scope, ["read"]),
        state: q.state,
        codeChallenge: q.code_challenge,
        resource: q.resource,
      });
    } catch (err) {
      if (err instanceof McpOAuthError && q.redirect_uri && (await isRegisteredRedirectSafe(q.redirect_uri, q.client_id))) {
        return reply.redirect(redirectError(q.redirect_uri, q.state, err.code, err.message));
      }
      return oauthError(reply, err);
    }
    return reply.redirect(`${consentBaseUrl()}?request_id=${encodeURIComponent(created.request.id)}`);
  });

  app.get("/mcp/oauth/request/:id", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await requireDashboardUser(req, reply);
    if (!user) return;
    try {
      const request = await getAuthorizationRequest((req.params as { id: string }).id);
      const client = await getClient(request.clientId);
      // `serverTime` lets the consent screen count down against the clock that
      // actually enforces `expiresAt`. Deliberately in the body rather than
      // read from the `Date` response header, which is not CORS-safelisted.
      // `clientRedirectHosts` lets the consent screen show "this app will
      // redirect you to: <host>" next to the claimed client name — a second,
      // harder-to-fake trust signal, since a client's self-reported name
      // alone can't be trusted (see reserved-term check in registerClient).
      const clientRedirectHosts = [
        ...new Set(
          client.redirectUris
            .map((uri) => {
              try {
                return new URL(uri).host;
              } catch {
                return null;
              }
            })
            .filter((host): host is string => Boolean(host)),
        ),
      ];
      // `clientIdHost` is the host a URL client_id (Client ID Metadata
      // Document) was fetched from — a verifiable origin the consent screen can
      // show next to the self-reported name. `localhostOnlyRedirect` flags a
      // client whose every redirect is loopback: the CIMD draft says the AS
      // SHOULD warn the user that such a client's identity cannot be verified
      // by its redirect destination.
      const clientIdHost = isClientIdMetadataUrl(client.clientId) ? new URL(client.clientId).host : null;
      const localhostOnlyRedirect = client.redirectUris.length > 0 && client.redirectUris.every((uri) => isLoopbackRedirectUri(uri));
      return {
        requestId: request.id,
        clientName: client.clientName ?? client.clientId,
        clientIdHost,
        localhostOnlyRedirect,
        clientRedirectHosts,
        redirectUri: request.redirectUri,
        scopes: request.scope,
        expiresAt: request.expiresAt,
        serverTime: new Date().toISOString(),
      };
    } catch (err) {
      return oauthError(reply, err);
    }
  });

  app.post("/mcp/oauth/request/:id/approve", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!hasCookieOrigin(req)) {
      return reply.code(403).send({ error: "origin_not_allowed", message: "This request's origin is not allowed to use cookie authentication on this endpoint." });
    }
    const user = await requireDashboardUser(req, reply);
    if (!user) return;
    try {
      // A non-object body (a bare string, from a forged text/plain POST) must
      // not silently fall through to "approve everything requested" —
      // require the real thing a same-origin fetch actually sends.
      if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
        throw new McpOAuthError("invalid_request", "Request body must be a JSON object.");
      }
      const body = req.body as Record<string, unknown>;
      const scopes =
        body.scopes === undefined
          ? undefined
          : Array.isArray(body.scopes) && body.scopes.every((scope): scope is string => typeof scope === "string")
            ? parseScopes(body.scopes)
            : (() => {
                throw new McpOAuthError("invalid_scope", "Selected permissions must be a list of supported MCP scopes.");
              })();
      const request = await getAuthorizationRequest((req.params as { id: string }).id);
      return await approveAuthorizationRequest(request.id, user.id, scopes ?? parseScopes(request.scope), requestContext(req));
    } catch (err) {
      return oauthError(reply, err);
    }
  });

  app.post("/mcp/oauth/request/:id/deny", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!hasCookieOrigin(req)) {
      return reply.code(403).send({ error: "origin_not_allowed", message: "This request's origin is not allowed to use cookie authentication on this endpoint." });
    }
    const user = await requireDashboardUser(req, reply);
    if (!user) return;
    try {
      return await denyAuthorizationRequest((req.params as { id: string }).id, user.id, requestContext(req));
    } catch (err) {
      return oauthError(reply, err);
    }
  });

  app.post("/mcp/oauth/token", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const body = parseForm(req.body);
      const clientId = body.client_id;
      if (!clientId || body.client_secret) {
        throw new McpOAuthError("invalid_client", "Only public PKCE clients are supported.", 401);
      }
      // Before any grant work, and before any database read that a caller
      // could drive in a loop. See `checkTokenEndpoint` for why the per-IP
      // limiter does not cover this endpoint and why one of the two buckets is
      // keyed on the presented secret.
      const throttled = await checkTokenEndpoint({
        clientId,
        presentedSecret: body.refresh_token ?? body.code,
      });
      if (throttled) {
        reply.header("Retry-After", String(throttled.retryAfterSec));
        // `slow_down` is a registered OAuth error code (RFC 8628 §3.5) and is
        // the one a client can act on: back off and retry. A bare 429 with no
        // OAuth error body reads to most clients as an unclassified failure.
        return reply.code(429).send({
          error: "slow_down",
          error_description: `Too many token requests: ${throttled.limit}/minute. Retry in ${throttled.retryAfterSec}s.`,
        });
      }
      if (body.grant_type === "authorization_code") {
        if (!body.code || !body.code_verifier || !body.redirect_uri) {
          throw new McpOAuthError("invalid_request", "code, code_verifier, and redirect_uri are required.");
        }
        return await exchangeAuthorizationCode(
          { clientId, code: body.code, codeVerifier: body.code_verifier, redirectUri: body.redirect_uri, resource: body.resource },
          requestContext(req),
        );
      }
      if (body.grant_type === "refresh_token") {
        // RFC 6749 §6 makes `refresh_token` REQUIRED, and §5.2 makes a missing
        // required parameter `invalid_request`. Gating the branch on the
        // parameter's presence instead reported `unsupported_grant_type` for a
        // grant this server advertises in its own RFC 8414 metadata.
        if (!body.refresh_token) {
          throw new McpOAuthError("invalid_request", "refresh_token is required for the refresh_token grant.");
        }
        return await exchangeRefreshToken(
          { clientId, refreshToken: body.refresh_token, scope: body.scope ? parseScopes(body.scope) : undefined, resource: body.resource },
          requestContext(req),
        );
      }
      // §4.1.3 makes `grant_type` REQUIRED, so its absence is a malformed
      // request rather than an unsupported grant.
      if (!body.grant_type) {
        throw new McpOAuthError("invalid_request", "grant_type is required.");
      }
      throw new McpOAuthError("unsupported_grant_type", "Supported grant types are authorization_code and refresh_token.");
    } catch (err) {
      return oauthError(reply, err);
    }
  });

  // RFC 7009. Deliberately returns 200 whether or not the token existed —
  // the spec requires it, and any other answer is a token-validity oracle.
  app.post("/mcp/oauth/revoke", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = parseForm(req.body);
    // RFC 7009 §2.1: the revoke is scoped to the client presenting it, so one
    // client cannot revoke another's token. The answer is 200 either way.
    if (body.token) await revokeMcpToken(body.token, body.client_id);
    return reply.code(200).send({});
  });

  app.get("/mcp/oauth/grants", async (req, reply) => {
    const user = await requireDashboardUser(req, reply);
    if (!user) return;
    reply.header("Cache-Control", "no-store");
    return { grants: await listMcpGrants(user.id) };
  });

  app.post("/mcp/oauth/grants/:clientId/revoke", async (req, reply) => {
    const user = await requireDashboardUser(req, reply);
    if (!user) return;
    reply.header("Cache-Control", "no-store");
    return revokeMcpGrant(user.id, (req.params as { clientId: string }).clientId);
  });

  // Disconnect every MCP client in one call. Session-gated like the per-client
  // revoke; hard-revokes all live access/refresh tokens rather than gating them.
  app.post("/mcp/oauth/grants/revoke-all", async (req, reply) => {
    const user = await requireDashboardUser(req, reply);
    if (!user) return;
    reply.header("Cache-Control", "no-store");
    return revokeAllMcpGrants(user.id);
  });

  // `/mcp` is the sole hosted MCP endpoint. There is deliberately no `/mcp/sse`.
  app.all("/mcp", handleMcpByEra);
}
