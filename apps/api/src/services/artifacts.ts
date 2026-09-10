// SPDX-License-Identifier: Apache-2.0

import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  ArtifactKind,
  ArtifactStatus,
  ArtifactVisibility,
  ArtifactScanStatus,
  SponsorExampleReviewStatus,
  BountyKind,
  BountyStatus,
  DatasetRequestStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decodeDateCursor, encodeCursor, filterKeyOf, takePage } from "../lib/keyset-cursor.js";
import { dbJobQueue } from "./jobs.js";
import { config } from "../config.js";
import { getArtifactData, putArtifactData, headArtifactData, removeArtifactData } from "./storage.js";
import { storage, hasDirectUpload, hasMultipartUpload, planMultipartParts } from "../lib/storage/index.js";
import type { DirectUploadTarget, MultipartCompletedPart, MultipartPartDeclaration, MultipartUploadPlan } from "../lib/storage/types.js";
import { writeAuditLog } from "../lib/audit-log.js";
import { checkMagicBytesFromBuffer, mimeForDetectedKind } from "../lib/magic-bytes.js";
import { modalityForContentType, resolveHandler } from "./format-registry/registry.js";
import { DEFAULT_HANDLER } from "./format-registry/default-handler.js";
import {
  DECLARATION_GOVERNED_KINDS,
  MAX_ARCHIVE_UPLOAD_BYTES,
  archiveSizeExceedsLimit,
  normalizeDeclaredContentType,
  validateArtifactDeclaration,
} from "../lib/artifact-upload-declaration.js";

/**
 * Lifetime of one upload slot. Was a hardcoded 1 hour; now read from config
 * (`STORAGE_DIRECT_UPLOAD_EXPIRES_SECONDS`, default 900s, bounded 60-3600s) so
 * an operator can tune it without a deploy, matching v1 `config.ts:381-386`.
 * Read through a function, not a module-level constant, so a test that
 * overrides the env before importing config still sees its own value.
 */
function uploadSlotTtlMs(): number {
  return config.storage.directUploadExpiresSeconds * 1000;
}

/**
 * Admin-configurable tolerance added to `uploadExpiresAt` before a slot counts
 * as lapsed. Same setting key and same code default (0) as the purge worker's
 * own `getArtifactUploadGraceMs` (`services/jobs/artifact-jobs.ts`).
 *
 * Duplicated here rather than imported to avoid a service <-> jobs import
 * cycle (`jobs/artifact-jobs.ts` already imports from this module). The two
 * MUST agree: before this, only the worker applied the grace, so completion
 * refused slots the worker was still willing to tolerate — a window in which
 * an upload that landed inside the operator-granted grace could neither be
 * completed nor purged, and simply became an orphan.
 */
async function artifactUploadGraceMs(): Promise<number> {
  const row = await prisma.adminSetting.findUnique({ where: { key: "artifacts.upload.grace_seconds" } });
  const value = row?.value as unknown;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value * 1000 : 0;
}

/** True when this slot's window (plus any operator-granted grace) has closed. */
function slotHasLapsed(uploadExpiresAt: Date | null, graceMs: number): boolean {
  if (!uploadExpiresAt) return true;
  return uploadExpiresAt.getTime() + graceMs <= Date.now();
}

/**
 * Capability token embedded in the slot's `uploadUrl`, so that
 * POST /v1/artifacts/:id/content can authorize the byte transfer.
 *
 * Why this exists: the browser transfers the file with a bare `fetch()` that
 * carries no session cookie (apps/web `transferToStorage()` deliberately omits
 * `credentials`, because in the real product this URL points at S3, not at
 * this API). Gating the content route on a credential alone would therefore
 * close the hole by breaking every dashboard upload. This mirrors what a
 * presigned S3 URL does: the slot issuer signs a target, and the holder of
 * that signature may write those exact bytes and nothing else.
 *
 * The signature is derived, never stored — no schema change — and is bound to
 * the artifact id, its owner, and the slot's own expiry, so it cannot be
 * replayed against a different artifact or after the slot lapses. It is
 * additionally only accepted while the artifact is still `pending_upload`, so
 * a completed upload can never be silently overwritten with it.
 */
const UPLOAD_TOKEN_VERSION = "v1";

function uploadTokenFor(artifact: {
  id: string;
  ownerUserId: string | null;
  storageKey: string;
  uploadExpiresAt: Date | null;
}): string {
  return createHmac("sha256", config.sessionSecret)
    .update(
      [
        UPLOAD_TOKEN_VERSION,
        artifact.id,
        artifact.ownerUserId ?? "",
        artifact.storageKey,
        artifact.uploadExpiresAt?.toISOString() ?? "",
      ].join(".")
    )
    .digest("hex");
}

/** Fail-closed check for the slot capability token. Any missing/short/expired/
 *  already-uploaded case returns false rather than throwing. */
export function verifyUploadToken(
  artifact: { id: string; ownerUserId: string | null; storageKey: string; uploadExpiresAt: Date | null; status: ArtifactStatus },
  presented: unknown
): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  if (artifact.status !== ArtifactStatus.pending_upload) return false;
  if (!artifact.uploadExpiresAt || artifact.uploadExpiresAt.getTime() <= Date.now()) return false;
  const expected = Buffer.from(uploadTokenFor(artifact), "utf8");
  const got = Buffer.from(presented, "utf8");
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

/** Minimal shape of a reader for {@link canReadArtifact} — id plus roles. */
export interface ArtifactReader {
  id: string;
  roles?: string[];
}

/**
 * Who may read one artifact's metadata and bytes. Ported from the funded
 * product's `canReadArtifact` (v1 databounty-api services/artifacts.ts) so the
 * two products answer this question the same way, and adapted to the two
 * places this schema differs (see the audit-window note below).
 *
 * Fail-closed by construction: every branch that cannot positively establish a
 * relationship falls through to `false`.
 */
export async function canReadArtifact(
  artifact: {
    id: string;
    kind: ArtifactKind;
    visibility: ArtifactVisibility;
    status: ArtifactStatus;
    ownerUserId: string | null;
    bountyId: string | null;
    submissionId: string | null;
    sponsorReviewStatus: SponsorExampleReviewStatus | null;
  },
  user: ArtifactReader | null
): Promise<boolean> {
  if (artifact.status === ArtifactStatus.deleted) return false;
  // Benchmark inputs/outputs are never readable through this generic path:
  // private holdouts must stay inside the worker boundary and run output can
  // carry model traces. A dedicated, narrowly-authorized service has to be
  // added explicitly rather than weakening this default.
  if (
    artifact.kind === ArtifactKind.benchmark_manifest ||
    artifact.kind === ArtifactKind.benchmark_private_split ||
    artifact.kind === ArtifactKind.benchmark_run_output
  ) {
    return false;
  }
  // Owner and platform staff always see their own / any artifact, regardless
  // of visibility or review state. Checked BEFORE the `public_sample` gate
  // below (moved up from where they used to sit, after it) so that gate — a
  // restriction meant for everyone ELSE — can never block a sponsor from
  // seeing their own still-pending sample, or an admin from reviewing it.
  if (user) {
    if (user.roles?.some((r) => r === "admin" || r === "member" || r === "support")) return true;
    if (artifact.ownerUserId && artifact.ownerUserId === user.id) return true;
  }

  // `public_sample` is the ONLY world-readable visibility this function ever
  // grants — no auth, no ownership, nothing. Before this fix that made it a
  // free pass for ANY `kind`: `canReadArtifact` returned `true` here whenever
  // the column said `public_sample`, with no relationship to what the
  // artifact actually was. Combined with `uploadSlotBody` accepting
  // `visibility` with no tie to `kind` (routes/v1/artifacts.ts), any verified
  // member could request `public_sample` on a `submission_attachment`,
  // `bulk_submission_source`, or any other private kind and have it become an
  // anonymously downloadable public file the moment it reached `ready` —
  // unreviewed, and with none of the `sponsor_reference` admin-approval gate
  // this visibility value is SUPPOSED to require. Tracked internally as
  // "F-003"; this closes it.
  //
  // `createUploadSlot`/`createMultipartUpload` now refuse the combination at
  // write time for every kind except `sponsor_reference` (the one kind that
  // already has a real, wired admin-approval gate — `sponsorReviewStatus`,
  // the `/:id/sponsor-review` route). This is the second, independent layer:
  // even for `sponsor_reference`, `public_sample` is only honoured once the
  // SAME approval gate the `work_brief` branch below already enforces has
  // actually fired — a pending or rejected sample stays private regardless of
  // its visibility column. Every other kind is refused outright rather than
  // silently falling through to `false` by accident, so a future kind (or a
  // hand-edited row) cannot ride this shortcut to public just by carrying the
  // right visibility value. `ArtifactKind.public_sample` itself is
  // deliberately NOT allowlisted here despite its name: it has zero creation
  // call sites anywhere in this codebase, no admin-approval wiring of its
  // own, and `mcp/tools.ts`'s `MCP_UPLOAD_KINDS` comment already documents it
  // as "server-authored... never a caller's to create" (a future
  // platform-exporter-generated preview, per
  // docs/engineering/STORAGE_AND_ARTIFACTS_PLAN.md — not this).
  if (artifact.visibility === ArtifactVisibility.public_sample) {
    if (artifact.kind === ArtifactKind.sponsor_reference) {
      return artifact.status === ArtifactStatus.ready && artifact.sponsorReviewStatus === SponsorExampleReviewStatus.approved;
    }
    return false;
  }
  if (!user) return false;

  // A sponsor example is not part of the contributor/validator work brief
  // until the scanner has cleared it AND an administrator has approved it.
  if (
    artifact.kind === ArtifactKind.sponsor_reference &&
    (artifact.status !== ArtifactStatus.ready || artifact.sponsorReviewStatus !== SponsorExampleReviewStatus.approved)
  ) {
    return false;
  }

  // A validator reviewing this submission must be able to open its evidence.
  //
  // This schema has NO per-validator audit assignment to check — unlike v1's
  // AuditItem -> AuditBatch.validatorUserId, HumanAuditWindow/Membership carry
  // no validator column, and `services/audits.ts` computes eligibility live
  // instead. So the equivalent rule is that same eligibility, restated: the
  // submission is a *selected* member of a live (non-superseded) window, and
  // the reader is eligible for that window because none of its selected items
  // are their own work (`getAuditWindowById` hides such a window in full).
  //
  // Checked BEFORE the bountyId bail-out below, unlike v1, where the identical
  // rule sits after an early `if (!artifact.bountyId) return false` and is
  // therefore unreachable for a submission attachment carrying no bountyId.
  if (artifact.submissionId) {
    const membership = await prisma.humanAuditWindowMembership.findFirst({
      where: {
        submissionId: artifact.submissionId,
        selected: true,
        window: { supersededAt: null },
      },
      select: { windowId: true },
    });
    if (membership) {
      const selfAuthored = await prisma.humanAuditWindowMembership.findFirst({
        where: {
          windowId: membership.windowId,
          selected: true,
          submission: { contributorUserId: user.id },
        },
        select: { id: true },
      });
      if (!selfAuthored) return true;
    }
  }

  if (!artifact.bountyId) return false;
  const bounty = await prisma.bounty.findUnique({
    where: { id: artifact.bountyId },
    select: { requesterUserId: true, kind: true, status: true },
  });
  if (!bounty) return false;
  if (bounty.requesterUserId === user.id) return true; // sponsor owns the bounty

  if (artifact.visibility === ArtifactVisibility.work_brief) {
    // Community pools have no claim step. An approved reference file is the
    // brief every signed-in contributor works from, so requiring a prior
    // submission here would make the first contribution impossible to prepare.
    if (bounty.kind === BountyKind.community && bounty.status === BountyStatus.active) return true;
    const [batch, submission] = await Promise.all([
      prisma.contributorBatch.findFirst({
        where: { bountyId: artifact.bountyId, contributorUserId: user.id },
        select: { id: true },
      }),
      prisma.submission.findFirst({
        where: { bountyId: artifact.bountyId, contributorUserId: user.id },
        select: { id: true },
      }),
    ]);
    if (batch || submission) return true;
  }

  return false;
}

/** Thrown by the upload-slot service functions on a caller-fixable input
 * problem (missing checksum, unsupported driver, bad parts). Routes map this
 * to 400/409 with `code`; never a fabricated 500. */
export class ArtifactUploadValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    /** Explicit HTTP status when the code alone does not imply one. Upload
     * TARGET authorization (ported from v1's `authorizeArtifactUploadTarget`)
     * needs real 403/404/409 answers — "you are not the submitter" is not a
     * malformed request — so the class now carries the status instead of the
     * route re-deriving every case from a string prefix. Omitted = the route's
     * existing code-based mapping still applies, so nothing that threw before
     * changes shape. */
    public readonly status?: 400 | 403 | 404 | 409
  ) {
    super(message);
    this.name = "ArtifactUploadValidationError";
  }
}

/** Longest filename segment allowed inside a storage key. Matches v1's
 * `safeName` cap so rebuild keys stay parity-shaped, and bounds the key against a filesystem's
 * own per-component limit (255 bytes on ext4/APFS) — an unbounded display name
 * would otherwise turn into an ENAMETOOLONG at write time. */
export const STORAGE_FILENAME_MAX_LENGTH = 120;

/**
 * Reduce an untrusted display filename to ONE safe path segment for use in a
 * storage key. Fixes SEC-01: `artifacts/${kind}/${id}/${params.filename}` let
 * a verified uploader put `../` (or a leading `/`, a backslash, a Windows
 * drive prefix, a NUL byte) into the key and write outside its own artifact
 * directory, overwriting another account's bytes on the local-disk driver.
 *
 * Parity note: this is v1's `safeName`
 * plus two hardenings v1 lacked — control characters
 * are dropped rather than folded to `_`, and a leading-dot / dot-only result
 * is neutralised, because v1's version let the literal name `..` survive as a
 * whole segment and still resolve one directory up. The `_`-folding and the
 * leading-dot rule match the in-repo `sanitizePublishFilename`
 * (`services/community-publish.ts:474`).
 *
 * The returned value contains only `[A-Za-z0-9._-]`, is never empty, never
 * dot-only, and never contains a separator — so it cannot add, escape, or
 * collapse a path segment. Percent-encoded separators (`%2f`, `%2e%2e%2f`)
 * survive only as inert `_2f` / `_2e_2e_2f` text, since `%` is not in the
 * allowlist and no decoding step is applied to a key.
 *
 * This is for KEYS ONLY. The human display name is persisted verbatim in the
 * `Artifact.filename` column and is what API responses round-trip.
 */
export function safeStorageFilename(filename: string): string {
  const raw = typeof filename === "string" ? filename : "";
  // Last segment only: splitting on both separators discards `../`, a leading
  // `/`, and a `C:\dir\` Windows prefix before anything else runs.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, STORAGE_FILENAME_MAX_LENGTH);
  // A name made only of dots/underscores/dashes carries no information and
  // `.`/`..` would be traversal, so fall back to a fixed literal.
  if (cleaned === "" || /^[._-]+$/.test(cleaned)) return "file";
  return cleaned;
}

/**
 * The one place an artifact storage key is built. Every segment except the
 * trailing one comes from server-controlled values (the closed `ArtifactKind`
 * enum and the server-minted `art_<32 hex>` id), and the trailing segment goes
 * through {@link safeStorageFilename}, so the returned key is always exactly
 * `artifacts/<kind>/<artifactId>/<one safe segment>` — inside that artifact
 * id's own prefix, whatever the caller's filename was.
 */
export function buildArtifactStorageKey(params: {
  kind: ArtifactKind;
  artifactId: string;
  filename: string;
}): string {
  return `artifacts/${params.kind}/${params.artifactId}/${safeStorageFilename(params.filename)}`;
}

/** The four ids an upload slot may be bound to, as the caller declares them. */
export interface UploadTargetInput {
  bountyId?: string | null;
  submissionId?: string | null;
  contributorBatchId?: string | null;
  /** sponsor_reference only, pre-mint. Exactly one of
   * bountyId/datasetRequestId/plannerSessionId is valid for that kind
   * (schema.prisma's Artifact owner invariant). */
  datasetRequestId?: string | null;
  plannerSessionId?: string | null;
}

/** The same ids after the server has AUTHORIZED and, where applicable,
 * DERIVED them (a submission/batch target contributes its own bountyId). */
export interface AuthorizedUploadTarget {
  bountyId: string | null;
  submissionId: string | null;
  contributorBatchId: string | null;
  datasetRequestId: string | null;
  plannerSessionId: string | null;
}

/** Dataset-request statuses whose sample set a requester may still change.
 * Once a request is decided, the terms a reviewer signed off on must not be
 * rewritten out from under them. */
const SAMPLE_EDITABLE_REQUEST_STATUSES: ReadonlySet<DatasetRequestStatus> = new Set([
  DatasetRequestStatus.submitted,
  DatasetRequestStatus.under_review,
  DatasetRequestStatus.changes_requested,
]);

/** The same freeze, as a predicate, so the REMOVE path (DELETE
 * /v1/artifacts/:id) applies exactly the gate the ADD path does instead of
 * spelling out a second copy of the status list. v1 exports the identical
 * helper under the same name (`services/sponsor-samples.ts`
 * `requestSamplesEditable`), and its delete route's comment records why both
 * directions must be gated together: gating only uploads made removal
 * one-directional, so deleting a rejected sample could drop an approved
 * request below `min` with no way to add a replacement. */
export function requestSamplesEditable(status: DatasetRequestStatus): boolean {
  return SAMPLE_EDITABLE_REQUEST_STATUSES.has(status);
}

/** Bounty statuses that are terminal for contribution/sample purposes.
 * Exported so the REMOVE path (DELETE /v1/artifacts/:id) freezes a pool's
 * sample set on exactly the same statuses the ADD path does. */
export const TERMINAL_BOUNTY_STATUSES: ReadonlySet<BountyStatus> = new Set([
  BountyStatus.cancelled,
  BountyStatus.completed,
  BountyStatus.partially_completed,
]);

/** Owner-scoped `where` for the sponsor_reference rows attached to ONE sample
 * owner. Exactly one of the three columns is ever set (schema.prisma's
 * plannerSessionId/datasetRequestId/bountyId invariant), so this is keyed by
 * whichever the caller resolved. */
function sampleOwnerWhere(owner: {
  plannerSessionId?: string | null;
  datasetRequestId?: string | null;
  bountyId?: string | null;
}): Prisma.ArtifactWhereInput {
  if (owner.plannerSessionId) return { plannerSessionId: owner.plannerSessionId };
  if (owner.datasetRequestId) return { datasetRequestId: owner.datasetRequestId };
  return { bountyId: owner.bountyId! };
}

/**
 * Enforce {@link REQUIRED_SPONSOR_EXAMPLES_DEFAULT} as a real cap at the input
 * boundary. Returns the sponsor-facing reason when the owner is full, else
 * null. Ported from v1 `services/sponsor-samples.ts#sampleSlotError`.
 *
 * There was NO server-side cap: `sampleGate.max` was emitted by
 * `routes/v1/planner.ts` and enforced nowhere, so a direct POST to
 * /v1/artifacts/upload-slot put 5 sponsor_reference rows on one draft while
 * the planner UI said "3 attached", and finalize carried all 5 (a
 * `pending_upload` orphan among them) onto the request. Verified live.
 *
 * Which rows occupy a slot, and why — these match the web client's
 * `occupiesSampleSlot()` (apps/web/lib/api-artifacts.ts) so the count on
 * screen and the count the server enforces cannot disagree:
 *
 *  - `deleted` / `quarantined` do NOT occupy. A row the scanner quarantined
 *    can never become a usable sample, so counting it would strand the sponsor
 *    against the cap with nothing they could do about it.
 *  - A `pending_upload` row whose slot has EXPIRED does not occupy: issuing a
 *    slot writes the row before the browser talks to storage, so any failed
 *    transfer leaves a byte-less row behind. A LIVE pending slot does occupy,
 *    so this is not a hole a caller can drive through by opening slots in
 *    parallel, and DELETE /v1/artifacts/:id is the escape hatch for a live one.
 *  - `rejected` does NOT occupy — a rejection has to free its slot for the
 *    replacement, or at min == max every rejection would dead-end.
 *  - `needs_changes` DOES occupy. It is non-terminal: the sponsor is meant to
 *    resolve that specific sample, and freeing a slot for it would let the set
 *    grow while an unresolved sample is still in the reviewer's queue.
 *
 * The `rejected` test is spelled out as an explicit OR rather than the shorter
 * `{ not: "rejected" }`, because Prisma's `not` on a NULLABLE column drops NULL
 * rows too — a single legacy or hand-repaired NULL `sponsorReviewStatus` would
 * otherwise stop counting and let the set grow past the cap.
 *
 * Residual race, deliberately accepted and not papered over: the count runs
 * before the artifact row is written, so two slot requests issued for the same
 * owner in the same instant can both pass at max-1 and land at max+1. The cap
 * is a product bound on one sponsor's own sample set, not a privilege boundary
 * (the ownership checks above are), and closing it would mean holding an owner
 * row lock across the storage provider's signing call. v1 has the same shape.
 */
/**
 * Soft-delete one artifact, with every freeze gate the sponsor-facing route
 * applies — extracted so the REST route and the MCP `delete_file` tool cannot
 * diverge.
 *
 * They HAD diverged, and badly: `mcp/tools.ts` was a bare
 * `updateMany({ data: { status: "deleted" } })` on ownership alone. Two
 * consequences, both live and both proven against the running deployment.
 * First, it never stamped `deletedAt`, and the sample-gate readers filter on
 * `deletedAt IS NULL` rather than on `status` (see `buildSampleGate`,
 * `listDatasetRequestSamples`, `buildPublicSamples`), so an MCP-deleted
 * sample freed its slot against the cap while still being counted by the gate
 * and still published as a public sample — the database held exactly one such
 * orphan row. Second, and worse, it applied NONE of the freeze gates, so a
 * sample could be removed from an `approved` or minted request that the REST
 * route refuses with 409. That is an authorization bypass, not a bookkeeping
 * slip: the same operation was permitted or refused purely by which transport
 * the caller reached for.
 *
 * The gates are the same predicates the ADD path uses (`requestSamplesEditable`,
 * `TERMINAL_BOUNTY_STATUSES`, `session.completed`), shared rather than
 * restated — gating only uploads is what made removal one-directional in the
 * first place. Each freeze read takes a `FOR UPDATE` lock on its owner row
 * first, because the check reads a status and then decides: without the lock,
 * an admin approving concurrently can be read as still-editable and the
 * removal commits against a set that has just been signed off.
 *
 * Throws `ArtifactUploadValidationError` (409/403/404) so both callers can map
 * one error type onto their own transport.
 */
export async function softDeleteArtifact(params: {
  artifactId: string;
  actorUserId: string;
  isStaff: boolean;
  audit?: { ip?: string; userAgent?: string; requestId?: string };
}): Promise<{ kind: ArtifactKind }> {
  const artifact = await prisma.artifact.findUnique({ where: { id: params.artifactId } });
  if (!artifact) throw new ArtifactUploadValidationError("Artifact not found", "NOT_FOUND", 404);

  // Per-row ownership, written to FAIL CLOSED on a NULL `ownerUserId`: an
  // orphaned row is deletable by staff only, never by whoever asks first.
  if (artifact.ownerUserId !== params.actorUserId && !params.isStaff) {
    throw new ArtifactUploadValidationError("Cannot delete this artifact", "FORBIDDEN", 403);
  }

  await prisma.$transaction(async (tx) => {
    if (artifact.kind === ArtifactKind.sponsor_reference && artifact.datasetRequestId) {
      await tx.$queryRaw`SELECT id FROM dataset_requests WHERE id = ${artifact.datasetRequestId} FOR UPDATE`;
      const request = await tx.datasetRequest.findUnique({
        where: { id: artifact.datasetRequestId },
        select: { status: true },
      });
      // Applies to staff too: an operator who genuinely must remove a frozen
      // sample has `admin-artifacts.ts`, and letting the sponsor-facing path
      // through for staff would record an operator action as the sponsor's own
      // remove button.
      if (request && !requestSamplesEditable(request.status)) {
        throw new ArtifactUploadValidationError(
          `this request is ${request.status} — its reference samples are frozen`,
          "SPONSOR_EXAMPLES_LOCKED",
          409
        );
      }
    }

    if (artifact.kind === ArtifactKind.sponsor_reference && artifact.bountyId) {
      await tx.$queryRaw`SELECT id FROM bounties WHERE id = ${artifact.bountyId} FOR UPDATE`;
      const bounty = await tx.bounty.findUnique({ where: { id: artifact.bountyId }, select: { status: true } });
      if (bounty && TERMINAL_BOUNTY_STATUSES.has(bounty.status)) {
        throw new ArtifactUploadValidationError(
          `this pool is ${bounty.status} — its reference samples are frozen`,
          "SPONSOR_EXAMPLES_LOCKED",
          409
        );
      }
    }

    if (artifact.kind === ArtifactKind.sponsor_reference && artifact.plannerSessionId) {
      await tx.$queryRaw`SELECT id FROM planner_sessions WHERE id = ${artifact.plannerSessionId} FOR UPDATE`;
      const session = await tx.plannerSession.findUnique({
        where: { id: artifact.plannerSessionId },
        select: { completed: true },
      });
      if (session?.completed) {
        throw new ArtifactUploadValidationError(
          "this draft has already been submitted — its reference samples are frozen",
          "SPONSOR_EXAMPLES_LOCKED",
          409
        );
      }
    }

    // Conditional write: a second delete matches nothing and answers 409
    // rather than re-stamping `deletedAt` on a row that was already gone.
    // BOTH columns are stamped — the readers disagree about which one they
    // filter on, so stamping one leaves a sample gone from the cap but still
    // counted by the gate, which is precisely the MCP bug this function
    // exists to make unrepeatable.
    const removed = await tx.artifact.updateMany({
      where: { id: params.artifactId, status: { not: ArtifactStatus.deleted } },
      data: { status: ArtifactStatus.deleted, deletedAt: new Date() },
    });
    if (removed.count !== 1) {
      throw new ArtifactUploadValidationError("This file was already removed", "ARTIFACT_ALREADY_DELETED", 409);
    }

    await writeAuditLog(tx, {
      actorUserId: params.actorUserId,
      action: "artifact.deleted",
      targetType: "artifact",
      targetId: params.artifactId,
      metadata: {
        kind: artifact.kind,
        bountyId: artifact.bountyId,
        datasetRequestId: artifact.datasetRequestId,
        plannerSessionId: artifact.plannerSessionId,
        byStaff: artifact.ownerUserId !== params.actorUserId,
      },
      before: { status: artifact.status, deletedAt: artifact.deletedAt },
      after: { status: ArtifactStatus.deleted },
      ...(params.audit ?? {}),
    });
  });

  return { kind: artifact.kind };
}

export async function sampleSlotError(
  owner: { plannerSessionId?: string | null; datasetRequestId?: string | null; bountyId?: string | null },
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<string | null> {
  // Widened deliberately: the constant's literal type is `3`, which would
  // make the pluralisation below look statically dead to the compiler.
  const max: number = REQUIRED_SPONSOR_EXAMPLES_DEFAULT;
  const occupied = await client.artifact.count({
    where: {
      ...sampleOwnerWhere(owner),
      kind: ArtifactKind.sponsor_reference,
      deletedAt: null,
      status: { notIn: [ArtifactStatus.deleted, ArtifactStatus.quarantined] },
      OR: [
        { sponsorReviewStatus: null },
        { sponsorReviewStatus: { not: SponsorExampleReviewStatus.rejected } },
      ],
      NOT: { status: ArtifactStatus.pending_upload, uploadExpiresAt: { lte: new Date() } },
    },
  });
  return occupied >= max
    ? `this dataset already has ${max} reference sample${max === 1 ? "" : "s"} — remove or replace one before adding another`
    : null;
}

/** Throw the cap as a 409 if the resolved owner is full. Called on every
 * sponsor_reference leg below, i.e. from the SERVICE rather than a route, so
 * `createUploadSlot`, `createMultipartUpload` and the MCP `prepare_file_upload`
 * tool are all bounded by the one check. */
async function assertSampleSlotAvailable(owner: {
  plannerSessionId?: string | null;
  datasetRequestId?: string | null;
  bountyId?: string | null;
}): Promise<void> {
  const full = await sampleSlotError(owner);
  if (full) throw new ArtifactUploadValidationError(full, "SAMPLE_LIMIT_REACHED", 409);
}

async function authorizeSponsorReferenceTarget(
  userId: string,
  target: UploadTargetInput
): Promise<AuthorizedUploadTarget> {
  const owners = [target.bountyId, target.datasetRequestId, target.plannerSessionId].filter(Boolean);
  if (owners.length !== 1) {
    throw new ArtifactUploadValidationError(
      "a sponsor reference sample must name exactly one of bountyId, datasetRequestId or plannerSessionId",
      "SAMPLE_OWNER_REQUIRED",
      400
    );
  }

  if (target.plannerSessionId) {
    const session = await prisma.plannerSession.findUnique({
      where: { id: target.plannerSessionId },
      select: { userId: true, completed: true },
    });
    // 404, not 403: a draft id the caller does not own must not be confirmed
    // to exist. Same choice the route already made for this leg.
    if (!session || session.userId !== userId) {
      throw new ArtifactUploadValidationError("planner session not found", "NOT_FOUND", 404);
    }
    if (session.completed) {
      throw new ArtifactUploadValidationError("this draft has already been submitted", "DRAFT_SUBMITTED", 409);
    }
    await assertSampleSlotAvailable({ plannerSessionId: target.plannerSessionId });
    return { bountyId: null, submissionId: null, contributorBatchId: null, datasetRequestId: null, plannerSessionId: target.plannerSessionId };
  }

  if (target.datasetRequestId) {
    const request = await prisma.datasetRequest.findUnique({
      where: { id: target.datasetRequestId },
      select: { requesterUserId: true, status: true },
    });
    if (!request) throw new ArtifactUploadValidationError("dataset request not found", "NOT_FOUND", 404);
    if (request.requesterUserId !== userId) {
      throw new ArtifactUploadValidationError("only the requester may attach reference samples", "NOT_SAMPLE_OWNER", 403);
    }
    if (!SAMPLE_EDITABLE_REQUEST_STATUSES.has(request.status)) {
      throw new ArtifactUploadValidationError(
        `this request is ${request.status} — its reference samples are frozen`,
        "SAMPLES_FROZEN",
        409
      );
    }
    await assertSampleSlotAvailable({ datasetRequestId: target.datasetRequestId });
    return { bountyId: null, submissionId: null, contributorBatchId: null, datasetRequestId: target.datasetRequestId, plannerSessionId: null };
  }

  const bounty = await prisma.bounty.findUnique({
    where: { id: target.bountyId! },
    select: { requesterUserId: true, communityRequesterUserId: true, status: true },
  });
  if (!bounty) throw new ArtifactUploadValidationError("bounty not found", "NOT_FOUND", 404);
  const sponsorId = bounty.communityRequesterUserId ?? bounty.requesterUserId;
  if (sponsorId !== userId) {
    throw new ArtifactUploadValidationError("only the pool's sponsor may attach reference samples", "NOT_SAMPLE_OWNER", 403);
  }
  if (TERMINAL_BOUNTY_STATUSES.has(bounty.status)) {
    throw new ArtifactUploadValidationError(`this pool is ${bounty.status} — its reference samples are frozen`, "SAMPLES_FROZEN", 409);
  }
  await assertSampleSlotAvailable({ bountyId: target.bountyId! });
  return { bountyId: target.bountyId!, submissionId: null, contributorBatchId: null, datasetRequestId: null, plannerSessionId: null };
}

/** Ownership of a submission target: only its submitter may attach to it. */
async function authorizeSubmissionTarget(userId: string, submissionId: string): Promise<string | null> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { contributorUserId: true, bountyId: true },
  });
  if (!submission) throw new ArtifactUploadValidationError("submission not found", "NOT_FOUND", 404);
  if (submission.contributorUserId !== userId) {
    throw new ArtifactUploadValidationError("only the submitter may attach files", "NOT_TARGET_OWNER", 403);
  }
  return submission.bountyId;
}

/** Ownership of a contributor-batch target: only the batch's claimant. */
async function authorizeBatchTarget(userId: string, contributorBatchId: string, noun: string): Promise<string | null> {
  const batch = await prisma.contributorBatch.findUnique({
    where: { id: contributorBatchId },
    select: { contributorUserId: true, bountyId: true },
  });
  if (!batch) throw new ArtifactUploadValidationError("batch not found", "NOT_FOUND", 404);
  if (batch.contributorUserId !== userId) {
    throw new ArtifactUploadValidationError(`only the batch owner may ${noun}`, "NOT_TARGET_OWNER", 403);
  }
  return batch.bountyId;
}

/** A bare bountyId target is only legitimate for an OPEN community pool: with
 * no ContributorBatch to own, the pool itself is the boundary, so the pool has
 * to still be accepting work. */
async function authorizeOpenPoolTarget(bountyId: string, forSource: boolean): Promise<void> {
  const bounty = await prisma.bounty.findUnique({
    where: { id: bountyId },
    select: { kind: true, status: true, poolClosedAt: true, acceptedItems: true, targetItems: true },
  });
  if (!bounty) throw new ArtifactUploadValidationError("bounty not found", "NOT_FOUND", 404);
  // `BountyKind` has exactly one member in this product (D18 — there is no
  // funded track), so this can never fire today. Kept because it is the
  // boundary v1 enforces, and because testing for `community` rather than for
  // "not paid" fails closed if a second kind is ever added.
  if (bounty.kind !== BountyKind.community) {
    throw new ArtifactUploadValidationError("contributorBatchId required for paid-bounty uploads", "BATCH_REQUIRED", 400);
  }
  const full = !forSource && bounty.acceptedItems >= bounty.targetItems;
  if (bounty.status !== BountyStatus.active || bounty.poolClosedAt || full) {
    throw new ArtifactUploadValidationError(
      forSource ? "this community pool is not accepting source uploads" : "this pool is not currently accepting contributions",
      "POOL_CLOSED",
      409
    );
  }
}

/**
 * Decide whether this caller may bind an upload slot to the target ids they
 * declared, and derive the bountyId implied by a submission/batch target.
 *
 * Ported from v1 `services/artifact-uploads.ts:232-320`
 * (`authorizeArtifactUploadTarget`), with the sponsor_reference leg — which v1
 * delegates to its `services/sponsor-samples.ts`, a module this rebuild does
 * not have — restated inline above against this schema's three possible sample
 * owners.
 *
 * This closes a LIVE privilege bug: `createUploadSlot` previously wrote
 * `bountyId`/`submissionId`/`contributorBatchId`/`datasetRequestId` straight
 * from its params with no check at all (the route validated only
 * `plannerSessionId`), so any verified account could mint an artifact bound to
 * ANOTHER user's submission or claimed batch — reachable both through
 * POST /v1/artifacts/upload-slot and through the MCP `prepare_file_upload`
 * tool. Enforced in the SERVICE, not the route, precisely so every caller
 * (route, MCP, draft routes) is covered by the one check.
 */
export async function authorizeArtifactUploadTarget(
  userId: string,
  kind: ArtifactKind,
  target: UploadTargetInput
): Promise<AuthorizedUploadTarget> {
  if (kind === ArtifactKind.sponsor_reference) {
    return authorizeSponsorReferenceTarget(userId, target);
  }

  const submissionId = target.submissionId ?? null;
  const contributorBatchId = target.contributorBatchId ?? null;
  let bountyId = target.bountyId ?? null;
  const base = { submissionId, contributorBatchId, datasetRequestId: null, plannerSessionId: null };

  if (kind === ArtifactKind.bulk_submission_source) {
    if (contributorBatchId) {
      bountyId = await authorizeBatchTarget(userId, contributorBatchId, "upload the source");
    } else if (bountyId) {
      await authorizeOpenPoolTarget(bountyId, true);
    }
    // NO target supplied: allowed, and the row is bound to nothing.
    //
    // DELIBERATE DEVIATION from v1, which throws "contributorBatchId or an
    // open community bountyId required" here. An unbound slot is not the
    // privilege bug this function exists to close — it can only ever produce
    // an artifact owned by, and visible to, its uploader. v1 can afford to
    // require a target because its MCP `prepare_file_upload` always supplies
    // one; this product's does not (`mcp/tools.ts` makes `bountyId` optional
    // and the draft/agent flows rely on that), so requiring one would break a
    // live, legitimate caller to no security benefit. Recheck this if the MCP
    // tool ever starts mandating a target.
    return { ...base, bountyId };
  }

  if (kind === ArtifactKind.submission_attachment) {
    if (submissionId) {
      bountyId = await authorizeSubmissionTarget(userId, submissionId);
    } else if (contributorBatchId) {
      bountyId = await authorizeBatchTarget(userId, contributorBatchId, "attach files");
    } else if (bountyId) {
      // Community pools have no ContributorBatch before an item exists, so the
      // contributor stages the file against the open pool itself and the
      // item-create transaction re-parents it onto the submission.
      await authorizeOpenPoolTarget(bountyId, false);
    }
    // NO target supplied: allowed and bound to nothing — see the identical
    // deviation note in the bulk_submission_source branch above.
    return { ...base, bountyId };
  }

  // Every remaining kind is server-generated (validation logs, export
  // bundles, benchmark splits) and has no upload contract of its own. v1
  // leaves such a target unchecked because its route's zod enum makes the case
  // unreachable; this route accepts the full enum, so rather than leave the
  // same hole open under a different kind, ANY target id supplied here is put
  // through the same ownership checks. A slot with no target at all stays
  // legal, exactly as before.
  if (submissionId) bountyId = await authorizeSubmissionTarget(userId, submissionId);
  else if (contributorBatchId) bountyId = await authorizeBatchTarget(userId, contributorBatchId, "attach files");
  else if (bountyId) await authorizeOpenPoolTarget(bountyId, false);
  if (target.datasetRequestId || target.plannerSessionId) {
    throw new ArtifactUploadValidationError(
      "datasetRequestId and plannerSessionId are only valid for sponsor_reference uploads",
      "UPLOAD_TARGET_INVALID",
      400
    );
  }
  return { ...base, bountyId };
}

/** The dataset type whose file-field contract governs this upload, resolved
 * from whichever owner the slot is bound to. Mirrors v1's
 * `services/sponsor-samples.ts#resolveSampleDatasetType`. */
async function resolveUploadDatasetType(target: {
  bountyId: string | null;
  datasetRequestId: string | null;
  plannerSessionId: string | null;
}) {
  if (target.bountyId) {
    const bounty = await prisma.bounty.findUnique({ where: { id: target.bountyId }, select: { datasetType: true } });
    return bounty?.datasetType ?? null;
  }
  if (target.datasetRequestId) {
    const request = await prisma.datasetRequest.findUnique({
      where: { id: target.datasetRequestId },
      select: { datasetType: true },
    });
    return request?.datasetType ?? null;
  }
  if (target.plannerSessionId) {
    const session = await prisma.plannerSession.findUnique({
      where: { id: target.plannerSessionId },
      select: { answersJson: true },
    });
    const answers = session?.answersJson as { datasetTypeId?: unknown } | null;
    const typeId = typeof answers?.datasetTypeId === "string" ? answers.datasetTypeId : null;
    if (!typeId) return null;
    return prisma.datasetType.findUnique({ where: { id: typeId } });
  }
  return null;
}

function fileFieldAccepts(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((field) => {
    if (!field || typeof field !== "object") return [];
    const value = field as { role?: unknown; accept?: unknown };
    return value.role === "file" && typeof value.accept === "string" ? [value.accept] : [];
  });
}

/** Modalities the dataset type's file fields explicitly declare. Empty when it
 * declares none — the modality gate is then SKIPPED rather than inferred, so
 * catalog rows that predate the field are not retroactively rejected. */
function fileFieldModalities(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  const found = fields.flatMap((field) => {
    if (!field || typeof field !== "object") return [];
    const value = field as { role?: unknown; modality?: unknown };
    return value.role === "file" && typeof value.modality === "string" ? [value.modality] : [];
  });
  return [...new Set(found)];
}

/**
 * Enforce the upload kind's conservative default accept contract, or the
 * target dataset type's explicit file-field contract when it declares one, and
 * cross-check the declared modality. Ported from v1
 * `services/artifact-uploads.ts:190-228`.
 *
 * Returns the NORMALIZED content type — aliases folded, parameters stripped,
 * lowercased — which is what gets persisted, so modality routing, the
 * magic-byte reconciliation and the stored object's Content-Type all agree on
 * one spelling. Nothing enforced MIME at prepare before this; an upload could
 * declare any string at all and only be caught (if at all) after its bytes
 * were already in the bucket.
 *
 * Declaration-time only. The malware scan and magic-byte reconciliation over
 * the REAL bytes still run afterwards and are still what actually clears an
 * artifact — this never claims a file is safe, only that its declaration is
 * one the contract permits.
 */
export async function validateArtifactUploadDeclaration(input: {
  kind: ArtifactKind;
  filename: string;
  contentType: string;
  bountyId?: string | null;
  datasetRequestId?: string | null;
  plannerSessionId?: string | null;
}): Promise<string> {
  const governed = (DECLARATION_GOVERNED_KINDS as string[]).includes(input.kind);
  if (!governed) {
    // Server-generated kinds have no accept contract; still normalize so the
    // stored content type is canonical.
    const normalized = normalizeDeclaredContentType(input.contentType);
    if (!normalized) {
      throw new ArtifactUploadValidationError("contentType must contain a valid MIME type", "INVALID_FILE_DECLARATION", 400);
    }
    return normalized;
  }

  const datasetType = await resolveUploadDatasetType({
    bountyId: input.bountyId ?? null,
    datasetRequestId: input.datasetRequestId ?? null,
    plannerSessionId: input.plannerSessionId ?? null,
  });

  const declaredAccepts = fileFieldAccepts(datasetType?.fields);
  const result = validateArtifactDeclaration({
    kind: input.kind,
    filename: input.filename,
    contentType: input.contentType,
    fieldAccepts:
      input.kind === ArtifactKind.submission_attachment || input.kind === ArtifactKind.sponsor_reference
        ? declaredAccepts.length > 0
          ? declaredAccepts
          : // A resolved type that declares no file-valued field normalizes its
            // examples through JSON/JSONL. But when NO type resolved at all the
            // slot simply names no target yet, and narrowing it to JSON would
            // reject uploads the kind plainly allows — so leave the list empty
            // and let validateArtifactDeclaration apply DEFAULT_ACCEPT[kind],
            // which is v1's behaviour for an unresolved declaration.
            datasetType
            ? [".json,.jsonl,.ndjson"]
            : []
        : [],
  });
  if (!result.ok || !result.normalizedContentType) {
    throw new ArtifactUploadValidationError(
      result.reason ?? "file declaration is not allowed",
      "INVALID_FILE_DECLARATION",
      400
    );
  }

  // `accept` alone is not sufficient: a type can legitimately accept a broad
  // pattern while still expecting one kind of content, so without this a
  // contract asking for a screenshot would happily take an archive.
  const declaredModalities = fileFieldModalities(datasetType?.fields);
  if (
    declaredModalities.length > 0 &&
    (input.kind === ArtifactKind.submission_attachment || input.kind === ArtifactKind.sponsor_reference)
  ) {
    const uploaded = modalityForContentType(result.normalizedContentType);
    if (!declaredModalities.includes(uploaded)) {
      throw new ArtifactUploadValidationError(
        `this dataset type expects ${declaredModalities.join(" or ")} files, but "${input.filename}" looks like ${uploaded}`,
        "MODALITY_MISMATCH",
        400
      );
    }
  }
  return result.normalizedContentType;
}

/**
 * Write-time half of the F-003 fix (see the matching read-time gate in
 * {@link canReadArtifact}). `visibility: public_sample` is the only
 * world-readable visibility an artifact can carry, so it must never be a
 * caller's free choice independent of `kind` — before this, `uploadSlotBody`
 * (routes/v1/artifacts.ts) accepted `visibility` with no relationship to
 * `kind` at all, and this function wrote it straight through, so ANY
 * verified member could turn ANY upload (a `submission_attachment`, a
 * `bulk_submission_source`, anything) into an anonymous public download the
 * moment it reached `ready`.
 *
 * Enforced HERE, in the service, not only in the route's Zod schema — the
 * same reason {@link authorizeArtifactUploadTarget} lives here: so every
 * caller (this route, the MCP `prepare_file_upload`/`prepare_large_file_upload`
 * tools, any future draft route) gets the same answer from one place, rather
 * than each caller having to re-implement the allowlist. (The MCP tools do
 * not expose a `visibility` parameter today, so they cannot currently reach
 * this at all — this still guards the day one does.)
 *
 * `sponsor_reference` is the only kind allowed to request it: it already has
 * a real, wired admin-approval gate (`sponsorReviewStatus`, the
 * `/:id/sponsor-review` route, and the matching read-time check this function
 * pairs with in `canReadArtifact`) — see
 * `docs/engineering/STORAGE_AND_ARTIFACTS_PLAN.md` ("An admin may explicitly
 * promote a ready, approved sponsor reference to `public_sample`... a
 * deliberate visibility change, not a client-side fallback"). Every other
 * kind is refused outright with a clear, caller-visible error — never
 * silently downgraded to `private`, which would be a worse trap than an
 * honest rejection.
 *
 * `ArtifactKind.public_sample` is deliberately NOT on the allowlist despite
 * its name: it has zero creation call sites anywhere in this codebase today,
 * no admin-approval wiring of its own, and `mcp/tools.ts`'s own
 * `MCP_UPLOAD_KINDS` comment already documents it as "server-authored...
 * never a caller's to create" — a future platform-exporter-generated
 * preview, per the storage plan, not something this upload path should ever
 * hand out. Allowing it here would just relabel the same hole under a
 * different kind value.
 */
function assertVisibilityAllowedForKind(kind: ArtifactKind, visibility: ArtifactVisibility | undefined): void {
  if (visibility !== ArtifactVisibility.public_sample) return;
  if (kind === ArtifactKind.sponsor_reference) return;
  throw new ArtifactUploadValidationError(
    `visibility "public_sample" is not allowed for kind "${kind}" — only an approved sponsor_reference sample may be publicly visible`,
    "VISIBILITY_NOT_ALLOWED_FOR_KIND",
    400
  );
}

export async function createUploadSlot(params: {
  ownerUserId: string;
  kind: ArtifactKind;
  filename: string;
  contentType: string;
  declaredSizeBytes?: number;
  /** Hex SHA-256 of the exact bytes the caller intends to send. Required only
   * when the active storage driver can issue a direct-upload target (the
   * checksum gets bound into the signed policy) — the local-disk fallback
   * verifies the real bytes itself once they arrive, so it does not need one. */
  checksumSha256?: string;
  visibility?: ArtifactVisibility;
  bountyId?: string;
  submissionId?: string;
  contributorBatchId?: string;
  datasetRequestId?: string;
  /** Pre-mint owner for a `sponsor_reference` sample collected in the planner,
   * before any DatasetRequest or Bounty exists. Was missing here entirely, so
   * every planner sample was created with ALL THREE owner columns null —
   * violating the "exactly ONE of plannerSessionId / datasetRequestId /
   * bountyId is set" invariant in schema.prisma, and leaving the file attached
   * to nothing and reachable from nothing. */
  plannerSessionId?: string;
}): Promise<{ artifactId: string; storageKey: string; uploadExpiresAt: Date; upload: DirectUploadTarget; reused: boolean }> {
  // ---- 0. F-003: visibility must be one this kind may actually carry. ------
  // Checked first and synchronously — no DB round trip needed to reject a
  // caller-chosen visibility that was never this kind's to request.
  assertVisibilityAllowedForKind(params.kind, params.visibility);

  // ---- 1. Authorize the TARGET before anything is written. -----------------
  // P0: these ids used to be written straight through from params. See
  // authorizeArtifactUploadTarget's header for the bug this closes.
  const target = await authorizeArtifactUploadTarget(params.ownerUserId, params.kind, params);

  // ---- 2. Validate the DECLARATION against the dataset type's contract. ----
  const contentType = await validateArtifactUploadDeclaration({
    kind: params.kind,
    filename: params.filename,
    contentType: params.contentType,
    bountyId: target.bountyId,
    datasetRequestId: target.datasetRequestId,
    plannerSessionId: target.plannerSessionId,
  });

  // ---- 3. Archive size cap (v1 artifact-uploads.ts:347-353). ---------------
  // Nothing in this codebase decompresses an archive, so this bounds the
  // unparsed blob only — it is not an extraction limit.
  if (archiveSizeExceedsLimit(contentType, params.declaredSizeBytes)) {
    throw new ArtifactUploadValidationError(
      `archive uploads are capped at ${MAX_ARCHIVE_UPLOAD_BYTES} bytes (no extraction pipeline exists yet to bound a larger one safely)`,
      "ARCHIVE_TOO_LARGE",
      400
    );
  }

  // ---- 4. Pending-slot quota (v1 artifact-uploads.ts:355-368). -------------
  // Slot creation is a row write plus a signature; unbounded, a loop fills the
  // artifacts table and the bucket's pending-object space for free.
  const pendingCount = await prisma.artifact.count({
    where: { ownerUserId: params.ownerUserId, status: ArtifactStatus.pending_upload, uploadExpiresAt: { gt: new Date() } },
  });
  if (pendingCount >= config.storage.maxPendingUploadsPerUser) {
    throw new ArtifactUploadValidationError(
      "too many pending uploads; complete or wait for existing upload slots to expire",
      "TOO_MANY_PENDING_UPLOADS",
      409
    );
  }

  const driver = storage();
  const directCapable = hasDirectUpload(driver);
  const checksum = params.checksumSha256?.toLowerCase();
  if (directCapable && (!checksum || !/^[a-f0-9]{64}$/.test(checksum))) {
    // Checked BEFORE the row is created now, so an unfulfillable request no
    // longer creates-then-soft-deletes an orphan shell (and no longer burns a
    // slot against the quota above).
    throw new ArtifactUploadValidationError(
      "checksumSha256 (64 hex chars) is required when the active storage driver supports direct upload",
      "CHECKSUM_REQUIRED",
      400
    );
  }

  // ---- 5. Idempotent reuse (v1 artifact-uploads.ts:369-412). ---------------
  // A retry after a browser refresh, an MCP reconnect or a lost response must
  // not fill the quota with duplicate rows. Only an IDENTICAL, still-live,
  // already-server-authorized row owned by this caller is reused, and it gets
  // a freshly minted provider URL — the URL itself is never stored or replayed.
  const reusable = await prisma.artifact.findFirst({
    where: {
      ownerUserId: params.ownerUserId,
      kind: params.kind,
      bountyId: target.bountyId,
      submissionId: target.submissionId,
      contributorBatchId: target.contributorBatchId,
      datasetRequestId: target.datasetRequestId,
      plannerSessionId: target.plannerSessionId,
      filename: params.filename,
      contentType,
      declaredSizeBytes: params.declaredSizeBytes ? BigInt(params.declaredSizeBytes) : null,
      checksumSha256: checksum ?? null,
      status: ArtifactStatus.pending_upload,
      uploadExpiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (reusable) {
    const refreshed = await prisma.artifact.update({
      where: { id: reusable.id },
      data: { uploadExpiresAt: new Date(Date.now() + uploadSlotTtlMs()) },
    });
    const upload = directCapable
      ? await driver.createDirectUpload({
          key: refreshed.storageKey,
          contentType: refreshed.contentType,
          maxBytes: params.declaredSizeBytes ?? config.storage.maxUploadBytes,
          checksumSha256Hex: checksum!,
          expiresSeconds: Math.floor(uploadSlotTtlMs() / 1000),
        })
      : ({
          mode: "form_post",
          method: "POST",
          url: `/v1/artifacts/${refreshed.id}/content?token=${uploadTokenFor(refreshed)}`,
          fields: {},
          expiresAt: refreshed.uploadExpiresAt!,
        } as DirectUploadTarget);
    await prisma.$transaction((tx) =>
      writeAuditLog(tx, {
        actorUserId: params.ownerUserId,
        action: "artifact.upload_slot_issued",
        targetType: "artifact",
        targetId: refreshed.id,
        metadata: {
          kind: refreshed.kind,
          bountyId: refreshed.bountyId,
          sizeBytes: params.declaredSizeBytes ?? null,
          uploadMode: upload.mode,
          reused: true,
        },
      })
    );
    return {
      artifactId: refreshed.id,
      storageKey: refreshed.storageKey,
      uploadExpiresAt: refreshed.uploadExpiresAt!,
      upload,
      reused: true,
    };
  }

  const artifactId = `art_${randomBytes(16).toString("hex")}`;
  // SEC-01: server-generated key. `params.filename` is untrusted and reaches
  // the key only through safeStorageFilename, so it can never add a path
  // segment or escape this artifact id's prefix. The display name is stored
  // verbatim in the `filename` column below.
  const storageKey = buildArtifactStorageKey({ kind: params.kind, artifactId, filename: params.filename });

  const artifact = await prisma.artifact.create({
    data: {
      id: artifactId,
      ownerUserId: params.ownerUserId,
      kind: params.kind,
      filename: params.filename,
      // The NORMALIZED type (aliases folded, parameters stripped) — so the
      // stored row, the presigned policy, the modality router and the
      // magic-byte reconciliation all read one spelling.
      contentType,
      declaredSizeBytes: params.declaredSizeBytes ? BigInt(params.declaredSizeBytes) : undefined,
      // The client-declared checksum, recorded so completion can verify what
      // storage actually received against what was promised.
      checksumSha256: checksum,
      visibility: params.visibility ?? ArtifactVisibility.private,
      // Server-AUTHORIZED targets, never the raw params.
      bountyId: target.bountyId,
      submissionId: target.submissionId,
      contributorBatchId: target.contributorBatchId,
      datasetRequestId: target.datasetRequestId,
      plannerSessionId: target.plannerSessionId,
      storageDriver: config.storage.driver,
      storageKey,
      status: ArtifactStatus.pending_upload,
      scanStatus: ArtifactScanStatus.pending,
      uploadExpiresAt: new Date(Date.now() + uploadSlotTtlMs()),
    },
  });

  // Real capability detection, exactly like v1: only ask a driver for a
  // direct-upload target when it actually implements one. The local disk
  // driver never does (see lib/storage/local.ts's header comment), so dev
  // keeps using the same-origin, token-authorized content route unchanged.
  let upload: DirectUploadTarget;
  if (directCapable) {
    upload = await driver.createDirectUpload({
      key: storageKey,
      contentType,
      maxBytes: params.declaredSizeBytes ?? config.storage.maxUploadBytes,
      checksumSha256Hex: checksum!,
      expiresSeconds: Math.floor(uploadSlotTtlMs() / 1000),
    });
  } else {
    // Local-driver fallback: same-origin streaming route, authorized by the
    // slot's own capability token (see uploadTokenFor above) rather than a
    // provider-issued signature. Returned as a relative path — each transport
    // (browser route, MCP tool) absolutizes it for its own audience.
    upload = {
      mode: "form_post",
      method: "POST",
      url: `/v1/artifacts/${artifact.id}/content?token=${uploadTokenFor(artifact)}`,
      fields: {},
      expiresAt: artifact.uploadExpiresAt!,
    };
  }

  // Audit evidence for the issuance itself (v1 artifact-uploads.ts:441-452).
  // Before this only EXPIRY was logged, so the audit trail could show a slot
  // lapsing that no row ever recorded being handed out.
  await prisma.$transaction((tx) =>
    writeAuditLog(tx, {
      actorUserId: params.ownerUserId,
      action: "artifact.upload_slot_issued",
      targetType: "artifact",
      targetId: artifact.id,
      metadata: {
        kind: artifact.kind,
        bountyId: artifact.bountyId,
        sizeBytes: params.declaredSizeBytes ?? null,
        uploadMode: upload.mode,
        reused: false,
      },
    })
  );

  return { artifactId: artifact.id, storageKey, uploadExpiresAt: artifact.uploadExpiresAt!, upload, reused: false };
}

/**
 * Large-object (multipart) direct upload — S3-only capability. The client
 * declares the whole object's parts (number, exact size, per-part SHA-256) up
 * front; the server verifies that plan against its own configured part size
 * (`planMultipartParts`) so a client cannot smuggle a mis-sized part past the
 * per-part checksum binding, then asks the driver for one short-lived signed
 * PUT target per part.
 *
 * Throws {@link ArtifactUploadValidationError} with code
 * `MULTIPART_UPLOAD_UNSUPPORTED` when the active driver has no multipart
 * capability (local dev) — routes map this to 409 so the client's documented
 * fallback (a single-slot/content-route upload) can take over, exactly the
 * same shape as `createDirectUpload`'s local-driver fallback above.
 */
export async function createMultipartUpload(params: {
  ownerUserId: string;
  kind: ArtifactKind;
  filename: string;
  contentType: string;
  totalSizeBytes: number;
  parts: MultipartPartDeclaration[];
  visibility?: ArtifactVisibility;
  bountyId?: string;
  submissionId?: string;
  contributorBatchId?: string;
  datasetRequestId?: string;
}): Promise<{ artifactId: string; storageKey: string; multipart: MultipartUploadPlan }> {
  // F-003: same write-time visibility/kind check as createUploadSlot — see
  // assertVisibilityAllowedForKind's header for the full rationale. The
  // multipart path had the identical unchecked `visibility` hole.
  assertVisibilityAllowedForKind(params.kind, params.visibility);

  const driver = storage();
  if (!hasMultipartUpload(driver)) {
    throw new ArtifactUploadValidationError(
      "the active storage driver does not support multipart upload — use prepare_file_upload / POST /upload-slot instead",
      "MULTIPART_UPLOAD_UNSUPPORTED"
    );
  }

  // Same target authorization and declaration contract as the single-request
  // slot: the multipart path had the identical unchecked-target hole, and a
  // large upload is exactly the one you least want to discover is unauthorized
  // only after the parts are in the bucket.
  const target = await authorizeArtifactUploadTarget(params.ownerUserId, params.kind, params);
  const contentType = await validateArtifactUploadDeclaration({
    kind: params.kind,
    filename: params.filename,
    contentType: params.contentType,
    bountyId: target.bountyId,
    datasetRequestId: target.datasetRequestId,
    plannerSessionId: target.plannerSessionId,
  });
  if (archiveSizeExceedsLimit(contentType, params.totalSizeBytes)) {
    throw new ArtifactUploadValidationError(
      `archive uploads are capped at ${MAX_ARCHIVE_UPLOAD_BYTES} bytes (no extraction pipeline exists yet to bound a larger one safely)`,
      "ARCHIVE_TOO_LARGE",
      400
    );
  }
  const pendingCount = await prisma.artifact.count({
    where: { ownerUserId: params.ownerUserId, status: ArtifactStatus.pending_upload, uploadExpiresAt: { gt: new Date() } },
  });
  if (pendingCount >= config.storage.maxPendingUploadsPerUser) {
    throw new ArtifactUploadValidationError(
      "too many pending uploads; complete or wait for existing upload slots to expire",
      "TOO_MANY_PENDING_UPLOADS",
      409
    );
  }

  // Reconcile the client's declared part manifest against the server's own
  // plan for its configured part size. A client that got the split wrong
  // (mis-sized non-final part, wrong part count) is rejected here — with the
  // correct plan named in the error — rather than being handed presigned
  // targets a real upload could never actually assemble.
  const expected = planMultipartParts(params.totalSizeBytes, config.storage.multipartPartSizeBytes);
  if (
    params.parts.length !== expected.length ||
    params.parts.some((p, i) => p.partNumber !== expected[i]!.partNumber || p.sizeBytes !== expected[i]!.sizeBytes)
  ) {
    throw new ArtifactUploadValidationError(
      `declared parts do not match the required ${config.storage.multipartPartSizeBytes}-byte split for a ${params.totalSizeBytes}-byte object (expected ${expected.length} part(s))`,
      "MULTIPART_PLAN_MISMATCH"
    );
  }

  const artifactId = `art_${randomBytes(16).toString("hex")}`;
  // SEC-01: server-generated key. `params.filename` is untrusted and reaches
  // the key only through safeStorageFilename, so it can never add a path
  // segment or escape this artifact id's prefix. The display name is stored
  // verbatim in the `filename` column below.
  const storageKey = buildArtifactStorageKey({ kind: params.kind, artifactId, filename: params.filename });
  const expiresSeconds = Math.floor(uploadSlotTtlMs() / 1000);

  const plan = await driver.createMultipartUpload({
    key: storageKey,
    contentType,
    parts: params.parts,
    expiresSeconds,
  });

  await prisma.artifact.create({
    data: {
      id: artifactId,
      ownerUserId: params.ownerUserId,
      kind: params.kind,
      filename: params.filename,
      contentType,
      declaredSizeBytes: BigInt(params.totalSizeBytes),
      visibility: params.visibility ?? ArtifactVisibility.private,
      // Server-AUTHORIZED targets, never the raw params.
      bountyId: target.bountyId,
      submissionId: target.submissionId,
      contributorBatchId: target.contributorBatchId,
      datasetRequestId: target.datasetRequestId,
      plannerSessionId: target.plannerSessionId,
      storageDriver: config.storage.driver,
      storageKey,
      status: ArtifactStatus.pending_upload,
      scanStatus: ArtifactScanStatus.pending,
      uploadExpiresAt: plan.expiresAt,
      multipartUploadId: plan.uploadId,
    },
  });

  await prisma.$transaction((tx) =>
    writeAuditLog(tx, {
      actorUserId: params.ownerUserId,
      action: "artifact.upload_slot_issued",
      targetType: "artifact",
      targetId: artifactId,
      metadata: {
        kind: params.kind,
        bountyId: target.bountyId,
        sizeBytes: params.totalSizeBytes,
        uploadMode: "multipart",
        parts: params.parts.length,
        reused: false,
      },
    })
  );

  return { artifactId, storageKey, multipart: plan };
}

/** Assemble a multipart upload from its uploaded parts, then hand off to the
 * same HEAD-verify → enqueue-scan tail a single-request upload goes through. */
export async function completeMultipartUpload(
  artifactId: string,
  ownerUserId: string,
  parts: MultipartCompletedPart[]
) {
  const artifact = await prisma.artifact.findUnique({ where: { id: artifactId } });
  if (!artifact || artifact.ownerUserId !== ownerUserId) {
    throw new ArtifactUploadValidationError("Artifact not found or access denied", "NOT_FOUND");
  }
  if (artifact.status !== ArtifactStatus.pending_upload || !artifact.multipartUploadId) {
    throw new ArtifactUploadValidationError("This artifact has no in-progress multipart upload to complete", "NOT_MULTIPART_PENDING");
  }
  // Expiry, which this path did not check at all: an expired multipart slot
  // still assembled, so a slot the purge worker was about to reclaim could be
  // turned into a real object first. Same window (and same operator-granted
  // grace) the single-request path applies.
  if (slotHasLapsed(artifact.uploadExpiresAt, await artifactUploadGraceMs())) {
    throw new ArtifactUploadValidationError("upload slot has expired", "SLOT_EXPIRED");
  }
  const driver = storage();
  if (!hasMultipartUpload(driver)) {
    throw new ArtifactUploadValidationError("the active storage driver does not support multipart upload", "MULTIPART_UPLOAD_UNSUPPORTED");
  }

  await driver.completeMultipartUpload({ key: artifact.storageKey, uploadId: artifact.multipartUploadId, parts });

  // Never trust the client's declared total — HEAD the assembled object and
  // record what the provider actually verified, same as the single-request
  // path's completion. Multipart composite objects may not carry a whole-
  // object checksum (headArtifactData can honestly return null here).
  const head = await headArtifactData(artifact.storageKey);

  return prisma.artifact.update({
    where: { id: artifactId },
    data: {
      sizeBytes: BigInt(head.sizeBytes),
      checksumSha256: head.checksumSha256 ?? undefined,
      multipartUploadId: null,
      status: ArtifactStatus.scanning,
      scanStatus: ArtifactScanStatus.pending,
    },
  }).then(async (updated) => {
    await dbJobQueue.enqueue({
      type: "artifact.scan",
      idempotencyKey: `scan:${updated.id}`,
      payload: { artifactId: updated.id },
    });
    await prisma.$transaction((tx) =>
      writeAuditLog(tx, {
        actorUserId: ownerUserId,
        action: "artifact.upload_completed",
        targetType: "artifact",
        targetId: updated.id,
        metadata: { kind: updated.kind, bountyId: updated.bountyId, sizeBytes: head.sizeBytes, multipart: true, parts: parts.length },
        before: { status: ArtifactStatus.pending_upload },
        after: { status: updated.status },
      })
    );
    return updated;
  });
}

/** Cancel an in-flight multipart upload: best-effort abort on the provider
 * (releases reserved parts so they stop incurring storage cost) then
 * soft-delete the row, mirroring `abort_large_file_upload`'s existing
 * semantics. */
export async function abortMultipartUpload(artifactId: string, ownerUserId: string): Promise<void> {
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, ownerUserId } });
  if (!artifact) throw new ArtifactUploadValidationError("Artifact not found or access denied", "NOT_FOUND");

  const driver = storage();
  if (artifact.multipartUploadId && hasMultipartUpload(driver)) {
    await driver.abortMultipartUpload({ key: artifact.storageKey, uploadId: artifact.multipartUploadId });
  }
  // `deletedAt` is stamped alongside `status`, not instead of it. The readers
  // of a soft-deleted artifact do not agree on which column means "gone":
  // `sampleSlotError` above and `listUserArtifacts` test `status`, while
  // `buildSampleGate`, `listDatasetRequestSamples` and `buildPublicSamples`
  // test `deletedAt IS NULL`. This wrote only `status`, so an aborted
  // multipart sponsor_reference upload freed its slot against the cap but was
  // still counted by the gate and still listed — the gate reporting a sample
  // that no longer exists. DELETE /v1/artifacts/:id stamps both for the same
  // reason.
  await prisma.artifact.update({
    where: { id: artifactId },
    data: { status: ArtifactStatus.deleted, deletedAt: new Date(), multipartUploadId: null },
  });
}

/** True when a storage HEAD failed because the object simply is not there.
 * Covers the S3 driver's `S3 HEAD failed (404)` and the local driver's ENOENT
 * from `stat`. Anything else — timeout, 5xx, auth — is NOT not-found and must
 * keep its retryable identity, so the caller retries instead of being told,
 * wrongly, that their upload is missing. Ported from v1
 * `services/artifacts.ts:401-407`. */
function isObjectNotFound(error: unknown): boolean {
  if (!error) return false;
  if ((error as { code?: string }).code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\((404|403)\)/.test(message) || /NoSuchKey|NotFound/i.test(message);
}

/** Normalize a provider checksum (S3 returns base64 for its own algorithms,
 * quoted hex for an ETag) down to lowercase hex for comparison. */
function normalizeChecksumSha256(value: string): string {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded.toString("hex");
  } catch {
    /* not base64 — fall through */
  }
  return trimmed.toLowerCase();
}

export async function completeUpload(artifactId: string, ownerUserId: string) {
  const artifact = await prisma.artifact.findUnique({ where: { id: artifactId } });
  if (!artifact || artifact.ownerUserId !== ownerUserId) {
    throw new Error("Artifact not found or access denied");
  }

  // QA 2026-09-05 (P2, state integrity): completion used to check ownership
  // only, so an owner could "complete" an expired slot, or one that never
  // received bytes, and leave a `scanning`/`error` row with null size and no
  // object behind. Completion is only meaningful for a live slot that the
  // content route has already filled (it records the server-measured size
  // and checksum on a successful write).
  if (artifact.status !== ArtifactStatus.pending_upload) {
    throw new ArtifactUploadValidationError("upload slot is no longer open", "SLOT_NOT_OPEN");
  }
  // Grace, applied here as well as in the purge worker. Before this only the
  // worker read `artifacts.upload.grace_seconds`, so completion refused slots
  // the worker was still willing to tolerate — an upload landing inside an
  // operator-granted grace could neither complete nor be purged.
  if (slotHasLapsed(artifact.uploadExpiresAt, await artifactUploadGraceMs())) {
    throw new ArtifactUploadValidationError("upload slot has expired", "SLOT_EXPIRED");
  }

  // ---- Re-verify against STORAGE, not against the row. ---------------------
  //
  // This used to require `sizeBytes`/`checksumSha256` to be pre-populated on
  // the row — which ONLY the local-disk content route ever does. With
  // STORAGE_DRIVER=s3, where the client PUTs straight to the bucket and the
  // API never sees the bytes, those columns stay null and completion always
  // threw SLOT_EMPTY: the entire direct-PUT path was dead in production
  // configuration. v1 HEADs the object instead
  // (`services/artifacts.ts:409-459`), which is both the fix and the stronger
  // check — the server's own measurement of what storage actually holds,
  // rather than a value some earlier request wrote onto the row.
  let head: Awaited<ReturnType<typeof headArtifactData>>;
  try {
    head = await headArtifactData(artifact.storageKey);
  } catch (err) {
    // A completion whose bytes never landed is a CALLER problem, not a server
    // fault. Only a GENUINE not-found is reclassified; a timeout or a 5xx from
    // storage keeps its identity so the caller retries.
    if (isObjectNotFound(err)) {
      throw new ArtifactUploadValidationError(
        "no uploaded object found for this upload slot — the bytes were never sent to storage, or the upload failed. Upload to the slot's URL, then call complete again; if the slot has expired, request a new one.",
        "ARTIFACT_BYTES_MISSING",
        409
      );
    }
    throw err;
  }

  // Declared size and declared checksum are both promises the caller made when
  // the slot was issued (and, for a direct upload, promises bound into the
  // provider's signed policy). A stored object that breaks either one is not
  // the file this slot authorized — quarantine rather than reject, so the
  // mismatching bytes stay available as evidence instead of being silently
  // dropped, and so the row can never later be mistaken for a live slot.
  const expectedSize = artifact.declaredSizeBytes != null ? Number(artifact.declaredSizeBytes) : null;
  if (expectedSize != null && head.sizeBytes !== expectedSize) {
    await prisma.artifact.update({
      where: { id: artifactId },
      data: { status: ArtifactStatus.quarantined, sizeBytes: BigInt(head.sizeBytes) },
    });
    throw new ArtifactUploadValidationError(
      "uploaded object size did not match the upload slot",
      "ARTIFACT_SIZE_MISMATCH",
      409
    );
  }
  const expectedChecksum = artifact.checksumSha256?.toLowerCase() ?? null;
  // v1 treats "storage reports no checksum" as a failure because there the only
  // way to reach this point is a client PUT straight to the bucket — nothing
  // server-side ever saw those bytes, so an absent provider checksum means the
  // upload is unprovable and must fail closed.
  //
  // The rebuild also routes its LOCAL driver through here, and that path is the
  // opposite case: the content route hashed the bytes itself as it wrote them
  // and stored the result, so `artifact.checksumSha256` IS the server-verified
  // value. Local `head()` returns `checksumSha256: null` (it keeps no sidecar),
  // so applying v1's clause verbatim rejects every local completion with
  // ARTIFACT_CHECKSUM_MISMATCH on evidence that already proved the bytes good.
  // Demand a provider checksum only where the provider is the sole witness.
  const providerIsSoleWitness = hasDirectUpload(storage());
  const checksumContradicted = expectedChecksum
    ? head.checksumSha256
      ? normalizeChecksumSha256(head.checksumSha256) !== expectedChecksum
      : providerIsSoleWitness
    : false;
  if (checksumContradicted) {
    await prisma.artifact.update({
      where: { id: artifactId },
      data: { status: ArtifactStatus.quarantined, sizeBytes: BigInt(head.sizeBytes) },
    });
    throw new ArtifactUploadValidationError(
      "uploaded object checksum did not match the upload slot",
      "ARTIFACT_CHECKSUM_MISMATCH",
      409
    );
  }

  // The upload is stored, but nothing has scanned it yet — `scanning`/
  // `pending` is the honest state. Marking this `ready`+`clean` here (the
  // prior behavior) claimed a scan result that had not happened; the real
  // `artifact.scan` job below (services/artifact-scanner.ts's `scanArtifact`,
  // handled in worker.ts) is what actually decides `ready`/`quarantined`.
  //
  // Conditional claim (same shape as the content route's SEC-02 guard): if a
  // concurrent completion already moved the row off `pending_upload`, this
  // call loses and reports it instead of re-enqueueing a second scan.
  const claimed = await prisma.artifact.updateMany({
    where: { id: artifactId, status: ArtifactStatus.pending_upload },
    data: {
      status: ArtifactStatus.scanning,
      scanStatus: ArtifactScanStatus.pending,
      // Record what storage actually holds, not what the row claimed. On the
      // direct-PUT path these are the FIRST server-measured values the row
      // ever carries; on the local content-route path they re-confirm what
      // `putArtifactStream` already hashed.
      sizeBytes: BigInt(head.sizeBytes),
      ...(head.contentType ? { contentType: head.contentType } : {}),
    },
  });
  if (claimed.count === 0) {
    throw new ArtifactUploadValidationError("upload slot is no longer open", "SLOT_NOT_OPEN");
  }
  const updated = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });

  // Re-validate the declaration against the STORED content type (v1
  // `artifact-uploads.ts:457-505`). The type recorded above came back from
  // storage, so a caller who declared `.json` at prepare and got the bucket to
  // store `text/html` is caught here rather than at read time. Quarantine, not
  // reject: the object exists and must stop being treatable as a live slot.
  try {
    await validateArtifactUploadDeclaration({
      kind: updated.kind,
      filename: updated.filename,
      contentType: updated.contentType,
      bountyId: updated.bountyId,
      datasetRequestId: updated.datasetRequestId,
      plannerSessionId: updated.plannerSessionId,
    });
  } catch (err) {
    if (err instanceof ArtifactUploadValidationError && (err.code === "INVALID_FILE_DECLARATION" || err.code === "MODALITY_MISMATCH")) {
      await prisma.artifact.update({
        where: { id: artifactId },
        data: { status: ArtifactStatus.quarantined, scanStatus: ArtifactScanStatus.content_mismatch },
      });
      throw new ArtifactUploadValidationError(
        "stored object content type does not match the upload contract",
        "ARTIFACT_CONTENT_TYPE_MISMATCH",
        409
      );
    }
    throw err;
  }

  // Enqueue artifact scan / parse
  await dbJobQueue.enqueue({
    type: "artifact.scan",
    idempotencyKey: `scan:${artifact.id}`,
    payload: { artifactId: artifact.id },
  });

  await prisma.$transaction((tx) =>
    writeAuditLog(tx, {
      actorUserId: ownerUserId,
      action: "artifact.upload_completed",
      targetType: "artifact",
      targetId: updated.id,
      metadata: { kind: updated.kind, bountyId: updated.bountyId, sizeBytes: head.sizeBytes },
      before: { status: ArtifactStatus.pending_upload },
      after: { status: updated.status },
    })
  );

  return updated;
}

/** First bytes examined for the "is this even plausible text" fallback
 * check below — mirrors CODE_TEXT_HANDLER.detect()'s own window so the two
 * never disagree about what counts as binary. */
const UNKNOWN_TYPE_TEXT_PROBE_BYTES = 512;

/** Hard ceiling on an object this process will read fully into memory for the
 * scan/parse pass. Same value and same purpose as v1's
 * `services/artifact-jobs.ts` `WHOLE_BUFFER_MAX_BYTES`. */
export const WHOLE_BUFFER_MAX_BYTES = 200 * 1024 * 1024;

/** True when the header contains no embedded NUL byte, i.e. it's at least
 * plausibly UTF-8 text rather than an arbitrary binary blob. Used only for
 * the modality `other` fallback below — every recognized modality already
 * has its declared/detected signature reconciled by `checkMagicBytesFromBuffer`. */
function looksLikePlainText(header: Buffer): boolean {
  const limit = Math.min(header.length, UNKNOWN_TYPE_TEXT_PROBE_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (header[i] === 0) return false;
  }
  return true;
}

/**
 * The `artifact.scan` job handler. Runs, in order:
 *
 *  1. Magic-byte reconciliation (`checkMagicBytesFromBuffer` — cheap, local,
 *     no external dependency): a detectable mismatch between the declared
 *     content type and the file's real signature quarantines before
 *     spending a call on the malware scanner.
 *  2. The malware scan (services/artifact-scanner.ts's `scanArtifact` —
 *     already honest/fail-closed).
 *  3. Format-registry dispatch (services/format-registry) for whatever
 *     modality the artifact resolves to: `handler.parse()`/`preview()` run
 *     and their outcome is persisted as `ArtifactProcessingEvent` rows plus
 *     `Artifact.parserVersion` — evidence the admin console
 *     (`routes/v1/admin-artifacts.ts`) already reads, so nothing downstream
 *     needs to change to pick this up.
 *
 * Fail-closed contract, matching the Universal Dataset Modality Invariant:
 * a content/declaration mismatch, an archive that breaches the zip-bomb
 * caps, or a binary blob with no recognized modality and no plausible
 * plain-text signature ALL quarantine for human review — none of them is
 * silently accepted. `not_required` (malware scanning disabled/unconfigured)
 * still clears the artifact to `ready` — that mirrors the platform-wide
 * convention of not blocking a feature on an optional check the deployment
 * hasn't turned on — but the `scanStatus` column itself stays honest
 * (`not_required`, not a fabricated `clean`), so any reader checking scan
 * evidence sees the real state rather than a claimed pass.
 */
export async function runArtifactScanJob(artifactId: string): Promise<void> {
  const artifact = await prisma.artifact.findUnique({ where: { id: artifactId } });
  if (!artifact) return;
  // Already resolved (retried job after a crash post-commit, or a duplicate
  // enqueue) — don't re-scan or flip state a second time.
  if (artifact.status !== ArtifactStatus.scanning) return;

  // Whole-file buffering guard (v1 `services/artifact-jobs.ts:60`,
  // WHOLE_BUFFER_MAX_BYTES). `getArtifactData()` collects the entire object
  // into one Buffer with no cap of its own, so on the multipart path — where
  // `maxMultipartUploadBytes` allows objects far larger than the 100 MiB
  // single-PUT cap — a single scan job could try to allocate the whole thing
  // and take the worker process down. Checked BEFORE the read, against the
  // server-verified `sizeBytes`, so nothing is allocated at all. Fails closed:
  // quarantined for human review, never promoted to `ready`.
  const storedBytes = artifact.sizeBytes != null ? Number(artifact.sizeBytes) : null;
  if (storedBytes != null && storedBytes > WHOLE_BUFFER_MAX_BYTES) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.artifact.update({
        where: { id: artifactId },
        data: { status: ArtifactStatus.quarantined, scanStatus: ArtifactScanStatus.error },
      });
      await writeAuditLog(tx, {
        actorUserId: null,
        action: "artifact.scan_too_large",
        targetType: "artifact",
        targetId: updated.id,
        metadata: {
          kind: updated.kind,
          bountyId: updated.bountyId,
          sizeBytes: storedBytes,
          limitBytes: WHOLE_BUFFER_MAX_BYTES,
          detail: "object exceeds the in-process scan buffer limit; needs a streaming scanner",
        },
        before: { status: artifact.status, scanStatus: artifact.scanStatus },
        after: { status: updated.status, scanStatus: updated.scanStatus },
      });
    });
    return;
  }

  let fileBytes: Buffer;
  try {
    fileBytes = await getArtifactData(artifact.storageKey);
  } catch (err) {
    // Can't even read the bytes back — fail closed, same as a scan we
    // couldn't run: left in `scanning` with an `error` scanStatus for retry
    // or manual review, never silently promoted to `ready`.
    await prisma.artifact.update({ where: { id: artifactId }, data: { scanStatus: ArtifactScanStatus.error } });
    throw err;
  }

  const magicOutcome = checkMagicBytesFromBuffer(artifact, fileBytes);
  const detectedMime = mimeForDetectedKind(magicOutcome.detected);
  const detectedModality = detectedMime ? modalityForContentType(detectedMime) : null;

  if (!magicOutcome.ok) {
    // Declared content type disagrees with the file's real signature (e.g.
    // a `.txt` renamed to `.png`) — quarantine before the malware scan even
    // runs. `content_mismatch` is a distinct scanStatus from `infected` so
    // admin evidence never conflates "scanned, found malware" with "the
    // declaration itself was dishonest."
    await prisma.$transaction(async (tx) => {
      const updated = await tx.artifact.update({
        where: { id: artifactId },
        data: {
          status: ArtifactStatus.quarantined,
          scanStatus: ArtifactScanStatus.content_mismatch,
          detectedMimeType: detectedMime ?? magicOutcome.detected ?? undefined,
        },
      });
      await writeAuditLog(tx, {
        actorUserId: null,
        action: "artifact.content_mismatch",
        targetType: "artifact",
        targetId: updated.id,
        metadata: { kind: updated.kind, bountyId: updated.bountyId, detail: magicOutcome.detail },
        before: { status: artifact.status, scanStatus: artifact.scanStatus },
        after: { status: updated.status, scanStatus: updated.scanStatus },
      });
    });
    return;
  }

  const { scanArtifact } = await import("./artifact-scanner.js");
  let outcome: Awaited<ReturnType<typeof scanArtifact>>;
  try {
    outcome = await scanArtifact(artifact);
  } catch (err) {
    // Fail closed: a scan we could not actually run must not clear the
    // artifact for read. Left in `scanning` with an `error` scanStatus so a
    // retry (re-enqueue) or manual admin review can resolve it; never
    // silently promoted to `ready`.
    await prisma.artifact.update({
      where: { id: artifactId },
      data: { scanStatus: ArtifactScanStatus.error },
    });
    throw err;
  }

  if (outcome.status === "infected") {
    await prisma.artifact.update({
      where: { id: artifactId },
      data: {
        status: ArtifactStatus.quarantined,
        scanStatus: ArtifactScanStatus.infected,
        detectedMimeType: detectedMime ?? magicOutcome.detected ?? undefined,
        ...(detectedModality ? { modality: detectedModality } : {}),
      },
    });
    return;
  }

  // Resolve the modality to dispatch on: prefer what the bytes actually said
  // (detectedModality) over the client-declared content type, falling back
  // to the declared type only when detection was undetectable (all-text
  // formats have no magic-byte signature, so `detected` is legitimately
  // null there — that is not itself suspicious).
  const resolvedModality = detectedModality ?? artifact.modality ?? modalityForContentType(artifact.contentType);
  const handler = resolveHandler(resolvedModality);

  // Fail-closed on a genuinely unrecognized type: no known content-type
  // prefix, no magic-byte signature, AND the bytes don't even look like
  // plausible plain text. This is the "unknown types fail closed to
  // quarantine or human review" half of the invariant — distinct from the
  // content-type/magic-byte MISMATCH case above, which already quarantines
  // its own way. A binary blob nobody can identify is never let through
  // just because no signature happened to contradict its declared type.
  if (resolvedModality === "other" && !looksLikePlainText(fileBytes.subarray(0, UNKNOWN_TYPE_TEXT_PROBE_BYTES))) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.artifact.update({
        where: { id: artifactId },
        data: {
          status: ArtifactStatus.quarantined,
          scanStatus: ArtifactScanStatus.content_mismatch,
          detectedMimeType: detectedMime ?? magicOutcome.detected ?? undefined,
        },
      });
      await writeAuditLog(tx, {
        actorUserId: null,
        action: "artifact.unrecognized_type",
        targetType: "artifact",
        targetId: updated.id,
        metadata: {
          kind: updated.kind,
          bountyId: updated.bountyId,
          detail: "unrecognized binary content: no known content type, no magic-byte signature, not plain text",
        },
        before: { status: artifact.status, scanStatus: artifact.scanStatus },
        after: { status: updated.status, scanStatus: updated.scanStatus },
      });
    });
    return;
  }

  // Dispatch to the format registry. A handler that can't actually parse
  // this content (DEFAULT_HANDLER, or a real handler reporting ok:false)
  // must never be reported as a passed check — parserVersion is only
  // recorded when parse() succeeds.
  const parseResult = await handler.parse(artifact);
  const parseStatus = parseResult.ok ? "passed" : handler === DEFAULT_HANDLER ? "not_supported" : "failed";
  const previewResult = await handler.preview(artifact);

  // An archive that fails its own parse() failed the zip-bomb caps
  // (evaluateZipArchive) — that's a real content-policy breach, not merely
  // "not yet implemented" (which is what a video/audio/document handler's
  // permanent `ok:false` means). Quarantine only the former.
  const archiveBreach = resolvedModality === "archive" && !parseResult.ok;

  // Promotion is EXPLICIT per verdict. `ArtifactScanResult` still permits
  // `status: "error"`; `scanArtifact` never returns it today (it throws, and
  // the catch above records `error`), but the old ternary mapped "anything not
  // clean" to `not_required`, so a future writer returning `error` would have
  // been silently promoted to `ready`. Now only the two cleared verdicts
  // promote; any other value is recorded as `scanStatus = error` and the row
  // stays `scanning` for retry or manual review — the same fail-closed shape
  // as a thrown scan. The `not_required` → `ready` path itself is unchanged:
  // the scanner is optional and off by default in every environment (owner
  // decision 2026-09-05), and an absent setting row means `not_required`.
  const clearedScanStatus: ArtifactScanStatus | null =
    outcome.status === "clean"
      ? ArtifactScanStatus.clean
      : outcome.status === "not_required"
        ? ArtifactScanStatus.not_required
        : null;
  if (clearedScanStatus === null) {
    await prisma.artifact.update({
      where: { id: artifactId },
      data: { scanStatus: ArtifactScanStatus.error },
    });
    return;
  }

  let readyForFollowUp = false;
  await prisma.$transaction(async (tx) => {
    const quarantine = archiveBreach;
    const updated = await tx.artifact.update({
      where: { id: artifactId },
      data: {
        status: quarantine ? ArtifactStatus.quarantined : ArtifactStatus.ready,
        scanStatus: quarantine ? ArtifactScanStatus.content_mismatch : clearedScanStatus,
        detectedMimeType: detectedMime ?? magicOutcome.detected ?? undefined,
        ...(detectedModality ? { modality: detectedModality } : {}),
        ...(parseResult.ok ? { parserVersion: handler.version } : {}),
      },
    });
    await tx.artifactProcessingEvent.create({
      data: {
        artifactId: updated.id,
        stage: "parse",
        status: parseStatus,
        handlerVersion: handler.version,
        detail: { metadata: parseResult.metadata, reason: parseResult.reason ?? null } as Prisma.InputJsonValue,
      },
    });
    await tx.artifactProcessingEvent.create({
      data: {
        artifactId: updated.id,
        stage: "preview",
        status: previewResult.status,
        handlerVersion: handler.version,
        detail: { reason: previewResult.reason ?? null } as Prisma.InputJsonValue,
      },
    });
    if (archiveBreach) {
      await writeAuditLog(tx, {
        actorUserId: null,
        action: "artifact.archive_rejected",
        targetType: "artifact",
        targetId: updated.id,
        metadata: { kind: updated.kind, bountyId: updated.bountyId, detail: parseResult.reason },
        before: { status: artifact.status, scanStatus: artifact.scanStatus },
        after: { status: updated.status, scanStatus: updated.scanStatus },
      });
    }
    readyForFollowUp = !quarantine;
  });

  // Post-scan follow-up work, enqueued only once the artifact is genuinely
  // `ready` — ported from the equivalent block in v1
  // `services/artifact-jobs.ts#handleArtifactScan`. Enqueued INSIDE the same
  // transaction as the status flip would be tidier, but the enqueue helpers
  // each do their own pre-read/update on the artifact row, so they run
  // post-commit here; every one of them is keyed idempotently, so a crash in
  // this window costs a retry, never a duplicate.
  //
  // `parse` and `preview` are deliberately NOT enqueued: this handler already
  // wrote their evidence inline above (it needs the parse result as a
  // quarantine gate, so it cannot defer it). Re-enqueueing them would either
  // duplicate that evidence or dedupe into a permanent no-op. What is
  // genuinely missing at scan time is `similarity_check` (it needs siblings) —
  // see enqueueStaleFormatRechecks for the handler-version recheck path.
  if (!readyForFollowUp) return;
  const { enqueueFormatSimilarityCheck, FORMAT_REGISTRY_ELIGIBLE_KINDS } = await import("./jobs/artifact-jobs.js");
  const scanned = { id: artifactId, modality: detectedModality ?? artifact.modality, workspaceId: artifact.workspaceId, ownerUserId: artifact.ownerUserId };
  if (FORMAT_REGISTRY_ELIGIBLE_KINDS.includes(artifact.kind)) {
    await enqueueFormatSimilarityCheck(scanned);
  }
  if (artifact.kind === ArtifactKind.bulk_submission_source) {
    // The parser refuses a source with no attached review draft (permanent
    // error) and skips one created with `ingest:false`, so this is safe to
    // enqueue unconditionally for the kind; the attach-source routes enqueue
    // it again once a draft claims the source, and the shared idempotency key
    // makes that the same row.
    const { enqueueBulkSourceParse } = await import("./jobs/bulk-source-parse.js");
    await enqueueBulkSourceParse(artifactId);
  }
  if (artifact.kind === ArtifactKind.sponsor_reference) {
    const { enqueueSponsorReferenceReview } = await import("./jobs/sponsor-reference-review.js");
    await enqueueSponsorReferenceReview({
      id: artifactId,
      kind: artifact.kind,
      ownerUserId: artifact.ownerUserId,
      workspaceId: artifact.workspaceId,
    });
  }
}

export async function getArtifactById(artifactId: string) {
  return prisma.artifact.findUnique({
    where: { id: artifactId },
  });
}

/**
 * A user's artifacts, newest first.
 *
 * `limit`/`offset` are bounded rather than optional-and-unlimited: this was an
 * uncapped `findMany`, so an account with a long upload history returned every
 * row in one response — including through the `list_files` MCP tool, straight
 * into an agent's context. Default 50, hard ceiling 100, matching
 * `listSubmissions` and `listNotifications` so every list surface in this API
 * bounds the same way.
 *
 * `offset` is retained for the REST route (`GET /v1/artifacts`) and is NOT
 * stable: an upload that lands between two pages shifts every later row, so an
 * offset walk repeats or skips artifacts. `cursor` is the stable way to walk
 * the list and wins when both are supplied — see lib/keyset-cursor.ts.
 */
export function userArtifactsFilterKey(params: {
  ownerUserId: string;
  kind?: ArtifactKind;
  bountyId?: string;
  plannerSessionId?: string;
}): string {
  return filterKeyOf(["artifacts", params.ownerUserId, params.kind, params.bountyId, params.plannerSessionId]);
}

export async function listUserArtifacts(
  ownerUserId: string,
  kind?: ArtifactKind,
  params?: {
    limit?: number;
    offset?: number;
    plannerSessionId?: string;
    /** v1 exposes this on `list_files` (GET /artifacts?bountyId=); it was
     * dropped in this port, so an agent holding a bounty id had no way to ask
     * "which files belong to this pool?" and had to page the whole account. */
    bountyId?: string;
    cursor?: string;
  },
) {
  const limit = Math.min(Math.max(params?.limit ?? 50, 1), 100);
  const filterKey = userArtifactsFilterKey({ ownerUserId, kind, bountyId: params?.bountyId, plannerSessionId: params?.plannerSessionId });
  const position = params?.cursor ? decodeDateCursor(params.cursor, filterKey, "artifact") : null;

  const where: Prisma.ArtifactWhereInput = {
    ownerUserId,
    ...(kind ? { kind } : {}),
    // Scoped server-side rather than filtered in the client: a sponsor with
    // more artifacts than one page would otherwise have this draft's samples
    // fall off the end of the default 50 and silently read as "none
    // attached". Indexed by `@@index([plannerSessionId, kind])`.
    ...(params?.plannerSessionId ? { plannerSessionId: params.plannerSessionId } : {}),
    ...(params?.bountyId ? { bountyId: params.bountyId } : {}),
    status: { not: ArtifactStatus.deleted },
    // Strictly-after predicate for `createdAt desc, id desc`. `id` is the
    // tiebreaker so two artifacts written in the same millisecond still have a
    // total order and neither can be skipped or repeated.
    ...(position
      ? {
          OR: [
            { createdAt: { lt: position.createdAt } },
            { createdAt: position.createdAt, id: { lt: position.id } },
          ],
        }
      : {}),
  };

  const rows = await prisma.artifact.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(position ? {} : { skip: Math.max(params?.offset ?? 0, 0) }),
  });

  const { items, hasMore } = takePage(rows, limit);
  const last = items[items.length - 1];
  return {
    items,
    limit,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id, filterKey) : null,
  };
}

/**
 * Shapes a Prisma Artifact row into the wire contract `apps/web/lib/api-artifacts.ts`
 * actually reads (id/kind/visibility/status/scanStatus/modality/... + a
 * relative downloadUrl). Sending the raw Prisma row instead would both
 * mismatch that contract (BigInt `sizeBytes` columns throw on
 * `JSON.stringify`) and leak storage-internal fields. Single source of truth
 * for every route that returns an artifact — routes/v1/artifacts.ts and the
 * dataset-request sample routes (routes/v1/community.ts,
 * routes/v1/admin-community.ts) all reuse this instead of hand-rolling their
 * own projection.
 */
export function serializeArtifact(artifact: {
  id: string;
  kind: ArtifactKind;
  visibility: ArtifactVisibility;
  status: ArtifactStatus;
  scanStatus: ArtifactScanStatus;
  modality: string | null;
  detectedMimeType: string | null;
  parserVersion: string | null;
  sponsorReviewStatus: SponsorExampleReviewStatus | null;
  sponsorReviewNote: string | null;
  sponsorReviewedAt: Date | null;
  filename: string;
  contentType: string;
  sizeBytes: bigint | null;
  submissionId: string | null;
  plannerSessionId: string | null;
  createdAt: Date;
}) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    visibility: artifact.visibility,
    status: artifact.status,
    scanStatus: artifact.scanStatus,
    modality: artifact.modality,
    detectedMimeType: artifact.detectedMimeType,
    parserVersion: artifact.parserVersion,
    sponsorReviewStatus: artifact.sponsorReviewStatus,
    sponsorReviewNote: artifact.sponsorReviewNote,
    sponsorReviewedAt: artifact.sponsorReviewedAt,
    filename: artifact.filename,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes === null ? null : Number(artifact.sizeBytes),
    submissionId: artifact.submissionId,
    // The pre-mint owner of a sponsor_reference sample. Exposed so a resumed
    // planner draft can list its OWN samples back instead of showing an empty
    // list as though nothing had ever been attached. Safe to return: every
    // route that serializes an artifact is already ownership- or
    // `canReadArtifact`-gated, and this is a draft id, not file content.
    plannerSessionId: artifact.plannerSessionId,
    createdAt: artifact.createdAt,
    downloadUrl: `/v1/artifacts/${artifact.id}/content`,
  };
}

/** Minimum number of admin-approved sponsor_reference samples a dataset
 * request must carry before it is considered ready to mint. Single source of
 * truth for both the sample-count gate and the public-sample count cap (a
 * bounty never surfaces more approved samples publicly than a sponsor was
 * ever required to supply). */
export const REQUIRED_SPONSOR_EXAMPLES_DEFAULT = 3;

export interface SampleGate {
  ok: boolean;
  approved: number;
  pending: number;
  rejected: number;
  min: number;
  max: number;
  reason: string | null;
}

function sampleGateFromCounts(counts: Record<string, number>): SampleGate {
  const approved = counts.approved ?? 0;
  // `needs_changes` counts as PENDING, not rejected. It was bucketed with
  // `rejected` here, which put the server at odds with the cap and with the
  // web client's `occupiesSampleSlot()` (apps/web/lib/api-artifacts.ts) —
  // both of which treat only `rejected` as terminal and free. A sample sent
  // back for changes is still the sponsor's to resolve and still sits in the
  // reviewer's queue, so reporting it as rejected described a live sample as a
  // dead one. v1 buckets it the same way (`services/sponsor-samples.ts`
  // `NON_TERMINAL` = null | pending | needs_changes).
  //
  // `ok` is unaffected either way: it has only ever depended on `approved`.
  const pending = (counts.pending ?? 0) + (counts.needs_changes ?? 0);
  const rejected = counts.rejected ?? 0;
  const min = REQUIRED_SPONSOR_EXAMPLES_DEFAULT;
  return {
    ok: approved >= min,
    approved,
    pending,
    rejected,
    min,
    max: min,
    reason: approved >= min ? null : `Needs ${min - approved} more approved reference sample${min - approved === 1 ? "" : "s"}.`,
  };
}

/** Reference-sample gate for a request, computed with one aggregate query.
 * Reads real Artifact rows (kind=sponsor_reference, datasetRequestId=request.id)
 * — honest, not fabricated. No route in this deployment currently lets a
 * requester attach reference samples to a DatasetRequest (the sponsor-reference
 * upload flow only exists pre-mint on the planner-session/bounty legs, per
 * Artifact's plannerSessionId/datasetRequestId/bountyId invariant comment in
 * schema.prisma), so this will read 0/0/0 until that flow is built — that is a
 * real, current gap, not a bug in this query. Deliberately NOT enforced as a
 * hard block on decision/implement (unlike the UI's comment implies). It was
 * originally advisory because no pre-mint upload path existed at all; that is
 * no longer true — the planner attaches samples to the draft and finalize
 * carries them onto the request. It stays advisory anyway so requests created
 * before that path existed, which genuinely have no samples, do not
 * permanently jam the review queue. Making it blocking is a product decision,
 * not a cleanup.
 *
 * Prefer {@link listDatasetRequestSamples} + {@link sampleGateFromSamples} when
 * the caller also needs the underlying artifact rows (e.g. to render them) —
 * that avoids running this same count twice.
 */
export async function buildSampleGate(requestId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<SampleGate> {
  const rows = await client.artifact.groupBy({
    by: ["sponsorReviewStatus"],
    where: { datasetRequestId: requestId, kind: ArtifactKind.sponsor_reference, deletedAt: null },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.sponsorReviewStatus ?? "pending"] = r._count._all;
  return sampleGateFromCounts(counts);
}

/** The real sponsor_reference artifact rows attached to a dataset request —
 * same where-clause {@link buildSampleGate} counts, kept in sync deliberately
 * so a caller that needs both the rows and the gate (e.g. the sponsor-facing
 * single-request detail route) can derive the gate from these same rows with
 * {@link sampleGateFromSamples} instead of re-querying. */
export async function listDatasetRequestSamples(requestId: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  return client.artifact.findMany({
    where: { datasetRequestId: requestId, kind: ArtifactKind.sponsor_reference, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

/** Derives the same {@link SampleGate} shape as {@link buildSampleGate}, but
 * from an already-fetched array of samples (e.g. from
 * {@link listDatasetRequestSamples}) instead of issuing a second query. */
export function sampleGateFromSamples(samples: Array<{ sponsorReviewStatus: SponsorExampleReviewStatus | null }>): SampleGate {
  const counts: Record<string, number> = {};
  for (const s of samples) {
    const key = s.sponsorReviewStatus ?? "pending";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return sampleGateFromCounts(counts);
}

const PUBLIC_SAMPLE_PREVIEW_MAX_CHARS = 4_000;

/** Wire shape `apps/landing/lib/public-data.ts`'s `publicSamples()` mapper
 * and `apps/landing/app/(site)/bounties/[id]/view.tsx` actually read. */
export interface PublicSampleArtifact {
  id: string;
  filename: string;
  contentType: string;
  downloadUrl: string;
  sample: { available: boolean; content?: string; truncated?: boolean; reason?: string };
}

/**
 * The real sponsor-uploaded work brief for an open community pool. These are
 * Artifact rows, never copied DatasetType.sampleAssets: the download route
 * continues to enforce readiness, approval and reader access for every file.
 */
export async function listBountyBriefArtifacts(bountyId: string) {
  return prisma.artifact.findMany({
    where: {
      bountyId,
      kind: ArtifactKind.sponsor_reference,
      status: ArtifactStatus.ready,
      sponsorReviewStatus: SponsorExampleReviewStatus.approved,
      visibility: { in: [ArtifactVisibility.work_brief, ArtifactVisibility.public_sample] },
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Public-facing reference samples for a minted community bounty
 * (GET /v1/bounties/:id, GET /v1/community/catalog). Deliberately NOT a new
 * visibility rule: it reuses {@link canReadArtifact} with `user: null` (the
 * exact check the world-readable `/v1/artifacts/:id/content` download route
 * already applies to an anonymous caller) to decide `sample.available` per
 * artifact, so this can never claim an artifact is publicly viewable when the
 * real download route would 401/403 an anonymous request for the same id.
 *
 * Candidates are scoped to admin-approved, scan-cleared sponsor reference
 * samples on this bounty (the same `kind: sponsor_reference` +
 * `sponsorReviewStatus: approved` + `status: ready` gate {@link buildSampleGate}
 * counts as "approved") — a sample a sponsor never got sign-off on, or that
 * hasn't cleared the malware/content scan, is never surfaced here regardless
 * of its `visibility` column. Today no upload path ever sets
 * `visibility: public_sample` on a sponsor_reference artifact (see the upload
 * routes in routes/v1/artifacts.ts), so every candidate currently comes back
 * with `available: false` — an honest reflection of a real, current gap
 * (nothing has opted a sample into public visibility yet), not a bug in this
 * query. The "+N more hidden" affordance on the landing page exists for
 * exactly this state.
 */
export async function buildPublicSamples(bountyId: string): Promise<PublicSampleArtifact[]> {
  const candidates = await prisma.artifact.findMany({
    where: {
      bountyId,
      kind: ArtifactKind.sponsor_reference,
      status: ArtifactStatus.ready,
      sponsorReviewStatus: SponsorExampleReviewStatus.approved,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
  });

  return Promise.all(
    candidates.map(async (artifact): Promise<PublicSampleArtifact> => {
      const base = {
        id: artifact.id,
        filename: artifact.filename,
        contentType: artifact.contentType,
        downloadUrl: `/v1/artifacts/${artifact.id}/content`,
      };

      const publiclyReadable = await canReadArtifact(artifact, null);
      if (!publiclyReadable) {
        return { ...base, sample: { available: false, reason: "This sample has not been released for public preview." } };
      }

      const modality = artifact.modality ?? modalityForContentType(artifact.contentType);
      if (modality !== "text" && modality !== "code") {
        return { ...base, sample: { available: false, reason: "Preview isn't supported for this file type yet." } };
      }

      try {
        const bytes = await getArtifactData(artifact.storageKey);
        const text = bytes.toString("utf8");
        const truncated = text.length > PUBLIC_SAMPLE_PREVIEW_MAX_CHARS;
        return {
          ...base,
          sample: {
            available: true,
            content: truncated ? text.slice(0, PUBLIC_SAMPLE_PREVIEW_MAX_CHARS) : text,
            truncated,
          },
        };
      } catch {
        return { ...base, sample: { available: false, reason: "Sample content could not be loaded." } };
      }
    })
  );
}
