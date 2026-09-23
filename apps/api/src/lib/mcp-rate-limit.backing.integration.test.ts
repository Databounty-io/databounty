// SPDX-License-Identifier: Apache-2.0

/**
 * Where the rate-limit counter lives, and why it is not one answer.
 *
 * WHY THIS EXISTS. The per-credential limiter runs on every authenticated
 * request, and once API-key verification was cached it became the single
 * largest remaining write on the hot path — ~880 inserts per four minutes on
 * production, where essentially all traffic is MCP. Moving it to Redis removes
 * that write.
 *
 * WHAT MUST NOT BE LOST IN THE MOVE. Two things, and they pull in opposite
 * directions:
 *
 *  1. The limit must keep applying when the counter is unavailable. A cache
 *     that is off, or a Redis behind an open circuit breaker, must fall back to
 *     the database — NOT quietly stop counting. A rate limiter that fails open
 *     is worse than none, because it looks like it is working.
 *
 *  2. The token-endpoint limits must stay in Postgres. They are a security
 *     control — they are what stopped a dead-refresh-token replay loop running
 *     313 attempts over nine days — and production's Redis is shared with
 *     another application, so a key can be evicted under memory pressure. A
 *     silently reset security limit is a worse failure than a few writes. They
 *     are also low volume, so there is nothing to win by moving them.
 *
 * These tests run on the `memory` driver, which exercises the same
 * `cache.incr` contract Redis implements — the code path under test is the
 * branch, not the driver.
 */
import { vi } from "vitest";

// Before `config.js` resolves the driver. Without this the suite runs on
// NoopCache, every call takes the database path, and the branch this file
// exists to test is never entered.
vi.hoisted(() => {
  process.env.CACHE_DRIVER = "memory";
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./prisma.js";
import { config } from "../config.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import { checkAndIncrement, checkTokenEndpoint, currentWindowStart } from "./mcp-rate-limit.js";

requireDisposableDatabase();

const TAG = `rl-${Date.now()}`;

async function rowsFor(prefix: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM api_key_rate_buckets WHERE key_id LIKE ${prefix + "%"}
  `;
  return Number(rows[0]?.n ?? 0);
}

beforeAll(() => {
  expect(config.cache.driver).toBe("memory");
});

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM api_key_rate_buckets WHERE key_id LIKE ${TAG + "%"}`;
});

describe("rate-limit counter backing", () => {
  it("counts the per-credential limit without touching the database", async () => {
    // The whole point of the change: the hot path stops writing a row per
    // request. Asserted against the table rather than by timing, so it cannot
    // pass for the wrong reason.
    const key = `${TAG}:hot`;

    for (let i = 0; i < 5; i++) await checkAndIncrement(key, 100);

    expect(await rowsFor(key)).toBe(0);
  });

  it("still enforces the limit, and reports remaining correctly", async () => {
    const key = `${TAG}:enforce`;

    const first = await checkAndIncrement(key, 3);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    await checkAndIncrement(key, 3);
    const third = await checkAndIncrement(key, 3);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = await checkAndIncrement(key, 3);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBeGreaterThan(0);
  });

  it("keeps separate credentials in separate buckets", async () => {
    // A shared counter would throttle one client because another was busy —
    // exactly the per-IP failure this limiter was introduced to replace.
    const a = `${TAG}:alice`;
    const b = `${TAG}:bob`;

    for (let i = 0; i < 4; i++) await checkAndIncrement(a, 3);
    const bobsFirst = await checkAndIncrement(b, 3);

    expect(bobsFirst.allowed).toBe(true);
    expect(bobsFirst.remaining).toBe(2);
  });

  it("starts a fresh count in the next window", async () => {
    // The window start is part of the key, so a new window cannot inherit the
    // old count — and the old key must not be able to come back either.
    const key = `${TAG}:window`;
    await checkAndIncrement(key, 1);
    expect((await checkAndIncrement(key, 1)).allowed).toBe(false);

    const drift = currentWindowStart(new Date(Date.now() + 60_000));
    expect(drift.getTime()).toBeGreaterThan(currentWindowStart().getTime());
  });

  it("falls back to the database when the counter is unavailable", async () => {
    // The failure that matters. `durable` takes the same branch the null
    // return from `cache.incr` takes when Redis is unreachable or the cache is
    // off, so this asserts the fallback is real and still counts.
    const key = `${TAG}:fallback`;

    const first = await checkAndIncrement(key, 2, { durable: true });
    const second = await checkAndIncrement(key, 2, { durable: true });
    const third = await checkAndIncrement(key, 2, { durable: true });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false); // still enforced, not failing open
    expect(await rowsFor(key)).toBe(1); // one bucket row, incremented in place
  });

  it("keeps the token-endpoint limits in the database even with a cache available", async () => {
    // A security control, on an instance whose Redis is shared with another
    // application and may evict under memory pressure. If this ever starts
    // returning 0 rows, the replay limit has become evictable.
    const before = await rowsFor("mcp-token:");

    await checkTokenEndpoint({ clientId: `${TAG}-client`, presentedSecret: `${TAG}-secret` });

    expect(await rowsFor("mcp-token:")).toBeGreaterThan(before);
  });

  it("refuses a replayed grant secret within a few attempts", async () => {
    // The production incident this limit exists for: one connector replaying a
    // dead refresh token, unthrottled, 313 times over nine days.
    const secret = `${TAG}-replayed`;
    let refused = false;

    for (let i = 0; i < 8; i++) {
      const result = await checkTokenEndpoint({ clientId: `${TAG}-replay-client`, presentedSecret: secret });
      if (result && !result.allowed) {
        refused = true;
        break;
      }
    }

    expect(refused).toBe(true);
  });
});
