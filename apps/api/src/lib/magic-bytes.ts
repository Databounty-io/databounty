// SPDX-License-Identifier: Apache-2.0

/**
 * Magic-byte content sniffing. Ported from v1 databounty-api's
 * `src/lib/magic-bytes.ts` (SCALABILITY_AND_RESILIENCE_PLAN.md §2.5,
 * "no magic-byte/content detection — MIME/extension trust is
 * declaration-only"). Reconciles a file's actual bytes against its declared
 * MIME/extension so an arbitrary payload can't wear a `.png`/`.mp4` label —
 * checksum alone only proves the bytes match what was *declared*, not that
 * the declaration itself is honest.
 *
 * Deliberately best-effort and binary-format-only: plain-text formats (csv,
 * json, jsonl, txt, md, parquet) have no reliable magic-byte signature, so
 * `detectFileKind` returns `null` for those rather than guessing — a `null`
 * result means "undetectable", not "clean", and callers must not treat it as
 * a passed check.
 *
 * `checkMagicBytes` at the bottom is the wiring entry point used by
 * `services/artifacts.ts`. Unlike v1 (whose storage driver returns a
 * `Readable`), this product's `storage()` driver returns the whole file as a
 * `Buffer` (see `lib/storage/index.ts`), so there is no stream to peek —
 * callers just slice the header off the buffer they already have.
 */
import type { Artifact } from "@prisma/client";

export type DetectedFileKind =
  | "png" | "jpeg" | "gif" | "webp" | "pdf"
  | "zip" // also covers docx/xlsx — both are ZIP containers under OOXML
  | "mp4" // also covers mov/m4a — all ISO-BMFF ("ftyp") containers
  | "wav" | "flac";

const MAGIC_TO_MIME: Record<DetectedFileKind, readonly string[]> = {
  png: ["image/png"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  pdf: ["application/pdf"],
  zip: [
    "application/zip",
    "application/x-zip-compressed",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  mp4: ["video/mp4", "video/quicktime", "audio/mp4", "audio/x-m4a"],
  wav: ["audio/wav", "audio/x-wav"],
  flac: ["audio/flac", "audio/x-flac"],
};

/** Bytes needed to run every check below — callers only need to buffer this
 * many bytes from the start of the file, not the whole thing. */
export const MAGIC_BYTE_PEEK_LENGTH = 64;

function matches(header: Buffer, offset: number, bytes: number[]): boolean {
  if (header.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (header[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function matchesAscii(header: Buffer, offset: number, text: string): boolean {
  return matches(header, offset, [...text].map((c) => c.charCodeAt(0)));
}

/** Sniffs a file's actual type from its first bytes. Returns `null` when the
 * format has no reliable signature (plain text) or the header is
 * unrecognized — NOT a claim that the content is safe. */
export function detectFileKind(header: Buffer): DetectedFileKind | null {
  if (matches(header, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (matches(header, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (matchesAscii(header, 0, "GIF87a") || matchesAscii(header, 0, "GIF89a")) return "gif";
  if (matchesAscii(header, 0, "RIFF") && matchesAscii(header, 8, "WEBP")) return "webp";
  if (matchesAscii(header, 0, "RIFF") && matchesAscii(header, 8, "WAVE")) return "wav";
  if (matchesAscii(header, 0, "%PDF-")) return "pdf";
  if (matchesAscii(header, 0, "fLaC")) return "flac";
  // ZIP local-file-header / empty-archive / spanned-archive signatures.
  // docx/xlsx are OOXML — a ZIP container under a different extension.
  if (
    matches(header, 0, [0x50, 0x4b, 0x03, 0x04]) ||
    matches(header, 0, [0x50, 0x4b, 0x05, 0x06]) ||
    matches(header, 0, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "zip";
  }
  // ISO-BMFF container (mp4/mov/m4a all share this box structure) — "ftyp"
  // at byte offset 4.
  if (matchesAscii(header, 4, "ftyp")) return "mp4";
  return null;
}

/**
 * The canonical MIME type for a sniffed file kind — the first entry in that
 * kind's accepted list.
 *
 * `detectFileKind` deliberately returns a short kind token ("png"), not a MIME
 * type, because one signature can back several MIME spellings. Anything that
 * wants to reason in MIME terms (modality routing, storing a
 * `detectedMimeType`) must convert through here rather than passing the token
 * to a MIME-shaped function: "png" is not "image/png", and a MIME matcher
 * silently classifies it as unknown.
 */
export function mimeForDetectedKind(detected: DetectedFileKind | null): string | null {
  return detected ? (MAGIC_TO_MIME[detected][0] ?? null) : null;
}

/** True when the declared MIME is consistent with the sniffed file kind.
 * A `null` detected kind means "can't tell" — treated as consistent (fails
 * open on undetectable formats, never on detectable-but-wrong ones). */
export function contentTypeMatchesDetection(declaredContentType: string, detected: DetectedFileKind | null): boolean {
  if (detected === null) return true;
  return MAGIC_TO_MIME[detected].includes(declaredContentType);
}

/** `detected` is the file kind sniffed from real bytes, or null when the
 * format isn't one `detectFileKind` recognizes (all text formats, plus any
 * binary type not in its table). null means "undetectable", never "clean" —
 * callers must not treat it as confirmation of the declared type. It is
 * surfaced so the caller can persist it as evidence rather than recomputing
 * or discarding it. */
export type MagicByteCheckOutcome =
  | { ok: true; detected: DetectedFileKind | null }
  | { ok: false; detail: string; detected: DetectedFileKind | null };

/**
 * Reconciles an artifact's actual bytes against its declared content type.
 * Runs unconditionally — unlike malware scanning, this needs no external
 * scanner endpoint. Same fail-closed contract as the malware scan: a
 * detectable mismatch must quarantine the artifact rather than be silently
 * accepted.
 */
export function checkMagicBytesFromBuffer(
  artifact: Pick<Artifact, "contentType">,
  fileBytes: Buffer
): MagicByteCheckOutcome {
  const header = fileBytes.subarray(0, MAGIC_BYTE_PEEK_LENGTH);
  const detected = detectFileKind(header);
  if (contentTypeMatchesDetection(artifact.contentType, detected)) return { ok: true, detected };
  return {
    ok: false,
    detected,
    detail: `declared content type "${artifact.contentType}" does not match detected file signature "${detected}"`,
  };
}
