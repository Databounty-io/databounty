// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the contributor revise loop
 * (routes/v1/submissions.ts POST /:id/revise -> services/submissions.ts
 * reviseSubmission).
 *
 * Two defects are covered, and they only make sense together:
 *
 *  1. The revisable-state set. `reviseSubmission` used to gate on
 *     `needs_fixes` alone, which is written in exactly one place (the
 *     sponsor-review reject path, reachable only when a pool sets
 *     auditCoveragePct = 0). The two rejection paths that actually occur —
 *     `tests_failed` (services/validation.ts) and validator-`flagged`
 *     (services/audits.ts) — were dead ends.
 *
 *  2. The revision cap. Widening (1) without a cap turns the revise loop into
 *     an unbounded free-labour loop. The cap is claimed with a single atomic
 *     conditional UPDATE, so the concurrency test below is the point of the
 *     whole design: a read-then-check would let both callers past the gate.
 *
 * Same harness and self-guard as pipeline.integration.test.ts: Fastify
 * inject() against buildApp(), no port bound, refuses to run outside the
 * disposable verification database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { DEFAULT_MAX_REVISIONS } from "./services/submissions.js";
import { putArtifactData } from "./services/storage.js";
import { ArtifactKind, ArtifactStatus, SponsorExampleReviewStatus } from "@prisma/client";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

const MAX_REVISIONS_KEY = "submissions.max_revisions";

let app: FastifyInstance;
/** Whatever the settings row held before this file ran, so a concurrently
 * running suite (or a developer's local override) is restored afterwards
 * rather than silently wiped — the teardown footgun that has bitten other
 * suites in this codebase. */
let settingSnapshot: { existed: boolean; value: unknown } = { existed: false, value: null };

beforeAll(async () => {
  const row = await prisma.adminSetting.findUnique({ where: { key: MAX_REVISIONS_KEY } });
  settingSnapshot = { existed: Boolean(row), value: row?.value ?? null };
  // These tests assert the DEFAULT cap, so make sure no row is overriding it.
  if (row) await prisma.adminSetting.delete({ where: { key: MAX_REVISIONS_KEY } });
});

afterAll(async () => {
  if (settingSnapshot.existed) {
    await prisma.adminSetting.upsert({
      where: { key: MAX_REVISIONS_KEY },
      create: { key: MAX_REVISIONS_KEY, value: settingSnapshot.value as never },
      update: { value: settingSnapshot.value as never },
    });
  } else {
    await prisma.adminSetting.deleteMany({ where: { key: MAX_REVISIONS_KEY } });
  }
  await prisma.$disconnect();
});

// A fresh app per test gives each test its own in-memory AUTH_RATE_LIMIT
// bucket (10 signups/min, hardcoded on the route — see auth.ts). Sharing one
// instance across this file's 8 tests means the up-to-4 signups each test
// does via seedRevisableSubmission/signupVerified stack up past the cap
// within the file's few-second runtime, self-exhausting the bucket and
// failing later tests with 429s that have nothing to do with the revision
// logic under test.
beforeEach(async () => {
  app = await buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/**
 * Owner decision, 2026-09-09 (admin-community.ts): a community request can no
 * longer be minted with zero approved sponsor_reference samples — both mint
 * routes now return 409 "no_samples" until at least one is approved. Seeds
 * that precondition directly (bypassing the upload-slot/complete/scan
 * lifecycle and the admin sponsor-review action, which are covered
 * elsewhere — see pipeline.integration.test.ts's identical helper) since
 * this file's fixtures only need the gate cleared, not the review flow
 * itself exercised.
 */
async function seedApprovedSample(requestId: string, ownerUserId: string) {
  const storageKey = `artifacts/sponsor_reference/revision-fixture/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await putArtifactData(
    storageKey,
    Buffer.from(JSON.stringify({ instruction: "Fixture reference sample for submission-revision.integration.test.ts." }), "utf8"),
    "application/json",
  );
  await prisma.artifact.create({
    data: {
      kind: ArtifactKind.sponsor_reference,
      status: ArtifactStatus.ready,
      sponsorReviewStatus: SponsorExampleReviewStatus.approved,
      ownerUserId,
      datasetRequestId: requestId,
      filename: "sample.json",
      contentType: "application/json",
      storageKey,
    },
  });
}

async function signupVerified(emailPrefix: string) {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email,
      password: "Test@12345",
      handle: `${emailPrefix}${Date.now()}${Math.floor(Math.random() * 1000)}`,
      displayName: emailPrefix,
    },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

function payload(seed: string) {
  return {
    prompt: `fix bug ${seed}`,
    broken_code: `function f(a,b){ return a+b+1; } // ${seed}`,
    fixed_code: `function f(a,b){ return a+b; }\nmodule.exports = { f }; // ${seed}`,
    tests:
      "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { f } = require('./solution.js');\ntest('adds', () => { assert.strictEqual(f(2,3), 5); });",
    explanation: `revision fixture ${seed}`,
    bug_type: "off_by_one",
  };
}

/** Mints a live pool with room to spare (target 50, one item submitted) so it
 * never auto-closes, and returns one submission the test can push into any
 * status it needs. Validation jobs are deliberately NOT drained. */
async function seedRevisableSubmission(prefix: string) {
  const { userId: adminId, cookie: adminCookie } = await signupVerified(`${prefix}admin`);
  await prisma.userRole.create({ data: { userId: adminId, role: "admin" } });
  const { userId: contributorId, cookie: contributorCookie } = await signupVerified(`${prefix}contrib`);
  // A DISTINCT pool requester, so the sponsor-facing notification on the
  // cap-exceeded path has a real second recipient to land on.
  const { userId: requesterId, cookie: requesterCookie } = await signupVerified(`${prefix}req`);

  const reqRes = await app.inject({
    method: "POST",
    url: "/v1/community/requests",
    headers: { cookie: requesterCookie, origin: "http://localhost:3010" },
    payload: {
      title: `Revise Loop Pool ${prefix}`,
      description: "Fixture pool for the contributor revise-loop integration tests.",
      datasetTypeId: "debugging",
      domain: "coding",
      targetItems: 50,
      auditCoveragePct: 10,
    },
  });
  expect(reqRes.statusCode).toBe(201);

  const requestId = reqRes.json().request.id as string;
  // /mint now refuses a request that has not been approved (its status gate
  // was brought to parity with /community/requests/:id/implement — see
  // routes/v1/admin-community.ts). This fixture is not exercising the review
  // loop, so approve the request directly in the database rather than driving
  // an admin decision through the API: /dataset-requests/:id/review would also
  // award the requester 25 approval karma and write notification rows that
  // this test's own assertions do not expect.
  await prisma.datasetRequest.update({ where: { id: requestId }, data: { status: "approved" } });
  await seedApprovedSample(requestId, requesterId);

  const mintRes = await app.inject({
    method: "POST",
    url: `/v1/admin/dataset-requests/${requestId}/mint`,
    headers: { cookie: adminCookie, origin: "http://localhost:3010" },
    payload: {
      title: `Revise Loop Pool ${prefix}`,
      description: "Minted pool for the contributor revise-loop integration tests.",
      targetItems: 50,
      karmaPerAcceptedItem: 25,
      auditCoveragePct: 10,
    },
  });
  expect(mintRes.statusCode).toBe(201);
  const bountyId = mintRes.json().bounty.id as string;

  // The submission row is created DIRECTLY rather than through
  // POST /v1/submissions on purpose. The intake route enqueues a real
  // `validation.run` job, and the job queue is global: any pending row of that
  // type can be claimed by whichever process drains next — including
  // pipeline.integration.test.ts, running in parallel, which asserts on an
  // exact drained count. Seeding the row here keeps this file's fixtures out
  // of a queue it does not own. What is under test is the revise gate, not
  // intake, which pipeline.integration.test.ts already covers.
  const submission = await prisma.submission.create({
    data: {
      bountyId,
      contributorUserId: contributorId,
      title: `${prefix} item`,
      payloadJson: payload(`${prefix}-v0`),
      generationMethod: "human",
      dedupeKey: `revfixture-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "submitted",
    },
  });

  return {
    bountyId,
    contributorId,
    contributorCookie,
    requesterId,
    submissionId: submission.id,
  };
}

/** Fires the revise request and immediately clears the `validation.run` job it
 * enqueues, for the same shared-queue reason as above. The job's existence is
 * asserted before deletion in the first test, so this cleanup never hides
 * whether the loop actually re-queues validation. */
async function reviseRequest(submissionId: string, cookie: string, seed: string) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/submissions/${submissionId}/revise`,
    headers: { cookie, origin: "http://localhost:3010" },
    payload: { payloadJson: payload(seed) },
  });
  const where = { type: "validation.run", idempotencyKey: { startsWith: `val:${submissionId}:` } } as const;
  const enqueued = await prisma.jobQueue.findMany({ where, select: { idempotencyKey: true, status: true } });
  await prisma.jobQueue.deleteMany({ where });
  return Object.assign(res, { enqueuedJobs: enqueued });
}

async function rerunRequest(submissionId: string, cookie: string) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/submissions/${submissionId}/rerun-validation`,
    headers: { cookie, origin: "http://localhost:3010" },
  });
  const where = { type: "validation.run", idempotencyKey: { startsWith: `val:${submissionId}:attempt:` } } as const;
  const enqueued = await prisma.jobQueue.findMany({ where, select: { idempotencyKey: true } });
  await prisma.jobQueue.deleteMany({ where });
  return Object.assign(res, { enqueuedJobs: enqueued });
}

describe("revise loop reachability", () => {
  it("lets a contributor revise an item that failed execution (tests_failed)", async () => {
    const fx = await seedRevisableSubmission("revtf");
    await prisma.submission.update({
      where: { id: fx.submissionId },
      data: { status: "tests_failed" },
    });

    const res = await reviseRequest(fx.submissionId, fx.contributorCookie, "revtf-fix");
    expect(res.statusCode).toBe(200);
    expect(res.json().submission.status).toBe("submitted");

    const after = await prisma.submission.findUnique({ where: { id: fx.submissionId } });
    expect(after?.status).toBe("submitted");
    expect(after?.revisionCount).toBe(1);

    // The revision is archived and the corrected payload is re-queued for a
    // real validation run — the loop actually closes, it does not just flip a
    // status.
    const snapshots = await prisma.submissionRevision.findMany({ where: { submissionId: fx.submissionId } });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.revisionNumber).toBe(1);
    expect(snapshots[0]!.status).toBe("tests_failed");

    expect(res.enqueuedJobs.map((j) => j.idempotencyKey)).toContain(`val:${fx.submissionId}:1`);
  }, 30_000);

  it("lets a contributor revise an item a validator flagged", async () => {
    const fx = await seedRevisableSubmission("revfl");
    await prisma.submission.update({
      where: { id: fx.submissionId },
      data: { status: "flagged" },
    });

    const res = await reviseRequest(fx.submissionId, fx.contributorCookie, "revfl-fix");
    expect(res.statusCode).toBe(200);

    const after = await prisma.submission.findUnique({ where: { id: fx.submissionId } });
    expect(after?.status).toBe("submitted");
    expect(after?.revisionCount).toBe(1);
  }, 30_000);

  it("still refuses a status that is genuinely not contributor-actionable", async () => {
    const fx = await seedRevisableSubmission("revblk");
    await prisma.submission.update({
      where: { id: fx.submissionId },
      data: { status: "in_audit" },
    });

    const res = await reviseRequest(fx.submissionId, fx.contributorCookie, "revblk-fix");
    expect(res.statusCode).toBe(409);

    const after = await prisma.submission.findUnique({ where: { id: fx.submissionId } });
    expect(after?.status).toBe("in_audit");
    expect(after?.revisionCount).toBe(0);
  }, 30_000);

  it("refuses a revise from another contributor's account without leaking existence", async () => {
    const fx = await seedRevisableSubmission("revown");
    await prisma.submission.update({ where: { id: fx.submissionId }, data: { status: "tests_failed" } });
    const stranger = await signupVerified("revstranger");

    const res = await reviseRequest(fx.submissionId, stranger.cookie, "revown-fix");
    expect(res.statusCode).toBe(404);

    const after = await prisma.submission.findUnique({ where: { id: fx.submissionId } });
    expect(after?.revisionCount).toBe(0);
  }, 30_000);
});

describe("automated validation rerun", () => {
  it("requeues a failed automated attempt without replacing the payload or spending a revision", async () => {
    const fx = await seedRevisableSubmission("rerunok");
    const before = await prisma.submission.update({
      where: { id: fx.submissionId },
      data: { status: "tests_failed", validationAttempt: 4 },
    });
    await prisma.validationResult.create({
      data: { submissionId: fx.submissionId, validationAttempt: 4, stage: "execution", passed: false, score: 0, detailJson: { reason: "test failed" } },
    });

    const res = await rerunRequest(fx.submissionId, fx.contributorCookie);
    expect(res.statusCode).toBe(202);
    const after = await prisma.submission.findUnique({ where: { id: fx.submissionId } });
    expect(after?.status).toBe("submitted");
    expect(after?.validationAttempt).toBe(5);
    expect(after?.revisionCount).toBe(before.revisionCount);
    expect(res.enqueuedJobs.map((job) => job.idempotencyKey)).toContain(`val:${fx.submissionId}:attempt:5`);
    expect(await prisma.validationResult.count({ where: { submissionId: fx.submissionId, validationAttempt: 4 } })).toBe(1);
  }, 30_000);

  it("refuses a validator decision and a caller who does not own the submission", async () => {
    const fx = await seedRevisableSubmission("rerunno");
    await prisma.submission.update({ where: { id: fx.submissionId }, data: { status: "flagged" } });
    await prisma.validationResult.create({
      data: { submissionId: fx.submissionId, validationAttempt: 0, stage: "execution", passed: false, score: 0, detailJson: { reason: "test failed" } },
    });
    expect((await rerunRequest(fx.submissionId, fx.contributorCookie)).statusCode).toBe(409);

    await prisma.submission.update({ where: { id: fx.submissionId }, data: { status: "tests_failed" } });
    const stranger = await signupVerified("rerunstranger");
    expect((await rerunRequest(fx.submissionId, stranger.cookie)).statusCode).toBe(404);
  }, 30_000);
});

describe("revision cap", () => {
  it("rejects the attempt past the default cap and terminally rejects the submission", async () => {
    expect(DEFAULT_MAX_REVISIONS).toBe(3);
    const fx = await seedRevisableSubmission("revcap");
    // Three attempts already consumed; the fourth must be refused.
    await prisma.submission.update({
      where: { id: fx.submissionId },
      data: { status: "tests_failed", revisionCount: DEFAULT_MAX_REVISIONS },
    });

    const res = await reviseRequest(fx.submissionId, fx.contributorCookie, "revcap-fix");
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("revised 3 times");

    const after = await prisma.submission.findUnique({ where: { id: fx.submissionId } });
    expect(after?.status).toBe("rejected");
    // The refused attempt must NOT burn a revision.
    expect(after?.revisionCount).toBe(DEFAULT_MAX_REVISIONS);

    // The contributor is told why, and so is the pool requester.
    const notes = await prisma.notification.findMany({ where: { entityId: fx.submissionId } });
    expect(notes.some((n) => n.type === "submission.rejected" && n.userId === fx.contributorId)).toBe(true);
    expect(notes.some((n) => n.type === "submission.rejected_final" && n.userId === fx.requesterId)).toBe(true);
  }, 30_000);

  it("allows three attempts and refuses the fourth, counting from zero", async () => {
    const fx = await seedRevisableSubmission("revseq");
    for (let attempt = 1; attempt <= DEFAULT_MAX_REVISIONS; attempt++) {
      await prisma.submission.update({
        where: { id: fx.submissionId },
        data: { status: "tests_failed" },
      });
      const ok = await reviseRequest(fx.submissionId, fx.contributorCookie, `revseq-${attempt}`);
      expect(ok.statusCode).toBe(200);
      const row = await prisma.submission.findUnique({ where: { id: fx.submissionId } });
      expect(row?.revisionCount).toBe(attempt);
    }

    await prisma.submission.update({ where: { id: fx.submissionId }, data: { status: "tests_failed" } });
    const refused = await reviseRequest(fx.submissionId, fx.contributorCookie, "revseq-4");
    expect(refused.statusCode).toBe(409);

    const after = await prisma.submission.findUnique({ where: { id: fx.submissionId } });
    expect(after?.revisionCount).toBe(DEFAULT_MAX_REVISIONS);
    expect(after?.status).toBe("rejected");
  }, 60_000);

  it("treats a configured 0 as unlimited", async () => {
    const fx = await seedRevisableSubmission("revunl");
    await prisma.adminSetting.upsert({
      where: { key: MAX_REVISIONS_KEY },
      create: { key: MAX_REVISIONS_KEY, value: 0 },
      update: { value: 0 },
    });
    try {
      // Far past the default cap — must still be allowed.
      await prisma.submission.update({
        where: { id: fx.submissionId },
        data: { status: "tests_failed", revisionCount: 25 },
      });
      const res = await reviseRequest(fx.submissionId, fx.contributorCookie, "revunl-fix");
      expect(res.statusCode).toBe(200);
      const after = await prisma.submission.findUnique({ where: { id: fx.submissionId } });
      expect(after?.revisionCount).toBe(26);
      expect(after?.status).toBe("submitted");
    } finally {
      await prisma.adminSetting.deleteMany({ where: { key: MAX_REVISIONS_KEY } });
    }
  }, 30_000);

  it("cannot be raced past the cap by two concurrent revise calls", async () => {
    const fx = await seedRevisableSubmission("revrace");
    // One attempt left. Two callers arrive at the same instant: exactly one
    // may win. A read-then-check would let both through here.
    await prisma.submission.update({
      where: { id: fx.submissionId },
      data: { status: "tests_failed", revisionCount: DEFAULT_MAX_REVISIONS - 1 },
    });

    const [a, b] = await Promise.all([
      reviseRequest(fx.submissionId, fx.contributorCookie, "revrace-a"),
      reviseRequest(fx.submissionId, fx.contributorCookie, "revrace-b"),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const after = await prisma.submission.findUnique({ where: { id: fx.submissionId } });
    // The decisive assertion: the counter landed exactly ON the cap, never past it.
    expect(after?.revisionCount).toBe(DEFAULT_MAX_REVISIONS);

    // And exactly one snapshot was archived — the loser did no work at all.
    const snapshots = await prisma.submissionRevision.findMany({ where: { submissionId: fx.submissionId } });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.revisionNumber).toBe(DEFAULT_MAX_REVISIONS);
  }, 30_000);
});
