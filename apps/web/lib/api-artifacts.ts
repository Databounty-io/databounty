// SPDX-License-Identifier: Apache-2.0

/**
 * Typed client for the shared artifact/file system on databounty-api
 * (`/v1/artifacts`). Handles sponsor reference samples, submission attachments,
 * and bulk sources — any file type, uploaded direct to the API and served back
 * for inline viewing or download. See databounty-api STORAGE_AND_ARTIFACTS_PLAN.
 */
import { authedFetch } from "@/lib/store";
import { API } from "@/lib/api-endpoints";
import { API_URL } from "@/lib/urls";
import { draftAuthHeaders } from "./upload-draft-session";

/**
 * Read a positive-integer tuning knob out of the build-time environment.
 *
 * `Number(process.env.X ?? default)` is NOT safe here, and got this wrong in
 * production: `??` only fires on null/undefined, but a Dockerfile that declares
 * `ARG X=` and then `ENV X=$X` sets the variable to the EMPTY STRING, which
 * `Number("")` turns into `0`. Every limit below then became 0, and because the
 * server route these are a fallback for was missing, `uploadArtifact` rejected
 * every non-empty file with "the maximum allowed size is 0 GB/0 MB" before it
 * ever made a network call. An unset, empty, blank, zero, negative or
 * unparseable value must all mean "use the default".
 */
function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_UPLOAD_BYTES = envNumber(process.env.NEXT_PUBLIC_MAX_UPLOAD_BYTES, 100 * 1024 * 1024);
const DIRECT_UPLOAD_TIMEOUT_MS = envNumber(process.env.NEXT_PUBLIC_DIRECT_UPLOAD_TIMEOUT_MS, 16 * 60 * 1000);
// Files at/above the server's threshold upload to object storage in parts, in
// parallel, resumably; each part is hashed on its own (bounded memory), so a
// multi-GB file never enters RAM whole. The sizes themselves come from
// uploadLimits() below — the server rejects a non-final part whose size differs
// by a byte, so they must not be guessed here.
const MULTIPART_PART_CONCURRENCY = envNumber(process.env.NEXT_PUBLIC_MULTIPART_PART_CONCURRENCY, 4);

/**
 * Upload limits, asked of the server rather than mirrored.
 *
 * These four numbers have to agree with the API exactly — it rejects a
 * non-final part whose size differs by a byte, and it refuses a single-request
 * upload at or above the multipart threshold. They used to live here as
 * NEXT_PUBLIC_* constants duplicating the server's STORAGE_* config, which
 * meant any operator who tuned one side produced a client that builds a
 * perfectly-formed request the server then rejects on arithmetic — the hardest
 * kind of failure to read from a UI.
 *
 * Fetched once per page load and cached. The env values remain the fallback
 * for the offline/failed-fetch case: falling back keeps uploads working, and
 * the server is still the authority that validates every request.
 */
interface UploadLimits {
  maxUploadBytes: number;
  multipartThresholdBytes: number;
  multipartPartSizeBytes: number;
  maxMultipartUploadBytes: number;
}

const FALLBACK_LIMITS: UploadLimits = {
  maxUploadBytes: MAX_UPLOAD_BYTES,
  multipartThresholdBytes: envNumber(process.env.NEXT_PUBLIC_MULTIPART_THRESHOLD_BYTES, 100 * 1024 * 1024),
  multipartPartSizeBytes: envNumber(process.env.NEXT_PUBLIC_MULTIPART_PART_SIZE_BYTES, 16 * 1024 * 1024),
  maxMultipartUploadBytes: envNumber(process.env.NEXT_PUBLIC_MAX_MULTIPART_UPLOAD_BYTES, 5 * 1024 * 1024 * 1024),
};

let limitsPromise: Promise<UploadLimits> | null = null;

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export async function uploadLimits(): Promise<UploadLimits> {
  limitsPromise ??= (async () => {
    try {
      const res = await fetch(`${API_URL}${API.meta.uploadLimits}`);
      if (!res.ok) return FALLBACK_LIMITS;
      const body = (await res.json()) as Partial<UploadLimits>;
      // Take each field only when the server actually sent a usable number;
      // a partial or malformed response must not zero out a limit.
      return {
        maxUploadBytes: isPositive(body.maxUploadBytes) ? body.maxUploadBytes : FALLBACK_LIMITS.maxUploadBytes,
        multipartThresholdBytes: isPositive(body.multipartThresholdBytes) ? body.multipartThresholdBytes : FALLBACK_LIMITS.multipartThresholdBytes,
        multipartPartSizeBytes: isPositive(body.multipartPartSizeBytes) ? body.multipartPartSizeBytes : FALLBACK_LIMITS.multipartPartSizeBytes,
        maxMultipartUploadBytes: isPositive(body.maxMultipartUploadBytes) ? body.maxMultipartUploadBytes : FALLBACK_LIMITS.maxMultipartUploadBytes,
      };
    } catch {
      return FALLBACK_LIMITS;
    }
  })();
  return limitsPromise;
}

export type ArtifactKind =
  | "sponsor_reference"
  | "submission_attachment"
  | "bulk_submission_source"
  | "validation_log"
  | "validation_report"
  | "export_bundle"
  | "public_sample";

export interface ApiArtifact {
  id: string;
  kind: ArtifactKind;
  visibility: string;
  status: string;
  /** Malware/magic-byte scan verdict. `status: "ready"` covers bytes + this
   *  scan ONLY, never the modality-specific parse/preview/similarity checks —
   *  see serializeArtifact() in api/src/routes/v1/artifacts.ts. Rendering
   *  "ready" as "all checks passed" would be a claim the server never made. */
  scanStatus?: string | null;
  /** Modality the server detected and routed the file through, or null when it
   *  has not been classified yet. Not a claim that any check passed. */
  modality?: string | null;
  /** MIME type sniffed from the bytes, which can differ from `contentType`
   *  (what the uploader declared). A mismatch is what the gate exists for. */
  detectedMimeType?: string | null;
  parserVersion?: string | null;
  sponsorReviewStatus?: "pending" | "approved" | "needs_changes" | "rejected" | null;
  sponsorReviewNote?: string | null;
  sponsorReviewedAt?: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  submissionId?: string | null;
  /** Pre-mint owner of a `sponsor_reference` sample: the planner draft it was
   *  attached to. Lets a resumed draft list its own samples back. */
  plannerSessionId?: string | null;
  createdAt: string;
  /** API-relative path to the bytes; prefix with API_URL to fetch/view. */
  downloadUrl: string;
}

/** One stage's latest format-registry evidence for an artifact (see
 * databounty-docs/engineering/FORMAT_REGISTRY_AND_MULTIMODAL_PIPELINE_PLAN.md
 * §5). `status` is one of the backend's honest states — `missing` (no check
 * has ever run for this stage) and `stale` (the last run used an older
 * handler version than the one currently registered) are derived at read
 * time, never a silent omission or a fabricated pass. */
export interface ArtifactProcessingEvent {
  /** Mirrors PROCESSING_STAGES in api/src/routes/v1/artifacts.ts. The two
   *  `sponsor_sample_*` stages are the LLM contract review and cross-sample
   *  similarity run on a sponsor's own reference samples — the checks that
   *  decide whether a sample counts towards the go-live gate. */
  stage:
    | "parse"
    | "preview"
    | "similarity_check"
    | "sponsor_sample_llm_review"
    | "sponsor_sample_similarity";
  status: "passed" | "failed" | "not_supported" | "pending" | "stale" | "missing";
  handlerVersion: string | null;
  detail: unknown;
  createdAt: string | null;
}

export interface ArtifactProcessingEventsResponse {
  modality: string | null;
  currentHandlerVersion: string;
  events: ArtifactProcessingEvent[];
}

/** Per-stage modality-check evidence for one artifact
 * (GET /v1/artifacts/:id/processing-events). Returns `null` on any failure
 * so callers render an honest "couldn't load" state instead of pretending
 * nothing was checked. */
export async function getArtifactProcessingEvents(id: string): Promise<ArtifactProcessingEventsResponse | null> {
  const res = await authedFetch(API.artifacts.processingEvents(id));
  if (!res.ok) return null;
  return (await res.json()) as ArtifactProcessingEventsResponse;
}

export interface DirectUploadTarget {
  mode: "form_post" | "put";
  method: "POST" | "PUT";
  url: string;
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  /** The direct-storage capability expires at this server-provided time. */
  expiresAt: string;
}

interface ApiErrorBody {
  code?: string;
  message?: string;
}

// Fastify's built-in 404 handler writes messages of the exact shape
// "Route POST:/v1/foo/bar not found" whenever a route genuinely doesn't
// exist server-side — a routing implementation detail, never something a
// real handler would phrase that way. Trusting it blindly meant a missing
// backend route displayed that raw string to the user instead of the
// caller's own HTTP-status fallback. A handler's own
// `reply.notFound("...")`-style message never matches this pattern, so it
// still passes through untouched.
const FASTIFY_ROUTE_NOT_FOUND = /^Route (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):.* not found$/;
function safe(error: ApiErrorBody | null): string | undefined {
  const message = error?.message;
  return message && !FASTIFY_ROUTE_NOT_FOUND.test(message) ? message : undefined;
}

export type ArtifactUploadErrorHandler = (message: string) => void;

/** Absolute, credentialed URL for viewing/downloading an artifact's bytes. */
export function artifactContentUrl(a: Pick<ApiArtifact, "downloadUrl">): string {
  return `${API_URL}${a.downloadUrl}`;
}

interface UploadTarget {
  kind: Extract<ArtifactKind, "sponsor_reference" | "submission_attachment" | "bulk_submission_source">;
  bountyId?: string;
  submissionId?: string;
  contributorBatchId?: string;
  // Pre-mint owners for `sponsor_reference` samples. A community sample is
  // collected in the planner before any bounty (or even any request) exists,
  // so it is parked on the draft session and carried forward by the server:
  // plannerSession -> datasetRequest -> bounty.
  plannerSessionId?: string;
  datasetRequestId?: string;
  /**
   * `bulk_submission_source` only. `false` = "keep this file as the source of
   * record"; the rows were already posted item-by-item. Omitting it means the
   * server ingests the file into items — which, for the bulk flow's archive
   * copy, re-created every row that had just been submitted, consuming batch
   * capacity and surfacing the duplicates to the contributor as rejected work.
   */
  ingest?: boolean;
}

export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 (hex) of one Blob slice. Only this slice's bytes enter memory — the
 * whole file never does — which is what lets multipart upload arbitrarily large
 * files without the single-shot path's whole-file `arrayBuffer()` blow-up. */
async function sha256HexOfBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface MultipartPartTarget {
  partNumber: number;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}
interface MultipartPlan {
  uploadId: string;
  parts: MultipartPartTarget[];
  expiresAt: string;
}

/** Upload one part with bounded retries. Returns the S3 ETag needed to
 * assemble the object. The per-part checksum header is signed into the URL, so
 * storage rejects tampered bytes with a 4xx we surface rather than retry. */
async function uploadOnePart(target: MultipartPartTarget, body: Blob): Promise<{ partNumber: number; etag: string }> {
  let lastStatus = 0;
  let blockedBeforeResponse = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(target.url, {
        method: target.method,
        headers: target.headers,
        body,
        signal: AbortSignal.timeout(DIRECT_UPLOAD_TIMEOUT_MS),
      });
      if (res.ok) {
        const etag = res.headers.get("ETag") ?? res.headers.get("etag");
        if (!etag) throw new Error("storage did not return an ETag for the part (check bucket CORS ExposeHeaders: ETag)");
        return { partNumber: target.partNumber, etag };
      }
      lastStatus = res.status;
      // A 4xx is a rejected part (checksum/policy) — retrying won't help.
      if (res.status >= 400 && res.status < 500) break;
    } catch {
      // Network/timeout — fall through to retry with backoff. A blocked CORS
      // preflight also lands here (fetch rejects with an opaque TypeError and
      // no status), which is why the no-status case gets its own message below.
      blockedBeforeResponse = true;
    }
    await sleep(500 * (attempt + 1));
  }
  // No status on any attempt means the request never got a response at all.
  // For a signed part PUT that is nearly always bucket CORS (missing PUT in
  // AllowedMethods, or no CORS configuration), which otherwise reads as a
  // generic "upload failed" and sends people hunting through app code.
  if (!lastStatus && blockedBeforeResponse) {
    throw new Error(
      `part ${target.partNumber} never reached storage — the browser blocked it before any response. This is usually the storage bucket's CORS rules (they must allow PUT from this site and expose ETag).`
    );
  }
  throw new Error(`part ${target.partNumber} failed to upload${lastStatus ? ` (HTTP ${lastStatus})` : ""}`);
}

/** Drive an N-part multipart upload: hash+PUT parts with bounded concurrency,
 * then complete. The server already authorized the target and bound each
 * part's checksum when it issued the plan. */
async function uploadViaMultipart(file: File, target: UploadTarget, partSizeBytes: number, onError?: ArtifactUploadErrorHandler): Promise<ApiArtifact | null> {
  const fail = (message: string) => {
    onError?.(message);
    return null;
  };

  // 1. Slice + per-part hash (bounded memory).
  const partCount = Math.ceil(file.size / partSizeBytes);
  const slices: Blob[] = [];
  const declaredParts: { partNumber: number; sizeBytes: number; checksumSha256Hex: string }[] = [];
  for (let i = 0; i < partCount; i += 1) {
    const start = i * partSizeBytes;
    const blob = file.slice(start, Math.min(start + partSizeBytes, file.size));
    slices.push(blob);
    declaredParts.push({ partNumber: i + 1, sizeBytes: blob.size, checksumSha256Hex: await sha256HexOfBlob(blob) });
  }

  // 2. Open the multipart slot (server authorizes + returns per-part URLs).
  const slotRes = await authedFetch(API.artifacts.multipartSlot, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...target, filename: file.name, contentType: file.type || "application/octet-stream", totalSizeBytes: file.size, parts: declaredParts }),
  });
  if (!slotRes.ok) {
    const error = (await slotRes.json().catch(() => null)) as ApiErrorBody | null;
    // No multipart driver (local dev) → fall back to the backend-proxied upload.
    if (slotRes.status === 409 && error?.code === "MULTIPART_UPLOAD_UNSUPPORTED") return uploadMultipart(file, target, onError);
    return fail(safe(error) ?? `The large-file upload could not be started (HTTP ${slotRes.status}).`);
  }
  const slot = (await slotRes.json()) as { artifact: ApiArtifact; multipart: MultipartPlan };
  if (!slot.multipart?.expiresAt || Date.parse(slot.multipart.expiresAt) <= Date.now()) return fail("The upload link expired before it could be used. Please start the upload again.");

  // 3. Upload parts with bounded concurrency; abort server-side on failure.
  const byNumber = new Map(slot.multipart.parts.map((p) => [p.partNumber, p]));
  const completed: { partNumber: number; etag: string }[] = [];
  try {
    let cursor = 0;
    const worker = async () => {
      while (cursor < declaredParts.length) {
        const index = cursor++;
        const targetPart = byNumber.get(index + 1);
        if (!targetPart) throw new Error(`missing upload target for part ${index + 1}`);
        completed.push(await uploadOnePart(targetPart, slices[index]!));
      }
    };
    await Promise.all(Array.from({ length: Math.min(MULTIPART_PART_CONCURRENCY, declaredParts.length) }, worker));
  } catch (error) {
    await authedFetch(API.artifacts.multipartAbort(slot.artifact.id), { method: "POST" }).catch(() => {});
    return fail(error instanceof Error ? error.message : "A file part failed to upload. Please try again.");
  }

  // 4. Assemble + verify (server HEAD-checks size, then queues the async scan).
  const completeRes = await authedFetch(API.artifacts.multipartComplete(slot.artifact.id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: completed }),
  });
  if (!completeRes.ok) {
    const error = (await completeRes.json().catch(() => null)) as ApiErrorBody | null;
    // Same reason as the single-shot path: an unassembled row still holds a
    // capacity slot. The parts-failure branch above already aborts (which
    // soft-deletes server-side); these two later branches did not.
    await abandonPendingArtifact(slot.artifact.id);
    return fail(safe(error) ?? `The large upload could not be finalized (HTTP ${completeRes.status}).`);
  }
  const done = (await completeRes.json()) as { artifact: ApiArtifact };
  // Object assembly and server-side HEAD/checksum verification are complete
  // now. The malware scan is deliberately asynchronous: waiting for it here
  // held the picker for up to 30 seconds per sponsor sample even though the
  // bytes had arrived. Return the live `scanning` row and let the UI refresh
  // its status in place; it must not call this file verified until `ready`.
  return done.artifact;
}

async function uploadMultipart(
  file: File,
  target: UploadTarget,
  onError?: ArtifactUploadErrorHandler
): Promise<ApiArtifact | null> {
  const params = new URLSearchParams({ kind: target.kind });
  if (target.bountyId) params.set("bountyId", target.bountyId);
  if (target.submissionId) params.set("submissionId", target.submissionId);
  if (target.contributorBatchId) params.set("contributorBatchId", target.contributorBatchId);
  // Without these the local-disk fallback would silently drop the owner and
  // create an unowned sample the carry-forward chain can never pick up.
  if (target.plannerSessionId) params.set("plannerSessionId", target.plannerSessionId);
  if (target.datasetRequestId) params.set("datasetRequestId", target.datasetRequestId);
  // Same reason: this fallback must carry the archive-vs-ingest intent too, or
  // the source file the bulk flow archives gets parsed into a second copy of
  // every item that was just submitted.
  if (target.ingest === false) params.set("ingest", "false");
  const body = new FormData();
  body.set("file", file);
  const res = await authedFetch(`${API.artifacts.list}?${params.toString()}`, { method: "POST", body });
  if (!res.ok) {
    const error = await res.json().catch(() => null) as ApiErrorBody | null;
    onError?.(safe(error) ?? `The file upload was rejected (HTTP ${res.status}).`);
    return null;
  }
  const json = (await res.json()) as { artifact: ApiArtifact };
  return json.artifact;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A slot POST creates a real `pending_upload` Artifact row BEFORE the browser
 * ever talks to object storage. If the transfer then fails, that row survives
 * with no bytes behind it — and it still counts against server-side caps (the
 * sponsor sample gate allows 3), so a few failed retries lock the owner out of
 * a limit their UI shows as unused. Soft-delete the shell on every failure
 * path so a failed upload leaves nothing behind.
 *
 * Best-effort by design: if the cleanup itself fails there is nothing more the
 * client can honestly do, and the original error is what the user needs to
 * see, so it must never mask that error.
 */
async function abandonPendingArtifact(id: string): Promise<void> {
  await deleteArtifact(id).catch(() => {});
}

/**
 * Transfer the bytes to the URL the server signed. Returns `null` on success,
 * or a user-facing explanation of the failure.
 *
 * The no-response case gets its own message on purpose. A blocked CORS
 * preflight (or a bucket with no CORS configuration at all) rejects `fetch`
 * with an opaque `TypeError: Failed to fetch` and no status, which surfaced
 * verbatim in the sponsor sample card and read as a broken app — the same
 * failure the multipart path already names in `uploadOnePart`. This is not
 * hypothetical: `databounty-stage` shipped with CORS unset and every browser
 * upload died here.
 */
/**
 * `onProgress` reports the FRACTION of bytes sent so far (0–1), not bytes
 * read/parsed — for a multi-hundred-MB file the browser can sit at 100% for
 * several seconds while the server checksums and stores it, which is honest:
 * the transfer really is done, storage-side work just isn't instant. Callers
 * that want a percentage should still show an indeterminate state once
 * `onProgress` last reported 1.
 *
 * `fetch()` cannot report upload progress at all (no request-body progress
 * event exists in the Fetch API), so this uses `XMLHttpRequest` — the only
 * upload-progress-capable read path Firefox/Safari/Chrome all support — kept
 * behind the same Promise<string | null> signature so neither caller's error
 * handling had to change.
 */
export async function transferToStorage(
  upload: DirectUploadTarget,
  file: File,
  onProgress?: (fraction: number) => void
): Promise<string | null> {
  let body: FormData | File;
  let headers: Record<string, string> | undefined;
  if (upload.mode === "form_post") {
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields ?? {})) form.set(key, value);
    form.set("file", file);
    body = form;
  } else if (upload.mode === "put") {
    body = file;
    headers = upload.headers;
  } else {
    return "The API returned an invalid upload target.";
  }
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url, true);
    xhr.timeout = DIRECT_UPLOAD_TIMEOUT_MS;
    for (const [key, value] of Object.entries(headers ?? {})) xhr.setRequestHeader(key, value);
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.total > 0 ? e.loaded / e.total : 1);
      };
    }
    xhr.onload = () => {
      onProgress?.(1);
      resolve(xhr.status >= 200 && xhr.status < 300 ? null : `The file could not be transferred (HTTP ${xhr.status}).`);
    };
    xhr.ontimeout = () =>
      resolve("The upload timed out before it reached storage. Please check your connection and try again.");
    xhr.onerror = () =>
      resolve(
        "The file never reached storage — the browser blocked it before any response. This is usually the storage bucket's CORS rules (they must allow this site's origin to upload)."
      );
    xhr.send(body);
  });
}

/**
 * Upload one file. The browser always reaches the backend first: the API
 * authenticates the caller, authorizes the bounty/submission/batch target, and
 * creates a pending Artifact row before any object-store upload can happen.
 *
 * In object-storage environments the backend returns a short-lived direct-upload target.
 * Local dev explicitly returns DIRECT_UPLOAD_UNSUPPORTED because the local
 * disk driver cannot issue direct slots, so only that case falls back to
 * backend multipart upload.
 * Returns the created artifact, or null on failure (caller shows an inline error).
 */
export async function uploadArtifact(
  file: File,
  target: UploadTarget,
  onError?: ArtifactUploadErrorHandler
): Promise<ApiArtifact | null> {
  const fail = (message: string) => {
    onError?.(message);
    return null;
  };
  if (file.size <= 0) return fail("The selected file is empty.");
  // Large objects go through multipart (parallel, resumable, per-part hashed);
  // the whole file never enters memory. Smaller files use the single-PUT slot.
  const limits = await uploadLimits();
  if (file.size >= limits.multipartThresholdBytes) {
    if (file.size > limits.maxMultipartUploadBytes) {
      return fail(`This file is too large. The maximum allowed size is ${Math.round(limits.maxMultipartUploadBytes / (1024 * 1024 * 1024))} GB.`);
    }
    try {
      return await uploadViaMultipart(file, target, limits.multipartPartSizeBytes, onError);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "The upload failed. Please try again.");
    }
  }
  if (file.size > limits.maxUploadBytes) {
    return fail(`This file is too large. The maximum allowed size is ${Math.round(limits.maxUploadBytes / (1024 * 1024))} MB.`);
  }
  try {
    const checksumSha256 = await sha256Hex(file);
    const slotRes = await authedFetch(API.artifacts.uploadSlot, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...target,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        checksumSha256,
      }),
    });

    if (!slotRes.ok) {
      const error = await slotRes.json().catch(() => null) as ApiErrorBody | null;

      // Direct upload is unavailable for the active storage driver (local dev).
      // This is the only accepted fallback: the backend still authorizes first,
      // then receives the file bytes via multipart.
      if (slotRes.status === 409 && error?.code === "DIRECT_UPLOAD_UNSUPPORTED") {
        return uploadMultipart(file, target, onError);
      }
      return fail(safe(error) ?? `The upload could not be started (HTTP ${slotRes.status}).`);
    }

    const slot = (await slotRes.json()) as { artifact: ApiArtifact; upload: DirectUploadTarget; reused?: boolean };
    // From here on an Artifact row exists, so every failure has to clean up
    // after itself or it leaves a byte-less shell holding a capacity slot.
    try {
      if (!slot.upload?.expiresAt || Date.parse(slot.upload.expiresAt) <= Date.now()) {
        await abandonPendingArtifact(slot.artifact.id);
        return fail("The upload link expired before it could be used. Please start the upload again.");
      }
      const transferError = await transferToStorage(slot.upload, file);
      if (transferError) {
        await abandonPendingArtifact(slot.artifact.id);
        return fail(transferError);
      }
      const completeRes = await authedFetch(API.artifacts.complete(slot.artifact.id), { method: "POST" });
      if (!completeRes.ok) {
        const error = await completeRes.json().catch(() => null) as ApiErrorBody | null;
        await abandonPendingArtifact(slot.artifact.id);
        return fail(safe(error) ?? `The upload could not be finalized (HTTP ${completeRes.status}).`);
      }
      const completed = (await completeRes.json()) as { artifact: ApiArtifact };
      // Completion proves object storage has the exact bytes. Scanning is a
      // separate job and is represented by `completed.artifact.status`; do not
      // freeze the picker while that job waits for capacity or retries.
      return completed.artifact;
    } catch (error) {
      await abandonPendingArtifact(slot.artifact.id);
      throw error;
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The upload failed. Please try again.");
  }
}

/** List a bounty's artifacts the caller may see, optionally filtered by kind. */
export async function listBountyArtifacts(bountyId: string, kind?: ArtifactKind): Promise<ApiArtifact[]> {
  const params = new URLSearchParams({ bountyId });
  if (kind) params.set("kind", kind);
  const res = await authedFetch(`${API.artifacts.list}?${params.toString()}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { artifacts: ApiArtifact[] };
  return json.artifacts ?? [];
}

/**
 * True once an artifact's bytes have actually been stored — `scanning` counts
 * (the file arrived; only the async scan is outstanding), `pending_upload`
 * does not (a slot was issued and nothing followed).
 *
 * The sample gate is a count of attached samples, so this distinction is the
 * difference between an honest count and a false one. Without it, a slot
 * issued for an upload that then failed reads back as an attached sample: the
 * planner showed "2 attached · min 2" and let the sponsor continue to review
 * with two empty shells behind the brief contributors build against.
 */
export function artifactHasBytes(a: Pick<ApiArtifact, "status">): boolean {
  return a.status === "ready" || a.status === "scanning";
}

export type ArtifactScanState = { text: string; tone: "pending" | "ready" | "danger" };

/**
 * How one artifact's SCAN state reads to a person — the single wording for the
 * three surfaces that show stored files (planner, request panel, artifact row).
 *
 * `ready` deliberately gets text of its own. Scanning is asynchronous, so the
 * state that matters most resolves minutes after the sponsor last touched
 * anything, arriving through `useArtifactStatusPolling`. Both sample surfaces
 * used to render the in-progress and quarantined lines only, which meant a
 * passing scan removed the line and put nothing in its place: no confirmation
 * on screen, and — because a removal is not an announcement — nothing at all
 * for a screen reader. The whole point of scanning in the background is that it
 * finishes later, so finishing has to be the thing that is said out loud.
 *
 * `scanStatus` is the artifact's real scan VERDICT and is required to render
 * this honestly: the lifecycle `status` alone cannot distinguish a file that
 * passed a scan from one that was never scanned, because `not_required`
 * clears an artifact to `ready` exactly like `clean` does. Callers should
 * always pass it; it is optional only so an un-migrated call site fails
 * toward "state unknown" rather than toward a fabricated pass.
 *
 * Returns `null` for states these surfaces do not narrate (`pending_upload`,
 * `deleted`); both are filtered out before render by `listSampleArtifacts`.
 */
export function scanStatusState(status: string, scanStatus?: string | null): ArtifactScanState | null {
  if (status === "scanning") {
    // SEC-08: `malware_scan.enabled` ON with no ARTIFACT_SCAN_URL records
    // `error` and parks the row here, undownloadable. That is not "in
    // progress" — nothing is coming — so it must not read as though it were.
    if (scanStatus === "error") {
      return { text: "Security scan could not complete · this file is not verified", tone: "pending" };
    }
    return { text: "File stored · security scan in progress", tone: "pending" };
  }
  if (status === "quarantined") {
    // Distinguish the two quarantine causes the schema deliberately keeps
    // apart: a dishonest declaration is not a malware verdict.
    if (scanStatus === "content_mismatch") {
      return { text: "File contents do not match the declared file type. Remove it or upload a replacement.", tone: "danger" };
    }
    return { text: "Security verification held this file. Remove it or upload a replacement.", tone: "danger" };
  }
  if (status === "ready") {
    // Only a real `clean` verdict may claim a pass.
    if (scanStatus === "clean") return { text: "Stored", tone: "ready" };
    // Owner decision 2026-09-07: the sponsor sees only "Stored" — no scan
    // wording at all, in either direction.
    //
    // This is NOT a regression of the honesty invariant (AGENTS.md §3), which
    // bars presenting a missing/skipped/unconfigured check AS PASSED. Saying
    // nothing about scanning makes no claim, so there is nothing to falsify;
    // the earlier "Security scan passed" on an unscanned file did make one,
    // which is what was wrong. `not_required` is the default state everywhere
    // (`artifacts.malware_scan.enabled` is off by default in every
    // environment, production included — owner decision 2026-09-05, and an
    // absent row reads as off), so this branch is the common case.
    //
    // The real verdict is NOT hidden from operators, which is what keeps this
    // honest: the admin console renders each artifact's true `scanStatus`
    // (clean / not required / error / infected) in apps/admin's artifacts
    // page, and `artifacts.malware_scan.enabled` is a catalogued admin setting
    // visible with its full description on the admin settings page.
    //
    // A pass keeps `tone: "ready"` so the row still reads as settled rather
    // than pending. Quarantine and in-progress states below are unchanged:
    // both are actionable for the sponsor, not platform configuration detail.
    if (scanStatus === "not_required") return { text: "Stored", tone: "ready" };
    // Any other value (including a `scanStatus` the caller did not pass):
    // say what is actually known rather than inventing a verdict.
    return { text: "Stored", tone: "ready" };
  }
  return null;
}

/**
 * Whether a sample still occupies one of the `sampleGate.max` slots. Mirrors
 * `sampleSlotError()` in the API (services/sponsor-samples.ts), and must keep
 * mirroring it: this decides whether the UI offers an upload control at all.
 *
 * A `rejected` sample does NOT occupy a slot, so the sponsor can upload the
 * replacement directly. Counting it here — which both sample surfaces used to
 * do, via a bare `samples.length` — hid the upload control at exactly the
 * moment it was needed: at `min == max`, one rejection left the sponsor looking
 * at "1 of 3 approved · blocked" with no way to add anything, even though the
 * server would have accepted the upload. `needs_changes` still occupies its
 * slot, matching the server.
 */
export function occupiesSampleSlot(a: Pick<ApiArtifact, "status" | "sponsorReviewStatus">): boolean {
  return artifactHasBytes(a) && a.sponsorReviewStatus !== "rejected";
}

/**
 * List the sponsor reference samples parked on a pre-mint owner — a planner
 * draft or a submitted dataset request. Separate from `listBountyArtifacts`
 * because before a bounty exists there is no bountyId to filter on.
 *
 * A never-started or deleted row is filtered out: it has no useful sponsor
 * action. A quarantined row is deliberately retained. It has reached storage
 * but failed a security check, and hiding it after an asynchronous refresh
 * would make a just-uploaded sample appear to vanish with no explanation.
 * `occupiesSampleSlot()` still excludes it, so it cannot strand the sponsor
 * against the cap and they may upload a replacement.
 */
export async function listSampleArtifacts(
  owner: { plannerSessionId: string } | { datasetRequestId: string }
): Promise<ApiArtifact[]> {
  const params = new URLSearchParams(
    "plannerSessionId" in owner
      ? { plannerSessionId: owner.plannerSessionId }
      : { datasetRequestId: owner.datasetRequestId }
  );
  const res = await authedFetch(`${API.artifacts.list}?${params.toString()}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { artifacts: ApiArtifact[] };
  return (json.artifacts ?? []).filter((artifact) => artifact.status !== "pending_upload" && artifact.status !== "deleted");
}

/**
 * The `sponsor_reference` samples attached to one planner draft.
 *
 * Scoped server-side by `plannerSessionId` (not filtered here) so a sponsor
 * with more than a page of artifacts cannot have this draft's samples fall off
 * the end and read as "none attached". The API scopes the same query to the
 * caller, so another user's session id returns an empty list, never their
 * files. Returns [] on any failure — a resumed draft that cannot list its
 * samples must fall back to "re-attach them", never to a fabricated count.
 *
 * Filters the two non-actionable lifecycle states exactly as
 * `listSampleArtifacts` does. That matters now this is also the SCAN-POLL
 * refresh, not just the mount read: without it a poll landing after a removal
 * would re-add the soft-deleted row (`status: "deleted"`, which
 * `scanStatusState` narrates as nothing at all), so a sample the sponsor had
 * just removed would reappear with a blank status line. A quarantined row is
 * deliberately kept — see `listSampleArtifacts`.
 */
export async function listPlannerSessionSamples(plannerSessionId: string): Promise<ApiArtifact[]> {
  try {
    const qs = new URLSearchParams({ kind: "sponsor_reference", plannerSessionId });
    const res = await authedFetch(`${API.artifacts.list}?${qs.toString()}`);
    if (!res.ok) return [];
    const body = (await res.json()) as { artifacts?: ApiArtifact[] };
    if (!Array.isArray(body.artifacts)) return [];
    return body.artifacts.filter((a) => a.status !== "pending_upload" && a.status !== "deleted");
  } catch {
    return [];
  }
}

/** Soft-delete an artifact (owner or admin). */
export async function deleteArtifact(id: string): Promise<boolean> {
  const res = await authedFetch(API.artifacts.one(id), { method: "DELETE" });
  return res.ok;
}

/**
 * Upload a bulk-source file for a browser-review draft WITHOUT a dashboard
 * session, using the draft-scoped capability minted at handoff redemption.
 *
 * Deliberately separate from uploadArtifact(): that path calls
 * /v1/artifacts/upload-slot, which requires a real credential with the
 * `artifact` scope. Here the slot is issued by the draft itself, which pins
 * owner, kind and target server-side — the token holder supplies only bytes,
 * never a destination. Completion attaches the file to the draft in the same
 * call, so the browser can never end up with a finished upload and an empty
 * review.
 */
export async function uploadDraftSource(
  draftId: string,
  file: File,
  onError?: ArtifactUploadErrorHandler,
  onProgress?: (fraction: number) => void
): Promise<boolean> {
  const fail = (message: string) => {
    onError?.(message);
    return false;
  };
  if (file.size <= 0) return fail("The selected file is empty.");
  const limits = await uploadLimits();
  if (file.size >= limits.multipartThresholdBytes) {
    // Multipart needs per-part slots this draft route does not issue. Say so
    // plainly rather than starting an upload that cannot finish.
    return fail(
      `This file is too large for browser review (limit ${Math.round(limits.multipartThresholdBytes / (1024 * 1024))} MB). Split it into smaller files and review them one at a time.`
    );
  }
  if (file.size > limits.maxUploadBytes) {
    return fail(`This file is too large. The maximum allowed size is ${Math.round(limits.maxUploadBytes / (1024 * 1024))} MB.`);
  }
  try {
    const checksumSha256 = await sha256Hex(file);
    const slotRes = await authedFetch(API.uploadReviewDrafts.sourceSlot(draftId), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...draftAuthHeaders(draftId) },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        checksumSha256,
      }),
    });
    if (!slotRes.ok) {
      const error = (await slotRes.json().catch(() => null)) as ApiErrorBody | null;
      return fail(safe(error) ?? `The upload could not be started (HTTP ${slotRes.status}).`);
    }
    const slot = (await slotRes.json()) as { artifactId: string; upload: DirectUploadTarget };
    if (!slot.upload?.expiresAt || Date.parse(slot.upload.expiresAt) <= Date.now()) {
      return fail("The upload link expired before it could be used. Please choose the file again.");
    }
    const transferError = await transferToStorage(slot.upload, file, onProgress);
    if (transferError) return fail(transferError);
    const completeRes = await authedFetch(API.uploadReviewDrafts.sourceComplete(draftId), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...draftAuthHeaders(draftId) },
      body: JSON.stringify({ artifactId: slot.artifactId }),
    });
    if (!completeRes.ok) {
      const error = (await completeRes.json().catch(() => null)) as ApiErrorBody | null;
      return fail(safe(error) ?? `The upload could not be finalized (HTTP ${completeRes.status}).`);
    }
    return true;
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The upload failed. Please try again.");
  }
}
