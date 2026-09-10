// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for GET /v1/community/requests/:id
 * (routes/v1/community.ts) omitting `samples`/`sampleGate`.
 *
 * The web sponsor-facing detail page
 * (apps/web/components/dataset-request-detail.tsx) requires `sampleGate` to
 * be non-null before it renders the reference-samples section at all, so a
 * response with those fields missing made that whole section invisible for
 * every request, regardless of status.
 *
 * This test proves two things:
 *  1. A real request with real sponsor_reference artifacts, fetched through
 *     this sponsor-facing route, returns non-null `sampleGate` and a
 *     `samples` array whose counts match those artifacts.
 *  2. Those numbers are IDENTICAL to what buildSampleGate() (the exact helper
 *     the admin-side request list in routes/v1/admin-community.ts uses for
 *     its own sampleGate column) computes for the same request id — i.e. the
 *     fix reuses the shared helper rather than reimplementing the count.
 *
 * Same harness/self-guard pattern as the other *.integration.test.ts files:
 * Fastify inject() against buildApp(), no port bound, refuses to run outside
 * the disposable verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { buildSampleGate } from "../../services/artifacts.js";
import { ArtifactKind, ArtifactStatus, SponsorExampleReviewStatus } from "@prisma/client";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdDatasetTypeIds: string[] = [];
const createdRequestIds: string[] = [];
const createdArtifactIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.artifact.deleteMany({ where: { id: { in: createdArtifactIds } } });
  await prisma.datasetRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: createdDatasetTypeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function signupSponsor(emailPrefix: string) {
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
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

async function seedDatasetType(id: string) {
  const type = await prisma.datasetType.create({
    data: {
      id,
      domain: "coding",
      name: `Samples Fixture Type ${id}`,
      description: "Fixture dataset type for the request samples/sampleGate test.",
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

async function seedRequest(params: { requesterUserId: string; datasetTypeId: string }) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const request = await prisma.datasetRequest.create({
    data: {
      requesterUserId: params.requesterUserId,
      title: `Samples fixture request ${stamp}`,
      description: "A fixture community dataset request used to test samples/sampleGate.",
      datasetTypeId: params.datasetTypeId,
      proposedLicense: "CC-BY-4.0",
      language: "TypeScript",
      framework: "Node.js",
      targetItems: 50,
      difficultyMix: "balanced",
      auditCoveragePct: 10,
      idempotencyKey: `samples-fixture-${stamp}`,
      status: "submitted",
    },
  });
  createdRequestIds.push(request.id);
  return request.id;
}

async function seedSample(params: {
  requestId: string;
  ownerUserId: string;
  sponsorReviewStatus: SponsorExampleReviewStatus | null;
}) {
  const artifact = await prisma.artifact.create({
    data: {
      kind: ArtifactKind.sponsor_reference,
      status: ArtifactStatus.ready,
      sponsorReviewStatus: params.sponsorReviewStatus,
      ownerUserId: params.ownerUserId,
      datasetRequestId: params.requestId,
      filename: "sample.json",
      contentType: "application/json",
      storageKey: `artifacts/sponsor_reference/fixture/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
    },
  });
  createdArtifactIds.push(artifact.id);
  return artifact.id;
}

describe("GET /v1/community/requests/:id — samples and sampleGate", () => {
  it("returns non-null sampleGate and a samples array matching real approved/pending artifacts, identical to buildSampleGate()", async () => {
    const { userId, cookie } = await signupSponsor("samplesreq");
    const datasetTypeId = await seedDatasetType(`samples_req_${Date.now()}`);
    const requestId = await seedRequest({ requesterUserId: userId, datasetTypeId });

    // Two approved, one pending — mirrors a real in-review request with a
    // mix of reviewed and unreviewed reference samples.
    await seedSample({ requestId, ownerUserId: userId, sponsorReviewStatus: SponsorExampleReviewStatus.approved });
    await seedSample({ requestId, ownerUserId: userId, sponsorReviewStatus: SponsorExampleReviewStatus.approved });
    await seedSample({ requestId, ownerUserId: userId, sponsorReviewStatus: null });

    const res = await app.inject({
      method: "GET",
      url: `/v1/community/requests/${requestId}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { request: { id: string }; samples?: unknown[]; sampleGate?: unknown };

    expect(body.request.id).toBe(requestId);
    expect(body.sampleGate).not.toBeNull();
    expect(body.samples).toBeDefined();
    expect(body.samples).toHaveLength(3);

    // The exact numbers the admin request-list route
    // (routes/v1/admin-community.ts) would compute for this same request,
    // via the identical shared helper — proves both surfaces agree.
    const expectedGate = await buildSampleGate(requestId);
    expect(body.sampleGate).toEqual(expectedGate);
    expect(expectedGate.approved).toBe(2);
    expect(expectedGate.pending).toBe(1);
    expect(expectedGate.ok).toBe(false); // min is 3 approved; only 2 approved here
  });

  it("still 404s for a request owned by a different user (ownership scoping unaffected by the new fields)", async () => {
    const owner = await signupSponsor("samplesowner");
    const stranger = await signupSponsor("samplesstranger");
    const datasetTypeId = await seedDatasetType(`samples_scope_${Date.now()}`);
    const requestId = await seedRequest({ requesterUserId: owner.userId, datasetTypeId });

    const res = await app.inject({
      method: "GET",
      url: `/v1/community/requests/${requestId}`,
      headers: { cookie: stranger.cookie },
    });

    expect(res.statusCode).toBe(404);
  });
});
