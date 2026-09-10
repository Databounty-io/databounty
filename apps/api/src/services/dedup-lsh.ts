// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

/**
 * Near-duplicate detection via MinHash + LSH banding.
 *
 * Backs `SubmissionLshBand` (prisma/schema.prisma) — a table that existed
 * unused before this file. Exact-hash dedup (`computeDedupeKey` in
 * submissions.ts) only catches byte-identical resubmissions; this catches
 * "same item, reworded/reformatted/one-field-changed" resubmissions, which
 * exact hashing structurally cannot.
 *
 * Design (documented here because there's no single canonical "the" MinHash
 * config — these are the choices this implementation makes):
 *
 * 1. Canonicalization: `payloadJson` varies per dataset type (different
 *    field names/shapes), so instead of reading named fields we flatten
 *    every string value out of the JSON tree, sort the top-level object keys
 *    first (so `{a,b}` and `{b,a}` canonicalize identically regardless of
 *    JSON key order), then join everything with single spaces and
 *    lowercase it. This makes the signature robust across dataset types
 *    without hardcoding field names, at the cost of not caring which field a
 *    string came from — acceptable for a dedup *candidate* gate, since a
 *    real similarity score is computed downstream before anything acts on
 *    it.
 * 2. Shingling: word 5-grams (k=5) over the canonicalized text, tokenized on
 *    whitespace. Word-shingles are the standard choice for near-duplicate
 *    *document* detection (vs. char-shingles, more common for short strings
 *    like URLs); submissions here are prose/code blocks, so word-shingles
 *    are the better fit. Falls back to char 8-grams when the canonicalized
 *    text is too short to produce 5 words (e.g. a single short field),
 *    otherwise those short payloads would produce zero shingles and an
 *    empty, useless signature.
 * 3. MinHash: 64 hash functions (a standard, commonly-used count — enough
 *    signal for a stable Jaccard estimate at 1/64 ≈ 0.0156 resolution,
 *    without generating a large per-submission storage footprint), each
 *    implemented as a distinct salted SHA-256 of the shingle text truncated
 *    to a 32-bit integer, taking the min per function across all shingles.
 * 4. Banding: 16 bands × 4 rows (16 × 4 = 64 hashes). Two submissions that
 *    share *any* one band (all 4 of that band's hash values equal) are
 *    flagged as LSH candidates. With true Jaccard similarity s, probability
 *    of sharing at least one band is 1 - (1 - s^4)^16 — this crosses 50% at
 *    s ≈ 0.4 and approaches 1 as s → 0.8+, which is the right shape for a
 *    *candidate* filter feeding a real similarity computation (see
 *    `estimateJaccardSimilarity`), not a final decision on its own.
 */

const SHINGLE_K_WORDS = 5;
const SHINGLE_K_CHARS = 8;
const NUM_HASHES = 64;
const NUM_BANDS = 16;
const ROWS_PER_BAND = NUM_HASHES / NUM_BANDS; // 4

/** Deterministic per-function salts — fixed so the same payload always
 * produces the same signature across process restarts/deploys. */
const HASH_SEEDS: string[] = Array.from({ length: NUM_HASHES }, (_, i) => `dbty-minhash-seed-${i}`);

/** Flattens every string value out of an arbitrary JSON value, with object
 * keys sorted first so key order never affects the result. Numbers/booleans
 * are stringified too (they carry real signal, e.g. a changed line number),
 * null/undefined are skipped. */
function flattenToStrings(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.trim()) out.push(value.trim());
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenToStrings(item, out);
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) flattenToStrings((value as Record<string, unknown>)[key], out);
  }
}

/** Canonical, deterministic, key-order-independent text form of an arbitrary
 * dataset-type payload. Exported for testing/inspection. */
export function canonicalizePayload(payload: unknown): string {
  const parts: string[] = [];
  flattenToStrings(payload, parts);
  return parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Word 5-grams, falling back to char 8-grams for short texts so a short
 * payload still produces a usable (if lower-confidence) signature instead of
 * an all-empty one. */
function shingle(text: string): string[] {
  const words = text.split(" ").filter(Boolean);
  if (words.length >= SHINGLE_K_WORDS) {
    const shingles: string[] = [];
    for (let i = 0; i <= words.length - SHINGLE_K_WORDS; i += 1) {
      shingles.push(words.slice(i, i + SHINGLE_K_WORDS).join(" "));
    }
    return shingles;
  }
  const chars = text.replace(/\s+/g, "");
  if (chars.length >= SHINGLE_K_CHARS) {
    const shingles: string[] = [];
    for (let i = 0; i <= chars.length - SHINGLE_K_CHARS; i += 1) {
      shingles.push(chars.slice(i, i + SHINGLE_K_CHARS));
    }
    return shingles;
  }
  // Whole text is the only "shingle" available — better than nothing.
  return chars ? [chars] : [];
}

function seededHash32(seed: string, text: string): number {
  const digest = createHash("sha256").update(seed).update("|").update(text).digest();
  // Use the first 4 bytes as an unsigned 32-bit integer.
  return digest.readUInt32BE(0);
}

/** MinHash signature: one 32-bit min value per hash function across all of
 * the payload's shingles. Empty payloads (no shingles) get a signature of
 * all-zero, which will band-collide with each other but not with anything
 * that has real content — acceptable degenerate behavior for empty items. */
export function computeMinHashSignature(payload: unknown): number[] {
  const text = canonicalizePayload(payload);
  const shingles = shingle(text);
  if (shingles.length === 0) return new Array(NUM_HASHES).fill(0);

  const signature = new Array(NUM_HASHES).fill(Number.MAX_SAFE_INTEGER);
  for (const sh of shingles) {
    for (let h = 0; h < NUM_HASHES; h += 1) {
      const v = seededHash32(HASH_SEEDS[h]!, sh);
      if (v < signature[h]!) signature[h] = v;
    }
  }
  return signature;
}

/** Bands a MinHash signature into `{ bandIndex, bandHash }` rows matching
 * `SubmissionLshBand`'s shape. `bandHash` is a short deterministic digest of
 * that band's `ROWS_PER_BAND` signature values, so two submissions with
 * identical values in a band produce an identical `bandHash` string and can
 * be found via a plain equality query on `(bandIndex, bandHash)`. */
export function computeLshBands(payload: unknown): { bandIndex: number; bandHash: string }[] {
  const signature = computeMinHashSignature(payload);
  return bandsFromSignature(signature);
}

export function bandsFromSignature(signature: number[]): { bandIndex: number; bandHash: string }[] {
  const bands: { bandIndex: number; bandHash: string }[] = [];
  for (let b = 0; b < NUM_BANDS; b += 1) {
    const start = b * ROWS_PER_BAND;
    const rowValues = signature.slice(start, start + ROWS_PER_BAND);
    const bandHash = createHash("sha256").update(rowValues.join(",")).digest("hex").slice(0, 32);
    bands.push({ bandIndex: b, bandHash });
  }
  return bands;
}

/** Estimated Jaccard similarity between two MinHash signatures: the fraction
 * of hash functions where both signatures picked the same minimum value.
 * This is the standard MinHash similarity estimator and converges to true
 * Jaccard similarity of the underlying shingle sets as NUM_HASHES grows. */
export function estimateJaccardSimilarity(sigA: number[], sigB: number[]): number {
  if (sigA.length === 0 || sigB.length === 0 || sigA.length !== sigB.length) return 0;
  let matches = 0;
  for (let i = 0; i < sigA.length; i += 1) {
    if (sigA[i] === sigB[i]) matches += 1;
  }
  return matches / sigA.length;
}

export const LSH_CONFIG = {
  numHashes: NUM_HASHES,
  numBands: NUM_BANDS,
  rowsPerBand: ROWS_PER_BAND,
} as const;
