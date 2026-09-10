// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ArtifactKind } from "@prisma/client";
import {
  STORAGE_FILENAME_MAX_LENGTH,
  buildArtifactStorageKey,
  safeStorageFilename,
} from "./artifacts.js";

/**
 * SEC-01 regression suite — pure unit tests, no database and no network.
 *
 * The finding: `createUploadSlot` and `createMultipartUpload` built the
 * storage key as `artifacts/${kind}/${artifactId}/${params.filename}` with the
 * client's untrusted filename spliced straight in. A verified uploader could
 * therefore put `../` segments in a filename and write over another account's
 * artifact bytes inside the same local-storage root, bypassing artifact
 * ownership and invalidating the checksum/validation evidence stored against
 * the victim row.
 *
 * The contract these tests pin down:
 *   1. `safeStorageFilename` returns exactly ONE path segment, drawn only from
 *      `[A-Za-z0-9._-]`, never empty and never dot-only.
 *   2. `buildArtifactStorageKey` therefore ALWAYS returns a key under
 *      `artifacts/<kind>/<artifactId>/`, whatever the display name was.
 */

const ARTIFACT_ID = "art_0123456789abcdef0123456789abcdef";
const OTHER_ARTIFACT_ID = "art_ffffffffffffffffffffffffffffffff";
const PREFIX = `artifacts/${ArtifactKind.submission_attachment}/${ARTIFACT_ID}/`;

/** The invariant every key must satisfy, asserted directly rather than by
 *  eyeballing an expected string: exactly four segments, the first three
 *  server-controlled, and no traversal or separator smuggled into the last. */
function expectKeyStaysInsideArtifactDir(key: string, artifactId = ARTIFACT_ID) {
  const expectedPrefix = `artifacts/${ArtifactKind.submission_attachment}/${artifactId}/`;
  expect(key.startsWith(expectedPrefix)).toBe(true);
  const segments = key.split("/");
  expect(segments).toHaveLength(4);
  expect(segments[2]).toBe(artifactId);
  const last = segments[3]!;
  expect(last.length).toBeGreaterThan(0);
  expect(last).not.toBe(".");
  expect(last).not.toBe("..");
  expect(last).toMatch(/^[A-Za-z0-9._-]+$/);
  // Resolving the key as a POSIX path must not climb above the prefix.
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "..") resolved.pop();
    else if (seg !== "." && seg !== "") resolved.push(seg);
  }
  expect(resolved.join("/")).toBe(key);
}

function key(filename: string, artifactId = ARTIFACT_ID) {
  return buildArtifactStorageKey({
    kind: ArtifactKind.submission_attachment,
    artifactId,
    filename,
  });
}

describe("safeStorageFilename — path traversal", () => {
  it("strips POSIX parent-directory segments", () => {
    expect(safeStorageFilename("../victim.csv")).toBe("victim.csv");
    expect(safeStorageFilename("../../../../etc/passwd")).toBe("passwd");
    expect(safeStorageFilename("a/b/../../c.json")).toBe("c.json");
  });

  it("strips Windows-style parent-directory segments", () => {
    expect(safeStorageFilename("..\\victim.csv")).toBe("victim.csv");
    expect(safeStorageFilename("..\\..\\windows\\system32\\config")).toBe("config");
  });

  it("neutralises a bare dot or dot-dot filename", () => {
    // v1's safeName let the literal ".." survive as a whole segment, which
    // still resolved one directory up. It must not.
    expect(safeStorageFilename("..")).toBe("file");
    expect(safeStorageFilename(".")).toBe("file");
    expect(safeStorageFilename("....")).toBe("file");
    expect(safeStorageFilename("../")).toBe("file");
    expect(safeStorageFilename("..\\")).toBe("file");
  });

  it("keeps a traversal attempt inside the artifact's own directory", () => {
    for (const attempt of [
      "../victim.csv",
      "../../../../etc/passwd",
      "..\\..\\victim.csv",
      "..",
      ".",
      "../",
      `../${OTHER_ARTIFACT_ID}/data.csv`,
    ]) {
      expectKeyStaysInsideArtifactDir(key(attempt));
    }
  });

  it("cannot be aimed at another artifact's directory", () => {
    const attacked = key(`../${OTHER_ARTIFACT_ID}/data.csv`);
    expect(attacked).toBe(`${PREFIX}data.csv`);
    expect(attacked).not.toContain(OTHER_ARTIFACT_ID);
  });
});

describe("safeStorageFilename — separators and absolute paths", () => {
  it("drops leading and trailing slashes and backslashes", () => {
    expect(safeStorageFilename("/data.csv")).toBe("data.csv");
    expect(safeStorageFilename("///data.csv")).toBe("data.csv");
    expect(safeStorageFilename("\\data.csv")).toBe("data.csv");
    expect(safeStorageFilename("\\\\server\\share\\data.csv")).toBe("data.csv");
    expect(safeStorageFilename("data.csv/")).toBe("file");
    expect(safeStorageFilename("data.csv\\")).toBe("file");
  });

  it("drops an absolute POSIX path down to its basename", () => {
    expect(safeStorageFilename("/etc/passwd")).toBe("passwd");
    expect(safeStorageFilename("/var/lib/databounty/storage/a.bin")).toBe("a.bin");
  });

  it("drops a Windows drive letter and UNC prefix", () => {
    expect(safeStorageFilename("C:\\Windows\\win.ini")).toBe("win.ini");
    expect(safeStorageFilename("C:/Windows/win.ini")).toBe("win.ini");
    // A bare drive spec has no basename to keep; the colon is not allowlisted.
    expect(safeStorageFilename("C:")).toBe("C_");
  });

  it("never emits a separator, so a key always has exactly four segments", () => {
    for (const attempt of ["/etc/passwd", "C:\\Windows\\win.ini", "a/b/c/d/e.csv", "x\\y\\z.csv"]) {
      expect(safeStorageFilename(attempt)).not.toMatch(/[\\/]/);
      expectKeyStaysInsideArtifactDir(key(attempt));
    }
  });
});

describe("safeStorageFilename — percent-encoded separators", () => {
  it("leaves encoded traversal inert rather than decoding it", () => {
    // `%` is not allowlisted, so nothing here can ever become a separator even
    // if a downstream layer were to decode the key.
    expect(safeStorageFilename("%2e%2e%2fvictim.csv")).toBe("_2e_2e_2fvictim.csv");
    expect(safeStorageFilename("%2fetc%2fpasswd")).toBe("_2fetc_2fpasswd");
    expect(safeStorageFilename("%2E%2E%5Cvictim.csv")).toBe("_2E_2E_5Cvictim.csv");
    // Leading dots collapse to a single `_` (the leading-dot rule), and the
    // encoded separators stay inert text.
    expect(safeStorageFilename("..%2f..%2fvictim.csv")).toBe("__2f.._2fvictim.csv");
  });

  it("keeps encoded attempts inside the artifact directory", () => {
    for (const attempt of ["%2e%2e%2fvictim.csv", "%2fetc%2fpasswd", "..%2f..%2fvictim.csv", "%00.csv"]) {
      const built = key(attempt);
      expect(built).not.toContain("%");
      expectKeyStaysInsideArtifactDir(built);
    }
  });
});

describe("safeStorageFilename — control characters", () => {
  it("removes NUL and other C0/C1 control characters", () => {
    expect(safeStorageFilename("data\u0000.csv")).toBe("data.csv");
    expect(safeStorageFilename("data\u0000/../evil.csv")).toBe("evil.csv");
    expect(safeStorageFilename("da\tta\n.csv")).toBe("data.csv");
    expect(safeStorageFilename("\u007fdata.csv")).toBe("data.csv");
    expect(safeStorageFilename("\u0000\u0001\u0002")).toBe("file");
  });

  it("never leaves a control character in a key", () => {
    for (const attempt of ["data\u0000.csv", "a\u001fb.csv", "\u0000\u0001"]) {
      // eslint-disable-next-line no-control-regex
      expect(key(attempt)).not.toMatch(/[\u0000-\u001f\u007f]/);
      expectKeyStaysInsideArtifactDir(key(attempt));
    }
  });
});

describe("safeStorageFilename — empty, dot-only and hidden names", () => {
  it("falls back to a fixed literal for names carrying no usable characters", () => {
    expect(safeStorageFilename("")).toBe("file");
    expect(safeStorageFilename("   ")).toBe("file");
    expect(safeStorageFilename("...")).toBe("file");
    expect(safeStorageFilename("___")).toBe("file");
    expect(safeStorageFilename("---")).toBe("file");
    expect(safeStorageFilename("/")).toBe("file");
    expect(safeStorageFilename("\\")).toBe("file");
  });

  it("tolerates a non-string filename without throwing", () => {
    // Route-level zod schemas make this unreachable today; the helper is
    // exported for other entrypoints, so it must fail closed on its own.
    expect(safeStorageFilename(undefined as unknown as string)).toBe("file");
    expect(safeStorageFilename(null as unknown as string)).toBe("file");
    expect(safeStorageFilename(42 as unknown as string)).toBe("file");
  });

  it("defuses a leading dot instead of writing a hidden file", () => {
    expect(safeStorageFilename(".env")).toBe("_env");
    expect(safeStorageFilename(".gitignore")).toBe("_gitignore");
    expect(safeStorageFilename("..hidden.csv")).toBe("_hidden.csv");
  });

  it("still produces a valid key for every degenerate name", () => {
    for (const attempt of ["", "   ", "...", "___", "/", "\\", ".env"]) {
      expectKeyStaysInsideArtifactDir(key(attempt));
    }
  });
});

describe("safeStorageFilename — length", () => {
  it("caps the segment at STORAGE_FILENAME_MAX_LENGTH", () => {
    const long = `${"a".repeat(5000)}.csv`;
    const safe = safeStorageFilename(long);
    expect(safe.length).toBe(STORAGE_FILENAME_MAX_LENGTH);
    expect(safe).toBe("a".repeat(STORAGE_FILENAME_MAX_LENGTH));
  });

  it("caps a long name that also tried to traverse", () => {
    const long = `../${"b".repeat(4000)}`;
    const safe = safeStorageFilename(long);
    expect(safe.length).toBe(STORAGE_FILENAME_MAX_LENGTH);
    expectKeyStaysInsideArtifactDir(key(long));
  });

  it("leaves a normal-length name untouched", () => {
    expect(safeStorageFilename("quarterly-report_v2.final.csv")).toBe("quarterly-report_v2.final.csv");
  });
});

describe("safeStorageFilename — unicode", () => {
  it("folds non-ASCII characters to underscores, one per code unit", () => {
    expect(safeStorageFilename("café.csv")).toBe("caf_.csv");
    expect(safeStorageFilename("данные.json")).toBe("______.json");
    expect(safeStorageFilename("日本語.csv")).toBe("___.csv");
    expect(safeStorageFilename("naïve\u202Efdp.csv")).toBe("na_ve_fdp.csv");
  });

  it("folds a fullwidth solidus rather than treating it as a separator", () => {
    // U+FF0F is NOT a path separator; it must survive as inert text, and the
    // key must still be one segment.
    expect(safeStorageFilename("a\uFF0Fb.csv")).toBe("a_b.csv");
    expectKeyStaysInsideArtifactDir(key("a\uFF0Fb.csv"));
  });

  it("keeps a unicode name inside the artifact directory", () => {
    for (const attempt of ["café.csv", "данные.json", "日本語.csv", "🙂.csv"]) {
      expectKeyStaysInsideArtifactDir(key(attempt));
    }
  });
});

describe("buildArtifactStorageKey", () => {
  it("uses the server-controlled prefix for a plain filename", () => {
    expect(key("data.csv")).toBe(`${PREFIX}data.csv`);
  });

  it("keeps two different display names under the same artifact id's prefix", () => {
    const a = key("report.csv");
    const b = key("../../../../report.csv");
    expect(a.startsWith(PREFIX)).toBe(true);
    expect(b.startsWith(PREFIX)).toBe(true);
    expect(a).toBe(b);
    expectKeyStaysInsideArtifactDir(a);
    expectKeyStaysInsideArtifactDir(b);
  });

  it("cannot make one artifact's key collide with a different artifact id", () => {
    const mine = key("data.csv", ARTIFACT_ID);
    const theirs = key("data.csv", OTHER_ARTIFACT_ID);
    expect(mine).not.toBe(theirs);
    // And no filename supplied to `mine` can reach `theirs`.
    for (const attempt of [
      `../${OTHER_ARTIFACT_ID}/data.csv`,
      `..%2f${OTHER_ARTIFACT_ID}%2fdata.csv`,
      `..\\${OTHER_ARTIFACT_ID}\\data.csv`,
      `/artifacts/${ArtifactKind.submission_attachment}/${OTHER_ARTIFACT_ID}/data.csv`,
    ]) {
      expect(key(attempt, ARTIFACT_ID)).not.toBe(theirs);
      expectKeyStaysInsideArtifactDir(key(attempt, ARTIFACT_ID));
    }
  });

  it("keeps the kind segment server-controlled across every kind", () => {
    for (const kind of Object.values(ArtifactKind)) {
      const built = buildArtifactStorageKey({ kind, artifactId: ARTIFACT_ID, filename: "../x/../y.csv" });
      expect(built).toBe(`artifacts/${kind}/${ARTIFACT_ID}/y.csv`);
      expect(built.split("/")).toHaveLength(4);
    }
  });
});
