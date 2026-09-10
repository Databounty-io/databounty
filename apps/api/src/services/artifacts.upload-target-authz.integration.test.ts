// SPDX-License-Identifier: Apache-2.0

/**
 * P0 — upload-target authorization.
 *
 * Before this change `createUploadSlot` wrote `bountyId` / `submissionId` /
 * `contributorBatchId` / `datasetRequestId` straight from its params with no
 * ownership or state check whatsoever (the route validated only
 * `plannerSessionId`), so ANY verified account could mint an artifact bound to
 * ANOTHER account's submission or claimed batch — reachable both through
 * POST /v1/artifacts/upload-slot and through MCP `prepare_file_upload`.
 *
 * These tests drive the real service against real rows in the disposable
 * parity-verify database, so they prove the ownership boundary itself rather
 * than a mock of it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactKind,
  ArtifactStatus,
  AuditMode,
  AuthMethod,
  BountyStatus,
  DatasetCategory,
  DatasetRequestStatus,
  GenerationMethod,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createUploadSlot, authorizeArtifactUploadTarget, ArtifactUploadValidationError } from "./artifacts.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const createdUserIds: string[] = [];
const createdArtifactIds: string[] = [];
const createdBountyIds: string[] = [];
const createdRequestIds: string[] = [];
const createdSubmissionIds: string[] = [];
const createdBatchIds: string[] = [];
const createdSessionIds: string[] = [];
const createdDatasetTypeIds: string[] = [];

function stamp(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function createUser(prefix: string): Promise<string> {
  const s = stamp();
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-${s}@example.com`,
      handle: `${prefix.slice(0, 5)}${s}`.toLowerCase().slice(0, 20),
      displayName: prefix,
      authMethod: AuthMethod.email,
      passwordHash: "not-used-in-these-tests",
      emailVerifiedAt: new Date(),
      onboarded: true,
    },
  });
  createdUserIds.push(user.id);
  return user.id;
}

/** An OPEN community pool: active, not closed, not yet at target. */
async function createOpenPool(requesterUserId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId,
      communityRequesterUserId: requesterUserId,
      title: `pool-${stamp()}`,
      description: "upload-target authorization fixture",
      datasetCategory: DatasetCategory.implementation,
      language: "en",
      framework: "none",
      targetItems: BigInt(100),
      status: BountyStatus.active,
      auditMode: AuditMode.partial,
      auditCoveragePct: 10,
      holdDays: 0,
      ...overrides,
    },
  });
  createdBountyIds.push(bounty.id);
  return bounty.id;
}

let victim: string;
let attacker: string;

beforeAll(async () => {
  victim = await createUser("uta-victim");
  attacker = await createUser("uta-attacker");
});

afterAll(async () => {
  await prisma.artifact.deleteMany({ where: { id: { in: createdArtifactIds } } });
  await prisma.submission.deleteMany({ where: { id: { in: createdSubmissionIds } } });
  await prisma.contributorBatch.deleteMany({ where: { id: { in: createdBatchIds } } });
  await prisma.plannerSession.deleteMany({ where: { id: { in: createdSessionIds } } });
  await prisma.datasetRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: createdDatasetTypeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("authorizeArtifactUploadTarget — submission targets", () => {
  it("REFUSES binding an upload to another user's submission (403)", async () => {
    const bountyId = await createOpenPool(victim);
    const submission = await prisma.submission.create({
      data: { bountyId, contributorUserId: victim, title: `item-${stamp()}`, payloadJson: {}, generationMethod: GenerationMethod.human },
    });
    createdSubmissionIds.push(submission.id);

    // The live privilege bug, stated as a test: attacker binds to victim's row.
    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.submission_attachment, { submissionId: submission.id })
    ).rejects.toMatchObject({ code: "NOT_TARGET_OWNER", status: 403 });

    // ...and the same refusal through the public entry point, so nothing is
    // written even though createUploadSlot used to create the row first.
    await expect(
      createUploadSlot({
        ownerUserId: attacker,
        kind: ArtifactKind.submission_attachment,
        filename: "steal.json",
        contentType: "application/json",
        submissionId: submission.id,
      })
    ).rejects.toBeInstanceOf(ArtifactUploadValidationError);
    const leaked = await prisma.artifact.findFirst({ where: { submissionId: submission.id } });
    expect(leaked).toBeNull();
  });

  it("ALLOWS the submitter, and derives the bountyId from the submission", async () => {
    const bountyId = await createOpenPool(victim);
    const submission = await prisma.submission.create({
      data: { bountyId, contributorUserId: victim, title: `item-${stamp()}`, payloadJson: {}, generationMethod: GenerationMethod.human },
    });
    createdSubmissionIds.push(submission.id);

    const slot = await createUploadSlot({
      ownerUserId: victim,
      kind: ArtifactKind.submission_attachment,
      filename: "evidence.json",
      contentType: "application/json",
      submissionId: submission.id,
    });
    createdArtifactIds.push(slot.artifactId);

    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: slot.artifactId } });
    expect(row.submissionId).toBe(submission.id);
    // Derived by the server, never taken from the caller.
    expect(row.bountyId).toBe(bountyId);
    expect(row.ownerUserId).toBe(victim);
  });

  it("404s an unknown submission id rather than confirming or creating anything", async () => {
    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.submission_attachment, { submissionId: "sub_does_not_exist" })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("authorizeArtifactUploadTarget — contributor-batch targets", () => {
  it("REFUSES binding an upload to another user's claimed batch (403)", async () => {
    const bountyId = await createOpenPool(victim);
    const batch = await prisma.contributorBatch.create({
      data: {
        bountyId,
        contributorUserId: victim,
        slotName: "slot-1",
        category: DatasetCategory.implementation,
        difficulty: "intermediate",
        itemCount: BigInt(10),
      },
    });
    createdBatchIds.push(batch.id);

    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.submission_attachment, { contributorBatchId: batch.id })
    ).rejects.toMatchObject({ code: "NOT_TARGET_OWNER", status: 403 });
    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.bulk_submission_source, { contributorBatchId: batch.id })
    ).rejects.toMatchObject({ code: "NOT_TARGET_OWNER", status: 403 });
  });

  it("ALLOWS the batch owner and derives the bountyId", async () => {
    const bountyId = await createOpenPool(victim);
    const batch = await prisma.contributorBatch.create({
      data: {
        bountyId,
        contributorUserId: victim,
        slotName: "slot-1",
        category: DatasetCategory.implementation,
        difficulty: "intermediate",
        itemCount: BigInt(10),
      },
    });
    createdBatchIds.push(batch.id);

    const target = await authorizeArtifactUploadTarget(victim, ArtifactKind.bulk_submission_source, {
      contributorBatchId: batch.id,
    });
    expect(target).toMatchObject({ contributorBatchId: batch.id, bountyId });
  });
});

describe("authorizeArtifactUploadTarget — bare bounty (open-pool) targets", () => {
  it("ALLOWS a bare bountyId only while the pool is genuinely open", async () => {
    const bountyId = await createOpenPool(victim);
    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.submission_attachment, { bountyId })
    ).resolves.toMatchObject({ bountyId });
  });

  it("REFUSES a closed pool (409 POOL_CLOSED)", async () => {
    const bountyId = await createOpenPool(victim, { poolClosedAt: new Date() });
    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.submission_attachment, { bountyId })
    ).rejects.toMatchObject({ code: "POOL_CLOSED", status: 409 });
  });

  it("REFUSES a non-active pool (409 POOL_CLOSED)", async () => {
    const bountyId = await createOpenPool(victim, { status: BountyStatus.cancelled });
    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.submission_attachment, { bountyId })
    ).rejects.toMatchObject({ code: "POOL_CLOSED", status: 409 });
  });

  it("REFUSES a pool that has already reached its target item count", async () => {
    const bountyId = await createOpenPool(victim, { targetItems: BigInt(5), acceptedItems: BigInt(5) });
    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.submission_attachment, { bountyId })
    ).rejects.toMatchObject({ code: "POOL_CLOSED", status: 409 });
  });

  it("404s an unknown bounty id", async () => {
    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.submission_attachment, { bountyId: "bnt_nope" })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("authorizeArtifactUploadTarget — sponsor_reference owners", () => {
  it("requires EXACTLY ONE owner id", async () => {
    const bountyId = await createOpenPool(victim);
    await expect(
      authorizeArtifactUploadTarget(victim, ArtifactKind.sponsor_reference, {})
    ).rejects.toMatchObject({ code: "SAMPLE_OWNER_REQUIRED", status: 400 });
    await expect(
      authorizeArtifactUploadTarget(victim, ArtifactKind.sponsor_reference, { bountyId, datasetRequestId: "x" })
    ).rejects.toMatchObject({ code: "SAMPLE_OWNER_REQUIRED", status: 400 });
  });

  it("REFUSES a sample on a pool the caller does not sponsor (403)", async () => {
    const bountyId = await createOpenPool(victim);
    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.sponsor_reference, { bountyId })
    ).rejects.toMatchObject({ code: "NOT_SAMPLE_OWNER", status: 403 });
  });

  it("ALLOWS the pool's own sponsor", async () => {
    const bountyId = await createOpenPool(victim);
    await expect(
      authorizeArtifactUploadTarget(victim, ArtifactKind.sponsor_reference, { bountyId })
    ).resolves.toMatchObject({ bountyId });
  });

  it("REFUSES a sample on someone else's dataset request (403) and 404s an unknown one", async () => {
    const request = await prisma.datasetRequest.create({
      data: {
        requesterUserId: victim,
        title: `req-${stamp()}`,
        description: "fixture",
        proposedLicense: "CC-BY-4.0",
        idempotencyKey: `idem-${stamp()}`,
        language: "en",
        framework: "none",
        targetItems: 10,
        status: DatasetRequestStatus.submitted,
      },
    });
    createdRequestIds.push(request.id);

    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.sponsor_reference, { datasetRequestId: request.id })
    ).rejects.toMatchObject({ code: "NOT_SAMPLE_OWNER", status: 403 });
    await expect(
      authorizeArtifactUploadTarget(victim, ArtifactKind.sponsor_reference, { datasetRequestId: request.id })
    ).resolves.toMatchObject({ datasetRequestId: request.id });
    await expect(
      authorizeArtifactUploadTarget(victim, ArtifactKind.sponsor_reference, { datasetRequestId: "req_nope" })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("freezes the sample set once the request has been decided (409)", async () => {
    const request = await prisma.datasetRequest.create({
      data: {
        requesterUserId: victim,
        title: `req-${stamp()}`,
        description: "fixture",
        proposedLicense: "CC-BY-4.0",
        idempotencyKey: `idem-${stamp()}`,
        language: "en",
        framework: "none",
        targetItems: 10,
        status: DatasetRequestStatus.declined,
      },
    });
    createdRequestIds.push(request.id);
    await expect(
      authorizeArtifactUploadTarget(victim, ArtifactKind.sponsor_reference, { datasetRequestId: request.id })
    ).rejects.toMatchObject({ code: "SAMPLES_FROZEN", status: 409 });
  });

  it("keeps the planner-draft rule the route used to own: 404 for another user's draft, 409 once submitted", async () => {
    const session = await prisma.plannerSession.create({
      data: { userId: victim, answersJson: {}, transcript: [] },
    });
    createdSessionIds.push(session.id);

    await expect(
      authorizeArtifactUploadTarget(attacker, ArtifactKind.sponsor_reference, { plannerSessionId: session.id })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      authorizeArtifactUploadTarget(victim, ArtifactKind.sponsor_reference, { plannerSessionId: session.id })
    ).resolves.toMatchObject({ plannerSessionId: session.id });

    await prisma.plannerSession.update({ where: { id: session.id }, data: { completed: true } });
    await expect(
      authorizeArtifactUploadTarget(victim, ArtifactKind.sponsor_reference, { plannerSessionId: session.id })
    ).rejects.toMatchObject({ code: "DRAFT_SUBMITTED", status: 409 });
  });
});

describe("createUploadSlot — quota, reuse and archive cap", () => {
  it("refuses a slot once the caller holds the configured number of live pending slots", async () => {
    const owner = await createUser("uta-quota");
    const { config } = await import("../config.js");
    const quota = config.storage.maxPendingUploadsPerUser;

    for (let i = 0; i < quota; i += 1) {
      const slot = await createUploadSlot({
        ownerUserId: owner,
        kind: ArtifactKind.submission_attachment,
        // Distinct filenames, so the idempotent-reuse path never absorbs one
        // of these and leaves the quota unreached.
        filename: `q-${i}.json`,
        contentType: "application/json",
      });
      createdArtifactIds.push(slot.artifactId);
    }

    await expect(
      createUploadSlot({
        ownerUserId: owner,
        kind: ArtifactKind.submission_attachment,
        filename: "one-too-many.json",
        contentType: "application/json",
      })
    ).rejects.toMatchObject({ code: "TOO_MANY_PENDING_UPLOADS", status: 409 });

    // An EXPIRED pending row must not count against the quota.
    await prisma.artifact.updateMany({
      where: { ownerUserId: owner },
      data: { uploadExpiresAt: new Date(Date.now() - 60_000) },
    });
    const after = await createUploadSlot({
      ownerUserId: owner,
      kind: ArtifactKind.submission_attachment,
      filename: "now-allowed.json",
      contentType: "application/json",
    });
    createdArtifactIds.push(after.artifactId);
    expect(after.artifactId).toBeTruthy();
  });

  it("reuses an identical live slot instead of minting a duplicate row", async () => {
    const owner = await createUser("uta-reuse");
    const first = await createUploadSlot({
      ownerUserId: owner,
      kind: ArtifactKind.submission_attachment,
      filename: "retry-me.json",
      contentType: "application/json",
      declaredSizeBytes: 1234,
    });
    createdArtifactIds.push(first.artifactId);
    expect(first.reused).toBe(false);

    const second = await createUploadSlot({
      ownerUserId: owner,
      kind: ArtifactKind.submission_attachment,
      filename: "retry-me.json",
      contentType: "application/json",
      declaredSizeBytes: 1234,
    });
    expect(second.reused).toBe(true);
    expect(second.artifactId).toBe(first.artifactId);
    // Expiry is re-stamped forward, so the retry gets a genuinely usable window.
    expect(second.uploadExpiresAt.getTime()).toBeGreaterThanOrEqual(first.uploadExpiresAt.getTime());
    expect(await prisma.artifact.count({ where: { ownerUserId: owner } })).toBe(1);

    // A DIFFERENT declaration is a different request and must not be absorbed.
    const third = await createUploadSlot({
      ownerUserId: owner,
      kind: ArtifactKind.submission_attachment,
      filename: "retry-me.json",
      contentType: "application/json",
      declaredSizeBytes: 4321,
    });
    createdArtifactIds.push(third.artifactId);
    expect(third.reused).toBe(false);
    expect(third.artifactId).not.toBe(first.artifactId);
  });

  it("never reuses ANOTHER account's pending slot", async () => {
    const a = await createUser("uta-reuse-a");
    const b = await createUser("uta-reuse-b");
    const mine = await createUploadSlot({
      ownerUserId: a,
      kind: ArtifactKind.submission_attachment,
      filename: "shared-name.json",
      contentType: "application/json",
      declaredSizeBytes: 10,
    });
    createdArtifactIds.push(mine.artifactId);
    const theirs = await createUploadSlot({
      ownerUserId: b,
      kind: ArtifactKind.submission_attachment,
      filename: "shared-name.json",
      contentType: "application/json",
      declaredSizeBytes: 10,
    });
    createdArtifactIds.push(theirs.artifactId);
    expect(theirs.reused).toBe(false);
    expect(theirs.artifactId).not.toBe(mine.artifactId);
  });

  it("caps an archive upload at the declaration stage, once the contract allows archives at all", async () => {
    const owner = await createUser("uta-zip");
    // A dataset type whose file field explicitly accepts .zip — without one
    // the conservative default (.json/.jsonl/.ndjson) rejects the archive
    // earlier, as INVALID_FILE_DECLARATION, and the size cap is never reached.
    const typeId = `uta-zip-${stamp()}`;
    await prisma.datasetType.create({
      data: {
        id: typeId,
        domain: "coding",
        name: "archive fixture",
        description: "fixture",
        status: "draft",
        origin: "platform",
        category: DatasetCategory.implementation,
        trustTier: "expert_audited",
        fields: [{ key: "bundle", role: "file", accept: ".zip" }],
        verification: {},
      },
    });
    createdDatasetTypeIds.push(typeId);
    const bountyId = await createOpenPool(owner, { datasetTypeId: typeId });

    // Under the cap: the contract admits it.
    const ok = await createUploadSlot({
      ownerUserId: owner,
      kind: ArtifactKind.submission_attachment,
      filename: "small.zip",
      contentType: "application/zip",
      declaredSizeBytes: 1024,
      bountyId,
    });
    createdArtifactIds.push(ok.artifactId);

    // Over the cap: refused, and nothing extra is written.
    const before = await prisma.artifact.count({ where: { ownerUserId: owner } });
    await expect(
      createUploadSlot({
        ownerUserId: owner,
        kind: ArtifactKind.submission_attachment,
        filename: "huge.zip",
        contentType: "application/zip",
        declaredSizeBytes: 26 * 1024 * 1024,
        bountyId,
      })
    ).rejects.toMatchObject({ code: "ARCHIVE_TOO_LARGE", status: 400 });
    expect(await prisma.artifact.count({ where: { ownerUserId: owner } })).toBe(before);
  });

  it("refuses a declaration the dataset type's accept contract forbids", async () => {
    const owner = await createUser("uta-accept");
    const typeId = `uta-acc-${stamp()}`;
    await prisma.datasetType.create({
      data: {
        id: typeId,
        domain: "coding",
        name: "image-only fixture",
        description: "fixture",
        status: "draft",
        origin: "platform",
        category: DatasetCategory.implementation,
        trustTier: "expert_audited",
        fields: [{ key: "shot", role: "file", accept: ".png", modality: "image" }],
        verification: {},
      },
    });
    createdDatasetTypeIds.push(typeId);
    const bountyId = await createOpenPool(owner, { datasetTypeId: typeId });

    await expect(
      createUploadSlot({
        ownerUserId: owner,
        kind: ArtifactKind.submission_attachment,
        filename: "notes.json",
        contentType: "application/json",
        bountyId,
      })
    ).rejects.toMatchObject({ code: "INVALID_FILE_DECLARATION", status: 400 });

    // A declared MIME that contradicts its own extension is refused too.
    await expect(
      createUploadSlot({
        ownerUserId: owner,
        kind: ArtifactKind.submission_attachment,
        filename: "shot.png",
        contentType: "text/html",
        bountyId,
      })
    ).rejects.toMatchObject({ code: "INVALID_FILE_DECLARATION", status: 400 });

    const allowed = await createUploadSlot({
      ownerUserId: owner,
      kind: ArtifactKind.submission_attachment,
      filename: "shot.png",
      contentType: "image/png",
      bountyId,
    });
    createdArtifactIds.push(allowed.artifactId);
    expect(allowed.artifactId).toBeTruthy();
  });

  it("cross-checks the dataset type's declared MODALITY, not just its accept list", async () => {
    const owner = await createUser("uta-modal");
    const typeId = `uta-mod-${stamp()}`;
    await prisma.datasetType.create({
      data: {
        id: typeId,
        domain: "coding",
        name: "modality fixture",
        description: "fixture",
        status: "draft",
        origin: "platform",
        category: DatasetCategory.implementation,
        trustTier: "expert_audited",
        // Broad accept, narrow modality — exactly the case `accept` alone
        // cannot police: a contract asking for a screenshot would otherwise
        // happily take an archive.
        fields: [{ key: "shot", role: "file", accept: ".png,.zip", modality: "image" }],
        verification: {},
      },
    });
    createdDatasetTypeIds.push(typeId);
    const bountyId = await createOpenPool(owner, { datasetTypeId: typeId });

    await expect(
      createUploadSlot({
        ownerUserId: owner,
        kind: ArtifactKind.submission_attachment,
        filename: "bundle.zip",
        contentType: "application/zip",
        declaredSizeBytes: 1024,
        bountyId,
      })
    ).rejects.toMatchObject({ code: "MODALITY_MISMATCH", status: 400 });
  });

  it("writes an artifact.upload_slot_issued audit row for both a new and a reused slot", async () => {
    const owner = await createUser("uta-audit");
    const first = await createUploadSlot({
      ownerUserId: owner,
      kind: ArtifactKind.submission_attachment,
      filename: "audited.json",
      contentType: "application/json",
      declaredSizeBytes: 7,
    });
    createdArtifactIds.push(first.artifactId);
    await createUploadSlot({
      ownerUserId: owner,
      kind: ArtifactKind.submission_attachment,
      filename: "audited.json",
      contentType: "application/json",
      declaredSizeBytes: 7,
    });

    const rows = await prisma.adminAuditLog.findMany({
      where: { action: "artifact.upload_slot_issued", targetId: first.artifactId },
    });
    expect(rows.length).toBe(2);
    expect(rows.map((r) => (r.metadata as { reused?: boolean } | null)?.reused).sort()).toEqual([false, true]);
  });

  it("persists the NORMALIZED content type, not the caller's spelling", async () => {
    const owner = await createUser("uta-norm");
    const slot = await createUploadSlot({
      ownerUserId: owner,
      kind: ArtifactKind.submission_attachment,
      filename: "rows.jsonl",
      // An alias an MCP agent commonly sends; must be folded to the canonical
      // type so modality routing and the magic-byte check agree on one value.
      contentType: "application/jsonl",
    });
    createdArtifactIds.push(slot.artifactId);
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: slot.artifactId } });
    expect(row.contentType).toBe("application/x-ndjson");
    expect(row.status).toBe(ArtifactStatus.pending_upload);
  });
});
