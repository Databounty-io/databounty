// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { positiveIntEnv } from "./env-int.js";
import { prisma } from "./prisma.js";

/**
 * Per-credential request limiter, independent of and in addition to the global
 * per-IP limit in app.ts.
 *
 * One-minute buckets keyed by (credential, windowStart) in `api_key_rate_buckets`.
 * Bucketed rather than a true sliding window — ±1-bucket accuracy is the
 * accepted tradeoff for not requiring Redis, which this service does not have a
 * client abstraction for.
 *
 * The bucket key is a plain string so BOTH credential kinds share the table:
 *   - API keys       → the ApiKey row id
 *   - MCP OAuth      → `mcp:<userId>:<clientId>`
 * Keying OAuth traffic by (userId, clientId) rather than by IP is the point:
 * without it, two MCP clients on one machine (say Claude Code and Codex) fall
 * into the same per-IP bucket and 429 each other.
 */

const WINDOW_MS = 60_000;
const PRUNE_OLDER_THAN_MS = 10 * WINDOW_MS;

/** Requests per minute per credential. 0 disables enforcement. */
function limitPerMin(): number {
  const raw = Number(process.env.MCP_RATE_LIMIT_PER_MIN ?? process.env.API_KEY_RATE_LIMIT_PER_MIN ?? 300);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 300;
}

export function currentWindowStart(now = new Date()): Date {
  return new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Atomically increments this credential's counter for the current window and
 * reports whether the request is within the limit. A single INSERT … ON
 * CONFLICT DO UPDATE, so concurrent requests from the same credential cannot
 * both read a stale count.
 */
export async function checkAndIncrement(bucketKey: string, limitOverride?: number): Promise<RateLimitResult> {
  const limit = limitOverride ?? limitPerMin();
  const start = currentWindowStart();
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO api_key_rate_buckets (key_id, window_start, count)
    VALUES (${bucketKey}, ${start}, 1)
    ON CONFLICT (key_id, window_start)
    DO UPDATE SET count = api_key_rate_buckets.count + 1
    RETURNING count
  `;
  const count = rows[0]?.count ?? 1;
  const retryAfterSec = Math.max(1, Math.ceil((start.getTime() + WINDOW_MS - Date.now()) / 1000));
  return {
    allowed: limit <= 0 || count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSec,
  };
}

/** Per client_id, per minute, on `POST /mcp/oauth/token`. 0 disables. */
const tokenLimitPerMin = () => positiveIntEnv("MCP_TOKEN_RATE_LIMIT_PER_MIN", 60, true);

/** Per *presented grant secret*, per minute, on the same endpoint. 0 disables. */
const tokenReplayLimitPerMin = () => positiveIntEnv("MCP_TOKEN_REPLAY_LIMIT_PER_MIN", 5, true);

/**
 * `POST /mcp/oauth/token` was the one credentialed surface with NO
 * per-client limit.
 *
 * The limiter in `app.ts` only fires on an `Authorization: Bearer` header, and
 * this endpoint deliberately has none — it is a public PKCE client
 * authenticating with a form body (`token_endpoint_auth_methods_supported:
 * ["none"]`). So it fell through to the global per-IP bucket, and that bucket
 * is worth nothing here: `TRUST_PROXY` is unset on the deployment, so every
 * container-proxied request arrives as the same Docker gateway address. One
 * bucket, every client. A single broken client can spend the whole allowance
 * and there is no way to tell it apart from anyone else.
 *
 * Observed in production 2026-09-22: one contributor's Codex connector held a
 * dead refresh token and replayed it 313 times over nine days, entirely
 * unthrottled, each attempt re-handshaking against `/mcp`.
 *
 * TWO buckets, because they catch different failures:
 *
 *  - `clientId` — the broad one. Bounds a client that loops by re-authorising
 *    with fresh grants, which a token-keyed bucket alone would never see.
 *    Untrusted (it comes from the request body), so it is hashed, both to
 *    bound the key length and to keep a caller-chosen string out of the table.
 *
 *  - The presented code/refresh token — the precise one, and the reason this
 *    fix actually works. Rotation means a healthy client presents a DIFFERENT
 *    secret every time, so it lands in a fresh bucket and never approaches the
 *    limit no matter how often it refreshes. A client replaying one dead token
 *    lands in the SAME bucket every attempt and is throttled within seconds.
 *    The limit can therefore be tight without risk to a working client.
 *    Hashed with SHA-256 and truncated: the raw secret must never reach a
 *    table, and the bucket key is not a secret store.
 *
 * Both checks run and the caller is refused if EITHER is exceeded; the
 * recorded increment on the other is intentional, since a refused attempt is
 * still an attempt.
 */
export async function checkTokenEndpoint(input: {
  clientId: string;
  presentedSecret?: string;
}): Promise<RateLimitResult | null> {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

  const results: RateLimitResult[] = [];

  const clientLimit = tokenLimitPerMin();
  if (clientLimit > 0) {
    results.push(await checkAndIncrement(`mcp-token:client:${digest(input.clientId)}`, clientLimit));
  }

  const replayLimit = tokenReplayLimitPerMin();
  if (input.presentedSecret && replayLimit > 0) {
    results.push(await checkAndIncrement(`mcp-token:grant:${digest(input.presentedSecret)}`, replayLimit));
  }

  // Report the first refusal, so `Retry-After` describes the bucket that
  // actually blocked the caller rather than whichever check ran last.
  return results.find((result) => !result.allowed) ?? null;
}

/** Periodic cleanup so the table doesn't grow unbounded. Plain DELETE — safe to
 *  run concurrently from several instances, no locking needed. */
export async function pruneOldRateBuckets(): Promise<number> {
  const cutoff = new Date(Date.now() - PRUNE_OLDER_THAN_MS);
  return prisma.$executeRaw`DELETE FROM api_key_rate_buckets WHERE window_start < ${cutoff}`;
}
