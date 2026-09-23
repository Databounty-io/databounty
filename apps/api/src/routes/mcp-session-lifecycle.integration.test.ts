// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for `/mcp` streamable-HTTP SESSION LIFECYCLE — creation, the answer
 * given for a session id this process does not hold, and the bound on how many
 * sessions one credential may pin.
 *
 * WHAT REGRESSED BEFORE THIS EXISTED (production, 2026-09-22): the session map
 * in `routes/mcp.ts` only ever shrank by `sessions.delete(id)`. Nothing called
 * `transport.close()`, so the hijacked response socket, the transport, the
 * `McpServer` holding the whole tool catalog, and the per-SSE-stream keep-alive
 * `setInterval` all stayed resident for the life of the process. Expiry was
 * also checked only inside `handleMcp`, so a client that went silent was never
 * swept at all. Hundreds of connections accumulated and only a container
 * restart cleared them.
 *
 * Two protocol-level mistakes turned one stuck client into that pile, and they
 * are what this file pins down:
 *
 *  1. An unrecognised session id was answered `400`. MCP 2025-06-18 Streamable
 *     HTTP §Session Management requires `404`, and item 4 makes 404 the
 *     client's instruction to re-initialize. A compliant client given 400 has
 *     no such instruction and retries the dead id.
 *  2. A POST carrying that dead id fell through to the session-creation branch.
 *     The SDK rejects a non-initialize request on a transport that has not been
 *     initialized, so the client got an error AND the transport built for it
 *     was orphaned — one more leaked session per retry.
 *
 * These are contract assertions on purpose: the session map is module-private
 * and stays that way, so every fact here is observable over HTTP exactly as a
 * real MCP client would observe it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
let apiKey: string;

const MCP_ACCEPT = "application/json, text/event-stream";

/** A session id that is well-formed but was never issued by this process. */
const UNKNOWN_SESSION_ID = "11111111-2222-4333-8444-555555555555";

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const signup = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `mcp-session-${stamp}@example.com`,
      password: "Test@12345",
      handle: `mcpsession${stamp}`.toLowerCase().slice(0, 20),
      displayName: "MCP Session",
    },
  });
  expect(signup.statusCode).toBe(201);
  const userId = signup.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date(), onboarded: true } });
  const setCookie = signup.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;

  const issued = await app.inject({
    method: "POST",
    url: "/v1/me/api-keys",
    headers: { cookie, origin: "http://localhost:3010" },
    payload: { scopes: ["read"] },
  });
  expect(issued.statusCode).toBe(201);
  apiKey = issued.json().key as string;
});

afterAll(async () => {
  await app.close();
});

function mcp(input: { method: "POST" | "GET" | "DELETE"; sessionId?: string; payload?: unknown }) {
  return app.inject({
    method: input.method,
    url: "/mcp",
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: MCP_ACCEPT,
      ...(input.payload ? { "content-type": "application/json" } : {}),
      ...(input.sessionId ? { "mcp-session-id": input.sessionId } : {}),
    },
    ...(input.payload ? { payload: input.payload } : {}),
  });
}

const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

describe("/mcp session lifecycle", () => {
  it("authenticates before it decides anything about the session", async () => {
    // Guards the ordering the rest of this file depends on: if an unknown
    // session id were answered before credentials were checked, the 404 below
    // would be an unauthenticated probe of which session ids exist.
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: MCP_ACCEPT, "content-type": "application/json", "mcp-session-id": UNKNOWN_SESSION_ID },
      payload: TOOLS_LIST,
    });
    expect(res.statusCode).toBe(401);
  });

  it("answers 404 — not 400 — for a session id it does not hold", async () => {
    // MCP 2025-06-18 §Session Management item 3: a server that has terminated a
    // session "MUST respond to requests containing that session ID with HTTP
    // 404 Not Found". Item 4 makes that the client's cue to re-initialize.
    // This used to be 400, which instructs a compliant client to do nothing.
    const res = await mcp({ method: "POST", sessionId: UNKNOWN_SESSION_ID, payload: TOOLS_LIST });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("session_not_found");
  });

  it("answers 404 for an unknown session id on GET and DELETE too", async () => {
    // The status must not depend on the verb — a client resuming its SSE stream
    // (GET) after a sweep needs the same re-initialize signal a POST gets.
    for (const method of ["GET", "DELETE"] as const) {
      const res = await mcp({ method, sessionId: UNKNOWN_SESSION_ID });
      expect(res.statusCode, `${method} with an unknown session id`).toBe(404);
    }
  });

  it("does NOT mint a session for a POST that carries an unknown session id", async () => {
    // The leak amplifier. Creation must happen only for a POST with NO session
    // id; a POST presenting a dead one previously built a transport, failed the
    // request anyway, and left that transport behind — every single retry.
    //
    // Observable proof that no session was created: the response is the 404
    // above rather than anything the SDK produces, and it carries no
    // `mcp-session-id` header, which is the only way a caller could ever learn
    // about a session this process had built.
    const res = await mcp({ method: "POST", sessionId: UNKNOWN_SESSION_ID, payload: TOOLS_LIST });
    expect(res.statusCode).toBe(404);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("answers 400 when a non-initialize request carries no session id at all", async () => {
    // Same spec section, item 2: "Servers that require a session ID SHOULD
    // respond to requests without an Mcp-Session-Id header (other than
    // initialization) with HTTP 400 Bad Request". A missing id is a malformed
    // request; a stale id is a terminated session. They are different answers
    // and a client acts on them differently.
    const res = await mcp({ method: "GET" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_session");
  });

  it("still refuses a session id bound to a different credential with 401", async () => {
    // Pre-existing security behaviour that the 404 branch must not have
    // swallowed: binding is checked BEFORE the unknown-session branch, so a
    // leaked session id presented by another credential is refused as a
    // credential problem, never answered as if the session simply expired.
    const other = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer db_live_definitely-not-a-real-key",
        accept: MCP_ACCEPT,
        "content-type": "application/json",
        "mcp-session-id": UNKNOWN_SESSION_ID,
      },
      payload: TOOLS_LIST,
    });
    // An unusable credential never reaches the session layer at all.
    expect(other.statusCode).toBe(401);
  });
});
