// SPDX-License-Identifier: Apache-2.0

/**
 * Archive modality handler. Adapted from v1 databounty-api's
 * `src/services/format-registry/archive.ts`. Unlike v1 (where the zip-bomb
 * ratio guard runs pre-scan in `artifact-jobs.ts` before this handler is ever
 * reached), community's `services/artifacts.ts` calls this handler's
 * `parse()` directly with the artifact's already-read bytes, so the guard is
 * inlined here instead of being assumed to have already run. `parse()`
 * fails closed (`ok: false`) on a zip-bomb breach — the caller
 * (`runArtifactScanJob`) treats a failed parse on an archive as grounds to
 * quarantine rather than trust an unopened, unbounded ZIP.
 */
import type { Artifact, ArtifactModality } from "@prisma/client";
import { getArtifactData } from "../storage.js";
import { evaluateZipArchive } from "../../lib/artifact-file-policy.js";
import type { FormatHandler, ParseResult, PreviewResult, SimilarityResult } from "./types.js";

// ZIP local-file-header magic bytes: "PK\x03\x04".
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export const ARCHIVE_HANDLER: FormatHandler = {
  modality: "archive" as ArtifactModality,
  version: "1.0.0",

  detect(peek: Buffer): boolean {
    return peek.length >= ZIP_LOCAL_FILE_HEADER.length && peek.subarray(0, 4).equals(ZIP_LOCAL_FILE_HEADER);
  },

  async parse(artifact: Artifact): Promise<ParseResult> {
    let buffer: Buffer;
    try {
      buffer = await getArtifactData(artifact.storageKey);
    } catch (err) {
      return {
        ok: false,
        metadata: {},
        reason: `could not read artifact bytes from storage: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const evaluation = evaluateZipArchive(buffer, Number(artifact.sizeBytes ?? buffer.length));
    if (!evaluation.ok) {
      return {
        ok: false,
        metadata: { entries: evaluation.entries, uncompressedBytes: evaluation.uncompressedBytes, ratio: evaluation.ratio },
        reason: `zip archive rejected: ${evaluation.reason}`,
      };
    }
    return {
      ok: true,
      metadata: {
        entries: evaluation.entries,
        uncompressedBytes: evaluation.uncompressedBytes,
        ratio: evaluation.ratio,
        checkedBy: "evaluateZipArchive",
      },
    };
  },

  async preview(_artifact: Artifact): Promise<PreviewResult> {
    return { status: "not_supported", reason: "archive preview not implemented" };
  },

  async similarityCheck(_a: Artifact, _b: Artifact): Promise<SimilarityResult> {
    return { status: "not_supported", reason: "archive similarity check not implemented" };
  },
};
