// SPDX-License-Identifier: Apache-2.0

/**
 * Image FormatHandler. Adapted from v1 databounty-api's
 * `src/services/format-registry/image.ts`. Parses PNG/JPEG dimensions with
 * pure buffer reads (no new npm dependency beyond `jimp`, which the perceptual
 * hash below already needs) by reading the artifact's own stored bytes via
 * `getArtifactData()` (services/storage.ts), which collects the storage
 * driver's `Readable` into a `Buffer` on this handler's behalf — the driver
 * itself streams (see `lib/storage/local.ts` / `s3.ts`), so no image this
 * handler ever sees was buffered twice on the way in.
 *
 * preview() remains honestly `not_supported` until a later phase adds real
 * thumbnailing — never fabricate a pass for content this handler can't
 * actually check.
 *
 * similarityCheck() implements a real perceptual-hash (difference-hash /
 * dHash) near-duplicate check via `jimp` (pure-JS, no native bindings,
 * already a project dependency).
 */
import { Jimp } from "jimp";
import type { Artifact, ArtifactModality } from "@prisma/client";
import { getArtifactData } from "../storage.js";
import type { FormatHandler, ParseResult, PreviewResult, SimilarityResult } from "./types.js";

/** dHash uses a 9x8 grayscale grid (9 columns so each row yields 8
 * left-vs-right comparisons -> 8 rows * 8 bits = 64-bit hash). */
const DHASH_WIDTH = 9;
const DHASH_HEIGHT = 8;

/** Hamming-distance verdict thresholds for the 64-bit dHash comparison.
 * dHash Hamming distance (0-64, lower = more similar) is not on the same
 * scale as Jaccard similarity (0-1, higher = more similar) used for text
 * dedup, so these are a fresh, provisional pair (distance <= 5 treated as
 * visually identical/near-identical; <= 10 as plausibly related
 * crops/recompressions worth a human look), not a reuse of the 0.9/0.8 text
 * thresholds. */
const DHASH_REJECT_MAX_DISTANCE = 5;
const DHASH_ADVISORY_MAX_DISTANCE = 10;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SOI = Buffer.from([0xff, 0xd8]);

/** How many leading bytes we look at before giving up on finding a JPEG SOF
 * marker. Generous enough to cover typical EXIF/ICC-profile header segments
 * that precede the frame header in real-world photos. */
const PEEK_BYTES = 256 * 1024;

/** SOF markers that carry frame dimensions. Excludes 0xFFC4 (DHT), 0xFFC8
 * (JPG reserved, unused in practice), and 0xFFCC (DAC) which fall in the
 * 0xC0-0xCF range but are not real start-of-frame markers. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function isPng(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(PNG_SIGNATURE);
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 2 && buf.subarray(0, 2).equals(JPEG_SOI);
}

/** Computes a 64-bit difference-hash (dHash) for an image buffer: decode,
 * resize to 9x8 grayscale, then for each row set bit i when pixel[i] is
 * darker than pixel[i+1]. Returns the hash as a bigint for cheap XOR-based
 * Hamming-distance comparison. Throws on undecodable input -- the caller is
 * responsible for turning that into an honest `not_supported`/failed result,
 * never a fabricated pass. */
async function computeDHash(buf: Buffer): Promise<bigint> {
  const image = await Jimp.fromBuffer(buf);
  image.resize({ w: DHASH_WIDTH, h: DHASH_HEIGHT }).greyscale();
  let hash = 0n;
  for (let y = 0; y < DHASH_HEIGHT; y++) {
    for (let x = 0; x < DHASH_WIDTH - 1; x++) {
      const left = image.getPixelColor(x, y);
      const right = image.getPixelColor(x + 1, y);
      // getPixelColor returns 0xRRGGBBAA; greyscale() makes R=G=B, so the
      // red byte alone is the brightness we need.
      const leftBrightness = (left >>> 24) & 0xff;
      const rightBrightness = (right >>> 24) & 0xff;
      hash = (hash << 1n) | (leftBrightness < rightBrightness ? 1n : 0n);
    }
  }
  return hash;
}

/** Popcount of the XOR of two 64-bit hashes -- the standard dHash distance
 * metric (0 = identical, 64 = maximally different). */
function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

function parsePng(buf: Buffer): ParseResult {
  // PNG signature (8 bytes) + IHDR chunk: 4-byte length, 4-byte "IHDR" tag,
  // then 4-byte width, 4-byte height (big-endian), starting at byte 16.
  if (buf.length < 24) {
    return { ok: false, metadata: {}, reason: "buffer too short for PNG IHDR chunk" };
  }
  const chunkType = buf.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") {
    return { ok: false, metadata: {}, reason: "PNG missing IHDR as first chunk" };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    return { ok: false, metadata: {}, reason: "PNG IHDR reported non-positive dimensions" };
  }
  return { ok: true, metadata: { format: "png", width, height } };
}

function parseJpeg(buf: Buffer): ParseResult {
  // Walk the marker-segment stream looking for an SOF marker; the layout of
  // that segment is length(2) precision(1) height(2) width(2) ...
  let offset = 2; // past SOI
  while (offset + 2 <= buf.length) {
    if (buf[offset] !== 0xff) {
      return { ok: false, metadata: {}, reason: "JPEG marker stream malformed (expected 0xFF)" };
    }
    const marker = buf[offset + 1];
    if (marker === undefined) {
      return { ok: false, metadata: {}, reason: "JPEG marker stream truncated within peeked bytes" };
    }
    // Standalone markers with no length/payload (RSTn, TEM).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) break; // EOI reached without finding SOF
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) {
      return { ok: false, metadata: {}, reason: "JPEG segment header truncated within peeked bytes" };
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > buf.length) {
        return { ok: false, metadata: {}, reason: "JPEG SOF segment truncated within peeked bytes" };
      }
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (width <= 0 || height <= 0) {
        return { ok: false, metadata: {}, reason: "JPEG SOF reported non-positive dimensions" };
      }
      return { ok: true, metadata: { format: "jpeg", width, height } };
    }
    if (segmentLength < 2) {
      return { ok: false, metadata: {}, reason: "JPEG segment length invalid" };
    }
    offset += 2 + segmentLength;
  }
  return { ok: false, metadata: {}, reason: "no SOF0/SOF2 marker found within peeked JPEG bytes" };
}

export const IMAGE_HANDLER: FormatHandler = {
  modality: "image" as ArtifactModality,
  version: "1.0.0",

  detect(peek: Buffer): boolean {
    return isPng(peek) || isJpeg(peek);
  },

  async parse(artifact: Artifact): Promise<ParseResult> {
    let full: Buffer;
    try {
      full = await getArtifactData(artifact.storageKey);
    } catch (err) {
      return {
        ok: false,
        metadata: {},
        reason: `could not read artifact bytes from storage: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const buf = full.subarray(0, PEEK_BYTES);
    if (isPng(buf)) return parsePng(buf);
    if (isJpeg(buf)) return parseJpeg(buf);
    return { ok: false, metadata: {}, reason: "artifact bytes are not a recognized PNG or JPEG signature" };
  },

  async preview(): Promise<PreviewResult> {
    return { status: "not_supported", reason: "no server-side image preview generator implemented yet" };
  },

  async similarityCheck(a: Artifact, b: Artifact): Promise<SimilarityResult> {
    const [hashA, hashB] = await Promise.all([artifactDHash(a), artifactDHash(b)]);
    if (!hashA.ok) return { status: "not_supported", reason: hashA.reason };
    if (!hashB.ok) return { status: "not_supported", reason: hashB.reason };
    return dHashVerdict(hashA.hash, hashB.hash);
  },
};

/**
 * One artifact's 64-bit dHash, as a reusable fingerprint. Never throws — a
 * failure to read or decode is returned as a reason so callers can record
 * "could not compare" as its own state instead of a clean pass.
 */
export async function artifactDHash(
  artifact: Artifact
): Promise<{ ok: true; hash: bigint } | { ok: false; reason: string }> {
  let buf: Buffer;
  try {
    buf = await getArtifactData(artifact.storageKey);
  } catch (err) {
    return { ok: false, reason: `could not read artifact bytes from storage: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { ok: true, hash: await computeDHash(buf) };
  } catch (err) {
    return { ok: false, reason: `could not decode image for perceptual hashing: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Shared distance->verdict mapping, so the pairwise entry point and any
 * future batch path can never drift onto different thresholds. */
export function dHashVerdict(a: bigint, b: bigint): SimilarityResult {
  const distance = hammingDistance(a, b);
  const verdict: SimilarityResult["verdict"] =
    distance <= DHASH_REJECT_MAX_DISTANCE
      ? "reject"
      : distance <= DHASH_ADVISORY_MAX_DISTANCE
        ? "advisory"
        : "clear";
  return { status: "passed", score: distance, verdict };
}

export default IMAGE_HANDLER;
