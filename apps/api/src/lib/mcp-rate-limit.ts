// SPDX-License-Identifier: Apache-2.0

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
export async function checkAndIncrement(bucketKey: string): Promise<RateLimitResult> {
  const limit = limitPerMin();
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

/** Periodic cleanup so the table doesn't grow unbounded. Plain DELETE — safe to
 *  run concurrently from several instances, no locking needed. */
export async function pruneOldRateBuckets(): Promise<number> {
  const cutoff = new Date(Date.now() - PRUNE_OLDER_THAN_MS);
  return prisma.$executeRaw`DELETE FROM api_key_rate_buckets WHERE window_start < ${cutoff}`;
}
