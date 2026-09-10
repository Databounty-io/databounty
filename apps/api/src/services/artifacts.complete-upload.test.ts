// SPDX-License-Identifier: Apache-2.0
//
// QA 2026-09-05 (F-002, P2 state integrity): `completeUpload` used to check
// ownership only, so an owner could complete an expired slot or one that never
// received bytes, leaving a `scanning`/`error` row with null size and no object.
// These are pure unit tests over Prisma/job-queue doubles — no PostgreSQL.
//
// UPDATED (parity pass): completion no longer trusts the ROW's sizeBytes /
// checksumSha256 — it HEADs the stored object and verifies against them
// (v1 `services/artifacts.ts#completePendingArtifact`). Two consequences for
// this file, both deliberate:
//   * the old "refuses an empty slot with SLOT_EMPTY" case encoded the bug —
//     that check is what made the direct-PUT path unreachable under
//     STORAGE_DRIVER=s3, where those columns are legitimately null. It is
//     replaced by "storage has no such object -> ARTIFACT_BYTES_MISSING",
//     which is the honest version of the same refusal.
//   * the doubles now cover `adminSetting` (grace period), `headArtifactData`
//     and `writeAuditLog`, which completion newly consults.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactScanStatus, ArtifactStatus } from "@prisma/client";

const CHECKSUM = "a".repeat(64);

const artifactRow = {
  id: "art_test",
  ownerUserId: "owner",
  kind: "submission_attachment",
  filename: "item.json",
  contentType: "application/json",
  bountyId: null,
  datasetRequestId: null,
  plannerSessionId: null,
  storageKey: "artifacts/submission_attachment/art_test/item.json",
  status: ArtifactStatus.pending_upload,
  uploadExpiresAt: new Date(Date.now() + 60_000),
  declaredSizeBytes: BigInt(63),
  sizeBytes: BigInt(63),
  checksumSha256: CHECKSUM,
};

const prismaMock = {
  artifact: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  adminSetting: { findUnique: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
};
const enqueue = vi.fn();
const headArtifactData = vi.fn();
const writeAuditLog = vi.fn();

vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("./jobs.js", () => ({ dbJobQueue: { enqueue } }));
vi.mock("./storage.js", () => ({
  headArtifactData: (...args: unknown[]) => headArtifactData(...args),
  getArtifactData: vi.fn(),
  putArtifactData: vi.fn(),
  removeArtifactData: vi.fn(),
}));
vi.mock("../lib/audit-log.js", () => ({ writeAuditLog: (...args: unknown[]) => writeAuditLog(...args) }));

const { completeUpload, ArtifactUploadValidationError } = await import("./artifacts.js");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.artifact.findUnique.mockResolvedValue({ ...artifactRow });
  prismaMock.artifact.update.mockResolvedValue({ ...artifactRow });
  prismaMock.artifact.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.artifact.findUniqueOrThrow.mockResolvedValue({
    ...artifactRow,
    status: ArtifactStatus.scanning,
    scanStatus: ArtifactScanStatus.pending,
  });
  // No grace configured -> the code default of 0, same as the purge worker.
  prismaMock.adminSetting.findUnique.mockResolvedValue(null);
  headArtifactData.mockResolvedValue({ sizeBytes: 63, checksumSha256: CHECKSUM, contentType: "application/json" });
});

async function expectRefusal(code: string) {
  await expect(completeUpload("art_test", "owner")).rejects.toMatchObject({ code });
  expect(prismaMock.artifact.updateMany).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
}

describe("completeUpload lifecycle guards", () => {
  it("completes a live, filled slot: conditional claim then one scan job", async () => {
    const result = await completeUpload("art_test", "owner");
    expect(result.status).toBe(ArtifactStatus.scanning);
    expect(prismaMock.artifact.updateMany).toHaveBeenCalledWith({
      where: { id: "art_test", status: ArtifactStatus.pending_upload },
      data: {
        status: ArtifactStatus.scanning,
        scanStatus: ArtifactScanStatus.pending,
        sizeBytes: BigInt(63),
        contentType: "application/json",
      },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ type: "artifact.scan", idempotencyKey: "scan:art_test" });
  });

  it("refuses a slot whose bytes never reached storage with ARTIFACT_BYTES_MISSING", async () => {
    // Replaces the old SLOT_EMPTY case: the row's null size/checksum is NOT
    // evidence of an empty slot on a direct-PUT driver, so emptiness is now
    // decided by asking storage. A genuine not-found becomes a caller-fixable
    // 409, not an opaque 500.
    prismaMock.artifact.findUnique.mockResolvedValue({ ...artifactRow, sizeBytes: null, checksumSha256: null });
    headArtifactData.mockRejectedValue(Object.assign(new Error("stat failed"), { code: "ENOENT" }));
    await expectRefusal("ARTIFACT_BYTES_MISSING");
  });

  it("completes a direct-PUT slot whose row carries no server-measured size yet", async () => {
    // The regression this whole change exists for: with STORAGE_DRIVER=s3 the
    // API never sees the bytes, so sizeBytes/checksumSha256 stay null on the
    // row and completion used to throw SLOT_EMPTY every single time.
    prismaMock.artifact.findUnique.mockResolvedValue({ ...artifactRow, sizeBytes: null, declaredSizeBytes: null, checksumSha256: null });
    const result = await completeUpload("art_test", "owner");
    expect(result.status).toBe(ArtifactStatus.scanning);
    expect(prismaMock.artifact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sizeBytes: BigInt(63) }) })
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("keeps a non-not-found storage failure retryable instead of blaming the caller", async () => {
    headArtifactData.mockRejectedValue(new Error("S3 HEAD failed (503)"));
    await expect(completeUpload("art_test", "owner")).rejects.toThrow(/503/);
    expect(prismaMock.artifact.updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("quarantines when the stored object's size contradicts the declared size", async () => {
    headArtifactData.mockResolvedValue({ sizeBytes: 999, checksumSha256: CHECKSUM, contentType: null });
    await expect(completeUpload("art_test", "owner")).rejects.toMatchObject({ code: "ARTIFACT_SIZE_MISMATCH" });
    expect(prismaMock.artifact.update).toHaveBeenCalledWith({
      where: { id: "art_test" },
      data: { status: ArtifactStatus.quarantined, sizeBytes: BigInt(999) },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("quarantines when the stored object's checksum contradicts the declared checksum", async () => {
    headArtifactData.mockResolvedValue({ sizeBytes: 63, checksumSha256: "b".repeat(64), contentType: null });
    await expect(completeUpload("art_test", "owner")).rejects.toMatchObject({ code: "ARTIFACT_CHECKSUM_MISMATCH" });
    expect(prismaMock.artifact.update).toHaveBeenCalledWith({
      where: { id: "art_test" },
      data: { status: ArtifactStatus.quarantined, sizeBytes: BigInt(63) },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("quarantines when storage reports a content type the upload contract forbids", async () => {
    // Post-complete re-validation against the STORED type (v1
    // artifact-uploads.ts:457-505): declared .json at prepare, bucket holds
    // text/html.
    headArtifactData.mockResolvedValue({ sizeBytes: 63, checksumSha256: CHECKSUM, contentType: "text/html" });
    prismaMock.artifact.findUniqueOrThrow.mockResolvedValue({
      ...artifactRow,
      status: ArtifactStatus.scanning,
      scanStatus: ArtifactScanStatus.pending,
      contentType: "text/html",
    });
    await expect(completeUpload("art_test", "owner")).rejects.toMatchObject({ code: "ARTIFACT_CONTENT_TYPE_MISMATCH" });
    expect(prismaMock.artifact.update).toHaveBeenCalledWith({
      where: { id: "art_test" },
      data: { status: ArtifactStatus.quarantined, scanStatus: ArtifactScanStatus.content_mismatch },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("honours the admin grace period on both sides of expiry", async () => {
    // 120s grace configured; slot lapsed 60s ago -> still completable. This is
    // the symmetry fix: only the purge worker read this setting before, so
    // completion refused slots the worker was still tolerating.
    prismaMock.adminSetting.findUnique.mockResolvedValue({ value: 120 });
    prismaMock.artifact.findUnique.mockResolvedValue({ ...artifactRow, uploadExpiresAt: new Date(Date.now() - 60_000) });
    await expect(completeUpload("art_test", "owner")).resolves.toBeTruthy();

    vi.clearAllMocks();
    prismaMock.adminSetting.findUnique.mockResolvedValue({ value: 120 });
    prismaMock.artifact.findUnique.mockResolvedValue({ ...artifactRow, uploadExpiresAt: new Date(Date.now() - 180_000) });
    await expect(completeUpload("art_test", "owner")).rejects.toMatchObject({ code: "SLOT_EXPIRED" });
  });

  it("writes an artifact.upload_completed audit row on success", async () => {
    await completeUpload("art_test", "owner");
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "artifact.upload_completed", targetId: "art_test", actorUserId: "owner" })
    );
  });

  it("refuses an expired slot with SLOT_EXPIRED even when bytes landed", async () => {
    prismaMock.artifact.findUnique.mockResolvedValue({ ...artifactRow, uploadExpiresAt: new Date(Date.now() - 1) });
    await expectRefusal("SLOT_EXPIRED");
  });

  it("refuses a slot with no expiry at all", async () => {
    prismaMock.artifact.findUnique.mockResolvedValue({ ...artifactRow, uploadExpiresAt: null });
    await expectRefusal("SLOT_EXPIRED");
  });

  it.each([ArtifactStatus.scanning, ArtifactStatus.ready, ArtifactStatus.quarantined, ArtifactStatus.deleted])(
    "refuses a slot already in state %s with SLOT_NOT_OPEN",
    async (status) => {
      prismaMock.artifact.findUnique.mockResolvedValue({ ...artifactRow, status });
      await expectRefusal("SLOT_NOT_OPEN");
    }
  );

  it("loses a concurrent completion race without enqueueing a second scan", async () => {
    prismaMock.artifact.updateMany.mockResolvedValue({ count: 0 });
    await expect(completeUpload("art_test", "owner")).rejects.toMatchObject({ code: "SLOT_NOT_OPEN" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("still refuses a non-owner before any state check", async () => {
    await expect(completeUpload("art_test", "someone-else")).rejects.toThrow(/access denied/);
    expect(prismaMock.artifact.updateMany).not.toHaveBeenCalled();
  });

  it("exposes the refusals as ArtifactUploadValidationError so the route maps them to 409", async () => {
    prismaMock.artifact.findUnique.mockResolvedValue({ ...artifactRow, status: ArtifactStatus.ready });
    await expect(completeUpload("art_test", "owner")).rejects.toBeInstanceOf(ArtifactUploadValidationError);
  });
});
