// SPDX-License-Identifier: Apache-2.0

/**
 * Pure unit tests for the declaration-time upload policy ported from v1
 * (`lib/artifact-file-policy.ts:1-159`). Nothing in the rebuild enforced MIME
 * or extension at prepare before this — an upload could declare any string at
 * all and only be caught, if at all, after its bytes were already stored.
 */
import { describe, expect, it } from "vitest";
import { ArtifactKind } from "@prisma/client";
import {
  MAX_ARCHIVE_UPLOAD_BYTES,
  acceptMatches,
  archiveSizeExceedsLimit,
  fileExtension,
  isValidFileAccept,
  normalizeDeclaredContentType,
  validateArtifactDeclaration,
} from "./artifact-upload-declaration.js";

describe("normalizeDeclaredContentType", () => {
  it("strips parameters, lowercases, and folds known aliases onto one canonical type", () => {
    expect(normalizeDeclaredContentType("Application/JSON; charset=utf-8")).toBe("application/json");
    expect(normalizeDeclaredContentType("application/jsonl")).toBe("application/x-ndjson");
    expect(normalizeDeclaredContentType("application/ndjson")).toBe("application/x-ndjson");
    expect(normalizeDeclaredContentType("application/x-jsonlines")).toBe("application/x-ndjson");
  });

  it("rejects anything that is not a MIME type", () => {
    for (const bad of ["", "json", "  ", "/", "application/", "<script>"]) {
      expect(normalizeDeclaredContentType(bad)).toBeNull();
    }
  });
});

describe("fileExtension", () => {
  it("takes the last path segment's last dot, lowercased", () => {
    expect(fileExtension("a/b/c/Rows.JSONL")).toBe(".jsonl");
    expect(fileExtension("C:\\dir\\thing.PNG")).toBe(".png");
  });

  it("returns empty for a dotless name and for a leading-dot-only name", () => {
    expect(fileExtension("README")).toBe("");
    expect(fileExtension(".gitignore")).toBe("");
  });
});

describe("isValidFileAccept / acceptMatches", () => {
  it("accepts extension tokens, exact MIME tokens and type wildcards", () => {
    expect(isValidFileAccept(".png,.jpg")).toBe(true);
    expect(isValidFileAccept("image/*")).toBe(true);
    expect(isValidFileAccept("application/json")).toBe(true);
    expect(isValidFileAccept("")).toBe(false);
    expect(isValidFileAccept("not a token")).toBe(false);
  });

  it("matches on extension, exact type and wildcard, and on nothing else", () => {
    expect(acceptMatches("a.png", "image/png", ".png")).toBe(true);
    expect(acceptMatches("a.png", "image/png", "image/*")).toBe(true);
    expect(acceptMatches("a.png", "image/png", "image/png")).toBe(true);
    expect(acceptMatches("a.png", "image/png", ".jpg")).toBe(false);
    // A malformed accept never widens the gate — it fails closed.
    expect(acceptMatches("a.png", "image/png", "garbage tokens")).toBe(false);
  });
});

describe("validateArtifactDeclaration", () => {
  it("accepts a per-kind default declaration and returns the normalized type", () => {
    const result = validateArtifactDeclaration({
      kind: ArtifactKind.bulk_submission_source,
      filename: "rows.jsonl",
      contentType: "application/jsonl",
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedContentType).toBe("application/x-ndjson");
  });

  it("refuses a filename with no extension", () => {
    const result = validateArtifactDeclaration({
      kind: ArtifactKind.submission_attachment,
      filename: "README",
      contentType: "text/plain",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/extension/);
  });

  it("refuses an extension the kind's default does not admit", () => {
    // bulk sources are tabular/line-delimited only — no archives.
    const result = validateArtifactDeclaration({
      kind: ArtifactKind.bulk_submission_source,
      filename: "bundle.zip",
      contentType: "application/zip",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a MIME type that contradicts its own extension, and names the accepted set", () => {
    const result = validateArtifactDeclaration({
      kind: ArtifactKind.sponsor_reference,
      filename: "sample.png",
      contentType: "text/html",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("image/png");
  });

  it("refuses an extension that contradicts a known MIME type", () => {
    const result = validateArtifactDeclaration({
      kind: ArtifactKind.sponsor_reference,
      filename: "sample.unknownext",
      contentType: "image/png",
      // An accept that admits the odd extension, so the earlier accept gate
      // passes and the MIME<->extension consistency branch is what refuses.
      fieldAccepts: [".unknownext"],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not match declared MIME/);
  });

  it("lets an explicit field accept WIDEN the conservative default", () => {
    const withoutField = validateArtifactDeclaration({
      kind: ArtifactKind.submission_attachment,
      filename: "clip.mp4",
      contentType: "video/mp4",
      fieldAccepts: [".json"],
    });
    expect(withoutField.ok).toBe(false);

    const withField = validateArtifactDeclaration({
      kind: ArtifactKind.submission_attachment,
      filename: "clip.mp4",
      contentType: "video/mp4",
      fieldAccepts: ["video/*"],
    });
    expect(withField.ok).toBe(true);
    expect(withField.normalizedContentType).toBe("video/mp4");
  });

  it("ignores a malformed field accept rather than letting it widen or break the gate", () => {
    const result = validateArtifactDeclaration({
      kind: ArtifactKind.submission_attachment,
      filename: "notes.json",
      contentType: "application/json",
      // Only invalid tokens -> filtered to empty -> falls back to the default,
      // which does admit .json. The malformed string neither widens nor blocks.
      fieldAccepts: ["*** not an accept ***"],
    });
    expect(result.ok).toBe(true);
  });
});

describe("archive upload cap", () => {
  it("applies only to archive content types, and only above the ceiling", () => {
    expect(archiveSizeExceedsLimit("application/zip", MAX_ARCHIVE_UPLOAD_BYTES)).toBe(false);
    expect(archiveSizeExceedsLimit("application/zip", MAX_ARCHIVE_UPLOAD_BYTES + 1)).toBe(true);
    expect(archiveSizeExceedsLimit("application/x-zip-compressed", MAX_ARCHIVE_UPLOAD_BYTES + 1)).toBe(true);
    expect(archiveSizeExceedsLimit("video/mp4", MAX_ARCHIVE_UPLOAD_BYTES * 10)).toBe(false);
  });

  it("is a no-op when no size was declared (there is nothing to compare)", () => {
    expect(archiveSizeExceedsLimit("application/zip", undefined)).toBe(false);
    expect(archiveSizeExceedsLimit("application/zip", null)).toBe(false);
  });
});
