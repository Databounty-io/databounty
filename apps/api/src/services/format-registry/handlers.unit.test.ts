// SPDX-License-Identifier: Apache-2.0

/**
 * Pure unit tests for the format registry — no database, no storage I/O.
 * Covers: each of the 7 modality handlers' detect() against a real matching
 * signature, at least 2 handlers rejecting a magic-byte mismatch via the
 * shared `checkMagicBytesFromBuffer` reconciliation, and the
 * dispatch/classification helpers in `registry.ts`.
 */
import { describe, expect, it } from "vitest";
import { checkMagicBytesFromBuffer } from "../../lib/magic-bytes.js";
import { evaluateZipArchive } from "../../lib/artifact-file-policy.js";
import { ARCHIVE_HANDLER } from "./archive.js";
import { AUDIO_HANDLER } from "./audio.js";
import { CODE_TEXT_HANDLER } from "./code-text.js";
import { DEFAULT_HANDLER } from "./default-handler.js";
import { DOCUMENT_HANDLER } from "./document.js";
import { IMAGE_HANDLER } from "./image.js";
import { VIDEO_HANDLER } from "./video.js";
import { FORMAT_HANDLERS, modalityForContentType, resolveHandler } from "./registry.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const PDF_HEADER = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3", "latin1");
const WAV_HEADER = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
const MP4_HEADER = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.from("isom")]);
const WEBM_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
const PLAIN_TEXT = Buffer.from("just some readable UTF-8 prose, no null bytes anywhere here", "utf8");
const BINARY_WITH_NUL = Buffer.from([0x01, 0x02, 0x00, 0x03, 0x04]);

describe("format-registry handlers — detect() on a matching signature", () => {
  it("IMAGE_HANDLER detects a real PNG signature", () => {
    expect(IMAGE_HANDLER.detect(PNG_HEADER)).toBe(true);
  });

  it("IMAGE_HANDLER detects a real JPEG signature", () => {
    expect(IMAGE_HANDLER.detect(JPEG_HEADER)).toBe(true);
  });

  it("VIDEO_HANDLER detects an ISO-BMFF ftyp box", () => {
    expect(VIDEO_HANDLER.detect(MP4_HEADER)).toBe(true);
  });

  it("VIDEO_HANDLER detects a WebM/Matroska EBML header", () => {
    expect(VIDEO_HANDLER.detect(WEBM_HEADER)).toBe(true);
  });

  it("AUDIO_HANDLER detects a WAV RIFF/WAVE container", () => {
    expect(AUDIO_HANDLER.detect(WAV_HEADER)).toBe(true);
  });

  it("DOCUMENT_HANDLER detects a real PDF signature", () => {
    expect(DOCUMENT_HANDLER.detect(PDF_HEADER)).toBe(true);
  });

  it("ARCHIVE_HANDLER detects a real ZIP local-file-header signature", () => {
    expect(ARCHIVE_HANDLER.detect(ZIP_HEADER)).toBe(true);
  });

  it("CODE_TEXT_HANDLER detects plausible UTF-8 text (no embedded NUL byte)", () => {
    expect(CODE_TEXT_HANDLER.detect(PLAIN_TEXT)).toBe(true);
  });

  it("CODE_TEXT_HANDLER rejects binary content with an embedded NUL byte", () => {
    expect(CODE_TEXT_HANDLER.detect(BINARY_WITH_NUL)).toBe(false);
  });

  it("DEFAULT_HANDLER never detects anything — it exists to always fail closed", () => {
    expect(DEFAULT_HANDLER.detect(PNG_HEADER)).toBe(false);
    expect(DEFAULT_HANDLER.detect(PLAIN_TEXT)).toBe(false);
  });
});

describe("format-registry handlers — honest not_supported/failed evidence, never a fabricated pass", () => {
  it("DEFAULT_HANDLER.parse always reports ok:false with a reason", async () => {
    const result = await DEFAULT_HANDLER.parse({} as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("VIDEO_HANDLER.parse honestly reports unimplemented probing, never fabricated metadata", async () => {
    const result = await VIDEO_HANDLER.parse({} as never);
    expect(result.ok).toBe(false);
    expect(result.metadata).toEqual({});
  });

  it("AUDIO_HANDLER.preview is honestly not_supported, never a fabricated pass", async () => {
    const result = await AUDIO_HANDLER.preview({} as never);
    expect(result.status).toBe("not_supported");
  });

  it("DOCUMENT_HANDLER.similarityCheck is honestly not_supported (no PDF library integrated)", async () => {
    const result = await DOCUMENT_HANDLER.similarityCheck({} as never, {} as never);
    expect(result.status).toBe("not_supported");
  });
});

describe("checkMagicBytesFromBuffer — fail-closed on a mismatched signature", () => {
  it("rejects real PNG bytes declared as text/plain (a '.txt renamed to .png' style attack)", () => {
    const outcome = checkMagicBytesFromBuffer({ contentType: "text/plain" }, PNG_HEADER);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detected).toBe("png");
      expect(outcome.detail).toContain("does not match");
    }
  });

  it("rejects real ZIP bytes declared as image/png", () => {
    const outcome = checkMagicBytesFromBuffer({ contentType: "image/png" }, ZIP_HEADER);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detected).toBe("zip");
  });

  it("accepts real PNG bytes correctly declared as image/png", () => {
    const outcome = checkMagicBytesFromBuffer({ contentType: "image/png" }, PNG_HEADER);
    expect(outcome.ok).toBe(true);
  });

  it("fails open (does not block) on an undetectable format like plain text", () => {
    const outcome = checkMagicBytesFromBuffer({ contentType: "text/csv" }, Buffer.from("a,b,c\n1,2,3"));
    expect(outcome.ok).toBe(true);
    expect(outcome.detected).toBeNull();
  });
});

describe("registry dispatch", () => {
  it("modalityForContentType classifies every known family and falls back to 'other' for anything unrecognized", () => {
    expect(modalityForContentType("image/png")).toBe("image");
    expect(modalityForContentType("video/mp4")).toBe("video");
    expect(modalityForContentType("audio/wav")).toBe("audio");
    expect(modalityForContentType("application/pdf")).toBe("document");
    expect(modalityForContentType("application/zip")).toBe("archive");
    expect(modalityForContentType("application/json")).toBe("code");
    expect(modalityForContentType("text/plain")).toBe("text");
    expect(modalityForContentType("application/x-totally-unknown")).toBe("other");
    expect(modalityForContentType(null)).toBe("other");
  });

  it("resolveHandler never returns undefined and fails closed to DEFAULT_HANDLER for null/unrecognized modality", () => {
    expect(resolveHandler(null)).toBe(DEFAULT_HANDLER);
    expect(resolveHandler(undefined)).toBe(DEFAULT_HANDLER);
    expect(resolveHandler("other")).toBe(DEFAULT_HANDLER);
  });

  it("resolveHandler routes each real modality to its own handler", () => {
    expect(resolveHandler("image")).toBe(IMAGE_HANDLER);
    expect(resolveHandler("video")).toBe(VIDEO_HANDLER);
    expect(resolveHandler("audio")).toBe(AUDIO_HANDLER);
    expect(resolveHandler("document")).toBe(DOCUMENT_HANDLER);
    expect(resolveHandler("archive")).toBe(ARCHIVE_HANDLER);
    expect(resolveHandler("code")).toBe(CODE_TEXT_HANDLER);
    expect(resolveHandler("text")).toBe(CODE_TEXT_HANDLER);
  });

  it("every registered handler exposes a non-empty version string (evidence, not cosmetic)", () => {
    for (const handler of Object.values(FORMAT_HANDLERS)) {
      expect(typeof handler.version).toBe("string");
      expect(handler.version.length).toBeGreaterThan(0);
    }
  });
});

describe("evaluateZipArchive — zip-bomb caps, pure central-directory read", () => {
  it("fails closed (unparseable) on a buffer too short to contain an EOCD record", () => {
    const evaluation = evaluateZipArchive(Buffer.alloc(4), 4);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.reason).toBe("unparseable");
  });
});
