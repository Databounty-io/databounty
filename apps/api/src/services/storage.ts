// SPDX-License-Identifier: Apache-2.0

import { Readable, Transform, pipeline } from "node:stream";
import { config } from "../config.js";
import { storage } from "../lib/storage/index.js";
import type { ObjectMetadata, StoredObject } from "../lib/storage/types.js";

export { storage } from "../lib/storage/index.js";

async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Read an artifact's bytes into memory. Only safe for content small enough
 * to buffer whole (scans, format-registry parsing, inline downloads) — large
 * uploads never go through this path; they stream via the driver's own
 * put()/multipart machinery. */
export async function getArtifactData(key: string): Promise<Buffer> {
  return collectStream(await storage().get(key));
}

/** Open an artifact's bytes as a stream, for serving to a client without
 * buffering the object in memory. Throws (ENOENT-shaped) if the object is
 * missing, before any byte is handed out, so a route can still answer 404. */
export async function openArtifactStream(key: string): Promise<Readable> {
  return storage().get(key);
}

/** Persist bytes at `key`, returning the server-verified size and SHA-256
 * (never the client's claim). Wraps the caller's Buffer as a one-shot
 * Readable so the driver's streaming `put()` contract stays uniform whether
 * the caller already has bytes in memory (this path) or a live upload stream. */
export async function putArtifactData(key: string, data: Buffer | Uint8Array, contentType: string): Promise<StoredObject> {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return storage().put(key, Readable.from(buffer), contentType);
}

/**
 * Thrown by {@link putArtifactStream} the moment an upload stream exceeds its
 * byte cap. By the time a caller sees it the source has been destroyed (no
 * further bytes are read from the client) and the partial object has been
 * removed from storage. `statusCode` follows the Fastify error convention so
 * a route can map it to 413 without knowing the class.
 */
export class ArtifactUploadTooLargeError extends Error {
  readonly code = "ARTIFACT_TOO_LARGE" as const;
  readonly statusCode = 413;
  constructor(readonly maxBytes: number) {
    super(`upload exceeds the ${maxBytes}-byte limit for this artifact`);
    this.name = "ArtifactUploadTooLargeError";
  }
}

/**
 * The byte cap for a single-request (content-route) upload. The platform-wide
 * ceiling is `STORAGE_MAX_UPLOAD_BYTES`; when the slot recorded a declared size
 * the cap is the smaller of the two — the same rule the direct-upload path
 * binds into a provider's signed policy (`createUploadSlot` passes
 * `maxBytes: declaredSizeBytes ?? maxUploadBytes`), so a declared size means
 * the same thing whichever transport the bytes take.
 */
export function resolveUploadByteCap(declaredSizeBytes: bigint | number | null | undefined): number {
  const ceiling = config.storage.maxUploadBytes;
  if (declaredSizeBytes === null || declaredSizeBytes === undefined) return ceiling;
  const declared = Number(declaredSizeBytes);
  if (!Number.isFinite(declared) || declared <= 0) return ceiling;
  return Math.min(declared, ceiling);
}

/** A pass-through that counts bytes and fails the pipeline the moment the
 * running total would exceed `maxBytes`. The offending chunk is NOT forwarded,
 * so the driver never receives a byte past the cap. */
function byteCap(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new ArtifactUploadTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Stream an untrusted upload straight into the storage driver, enforcing
 * `maxBytes` WHILE the bytes flow rather than after they have all landed.
 *
 * Universal modality invariant: large files stream. The route used to
 * `toBuffer()` a multipart file (up to the 100 MiB plugin limit) into memory
 * before a single byte reached storage; this hands the driver a live stream
 * and lets `put()` hash and size it in one pass — the returned size/sha256 are
 * still the server's own measurement, never the client's claim.
 *
 * Failure contract, for BOTH the cap and a source that dies mid-stream (client
 * abort, network reset):
 *  1. `pipeline(body, cap)` propagates the error in both directions, so the
 *     source is destroyed — the server stops reading the client's bytes.
 *  2. The driver's own `pipeline(cap, sink)` rejects, so `put()` never
 *     returns a size/checksum for a partial object.
 *  3. The partial object is removed (best effort) before the error is
 *     rethrown, so a later `/complete` cannot find and promote half a file:
 *     `runArtifactScanJob` fails to read the bytes back and records
 *     `scanStatus = error`, leaving the row in `scanning` — never `ready`.
 * The caller therefore either gets a StoredObject for the WHOLE body or an
 * exception; there is no third outcome.
 */
export async function putArtifactStream(
  key: string,
  body: Readable,
  contentType: string,
  options: { maxBytes: number }
): Promise<StoredObject> {
  const cap = byteCap(options.maxBytes);
  // Capture the *first* error (the cap's, or the source's premature close) so
  // the caller sees the real cause rather than a downstream "premature close".
  let capError: unknown = null;
  pipeline(body, cap, (err) => {
    if (err && capError === null) capError = err;
  });
  try {
    return await storage().put(key, cap, contentType);
  } catch (err) {
    try {
      await storage().remove(key);
    } catch {
      // Best effort: the row will never be promoted without the object, and a
      // leftover partial is exactly what the scan job's read-back fails on.
    }
    throw capError ?? err;
  }
}

/** Server-verified size/checksum/content-type for a stored object. Throws if
 * the object is missing. */
export async function headArtifactData(key: string): Promise<ObjectMetadata> {
  return storage().head(key);
}

/** Best-effort hard delete. Missing key is not an error. */
export async function removeArtifactData(key: string): Promise<void> {
  await storage().remove(key);
}
