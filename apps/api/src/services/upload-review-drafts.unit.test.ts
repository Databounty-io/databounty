// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BountyKind, BountyStatus, DatasetTypeStatus, GenerationMethod } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { createUploadReviewDraft, UploadReviewDraftError } from "./upload-review-drafts.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let datasetTypeId: string;
let userId: string;
let bountyId: string;

beforeAll(async () => {
  const dt = await prisma.datasetType.create({
    data: {
      id: `uprd-${stamp}`,
      name: `Upload Review Draft ${stamp}`,
      description: "Fixture dataset type for the upload-review-draft service tests.",
      domain: "coding",
      status: DatasetTypeStatus.active,
      origin: "platform",
      category: "implementation",
      trustTier: "llm_verified",
      fields: [{ key: "instruction", label: "Instruction", role: "instruction", required: true }],
      verification: { pipeline: ["schema", "human_audit"] },
    },
  });
  datasetTypeId = dt.id;
  const user = await prisma.user.create({
    data: { email: `uprd-${stamp}@example.com`, handle: `uprd${stamp}`.slice(0, 20), displayName: "uprd", authMethod: "email", passwordHash: "x" },
  });
  userId = user.id;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: userId,
      title: `Upload Review Draft Pool ${stamp}`,
      description: "Fixture pool for the upload-review-draft service tests.",
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
      targetItems: 10,
    },
  });
  bountyId = bounty.id;
});

afterAll(async () => {
  await prisma.submissionUploadDraft.deleteMany({ where: { bountyId } });
  await prisma.bounty.deleteMany({ where: { id: bountyId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.datasetType.deleteMany({ where: { id: datasetTypeId } });
});

describe("createUploadReviewDraft — the function the REST route and the MCP tool both call", () => {
  it("defaults generationMethod to human, never ai_assisted", async () => {
    const result = await createUploadReviewDraft({ ownerUserId: userId, bountyId });
    const draft = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: result.draftId } });
    expect(draft.generationMethod).toBe(GenerationMethod.human);
  });

  it("stores an honestly declared generationMethod instead of overwriting it", async () => {
    const result = await createUploadReviewDraft({ ownerUserId: userId, bountyId, generationMethod: GenerationMethod.ai_assisted });
    const draft = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: result.draftId } });
    expect(draft.generationMethod).toBe(GenerationMethod.ai_assisted);
  });

  it("returns a handoffUrl and never a raw token", async () => {
    const result = await createUploadReviewDraft({ ownerUserId: userId, bountyId });
    expect(result.handoffUrl).toBe(`${config.appUrl.replace(/\/+$/, "")}/upload/${result.handoffUrl.split("/").pop()}`);
    expect(result.handoffUrl.startsWith(config.appUrl.replace(/\/+$/, ""))).toBe(true);
    expect(Object.keys(result)).not.toContain("token");
  });

  it("starts a draft with no sourceArtifactId at awaiting_upload, not the invented 'ready' status", async () => {
    const result = await createUploadReviewDraft({ ownerUserId: userId, bountyId });
    const draft = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: result.draftId } });
    expect(draft.status).toBe("awaiting_upload");
  });

  it("refuses a nonexistent bounty id", async () => {
    await expect(createUploadReviewDraft({ ownerUserId: userId, bountyId: "does-not-exist" })).rejects.toThrow(UploadReviewDraftError);
  });

  it("refuses a bounty that is not active", async () => {
    const closed = await prisma.bounty.create({
      data: {
        requesterUserId: userId,
        title: `Closed Pool ${stamp}`,
        description: "fixture",
        datasetCategory: "implementation",
        language: "TypeScript",
        framework: "Node.js",
        auditCoveragePct: 10,
        auditMode: "partial",
        holdDays: 0,
        disputeWindowHours: 48,
        communityLicense: "CC-BY-4.0",
        kind: BountyKind.community,
        status: BountyStatus.closing,
        datasetTypeId,
        targetItems: 10,
      },
    });
    try {
      await expect(createUploadReviewDraft({ ownerUserId: userId, bountyId: closed.id })).rejects.toThrow(UploadReviewDraftError);
    } finally {
      await prisma.bounty.deleteMany({ where: { id: closed.id } });
    }
  });

  it("refuses a sourceArtifactId that does not belong to the caller", async () => {
    const otherUser = await prisma.user.create({
      data: { email: `uprd-other-${stamp}@example.com`, handle: `uprdo${stamp}`.slice(0, 20), displayName: "other", authMethod: "email", passwordHash: "x" },
    });
    try {
      await expect(
        createUploadReviewDraft({ ownerUserId: userId, bountyId, sourceArtifactId: "does-not-exist" })
      ).rejects.toThrow(UploadReviewDraftError);
    } finally {
      await prisma.user.deleteMany({ where: { id: otherUser.id } });
    }
  });
});
