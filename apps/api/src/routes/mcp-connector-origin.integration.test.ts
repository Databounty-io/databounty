// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the `/mcp` origin gate and the hosted-connector allowlist.
 *
 * WHAT REGRESSED BEFORE THIS EXISTED: `handleMcpByEra` gated `/mcp` on
 * `config.corsOrigins` alone (routes/mcp.ts), so ANY request carrying an
 * `Origin` the credentialed-CORS allowlist did not contain was refused 403
 * BEFORE authentication ran. v1 has no origin check on `/mcp` at all, so this
 * was the one place this port could reject a client v1 would have accepted —
 * and a hosted connector (ChatGPT, claude.ai) attaches its own Origin
 * automatically. Symptom: OAuth works from a native client and fails from a
 * hosted one, with no auth error to explain it.
 *
 * The gate is kept — it is DNS-rebinding defense-in-depth for a future
 * browser-embedded client — but hosted connector origins now come from a
 * SEPARATE list. That separation is the point of this file: admitting an
 * origin to `/mcp` must not admit it to credentialed CORS across the whole
 * API, which is what putting it in `CORS_ORIGINS` would have done.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { config } from "../config.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** A well-formed JSON-RPC POST. Never authenticated here — every assertion is
 * about whether the request reaches the auth layer at all. */
function post(origin?: string) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
}

const ORIGIN_REFUSED = 403;

describe("/mcp origin gate", () => {
  it("ships a hosted-connector allowlist that is NOT the credentialed-CORS list", () => {
    // The security property this whole change rests on. If these ever become
    // the same list, admitting a connector silently grants it cookie-bearing
    // access to every endpoint on the API.
    expect(config.mcpAllowedOrigins).not.toBe(config.corsOrigins);
    for (const origin of config.mcpAllowedOrigins) {
      expect(config.corsOrigins).not.toContain(origin);
    }
  });

  it("lets a request with NO Origin through to authentication", async () => {
    // Native clients (Claude Code, Codex, mcp-remote) send no Origin. The gate
    // must never require one.
    const res = await post();
    expect(res.statusCode).not.toBe(ORIGIN_REFUSED);
  });

  it("lets the ChatGPT connector origin reach authentication instead of 403ing it", async () => {
    // The regression. Previously 403 before any credential was examined.
    const res = await post("https://chatgpt.com");
    expect(res.statusCode).not.toBe(ORIGIN_REFUSED);
  });

  it("lets the claude.ai connector origin reach authentication", async () => {
    const res = await post("https://claude.ai");
    expect(res.statusCode).not.toBe(ORIGIN_REFUSED);
  });

  it("still refuses an origin on neither list", async () => {
    // The gate is narrowed, not removed: an unknown browser origin is still
    // refused, which is the DNS-rebinding case it exists for.
    const res = await post("https://evil.example.com");
    expect(res.statusCode).toBe(ORIGIN_REFUSED);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("refuses an origin that merely CONTAINS an allowed one as a substring", async () => {
    // `chatgpt.com.evil.example` and `https://chatgpt.com.evil.example` must
    // not pass — the check is exact membership, not a prefix or substring test.
    for (const spoof of ["https://chatgpt.com.evil.example", "https://notchatgpt.com", "https://evil.com?x=chatgpt.com"]) {
      const res = await post(spoof);
      expect(res.statusCode, `${spoof} must be refused`).toBe(ORIGIN_REFUSED);
    }
  });

  it("keeps admitting the app's own configured origins", async () => {
    const own = config.corsOrigins[0];
    expect(own).toBeTruthy();
    const res = await post(own);
    expect(res.statusCode).not.toBe(ORIGIN_REFUSED);
  });
});

/**
 * WHAT REGRESSED BEFORE THIS EXISTED: `Mcp-Session-Id` was not in
 * `Access-Control-Expose-Headers`. The server mints that id on `initialize` and
 * `handleMcp` reads it back off every later request, but a browser only lets
 * script read a response header that is explicitly exposed. A cross-origin
 * client therefore could not echo the id: every call after `initialize` arrived
 * as a NEW uninitialized session and the SDK answered `tools/list` with
 * "Server not initialized".
 *
 * The symptom is deceptive, which is why it survived: the connection reports
 * SUCCESS — `initialize` genuinely returns 200 — and then the tool list is just
 * empty. Native clients read raw headers with no CORS layer involved, so they
 * were never affected; it presented as "works in one client, no tools in
 * another".
 */
/**
 * First configured CORS origin, asserted present.
 *
 * `config.corsOrigins` is a `string[]`, and under `noUncheckedIndexedAccess`
 * indexing it yields `string | undefined` — not assignable to
 * `preflight(origin: string)`, which is what broke `tsc` at the four call
 * sites below. A `!` would silence that; this throws instead, because an
 * empty `corsOrigins` would make every assertion in this block vacuous: a
 * preflight sent with no Origin header is not the case under test, and it
 * would pass for the wrong reason rather than fail.
 */
function ownOrigin(): string {
  const origin = config.corsOrigins[0];
  if (!origin) {
    throw new Error("config.corsOrigins is empty — this suite needs at least one configured origin to preflight against");
  }
  return origin;
}

describe("MCP session header exposure", () => {
  async function preflight(origin: string) {
    return app.inject({
      method: "OPTIONS",
      url: "/mcp",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,mcp-session-id",
      },
    });
  }

  it("exposes Mcp-Session-Id so a cross-origin client can echo it back", async () => {
    const res = await preflight(ownOrigin());
    const exposed = String(res.headers["access-control-expose-headers"] ?? "").toLowerCase();
    // Without this the sessionful handshake cannot complete cross-origin.
    expect(exposed).toContain("mcp-session-id");
  });

  it("exposes WWW-Authenticate so a 401 can start the OAuth flow", async () => {
    // Carries the resource_metadata pointer and scope list the client needs.
    const res = await preflight(ownOrigin());
    const exposed = String(res.headers["access-control-expose-headers"] ?? "").toLowerCase();
    expect(exposed).toContain("www-authenticate");
  });

  it("exposes MCP-Protocol-Version for revision negotiation", async () => {
    const res = await preflight(ownOrigin());
    const exposed = String(res.headers["access-control-expose-headers"] ?? "").toLowerCase();
    expect(exposed).toContain("mcp-protocol-version");
  });

  it("still allows the session header on the REQUEST side", async () => {
    const res = await preflight(ownOrigin());
    const allowed = String(res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowed).toContain("mcp-session-id");
    expect(allowed).toContain("authorization");
  });
});
