// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the mint-twice race and the two fail-closed gates
 * on POST /v1/admin/community/requests/:id/implement
 * (routes/v1/admin-community.ts).
 *
 * Before the fix: the "not yet minted" check (`findUnique`) and the `Bounty`
 * create/`mintedBountyId` write were two separate statements outside any
 * shared lock, so two concurrent /implement calls for the SAME approved
 * request could each observe `mintedBountyId: null` and each create their
 * own `Bounty` row — the request ends up pointing at whichever transaction
 * committed last, silently orphaning the other bounty.
 *
 * After the fix: both statements share one transaction that takes a
 * `SELECT ... FOR UPDATE` lock on the `dataset_requests` row first, so the
 * second concurrent call always observes the first call's write and returns
 * the SAME already-minted bounty instead of creating a second one.
 *
 * Also covers the "active ⇒ priced" fail-closed gate added alongside the
 * race fix: a dataset type with a null complexityScore/verificationUnits
 * must not back a mint, with a 409 naming the reason (not a generic 500).
 *
 * Same harness/self-guard pattern as the other *.integration.test.ts files
 * in this directory: Fastify inject() against buildApp(), no port bound,
 * refuses to run outside the disposable verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ArtifactKind, ArtifactStatus, SponsorExampleReviewStatus } from "@prisma/client";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { putArtifactData } from "./services/storage.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdDatasetTypeIds: string[] = [];
const createdRequestIds: string[] = [];
const createdBountyIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // Deletes by both the tracked id AND by FK-reference to a tracked user, so
  // a bounty created by a test that timed out before its id was pushed onto
  // `createdBountyIds` (the concurrency test's transactions can legitimately
  // take a few seconds under the lock) still gets cleaned up instead of
  // leaving a dangling `bounties_requester_user_id_fkey` on the user delete
  // below.
  await prisma.bounty.deleteMany({
    where: { OR: [{ id: { in: createdBountyIds } }, { requesterUserId: { in: createdUserIds } }, { communityRequesterUserId: { in: createdUserIds } }] },
  });
  await prisma.datasetRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: createdDatasetTypeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function signupAdmin(emailPrefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${emailPrefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${emailPrefix}${stamp}`.slice(0, 30), displayName: emailPrefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  await prisma.userRole.create({ data: { userId, role: "admin" } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

async function seedRequester() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await prisma.user.create({
    data: { authMethod: "email", email: `implement-req-${stamp}@local.test`, displayName: "Implement Fixture Requester" },
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function seedDatasetType(params: { id: string; priced: boolean }) {
  const type = await prisma.datasetType.create({
    data: {
      id: params.id,
      domain: "coding",
      name: `Implement Fixture Type ${params.id}`,
      description: "Fixture dataset type for the /implement concurrency + pricing gate test.",
      status: "active",
      origin: "platform",
      category: "implementation",
      trustTier: "llm_verified",
      fields: [{ key: "instruction", label: "Instruction", role: "instruction", required: true }],
      verification: { pipeline: ["schema", "human_audit"], dedupeFields: ["instruction"], auditOptions: [25, 100] },
      difficultyLevels: ["beginner", "intermediate", "advanced"],
      complexityScore: params.priced ? 2 : null,
      verificationUnits: params.priced ? 1 : null,
    },
  });
  createdDatasetTypeIds.push(type.id);
  return type.id;
}

async function seedApprovedRequest(params: { requesterUserId: string; datasetTypeId: string }) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const request = await prisma.datasetRequest.create({
    data: {
      requesterUserId: params.requesterUserId,
      title: `Implement fixture request ${stamp}`,
      description: "A fixture community dataset request used to test the /implement endpoint.",
      datasetTypeId: params.datasetTypeId,
      proposedLicense: "CC-BY-4.0",
      language: "TypeScript",
      framework: "Node.js",
      targetItems: 50,
      difficultyMix: "balanced",
      auditCoveragePct: 10,
      idempotencyKey: `implement-fixture-${stamp}`,
      status: "approved",
    },
  });
  createdRequestIds.push(request.id);
  return request.id;
}

/**
 * Owner decision, 2026-09-09 (admin-community.ts): a community request can no
 * longer be minted with zero approved sponsor_reference samples — both mint
 * routes now return 409 "no_samples" until at least one is approved. Seeds
 * that precondition directly, same pattern as pipeline.integration.test.ts.
 */
async function seedApprovedSample(requestId: string, ownerUserId: string) {
  const storageKey = `artifacts/sponsor_reference/implement-fixture/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await putArtifactData(
    storageKey,
    Buffer.from(JSON.stringify({ instruction: "Fixture reference sample for admin-community-implement.integration.test.ts." }), "utf8"),
    "application/json",
  );
  await prisma.artifact.create({
    data: {
      kind: ArtifactKind.sponsor_reference,
      status: ArtifactStatus.ready,
      sponsorReviewStatus: SponsorExampleReviewStatus.approved,
      ownerUserId,
      datasetRequestId: requestId,
      filename: "sample.json",
      contentType: "application/json",
      storageKey,
    },
  });
}

describe("POST /v1/admin/community/requests/:id/implement", () => {
  it("under two concurrent calls for the same approved request, mints exactly one Bounty (row-lock race fix)", async () => {
    // The whole point of the fix is that the second call now WAITS on the
    // first call's transaction (real Postgres lock contention, not a no-op),
    // so this needs more headroom than vitest's 5s default.
    const { cookie } = await signupAdmin("implementrace");
    const requesterUserId = await seedRequester();
    const datasetTypeId = await seedDatasetType({ id: `implement_race_${Date.now()}`, priced: true });
    const requestId = await seedApprovedRequest({ requesterUserId, datasetTypeId });
    await seedApprovedSample(requestId, requesterUserId);

    const fire = () =>
      app.inject({
        method: "POST",
        url: `/v1/admin/community/requests/${requestId}/implement`,
        headers: { cookie, origin: "http://localhost:3010", "content-type": "application/json" },
        payload: { targetItems: 50 },
      });

    const [a, b] = await Promise.all([fire(), fire()]);

    // Both requests must resolve successfully (the loser of the race gets
    // the idempotent replay branch, not an error) and must name the SAME
    // bounty — never two different ids.
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const bountyIdA = a.json().bounty.id as string;
    const bountyIdB = b.json().bounty.id as string;
    expect(bountyIdA).toBe(bountyIdB);
    createdBountyIds.push(bountyIdA);

    // The real assertion: exactly one Bounty row exists for this request, and
    // the request's own mintedBountyId points at it. Two rows here would mean
    // the lock did not actually serialize the two transactions.
    const bounties = await prisma.bounty.findMany({ where: { title: { startsWith: "Implement fixture request " }, datasetTypeId } });
    expect(bounties).toHaveLength(1);
    expect(bounties[0]!.id).toBe(bountyIdA);

    const request = await prisma.datasetRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(request.mintedBountyId).toBe(bountyIdA);
    expect(request.status).toBe("implemented");
  }, 45_000);

  it("fails closed with 409 when the dataset type has no complexity score / verification units (unpriced)", async () => {
    const { cookie } = await signupAdmin("implementunpriced");
    const requesterUserId = await seedRequester();
    const datasetTypeId = await seedDatasetType({ id: `implement_unpriced_${Date.now()}`, priced: false });
    const requestId = await seedApprovedRequest({ requesterUserId, datasetTypeId });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/community/requests/${requestId}/implement`,
      headers: { cookie, origin: "http://localhost:3010", "content-type": "application/json" },
      payload: { targetItems: 50 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/isn't priced for karma yet/i);

    const request = await prisma.datasetRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(request.mintedBountyId).toBeNull();
    expect(request.status).toBe("approved");
  });
});
