// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { KEY_PREFIX } from "../services/api-keys.js";
import { MCP_ACCESS_TOKEN_PREFIX } from "../services/mcp-oauth.js";

/**
 * Which bucket a request counts against in the GLOBAL limiter.
 *
 * `@fastify/rate-limit` defaults to keying by client IP, and for genuinely
 * public routes (login, signup, waitlist) that is correct. For authenticated
 * traffic it was actively wrong, and it silently defeated the per-credential
 * hook registered right after it in `app.ts`: that hook exists so two MCP
 * clients on one machine — Claude Code and Codex, say — do not 429 each
 * other, but the global bucket above it still counted them together, so they
 * did. The same shape locked out every caller behind one NAT: an office, a
 * university, a VPN exit, mobile CGNAT.
 *
 * It is also the weaker abuse control, not the stronger one — one attacker
 * rotating IPs multiplies their own quota while co-located legitimate users
 * starve.
 *
 * ---------------------------------------------------------------------------
 * SEC-04, 2026-09-05. The first version of this function keyed on ANY
 * bearer string carrying a recognised prefix, without ever checking that the
 * credential existed. That is a caller-invented identity: at a limit of two,
 * four anonymous requests from one IP returned 200, 200, 429, 429, while four
 * requests rotating `db_live_sk_dummy_0…3` returned 200 four times. Every
 * unauthenticated endpoint — including the auth routes, which inherit this
 * key generator through their route-level `config.rateLimit` — could be
 * driven at unlimited rate by an attacker who simply invents a new token per
 * request, and the per-credential hook in `app.ts` does not close it because
 * that hook only ever narrows to 429 and returns silently on an invalid
 * token.
 *
 * The fix is layered, not a revert — reverting would put the NAT/two-MCP-
 * client regression back:
 *
 *  - The source-IP bucket ALWAYS applies unless the request presents a
 *    credential the SERVER HAS ALREADY VALIDATED. Nothing a caller can invent
 *    escapes it, because a fingerprint only becomes a bucket of its own once
 *    `verifyApiKey` / `verifyMcpAccessToken` has succeeded for that exact
 *    token (see {@link noteValidatedCredential}, called from the credential
 *    hook in `app.ts`).
 *  - A validated credential gets its own bucket, which is what keeps two MCP
 *    clients behind one NAT out of each other's way, plus the per-credential
 *    quota that hook enforces via `lib/mcp-rate-limit.ts`.
 *  - Auth routes (`/v1/auth/**`) are pinned to the IP bucket unconditionally.
 *    They are the password-hashing surface, they authenticate with session
 *    cookies rather than API keys, and a public endpoint must never be keyed
 *    by anything the caller supplies.
 *
 * Why validation is not done here: verifying an API key is a hash lookup plus
 * a `lastUsedAt` write, and the key generator runs on every request including
 * the ones the limiter exists to shed. The set is populated instead by the
 * credential hook in `app.ts`, which — being an instance-level `onRequest`
 * hook — runs ahead of @fastify/rate-limit's own check, since the plugin
 * attaches that per route. So in practice a valid credential is on its own
 * bucket from its first request. Nothing here relies on that ordering: were it
 * to change, the first request from a not-yet-seen credential would count
 * against its IP, which is the correct conservative default. A caller cannot
 * forge entry into the validated set; only a successful server-side
 * verification writes to it.
 *
 * The validated set is intentionally a *rate-limiting* cache and nothing else.
 * A revoked credential can keep its own limiter bucket for up to
 * {@link VALIDATED_TTL_MS}; it cannot keep access, because authorisation is
 * decided by the auth path on every request, never by this file.
 *
 * Never returns the raw credential: keys land in limiter state and
 * diagnostics, so a token is only ever present as a truncated SHA-256.
 */

/** How long a successful verification keeps the credential's own bucket. */
const VALIDATED_TTL_MS = 10 * 60 * 1000;

/** Hard cap on the validated set. Bounded so a machine holding many live
 * credentials cannot grow it without limit; eviction is oldest-inserted
 * first, and losing an entry only demotes that credential to its IP bucket. */
const VALIDATED_MAX_ENTRIES = 5_000;

/** fingerprint → expiry (ms). Insertion order is used as an approximate LRU. */
const validatedCredentials = new Map<string, number>();

/**
 * Truncated SHA-256 of a credential. Collision-free in practice (128 bits),
 * short enough to keep the limiter's key space small, and never reversible to
 * the token.
 */
export function credentialFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * Record that the server has successfully verified `token`. Called ONLY from
 * the credential hook in `app.ts`, after `verifyApiKey` /
 * `verifyMcpAccessToken` returned a row — never from anything a caller
 * controls.
 */
export function noteValidatedCredential(token: string): void {
  const now = Date.now();
  if (validatedCredentials.size >= VALIDATED_MAX_ENTRIES) {
    for (const [fp, expiresAt] of validatedCredentials) {
      if (expiresAt <= now) validatedCredentials.delete(fp);
    }
    while (validatedCredentials.size >= VALIDATED_MAX_ENTRIES) {
      const oldest = validatedCredentials.keys().next();
      if (oldest.done) break;
      validatedCredentials.delete(oldest.value);
    }
  }
  const fingerprint = credentialFingerprint(token);
  // Re-insert so Map iteration order stays recency-ordered.
  validatedCredentials.delete(fingerprint);
  validatedCredentials.set(fingerprint, now + VALIDATED_TTL_MS);
}

function isValidatedFingerprint(fingerprint: string): boolean {
  const expiresAt = validatedCredentials.get(fingerprint);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    validatedCredentials.delete(fingerprint);
    return false;
  }
  return true;
}

/** Test-only: drop the validated set so one test's credentials cannot leak
 * into another's assertions. Not called by application code. */
export function resetValidatedCredentials(): void {
  validatedCredentials.clear();
}

/** Public/auth surface that must never be keyed by a caller-supplied value,
 * validated or not. */
const AUTH_PATH = /^\/v1\/auth(\/|$)/;

export function rateLimitKey(req: FastifyRequest): string {
  const ipKey = `ip:${req.ip}`;

  const path = (req.url ?? "").split("?")[0] ?? "";
  if (AUTH_PATH.test(path)) return ipKey;

  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return ipKey;

  const token = auth.slice("Bearer ".length);
  if (!token.startsWith(KEY_PREFIX) && !token.startsWith(MCP_ACCESS_TOKEN_PREFIX)) return ipKey;

  const fingerprint = credentialFingerprint(token);
  if (!isValidatedFingerprint(fingerprint)) return ipKey;
  return `k:${fingerprint}`;
}