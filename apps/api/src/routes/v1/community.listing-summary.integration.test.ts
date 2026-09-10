// SPDX-License-Identifier: Apache-2.0

/**
 * The listing must carry enough progress for a client to shortlist WITHOUT
 * opening a contract per row, and it must not tell a different story about the
 * same pool than the contract does. Both are load-bearing: the MCP listing
 * description now tells agents to rely on it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactKind, ArtifactStatus, ArtifactVisibility, BountyKind, BountyStatus, DatasetTypeStatus, GenerationMethod, SponsorExampleReviewStatus, SubmissionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { listCommunityPools, getPoolContractForBounty } from "../../services/bounties.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let bountyId: string;
let datasetTypeId: string;
let userId: string;

beforeAll(async () => {
  const dt = await prisma.datasetType.create({
    data: {
      id: `listsum-${stamp}`,
      name: `List Summary ${stamp}`,
      description: "Fixture dataset type for the listing-progress tests.",
      domain: "coding",
      status: DatasetTypeStatus.active,
      origin: "platform",
      category: "implementation",
      trustTier: "llm_verified",
      fields: [{ key: "instruction", label: "Instruction", role: "instruction", required: true }],
      verification: { pipeline: ["schema", "human_audit"] },
      difficultyLevels: ["intermediate", "advanced"],
    },
  });
  datasetTypeId = dt.id;
  const user = await prisma.user.create({
    data: { email: `listsum-${stamp}@example.com`, handle: `ls${stamp}`.slice(0, 20), displayName: "ls", authMethod: "email", passwordHash: "x" },
  });
  userId = user.id;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: userId,
      title: `List Summary Pool ${stamp}`,
      description: "Fixture pool for the listing-progress tests.",
      datasetCategory: "implementation",
      language: "TypeScript",
      framework: "Node.js",
      auditCoveragePct: 10,
      auditMode: "partial",
      holdDays: 0,
      disputeWindowHours: 48,
      communityLicense: "CC-BY-4.0",
      kind: BountyKind.community,
      status: BountyStatus.active,
      datasetTypeId,
      targetItems: 10n,
      acceptedItems: 3n,
      finalAcceptedItems: 2n,
      poolDifficulty: "advanced",
      karmaPerAcceptedItem: 7,
    },
  });
  bountyId = bounty.id;
  // One row per bucket the summary reports separately.
  for (const status of [SubmissionStatus.accepted, SubmissionStatus.accepted, SubmissionStatus.in_audit, SubmissionStatus.rejected, SubmissionStatus.needs_fixes]) {
    await prisma.submission.create({ data: { bountyId, contributorUserId: userId, status, title: `Fixture ${stamp}`, payloadJson: { instruction: `fixture ${stamp}` }, generationMethod: GenerationMethod.human } });
  }
});

afterAll(async () => {
  await prisma.auditItem.deleteMany({ where: { submission: { bountyId } } });
  await prisma.submission.deleteMany({ where: { bountyId } });
  await prisma.bounty.deleteMany({ where: { id: bountyId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.datasetType.deleteMany({ where: { id: datasetTypeId } });
});

describe("community pool listing carries its own progress", () => {
  it("returns difficulty and a poolSummary on every row, so no per-row contract call is needed", async () => {
    const page = await listCommunityPools({ limit: 100 });
    const row = page.bounties.find((b: { id: string }) => b.id === bountyId);
    if (!row) throw new Error("fixture pool missing from the listing");
    expect(row.difficulty).toBe("advanced");
    expect(row.poolSummary).toMatchObject({
      targetItems: 10,
      finalAccepted: 2,
      capacityReserved: 3,
      remainingToTarget: 7,
      accepted: 2,
      validatorReview: 1,
      rejected: 1,
      needsFixes: 1,
      totalSubmitted: 5,
    });
  });

  it("never disagrees with the contract about the same pool", async () => {
    const [page, contract] = await Promise.all([listCommunityPools({ limit: 100 }), getPoolContractForBounty(bountyId)]);
    const row = page.bounties.find((b: { id: string }) => b.id === bountyId);
    if (!row) throw new Error("fixture pool missing from the listing");
    expect(row.poolSummary).toEqual(contract!.bounty.poolSummary);
    // The listing's difficulty is the same field the contract publishes.
    expect(row.difficulty).toBe(contract!.bounty.difficulty);
  });

  it("keeps capacity.poolRemaining equal to the summary's remainingToTarget", async () => {
    const contract = await getPoolContractForBounty(bountyId);
    expect(contract!.capacity.poolRemaining).toBe(contract!.bounty.poolSummary.remainingToTarget);
  });

  it("returns the sponsor's approved work-brief files, never catalog sampleAssets or private uploads", async () => {
    const brief = await prisma.artifact.create({
      data: {
        bountyId,
        ownerUserId: userId,
        kind: ArtifactKind.sponsor_reference,
        visibility: ArtifactVisibility.work_brief,
        status: ArtifactStatus.ready,
        sponsorReviewStatus: SponsorExampleReviewStatus.approved,
        filename: "real-sponsor-example.pdf",
        contentType: "application/pdf",
        storageKey: `artifacts/sponsor_reference/listsum/${stamp}/brief.pdf`,
      },
    });
    const hidden = await prisma.artifact.create({
      data: {
        bountyId,
        ownerUserId: userId,
        kind: ArtifactKind.sponsor_reference,
        visibility: ArtifactVisibility.private,
        status: ArtifactStatus.ready,
        sponsorReviewStatus: SponsorExampleReviewStatus.approved,
        filename: "private-sponsor-note.pdf",
        contentType: "application/pdf",
        storageKey: `artifacts/sponsor_reference/listsum/${stamp}/private.pdf`,
      },
    });
    try {
      const contract = await getPoolContractForBounty(bountyId, { includeSponsorReferences: true });
      const references = contract!.sponsorReferences;
      expect(references).toEqual([
        expect.objectContaining({
          id: brief.id,
          filename: "real-sponsor-example.pdf",
          downloadUrl: `/v1/artifacts/${brief.id}/content`,
        }),
      ]);
      expect(references?.map((artifact) => artifact.id)).not.toContain(hidden.id);
    } finally {
      await prisma.artifact.deleteMany({ where: { id: { in: [brief.id, hidden.id] } } });
    }
  });

  it("does not fabricate a difficulty for a pool that declares none", async () => {
    const bare = await prisma.bounty.create({
      data: { requesterUserId: userId, title: `Bare ${stamp}`, description: "Fixture pool with no declared difficulty.", datasetCategory: "implementation", language: "TypeScript", framework: "Node.js", auditCoveragePct: 10, auditMode: "partial", holdDays: 0, disputeWindowHours: 48, communityLicense: "CC-BY-4.0", kind: BountyKind.community, status: BountyStatus.active, datasetTypeId, targetItems: 5n },
    });
    try {
      const page = await listCommunityPools({ limit: 100 });
      const row = page.bounties.find((b: { id: string }) => b.id === bare.id);
      if (!row) throw new Error("bare fixture pool missing from the listing");
      expect(row.difficulty).toBeNull();
      const contract = await getPoolContractForBounty(bare.id);
      expect(contract!.bounty.difficulty).toBeNull();
      expect(contract!.bounty.difficultyRequirement.selectedDifficulty).toBeNull();
      expect(contract!.bounty.difficultyRequirement.guidance).toContain("no selected difficulty");
    } finally {
      await prisma.bounty.deleteMany({ where: { id: bare.id } });
    }
  });
});
