// SPDX-License-Identifier: Apache-2.0

/**
 * Slot-lifecycle parity fixes, as pure unit tests over Prisma/storage doubles
 * (no PostgreSQL):
 *
 *  - multipart completion now checks EXPIRY. It previously checked only
 *    status + a non-null multipartUploadId, so an expired slot still
 *    assembled — a slot the purge worker was about to reclaim could be turned
 *    into a real object first.
 *  - the admin `artifacts.upload.grace_seconds` tolerance is applied on BOTH
 *    completion paths, not only in the purge worker.
 *  - the slot TTL comes from config (900s default, 60-3600s bounds) instead of
 *    a hardcoded hour.
 *  - the scan job refuses to buffer an object larger than
 *    WHOLE_BUFFER_MAX_BYTES and fails CLOSED (quarantine), rather than trying
 *    to allocate it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactScanStatus, ArtifactStatus } from "@prisma/client";

const CHECKSUM = "a".repeat(64);

const baseRow = {
  id: "art_mp",
  ownerUserId: "owner",
  kind: "bulk_submission_source",
  filename: "rows.jsonl",
  contentType: "application/x-ndjson",
  bountyId: null,
  datasetRequestId: null,
  plannerSessionId: null,
  storageKey: "artifacts/bulk_submission_source/art_mp/rows.jsonl",
  status: ArtifactStatus.pending_upload,
  scanStatus: ArtifactScanStatus.pending,
  uploadExpiresAt: new Date(Date.now() + 60_000),
  multipartUploadId: "upload-1",
  declaredSizeBytes: null,
  sizeBytes: null,
  checksumSha256: null,
  modality: null,
  workspaceId: null,
};

const prismaMock = {
  artifact: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
  adminSetting: { findUnique: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
};
const enqueue = vi.fn();
const headArtifactData = vi.fn();
const getArtifactData = vi.fn();
const writeAuditLog = vi.fn();

const fakeDriver = {
  name: "fake-mp",
  completeMultipartUpload: vi.fn(async () => undefined),
  createMultipartUpload: vi.fn(),
  abortMultipartUpload: vi.fn(async () => undefined),
};

vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("./jobs.js", () => ({ dbJobQueue: { enqueue } }));
vi.mock("./storage.js", () => ({
  headArtifactData: (...a: unknown[]) => headArtifactData(...a),
  getArtifactData: (...a: unknown[]) => getArtifactData(...a),
  putArtifactData: vi.fn(),
  removeArtifactData: vi.fn(),
}));
vi.mock("../lib/audit-log.js", () => ({ writeAuditLog: (...a: unknown[]) => writeAuditLog(...a) }));
vi.mock("../lib/storage/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, storage: () => fakeDriver, hasMultipartUpload: () => true, hasDirectUpload: () => false };
});

const { completeMultipartUpload, runArtifactScanJob, WHOLE_BUFFER_MAX_BYTES } = await import("./artifacts.js");
const { config } = await import("../config.js");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.artifact.findUnique.mockResolvedValue({ ...baseRow });
  prismaMock.artifact.update.mockResolvedValue({ ...baseRow, status: ArtifactStatus.scanning, multipartUploadId: null });
  prismaMock.adminSetting.findUnique.mockResolvedValue(null);
  headArtifactData.mockResolvedValue({ sizeBytes: 42, checksumSha256: CHECKSUM, contentType: null });
});

describe("completeMultipartUpload — expiry", () => {
  it("assembles a live slot", async () => {
    const result = await completeMultipartUpload("art_mp", "owner", [{ partNumber: 1, etag: "e1" }]);
    expect(fakeDriver.completeMultipartUpload).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(ArtifactStatus.scanning);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("REFUSES an expired slot and never touches the provider", async () => {
    prismaMock.artifact.findUnique.mockResolvedValue({ ...baseRow, uploadExpiresAt: new Date(Date.now() - 1) });
    await expect(completeMultipartUpload("art_mp", "owner", [{ partNumber: 1, etag: "e1" }])).rejects.toMatchObject({
      code: "SLOT_EXPIRED",
    });
    // The object must not be assembled: this is the whole point of the gate.
    expect(fakeDriver.completeMultipartUpload).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a slot with no expiry at all", async () => {
    prismaMock.artifact.findUnique.mockResolvedValue({ ...baseRow, uploadExpiresAt: null });
    await expect(completeMultipartUpload("art_mp", "owner", [{ partNumber: 1, etag: "e1" }])).rejects.toMatchObject({
      code: "SLOT_EXPIRED",
    });
  });

  it("honours the admin grace period, so completion and the purge worker agree", async () => {
    prismaMock.adminSetting.findUnique.mockResolvedValue({ value: 120 });
    // Lapsed 60s ago, 120s grace -> still inside the window the worker tolerates.
    prismaMock.artifact.findUnique.mockResolvedValue({ ...baseRow, uploadExpiresAt: new Date(Date.now() - 60_000) });
    await expect(completeMultipartUpload("art_mp", "owner", [{ partNumber: 1, etag: "e1" }])).resolves.toBeTruthy();

    vi.clearAllMocks();
    prismaMock.adminSetting.findUnique.mockResolvedValue({ value: 120 });
    prismaMock.artifact.update.mockResolvedValue({ ...baseRow, status: ArtifactStatus.scanning });
    headArtifactData.mockResolvedValue({ sizeBytes: 42, checksumSha256: CHECKSUM, contentType: null });
    prismaMock.artifact.findUnique.mockResolvedValue({ ...baseRow, uploadExpiresAt: new Date(Date.now() - 180_000) });
    await expect(completeMultipartUpload("art_mp", "owner", [{ partNumber: 1, etag: "e1" }])).rejects.toMatchObject({
      code: "SLOT_EXPIRED",
    });
    expect(fakeDriver.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("ignores a malformed grace setting instead of trusting it", async () => {
    // Non-integer / negative / non-numeric all fall back to 0, same as the worker.
    for (const value of ["120", -5, 1.5, null, { seconds: 120 }]) {
      vi.clearAllMocks();
      prismaMock.adminSetting.findUnique.mockResolvedValue({ value });
      prismaMock.artifact.findUnique.mockResolvedValue({ ...baseRow, uploadExpiresAt: new Date(Date.now() - 60_000) });
      await expect(completeMultipartUpload("art_mp", "owner", [{ partNumber: 1, etag: "e1" }])).rejects.toMatchObject({
        code: "SLOT_EXPIRED",
      });
    }
  });

  it("writes an artifact.upload_completed audit row", async () => {
    await completeMultipartUpload("art_mp", "owner", [{ partNumber: 1, etag: "e1" }]);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "artifact.upload_completed", actorUserId: "owner" })
    );
  });
});

describe("upload slot TTL is configuration, not a hardcoded hour", () => {
  it("defaults to 900 seconds and is bounded to 60-3600", () => {
    expect(config.storage.directUploadExpiresSeconds).toBe(900);
    expect(config.storage.directUploadExpiresSeconds).toBeGreaterThanOrEqual(60);
    expect(config.storage.directUploadExpiresSeconds).toBeLessThanOrEqual(3600);
    // The value it replaced. Kept as an explicit assertion so a silent revert
    // to the old hardcoded hour fails here.
    expect(config.storage.directUploadExpiresSeconds).not.toBe(3600);
  });

  it("exposes a bounded pending-slot quota", () => {
    expect(config.storage.maxPendingUploadsPerUser).toBe(20);
  });
});

describe("runArtifactScanJob — whole-file buffering cap", () => {
  it("quarantines an object above the buffer ceiling WITHOUT reading it", async () => {
    prismaMock.artifact.findUnique.mockResolvedValue({
      ...baseRow,
      status: ArtifactStatus.scanning,
      sizeBytes: BigInt(WHOLE_BUFFER_MAX_BYTES + 1),
    });
    prismaMock.artifact.update.mockResolvedValue({
      ...baseRow,
      status: ArtifactStatus.quarantined,
      scanStatus: ArtifactScanStatus.error,
    });

    await runArtifactScanJob("art_mp");

    // Nothing was allocated — that is the fix, not merely "it errored".
    expect(getArtifactData).not.toHaveBeenCalled();
    expect(prismaMock.artifact.update).toHaveBeenCalledWith({
      where: { id: "art_mp" },
      data: { status: ArtifactStatus.quarantined, scanStatus: ArtifactScanStatus.error },
    });
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "artifact.scan_too_large" })
    );
  });

  it("reads an object at exactly the ceiling", async () => {
    prismaMock.artifact.findUnique.mockResolvedValue({
      ...baseRow,
      status: ArtifactStatus.scanning,
      sizeBytes: BigInt(WHOLE_BUFFER_MAX_BYTES),
    });
    getArtifactData.mockRejectedValue(new Error("read attempted — that is what this test asserts"));
    prismaMock.artifact.update.mockResolvedValue({ ...baseRow });

    await expect(runArtifactScanJob("art_mp")).rejects.toThrow(/read attempted/);
    expect(getArtifactData).toHaveBeenCalledTimes(1);
  });

  it("still reads a row whose size is unknown (null) rather than failing it on a missing number", async () => {
    prismaMock.artifact.findUnique.mockResolvedValue({ ...baseRow, status: ArtifactStatus.scanning, sizeBytes: null });
    getArtifactData.mockRejectedValue(new Error("read attempted"));
    prismaMock.artifact.update.mockResolvedValue({ ...baseRow });

    await expect(runArtifactScanJob("art_mp")).rejects.toThrow(/read attempted/);
    expect(getArtifactData).toHaveBeenCalledTimes(1);
  });
});
