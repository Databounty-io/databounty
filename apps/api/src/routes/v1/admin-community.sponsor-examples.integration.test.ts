// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for GET /v1/admin/sponsor-examples — the platform-wide queue of
 * sponsor reference samples (`Artifact.kind === "sponsor_reference"`)
 * awaiting admin review. Ported from v1 (databounty-api/src/routes/v1/admin.ts
 * `GET /sponsor-examples`), which never made it into this rebuild: the review
 * ACTION (`POST /v1/artifacts/:id/sponsor-review`) already existed here with
 * nothing surfacing what needed reviewing.
 *
 * A sample is attached to exactly one of two owners at any time (see the
 * Artifact model's INVARIANT comment): an already-minted Bounty (its
 * community pool) or, pre-mint, a DatasetRequest (`bountyId` null,
 * `datasetRequestId` set). This suite proves both owners are actually
 * surfaced — a `bounty: {...}` relation filter alone would silently exclude
 * every pre-mint sample — and that a reviewed (approved/rejected) sample
 * drops off the queue.
 *
 * Same harness as the other `*.integration.test.ts` files in this directory
 * (`admin-community.publication-retry-backfill.integration.test.ts`,
 * `community.requests-samples.integration.test.ts`): a real Fastify app via
 * `buildApp()`, `app.inject()` over HTTP, a real Postgres database guarded by
 * `requireDisposableDatabase()`. Assertions locate this test's own fixture
 * rows by id inside the response rather than asserting an exact array length,
 * since the queue is platform-wide and other fixtures may coexist in the same
 * disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ArtifactKind,
  ArtifactStatus,
  AuditMode,
  DatasetCategory,
  SponsorExampleReviewStatus,
} from "@prisma/client";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdDatasetTypeIds: string[] = [];
const createdBountyIds: string[] = [];
const createdRequestIds: string[] = [];
const createdArtifactIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.artifact.deleteMany({ where: { id: { in: createdArtifactIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.datasetRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: createdDatasetTypeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function signupUser(emailPrefix: string, opts: { admin?: boolean } = {}) {
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
  if (opts.admin) {
    await prisma.userRole.create({ data: { userId, role: "admin" } });
  }
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { userId, cookie };
}

async function seedDatasetType(id: string) {
  const type = await prisma.datasetType.create({
    data: {
      id,
      domain: "coding",
      name: `Sponsor Examples Fixture Type ${id}`,
      description: "Fixture dataset type for the admin sponsor-examples queue test.",
      status: "active",
      origin: "platform",
      category: "implementation",
      trustTier: "llm_verified",
      fields: [{ key: "instruction", label: "Instruction", role: "instruction", required: true }],
      verification: { pipeline: ["schema", "human_audit"], dedupeFields: ["instruction"], auditOptions: [25, 100] },
      difficultyLevels: ["beginner", "intermediate", "advanced"],
      complexityScore: 2,
      verificationUnits: 1,
    },
  });
  createdDatasetTypeIds.push(type.id);
  return type.id;
}

async function seedBounty(params: { requesterUserId: string; datasetTypeId: string }) {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: params.requesterUserId,
      communityRequesterUserId: params.requesterUserId,
      kind: "community",
      title: `Sponsor examples fixture bounty ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      description: "A fixture community pool used to test the admin sponsor-examples queue.",
      datasetCategory: DatasetCategory.implementation,
      language: "TypeScript",
      framework: "Node.js",
      targetItems: BigInt(100),
      requiredSponsorExamples: 3,
      auditMode: AuditMode.partial,
      auditCoveragePct: 10,
      holdDays: 0,
      karmaPerAcceptedItem: 10,
      communityLicense: "CC-BY-4.0",
      datasetTypeId: params.datasetTypeId,
    },
  });
  createdBountyIds.push(bounty.id);
  return bounty.id;
}

async function seedRequest(params: { requesterUserId: string; datasetTypeId: string }) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const request = await prisma.datasetRequest.create({
    data: {
      requesterUserId: params.requesterUserId,
      title: `Sponsor examples fixture request ${stamp}`,
      description: "A fixture pre-mint dataset request used to test the admin sponsor-examples queue.",
      datasetTypeId: params.datasetTypeId,
      proposedLicense: "CC-BY-4.0",
      language: "TypeScript",
      framework: "Node.js",
      targetItems: 50,
      difficultyMix: "balanced",
      auditCoveragePct: 10,
      idempotencyKey: `sponsor-examples-fixture-${stamp}`,
      status: "submitted",
    },
  });
  createdRequestIds.push(request.id);
  return request.id;
}

async function seedSample(params: {
  ownerUserId: string;
  bountyId?: string;
  datasetRequestId?: string;
  sponsorReviewStatus: SponsorExampleReviewStatus;
  filename?: string;
}) {
  const artifact = await prisma.artifact.create({
    data: {
      kind: ArtifactKind.sponsor_reference,
      status: ArtifactStatus.ready,
      sponsorReviewStatus: params.sponsorReviewStatus,
      ownerUserId: params.ownerUserId,
      bountyId: params.bountyId,
      datasetRequestId: params.datasetRequestId,
      filename: params.filename ?? "sample.json",
      contentType: "application/json",
      storageKey: `artifacts/sponsor_reference/fixture/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
    },
  });
  createdArtifactIds.push(artifact.id);
  return artifact.id;
}

describe("GET /v1/admin/sponsor-examples", () => {
  it("surfaces a pending bounty-owned sample with owner.type 'bounty' and a populated contract/scope", async () => {
    const admin = await signupUser("sponsorex-admin-bounty", { admin: true });
    const sponsor = await signupUser("sponsorex-sponsor-bounty");
    const datasetTypeId = await seedDatasetType(`sponsor_ex_bounty_${Date.now()}`);
    const bountyId = await seedBounty({ requesterUserId: sponsor.userId, datasetTypeId });
    const artifactId = await seedSample({
      ownerUserId: sponsor.userId,
      bountyId,
      sponsorReviewStatus: SponsorExampleReviewStatus.pending,
      filename: "bounty-owned-sample.json",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/sponsor-examples",
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { examples: Array<Record<string, unknown>> };
    const row = body.examples.find((e) => e.id === artifactId);
    expect(row).toBeTruthy();
    expect(row!.bountyId).toBe(bountyId);
    expect(row!.status).toBe("pending");
    expect(row!.filename).toBe("bounty-owned-sample.json");
    expect(row!.downloadUrl).toBe(`/v1/artifacts/${artifactId}/content`);
    expect(row!.owner).toEqual({ type: "bounty", id: bountyId, title: expect.any(String) });
    expect(row!.contract).toMatchObject({ id: datasetTypeId });
    expect(row!.scope).toMatchObject({
      language: "TypeScript",
      framework: "Node.js",
      targetItems: 100,
      auditCoveragePct: 10,
    });
    // Advisory evidence never ran for this fixture — must be honestly null,
    // never defaulted to a pass.
    expect(row!.evidence).toEqual({ llmReview: null, similarity: null });
  });

  it("surfaces a pending pre-mint dataset-request-owned sample with owner.type 'dataset_request' and the request's own status", async () => {
    const admin = await signupUser("sponsorex-admin-request", { admin: true });
    const sponsor = await signupUser("sponsorex-sponsor-request");
    const datasetTypeId = await seedDatasetType(`sponsor_ex_request_${Date.now()}`);
    const requestId = await seedRequest({ requesterUserId: sponsor.userId, datasetTypeId });
    const artifactId = await seedSample({
      ownerUserId: sponsor.userId,
      datasetRequestId: requestId,
      sponsorReviewStatus: SponsorExampleReviewStatus.needs_changes,
      filename: "pre-mint-sample.json",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/sponsor-examples",
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { examples: Array<Record<string, unknown>> };
    const row = body.examples.find((e) => e.id === artifactId);
    expect(row).toBeTruthy();
    // No bounty exists yet — bountyId must be null, not fabricated.
    expect(row!.bountyId).toBeNull();
    expect(row!.status).toBe("needs_changes");
    expect(row!.owner).toEqual({ type: "dataset_request", id: requestId, title: expect.any(String), requestStatus: "submitted" });
    expect(row!.contract).toMatchObject({ id: datasetTypeId });
    expect(row!.scope).toMatchObject({
      language: "TypeScript",
      framework: "Node.js",
      targetItems: 50,
      difficultyMix: "balanced",
      auditCoveragePct: 10,
    });
  });

  it("excludes an already-reviewed (approved or rejected) sample from the queue", async () => {
    const admin = await signupUser("sponsorex-admin-reviewed", { admin: true });
    const sponsor = await signupUser("sponsorex-sponsor-reviewed");
    const datasetTypeId = await seedDatasetType(`sponsor_ex_reviewed_${Date.now()}`);
    const requestId = await seedRequest({ requesterUserId: sponsor.userId, datasetTypeId });
    const approvedId = await seedSample({
      ownerUserId: sponsor.userId,
      datasetRequestId: requestId,
      sponsorReviewStatus: SponsorExampleReviewStatus.approved,
      filename: "approved-sample.json",
    });
    const rejectedId = await seedSample({
      ownerUserId: sponsor.userId,
      datasetRequestId: requestId,
      sponsorReviewStatus: SponsorExampleReviewStatus.rejected,
      filename: "rejected-sample.json",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/sponsor-examples",
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { examples: Array<Record<string, unknown>> };
    const ids = body.examples.map((e) => e.id);
    expect(ids).not.toContain(approvedId);
    expect(ids).not.toContain(rejectedId);
  });

  it("refuses a non-admin caller with 403", async () => {
    const plain = await signupUser("sponsorex-plain-caller");

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/sponsor-examples",
      headers: { cookie: plain.cookie },
    });

    expect(res.statusCode).toBe(403);
  });
});
