// SPDX-License-Identifier: Apache-2.0

import { randomBytes, createHmac } from "node:crypto";
import type { ApiKeyScope, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { writeAuditLog } from "../lib/audit-log.js";
import { cache } from "../lib/cache/index.js";

/**
 * Verified-key cache.
 *
 * WHY. Every authenticated request paid four database round trips before it
 * reached any handler: find the key, join the owner for account status, bump
 * `lastUsedAt`, and insert a rate-limit bucket row. Measured on production
 * 2026-09-23, essentially all traffic on this deployment is MCP -- 67,348
 * `/mcp` requests against 45 on the REST vhost in one day -- so that overhead
 * WAS the load, roughly 2M queries/day and the largest remaining source of
 * database egress once compression and public-read caching had landed. V1
 * cached this; the rebuild never did, because until 2026-09-23 production had
 * no cache to put it in.
 *
 * WHAT IS CACHED. Only keys that verified successfully. A failed lookup is
 * never cached: an unauthenticated caller controls the token, so caching
 * misses would let anyone fill the cache with junk at one entry per request.
 * The stored value carries no secret -- the cache KEY is the HMAC hash the
 * database itself is indexed on, and the value is the same `{id, userId,
 * scopes}` the caller would have received anyway.
 *
 * STALENESS IS BOUNDED TWO WAYS. The TTL caps it at 60 seconds for anything
 * that changes without going through this module, and every mutation that can
 * invalidate a key deletes its entry explicitly, so revocation, rotation and
 * suspension take effect immediately rather than after a TTL. Expiry needs
 * neither: it is re-evaluated on every cache hit from the stored timestamp, so
 * a key cannot outlive `expiresAt` even by one request.
 */
/** Same shape the other services use: a transaction client or the root client. */
type DbClient = Prisma.TransactionClient | typeof prisma;

const API_KEY_CACHE_TTL_SEC = 60;

function apiKeyCacheKey(keyHash: string): string {
  return `apikey:v1:${keyHash}`;
}

interface CachedApiKey {
  verified: VerifiedApiKey;
  /** Re-checked on every hit, so a cached key expires on time regardless of TTL. */
  expiresAtMs: number | null;
}

/**
 * Drop every cached key belonging to one account.
 *
 * The cache is keyed by key hash, so there is no way to reach a user's entries
 * without looking up their hashes first. That is the price of never storing a
 * reverse index, and it is worth paying: this runs on suspension, which is
 * rare, while the read path runs thousands of times an hour.
 *
 * Deliberately NOT filtered to un-revoked keys. A key revoked moments earlier
 * in the same operation may still be cached, and the point here is to leave
 * nothing behind.
 *
 * Call this AFTER the transaction commits. Calling it inside one would clear
 * the cache against a state that can still roll back, and the next request
 * would re-populate it from the pre-rollback row.
 */
export async function invalidateUserApiKeys(userId: string, db: DbClient = prisma): Promise<void> {
  const rows = await db.apiKey.findMany({ where: { userId }, select: { keyHash: true } });
  if (rows.length === 0) return;
  await cache.del(rows.map((r: { keyHash: string }) => apiKeyCacheKey(r.keyHash)));
}

export const KEY_PREFIX = "db_live_sk_";
const PREFIX_DISPLAY_LEN = 12;
const DEFAULT_KEY_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function defaultExpiry(): Date {
  return new Date(Date.now() + DEFAULT_KEY_TTL_MS);
}

export interface ApiKeySummary {
  id: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  createdAt: Date;
  rotatedAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface VerifiedApiKey {
  id: string;
  userId: string;
  scopes: ApiKeyScope[];
}

function hashKey(rawKey: string): string {
  return createHmac("sha256", config.sessionSecret).update(rawKey).digest("hex");
}

function generateRawKey(): { rawKey: string; prefix: string } {
  const secret = randomBytes(32).toString("base64url");
  const rawKey = `${KEY_PREFIX}${secret}`;
  return { rawKey, prefix: rawKey.slice(0, KEY_PREFIX.length + PREFIX_DISPLAY_LEN) };
}

function summarize(row: {
  id: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  createdAt: Date;
  rotatedAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}): ApiKeySummary {
  return {
    id: row.id,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

export async function listApiKeys(userId: string): Promise<ApiKeySummary[]> {
  const rows = await prisma.apiKey.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(summarize);
}

export async function issueApiKey(params: {
  userId: string;
  scopes: ApiKeyScope[];
  ip?: string | null;
}): Promise<{ rawKey: string; summary: ApiKeySummary }> {
  const { rawKey, prefix } = generateRawKey();

  const summary = await prisma.$transaction(async (tx) => {
    const expiresAt = defaultExpiry();
    const row = await tx.apiKey.create({
      data: {
        userId: params.userId,
        keyPrefix: prefix,
        keyHash: hashKey(rawKey),
        scopes: params.scopes,
        expiresAt,
      },
    });
    await writeAuditLog(tx, {
      actorUserId: params.userId,
      action: "api_key.issued",
      targetType: "ApiKey",
      targetId: row.id,
      after: { scopes: params.scopes, keyPrefix: prefix, expiresAt },
      ip: params.ip,
    });
    return summarize(row);
  });

  return { rawKey, summary };
}

export async function rotateApiKey(params: {
  id: string;
  userId: string;
  ip?: string | null;
}): Promise<{ rawKey: string; summary: ApiKeySummary } | null> {
  const { rawKey, prefix } = generateRawKey();

  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();
    // This conditional update is the concurrency boundary, and it has to come
    // first. Reading the row and then updating it let two simultaneous
    // rotations both succeed with different secrets: last write won and the
    // loser was handed a key that never authenticated. Postgres re-evaluates
    // this WHERE clause after taking the row lock, so exactly one caller sees
    // count === 1 and the other gets the not-found answer.
    const revoked = await tx.apiKey.updateMany({
      where: { id: params.id, userId: params.userId, revokedAt: null },
      data: { revokedAt: now, rotatedAt: now },
    });
    if (revoked.count !== 1) return null;
    const existing = await tx.apiKey.findUnique({ where: { id: params.id } });
    if (!existing) return null;
    const expiresAt = defaultExpiry();
    // A NEW row, rather than a new secret on the old row. The MCP session
    // binding is `api-key:<id>`, so rotating in place kept the id and left the
    // sessions opened with the old secret alive. A fresh id retires them.
    const row = await tx.apiKey.create({
      data: {
        userId: params.userId,
        keyPrefix: prefix,
        keyHash: hashKey(rawKey),
        scopes: existing.scopes,
        expiresAt,
        // Stamped on the NEW row as well as the retired one: the dashboard
        // reads `rotatedAt` off the key it was just handed to show "rotated
        // <when>", and a fresh row with a null timestamp would have made a
        // rotation look like a first issue.
        rotatedAt: now,
      },
    });
    await writeAuditLog(tx, {
      actorUserId: params.userId,
      action: "api_key.rotated",
      targetType: "ApiKey",
      targetId: row.id,
      before: { keyPrefix: existing.keyPrefix, previousKeyId: params.id },
      after: { keyPrefix: prefix, rotatedAt: now, expiresAt, scopes: existing.scopes },
      ip: params.ip,
    });
    return { summary: summarize(row), retiredKeyHash: existing.keyHash };
  });

  if (!result) return null;
  // Rotation retires the old secret immediately -- no TTL grace. The NEW key
  // needs no invalidation: its hash has never been cached, because only a
  // successful verification writes an entry.
  await cache.del(apiKeyCacheKey(result.retiredKeyHash));

  return { rawKey, summary: result.summary };
}

export async function revokeApiKey(params: {
  id: string;
  userId: string;
  ip?: string | null;
}): Promise<ApiKeySummary | null> {
  const existing = await prisma.apiKey.findUnique({ where: { id: params.id } });
  if (!existing || existing.userId !== params.userId) return null;
  if (existing.revokedAt) return summarize(existing);

  const summary = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const row = await tx.apiKey.update({
      where: { id: params.id },
      data: { revokedAt: now },
    });
    await writeAuditLog(tx, {
      actorUserId: params.userId,
      action: "api_key.revoked",
      targetType: "ApiKey",
      targetId: row.id,
      after: { revokedAt: now },
      ip: params.ip,
    });
    return summarize(row);
  });

  // Revocation must take effect on the next request, not at the next TTL
  // boundary. `existing` was read before the update, so its hash is the one
  // under which any cached entry was written.
  await cache.del(apiKeyCacheKey(existing.keyHash));

  return summary;
}

export async function verifyApiKey(token: string): Promise<VerifiedApiKey | null> {
  if (!token.startsWith(KEY_PREFIX)) return null;
  const keyHash = hashKey(token);

  // A hit skips the lookup, the owner join AND the `lastUsedAt` write. That
  // last one is intentional: `lastUsedAt` is a coarse "is this key still in
  // use" signal shown in the dashboard, not an audit record -- the audit trail
  // is `admin_audit_log`. Once per TTL per key is ample, and it turns a write
  // on every single request into roughly one a minute.
  const cached = await cache.get<CachedApiKey>(apiKeyCacheKey(keyHash));
  if (cached) {
    if (cached.expiresAtMs !== null && cached.expiresAtMs <= Date.now()) return null;
    return cached.verified;
  }

  const row = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      userId: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
      // An API key outlives the session that minted it, so the owner's account
      // status has to be re-read on every use. Without this join a suspended
      // account keeps executing MCP tools indefinitely through a key issued
      // before the suspension — the OAuth path already refuses that, and this
      // is what closed the gap between the two credential kinds.
      user: { select: { status: true } },
    },
  });

  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  if (row.user.status !== "active") return null;

  // Stash lastUsedAt asynchronously
  void prisma.apiKey.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});

  const verified: VerifiedApiKey = { id: row.id, userId: row.userId, scopes: row.scopes };
  // Written only on the success path, below every rejection above: a revoked,
  // expired or suspended key must never become a cache entry that outlives the
  // check that rejected it.
  await cache.set<CachedApiKey>(
    apiKeyCacheKey(keyHash),
    { verified, expiresAtMs: row.expiresAt ? row.expiresAt.getTime() : null },
    API_KEY_CACHE_TTL_SEC,
  );
  return verified;
}

/** Minimal overview metric: unlike the administrative roster, this exposes
 * no owner identity, key prefix, scopes, or lifecycle timestamps. */
export async function adminCountActiveApiKeys(): Promise<number> {
  const now = new Date();
  return prisma.apiKey.count({
    where: {
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });
}

export async function adminListApiKeys(params?: {
  userId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: (ApiKeySummary & { user: { id: string; email: string | null; displayName: string } })[]; total: number }> {
  const where = params?.userId ? { userId: params.userId } : {};
  const [rows, total] = await Promise.all([
    prisma.apiKey.findMany({
      where,
      include: { user: { select: { id: true, email: true, displayName: true } } },
      orderBy: { createdAt: "desc" },
      take: params?.limit ?? 50,
      skip: params?.offset ?? 0,
    }),
    prisma.apiKey.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      ...summarize(r),
      user: r.user,
    })),
    total,
  };
}

export async function adminRevokeApiKey(
  id: string,
  actorUserId: string,
  context?: { ip?: string; userAgent?: string }
): Promise<ApiKeySummary | null> {
  const existing = await prisma.apiKey.findUnique({ where: { id } });
  if (!existing) return null;
  if (existing.revokedAt) return summarize(existing);

  const summary = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const row = await tx.apiKey.update({
      where: { id },
      data: { revokedAt: now },
    });
    await writeAuditLog(tx, {
      actorUserId,
      action: "admin.api_key.revoked",
      targetType: "ApiKey",
      targetId: row.id,
      after: { revokedAt: now },
      ip: context?.ip,
      userAgent: context?.userAgent,
    });
    return summarize(row);
  });

  // Same immediacy as the self-service path above. This was the easier one to
  // miss: an operator revoking someone else's key is exactly the case where a
  // minute of continued access is least acceptable.
  await cache.del(apiKeyCacheKey(existing.keyHash));

  return summary;
}
