// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-04 regression. The global limiter's key generator used to hash ANY
 * bearer string carrying a recognised credential prefix, so a caller could
 * invent a fresh `db_live_sk_…`-shaped string per request and get a fresh
 * bucket each time. The review's executed evidence: at a limit of two, four
 * anonymous requests from one IP returned 200, 200, 429, 429, while four
 * requests rotating invalid API-key-shaped strings returned 200 four times.
 *
 * These tests pin both halves of the layered fix:
 *   - invented (unvalidated) credentials cannot escape the source-IP bucket,
 *     on public routes and on the auth routes that inherit the key generator
 *     through their route-level `config.rateLimit`;
 *   - two genuinely distinct VALIDATED clients still get independent quotas,
 *     which is the NAT / two-MCP-clients-on-one-machine regression that
 *     per-credential keying was introduced to fix and must not come back.
 *
 * Plugin-level, with NO database and NO network: the harness registers
 * `@fastify/rate-limit` with the real `rateLimitKey` and stands in for
 * `app.ts`'s credential hook with an explicit set of "valid" tokens, calling
 * the same `noteValidatedCredential` the real hook calls after
 * `verifyApiKey` / `verifyMcpAccessToken` succeeds. Shape follows
 * `docs/private/operations/community-security-evidence/probe.cjs`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { KEY_PREFIX } from "../services/api-keys.js";
import { MCP_ACCESS_TOKEN_PREFIX } from "../services/mcp-oauth.js";
import {
  credentialFingerprint,
  noteValidatedCredential,
  rateLimitKey,
  resetValidatedCredentials,
} from "./rate-limit-key.js";

const IP = "203.0.113.7";
const OTHER_IP = "203.0.113.8";

/** Distinct random tokens of the shapes the key generator recognises. Random
 * per call, exactly like a caller rotating invented strings. */
function inventedApiKey(): string {
  return `${KEY_PREFIX}${Math.random().toString(36).slice(2)}${Date.now()}`;
}
function inventedMcpToken(): string {
  return `${MCP_ACCESS_TOKEN_PREFIX}${Math.random().toString(36).slice(2)}${Date.now()}`;
}

interface Probe {
  app: FastifyInstance;
  logLines: string[];
}

/**
 * Minimal stand-in for `app.ts`: the global limiter keyed by `rateLimitKey`,
 * followed by the credential hook that is the only thing allowed to promote a
 * token to its own bucket.
 */
async function buildProbe(max: number, validTokens: Set<string>): Promise<Probe> {
  const logLines: string[] = [];
  const app = Fastify({
    logger: {
      level: "info",
      stream: {
        write(line: string) {
          logLines.push(line);
        },
      },
    },
  });

  await app.register(rateLimit, { global: true, max, timeWindow: 60_000, keyGenerator: rateLimitKey });

  app.addHook("onRequest", async (req) => {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return;
    const token = auth.slice("Bearer ".length);
    if (!token.startsWith(KEY_PREFIX) && !token.startsWith(MCP_ACCESS_TOKEN_PREFIX)) return;
    // Mirrors app.ts: only a SUCCESSFUL server-side verification promotes.
    if (!validTokens.has(token)) return;
    noteValidatedCredential(token);
  });

  app.get("/v1/pools", async () => ({ ok: true })); // public route
  app.get("/v1/me", async () => ({ ok: true })); // bearer-authenticated route
  // Auth routes carry their own route-level limiter settings and inherit the
  // global key generator — the inheritance the review called out.
  app.post("/v1/auth/login", { config: { rateLimit: { max, timeWindow: "1 minute" } } }, async () => ({ ok: true }));

  return { app, logLines };
}

type Request = { url: string; method?: "GET" | "POST"; token?: string; ip?: string };

async function statuses(app: FastifyInstance, requests: Request[]): Promise<number[]> {
  const out: number[] = [];
  for (const r of requests) {
    const res = await app.inject({
      method: r.method ?? "GET",
      url: r.url,
      remoteAddress: r.ip ?? IP,
      headers: r.token ? { authorization: `Bearer ${r.token}` } : {},
    });
    out.push(res.statusCode);
  }
  return out;
}

function repeat(n: number, make: (i: number) => Request): Request[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

describe("rateLimitKey — SEC-04 invented-credential bypass", () => {
  beforeEach(() => {
    resetValidatedCredentials();
  });

  it("anonymous requests from one IP share one bucket (the baseline the review measured)", async () => {
    const { app } = await buildProbe(2, new Set());
    expect(await statuses(app, repeat(4, () => ({ url: "/v1/pools" })))).toEqual([200, 200, 429, 429]);
    await app.close();
  });

  it("rotating random INVALID API-key-shaped bearer strings cannot escape the IP bucket", async () => {
    const { app } = await buildProbe(2, new Set());
    expect(await statuses(app, repeat(4, () => ({ url: "/v1/pools", token: inventedApiKey() })))).toEqual([
      200, 200, 429, 429,
    ]);
    await app.close();
  });

  it("rotating random INVALID MCP-token-shaped bearer strings cannot escape the IP bucket", async () => {
    const { app } = await buildProbe(2, new Set());
    expect(await statuses(app, repeat(4, () => ({ url: "/v1/pools", token: inventedMcpToken() })))).toEqual([
      200, 200, 429, 429,
    ]);
    await app.close();
  });

  it("anonymous and invented-credential requests from one IP count against the SAME bucket", async () => {
    const { app } = await buildProbe(2, new Set());
    expect(
      await statuses(app, [
        { url: "/v1/pools" },
        { url: "/v1/pools", token: inventedApiKey() },
        { url: "/v1/me", token: inventedMcpToken() },
      ]),
    ).toEqual([200, 200, 429]);
    await app.close();
  });

  it("auth routes stay IP-bucketed against rotating invented credentials", async () => {
    const { app } = await buildProbe(2, new Set());
    expect(
      await statuses(
        app,
        repeat(4, () => ({ url: "/v1/auth/login", method: "POST" as const, token: inventedApiKey() })),
      ),
    ).toEqual([200, 200, 429, 429]);
    await app.close();
  });

  it("auth routes stay IP-bucketed even for a VALIDATED credential", async () => {
    const valid = `${KEY_PREFIX}real_client_auth`;
    const { app } = await buildProbe(2, new Set([valid]));
    noteValidatedCredential(valid);
    expect(await statuses(app, [{ url: "/v1/me", token: valid }])).toEqual([200]);
    expect(rateLimitKey({ url: "/v1/me", ip: IP, headers: { authorization: `Bearer ${valid}` } } as never)).toBe(
      `k:${credentialFingerprint(valid)}`,
    );
    // Same credential on an auth route must fall back to the IP bucket.
    expect(
      rateLimitKey({ url: "/v1/auth/login", ip: IP, headers: { authorization: `Bearer ${valid}` } } as never),
    ).toBe(`ip:${IP}`);
    await app.close();
  });

  it("two genuinely distinct VALID clients behind one IP keep independent quotas", async () => {
    const clientA = `${KEY_PREFIX}client_a_real`;
    const clientB = `${MCP_ACCESS_TOKEN_PREFIX}client_b_real`;
    const { app } = await buildProbe(4, new Set([clientA, clientB]));
    // Seeded directly so the assertion does not depend on hook ordering (see
    // the ordering test below): both credentials are already server-validated.
    noteValidatedCredential(clientA);
    noteValidatedCredential(clientB);

    // A full quota each, and neither exhausts the other. Under per-IP-only
    // keying these would have 429'd each other — the NAT / two-MCP-clients
    // regression that must stay fixed.
    expect(await statuses(app, repeat(4, () => ({ url: "/v1/me", token: clientA })))).toEqual([200, 200, 200, 200]);
    expect(await statuses(app, repeat(4, () => ({ url: "/v1/me", token: clientB })))).toEqual([200, 200, 200, 200]);

    // And the IP bucket was NOT consumed or widened by any of it.
    expect(await statuses(app, repeat(5, () => ({ url: "/v1/pools" })))).toEqual([200, 200, 200, 200, 429]);
    await app.close();
  });

  it("a validated credential's bucket does not leak to a different (invented) token", async () => {
    const valid = `${KEY_PREFIX}client_valid_only`;
    const { app } = await buildProbe(2, new Set([valid]));
    noteValidatedCredential(valid);
    // The validated credential spends its own bucket...
    expect(await statuses(app, repeat(2, () => ({ url: "/v1/me", token: valid })))).toEqual([200, 200]);
    // ...while invented tokens remain on the IP bucket regardless.
    expect(
      await statuses(app, repeat(3, () => ({ url: "/v1/pools", token: inventedApiKey() }))),
    ).toEqual([200, 200, 429]);
    await app.close();
  });

  it("the credential hook runs before the route-level limiter, so a valid client is bucketed from its first request", async () => {
    // Documented because it is load-bearing for the UX half of the design but
    // NOT for the security half: if Fastify ever ran the limiter first, an
    // unrecognised-but-valid credential's first request would simply be
    // counted against its IP, which is the conservative default. Instance
    // `onRequest` hooks (app.ts's credential hook) run ahead of route-level
    // ones, and @fastify/rate-limit attaches its check per route.
    const valid = `${KEY_PREFIX}first_request_client`;
    const { app } = await buildProbe(2, new Set([valid]));
    // Two anonymous requests exhaust the IP bucket.
    expect(await statuses(app, repeat(2, () => ({ url: "/v1/pools" })))).toEqual([200, 200]);
    // The valid client is unaffected: it is already on its own bucket.
    expect(await statuses(app, repeat(2, () => ({ url: "/v1/me", token: valid })))).toEqual([200, 200]);
    // An invented one is not.
    expect(await statuses(app, [{ url: "/v1/pools", token: inventedApiKey() }])).toEqual([429]);
    await app.close();
  });

  it("distinct source IPs keep distinct buckets", async () => {
    const { app } = await buildProbe(2, new Set());
    expect(await statuses(app, repeat(3, () => ({ url: "/v1/pools" })))).toEqual([200, 200, 429]);
    expect(await statuses(app, repeat(2, () => ({ url: "/v1/pools", ip: OTHER_IP })))).toEqual([200, 200]);
    await app.close();
  });

  it("never puts a raw token in a limiter key, validated or not", async () => {
    const valid = `${KEY_PREFIX}sensitive_secret_value`;
    const invented = inventedApiKey();
    const mcp = `${MCP_ACCESS_TOKEN_PREFIX}another_sensitive_value`;
    noteValidatedCredential(valid);
    noteValidatedCredential(mcp);

    for (const token of [valid, invented, mcp]) {
      const key = rateLimitKey({ url: "/v1/me", ip: IP, headers: { authorization: `Bearer ${token}` } } as never);
      expect(key).not.toContain(token);
      expect(key).not.toContain(token.slice(KEY_PREFIX.length));
      expect(key).toMatch(/^(ip:|k:[0-9a-f]{32}$)/);
    }
  });

  it("never logs a raw token while limiting", async () => {
    const valid = `${KEY_PREFIX}logged_secret_value`;
    const { app, logLines } = await buildProbe(2, new Set([valid]));
    const invented = inventedApiKey();
    await statuses(app, [
      { url: "/v1/me", token: valid },
      { url: "/v1/me", token: valid },
      { url: "/v1/pools", token: invented },
      { url: "/v1/pools", token: invented },
      { url: "/v1/pools", token: invented },
    ]);
    const log = logLines.join("\n");
    expect(log).not.toContain(valid);
    expect(log).not.toContain(invented);
    await app.close();
  });
});
