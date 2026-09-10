// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Client ID Metadata Documents (CIMD) through the real app and the real
 * database: a client that identifies itself with an https URL instead of a
 * dynamically-registered id, driven end to end through `/mcp/oauth/authorize`,
 * the consent-page read, approval and token exchange.
 *
 * The metadata document fetch and the DNS lookup are stubbed through the
 * service's own seams — no network — while everything else (Fastify, Prisma,
 * Postgres, session cookies) is real. Self-guards like every other integration
 * test: refuses to run unless DATABASE_URL names a disposable local database.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const CLIENT_URL = "https://agent-cli.example/oauth/client-metadata";
const CLIENT_NAME = "Example Agent CLI";
const LOOPBACK_REDIRECT = "http://127.0.0.1:41234/callback";
const PUBLIC_ADDR = [{ address: "93.184.216.34", family: 4 }];

type FetchStub = (url: string) => Response | Promise<Response>;
let stub: FetchStub;
let fetched: string[];

function metadataDocument(overrides: Record<string, unknown> = {}, url = CLIENT_URL) {
  return {
    client_id: url,
    client_name: CLIENT_NAME,
    redirect_uris: [LOOPBACK_REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  setClientMetadataFetch(null);
  setClientMetadataDnsLookup(null);
  clearClientMetadataCache();
  await app.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  clearClientMetadataCache();
  fetched = [];
  stub = (url) => json(metadataDocument({}, url));
  setClientMetadataDnsLookup(async () => PUBLIC_ADDR);
  setClientMetadataFetch(async (url) => {
    fetched.push(url);
    return stub(url);
  });
});

afterEach(() => {
  clearClientMetadataCache();
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

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorize(query: Record<string, string | undefined>) {
  return app.inject({
    method: "GET",
    url: "/mcp/oauth/authorize",
    query: Object.fromEntries(Object.entries(query).filter((e): e is [string, string] => typeof e[1] === "string")),
  });
}

describe("RFC 8414 metadata advertises CIMD and RFC 9207", () => {
  it("sets client_id_metadata_document_supported and the companion fields", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server/mcp" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
    expect(body.response_modes_supported).toEqual(["query"]);
    expect(body.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
    // Dynamic registration is still offered alongside — CIMD is additive.
    expect(body.registration_endpoint).toMatch(/\/mcp\/oauth\/register$/);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("serves the same flags on every alias", async () => {
    for (const path of ["/mcp/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server"]) {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.json().client_id_metadata_document_supported).toBe(true);
    }
  });
});

describe("authorize with a URL client_id", () => {
  it("fetches the document, mirrors the client, and redirects to the consent page; the consent read shows the document's name and host", async () => {
    const { challenge, verifier } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: CLIENT_URL,
      redirect_uri: LOOPBACK_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "read contribute",
      state: "xyz",
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.pathname).toMatch(/\/mcp\/authorize$/);
    const requestId = location.searchParams.get("request_id");
    expect(requestId).toBeTruthy();
    expect(fetched).toEqual([CLIENT_URL]);

    // The URL client is now a real oauth_clients row keyed on the URL, so the
    // FK-linked authorization request resolves to it.
    const stored = await prisma.oAuthClient.findUnique({ where: { clientId: CLIENT_URL } });
    expect(stored).not.toBeNull();
    expect(stored!.clientName).toBe(CLIENT_NAME);
    expect(stored!.redirectUris).toEqual([LOOPBACK_REDIRECT]);
    expect(stored!.tokenEndpointAuthMethod).toBe("none");

    // Consent read is session-gated.
    const anon = await app.inject({ method: "GET", url: `/mcp/oauth/request/${requestId}` });
    expect(anon.statusCode).toBe(401);

    const { cookie, userId } = await signupVerified("cimd");
    const consent = await app.inject({ method: "GET", url: `/mcp/oauth/request/${requestId}`, headers: { cookie } });
    expect(consent.statusCode).toBe(200);
    const body = consent.json();
    expect(body.clientName).toBe(CLIENT_NAME);
    expect(body.clientIdHost).toBe("agent-cli.example");
    expect(body.localhostOnlyRedirect).toBe(true);
    expect(body.clientRedirectHosts).toEqual(["127.0.0.1:41234"]);
    expect(body.scopes).toEqual(["read", "contribute"]);
    expect(body.redirectUri).toBe(LOOPBACK_REDIRECT);
    // Reading the consent page never re-fetches the document.
    expect(fetched).toEqual([CLIENT_URL]);

    // Approve → code → exchange with the URL client_id → tokens that work.
    const approved = await app.inject({
      method: "POST",
      url: `/mcp/oauth/request/${requestId}/approve`,
      headers: { cookie, origin: "http://localhost:3000" },
      payload: { scopes: ["read"] },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe("xyz");
    expect(approved.json().issuer).toMatch(/\/mcp$/);
    const code = approved.json().code as string;

    const token = await app.inject({
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_URL,
        code,
        code_verifier: verifier,
        redirect_uri: LOOPBACK_REDIRECT,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    expect(token.json().access_token).toMatch(/^db_mcp_at_/);
    expect(token.json().scope).toBe("read");

    const grants = await app.inject({ method: "GET", url: "/mcp/oauth/grants", headers: { cookie } });
    expect(grants.statusCode).toBe(200);
    const grant = (grants.json().grants as Array<{ clientId: string; clientName: string }>).find((g) => g.clientId === CLIENT_URL);
    expect(grant?.clientName).toBe(CLIENT_NAME);

    // Refresh through the URL client id too.
    const refreshed = await app.inject({
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_URL, refresh_token: token.json().refresh_token }).toString(),
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().access_token).toMatch(/^db_mcp_at_/);

    await prisma.user.delete({ where: { id: userId } });
  });

  it("accepts a loopback redirect whose port differs from the registered one (RFC 8252 §7.3)", async () => {
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: CLIENT_URL,
      redirect_uri: "http://127.0.0.1:59999/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get("request_id")).toBeTruthy();
  });

  it("refreshes the mirrored row when the document changes after the cache expires", async () => {
    const { challenge } = pkce();
    await authorize({ response_type: "code", client_id: CLIENT_URL, redirect_uri: LOOPBACK_REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    clearClientMetadataCache();
    stub = (url) => json(metadataDocument({ client_name: "Renamed Agent", redirect_uris: [LOOPBACK_REDIRECT, "https://agent-cli.example/cb"] }, url));
    const again = await authorize({ response_type: "code", client_id: CLIENT_URL, redirect_uri: "https://agent-cli.example/cb", code_challenge: challenge, code_challenge_method: "S256" });
    expect(again.statusCode).toBe(302);
    const stored = await prisma.oAuthClient.findUnique({ where: { clientId: CLIENT_URL } });
    expect(stored!.clientName).toBe("Renamed Agent");
    expect(stored!.redirectUris).toContain("https://agent-cli.example/cb");
    expect(fetched).toHaveLength(2);
  });
});

describe("real-world client documents", () => {
  it("accepts Claude Code's document: a port-less loopback redirect matched against the ephemeral port it actually listens on", async () => {
    // Verbatim shape of https://claude.ai/oauth/claude-code-client-metadata.
    // It registers `http://localhost/callback` but calls back on a port the
    // CLI picks at run time, so the registration would never match without
    // RFC 8252 §7.3 port-agnostic loopback comparison.
    const url = "https://claude-code.example/oauth/client-metadata";
    stub = () =>
      json({
        client_id: url,
        client_name: "Example Code CLI",
        client_uri: "https://claude-code.example",
        redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: url,
      redirect_uri: "http://localhost:53076/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "read",
    });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get("request_id")).toBeTruthy();
  });

  it("accepts a document declaring non-secret client authentication, records it as a public client, and still refuses a client_secret at the token endpoint", async () => {
    // `token_endpoint_auth_method` is the client's own declaration; the CIMD
    // draft forbids only shared-secret methods, so `private_key_jwt` must not
    // cost the client its registration. It is normalised to "none" because
    // that is all this server advertises — and the token endpoint proves the
    // normalisation is not a downgrade by refusing a presented secret.
    const url = "https://asymmetric-cli.example/oauth/client-metadata";
    stub = () => json(metadataDocument({ token_endpoint_auth_method: "private_key_jwt" }, url));
    const { challenge, verifier } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: url,
      redirect_uri: LOOPBACK_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "read",
    });
    expect(res.statusCode).toBe(302);
    const requestId = new URL(res.headers.location as string).searchParams.get("request_id");
    expect(await prisma.oAuthClient.findUnique({ where: { clientId: url } })).toMatchObject({ tokenEndpointAuthMethod: "none" });

    const { cookie, userId } = await signupVerified("cimd-asym");
    const approved = await app.inject({
      method: "POST",
      url: `/mcp/oauth/request/${requestId}/approve`,
      headers: { cookie, origin: "http://localhost:3000" },
      payload: { scopes: ["read"] },
    });
    expect(approved.statusCode).toBe(200);
    const code = approved.json().code as string;

    const withSecret = await app.inject({
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: url,
        client_secret: "pretend-secret",
        code,
        code_verifier: verifier,
        redirect_uri: LOOPBACK_REDIRECT,
      }).toString(),
    });
    expect(withSecret.statusCode).toBe(401);
    expect(withSecret.json().error).toBe("invalid_client");

    // The code survived the refusal, and PKCE alone redeems it.
    const withoutSecret = await app.inject({
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: url,
        code,
        code_verifier: verifier,
        redirect_uri: LOOPBACK_REDIRECT,
      }).toString(),
    });
    expect(withoutSecret.statusCode).toBe(200);
    expect(withoutSecret.json().access_token).toMatch(/^db_mcp_at_/);

    await prisma.user.delete({ where: { id: userId } });
  });
});

describe("authorize rejections", () => {
  it("still answers 401 invalid_client for an unknown opaque client_id (no fetch attempted)", async () => {
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: "db_mcp_client_does_not_exist",
      redirect_uri: LOOPBACK_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
    expect(fetched).toHaveLength(0);
  });

  it("answers 401 invalid_client, as JSON (never a redirect), when the document cannot be fetched", async () => {
    stub = () => json({ error: "not found" }, 404);
    const url = "https://missing.example/oauth/client-metadata";
    const { challenge } = pkce();
    const res = await authorize({ response_type: "code", client_id: url, redirect_uri: LOOPBACK_REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
    expect(res.json().error_description).toMatch(/HTTP 404/);
    expect(await prisma.oAuthClient.findUnique({ where: { clientId: url } })).toBeNull();
  });

  it("answers 401 invalid_client when the document's client_id does not match the URL", async () => {
    const url = "https://mismatch.example/oauth/client-metadata";
    stub = () => json(metadataDocument({}, "https://mismatch.example/oauth/other"));
    const { challenge } = pkce();
    const res = await authorize({ response_type: "code", client_id: url, redirect_uri: LOOPBACK_REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
    expect(res.json().error_description).toMatch(/client_id/);
  });

  it("answers 401 invalid_client when the client_id host resolves to a private address, and never fetches", async () => {
    setClientMetadataDnsLookup(async () => [{ address: "10.1.2.3", family: 4 }]);
    const url = "https://internal-only.example/oauth/client-metadata";
    const { challenge } = pkce();
    const res = await authorize({ response_type: "code", client_id: url, redirect_uri: LOOPBACK_REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
    expect(fetched).toHaveLength(0);
  });

  it("answers 401 invalid_client for a plain-http client_id URL (not a metadata URL, not a registered id)", async () => {
    const { challenge } = pkce();
    const res = await authorize({ response_type: "code", client_id: "http://agent-cli.example/oauth/client-metadata", redirect_uri: LOOPBACK_REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
    expect(fetched).toHaveLength(0);
  });

  it("rejects a redirect_uri absent from the document with a JSON 400 — no redirect to an unregistered URI", async () => {
    const { challenge } = pkce();
    const res = await authorize({ response_type: "code", client_id: CLIENT_URL, redirect_uri: "https://evil.example/steal", code_challenge: challenge, code_challenge_method: "S256" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("carries the RFC 9207 iss parameter on an error redirect to a registered redirect_uri", async () => {
    const { challenge } = pkce();
    // Prime the client row so the registered-redirect check can pass.
    const primed = await authorize({ response_type: "code", client_id: CLIENT_URL, redirect_uri: LOOPBACK_REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    expect(primed.statusCode).toBe(302);
    const res = await authorize({
      response_type: "code",
      client_id: CLIENT_URL,
      redirect_uri: LOOPBACK_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "not-a-real-scope",
      state: "s1",
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(LOOPBACK_REDIRECT);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("state")).toBe("s1");
    const asm = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server/mcp" });
    expect(location.searchParams.get("iss")).toBe(asm.json().issuer);
  });
});

describe("token endpoint with a URL client_id", () => {
  it("rejects an unknown URL client at the token endpoint with 401 when the document is unreachable and nothing is stored", async () => {
    stub = () => json({}, 503);
    const res = await app.inject({
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "https://never-seen.example/oauth/client-metadata",
        code: "db_mcp_code_bogus",
        code_verifier: randomBytes(32).toString("base64url"),
        redirect_uri: LOOPBACK_REDIRECT,
      }).toString(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
  });

  it("falls back to the stored client at the token endpoint when the document is transiently unreachable", async () => {
    const { challenge, verifier } = pkce();
    const auth = await authorize({ response_type: "code", client_id: CLIENT_URL, redirect_uri: LOOPBACK_REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scope: "read" });
    expect(auth.statusCode).toBe(302);
    const requestId = new URL(auth.headers.location as string).searchParams.get("request_id")!;
    const { cookie, userId } = await signupVerified("cimdfb");
    const approved = await app.inject({ method: "POST", url: `/mcp/oauth/request/${requestId}/approve`, headers: { cookie, origin: "http://localhost:3000" }, payload: { scopes: ["read"] } });
    expect(approved.statusCode).toBe(200);

    clearClientMetadataCache();
    stub = () => json({}, 503);
    const token = await app.inject({
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_URL, code: approved.json().code, code_verifier: verifier, redirect_uri: LOOPBACK_REDIRECT }).toString(),
    });
    expect(token.statusCode).toBe(200);
    expect(token.json().access_token).toMatch(/^db_mcp_at_/);
    await prisma.user.delete({ where: { id: userId } });
  });
});
