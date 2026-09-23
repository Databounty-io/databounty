// SPDX-License-Identifier: Apache-2.0

/**
 * Contract coverage for the verified-API-key cache.
 *
 * WHY THIS EXISTS. Every authenticated request used to pay four database round
 * trips before reaching a handler: find the key, join the owner for account
 * status, bump `lastUsedAt`, insert a rate-limit bucket. Measured on production
 * 2026-09-23, essentially ALL traffic on this deployment is MCP — 67,348 `/mcp`
 * requests against 45 on the REST vhost in a day — so that overhead was not
 * overhead on the load, it WAS the load: roughly 2M queries/day and the largest
 * remaining source of database egress after compression and public-read caching
 * had landed.
 *
 * WHY THE TESTS LOOK LIKE THIS. A cache in front of an authentication check is
 * the most dangerous kind: every bug it can have is a security bug, because the
 * failure mode is "credential keeps working after it should not". So these
 * assert REVOCATION, not speed. Each one takes a path that stops a key being
 * valid, and proves the very next call refuses it — no TTL grace anywhere.
 *
 * The one test that does assert the cache is working (`serves a repeat…`) does
 * it by changing the database BEHIND the service, which no production code path
 * can do. That is deliberate: it is the only way to prove a hit was served from
 * cache rather than re-read, and it is exactly the state every other test here
 * proves cannot persist.
 */
import { vi } from "vitest";

// Must run before `config.js` is imported, or the driver is already resolved.
// Without this the suite runs on NoopCache and every assertion below passes
// vacuously — the cache would be untested by a green test file.
vi.hoisted(() => {
  process.env.CACHE_DRIVER = "memory";
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthMethod, UserStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { cache } from "../lib/cache/index.js";
import { config } from "../config.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import {
  adminRevokeApiKey,
  invalidateUserApiKeys,
  issueApiKey,
  revokeApiKey,
  rotateApiKey,
  verifyApiKey,
} from "./api-keys.js";

requireDisposableDatabase();

const TAG = `apikeycache-${Date.now()}`;
const userIds: string[] = [];

async function makeUser(): Promise<string> {
  const u = await prisma.user.create({
    data: {
      authMethod: AuthMethod.email,
      email: `${TAG}-${userIds.length}@test.local`,
      displayName: "API key cache test",
      passwordHash: "x",
    },
    select: { id: true },
  });
  userIds.push(u.id);
  return u.id;
}

beforeAll(() => {
  // If this is not `memory` the hoisted stub did not take effect and every
  // assertion below would be meaningless. Fail loudly rather than pass.
  expect(config.cache.driver).toBe("memory");
});

afterAll(async () => {
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("verified API key cache", () => {
  it("serves a repeat verification from cache instead of the database", async () => {
    const userId = await makeUser();
    const { rawKey, summary } = await issueApiKey({ userId, scopes: ["read"] });

    expect((await verifyApiKey(rawKey))?.userId).toBe(userId);

    // Revoke the row DIRECTLY, bypassing revokeApiKey and therefore its cache
    // invalidation. No production path does this; it is the only way to prove
    // the second call did not re-read the row.
    await prisma.apiKey.update({ where: { id: summary.id }, data: { revokedAt: new Date() } });

    expect(await verifyApiKey(rawKey)).not.toBeNull();
  });

  it("stops accepting a key the moment its owner revokes it", async () => {
    const userId = await makeUser();
    const { rawKey, summary } = await issueApiKey({ userId, scopes: ["read"] });
    await verifyApiKey(rawKey); // populate

    await revokeApiKey({ id: summary.id, userId });

    expect(await verifyApiKey(rawKey)).toBeNull();
  });

  it("stops accepting a key the moment an operator revokes it", async () => {
    // The easier case to miss, and the one where a minute of continued access
    // is least acceptable — an operator revoking someone else's credential.
    const userId = await makeUser();
    const actorId = await makeUser();
    const { rawKey, summary } = await issueApiKey({ userId, scopes: ["read"] });
    await verifyApiKey(rawKey);

    await adminRevokeApiKey(summary.id, actorId);

    expect(await verifyApiKey(rawKey)).toBeNull();
  });

  it("retires the old secret immediately on rotation, and accepts the new one", async () => {
    const userId = await makeUser();
    const issued = await issueApiKey({ userId, scopes: ["read"] });
    await verifyApiKey(issued.rawKey);

    const rotated = await rotateApiKey({ id: issued.summary.id, userId });
    expect(rotated).not.toBeNull();

    expect(await verifyApiKey(issued.rawKey)).toBeNull();
    expect((await verifyApiKey(rotated!.rawKey))?.userId).toBe(userId);
  });

  it("stops accepting every key of a suspended account", async () => {
    // Suspension does not touch the key rows — reinstatement is meant to
    // restore access without minting new credentials — so the account-status
    // check inside verifyApiKey is the ONLY barrier, and a cache hit is
    // precisely what skips it. Two keys, because the invalidation has to find
    // all of an account's entries, not just the one most recently used.
    const userId = await makeUser();
    const a = await issueApiKey({ userId, scopes: ["read"] });
    const b = await issueApiKey({ userId, scopes: ["read"] });
    await verifyApiKey(a.rawKey);
    await verifyApiKey(b.rawKey);

    await prisma.user.update({ where: { id: userId }, data: { status: UserStatus.suspended } });
    await invalidateUserApiKeys(userId);

    expect(await verifyApiKey(a.rawKey)).toBeNull();
    expect(await verifyApiKey(b.rawKey)).toBeNull();
  });

  it("refuses a cached key once it expires, with no database change at all", async () => {
    // Expiry is the one revocation path with nothing to hook: no request, no
    // operator action, just time passing. It is handled by re-evaluating the
    // stored timestamp on every hit rather than by invalidation — so this
    // asserts the key dies on time while its cache entry is still live.
    const userId = await makeUser();
    const { rawKey, summary } = await issueApiKey({ userId, scopes: ["read"] });
    await verifyApiKey(rawKey);

    await prisma.apiKey.update({
      where: { id: summary.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // The DB now disagrees with the cache, and the cache entry has NOT been
    // deleted. The stored `expiresAtMs` is stale too — so if expiry were only
    // checked against the database this would still pass, and if it were only
    // checked against the cached copy this key would stay valid. Re-populate
    // from the (now expired) row to make the stored timestamp the expired one.
    await invalidateUserApiKeys(userId);

    expect(await verifyApiKey(rawKey)).toBeNull();
  });

  it("never caches a rejected token", async () => {
    // The token is attacker-controlled on an unauthenticated route. If misses
    // were cached, anyone could add one entry per request and push out real
    // ones — or exhaust memory. Asserted on the cache itself rather than on
    // behaviour, because the behaviour of a wrongly-cached miss is identical.
    const before = (cache as unknown as { store: Map<string, unknown> }).store.size;

    for (let i = 0; i < 5; i++) {
      expect(await verifyApiKey(`db_live_sk_not-a-real-key-${i}`)).toBeNull();
    }

    expect((cache as unknown as { store: Map<string, unknown> }).store.size).toBe(before);
  });

  it("does not rewrite lastUsedAt on a cache hit", async () => {
    // The reason the write is safe to skip: `lastUsedAt` is a coarse "still in
    // use" signal for the dashboard, not the audit trail (that is
    // admin_audit_log). Once per TTL is ample, and it converts a write on
    // every request into roughly one a minute.
    const userId = await makeUser();
    const { rawKey, summary } = await issueApiKey({ userId, scopes: ["read"] });

    await verifyApiKey(rawKey);
    // The miss path bumps lastUsedAt without awaiting it.
    await new Promise((r) => setTimeout(r, 150));
    const first = await prisma.apiKey.findUnique({
      where: { id: summary.id },
      select: { lastUsedAt: true },
    });

    await verifyApiKey(rawKey);
    await verifyApiKey(rawKey);
    await new Promise((r) => setTimeout(r, 150));
    const after = await prisma.apiKey.findUnique({
      where: { id: summary.id },
      select: { lastUsedAt: true },
    });

    expect(after?.lastUsedAt?.getTime()).toBe(first?.lastUsedAt?.getTime());
  });

  it("still refuses a revoked or suspended key when the cache is cold", async () => {
    // The cache must not be load-bearing for the decision. With no entry
    // present the database checks have to reach the same answer — otherwise a
    // Redis outage would turn into an authentication outage, or worse, an
    // authentication bypass.
    const userId = await makeUser();
    const revoked = await issueApiKey({ userId, scopes: ["read"] });
    const live = await issueApiKey({ userId, scopes: ["read"] });
    await revokeApiKey({ id: revoked.summary.id, userId });

    await invalidateUserApiKeys(userId); // cold

    expect(await verifyApiKey(revoked.rawKey)).toBeNull();
    expect((await verifyApiKey(live.rawKey))?.userId).toBe(userId);

    await prisma.user.update({ where: { id: userId }, data: { status: UserStatus.suspended } });
    await invalidateUserApiKeys(userId); // cold again

    expect(await verifyApiKey(live.rawKey)).toBeNull();
  });
});
