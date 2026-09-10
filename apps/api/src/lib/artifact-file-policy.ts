// SPDX-License-Identifier: Apache-2.0

/**
 * Artifact file-content policy: per-modality size ceilings plus the ZIP
 * zip-bomb (extraction-ratio) guard. Adapted from v1 databounty-api's
 * `src/lib/artifact-file-policy.ts`, scoped down to what community's format
 * registry actually needs — declaration-time extension/MIME allowlisting
 * lives in `routes/v1/artifacts.ts` (owned by another agent) and is out of
 * scope here.
 *
 * Per-type size ceilings are deliberately generous defaults for a
 * community-scale deployment (no paid-tier distinctions — community has one
 * tier). They exist so a single oversized upload of a given modality can be
 * flagged/rejected by the registry dispatcher before its bytes are trusted
 * for parsing, rather than only being bounded by the platform-wide upload
 * cap (if any) exposed elsewhere.
 */
import type { ArtifactModality } from "@prisma/client";

const MB = 1024 * 1024;

/** Per-modality upload size ceiling, in bytes. `other` covers anything the
 * registry could not classify — kept conservative since an unrecognized
 * modality gets no real handler support anyway. */
export const MODALITY_SIZE_CEILING_BYTES: Readonly<Record<ArtifactModality, number>> = {
  image: 25 * MB,
  video: 500 * MB,
  audio: 100 * MB,
  document: 50 * MB,
  archive: 25 * MB,
  code: 10 * MB,
  text: 10 * MB,
  other: 10 * MB,
};

export interface SizeCeilingResult {
  ok: boolean;
  ceilingBytes: number;
}

/** Fail-closed by construction: an unknown modality still resolves to a real
 * (conservative) ceiling via the `other` entry — there is no "no limit"
 * branch. */
export function checkModalitySizeCeiling(modality: ArtifactModality, sizeBytes: number): SizeCeilingResult {
  const ceilingBytes = MODALITY_SIZE_CEILING_BYTES[modality] ?? MODALITY_SIZE_CEILING_BYTES.other;
  return { ok: sizeBytes <= ceilingBytes, ceilingBytes };
}

// G8 — zip-bomb defense. Read the ZIP *central directory* — which declares
// each entry's uncompressed size and the total entry count WITHOUT
// decompressing a single byte — and reject archives that declare too many
// entries, too much total uncompressed data, or an implausible expansion
// ratio (the classic zip-bomb signature: a few KB that claim to expand to
// gigabytes). Fails closed: anything that cannot be parsed with confidence
// (ZIP64, truncation, bad signatures) is treated as a breach.
export const MAX_ARCHIVE_ENTRIES = 10_000;
export const MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES = 500 * MB;
export const MAX_ARCHIVE_EXPANSION_RATIO = 100;

export interface ArchiveEvaluation {
  ok: boolean;
  reason?: "too_many_entries" | "uncompressed_too_large" | "expansion_ratio" | "unparseable";
  entries?: number;
  uncompressedBytes?: number;
  ratio?: number;
}

const EOCD_SIGNATURE = 0x06054b50; // "PK\x05\x06" — End Of Central Directory
const CDH_SIGNATURE = 0x02014b50; // "PK\x01\x02" — Central Directory Header
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

/**
 * Evaluate a ZIP archive against the zip-bomb caps by reading only its
 * central directory — no decompression, no dependency. Pure and fully
 * unit-testable. Fails closed (`ok: false`, `reason: "unparseable"`) on
 * anything it cannot read with certainty, including any ZIP64 sentinel, so a
 * crafted archive can never slip past by hiding its real sizes in an
 * extension this function does not parse.
 */
export function evaluateZipArchive(buffer: Buffer, compressedSizeBytes: number): ArchiveEvaluation {
  const unparseable: ArchiveEvaluation = { ok: false, reason: "unparseable" };

  // The EOCD lives at the end, after an optional comment of up to 65535 bytes.
  const minEocd = 22;
  if (buffer.length < minEocd) return unparseable;
  let eocd = -1;
  const scanFrom = Math.max(0, buffer.length - (minEocd + 0xffff));
  for (let i = buffer.length - minEocd; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return unparseable;

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  // ZIP64 sentinels mean the real values live in a ZIP64 record this
  // function does not parse — refuse rather than trust the truncated
  // 16/32-bit view.
  if (totalEntries === ZIP64_SENTINEL_16 || cdOffset === ZIP64_SENTINEL_32) return unparseable;
  if (cdOffset >= buffer.length) return unparseable;

  let entries = 0;
  let uncompressedBytes = 0;
  let p = cdOffset;
  while (p + 46 <= buffer.length && buffer.readUInt32LE(p) === CDH_SIGNATURE) {
    const compressed = buffer.readUInt32LE(p + 20);
    const uncompressed = buffer.readUInt32LE(p + 24);
    if (compressed === ZIP64_SENTINEL_32 || uncompressed === ZIP64_SENTINEL_32) return unparseable;
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    entries += 1;
    uncompressedBytes += uncompressed;
    if (entries > MAX_ARCHIVE_ENTRIES) return { ok: false, reason: "too_many_entries", entries };
    if (uncompressedBytes > MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES) {
      return { ok: false, reason: "uncompressed_too_large", entries, uncompressedBytes };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  // The walked count must match the directory's declared total, or the
  // archive is malformed/truncated — fail closed.
  if (entries !== totalEntries) return unparseable;

  const ratio = compressedSizeBytes > 0 ? uncompressedBytes / compressedSizeBytes : uncompressedBytes;
  if (ratio > MAX_ARCHIVE_EXPANSION_RATIO) {
    return { ok: false, reason: "expansion_ratio", entries, uncompressedBytes, ratio };
  }
  return { ok: true, entries, uncompressedBytes, ratio };
}
