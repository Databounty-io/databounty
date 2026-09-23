// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { positiveIntEnv } from "./env-int.js";
import { prisma } from "./prisma.js";
import { cache } from "./cache/index.js";

/**
 * Per-credential request limiter, independent of and in addition to the global
 * per-IP limit in app.ts.
 *
 * One-minute buckets keyed by (credential, windowStart). Bucketed rather than a
 * true sliding window — ±1-bucket accuracy is the accepted tradeoff.
 *
 * WHERE THE COUNTER LIVES. Two backings, chosen per call site rather than
 * globally, because the two kinds of limit here have genuinely different
 * requirements:
 *
 *  - The per-credential request limiter runs on EVERY authenticated request.
 *    Measured on production 2026-09-23 that was ~880 writes per four minutes
 *    and, once API-key verification was cached, the single largest remaining
 *    write on the hot path. It counts in Redis when one is available.
 *
 *  - The token-endpoint limiters are a security control, not a performance
 *    guard — they are what stopped a dead-refresh-token replay loop in
 *    production. They are also low volume. They stay in Postgres
 *    unconditionally, because Redis may evict a key under memory pressure (the
 *    production instance is shared with another application) and a silently
 *    reset security limit is a worse failure than a few extra writes.
 *
 * Both paths fail SAFE rather than open: if the counter is unavailable the
 * request still gets counted, just in the other store.
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
/**
 * The Redis key for one bucket. The window start is IN the key, so a bucket can
 * never be reused by the next window and the TTL only has to outlive its own.
 */
function bucketCacheKey(bucketKey: string, start: Date): string {
  return `ratelimit:v1:${bucketKey}:${start.getTime()}`;
}

/** Comfortably longer than a window, so a bucket opened at the very start of
 *  one is still counting at the end of it, and is gone well before the key
 *  could ever be confused with a later window's. */
const BUCKET_TTL_SEC = (WINDOW_MS / 1000) * 2;

async function incrementInDatabase(bucketKey: string, start: Date): Promise<number> {
  // A single INSERT … ON CONFLICT DO UPDATE, so concurrent requests from the
  // same credential cannot both read a stale count.
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO api_key_rate_buckets (key_id, window_start, count)
    VALUES (${bucketKey}, ${start}, 1)
    ON CONFLICT (key_id, window_start)
    DO UPDATE SET count = api_key_rate_buckets.count + 1
    RETURNING count
  `;
  return rows[0]?.count ?? 1;
}

/**
 * Atomically increments this credential's counter for the current window and
 * reports whether the request is within the limit.
 *
 * `durable: true` forces the Postgres counter regardless of what cache is
 * configured — see the note at the top of this file on why the token-endpoint
 * limits use it and the per-request limit does not.
 */
export async function checkAndIncrement(
  bucketKey: string,
  limitOverride?: number,
  options?: { durable?: boolean },
): Promise<RateLimitResult> {
  const limit = limitOverride ?? limitPerMin();
  const start = currentWindowStart();

  let count: number | null = null;
  if (!options?.durable) {
    // null means the driver has no atomic counter (cache off) or Redis is
    // unreachable behind its circuit breaker. Either way the request must
    // still be counted, so fall through to the database rather than letting
    // the limit silently stop applying.
    count = await cache.incr(bucketCacheKey(bucketKey, start), BUCKET_TTL_SEC);
  }
  if (count === null) count = await incrementInDatabase(bucketKey, start);

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
    results.push(await checkAndIncrement(`mcp-token:client:${digest(input.clientId)}`, clientLimit, { durable: true }));
  }

  const replayLimit = tokenReplayLimitPerMin();
  if (input.presentedSecret && replayLimit > 0) {
    results.push(await checkAndIncrement(`mcp-token:grant:${digest(input.presentedSecret)}`, replayLimit, { durable: true }));
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
