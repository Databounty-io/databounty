// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the rate limit on `POST /mcp/oauth/token`.
 *
 * WHAT REGRESSED BEFORE THIS EXISTED (production, 2026-09-22): this endpoint
 * had NO per-client limit at all. The limiter in `app.ts` only fires on an
 * `Authorization: Bearer` header, and the token endpoint deliberately has none
 * — it serves public PKCE clients that authenticate with a form body. So it
 * fell through to the global per-IP bucket, which is worth nothing on this
 * deployment: `TRUST_PROXY` is unset, so every proxied request arrives as the
 * same Docker gateway address and all clients share one bucket.
 *
 * One contributor's Codex connector held a dead refresh token and replayed it
 * 313 times over nine days, completely unthrottled, re-handshaking against
 * `/mcp` on each attempt.
 *
 * The property that makes the fix safe is the one this file pins down: the
 * tight bucket is keyed on the PRESENTED SECRET, not on the client. Refresh
 * rotation hands a healthy client a different secret every time, so it lands
 * in a fresh bucket on every call and can never be throttled by it, however
 * often it legitimately refreshes. Only a client presenting the SAME dead
 * secret over and over collides with itself. If that distinction ever breaks,
 * the limit starts refusing working clients — hence the second test, which
 * matters more than the first.
 *
 * No OAuth setup here on purpose: the limiter runs before any grant is looked
 * up, so a bogus secret exercises exactly the same path a dead real one does,
 * and the test stays independent of the consent flow.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Unique per test so one test's buckets can never bleed into another's. */
function freshClientId(label: string) {
  return `test-client-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function tokenRequest(params: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/mcp/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(params).toString(),
  });
}

/**
 * The bucket window is a wall-clock minute, so a burst can straddle a
 * boundary and split its count. Twelve attempts against a limit of five trip
 * it even in the worst split (6/6), which keeps this deterministic rather
 * than occasionally-passing.
 */
const BURST = 12;
const REPLAY_LIMIT = 5;

describe("POST /mcp/oauth/token rate limit", () => {
  it("throttles a client replaying the SAME refresh token", async () => {
    const clientId = freshClientId("replay");
    const deadToken = "db_mcp_rt_a-refresh-token-that-was-already-rotated-away";

    const statuses: number[] = [];
    for (let i = 0; i < BURST; i += 1) {
      const res = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: deadToken,
      });
      statuses.push(res.statusCode);
    }

    // The dead token is refused on its own merits first; what matters is that
    // the refusals STOP being free and become 429s.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    // Everything before the limit bites must have been let through to the
    // grant logic — a limiter that refused from request one would be broken in
    // the other direction.
    expect(statuses.slice(0, REPLAY_LIMIT).every((s) => s !== 429)).toBe(true);
  });

  it("answers a throttled request with an OAuth slow_down body and Retry-After", async () => {
    const clientId = freshClientId("shape");
    const deadToken = "db_mcp_rt_another-dead-token-for-the-response-shape";

    let throttled: Awaited<ReturnType<typeof tokenRequest>> | undefined;
    for (let i = 0; i < BURST && !throttled; i += 1) {
      const res = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: deadToken,
      });
      if (res.statusCode === 429) throttled = res;
    }

    expect(throttled).toBeDefined();
    // `slow_down` is a registered OAuth error code (RFC 8628 §3.5), so a
    // client can act on it. A bare 429 with no OAuth body reads to most
    // clients as an unclassified failure they may retry immediately.
    expect(throttled!.json().error).toBe("slow_down");
    expect(Number(throttled!.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("does NOT throttle a healthy client that rotates its refresh token", async () => {
    // The whole reason the tight limit can be tight. Each rotation presents a
    // DIFFERENT secret, so every attempt lands in its own bucket and the
    // replay limit is never approached — even at a burst far above it.
    const clientId = freshClientId("rotating");

    const statuses: number[] = [];
    for (let i = 0; i < BURST; i += 1) {
      const res = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: `db_mcp_rt_rotated-secret-number-${i}-${Math.random().toString(36).slice(2)}`,
      });
      statuses.push(res.statusCode);
    }

    expect(statuses).not.toContain(429);
  });

  it("still bounds a client that loops on DIFFERENT secrets, via the per-client bucket", async () => {
    // The broad bucket exists for the failure the token-keyed one cannot see:
    // a client that loops by re-authorising and presenting a fresh grant each
    // time. Stubbed low because the real default is 60/min and this asserts
    // the mechanism, not the number. Read per call, so the stub takes effect
    // without rebuilding the app.
    vi.stubEnv("MCP_TOKEN_RATE_LIMIT_PER_MIN", "3");
    const clientId = freshClientId("perclient");

    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: `db_mcp_rt_unique-${i}-${Math.random().toString(36).slice(2)}`,
      });
      statuses.push(res.statusCode);
    }

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("can be switched off entirely", async () => {
    // An operator must be able to disable a limiter that is misbehaving
    // without shipping code. 0 means off for both buckets.
    vi.stubEnv("MCP_TOKEN_RATE_LIMIT_PER_MIN", "0");
    vi.stubEnv("MCP_TOKEN_REPLAY_LIMIT_PER_MIN", "0");
    const clientId = freshClientId("disabled");
    const deadToken = "db_mcp_rt_same-token-every-time-but-limiter-is-off";

    const statuses: number[] = [];
    for (let i = 0; i < BURST; i += 1) {
      const res = await tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: deadToken,
      });
      statuses.push(res.statusCode);
    }

    expect(statuses).not.toContain(429);
  });

  it("rejects a request with no client_id before it reaches the limiter", async () => {
    // Ordering guard: the limiter keys on `client_id`, so the endpoint's own
    // `invalid_client` check must stay in front of it. If it ever moved, an
    // anonymous caller would be bucketed under an empty key — one shared
    // bucket for every unidentified request.
    const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: "whatever" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
  });
});
