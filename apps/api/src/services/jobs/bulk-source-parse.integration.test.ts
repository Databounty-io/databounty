// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for `runBulkSourceParseJob` (services/jobs/bulk-source-parse.ts).
 *
 * A prior audit found this file had zero tests, and that the draft status /
 * `previewSummary` field names it wrote did not match what apps/web's
 * upload-review page (`app/(app)/upload-review/[draftId]/view.tsx`) reads —
 * so the review page's Submit button never rendered for a real upload
 * (status stuck outside the page's known union, and `acceptedRows` always
 * `undefined`). These tests pin the corrected contract:
 *
 *  - a completed parse reaches `status: "review_ready"` with
 *    `previewSummary.rowsRead` / `acceptedRows` / `rejectedRows` populated
 *    from the real row mix;
 *  - a draft cancelled WHILE a parse job is mid-flight is never resurrected
 *    back to `review_ready` (or `failed`) by that job's completion/failure
 *    write — the `revokedAt` + pre-terminal-status guard;
 *  - a permanent parse failure lands the draft at `status: "failed"` with a
 *    real `previewSummary.error`, instead of leaving it stuck at whatever
 *    pre-terminal status it already had.
 *
 * Against the disposable test database — same guard as the other
 * integration tests in this package.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  ArtifactKind,
  ArtifactStatus,
  BountyKind,
  BountyStatus,
  BulkParseStatus,
  DatasetTypeStatus,
  GenerationMethod,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { putArtifactData } from "../storage.js";
import { runBulkSourceParseJob } from "./bulk-source-parse.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let datasetTypeId: string;
let userId: string;
let bountyId: string;

const artifactIds: string[] = [];
const draftIds: string[] = [];

beforeAll(async () => {
  const dt = await prisma.datasetType.create({
    data: {
      id: `bsp-${stamp}`,
      name: `Bulk Source Parse ${stamp}`,
      description: "Fixture dataset type for bulk-source-parse job tests.",
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
    data: {
      email: `bsp-${stamp}@example.com`,
      handle: `bsp${stamp}`.slice(0, 20),
      displayName: "bsp",
      authMethod: "email",
      passwordHash: "x",
    },
  });
  userId = user.id;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: userId,
      title: `Bulk Source Parse Pool ${stamp}`,
      description: "Fixture pool for bulk-source-parse job tests.",
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
  await prisma.submissionUploadDraftItem.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.submissionUploadDraft.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.artifact.deleteMany({ where: { id: { in: artifactIds } } });
  await prisma.bounty.deleteMany({ where: { id: bountyId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.datasetType.deleteMany({ where: { id: datasetTypeId } });
  await prisma.$disconnect();
});

/** Creates a real `ready` bulk_submission_source artifact with real bytes in
 * storage, plus the `SubmissionUploadDraft` that references it (mirroring how
 * the upload-review-drafts route wires the two together) at whatever
 * pre-parse `status` the caller wants to start from. */
async function createArtifactAndDraft(params: { bytes: Buffer; filename: string; contentType: string; draftStatus?: string }) {
  const id = `art_bsp_${randomBytes(8).toString("hex")}`;
  const storageKey = `artifacts/test/${id}/${params.filename}`;
  await putArtifactData(storageKey, params.bytes, params.contentType);
  const artifact = await prisma.artifact.create({
    data: {
      id,
      kind: ArtifactKind.bulk_submission_source,
      filename: params.filename,
      contentType: params.contentType,
      storageDriver: "local",
      storageKey,
      status: ArtifactStatus.ready,
      ownerUserId: userId,
      bountyId,
    },
  });
  artifactIds.push(artifact.id);

  const draft = await prisma.submissionUploadDraft.create({
    data: {
      ownerUserId: userId,
      targetKind: "community_pool",
      bountyId,
      generationMethod: GenerationMethod.human,
      tokenHash: `bsp-token-${randomBytes(16).toString("hex")}`,
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      draftExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      sourceArtifactId: artifact.id,
      status: params.draftStatus ?? "uploading",
    },
  });
  draftIds.push(draft.id);

  return { artifact, draft };
}

describe("runBulkSourceParseJob — draft status/previewSummary contract with apps/web's review page", () => {
  it("completes a parse to status review_ready with rowsRead/acceptedRows/rejectedRows from a mix of valid and invalid rows", async () => {
    const jsonl = [
      JSON.stringify({ instruction: "do thing one" }),
      JSON.stringify({ instruction: "do thing two" }),
      "not valid json",
      JSON.stringify(["not", "an", "object"]),
    ].join("\n");
    const { artifact, draft } = await createArtifactAndDraft({
      bytes: Buffer.from(jsonl, "utf8"),
      filename: "source.jsonl",
      contentType: "application/x-ndjson",
    });

    const result = await runBulkSourceParseJob(artifact.id);
    expect(result.done).toBe(true);
    expect(result.created).toBe(2);

    const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.status).toBe("review_ready");
    const summary = updated.previewSummary as Record<string, unknown>;
    expect(summary.rowsRead).toBe(4);
    expect(summary.acceptedRows).toBe(2);
    expect(summary.rejectedRows).toBe(2);
    expect(typeof summary.parserVersion).toBe("string");
    expect(summary.parserVersion).toBeTruthy();
    // Old vocabulary must be gone, not just renamed-and-also-present.
    expect(summary.totalRows).toBeUndefined();
    expect(summary.usableRows).toBeUndefined();
    expect(summary.skippedRows).toBeUndefined();
    expect(summary.status).not.toBe("review");

    const updatedArtifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(updatedArtifact.bulkParseStatus).toBe(BulkParseStatus.done);
  });

  it("never resurrects a draft that was cancelled while the parse job was still mid-flight", async () => {
    const jsonl = [JSON.stringify({ instruction: "a" }), JSON.stringify({ instruction: "b" })].join("\n");
    const { artifact, draft } = await createArtifactAndDraft({
      bytes: Buffer.from(jsonl, "utf8"),
      filename: "source2.jsonl",
      contentType: "application/x-ndjson",
    });

    // Simulate the contributor cancelling the draft after the job read the
    // artifact/draft rows but before its completion write runs — direct DB
    // mutation is the same pattern jobs.integration.test.ts uses to
    // fast-forward state without a real race.
    await prisma.submissionUploadDraft.update({
      where: { id: draft.id },
      data: { status: "cancelled", revokedAt: new Date() },
    });

    const result = await runBulkSourceParseJob(artifact.id);
    expect(result.done).toBe(true);

    const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.status).toBe("cancelled");
    expect(updated.revokedAt).not.toBeNull();
    // The guarded updateMany must not have touched previewSummary either.
    expect(updated.previewSummary).toBeNull();

    // The artifact side (bulkParseStatus/created counts) is independent
    // progress bookkeeping and is still allowed to reach `done` — only the
    // DRAFT's fate is protected by the guard.
    const updatedArtifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(updatedArtifact.bulkParseStatus).toBe(BulkParseStatus.done);
  });

  it("lands a permanently-failing parse (unparseable source) at status failed with a real previewSummary.error, not stuck at uploading", async () => {
    const { artifact, draft } = await createArtifactAndDraft({
      bytes: Buffer.from("this is not a supported bulk source container", "utf8"),
      filename: "source.bin",
      contentType: "application/x-unsupported",
    });

    await expect(runBulkSourceParseJob(artifact.id)).rejects.toThrow(/unsupported bulk source container/);

    const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.status).toBe("failed");
    const summary = updated.previewSummary as Record<string, unknown>;
    expect(typeof summary.error).toBe("string");
    expect(summary.error).toMatch(/unsupported bulk source container/);

    const updatedArtifact = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(updatedArtifact.bulkParseStatus).toBe(BulkParseStatus.failed);
    expect(updatedArtifact.bulkParseError).toMatch(/unsupported bulk source container/);
  });

  it("never resurrects (to failed) a draft that was cancelled before a permanent parse failure's completion write", async () => {
    const { artifact, draft } = await createArtifactAndDraft({
      bytes: Buffer.from("also not a supported container", "utf8"),
      filename: "source2.bin",
      contentType: "application/x-unsupported",
    });

    await prisma.submissionUploadDraft.update({
      where: { id: draft.id },
      data: { status: "cancelled", revokedAt: new Date() },
    });

    await expect(runBulkSourceParseJob(artifact.id)).rejects.toThrow();

    const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.status).toBe("cancelled");
    expect(updated.previewSummary).toBeNull();
  });
});
