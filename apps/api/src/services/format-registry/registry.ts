// SPDX-License-Identifier: Apache-2.0

import { ArtifactModality } from "@prisma/client";
import { ARCHIVE_HANDLER } from "./archive.js";
import { AUDIO_HANDLER } from "./audio.js";
import { CODE_TEXT_HANDLER } from "./code-text.js";
import { DEFAULT_HANDLER } from "./default-handler.js";
import { DOCUMENT_HANDLER } from "./document.js";
import { IMAGE_HANDLER } from "./image.js";
import type { FormatHandler } from "./types.js";
import { VIDEO_HANDLER } from "./video.js";

/**
 * Per-modality format handler registry. Ported from v1 databounty-api's
 * `src/services/format-registry/registry.ts`. Adding real support for a
 * modality — or swapping its implementation — is a local change here
 * (implement FormatHandler, register it below), never a rewrite of the
 * upload pipeline that calls resolveHandler().
 *
 * `code` and `text` deliberately share the same handler instance —
 * code-text.ts implements one format-agnostic plain-UTF-8 handler for both.
 */
export const FORMAT_HANDLERS: Record<ArtifactModality, FormatHandler> = {
  image: IMAGE_HANDLER,
  video: VIDEO_HANDLER,
  audio: AUDIO_HANDLER,
  document: DOCUMENT_HANDLER,
  archive: ARCHIVE_HANDLER,
  code: CODE_TEXT_HANDLER,
  text: CODE_TEXT_HANDLER,
  other: DEFAULT_HANDLER,
};

/** Resolve the handler for a (possibly missing/unknown) modality. Never
 * throws and never returns undefined — an artifact with no modality yet or
 * an unrecognized value fails closed to DEFAULT_HANDLER rather than
 * crashing the pipeline or silently skipping evidence. */
export function resolveHandler(modality: ArtifactModality | null | undefined): FormatHandler {
  if (!modality) return DEFAULT_HANDLER;
  return FORMAT_HANDLERS[modality] ?? DEFAULT_HANDLER;
}

/** Archive container types that aren't distinguishable by MIME prefix. */
const ARCHIVE_MIMES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
]);

/** Text-ish MIMEs that are really source code / structured data, not prose. */
const CODE_MIMES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "text/xml",
  "text/csv",
  "text/tab-separated-values",
]);

/**
 * Classify an artifact's modality from its content type. This is what makes
 * the format registry reachable at all: an artifact with a NULL modality
 * resolves to DEFAULT_HANDLER forever, so every new upload must be
 * classified at creation time, not just backfilled for historical rows.
 *
 * Deliberately conservative: anything unrecognized becomes `other` (which
 * resolves to the fail-closed DEFAULT_HANDLER) rather than being guessed
 * into a modality whose handler would then make claims it can't back up.
 * The post-scan pass in `services/artifacts.ts` narrows this once real bytes
 * have been sniffed.
 */
export function modalityForContentType(contentType: string | null | undefined): ArtifactModality {
  if (!contentType) return "other";
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (ct === "application/pdf") return "document";
  if (ARCHIVE_MIMES.has(ct) || ct.includes("zip")) return "archive";
  if (CODE_MIMES.has(ct)) return "code";
  if (ct === "text/plain" || ct.startsWith("text/")) return "text";
  return "other";
}
