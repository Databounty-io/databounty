// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the base `StorageDriver` contract (put/get/head/remove) holds for
 * the local-disk driver with ZERO required env vars — the guarantee the
 * S3-capability port must not regress. Runs against a disposable temp
 * directory, not the shared dev/test data dir, so it never collides with a
 * running server.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { LocalDiskDriver } from "./local.js";
import { hasDirectUpload, hasMultipartUpload } from "./types.js";

describe("LocalDiskDriver", () => {
  let root: string;

  async function freshDriver(): Promise<{ driver: LocalDiskDriver; root: string }> {
    root = await mkdtemp(join(tmpdir(), "databounty-storage-test-"));
    return { driver: new LocalDiskDriver(root), root };
  }

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("declares only the base capability — no direct-upload or multipart claim", async () => {
    const { driver } = await freshDriver();
    expect(driver.name).toBe("local");
    expect(hasDirectUpload(driver)).toBe(false);
    expect(hasMultipartUpload(driver)).toBe(false);
  });

  it("put() streams to disk and returns the real server-verified size and sha256", async () => {
    const { driver } = await freshDriver();
    const bytes = Buffer.from("hello databounty community storage");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

    const stored = await driver.put("artifacts/test/one.txt", Readable.from(bytes), "text/plain");

    expect(stored.sizeBytes).toBe(bytes.length);
    expect(stored.checksumSha256).toBe(expectedSha256);
  });

  it("get() returns a stream of the exact bytes written", async () => {
    const { driver } = await freshDriver();
    const bytes = Buffer.from("round trip me");
    await driver.put("artifacts/test/two.txt", Readable.from(bytes), "text/plain");

    const chunks: Buffer[] = [];
    for await (const chunk of await driver.get("artifacts/test/two.txt")) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });

  it("get() throws (surfaces as 404 upstream) for a missing key", async () => {
    const { driver } = await freshDriver();
    await expect(driver.get("artifacts/test/does-not-exist.txt")).rejects.toThrow();
  });

  it("head() returns the on-disk size, honestly reporting no checksum/contentType (local disk cannot know either without re-reading)", async () => {
    const { driver } = await freshDriver();
    const bytes = Buffer.from("size me up");
    await driver.put("artifacts/test/three.txt", Readable.from(bytes), "text/plain");

    const meta = await driver.head("artifacts/test/three.txt");
    expect(meta.sizeBytes).toBe(bytes.length);
    expect(meta.checksumSha256).toBeNull();
    expect(meta.contentType).toBeNull();
  });

  it("remove() deletes the object, and is a no-op (not an error) on an already-missing key", async () => {
    const { driver } = await freshDriver();
    await driver.put("artifacts/test/four.txt", Readable.from(Buffer.from("bye")), "text/plain");
    await driver.remove("artifacts/test/four.txt");
    await expect(driver.get("artifacts/test/four.txt")).rejects.toThrow();
    // Removing again must not throw.
    await expect(driver.remove("artifacts/test/four.txt")).resolves.toBeUndefined();
  });

  it("refuses a key that attempts to escape the storage root via path traversal", async () => {
    const { driver } = await freshDriver();
    // pathFor() throws before any mkdir/write happens, so a rejection here is
    // itself the proof nothing was written outside the configured root.
    await expect(driver.put("../../etc/passwd", Readable.from(Buffer.from("x")), "text/plain")).rejects.toThrow(/escapes root/);
  });
});
