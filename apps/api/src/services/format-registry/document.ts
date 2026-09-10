// SPDX-License-Identifier: Apache-2.0

/**
 * Document-modality FormatHandler. Ported from v1 databounty-api's
 * `src/services/format-registry/document.ts`. Detects PDFs via magic bytes
 * only. No text-extraction library is integrated yet, so parse() fails
 * closed with an honest reason instead of hand-rolling a PDF parser; preview
 * and similarity are not_supported for the same reason. Bump `version`
 * whenever this behavior changes.
 */
import type { Artifact, ArtifactModality } from "@prisma/client";
import type { FormatHandler, ParseResult, PreviewResult, SimilarityResult } from "./types.js";

const PDF_MAGIC_BYTES = Buffer.from("%PDF-", "utf8");

export const DOCUMENT_HANDLER: FormatHandler = {
  modality: "document" as ArtifactModality,
  version: "1.0.0",

  detect(peek: Buffer): boolean {
    return peek.subarray(0, PDF_MAGIC_BYTES.length).equals(PDF_MAGIC_BYTES);
  },

  async parse(_artifact: Artifact): Promise<ParseResult> {
    return {
      ok: false,
      metadata: {},
      reason: "text extraction requires a PDF library not yet integrated",
    };
  },

  async preview(_artifact: Artifact): Promise<PreviewResult> {
    return { status: "not_supported", reason: "text extraction requires a PDF library not yet integrated" };
  },

  async similarityCheck(_a: Artifact, _b: Artifact): Promise<SimilarityResult> {
    return { status: "not_supported", reason: "text extraction requires a PDF library not yet integrated" };
  },
};
