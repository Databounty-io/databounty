// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for GET /v1/bounties/:id (routes/v1/bounties.ts,
 * services/bounties.ts#getCommunityPool) never including a `publicSamples`
 * field.
 *
 * The public landing bounty-detail page
 * (apps/landing/app/(site)/bounties/[id]/view.tsx) reads
 * `bounty.publicSamples` to render reference samples publicly. Before this
 * fix the field was never sent at all, so no public bounty page could ever
 * show a sample or the "+N more hidden" indicator.
 *
 * buildPublicSamples() (services/artifacts.ts) deliberately reuses
 * canReadArtifact(artifact, null) — the exact same check the world-readable
 * GET /v1/artifacts/:id/content route applies to an anonymous caller — to
 * decide `sample.available`, rather than inventing a new visibility rule.
 * This test proves that end to end with real artifacts:
 *  - an approved+ready sponsor_reference sample with visibility "public_sample"
 *    comes back `available: true` with its real (non-fabricated) file content
 *    inlined and a downloadUrl that a real anonymous GET can actually fetch.
 *  - an approved+ready sponsor_reference sample WITHOUT that visibility comes
 *    back `available: false` (present, not silently dropped) — this is what
 *    powers the "+N more hidden" affordance.
 *  - a sample that was never approved (still pending review) is excluded
 *    from the array entirely, not merely marked unavailable — a request
 *    still under review must never leak its private review-draft content on
 *    a public bounty page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { putArtifactData } from "../../services/storage.js";
import { ArtifactKind, ArtifactStatus, ArtifactVisibility, BountyKind, BountyStatus, SponsorExampleReviewStatus } from "@prisma/client";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdDatasetTypeIds: string[] = [];
const createdBountyIds: string[] = [];
const createdArtifactIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.artifact.deleteMany({ where: { id: { in: createdArtifactIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: createdDatasetTypeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function seedRequester() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await prisma.user.create({
    data: { authMethod: "email", email: `public-samples-${stamp}@local.test`, displayName: "Public Samples Fixture Requester" },
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function seedDatasetType(id: string) {
  const type = await prisma.datasetType.create({
    data: {
      id,
      domain: "coding",
      name: `Public Samples Fixture Type ${id}`,
      description: "Fixture dataset type for the GET /v1/bounties/:id publicSamples test.",
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
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: params.requesterUserId,
      kind: BountyKind.community,
      title: `Public samples fixture bounty ${stamp}`,
      description: "A fixture community bounty used to test publicSamples.",
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
      datasetTypeId: params.datasetTypeId,
    },
  });
  createdBountyIds.push(bounty.id);
  return bounty.id;
}

async function seedSample(params: {
  bountyId: string;
  ownerUserId: string;
  visibility: ArtifactVisibility;
  status: ArtifactStatus;
  sponsorReviewStatus: SponsorExampleReviewStatus | null;
  content: string;
}) {
  const storageKey = `artifacts/sponsor_reference/fixture-public/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await putArtifactData(storageKey, Buffer.from(params.content, "utf8"), "application/json");
  const artifact = await prisma.artifact.create({
    data: {
      kind: ArtifactKind.sponsor_reference,
      visibility: params.visibility,
      status: params.status,
      sponsorReviewStatus: params.sponsorReviewStatus,
      ownerUserId: params.ownerUserId,
      bountyId: params.bountyId,
      filename: "sample.json",
      contentType: "application/json",
      storageKey,
    },
  });
  createdArtifactIds.push(artifact.id);
  return artifact.id;
}

describe("GET /v1/bounties/:id — publicSamples", () => {
  it("includes a public_sample-visibility approved sample as available with real inlined content and a working anonymous download, and an approved-but-not-public sample as present but unavailable", async () => {
    const requesterUserId = await seedRequester();
    const datasetTypeId = await seedDatasetType(`public_samples_${Date.now()}`);
    const bountyId = await seedBounty({ requesterUserId, datasetTypeId });

    const publicContent = JSON.stringify({ instruction: "Fix the off-by-one bug in sum()." });
    const publicArtifactId = await seedSample({
      bountyId,
      ownerUserId: requesterUserId,
      visibility: ArtifactVisibility.public_sample,
      status: ArtifactStatus.ready,
      sponsorReviewStatus: SponsorExampleReviewStatus.approved,
      content: publicContent,
    });

    await seedSample({
      bountyId,
      ownerUserId: requesterUserId,
      visibility: ArtifactVisibility.private,
      status: ArtifactStatus.ready,
      sponsorReviewStatus: SponsorExampleReviewStatus.approved,
      content: JSON.stringify({ instruction: "Approved but never marked public." }),
    });

    // Never approved — must be excluded entirely, not just marked unavailable.
    await seedSample({
      bountyId,
      ownerUserId: requesterUserId,
      visibility: ArtifactVisibility.public_sample,
      status: ArtifactStatus.ready,
      sponsorReviewStatus: null,
      content: JSON.stringify({ instruction: "Still pending review." }),
    });

    const res = await app.inject({ method: "GET", url: `/v1/bounties/${bountyId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { bounty: { id: string; publicSamples?: Array<{ id: string; downloadUrl: string; sample: { available: boolean; content?: string; reason?: string } }> } };

    expect(body.bounty.id).toBe(bountyId);
    expect(body.bounty.publicSamples).toBeDefined();
    // Only the two approved+ready samples — the still-pending one is excluded.
    expect(body.bounty.publicSamples).toHaveLength(2);

    const publicRow = body.bounty.publicSamples!.find((s) => s.id === publicArtifactId)!;
    expect(publicRow.sample.available).toBe(true);
    expect(publicRow.sample.content).toBe(publicContent);

    const hiddenRow = body.bounty.publicSamples!.find((s) => s.id !== publicArtifactId)!;
    expect(hiddenRow.sample.available).toBe(false);
    expect(hiddenRow.sample.reason).toBeTruthy();

    // The download link this powers must actually work anonymously — no
    // cookie, no API key — for the one marked available, proving `available`
    // isn't a claim the real content route would contradict.
    const download = await app.inject({ method: "GET", url: publicRow.downloadUrl });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe(publicContent);

    // And the hidden one's download route genuinely 401s anonymously —
    // proving `available: false` is honest, not just a display flag.
    const hiddenDownload = await app.inject({ method: "GET", url: hiddenRow.downloadUrl });
    expect(hiddenDownload.statusCode).toBe(401);
  });

  it("returns an empty publicSamples array (not undefined) for a bounty with no reference samples", async () => {
    const requesterUserId = await seedRequester();
    const datasetTypeId = await seedDatasetType(`public_samples_empty_${Date.now()}`);
    const bountyId = await seedBounty({ requesterUserId, datasetTypeId });

    const res = await app.inject({ method: "GET", url: `/v1/bounties/${bountyId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { bounty: { publicSamples?: unknown[] } };
    expect(body.bounty.publicSamples).toEqual([]);
  });
});
