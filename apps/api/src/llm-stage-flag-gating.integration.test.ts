// SPDX-License-Identifier: Apache-2.0

/**
 * Proves that `validation.llm.enabled` actually GATES the LLM stage inside
 * `services/validation.ts` — the bug this file exists for: the stage was
 * gated only on `openRouterConfigured()` (env-key presence), so the published
 * admin control had zero readers and turning it off would not have stopped the
 * stage.
 *
 * Why this is a separate file from pipeline.integration.test.ts: the LLM stage
 * sits AFTER the execution stage, and `runSubmissionValidation` returns early
 * when execution produces no verdict. No sandbox provider is configured in
 * this environment, so in that suite the LLM stage is simply never reached and
 * "no llm row" is vacuously true. Here `runExecution` is replaced with a TEST
 * DOUBLE that reports a clean run, purely so control flow reaches the stage
 * under test. That double is a fabricated execution verdict and is confined to
 * this file — nothing it returns is asserted on, and no product code path
 * reads it.
 *
 * The provider-configured axis is driven by mutating `config.openRouterApiKey`
 * rather than by mocking the LLM client: this `.env` carries a REAL OpenRouter
 * key, so the flag-on + provider-configured combination would bill a live
 * model call and make the assertion depend on the network. That fourth corner
 * of the matrix is therefore deliberately not exercised here; the three that
 * carry the honesty guarantees are.
 *
 * Self-guards exactly like the other integration suites: refuses to run unless
 * DATABASE_URL points at the disposable databounty_community_parity_verify
 * database.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ArtifactKind, ArtifactStatus, SponsorExampleReviewStatus } from "@prisma/client";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

// Must be declared before the module under test is imported. `importOriginal`
// keeps `executionToStageResult` (and everything else) real — only the sandbox
// call itself is replaced.
vi.mock("./services/execution-providers/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/execution-providers/service.js")>();
  return {
    ...actual,
    runExecution: vi.fn(async () => ({
      available: true as const,
      passed: true,
      score: 1,
      detail: { note: "test double — no sandbox ran" },
      isolationVerified: true,
      provider: "test-double",
      durationMs: 1,
    })),
  };
});

const { buildApp } = await import("./app.js");
const { prisma } = await import("./lib/prisma.js");
const { dbJobQueue } = await import("./services/jobs.js");
const { runSubmissionValidation } = await import("./services/validation.js");
const { setAdminSetting } = await import("./services/admin-settings.js");
const { config } = await import("./config.js");
const { putArtifactData } = await import("./services/storage.js");

requireDisposableDatabase();

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function signupVerified(emailPrefix: string) {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${emailPrefix}${Date.now()}`, displayName: emailPrefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

/**
 * Owner decision, 2026-09-09 (admin-community.ts): a community request can no
 * longer be minted with zero approved sponsor_reference samples — both mint
 * routes now return 409 "no_samples" until at least one is approved. Seeds
 * that precondition directly (bypassing the upload-slot/complete/scan
 * lifecycle and the admin sponsor-review action, which are covered
 * elsewhere) since this file's fixtures only need the gate cleared, not the
 * review flow itself exercised. Mirrors the identical helper added to
 * pipeline.integration.test.ts for the same reason.
 */
async function seedApprovedSample(requestId: string, ownerUserId: string) {
  const storageKey = `artifacts/sponsor_reference/llm-gate-fixture/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await putArtifactData(
    storageKey,
    Buffer.from(JSON.stringify({ instruction: "Fixture reference sample for llm-stage-flag-gating.integration.test.ts." }), "utf8"),
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

async function mintPool(label: string) {
  const { userId: adminId, cookie: adminCookie } = await signupVerified(`llmgateadmin${label}`);
  await prisma.userRole.create({ data: { userId: adminId, role: "admin" } });
  const { userId: contributorId, cookie: contributorCookie } = await signupVerified(`llmgatecontrib${label}`);

  const reqRes = await app.inject({
    method: "POST",
    url: "/v1/community/requests",
    headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
    payload: {
      title: `LLM Stage Gating Pool ${label}`,
      description: "Exercises whether validation.llm.enabled gates the LLM validation stage.",
      datasetTypeId: "debugging",
      domain: "coding",
      targetItems: 10,
      auditCoveragePct: 10,
    },
  });
  expect(reqRes.statusCode).toBe(201);
  const requestId = reqRes.json().request.id as string;
  await seedApprovedSample(requestId, contributorId);

  // /mint now refuses a request that has not been approved (its status gate
  // was brought to parity with /community/requests/:id/implement — see
  // routes/v1/admin-community.ts). This fixture is not exercising the review
  // loop, so approve the request directly in the database rather than driving
  // an admin decision through the API: /dataset-requests/:id/review would also
  // award the requester 25 approval karma and write notification rows that
  // this test's own assertions do not expect.
  await prisma.datasetRequest.update({ where: { id: requestId }, data: { status: "approved" } });

  const mintRes = await app.inject({
    method: "POST",
    url: `/v1/admin/dataset-requests/${requestId}/mint`,
    headers: { cookie: adminCookie, origin: "http://localhost:3010" },
    payload: {
      title: `LLM Stage Gating Bounty ${label}`,
      description: "Mint for the LLM stage-gating integration test.",
      targetItems: 10,
      karmaPerAcceptedItem: 25,
      auditCoveragePct: 10,
    },
  });
  expect(mintRes.statusCode).toBe(201);
  return { adminId, contributorCookie, bountyId: mintRes.json().bounty.id as string };
}

/**
 * Submits one item through the real route (so a real `validation.run` JobQueue
 * row is created, same as production) and then runs exactly that job's
 * handler, marking it done — never leaving a dangling pending row for another
 * suite's `drainJobs` to double-claim.
 */
async function submitAndRunValidation(bountyId: string, contributorCookie: string, label: string) {
  const submitRes = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
    payload: {
      bountyId,
      title: `LLM stage gating item ${label}`,
      payloadJson: {
        prompt: `fix it ${label}`,
        broken_code: `function add${label}(a,b){ return a+b+1; }`,
        fixed_code: `function add${label}(a,b){ return a+b; }\nmodule.exports = { add${label} };`,
        tests:
          `const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { add${label} } = require('./solution.js');\ntest('adds ${label}', () => { assert.strictEqual(add${label}(2,3), 5); });`,
        explanation: "removed +1",
        bug_type: "off_by_one",
      },
    },
  });
  expect(submitRes.statusCode).toBe(201);
  const submissionId = submitRes.json().submission.id as string;

  const job = await prisma.jobQueue.findFirst({
    where: { type: "validation.run", idempotencyKey: `val:${submissionId}:0` },
  });
  expect(job).not.toBeNull();
  expect(job!.status).toBe("pending");

  // Resolve OUR job by its idempotency key and run that one, instead of
  // calling `dbJobQueue.claim(["validation.run"])` and then asserting the row
  // it handed back happened to be ours.
  //
  // `claim()` is a global, oldest-first queue read (services/jobs.ts:
  // `orderBy: { createdAt: "asc" }`) over a `job_queue` table this suite
  // shares with every other file in the run AND with every previous run
  // against the same database — rows are not reset between runs. The previous
  // form therefore only passed while no `validation.run` row anywhere in that
  // table was older-and-still-claimable, which is a property of leftover data,
  // not of anything this file or the code under test does. When it broke it
  // broke as `expected '<some other submission id>' to be '<ours>'`, three
  // levels away from the LLM-flag behaviour under test, and it stayed broken
  // for every later run because each failure leaves this file's own row
  // pending too.
  //
  // Nothing about the LLM-stage contract this file exists to pin needs the
  // claim path: what it needs is that the route really enqueued a job (checked
  // above), that the real handler ran for THIS submission, and that no
  // dangling pending row is left behind (`complete` below). `claim()` itself
  // is covered where it belongs, by pipeline.integration.test.ts's "worker job
  // processing > claims and processes a validation.run job end to end" and by
  // services/jobs.integration.test.ts.
  await runSubmissionValidation(submissionId, 0);
  await dbJobQueue.complete(job!.id);
  return submissionId;
}

describe("validation.llm.enabled gates the LLM validation stage", () => {
  it("flag OFF: the stage is skipped entirely — no llm evidence row, no score, and no stage step claiming an LLM outcome", async () => {
    const { adminId, contributorCookie, bountyId } = await mintPool("off");
    await setAdminSetting({ key: "validation.llm.enabled", value: false, updatedByUserId: adminId });

    const submissionId = await submitAndRunValidation(bountyId, contributorCookie, "Off");

    // Execution reached a clean verdict (test double), so control flow DID
    // arrive at the LLM stage — prove that before asserting the skip, or the
    // assertion below would be vacuous.
    const execRow = await prisma.validationResult.findFirst({ where: { submissionId, stage: "execution" } });
    expect(execRow?.passed).toBe(true);

    // THE assertion. Before the fix, the stage ran on env-key presence alone,
    // and this `.env` has a real OpenRouter key — so with the platform switch
    // OFF a real model verdict (including a PASS) was still recorded.
    const llmRows = await prisma.validationResult.findMany({ where: { submissionId, stage: "llm" } });
    expect(llmRows).toHaveLength(0);

    const sub = await prisma.submission.findUnique({ where: { id: submissionId } });
    expect(sub?.llmScore).toBeNull();
    // Skipping the stage must not weaken the outcome: the item still holds for
    // a human validator rather than being auto-accepted on nothing.
    expect(sub?.pendingHumanReview).toBe(true);

    const stageKeys = (
      await prisma.notification.findMany({
        where: { type: "validation.stage_result", entityId: submissionId },
        select: { eventKey: true },
      })
    ).map((n) => n.eventKey);
    expect(stageKeys.some((k) => k.endsWith(":llm"))).toBe(false);
    // The stages that DID run are still reported, so this is a targeted skip,
    // not a silent loss of the whole timeline.
    expect(stageKeys.some((k) => k.endsWith(":execution"))).toBe(true);

    const detailRes = await app.inject({
      method: "GET",
      url: `/v1/submissions/${submissionId}`,
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().submission.llmValidationEnabled).toBe(false);
  }, 60_000);

  it("flag ON + no provider configured: writes exactly one honest no_provider_configured row — never absent, never a pass", async () => {
    const { adminId, contributorCookie, bountyId } = await mintPool("on");
    await setAdminSetting({ key: "validation.llm.enabled", value: true, updatedByUserId: adminId });

    const realKey = config.openRouterApiKey;
    config.openRouterApiKey = undefined;
    try {
      const submissionId = await submitAndRunValidation(bountyId, contributorCookie, "On");

      const llmRows = await prisma.validationResult.findMany({ where: { submissionId, stage: "llm" } });
      expect(llmRows).toHaveLength(1);
      const row = llmRows[0]!;
      expect(row.outcome).toBe("no_provider_configured");
      expect(row.passed).toBe(false);
      expect(row.score).toBeNull();
      expect((row.detailJson as Record<string, unknown>).status).toBe("pending_llm_review");

      const sub = await prisma.submission.findUnique({ where: { id: submissionId } });
      expect(sub?.llmScore).toBeNull();
      expect(sub?.pendingHumanReview).toBe(true);

      // The step IS reported to the contributor in this state — "on, but
      // nothing ran" is information they are entitled to, unlike the flag-off
      // case where the stage is not part of the pipeline at all.
      const stageKeys = (
        await prisma.notification.findMany({
          where: { type: "validation.stage_result", entityId: submissionId },
          select: { eventKey: true },
        })
      ).map((n) => n.eventKey);
      expect(stageKeys.some((k) => k.endsWith(":llm"))).toBe(true);

      // The field pair is what lets a client tell this state apart from
      // flag-off: an absent `llm` row alone means both.
      const detailRes = await app.inject({
        method: "GET",
        url: `/v1/submissions/${submissionId}`,
        headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      });
      expect(detailRes.statusCode).toBe(200);
      const detail = detailRes.json().submission;
      expect(detail.llmValidationEnabled).toBe(true);
      expect(detail.llmProviderConfigured).toBe(false);

      const contractRes = await app.inject({
        method: "GET",
        url: `/v1/bounties/${bountyId}/contract`,
        headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      });
      expect(contractRes.statusCode).toBe(200);
      expect(contractRes.json().llmValidationEnabled).toBe(true);
      expect(contractRes.json().llmProviderConfigured).toBe(false);

      const devRes = await app.inject({
        method: "GET",
        url: "/v1/meta/developer-surface",
        // Public URLs must come from trusted deployment config, never Host.
        headers: { host: "api.internal.invalid:4000" },
      });
      expect(devRes.json().baseUrl).toBe(`${config.publicApiBaseUrl}/v1`);
      expect(devRes.json().mcpRemoteUrl).toBe(`${config.mcpPublicUrl}/mcp`);
      expect(devRes.json().llmValidationEnabled).toBe(true);
      expect(devRes.json().llmProviderConfigured).toBe(false);
    } finally {
      config.openRouterApiKey = realKey;
      // Restore the catalog default. This database is shared and never reset,
      // and leaving the switch ON with a real key in `.env` would bill live
      // model calls from whatever suite runs next.
      await setAdminSetting({ key: "validation.llm.enabled", value: false, updatedByUserId: adminId });
    }
  }, 60_000);
});
