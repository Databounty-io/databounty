// SPDX-License-Identifier: Apache-2.0

import type { Readable } from "node:stream";

/**
 * Storage driver abstraction, ported faithfully from v1 databounty-api
 * (`src/lib/storage/types.ts`). Product/API code never talks to a concrete
 * provider directly; it goes through this port so local disk, S3-compatible
 * object stores, R2/GCS/Azure adapters, or a future internal blob service can
 * be swapped by registering another driver in `./index.ts`. Object keys are
 * always server-generated; a driver must never derive a key from a client
 * filename.
 */
export type UploadTargetMode = "form_post" | "put";

export interface StoredObject {
  sizeBytes: number;
  checksumSha256: string;
}

export interface ObjectMetadata {
  sizeBytes: number;
  checksumSha256: string | null;
  contentType: string | null;
}

export interface DirectUploadTarget {
  /**
   * Generic browser-upload strategy. Some providers use an HTML form POST,
   * others use a signed PUT with headers. The browser treats this as opaque
   * instructions issued by the backend.
   */
  mode: UploadTargetMode;
  method: "POST" | "PUT";
  url: string;
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  expiresAt: Date;
}

export interface StorageDriver {
  /** Driver id persisted on the Artifact row (`local`, `s3`, `r2`, etc). */
  readonly name: string;
  /** Optional provider container identifier persisted on the Artifact row. */
  readonly bucket: string | null;

  /**
   * Persist a stream at `key`, returning the server-verified size and sha256.
   * Overwrite is not allowed — each key includes a unique artifact id, so a
   * caller that retries gets a fresh key/row.
   */
  put(key: string, body: Readable, contentType: string): Promise<StoredObject>;

  /** Open a readable stream for `key`. Throws if the object is missing. */
  get(key: string): Promise<Readable>;

  /** Return verified object metadata. Throws if the object is missing. */
  head(key: string): Promise<ObjectMetadata>;

  /** Best-effort hard delete (GDPR purge). Missing key is not an error. */
  remove(key: string): Promise<void>;
}

export interface DirectUploadStorageDriver extends StorageDriver {
  createDirectUpload(params: {
    key: string;
    contentType: string;
    maxBytes: number;
    checksumSha256Hex: string;
    expiresSeconds: number;
  }): Promise<DirectUploadTarget>;
}

export function hasDirectUpload(driver: StorageDriver): driver is DirectUploadStorageDriver {
  return typeof (driver as DirectUploadStorageDriver).createDirectUpload === "function";
}

/** One part the client must declare up front (part number, exact byte size,
 * and the SHA-256 of that part's bytes). The server binds the checksum into
 * the part's presigned URL so object storage rejects a part whose bytes don't
 * match — the same integrity guarantee the single-PUT path gets, applied
 * per-part. Because each part is bounded (default 16 MB), the client hashes a
 * chunk at a time and never buffers the whole object. */
export interface MultipartPartDeclaration {
  partNumber: number;
  sizeBytes: number;
  checksumSha256Hex: string;
}

export interface MultipartPartTarget {
  partNumber: number;
  method: "PUT";
  url: string;
  /** Headers the client MUST send verbatim (the signed per-part checksum). */
  headers: Record<string, string>;
}

export interface MultipartUploadPlan {
  /** Provider multipart upload id; required to upload parts, complete, or abort. */
  uploadId: string;
  parts: MultipartPartTarget[];
  expiresAt: Date;
}

/** One uploaded part's identity, returned by the provider on each part PUT and
 * echoed back at completion so the provider can assemble the object. */
export interface MultipartCompletedPart {
  partNumber: number;
  etag: string;
}

export interface MultipartUploadStorageDriver extends StorageDriver {
  createMultipartUpload(params: {
    key: string;
    contentType: string;
    parts: MultipartPartDeclaration[];
    expiresSeconds: number;
  }): Promise<MultipartUploadPlan>;
  completeMultipartUpload(params: {
    key: string;
    uploadId: string;
    parts: MultipartCompletedPart[];
  }): Promise<void>;
  /** Best-effort abort so incomplete parts stop incurring storage cost. A
   * missing/already-aborted upload is not an error. */
  abortMultipartUpload(params: { key: string; uploadId: string }): Promise<void>;
}

export function hasMultipartUpload(driver: StorageDriver): driver is MultipartUploadStorageDriver {
  return typeof (driver as MultipartUploadStorageDriver).createMultipartUpload === "function";
}

/**
 * Split a total object size into ordered part sizes for multipart upload,
 * enforcing the S3 contract: parts are numbered from 1, every part except the
 * last is exactly `partSizeBytes`, each part is 5 MB–5 GB (the last may be
 * smaller), and there are at most 10,000 parts. Pure and provider-agnostic so
 * it can be unit-tested without touching a network. Throws on inputs that
 * cannot form a valid multipart upload rather than silently truncating.
 */
export const S3_MIN_PART_BYTES = 5 * 1024 * 1024;
export const S3_MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;
export const S3_MAX_PARTS = 10_000;

export function planMultipartParts(totalBytes: number, partSizeBytes: number): { partNumber: number; sizeBytes: number; offset: number }[] {
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) throw new Error("totalBytes must be a positive integer");
  if (!Number.isInteger(partSizeBytes) || partSizeBytes < S3_MIN_PART_BYTES || partSizeBytes > S3_MAX_PART_BYTES) {
    throw new Error(`partSizeBytes must be between ${S3_MIN_PART_BYTES} and ${S3_MAX_PART_BYTES}`);
  }
  const count = Math.ceil(totalBytes / partSizeBytes);
  if (count > S3_MAX_PARTS) {
    throw new Error(`object needs ${count} parts at ${partSizeBytes} bytes each, exceeding the ${S3_MAX_PARTS}-part limit; use a larger part size`);
  }
  const parts: { partNumber: number; sizeBytes: number; offset: number }[] = [];
  let offset = 0;
  for (let partNumber = 1; partNumber <= count; partNumber += 1) {
    const sizeBytes = Math.min(partSizeBytes, totalBytes - offset);
    parts.push({ partNumber, sizeBytes, offset });
    offset += sizeBytes;
  }
  return parts;
}
