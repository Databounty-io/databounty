// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for three previously dead notification functions in
 * services/notifications.ts — emitNewWorkMatches, emitAuditAvailableMatches,
 * and notifyValidationStageResults were all fully written and exported, but
 * grep found zero call sites anywhere in the codebase: contributors never
 * got alerted when new matching work appeared, validators never got alerted
 * when audit work became claimable, and no per-stage validation evidence
 * ever reached a contributor's inbox.
 *
 * This suite exercises the REAL trigger points these were wired into (v1
 * parity — see each call site's own doc comment for the v1 file:line it
 * mirrors), not the notification functions in isolation:
 *
 *  - emitNewWorkMatches:        POST /v1/admin/community/requests/:id/implement
 *                                (routes/v1/admin-community.ts) — the moment
 *                                a community bounty is minted and opens to
 *                                the pool.
 *  - emitAuditAvailableMatches: runPoolSamplingJob (services/pool-lifecycle.ts)
 *                                — the moment pool close-out opens one or
 *                                more claimable HumanAuditWindows.
 *  - notifyValidationStageResults: runSubmissionValidation
 *                                (services/validation.ts) — every completed
 *                                validation run, terminal or not.
 *
 * Same harness/self-guard pattern as the other *.integration.test.ts files
 * in this directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  AuditMode,
  DatasetCategory,
  GenerationMethod,
  SubmissionStatus,
  AuthMethod,
  ArtifactKind,
  ArtifactStatus,
  SponsorExampleReviewStatus,
} from "@prisma/client";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { deleteAuditRowsForBounties } from "./test-support/audit-cleanup.js";
import { runPoolSamplingJob } from "./services/pool-lifecycle.js";
import { runWatcherFanoutJob } from "./services/notifications.js";
import { dbJobQueue, type WatcherFanoutPayload } from "./services/jobs.js";
import { runSubmissionValidation } from "./services/validation.js";
import { putArtifactData } from "./services/storage.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();


/**
 * Watcher fan-out is DURABLE (v1 parity): the trigger points enqueue one
 * `notifications.fanout_watchers` row and the worker expands it. These tests
 * exercise the trigger, so they must also play the worker — otherwise they
 * would only prove that a job row was written.
 *
 * Targeted by idempotency key rather than a generic `dbJobQueue.claim()` loop:
 * `claim` is oldest-first and this shared verification database accumulates
 * fan-out rows from earlier runs, so a generic drain spends its budget on
 * unrelated jobs and never reaches the one under test.
 */
async function runFanoutJobByKey(idempotencyKey: string, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const job = await prisma.jobQueue.findUnique({ where: { idempotencyKey } });
    if (job) {
      fanoutJobKeys.push(idempotencyKey);
      await runWatcherFanoutJob(job.payload as unknown as WatcherFanoutPayload);
      await dbJobQueue.complete(job.id);
      return true;
    }
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const fanoutJobKeys: string[] = [];

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdDatasetTypeIds: string[] = [];
const createdRequestIds: string[] = [];
const createdBountyIds: string[] = [];
const createdArtifactIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  await prisma.artifact.deleteMany({ where: { id: { in: createdArtifactIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.watchPref.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.humanAuditWindowMembership.deleteMany({ where: { window: { bountyId: { in: createdBountyIds } } } });
  // Audit rows BEFORE the window delete (a window references its batch) and
  // before the submission delete (`audit_items.submission_id` is ON DELETE
  // RESTRICT, v1's constraint — it is what stops a submission delete from
  // erasing the record of who audited it). Pool close-out now routes sampled
  // items into real AuditBatch/AuditItem rows, so any suite that closes a pool
  // and then deletes its submissions must clear these or the teardown fails
  // with `audit_items_submission_id_fkey`.
  await deleteAuditRowsForBounties(createdBountyIds);
  await prisma.humanAuditWindow.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.validationResult.deleteMany({ where: { submission: { bountyId: { in: createdBountyIds } } } });
  await prisma.submission.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.bounty.deleteMany({
    where: { OR: [{ id: { in: createdBountyIds } }, { requesterUserId: { in: createdUserIds } }, { communityRequesterUserId: { in: createdUserIds } }] },
  });
  await prisma.datasetRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: createdDatasetTypeIds } } });
  await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  // Queue rows this suite produced: the fan-out jobs it ran, and the
  // leaderboard rank checks awardKarma enqueues for its fixture users.
  await prisma.jobQueue.deleteMany({ where: { idempotencyKey: { in: fanoutJobKeys } } });
  for (const userId of createdUserIds) {
    await prisma.jobQueue.deleteMany({
      where: { type: "leaderboard.rank_check", idempotencyKey: { startsWith: `leaderboard.rank_check:${userId}:` } },
    });
  }
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function signupAdmin(emailPrefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${emailPrefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${emailPrefix}${stamp}`.slice(0, 30), displayName: emailPrefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  await prisma.userRole.create({ data: { userId, role: "admin" } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

async function seedFixtureUser(prefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await prisma.user.create({
    data: { authMethod: AuthMethod.email, email: `${prefix}-${stamp}@local.test`, displayName: prefix },
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function seedDatasetType(params: { id: string }) {
  const type = await prisma.datasetType.create({
    data: {
      id: params.id,
      domain: "coding",
      name: `Notification Wiring Fixture Type ${params.id}`,
      description: "Fixture dataset type for the notification-wiring integration test.",
      status: "active",
      origin: "platform",
      category: "implementation",
      trustTier: "llm_verified",
      fields: [{ key: "instruction", label: "Instruction", role: "instruction", required: true }],
      verification: { pipeline: ["schema", "human_audit"], dedupeFields: ["instruction"], auditOptions: [25, 100] },
      difficultyLevels: ["beginner", "intermediate", "advanced"],
      complexityScore: 2,
      verificationUnits: 1,
    },
  });
  createdDatasetTypeIds.push(type.id);
  return type.id;
}

describe("emitNewWorkMatches fires from POST /community/requests/:id/implement", () => {
  it("notifies a matching watcher, but never the request's own requester", async () => {
    const { cookie } = await signupAdmin("wiringmint");
    const requesterUserId = await seedFixtureUser("wiring-requester");
    const watcherUserId = await seedFixtureUser("wiring-watcher");
    const nonMatchingWatcherId = await seedFixtureUser("wiring-nonmatch");

    await prisma.watchPref.create({
      data: {
        userId: watcherUserId,
        enabled: true,
        domains: ["coding"],
        categories: ["implementation"],
        languages: ["TypeScript"],
      },
    });
    // Same domain, but a category/language that will never match this
    // fixture's request — proves the fan-out is a real filter, not "everyone
    // with watch enabled".
    await prisma.watchPref.create({
      data: {
        userId: nonMatchingWatcherId,
        enabled: true,
        domains: ["coding"],
        categories: ["debugging"],
        languages: ["Rust"],
      },
    });

    const datasetTypeId = await seedDatasetType({ id: `wiring_mint_${Date.now()}` });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const request = await prisma.datasetRequest.create({
      data: {
        requesterUserId,
        title: `Notification wiring fixture request ${stamp}`,
        description: "Fixture request for the emitNewWorkMatches wiring test.",
        datasetTypeId,
        proposedLicense: "CC-BY-4.0",
        language: "TypeScript",
        framework: "Node.js",
        targetItems: 50,
        difficultyMix: "balanced",
        auditCoveragePct: 10,
        idempotencyKey: `wiring-mint-fixture-${stamp}`,
        status: "approved",
      },
    });
    createdRequestIds.push(request.id);

    // Owner decision, 2026-09-09 (admin-community.ts /implement): a pool
    // cannot mint without at least one approved sponsor_reference sample on
    // the request. Without this fixture, /implement now returns 409
    // "no_samples" instead of minting — unrelated to this suite's actual
    // subject (emitNewWorkMatches), so it is satisfied here rather than
    // worked around.
    const sampleStorageKey = `artifacts/sponsor_reference/fixture-wiring/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    await putArtifactData(
      sampleStorageKey,
      Buffer.from(JSON.stringify({ instruction: "Fixture reference sample for the emitNewWorkMatches wiring test." }), "utf8"),
      "application/json"
    );
    const sampleArtifact = await prisma.artifact.create({
      data: {
        kind: ArtifactKind.sponsor_reference,
        status: ArtifactStatus.ready,
        sponsorReviewStatus: SponsorExampleReviewStatus.approved,
        ownerUserId: requesterUserId,
        datasetRequestId: request.id,
        filename: "sample.json",
        contentType: "application/json",
        storageKey: sampleStorageKey,
      },
    });
    createdArtifactIds.push(sampleArtifact.id);

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/community/requests/${request.id}/implement`,
      headers: { cookie, origin: "http://localhost:3010", "content-type": "application/json" },
      payload: { targetItems: 50 },
    });
    expect(res.statusCode).toBe(201);
    const bountyId = res.json().bounty.id as string;
    createdBountyIds.push(bountyId);

    // The mint route enqueues the fan-out post-commit and does not await it,
    // so poll for the row, then play the worker that expands it.
    expect(await runFanoutJobByKey(`fanout:new_work_match:${bountyId}`, 20_000)).toBe(true);
    const matched = await waitFor(
      () => prisma.notification.findFirst({ where: { userId: watcherUserId, eventKey: `work.new_match:${bountyId}` } }),
      30_000
    );
    expect(matched).toBeTruthy();
    expect(matched!.type).toBe("work.new_match");

    const nonMatch = await prisma.notification.findFirst({
      where: { userId: nonMatchingWatcherId, eventKey: `work.new_match:${bountyId}` },
    });
    expect(nonMatch).toBeNull();

    const sponsorNotified = await prisma.notification.findFirst({
      where: { userId: requesterUserId, eventKey: `work.new_match:${bountyId}` },
    });
    expect(sponsorNotified).toBeNull();
  }, 45_000);
});

describe("emitAuditAvailableMatches fires from runPoolSamplingJob", () => {
  it("notifies a matching validator watcher when a HumanAuditWindow opens, never the pool's own requester", async () => {
    const requesterUserId = await seedFixtureUser("wiring-audit-requester");
    const contributorUserId = await seedFixtureUser("wiring-audit-contributor");
    const validatorWatcherId = await seedFixtureUser("wiring-audit-watcher");

    await prisma.watchPref.create({
      data: {
        userId: validatorWatcherId,
        enabled: true,
        domains: ["coding"],
        categories: [DatasetCategory.debugging],
        languages: ["typescript"],
      },
    });

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const bounty = await prisma.bounty.create({
      data: {
        requesterUserId,
        title: `wiring audit-available fixture ${stamp}`,
        description: "fixture pool for the emitAuditAvailableMatches wiring test",
        datasetCategory: DatasetCategory.debugging,
        language: "typescript",
        framework: "none",
        targetItems: BigInt(5),
        auditMode: AuditMode.partial,
        auditCoveragePct: 100,
        holdDays: 0,
        karmaPerAcceptedItem: 25,
        acceptedItems: BigInt(5),
        poolClosedAt: new Date(),
      },
    });
    createdBountyIds.push(bounty.id);

    await prisma.submission.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        bountyId: bounty.id,
        contributorUserId,
        title: `wiring fixture item ${i}`,
        payloadJson: { i },
        generationMethod: GenerationMethod.human,
        status: SubmissionStatus.accepted_pending_sample,
      })),
    });

    const outcome = await runPoolSamplingJob(bounty.id);
    expect(outcome.skipped).toBe(false);
    if (!outcome.skipped) expect(outcome.selectedCount).toBeGreaterThan(0);

    // Same as above: sampling enqueues the validator-side fan-out post-commit.
    expect(await runFanoutJobByKey(`fanout:audit_available:${bounty.id}`)).toBe(true);

    const matched = await waitFor(() =>
      prisma.notification.findFirst({ where: { userId: validatorWatcherId, eventKey: `audit.available:${bounty.id}` } })
    );
    expect(matched).toBeTruthy();
    expect(matched!.type).toBe("audit.available");

    const sponsorNotified = await prisma.notification.findFirst({
      where: { userId: requesterUserId, eventKey: `audit.available:${bounty.id}` },
    });
    expect(sponsorNotified).toBeNull();
  }, 20_000);
});

describe("notifyValidationStageResults fires from runSubmissionValidation", () => {
  it("records one idempotent inbox event per stage the pipeline actually ran", async () => {
    const requesterUserId = await seedFixtureUser("wiring-validation-requester");
    const contributorUserId = await seedFixtureUser("wiring-validation-contributor");

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const bounty = await prisma.bounty.create({
      data: {
        requesterUserId,
        title: `wiring validation-stage fixture ${stamp}`,
        description: "fixture pool for the notifyValidationStageResults wiring test",
        datasetCategory: DatasetCategory.debugging,
        language: "typescript",
        framework: "none",
        targetItems: BigInt(1),
        // requiredSponsorExamples must stay BELOW targetItems: the
        // `bounties_required_sponsor_examples_bounds` CHECK (restored from V1 by
        // migration 20260902100000) rejects the schema default of 3 on a
        // small-target fixture pool like this one.
        requiredSponsorExamples: 0,
        auditMode: AuditMode.partial,
        auditCoveragePct: 10,
        holdDays: 0,
        karmaPerAcceptedItem: 25,
      },
    });
    createdBountyIds.push(bounty.id);

    // No datasetTypeId: runSubmissionValidation's execution stage correctly
    // treats a submission with no dataset-type contract as "no executable
    // harness" (honest not-attempted, not a failure) — the same
    // accepted_pending_sample + pendingHumanReview exit this test asserts
    // fired a stage-result notification from.
    const submission = await prisma.submission.create({
      data: {
        bountyId: bounty.id,
        contributorUserId,
        title: `wiring validation fixture item ${stamp}`,
        payloadJson: { instruction: "fixture" },
        generationMethod: GenerationMethod.human,
        status: SubmissionStatus.submitted,
      },
    });

    await runSubmissionValidation(submission.id, 0);

    const steps = await prisma.notification.findMany({
      where: { userId: contributorUserId, type: "validation.stage_result" },
      orderBy: { createdAt: "asc" },
    });
    // dedupe + ai_attribution + execution, per the "execution not
    // available" branch this fixture is built to exercise. notifyEvent (like
    // v1's) renders title/body from the per-call data at write time but does
    // not persist that structured data on the row itself — only
    // digest.summary does — so the stage/outcome are asserted from the
    // eventKey suffix (`${type}:${keyBase}:${stage}`, keyBase embeds the
    // attempt number) and from the rendered title/body text, exactly what a
    // real recipient would see in their inbox.
    expect(steps.length).toBeGreaterThanOrEqual(3);

    const eventKeys = steps.map((s) => s.eventKey);
    expect(eventKeys).toContain("validation.stage_result:validation:0:dedupe");
    expect(eventKeys).toContain("validation.stage_result:validation:0:ai_attribution");
    expect(eventKeys).toContain("validation.stage_result:validation:0:execution");

    const executionStep = steps.find((s) => s.eventKey === "validation.stage_result:validation:0:execution");
    expect(executionStep!.title).toContain("execution");
    expect(executionStep!.title.toLowerCase()).toContain("pending");

    // Idempotency: re-running the SAME validation attempt must not create a
    // second copy of any of these rows (unique on userId+eventKey, keyed by
    // keyBase which embeds the attempt number).
    await runSubmissionValidation(submission.id, 0);
    const stepsAfterReplay = await prisma.notification.findMany({
      where: { userId: contributorUserId, type: "validation.stage_result" },
    });
    expect(stepsAfterReplay).toHaveLength(steps.length);
  }, 20_000);
});

/** Bounded poll for the async, post-commit fan-out (fanOutWatchers is
 * deliberately fired outside any request/business transaction — see
 * notifications.ts's own doc comment — so it can still be finishing its
 * per-recipient writes for a moment after inject()/the caller resolves). */
async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5_000): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
