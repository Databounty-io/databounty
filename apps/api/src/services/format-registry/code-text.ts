// SPDX-License-Identifier: Apache-2.0

/**
 * FormatHandler for the 'code' and 'text' modalities. Adapted from v1
 * databounty-api's `src/services/format-registry/code-text.ts`. Both
 * modalities share one implementation: plain UTF-8 content.
 *
 * v1's version delegates its similarityCheck() to shared shingle/Jaccard
 * primitives that (in v1) happened to live alongside its external-corpus
 * plagiarism module. Community has no such shared module to reuse (and,
 * per owner decision, will never build external-corpus plagiarism
 * screening), so this file carries a small self-contained k-shingle +
 * Jaccard implementation instead of inventing a fake dependency. If a
 * future community cross-contributor dedup pipeline needs this math
 * elsewhere, this is the natural place to switch to reusing it.
 *
 * Registered for BOTH `code` and `text` in the assembly phase
 * (registry.ts); this file does not do the registering itself.
 */
import type { Artifact } from "@prisma/client";
import { getArtifactData } from "../storage.js";
import type { FormatHandler, ParseResult, PreviewResult, SimilarityResult } from "./types.js";

/** Caps how much text is pulled into memory for a similarity comparison. */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** Read an artifact's bytes as UTF-8 text, bounded by MAX_TEXT_BYTES.
 * Returns null on any read failure or oversize content so callers can
 * degrade to `not_supported` instead of throwing. */
async function readArtifactText(artifact: Artifact): Promise<string | null> {
  try {
    const buffer = await getArtifactData(artifact.storageKey);
    if (buffer.length > MAX_TEXT_BYTES) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

const SHINGLE_SIZE = 5;

/** k-word shingles of normalized text, for a cheap Jaccard near-duplicate
 * comparison. Pure function, no I/O. */
export function shingles(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < SHINGLE_SIZE) return words.length > 0 ? [words.join(" ")] : [];
  const result: string[] = [];
  for (let i = 0; i <= words.length - SHINGLE_SIZE; i += 1) {
    result.push(words.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return result;
}

/** Jaccard similarity of two shingle sets: |intersection| / |union|. */
export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const s of setA) if (setB.has(s)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export const CODE_TEXT_HANDLER: FormatHandler = {
  // Registered for both `code` and `text` by the registry assembly step;
  // this field just needs a valid ArtifactModality value for the object to
  // type-check on its own.
  modality: "code",
  version: "1.0.0",

  /** UTF-8 text has no embedded NUL bytes. A null byte in the first 512
   * bytes is the standard cheap signal that content is binary, not text —
   * this only corroborates declared/detected MIME, it never overrides it. */
  detect(peek: Buffer): boolean {
    const limit = Math.min(peek.length, 512);
    for (let i = 0; i < limit; i += 1) {
      if (peek[i] === 0) return false;
    }
    return true;
  },

  /** Thin pass-through: real schema/contract validation for code and text
   * submissions runs through the existing submission pipeline, not through
   * the format registry. This handler has nothing to add. */
  async parse(): Promise<ParseResult> {
    return { ok: true, metadata: {} };
  },

  /** The frontend already renders code/text client-side from the submitted
   * payload; there is no separate server-generated preview artifact to
   * fabricate here. */
  async preview(): Promise<PreviewResult> {
    return { status: "not_supported", reason: "code/text is rendered client-side from the submission payload" };
  },

  async similarityCheck(a: Artifact, b: Artifact): Promise<SimilarityResult> {
    const [textA, textB] = await Promise.all([readArtifactText(a), readArtifactText(b)]);
    if (textA === null || textB === null) {
      return { status: "not_supported", reason: "could not read one or both artifacts as UTF-8 text" };
    }
    const score = jaccard(shingles(textA), shingles(textB));
    return { status: "passed", score, verdict: score >= 0.9 ? "reject" : score >= 0.8 ? "advisory" : "clear" };
  },
};
