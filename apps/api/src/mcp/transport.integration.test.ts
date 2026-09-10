// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted MCP: OAuth 2.1 discovery + authorization code flow + the JSON-RPC
 * streamable-HTTP transport at `/mcp`, driven end to end against the real app
 * and the real database.
 *
 * Self-guards exactly like the other integration tests: refuses to run unless
 * DATABASE_URL points at the disposable databounty_community_parity_verify
 * database.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { tools } from "./tools.js";
import { MCP_SERVER_METADATA } from "./server.js";
import { PUBLIC_SCOPE } from "./core/contract.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function signupVerified(prefix: string) {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const email = `${prefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${prefix}${stamp}`.toLowerCase().slice(0, 20), displayName: prefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date(), onboarded: true } });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

const MCP_ACCEPT = "application/json, text/event-stream";

/** Streamable HTTP may answer with SSE. Pull the single JSON-RPC payload out of
 *  either representation so assertions read the same for both. */
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

describe("MCP discovery documents", () => {
  it("serves RFC 9728 protected-resource metadata naming the resource and its authorization server", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resource).toMatch(/\/mcp$/);
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect(body.authorization_servers.length).toBeGreaterThan(0);
    expect(body.bearer_methods_supported).toContain("header");
    expect(body.scopes_supported).toEqual(expect.arrayContaining(["read", "contribute", "validate", "artifact", "account"]));
  });

  it("serves RFC 8414 authorization-server metadata advertising PKCE S256 and dynamic registration", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server/mcp" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.registration_endpoint).toMatch(/\/mcp\/oauth\/register$/);
    expect(body.token_endpoint).toMatch(/\/mcp\/oauth\/token$/);
    expect(body.revocation_endpoint).toMatch(/\/mcp\/oauth\/revoke$/);
    expect(body.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("serves the /mcp/.well-known/* aliases identically", async () => {
    const canonical = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server/mcp" });
    const alias = await app.inject({ method: "GET", url: "/mcp/.well-known/oauth-authorization-server" });
    expect(alias.statusCode).toBe(200);
    expect(alias.json()).toEqual(canonical.json());
  });

  it("serves the root /.well-known/* fallbacks identically", async () => {
    for (const doc of ["oauth-authorization-server", "oauth-protected-resource"]) {
      const canonical = await app.inject({ method: "GET", url: `/.well-known/${doc}/mcp` });
      const root = await app.inject({ method: "GET", url: `/.well-known/${doc}` });
      expect(root.statusCode).toBe(200);
      expect(root.json()).toEqual(canonical.json());
    }
  });

  it("advertises discovery and OAuth URLs that this server actually serves", async () => {
    // Regression: with MCP_PUBLIC_URL set to the full .../mcp client URL the
    // issuer became .../mcp/mcp and every advertised URL was a 404.
    const challenge = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
    expect(challenge.statusCode).toBe(401);
    const header = String(challenge.headers["www-authenticate"] ?? "");
    const match = /resource_metadata="([^"]+)"/.exec(header);
    expect(match).not.toBeNull();
    const metadataPath = new URL(match?.[1] ?? "").pathname;
    expect(metadataPath).toBe("/.well-known/oauth-protected-resource/mcp");
    const prm = await app.inject({ method: "GET", url: metadataPath });
    expect(prm.statusCode).toBe(200);
    expect(new URL(prm.json().resource).pathname).toBe("/mcp");
    const asm = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server/mcp" });
    for (const key of ["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) {
      expect(new URL(asm.json()[key]).pathname.startsWith("/mcp/mcp")).toBe(false);
    }
    expect(new URL(asm.json().issuer).pathname).toBe("/mcp");
  });
});

describe("MCP transport authentication", () => {
  it("rejects an unauthenticated JSON-RPC tool call with 401 and an OAuth challenge", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: MCP_ACCEPT, "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "whoami", arguments: {} },
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
    const challenge = res.headers["www-authenticate"] as string;
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain('error="invalid_token"');
  });

  it("rejects an unauthenticated initialize the same way — no session is issued without a credential", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: MCP_ACCEPT, "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("rejects a bearer token that is neither an API key nor a live MCP access token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: MCP_ACCEPT, "content-type": "application/json", authorization: "Bearer db_mcp_at_not_a_real_token" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("MCP tool scope contract", () => {
  it("keeps `public` a genuinely tiny scope — nothing that reads a user row or writes is public", () => {
    const publicTools = tools.filter((t) => t.scope === PUBLIC_SCOPE).map((t) => t.name).sort();
    expect(publicTools).toEqual(
      [
        "get_pool",
        "get_community_stats",
        "get_file_upload_limits",
        "list_community_pools",
        "list_dataset_categories",
      ].sort(),
    );
  });

  it("no longer lets a `read`-scoped tool run with no credential over the legacy /mcp/call surface", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp/call",
      payload: { name: "check_submission", arguments: { submissionId: "does-not-matter" } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().isError).toBe(true);
  });

  it("refuses report_issue without a credential — it is an authenticated write, not a public one", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp/call",
      payload: {
        name: "report_issue",
        arguments: { category: "mcp", impact: "degraded", summary: "anon write", expected: "refused", actual: "refused" },
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().isError).toBe(true);
  });
});

describe("MCP OAuth 2.1 authorization code flow", () => {
  it("registers a client, issues a code against PKCE, exchanges it, and serves tools/list over the transport", async () => {
    const redirectUri = "http://127.0.0.1:41234/callback";
    const registered = await app.inject({
      method: "POST",
      url: "/mcp/oauth/register",
      payload: { redirect_uris: [redirectUri], client_name: "vitest-client", token_endpoint_auth_method: "none" },
    });
    expect(registered.statusCode).toBe(201);
    const clientId = registered.json().client_id as string;
    expect(clientId).toMatch(/^db_mcp_client_/);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const authorize = await app.inject({
      method: "GET",
      url: "/mcp/oauth/authorize",
      query: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "read contribute",
      },
    });
    expect(authorize.statusCode).toBe(302);
    const requestId = new URL(authorize.headers.location as string).searchParams.get("request_id");
    expect(requestId).toBeTruthy();

    // Consent is dashboard-session gated: no cookie, no approval.
    const anonApprove = await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/approve`, payload: {} });
    expect(anonApprove.statusCode).toBe(401);

    const { cookie, userId } = await signupVerified("mcpoauth");
    const approved = await app.inject({
      method: "POST",
      url: `/mcp/oauth/request/${requestId}/approve`,
      headers: { cookie, origin: "http://localhost:3000" },
      payload: { scopes: ["read"] },
    });
    expect(approved.statusCode).toBe(200);
    const code = approved.json().code as string;
    expect(code).toMatch(/^db_mcp_code_/);

    // Wrong verifier must not exchange.
    const badExchange = await app.inject({
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: randomBytes(32).toString("base64url"),
        redirect_uri: redirectUri,
      }).toString(),
    });
    expect(badExchange.statusCode).toBe(400);
    expect(badExchange.json().error).toBe("invalid_grant");

    const exchanged = await app.inject({
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
    });
    expect(exchanged.statusCode).toBe(200);
    const tokenBody = exchanged.json();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.access_token).toMatch(/^db_mcp_at_/);
    expect(tokenBody.refresh_token).toMatch(/^db_mcp_rt_/);
    // Only the scope the user actually approved, not the two requested.
    expect(tokenBody.scope).toBe("read");
    const accessToken = tokenBody.access_token as string;

    // A replayed code is NOT exercised here — since OAuth 2.1 §4.1.3/§7.5.3,
    // it now revokes the tokens the code minted
    // (`revokeTokensFromAuthorizationCode`), which would end this sequence
    // (initialize/tools-list/whoami/submit/revoke) early. Single-use
    // rejection AND the revocation side effect both have their own dedicated
    // test below, with their own code/token pair.

    // Now speak MCP with it: initialize, then tools/list.
    const auth = { authorization: `Bearer ${accessToken}`, accept: MCP_ACCEPT, "content-type": "application/json" };
    const init = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: auth,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
      },
    });
    expect(init.statusCode).toBe(200);
    const sessionId = init.headers["mcp-session-id"] as string;
    expect(sessionId).toBeTruthy();
    const initBody = jsonRpcBody(init.payload);
    expect(initBody.result.serverInfo.name).toBe("DataBounty Community MCP");
    expect(MCP_SERVER_METADATA.description).toMatch(/supported dataset types/i);
    expect(initBody.result.capabilities.tools).toBeDefined();

    await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...auth, "mcp-session-id": sessionId },
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });

    const list = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...auth, "mcp-session-id": sessionId },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(list.statusCode).toBe(200);
    const listed = jsonRpcBody(list.payload).result.tools as { name: string }[];
    expect(listed.length).toBe(tools.length);
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(["whoami", "list_community_pools", "submit_pool_items"]));

    // A `read`-scoped tool works with this credential…
    const whoami = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...auth, "mcp-session-id": sessionId },
      payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } },
    });
    expect(whoami.statusCode).toBe(200);
    const whoamiResult = jsonRpcBody(whoami.payload).result;
    expect(whoamiResult.isError).toBeFalsy();
    expect(JSON.parse(whoamiResult.content[0].text).id).toBe(userId);

    // …and a `contribute` tool does NOT, because the user approved only `read`.
    const submit = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...auth, "mcp-session-id": sessionId },
      payload: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "submit_pool_items", arguments: { bountyId: "x", items: [] } },
      },
    });
    const submitResult = jsonRpcBody(submit.payload).result;
    expect(submitResult.isError).toBe(true);
    expect(submitResult.content[0].text).toMatch(/missing the required scope: contribute/i);

    // The tool-call audit trail is real, not aspirational. Writes are
    // fire-and-forget by design (auditing must never block or fail a tool
    // call), so poll briefly rather than racing the flush.
    let audited: unknown[] = [];
    for (let i = 0; i < 20 && audited.length < 2; i++) {
      audited = await prisma.oAuthAuditEvent.findMany({ where: { userId, action: "tool.invoked" } });
      if (audited.length < 2) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(audited.length).toBeGreaterThanOrEqual(2);

    // Revocation is immediate — no cache window.
    const revoked = await app.inject({
      method: "POST",
      url: "/mcp/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: accessToken }).toString(),
    });
    expect(revoked.statusCode).toBe(200);
    const afterRevoke = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...auth, "mcp-session-id": sessionId },
      payload: { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });
});

/**
 * Modern (2026-07-28) era: stateless, one `_meta` envelope per request, no
 * `initialize` handshake and no `Mcp-Session-Id`. Served at the same `/mcp`
 * URL as the sessionful era above; `handleMcpByEra` tells them apart.
 */
const MODERN_PROTOCOL_VERSION = "2026-07-28";

function modernEnvelope(extra: Record<string, unknown> = {}) {
  return {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "vitest-modern", version: "0" },
    },
    ...extra,
  };
}

/** SEP-2243 standard headers. A modern `tools/call` MUST also carry `Mcp-Name`
 *  mirroring `params.name`; the entry rejects the request with 400 otherwise. */
function modernHeaders(method: string, authorization?: string, name?: string) {
  return {
    ...(authorization ? { authorization } : {}),
    accept: MCP_ACCEPT,
    "content-type": "application/json",
    "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  };
}

describe("MCP modern (2026-07-28) stateless era", () => {
  it("rejects an unauthenticated modern request with 401 and an OAuth challenge, never a protocol error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: modernHeaders("server/discover"),
      payload: { jsonrpc: "2.0", id: 1, method: "server/discover", params: modernEnvelope() },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
    const challenge = res.headers["www-authenticate"] as string;
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain('error="invalid_token"');
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("answers server/discover and tools/list for an API-key principal without any session handshake", async () => {
    const { cookie, userId } = await signupVerified("mcpmodern");
    const issued = await app.inject({
      method: "POST",
      url: "/v1/me/api-keys",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { scopes: ["read"] },
    });
    expect(issued.statusCode).toBe(201);
    const apiKey = issued.json().key as string;
    expect(apiKey).toBeTruthy();
    const authorization = `Bearer ${apiKey}`;

    const discover = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: modernHeaders("server/discover", authorization),
      payload: { jsonrpc: "2.0", id: 1, method: "server/discover", params: modernEnvelope() },
    });
    expect(discover.statusCode).toBe(200);
    // Stateless: no session is minted for the modern era.
    expect(discover.headers["mcp-session-id"]).toBeUndefined();
    const discovered = jsonRpcBody(discover.payload);
    expect(discovered.id).toBe(1);
    expect(discovered.error).toBeUndefined();
    expect(discovered.result.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
    expect(discovered.result.capabilities.tools).toBeDefined();
    expect(discovered.result.instructions).toMatch(/DataBounty Community/);
    expect(discovered.result.instructions).toMatch(/nothing to claim or bid on/i);
    expect(discovered.result.instructions).toMatch(/no paid, wallet, funding, or bidding workflow/i);
    expect(discovered.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("DataBounty Community MCP");

    const list = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: modernHeaders("tools/list", authorization),
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: modernEnvelope() },
    });
    expect(list.statusCode).toBe(200);
    const listed = jsonRpcBody(list.payload).result.tools as { name: string; inputSchema: { type: string } }[];
    expect(listed.length).toBe(tools.length);
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(["whoami", "list_community_pools", "submit_pool_items"]));
    // The Zod v3 catalog schemas survive the JSON Schema conversion as object schemas.
    expect(listed.every((t) => t.inputSchema.type === "object")).toBe(true);

    // Same tool handler, same identity: a `read`-scoped call runs as the key's owner…
    const whoami = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: modernHeaders("tools/call", authorization, "whoami"),
      payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: modernEnvelope({ name: "whoami", arguments: {} }) },
    });
    expect(whoami.statusCode).toBe(200);
    const whoamiResult = jsonRpcBody(whoami.payload).result;
    expect(whoamiResult.isError).toBeFalsy();
    expect(JSON.parse(whoamiResult.content[0].text).id).toBe(userId);

    // …and the same scope gate refuses a `contribute` tool for a `read`-only key.
    const submit = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: modernHeaders("tools/call", authorization, "submit_pool_items"),
      payload: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: modernEnvelope({ name: "submit_pool_items", arguments: { bountyId: "x", items: [] } }),
      },
    });
    const submitResult = jsonRpcBody(submit.payload).result;
    expect(submitResult.isError).toBe(true);
    expect(submitResult.content[0].text).toMatch(/missing the required scope: contribute/i);
  });

  it("still routes a legacy initialize to the sessionful era at the same URL", async () => {
    const { cookie } = await signupVerified("mcplegacy");
    const issued = await app.inject({
      method: "POST",
      url: "/v1/me/api-keys",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { scopes: ["read"] },
    });
    expect(issued.statusCode).toBe(201);
    const init = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${issued.json().key}`, accept: MCP_ACCEPT, "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
      },
    });
    expect(init.statusCode).toBe(200);
    expect(init.headers["mcp-session-id"]).toBeTruthy();
    expect(jsonRpcBody(init.payload).result.serverInfo.name).toBe("DataBounty Community MCP");
  });
});
