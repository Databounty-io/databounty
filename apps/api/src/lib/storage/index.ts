// SPDX-License-Identifier: Apache-2.0

import { config } from "../../config.js";
import { LocalDiskDriver, localRootFor } from "./local.js";
import { S3Driver } from "./s3.js";
import type { StorageDriver } from "./types.js";

export type { StorageDriver, StoredObject, ObjectMetadata, DirectUploadTarget, MultipartUploadPlan, MultipartPartDeclaration, MultipartCompletedPart } from "./types.js";
export { hasDirectUpload, hasMultipartUpload, planMultipartParts, S3_MIN_PART_BYTES, S3_MAX_PART_BYTES, S3_MAX_PARTS } from "./types.js";

type StorageDriverFactory = () => StorageDriver;

const storageDriverFactories: Record<string, StorageDriverFactory> = {
  local: () => new LocalDiskDriver(localRootFor(config.storage.localDir), config.storage.bucket || null),
  // S3Driver is intentionally the adapter for the S3-compatible protocol, not
  // a product dependency. R2/MinIO/Ceph can use this with STORAGE_ENDPOINT; a
  // provider with a different API should add a new factory here.
  s3: () =>
    new S3Driver({
      bucket: config.storage.bucket,
      region: config.storage.region,
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
      sessionToken: config.storage.sessionToken,
      endpoint: config.storage.endpoint || undefined,
    }),
};

let driver: StorageDriver | null = null;

/**
 * The process-wide storage driver, selected by STORAGE_DRIVER. Instantiated
 * lazily and memoized; callers do not change when the backing provider changes.
 * Ported from v1 databounty-api (`src/lib/storage/index.ts`).
 */
export function storage(): StorageDriver {
  if (driver) return driver;
  const factory = storageDriverFactories[config.storage.driver];
  if (!factory) throw new Error(`Unknown STORAGE_DRIVER: ${config.storage.driver}`);
  driver = factory();
  return driver;
}

/** Test-only: force the next `storage()` call to re-run the factory. */
export function resetStorageDriverForTests(): void {
  driver = null;
}

/** Test-only: inject a fake/mock driver (e.g. a fake `MultipartUploadStorageDriver`)
 * so multipart wiring can be proven end-to-end without real S3 infrastructure.
 * Call `resetStorageDriverForTests()` in `afterEach`/`afterAll` to restore the
 * env-configured driver. */
export function setStorageDriverForTests(fake: StorageDriver): void {
  driver = fake;
}
