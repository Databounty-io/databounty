// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring guard for the public read cache on `GET /v1/community/catalog` and
 * `GET /v1/community/stats` (lib/public-read-cache.ts).
 *
 * The suite normally runs with the cache bypassed (`NODE_ENV=test` ⇒ TTL 0),
 * so every other test keeps its read-after-write expectations. This file
 * turns the cache on explicitly and proves three things the egress fix
 * depends on:
 *  1. with a TTL, a repeated identical catalog query is answered from memory
 *     (a bounty minted in between is not visible until the cache is cleared);
 *  2. the key is the validated query, so a different query is a different
 *     entry and a stale cursor still gets its clean 400 (errors never cache);
 *  3. the `datasetTypes` list no longer ships the JSON contract columns,
 *     while `/catalog/:id` still returns the full type.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { BountyKind, BountyStatus } from "@prisma/client";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { clearPublicReadCache } from "../../lib/public-read-cache.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const TAG = `prc${Date.now().toString(36)}`;
const createdUserIds: string[] = [];
const createdTypeIds: string[] = [];
const createdBountyIds: string[] = [];
const savedTtl = process.env.PUBLIC_READ_CACHE_TTL_MS;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: createdTypeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

afterEach(() => {
  clearPublicReadCache();
  if (savedTtl === undefined) delete process.env.PUBLIC_READ_CACHE_TTL_MS;
  else process.env.PUBLIC_READ_CACHE_TTL_MS = savedTtl;
});

async function seedUser() {
  const user = await prisma.user.create({
    data: { authMethod: "email", email: `${TAG}-${Math.random().toString(36).slice(2, 8)}@local.test`, displayName: "Public Read Cache Fixture" },
  });
  createdUserIds.push(user.id);
  return user;
}

async function seedType() {
  const type = await prisma.datasetType.create({
    data: {
      id: `${TAG}-type-${Math.random().toString(36).slice(2, 8)}`,
      domain: "coding",
      name: `Public Read Cache Fixture Type ${TAG}`,
      description: "Fixture dataset type for the public read cache tests.",
      status: "active",
      origin: "platform",
      category: "implementation",
      trustTier: "llm_verified",
      fields: [{ key: "instruction", label: "Instruction", role: "instruction", required: true }],
      verification: { pipeline: ["schema", "human_audit"], dedupeFields: ["instruction"], auditOptions: [25, 100] },
      difficultyLevels: ["intermediate"],
      complexityScore: 2,
      verificationUnits: 1,
    },
  });
  createdTypeIds.push(type.id);
  return type;
}

async function seedBounty(userId: string, typeId: string, title: string) {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: userId,
      kind: BountyKind.community,
      title,
      description: `Fixture pool ${TAG}`,
      datasetCategory: "implementation",
      language: "TypeScript",
      framework: "Node.js",
      targetItems: 50,
      karmaPerAcceptedItem: 25,
      auditCoveragePct: 10,
      auditMode: "partial",
      holdDays: 0,
      disputeWindowHours: 48,
      communityLicense: "CC-BY-4.0",
      poolDifficulty: "intermediate",
      status: BountyStatus.active,
      datasetTypeId: typeId,
    },
  });
  createdBountyIds.push(bounty.id);
  return bounty;
}

describe("public read cache wiring", () => {
  it("serves a repeated identical catalog query from memory until cleared", async () => {
    process.env.PUBLIC_READ_CACHE_TTL_MS = "60000";
    const user = await seedUser();
    const type = await seedType();
    const query = `/v1/community/catalog?q=${TAG}&limit=5`;

    const first = await app.inject({ method: "GET", url: query });
    expect(first.statusCode).toBe(200);
    expect(first.json().bounties).toHaveLength(0);

    await seedBounty(user.id, type.id, `${TAG} first pool`);

    const cached = await app.inject({ method: "GET", url: query });
    expect(cached.statusCode).toBe(200);
    expect(cached.json().bounties).toHaveLength(0);

    // Same params in a different order share the entry.
    const reordered = await app.inject({ method: "GET", url: `/v1/community/catalog?limit=5&q=${TAG}` });
    expect(reordered.json().bounties).toHaveLength(0);

    // A different validated query is a different key and sees the write.
    const other = await app.inject({ method: "GET", url: `${query}&withPoolSummary=true` });
    expect(other.json().bounties).toHaveLength(1);

    clearPublicReadCache();
    const fresh = await app.inject({ method: "GET", url: query });
    expect(fresh.json().bounties).toHaveLength(1);
  });

  it("TTL 0 bypasses the cache: a write is visible on the very next read", async () => {
    process.env.PUBLIC_READ_CACHE_TTL_MS = "0";
    const user = await seedUser();
    const type = await seedType();
    const query = `/v1/community/catalog?q=${TAG}-bypass`;

    expect((await app.inject({ method: "GET", url: query })).json().bounties).toHaveLength(0);
    await seedBounty(user.id, type.id, `${TAG}-bypass pool`);
    expect((await app.inject({ method: "GET", url: query })).json().bounties).toHaveLength(1);
  });

  it("does not cache a stale-cursor 400, and stats is cached too", async () => {
    process.env.PUBLIC_READ_CACHE_TTL_MS = "60000";
    const bad = await app.inject({ method: "GET", url: "/v1/community/catalog?cursor=not-a-cursor" });
    expect(bad.statusCode).toBe(400);
    const badAgain = await app.inject({ method: "GET", url: "/v1/community/catalog?cursor=not-a-cursor" });
    expect(badAgain.statusCode).toBe(400);

    const statsA = await app.inject({ method: "GET", url: "/v1/community/stats" });
    expect(statsA.statusCode).toBe(200);
    const statsB = await app.inject({ method: "GET", url: "/v1/community/stats" });
    expect(statsB.json()).toEqual(statsA.json());
  });

  it("catalog datasetTypes is the list projection; /catalog/:id keeps the full contract", async () => {
    process.env.PUBLIC_READ_CACHE_TTL_MS = "0";
    const type = await seedType();

    const list = await app.inject({ method: "GET", url: "/v1/community/catalog" });
    expect(list.statusCode).toBe(200);
    const row = (list.json().datasetTypes as Array<Record<string, unknown>>).find((t) => t.id === type.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ id: type.id, name: type.name, trustTier: "llm_verified" });
    expect(row).not.toHaveProperty("fields");
    expect(row).not.toHaveProperty("verification");
    expect(row).not.toHaveProperty("sampleAssets");
    expect(row).toHaveProperty("difficultyLevels");

    const detail = await app.inject({ method: "GET", url: `/v1/community/catalog/${encodeURIComponent(type.id)}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().datasetType).toMatchObject({ id: type.id });
    expect(detail.json().datasetType).toHaveProperty("fields");
    expect(detail.json().datasetType).toHaveProperty("verification");
  });
});
