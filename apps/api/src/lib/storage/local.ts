// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { ObjectMetadata, StorageDriver, StoredObject } from "./types.js";

/**
 * Local-disk storage driver for dev and single-node deploys, ported
 * faithfully from v1 databounty-api (`src/lib/storage/local.ts`). Files live
 * under a configured root directory keyed by the server-generated object key.
 * Content is hashed and sized while streaming to disk (single pass) so the
 * Artifact row records server-verified integrity, not client claims.
 *
 * Deliberately implements ONLY the base `StorageDriver` contract — no
 * `DirectUploadStorageDriver` / `MultipartUploadStorageDriver` capability.
 * Local disk has no notion of a short-lived signed browser-upload target, so
 * claiming either capability here would misrepresent what this driver can
 * actually do (see `hasDirectUpload`/`hasMultipartUpload` type guards).
 */

/** Longest storage key the driver will touch. Generated keys are
 * `artifacts/<kind>/<art_ + 32 hex>/<= 120 chars>` — comfortably under this —
 * and a bound keeps a hostile key from turning into an ENAMETOOLONG (or a
 * pathological resolve) instead of a clean rejection. */
const MAX_KEY_LENGTH = 1024;

// NUL and the rest of the C0 range plus DEL. A NUL byte truncates the path in
// some syscall layers, so it must never reach `resolve()`.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Windows drive prefix (`C:`, `c:/…`). `isAbsolute()` on POSIX does not
 * consider it absolute, so it is rejected explicitly rather than being left to
 * become a literal `C:` directory name. */
const DRIVE_LETTER = /^[A-Za-z]:/;

/** Percent-encoded separators and dot segments (`%2f`, `%2e%2e`). No key
 * generator in this codebase emits `%`, and `safeStorageFilename` deliberately
 * folds it away, so any key containing one has been through a decoding step
 * that the driver must not trust. */
const ENCODED_SEPARATOR = /%2e|%2f|%5c/i;

/**
 * Is `abs` the same as, or inside, `rootAbs`?
 *
 * Two things a bare `abs.startsWith(rootAbs)` gets wrong:
 *
 *  - Sibling prefixes: `/data/store-public` starts with `/data/store` while
 *    being entirely outside it. Anchoring on `rootAbs + sep` fixes that, and
 *    is what the original check did.
 *  - Case. macOS (APFS, default) and Windows are case-insensitive, so
 *    `/data/Store/x` and `/data/store/x` are the SAME file while comparing
 *    unequal as strings. In this driver's own call path that cannot be
 *    exploited — `abs` is produced by resolving the key *against* `rootAbs`,
 *    so the prefix is byte-identical by construction, and a case flip in the
 *    key can only move within the root. But the comparison is the last line of
 *    defense, and it should stay correct if it is ever handed a path from
 *    another source (a config value in different case, a future refactor that
 *    compares an externally supplied absolute path). So on case-insensitive
 *    platforms it is folded before comparing.
 *
 * What this check still cannot see, honestly: `resolve()` is purely lexical,
 * so a SYMLINK planted inside the root and pointing outside it would pass.
 * Guarding that needs `realpath` on every operation. The key hardening below
 * is what makes it moot for keys the API generates — no caller can create a
 * link inside the root through this driver.
 */
function containedIn(rootAbs: string, abs: string): boolean {
  const caseInsensitive = platform() === "darwin" || platform() === "win32";
  const a = caseInsensitive ? abs.toLowerCase() : abs;
  const r = caseInsensitive ? rootAbs.toLowerCase() : rootAbs;
  return a === r || a.startsWith(r + sep);
}

export class LocalDiskDriver implements StorageDriver {
  readonly name = "local";
  readonly bucket: string | null;

  constructor(private readonly root: string, bucket: string | null = null) {
    this.bucket = bucket;
  }

  /**
   * Resolve a key to an absolute path, refusing anything that escapes root.
   *
   * SEC-01 defense in depth. The key generator
   * (`services/artifacts.ts:buildArtifactStorageKey`) is what guarantees a key
   * lands inside its own artifact directory; this function assumes nothing
   * about that and rejects every traversal primitive on its own:
   *
   *  1. Before resolving: empty/over-long keys, NUL and other control
   *     characters, backslashes, Windows drive prefixes, absolute paths, `.`
   *     and `..` segments, empty segments, and percent-encoded separators.
   *     Rejecting `..` *lexically* matters because `normalize()` collapses
   *     `a/../../b` into something that may still resolve inside the root —
   *     containment in the root was never the same property as containment in
   *     the artifact's own directory.
   *  2. After resolving: containment in the storage root, kept as the last
   *     line of defense (see {@link containedIn}).
   *
   * Every public method routes through here, so `get`/`head`/`remove` are
   * bound by exactly the same rules as `put`.
   */
  private pathFor(key: string): string {
    if (typeof key !== "string" || key === "") {
      throw new Error("storage key escapes root (empty key)");
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new Error("storage key escapes root (key too long)");
    }
    if (CONTROL_CHARS.test(key)) {
      throw new Error("storage key escapes root (control characters)");
    }
    if (key.includes("\\")) {
      throw new Error("storage key escapes root (backslash)");
    }
    if (DRIVE_LETTER.test(key)) {
      throw new Error("storage key escapes root (drive prefix)");
    }
    if (key.startsWith("/") || isAbsolute(key)) {
      throw new Error("storage key escapes root (absolute path)");
    }
    if (ENCODED_SEPARATOR.test(key)) {
      throw new Error("storage key escapes root (encoded separator)");
    }
    const segments = key.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("storage key escapes root (invalid path segment)");
    }

    const rootAbs = resolve(this.root);
    const abs = resolve(rootAbs, key);
    // Belt and braces: a relative()-based check and the historical
    // separator-anchored prefix check must BOTH agree the path is inside.
    const rel = relative(rootAbs, abs);
    if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      throw new Error("storage key escapes root");
    }
    if (!containedIn(rootAbs, abs) || abs === rootAbs) {
      throw new Error("storage key escapes root");
    }
    return abs;
  }

  /**
   * Write `body` to `key`, returning the server-verified size and SHA-256.
   *
   * Overwrites an existing object at the same key, deliberately. A no-clobber
   * default was considered as part of SEC-01 and rejected: the artifact upload
   * route legitimately re-writes the same key — a retried upload after a
   * client-side failure, and the format-registry/normalisation paths that
   * re-put derived bytes (`routes/v1/artifacts.ts` → `putArtifactData`) — so
   * refusing here would turn a recoverable retry into a permanently stuck
   * artifact. Whether a *completed* artifact may be re-uploaded is a lifecycle
   * decision that belongs to the route/service layer (where the artifact's
   * status is known), not to a storage driver that only sees a key. The
   * traversal hardening in {@link pathFor} is what stops a caller from
   * overwriting an object it does not own; overwriting your OWN key is the
   * driver contract every other driver (S3 included) also has.
   */
  async put(key: string, body: Readable, _contentType: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const hash = createHash("sha256");
    let sizeBytes = 0;
    body.on("data", (chunk: Buffer) => {
      sizeBytes += chunk.length;
      hash.update(chunk);
    });
    await pipeline(body, createWriteStream(path));
    return { sizeBytes, checksumSha256: hash.digest("hex") };
  }

  async get(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    await stat(path); // throws ENOENT if missing — surfaces as 404 upstream
    return createReadStream(path);
  }

  async head(key: string): Promise<ObjectMetadata> {
    const path = this.pathFor(key);
    const info = await stat(path);
    return { sizeBytes: info.size, checksumSha256: null, contentType: null };
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

export function localRootFor(dir: string): string {
  return join(process.cwd(), dir);
}
