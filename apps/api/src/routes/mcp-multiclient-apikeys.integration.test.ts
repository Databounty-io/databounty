// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-client MCP isolation, concurrent sessions, and developer API keys
 * alongside OAuth — driven through the real Fastify app, the real MCP
 * streamable-HTTP transport and a real local Postgres.
 *
 * Three credentials are live at once for ONE account:
 *   1. a CIMD client        — an https URL `client_id` whose metadata document
 *                             fetch and DNS lookup are stubbed through the
 *                             service's own seams (`setClientMetadataFetch` /
 *                             `setClientMetadataDnsLookup`), exactly as
 *                             `mcp-cimd.integration.test.ts` does. No network.
 *   2. a dynamic client     — `POST /mcp/oauth/register` (RFC 7591)
 *   3. an API key           — `POST /v1/me/api-keys`
 *
 * Everything else is real: Fastify, Prisma, Postgres, session cookies, the
 * AsyncLocalStorage principal, the `oauth_audit_events` trail and the
 * per-credential rate-limit buckets.
 *
 * WHY EVERY ACCOUNT IS CREATED IN `beforeAll`. `/v1/auth/*` carries a hard
 * 10-requests-per-minute-per-IP limiter that an admin setting cannot widen
 * (routes/v1/auth.ts AUTH_RATE_LIMIT). Signing up per test would 429 the suite
 * against itself, so the two accounts and the second browser session are
 * minted once and shared.
 *
 * Self-guards like every other integration test: refuses to run unless
 * DATABASE_URL names a disposable local database.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import {
  clearClientMetadataCache,
  setClientMetadataDnsLookup,
  setClientMetadataFetch,
} from "../services/mcp-client-metadata.js";

requireDisposableDatabase();

let app: FastifyInstance;

const MCP_ACCEPT = "application/json, text/event-stream";

/** CIMD client (era 1). */
const CIMD_URL = "https://multiclient-cimd.example/oauth/client-metadata";
const CIMD_NAME = "Multiclient CIMD Agent";
const CIMD_REDIRECT = "http://127.0.0.1:44101/callback";
const PUBLIC_ADDR = [{ address: "93.184.216.34", family: 4 }];

/** Dynamic client (era 2). */
const DYN_REDIRECT = "http://127.0.0.1:44102/callback";


type Account = { email: string; userId: string; cookie: string };

let userA: Account;
let userB: Account;
/** A SECOND browser session for userA — two consent flows at once. */
let cookieA2: string;

let cimdClientId: string;
let dynClientId: string;
const registeredClientIds: string[] = [];


// ── helpers ────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Streamable HTTP may answer with SSE; read either representation. */
function jsonRpcBody(payload: string): any {
  const trimmed = payload.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = payload
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`No JSON-RPC payload in response: ${payload.slice(0, 200)}`);
  return JSON.parse(dataLine.slice("data:".length).trim());
}

async function signupVerified(prefix: string): Promise<Account> {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const email = `${prefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email,
      password: "Test@12345",
      handle: `${prefix}${stamp}`.toLowerCase().slice(0, 20),
      displayName: prefix,
    },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date(), onboarded: true } });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

/** A second, independent dashboard session for an existing account. */
async function loginAgain(account: Account): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: account.email, password: "Test@12345" },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers["set-cookie"];
  return (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
}

async function registerDynamicClient(name: string, redirectUri = DYN_REDIRECT): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/mcp/oauth/register",
    payload: { redirect_uris: [redirectUri], client_name: name, token_endpoint_auth_method: "none" },
  });
  expect(res.statusCode).toBe(201);
  const clientId = res.json().client_id as string;
  registeredClientIds.push(clientId);
  return clientId;
}

interface AuthorizeResult {
  requestId: string;
  verifier: string;
}

async function startAuthorization(input: {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state?: string;
  resource?: string;
}): Promise<AuthorizeResult> {
  const { verifier, challenge } = pkce();
  const res = await app.inject({
    method: "GET",
    url: "/mcp/oauth/authorize",
    query: {
      response_type: "code",
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: input.scope.join(" "),
      ...(input.state ? { state: input.state } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
    },
  });
  expect(res.statusCode).toBe(302);
  const requestId = new URL(res.headers.location as string).searchParams.get("request_id");
  expect(requestId).toBeTruthy();
  return { requestId: requestId!, verifier };
}

async function approve(requestId: string, cookie: string, scopes: string[]) {
  const res = await app.inject({
    method: "POST",
    url: `/mcp/oauth/request/${requestId}/approve`,
    headers: { cookie, origin: "http://localhost:3000" },
    payload: { scopes },
  });
  return res;
}

async function exchangeCode(input: {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource?: string;
}) {
  return app.inject({
    method: "POST",
    url: "/mcp/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      ...(input.resource ? { resource: input.resource } : {}),
    }).toString(),
  });
}

async function refresh(clientId: string, refreshToken: string, scope?: string[]) {
  return app.inject({
    method: "POST",
    url: "/mcp/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      ...(scope ? { scope: scope.join(" ") } : {}),
    }).toString(),
  });
}

/** Full consent flow → live tokens for one (user, client) pair. */
async function connectClient(input: {
  clientId: string;
  redirectUri: string;
  request: string[];
  approve?: string[];
  cookie: string;
}): Promise<{ accessToken: string; refreshToken: string; scope: string }> {
  const { requestId, verifier } = await startAuthorization({
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    scope: input.request,
  });
  const approved = await approve(requestId, input.cookie, input.approve ?? input.request);
  expect(approved.statusCode).toBe(200);
  const token = await exchangeCode({
    clientId: input.clientId,
    code: approved.json().code as string,
    verifier,
    redirectUri: input.redirectUri,
  });
  expect(token.statusCode).toBe(200);
  const body = token.json();
  return { accessToken: body.access_token, refreshToken: body.refresh_token, scope: body.scope };
}

async function issueApiKey(cookie: string, scopes: string[]) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/me/api-keys",
    headers: { cookie, origin: "http://localhost:3010" },
    payload: { scopes },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { id: body.id as string, key: body.key as string, keyPrefix: body.keyPrefix as string, body };
}

interface McpClientSession {
  sessionId: string;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ statusCode: number; result: any; raw: Awaited<ReturnType<FastifyInstance["inject"]>> }>;
}

/** Open a real sessionful streamable-HTTP MCP session on a bearer credential. */
async function openMcpSession(token: string): Promise<McpClientSession> {
  const auth = { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, "content-type": "application/json" };
  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: auth,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest-multiclient", version: "0" } },
    },
  });
  expect(init.statusCode).toBe(200);
  const sessionId = init.headers["mcp-session-id"] as string;
  expect(sessionId).toBeTruthy();
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...auth, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  let id = 1;
  return {
    sessionId,
    call: async (name, args = {}) => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { ...auth, "mcp-session-id": sessionId },
        payload: { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } },
      });
      return {
        statusCode: res.statusCode,
        result: res.statusCode === 200 ? jsonRpcBody(res.payload).result : undefined,
        raw: res,
      };
    },
  };
}

function toolText(result: any): string {
  return String(result?.content?.[0]?.text ?? "");
}

/** Audit writes are fire-and-forget by design; poll instead of racing them. */
async function waitForAuditEvents(where: Record<string, unknown>, atLeast: number, attempts = 40) {
  let rows: Awaited<ReturnType<typeof prisma.oAuthAuditEvent.findMany>> = [];
  for (let i = 0; i < attempts; i++) {
    rows = await prisma.oAuthAuditEvent.findMany({ where });
    if (rows.length >= atLeast) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return rows;
}

/** Cheap authenticated request that traverses the per-credential rate-limit
 *  hook. `GET /mcp` with a bearer and no session id is answered 400 by the
 *  transport, so a 429 is unambiguously the limiter and nothing else. */
function pingWithBearer(token: string) {
  return app.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${token}` } });
}

// ── fixtures ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  // The global per-IP limiter is a BOOT-TIME read of `ratelimit.global.max`
  // (app.ts). This file issues several hundred requests from one IP, so raise
  // it before buildApp() and restore the prior state in afterAll. The
  // per-credential limiter under test is untouched by this.
  process.env.RATELIMIT_GLOBAL_MAX = "100000";

  app = await buildApp();
  await app.ready();

  clearClientMetadataCache();
  setClientMetadataDnsLookup(async () => PUBLIC_ADDR);
  setClientMetadataFetch(async (url) =>
    json({
      client_id: url,
      client_name: CIMD_NAME,
      redirect_uris: [CIMD_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  );

  // Three auth-route requests total — inside AUTH_RATE_LIMIT's 10/min budget.
  userA = await signupVerified("mcA");
  userB = await signupVerified("mcB");
  cookieA2 = await loginAgain(userA);

  cimdClientId = CIMD_URL;
  dynClientId = await registerDynamicClient("multiclient-dynamic");
});

afterAll(async () => {
  setClientMetadataFetch(null);
  setClientMetadataDnsLookup(null);
  clearClientMetadataCache();

  const userIds = [userA?.userId, userB?.userId].filter((id): id is string => Boolean(id));
  if (userIds.length) {
    await prisma.oAuthAuditEvent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.oAuthAuditEvent.deleteMany({ where: { clientId: { in: [CIMD_URL, ...registeredClientIds] } } });
  await prisma.oAuthClient.deleteMany({ where: { clientId: { in: [CIMD_URL, ...registeredClientIds] } } });

  delete process.env.RATELIMIT_GLOBAL_MAX;

  await app.close();
  await prisma.$disconnect();
});

// ══ 1. Three clients, one account, at the same time ════════════════════════

describe("three MCP clients connected for one account at once", () => {
  it("gives each credential its own scopes, its own identity and its own audit attribution — with no cross-attribution", async () => {
    // CIMD client: read only.
    const cimd = await connectClient({
      clientId: cimdClientId,
      redirectUri: CIMD_REDIRECT,
      request: ["read", "contribute"],
      approve: ["read"],
      cookie: userA.cookie,
    });
    expect(cimd.scope).toBe("read");

    // Dynamic client: read + contribute.
    const dyn = await connectClient({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      request: ["read", "contribute"],
      cookie: userA.cookie,
    });
    expect(dyn.scope).toBe("read contribute");

    // API-key client: read only.
    const apiKey = await issueApiKey(userA.cookie, ["read"]);

    const cimdSession = await openMcpSession(cimd.accessToken);
    const dynSession = await openMcpSession(dyn.accessToken);
    const keySession = await openMcpSession(apiKey.key);

    // Distinct sessions, so a leaked id cannot be shared.
    expect(new Set([cimdSession.sessionId, dynSession.sessionId, keySession.sessionId]).size).toBe(3);

    // Each resolves to the same account…
    for (const session of [cimdSession, dynSession, keySession]) {
      const who = await session.call("whoami");
      expect(who.result.isError).toBeFalsy();
      expect(JSON.parse(toolText(who.result)).id).toBe(userA.userId);
    }

    // …but the CIMD credential does NOT carry the dynamic client's
    // `contribute` scope, even though both belong to the same user.
    const cimdContribute = await cimdSession.call("submit_pool_items", { bountyId: "nope", items: [] });
    expect(cimdContribute.result.isError).toBe(true);
    expect(toolText(cimdContribute.result)).toMatch(/missing the required scope: contribute/i);

    // The dynamic client's own token clears the scope gate (it then fails on
    // the bounty, which is the point: the refusal is no longer about scope).
    const dynContribute = await dynSession.call("submit_pool_items", { bountyId: "nope", items: [] });
    expect(toolText(dynContribute.result)).not.toMatch(/missing the required scope/i);

    // The API key is `read` too, and equally cannot borrow `contribute`.
    const keyContribute = await keySession.call("submit_pool_items", { bountyId: "nope", items: [] });
    expect(keyContribute.result.isError).toBe(true);
    expect(toolText(keyContribute.result)).toMatch(/missing the required scope: contribute/i);

    // ── audit attribution: one distinct tool per credential ───────────────
    await cimdSession.call("get_karma_details");
    await dynSession.call("list_notifications");
    await keySession.call("mark_notifications_read");

    const rows = await waitForAuditEvents({ userId: userA.userId, action: "tool.invoked" }, 9);
    const byTool = (tool: string) =>
      rows.filter((row) => (row.metadata as { tool?: string } | null)?.tool === tool);

    const karma = byTool("get_karma_details");
    expect(karma.length).toBeGreaterThanOrEqual(1);
    for (const row of karma) {
      expect(row.clientId).toBe(CIMD_URL);
      expect((row.metadata as { keyId?: string }).keyId).toBeUndefined();
    }

    const notifications = byTool("list_notifications");
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    for (const row of notifications) {
      expect(row.clientId).toBe(dynClientId);
      expect((row.metadata as { keyId?: string }).keyId).toBeUndefined();
    }

    // An API-key principal carries keyId in metadata and NEVER borrows a
    // clientId — `clientId` is an FK to OAuthClient and an API key has none.
    const marked = byTool("mark_notifications_read");
    expect(marked.length).toBeGreaterThanOrEqual(1);
    for (const row of marked) {
      expect(row.clientId).toBeNull();
      expect((row.metadata as { keyId?: string }).keyId).toBe(apiKey.id);
    }

    // No tool.invoked row for userA is attributed to any client but these two.
    for (const row of rows) {
      if (row.clientId !== null) expect([CIMD_URL, dynClientId]).toContain(row.clientId);
    }

    // Nothing userA did is attributed to userB.
    const bRows = await prisma.oAuthAuditEvent.findMany({ where: { userId: userB.userId, action: "tool.invoked" } });
    expect(bRows).toHaveLength(0);
  });

  it("refuses a session id presented with a different credential — sessions are bound to their principal", async () => {
    const cimd = await connectClient({
      clientId: cimdClientId,
      redirectUri: CIMD_REDIRECT,
      request: ["read"],
      cookie: userA.cookie,
    });
    const dyn = await connectClient({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      request: ["read"],
      cookie: userA.cookie,
    });
    const apiKey = await issueApiKey(userA.cookie, ["read"]);

    const cimdSession = await openMcpSession(cimd.accessToken);

    for (const [label, token] of [
      ["other OAuth client", dyn.accessToken],
      ["API key", apiKey.key],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          accept: MCP_ACCEPT,
          "content-type": "application/json",
          "mcp-session-id": cimdSession.sessionId,
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(res.statusCode, label).toBe(401);
      expect(res.json().message, label).toMatch(/different credential/i);
    }
  });

  it("denies one tool per non-granted scope to a read-only OAuth token", async () => {
    const readOnly = await connectClient({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      request: ["read"],
      cookie: userA.cookie,
    });
    const session = await openMcpSession(readOnly.accessToken);

    const matrix: [string, string, Record<string, unknown>][] = [
      ["contribute", "submit_pool_items", { bountyId: "x", items: [] }],
      ["validate", "list_audits", {}],
      ["artifact", "list_files", {}],
      ["sponsor", "get_sponsor_submission_evidence", { bountyId: "x" }],
      ["account", "claim_handle", { handle: "should-never-happen" }],
    ];

    for (const [scope, tool, args] of matrix) {
      const res = await session.call(tool, args);
      expect(res.result.isError, `${tool} (${scope})`).toBe(true);
      expect(toolText(res.result), `${tool} (${scope})`).toMatch(new RegExp(`missing the required scope: ${scope}`, "i"));
      // A 403 scope refusal must also hand the client a runtime challenge so a
      // standards-compliant client can ask for a wider grant.
      const challenge = res.result._meta?.["mcp/www_authenticate"];
      expect(Array.isArray(challenge), `${tool} challenge`).toBe(true);
      expect(String(challenge[0]), `${tool} challenge`).toContain(scope);
    }

    // The handle was never claimed — the refusal was real, not cosmetic.
    const user = await prisma.user.findUnique({ where: { id: userA.userId }, select: { handle: true } });
    expect(user?.handle).not.toBe("should-never-happen");
  });

  it("denies one tool per non-granted scope to a read-only API key over the legacy /mcp/call surface", async () => {
    const apiKey = await issueApiKey(userA.cookie, ["read"]);
    const matrix: [string, string, Record<string, unknown>][] = [
      ["contribute", "submit_pool_items", { bountyId: "x", items: [] }],
      ["validate", "list_audits", {}],
      ["artifact", "list_files", {}],
      ["sponsor", "get_sponsor_submission_evidence", { bountyId: "x" }],
      ["account", "claim_handle", { handle: "should-never-happen" }],
    ];
    for (const [scope, tool, args] of matrix) {
      const res = await app.inject({
        method: "POST",
        url: "/mcp/call",
        headers: { authorization: `Bearer ${apiKey.key}` },
        payload: { name: tool, arguments: args },
      });
      expect(res.statusCode, `${tool} (${scope})`).toBe(403);
      expect(res.json().isError, `${tool} (${scope})`).toBe(true);
      expect(String(res.json().content[0].text), `${tool} (${scope})`).toMatch(
        new RegExp(`missing the required scope: ${scope}`, "i"),
      );
    }
  });
});

// ══ 2. Cross-client abuse of another client's grant ════════════════════════

describe("one client cannot use another client's grant", () => {
  it("refuses to redeem an authorization code issued to a different client", async () => {
    const { requestId, verifier } = await startAuthorization({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      scope: ["read"],
    });
    const approved = await approve(requestId, userA.cookie, ["read"]);
    expect(approved.statusCode).toBe(200);
    const code = approved.json().code as string;

    // The CIMD client presents a code minted for the dynamic client. Both
    // clients are real and registered; only the binding differs.
    const stolen = await exchangeCode({ clientId: cimdClientId, code, verifier, redirectUri: DYN_REDIRECT });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().error).toBe("invalid_grant");

    // …and the code is still redeemable by its rightful client, so the
    // refusal did not burn it.
    const rightful = await exchangeCode({ clientId: dynClientId, code, verifier, redirectUri: DYN_REDIRECT });
    expect(rightful.statusCode).toBe(200);
    expect(rightful.json().access_token).toMatch(/^db_mcp_at_/);
  });

  it("refuses to refresh another client's refresh token", async () => {
    const dyn = await connectClient({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      request: ["read"],
      cookie: userA.cookie,
    });

    const stolen = await refresh(cimdClientId, dyn.refreshToken);
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().error).toBe("invalid_grant");

    // Still usable by its own client.
    const own = await refresh(dynClientId, dyn.refreshToken);
    expect(own.statusCode).toBe(200);
    expect(own.json().access_token).toMatch(/^db_mcp_at_/);
  });

  it("refuses to widen scope on refresh", async () => {
    const dyn = await connectClient({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      request: ["read", "contribute"],
      approve: ["read"],
      cookie: userA.cookie,
    });
    const widened = await refresh(dynClientId, dyn.refreshToken, ["read", "contribute"]);
    expect(widened.statusCode).toBe(400);
    expect(widened.json().error).toBe("invalid_scope");
  });

  it("revoking one client's grant leaves every other client working", async () => {
    const cimd = await connectClient({
      clientId: cimdClientId,
      redirectUri: CIMD_REDIRECT,
      request: ["read"],
      cookie: userA.cookie,
    });
    const dyn = await connectClient({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      request: ["read"],
      cookie: userA.cookie,
    });
    const apiKey = await issueApiKey(userA.cookie, ["read"]);

    const revoked = await app.inject({
      method: "POST",
      url: `/mcp/oauth/grants/${encodeURIComponent(cimdClientId)}/revoke`,
      headers: { cookie: userA.cookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revoked).toBe(true);

    // CIMD is dead immediately — there is no verified-token cache to wait out.
    const dead = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${cimd.accessToken}`, accept: MCP_ACCEPT, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(dead.statusCode).toBe(401);
    expect((await refresh(cimdClientId, cimd.refreshToken)).statusCode).toBe(400);

    // The other two are untouched.
    const dynSession = await openMcpSession(dyn.accessToken);
    expect(JSON.parse(toolText((await dynSession.call("whoami")).result)).id).toBe(userA.userId);
    const keySession = await openMcpSession(apiKey.key);
    expect(JSON.parse(toolText((await keySession.call("whoami")).result)).id).toBe(userA.userId);
  });

  it("another account cannot revoke this account's grant", async () => {
    const dyn = await connectClient({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      request: ["read"],
      cookie: userA.cookie,
    });

    // userB asks for userA's client to be disconnected. The route is scoped to
    // the *session's* user, so it must be a no-op, not a cross-account kill.
    const attempt = await app.inject({
      method: "POST",
      url: `/mcp/oauth/grants/${encodeURIComponent(dynClientId)}/revoke`,
      headers: { cookie: userB.cookie },
    });
    expect(attempt.statusCode).toBe(200);
    expect(attempt.json().revoked).toBe(false);

    const session = await openMcpSession(dyn.accessToken);
    expect(JSON.parse(toolText((await session.call("whoami")).result)).id).toBe(userA.userId);
  });

  it(
    "RFC 7009 §2.1: the revocation endpoint must verify the token was issued to the requesting client",
    async () => {
      // RFC 7009 §2.1: "The authorization server first validates the client
      // credentials (in case of a confidential client) and then verifies
      // whether the token was issued to the client making the revocation
      // request." routes/mcp.ts `/mcp/oauth/revoke` never reads `client_id`
      // and services/mcp-oauth.ts `revokeMcpToken(token)` takes no client at
      // all, so any client that gets hold of another client's token can kill
      // it. Recorded as a failing expectation rather than softened.
      const dyn = await connectClient({
        clientId: dynClientId,
        redirectUri: DYN_REDIRECT,
        request: ["read"],
        cookie: userA.cookie,
      });

      const res = await app.inject({
        method: "POST",
        url: "/mcp/oauth/revoke",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ token: dyn.accessToken, client_id: cimdClientId }).toString(),
      });
      // RFC 7009 §2.2 requires 200 even for a token the server declines to
      // act on, so the observable requirement is that the token SURVIVES.
      expect(res.statusCode).toBe(200);

      const still = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${dyn.accessToken}`, accept: MCP_ACCEPT, "content-type": "application/json" },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "v", version: "0" } },
        },
      });
      expect(still.statusCode).toBe(200);
    },
  );
});

// ══ 3. RFC 8707 / MCP authorization spec: audience binding ════════════════

describe("RFC 8707 resource indicators bind a credential to this MCP endpoint", () => {
  it("refuses an authorization request for a foreign resource", async () => {
    const { challenge } = pkce();
    const res = await app.inject({
      method: "GET",
      url: "/mcp/oauth/authorize",
      query: {
        response_type: "code",
        client_id: dynClientId,
        redirect_uri: DYN_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "read",
        resource: "https://someone-elses-mcp.example/mcp",
      },
    });
    // A registered redirect_uri means the error is delivered as a redirect
    // (RFC 6749 §4.1.2.1) rather than JSON — either way it must not succeed.
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get("error")).toBe("invalid_target");
    expect(location.searchParams.get("request_id")).toBeNull();
  });

  it("refuses a token exchange whose resource does not match the approved one", async () => {
    const { requestId, verifier } = await startAuthorization({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      scope: ["read"],
    });
    const approved = await approve(requestId, userA.cookie, ["read"]);
    expect(approved.statusCode).toBe(200);
    const code = approved.json().code as string;

    const mismatched = await exchangeCode({
      clientId: dynClientId,
      code,
      verifier,
      redirectUri: DYN_REDIRECT,
      resource: "https://someone-elses-mcp.example/mcp",
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error).toBe("invalid_grant");

    // A trailing slash on the client's configured URL still matches — the
    // comparison is over canonicalised resources, not raw bytes.
    const resource = (await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" })).json().resource as string;
    const ok = await exchangeCode({
      clientId: dynClientId,
      code,
      verifier,
      redirectUri: DYN_REDIRECT,
      resource: `${resource}/`,
    });
    expect(ok.statusCode).toBe(200);
  });
});

// ══ 4. Concurrent dashboard sessions and concurrent consent flows ══════════

describe("concurrent sessions", () => {
  it("keeps two simultaneous consent flows for one account independent, each approved from its own browser session", async () => {
    // Both requests exist before either is approved — genuinely concurrent.
    const first = await startAuthorization({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      scope: ["read", "contribute"],
      state: "flow-1",
    });
    const second = await startAuthorization({
      clientId: cimdClientId,
      redirectUri: CIMD_REDIRECT,
      scope: ["read", "account"],
      state: "flow-2",
    });
    expect(first.requestId).not.toBe(second.requestId);

    // Each consent page shows its OWN client and its OWN requested scopes,
    // read through two different sessions of the same account.
    const view1 = await app.inject({ method: "GET", url: `/mcp/oauth/request/${first.requestId}`, headers: { cookie: userA.cookie } });
    const view2 = await app.inject({ method: "GET", url: `/mcp/oauth/request/${second.requestId}`, headers: { cookie: cookieA2 } });
    expect(view1.statusCode).toBe(200);
    expect(view2.statusCode).toBe(200);
    expect(view1.json().scopes).toEqual(["read", "contribute"]);
    expect(view2.json().scopes).toEqual(["read", "account"]);
    expect(view1.json().redirectUri).toBe(DYN_REDIRECT);
    expect(view2.json().redirectUri).toBe(CIMD_REDIRECT);
    expect(view2.json().clientIdHost).toBe("multiclient-cimd.example");
    expect(view1.json().clientIdHost).toBeNull();

    // Approve both, from the two different sessions, with DIFFERENT subsets.
    const [approved1, approved2] = await Promise.all([
      approve(first.requestId, userA.cookie, ["read"]),
      approve(second.requestId, cookieA2, ["read", "account"]),
    ]);
    expect(approved1.statusCode).toBe(200);
    expect(approved2.statusCode).toBe(200);
    expect(approved1.json().state).toBe("flow-1");
    expect(approved2.json().state).toBe("flow-2");

    // No cross-talk: each code redeems only against its own client, with only
    // the scopes that flow approved.
    const crossed = await exchangeCode({
      clientId: cimdClientId,
      code: approved1.json().code,
      verifier: first.verifier,
      redirectUri: DYN_REDIRECT,
    });
    expect(crossed.statusCode).toBe(400);

    const token1 = await exchangeCode({
      clientId: dynClientId,
      code: approved1.json().code,
      verifier: first.verifier,
      redirectUri: DYN_REDIRECT,
    });
    const token2 = await exchangeCode({
      clientId: cimdClientId,
      code: approved2.json().code,
      verifier: second.verifier,
      redirectUri: CIMD_REDIRECT,
    });
    expect(token1.statusCode).toBe(200);
    expect(token2.statusCode).toBe(200);
    expect(token1.json().scope).toBe("read");
    expect(token2.json().scope).toBe("read account");

    // The scope split is enforced, not merely reported.
    const session1 = await openMcpSession(token1.json().access_token);
    const session2 = await openMcpSession(token2.json().access_token);
    expect(toolText((await session1.call("claim_handle", { handle: "no" })).result)).toMatch(
      /missing the required scope: account/i,
    );
    expect(toolText((await session2.call("claim_handle", { handle: "no" })).result)).not.toMatch(
      /missing the required scope/i,
    );
  });

  it("a completed authorization request cannot be replayed by either session", async () => {
    const { requestId } = await startAuthorization({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      scope: ["read"],
    });
    expect((await approve(requestId, userA.cookie, ["read"])).statusCode).toBe(200);

    // The same session, and the account's OTHER session, both get the same
    // "already completed" answer — the request is not re-approvable.
    for (const [label, cookie] of [
      ["same session", userA.cookie],
      ["second session", cookieA2],
      ["another account", userB.cookie],
    ] as const) {
      const again = await approve(requestId, cookie, ["read"]);
      expect(again.statusCode, label).toBe(400);
      expect(again.json().reason, label).toBe("already_completed");
      const read = await app.inject({ method: "GET", url: `/mcp/oauth/request/${requestId}`, headers: { cookie } });
      expect(read.statusCode, label).toBe(400);
      expect(read.json().reason, label).toBe("already_completed");
    }
  });

  it("OBSERVED MODEL: a pending authorization request is unowned until consent, so any signed-in account may approve it and the grant binds to whoever did", async () => {
    // This is the standard OAuth authorization-server model: `/authorize` is
    // unauthenticated, the request carries no user until the consent screen
    // authenticates one (services/mcp-oauth.ts approveAuthorizationRequest
    // sets `userId` at approval time). Recorded as the observed contract, not
    // asserted as a leak: the consent read exposes only client metadata and
    // requested scopes — no data belonging to the initiating account.
    const { requestId, verifier } = await startAuthorization({
      clientId: dynClientId,
      redirectUri: DYN_REDIRECT,
      scope: ["read"],
    });

    const bView = await app.inject({ method: "GET", url: `/mcp/oauth/request/${requestId}`, headers: { cookie: userB.cookie } });
    expect(bView.statusCode).toBe(200);
    // Nothing about userA is in the payload.
    expect(JSON.stringify(bView.json())).not.toContain(userA.userId);
    expect(JSON.stringify(bView.json())).not.toContain(userA.email);

    const approved = await approve(requestId, userB.cookie, ["read"]);
    expect(approved.statusCode).toBe(200);
    const token = await exchangeCode({
      clientId: dynClientId,
      code: approved.json().code,
      verifier,
      redirectUri: DYN_REDIRECT,
    });
    expect(token.statusCode).toBe(200);

    // The credential is userB's, never userA's — approval binds identity.
    const session = await openMcpSession(token.json().access_token);
    expect(JSON.parse(toolText((await session.call("whoami")).result)).id).toBe(userB.userId);

    // And the consent read itself is still session-gated.
    const anon = await app.inject({ method: "GET", url: `/mcp/oauth/request/${requestId}` });
    expect(anon.statusCode).toBe(401);
  });

  it("OBSERVED MODEL: the same client connecting twice yields two token pairs but ONE grant row in the dashboard list, and revoke kills both", async () => {
    const clientId = await registerDynamicClient("multiclient-twice");
    const first = await connectClient({ clientId, redirectUri: DYN_REDIRECT, request: ["read"], cookie: userA.cookie });
    const second = await connectClient({ clientId, redirectUri: DYN_REDIRECT, request: ["read"], cookie: cookieA2 });
    expect(first.accessToken).not.toBe(second.accessToken);

    // Storage: two independent access tokens and two refresh tokens.
    expect(
      await prisma.oAuthAccessToken.count({ where: { userId: userA.userId, clientId, revokedAt: null } }),
    ).toBe(2);

    // Presentation: `GET /mcp/oauth/grants` collapses them to one row per
    // client (services/mcp-oauth.ts listMcpGrants keys a Map on clientId).
    const grants = await app.inject({ method: "GET", url: "/mcp/oauth/grants", headers: { cookie: userA.cookie } });
    expect(grants.statusCode).toBe(200);
    const matching = (grants.json().grants as { clientId: string }[]).filter((g) => g.clientId === clientId);
    expect(matching).toHaveLength(1);

    // Both connections are live…
    for (const token of [first.accessToken, second.accessToken]) {
      const session = await openMcpSession(token);
      expect(JSON.parse(toolText((await session.call("whoami")).result)).id).toBe(userA.userId);
    }

    // …and one revoke of that single grant row kills both, consistently with
    // the one-row presentation.
    const revoked = await app.inject({
      method: "POST",
      url: `/mcp/oauth/grants/${encodeURIComponent(clientId)}/revoke`,
      headers: { cookie: cookieA2 },
    });
    expect(revoked.statusCode).toBe(200);
    for (const token of [first.accessToken, second.accessToken]) {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(res.statusCode).toBe(401);
    }
    const after = await app.inject({ method: "GET", url: "/mcp/oauth/grants", headers: { cookie: userA.cookie } });
    expect((after.json().grants as { clientId: string }[]).some((g) => g.clientId === clientId)).toBe(false);
  });

  it("revoke-all disconnects every OAuth client of the account and nobody else's", async () => {
    const clientId = await registerDynamicClient("multiclient-revoke-all");
    const mine = await connectClient({ clientId, redirectUri: DYN_REDIRECT, request: ["read"], cookie: userA.cookie });
    const alsoMine = await connectClient({
      clientId: cimdClientId,
      redirectUri: CIMD_REDIRECT,
      request: ["read"],
      cookie: userA.cookie,
    });
    const theirs = await connectClient({ clientId, redirectUri: DYN_REDIRECT, request: ["read"], cookie: userB.cookie });

    const res = await app.inject({ method: "POST", url: "/mcp/oauth/grants/revoke-all", headers: { cookie: userA.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked).toBe(true);

    for (const token of [mine.accessToken, alsoMine.accessToken]) {
      const dead = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(dead.statusCode).toBe(401);
    }
    expect((await app.inject({ method: "GET", url: "/mcp/oauth/grants", headers: { cookie: userA.cookie } })).json().grants).toEqual([]);

    // userB shares the same client registration and is unaffected.
    const session = await openMcpSession(theirs.accessToken);
    expect(JSON.parse(toolText((await session.call("whoami")).result)).id).toBe(userB.userId);
  });

  it("runs parallel tool calls on several live credentials without leaking identity between them", async () => {
    // The principal lives in AsyncLocalStorage precisely so this cannot go
    // wrong (lib/mcp-context.ts). Two clients of userA, one client of userB,
    // one API key each — all in flight together.
    const aOne = await connectClient({ clientId: dynClientId, redirectUri: DYN_REDIRECT, request: ["read"], cookie: userA.cookie });
    const aTwo = await connectClient({ clientId: cimdClientId, redirectUri: CIMD_REDIRECT, request: ["read"], cookie: userA.cookie });
    const bOne = await connectClient({ clientId: dynClientId, redirectUri: DYN_REDIRECT, request: ["read"], cookie: userB.cookie });
    const aKey = await issueApiKey(userA.cookie, ["read"]);
    const bKey = await issueApiKey(userB.cookie, ["read"]);

    const sessions = await Promise.all(
      [aOne.accessToken, aTwo.accessToken, aKey.key, bOne.accessToken, bKey.key].map(openMcpSession),
    );
    const expected = [userA.userId, userA.userId, userA.userId, userB.userId, userB.userId];

    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(sessions.map((session) => session.call("whoami")));
      expect(results.map((r) => JSON.parse(toolText(r.result)).id)).toEqual(expected);
    }
  });
});

// ══ 5. Per-credential rate limiting ════════════════════════════════════════

describe("per-credential rate limiting", () => {
  it("buckets by API key id, not by IP — exhausting one key leaves another key of the SAME user on the SAME IP working", async () => {
    const first = await issueApiKey(userA.cookie, ["read"]);
    const second = await issueApiKey(userA.cookie, ["read"]);
    const prior = process.env.MCP_RATE_LIMIT_PER_MIN;
    process.env.MCP_RATE_LIMIT_PER_MIN = "2";
    try {
      const a1 = await pingWithBearer(first.key);
      const a2 = await pingWithBearer(first.key);
      const a3 = await pingWithBearer(first.key);
      expect(a1.statusCode).not.toBe(429);
      expect(a2.statusCode).not.toBe(429);
      expect(a3.statusCode).toBe(429);
      expect(a3.headers["retry-after"]).toBeTruthy();
      expect(a3.json().message).toMatch(/API key rate limit exceeded/i);

      // Same user, same IP, different key → its own bucket.
      const b1 = await pingWithBearer(second.key);
      expect(b1.statusCode).not.toBe(429);
    } finally {
      if (prior === undefined) delete process.env.MCP_RATE_LIMIT_PER_MIN;
      else process.env.MCP_RATE_LIMIT_PER_MIN = prior;
    }
  });

  it("buckets OAuth traffic by (userId, clientId) — one client's exhaustion does not 429 the account's other client, nor another account on the same client", async () => {
    const clientOne = await registerDynamicClient("multiclient-rl-one");
    const clientTwo = await registerDynamicClient("multiclient-rl-two");
    const aOnOne = await connectClient({ clientId: clientOne, redirectUri: DYN_REDIRECT, request: ["read"], cookie: userA.cookie });
    const aOnTwo = await connectClient({ clientId: clientTwo, redirectUri: DYN_REDIRECT, request: ["read"], cookie: userA.cookie });
    const bOnOne = await connectClient({ clientId: clientOne, redirectUri: DYN_REDIRECT, request: ["read"], cookie: userB.cookie });

    const prior = process.env.MCP_RATE_LIMIT_PER_MIN;
    process.env.MCP_RATE_LIMIT_PER_MIN = "2";
    try {
      await pingWithBearer(aOnOne.accessToken);
      await pingWithBearer(aOnOne.accessToken);
      const exhausted = await pingWithBearer(aOnOne.accessToken);
      expect(exhausted.statusCode).toBe(429);
      expect(exhausted.json().message).toMatch(/MCP client rate limit exceeded/i);

      // Different client, same user → separate bucket (this is what "not
      // per-IP" actually means, since both requests share one IP).
      expect((await pingWithBearer(aOnTwo.accessToken)).statusCode).not.toBe(429);
      // Same client, different user → separate bucket.
      expect((await pingWithBearer(bOnOne.accessToken)).statusCode).not.toBe(429);
    } finally {
      if (prior === undefined) delete process.env.MCP_RATE_LIMIT_PER_MIN;
      else process.env.MCP_RATE_LIMIT_PER_MIN = prior;
    }

    // The bucket keys are the documented shape.
    const keys = await prisma.apiKeyRateBucket.findMany({
      where: { keyId: { in: [`mcp:${userA.userId}:${clientOne}`, `mcp:${userA.userId}:${clientTwo}`, `mcp:${userB.userId}:${clientOne}`] } },
      select: { keyId: true },
    });
    expect(new Set(keys.map((k) => k.keyId)).size).toBe(3);
  });

  it.fails(
    "the X-RateLimit-* headers must describe the limit actually enforced — the global plugin's onSend overwrites the per-credential hook's, so a throttled client is told it has 100000 requests left (DEFECT)",
    async () => {
      // app.ts:120-122/136-138 set X-RateLimit-Limit/Remaining from the
      // per-credential bucket, but @fastify/rate-limit (registered at
      // app.ts:95) rewrites both in its own onSend with the GLOBAL per-IP
      // figures. The headers a client reads therefore describe a limit that is
      // not the one refusing it, which is precisely the signal an MCP client
      // uses to back off.
      const key = await issueApiKey(userA.cookie, ["read"]);
      const prior = process.env.MCP_RATE_LIMIT_PER_MIN;
      process.env.MCP_RATE_LIMIT_PER_MIN = "2";
      try {
        const first = await pingWithBearer(key.key);
        expect(first.headers["x-ratelimit-limit"]).toBe("2");
      } finally {
        if (prior === undefined) delete process.env.MCP_RATE_LIMIT_PER_MIN;
        else process.env.MCP_RATE_LIMIT_PER_MIN = prior;
      }
    },
  );

  it(
    "the GLOBAL limiter must not put two different credentials into one bucket",
    async () => {
      // app.ts:95-99 registers @fastify/rate-limit with no `keyGenerator`, so
      // the plugin default (per-IP) governs every authenticated request. v1
      // supplies one (databounty-api/src/app.ts:146 →
      // lib/rate-limit-key.ts:44-60): API key → key fingerprint, session →
      // userId, otherwise IP. Without it the per-credential hook immediately
      // below (app.ts:107-143, correctly keyed on `apiKey.id` and
      // `mcp:<userId>:<clientId>`) is undermined by the layer above it — the
      // exact failure that hook's own comment at app.ts:131-134 says it
      // exists to prevent.
      //
      // Proven on a SECOND app instance booted with a tiny global limit,
      // because the global limit is read once at boot.
      const keyOne = await issueApiKey(userA.cookie, ["read"]);
      const keyTwo = await issueApiKey(userB.cookie, ["read"]);

      process.env.RATELIMIT_GLOBAL_MAX = "2";
      const tiny = await buildApp();
      await tiny.ready();
      try {
        // Two requests on userA's key exhaust the shared per-IP bucket…
        await tiny.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${keyOne.key}` } });
        await tiny.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${keyOne.key}` } });
        // …and a DIFFERENT user's DIFFERENT credential is refused by it.
        const other = await tiny.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${keyTwo.key}` } });
        expect(other.statusCode).not.toBe(429);
      } finally {
        await tiny.close();
        process.env.RATELIMIT_GLOBAL_MAX = "100000";
      }
    },
  );

  it("never lets the limiter answer 401/403 — an invalid bearer is left to the auth path, so the limiter is not a credential oracle", async () => {
    const prior = process.env.MCP_RATE_LIMIT_PER_MIN;
    process.env.MCP_RATE_LIMIT_PER_MIN = "1";
    try {
      for (let i = 0; i < 4; i++) {
        const res = await pingWithBearer("db_live_sk_dummy_invalid");
        expect(res.statusCode).toBe(401);
      }
    } finally {
      if (prior === undefined) delete process.env.MCP_RATE_LIMIT_PER_MIN;
      else process.env.MCP_RATE_LIMIT_PER_MIN = prior;
    }
  });
});

// ══ 6. Developer API keys ══════════════════════════════════════════════════

describe("API key lifecycle", () => {
  it("reveals the plaintext exactly once and never stores it", async () => {
    const issued = await issueApiKey(userA.cookie, ["read", "contribute"]);
    expect(issued.key).toMatch(/^db_live_sk_/);
    expect(issued.keyPrefix).toBe(issued.key.slice(0, "db_live_sk_".length + 12));

    // Never again over the API.
    const listed = await app.inject({ method: "GET", url: "/v1/me/api-keys", headers: { cookie: userA.cookie } });
    expect(listed.statusCode).toBe(200);
    const row = (listed.json().keys as any[]).find((k) => k.id === issued.id);
    expect(row).toBeTruthy();
    expect(row.key).toBeUndefined();
    expect(JSON.stringify(listed.json())).not.toContain(issued.key);

    // Never at rest, either: only an HMAC and a display prefix.
    const stored = await prisma.apiKey.findUnique({ where: { id: issued.id } });
    expect(stored).not.toBeNull();
    expect(stored!.keyHash).not.toBe(issued.key);
    expect(stored!.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.key.startsWith(stored!.keyPrefix)).toBe(true);
    expect(stored!.keyPrefix.length).toBeLessThan(issued.key.length);
    const literal = await prisma.apiKey.findMany({ where: { OR: [{ keyHash: issued.key }, { keyPrefix: issued.key }] } });
    expect(literal).toHaveLength(0);

    // Issuance is audited.
    const audit = await prisma.adminAuditLog.findMany({ where: { targetType: "ApiKey", targetId: issued.id, action: "api_key.issued" } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.after)).not.toContain(issued.key);
  });

  it("rotates by revoke-and-recreate: the old secret stops working immediately, the new one works, and the key id changes", async () => {
    const issued = await issueApiKey(userA.cookie, ["read"]);
    const before = await openMcpSession(issued.key);
    expect(JSON.parse(toolText((await before.call("whoami")).result)).id).toBe(userA.userId);

    const rotated = await app.inject({
      method: "POST",
      url: `/v1/me/api-keys/${issued.id}/rotate`,
      headers: { cookie: userA.cookie, origin: "http://localhost:3010" },
    });
    expect(rotated.statusCode).toBe(200);
    const newKey = rotated.json().key as string;
    // A NEW row, not a new secret on the old row: the MCP session binding is
    // `api-key:<id>`, so keeping the id left sessions opened with the old
    // secret alive after rotation.
    const rotatedId = rotated.json().id as string;
    expect(rotatedId).not.toBe(issued.id);
    expect(newKey).not.toBe(issued.key);
    expect(rotated.json().rotatedAt).toBeTruthy();

    const oldRefused = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${issued.key}`, accept: MCP_ACCEPT, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(oldRefused.statusCode).toBe(401);

    const after = await openMcpSession(newKey);
    expect(JSON.parse(toolText((await after.call("whoami")).result)).id).toBe(userA.userId);

    const audit = await prisma.adminAuditLog.findMany({ where: { targetType: "ApiKey", targetId: rotatedId, action: "api_key.rotated" } });
    expect(audit).toHaveLength(1);
    expect((audit[0]!.before as { previousKeyId?: string }).previousKeyId).toBe(issued.id);
  });

  it("revokes immediately and refuses the key from then on", async () => {
    const issued = await issueApiKey(userA.cookie, ["read"]);
    const session = await openMcpSession(issued.key);
    expect((await session.call("whoami")).result.isError).toBeFalsy();

    const revoked = await app.inject({ method: "DELETE", url: `/v1/me/api-keys/${issued.id}`, headers: { cookie: userA.cookie, origin: "http://localhost:3010" } });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().key.revokedAt).toBeTruthy();

    // No cache window: the very next request is refused, on the live session
    // id as well as on a fresh connection.
    const onLiveSession = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${issued.key}`,
        accept: MCP_ACCEPT,
        "content-type": "application/json",
        "mcp-session-id": session.sessionId,
      },
      payload: { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} },
    });
    expect(onLiveSession.statusCode).toBe(401);

    // A revoked key cannot be rotated back to life.
    const rotate = await app.inject({ method: "POST", url: `/v1/me/api-keys/${issued.id}/rotate`, headers: { cookie: userA.cookie, origin: "http://localhost:3010" } });
    expect(rotate.statusCode).toBe(404);
  });

  it("refuses cross-account key management", async () => {
    const issued = await issueApiKey(userA.cookie, ["read"]);
    for (const [method, url] of [
      ["POST", `/v1/me/api-keys/${issued.id}/rotate`],
      ["DELETE", `/v1/me/api-keys/${issued.id}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie: userB.cookie, origin: "http://localhost:3010" } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // Still userA's, still working.
    const session = await openMcpSession(issued.key);
    expect(JSON.parse(toolText((await session.call("whoami")).result)).id).toBe(userA.userId);
    // And userB's own listing never shows it.
    const listed = await app.inject({ method: "GET", url: "/v1/me/api-keys", headers: { cookie: userB.cookie } });
    expect((listed.json().keys as any[]).some((k) => k.id === issued.id)).toBe(false);
  });
});

describe("API keys and OAuth tokens are independent credentials", () => {
  it("revoking the API key leaves the OAuth token working, and revoking the OAuth grant leaves a second API key working", async () => {
    const clientId = await registerDynamicClient("multiclient-independence");
    const oauth = await connectClient({ clientId, redirectUri: DYN_REDIRECT, request: ["read"], cookie: userA.cookie });
    const keyOne = await issueApiKey(userA.cookie, ["read"]);
    const keyTwo = await issueApiKey(userA.cookie, ["read"]);

    // Direction 1: kill the API key.
    expect((await app.inject({ method: "DELETE", url: `/v1/me/api-keys/${keyOne.id}`, headers: { cookie: userA.cookie, origin: "http://localhost:3010" } })).statusCode).toBe(200);
    const keyOneDead = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${keyOne.key}`, accept: MCP_ACCEPT, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(keyOneDead.statusCode).toBe(401);
    const oauthSession = await openMcpSession(oauth.accessToken);
    expect(JSON.parse(toolText((await oauthSession.call("whoami")).result)).id).toBe(userA.userId);

    // Direction 2: kill every OAuth grant. The surviving API key is untouched —
    // revoke-all operates on oauth_access_tokens / oauth_refresh_tokens only.
    expect((await app.inject({ method: "POST", url: "/mcp/oauth/grants/revoke-all", headers: { cookie: userA.cookie } })).statusCode).toBe(200);
    const oauthDead = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${oauth.accessToken}`, accept: MCP_ACCEPT, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(oauthDead.statusCode).toBe(401);
    const keyTwoSession = await openMcpSession(keyTwo.key);
    expect(JSON.parse(toolText((await keyTwoSession.call("whoami")).result)).id).toBe(userA.userId);
    const stillLive = await prisma.apiKey.findUnique({ where: { id: keyTwo.id }, select: { revokedAt: true } });
    expect(stillLive?.revokedAt).toBeNull();
  });

  it("an OAuth access token is not an API key and never appears in the account's key list", async () => {
    const oauth = await connectClient({ clientId: dynClientId, redirectUri: DYN_REDIRECT, request: ["read"], cookie: userA.cookie });
    const listed = await app.inject({ method: "GET", url: "/v1/me/api-keys", headers: { cookie: userA.cookie } });
    expect(JSON.stringify(listed.json())).not.toContain(oauth.accessToken);
    // …and the OAuth grant list does not report API keys as OAuth clients.
    const grants = await app.inject({ method: "GET", url: "/mcp/oauth/grants", headers: { cookie: userA.cookie } });
    for (const grant of grants.json().grants as { clientId: string }[]) {
      expect(grant.clientId.startsWith("db_live_sk_")).toBe(false);
    }
  });
});

describe("credential kinds are not interchangeable across surfaces", () => {
  it("an API key is refused wherever a dashboard session is required (lib/rbac.ts requireAuth / requireRole)", async () => {
    const apiKey = await issueApiKey(userA.cookie, ["read", "contribute", "validate", "artifact", "sponsor", "account"]);

    // requireAuth: the account surface is session-only even with every scope.
    for (const url of ["/v1/me/badges", "/v1/me/api-keys"]) {
      const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${apiKey.key}` } });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().message, url).toMatch(/requires a dashboard session/i);
    }
    // A key cannot mint another key.
    const mint = await app.inject({
      method: "POST",
      url: "/v1/me/api-keys",
      headers: { authorization: `Bearer ${apiKey.key}` },
      payload: { scopes: ["read"] },
    });
    expect(mint.statusCode).toBe(403);

    // requireRole: admin surfaces are session-only, with a distinct message.
    const admin = await app.inject({ method: "GET", url: "/v1/admin/api-keys", headers: { authorization: `Bearer ${apiKey.key}` } });
    expect(admin.statusCode).toBe(403);
    expect(admin.json().message).toMatch(/require a dashboard session/i);

    // MCP consent/grant management is session-gated too — a bearer API key is
    // not a session there.
    for (const url of ["/mcp/oauth/grants"]) {
      const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${apiKey.key}` } });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error, url).toBe("login_required");
    }
  });

  it(
    "a suspended account's API key must stop executing MCP tools",
    async () => {
      // `verifyMcpAccessToken` joins the user and refuses a non-active account
      // (services/mcp-oauth.ts:618). `verifyApiKey` selects only
      // id/userId/scopes/expiresAt/revokedAt and never looks at
      // `user.status` (services/api-keys.ts:178-197), and the single MCP tool
      // choke point checks credential → scope → verified email → onboarding
      // but never status (mcp/tool-gate.ts:83-97). REST is still safe because
      // lib/rbac.ts:37 re-reads the user; the MCP transport is not, because
      // routes/mcp.ts:171 accepts the key on verifyApiKey alone.
      // v1 databounty-api/src/services/api-keys.ts:351 has the status check.
      const oauth = await connectClient({
        clientId: dynClientId,
        redirectUri: DYN_REDIRECT,
        request: ["read"],
        cookie: userB.cookie,
      });
      const apiKey = await issueApiKey(userB.cookie, ["read"]);
      const keySession = await openMcpSession(apiKey.key);
      expect((await keySession.call("whoami")).result.isError).toBeFalsy();

      await prisma.user.update({ where: { id: userB.userId }, data: { status: "suspended" } });
      try {
        // OAuth: correctly dead.
        const oauthRes = await app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${oauth.accessToken}`, accept: MCP_ACCEPT, "content-type": "application/json" },
          payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        });
        expect(oauthRes.statusCode).toBe(401);

        // API key: must also be dead. It is not — this is the failing half.
        const fresh = await app.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${apiKey.key}`, accept: MCP_ACCEPT, "content-type": "application/json" },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "v", version: "0" } },
          },
        });
        expect(fresh.statusCode).toBe(401);
      } finally {
        await prisma.user.update({ where: { id: userB.userId }, data: { status: "active" } });
      }
    },
  );

  it(
    "an unverified account must not be able to mint a working API key",
    async () => {
      // v1 gates issue/rotate/revoke behind `requireVerifiedEmail`
      // (databounty-api/src/routes/v1/api-keys.ts:47, :58, :75). Parity mounts
      // them under the plugin-wide `requireAuth` only
      // (routes/v1/me.ts:105, :457), so an account that never verified its
      // email can mint a credential that then executes MCP tools.
      await prisma.user.update({ where: { id: userB.userId }, data: { emailVerifiedAt: null } });
      try {
        const res = await app.inject({
          method: "POST",
          url: "/v1/me/api-keys",
          headers: { cookie: userB.cookie, origin: "http://localhost:3010" },
          payload: { scopes: ["read"] },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await prisma.user.update({ where: { id: userB.userId }, data: { emailVerifiedAt: new Date() } });
      }
    },
  );

  it(
    "rotating a key must terminate the MCP sessions the old secret opened",
    async () => {
      // The session binding is `api-key:${apiKey.id}` (routes/mcp.ts:76) and
      // parity's `rotateApiKey` updates the SAME row in place, keeping the id
      // (services/api-keys.ts:118-129). v1 revokes the old row and creates a
      // NEW one with a new id (databounty-api/src/services/api-keys.ts:148-164),
      // so the pre-rotation session's binding no longer resolves. Rotation
      // exists to terminate the old credential; carrying its live session
      // across the rotation is the one thing it must not do.
      const issued = await issueApiKey(userA.cookie, ["read"]);
      const session = await openMcpSession(issued.key);
      const rotated = await app.inject({
        method: "POST",
        url: `/v1/me/api-keys/${issued.id}/rotate`,
        headers: { cookie: userA.cookie, origin: "http://localhost:3010" },
      });
      expect(rotated.statusCode).toBe(200);
      const newKey = rotated.json().key as string;

      const onOldSession = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${newKey}`,
          accept: MCP_ACCEPT,
          "content-type": "application/json",
          "mcp-session-id": session.sessionId,
        },
        payload: { jsonrpc: "2.0", id: 50, method: "tools/list", params: {} },
      });
      expect(onOldSession.statusCode).toBe(401);
    },
  );

  it("concurrent rotation must yield exactly one usable key", async () => {
    // Parity `rotateApiKey` (services/api-keys.ts:111-129) reads the row, then
    // writes unconditionally: no `updateMany({ revokedAt: null })` guard, no
    // row-count check. Two concurrent rotations both return 201-shaped bodies
    // with different raw keys; last write wins and the loser is handed a
    // secret that never authenticates. v1 guards this with a conditional
    // update and throws when `count !== 1`
    // (databounty-api/src/services/api-keys.ts:148-152).
    const issued = await issueApiKey(userA.cookie, ["read"]);
    const rotate = () =>
      app.inject({ method: "POST", url: `/v1/me/api-keys/${issued.id}/rotate`, headers: { cookie: userA.cookie, origin: "http://localhost:3010" } });
    const [one, two] = await Promise.all([rotate(), rotate()]);

    const succeeded = [one, two].filter((r) => r.statusCode === 200);
    // Either one caller loses, or both keys must work. Neither holds.
    if (succeeded.length === 2) {
      const keys = succeeded.map((r) => r.json().key as string);
      expect(new Set(keys).size).toBe(1);
    } else {
      expect(succeeded).toHaveLength(1);
    }
  });

  it("a dashboard session is refused on the MCP transport, whether presented as a cookie or as a bearer", async () => {
    const asCookie = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { cookie: userA.cookie, accept: MCP_ACCEPT, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(asCookie.statusCode).toBe(401);
    expect(String(asCookie.headers["www-authenticate"])).toContain('error="invalid_token"');

    const sessionToken = userA.cookie.split("=").slice(1).join("=");
    const asBearer = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${sessionToken}`, accept: MCP_ACCEPT, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(asBearer.statusCode).toBe(401);

    // Same on the legacy /mcp/call surface for an authenticated-write tool:
    // a session IS accepted there (it is the dashboard's own surface) but it
    // must not be treated as a scoped MCP credential on /mcp.
    // A real browser always sends `Origin` on a POST fetch, same-origin or
    // not — that is exactly what the CSRF guard on /mcp/call checks.
    const legacy = await app.inject({
      method: "POST",
      url: "/mcp/call",
      headers: { cookie: userA.cookie, origin: "http://localhost:3000" },
      payload: { name: "whoami", arguments: {} },
    });
    expect(legacy.statusCode).toBe(200);
    expect(JSON.parse(legacy.json().content[0].text).id).toBe(userA.userId);
  });

  it("refuses a cookie-authenticated /mcp/call whose Origin is missing or not allow-listed (CSRF guard)", async () => {
    const noOrigin = await app.inject({
      method: "POST",
      url: "/mcp/call",
      headers: { cookie: userA.cookie },
      payload: { name: "whoami", arguments: {} },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json().isError).toBe(true);

    const foreignOrigin = await app.inject({
      method: "POST",
      url: "/mcp/call",
      headers: { cookie: userA.cookie, origin: "https://attacker.example" },
      payload: { name: "whoami", arguments: {} },
    });
    expect(foreignOrigin.statusCode).toBe(403);

    // A Bearer credential is never sent involuntarily by a browser, so the
    // guard does not apply to it — no Origin header needed.
    const apiKey = await issueApiKey(userA.cookie, ["read"]);
    const bearer = await app.inject({
      method: "POST",
      url: "/mcp/call",
      headers: { authorization: `Bearer ${apiKey.key}` },
      payload: { name: "whoami", arguments: {} },
    });
    expect(bearer.statusCode).toBe(200);
  });
});
