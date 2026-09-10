// SPDX-License-Identifier: Apache-2.0

/**
 * Lease/reclaim regression coverage for `dbJobQueue.claim` (services/jobs.ts).
 *
 * Before this fix, `claim()` marked a row `processing` with no expiry at all
 * — if the worker that claimed it crashed or was killed mid-handler (a real
 * risk for `validation.run`'s sandbox/LLM calls and `harness.proof_run`'s
 * sequential sandbox samples, both of which can hang or OOM-kill the
 * process), that row was stuck `processing` forever: never retried, never
 * dead-lettered, no operator-visible symptom beyond a silently growing count
 * of stale `processing` rows.
 *
 * These tests simulate the crash by claiming a job and then, instead of
 * calling `complete()`/`fail()`, writing a past `nextAttemptAt` directly via
 * Prisma (the pattern this codebase already uses elsewhere to fast-forward
 * time-dependent state without a real sleep — see the "reserved test-only job
 * type" note in the DataBounty CLAUDE.md's job-queue testing guidance). A
 * reserved, unhandled job type (`benchmark.run_evaluation`) is used so a live
 * worker process — should one ever be polling this same database — can never
 * race the assertions.
 */
import { afterAll, describe, expect, it } from "vitest";
import { JobStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { dbJobQueue, type JobType } from "./jobs.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

// Not in HANDLED_TYPES (worker.ts) and not a type any route ever enqueues in
// production — safe for a real concurrent worker/dev server to ignore.
const TEST_ONLY_TYPE: JobType = "benchmark.run_evaluation";

const createdJobIds: string[] = [];

afterAll(async () => {
  await prisma.jobQueue.deleteMany({ where: { id: { in: createdJobIds } } });
  await prisma.$disconnect();
});

async function seedJob(idempotencyKey: string) {
  const row = await prisma.jobQueue.create({
    data: {
      type: TEST_ONLY_TYPE,
      idempotencyKey,
      payload: {},
      status: JobStatus.pending,
      maxAttempts: 5,
    },
  });
  createdJobIds.push(row.id);
  return row;
}


/**
 * `claim()` returns the OLDEST row of the type, so a test that needs to claim
 * *its own* seeded row must first clear rows left behind by earlier tests in
 * this file (the enqueue test deliberately leaves a `pending` row). Scoped to
 * the reserved test-only type, which no route enqueues and no worker handles,
 * so this can never delete real work.
 */
async function isolate(keepJobId: string) {
  await prisma.jobQueue.deleteMany({ where: { type: TEST_ONLY_TYPE, id: { not: keepJobId } } });
}

describe("dbJobQueue.claim lease/reclaim", () => {
  it("reclaims a job whose lease has expired after a crashed worker never called complete()/fail()", async () => {
    const seeded = await seedJob(`jobs-lease-test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);

    // First claim — simulates the worker that is about to "crash": it takes
    // the job but never acks or fails it.
    const firstClaim = await dbJobQueue.claim([TEST_ONLY_TYPE], 1_000);
    expect(firstClaim?.id).toBe(seeded.id);
    expect(firstClaim?.attempts).toBe(1);

    const afterFirstClaim = await prisma.jobQueue.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(afterFirstClaim.status).toBe(JobStatus.processing);
    expect(afterFirstClaim.nextAttemptAt).not.toBeNull();

    // A second claim attempt immediately after must NOT reclaim it — the
    // lease is still live, so a still-running worker's job must not be
    // handed to a second worker.
    const raceClaim = await dbJobQueue.claim([TEST_ONLY_TYPE], 1_000);
    expect(raceClaim).toBeNull();

    // Simulate the lease expiring (i.e. simulate time passing past the crash)
    // by writing a past `nextAttemptAt` directly, rather than sleeping.
    await prisma.jobQueue.update({
      where: { id: seeded.id },
      data: { nextAttemptAt: new Date(Date.now() - 5_000) },
    });

    // The job is now reclaimable: same row, attempts incremented again.
    const reclaim = await dbJobQueue.claim([TEST_ONLY_TYPE], 60_000);
    expect(reclaim?.id).toBe(seeded.id);
    expect(reclaim?.attempts).toBe(2);
    expect(reclaim?.status).toBe(JobStatus.processing);

    const afterReclaim = await prisma.jobQueue.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(afterReclaim.status).toBe(JobStatus.processing);
    // The new lease should be roughly 60s out, not the stale expired one.
    expect(afterReclaim.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it("does not reclaim a job whose lease has not yet expired", async () => {
    const seeded = await seedJob(`jobs-lease-live-test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);

    const claimed = await dbJobQueue.claim([TEST_ONLY_TYPE], 5 * 60_000);
    expect(claimed?.id).toBe(seeded.id);

    const attempt = await dbJobQueue.claim([TEST_ONLY_TYPE], 5 * 60_000);
    expect(attempt).toBeNull();
  });

  it("completed jobs are never reclaimed even after their old lease window would have expired", async () => {
    const seeded = await seedJob(`jobs-lease-done-test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);

    const claimed = await dbJobQueue.claim([TEST_ONLY_TYPE], 1_000);
    expect(claimed?.id).toBe(seeded.id);
    await dbJobQueue.complete(seeded.id);

    // Backdate as if the (no-longer-relevant) lease had expired — a `done`
    // job must stay done regardless of `nextAttemptAt`.
    await prisma.jobQueue.update({ where: { id: seeded.id }, data: { nextAttemptAt: new Date(Date.now() - 5_000) } });

    const reclaim = await dbJobQueue.claim([TEST_ONLY_TYPE], 60_000);
    expect(reclaim).toBeNull();
  });
});

/**
 * Retry / dead-letter regression coverage — added 2026-09-02 after a V1 parity
 * audit found that `fail()` and `claim()` disagreed about the `failed` state.
 *
 * `fail()` parks a row as `failed` with an exponential backoff in
 * `nextAttemptAt`, but `claim()`'s WHERE matched only `pending` and
 * lease-expired `processing` — never `failed`. So a failed job was never
 * claimed again: `maxAttempts` (default 5) was effectively 1, every transient
 * error was permanent, and because a row could never fail a *second* time it
 * could never reach `dead` either, making the `job_dead_letter` critical alert
 * in services/watchdog.ts unreachable code. This matches v1's own claim CTE,
 * which claims the state explicitly.
 *
 * Nothing covered this path, which is how it survived. These tests fast-forward
 * the backoff by writing a past `nextAttemptAt` rather than sleeping, matching
 * the lease tests above.
 */
describe("dbJobQueue retry and dead-letter", () => {
  it("re-claims a failed job once its backoff has elapsed, and reaches dead at maxAttempts", async () => {
    const seeded = await seedJob(`jobs-retry-test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
    await prisma.jobQueue.update({ where: { id: seeded.id }, data: { maxAttempts: 2 } });
    await isolate(seeded.id);

    // Attempt 1 → fail. `attempts` is incremented by claim(), so it is 1 here.
    const first = await dbJobQueue.claim([TEST_ONLY_TYPE], 60_000);
    expect(first?.id).toBe(seeded.id);
    expect(first?.attempts).toBe(1);
    await dbJobQueue.fail(seeded.id, "transient failure #1");

    const afterFirstFail = await prisma.jobQueue.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(afterFirstFail.status).toBe(JobStatus.failed);
    expect(afterFirstFail.lastError).toContain("transient failure #1");
    // Not dead yet: attempts (1) < maxAttempts (2), so a backoff is stamped.
    expect(afterFirstFail.nextAttemptAt).not.toBeNull();

    // While the backoff is in the future the row must stay invisible.
    expect(await dbJobQueue.claim([TEST_ONLY_TYPE], 60_000)).toBeNull();

    // Fast-forward the backoff.
    await prisma.jobQueue.update({
      where: { id: seeded.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });

    // THE REGRESSION: before the fix this returned null forever.
    const second = await dbJobQueue.claim([TEST_ONLY_TYPE], 60_000);
    expect(second?.id).toBe(seeded.id);
    expect(second?.attempts).toBe(2);

    // Second failure hits maxAttempts → terminal `dead`, no further backoff.
    await dbJobQueue.fail(seeded.id, "transient failure #2");
    const afterSecondFail = await prisma.jobQueue.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(afterSecondFail.status).toBe(JobStatus.dead);
    expect(afterSecondFail.nextAttemptAt).toBeNull();
    expect(afterSecondFail.finishedAt).not.toBeNull();

    // A dead row is terminal: it must never be claimed again.
    expect(await dbJobQueue.claim([TEST_ONLY_TYPE], 60_000)).toBeNull();
  });

  it("stamps nextAttemptAt on enqueue so the watchdog's age-based backlog alarms can see the row", async () => {
    const key = `jobs-nextattempt-test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const id = await dbJobQueue.enqueue({ type: TEST_ONLY_TYPE, idempotencyKey: key, payload: {} });
    createdJobIds.push(id);

    const row = await prisma.jobQueue.findUniqueOrThrow({ where: { id } });
    // Previously NULL for every producer that omits `runAfter`, which made
    // watchdog.ts's `nextAttemptAt: { lte: now }` filter skip the row and left
    // `oldestPendingAgeMs` permanently null.
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.status).toBe(JobStatus.pending);
  });

  it("does not re-arm a job a worker is currently holding", async () => {
    const key = `jobs-rearm-test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const id = await dbJobQueue.enqueue({ type: TEST_ONLY_TYPE, idempotencyKey: key, payload: { pass: 1 } });
    createdJobIds.push(id);

    await isolate(id);

    const claimed = await dbJobQueue.claim([TEST_ONLY_TYPE], 60_000);
    expect(claimed?.id).toBe(id);

    // A second producer enqueues the same idempotency key mid-flight. Before
    // the fix the upsert flipped this row back to `pending`, so another worker
    // could claim it and run the handler concurrently with itself — and a
    // `done` row could be resurrected. `bulk_source.parse` is shared by two
    // producers on one key, which is exactly where that double-write landed.
    const sameId = await dbJobQueue.enqueue({ type: TEST_ONLY_TYPE, idempotencyKey: key, payload: { pass: 2 } });
    expect(sameId).toBe(id);

    const row = await prisma.jobQueue.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(JobStatus.processing);
    expect(row.attempts).toBe(1);
    // Payload untouched: the in-flight handler keeps the input it claimed.
    expect(row.payload).toEqual({ pass: 1 });

    // And it is not claimable while held.
    expect(await dbJobQueue.claim([TEST_ONLY_TYPE], 60_000)).toBeNull();
  });

  it("re-arms an idle failed job and resets its retry budget", async () => {
    const key = `jobs-rearm-idle-test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const id = await dbJobQueue.enqueue({ type: TEST_ONLY_TYPE, idempotencyKey: key, payload: { pass: 1 } });
    createdJobIds.push(id);

    await isolate(id);

    const claimed = await dbJobQueue.claim([TEST_ONLY_TYPE], 60_000);
    expect(claimed?.id).toBe(id);
    await dbJobQueue.fail(id, "boom");
    expect((await prisma.jobQueue.findUniqueOrThrow({ where: { id } })).status).toBe(JobStatus.failed);

    // An explicit re-arm (format-registry sweep, draft re-attach, policy
    // change) must give the row a fresh attempt budget — otherwise a row
    // sitting at attempts=maxAttempts is re-armed straight back to `dead`.
    const sameId = await dbJobQueue.enqueue({ type: TEST_ONLY_TYPE, idempotencyKey: key, payload: { pass: 2 } });
    expect(sameId).toBe(id);

    const row = await prisma.jobQueue.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(JobStatus.pending);
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.payload).toEqual({ pass: 2 });
  });
});
