// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed default handler. Ported from v1 databounty-api's
 * `src/services/format-registry/default-handler.ts`. Every ArtifactModality
 * resolves to this handler until a real implementation is registered for it.
 * Mirrors an unconfigured SandboxProvider: every operation reports itself as
 * unsupported rather than fabricating a pass, so UI trust claims built on
 * this evidence stay honest (missing/unsupported checks must never render
 * as "passed").
 */
import type { ArtifactModality } from "@prisma/client";
import type { FormatHandler, ParseResult, PreviewResult, SimilarityResult } from "./types.js";

export const DEFAULT_HANDLER: FormatHandler = {
  modality: "other" as ArtifactModality,
  version: "0.0.0-unsupported",

  detect(): boolean {
    return false;
  },

  async parse(): Promise<ParseResult> {
    return { ok: false, metadata: {}, reason: "no handler registered for this modality" };
  },

  async preview(): Promise<PreviewResult> {
    return { status: "not_supported", reason: "no handler registered for this modality" };
  },

  async similarityCheck(): Promise<SimilarityResult> {
    return { status: "not_supported", reason: "no handler registered for this modality" };
  },
};
