// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for the format-registry wiring in
 * `services/artifacts.ts`'s `runArtifactScanJob`: proves the
 * Universal Dataset Modality Invariant's fail-closed contract actually
 * holds end to end against real storage + a real database row, not just in
 * the pure handler unit tests (see `format-registry/handlers.unit.test.ts`).
 *
 * Against the disposable `databounty_community_parity_verify` database
 * configured via .env (NEVER the shared v1 `databounty` database) — same
 * guard as the other integration tests in this package.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { ArtifactKind, ArtifactScanStatus, ArtifactStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { storage } from "../lib/storage/index.js";
import { runArtifactScanJob } from "./artifacts.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

/** Real 4-byte PNG signature, padded so magic-byte peeking has enough bytes
 * to work with without needing a fully valid PNG for the mismatch tests
 * below (only `checkFileKind`'s signature match matters there). */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function createScanningArtifact(params: { contentType: string; bytes: Buffer; kind?: ArtifactKind }) {
  const id = `art_test_${randomBytes(8).toString("hex")}`;
  const storageKey = `artifacts/test/${id}/payload.bin`;
  await storage().put(storageKey, Readable.from(params.bytes), params.contentType);
  const artifact = await prisma.artifact.create({
    data: {
      id,
      kind: params.kind ?? ArtifactKind.submission_attachment,
      filename: "payload.bin",
      contentType: params.contentType,
      storageDriver: "local",
      storageKey,
      status: ArtifactStatus.scanning,
      scanStatus: ArtifactScanStatus.pending,
    },
  });
  return artifact;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("runArtifactScanJob — fail-closed format-registry dispatch", () => {
  it("quarantines a magic-byte mismatch (real PNG bytes declared as text/plain)", async () => {
    const artifact = await createScanningArtifact({
      contentType: "text/plain",
      bytes: Buffer.concat([PNG_HEADER, Buffer.alloc(64)]),
    });
    await runArtifactScanJob(artifact.id);
    const updated = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(updated.status).toBe(ArtifactStatus.quarantined);
    expect(updated.scanStatus).toBe(ArtifactScanStatus.content_mismatch);
    expect(updated.detectedMimeType).toBe("image/png");
  });

  it("quarantines a magic-byte mismatch (real ZIP bytes declared as image/png)", async () => {
    const artifact = await createScanningArtifact({
      contentType: "image/png",
      bytes: Buffer.concat([ZIP_HEADER, Buffer.alloc(64)]),
    });
    await runArtifactScanJob(artifact.id);
    const updated = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(updated.status).toBe(ArtifactStatus.quarantined);
    expect(updated.scanStatus).toBe(ArtifactScanStatus.content_mismatch);
    expect(updated.detectedMimeType).toBe("application/zip");
  });

  it("quarantines an unrecognized binary blob (no content-type match, no magic-byte signature, not plain text)", async () => {
    // Random bytes with an unregistered content type: modalityForContentType
    // returns "other", detectFileKind returns null (no known signature), and
    // the bytes contain NUL/high-entropy bytes so looksLikePlainText is
    // false too — nothing here should ever resolve to "ready".
    const opaque = randomBytes(256);
    opaque[0] = 0x00; // guarantee at least one NUL byte in the probed header
    const artifact = await createScanningArtifact({
      contentType: "application/x-unknown-binary-blob",
      bytes: opaque,
    });
    await runArtifactScanJob(artifact.id);
    const updated = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(updated.status).toBe(ArtifactStatus.quarantined);
    expect(updated.scanStatus).toBe(ArtifactScanStatus.content_mismatch);
  });

  it("never silently accepts an unrecognized type as ready", async () => {
    const opaque = randomBytes(256);
    opaque[10] = 0x00;
    const artifact = await createScanningArtifact({
      contentType: "application/x-another-unknown-blob",
      bytes: opaque,
    });
    await runArtifactScanJob(artifact.id);
    const updated = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(updated.status).not.toBe(ArtifactStatus.ready);
  });

  it("clears a matching, recognized plain-text artifact to ready and records real parse evidence", async () => {
    const artifact = await createScanningArtifact({
      contentType: "text/plain",
      bytes: Buffer.from("hello world, this is plain readable text with no null bytes", "utf8"),
    });
    await runArtifactScanJob(artifact.id);
    const updated = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(updated.status).toBe(ArtifactStatus.ready);
    expect(updated.scanStatus).not.toBe(ArtifactScanStatus.content_mismatch);
    expect(updated.parserVersion).toBe("1.0.0"); // CODE_TEXT_HANDLER.version
    const events = await prisma.artifactProcessingEvent.findMany({ where: { artifactId: artifact.id } });
    const parseEvent = events.find((e) => e.stage === "parse");
    expect(parseEvent?.status).toBe("passed");
    expect(parseEvent?.handlerVersion).toBe("1.0.0");
  });

  it("clears a matching real PNG image to ready with honest, real parse metadata (dimensions)", async () => {
    // A minimal-but-real 1x1 PNG: signature + IHDR chunk declaring 1x1.
    const ihdr = Buffer.alloc(25);
    PNG_HEADER.copy(ihdr, 0);
    ihdr.writeUInt32BE(13, 8); // chunk length
    ihdr.write("IHDR", 12, "ascii");
    ihdr.writeUInt32BE(1, 16); // width
    ihdr.writeUInt32BE(1, 20); // height
    const artifact = await createScanningArtifact({ contentType: "image/png", bytes: ihdr });
    await runArtifactScanJob(artifact.id);
    const updated = await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
    expect(updated.status).toBe(ArtifactStatus.ready);
    expect(updated.modality).toBe("image");
    const events = await prisma.artifactProcessingEvent.findMany({ where: { artifactId: artifact.id, stage: "parse" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("passed");
    expect((events[0]?.detail as { metadata?: Record<string, unknown> })?.metadata).toMatchObject({
      format: "png",
      width: 1,
      height: 1,
    });
  });
});
