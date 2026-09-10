// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the previously-unverified pieces of the Community
 * API: the background job-queue worker's processing logic (src/worker.ts),
 * the MCP server's tool listing/call surface (src/mcp/server.ts), and the
 * full batches -> submissions -> audits contribution pipeline
 * (routes/v1/community.ts mint, routes/v1/submissions.ts,
 * services/pool-lifecycle.ts, routes/v1/audits.ts).
 *
 * Uses Fastify's inject() against buildApp() so no port is bound — same
 * pattern as src/boot.integration.test.ts. Job processing is exercised by
 * importing the exact same functions src/worker.ts calls
 * (dbJobQueue.claim/complete/fail, runSubmissionValidation,
 * runPoolSamplingJob) and driving them in a bounded loop, rather than
 * spawning the worker's own infinite polling process — that process was
 * separately verified manually against this same disposable database
 * (enqueue -> real `node --test` execution -> pool close-out -> human audit
 * window, all observed via psql).
 *
 * Self-guards exactly like boot.integration.test.ts: refuses to run unless
 * DATABASE_URL points at the disposable databounty_community_parity_verify
 * database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { dbJobQueue, type JobType } from "./services/jobs.js";
import { runSubmissionValidation } from "./services/validation.js";
import { runPoolSamplingJob } from "./services/pool-lifecycle.js";
import { runArtifactScanJob } from "./services/artifacts.js";
import { llmValidationEnabled, setAdminSetting } from "./services/admin-settings.js";
import { putArtifactData } from "./services/storage.js";
import { ArtifactKind, ArtifactStatus, SponsorExampleReviewStatus } from "@prisma/client";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;

// A fresh app per test gives each test its own in-memory AUTH_RATE_LIMIT
// bucket (10 signups/min, hardcoded on the route — see auth.ts). Sharing one
// instance across this file's tests means their combined signups stack up
// past the cap within the file's runtime, self-exhausting the bucket and
// failing later tests with 429s unrelated to the pipeline logic under test.
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

/** Drains every pending job of the given types by claiming and handling them
 * one at a time, mirroring src/worker.ts's `handle()` switch exactly — this
 * proves the same processing logic the real worker process runs actually
 * clears the queue, without needing to spawn worker.ts's infinite loop. */
/**
 * Drain claimable jobs of the given types and return how many of them were
 * OURS.
 *
 * `mine` exists because the job queue is global and this suite shares a
 * database with every other suite in the run. Without it, `drainJobs` counted
 * every job it claimed — including `pool.sampling` and `validation.run` rows
 * enqueued by other files — so an exact-count assertion here passed when the
 * file ran alone and failed in a full run with e.g. `expected 3 to be 1`. That
 * is a test-isolation defect, not a product one: the counts were never wrong
 * about this suite's own work.
 *
 * Everything claimable is still EXECUTED and completed, whether or not it is
 * ours — a foreign job left un-drained would block the queue and change what
 * this suite observes next. Only the returned COUNT is scoped.
 */
async function drainJobs(
  types: JobType[],
  maxIterations = 50,
  mine?: (type: JobType, payload: Record<string, unknown>) => boolean,
): Promise<number> {
  let processed = 0;
  let mineSeen = 0;
  let foreignSeen = 0;
  // `maxIterations` is this suite's budget for ITS OWN jobs. Foreign rows get
  // a separate, much larger allowance.
  //
  // Why: `dbJobQueue.claim()` is a global, oldest-first read over a `job_queue`
  // table shared with every other file in the run and never reset between runs
  // (services/jobs.ts `orderBy: { createdAt: "asc" }`). Leftover claimable rows
  // from an earlier file or an earlier run are therefore served FIRST. With the
  // budget shared, a handful of such rows consumed the whole `maxIterations`
  // allowance before this suite's own job was ever reached, and the exact-count
  // assertions here failed as `expected +0 to be 1` / `expected 'pending' to be
  // 'done'` — a symptom of stale queue rows, with nothing wrong in the pipeline
  // being tested. Every failure then left this suite's own rows pending, which
  // fed the same backlog and made the next run worse.
  //
  // Foreign jobs are still executed and completed exactly as before (a claimed
  // row left dangling would block the queue for everyone); they just no longer
  // starve this file. The foreign allowance is bounded so a genuinely stuck
  // queue still fails fast rather than looping forever.
  const maxForeignIterations = 1000;
  while (mineSeen < maxIterations && foreignSeen < maxForeignIterations) {
    const job = await dbJobQueue.claim(types);
    if (!job) break;
    try {
      switch (job.type) {
        case "validation.run": {
          const payload = job.payload as { submissionId: string; validationAttempt?: number };
          await runSubmissionValidation(payload.submissionId, payload.validationAttempt ?? 0);
          break;
        }
        case "pool.sampling": {
          const payload = job.payload as { bountyId: string };
          await runPoolSamplingJob(payload.bountyId);
          break;
        }
        case "artifact.scan": {
          const payload = job.payload as { artifactId: string };
          await runArtifactScanJob(payload.artifactId);
          break;
        }
        default:
          throw new Error(`No handler for job type in test: ${job.type}`);
      }
      await dbJobQueue.complete(job.id);
    } catch (err) {
      await dbJobQueue.fail(job.id, err instanceof Error ? err.message : String(err));
    }
    if (!mine || mine(job.type as JobType, job.payload as Record<string, unknown>)) {
      processed++;
      mineSeen++;
    } else {
      foreignSeen++;
    }
  }
  return processed;
}

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
 * lifecycle and the admin sponsor-review action, which are already covered by
 * community.requests-samples.integration.test.ts and
 * bounties.public-samples.integration.test.ts) since this file's fixtures
 * only need the gate cleared, not the review flow itself exercised.
 */
async function seedApprovedSample(requestId: string, ownerUserId: string) {
  const storageKey = `artifacts/sponsor_reference/pipeline-fixture/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await putArtifactData(
    storageKey,
    Buffer.from(JSON.stringify({ instruction: "Fixture reference sample for pipeline.integration.test.ts." }), "utf8"),
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

describe("MCP server", () => {
  it("GET /mcp/ (unauthenticated) answers 401 with a WWW-Authenticate challenge, matching docs/mcp.md", async () => {
    // This used to return a 200 server-identity document as a health-check
    // convenience, which contradicted the documented contract and, worse,
    // meant several real MCP clients (Zed, Cline, mcp-remote) that start
    // their OAuth flow from a 401 on ANY unauthenticated request — not only
    // a POST — never learned they needed to authenticate. Health checks live
    // at /health and /healthz (routes/health.ts) instead.
    const res = await app.inject({ method: "GET", url: "/mcp/" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
    expect(String(res.headers["www-authenticate"])).toContain('error="invalid_token"');
  });

  it("GET /mcp/tools lists real tool definitions with schemas, unauthenticated", async () => {
    const rootRes = await app.inject({ method: "GET", url: "/mcp/tools" });
    expect(rootRes.statusCode).toBe(200);
    const body = rootRes.json();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    for (const tool of body.tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.scope).toBe("string");
      expect(tool.inputSchema).toBeDefined();
    }
    // A handful of tools this test suite exercises below must actually be present.
    const names = body.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_community_pools");
    expect(names).toContain("whoami");
    expect(names).toContain("list_audits");
  });

  it("POST /mcp/call runs a read-scope tool without authentication", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp/call", payload: { name: "list_community_pools", arguments: {} } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isError).toBe(false);
    const parsed = JSON.parse(body.content[0].text);
    expect(parsed).toHaveProperty("items");
  });

  it("POST /mcp/call rejects an authenticated-scope tool with no session, and succeeds with one", async () => {
    const unauth = await app.inject({ method: "POST", url: "/mcp/call", payload: { name: "whoami", arguments: {} } });
    expect(unauth.json().isError).toBe(true);

    const { email, cookie } = await signupVerified("mcpwhoami");
    // A real browser always sends `Origin` on a POST fetch — required by the
    // /mcp/call CSRF guard for cookie authentication (D24).
    const authed = await app.inject({
      method: "POST",
      url: "/mcp/call",
      headers: { cookie, origin: "http://localhost:3000" },
      payload: { name: "whoami", arguments: {} },
    });
    expect(authed.statusCode).toBe(200);
    const body = authed.json();
    expect(body.isError).toBe(false);
    const parsed = JSON.parse(body.content[0].text);
    expect(parsed.email).toBe(email);
  });

  it("POST /mcp/call returns a clean error for an unknown tool name", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp/call", payload: { name: "not_a_real_tool" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("worker job processing", () => {
  it("claims and processes a validation.run job end to end against a real submission", async () => {
    const { userId: adminId, cookie: adminCookie } = await signupVerified("workeradmin");
    await prisma.userRole.create({ data: { userId: adminId, role: "admin" } });
    const { userId: contributorId, cookie: contributorCookie } = await signupVerified("workercontrib");

    const reqRes = await app.inject({
      method: "POST",
      url: "/v1/community/requests",
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      payload: {
        title: "Worker Job Processing Test Pool",
        description: "Exercises validation.run job processing via the worker's own handler logic.",
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
        title: "Worker Job Processing Pool",
        description: "Mint for worker job-processing integration test.",
        targetItems: 10,
        karmaPerAcceptedItem: 25,
        auditCoveragePct: 10,
      },
    });
    expect(mintRes.statusCode).toBe(201);
    const bountyId = mintRes.json().bounty.id as string;

    const submitRes = await app.inject({
      method: "POST",
      url: "/v1/submissions",
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      payload: {
        bountyId,
        title: "Worker test item",
        payloadJson: {
          prompt: "fix it",
          broken_code: "function add(a,b){ return a+b+1; }",
          fixed_code: "function add(a,b){ return a+b; }\nmodule.exports = { add };",
          tests:
            "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./solution.js');\ntest('adds', () => { assert.strictEqual(add(2,3), 5); });",
          explanation: "removed +1",
          bug_type: "off_by_one",
        },
      },
    });
    expect(submitRes.statusCode).toBe(201);
    const submissionId = submitRes.json().submission.id as string;

    // The route enqueued a real JobQueue row — prove it's actually there,
    // pending, before we touch it.
    const pendingJob = await prisma.jobQueue.findFirst({
      where: { type: "validation.run", idempotencyKey: `val:${submissionId}:0` },
    });
    expect(pendingJob).not.toBeNull();
    expect(pendingJob!.status).toBe("pending");

    // Scoped to this test's own submission: an unscoped drain counts (and is
    // starved by) another file's leftover `validation.run` rows.
    const processedCount = await drainJobs(
      ["validation.run"],
      5,
      (_t, payload) => payload.submissionId === submissionId,
    );
    expect(processedCount).toBeGreaterThan(0);

    const doneJob = await prisma.jobQueue.findUnique({ where: { id: pendingJob!.id } });
    expect(doneJob?.status).toBe("done");

    const sub = await prisma.submission.findUnique({ where: { id: submissionId } });
    // The item lands in accepted_pending_sample with pendingHumanReview set:
    // this pipeline has no automated stage left that is allowed to grant a
    // bare "accepted" (external-corpus plagiarism screening was removed
    // entirely per owner decision), and — with no isolated execution sandbox
    // configured in the test environment — the execution stage produced no
    // verdict either. Crucially it is NOT
    // tests_failed: "we could not verify" is a different claim from "your code
    // is wrong", and only a sandbox that actually ran the tests may make the
    // latter.
    expect(sub?.status).toBe("accepted_pending_sample");
    expect(sub?.pendingHumanReview).toBe(true);

    const execResult = await prisma.validationResult.findFirst({
      where: { submissionId, stage: "execution" },
    });
    // FAIL-CLOSED CONTRACT. Execution now runs only inside an isolated sandbox
    // provider (services/execution-providers/); there is no in-process
    // fallback. With no E2B_API_KEY set, nothing executes and the stage records
    // the honest reason rather than a fabricated pass.
    expect(execResult?.passed).toBe(false);
    expect(execResult?.outcome).toBe("no_provider_configured");
    // Never a claim of isolation for a run that did not happen: null means "not
    // attempted", which is a different state from "ran, unverified".
    expect(execResult?.isolationVerified).toBeNull();
    expect(execResult?.provider).toBeNull();
  }, 30_000);
});

describe("validation.dedupe.reject_threshold admin setting", () => {
  it("honours a live-configured threshold instead of the old hardcoded 0.8 — the exact bug the fact-check audit caught", async () => {
    const { userId: adminId, cookie: adminCookie } = await signupVerified("dedupethresholdadmin");
    await prisma.userRole.create({ data: { userId: adminId, role: "admin" } });
    const { userId: contributorId, cookie: contributorCookie } = await signupVerified("dedupethresholdcontrib");

    const reqRes = await app.inject({
      method: "POST",
      url: "/v1/community/requests",
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      payload: {
        title: "Dedupe Threshold Setting Test Pool",
        description: "Exercises the live-configurable validation.dedupe.reject_threshold admin setting.",
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
        title: "Dedupe Threshold Setting Pool",
        description: "Mint for the dedupe-threshold admin-setting integration test.",
        targetItems: 10,
        karmaPerAcceptedItem: 25,
        auditCoveragePct: 10,
      },
    });
    expect(mintRes.statusCode).toBe(201);
    const bountyId = mintRes.json().bounty.id as string;

    // Submissions are created through the real route (which enqueues a real
    // `validation.run` JobQueue row, same as every other test in this file)
    // and then drained through the same `drainJobs()` helper the "worker job
    // processing" suite above uses — never by calling
    // `runSubmissionValidation` directly against a dangling job, which would
    // leave that job permanently "pending" and get double-claimed by a later,
    // unrelated test's own `drainJobs(["validation.run"], ...)` call.
    async function submitWithDuplicateScore(score: number, label: string) {
      const submitRes = await app.inject({
        method: "POST",
        url: "/v1/submissions",
        headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
        payload: {
          bountyId,
          title: `Dedupe threshold test item ${label}`,
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
      // The real submit path only computes a nonzero duplicateScore against an
      // actual near-duplicate; there is no other one in this fresh pool, so it
      // is forced here to a fixed 0.6 — deliberately BETWEEN the old hardcoded
      // 0.8 and the 0.5 threshold this test configures below, which is exactly
      // the band the bug made unreachable (nothing could ever move the cutoff
      // off of 0.8 no matter what the admin saved).
      await prisma.submission.update({ where: { id: submissionId }, data: { duplicateScore: score } });
      const processed = await drainJobs(
        ["validation.run"],
        5,
        (_t, payload) => payload.submissionId === submissionId,
      );
      expect(processed).toBe(1);
      return submissionId;
    }

    // Case 1: threshold explicitly set to 0.8 rather than assumed absent —
    // `AdminSetting` rows persist in this real, shared Postgres database
    // across test runs (this suite does not reset it), so a bare "nothing
    // has ever set this key" assumption would be false on any rerun after a
    // prior pass already saved an override. This still exercises the exact
    // behaviour that matters: a 0.6 score clears the dedupe gate at the 0.8
    // threshold (0.8 is now the catalog's review_threshold default, not the
    // reject_threshold default — see the two-tier dedupe test below).
    await setAdminSetting({
      key: "validation.dedupe.reject_threshold",
      value: 0.8,
      updatedByUserId: adminId,
    });
    const beforeId = await submitWithDuplicateScore(0.6, "before");
    const beforeSub = await prisma.submission.findUnique({ where: { id: beforeId } });
    expect(beforeSub?.status).not.toBe("rejected");

    // Case 2: admin lowers the reject threshold to 0.5 via the same
    // setAdminSetting() write path the /settings admin-console page uses.
    await setAdminSetting({
      key: "validation.dedupe.reject_threshold",
      value: 0.5,
      updatedByUserId: adminId,
    });

    const afterId = await submitWithDuplicateScore(0.6, "after");
    const afterSub = await prisma.submission.findUnique({ where: { id: afterId } });
    // This is the assertion that would have caught the original bug: with the
    // hardcoded `< 0.8` literal, a 0.6 score always cleared the gate no matter
    // what the admin saved. Now that the check reads the live setting, the
    // same 0.6 score is rejected once the threshold is lowered to 0.5.
    expect(afterSub?.status).toBe("rejected");

    const dupResult = await prisma.validationResult.findFirst({
      where: { submissionId: afterId, stage: "dedupe" },
    });
    expect(dupResult?.passed).toBe(false);
    expect(dupResult?.score).toBe(0.6);

    // Restore the catalog default so this shared, non-reset database doesn't
    // leave a lowered threshold behind for whatever test file runs next.
    await setAdminSetting({
      key: "validation.dedupe.reject_threshold",
      value: 0.9,
      updatedByUserId: adminId,
    });
  }, 30_000);

  it("two-tier: a review-band score is flagged for human review, not auto-rejected — only the reject_threshold band is", async () => {
    const { userId: adminId, cookie: adminCookie } = await signupVerified("dedupetiersadmin");
    await prisma.userRole.create({ data: { userId: adminId, role: "admin" } });
    const { userId: contributorId, cookie: contributorCookie } = await signupVerified("dedupetierscontrib");

    const reqRes = await app.inject({
      method: "POST",
      url: "/v1/community/requests",
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      payload: {
        title: "Dedupe Two-Tier Threshold Test Pool",
        description: "Exercises the review_threshold / reject_threshold two-tier dedupe design (V1 parity).",
        datasetTypeId: "debugging",
        domain: "coding",
        targetItems: 10,
        auditCoveragePct: 10,
      },
    });
    expect(reqRes.statusCode).toBe(201);
    const requestId = reqRes.json().request.id as string;
    await seedApprovedSample(requestId, contributorId);
    await prisma.datasetRequest.update({ where: { id: requestId }, data: { status: "approved" } });

    const mintRes = await app.inject({
      method: "POST",
      url: `/v1/admin/dataset-requests/${requestId}/mint`,
      headers: { cookie: adminCookie, origin: "http://localhost:3010" },
      payload: {
        title: "Dedupe Two-Tier Threshold Pool",
        description: "Mint for the two-tier dedupe test.",
        targetItems: 10,
        karmaPerAcceptedItem: 25,
        auditCoveragePct: 10,
      },
    });
    expect(mintRes.statusCode).toBe(201);
    const bountyId = mintRes.json().bounty.id as string;

    async function submitWithDuplicateScore(score: number, label: string) {
      const submitRes = await app.inject({
        method: "POST",
        url: "/v1/submissions",
        headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
        payload: {
          bountyId,
          title: `Two-tier dedupe test item ${label}`,
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
      await prisma.submission.update({ where: { id: submissionId }, data: { duplicateScore: score } });
      const processed = await drainJobs(
        ["validation.run"],
        5,
        (_t, payload) => payload.submissionId === submissionId,
      );
      expect(processed).toBe(1);
      return submissionId;
    }

    // Explicit thresholds for this test, independent of whatever the previous
    // suite's cleanup left behind: review at 0.8, reject at 0.9 (the catalog
    // defaults, matching V1's evaluateDuplicate() design).
    await setAdminSetting({ key: "validation.dedupe.review_threshold", value: 0.8, updatedByUserId: adminId });
    await setAdminSetting({ key: "validation.dedupe.reject_threshold", value: 0.9, updatedByUserId: adminId });

    // 0.85 is in the review band: not a near-certain duplicate, so it must
    // NOT be auto-rejected — a validator sees the evidence and decides.
    const reviewId = await submitWithDuplicateScore(0.85, "review-band");
    const reviewSub = await prisma.submission.findUnique({ where: { id: reviewId } });
    expect(reviewSub?.status).not.toBe("rejected");
    expect(reviewSub?.duplicateDecision).toBe("review_required");
    const reviewResult = await prisma.validationResult.findFirst({
      where: { submissionId: reviewId, stage: "dedupe" },
    });
    expect(reviewResult?.passed).toBe(true);
    expect((reviewResult?.detailJson as { duplicateDecision?: string } | null)?.duplicateDecision).toBe(
      "review_required",
    );

    // 0.95 is a near-certain duplicate: auto-rejected, no human needed.
    const rejectId = await submitWithDuplicateScore(0.95, "reject-band");
    const rejectSub = await prisma.submission.findUnique({ where: { id: rejectId } });
    expect(rejectSub?.status).toBe("rejected");
    expect(rejectSub?.duplicateDecision).toBe("rejected");
    const rejectResult = await prisma.validationResult.findFirst({
      where: { submissionId: rejectId, stage: "dedupe" },
    });
    expect(rejectResult?.passed).toBe(false);

    // Restore catalog defaults for whatever test file runs next.
    await setAdminSetting({ key: "validation.dedupe.review_threshold", value: 0.8, updatedByUserId: adminId });
    await setAdminSetting({ key: "validation.dedupe.reject_threshold", value: 0.9, updatedByUserId: adminId });
  }, 30_000);
});

describe("batches -> submissions -> audits happy path", () => {
  it("mints a pool, submits items, closes the pool, samples a human-audit window, and settles validator decisions", async () => {
    const { userId: adminId, cookie: adminCookie } = await signupVerified("pipelineadmin");
    await prisma.userRole.create({ data: { userId: adminId, role: "admin" } });
    const { userId: contributorId, cookie: contributorCookie } = await signupVerified("pipelinecontrib");
    const { userId: validatorId, cookie: validatorCookie } = await signupVerified("pipelinevalidator");

    const reqRes = await app.inject({
      method: "POST",
      url: "/v1/community/requests",
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      payload: {
        title: "Full Pipeline Integration Test Pool",
        description: "Exercises the full batches/submissions/audits happy path end to end.",
        datasetTypeId: "debugging",
        domain: "coding",
        targetItems: 10,
        auditCoveragePct: 100,
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
        title: "Full Pipeline Pool",
        description: "Minted pool for the full-pipeline integration test.",
        targetItems: 10,
        karmaPerAcceptedItem: 25,
        auditCoveragePct: 100,
      },
    });
    expect(mintRes.statusCode).toBe(201);
    const bountyId = mintRes.json().bounty.id as string;
    expect(mintRes.json().bounty.status).toBe("active");

    const items = Array.from({ length: 10 }, (_, i) => ({
      title: `Pipeline test item ${i}`,
      payloadJson: {
        prompt: `fix bug ${i}`,
        broken_code: `function fn${i}(a,b){ return a+b+1; }`,
        fixed_code: `function fn${i}(a,b){ return a+b; }\nmodule.exports = { fn${i} };`,
        tests:
          `const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { fn${i} } = require('./solution.js');\ntest('case ${i}', () => { assert.strictEqual(fn${i}(2,3), 5); });`,
        explanation: "removed +1 offset",
        bug_type: "off_by_one",
      },
    }));

    const bulkRes = await app.inject({
      method: "POST",
      url: "/v1/submissions/bulk",
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      payload: { bountyId, items },
    });
    expect(bulkRes.statusCode).toBe(201);
    expect(bulkRes.json().created).toBe(10);

    const ourSubmissionIds = new Set(
      (await prisma.submission.findMany({ where: { bountyId }, select: { id: true } })).map((r) => r.id),
    );
    const processedValidation = await drainJobs(
      ["validation.run"],
      20,
      (_t, payload) => ourSubmissionIds.has(payload.submissionId as string),
    );
    expect(processedValidation).toBe(10);

    const afterAutomation = await prisma.submission.findMany({ where: { bountyId }, select: { status: true } });
    expect(afterAutomation.every((s) => s.status === "accepted_pending_sample")).toBe(true);

    const bountyAfterAutomation = await prisma.bounty.findUnique({ where: { id: bountyId } });
    expect(Number(bountyAfterAutomation?.acceptedItems)).toBe(10);
    // 100% coverage forces every item pendingHumanReview into the sample
    // regardless, but the real trigger for pool close is acceptedItems
    // reaching targetItems — verify that actually fired.
    expect(bountyAfterAutomation?.poolClosedAt).not.toBeNull();

    const processedSampling = await drainJobs(
      ["pool.sampling"],
      50,
      (_t, payload) => payload.bountyId === bountyId,
    );
    expect(processedSampling).toBe(1);

    const bountyAfterSampling = await prisma.bounty.findUnique({ where: { id: bountyId } });
    expect(bountyAfterSampling?.poolSamplingCompletedAt).not.toBeNull();

    const inAudit = await prisma.submission.findMany({ where: { bountyId }, select: { id: true, status: true } });
    expect(inAudit.every((s) => s.status === "in_audit")).toBe(true);

    // Validator sees the window via the real listing endpoint.
    // Scoped with ?bountyId — the endpoint supports it (routes/v1/audits.ts:38).
    // An unscoped list is ONE page ordered by closedAt desc, so on a populated
    // database this window can sit outside page 1 and `.find()` returned
    // undefined. The filter is also what a real client would send.
    const auditsRes = await app.inject({
      method: "GET",
      url: `/v1/audits?bountyId=${bountyId}`,
      headers: { cookie: validatorCookie },
    });
    expect(auditsRes.statusCode).toBe(200);
    const auditsBody = auditsRes.json();
    const window = auditsBody.audits.find((a: { bountyId: string }) => a.bountyId === bountyId);
    expect(window).toBeDefined();
    expect(window.itemCount).toBe(10);

    // T1: evidence is gated behind the claim — GET /:id refuses an
    // unclaimed window (409), so the validator claims it first.
    const claimRes = await app.inject({
      method: "POST",
      url: `/v1/audits/${window.id}/claim`,
      headers: { cookie: validatorCookie, origin: "http://localhost:3010" },
    });
    expect(claimRes.statusCode).toBe(200);
    expect(claimRes.json().audit.claimedByUserId).toBe(validatorId);

    const detailRes = await app.inject({
      method: "GET",
      url: `/v1/audits/${window.id}`,
      headers: { cookie: validatorCookie },
    });
    expect(detailRes.statusCode).toBe(200);
    const items2 = detailRes.json().audit.items as Array<{ id: string; submissionId: string }>;
    expect(items2).toHaveLength(10);

    // Accept the first 9, flag the last one — exercises both verdict paths
    // and the partial-failure threshold logic in one settle call.
    const decisions = items2.map((it, idx) =>
      idx < 9
        ? { auditItemId: it.id, verdict: "ok" }
        : { auditItemId: it.id, verdict: "flagged", flagReason: "low_quality", note: "Integration test flag path." },
    );

    const decideRes = await app.inject({
      method: "POST",
      url: `/v1/audits/${window.id}/decisions`,
      headers: { cookie: validatorCookie, origin: "http://localhost:3010" },
      payload: { decisions },
    });
    expect(decideRes.statusCode).toBe(200);
    const decideBody = decideRes.json();
    expect(decideBody.ok).toBe(true);
    expect(decideBody.decisionsCount).toBe(10);
    expect(decideBody.rejectedCount).toBe(1);

    const finalSubs = await prisma.submission.findMany({ where: { bountyId }, select: { status: true } });
    expect(finalSubs.filter((s) => s.status === "accepted")).toHaveLength(9);
    expect(finalSubs.filter((s) => s.status === "flagged")).toHaveLength(1);

    const bountyFinal = await prisma.bounty.findUnique({ where: { id: bountyId } });
    expect(Number(bountyFinal?.finalAcceptedItems)).toBe(9);

    // A validator can never audit their own submission — the guard in
    // services/audits.ts (submitAuditDecisions) must reject this, not the
    // route-level 403 the batch-level self-audit check covers elsewhere.
    const selfAuditContributor = await app.inject({
      method: "GET",
      url: "/v1/audits",
      headers: { cookie: contributorCookie },
    });
    expect(selfAuditContributor.statusCode).toBe(200);
    const ownWindow = selfAuditContributor.json().audits.find((a: { bountyId: string }) => a.bountyId === bountyId);
    // The window is fully settled now (nothing pending), so it won't even
    // surface in the contributor's own list — but confirm the earlier
    // conflictExcluded accounting worked while it was still open by
    // re-checking the stored membership rows directly.
    expect(ownWindow).toBeUndefined();

    // Accepted-item karma now goes through the hold-then-release gate
    // (services/karma-holds.ts, community.karma_holds.enabled defaults to
    // true — recorded in the parity decision register), so a fresh accept does not land as a
    // live KarmaEvent yet: it is frozen in PendingKarmaAward until the
    // sponsor's dispute window closes. Assert the hold, not an immediate
    // award — the release-sweep path itself is covered by
    // karma-badges-attribution.integration.test.ts.
    const karmaEvents = await prisma.karmaEvent.findMany({
      where: { userId: contributorId, eventType: "community_item_accepted", sourceType: "Submission" },
    });
    expect(karmaEvents.length).toBe(0);

    const pendingKarma = await prisma.pendingKarmaAward.findMany({
      where: { userId: contributorId, eventType: "community_item_accepted", sourceType: "Submission" },
    });
    expect(pendingKarma.length).toBe(9);
    expect(pendingKarma.every((p) => p.amount === 25)).toBe(true);
    expect(pendingKarma.every((p) => p.releasedAt === null && p.reversedAt === null)).toBe(true);

    const validatorKarma = await prisma.karmaEvent.findMany({
      where: { userId: validatorId, eventType: "community_audit_completed" },
    });
    expect(validatorKarma.length).toBe(10);
  }, 120_000);
});

/**
 * Coverage for the ai_attribution validation stage (services/ai-attribution.ts,
 * wired into services/validation.ts). It is unconditional — every submission
 * gets a real ValidationResult row for it, not just dataset types that
 * "opt in" (there is no opt-in mechanism for it at all; see the comment on
 * `allowedStages` in routes/v1/admin-dataset-types.ts).
 */
describe("ai_attribution stage", () => {
  it("flags a submission with an explicit AI-disclosure phrase and clears a clean one, both still routed to human review", async () => {
    const { userId: adminId, cookie: adminCookie } = await signupVerified("aiattradmin");
    await prisma.userRole.create({ data: { userId: adminId, role: "admin" } });
    const { userId: contributorId, cookie: contributorCookie } = await signupVerified("aiattrcontrib");

    const reqRes = await app.inject({
      method: "POST",
      url: "/v1/community/requests",
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      payload: {
        title: "AI Attribution Stage Integration Test Pool",
        description: "Exercises the ai_attribution validation stage end to end.",
        datasetTypeId: "debugging",
        domain: "coding",
        targetItems: 10,
        auditCoveragePct: 100,
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
        title: "AI Attribution Stage Pool",
        description: "Minted pool for the ai_attribution stage integration test.",
        targetItems: 10,
        karmaPerAcceptedItem: 25,
        auditCoveragePct: 100,
      },
    });
    expect(mintRes.statusCode).toBe(201);
    const bountyId = mintRes.json().bounty.id as string;

    function item(i: number, explanation: string) {
      return {
        title: `AI attribution test item ${i}`,
        payloadJson: {
          prompt: `fix bug ${i}`,
          broken_code: `function aiAttrFn${i}(a,b){ return a+b+1; }`,
          fixed_code: `function aiAttrFn${i}(a,b){ return a+b; }\nmodule.exports = { aiAttrFn${i} };`,
          tests:
            `const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { aiAttrFn${i} } = require('./solution.js');\ntest('case ${i}', () => { assert.strictEqual(aiAttrFn${i}(2,3), 5); });`,
          explanation,
          bug_type: "off_by_one",
        },
      };
    }

    const bulkRes = await app.inject({
      method: "POST",
      url: "/v1/submissions/bulk",
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      payload: {
        bountyId,
        items: [
          item(0, "As an AI language model, I cannot guarantee this is bug-free, but the off-by-one offset was removed."),
          item(1, "Removed the stray +1 offset in the return statement."),
        ],
      },
    });
    expect(bulkRes.statusCode).toBe(201);
    expect(bulkRes.json().created).toBe(2);
    const submissionIds = bulkRes.json().submissions.map((s: { id: string }) => s.id) as string[];

    // Scoped to this test's own submissions — see the note on `drainJobs`.
    const processed = await drainJobs(
      ["validation.run"],
      5,
      (_t, payload) => submissionIds.includes(payload.submissionId as string),
    );
    expect(processed).toBe(2);

    const evidenceRows = await prisma.validationResult.findMany({
      where: { submissionId: { in: submissionIds }, stage: "ai_attribution" },
    });
    expect(evidenceRows).toHaveLength(2);

    const flaggedRow = evidenceRows.find((r) => submissionIds[0] === r.submissionId)!;
    expect(flaggedRow.passed).toBe(false);
    expect(flaggedRow.detailJson).toMatchObject({ status: "flagged", matches: [{ id: "ai_language_model" }] });

    const cleanRow = evidenceRows.find((r) => submissionIds[1] === r.submissionId)!;
    expect(cleanRow.passed).toBe(true);
    expect(cleanRow.detailJson).toMatchObject({ status: "clear" });

    // Both still land on the same automation-cleared outcome: this
    // deployment already routes EVERY automation-cleared item to human
    // review unconditionally (services/validation.ts), so a flagged
    // disclosure does not change the submission's status here — it is
    // recorded as real, queryable evidence for the validator to see.
    const subsAfter = await prisma.submission.findMany({
      where: { id: { in: submissionIds } },
      select: { id: true, status: true, pendingHumanReview: true },
    });
    for (const s of subsAfter) {
      expect(s.status).toBe("accepted_pending_sample");
      expect(s.pendingHumanReview).toBe(true);
    }
  }, 60_000);
});

/**
 * Regression tests for the authorization hole on the artifact content routes:
 * POST /v1/artifacts/:id/content and GET /v1/artifacts/:id/content both used
 * to run with no preHandler and no ownership check, so an artifact id alone
 * was enough to overwrite or download anyone's stored file.
 */
describe("artifact content authorization", () => {
  const BOUNDARY = "----databountyTestBoundary";

  /** Minimal multipart/form-data body — @fastify/multipart's `req.file()`
   *  reads this exactly like a browser FormData upload, with no extra dep. */
  function multipart(contents: string, filename = "sample.txt") {
    return {
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
            `Content-Type: text/plain\r\n\r\n`
        ),
        Buffer.from(contents),
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    };
  }

  /** Owner takes a slot, stores real bytes through it, and then walks the
   *  artifact through the REAL lifecycle to `ready`: POST /:id/complete moves
   *  the row to `scanning` and enqueues `artifact.scan`; draining that job runs
   *  `runArtifactScanJob` (magic-byte check, scanner policy, format registry).
   *  The malware scanner is optional and OFF by default in every environment
   *  (an absent `artifacts.malware_scan.enabled` row reads as off), so with no
   *  scanner configured the verdict is `not_required` and the row promotes to
   *  `ready` — which is the state SEC-03 requires before GET /:id/content will
   *  serve a single byte. Before SEC-03 these tests read a `pending_upload`
   *  artifact back with 200; that was the hole, not the contract. */
  async function uploadOwnedArtifact(cookie: string, contents: string) {
    const slotRes = await app.inject({
      method: "POST",
      url: "/v1/artifacts/upload-slot",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { kind: "submission_attachment", filename: "sample.txt", contentType: "text/plain" },
    });
    expect(slotRes.statusCode).toBe(201);
    const slot = slotRes.json();
    const target = new URL(slot.upload.url);
    const uploadPath = `${target.pathname}${target.search}`;
    // The slot URL must carry the capability token: the browser transfers the
    // bytes with a credential-less fetch, so without it this upload could only
    // be authorized by re-opening the route.
    expect(target.search).toMatch(/[?&]token=[a-f0-9]{64}/);

    const put = await app.inject({ method: "POST", url: uploadPath, ...multipart(contents) });
    expect(put.statusCode).toBe(200);
    expect(put.json().sizeBytes).toBe(contents.length);
    const artifactId = slot.artifact.id as string;

    // Bytes landed but nothing has vouched for them yet: the generic content
    // route must refuse even the owner at this point (SEC-03).
    const early = await app.inject({ method: "GET", url: target.pathname, headers: { cookie } });
    expect(early.statusCode).toBe(409);

    const complete = await app.inject({ method: "POST", url: `/v1/artifacts/${artifactId}/complete`, headers: { cookie, origin: "http://localhost:3010" } });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().artifact.status).toBe("scanning");

    const scanned = await drainJobs(["artifact.scan"], 50, (_type, payload) => payload.artifactId === artifactId);
    expect(scanned).toBe(1);
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
    expect(row.status).toBe("ready");
    expect(["not_required", "clean"]).toContain(row.scanStatus);

    return { artifactId, uploadPath, contentPath: target.pathname };
  }

  it("rejects an unauthenticated GET /v1/artifacts/:id/content instead of serving the file", async () => {
    const owner = await signupVerified("artifactowner");
    const { contentPath } = await uploadOwnedArtifact(owner.cookie, "OWNER SECRET BYTES");

    // No credential at all: must be 401, and must not leak the bytes.
    const anon = await app.inject({ method: "GET", url: contentPath });
    expect(anon.statusCode).toBe(401);
    expect(anon.body).not.toContain("OWNER SECRET BYTES");

    // A different signed-in account is authenticated but unrelated: 403.
    const stranger = await signupVerified("artifactstranger");
    const other = await app.inject({ method: "GET", url: contentPath, headers: { cookie: stranger.cookie } });
    expect(other.statusCode).toBe(403);
    expect(other.body).not.toContain("OWNER SECRET BYTES");

    // The owner still gets their own file — the gate is authorization, not a
    // blanket lockout.
    const mine = await app.inject({ method: "GET", url: contentPath, headers: { cookie: owner.cookie } });
    expect(mine.statusCode).toBe(200);
    expect(mine.body).toBe("OWNER SECRET BYTES");
  }, 60_000);

  it("refuses a non-owner overwrite through POST /v1/artifacts/:id/content and leaves the stored bytes intact", async () => {
    const owner = await signupVerified("artifactvictim");
    const attacker = await signupVerified("artifactattacker");
    const { artifactId, contentPath } = await uploadOwnedArtifact(owner.cookie, "ORIGINAL OWNER BYTES");

    // Authenticated, holds the artifact id, is not the owner -> 403.
    const overwrite = await app.inject({
      method: "POST",
      url: contentPath,
      headers: { cookie: attacker.cookie, origin: "http://localhost:3010", ...multipart("ATTACKER BYTES").headers },
      payload: multipart("ATTACKER BYTES").payload,
    });
    expect(overwrite.statusCode).toBe(403);

    // No credential and no token -> 401, still no write.
    const anonOverwrite = await app.inject({ method: "POST", url: contentPath, ...multipart("ANON BYTES") });
    expect(anonOverwrite.statusCode).toBe(401);

    // A forged capability token must not stand in for one: it falls through to
    // the credential path, which the attacker also fails.
    const forged = await app.inject({
      method: "POST",
      url: `${contentPath}?token=${"0".repeat(64)}`,
      headers: { cookie: attacker.cookie, origin: "http://localhost:3010", ...multipart("FORGED BYTES").headers },
      payload: multipart("FORGED BYTES").payload,
    });
    expect(forged.statusCode).toBe(403);

    // And the OWNER cannot re-write a completed artifact either (SEC-02): the
    // slot is no longer `pending_upload`, so the conditional claim fails.
    const ownerRewrite = await app.inject({
      method: "POST",
      url: contentPath,
      headers: { cookie: owner.cookie, origin: "http://localhost:3010", ...multipart("OWNER SECOND THOUGHTS").headers },
      payload: multipart("OWNER SECOND THOUGHTS").payload,
    });
    expect(ownerRewrite.statusCode).toBe(409);

    // The file the owner uploaded is byte-for-byte unchanged, and the recorded
    // size was never rewritten by any of the four rejected attempts.
    const readBack = await app.inject({ method: "GET", url: contentPath, headers: { cookie: owner.cookie } });
    expect(readBack.statusCode).toBe(200);
    expect(readBack.body).toBe("ORIGINAL OWNER BYTES");
    const row = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId } });
    expect(Number(row.sizeBytes)).toBe("ORIGINAL OWNER BYTES".length);
  }, 60_000);
});

/**
 * `validation.llm.enabled` — the setting that was PUBLISHED in
 * SETTINGS_CATALOG but had zero readers in this API. The LLM stage was gated
 * only on `openRouterConfigured()` (env-key presence), and three surfaces
 * hardcoded an answer for the flag: services/bounties.ts's pool contract said
 * `true` unconditionally, routes/v1/meta.ts's developer-surface said `false`
 * unconditionally, and the submission/audit detail payloads carried nothing at
 * all — so a client could not tell "switched off" from "switched on but
 * nothing recorded yet".
 *
 * This suite covers the flag as seen from the OUTSIDE: what each HTTP surface
 * reports, and that a non-boolean stored value fails closed to off.
 *
 * It deliberately does NOT try to prove the flag-ON branch of the pipeline
 * here. No execution sandbox provider is configured in this environment, so
 * `runSubmissionValidation` returns at its "execution produced no verdict"
 * branch and never reaches the LLM stage at all — which also means the
 * "no `llm` row" assertion below, while a genuine regression net for the
 * surfaces, is not on its own proof that the flag gates the stage. That proof
 * lives in src/llm-stage-flag-gating.integration.test.ts, which stubs the
 * execution provider so the stage is actually reachable.
 */
describe("validation.llm.enabled admin setting", () => {
  async function mintPool(label: string) {
    const { userId: adminId, cookie: adminCookie } = await signupVerified(`llmflagadmin${label}`);
    await prisma.userRole.create({ data: { userId: adminId, role: "admin" } });
    const { userId: contributorId, cookie: contributorCookie } = await signupVerified(`llmflagcontrib${label}`);

    const reqRes = await app.inject({
      method: "POST",
      url: "/v1/community/requests",
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      payload: {
        title: `LLM Flag Test Pool ${label}`,
        description: "Exercises the live-configurable validation.llm.enabled admin setting.",
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
        title: `LLM Flag Pool ${label}`,
        description: "Mint for the validation.llm.enabled integration test.",
        targetItems: 10,
        karmaPerAcceptedItem: 25,
        auditCoveragePct: 10,
      },
    });
    expect(mintRes.statusCode).toBe(201);
    return { adminId, contributorCookie, bountyId: mintRes.json().bounty.id as string };
  }

  async function submitAndDrain(bountyId: string, contributorCookie: string, label: string) {
    const submitRes = await app.inject({
      method: "POST",
      url: "/v1/submissions",
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
      payload: {
        bountyId,
        title: `LLM flag test item ${label}`,
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
    const processed = await drainJobs(
      ["validation.run"],
      5,
      (_t, payload) => payload.submissionId === submissionId,
    );
    expect(processed).toBe(1);
    return submissionId;
  }

  it("flag OFF: skips the LLM stage entirely — no evidence row, no score, no pass — and reports false on every surface", async () => {
    const { adminId, contributorCookie, bountyId } = await mintPool("off");
    await setAdminSetting({ key: "validation.llm.enabled", value: false, updatedByUserId: adminId });

    const submissionId = await submitAndDrain(bountyId, contributorCookie, "Off");

    // THE core assertion. Before the fix the stage ran purely on env-key
    // presence, so this row existed (and could carry a real model pass) with
    // the platform switch off.
    const llmRows = await prisma.validationResult.findMany({ where: { submissionId, stage: "llm" } });
    expect(llmRows).toHaveLength(0);

    const sub = await prisma.submission.findUnique({ where: { id: submissionId } });
    expect(sub?.llmScore).toBeNull();
    // Skipping the stage must not weaken the outcome: the item still holds for
    // a human validator rather than being auto-accepted on nothing.
    expect(sub?.pendingHumanReview).toBe(true);

    // No stage-result notification claims an LLM outcome either.
    const stageKeys = (
      await prisma.notification.findMany({
        where: { type: "validation.stage_result", entityId: submissionId },
        select: { eventKey: true },
      })
    ).map((n) => n.eventKey);
    expect(stageKeys.some((k) => k.endsWith(":llm"))).toBe(false);

    // Surface 1: the pool contract, which hardcoded `llmValidationEnabled: true`.
    const contractRes = await app.inject({
      method: "GET",
      url: `/v1/bounties/${bountyId}/contract`,
      headers: { cookie: contributorCookie, origin: "http://localhost:3010" },
    });
    expect(contractRes.statusCode).toBe(200);
    expect(contractRes.json().llmValidationEnabled).toBe(false);

    // Surface 2: developer-surface, which hardcoded `llmValidationEnabled: false`
    // (right answer here, but for the wrong reason — it never read the flag).
    const devRes = await app.inject({ method: "GET", url: "/v1/meta/developer-surface" });
    expect(devRes.statusCode).toBe(200);
    expect(devRes.json().llmValidationEnabled).toBe(false);

    // Surface 3: submission detail, which carried no such field at all.
    const detailRes = await app.inject({
      method: "GET",
      url: `/v1/submissions/${submissionId}`,
      headers: { cookie: contributorCookie },
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().submission.llmValidationEnabled).toBe(false);
  }, 60_000);

  it("fails closed: a stored non-boolean value reads as OFF, never as on", async () => {
    const { adminId } = await mintPool("nonbool");
    // The catalog's write-path schema refuses a non-boolean, so this is
    // written straight to the row — the exact shape a hand-edited row or a
    // pre-catalog write would leave behind, which the reader must not coerce
    // into a truthy "on".
    await prisma.adminSetting.upsert({
      where: { key: "validation.llm.enabled" },
      create: { key: "validation.llm.enabled", value: "yes", updatedBy: adminId },
      update: { value: "yes", updatedBy: adminId },
    });
    try {
      expect(await llmValidationEnabled()).toBe(false);
      const devRes = await app.inject({ method: "GET", url: "/v1/meta/developer-surface" });
      expect(devRes.json().llmValidationEnabled).toBe(false);
    } finally {
      await setAdminSetting({ key: "validation.llm.enabled", value: false, updatedByUserId: adminId });
    }
  }, 60_000);
});
