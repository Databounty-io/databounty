// SPDX-License-Identifier: Apache-2.0

/**
 * MCP OAuth 2.1 token ROTATION and REVOCATION, driven through the real Fastify
 * app and the real Postgres database. No mocks: dynamic client registration,
 * `/mcp/oauth/authorize`, the session-gated consent approval, `/mcp/oauth/token`
 * (both grant types), `/mcp/oauth/revoke`, the dashboard grant routes and the
 * `/mcp` resource itself all run for real.
 *
 * Assertions are written against what the specifications REQUIRE, not against
 * what this implementation happens to do:
 *
 *  - OAuth 2.1 draft-13 §4.1.3 — "If a second valid token request is made with
 *    the same authorization code as a previously successful token request, the
 *    authorization server MUST deny the request and SHOULD revoke (when
 *    possible) all access tokens and refresh tokens previously issued based on
 *    that authorization code." (§7.5.3 restates it and adds the caveat that
 *    tokens must NOT be revoked when the replay carries invalid parameters.)
 *  - OAuth 2.1 draft-13 §4.3.1 — "Authorization servers MUST utilize one of
 *    these methods to detect refresh token replay by malicious actors for
 *    public clients": sender-constrained refresh tokens, OR refresh token
 *    rotation, where on seeing an invalidated refresh token the server "will
 *    revoke the active refresh token as well as the access authorization grant
 *    associated with it."
 *  - OAuth 2.1 draft-13 §4.3.3 — "If a new refresh token is issued, the refresh
 *    token scope MUST be identical to that of the refresh token included by the
 *    client in the request."
 *  - RFC 7009 §2.1 — the AS "verifies whether the token was issued to the
 *    client making the revocation request"; and "If the particular token is a
 *    refresh token and the authorization server supports the revocation of
 *    access tokens, then the authorization server SHOULD also invalidate all
 *    access tokens based on the same authorization grant." §2.2 — HTTP 200 for
 *    a successfully revoked token AND for an invalid one.
 *
 * Tests that FAIL here are recorded defects, not broken tests. Each such
 * assertion carries a `SPEC GAP` comment naming the clause it enforces. They
 * are deliberately left failing: source fixes land centrally, not here.
 *
 * Self-guards like every other integration suite — refuses to run unless
 * DATABASE_URL names a disposable local database.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import { createSession } from "../lib/session.js";
import { SESSION_COOKIE } from "../lib/session-cookie.js";
import { config } from "../config.js";

requireDisposableDatabase();

let app: FastifyInstance;

/** Every user and client this file creates, torn down in afterAll. */
const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

/** From the code, not guessed: ACCESS_TTL_MS = 8h in services/mcp-oauth.ts. */
const EXPECTED_EXPIRES_IN = 8 * 60 * 60;
const REDIRECT = "http://127.0.0.1:41888/callback";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

function refreshTokenHash(token: string): string {
  return createHmac("sha256", config.sessionSecret).update(token).digest("hex");
}

/**
 * Harness setup, not a product assertion: `app.ts` registers
 * `@fastify/rate-limit` with a BOOT-TIME read of `ratelimit.global.max`
 * (default 300 req/60s, keyed on `req.ip`, which is 127.0.0.1 for every
 * `app.inject` call). This file drives ~15 OAuth round trips per grant across
 * two dozen grants, so the global limiter would start answering 429 partway
 * through the suite and every later test would fail for a reason that has
 * nothing to do with OAuth. Raised here before `buildApp()` so the plugin
 * picks it up at registration time, and removed again in afterAll.
 */
beforeAll(async () => {
  await prisma.adminSetting.upsert({
    where: { key: "ratelimit.global.max" },
    create: { key: "ratelimit.global.max", value: 1_000_000 },
    update: { value: 1_000_000 },
  });
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  // Audit events null out their FKs on delete rather than cascading, so they
  // are removed explicitly first or the suite leaves orphan rows behind.
  if (createdClientIds.length) {
    await prisma.oAuthAuditEvent.deleteMany({ where: { clientId: { in: createdClientIds } } });
  }
  if (createdUserIds.length) {
    await prisma.oAuthAuditEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  }
  if (createdClientIds.length) {
    await prisma.oAuthClient.deleteMany({ where: { clientId: { in: createdClientIds } } });
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.adminSetting.deleteMany({ where: { key: "ratelimit.global.max" } });
  await app.close();
  await prisma.$disconnect();
});

/**
 * A verified user plus a real dashboard session cookie.
 *
 * Deliberately NOT via `POST /v1/auth/signup` (the convention in
 * `mcp-cimd.integration.test.ts`): that route carries the hard-coded
 * `AUTH_RATE_LIMIT` of 10 requests/minute per IP (`routes/v1/auth.ts:84`), and
 * every `app.inject` call shares one IP. Each revocation case here needs its
 * own user — sharing them would let one test's revoke-all kill another's
 * grant — so signing up two dozen users inside one minute made the whole suite
 * 429 partway through. The user row and the session are created through the
 * app's OWN `createSession` and cookie name, so the consent routes see exactly
 * the session a real browser login produces.
 */
async function signupVerified(prefix: string) {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${stamp}@example.com`.toLowerCase();
  const user = await prisma.user.create({
    data: {
      authMethod: "email",
      email,
      handle: `${prefix}${stamp}`.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24),
      displayName: prefix,
      emailVerifiedAt: new Date(),
      onboarded: true,
      status: "active",
    },
  });
  createdUserIds.push(user.id);
  const token = await createSession(user.id);
  return { email, userId: user.id, cookie: `${SESSION_COOKIE}=${token}` };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(name: string, redirectUri = REDIRECT) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp/oauth/register",
    payload: { redirect_uris: [redirectUri], client_name: name, token_endpoint_auth_method: "none" },
  });
  expect(res.statusCode).toBe(201);
  const clientId = res.json().client_id as string;
  createdClientIds.push(clientId);
  return clientId;
}

/** Authorize + approve, returning the one-shot code and its PKCE verifier. */
async function authorizedCode(input: {
  clientId: string;
  cookie: string;
  scope: string;
  approveScopes?: string[];
  redirectUri?: string;
}) {
  const { verifier, challenge } = pkce();
  const auth = await app.inject({
    method: "GET",
    url: "/mcp/oauth/authorize",
    query: {
      response_type: "code",
      client_id: input.clientId,
      redirect_uri: input.redirectUri ?? REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: input.scope,
    },
  });
  expect(auth.statusCode).toBe(302);
  const requestId = new URL(auth.headers.location as string).searchParams.get("request_id")!;
  const approved = await app.inject({
    method: "POST",
    url: `/mcp/oauth/request/${requestId}/approve`,
    headers: { cookie: input.cookie, origin: "http://localhost:3000" },
    payload: { scopes: input.approveScopes ?? input.scope.split(" ") },
  });
  expect(approved.statusCode).toBe(200);
  return { code: approved.json().code as string, verifier };
}

function exchangeCode(input: { clientId: string; code: string; verifier: string; redirectUri?: string }) {
  return app.inject({
    method: "POST",
    url: "/mcp/oauth/token",
    headers: FORM,
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri ?? REDIRECT,
    }).toString(),
  });
}

function refresh(input: { clientId: string; refreshToken: string; scope?: string }) {
  return app.inject({
    method: "POST",
    url: "/mcp/oauth/token",
    headers: FORM,
    payload: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      ...(input.scope ? { scope: input.scope } : {}),
    }).toString(),
  });
}

function revoke(token: string, extra: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/mcp/oauth/revoke",
    headers: FORM,
    payload: new URLSearchParams({ token, ...extra }).toString(),
  });
}

/** A full grant: registered client, verified user, live access+refresh pair. */
async function connectedGrant(prefix: string, scope = "read contribute") {
  const user = await signupVerified(prefix);
  const clientId = await registerClient(`${prefix} client`);
  const { code, verifier } = await authorizedCode({ clientId, cookie: user.cookie, scope });
  const token = await exchangeCode({ clientId, code, verifier });
  expect(token.statusCode).toBe(200);
  return {
    ...user,
    clientId,
    access: token.json().access_token as string,
    refreshToken: token.json().refresh_token as string,
    scope: token.json().scope as string,
  };
}

/** Bearer-authenticated probe of the MCP resource itself. */
function mcpProbe(token: string) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
  });
}

async function auditActions(clientId: string): Promise<string[]> {
  const rows = await prisma.oAuthAuditEvent.findMany({ where: { clientId }, orderBy: { createdAt: "asc" }, select: { action: true } });
  return rows.map((row) => row.action);
}

function liveAccessTokens(userId: string, clientId: string) {
  return prisma.oAuthAccessToken.count({ where: { userId, clientId, revokedAt: null, expiresAt: { gt: new Date() } } });
}

function liveRefreshTokens(userId: string, clientId: string) {
  return prisma.oAuthRefreshToken.count({ where: { userId, clientId, revokedAt: null, expiresAt: { gt: new Date() } } });
}

function ok(res: LightMyRequestResponse): boolean {
  return res.statusCode === 200;
}

// ───────────────────────────────────────────────────────────────────────────
// Authorization-code exchange: what it issues, and single use
// ───────────────────────────────────────────────────────────────────────────

describe("authorization-code exchange", () => {
  it("issues an access token and a refresh token, with the code's TTL and scope, and audits token.issued", async () => {
    const grant = await connectedGrant("rot-issue");
    expect(grant.access).toMatch(/^db_mcp_at_/);
    expect(grant.refreshToken).toMatch(/^db_mcp_rt_/);
    expect(grant.scope).toBe("read contribute");

    const row = await prisma.oAuthAccessToken.findFirst({ where: { userId: grant.userId, clientId: grant.clientId } });
    expect(row).not.toBeNull();
    expect(row!.scope).toEqual(["read", "contribute"]);
    // expires_in is ACCESS_TTL_MS/1000 from the service, not a guess.
    const again = await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken });
    expect(again.json().expires_in).toBe(EXPECTED_EXPIRES_IN);
    expect(await auditActions(grant.clientId)).toContain("token.issued");
  });

  it("burns the authorization code: a second exchange with the SAME valid code and verifier is denied", async () => {
    const user = await signupVerified("rot-burn");
    const clientId = await registerClient("rot-burn client");
    const { code, verifier } = await authorizedCode({ clientId, cookie: user.cookie, scope: "read" });

    const first = await exchangeCode({ clientId, code, verifier });
    expect(first.statusCode).toBe(200);

    const second = await exchangeCode({ clientId, code, verifier });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe("invalid_grant");
  });

  it("revokes the tokens already issued from a replayed authorization code (OAuth 2.1 §4.1.3 / §7.5.3)", async () => {
    const user = await signupVerified("rot-replay");
    const clientId = await registerClient("rot-replay client");
    const { code, verifier } = await authorizedCode({ clientId, cookie: user.cookie, scope: "read" });

    const first = await exchangeCode({ clientId, code, verifier });
    expect(first.statusCode).toBe(200);
    const stolenAccess = first.json().access_token as string;
    const stolenRefresh = first.json().refresh_token as string;

    // A SECOND VALID request — right client, right redirect_uri, right PKCE
    // verifier. §7.5.3's caveat (do not revoke on an invalid replay) does not
    // apply: this replay is valid in every parameter but the code's freshness.
    const second = await exchangeCode({ clientId, code, verifier });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe("invalid_grant");

    // OAuth 2.1 §4.1.3: the AS "MUST deny the request and SHOULD revoke (when
    // possible) all access tokens and refresh tokens previously issued based
    // on that authorization code". The point is that when a code is
    // exfiltrated and redeemed by an attacker, the tokens the attacker
    // already holds die the moment the legitimate client's redemption
    // arrives — traced via OAuthAccessToken/OAuthRefreshToken.authorizationCodeId.
    expect(await liveAccessTokens(user.userId, clientId)).toBe(0);
    expect(await liveRefreshTokens(user.userId, clientId)).toBe(0);
    expect(ok(await refresh({ clientId, refreshToken: stolenRefresh }))).toBe(false);
    expect((await mcpProbe(stolenAccess)).statusCode).toBe(401);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Refresh rotation
// ───────────────────────────────────────────────────────────────────────────

describe("refresh rotation", () => {
  it("returns a NEW refresh token, retires the presented one as rotated, and audits refresh.rotated", async () => {
    const grant = await connectedGrant("rot-basic");

    const res = await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken });
    expect(res.statusCode).toBe(200);
    const next = res.json().refresh_token as string;
    expect(next).toMatch(/^db_mcp_rt_/);
    // OAuth 2.1 §4.3.1 rotation: a new refresh token with every refresh
    // response, the previous one invalidated.
    expect(next).not.toBe(grant.refreshToken);
    expect(res.json().access_token).not.toBe(grant.access);
    expect(res.json().scope).toBe("read contribute");

    // Exactly one live refresh token remains for the grant, and the retired
    // one is marked as retired BY ROTATION (rotatedAt), which is what keeps
    // the reuse grace from ever applying to an explicit revocation.
    expect(await liveRefreshTokens(grant.userId, grant.clientId)).toBe(1);
    const retired = await prisma.oAuthRefreshToken.findFirst({
      where: { userId: grant.userId, clientId: grant.clientId, revokedAt: { not: null } },
    });
    expect(retired!.rotatedAt).not.toBeNull();
    expect(await auditActions(grant.clientId)).toContain("refresh.rotated");
  });

  it("keeps the refresh token bound to its client: another client cannot present it", async () => {
    const grant = await connectedGrant("rot-bind");
    const otherClient = await registerClient("rot-bind other");
    // OAuth 2.1 §4.3.1: "if a client_id is included in the request, ensure the
    // refresh token was issued to the matching client".
    const res = await refresh({ clientId: otherClient, refreshToken: grant.refreshToken });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
    expect(await liveRefreshTokens(grant.userId, grant.clientId)).toBe(1);
  });

  it("refuses an expired refresh token", async () => {
    const grant = await connectedGrant("rot-rtexp");
    await prisma.oAuthRefreshToken.updateMany({
      where: { userId: grant.userId, clientId: grant.clientId, revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("refuses an expired access token at the MCP resource, with an RFC 9728 challenge", async () => {
    const grant = await connectedGrant("rot-atexp");
    await prisma.oAuthAccessToken.updateMany({
      where: { userId: grant.userId, clientId: grant.clientId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await mcpProbe(grant.access);
    expect(res.statusCode).toBe(401);
    const challenge = String(res.headers["www-authenticate"]);
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toMatch(/resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Refresh-token reuse detection
// ───────────────────────────────────────────────────────────────────────────

describe("refresh-token reuse detection", () => {
  it("rejects a rotated refresh token past the grace window without burning its live successor", async () => {
    const grant = await connectedGrant("rot-reuse-late");
    const rotated = await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken });
    expect(rotated.statusCode).toBe(200);
    const liveRefresh = rotated.json().refresh_token as string;
    const liveAccess = rotated.json().access_token as string;

    await prisma.oAuthRefreshToken.updateMany({
      where: { tokenHash: refreshTokenHash(grant.refreshToken) },
      data: { rotatedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const replay = await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe("invalid_grant");
    expect(await auditActions(grant.clientId)).toContain("refresh.replay_rejected");
    expect(await liveRefreshTokens(grant.userId, grant.clientId)).toBe(1);
    expect((await mcpProbe(liveAccess)).statusCode).toBe(200);
    expect(ok(await refresh({ clientId: grant.clientId, refreshToken: liveRefresh }))).toBe(true);
  });

  it("reissues a working pair when the rotation predecessor is reused immediately", async () => {
    const grant = await connectedGrant("rot-grace");
    const rotated = await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken });
    expect(rotated.statusCode).toBe(200);

    const replay = await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().refresh_token).not.toBe(grant.refreshToken);
    expect(replay.json().refresh_token).not.toBe(rotated.json().refresh_token);
    expect((await mcpProbe(replay.json().access_token as string)).statusCode).toBe(200);
    expect(await liveRefreshTokens(grant.userId, grant.clientId)).toBe(2);
    expect(await auditActions(grant.clientId)).toContain("refresh.grace_reissued");
  });

  it("never resurrects a refresh token killed by explicit revocation, even inside the grace window", async () => {
    const grant = await connectedGrant("rot-norez");
    // Explicit revocation sets revokedAt and leaves rotatedAt null, so the
    // grace window cannot apply. This is the correct half of the design.
    expect(ok(await revoke(grant.refreshToken))).toBe(true);
    const res = await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_grant");
  });

  it("lets two concurrent client processes converge on separate working token pairs", async () => {
    const grant = await connectedGrant("rot-race");
    const [a, b] = await Promise.all([
      refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken }),
      refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken }),
    ]);
    const winners = [a, b].filter(ok);

    expect(winners).toHaveLength(2);
    expect(await liveRefreshTokens(grant.userId, grant.clientId)).toBe(2);
    for (const winner of winners) {
      expect((await mcpProbe(winner.json().access_token as string)).statusCode).toBe(200);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Scope on refresh
// ───────────────────────────────────────────────────────────────────────────

describe("scope on refresh", () => {
  it("refuses to widen scope", async () => {
    const grant = await connectedGrant("rot-widen", "read");
    const res = await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken, scope: "read sponsor" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_scope");
    // The refusal must not consume the token.
    expect(ok(await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken }))).toBe(true);
  });

  it("honours a narrowed scope on the ACCESS token without narrowing the grant's refresh token (OAuth 2.1 §4.3.3)", async () => {
    const grant = await connectedGrant("rot-narrow", "read contribute");
    const narrowed = await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken, scope: "read" });
    expect(narrowed.statusCode).toBe(200);
    // A narrowed request is honoured for the issued access token — correct.
    expect(narrowed.json().scope).toBe("read");
    const next = narrowed.json().refresh_token as string;

    // SPEC GAP — OAuth 2.1 §4.3.3: "If a new refresh token is issued, the
    // refresh token scope MUST be identical to that of the refresh token
    // included by the client in the request." The rotated refresh token is
    // stored with the NARROWED scope, so one down-scoped request permanently
    // and irreversibly shrinks the grant: the client can never again obtain
    // the scopes the user actually approved without a full re-authorization,
    // and §4.3's stated use case (a client that "previously obtained an access
    // token with a scope more narrow than approved by the respective grant and
    // later requires an access token with a different scope under the same
    // grant") stops working.
    const rewidened = await refresh({ clientId: grant.clientId, refreshToken: next, scope: "read contribute" });
    expect(rewidened.statusCode).toBe(200);
    expect(rewidened.json().scope).toBe("read contribute");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// RFC 7009 revocation
// ───────────────────────────────────────────────────────────────────────────

describe("RFC 7009 /mcp/oauth/revoke", () => {
  it("revokes an access token immediately — no cached validation window — and audits token.revoked", async () => {
    const grant = await connectedGrant("rev-access");
    // Positive control for `mcpProbe`: while the token is live the resource
    // must NOT answer 401, so the 401s asserted elsewhere in this file are
    // caused by revocation/expiry and not by the probe itself being malformed.
    expect((await mcpProbe(grant.access)).statusCode).not.toBe(401);

    // Community has no verified-token cache in the auth path (unlike v1, which
    // caches verifyMcpAccessToken for 60s with explicit eviction), so the very
    // next request must already be refused.
    expect(ok(await revoke(grant.access))).toBe(true);
    expect((await mcpProbe(grant.access)).statusCode).toBe(401);
    expect(await liveAccessTokens(grant.userId, grant.clientId)).toBe(0);

    const events = await prisma.oAuthAuditEvent.findMany({ where: { clientId: grant.clientId, action: "token.revoked" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ kind: "access" });
    expect(events[0]!.userId).toBe(grant.userId);

    // RFC 7009 §2.1 permits the refresh token to survive access-token
    // revocation, and this server takes that option.
    expect(ok(await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken }))).toBe(true);
  });

  it("revoking a refresh token kills that token and, with it, the access tokens on the same grant (RFC 7009 §2.1)", async () => {
    const grant = await connectedGrant("rev-refresh");
    expect(ok(await revoke(grant.refreshToken))).toBe(true);

    // The refresh token itself is dead — correct.
    expect((await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken })).statusCode).toBe(400);
    const events = await prisma.oAuthAuditEvent.findMany({ where: { clientId: grant.clientId, action: "token.revoked" } });
    expect(events[0]!.metadata).toMatchObject({ kind: "refresh" });

    // SPEC GAP — RFC 7009 §2.1: "If the particular token is a refresh token
    // and the authorization server supports the revocation of access tokens,
    // then the authorization server SHOULD also invalidate all access tokens
    // based on the same authorization grant." This server does support access
    // token revocation, so the SHOULD applies. `revokeMcpToken` returns after
    // the first matching table, leaving the access token live for up to its
    // 8-hour TTL after the user's client believed it had revoked the grant.
    expect(await liveAccessTokens(grant.userId, grant.clientId)).toBe(0);
    expect((await mcpProbe(grant.access)).statusCode).toBe(401);
  });

  it("answers 200 for an unknown token and writes no audit event (RFC 7009 §2.2 — no validity oracle)", async () => {
    const grant = await connectedGrant("rev-unknown");
    const before = await auditActions(grant.clientId);
    const res = await revoke(`db_mcp_at_${randomBytes(32).toString("base64url")}`);
    expect(res.statusCode).toBe(200);
    expect(await auditActions(grant.clientId)).toEqual(before);
    // And a request with no token at all is still a 200, not a 400.
    expect((await app.inject({ method: "POST", url: "/mcp/oauth/revoke", headers: FORM, payload: "" })).statusCode).toBe(200);
  });

  it("ignores a wrong token_type_hint and still finds the token (RFC 7009 §2.1)", async () => {
    const grant = await connectedGrant("rev-hint");
    // The hint is advisory: "the authorization server MUST extend its search
    // across all supported token types" if the hinted type does not match.
    expect(ok(await revoke(grant.access, { token_type_hint: "refresh_token" }))).toBe(true);
    expect((await mcpProbe(grant.access)).statusCode).toBe(401);

    const grant2 = await connectedGrant("rev-hint2");
    expect(ok(await revoke(grant2.refreshToken, { token_type_hint: "access_token" }))).toBe(true);
    expect((await refresh({ clientId: grant2.clientId, refreshToken: grant2.refreshToken })).statusCode).toBe(400);
  });

  it("refuses to revoke a token that was issued to a DIFFERENT client (RFC 7009 §2.1)", async () => {
    const victim = await connectedGrant("rev-victim");
    const attackerClient = await registerClient("rev-attacker client");

    // The attacker presents the victim's access token at the revocation
    // endpoint under its OWN client_id.
    const res = await revoke(victim.access, { client_id: attackerClient });
    // RFC 7009 §2.2 keeps the response a 200 either way, so status alone
    // cannot distinguish refusal from success — the token's fate is the test.
    expect(res.statusCode).toBe(200);

    // SPEC GAP — RFC 7009 §2.1: the AS "verifies whether the token was issued
    // to the client making the revocation request. If this validation fails,
    // the request is refused and the client should be informed about the error
    // by the authorization server as described below." `/mcp/oauth/revoke`
    // reads only `token` — it never looks at `client_id` and `revokeMcpToken()`
    // takes no client argument — so ANY party holding a token value can revoke
    // it regardless of who it belongs to. On a public, unauthenticated
    // revocation endpoint that turns every place a token is observable (a
    // shared MCP proxy, a log, a co-resident client) into a denial-of-service
    // handle over someone else's live grant.
    expect(await liveAccessTokens(victim.userId, victim.clientId)).toBe(1);
    expect((await mcpProbe(victim.access)).statusCode).not.toBe(401);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Dashboard grant revocation
// ───────────────────────────────────────────────────────────────────────────

describe("dashboard grant revocation", () => {
  it("is session-gated on every route", async () => {
    for (const [method, url] of [
      ["GET", "/mcp/oauth/grants"],
      ["POST", "/mcp/oauth/grants/db_mcp_client_whatever/revoke"],
      ["POST", "/mcp/oauth/grants/revoke-all"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("login_required");
    }
  });

  it("revokes both the access and the refresh token of one client immediately, and GET /grants stops listing it", async () => {
    const grant = await connectedGrant("rev-dash");
    const listed = await app.inject({ method: "GET", url: "/mcp/oauth/grants", headers: { cookie: grant.cookie } });
    expect(listed.statusCode).toBe(200);
    expect((listed.json().grants as Array<{ clientId: string; scopes: string[] }>).map((g) => g.clientId)).toContain(grant.clientId);

    const res = await app.inject({
      method: "POST",
      url: `/mcp/oauth/grants/${grant.clientId}/revoke`,
      headers: { cookie: grant.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: true });

    // Both credential kinds stop working on the very next request.
    expect((await mcpProbe(grant.access)).statusCode).toBe(401);
    expect((await refresh({ clientId: grant.clientId, refreshToken: grant.refreshToken })).statusCode).toBe(400);
    expect(await liveAccessTokens(grant.userId, grant.clientId)).toBe(0);
    expect(await liveRefreshTokens(grant.userId, grant.clientId)).toBe(0);

    const after = await app.inject({ method: "GET", url: "/mcp/oauth/grants", headers: { cookie: grant.cookie } });
    expect((after.json().grants as Array<{ clientId: string }>).map((g) => g.clientId)).not.toContain(grant.clientId);

    const revokedEvent = await prisma.oAuthAuditEvent.findFirst({ where: { clientId: grant.clientId, action: "grant.revoked" } });
    expect(revokedEvent).not.toBeNull();
    expect(revokedEvent!.userId).toBe(grant.userId);
    expect(revokedEvent!.metadata).toMatchObject({ accessTokens: 1, refreshTokens: 1 });
  });

  it("is user-scoped: user B cannot revoke user A's grant on the same client", async () => {
    const victim = await connectedGrant("rev-scope-a");
    const attacker = await signupVerified("rev-scope-b");

    const res = await app.inject({
      method: "POST",
      url: `/mcp/oauth/grants/${victim.clientId}/revoke`,
      headers: { cookie: attacker.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: false });

    expect(await liveAccessTokens(victim.userId, victim.clientId)).toBe(1);
    expect(ok(await refresh({ clientId: victim.clientId, refreshToken: victim.refreshToken }))).toBe(true);

    // Nor via revoke-all, which is scoped to the caller's own user id.
    const all = await app.inject({ method: "POST", url: "/mcp/oauth/grants/revoke-all", headers: { cookie: attacker.cookie } });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ revoked: false, accessTokens: 0, refreshTokens: 0 });
    expect(await liveRefreshTokens(victim.userId, victim.clientId)).toBe(1);
  });

  it("revoke-all disconnects every client of the caller and reports the counts", async () => {
    const user = await signupVerified("rev-all");
    const clients = await Promise.all([registerClient("rev-all c1"), registerClient("rev-all c2")]);
    const tokens: Array<{ clientId: string; access: string; refreshToken: string }> = [];
    for (const clientId of clients) {
      const { code, verifier } = await authorizedCode({ clientId, cookie: user.cookie, scope: "read" });
      const res = await exchangeCode({ clientId, code, verifier });
      expect(res.statusCode).toBe(200);
      tokens.push({ clientId, access: res.json().access_token, refreshToken: res.json().refresh_token });
    }

    const res = await app.inject({ method: "POST", url: "/mcp/oauth/grants/revoke-all", headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ revoked: true, accessTokens: 2, refreshTokens: 2 });

    for (const token of tokens) {
      expect((await mcpProbe(token.access)).statusCode).toBe(401);
      expect((await refresh({ clientId: token.clientId, refreshToken: token.refreshToken })).statusCode).toBe(400);
    }
    const listed = await app.inject({ method: "GET", url: "/mcp/oauth/grants", headers: { cookie: user.cookie } });
    expect(listed.json().grants).toEqual([]);

    const event = await prisma.oAuthAuditEvent.findFirst({ where: { userId: user.userId, action: "grant.revoked_all" } });
    expect(event).not.toBeNull();
    expect(event!.metadata).toMatchObject({ accessTokens: 2, refreshTokens: 2 });
  });

  it("a revoked access token used against /mcp answers 401 with the full RFC 9728 challenge", async () => {
    const grant = await connectedGrant("rev-challenge");
    await app.inject({ method: "POST", url: `/mcp/oauth/grants/${grant.clientId}/revoke`, headers: { cookie: grant.cookie } });

    const res = await mcpProbe(grant.access);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
    const challenge = String(res.headers["www-authenticate"]);
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toMatch(/resource_metadata="/);
    // The challenge advertises the scope set a client should ask for next.
    expect(challenge).toContain('scope="read contribute validate artifact sponsor account"');

    const meta = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" });
    expect(challenge).toContain(`resource_metadata="${meta.json().resource.replace(/\/mcp$/, "")}/.well-known/oauth-protected-resource/mcp"`);
  });
});
