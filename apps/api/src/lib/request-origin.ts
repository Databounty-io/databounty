// SPDX-License-Identifier: Apache-2.0

import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { SESSION_COOKIE, ADMIN_SESSION_COOKIE } from "./session-cookie.js";

/**
 * Trusted-origin (CSRF) checking for cookie-authenticated state changes.
 *
 * WHY THIS EXISTS — SEC-05/06/07 review, 2026-09-05. The API globally accepts
 * `application/x-www-form-urlencoded` bodies (`app.ts`) and enables
 * credentialed CORS. CORS is a RESPONSE-reading control: the browser withholds
 * the response body from an untrusted origin, but the request has already been
 * dispatched and the mutation has already happened. The review proved exactly
 * that against the real app — a `POST /v1/auth/set-password` from
 * `http://untrusted.localhost:9999` carrying a victim session cookie and a
 * simple-form content type returned 200 and wrote a password hash to
 * PostgreSQL. No `access-control-allow-origin` header came back, and it made
 * no difference.
 *
 * The trust decision therefore has to happen BEFORE the handler runs, on the
 * request itself. There is no new environment variable here on purpose: the
 * allowlist is derived from the origins the deployment already declares
 * (`CORS_ORIGINS`, `APP_URL`, `ADMIN_URL`, `LANDING_URL`), all four of which
 * already carry production boot guards in `config.ts`. Add nothing to that
 * list without a matching guard.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `https://Host:443/path` -> `https://host:443`; null when unparseable. */
export function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  // "null" is what a browser sends for an opaque origin (sandboxed iframe,
  // data: document, some redirect chains). It is never trustworthy.
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  try {
    const url = new URL(trimmed);
    if (!url.protocol || !url.host) return null;
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** The origins allowed to drive cookie-authenticated mutations. */
export function trustedOrigins(): string[] {
  const declared = [
    ...config.corsOrigins,
    config.appUrl,
    config.adminUrl,
    config.landingUrl,
  ];
  const normalized = declared
    .map((origin) => normalizeOrigin(origin))
    .filter((origin): origin is string => origin !== null);
  return [...new Set(normalized)];
}

/**
 * True when the ONLY thing authenticating this request is an ambient cookie.
 *
 * A `Authorization: Bearer` credential is never attached by the browser on a
 * cross-site request — the caller has to hold the token and set the header — so
 * bearer-authenticated API and MCP clients are not a CSRF surface and are
 * deliberately exempt. That exemption is what lets this run as a route
 * preHandler without breaking non-browser callers.
 */
export function isCookieAuthenticated(req: FastifyRequest): boolean {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return false;
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  return Boolean(cookies?.[SESSION_COOKIE] || cookies?.[ADMIN_SESSION_COOKIE]);
}

/**
 * The requesting origin, from `Origin` and falling back to `Referer`.
 * `null` means "the request did not state one", which is NOT the same as
 * "same origin" — see requireTrustedOrigin().
 */
export function requestOrigin(req: FastifyRequest): string | null {
  const origin = normalizeOrigin(req.headers.origin as string | undefined);
  if (origin) return origin;
  return normalizeOrigin(req.headers.referer as string | undefined);
}

export function isTrustedRequestOrigin(req: FastifyRequest): boolean {
  const origin = requestOrigin(req);
  if (!origin) return false;
  return trustedOrigins().includes(origin);
}

/**
 * Fastify preHandler: reject a cookie-authenticated state change that does not
 * come from a trusted origin.
 *
 * Fails CLOSED on a missing `Origin`/`Referer`. Every browser sends `Origin`
 * on a cross-origin request and on any same-origin POST/PUT/PATCH/DELETE, so
 * an unstated origin on a cookie-authenticated mutation is either a stripped
 * header or a non-browser caller — and a non-browser caller can present a
 * bearer token instead, which skips this check entirely.
 *
 * Scope note: this is a ROUTE-level preHandler, not a global hook, because
 * `app.ts` is not owned by this change. A global `onRequest` hook there would
 * be strictly better (it would cover every cookie-authenticated mutation in
 * the API, not just the ones that opt in) but would also have to carve out the
 * deliberate OAuth protocol form endpoints under `/mcp` (`routes/mcp.ts`,
 * `services/mcp-oauth.ts`), which are unauthenticated-by-cookie form POSTs by
 * specification.
 */
export async function requireTrustedOrigin(req: FastifyRequest, reply: FastifyReply) {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;
  if (!isCookieAuthenticated(req)) return;

  const origin = requestOrigin(req);
  if (!origin) {
    return reply.forbidden(
      "This request must state its origin. Retry from the dashboard, or authenticate with a bearer token instead of a session cookie."
    );
  }
  if (!trustedOrigins().includes(origin)) {
    return reply.forbidden("This request came from an untrusted origin.");
  }
}
