// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the two benchmark job handlers (services/jobs/benchmark-jobs.ts).
 *
 * Why this file exists: `routes/v1/admin-benchmarks.ts`
 * (`POST /benchmarks/:id/versions`) has been writing real
 * `benchmark.version_build` queue rows, and nothing consumed them — every
 * authored release sat in `building` forever with no visible reason. These
 * tests exercise the handler through the queue exactly as `src/worker.ts` does,
 * and pin the two properties that matter most:
 *
 *   1. an ELIGIBLE release actually freezes (status `validating`, immutable
 *      `BenchmarkTask` snapshots, private tasks carrying hashes only);
 *   2. an INELIGIBLE release fails CLOSED and terminally — recorded as
 *      `failed` with real evidence, never left looking like it is still
 *      building and never silently frozen from unscreened sources.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuditMode,
  AuthMethod,
  BenchmarkRunStatus,
  BenchmarkVersionStatus,
  DatasetCategory,
  GenerationMethod,
  SubmissionStatus,
} from "@prisma/client";
import { prisma } from "./lib/prisma.js";
import { dbJobQueue, type JobType } from "./services/jobs.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";
import {
  enqueueBenchmarkVersionBuild,
  failClosedBenchmarkEvaluation,
  runBenchmarkVersionBuildJob,
} from "./services/jobs/benchmark-jobs.js";

requireDisposableDatabase();

const createdUserIds: string[] = [];
const createdBountyIds: string[] = [];
const createdBenchmarkIds: string[] = [];
const createdJobKeys: string[] = [];

let ownerUserId = "";
let acceptedSubmissionIds: string[] = [];
let unscreenedSubmissionId = "";

async function seedUser(prefix: string): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await prisma.user.create({
    data: { authMethod: AuthMethod.email, email: `${prefix}-${stamp}@local.test`, displayName: prefix },
  });
  createdUserIds.push(user.id);
  return user.id;
}

/** An accepted item with the evidence a release requires: a passed `execution`
 * result and a passed `dedupe` result (this rebuild's live screening
 * stage — see the PORT DIVERGENCE note in services/jobs/benchmark-jobs.ts). */
async function seedAcceptedSubmission(
  bountyId: string,
  contributorUserId: string,
  label: string,
  opts: { screened?: boolean } = {}
): Promise<string> {
  const submission = await prisma.submission.create({
    data: {
      bountyId,
      contributorUserId,
      title: `benchmark fixture ${label}`,
      payloadJson: { instruction: `fixture ${label}`, answer: label },
      generationMethod: GenerationMethod.human,
      status: SubmissionStatus.accepted,
      acceptedAt: new Date(),
    },
  });
  await prisma.validationResult.create({
    data: { submissionId: submission.id, stage: "execution", passed: true, score: 1 },
  });
  if (opts.screened !== false) {
    await prisma.validationResult.create({
      data: { submissionId: submission.id, stage: "dedupe", passed: true, score: 0 },
    });
  }
  return submission.id;
}

async function seedBenchmarkVersion(params: {
  candidates: unknown[];
  status?: BenchmarkVersionStatus;
}): Promise<{ benchmarkId: string; versionId: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const benchmark = await prisma.benchmark.create({
    data: {
      slug: `bench-fixture-${stamp}`,
      title: `Benchmark job fixture ${stamp}`,
      supportedDomains: ["coding"],
      createdByUserId: ownerUserId,
    },
  });
  createdBenchmarkIds.push(benchmark.id);
  const sourceManifest = { candidates: params.candidates };
  const version = await prisma.benchmarkVersion.create({
    data: {
      benchmarkId: benchmark.id,
      version: 1,
      status: params.status ?? BenchmarkVersionStatus.building,
      contract: { scoring: "exact_match" },
      sourceManifest: sourceManifest as never,
      sourceManifestSha256: `fixture-${stamp}`,
      createdByUserId: ownerUserId,
    },
  });
  return { benchmarkId: benchmark.id, versionId: version.id };
}

/** Claim + run + complete one job of `type`, the way src/worker.ts does.
 * Targeted by idempotency key because this shared verification database
 * accumulates queue rows from other suites and `claim()` is oldest-first. */
async function runQueuedJob(type: JobType, idempotencyKey: string): Promise<boolean> {
  const row = await prisma.jobQueue.findUnique({ where: { idempotencyKey } });
  if (!row || row.type !== type) return false;
  createdJobKeys.push(idempotencyKey);
  const payload = row.payload as { benchmarkVersionId: string };
  await runBenchmarkVersionBuildJob(payload.benchmarkVersionId, {
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
  });
  await dbJobQueue.complete(row.id);
  return true;
}

beforeAll(async () => {
  ownerUserId = await seedUser("bench-owner");
  const contributorUserId = await seedUser("bench-contributor");
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: ownerUserId,
      title: `benchmark source pool ${stamp}`,
      description: "fixture pool supplying benchmark release sources",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(3),
      // requiredSponsorExamples must stay BELOW targetItems: the
      // `bounties_required_sponsor_examples_bounds` CHECK (restored from V1 by
      // migration 20260902100000) rejects the schema default of 3 on a
      // small-target fixture pool like this one.
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 0,
      holdDays: 0,
      karmaPerAcceptedItem: 10,
    },
  });
  createdBountyIds.push(bounty.id);
  acceptedSubmissionIds = [
    await seedAcceptedSubmission(bounty.id, contributorUserId, "public-a"),
    await seedAcceptedSubmission(bounty.id, contributorUserId, "private-b"),
  ];
  unscreenedSubmissionId = await seedAcceptedSubmission(bounty.id, contributorUserId, "unscreened", {
    screened: false,
  });
});

afterAll(async () => {
  await prisma.jobQueue.deleteMany({ where: { idempotencyKey: { in: createdJobKeys } } });
  await prisma.benchmarkRunTaskResult.deleteMany({
    where: { benchmarkRun: { benchmarkVersion: { benchmarkId: { in: createdBenchmarkIds } } } },
  });
  await prisma.benchmarkRun.deleteMany({
    where: { benchmarkVersion: { benchmarkId: { in: createdBenchmarkIds } } },
  });
  await prisma.benchmarkTask.deleteMany({
    where: { benchmarkVersion: { benchmarkId: { in: createdBenchmarkIds } } },
  });
  await prisma.benchmarkVersion.deleteMany({ where: { benchmarkId: { in: createdBenchmarkIds } } });
  await prisma.benchmark.deleteMany({ where: { id: { in: createdBenchmarkIds } } });
  await prisma.submissionRevision.deleteMany({ where: { submission: { bountyId: { in: createdBountyIds } } } });
  await prisma.validationResult.deleteMany({ where: { submission: { bountyId: { in: createdBountyIds } } } });
  await prisma.submission.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  for (const userId of createdUserIds) {
    await prisma.jobQueue.deleteMany({
      where: { idempotencyKey: { startsWith: `leaderboard.rank_check:${userId}:` } },
    });
  }
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("benchmark.version_build", () => {
  it("freezes an eligible release into immutable tasks, and is idempotent on re-run", async () => {
    const { versionId } = await seedBenchmarkVersion({
      candidates: [
        { submissionId: acceptedSubmissionIds[0], split: "public_sample", taskKey: "task-a", ordinal: 1, publicMetadata: { hint: "sample" } },
        { submissionId: acceptedSubmissionIds[1], split: "private_holdout", taskKey: "task-b", ordinal: 2 },
      ],
    });

    // Goes through the real producer, so the queue row this asserts on is the
    // one a caller would actually create.
    await enqueueBenchmarkVersionBuild(versionId, ownerUserId);
    expect(await runQueuedJob("benchmark.version_build", `benchmark.version_build:${versionId}`)).toBe(true);

    const frozen = await prisma.benchmarkVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(frozen.status).toBe(BenchmarkVersionStatus.validating);
    expect(frozen.taskCount).toBe(2);
    expect(frozen.publicTaskCount).toBe(1);
    expect(frozen.privateTaskCount).toBe(1);
    expect(frozen.frozenAt).not.toBeNull();
    expect(frozen.failureEvidence).toBeNull();

    const tasks = await prisma.benchmarkTask.findMany({
      where: { benchmarkVersionId: versionId },
      orderBy: { ordinal: "asc" },
    });
    expect(tasks.map((t) => t.taskKey)).toEqual(["task-a", "task-b"]);
    // Every task pins an immutable revision snapshot, not the live row.
    for (const task of tasks) expect(task.sourceSubmissionRevisionId).toBeTruthy();
    // The private-holdout invariant: identifiers and hashes only, never the
    // holdout payload, and no public display metadata.
    const privateTask = tasks[1]!;
    expect(privateTask.publicMetadata).toBeNull();
    const privateEvidence = privateTask.privateEvidence as Record<string, unknown>;
    expect(Object.keys(privateEvidence).sort()).toEqual([
      "sourcePayloadSha256",
      "sourceRevisionId",
      "validationEvidenceSha256",
    ]);
    expect(JSON.stringify(privateEvidence)).not.toContain("fixture private-b");

    // Re-running is a no-op: the release is no longer `building`, so nothing is
    // re-frozen and no duplicate task appears.
    await runBenchmarkVersionBuildJob(versionId, { attempts: 1, maxAttempts: 3 });
    const afterReplay = await prisma.benchmarkTask.count({ where: { benchmarkVersionId: versionId } });
    expect(afterReplay).toBe(2);
    expect((await prisma.benchmarkVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe(
      BenchmarkVersionStatus.validating
    );
  }, 30_000);

  it("fails a release CLOSED and terminally when a source lacks passed screening evidence", async () => {
    const { versionId } = await seedBenchmarkVersion({
      candidates: [
        { submissionId: unscreenedSubmissionId, split: "private_holdout", taskKey: "task-x", ordinal: 1 },
      ],
    });

    await enqueueBenchmarkVersionBuild(versionId, ownerUserId);
    // The handler swallows the permanent error on purpose: the job acks and the
    // RELEASE carries the failure, instead of the queue retrying a manifest
    // that can never become valid.
    expect(await runQueuedJob("benchmark.version_build", `benchmark.version_build:${versionId}`)).toBe(true);

    const failed = await prisma.benchmarkVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(failed.status).toBe(BenchmarkVersionStatus.failed);
    expect(failed.failedAt).not.toBeNull();
    const evidence = failed.failureEvidence as { code: string; message: string };
    expect(evidence.code).toBe("BENCHMARK_RELEASE_INELIGIBLE");
    expect(evidence.message).toContain("duplicate-check");
    // Nothing was made visible.
    expect(await prisma.benchmarkTask.count({ where: { benchmarkVersionId: versionId } })).toBe(0);
  }, 30_000);

  it("refuses a manifest with no private holdout task", async () => {
    const { versionId } = await seedBenchmarkVersion({
      candidates: [
        { submissionId: acceptedSubmissionIds[0], split: "public_sample", taskKey: "task-only", ordinal: 1 },
      ],
    });
    await runBenchmarkVersionBuildJob(versionId, { attempts: 1, maxAttempts: 3 });
    const failed = await prisma.benchmarkVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(failed.status).toBe(BenchmarkVersionStatus.failed);
    expect((failed.failureEvidence as { message: string }).message).toContain("private holdout");
  }, 30_000);
});

describe("benchmark.run_evaluation", () => {
  it("records an honest unavailable-evaluator failure instead of inventing a score", async () => {
    const { versionId } = await seedBenchmarkVersion({
      candidates: [
        { submissionId: acceptedSubmissionIds[1], split: "private_holdout", taskKey: "task-run", ordinal: 1 },
      ],
      status: BenchmarkVersionStatus.published,
    });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const run = await prisma.benchmarkRun.create({
      data: {
        benchmarkVersionId: versionId,
        idempotencyKey: `bench-run-fixture-${stamp}`,
        modelProvider: "fixture",
        modelName: "fixture-model",
        modelConfig: {},
        evaluatorImage: "fixture:latest",
        scoringProfile: {},
        requestedByUserId: ownerUserId,
      },
    });

    await failClosedBenchmarkEvaluation(run.id);

    const settled = await prisma.benchmarkRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(settled.status).toBe(BenchmarkRunStatus.failed);
    // The whole point: no score, and an explicit reason.
    expect(settled.score).toBeNull();
    expect(settled.passedTaskCount).toBe(0);
    expect((settled.failureEvidence as { code: string }).code).toBe("BENCHMARK_EVALUATOR_UNAVAILABLE");
  }, 30_000);
});
