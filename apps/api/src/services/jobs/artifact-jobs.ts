// SPDX-License-Identifier: Apache-2.0

/**
 * Artifact retention + format-registry job handlers.
 *
 * Ported from v1 `databounty-api/src/services/artifact-jobs.ts`
 * (`purgeExpiredArtifactUploads`, `handleFormatParse`, `handleFormatPreview`,
 * `handleFormatSimilarityCheck`, `findSimilarityCandidates`, and the three
 * `enqueueFormat*` helpers). The claim/ack/backoff loop v1 wrapped around
 * them lives in this rebuild's `src/worker.ts` instead, so only the real
 * behavior is duplicated here — never the queue plumbing.
 *
 * The evidence contract is v1's, unchanged, and it is the whole point of the
 * file: a stage that could not run records `not_supported` with a reason,
 * never a fabricated `passed`. `parserVersion` is written ONLY on a real
 * successful parse, so "this file was parsed by handler X" is always a claim
 * backed by a stored result.
 */
import type { Artifact, Prisma } from "@prisma/client";
import { ArtifactStatus, ArtifactKind } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { storage, hasMultipartUpload } from "../../lib/storage/index.js";
import { resolveHandler } from "../format-registry/registry.js";
import { DEFAULT_HANDLER } from "../format-registry/default-handler.js";
import type { SimilarityResult } from "../format-registry/types.js";
import { enqueueJob, workspaceKeyForUser, type JobType } from "../jobs.js";

/** Upload slots purged per sweep. Bounded so one backlog cannot hold a worker
 * slot open indefinitely; the sweep simply runs again next tick. */
const PURGE_BATCH = 100;

/**
 * How many earlier same-bounty/kind/modality artifacts a similarity_check job
 * compares against. Mirrors the dedupe pipeline's candidate cap purpose
 * (bound the pairwise-comparison fan-out) without pulling MinHash/LSH into
 * what is, for now, a small-N per-bounty comparison set.
 */
const SIMILARITY_CANDIDATE_CAP = 25;

/** Artifacts whose latest stage evidence is checked for staleness per sweep. */
const RECHECK_SCAN_BATCH = 200;

/**
 * Kinds whose bytes are worth format-registry evidence. Internal pipeline
 * artifacts (validation logs/reports, export bundles) are machine-generated,
 * and `bulk_submission_source` has its own dedicated parse pipeline — running
 * the registry over them would only produce noise evidence nobody reads.
 */
export const FORMAT_REGISTRY_ELIGIBLE_KINDS: ArtifactKind[] = [
  ArtifactKind.submission_attachment,
  ArtifactKind.sponsor_reference,
];

/**
 * Admin-configurable tolerance added to `uploadExpiresAt` before a slot is
 * treated as abandoned. Same setting key and same code default (0 — no grace
 * unless an operator asks for one) as v1's `getArtifactUploadGraceMs`.
 */
export async function getArtifactUploadGraceMs(): Promise<number> {
  const row = await prisma.adminSetting.findUnique({ where: { key: "artifacts.upload.grace_seconds" } });
  const value = row?.value as unknown;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value * 1000 : 0;
}

/**
 * `artifact.purge_expired_uploads` handler.
 *
 * An upload slot whose window closed without bytes landing is abandoned: the
 * row is quarantined + soft-deleted, and any provider-side multipart upload is
 * aborted so orphaned parts stop costing storage. Two ordering rules matter:
 *
 *  1. **Claim the row before touching the provider.** A concurrent completion
 *     then sees a non-`pending_upload` status and fails closed, instead of
 *     assembling a multipart object whose slot has already been reclaimed.
 *  2. **Provider abort is best-effort AFTER the commit.** The database is
 *     already in a safe state if the abort fails; the bucket lifecycle rule
 *     remains the durable backstop.
 */
export async function purgeExpiredArtifactUploads(): Promise<{ purged: number }> {
  const graceMs = await getArtifactUploadGraceMs();
  const cutoff = new Date(Date.now() - graceMs);
  const expired = await prisma.artifact.findMany({
    where: { status: ArtifactStatus.pending_upload, uploadExpiresAt: { lte: cutoff } },
    orderBy: { uploadExpiresAt: "asc" },
    take: PURGE_BATCH,
    select: { id: true },
  });

  let purged = 0;
  for (const row of expired) {
    const claimed = await prisma.$transaction(async (tx) => {
      // Re-read INSIDE the transaction and guard the update on the status we
      // read: `updateMany` with the guard in its WHERE is the compare-and-set
      // that makes two concurrent sweeps (or a sweep racing a completion)
      // resolve to exactly one winner.
      const current = await tx.artifact.findUnique({ where: { id: row.id } });
      if (!current || current.status !== ArtifactStatus.pending_upload) return null;
      if (!current.uploadExpiresAt || current.uploadExpiresAt.getTime() > Date.now() - graceMs) return null;

      const won = await tx.artifact.updateMany({
        where: { id: current.id, status: ArtifactStatus.pending_upload },
        data: { status: ArtifactStatus.quarantined, deletedAt: new Date(), multipartUploadId: null },
      });
      if (won.count !== 1) return null;

      await writeAuditLog(tx, {
        actorUserId: null,
        action: "artifact.upload_expired",
        targetType: "artifact",
        targetId: current.id,
        metadata: { kind: current.kind, multipartUpload: Boolean(current.multipartUploadId) },
        before: { status: current.status, uploadExpiresAt: current.uploadExpiresAt },
        after: { status: ArtifactStatus.quarantined },
      });
      return { storageKey: current.storageKey, multipartUploadId: current.multipartUploadId };
    });

    if (!claimed) continue;
    purged += 1;
    if (claimed.multipartUploadId) {
      const driver = storage();
      if (hasMultipartUpload(driver)) {
        await driver
          .abortMultipartUpload({ key: claimed.storageKey, uploadId: claimed.multipartUploadId })
          .catch((error: unknown) => {
            console.warn(
              `[artifact-jobs] abort expired multipart upload failed for ${row.id}:`,
              error instanceof Error ? error.message : error
            );
          });
      }
    }
  }
  return { purged };
}

async function loadArtifactOrThrow(artifactId: string): Promise<Artifact> {
  const artifact = await prisma.artifact.findUnique({ where: { id: artifactId } });
  if (!artifact) throw new Error("ARTIFACT_NOT_FOUND");
  return artifact;
}

/** True when this exact (artifact, stage, handler version) has already been
 * recorded. Handler dispatch is deterministic per (modality, version), so a
 * repeat run would write a byte-identical second evidence row — and evidence
 * that duplicates on retry is evidence nobody can count. */
async function alreadyRecorded(artifactId: string, stage: string, handlerVersion: string): Promise<boolean> {
  const existing = await prisma.artifactProcessingEvent.findFirst({
    where: { artifactId, stage, handlerVersion },
    select: { id: true },
  });
  return existing !== null;
}

/** `artifact.parse` handler. */
export async function runArtifactParseJob(artifactId: string): Promise<void> {
  const artifact = await loadArtifactOrThrow(artifactId);
  const handler = resolveHandler(artifact.modality);
  if (await alreadyRecorded(artifact.id, "parse", handler.version)) return;

  const result = await handler.parse(artifact);
  // DEFAULT_HANDLER's parse() always returns ok:false — that case is "no
  // verifier exists for this modality yet" (not_supported), which is a
  // different fact from a real handler failing on these actual bytes
  // (failed). Never conflate them: a fabricated `failed` on an unimplemented
  // modality misleadingly implies a check ran.
  const status = result.ok ? "passed" : handler === DEFAULT_HANDLER ? "not_supported" : "failed";
  await prisma.$transaction(async (tx) => {
    await tx.artifactProcessingEvent.create({
      data: {
        artifactId: artifact.id,
        stage: "parse",
        status,
        handlerVersion: handler.version,
        detail: { metadata: result.metadata, reason: result.reason ?? null } as Prisma.InputJsonValue,
      },
    });
    if (result.ok) {
      await tx.artifact.update({ where: { id: artifact.id }, data: { parserVersion: handler.version } });
    }
  });
}

/** `artifact.preview` handler. */
export async function runArtifactPreviewJob(artifactId: string): Promise<void> {
  const artifact = await loadArtifactOrThrow(artifactId);
  const handler = resolveHandler(artifact.modality);
  if (await alreadyRecorded(artifact.id, "preview", handler.version)) return;

  const result = await handler.preview(artifact);
  await prisma.artifactProcessingEvent.create({
    data: {
      artifactId: artifact.id,
      stage: "preview",
      status: result.status,
      handlerVersion: handler.version,
      detail: { reason: result.reason ?? null } as Prisma.InputJsonValue,
    },
  });
}

/**
 * Comparison-target lookup, ported from v1's `findSimilarityCandidates`:
 * scope candidates to the same bounty (never cross-bounty — that matches the
 * existing per-bounty dedupe scope), only `ready`/non-deleted siblings of the
 * same kind and modality, and only ones that sort *before* this artifact
 * (stable createdAt/id tiebreak) so two near-duplicates uploaded close
 * together cannot symmetrically flag each other before either has a settled
 * order.
 */
async function findSimilarityCandidates(artifact: Artifact): Promise<Artifact[]> {
  if (!artifact.bountyId) return [];
  return prisma.artifact.findMany({
    where: {
      bountyId: artifact.bountyId,
      kind: artifact.kind,
      modality: artifact.modality,
      status: ArtifactStatus.ready,
      deletedAt: null,
      id: { not: artifact.id },
      OR: [
        { createdAt: { lt: artifact.createdAt } },
        { createdAt: artifact.createdAt, id: { lt: artifact.id } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: SIMILARITY_CANDIDATE_CAP,
  });
}

const SIMILARITY_VERDICT_RANK: Record<string, number> = { clear: 0, advisory: 1, reject: 2 };

/** `artifact.similarity_check` handler. Records the WORST real verdict across
 * the candidate set; a handler with no comparison logic, or a bounty with no
 * prior sibling, records `not_supported` with the reason rather than `clear`. */
export async function runArtifactSimilarityJob(artifactId: string): Promise<void> {
  const artifact = await loadArtifactOrThrow(artifactId);
  const handler = resolveHandler(artifact.modality);
  if (await alreadyRecorded(artifact.id, "similarity_check", handler.version)) return;

  const candidates = await findSimilarityCandidates(artifact);
  let worst: SimilarityResult = {
    status: "not_supported",
    reason: candidates.length === 0 ? "no comparison candidates in this bounty yet" : undefined,
  };
  let comparedAgainst = 0;
  for (const candidate of candidates) {
    const result = await handler.similarityCheck(artifact, candidate);
    if (result.status !== "passed") continue;
    comparedAgainst += 1;
    const resultRank = SIMILARITY_VERDICT_RANK[result.verdict ?? "clear"] ?? 0;
    const worstRank = worst.status === "passed" ? SIMILARITY_VERDICT_RANK[worst.verdict ?? "clear"] ?? 0 : -1;
    if (resultRank >= worstRank) worst = result;
  }

  await prisma.artifactProcessingEvent.create({
    data: {
      artifactId: artifact.id,
      stage: "similarity_check",
      status: worst.status,
      handlerVersion: handler.version,
      detail: {
        verdict: worst.verdict ?? null,
        score: worst.score ?? null,
        reason: worst.reason ?? null,
        candidatesConsidered: candidates.length,
        candidatesCompared: comparedAgainst,
      } as Prisma.InputJsonValue,
    },
  });
}

/* ==========================================================================
 * Producers
 *
 * All three format-stage keys are `${artifactId}:${type}:${handler.version}`
 * (v1's scheme): a handler-version bump naturally produces a NEW idempotency
 * key rather than deduping against a stale result, so `resolveHandler()` is
 * the single source of truth for "current version" — never a literal copied
 * into a call site here.
 * ======================================================================== */

/** Fairness partition key for an artifact-scoped job: the artifact's own
 * tenant column, falling back to the owner's deterministic personal
 * workspace. Without the fallback every artifact job would collapse into the
 * shared "system" bucket, since no current call site populates workspaceId. */
function artifactWorkspaceKey(artifact: Pick<Artifact, "workspaceId" | "ownerUserId">): string | undefined {
  if (artifact.workspaceId) return artifact.workspaceId;
  return artifact.ownerUserId ? workspaceKeyForUser(artifact.ownerUserId) : undefined;
}

type FormatStageType = Extract<JobType, "artifact.parse" | "artifact.preview" | "artifact.similarity_check">;

async function enqueueFormatStage(
  type: FormatStageType,
  artifact: Pick<Artifact, "id" | "modality" | "workspaceId" | "ownerUserId">,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const handler = resolveHandler(artifact.modality);
  await enqueueJob(
    type,
    { artifactId: artifact.id },
    {
      idempotencyKey: `${artifact.id}:${type}:${handler.version}`,
      workspaceId: artifactWorkspaceKey(artifact),
      maxAttempts: 5,
      tx,
    }
  );
}

export function enqueueFormatParse(
  artifact: Pick<Artifact, "id" | "modality" | "workspaceId" | "ownerUserId">,
  tx?: Prisma.TransactionClient
): Promise<void> {
  return enqueueFormatStage("artifact.parse", artifact, tx);
}

export function enqueueFormatPreview(
  artifact: Pick<Artifact, "id" | "modality" | "workspaceId" | "ownerUserId">,
  tx?: Prisma.TransactionClient
): Promise<void> {
  return enqueueFormatStage("artifact.preview", artifact, tx);
}

export function enqueueFormatSimilarityCheck(
  artifact: Pick<Artifact, "id" | "modality" | "workspaceId" | "ownerUserId">,
  tx?: Prisma.TransactionClient
): Promise<void> {
  return enqueueFormatStage("artifact.similarity_check", artifact, tx);
}

/** Untenanted platform maintenance sweep. Five-minute idempotency bucket so
 * many workers ticking together still enqueue one purge per window. */
export async function enqueueExpiredUploadPurge(): Promise<void> {
  await enqueueJob(
    "artifact.purge_expired_uploads",
    {} as Record<string, never>,
    { idempotencyKey: `artifact.purge_expired_uploads:${Math.floor(Date.now() / 300_000)}`, maxAttempts: 3 }
  );
}

/** Stage evidence a ready artifact is expected to carry. */
const RECHECK_STAGES = ["parse", "preview", "similarity_check"] as const;

/**
 * Staleness sweep — the producer that makes a handler-version bump mean
 * something. For each recently-touched ready artifact of an eligible kind, it
 * compares the stage evidence on record against the version
 * `resolveHandler()` would use NOW, and enqueues only the stages that are
 * missing or stale.
 *
 * Deliberately query-driven rather than "enqueue three jobs on every upload":
 * the initial parse/preview evidence is already written inline by
 * `runArtifactScanJob` (it needs the parse result as a quarantine gate, so it
 * cannot defer it), and re-enqueueing those stages unconditionally would
 * either duplicate that evidence or dedupe into a no-op forever. What is
 * genuinely missing at scan time is `similarity_check` (it needs siblings) and
 * any stage whose handler has since been revised.
 */
export async function enqueueStaleFormatRechecks(limit = RECHECK_SCAN_BATCH): Promise<{ enqueued: number }> {
  const artifacts = await prisma.artifact.findMany({
    where: {
      status: ArtifactStatus.ready,
      deletedAt: null,
      kind: { in: FORMAT_REGISTRY_ELIGIBLE_KINDS },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, modality: true, workspaceId: true, ownerUserId: true },
  });
  if (artifacts.length === 0) return { enqueued: 0 };

  const events = await prisma.artifactProcessingEvent.findMany({
    where: { artifactId: { in: artifacts.map((a) => a.id) }, stage: { in: [...RECHECK_STAGES] } },
    select: { artifactId: true, stage: true, handlerVersion: true },
  });
  const recorded = new Set(events.map((e) => `${e.artifactId}:${e.stage}:${e.handlerVersion}`));

  let enqueued = 0;
  for (const artifact of artifacts) {
    const version = resolveHandler(artifact.modality).version;
    for (const stage of RECHECK_STAGES) {
      if (recorded.has(`${artifact.id}:${stage}:${version}`)) continue;
      const type: FormatStageType =
        stage === "parse" ? "artifact.parse" : stage === "preview" ? "artifact.preview" : "artifact.similarity_check";
      await enqueueFormatStage(type, artifact);
      enqueued += 1;
    }
  }
  return { enqueued };
}
