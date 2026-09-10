// SPDX-License-Identifier: Apache-2.0

/**
 * Every MCP OAuth ERROR path, driven end to end through the real Fastify app
 * and the real local Postgres database. Nothing here is stubbed: no fetch
 * seam, no fake clock, no mocked Prisma. Self-guards like the other
 * integration tests — refuses to run unless DATABASE_URL names a disposable
 * local database.
 *
 * The happy paths live in `src/mcp/transport.integration.test.ts` and the
 * Client-ID-Metadata-Document paths in `src/routes/mcp-cimd.integration.test.ts`.
 * This file is deliberately only about refusals, and asserts what the relevant
 * specification REQUIRES rather than what the code currently returns:
 *
 *   - RFC 7591 §3.2.2  dynamic client registration error codes
 *   - RFC 6749 §4.1.2.1 authorization endpoint error codes / no-redirect rule
 *   - RFC 6749 §5.2     token endpoint status codes and error codes
 *   - RFC 7009 §2.2     revocation is a 200 even for an unknown token
 *   - RFC 8707 §2       resource indicators (`invalid_target`, no fragment)
 *   - RFC 9207 §2.4     `iss` on every authorization error redirect
 *   - MCP authorization 2025-11-25 — 401 for an invalid/expired token, with a
 *     `WWW-Authenticate: Bearer resource_metadata="…"` challenge, and a
 *     `scope` hint; 403 + `error="insufficient_scope"` at runtime.
 *
 * Where the implementation disagrees with the specification the assertion is
 * left as written and the test FAILS. Each such test carries a `SPEC GAP`
 * comment naming the file, the line and the specification clause, so the
 * failure is a report rather than a mystery. Nothing here is `it.skip`/
 * `it.fails`-ed to make the suite green.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
/** The RFC 8707 audience this server issues credentials for, read from its own
 *  RFC 9728 document rather than reconstructed from env. */
let canonicalResource: string;
/** The RFC 9728 metadata URL this server advertises in WWW-Authenticate. */
let resourceMetadataUrl: string;
/** The RFC 9207 issuer this server stamps on authorization responses. */
let issuer: string;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

/**
 * One signed-in account reused for every consent approval. Signing up per test
 * is what this suite did first, and the sheer request count tripped the app's
 * own global per-IP rate limiter (`ratelimit.global.max`, read once at boot in
 * `src/app.ts`) — every later test then failed on a 429 from `/v1/auth/signup`
 * rather than on the OAuth behaviour under test. Tests that need to mutate an
 * account (suspension, cross-user ownership) still ask for a fresh one.
 */
let shared: { userId: string; cookie: string };

const LOOPBACK = "http://127.0.0.1:41999/callback";
const MCP_ACCEPT = "application/json, text/event-stream";
const PAST = new Date(Date.now() - 60_000);

beforeAll(async () => {
  // Raise the boot-time global rate limit for this suite only. This is an
  // error-surface suite: it deliberately makes several hundred requests from
  // one IP, which the production default (300/min) is right to refuse. Set
  // BEFORE buildApp, because app.ts reads the setting once at boot.
  process.env.RATELIMIT_GLOBAL_MAX = "100000";

  app = await buildApp();
  await app.ready();

  const prm = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" });
  expect(prm.statusCode).toBe(200);
  canonicalResource = prm.json().resource as string;
  const asm = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server/mcp" });
  expect(asm.statusCode).toBe(200);
  issuer = asm.json().issuer as string;

  const challenge = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
  resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(String(challenge.headers["www-authenticate"] ?? ""))?.[1] ?? "";
  expect(resourceMetadataUrl).toBeTruthy();

  shared = await signupVerified("oaerrshared");
});

afterAll(async () => {
  // Clients cascade to their authorization requests, codes and tokens; users
  // cascade to theirs. Audit events null out their FKs rather than blocking.
  for (const clientId of createdClientIds) {
    await prisma.oAuthClient.deleteMany({ where: { clientId } });
  }
  for (const id of createdUserIds) {
    await prisma.user.deleteMany({ where: { id } });
  }
  delete process.env.RATELIMIT_GLOBAL_MAX;
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
  createdUserIds.push(userId);
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date(), onboarded: true } });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function register(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/mcp/oauth/register", payload: body });
}

/** A real dynamically-registered public client, tracked for cleanup. */
async function registerClient(redirectUris: string[] = [LOOPBACK]): Promise<string> {
  const res = await register({ redirect_uris: redirectUris, client_name: "Errors Suite Client" });
  expect(res.statusCode).toBe(201);
  const clientId = res.json().client_id as string;
  createdClientIds.push(clientId);
  return clientId;
}

function authorize(query: Record<string, string | undefined>) {
  return app.inject({
    method: "GET",
    url: "/mcp/oauth/authorize",
    query: Object.fromEntries(Object.entries(query).filter((e): e is [string, string] => typeof e[1] === "string")),
  });
}

function form(fields: Record<string, string>) {
  return {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  };
}

function tokenRequest(fields: Record<string, string>) {
  return app.inject({ method: "POST", url: "/mcp/oauth/token", ...form(fields) });
}

/** Full authorization-code flow up to (but not including) the exchange. */
async function approvedCode(options: { scope?: string; approve?: string[]; redirectUri?: string; freshUser?: boolean } = {}) {
  const clientId = await registerClient([options.redirectUri ?? LOOPBACK]);
  const { verifier, challenge } = pkce();
  const auth = await authorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: options.redirectUri ?? LOOPBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: options.scope ?? "read contribute",
    resource: canonicalResource,
  });
  expect(auth.statusCode).toBe(302);
  const requestId = new URL(auth.headers.location as string).searchParams.get("request_id")!;
  const { cookie, userId } = options.freshUser ? await signupVerified("oaerr") : shared;
  const approved = await app.inject({
    method: "POST",
    url: `/mcp/oauth/request/${requestId}/approve`,
    headers: { cookie, origin: "http://localhost:3000" },
    payload: options.approve ? { scopes: options.approve } : {},
  });
  expect(approved.statusCode).toBe(200);
  return { clientId, verifier, code: approved.json().code as string, cookie, userId, requestId };
}

/** A live access token plus its refresh token, minted through the real flow. */
async function mintTokens(scope = "read", options: { freshUser?: boolean } = {}) {
  const { clientId, verifier, code, userId, cookie } = await approvedCode({ scope, approve: scope.split(" "), freshUser: options.freshUser });
  const res = await tokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: LOOPBACK,
    resource: canonicalResource,
  });
  expect(res.statusCode).toBe(200);
  return {
    clientId,
    userId,
    cookie,
    accessToken: res.json().access_token as string,
    refreshToken: res.json().refresh_token as string,
  };
}

function mcpCall(headers: Record<string, string>, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/mcp", headers: { accept: MCP_ACCEPT, "content-type": "application/json", ...headers }, payload });
}

function jsonRpcBody(payload: string): any {
  const trimmed = payload.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = payload.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`No JSON-RPC payload in response: ${payload.slice(0, 200)}`);
  return JSON.parse(dataLine.slice("data:".length).trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /mcp/oauth/register — RFC 7591 §3.2.2
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /mcp/oauth/register — RFC 7591 rejections", () => {
  /** Every rejection must be a 400 that persists NOTHING. */
  async function expectRejected(body: Record<string, unknown>): Promise<{ error: string; description: string }> {
    const res = await register(body);
    expect(res.statusCode).toBe(400);
    expect(res.headers["cache-control"]).toBe("no-store");
    // No credential is handed back. The stronger "no row was written" claim is
    // asserted once, in the test below, against a suite-unique client_name — a
    // global `oAuthClient.count()` here was polluted by any other suite
    // registering a client in parallel against the same disposable database,
    // and failed registrations that had in fact been rejected correctly.
    expect(res.json()).not.toHaveProperty("client_id");
    return { error: res.json().error as string, description: String(res.json().error_description ?? "") };
  }

  it("writes no oauth_clients row for a rejected registration", async () => {
    const uniqueName = `Rejected Registration ${randomBytes(6).toString("hex")}`;
    await expectRejected({ redirect_uris: ["http://evil.example/callback"], client_name: uniqueName });
    expect(await prisma.oAuthClient.count({ where: { clientName: uniqueName } })).toBe(0);
  });

  it("rejects a body with no redirect_uris at all", async () => {
    expect((await expectRejected({ client_name: "No Redirects" })).error).toBeTruthy();
  });

  it("rejects an empty redirect_uris array", async () => {
    expect((await expectRejected({ redirect_uris: [] })).error).toBeTruthy();
  });

  it("rejects redirect_uris whose entries are not strings", async () => {
    // The route filters non-strings out, so `[1, 2]` degrades to `[]`.
    expect((await expectRejected({ redirect_uris: [1, 2, { uri: "x" }] })).error).toBeTruthy();
  });

  it("rejects a non-loopback plain-http redirect_uri", async () => {
    await expectRejected({ redirect_uris: ["http://evil.example/callback"] });
  });

  it("rejects a non-http(s) scheme", async () => {
    for (const uri of ["javascript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "myapp://cb"]) {
      await expectRejected({ redirect_uris: [uri] });
    }
  });

  it("rejects an unparseable redirect_uri", async () => {
    await expectRejected({ redirect_uris: ["not a uri at all"] });
  });

  it("rejects a redirect_uri carrying a fragment", async () => {
    await expectRejected({ redirect_uris: ["https://client.example/cb#frag"] });
  });

  it("rejects a redirect_uri carrying embedded userinfo (phishing / open-redirect shape)", async () => {
    // Not present in v1's isSafeRedirectUri — parity hardening.
    await expectRejected({ redirect_uris: ["https://trusted-looking@evil.example/cb"] });
    await expectRejected({ redirect_uris: ["https://user:pass@client.example/cb"] });
  });

  it("rejects an oversized redirect_uri (2048-character cap)", async () => {
    const long = `https://client.example/cb?x=${"a".repeat(2100)}`;
    expect(long.length).toBeGreaterThan(2048);
    await expectRejected({ redirect_uris: [long] });
  });

  it("rejects more than 20 redirect_uris", async () => {
    await expectRejected({ redirect_uris: Array.from({ length: 21 }, (_, i) => `https://client.example/cb${i}`) });
  });

  it("rejects a reserved client_name and names the reserved terms", async () => {
    for (const name of ["DataBounty Official Client", "databounty helper", "The OFFICIAL agent"]) {
      const { error, description } = await expectRejected({ redirect_uris: [LOOPBACK], client_name: name });
      expect(error).toBe("invalid_client_metadata");
      expect(description).toMatch(/reserved terms/i);
    }
  });

  it("intersects grant_types with what it issues, and rejects only a registration with no usable grant", async () => {
    // A client's grant_types describes what it can do everywhere, not what it
    // demands of us. VS Code's registration body lists device_code alongside
    // the two we serve, so rejecting the whole registration over an extra
    // entry locked it out. RFC 7591 §3.2.1 lets the server register its own
    // values and report them back, which is what the response asserts here.
    for (const grants of [["client_credentials"], ["implicit"], ["refresh_token"]]) {
      expect((await expectRejected({ redirect_uris: [LOOPBACK], grant_types: grants })).error).toBe("invalid_client_metadata");
    }
    for (const grants of [
      ["authorization_code", "password"],
      ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
    ]) {
      const res = await register({ redirect_uris: [LOOPBACK], client_name: "Extra Grants Client", grant_types: grants });
      expect(res.statusCode).toBe(201);
      createdClientIds.push(res.json().client_id);
      expect(res.json().grant_types).toEqual(grants.filter((g) => g === "authorization_code" || g === "refresh_token"));
    }
  });

  it("rejects a token_endpoint_auth_method other than none with invalid_client_metadata", async () => {
    for (const method of ["client_secret_basic", "client_secret_post", "private_key_jwt", "tls_client_auth"]) {
      const { error, description } = await expectRejected({ redirect_uris: [LOOPBACK], client_name: "Confidential", token_endpoint_auth_method: method });
      expect(error).toBe("invalid_client_metadata");
      expect(description).toMatch(/PKCE/i);
    }
  });

  it("registers a valid public client and echoes only public-client metadata", async () => {
    const res = await register({ redirect_uris: [LOOPBACK, "https://client.example/cb"], client_name: "Good Client" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    createdClientIds.push(body.client_id);
    expect(body.client_id).toMatch(/^db_mcp_client_/);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body).not.toHaveProperty("client_secret");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("truncates an oversized client_name instead of failing (metadata substitution, RFC 7591 §3.2.1)", async () => {
    const res = await register({ redirect_uris: [LOOPBACK], client_name: "N".repeat(5000) });
    expect(res.statusCode).toBe(201);
    createdClientIds.push(res.json().client_id);
    expect((res.json().client_name as string).length).toBe(200);
  });

  it("SPEC GAP — a redirect_uri problem must be reported as invalid_redirect_uri, not invalid_client_metadata", async () => {
    // RFC 7591 §3.2.2 defines a dedicated code: "invalid_redirect_uri — The
    // value of one or more redirection URIs is invalid." A generic
    // invalid_client_metadata gives a client no way to tell a bad redirect URI
    // (fixable by re-registering with a different URI) apart from an
    // unsupported grant type or auth method.
    // src/services/mcp-oauth.ts:266 throws invalid_client_metadata for the
    // redirect_uris branch. Same in v1 (databounty-api mcp-oauth.ts:247), so
    // this is inherited, not introduced.
    const res = await register({ redirect_uris: ["http://evil.example/callback"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_redirect_uri");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /mcp/oauth/authorize — RFC 6749 §4.1.2.1, RFC 8707, RFC 9207
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /mcp/oauth/authorize — client and redirect_uri errors are JSON, never a redirect", () => {
  it("rejects a missing client_id with a JSON 400 and no Location header", async () => {
    const { challenge } = pkce();
    const res = await authorize({ response_type: "code", redirect_uri: LOOPBACK, code_challenge: challenge, code_challenge_method: "S256" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(res.headers.location).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("rejects an unknown client_id with a JSON 401 invalid_client and no Location header", async () => {
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: "db_mcp_client_definitely_not_registered",
      redirect_uri: LOOPBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
    expect(res.headers.location).toBeUndefined();
  });

  it("rejects a missing redirect_uri with a JSON 400", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await authorize({ response_type: "code", client_id: clientId, code_challenge: challenge, code_challenge_method: "S256" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(res.headers.location).toBeUndefined();
  });

  it("never redirects to an UNREGISTERED redirect_uri, even for a known client (RFC 6749 §4.1.2.1)", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://attacker.example/steal",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(res.headers.location).toBeUndefined();
  });

  it("does not leak an authorization request row for a rejected authorize call", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://attacker.example/steal",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(await prisma.oAuthAuthorizationRequest.count({ where: { clientId } })).toBe(0);
  });
});

describe("GET /mcp/oauth/authorize — post-validation errors redirect with error, state and iss", () => {
  /** Client and redirect_uri are both valid here, so RFC 6749 §4.1.2.1
   *  requires the error to be delivered to the redirect_uri. */
  async function expectErrorRedirect(query: Record<string, string | undefined>, expected: string) {
    const clientId = query.client_id ?? (await registerClient());
    const res = await authorize({ client_id: clientId, redirect_uri: LOOPBACK, state: "st-42", ...query });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(LOOPBACK);
    expect(location.searchParams.get("error")).toBe(expected);
    expect(location.searchParams.get("state")).toBe("st-42");
    // RFC 9207 §2.4: the issuer identifier on every authorization response.
    expect(location.searchParams.get("iss")).toBe(issuer);
    return location;
  }

  it("redirects invalid_request for a missing code_challenge", async () => {
    await expectErrorRedirect({ response_type: "code", code_challenge_method: "S256" }, "invalid_request");
  });

  it("redirects invalid_request for a malformed code_challenge (too short, illegal characters)", async () => {
    await expectErrorRedirect({ response_type: "code", code_challenge: "tooshort", code_challenge_method: "S256" }, "invalid_request");
    await expectErrorRedirect({ response_type: "code", code_challenge: `${"a".repeat(40)}+/=`, code_challenge_method: "S256" }, "invalid_request");
    await expectErrorRedirect({ response_type: "code", code_challenge: "a".repeat(200), code_challenge_method: "S256" }, "invalid_request");
  });

  it("redirects invalid_request for code_challenge_method=plain or a missing method (OAuth 2.1 requires S256)", async () => {
    const { challenge } = pkce();
    await expectErrorRedirect({ response_type: "code", code_challenge: challenge, code_challenge_method: "plain" }, "invalid_request");
    await expectErrorRedirect({ response_type: "code", code_challenge: challenge }, "invalid_request");
  });

  it("redirects invalid_scope for an unknown scope", async () => {
    const { challenge } = pkce();
    await expectErrorRedirect(
      { response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "read superuser" },
      "invalid_scope",
    );
  });

  it("redirects invalid_target for a resource that is not this MCP server (RFC 8707 §2)", async () => {
    const { challenge } = pkce();
    await expectErrorRedirect(
      { response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: "https://not-this-server.example/mcp" },
      "invalid_target",
    );
  });

  it("redirects invalid_target for a resource carrying a fragment or an unparseable resource (RFC 8707 §2)", async () => {
    const { challenge } = pkce();
    await expectErrorRedirect(
      { response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: `${canonicalResource}#frag` },
      "invalid_target",
    );
    await expectErrorRedirect(
      { response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: "definitely-not-a-uri" },
      "invalid_target",
    );
  });

  it("omits state from the error redirect when the client sent none", async () => {
    const clientId = await registerClient();
    const res = await authorize({ response_type: "code", client_id: clientId, redirect_uri: LOOPBACK, code_challenge: "tooshort", code_challenge_method: "S256" });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.has("state")).toBe(false);
    expect(location.searchParams.get("iss")).toBe(issuer);
  });

  it("accepts an omitted resource as this server's only resource (older clients), and still consents", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await authorize({ response_type: "code", client_id: clientId, redirect_uri: LOOPBACK, code_challenge: challenge, code_challenge_method: "S256" });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get("request_id")).toBeTruthy();
  });

  it("SPEC GAP — response_type other than code must be unsupported_response_type, not invalid_request", async () => {
    // RFC 6749 §4.1.2.1: "unsupported_response_type — The authorization server
    // does not support obtaining an authorization code using this method."
    // src/routes/mcp.ts:360-364 folds response_type, client_id, redirect_uri,
    // code_challenge and code_challenge_method into one invalid_request throw,
    // so a client asking for the implicit flow is told its request is
    // malformed instead of that the response type is unsupported. Same in v1
    // (databounty-api routes/mcp.ts:329-340).
    const { challenge } = pkce();
    await expectErrorRedirect({ response_type: "token", code_challenge: challenge, code_challenge_method: "S256" }, "unsupported_response_type");
  });

  it("SPEC GAP — an error must redirect to a loopback redirect_uri that differs only in port (RFC 8252 §7.3)", async () => {
    // `redirectMatches` (src/services/mcp-oauth.ts:218) deliberately treats a
    // loopback port as variable, and the happy path relies on that. But the
    // error path uses `isRegisteredRedirectSafe` (src/routes/mcp.ts:133-142),
    // which compares with `registered === uri` — exact string equality. So a
    // client that registers http://127.0.0.1:41999/callback and listens on an
    // ephemeral port gets a JSON 400 instead of the RFC 6749 §4.1.2.1 error
    // redirect it is entitled to, and never learns why its authorization
    // failed. Fail-safe, but the client-visible contract is wrong. Same in v1
    // (databounty-api routes/mcp.ts:464-472).
    const clientId = await registerClient(["http://127.0.0.1:41999/callback"]);
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:52525/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "not-a-scope",
      state: "st-9",
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /mcp/oauth/request/:id and the approve / deny endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe("consent endpoints — session gating and request lifecycle", () => {
  async function pendingRequest() {
    const clientId = await registerClient();
    const { challenge, verifier } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: LOOPBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "read contribute",
    });
    expect(res.statusCode).toBe(302);
    return { clientId, verifier, requestId: new URL(res.headers.location as string).searchParams.get("request_id")! };
  }

  it("refuses an unauthenticated read, approve and deny with 401 login_required", async () => {
    const { requestId } = await pendingRequest();
    const unauthenticated = [
      await app.inject({ method: "GET", url: `/mcp/oauth/request/${requestId}` }),
      await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/approve`, payload: {} }),
      await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/deny`, payload: {} }),
    ];
    for (const res of unauthenticated) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("login_required");
    }
    // Nothing was decided.
    const row = await prisma.oAuthAuthorizationRequest.findUnique({ where: { id: requestId } });
    expect(row?.approvedAt).toBeNull();
    expect(row?.deniedAt).toBeNull();
  });

  it("refuses a cookie-authenticated approve/deny whose Origin is missing or not allow-listed (CSRF guard), and approve never falls back to the full scope set for a forged body", async () => {
    // /approve falls back to the CLIENT'S FULL REQUESTED SCOPE SET whenever
    // `body.scopes` is absent — and Fastify's default text/plain parser
    // accepts a cross-site POST with no preflight, so a forged request with
    // no scopes at all would otherwise approve everything the client asked
    // for. sameSite=lax blocks this by default; COOKIE_SAMESITE=none, which
    // a split-origin deployment needs, would not.
    const { cookie } = shared;
    const { requestId: r1 } = await pendingRequest();
    const noOrigin = await app.inject({ method: "POST", url: `/mcp/oauth/request/${r1}/approve`, headers: { cookie }, payload: {} });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json().error).toBe("origin_not_allowed");

    const { requestId: r2 } = await pendingRequest();
    const foreignOrigin = await app.inject({
      method: "POST",
      url: `/mcp/oauth/request/${r2}/approve`,
      headers: { cookie, origin: "https://attacker.example" },
      payload: {},
    });
    expect(foreignOrigin.statusCode).toBe(403);

    const { requestId: r3 } = await pendingRequest();
    const deny = await app.inject({ method: "POST", url: `/mcp/oauth/request/${r3}/deny`, headers: { cookie } });
    expect(deny.statusCode).toBe(403);

    // Nothing was decided by any of the three forged attempts.
    for (const id of [r1, r2, r3]) {
      const row = await prisma.oAuthAuthorizationRequest.findUnique({ where: { id } });
      expect(row?.approvedAt).toBeNull();
      expect(row?.deniedAt).toBeNull();
    }

    // A real same-origin approve, with a non-object (forged text/plain-style)
    // body, is rejected as invalid_request rather than silently approving
    // the full requested scope set.
    const { requestId: r4 } = await pendingRequest();
    const nonObjectBody = await app.inject({
      method: "POST",
      url: `/mcp/oauth/request/${r4}/approve`,
      headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
      payload: JSON.stringify("not an object") as unknown as Record<string, unknown>,
    });
    expect(nonObjectBody.statusCode).toBe(400);
    expect(nonObjectBody.json().error).toBe("invalid_request");
    const row4 = await prisma.oAuthAuthorizationRequest.findUnique({ where: { id: r4 } });
    expect(row4?.approvedAt).toBeNull();
  });

  it("reports an unknown request id as invalid_request with reason not_found", async () => {
    const { cookie } = shared;
    const res = await app.inject({ method: "GET", url: `/mcp/oauth/request/${randomBytes(16).toString("hex")}`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(res.json().reason).toBe("not_found");
  });

  it("answers a missing request id with a 4xx, never a 500", async () => {
    const { cookie } = shared;
    const res = await app.inject({ method: "GET", url: "/mcp/oauth/request/", headers: { cookie } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("reports an expired request with reason expired and refuses to approve it", async () => {
    const { requestId } = await pendingRequest();
    const { cookie } = shared;
    await prisma.oAuthAuthorizationRequest.update({ where: { id: requestId }, data: { expiresAt: PAST } });

    const read = await app.inject({ method: "GET", url: `/mcp/oauth/request/${requestId}`, headers: { cookie } });
    expect(read.statusCode).toBe(400);
    expect(read.json().reason).toBe("expired");

    const approve = await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/approve`, headers: { cookie, origin: "http://localhost:3000" }, payload: {} });
    expect(approve.statusCode).toBe(400);
    expect(approve.json().reason).toBe("expired");
    expect(await prisma.oAuthAuthorizationCode.count({ where: { clientId: (await prisma.oAuthAuthorizationRequest.findUnique({ where: { id: requestId } }))!.clientId } })).toBe(0);
  });

  it("reports an already-approved request as already_completed, and a second approve mints no second code", async () => {
    const { requestId, clientId } = await pendingRequest();
    const { cookie } = shared;
    const first = await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/approve`, headers: { cookie, origin: "http://localhost:3000" }, payload: { scopes: ["read"] } });
    expect(first.statusCode).toBe(200);

    const read = await app.inject({ method: "GET", url: `/mcp/oauth/request/${requestId}`, headers: { cookie } });
    expect(read.statusCode).toBe(400);
    expect(read.json().reason).toBe("already_completed");

    const second = await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/approve`, headers: { cookie, origin: "http://localhost:3000" }, payload: { scopes: ["read"] } });
    expect(second.statusCode).toBe(400);
    expect(second.json().reason).toBe("already_completed");
    expect(await prisma.oAuthAuthorizationCode.count({ where: { clientId } })).toBe(1);
  });

  it("reports an already-denied request as already_completed and mints no code", async () => {
    const { requestId, clientId } = await pendingRequest();
    const { cookie } = shared;
    expect((await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/deny`, headers: { cookie, origin: "http://localhost:3000" }, payload: {} })).statusCode).toBe(200);

    const approve = await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/approve`, headers: { cookie, origin: "http://localhost:3000" }, payload: { scopes: ["read"] } });
    expect(approve.statusCode).toBe(400);
    expect(approve.json().reason).toBe("already_completed");
    expect(await prisma.oAuthAuthorizationCode.count({ where: { clientId } })).toBe(0);
  });

  it("refuses to deny a request that already belongs to another account (403 access_denied)", async () => {
    const { requestId } = await pendingRequest();
    const owner = await signupVerified("oaerrown");
    const other = await signupVerified("oaerroth");
    await prisma.oAuthAuthorizationRequest.update({ where: { id: requestId }, data: { userId: owner.userId } });

    const res = await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/deny`, headers: { cookie: other.cookie, origin: "http://localhost:3000" }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("access_denied");
    expect((await prisma.oAuthAuthorizationRequest.findUnique({ where: { id: requestId } }))?.deniedAt).toBeNull();
  });

  it("rejects an approve carrying a scope the client never requested", async () => {
    const { requestId, clientId } = await pendingRequest();
    const { cookie } = shared;
    const res = await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/approve`, headers: { cookie, origin: "http://localhost:3000" }, payload: { scopes: ["read", "sponsor"] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_scope");
    expect(await prisma.oAuthAuthorizationCode.count({ where: { clientId } })).toBe(0);
    // The request is still pending, so the person can approve correctly.
    expect((await prisma.oAuthAuthorizationRequest.findUnique({ where: { id: requestId } }))?.approvedAt).toBeNull();
  });

  it("rejects an approve with an unsupported, empty or non-string scopes payload", async () => {
    const { cookie } = shared;
    for (const scopes of [["not-a-scope"], [], [1, 2], "read", {}]) {
      const { requestId } = await pendingRequest();
      const res = await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/approve`, headers: { cookie, origin: "http://localhost:3000" }, payload: { scopes } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_scope");
    }
  });

  it("rejects deny for an unknown request id with 400 not_found", async () => {
    const { cookie } = shared;
    const res = await app.inject({ method: "POST", url: `/mcp/oauth/request/${randomBytes(16).toString("hex")}/deny`, headers: { cookie, origin: "http://localhost:3000" }, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe("not_found");
  });

  it("never exposes the consent `reason` detail to the OAuth client, only to the session-gated consent screen", async () => {
    // The consent routes are session-gated, so `reason` is safe there. The
    // token endpoint, which any client can reach, must not carry it.
    const res = await tokenRequest({ grant_type: "authorization_code", client_id: await registerClient(), code: "db_mcp_code_nope", code_verifier: randomBytes(32).toString("base64url"), redirect_uri: LOOPBACK });
    expect(res.statusCode).toBe(400);
    expect(res.json()).not.toHaveProperty("reason");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /mcp/oauth/token — RFC 6749 §5.2
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /mcp/oauth/token — authorization_code grant errors", () => {
  it("refuses a request with no client_id (401 invalid_client, public clients only)", async () => {
    const res = await tokenRequest({ grant_type: "authorization_code", code: "db_mcp_code_x", code_verifier: randomBytes(32).toString("base64url"), redirect_uri: LOOPBACK });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a presented client_secret with 401 invalid_client and does not consume the code", async () => {
    const { clientId, verifier, code } = await approvedCode({ scope: "read", approve: ["read"] });
    const withSecret = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: "not-a-thing",
      code,
      code_verifier: verifier,
      redirect_uri: LOOPBACK,
    });
    expect(withSecret.statusCode).toBe(401);
    expect(withSecret.json().error).toBe("invalid_client");
    // The refusal must not burn the code.
    const ok = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: LOOPBACK });
    expect(ok.statusCode).toBe(200);
  });

  it("rejects an unsupported grant_type with 400 unsupported_grant_type", async () => {
    for (const grant of ["client_credentials", "password", "implicit", "urn:ietf:params:oauth:grant-type:device_code"]) {
      const res = await tokenRequest({ grant_type: grant, client_id: await registerClient() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("unsupported_grant_type");
    }
  });

  it("rejects a missing code, code_verifier or redirect_uri with 400 invalid_request", async () => {
    const clientId = await registerClient();
    const verifier = randomBytes(32).toString("base64url");
    const complete = { grant_type: "authorization_code", client_id: clientId, code: "db_mcp_code_x", code_verifier: verifier, redirect_uri: LOOPBACK };
    for (const omit of ["code", "code_verifier", "redirect_uri"] as const) {
      const fields = { ...complete };
      delete (fields as Record<string, string>)[omit];
      const res = await tokenRequest(fields);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_request");
    }
  });

  it("rejects an unknown code with 400 invalid_grant", async () => {
    const res = await tokenRequest({
      grant_type: "authorization_code",
      client_id: await registerClient(),
      code: `db_mcp_code_${randomBytes(32).toString("base64url")}`,
      code_verifier: randomBytes(32).toString("base64url"),
      redirect_uri: LOOPBACK,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("rejects a replayed (already-consumed) code with 400 invalid_grant", async () => {
    const { clientId, verifier, code } = await approvedCode({ scope: "read", approve: ["read"] });
    const fields = { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: LOOPBACK };
    expect((await tokenRequest(fields)).statusCode).toBe(200);
    const replay = await tokenRequest(fields);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe("invalid_grant");
    // Exactly one credential pair came out of that code.
    expect(await prisma.oAuthAccessToken.count({ where: { clientId } })).toBe(1);
    expect(await prisma.oAuthRefreshToken.count({ where: { clientId } })).toBe(1);
  });

  it("rejects an expired code with 400 invalid_grant", async () => {
    const { clientId, verifier, code } = await approvedCode({ scope: "read", approve: ["read"] });
    await prisma.oAuthAuthorizationCode.updateMany({ where: { clientId }, data: { expiresAt: PAST } });
    const res = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: LOOPBACK });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
    expect(await prisma.oAuthAccessToken.count({ where: { clientId } })).toBe(0);
  });

  it("rejects a redirect_uri that does not match the one the code was issued for", async () => {
    const { clientId, verifier, code } = await approvedCode({ scope: "read", approve: ["read"] });
    const res = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1:41999/other",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("rejects a wrong code_verifier with 400 invalid_grant and burns nothing", async () => {
    const { clientId, verifier, code } = await approvedCode({ scope: "read", approve: ["read"] });
    const wrong = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: randomBytes(32).toString("base64url"),
      redirect_uri: LOOPBACK,
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("invalid_grant");
    expect(await prisma.oAuthAccessToken.count({ where: { clientId } })).toBe(0);
    // PKCE failure is not a code-burning event; the real verifier still works.
    expect((await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: LOOPBACK })).statusCode).toBe(200);
  });

  it("rejects a malformed code_verifier (outside the RFC 7636 43–128 character set)", async () => {
    const { clientId, code } = await approvedCode({ scope: "read", approve: ["read"] });
    for (const bad of ["short", "a".repeat(200), `${"a".repeat(42)}$`]) {
      const res = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: bad, redirect_uri: LOOPBACK });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_grant");
    }
  });

  it("rejects a client_id that does not own the code with 400 invalid_grant", async () => {
    const { verifier, code } = await approvedCode({ scope: "read", approve: ["read"] });
    const attacker = await registerClient();
    const res = await tokenRequest({ grant_type: "authorization_code", client_id: attacker, code, code_verifier: verifier, redirect_uri: LOOPBACK });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
    expect(await prisma.oAuthAccessToken.count({ where: { clientId: attacker } })).toBe(0);
  });

  it("rejects a resource that does not match the one bound to the code (RFC 8707)", async () => {
    const { clientId, verifier, code } = await approvedCode({ scope: "read", approve: ["read"] });
    for (const resource of ["https://not-this-server.example/mcp", `${canonicalResource}#frag`, "nonsense"]) {
      const res = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: LOOPBACK, resource });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_grant");
    }
  });

  it("rejects a code whose owning account is no longer active", async () => {
    const { clientId, verifier, code, userId } = await approvedCode({ scope: "read", approve: ["read"], freshUser: true });
    await prisma.user.update({ where: { id: userId }, data: { status: "suspended" } });
    const res = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: LOOPBACK });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
    await prisma.user.update({ where: { id: userId }, data: { status: "active" } });
  });

  it("SPEC GAP — a token request with no grant_type must be invalid_request, not unsupported_grant_type", async () => {
    // RFC 6749 §5.2: "invalid_request — The request is missing a required
    // parameter". `grant_type` is REQUIRED (§4.1.3), so its absence is a
    // malformed request, not an unsupported grant. src/routes/mcp.ts:491
    // falls through to unsupported_grant_type for both cases, which tells a
    // client the server cannot do something it never asked for. Same in v1
    // (databounty-api routes/mcp.ts:415).
    const res = await tokenRequest({ client_id: await registerClient(), code: "db_mcp_code_x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});

describe("POST /mcp/oauth/token — refresh_token grant errors", () => {
  it("rejects an unknown refresh token with 400 invalid_grant", async () => {
    const res = await tokenRequest({
      grant_type: "refresh_token",
      client_id: await registerClient(),
      refresh_token: `db_mcp_rt_${randomBytes(32).toString("base64url")}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("rejects a refresh token presented by a different client", async () => {
    const { refreshToken } = await mintTokens("read");
    const attacker = await registerClient();
    const res = await tokenRequest({ grant_type: "refresh_token", client_id: attacker, refresh_token: refreshToken });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("rejects an expired refresh token", async () => {
    const { clientId, refreshToken } = await mintTokens("read");
    await prisma.oAuthRefreshToken.updateMany({ where: { clientId }, data: { expiresAt: PAST } });
    const res = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("rejects a refresh token that was explicitly revoked — the rotation grace never resurrects it", async () => {
    const { clientId, refreshToken } = await mintTokens("read");
    expect((await app.inject({ method: "POST", url: "/mcp/oauth/revoke", ...form({ token: refreshToken }) })).statusCode).toBe(200);
    const res = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("rejects a refresh token whose grant was disconnected from the dashboard", async () => {
    const { clientId, refreshToken, cookie } = await mintTokens("read");
    expect((await app.inject({ method: "POST", url: `/mcp/oauth/grants/${encodeURIComponent(clientId)}/revoke`, headers: { cookie } })).statusCode).toBe(200);
    const res = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("refuses to widen scope on refresh with 400 invalid_scope", async () => {
    const { clientId, refreshToken } = await mintTokens("read");
    const res = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, scope: "read sponsor" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_scope");
  });

  it("rejects an unsupported scope string on refresh with 400 invalid_scope", async () => {
    const { clientId, refreshToken } = await mintTokens("read");
    const res = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, scope: "not-a-scope" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_scope");
  });

  it("rejects a mismatched resource on refresh (RFC 8707)", async () => {
    const { clientId, refreshToken } = await mintTokens("read");
    const res = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource: "https://not-this-server.example/mcp" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("rejects a refresh whose account is no longer active", async () => {
    const { clientId, refreshToken, userId } = await mintTokens("read", { freshUser: true });
    await prisma.user.update({ where: { id: userId }, data: { status: "suspended" } });
    const res = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
    await prisma.user.update({ where: { id: userId }, data: { status: "active" } });
  });

  it("rejects an access token presented as a refresh token", async () => {
    const { clientId, accessToken } = await mintTokens("read");
    const res = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: accessToken });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("SPEC GAP — a refresh_token grant with no refresh_token must be invalid_request, not unsupported_grant_type", async () => {
    // RFC 6749 §6: `refresh_token` is REQUIRED for this grant, so §5.2 makes
    // its absence invalid_request. src/routes/mcp.ts:485 gates the whole grant
    // branch on `body.refresh_token` being present and otherwise falls through
    // to the unsupported_grant_type throw on line 491 — so a client with a
    // dropped parameter is told the server does not support the refresh grant
    // it advertises in its own RFC 8414 metadata. Same in v1
    // (databounty-api routes/mcp.ts:414-415).
    const res = await tokenRequest({ grant_type: "refresh_token", client_id: await registerClient() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /mcp/oauth/revoke — RFC 7009
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /mcp/oauth/revoke — RFC 7009 no-op semantics", () => {
  it("answers 200 for a token that never existed (never a validity oracle)", async () => {
    for (const token of [`db_mcp_at_${randomBytes(32).toString("base64url")}`, `db_mcp_rt_${randomBytes(32).toString("base64url")}`, "totally-bogus"]) {
      const res = await app.inject({ method: "POST", url: "/mcp/oauth/revoke", ...form({ token }) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
    }
  });

  it("answers 200 identically for a live token, a revoked token and an unknown token", async () => {
    const { accessToken } = await mintTokens("read");
    const first = await app.inject({ method: "POST", url: "/mcp/oauth/revoke", ...form({ token: accessToken }) });
    const second = await app.inject({ method: "POST", url: "/mcp/oauth/revoke", ...form({ token: accessToken }) });
    const unknown = await app.inject({ method: "POST", url: "/mcp/oauth/revoke", ...form({ token: "db_mcp_at_nope" }) });
    expect([first.statusCode, second.statusCode, unknown.statusCode]).toEqual([200, 200, 200]);
    expect([first.payload, second.payload, unknown.payload]).toEqual([first.payload, first.payload, first.payload]);
  });

  it("ignores an unsupported token_type_hint rather than failing (RFC 7009 §2.1)", async () => {
    const { accessToken } = await mintTokens("read");
    const res = await app.inject({ method: "POST", url: "/mcp/oauth/revoke", ...form({ token: accessToken, token_type_hint: "refresh_token" }) });
    expect(res.statusCode).toBe(200);
    // The hint is wrong, but the access token is still revoked.
    const after = await mcpCall({ authorization: `Bearer ${accessToken}` }, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(after.statusCode).toBe(401);
  });

  it("answers 200 with no token parameter at all", async () => {
    // RFC 7009 §2.1 marks `token` REQUIRED and §2.2.1 defers other errors to
    // RFC 6749 §5.2, which would make this invalid_request/400. The RFC never
    // states it explicitly, and answering 200 is the more conservative
    // no-oracle reading, so this asserts the implemented behaviour and records
    // the ambiguity rather than manufacturing a failure. src/routes/mcp.ts:500-503.
    const res = await app.inject({ method: "POST", url: "/mcp/oauth/revoke", ...form({}) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authenticated MCP calls to /mcp — MCP authorization 2025-11-25
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /mcp — 401 challenges (MCP authorization 2025-11-25 §Error Handling)", () => {
  /** Every 401 must carry an RFC 6750 Bearer challenge naming the RFC 9728
   *  metadata document, a scope hint and error="invalid_token". */
  function expectChallenge(header: string | undefined) {
    const value = String(header ?? "");
    expect(value).toMatch(/^Bearer /);
    expect(value).toContain(`resource_metadata="${resourceMetadataUrl}"`);
    expect(value).toMatch(/scope="[^"]+"/);
    expect(value).toContain('error="invalid_token"');
    return value;
  }

  const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } };

  it("refuses a request with no Authorization header", async () => {
    const res = await mcpCall({}, INIT);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
    expectChallenge(res.headers["www-authenticate"] as string);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("refuses a malformed Authorization header (no Bearer scheme, empty bearer, non-token value)", async () => {
    for (const authorization of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer    ", "db_mcp_at_no_scheme", "Bearer not-a-databounty-token"]) {
      const res = await mcpCall({ authorization }, INIT);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_token");
      expectChallenge(res.headers["www-authenticate"] as string);
    }
  });

  it("refuses an unknown but well-shaped access token", async () => {
    const res = await mcpCall({ authorization: `Bearer db_mcp_at_${randomBytes(32).toString("base64url")}` }, INIT);
    expect(res.statusCode).toBe(401);
    expectChallenge(res.headers["www-authenticate"] as string);
  });

  it("refuses an expired access token", async () => {
    const { clientId, accessToken } = await mintTokens("read");
    await prisma.oAuthAccessToken.updateMany({ where: { clientId }, data: { expiresAt: PAST } });
    const res = await mcpCall({ authorization: `Bearer ${accessToken}` }, INIT);
    expect(res.statusCode).toBe(401);
    expectChallenge(res.headers["www-authenticate"] as string);
  });

  it("refuses a revoked access token immediately, with no cache window", async () => {
    const { accessToken } = await mintTokens("read");
    expect((await mcpCall({ authorization: `Bearer ${accessToken}` }, INIT)).statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/mcp/oauth/revoke", ...form({ token: accessToken }) });
    const res = await mcpCall({ authorization: `Bearer ${accessToken}` }, INIT);
    expect(res.statusCode).toBe(401);
  });

  it("refuses a token minted for a different audience (RFC 8707 audience binding)", async () => {
    const { clientId, accessToken } = await mintTokens("read");
    await prisma.oAuthAccessToken.updateMany({ where: { clientId }, data: { resource: "https://someone-elses-server.example/mcp" } });
    const res = await mcpCall({ authorization: `Bearer ${accessToken}` }, INIT);
    expect(res.statusCode).toBe(401);
    expectChallenge(res.headers["www-authenticate"] as string);
  });

  it("refuses a token whose account was suspended", async () => {
    const { accessToken, userId } = await mintTokens("read", { freshUser: true });
    await prisma.user.update({ where: { id: userId }, data: { status: "suspended" } });
    const res = await mcpCall({ authorization: `Bearer ${accessToken}` }, INIT);
    expect(res.statusCode).toBe(401);
    await prisma.user.update({ where: { id: userId }, data: { status: "active" } });
  });

  it("refuses to hand a session to a different credential than the one that opened it", async () => {
    const first = await mintTokens("read");
    const init = await mcpCall({ authorization: `Bearer ${first.accessToken}` }, INIT);
    expect(init.statusCode).toBe(200);
    const sessionId = init.headers["mcp-session-id"] as string;
    expect(sessionId).toBeTruthy();

    const second = await mintTokens("read");
    const stolen = await mcpCall(
      { authorization: `Bearer ${second.accessToken}`, "mcp-session-id": sessionId },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    );
    expect(stolen.statusCode).toBe(401);
    expect(stolen.json().error).toBe("invalid_token");
  });

  it("refuses an unknown session id with 400 rather than opening a new one", async () => {
    const { accessToken } = await mintTokens("read");
    const res = await mcpCall(
      { authorization: `Bearer ${accessToken}`, "mcp-session-id": randomBytes(16).toString("hex") },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    );
    // Any 4xx is acceptable; what must not happen is a silently new session.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("refuses a plain unauthenticated GET with a 401 challenge, the same as a credential-bearing one", async () => {
    // A 200 identity document here — a health-check convenience left from
    // before /health and /healthz existed — contradicted docs/mcp.md's own
    // documented contract and meant clients that start OAuth from a 401 on
    // ANY unauthenticated request (Zed, Cline, mcp-remote), not only a POST,
    // never learned they needed to authenticate.
    const noAuth = await app.inject({ method: "GET", url: "/mcp" });
    expect(noAuth.statusCode).toBe(401);
    expectChallenge(noAuth.headers["www-authenticate"] as string);

    const withBadToken = await app.inject({ method: "GET", url: "/mcp", headers: { authorization: "Bearer db_mcp_at_nope", accept: MCP_ACCEPT } });
    expect(withBadToken.statusCode).toBe(401);
    expectChallenge(withBadToken.headers["www-authenticate"] as string);
  });

  it("advertises a resource_metadata URL that this server actually serves", async () => {
    const res = await app.inject({ method: "GET", url: new URL(resourceMetadataUrl).pathname });
    expect(res.statusCode).toBe(200);
    expect(res.json().resource).toBe(canonicalResource);
    expect(res.json().authorization_servers).toContain(issuer);
  });
});

describe("POST /mcp — insufficient scope at runtime", () => {
  it("refuses a tool the credential lacks scope for and returns an RFC 6750 insufficient_scope challenge", async () => {
    const { accessToken } = await mintTokens("read");
    const auth = { authorization: `Bearer ${accessToken}` };
    const init = await mcpCall(auth, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } });
    expect(init.statusCode).toBe(200);
    const sessionId = init.headers["mcp-session-id"] as string;
    await mcpCall({ ...auth, "mcp-session-id": sessionId }, { jsonrpc: "2.0", method: "notifications/initialized" });

    const res = await mcpCall(
      { ...auth, "mcp-session-id": sessionId },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_pool_items", arguments: { bountyId: "x", items: [] } } },
    );
    const result = jsonRpcBody(res.payload).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/missing the required scope: contribute/i);

    // MCP authorization 2025-11-25 §Scope Challenge Handling requires the
    // challenge to name error="insufficient_scope", the scopes needed, and the
    // resource metadata document. It is carried in `_meta` rather than an HTTP
    // header because a JSON-RPC tool refusal cannot set the response status of
    // a possibly-batched HTTP response.
    const challenge = String((result._meta?.["mcp/www_authenticate"] ?? [])[0] ?? "");
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain(`resource_metadata="${resourceMetadataUrl}"`);
    // Recommended approach: existing scopes plus the newly required one.
    expect(challenge).toMatch(/scope="[^"]*\bread\b[^"]*"/);
    expect(challenge).toMatch(/scope="[^"]*\bcontribute\b[^"]*"/);
  });

  it("does not offer a scope challenge for the 401 no-credential case (re-authorizing with more scope fixes nothing)", async () => {
    const res = await mcpCall({}, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["www-authenticate"])).not.toContain("insufficient_scope");
  });
});
