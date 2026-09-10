// SPDX-License-Identifier: Apache-2.0

import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { isHttpError } from "http-errors";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { v1Routes } from "./routes/v1/index.js";
import { mcpPlugin } from "./mcp/server.js";
import { mcpRoutes } from "./routes/mcp.js";
import { verifyApiKey, KEY_PREFIX } from "./services/api-keys.js";
import { MCP_ACCESS_TOKEN_PREFIX, verifyMcpAccessToken } from "./services/mcp-oauth.js";
import { checkAndIncrement } from "./lib/mcp-rate-limit.js";
import { noteValidatedCredential, rateLimitKey } from "./lib/rate-limit-key.js";
import { toFastifyTrustProxy } from "./lib/trust-proxy.js";
import { getAdminSetting } from "./services/admin-settings.js";
import { requireTrustedOrigin } from "./lib/request-origin.js";

/**
 * Build the Fastify app. Kept separate from server.ts so tests can spin up an
 * instance without binding a port.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    routerOptions: { ignoreTrailingSlash: true },
    bodyLimit: config.server.bodyLimitBytes,
    // A hop count (`TRUST_PROXY=2`) becomes a peer-checked trust function; a
    // boolean or CIDR allowlist passes through. `Boolean()` here previously
    // turned `2` into "trust the whole chain" — see lib/trust-proxy.ts.
    trustProxy: toFastifyTrustProxy(config.server.trustProxy),
    logger: {
      level: config.logLevel,
      transport: config.isProd
        ? undefined
        : { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers[\"set-cookie\"]",
        ],
        censor: "[redacted]",
      },
      // `redact` above can't reach the URL — several routes (e.g. the
      // artifact-upload content endpoint) accept a bearer-capability token as
      // a `?token=` query param, and Fastify's default req serializer logs
      // `req.url` verbatim, which would otherwise put a live, still-usable
      // token straight into request logs. Same fields as the default
      // serializer (fastify/lib/logger-pino.js), path-only url.
      serializers: {
        req(req) {
          const path = req.url.split("?", 1)[0] ?? req.url;
          return {
            method: req.method,
            url: path,
            host: req.host,
            remoteAddress: req.ip,
            remotePort: req.socket ? req.socket.remotePort : undefined,
          };
        },
      },
    },
  });

  await app.register(sensible);
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    frameguard: { action: "deny" },
    hsts: { maxAge: 31_536_000, includeSubDomains: false },
    noSniff: true,
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  await app.register(cookie);

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    // `Mcp-Session-Id` is the whole sessionful MCP handshake. The server mints
    // it on `initialize` and `handleMcp` reads it back off every subsequent
    // request (routes/mcp.ts). A browser only lets script read a response
    // header that is named here, so without this the header is invisible to
    // any cross-origin client: it cannot echo the id, every call after
    // `initialize` arrives as a NEW uninitialized session, and the SDK answers
    // `tools/list` with "Server not initialized".
    //
    // The symptom is deceptive — the connection itself reports success,
    // because `initialize` really did return 200 — and then the tool list is
    // simply empty. Native clients (Claude Code, Codex, mcp-remote) read raw
    // headers with no CORS layer in the way, so they were never affected,
    // which is why this presented as working in one client and not another.
    //
    // `WWW-Authenticate` is exposed for the same class of reason: it carries
    // the OAuth `resource_metadata` pointer and scope list a client needs to
    // start the authorization flow after a 401.
    exposedHeaders: ["Mcp-Session-Id", "MCP-Protocol-Version", "WWW-Authenticate"],
  });

  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100 MiB limit for multipart file uploads
    },
  });

  // `ratelimit.global.max` / `ratelimit.global.window_seconds` are admin-editable
  // settings (see `services/admin-settings.ts`), but this hook runs on EVERY
  // request the API receives, authenticated or not — @fastify/rate-limit does
  // support a per-request async `max`/`timeWindow` function, but calling
  // `getAdminSetting` (an uncached Prisma query) on every single request would
  // add a database round trip to the one code path whose entire job is to
  // shed load, which is a worse trade than the gap it would close. So this is
  // a BOOT-TIME read, not a live one: the current admin-settings value takes
  // effect on next process restart/deploy, not immediately when an admin
  // saves it in the console. Do not "fix" this by wiring the DB call in per
  // request without adding a cache layer first.
  // An env override takes precedence over the admin setting. Two reasons it
  // exists: an operator can lift the limit during an incident without a
  // database write, and a test can be hermetic. Tests previously raised the
  // shared `admin_settings` row before boot and deleted it afterwards, so two
  // suites running in parallel clobbered each other's value and 429'd on
  // requests that had nothing to do with what they were asserting.
  const rateLimitMaxOverride = Number(process.env.RATELIMIT_GLOBAL_MAX);
  const rateLimitMax = Number.isFinite(rateLimitMaxOverride) && rateLimitMaxOverride > 0
    ? rateLimitMaxOverride
    : await getAdminSetting<number>("ratelimit.global.max", 300);
  const rateLimitWindowSeconds = await getAdminSetting<number>("ratelimit.global.window_seconds", 60);
  await app.register(rateLimit, {
    global: true,
    max: rateLimitMax,
    timeWindow: rateLimitWindowSeconds * 1000,
    // Layered keying (see lib/rate-limit-key.ts for the full rationale):
    // source IP always, EXCEPT for a credential the server has already
    // validated, which gets its own bucket. Without the credential layer two
    // MCP clients on one machine 429 each other despite the per-credential
    // hook below existing precisely to stop that; without the
    // already-validated requirement (SEC-04) any caller could invent a fresh
    // `db_live_sk_…`-shaped string per request and escape the IP bucket on
    // every endpoint that does not require a real credential.
    keyGenerator: rateLimitKey,
  });

  // Per-credential rate limiting, independent of and in addition to the global
  // per-IP limit above. Runs on every request but is a no-op unless the bearer
  // token is API-key- or MCP-token-shaped, so session-cookie and
  // unauthenticated requests never touch the bucket table. This hook only ever
  // narrows to 429 — never widens to 401/403 — so it cannot be used to probe
  // credential validity; an invalid token is left for the normal auth path.
  app.addHook("onRequest", async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return;
    const token = auth.slice("Bearer ".length);

    const send429 = (limit: number, retryAfterSec: number, label: string) => {
      reply.header("Retry-After", String(retryAfterSec));
      return reply.code(429).send({
        statusCode: 429,
        error: "Too Many Requests",
        message: `${label} rate limit exceeded: ${limit} requests/minute`,
      });
    };

    if (token.startsWith(KEY_PREFIX)) {
      const apiKey = await verifyApiKey(token);
      if (!apiKey) return;
      // This is the ONLY place the global limiter learns that a credential is
      // real (SEC-04) — nothing a caller supplies can put a fingerprint in
      // that set. Ordering: this instance-level onRequest hook runs BEFORE
      // @fastify/rate-limit's check, which the plugin attaches per route, so
      // the credential's own bucket applies from its very first request
      // (verified in lib/rate-limit-key.security.test.ts). The design does not
      // depend on that: if the limiter ever ran first, the first request from
      // a not-yet-seen credential would simply count against the caller's IP.
      noteValidatedCredential(token);
      const result = await checkAndIncrement(apiKey.id);
      reply.header("X-RateLimit-Limit", String(result.limit));
      reply.header("X-RateLimit-Remaining", String(result.remaining));
      if (!result.allowed) return send429(result.limit, result.retryAfterSec, "API key");
      return;
    }

    // OAuth MCP access tokens. Without this they fall to the global per-IP
    // bucket, so two MCP clients co-located on one machine (Claude Code and
    // Codex, say) share one bucket and 429 each other. Key by
    // (userId, clientId) instead.
    if (token.startsWith(MCP_ACCESS_TOKEN_PREFIX)) {
      const oauth = await verifyMcpAccessToken(token);
      if (!oauth) return;
      noteValidatedCredential(token);
      const result = await checkAndIncrement(`mcp:${oauth.userId}:${oauth.clientId}`);
      reply.header("X-RateLimit-Limit", String(result.limit));
      reply.header("X-RateLimit-Remaining", String(result.remaining));
      if (!result.allowed) return send429(result.limit, result.retryAfterSec, "MCP client");
    }
  });

  // Global CSRF guard (SEC-05/06/07 follow-up, 2026-09-09). `requireTrustedOrigin`
  // (lib/request-origin.ts) already fails closed correctly per-request — it
  // no-ops for a safe method and for any request that is NOT authenticating
  // via the ambient session cookie (a Bearer-token API key or MCP access
  // token can't be attached involuntarily by a browser, so those callers are
  // not a CSRF surface and don't need an Origin header at all). Until now it
  // was wired as a route-local `preHandler` on exactly the 2 routes
  // (`/v1/auth/set-password`, `/v1/auth/request-set-password`) that motivated
  // it, leaving every OTHER cookie-session-only mutating route — admin
  // suspend/restrict, community-request decision/mint, most of `me.ts` —
  // with no origin check at all, relying solely on the `COOKIE_SAMESITE`
  // cookie attribute (env-overridable to `none`) for protection. Running it
  // here, once, on every request the process receives, closes that gap for
  // the whole API without having to enumerate and patch each route (and
  // without silently missing new ones added later). It costs nothing on a
  // request that isn't cookie-authenticated: no DB call, just header/cookie
  // reads already available at this point (the `cookie` plugin's own parsing
  // hook is registered above, so `req.cookies` is already populated here).
  //
  // Carve-out: the MCP OAuth 2.1 endpoints under `/mcp` (routes/mcp.ts) are
  // the protocol's own cross-origin dance — public-client registration and
  // token/refresh/revoke exchanges are never cookie-authenticated in the
  // first place (so `requireTrustedOrigin` would no-op on them anyway), and
  // the two decision endpoints that ARE cookie-authenticated
  // (`/mcp/oauth/request/:id/approve` and `.../deny`) already carry their own
  // narrower origin check (`hasCookieOrigin` in routes/mcp.ts, added for the
  // same SEC-05/06/07 review) tuned for that consent screen. Excluding the
  // whole prefix here — rather than trying to enumerate exactly which of
  // those sub-routes are safe — matches the scope note already left in
  // lib/request-origin.ts and avoids adding a second, possibly-diverging
  // origin policy on top of the one that route file already reasoned through.
  // The sessionful streamable-HTTP transport at exactly `/mcp` is also under
  // this prefix and is bearer-token authenticated only (OAuth access token or
  // API key — see routes/mcp.ts), so it was never in scope either.
  //
  // Second, narrower carve-out: `POST /v1/notifications/unsubscribe-digest`
  // (routes/v1/notifications.ts) is RFC 8058 one-click unsubscribe —
  // deliberately unauthenticated by session, on purpose, because the whole
  // point is that it works from a mail client on a device that may not be
  // logged in at all. Its own GET handler serves the confirmation page (a
  // bare `<form method="post">` with no `action`, so it submits back to
  // itself) directly from THIS API's own origin, not from `appUrl`/
  // `adminUrl`/`landingUrl`. A real click-through is therefore a same-origin
  // browser form POST whose `Origin` header is the API's own origin — which
  // was never meant to appear in `trustedOrigins()` (that list is the
  // front-end app origins this API is a backend for, not itself) — so
  // without this exclusion, every recipient who also happens to be signed
  // into the dashboard in the same browser would have their unsubscribe
  // silently rejected with 403. The route never reads the session cookie;
  // the signed capability token in the POST body is the only credential
  // (lib/digest-unsubscribe-token.ts), so exempting it adds no CSRF surface.
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?", 1)[0] ?? req.url;
    if (path === "/mcp" || path.startsWith("/mcp/")) return;
    // `ignoreTrailingSlash: true` (router options above) routes the trailing
    // slash variant to the same handler, so both forms are excluded here.
    if (path === "/v1/notifications/unsubscribe-digest" || path === "/v1/notifications/unsubscribe-digest/") return;
    return requireTrustedOrigin(req, reply);
  });

  // Register base routes
  await app.register(healthRoutes);

  // Register V1 API routes
  await app.register(v1Routes, { prefix: "/v1" });

  // Legacy bespoke MCP-over-REST pair (`GET /mcp/tools`, `POST /mcp/call`).
  // Not the Model Context Protocol — no real MCP client speaks it — but kept
  // for existing internal callers. It now shares the same authorization gate
  // as the real transport (src/mcp/tool-gate.ts).
  await app.register(mcpPlugin, { prefix: "/mcp" });

  // Hosted MCP: OAuth 2.1 authorization server, RFC 8414/9728 discovery, and
  // the streamable-HTTP transport at `/mcp` — the URL an MCP client configures.
  await app.register(mcpRoutes);

  // Global error handler
  app.setErrorHandler((error: any, _request, reply) => {
    if (isHttpError(error)) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.name,
        message: error.message,
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: error.message,
        details: error.validation,
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    });
  });

  return app;
}
