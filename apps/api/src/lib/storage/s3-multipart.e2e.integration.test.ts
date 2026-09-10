// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { storage } from "./index.js";
import { hasMultipartUpload, type MultipartUploadStorageDriver, S3_MIN_PART_BYTES } from "./types.js";

/**
 * Ported from v1 databounty-api (`src/lib/storage/s3-multipart.e2e.integration.test.ts`).
 *
 * Deliberately opt-in: this writes a short-lived, random test object to the
 * configured bucket (STORAGE_DRIVER=s3), exercises the exact presigned-part URL
 * contract a browser uses, then deletes the object in afterAll. It stays skipped
 * by default so a machine without object storage reports an honest skip rather
 * than a fabricated pass against nothing.
 *
 * It does NOT need real AWS. The driver signs SigV4 by hand and addresses
 * path-style, so any S3-compatible endpoint works via STORAGE_ENDPOINT.
 * VERIFIED PASSING 2026-09-02 against a local MinIO (Docker is not required —
 * MinIO is a brew formula and needs no admin rights on this machine):
 *
 *   brew install minio minio-mc
 *   MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin123 \
 *     minio server --address=:9010 --console-address=:9011 /tmp/minio-data &
 *   AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin123 \
 *     AWS_DEFAULT_REGION=us-east-1 \
 *     aws --endpoint-url http://127.0.0.1:9010 s3 mb s3://databounty-e2e
 *
 *   RUN_S3_MULTIPART_E2E=true STORAGE_DRIVER=s3 STORAGE_BUCKET=databounty-e2e \
 *   STORAGE_REGION=us-east-1 STORAGE_ENDPOINT=http://127.0.0.1:9010 \
 *   AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin123 \
 *   npx vitest run src/lib/storage/s3-multipart.e2e.integration.test.ts
 *
 * Against real AWS, drop STORAGE_ENDPOINT and supply real AWS_* credentials.
 */
const enabled = process.env.RUN_S3_MULTIPART_E2E === "true";
const key = `e2e/upload-review/${randomUUID()}.bin`;
let driver: MultipartUploadStorageDriver | null = null;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe.runIf(enabled)("real S3 multipart upload", () => {
  afterAll(async () => {
    await driver?.remove(key).catch(() => undefined);
  });

  it("uploads checksummed parts, completes with ETags, reads exact bytes, and cleans up", async () => {
    const candidate = storage();
    expect(hasMultipartUpload(candidate)).toBe(true);
    if (!hasMultipartUpload(candidate)) return;
    driver = candidate;
    const first = Buffer.alloc(S3_MIN_PART_BYTES, 0x61);
    const last = Buffer.from("databounty community multipart e2e final part");
    const plan = await driver.createMultipartUpload({
      key,
      contentType: "application/octet-stream",
      expiresSeconds: 120,
      parts: [
        { partNumber: 1, sizeBytes: first.length, checksumSha256Hex: sha256Hex(first) },
        { partNumber: 2, sizeBytes: last.length, checksumSha256Hex: sha256Hex(last) },
      ],
    });
    const completed: Array<{ partNumber: number; etag: string }> = [];
    for (const part of plan.parts) {
      const body = part.partNumber === 1 ? first : last;
      const put = await fetch(part.url, { method: part.method, headers: part.headers, body });
      expect(put.ok, `part ${part.partNumber}: ${put.status} ${await put.text()}`).toBe(true);
      const etag = put.headers.get("etag");
      expect(etag).toBeTruthy();
      completed.push({ partNumber: part.partNumber, etag: etag! });
    }
    await driver.completeMultipartUpload({ key, uploadId: plan.uploadId, parts: completed });
    const head = await driver.head(key);
    expect(head.sizeBytes).toBe(first.length + last.length);
    const chunks: Buffer[] = [];
    for await (const chunk of await driver.get(key)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([first, last]));
  }, 90_000);
});

if (!enabled) {
  // vitest requires at least one non-skipped assertion in strict/CI modes for
  // some reporters; this keeps the file a visible, honest "skipped" entry
  // rather than an empty file that silently vanishes from the run summary.
  describe("real S3 multipart upload", () => {
    it.skip("RUN_S3_MULTIPART_E2E is not set — no S3-compatible infrastructure configured in this environment", () => {});
  });
}
