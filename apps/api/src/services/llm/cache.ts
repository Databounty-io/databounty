// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import type { LlmFeature } from "./types.js";

/**
 * Dedupe cache — shared across instances via the existing `llm_cache` table
 * (`prisma/schema.prisma` model `LlmCache`; no migration needed). Ported from
 * v1's `services/llm/cache.ts`. An identical deterministic call (or one with
 * an explicit idempotencyKey) is served without re-billing the provider.
 * Async and best-effort: a cache outage never breaks a call, it just means a
 * cache miss.
 */

/** Build the cache key. An explicit idempotencyKey wins; otherwise hash the
 * routing identity + the exact input so only truly-identical calls collide. */
export function cacheKey(opts: {
  feature: LlmFeature;
  model: string;
  promptVersion: string;
  promptHash: string;
  idempotencyKey?: string;
}): string {
  if (opts.idempotencyKey) return `idem:${opts.feature}:${opts.idempotencyKey}`;
  const h = createHash("sha256")
    .update(`${opts.feature}|${opts.model}|${opts.promptVersion}|${opts.promptHash}`)
    .digest("hex");
  return `hash:${h}`;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const row = await prisma.llmCache.findUnique({ where: { key } });
    if (!row) return undefined;
    if (row.expiresAt.getTime() <= Date.now()) {
      // Lazily drop the expired row; losing the race to another instance is
      // normal, and anything else is still just a stale-row leak.
      await prisma.llmCache
        .deleteMany({ where: { key, expiresAt: { lte: new Date() } } })
        .catch((err) => {
          console.warn("[llm-cache] expired-row cleanup failed:", err instanceof Error ? err.message : err);
        });
      return undefined;
    }
    return row.value as T;
  } catch {
    return undefined; // cache outage -> treat as a miss
  }
}

export async function cachePut(key: string, feature: LlmFeature, value: unknown, ttlMs: number): Promise<void> {
  if (ttlMs <= 0) return;
  const expiresAt = new Date(Date.now() + ttlMs);
  try {
    await prisma.llmCache.upsert({
      where: { key },
      create: { key, feature, value: value as never, expiresAt },
      update: { value: value as never, expiresAt },
    });
  } catch {
    /* best-effort: a write failure just forfeits the cache hit */
  }
}
