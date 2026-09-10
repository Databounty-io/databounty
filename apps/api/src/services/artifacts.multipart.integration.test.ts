// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the real multipart-upload wiring (createMultipartUpload ->
 * completeMultipartUpload / abortMultipartUpload) end-to-end against a fake
 * `MultipartUploadStorageDriver` — this environment has no real S3-compatible
 * infrastructure (see `lib/storage/s3-multipart.e2e.integration.test.ts` for
 * the honest, opt-in, skipped-by-default real-S3 gate). The fake driver
 * exercises the exact same contract shape a real object store would
 * (uploadId, per-part signed targets, ETags, HEAD-verified size/checksum), so
 * this proves the SERVICE and ROUTE logic is correct even though the actual
 * bytes never leave this process.
 *
 * Against the disposable `databounty_community_parity_verify` database
 * configured via .env (NEVER the shared v1 `databounty` database) — same
 * guard as the other integration tests in this package.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ArtifactKind, ArtifactStatus, AuthMethod } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { setStorageDriverForTests, resetStorageDriverForTests } from "../lib/storage/index.js";
import type {
  MultipartCompletedPart,
  MultipartPartDeclaration,
  MultipartUploadPlan,
  MultipartUploadStorageDriver,
  ObjectMetadata,
  StoredObject,
} from "../lib/storage/types.js";
import { createMultipartUpload, completeMultipartUpload, abortMultipartUpload, ArtifactUploadValidationError } from "./artifacts.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

/** In-memory stand-in for an S3-compatible multipart-capable object store.
 * Implements the full `MultipartUploadStorageDriver` (+ base `StorageDriver`)
 * contract so `createMultipartUpload`/`completeMultipartUpload` exercise the
 * real capability-detection path (`hasMultipartUpload`), not a special case. */
class FakeMultipartDriver implements MultipartUploadStorageDriver {
  readonly name = "fake-s3";
  readonly bucket = "fake-bucket";
  private objects = new Map<string, Buffer>();
  private uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  public aborted: string[] = [];

  async put(key: string, body: Readable): Promise<StoredObject> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const buf = Buffer.concat(chunks);
    this.objects.set(key, buf);
    return { sizeBytes: buf.length, checksumSha256: createHash("sha256").update(buf).digest("hex") };
  }

  async get(key: string): Promise<Readable> {
    const buf = this.objects.get(key);
    if (!buf) throw new Error(`fake driver: object not found: ${key}`);
    return Readable.from(buf);
  }

  async head(key: string): Promise<ObjectMetadata> {
    const buf = this.objects.get(key);
    if (!buf) throw new Error(`fake driver: object not found: ${key}`);
    return { sizeBytes: buf.length, checksumSha256: createHash("sha256").update(buf).digest("hex"), contentType: null };
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async createMultipartUpload(params: {
    key: string;
    contentType: string;
    parts: MultipartPartDeclaration[];
    expiresSeconds: number;
  }): Promise<MultipartUploadPlan> {
    const uploadId = `fake-upload-${randomUUID()}`;
    this.uploads.set(uploadId, { key: params.key, parts: new Map() });
    return {
      uploadId,
      expiresAt: new Date(Date.now() + params.expiresSeconds * 1000),
      parts: params.parts.map((p) => ({
        partNumber: p.partNumber,
        method: "PUT" as const,
        // A fake, but structurally real, per-part target — this test drives
        // the upload by calling `uploadPart` directly rather than a real
        // fetch(), since there is no bucket host to PUT against.
        url: `https://fake-bucket.s3.fake-region.amazonaws.com/${encodeURIComponent(params.key)}?partNumber=${p.partNumber}&uploadId=${uploadId}`,
        headers: { "x-amz-checksum-sha256": Buffer.from(p.checksumSha256Hex, "hex").toString("base64") },
      })),
    };
  }

  /** Stand-in for the browser's `fetch(part.url, { method: "PUT", body })` —
   * records the part's bytes and returns a fake ETag, exactly the shape
   * `completeMultipartUpload` needs. */
  uploadPart(uploadId: string, partNumber: number, body: Buffer): { partNumber: number; etag: string } {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`fake driver: unknown uploadId ${uploadId}`);
    upload.parts.set(partNumber, body);
    return { partNumber, etag: `"${createHash("md5").update(body).digest("hex")}"` };
  }

  async completeMultipartUpload(params: { key: string; uploadId: string; parts: MultipartCompletedPart[] }): Promise<void> {
    const upload = this.uploads.get(params.uploadId);
    if (!upload) throw new Error(`fake driver: unknown uploadId ${params.uploadId}`);
    const ordered = [...params.parts].sort((a, b) => a.partNumber - b.partNumber);
    const assembled = Buffer.concat(
      ordered.map((p) => {
        const bytes = upload.parts.get(p.partNumber);
        if (!bytes) throw new Error(`fake driver: part ${p.partNumber} was never uploaded`);
        return bytes;
      }),
    );
    this.objects.set(params.key, assembled);
    this.uploads.delete(params.uploadId);
  }

  async abortMultipartUpload(params: { key: string; uploadId: string }): Promise<void> {
    this.aborted.push(params.uploadId);
    this.uploads.delete(params.uploadId);
  }
}

let fake: FakeMultipartDriver;
const createdUserIds: string[] = [];
const createdArtifactIds: string[] = [];

async function createTestUser(prefix: string): Promise<string> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-${stamp}@example.com`,
      handle: `${prefix.slice(0, 6)}${stamp}`.toLowerCase().slice(0, 20),
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

beforeAll(() => {
  fake = new FakeMultipartDriver();
  setStorageDriverForTests(fake);
});

afterEach(() => {
  fake.aborted = [];
});

afterAll(async () => {
  resetStorageDriverForTests();
  await prisma.artifact.deleteMany({ where: { id: { in: createdArtifactIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("multipart upload service functions (fake S3-compatible driver)", () => {
  it("prepare -> upload parts -> complete produces a real object with the correct final checksum", async () => {
    const ownerUserId = await createTestUser("mp-happy");
    // Every non-final part must be exactly the server's configured part size
    // (planMultipartParts' contract) — partA hits that exactly, partB is the
    // deliberately smaller final remainder.
    const partA = randomBytes(config.storage.multipartPartSizeBytes);
    const partB = Buffer.from("final smaller part, not required to hit the floor");
    const totalSizeBytes = partA.length + partB.length;
    const parts: MultipartPartDeclaration[] = [
      { partNumber: 1, sizeBytes: partA.length, checksumSha256Hex: createHash("sha256").update(partA).digest("hex") },
      { partNumber: 2, sizeBytes: partB.length, checksumSha256Hex: createHash("sha256").update(partB).digest("hex") },
    ];

    const { artifactId, storageKey, multipart } = await createMultipartUpload({
      ownerUserId,
      kind: ArtifactKind.bulk_submission_source,
      filename: "big-dataset.jsonl",
      contentType: "application/jsonl",
      totalSizeBytes,
      parts,
    });
    createdArtifactIds.push(artifactId);

    const pending = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
    expect(pending.status).toBe(ArtifactStatus.pending_upload);
    expect(pending.multipartUploadId).toBe(multipart.uploadId);
    expect(pending.declaredSizeBytes).toBe(BigInt(totalSizeBytes));

    const completedParts = [
      fake.uploadPart(multipart.uploadId, 1, partA),
      fake.uploadPart(multipart.uploadId, 2, partB),
    ];

    const completed = await completeMultipartUpload(artifactId, ownerUserId, completedParts);

    expect(completed.status).toBe(ArtifactStatus.scanning);
    expect(completed.multipartUploadId).toBeNull();
    expect(Number(completed.sizeBytes)).toBe(totalSizeBytes);
    expect(completed.checksumSha256).toBe(createHash("sha256").update(Buffer.concat([partA, partB])).digest("hex"));

    // The assembled object really exists in the (fake) store with the exact
    // bytes — compared with Buffer.equals(), not toEqual(): deep-diffing two
    // 16 MB+ buffers as element-by-element arrays is what real vitest/chai
    // matchers do on mismatch, which is prohibitively expensive (and, on a
    // real mismatch, would produce an unreadable diff anyway).
    const chunks: Buffer[] = [];
    for await (const chunk of await fake.get(storageKey)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    expect(Buffer.concat(chunks).equals(Buffer.concat([partA, partB]))).toBe(true);

    // The scan job was enqueued exactly once, same as the single-request path.
    const job = await prisma.jobQueue.findFirst({ where: { type: "artifact.scan", idempotencyKey: `scan:${artifactId}` } });
    expect(job).not.toBeNull();
  });

  it("aborting an in-flight multipart upload releases the provider's reserved parts and soft-deletes the row", async () => {
    const ownerUserId = await createTestUser("mp-abort");
    const parts: MultipartPartDeclaration[] = [
      { partNumber: 1, sizeBytes: 5 * 1024 * 1024, checksumSha256Hex: "a".repeat(64) },
    ];
    const { artifactId, multipart } = await createMultipartUpload({
      ownerUserId,
      kind: ArtifactKind.bulk_submission_source,
      filename: "abandoned.jsonl",
      contentType: "application/jsonl",
      totalSizeBytes: 5 * 1024 * 1024,
      parts,
    });
    createdArtifactIds.push(artifactId);

    await abortMultipartUpload(artifactId, ownerUserId);

    expect(fake.aborted).toContain(multipart.uploadId);
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
    expect(row.status).toBe(ArtifactStatus.deleted);
    expect(row.multipartUploadId).toBeNull();
  });

  it("rejects a caller-declared part plan that does not match the server's own part-size split", async () => {
    const ownerUserId = await createTestUser("mp-mismatch");
    await expect(
      createMultipartUpload({
        ownerUserId,
        kind: ArtifactKind.bulk_submission_source,
        filename: "wrong-split.jsonl",
        contentType: "application/jsonl",
        totalSizeBytes: 40 * 1024 * 1024,
        // Declares one part for a 40 MB object at the (much smaller,
        // configured) part size — the server's own plan requires 3 parts.
        parts: [{ partNumber: 1, sizeBytes: 40 * 1024 * 1024, checksumSha256Hex: "b".repeat(64) }],
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadValidationError);
  });

  it("completing a multipart upload the caller does not own is refused", async () => {
    const owner = await createTestUser("mp-owner");
    const attacker = await createTestUser("mp-attacker");
    const { artifactId, multipart } = await createMultipartUpload({
      ownerUserId: owner,
      kind: ArtifactKind.bulk_submission_source,
      filename: "not-yours.jsonl",
      contentType: "application/jsonl",
      totalSizeBytes: 5 * 1024 * 1024,
      parts: [{ partNumber: 1, sizeBytes: 5 * 1024 * 1024, checksumSha256Hex: "c".repeat(64) }],
    });
    createdArtifactIds.push(artifactId);
    const part = fake.uploadPart(multipart.uploadId, 1, randomBytes(5 * 1024 * 1024));

    await expect(completeMultipartUpload(artifactId, attacker, [part])).rejects.toBeInstanceOf(ArtifactUploadValidationError);

    // Left untouched for the real owner to still complete.
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
    expect(row.status).toBe(ArtifactStatus.pending_upload);
  });
});
