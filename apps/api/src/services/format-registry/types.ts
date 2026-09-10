// SPDX-License-Identifier: Apache-2.0

/**
 * Format-handler abstraction. Ported from v1 databounty-api's
 * `src/services/format-registry/types.ts`. A FormatHandler only knows how to
 * parse/preview/similarity-check one ArtifactModality — it has no idea what
 * bounty, contract, or pipeline stage is calling it. That lets us add a new
 * modality (or swap the implementation of an existing one) without touching
 * `services/artifacts.ts`, and vice versa: change the upload pipeline without
 * touching any handler.
 *
 * Mirrors the community `execution-providers/types.ts` pattern (a small
 * interface + a fail-closed default) so an unconfigured/unimplemented
 * modality degrades to "not supported" evidence instead of a fabricated
 * pass.
 */
import type { Artifact, ArtifactModality } from "@prisma/client";

/** Result of extracting structured metadata from an artifact's bytes. */
export interface ParseResult {
  ok: boolean;
  metadata: Record<string, unknown>;
  /** Present when ok is false — why parsing did not produce metadata. */
  reason?: string;
}

/** Result of generating (or declining to generate) a human-viewable preview. */
export interface PreviewResult {
  status: "passed" | "not_supported";
  reason?: string;
}

/** Result of comparing two artifacts of the same modality for
 * duplication/near-duplication (cross-contributor similarity — never an
 * external-corpus plagiarism check, which this platform does not perform).
 * Mirrors the dedupe verdict shape used elsewhere in the pipeline
 * (reject / advisory / clear) so this plugs into the same audit-evidence
 * rendering without a new vocabulary. */
export interface SimilarityResult {
  status: "passed" | "not_supported";
  score?: number;
  verdict?: "reject" | "advisory" | "clear";
  reason?: string;
}

/**
 * One modality's pluggable implementation of parse/preview/similarity (and,
 * optionally, a sandbox execution hook). `version` is evidence, not cosmetic:
 * it is persisted on `Artifact.parserVersion` and on each
 * `ArtifactProcessingEvent.handlerVersion` row, so a later bump in
 * parse/preview/similarity logic can be detected as staleness against
 * already-processed artifacts and trigger a recheck. Bump it whenever this
 * handler's parse/preview/similarity behavior changes.
 */
export interface FormatHandler {
  readonly modality: ArtifactModality;
  readonly version: string;

  /** Cheap, synchronous sniff of the first bytes of the file (magic bytes) —
   * no I/O; the caller has already read the artifact's bytes. Used to
   * corroborate (never solely trust) declared/detected MIME type. */
  detect(peek: Buffer): boolean;

  /** Extract structured metadata from the artifact. MUST NOT throw for an
   * unsupported/unconfigured handler — return `{ ok: false, reason }`
   * instead, so callers can record honest evidence. */
  parse(artifact: Artifact): Promise<ParseResult>;

  /** Produce (or decline to produce) a human-viewable preview for the
   * artifact. Never fabricate a "passed" preview for content it can't
   * actually render. */
  preview(artifact: Artifact): Promise<PreviewResult>;

  /** Compare two artifacts of this handler's modality for
   * duplication/near-duplication. Never fabricate a verdict when the
   * handler has no real comparison logic — return `not_supported`. */
  similarityCheck(a: Artifact, b: Artifact): Promise<SimilarityResult>;
}
