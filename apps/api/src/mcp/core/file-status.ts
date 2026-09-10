// SPDX-License-Identifier: Apache-2.0

import { BulkParseStatus, JobStatus, type Artifact } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { resolveHandler } from "../../services/format-registry/registry.js";

/**
 * The read-side detail v1's `get_file_status` / `get_file_processing_checks`
 * return, rebuilt from the rows this service already stores.
 *
 * Community's two tools had collapsed to "the raw artifact row" and "three
 * scalars", which is a materially weaker honesty contract than v1's: an agent
 * could not tell a stage that PASSED from one that never ran, could not see a
 * partial bulk ingest, and had nothing to pace its polling with, so it polled
 * in a loop.
 *
 * Everything below is derived from real persisted state — `Artifact.bulkParse*`
 * (schema.prisma), `JobQueue` (its `startedAt`/`finishedAt` columns exist
 * precisely "to compute the completion estimates the API hands back to
 * callers"), and `ArtifactProcessingEvent`. Nothing is invented: where a fact
 * is genuinely not recorded, the field is `null` with a stated basis rather
 * than a plausible-looking number, and a stage that is not `passed` is never
 * reported as passed.
 *
 * NOTE (honest gap): v1 sources these blocks from REST routes that Community
 * does not have; `services/job-eta.ts` is referenced by schema.prisma's own
 * comment but does not exist in this tree. The ETA is therefore computed here,
 * in the MCP layer, from the same columns such a service would read. If a
 * shared ETA service later lands, this is the call site to move onto it.
 */

/** Terminal job states — nothing more will happen without a re-enqueue. */
const SETTLED: JobStatus[] = [JobStatus.done, JobStatus.failed, JobStatus.dead, JobStatus.cancelled];

/** Floor for a recheck hint, so a client never busy-polls a queue. */
const MIN_RECHECK_SECONDS = 5;
/** Used only when nothing comparable has ever been measured; reported as
 *  `basis: "no_samples"` so the caller knows it is a provisional floor. */
const UNMEASURED_JOB_MS = 15_000;
const ETA_SAMPLE_SIZE = 20;

export interface JobEta {
  recheckAfterSeconds: number | null;
  estimatedReadyAt: string | null;
  /** "measured" = derived from real recent runs; "no_samples" = provisional
   *  floor, nothing of this type has finished yet; "settled" = nothing queued;
   *  "not_queued" = no job row exists for this work at all. */
  basis: "measured" | "no_samples" | "settled" | "not_queued";
}

const NOT_QUEUED: JobEta = { recheckAfterSeconds: null, estimatedReadyAt: null, basis: "not_queued" };
const SETTLED_ETA: JobEta = { recheckAfterSeconds: null, estimatedReadyAt: null, basis: "settled" };

type JobRow = {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
};

async function findJob(idempotencyKey: string): Promise<JobRow | null> {
  return prisma.jobQueue.findUnique({
    where: { idempotencyKey },
    select: {
      id: true,
      type: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      nextAttemptAt: true,
      lastError: true,
      createdAt: true,
    },
  });
}

/** Median measured duration of recent completed runs of this job type, or
 *  null when none has ever finished. Median, not mean: one pathological run
 *  must not double every subsequent estimate. */
async function measuredJobDurationMs(type: string): Promise<number | null> {
  const samples = await prisma.jobQueue.findMany({
    where: { type, status: JobStatus.done, startedAt: { not: null }, finishedAt: { not: null } },
    orderBy: { finishedAt: "desc" },
    take: ETA_SAMPLE_SIZE,
    select: { startedAt: true, finishedAt: true },
  });
  const durations = samples
    .map((s) => s.finishedAt!.getTime() - s.startedAt!.getTime())
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  return durations[Math.floor(durations.length / 2)]!;
}

async function etaForJob(job: JobRow | null): Promise<JobEta> {
  if (!job) return NOT_QUEUED;
  if (SETTLED.includes(job.status)) return SETTLED_ETA;
  const [measured, ahead] = await Promise.all([
    measuredJobDurationMs(job.type),
    prisma.jobQueue.count({
      where: { type: job.type, status: JobStatus.pending, createdAt: { lt: job.createdAt } },
    }),
  ]);
  const perJobMs = measured ?? UNMEASURED_JOB_MS;
  const waitMs = perJobMs * (ahead + 1);
  return {
    recheckAfterSeconds: Math.max(MIN_RECHECK_SECONDS, Math.ceil(waitMs / 1000)),
    estimatedReadyAt: new Date(Date.now() + waitMs).toISOString(),
    basis: measured === null ? "no_samples" : "measured",
  };
}

/** The same persisted-job estimate used for upload work, applied to a
 * submission validation run. A missing row is deliberately reported as
 * `not_queued`, never turned into an invented wait time. */
export async function validationEtaForSubmission(submissionId: string): Promise<JobEta> {
  const job = await prisma.jobQueue.findFirst({
    where: { type: "validation.run", idempotencyKey: { startsWith: `val:${submissionId}:` } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      nextAttemptAt: true,
      lastError: true,
      createdAt: true,
    },
  });
  return etaForJob(job);
}

export interface IngestBlock extends JobEta {
  status: BulkParseStatus;
  /** Lines read from the source so far. Null until the parser records one. */
  rowCount: number | null;
  /** Items actually created from those lines. */
  created: number;
  /** Lines read but unusable. `done` with `skipped > 0` is a PARTIAL ingest. */
  skipped: number;
  error: string | null;
}

export interface ScanProgressBlock {
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  /** True when the scan can no longer make progress on its own and an
   *  operator has to intervene — poll no further, tell the operator. */
  blocked: boolean;
  message: string | null;
}

/** Bulk-source ingest progress, or null when this artifact is not a
 *  many-item source (so an agent never reads "0 rows created" off a file that
 *  was never meant to be ingested). */
export async function ingestBlockFor(artifact: Artifact): Promise<IngestBlock | null> {
  if (artifact.bulkParseStatus === BulkParseStatus.not_applicable) return null;
  const job = await findJob(`bulk_source.parse:${artifact.id}`);
  const eta =
    artifact.bulkParseStatus === BulkParseStatus.done || artifact.bulkParseStatus === BulkParseStatus.failed
      ? SETTLED_ETA
      : await etaForJob(job);
  return {
    status: artifact.bulkParseStatus,
    rowCount: artifact.bulkParseRowCount,
    created: artifact.bulkParseCreated,
    skipped: artifact.bulkParseSkippedRows,
    error: artifact.bulkParseError,
    ...eta,
  };
}

/** Malware/file-signature scan retry state, or null when no scan job exists
 *  for this artifact (never uploaded, or the kind requires no scan). */
export async function scanProgressFor(artifactId: string): Promise<ScanProgressBlock | null> {
  const job = await findJob(`scan:${artifactId}`);
  if (!job) return null;
  const blocked = job.status === JobStatus.dead || (job.status === JobStatus.failed && job.attempts >= job.maxAttempts);
  return {
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt ? job.nextAttemptAt.toISOString() : null,
    blocked,
    message: job.lastError,
  };
}

/**
 * The three format-registry stages, in the order they run. Job type and
 * `ArtifactProcessingEvent.stage` share these names (see
 * `services/jobs/artifact-jobs.ts`).
 */
export const PROCESSING_STAGES = ["parse", "preview", "similarity_check"] as const;
export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

/** v1's six honest states. `not_supported` and `stale` are NOT passes. */
export type ProcessingStageStatus = "passed" | "failed" | "not_supported" | "stale" | "pending" | "missing";

export interface ProcessingStageResult {
  stage: ProcessingStage;
  status: ProcessingStageStatus;
  /** The handler version that produced the recorded result, if any. */
  handlerVersion: string | null;
  /** The handler version that would run today. A mismatch is what makes a
   *  recorded pass `stale`. */
  currentHandlerVersion: string;
  ranAt: string | null;
  detail: unknown;
}

/**
 * Per-stage results for one artifact, derived from the newest
 * `ArtifactProcessingEvent` per stage plus the live handler version.
 *
 * A stage with no event is `pending` when its job is still queued and
 * `missing` when nothing has ever been enqueued — the distinction v1 draws
 * and Community's three scalars could not express at all.
 */
export async function processingChecksFor(
  artifact: Pick<Artifact, "id" | "modality">,
): Promise<ProcessingStageResult[]> {
  const handler = resolveHandler(artifact.modality);
  const events = await prisma.artifactProcessingEvent.findMany({
    where: { artifactId: artifact.id, stage: { in: [...PROCESSING_STAGES] } },
    orderBy: { createdAt: "desc" },
  });

  const results: ProcessingStageResult[] = [];
  for (const stage of PROCESSING_STAGES) {
    const latest = events.find((e) => e.stage === stage);
    if (!latest) {
      // No result recorded. Is the work queued, or was it never asked for?
      const job = await findJob(`${artifact.id}:artifact.${stage}:${handler.version}`);
      results.push({
        stage,
        status: job && !SETTLED.includes(job.status) ? "pending" : "missing",
        handlerVersion: null,
        currentHandlerVersion: handler.version,
        ranAt: null,
        detail: null,
      });
      continue;
    }
    // A recorded `passed` from a superseded handler is reported as `stale`,
    // never as a pass: the checker changed, so the result no longer reflects
    // the logic that would run now.
    const recorded = latest.status;
    const status: ProcessingStageStatus =
      recorded === "passed" && latest.handlerVersion !== handler.version
        ? "stale"
        : (["passed", "failed", "not_supported", "stale", "pending"] as const).includes(recorded as never)
          ? (recorded as ProcessingStageStatus)
          : "missing";
    results.push({
      stage,
      status,
      handlerVersion: latest.handlerVersion,
      currentHandlerVersion: handler.version,
      ranAt: latest.createdAt.toISOString(),
      detail: latest.detail,
    });
  }
  return results;
}
