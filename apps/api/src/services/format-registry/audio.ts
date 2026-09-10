// SPDX-License-Identifier: Apache-2.0

/**
 * Audio modality FormatHandler. Ported from v1 databounty-api's
 * `src/services/format-registry/audio.ts`. This handler only implements
 * magic-byte detection for now (WAV/FLAC/MP3/M4A). It deliberately does NOT
 * fabricate a duration/codec probe it doesn't actually perform yet —
 * `parse()` reports `ok: false` with an honest reason so downstream evidence
 * never claims a check that didn't run. Preview and similarity are
 * `not_supported`.
 */
import type { Artifact, ArtifactModality } from "@prisma/client";
import type { FormatHandler, ParseResult, PreviewResult, SimilarityResult } from "./types.js";

/** WAV files are a RIFF container: bytes 0-3 "RIFF", bytes 8-11 "WAVE". */
function isWav(peek: Buffer): boolean {
  return (
    peek.length >= 12 &&
    peek.subarray(0, 4).toString("ascii") === "RIFF" &&
    peek.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

/** FLAC files start with the 4-byte magic "fLaC". */
function isFlac(peek: Buffer): boolean {
  return peek.length >= 4 && peek.subarray(0, 4).toString("ascii") === "fLaC";
}

/** MP3: either an ID3v2 tag ("ID3") or a raw MPEG audio frame sync (11 set
 * bits: 0xFF followed by 0xE0-0xFF). Files with no tag start at the frame. */
function isMp3(peek: Buffer): boolean {
  if (peek.length >= 3 && peek.subarray(0, 3).toString("ascii") === "ID3") return true;
  return peek.length >= 2 && peek[0] === 0xff && (peek[1]! & 0xe0) === 0xe0;
}

/** M4A/AAC is ISO-BMFF: a size-prefixed "ftyp" box at offset 4. The brand is
 * not checked here — the extension/MIME allowlist and the shared magic-byte
 * scanner already constrain which containers may be uploaded. */
function isIsoBmff(peek: Buffer): boolean {
  return peek.length >= 12 && peek.subarray(4, 8).toString("ascii") === "ftyp";
}

export const AUDIO_HANDLER: FormatHandler = {
  modality: "audio" as ArtifactModality,
  version: "1.0.0",

  detect(peek: Buffer): boolean {
    return isWav(peek) || isFlac(peek) || isMp3(peek) || isIsoBmff(peek);
  },

  async parse(_artifact: Artifact): Promise<ParseResult> {
    return {
      ok: false,
      metadata: {},
      reason: "audio duration/codec probe not implemented yet",
    };
  },

  async preview(_artifact: Artifact): Promise<PreviewResult> {
    return {
      status: "not_supported",
      reason: "no server-side audio preview generator implemented yet",
    };
  },

  async similarityCheck(_a: Artifact, _b: Artifact): Promise<SimilarityResult> {
    return {
      status: "not_supported",
      reason: "audio similarity checking not supported at launch",
    };
  },
};
