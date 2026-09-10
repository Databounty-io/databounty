// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { requireAuth, requireAnyScope, requireVerifiedEmail, requireRole, ADMIN_AND_MEMBER, getAuthedUser, type AuthedUser } from "../../lib/rbac.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { notifyEvent } from "../../services/notifications.js";
import {
  createUploadSlot,
  completeUpload,
  createMultipartUpload,
  completeMultipartUpload,
  abortMultipartUpload,
  ArtifactUploadValidationError,
  getArtifactById,
  softDeleteArtifact,
  listUserArtifacts,
  canReadArtifact,
  verifyUploadToken,
  serializeArtifact,
  // The two freeze predicates the ADD path already applies, imported rather
  // than restated so DELETE /:id below cannot drift from the upload gate.
  requestSamplesEditable,
  TERMINAL_BOUNTY_STATUSES,
} from "../../services/artifacts.js";
import {
  ArtifactUploadTooLargeError,
  openArtifactStream,
  putArtifactStream,
  resolveUploadByteCap,
} from "../../services/storage.js";
import { prisma } from "../../lib/prisma.js";
import { buildApprovedSampleAssets, safeToWriteSampleAssetsFor } from "../../services/bounties.js";
import { config } from "../../config.js";
import { storage, hasMultipartUpload } from "../../lib/storage/index.js";
import { ArtifactKind, ArtifactVisibility, ApiKeyScope, ArtifactStatus, ArtifactScanStatus, SponsorExampleReviewStatus, DatasetRequestStatus, BountyStatus } from "@prisma/client";

/** Content types a browser will EXECUTE if it renders them inline. Ported from
 * v1's `lib/artifact-file-policy.ts` `ACTIVE_CONTENT_TYPES` (kept local here so
 * this fix touches only the route file). */
const ACTIVE_CONTENT_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "application/javascript",
  "text/javascript",
  "application/xml",
  "text/xml",
]);

/** Types safe enough to preview in place. Everything else downloads. */
const INLINE_SAFE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/json",
  "text/csv",
]);

/**
 * Response headers for serving USER-SUPPLIED bytes. Ported from v1
 * (`databounty-api/src/routes/v1/artifacts.ts:742-748` +
 * `lib/artifact-file-policy.ts` `safeArtifactContentHeaders`).
 *
 * Two things this closes, both live before this change:
 *  - `Content-Disposition: inline; filename="${artifact.filename}"` interpolated
 *    the stored display name RAW. A filename containing `"` (or a CR/LF) broke
 *    out of the quoted-string and could inject a header. The ascii form now
 *    strips everything outside printable ASCII and neutralizes `"`/`\`, with the
 *    real name carried losslessly in the RFC 5987 `filename*` parameter.
 *  - An `image/svg+xml` or `text/html` artifact served `inline` with its own
 *    declared type executes script in the API's origin. Active types are
 *    downgraded to `application/octet-stream` + `attachment`, and every response
 *    carries `nosniff` plus a script-less sandbox CSP.
 */
export function safeArtifactContentHeaders(
  filename: string,
  declaredContentType: string,
  options: {
    /** Never preview in place, whatever the type. Used by the operator
     * quarantine-download route (`admin-artifacts.ts`), where the bytes may be
     * exactly what a scanner flagged. */
    forceAttachment?: boolean;
  } = {}
) {
  const normalized = declaredContentType.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
  const active = ACTIVE_CONTENT_TYPES.has(normalized);
  const inline =
    !options.forceAttachment &&
    !active &&
    (INLINE_SAFE_CONTENT_TYPES.has(normalized) || normalized.startsWith("audio/") || normalized.startsWith("video/"));
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return {
    contentType: active ? "application/octet-stream" : normalized,
    contentDisposition: `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    contentSecurityPolicy: "sandbox; default-src 'none'; object-src 'none'; script-src 'none'",
    xContentTypeOptions: "nosniff",
    xDownloadOptions: "noopen",
    crossOriginResourcePolicy: "same-origin",
  };
}

/** The only two scan verdicts that mean "these bytes were actually cleared".
 * `pending`/`error`/`infected`/`content_mismatch` are all "not cleared", and a
 * `ready` row may only ever carry one of these two. */
const CLEARED_SCAN_STATUSES: ReadonlySet<ArtifactScanStatus> = new Set([
  ArtifactScanStatus.clean,
  ArtifactScanStatus.not_required,
]);

/** Absolutize a slot's upload target for a browser caller. The service layer
 * returns a relative `url` for the local-driver token fallback (it has no
 * request to borrow a host from); a real direct-upload target from an object
 * store is already absolute and passes through untouched. */
function absolutizeUpload<T extends { url: string }>(req: FastifyRequest, upload: T): T {
  if (!upload.url.startsWith("/")) return upload;
  return { ...upload, url: `${req.protocol}://${req.headers.host}${upload.url}` };
}

const VALIDATION_ERROR_NAMES: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
};

function sendUploadValidationError(reply: import("fastify").FastifyReply, error: ArtifactUploadValidationError) {
  // The service now carries an explicit status for the cases where the code
  // alone cannot imply one — upload-TARGET authorization answers 403 ("you are
  // not the submitter") and 404 ("no such batch"), neither of which is a
  // malformed request. Everything without an explicit status keeps the original
  // code-prefix mapping, so no pre-existing refusal changes shape.
  const status =
    error.status ??
    (error.code === "MULTIPART_UPLOAD_UNSUPPORTED" || error.code.startsWith("SLOT_")
      ? 409
      : error.code === "NOT_FOUND"
        ? 404
        : 400);
  // Keep the platform envelope (`statusCode`/`error`/`message`) and add the
  // machine-readable `code` — QA 2026-09-05 flagged bodies that carried `code`
  // without `error`.
  const errorName = VALIDATION_ERROR_NAMES[status] ?? "Bad Request";
  return reply.status(status).send({ statusCode: status, error: errorName, code: error.code, message: error.message });
}

/**
 * Per-route rate limits, ported from v1 `routes/v1/artifacts.ts:86-87`. These
 * five routes had NO route-level limit at all — only the global limiter — so
 * slot creation (a row write plus a signature per call) and completion (a
 * storage HEAD per call) were both cheap to hammer. Completion is allowed a
 * higher ceiling than issuance because one upload legitimately retries
 * completion more often than it asks for a new slot.
 */
const UPLOAD_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: "1 minute" } };
const COMPLETE_RATE_LIMIT = { rateLimit: { max: 60, timeWindow: "1 minute" } };

const uploadSlotBody = z.object({
  kind: z.nativeEnum(ArtifactKind),
  filename: z.string().trim().min(1),
  contentType: z.string().trim().min(1),
  // `sizeBytes` is what apps/web's uploadArtifact() actually sends;
  // `declaredSizeBytes` is kept as an alias for existing callers (MCP's
  // prepare_file_upload predates the size/checksum requirement).
  sizeBytes: z.number().int().positive().optional(),
  declaredSizeBytes: z.number().int().positive().optional(),
  // Required only when the active storage driver supports direct upload
  // (createUploadSlot enforces this itself, with the driver-aware message).
  checksumSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, "checksumSha256 must be a hex SHA-256 digest")
    .optional(),
  visibility: z.nativeEnum(ArtifactVisibility).optional(),
  bountyId: z.string().optional(),
  submissionId: z.string().optional(),
  contributorBatchId: z.string().optional(),
  datasetRequestId: z.string().optional(),
  plannerSessionId: z.string().optional(),
});

const multipartPartDeclaration = z.object({
  partNumber: z.number().int().min(1).max(10_000),
  sizeBytes: z.number().int().min(1).max(5 * 1024 * 1024 * 1024),
  checksumSha256Hex: z.string().regex(/^[a-f0-9]{64}$/i, "part checksum must be a hex SHA-256 digest"),
});

const multipartSlotBody = z.object({
  kind: z.nativeEnum(ArtifactKind),
  filename: z.string().trim().min(1),
  contentType: z.string().trim().min(1),
  totalSizeBytes: z.number().int().positive(),
  parts: z.array(multipartPartDeclaration).min(1).max(10_000),
  visibility: z.nativeEnum(ArtifactVisibility).optional(),
  bountyId: z.string().optional(),
  submissionId: z.string().optional(),
  contributorBatchId: z.string().optional(),
  datasetRequestId: z.string().optional(),
});

const multipartCompleteBody = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(256) })).min(1).max(10_000),
});

export async function artifactRoutes(app: FastifyInstance) {
  // Raw-body uploads to POST /:id/content. Scoped to this plugin's
  // encapsulation context, so no other route family gains an octet-stream
  // parser. The payload is handed through UNPARSED — `req.body` is the live
  // request stream — which is what lets the content route stream it into
  // storage under its own byte cap instead of Fastify buffering it against
  // `bodyLimit` first. Before this there was no parser for the type at all, so
  // a raw upload was a 415 and the route's `Buffer.isBuffer(req.body)` branch
  // was unreachable.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => {
    done(null, payload);
  });

  // Request Upload Slot
  // Every mutation below also requires a VERIFIED EMAIL, matching V1
  // (`databounty-api/src/routes/v1/artifacts.ts`, which pairs
  // `requireVerifiedEmail` with the scope guard on all five). It was absent
  // from this file entirely, so an unverified account -- or its
  // `contribute`-scoped key -- could obtain upload slots and complete
  // artifacts, which is exactly what the verified-email gate on mutations
  // exists to prevent.
  //
  // Note this is deliberately a behaviour change, not pure hardening: an
  // unverified uploader that worked a moment ago now gets 403. That is V1's
  // contract and the intended one.
  app.post("/upload-slot", { preHandler: [requireAnyScope(ApiKeyScope.artifact, ApiKeyScope.contribute), requireVerifiedEmail], config: UPLOAD_RATE_LIMIT }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = uploadSlotBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    // Planner-draft ownership — and now EVERY other upload target — is
    // authorized inside `createUploadSlot`
    // (services/artifacts.ts#authorizeArtifactUploadTarget), so that the MCP
    // `prepare_file_upload` tool and the draft routes get the same check
    // rather than only this route. The former inline planner-session check
    // lived here and covered nothing else; it now lives there, verbatim in
    // behaviour (404 for a draft the caller does not own, 409 for a submitted
    // one), alongside the submission / batch / open-pool checks that were
    // missing entirely.

    // Steer an oversized file to the multipart route rather than issuing a
    // single-PUT slot storage would then have to police. The single-PUT cap
    // and the multipart threshold are separately configurable, so a file can
    // be under `maxUploadBytes` and still belong on the multipart path.
    // Ported from v1 `routes/v1/artifacts.ts:288-295`.
    const declaredSize = parsed.data.sizeBytes ?? parsed.data.declaredSizeBytes;
    if (
      declaredSize !== undefined &&
      declaredSize >= config.storage.multipartThresholdBytes &&
      hasMultipartUpload(storage())
    ) {
      return reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        code: "MULTIPART_REQUIRED",
        message: `files of ${config.storage.multipartThresholdBytes} bytes or larger upload in parts — use POST /v1/artifacts/multipart-slot (MCP: prepare_large_file_upload) with ${config.storage.multipartPartSizeBytes}-byte parts`,
      });
    }

    let slot;
    try {
      slot = await createUploadSlot({
        ownerUserId: user.id,
        kind: parsed.data.kind,
        filename: parsed.data.filename,
        contentType: parsed.data.contentType,
        declaredSizeBytes: parsed.data.sizeBytes ?? parsed.data.declaredSizeBytes,
        checksumSha256: parsed.data.checksumSha256,
        visibility: parsed.data.visibility,
        bountyId: parsed.data.bountyId,
        submissionId: parsed.data.submissionId,
        contributorBatchId: parsed.data.contributorBatchId,
        datasetRequestId: parsed.data.datasetRequestId,
        plannerSessionId: parsed.data.plannerSessionId,
      });
    } catch (err) {
      if (err instanceof ArtifactUploadValidationError) return sendUploadValidationError(reply, err);
      throw err;
    }
    const artifact = await getArtifactById(slot.artifactId);
    if (!artifact) return reply.internalServerError("Upload slot was created but the artifact row could not be read back.");

    // Real capability detection (hasDirectUpload) decides the shape of
    // `slot.upload` inside createUploadSlot; this route's only job is
    // absolutizing a relative fallback target for the browser (a real
    // provider-issued target is already absolute and passes through as-is).
    // 200 on a reused slot, 201 on a freshly created one (v1's convention) —
    // so a client retrying after a lost response can tell that no second
    // artifact was minted.
    return reply.status(slot.reused ? 200 : 201).send({
      artifact: serializeArtifact(artifact),
      upload: absolutizeUpload(req, slot.upload),
      reused: slot.reused,
    });
  });

  // Request Multipart Upload Slot — large-object (chunked, resumable) direct
  // upload. Only fulfillable by a driver implementing MultipartUploadStorageDriver
  // (S3); on the local driver this 409s with MULTIPART_UPLOAD_UNSUPPORTED so
  // the client's documented fallback (single-slot / content-route upload) can
  // take over instead of being handed a plan that can never be assembled.
  app.post("/multipart-slot", { preHandler: [requireAnyScope(ApiKeyScope.artifact, ApiKeyScope.contribute), requireVerifiedEmail], config: UPLOAD_RATE_LIMIT }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = multipartSlotBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    try {
      const { artifactId, multipart } = await createMultipartUpload({
        ownerUserId: user.id,
        kind: parsed.data.kind,
        filename: parsed.data.filename,
        contentType: parsed.data.contentType,
        totalSizeBytes: parsed.data.totalSizeBytes,
        parts: parsed.data.parts,
        visibility: parsed.data.visibility,
        bountyId: parsed.data.bountyId,
        submissionId: parsed.data.submissionId,
        contributorBatchId: parsed.data.contributorBatchId,
        datasetRequestId: parsed.data.datasetRequestId,
      });
      const artifact = await getArtifactById(artifactId);
      if (!artifact) return reply.internalServerError("Multipart slot was created but the artifact row could not be read back.");
      return reply.status(201).send({
        artifact: serializeArtifact(artifact),
        multipart: {
          uploadId: multipart.uploadId,
          expiresAt: multipart.expiresAt,
          // Per-part PUT targets are already absolute (signed against the
          // bucket host) — nothing to absolutize here, unlike the local-driver
          // fallback above.
          parts: multipart.parts,
        },
      });
    } catch (err) {
      if (err instanceof ArtifactUploadValidationError) return sendUploadValidationError(reply, err);
      throw err;
    }
  });

  // Complete Multipart Upload — assemble the object from its uploaded parts,
  // HEAD-verify it, and enqueue the same scan job a single-request upload gets.
  app.post("/:id/multipart-complete", { preHandler: [requireAnyScope(ApiKeyScope.artifact, ApiKeyScope.contribute), requireVerifiedEmail], config: COMPLETE_RATE_LIMIT }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    const parsed = multipartCompleteBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    try {
      const artifact = await completeMultipartUpload(id, user.id, parsed.data.parts);
      return reply.send({ artifact: serializeArtifact(artifact) });
    } catch (err) {
      if (err instanceof ArtifactUploadValidationError) return sendUploadValidationError(reply, err);
      throw err;
    }
  });

  // Abort Multipart Upload — best-effort cancel on the provider, then
  // soft-delete the pending row so it stops counting against any capacity cap.
  app.post("/:id/multipart-abort", { preHandler: [requireAnyScope(ApiKeyScope.artifact, ApiKeyScope.contribute), requireVerifiedEmail], config: COMPLETE_RATE_LIMIT }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };
    try {
      await abortMultipartUpload(id, user.id);
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof ArtifactUploadValidationError) return sendUploadValidationError(reply, err);
      throw err;
    }
  });

  // Complete Upload
  app.post("/:id/complete", { preHandler: [requireAnyScope(ApiKeyScope.artifact, ApiKeyScope.contribute), requireVerifiedEmail], config: COMPLETE_RATE_LIMIT }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };

    try {
      const artifact = await completeUpload(id, user.id);
      return reply.send({ artifact: serializeArtifact(artifact) });
    } catch (err: any) {
      if (err instanceof ArtifactUploadValidationError) return sendUploadValidationError(reply, err);
      return reply.badRequest(err.message);
    }
  });

  // Upload Content (Streaming)
  //
  // No `preHandler`: this route accepts EITHER of two credentials, and a
  // preHandler that rejected the token-only caller would break every dashboard
  // upload (see below). Before this fix it accepted neither — it had no auth
  // and no ownership check at all, so anyone holding an artifact id could
  // overwrite any stored file on the platform.
  //
  //  1. The slot's capability token (`?token=`), minted by /upload-slot and
  //     bound to this artifact + owner + storage key + slot expiry, and only
  //     honoured while the artifact is still `pending_upload`. This is what
  //     the browser presents: apps/web's `transferToStorage()` sends the bytes
  //     with a bare `fetch()` and no cookie, because in the funded product the
  //     slot URL points at S3 rather than at this API.
  //  2. A real credential belonging to the artifact's owner, with the same
  //     `artifact`/`contribute` scopes /upload-slot and /:id/complete require.
  //     This is the path MCP agents take (`prepare_file_upload` hands them the
  //     same uploadUrl, and they call it with their API key).
  app.post("/:id/content", async (req, reply) => {
    const { id } = req.params as { id: string };
    const artifact = await getArtifactById(id);
    if (!artifact) return reply.notFound("Artifact not found");

    if (!verifyUploadToken(artifact, (req.query as { token?: unknown } | undefined)?.token)) {
      const user = await getAuthedUser(req);
      if (!user) return reply.unauthorized("Sign in required");
      if (
        user.apiKeyScopes &&
        !user.apiKeyScopes.includes(ApiKeyScope.artifact) &&
        !user.apiKeyScopes.includes(ApiKeyScope.contribute)
      ) {
        return reply.forbidden(
          `API key missing one of the required scopes: ${ApiKeyScope.artifact}, ${ApiKeyScope.contribute}`
        );
      }
      // Ownership, not merely authentication — matching how delete_file and
      // the artifact listing already scope. Mirrors v1's choice of 403 (not a
      // 404) for an authenticated non-owner.
      if (artifact.ownerUserId !== user.id) return reply.forbidden("You do not own this artifact");
    }

    // SEC-02. Upload-slot immutability, enforced for BOTH credentials above.
    //
    // `verifyUploadToken` already refuses a non-pending or expired slot, but
    // the authenticated-owner fallback did not: an owner (or their
    // artifact/contribute-scoped API key) could re-POST bytes over an artifact
    // that was already `scanning`, `ready`/`clean` or `quarantined`. The write
    // only updated size/checksum, so the existing scan verdict and sponsor
    // review stayed on the row and kept vouching for bytes that had since
    // changed. Reproduced live before this change (409 now, 200 then).
    //
    // Race-safety, mirroring the original application's completion path: a plain
    // read-then-write check on the row read at the top of this handler loses to
    // a concurrent POST /:id/complete. Both the gate and the metadata write are
    // therefore CONDITIONAL `updateMany`s on the live row — `count === 0` means
    // the row is no longer a pending, unexpired slot and the caller lost the
    // race.
    //
    // `data: { status: pending_upload }` is deliberately a no-op value: the gate
    // needs an atomic "does the live row still match" answer, not a state
    // change (this route stores bytes; `/complete` is what advances the
    // lifecycle). Residual, documented window: the storage PUT itself is not
    // transactional, so a `/complete` landing *during* the PUT can still be
    // followed by those bytes. It is then detected — the post-write claim below
    // fails, no size/checksum is recorded, and the caller gets 409 instead of a
    // false success. Closing it completely needs a storage-level staging key or
    // a dedicated lock column, neither of which is in this file's scope.
    const pendingSlot = { id: artifact.id, status: ArtifactStatus.pending_upload, uploadExpiresAt: { gt: new Date() } };
    const claimed = await prisma.artifact.updateMany({
      where: pendingSlot,
      data: { status: ArtifactStatus.pending_upload },
    });
    if (claimed.count === 0) {
      return reply.conflict("This upload slot is no longer open — request a new upload slot.");
    }

    /** Persist the driver's own server-verified size + checksum (never the
     * client's claim — `put()` hashes while it writes), but only while the row
     * is still the pending slot we claimed. */
    const persist = async (stored: { sizeBytes: number; checksumSha256: string }) => {
      const kept = await prisma.artifact.updateMany({
        where: { id: artifact.id, status: ArtifactStatus.pending_upload, uploadExpiresAt: { gt: new Date() } },
        data: { sizeBytes: BigInt(stored.sizeBytes), checksumSha256: stored.checksumSha256 },
      });
      return kept.count === 1;
    };

    // Streaming, not buffering. This used to `await data.toBuffer()` (and, on
    // the raw path, `await req.body` as a whole Buffer) — up to the 100 MiB
    // multipart limit of untrusted bytes held in memory before the first one
    // reached storage, which violates the universal modality invariant (large
    // files stream). The bytes now flow from the request into the driver's
    // `put()` as a live stream; the driver hashes and sizes them in the same
    // pass, so what gets persisted below is still the server's measurement.
    //
    // Two body shapes, both streamed:
    //  - multipart/form-data (the browser's FormData and MCP agents following
    //    the slot URL): the first file part's stream.
    //  - application/octet-stream: the raw request stream, left unparsed by
    //    the plugin-scoped content-type parser registered at the top of
    //    `artifactRoutes` — there is deliberately no Buffer parser for it, so
    //    Fastify's body-limit buffering never engages on this route.
    // Anything else is a 400, as before.
    let source: Readable;
    let contentType: string;
    if (req.isMultipart()) {
      const data = await req.file();
      if (!data) return reply.badRequest("No file content provided");
      source = data.file;
      contentType = data.mimetype || artifact.contentType;
    } else if (req.body instanceof Readable) {
      source = req.body;
      contentType = artifact.contentType;
    } else {
      return reply.badRequest("No file content provided");
    }

    // The cap is enforced WHILE the bytes flow (services/storage.ts
    // `putArtifactStream`): the moment the running total would pass it the
    // source is destroyed, the driver's write is aborted, the partial object
    // is removed, and the caller gets 413 — the rest of the body is never
    // read, let alone stored. A source that dies mid-way (client abort) takes
    // the same path minus the 413: the partial object is removed and the error
    // propagates, so the row is never stamped with a size/checksum and
    // `/complete` cannot promote half a file. `@fastify/multipart`'s own
    // per-file limit surfaces on the same stream as a 413-coded error and is
    // mapped identically.
    let stored: { sizeBytes: number; checksumSha256: string };
    try {
      stored = await putArtifactStream(artifact.storageKey, source, contentType, {
        maxBytes: resolveUploadByteCap(artifact.declaredSizeBytes),
      });
    } catch (err) {
      if (err instanceof ArtifactUploadTooLargeError || (err as { statusCode?: unknown })?.statusCode === 413) {
        // The body is still arriving. `Connection: close` makes Node tear the
        // socket down once this response is flushed instead of draining (and
        // discarding) the rest of an over-cap upload.
        reply.header("Connection", "close");
        return reply.status(413).send({
          statusCode: 413,
          code: "ARTIFACT_TOO_LARGE",
          message:
            err instanceof ArtifactUploadTooLargeError
              ? `This file exceeds the ${err.maxBytes}-byte limit for this upload.`
              : "This file exceeds the upload size limit.",
        });
      }
      throw err;
    }

    // Bug fix (kept from the earlier pass): the real uploaded size was computed
    // but never persisted, so GET /v1/artifacts/:id and the /complete response
    // reported sizeBytes: null forever, even for a successfully stored file.
    if (!(await persist(stored))) {
      return reply.conflict("This upload was completed while the bytes were being stored — request a new upload slot.");
    }
    return reply.send({ ok: true, sizeBytes: stored.sizeBytes });
  });

  // Get Artifact Metadata. `requireAuth` was already here, but with no read
  // check behind it any signed-in account could read any artifact's filename,
  // scan verdict and storage metadata by id.
  app.get("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const artifact = await getArtifactById(id);
    if (!artifact) return reply.notFound("Artifact not found");
    if (!(await canReadArtifact(artifact, user))) return reply.forbidden("Not visible to this account");
    return reply.send({ artifact: serializeArtifact(artifact) });
  });

  // Download Artifact Content. Was completely ungated: any artifact id was a
  // download link for anyone. Now the same read rule as the metadata route —
  // owner, admin/member/support, the bounty's sponsor, a contributor on the
  // bounty for a work_brief file, or a validator eligible for the human-audit
  // window this submission sits in. `public_sample` artifacts stay readable
  // without signing in (as in v1); everything else 401s or 403s.
  app.get("/:id/content", async (req, reply) => {
    const { id } = req.params as { id: string };
    const artifact = await getArtifactById(id);
    if (!artifact) return reply.notFound("Artifact not found");

    const user = await getAuthedUser(req);
    if (!(await canReadArtifact(artifact, user))) {
      return user ? reply.forbidden("Not visible to this account") : reply.unauthorized("Sign in required");
    }
    if (
      user?.apiKeyScopes &&
      !user.apiKeyScopes.includes(ApiKeyScope.read) &&
      !user.apiKeyScopes.includes(ApiKeyScope.artifact)
    ) {
      return reply.forbidden(
        `API key missing one of the required scopes: ${ApiKeyScope.read}, ${ApiKeyScope.artifact}`
      );
    }

    // SEC-03. Readiness gate, applied to EVERY caller of this generic route
    // including an anonymous `public_sample` reader.
    //
    // `canReadArtifact` answers "who may relate to this artifact", and it
    // short-circuits to `true` on `visibility === public_sample` before any
    // scan consideration — so before this check a quarantined/`infected` public
    // sample was downloadable anonymously (reproduced live: 200 + bytes).
    // Readiness is a separate question from access, and the original
    // application asks it separately too.
    //
    // `status === ready` is the primary gate; the scan verdict is checked as
    // well rather than trusted transitively, so a row that reached `ready` with
    // a non-cleared verdict (a future writer's bug, a hand-edited row) still
    // fails closed. `deleted`, `pending_upload`, `scanning` and `quarantined`
    // all reject here. Deliberately NO owner exception: an owner cannot pull
    // their own unscanned or quarantined bytes back through this route either
    // — see the report note.
    if (artifact.status !== ArtifactStatus.ready || !CLEARED_SCAN_STATUSES.has(artifact.scanStatus)) {
      return reply.conflict("This file is not available for download yet");
    }

    // Publication policy for sponsor examples, restated here for the same
    // reason: `canReadArtifact` enforces "scan-clean AND admin-approved" for a
    // sponsor_reference, but only on the branch an anonymous `public_sample`
    // reader never reaches. So a sample that an administrator REJECTED could be
    // exposed by its visibility column alone. Owner and platform staff keep
    // their access — that is the sponsor-review flow itself.
    if (artifact.kind === ArtifactKind.sponsor_reference && artifact.sponsorReviewStatus !== SponsorExampleReviewStatus.approved) {
      const privileged =
        !!user &&
        (artifact.ownerUserId === user.id || !!user.roles?.some((r) => r === "admin" || r === "member" || r === "support"));
      if (!privileged) {
        return user ? reply.forbidden("Not visible to this account") : reply.unauthorized("Sign in required");
      }
    }

    // Streamed, not buffered: `openArtifactStream` resolves only once the
    // driver has confirmed the object exists (so a missing object is still a
    // clean 404 below), then the bytes flow straight from storage to the
    // response (chunked transfer; no Content-Length is asserted from the row).
    let content: Readable;
    try {
      content = await openArtifactStream(artifact.storageKey);
    } catch {
      return reply.notFound("Artifact file content not found in storage");
    }
    {
      // Untrusted, user-supplied bytes: never served with an executable
      // content type, never inline unless the type is preview-safe, and never
      // with a raw display name interpolated into a header.
      const headers = safeArtifactContentHeaders(artifact.filename, artifact.contentType);
      reply.header("Content-Type", headers.contentType);
      reply.header("Content-Disposition", headers.contentDisposition);
      reply.header("X-Content-Type-Options", headers.xContentTypeOptions);
      reply.header("Content-Security-Policy", headers.contentSecurityPolicy);
      reply.header("X-Download-Options", headers.xDownloadOptions);
      reply.header("Cross-Origin-Resource-Policy", headers.crossOriginResourcePolicy);
      // A private file must never be cached by a shared proxy or CDN.
      reply.header("Cache-Control", artifact.visibility === ArtifactVisibility.public_sample ? "public, max-age=300" : "private, no-store");
      return reply.send(content);
    }
  });

  // List User Artifacts
  // `plannerSessionId` narrows to one draft's artifacts — what a resumed
  // planner needs to list its own reference samples back. It only ever
  // narrows: the query is still scoped to `user.id` inside listUserArtifacts,
  // so passing someone else's session id returns nothing rather than
  // disclosing their samples.
  app.get("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = req.query as { kind?: ArtifactKind; plannerSessionId?: string; bountyId?: string };
    // `listUserArtifacts` now returns a paged envelope so the MCP `list_files`
    // tool can walk it with a stable cursor. This route's wire shape is
    // unchanged on purpose — existing web clients read `{ artifacts }` — so it
    // reads `.items` and keeps sending exactly that.
    const page = await listUserArtifacts(user.id, query.kind, {
      plannerSessionId: query.plannerSessionId,
      bountyId: query.bountyId,
    });
    return reply.send({ artifacts: page.items.map(serializeArtifact) });
  });

  // DELETE /v1/artifacts/:id — SOFT delete (owner, or admin/member).
  //
  // This route did not exist. `apps/web/lib/api-artifacts.ts`
  // `deleteArtifact()` has always called it and returns `res.ok`, which every
  // caller ignores — so the sponsor-facing "remove" control on a reference
  // sample 404'd and reported nothing. Combined with the max-3 cap that
  // `sampleSlotError` now really enforces (409 SAMPLE_LIMIT_REACHED, verified
  // live), a sponsor was permanently pinned to the first three files they
  // uploaded — including a byte-less `pending_upload` row from a transfer that
  // failed, which occupies a slot while its token is live. Removal is the
  // documented escape hatch for exactly that, so without this route the cap
  // was a trap rather than a bound.
  //
  // Ported from v1 `databounty-api/src/routes/v1/artifacts.ts:768`, with two
  // deliberate differences:
  //  - v1's `pilotFunded`/`fullFunded` sample lock is dropped: D18 means this
  //    deployment has no funded track, so those columns are never set. The
  //    equivalent freeze here is the pool's own lifecycle
  //    (`TERMINAL_BOUNTY_STATUSES`), which is what the ADD path checks.
  //  - the scope guard is `artifact` OR `contribute`, matching this file's
  //    upload routes rather than v1's `artifact`-only. A key that may ADD a
  //    sample must be able to REMOVE one; the whole class of bug being fixed
  //    here is a one-directional sample set.
  //
  // NEVER hard-deletes: the row and its bytes stay, `status` flips to
  // `deleted` and `deletedAt` is stamped. Both, not one — the readers disagree
  // about which column they filter on (`sampleSlotError` and
  // `listUserArtifacts` test `status`; `buildSampleGate`,
  // `listDatasetRequestSamples` and `buildPublicSamples` test
  // `deletedAt IS NULL`), so stamping only one leaves a sample that is gone
  // from the cap but still counted by the gate, or vice versa. See the report
  // note about `mcp/tools.ts`, which stamps only `status` today.
  app.delete(
    "/:id",
    { preHandler: [requireAnyScope(ApiKeyScope.artifact, ApiKeyScope.contribute), requireVerifiedEmail], config: COMPLETE_RATE_LIMIT },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;

      // Every gate, the FOR UPDATE locks, the both-columns stamp and the audit
      // row live in `softDeleteArtifact` (services/artifacts.ts). Extracted
      // 2026-09-07 because the MCP `delete_file` tool had its own bare
      // `updateMany` on ownership alone: it stamped `status` without
      // `deletedAt` (leaving a sample gone from the cap but still counted by
      // the gate, and still published) and applied NO freeze gate, so it could
      // remove a sample from an approved or minted request that this route
      // refuses with 409. Two copies of a rule is how that happened; one is
      // the fix.
      const isStaff = user.roles.some((r) => r === "admin" || r === "member");
      try {
        await softDeleteArtifact({
          artifactId: id,
          actorUserId: user.id,
          isStaff,
          audit: { ip: req.ip, userAgent: req.headers["user-agent"], requestId: req.id },
        });
      } catch (error) {
        if (error instanceof ArtifactUploadValidationError) return sendUploadValidationError(reply, error);
        throw error;
      }

      // Storage bytes are deliberately LEFT in place. The row is evidence: a
      // sample that was reviewed, or a submission attachment referenced by a
      // validation record, must still be resolvable for audit after the
      // sponsor removes it from their working set. Byte reclamation is a
      // retention job, not a side effect of a click.
      return reply.send({ ok: true });
    }
  );

  // POST /v1/artifacts/:id/sponsor-review — admin platform review of a
  // scan-clean sponsor reference example. Ported from v1's identically-named
  // route; distinct from malware scanning — a clean file can still be
  // off-spec and need replacement. This is the piece that was MISSING: the
  // `sponsorReviewStatus`/`sponsorReviewNote`/`sponsorReviewedAt`/
  // `sponsorReviewedBy` columns and the `approved`-gated sample-count logic
  // (`services/artifacts.ts` `sampleGateFromCounts`/`buildPublicSamples`,
  // `services/bounties.ts` `getCommunityPool`'s `approvedSponsorExamples`)
  // already existed and already READ these fields — nothing anywhere wrote
  // them, so a sponsor's uploaded examples could never leave `pending` and
  // the gate could never be satisfied. Reviews samples owned by a BOUNTY
  // (the community pool case — `SponsorReferenceManager` on `/sponsor/[id]`)
  // or a DatasetRequest (pre-mint planner samples).
  //
  // NOT ported from v1, deliberately, scope-trimmed for community:
  //  - the `pilotFunded`/`fullFunded` "locked sample set" check — moot, D18
  //    means no funded track exists here at all.
  //  - `lockSampleOwnerRow`/`requestSamplesEditable` (stage-gated re-review
  //    lock on a DatasetRequest) — community's request status machine was not
  //    re-derived here; if this turns out to matter in practice (a sponsor
  //    replacing a rejected sample after the request left an editable stage),
  //    it is a follow-up, not silently accepted risk — flagged in the
  //    decision-register entry for this change.
  app.post("/:id/sponsor-review", { preHandler: requireRole(...ADMIN_AND_MEMBER) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        decision: z.nativeEnum(SponsorExampleReviewStatus),
        note: z.string().trim().min(1).max(2000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.badRequest("decision and a note for non-approval are required");
    if (parsed.data.decision !== SponsorExampleReviewStatus.approved && !parsed.data.note) {
      return reply.badRequest("explain what the sponsor must change");
    }
    const reviewer = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;

    const current = await prisma.artifact.findUnique({
      where: { id },
      include: {
        bounty: {
          select: {
            title: true,
            requesterUserId: true,
            communityRequesterUserId: true,
            status: true,
            datasetTypeId: true,
            datasetType: { select: { sampleAssets: true } },
          },
        },
        datasetRequest: { select: { title: true, requesterUserId: true, status: true } },
      },
    });
    if (!current || current.kind !== ArtifactKind.sponsor_reference || (!current.bountyId && !current.datasetRequestId)) {
      return reply.notFound("sponsor example not found");
    }
    if (current.status !== ArtifactStatus.ready) {
      return reply.conflict("the example must clear file scanning before review");
    }
    // Found by a same-day QA audit: reproduced live that approving/rejecting
    // a sample on an already-DECLINED DatasetRequest (or a terminal Bounty)
    // succeeded and fired a real sponsor notification for a request/pool that
    // was already dead. A review decision on a sample nobody can act on any
    // more is a dead-end write, not a legitimate action.
    if (current.datasetRequest && current.datasetRequest.status === DatasetRequestStatus.declined) {
      return reply.conflict("this request was declined — no further review is meaningful");
    }
    if (
      current.bounty &&
      (current.bounty.status === BountyStatus.cancelled ||
        current.bounty.status === BountyStatus.completed ||
        current.bounty.status === BountyStatus.partially_completed)
    ) {
      return reply.conflict(`this pool is ${current.bounty.status} — no further review is meaningful`);
    }

    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.artifact.update({
        where: { id },
        data: {
          sponsorReviewStatus: parsed.data.decision,
          sponsorReviewNote: parsed.data.note ?? null,
          sponsorReviewedAt: new Date(),
          sponsorReviewedBy: reviewer.id,
        },
      });
      // The far more common path for populating DatasetType.sampleAssets: a
      // sponsor attaches a new reference sample directly to an ALREADY-LIVE
      // bounty (apps/web/components/dataset-request-detail.tsx-style
      // post-mint attachment) — the live DB shows 153 of 154 approved
      // sponsor_reference samples arrived this way, versus 1 the pre-mint
      // way admin-community.ts's mint route handles. Same missing-copy bug,
      // same fix, just triggered from approval instead of mint (there is no
      // "mint" moment here — the bounty already exists, so approval IS the
      // moment a sample becomes known-final).
      if (
        updated.sponsorReviewStatus === SponsorExampleReviewStatus.approved &&
        current.bounty?.datasetTypeId &&
        (await safeToWriteSampleAssetsFor(tx, current.bounty.datasetTypeId, current.bountyId!, current.bounty.datasetType?.sampleAssets))
      ) {
        const sampleAssets = await buildApprovedSampleAssets(tx, { bountyId: current.bountyId! });
        if (sampleAssets.length > 0) {
          await tx.datasetType.update({ where: { id: current.bounty.datasetTypeId }, data: { sampleAssets } });
        }
      }

      await writeAuditLog(tx, {
        actorUserId: reviewer.id,
        action: "sponsor_example.reviewed",
        targetType: "Artifact",
        targetId: id,
        before: { sponsorReviewStatus: current.sponsorReviewStatus, sponsorReviewNote: current.sponsorReviewNote },
        after: { sponsorReviewStatus: updated.sponsorReviewStatus, sponsorReviewNote: updated.sponsorReviewNote },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.id,
      });
      // Two events, not one with a switched entityId: the deep link has to
      // resolve to something the sponsor can actually open.
      if (current.bounty) {
        await notifyEvent(tx, "sponsor.example_reviewed", {
          userId: current.bounty.communityRequesterUserId ?? current.bounty.requesterUserId,
          entityId: current.bountyId!,
          keySuffix: `${id}:${updated.sponsorReviewStatus}`,
          data: { bounty: current.bounty.title, filename: current.filename, decision: updated.sponsorReviewStatus ?? "pending" },
        });
      } else if (current.datasetRequest) {
        await notifyEvent(tx, "sponsor.request_example_reviewed", {
          userId: current.datasetRequest.requesterUserId,
          entityId: current.datasetRequestId!,
          keySuffix: `${id}:${updated.sponsorReviewStatus}`,
          data: { request: current.datasetRequest.title, filename: current.filename, decision: updated.sponsorReviewStatus ?? "pending" },
        });
      }
      return updated;
    });

    return reply.send({ artifact: serializeArtifact(row) });
  });
}
