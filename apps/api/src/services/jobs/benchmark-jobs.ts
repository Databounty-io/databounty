// SPDX-License-Identifier: Apache-2.0

/**
 * Benchmark release + evaluation job handlers.
 *
 * Ported from v1 `src/services/benchmark-jobs.ts`. Without this module the
 * `benchmark.version_build` job that `routes/v1/admin-benchmarks.ts`
 * (`POST /benchmarks/:id/versions`) already enqueues had no consumer, so every
 * authored release sat in `building` forever — an admin sees a release that
 * never freezes and no reason why.
 *
 * PRIVATE-HOLDOUT INVARIANT (unchanged from v1): the queue payload carries an
 * IDENTIFIER only (`{ benchmarkVersionId }` / `{ benchmarkRunId }`). Private
 * holdout material is resolved here, inside the trusted worker, from the
 * database. This module also has no artifact-download dependency — do not add
 * the private manifest or a task payload to `services/artifacts.ts` read paths.
 *
 * PORT DIVERGENCE (one, deliberate, documented): v1's source-eligibility gate
 * requires BOTH a passed `execution` and a passed `contamination_check`
 * ValidationResult. This rebuild removed external-corpus plagiarism screening
 * from the pipeline entirely (see the `ValidationResult.stage` and
 * `SubmissionStatus.contamination_check` comments in prisma/schema.prisma — no
 * code path writes that stage any more), so porting that clause verbatim would
 * make EVERY release permanently ineligible. The equivalent live screening
 * stage here is `dedupe` (v1's own name for it), so that is what is required alongside
 * `execution`. This keeps the gate real (a release still cannot be built from
 * unscreened items) instead of trading a fail-closed check for a vacuous one.
 */
import { createHash } from "node:crypto";
import {
  BenchmarkRunStatus,
  BenchmarkTaskSplit,
  BenchmarkVersionStatus,
  Prisma,
  SubmissionStatus,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { enqueueJob } from "../jobs.js";

const MAX_RELEASE_TASKS = 500;

/** Ineligible manifest / ineligible source: a permanent condition no retry can
 * change. Distinguished from an infrastructure error so the handler can record
 * a terminal `failed` release instead of burning the retry budget. */
export class BenchmarkReleaseError extends Error {}

type ManifestCandidate = {
  submissionId: string;
  split: BenchmarkTaskSplit;
  taskKey: string;
  ordinal: number;
  /** Public-only, non-sensitive display material. Never accepted for private tasks. */
  publicMetadata?: Prisma.JsonValue;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function parseCandidates(value: Prisma.JsonValue): ManifestCandidate[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BenchmarkReleaseError("source manifest must be an object");
  }
  const raw = (value as Record<string, unknown>).candidates;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RELEASE_TASKS) {
    throw new BenchmarkReleaseError(`source manifest must contain 1-${MAX_RELEASE_TASKS} candidates`);
  }
  const candidates = raw.map((item, index): ManifestCandidate => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BenchmarkReleaseError(`candidate ${index} is invalid`);
    }
    const candidate = item as Record<string, unknown>;
    const split = candidate.split;
    if (
      typeof candidate.submissionId !== "string" ||
      !candidate.submissionId ||
      typeof candidate.taskKey !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(candidate.taskKey) ||
      typeof candidate.ordinal !== "number" ||
      !Number.isInteger(candidate.ordinal) ||
      (split !== "public_sample" && split !== "private_holdout")
    ) {
      throw new BenchmarkReleaseError(`candidate ${index} is invalid`);
    }
    // Private task metadata is deliberately REJECTED rather than silently
    // stripped: a malformed release must fail closed and be fixed by an
    // administrator, not produce an ambiguous public/private boundary.
    if (split === "private_holdout" && candidate.publicMetadata !== undefined) {
      throw new BenchmarkReleaseError(`private candidate ${candidate.taskKey} cannot include publicMetadata`);
    }
    return {
      submissionId: candidate.submissionId,
      split,
      taskKey: candidate.taskKey,
      ordinal: Number(candidate.ordinal),
      publicMetadata: candidate.publicMetadata as Prisma.JsonValue | undefined,
    };
  });
  const keys = new Set(candidates.map((c) => c.taskKey));
  const ordinals = new Set(candidates.map((c) => c.ordinal));
  if (keys.size !== candidates.length || ordinals.size !== candidates.length) {
    throw new BenchmarkReleaseError("task keys and ordinals must be unique");
  }
  if (!candidates.some((c) => c.split === "private_holdout")) {
    throw new BenchmarkReleaseError("release requires at least one private holdout task");
  }
  return candidates;
}

/**
 * Producer. `routes/v1/admin-benchmarks.ts` writes its own queue row inside the
 * version-creation transaction (it must, so the release row and the job commit
 * together); this is the standalone re-arm an explicit admin retry needs.
 */
export async function enqueueBenchmarkVersionBuild(
  benchmarkVersionId: string,
  actorUserId: string | null = null,
  transaction?: Prisma.TransactionClient
): Promise<void> {
  const enqueue = async (tx: Prisma.TransactionClient) => {
    const version = await tx.benchmarkVersion.findUnique({
      where: { id: benchmarkVersionId },
      select: { id: true, status: true, benchmark: { select: { status: true } } },
    });
    if (!version) throw new BenchmarkReleaseError("benchmark version not found");
    if (version.benchmark.status === "archived") {
      throw new BenchmarkReleaseError("cannot build a version for an archived benchmark");
    }
    if (version.status === BenchmarkVersionStatus.draft) {
      await tx.benchmarkVersion.update({
        where: { id: version.id },
        data: { status: BenchmarkVersionStatus.building },
      });
      await writeAuditLog(tx, {
        actorUserId,
        action: "benchmark.version_build_queued",
        targetType: "benchmark_version",
        targetId: version.id,
        before: { status: BenchmarkVersionStatus.draft },
        after: { status: BenchmarkVersionStatus.building },
      });
    } else if (version.status !== BenchmarkVersionStatus.building) {
      throw new BenchmarkReleaseError(`cannot queue build from ${version.status}`);
    }
    await enqueueJob(
      "benchmark.version_build",
      { benchmarkVersionId: version.id },
      { idempotencyKey: `benchmark.version_build:${version.id}`, maxAttempts: 3, tx }
    );
  };
  if (transaction) return enqueue(transaction);
  await prisma.$transaction(enqueue);
}

/**
 * `benchmark.version_build` handler: materialize immutable task snapshots.
 *
 * Validates EVERY selected source before making any task visible, and a retry
 * only accepts byte-for-byte identical existing tasks — it can never rewrite a
 * release after it has been frozen.
 */
export async function buildBenchmarkVersion(benchmarkVersionId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const version = await tx.benchmarkVersion.findUnique({
        where: { id: benchmarkVersionId },
        include: { benchmark: { select: { status: true } } },
      });
      // Not `building` → already frozen, failed, or never queued. Ack rather
      // than re-freeze: the status IS the idempotency guard.
      if (!version || version.status !== BenchmarkVersionStatus.building) return;
      if (version.benchmark.status === "archived") {
        throw new BenchmarkReleaseError("benchmark was archived during build");
      }
      const candidates = parseCandidates(version.sourceManifest);
      const submissions = await tx.submission.findMany({
        where: { id: { in: candidates.map((c) => c.submissionId) } },
        include: {
          validationResults: {
            select: { id: true, stage: true, passed: true, score: true, detailJson: true, createdAt: true },
          },
        },
      });
      const byId = new Map(submissions.map((s) => [s.id, s]));

      for (const candidate of candidates) {
        const source = byId.get(candidate.submissionId);
        if (!source) throw new BenchmarkReleaseError(`source submission ${candidate.submissionId} not found`);
        if (source.status !== SubmissionStatus.accepted) {
          throw new BenchmarkReleaseError(`source submission ${source.id} is not accepted`);
        }
        // See the PORT DIVERGENCE note at the top of this file for why the
        // second required stage is `dedupe` and not v1's
        // `contamination_check`.
        const execution = source.validationResults.some((r) => r.stage === "execution" && r.passed);
        const screened = source.validationResults.some((r) => r.stage === "dedupe" && r.passed);
        if (!execution || !screened) {
          throw new BenchmarkReleaseError(
            `source submission ${source.id} lacks passed execution/duplicate-check evidence`
          );
        }

        const validationEvidence = source.validationResults.map((r) => ({
          id: r.id,
          stage: r.stage,
          passed: r.passed,
          score: r.score,
          detail: r.detailJson,
          createdAt: r.createdAt.toISOString(),
        }));
        // A release must pin an immutable revision snapshot, never the mutable
        // live Submission row. `upsert ... update: {}` means an existing
        // snapshot is reused verbatim rather than rewritten.
        const revision = await tx.submissionRevision.upsert({
          where: {
            submissionId_revisionNumber: { submissionId: source.id, revisionNumber: source.revisionCount },
          },
          create: {
            submissionId: source.id,
            revisionNumber: source.revisionCount,
            title: source.title,
            payloadJson:
              source.payloadJson === null ? Prisma.JsonNull : (source.payloadJson as Prisma.InputJsonValue),
            generationMethod: source.generationMethod,
            status: source.status,
            duplicateScore: source.duplicateScore,
            contaminationScore: source.contaminationScore,
            llmScore: source.llmScore,
            validationEvidence: validationEvidence as Prisma.InputJsonValue,
          },
          update: {},
        });
        const sourcePayloadSha256 = sha256(revision.payloadJson);
        const provenanceEvidence = {
          sourceSubmissionId: source.id,
          sourceRevisionId: revision.id,
          sourceRevisionNumber: revision.revisionNumber,
          sourceStatus: source.status,
          acceptedAt: source.acceptedAt?.toISOString() ?? null,
          validationEvidenceSha256: sha256(revision.validationEvidence),
          sourcePayloadSha256,
        };
        // Private tasks carry HASHES and ids only — never the holdout payload.
        const privateEvidence =
          candidate.split === BenchmarkTaskSplit.private_holdout
            ? {
                sourcePayloadSha256,
                sourceRevisionId: revision.id,
                validationEvidenceSha256: sha256(revision.validationEvidence),
              }
            : undefined;
        const existing = await tx.benchmarkTask.findUnique({
          where: { benchmarkVersionId_taskKey: { benchmarkVersionId: version.id, taskKey: candidate.taskKey } },
        });
        if (existing) {
          if (
            existing.sourceSubmissionRevisionId !== revision.id ||
            existing.split !== candidate.split ||
            existing.ordinal !== candidate.ordinal ||
            existing.sourcePayloadSha256 !== sourcePayloadSha256
          ) {
            throw new BenchmarkReleaseError(
              `existing task ${candidate.taskKey} does not match immutable release manifest`
            );
          }
          continue;
        }
        await tx.benchmarkTask.create({
          data: {
            benchmarkVersionId: version.id,
            sourceSubmissionId: source.id,
            sourceSubmissionRevisionId: revision.id,
            split: candidate.split,
            ordinal: candidate.ordinal,
            taskKey: candidate.taskKey,
            sourcePayloadSha256,
            publicMetadata:
              candidate.split === BenchmarkTaskSplit.public_sample
                ? (candidate.publicMetadata ?? undefined) as Prisma.InputJsonValue | undefined
                : undefined,
            privateEvidence: privateEvidence as Prisma.InputJsonValue | undefined,
            provenanceEvidence: provenanceEvidence as Prisma.InputJsonValue,
          },
        });
      }
      const publicTaskCount = candidates.filter((c) => c.split === BenchmarkTaskSplit.public_sample).length;
      const privateTaskCount = candidates.length - publicTaskCount;
      await tx.benchmarkVersion.update({
        where: { id: version.id },
        data: {
          status: BenchmarkVersionStatus.validating,
          taskCount: candidates.length,
          publicTaskCount,
          privateTaskCount,
          frozenAt: new Date(),
        },
      });
      await writeAuditLog(tx, {
        actorUserId: null,
        action: "benchmark.version_tasks_frozen",
        targetType: "benchmark_version",
        targetId: version.id,
        before: { status: BenchmarkVersionStatus.building },
        after: {
          status: BenchmarkVersionStatus.validating,
          taskCount: candidates.length,
          publicTaskCount,
          privateTaskCount,
        },
        metadata: { sourceManifestSha256: version.sourceManifestSha256 },
      });
    },
    { timeout: 30_000 }
  );
}

/** Producer. Enqueue a real run only for an already-published immutable release. */
export async function enqueueBenchmarkEvaluation(benchmarkRunId: string): Promise<void> {
  const run = await prisma.benchmarkRun.findUnique({
    where: { id: benchmarkRunId },
    select: { id: true, status: true, benchmarkVersion: { select: { status: true } } },
  });
  if (!run) throw new BenchmarkReleaseError("benchmark run not found");
  if (run.status !== BenchmarkRunStatus.pending) {
    throw new BenchmarkReleaseError(`cannot queue evaluation from ${run.status}`);
  }
  if (run.benchmarkVersion.status !== BenchmarkVersionStatus.published) {
    throw new BenchmarkReleaseError("only published benchmark versions can be evaluated");
  }
  await enqueueJob(
    "benchmark.run_evaluation",
    { benchmarkRunId: run.id },
    { idempotencyKey: `benchmark.run_evaluation:${run.id}`, maxAttempts: 1 }
  );
}

/**
 * `benchmark.run_evaluation` handler.
 *
 * Deliberately fail-closed until a contract-tested sandbox evaluator exists
 * (identical posture to v1's `failClosedBenchmarkEvaluation`): it records an
 * honest terminal failure with an explicit `BENCHMARK_EVALUATOR_UNAVAILABLE`
 * code and NEVER invents a score. A stage that did not run must never be
 * recorded as a pass.
 */
export async function failClosedBenchmarkEvaluation(benchmarkRunId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const run = await tx.benchmarkRun.findUnique({
      where: { id: benchmarkRunId },
      select: { id: true, status: true },
    });
    if (!run || run.status !== BenchmarkRunStatus.pending) return;
    const evidence = {
      code: "BENCHMARK_EVALUATOR_UNAVAILABLE",
      message: "No healthy contract-tested benchmark evaluator is configured.",
      at: new Date().toISOString(),
    };
    await tx.benchmarkRun.update({
      where: { id: run.id },
      data: { status: BenchmarkRunStatus.failed, failureEvidence: evidence, completedAt: new Date() },
    });
    await writeAuditLog(tx, {
      actorUserId: null,
      action: "benchmark.evaluation_failed_closed",
      targetType: "benchmark_run",
      targetId: run.id,
      result: "failed",
      before: { status: run.status },
      after: { status: BenchmarkRunStatus.failed },
      metadata: evidence,
    });
  });
}

/** A malformed manifest or ineligible source is not retryable. Preserve the
 * failed release as evidence rather than leaving it apparently `building`, or
 * burning queue retries that cannot change the underlying facts. */
export async function markBenchmarkVersionBuildFailed(
  benchmarkVersionId: string,
  error: unknown
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.benchmarkVersion.findUnique({
      where: { id: benchmarkVersionId },
      select: { status: true },
    });
    if (!current || current.status !== BenchmarkVersionStatus.building) return;
    const message = error instanceof Error ? error.message : String(error);
    const evidence = {
      code:
        error instanceof BenchmarkReleaseError
          ? "BENCHMARK_RELEASE_INELIGIBLE"
          : "BENCHMARK_RELEASE_BUILD_EXHAUSTED",
      message: message.slice(0, 1000),
      at: new Date().toISOString(),
    };
    await tx.benchmarkVersion.update({
      where: { id: benchmarkVersionId },
      data: { status: BenchmarkVersionStatus.failed, failedAt: new Date(), failureEvidence: evidence },
    });
    await writeAuditLog(tx, {
      actorUserId: null,
      action: "benchmark.version_build_failed",
      targetType: "benchmark_version",
      targetId: benchmarkVersionId,
      result: "failed",
      before: { status: current.status },
      after: { status: BenchmarkVersionStatus.failed },
      metadata: evidence,
    });
  });
}

/**
 * Worker entry point for `benchmark.version_build`. Wraps
 * {@link buildBenchmarkVersion} with v1's terminal-failure policy, which the
 * central dispatch in `src/worker.ts` cannot express on its own:
 *
 *   - a `BenchmarkReleaseError` is PERMANENT — record the release as `failed`
 *     and let the job ack, so the admin console shows the real reason instead
 *     of a release stuck in `building` while the queue retries a manifest that
 *     can never become valid;
 *   - anything else is treated as transient and rethrown so `dbJobQueue.fail`
 *     applies its backoff — except on the LAST attempt, where the release is
 *     also marked failed so a dead job never leaves a permanently stale
 *     `building` status behind.
 */
export async function runBenchmarkVersionBuildJob(
  benchmarkVersionId: string,
  job: { attempts: number; maxAttempts: number }
): Promise<void> {
  try {
    await buildBenchmarkVersion(benchmarkVersionId);
  } catch (error) {
    if (error instanceof BenchmarkReleaseError) {
      await markBenchmarkVersionBuildFailed(benchmarkVersionId, error);
      return;
    }
    if (job.attempts >= job.maxAttempts) {
      await markBenchmarkVersionBuildFailed(benchmarkVersionId, error);
    }
    throw error;
  }
}
