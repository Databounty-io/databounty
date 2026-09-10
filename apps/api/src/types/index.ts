// SPDX-License-Identifier: Apache-2.0

export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

export interface BaseEntity {
  id: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface UserProfileSummary {
  userId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  bio: string | null;
  karma: number;
  acceptedSubmissionsCount: number;
  completedAuditsCount: number;
}

export type ArtifactScanStatusType =
  | "not_required"
  | "pending"
  | "clean"
  | "infected"
  | "error"
  | "content_mismatch";

export type ArtifactScanResult =
  | { status: "clean" }
  | { status: "infected"; detail: string }
  | { status: "not_required"; detail: string }
  | { status: "error"; detail: string };

// The real storage-driver contract lives in `lib/storage/types.ts`
// (StorageDriver / DirectUploadStorageDriver / MultipartUploadStorageDriver).
// This file only carries the config shape below.

export interface AppConfig {
  env: string;
  port: number;
  host: string;
  logLevel: string;
  corsOrigins: string[];
  /** Extra origins allowed to reach `/mcp` only. Deliberately NOT part of the
   * credentialed-CORS allowlist — see the note in config.ts. */
  mcpAllowedOrigins: string[];
  server: {
    bodyLimitBytes: number;
    trustProxy: boolean | number | string;
  };
  artifactScan: {
    endpoint?: string;
    token?: string;
    timeoutMs: number;
  };
  storage: {
    driver: "local" | "s3";
    localDir: string;
    /** Hard cap for a single-request (non-multipart) upload. */
    maxUploadBytes: number;
    /** At or above this size, uploads must go through the multipart path. */
    multipartThresholdBytes: number;
    /** Every non-final multipart part must be exactly this size. */
    multipartPartSizeBytes: number;
    /** Hard cap for a whole multipart object. */
    maxMultipartUploadBytes: number;
    /** Per-request timeout for outbound calls to the storage provider. */
    requestTimeoutMs: number;
    /** Lifetime of one upload slot, in seconds (bounded 60-3600). */
    directUploadExpiresSeconds: number;
    /** Live `pending_upload` rows one account may hold at once. */
    maxPendingUploadsPerUser: number;
    // S3-compatible provider config (s3 driver only; unused by local).
    bucket: string;
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    endpoint?: string;
  };
  /** Isolated execution sandbox (services/execution-providers/). */
  execution: {
    timeoutMs: number;
    sandboxLifetimeMs: number;
    e2bApiKey: string;
    e2bTemplate: string;
    harness: {
      childTimeoutMs: number;
      probeTimeoutMs: number;
    };
    sandbox: {
      allowEgress: boolean;
      egressAllowlist: string[];
      verifyIsolation: boolean;
      maxCpus: number;
      maxMemoryMB: number;
      maxProcesses: number;
      maxFileSizeMB: number;
      maxOpenFiles: number;
    };
  };
}
