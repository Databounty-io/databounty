# Storage Adapter Boundary

Ported from v1 databounty-api (`src/lib/storage/README.md`). Artifacts use a
provider-neutral storage port.

Product and route code must depend only on:

- `StorageDriver` for server-side `put`, `get`, `head`, and `remove`
- `DirectUploadStorageDriver` when a provider can issue browser-upload targets
- `MultipartUploadStorageDriver` when a provider can issue chunked, resumable
  large-object uploads
- artifact metadata in the database, never provider paths or bucket URLs

The API is the control plane. It authenticates, authorizes, creates pending
Artifact rows, generates server-owned object keys, verifies completion, and
serves reads through permission checks.

The storage provider is the data plane. Browser uploads may go directly to the
provider only after `/v1/artifacts/upload-slot` (single-request) or
`/v1/artifacts/multipart-slot` (chunked) returns backend-issued upload
instructions.

To add a provider:

1. Implement `StorageDriver` in a new adapter file.
2. Implement `DirectUploadStorageDriver` only if the provider supports safe
   short-lived browser uploads.
3. Implement `MultipartUploadStorageDriver` only if the provider supports real
   chunked/resumable large-object uploads.
4. Register the adapter in `src/lib/storage/index.ts`.
5. Keep provider-specific signing, headers, URLs, and credentials inside the
   adapter.
6. Do not expose storage keys, buckets, or provider URLs in product API
   responses.

The local disk driver (`local.ts`) implements ONLY the base `StorageDriver`
contract — no direct-upload, no multipart. That is correct, not a gap: a
local filesystem has no notion of a short-lived signed browser-upload target.
When the active driver has neither capability, `POST /v1/artifacts/:id/content`
(same-origin, token-authorized) is the fallback upload path — this is the
local-driver fallback the rest of this codebase relies on for dev.
