// SPDX-License-Identifier: Apache-2.0

/**
 * Declaration-time (pre-storage) file policy for artifact uploads.
 *
 * Ported from v1 `databounty-api/src/lib/artifact-file-policy.ts:1-159` — the
 * half of that file the rebuild never carried over. `lib/artifact-file-policy.ts`
 * here holds the POST-upload content policy (per-modality size ceilings, the
 * zip-bomb central-directory guard); this file holds the BEFORE-upload
 * declaration policy (extension/MIME allowlist, dataset-type `accept`
 * contract, archive size cap). Kept as a separate module rather than appended
 * to the existing one so the two policies stay independently testable and the
 * existing file's own scope note stays true.
 *
 * Everything here is pure: no Prisma, no storage, no config reads. The
 * dataset-type resolution and the modality cross-check that wrap it live in
 * `services/artifacts.ts#validateArtifactUploadDeclaration`.
 */

import type { ArtifactKind } from "@prisma/client";

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** Closed extension -> accepted-MIME map. An extension absent from this table
 * is rejected outright by {@link validateArtifactDeclaration} (it can never
 * match a default `accept`), so this doubles as the upload extension
 * allowlist. Verbatim from v1. */
const EXTENSION_MIMES: Readonly<Record<string, readonly string[]>> = {
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
  ".csv": ["text/csv", "application/csv", "application/vnd.ms-excel"],
  ".tsv": ["text/tab-separated-values", "text/tsv", "text/plain"],
  ".json": ["application/json", "text/json"],
  ".jsonl": ["application/x-ndjson", "application/json", "text/plain", "application/octet-stream"],
  ".ndjson": ["application/x-ndjson", "application/json", "text/plain", "application/octet-stream"],
  ".pdf": ["application/pdf"],
  ".zip": ["application/zip", "application/x-zip-compressed"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".gif": ["image/gif"],
  ".webp": ["image/webp"],
  ".mp3": ["audio/mpeg"],
  ".wav": ["audio/wav", "audio/x-wav"],
  ".flac": ["audio/flac", "audio/x-flac"],
  ".m4a": ["audio/mp4", "audio/x-m4a"],
  ".mp4": ["video/mp4"],
  ".mov": ["video/quicktime"],
  ".webm": ["video/webm", "audio/webm"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".parquet": ["application/vnd.apache.parquet", "application/octet-stream"],
};

const MIME_EXTENSIONS = Object.entries(EXTENSION_MIMES).reduce<Record<string, string[]>>((index, [extension, mimes]) => {
  for (const mime of mimes) (index[mime] ??= []).push(extension);
  return index;
}, {});

/**
 * Conservative per-kind defaults, used when the target dataset type declares
 * no file-field `accept` of its own.
 *
 * `bulk_submission_source` differs from v1 in ONE way, deliberately: v1
 * resolves the source accept through `lib/dataset-profile-registry.ts`'s
 * `sourceUploadRequirements(datasetType)`, which this rebuild does not have as
 * a standalone module (the equivalent lives inside the pool contract built by
 * `services/bounties.ts#getPoolContractForBounty`, and importing that from the
 * artifact service would be a cycle). The draft upload route already checks a
 * file against that contract's own extension list before it ever reaches an
 * upload slot, so this default is the second, coarser gate — never the only
 * one — and it matches v1's own default set exactly.
 */
const DEFAULT_ACCEPT: Readonly<Record<"sponsor_reference" | "submission_attachment" | "bulk_submission_source", string>> = {
  sponsor_reference: ".txt,.md,.csv,.json,.jsonl,.ndjson,.pdf,.zip,.png,.jpg,.jpeg,.gif,.webp,.mp3,.wav,.mp4,.webm,.docx,.xlsx",
  submission_attachment: ".txt,.md,.csv,.json,.jsonl,.ndjson,.pdf,.zip,.png,.jpg,.jpeg,.gif,.webp,.mp3,.wav,.mp4,.webm",
  bulk_submission_source: ".csv,.tsv,.json,.jsonl,.ndjson",
};

/**
 * Kinds this policy governs. Every OTHER `ArtifactKind` is server-generated
 * (validation logs, export bundles, benchmark splits) and is never created
 * through an upload slot, so it has no declaration to police — v1 leaves those
 * with an empty accept list and only reaches the extension/MIME consistency
 * checks, which is what this module reproduces.
 */
export const DECLARATION_GOVERNED_KINDS = Object.keys(DEFAULT_ACCEPT) as Array<keyof typeof DEFAULT_ACCEPT>;

/** Unregistered spellings folded onto the canonical type, so modality routing,
 * magic-byte checks and the stored object's Content-Type all see ONE value.
 * `application/jsonl` is what MCP agents reach for on seeing a `.jsonl`. */
const CONTENT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "application/jsonl": "application/x-ndjson",
  "application/x-jsonlines": "application/x-ndjson",
  "application/ndjson": "application/x-ndjson",
};

export function normalizeDeclaredContentType(value: string): string | null {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!MIME_PATTERN.test(normalized)) return null;
  return CONTENT_TYPE_ALIASES[normalized] ?? normalized;
}

export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** Same shape check `routes/v1/admin-dataset-types.ts` applies when an admin
 * authors a file field's `accept`, restated here so an accept string that was
 * stored before that validation existed cannot widen this gate. */
export function isValidFileAccept(value: string): boolean {
  if (typeof value !== "string") return false;
  const tokens = value.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => /^\.[a-z0-9]+$/i.test(token) || /^[a-z0-9.+-]+\/(\*|[a-z0-9.+-]+)$/i.test(token));
}

export function acceptMatches(filename: string, contentType: string, accept: string): boolean {
  if (!isValidFileAccept(accept)) return false;
  const extension = fileExtension(filename);
  return accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .some((token) => {
      if (token.startsWith(".")) return token === extension;
      if (token.endsWith("/*")) return contentType.startsWith(token.slice(0, -1));
      return token === contentType;
    });
}

export interface ArtifactDeclarationPolicy {
  kind: ArtifactKind;
  filename: string;
  contentType: string;
  fieldAccepts?: string[];
}

export interface ArtifactDeclarationResult {
  ok: boolean;
  normalizedContentType?: string;
  reason?: string;
}

/**
 * Validate client-declared metadata BEFORE any storage is allocated. A dataset
 * type's file fields may widen the conservative default explicitly, which is
 * how a future image/audio/video modality is enabled through versioned catalog
 * metadata instead of by weakening every upload kind (the Universal Dataset
 * Modality Invariant's "versioned format registry with per-type allowlists").
 *
 * This validates the DECLARATION only. It is not a substitute for the
 * magic-byte reconciliation and malware scan that still run over the real
 * bytes after they land (`services/artifacts.ts#runArtifactScanJob`).
 */
export function validateArtifactDeclaration(input: ArtifactDeclarationPolicy): ArtifactDeclarationResult {
  const contentType = normalizeDeclaredContentType(input.contentType);
  if (!contentType) return { ok: false, reason: "contentType must contain a valid MIME type" };
  const extension = fileExtension(input.filename);
  if (!extension) return { ok: false, reason: "filename must include an extension" };

  const kind = input.kind as keyof typeof DEFAULT_ACCEPT;
  const fieldAccepts = (input.fieldAccepts ?? []).filter(isValidFileAccept);
  const accepted =
    fieldAccepts.length > 0
      ? fieldAccepts.some((accept) => acceptMatches(input.filename, contentType, accept))
      : acceptMatches(input.filename, contentType, DEFAULT_ACCEPT[kind] ?? "");
  if (!accepted) return { ok: false, reason: "file extension or MIME type is not allowed for this upload" };

  const knownMimes = EXTENSION_MIMES[extension];
  if (knownMimes && !knownMimes.includes(contentType)) {
    // Name the closed set: a bare "does not match" leaves the caller guessing
    // at a list only the server knows.
    return {
      ok: false,
      reason: `declared MIME type "${contentType}" does not match ${extension} (accepted: ${knownMimes.join(", ")})`,
    };
  }
  const knownExtensions = MIME_EXTENSIONS[contentType];
  if (!knownMimes && knownExtensions) {
    return { ok: false, reason: "filename extension does not match declared MIME type" };
  }
  return { ok: true, normalizedContentType: contentType };
}

/**
 * Archive upload ceiling. No extraction pipeline exists in this codebase — a
 * `.zip` is accepted for upload, size-checked, central-directory-screened
 * (`lib/artifact-file-policy.ts#evaluateZipArchive`) and never decompressed.
 * This cap bounds nothing about extraction; it only bounds how large an
 * unparsed archive blob may sit in storage. Verbatim from v1.
 */
const ARCHIVE_CONTENT_TYPES = new Set(["application/zip", "application/x-zip-compressed"]);
export const MAX_ARCHIVE_UPLOAD_BYTES = 25 * 1024 * 1024;

export function isArchiveContentType(contentType: string): boolean {
  return ARCHIVE_CONTENT_TYPES.has(contentType);
}

export function archiveSizeExceedsLimit(contentType: string, sizeBytes: number | null | undefined): boolean {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes)) return false;
  return isArchiveContentType(contentType) && sizeBytes > MAX_ARCHIVE_UPLOAD_BYTES;
}
