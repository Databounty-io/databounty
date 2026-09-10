// SPDX-License-Identifier: Apache-2.0

/**
 * Video FormatHandler. Ported from v1 databounty-api's
 * `src/services/format-registry/video.ts`. `detect()` corroborates common
 * container magic bytes (ISO-BMFF `ftyp` box for mp4/mov, or the
 * WebM/Matroska EBML header) without pulling in a media-parsing dependency.
 * `parse()` honestly reports that duration/codec probing is not yet
 * implemented rather than fabricating metadata; `preview()`/
 * `similarityCheck()` are `not_supported` (frame-extract thumbnail and
 * similarity are both future work).
 */
import type { Artifact, ArtifactModality } from "@prisma/client";
import type { FormatHandler, ParseResult, PreviewResult, SimilarityResult } from "./types.js";

/** ISO-BMFF (mp4/mov/m4v/…) box type field lives at bytes 4-7, and the box
 * size (bytes 0-3) precedes it — the classic layout is
 * `[4-byte size][4-byte "ftyp"][...]`. We only check the well-known offset. */
const FTYP_OFFSET = 4;
const FTYP_BYTES = Buffer.from("ftyp", "ascii");

/** WebM/Matroska EBML header magic: 1A 45 DF A3, at the very start of the file. */
const EBML_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

export const VIDEO_HANDLER: FormatHandler = {
  modality: "video" as ArtifactModality,
  version: "1.0.0",

  detect(peek: Buffer): boolean {
    if (peek.length >= EBML_HEADER.length && peek.subarray(0, EBML_HEADER.length).equals(EBML_HEADER)) {
      return true;
    }
    if (peek.length >= FTYP_OFFSET + FTYP_BYTES.length) {
      const candidate = peek.subarray(FTYP_OFFSET, FTYP_OFFSET + FTYP_BYTES.length);
      if (candidate.equals(FTYP_BYTES)) {
        return true;
      }
    }
    return false;
  },

  async parse(_artifact: Artifact): Promise<ParseResult> {
    return {
      ok: false,
      metadata: {},
      reason: "duration/codec probing requires a media library not yet integrated",
    };
  },

  async preview(_artifact: Artifact): Promise<PreviewResult> {
    return { status: "not_supported", reason: "frame-extract preview not yet implemented" };
  },

  async similarityCheck(_a: Artifact, _b: Artifact): Promise<SimilarityResult> {
    return { status: "not_supported", reason: "video similarity check not yet implemented" };
  },
};
