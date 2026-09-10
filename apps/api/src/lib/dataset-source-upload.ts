// SPDX-License-Identifier: Apache-2.0

/**
 * Server-owned browser/bulk-source picker contract for a community pool.
 *
 * Ported from v1 `databounty-api/src/lib/dataset-profile-registry.ts:60-102`
 * (`sourceUploadRequirements` + its `FORMAT_PROFILES` table) — the piece this
 * rebuild never carried over, which left `services/bounties.ts`'s
 * `getPoolContractForBounty` reporting `sourceUpload.available: false` for
 * every dataset type unconditionally, even though the artifact-upload layer
 * (`services/artifacts.ts#validateArtifactUploadDeclaration`, via
 * `lib/artifact-upload-declaration.ts`'s `DEFAULT_ACCEPT.bulk_submission_source`)
 * already accepts a JSON/JSONL/NDJSON/CSV/TSV source file for ANY dataset
 * type. That mismatch is what the upload-review-draft page's "This dataset
 * type does not use file uploads" was reporting, on every pool, even ones
 * whose fields are plain text/code with nothing unusual about them.
 *
 * Deliberately in `lib/`, not `services/`: `services/bounties.ts` already
 * imports `services/artifacts.ts` (`buildPublicSamples`), so a module that
 * both `services/bounties.ts` (for the reported contract) and
 * `services/artifacts.ts` (for the actual upload-time gate, wired in a
 * follow-up) can import without either importing the other.
 *
 * Only the subset v1's module needs for this one job is ported —
 * `validateDatasetPayload` and `datasetProfileActivationError` govern
 * unrelated validation-profile/normalization-profile concerns this rebuild
 * does not use yet and are left out to keep this module's one job legible.
 */

import type { DatasetType } from "@prisma/client";

interface FormatProfile {
  version: 1;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  processor: "builtin-structured" | "document-worker" | "image-worker" | "audio-worker" | "video-worker";
}

export interface SourceUploadRequirements {
  profile: string;
  version: number;
  extensions: string[];
  mimeTypes: string[];
  accept: string;
  available: boolean;
  unavailableReason: string | null;
}

/** Verbatim from v1. Only `builtin-structured` profiles are ever `available`
 * here — the others name a worker (document/image/audio/video) this rebuild
 * has no bulk-source parser for, so they fail closed rather than offering a
 * picker that would only misparse what it accepts. */
const FORMAT_PROFILES: Readonly<Record<string, FormatProfile>> = {
  "structured-json-v1": { version: 1, extensions: [".json", ".jsonl", ".ndjson"], mimeTypes: ["application/json", "application/x-ndjson"], processor: "builtin-structured" },
  "tabular-v1": { version: 1, extensions: [".csv", ".tsv"], mimeTypes: ["text/csv", "text/tab-separated-values"], processor: "builtin-structured" },
  "tabular-binary-v1": { version: 1, extensions: [".parquet", ".xlsx"], mimeTypes: ["application/vnd.apache.parquet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], processor: "document-worker" },
  "document-v1": { version: 1, extensions: [".txt", ".md", ".pdf", ".docx"], mimeTypes: ["text/plain", "text/markdown", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], processor: "document-worker" },
  "image-v1": { version: 1, extensions: [".png", ".jpg", ".jpeg", ".webp"], mimeTypes: ["image/png", "image/jpeg", "image/webp"], processor: "image-worker" },
  "audio-v1": { version: 1, extensions: [".wav", ".mp3", ".flac", ".m4a"], mimeTypes: ["audio/wav", "audio/mpeg", "audio/flac", "audio/mp4"], processor: "audio-worker" },
  "video-v1": { version: 1, extensions: [".mp4", ".webm", ".mov"], mimeTypes: ["video/mp4", "video/webm", "video/quicktime"], processor: "video-worker" },
};

function verificationOf(type: Pick<DatasetType, "verification">): Record<string, unknown> {
  return type.verification && typeof type.verification === "object" && !Array.isArray(type.verification)
    ? (type.verification as Record<string, unknown>)
    : {};
}

/** Older/unconfigured catalog rows (no `verification.formatProfile` set —
 * true of every dataset type in this rebuild today) keep the legacy
 * structured-import surface: any dataset type can take a JSON/JSONL/NDJSON/CSV/TSV
 * source file, matching what `DEFAULT_ACCEPT.bulk_submission_source` already
 * permits at upload time. A type that explicitly opts into a non-structured
 * `formatProfile` (media/document) fails closed until its worker exists. */
export function sourceUploadRequirements(type: Pick<DatasetType, "verification"> | null | undefined): SourceUploadRequirements {
  if (!type) {
    return { profile: "missing", version: 0, extensions: [], mimeTypes: [], accept: "", available: false, unavailableReason: "This bounty has no dataset source format profile." };
  }
  const configured = verificationOf(type).formatProfile;
  if (typeof configured !== "string") {
    const extensions = [".json", ".jsonl", ".ndjson", ".csv", ".tsv"];
    const mimeTypes = ["application/json", "application/x-ndjson", "text/csv", "text/tab-separated-values"];
    return {
      profile: "legacy-structured-source-v1",
      version: 1,
      extensions,
      mimeTypes,
      accept: [...extensions, ...mimeTypes].join(","),
      available: true,
      unavailableReason: null,
    };
  }

  const profile = FORMAT_PROFILES[configured];
  if (!profile) {
    return { profile: configured, version: 0, extensions: [], mimeTypes: [], accept: "", available: false, unavailableReason: `Unsupported source format profile: ${configured}.` };
  }
  const available = profile.processor === "builtin-structured";
  return {
    profile: configured,
    version: profile.version,
    extensions: [...profile.extensions],
    mimeTypes: [...profile.mimeTypes],
    accept: [...profile.extensions, ...profile.mimeTypes].join(","),
    available,
    unavailableReason: available ? null : `Browser bulk review is not available for ${configured} until its ${profile.processor} source parser is healthy. Upload contract file fields individually instead.`,
  };
}
