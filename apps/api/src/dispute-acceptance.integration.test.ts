// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for POST /v1/submissions/:id/dispute-acceptance
 * (routes/v1/submissions.ts) — the requester's ("sponsor") counterpart to the
 * contributor's own-rejection `/dispute` route.
 *
 * Background: the sponsor submission page
 * (apps/web/app/(app)/sponsor/[id]/view.tsx) had a "dispute" button that
 * called the CONTRIBUTOR-scoped `/dispute` route for ANY non-disputed
 * submission. That route is gated `contributorUserId === user.id`, so for a
 * sponsor it always 404'd — a dead button. v1's real design
 * (databounty-api/src/routes/v1/submissions.ts `dispute-acceptance`) is a
 * separate, requester-owned endpoint that disputes an ALREADY-ACCEPTED item
 * during its post-accept hold window. This file covers the ported endpoint:
 *
 *  1. The requester disputes an accepted item within its hold window -> 201,
 *     a Dispute row is created, and the submission flips to `disputed`.
 *  2. The same action after the hold window has closed -> a clear 409
 *     conflict, never a 500.
 *  3. A non-owning caller (not the requester, not an admin) -> 403, proving
 *     the ownership check (`communityRequesterUserId ?? requesterUserId`)
 *     actually gates the route.
 *
 * The hold window itself is NOT reinvented here — the route reuses
 * `holdReleasesAt`/`defaultDisputeWindowHours` from services/karma-holds.ts,
 * the same anchor that already gates when a submission's karma award
 * releases. Scenario 2 forces the window closed by setting
 * `bounty.disputeWindowHours: 0` and backdating `submission.acceptedAt`,
 * rather than waiting on a real clock.
 *
 * Same harness/self-guard pattern as the other *.integration.test.ts files:
 * Fastify inject() against buildApp(), no port bound, refuses to run outside
 * the disposable verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ArtifactKind, ArtifactStatus, SponsorExampleReviewStatus } from "@prisma/client";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { putArtifactData } from "./services/storage.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

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
    explanation: `dispute-acceptance fixture ${seed}`,
    bug_type: "off_by_one",
  };
}

/**
 * Owner decision, 2026-09-09 (admin-community.ts): a community request can no
 * longer be minted with zero approved sponsor_reference samples — both mint
 * routes now return 409 "no_samples" until at least one is approved. Seeds
 * that precondition directly, same pattern as pipeline.integration.test.ts.
 */
async function seedApprovedSample(requestId: string, ownerUserId: string) {
  const storageKey = `artifacts/sponsor_reference/dispute-acceptance-fixture/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await putArtifactData(
    storageKey,
    Buffer.from(JSON.stringify({ instruction: "Fixture reference sample for dispute-acceptance.integration.test.ts." }), "utf8"),
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

/** Mints a live pool and returns its owning requester + a helper to seed an
 * `accepted` submission directly (bypassing the intake pipeline, same
 * rationale as submission-revision.integration.test.ts: the job queue is
 * global and shared with other parallel suites). */
async function seedAcceptedPool(prefix: string) {
  const { userId: adminId, cookie: adminCookie } = await signupVerified(`${prefix}admin`);
  await prisma.userRole.create({ data: { userId: adminId, role: "admin" } });
  const { userId: contributorId } = await signupVerified(`${prefix}contrib`);
  const { userId: requesterId, cookie: requesterCookie } = await signupVerified(`${prefix}req`);

  const reqRes = await app.inject({
    method: "POST",
    url: "/v1/community/requests",
    headers: { cookie: requesterCookie, origin: "http://localhost:3010" },
    payload: {
      title: `Dispute Acceptance Pool ${prefix}`,
      description: "Fixture pool for the dispute-acceptance integration tests.",
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
      title: `Dispute Acceptance Pool ${prefix}`,
      description: "Minted pool for the dispute-acceptance integration tests.",
      targetItems: 50,
      karmaPerAcceptedItem: 25,
      auditCoveragePct: 10,
    },
  });
  expect(mintRes.statusCode).toBe(201);
  const bountyId = mintRes.json().bounty.id as string;

  async function seedAccepted(seed: string, opts: { acceptedAt: Date; disputeWindowHours?: number | null } = { acceptedAt: new Date() }) {
    if (opts.disputeWindowHours !== undefined) {
      await prisma.bounty.update({ where: { id: bountyId }, data: { disputeWindowHours: opts.disputeWindowHours } });
    }
    const submission = await prisma.submission.create({
      data: {
        bountyId,
        contributorUserId: contributorId,
        title: `${prefix} ${seed}`,
        payloadJson: payload(`${prefix}-${seed}`),
        generationMethod: "human",
        dedupeKey: `disputeacc-${prefix}-${seed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: "accepted",
        acceptedAt: opts.acceptedAt,
      },
    });
    return submission.id;
  }

  return { bountyId, contributorId, requesterId, requesterCookie, seedAccepted };
}

// Takes ~4.6s: sign-in -> pool -> submission -> accept -> dispute, all over
// real HTTP against a real database. The suite-wide 30s `testTimeout` in
// vitest.config.ts is what keeps this honest; vitest's 5s default failed it
// only under load, which is a false signal, not a slow endpoint.
describe("POST /v1/submissions/:id/dispute-acceptance", () => {
  it("lets the requester dispute an accepted item within its hold window", async () => {
    const pool = await seedAcceptedPool("withinwindow");
    // Default dispute window (48h) with acceptedAt now — well within the window.
    const submissionId = await pool.seedAccepted("s1", { acceptedAt: new Date() });

    const res = await app.inject({
      method: "POST",
      url: `/v1/submissions/${submissionId}/dispute-acceptance`,
      headers: { cookie: pool.requesterCookie, origin: "http://localhost:3010" },
      payload: { reason: "solution_incorrect", argument: "This item should not have been accepted as-is." },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.dispute.status).toBe("open");
    expect(body.dispute.submissionId).toBe(submissionId);

    const updated = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(updated.status).toBe("disputed");

    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: body.dispute.id } });
    expect(dispute.raisedByUserId).toBe(pool.requesterId);
  });

  it("rejects with a clear 409 (not a 500) once the hold window has closed", async () => {
    const pool = await seedAcceptedPool("closedwindow");
    // Zero-hour window + an acceptedAt an hour in the past: guaranteed closed,
    // no race against the real clock.
    const acceptedAt = new Date(Date.now() - 60 * 60 * 1000);
    const submissionId = await pool.seedAccepted("s1", { acceptedAt, disputeWindowHours: 0 });

    const res = await app.inject({
      method: "POST",
      url: `/v1/submissions/${submissionId}/dispute-acceptance`,
      headers: { cookie: pool.requesterCookie, origin: "http://localhost:3010" },
      payload: { reason: "solution_incorrect", argument: "Too late, but should still fail cleanly." },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/window.*closed/i);

    const unchanged = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(unchanged.status).toBe("accepted");
  });

  it("rejects a non-owning caller with 403", async () => {
    const pool = await seedAcceptedPool("nonowner");
    const submissionId = await pool.seedAccepted("s1", { acceptedAt: new Date() });
    const { cookie: strangerCookie } = await signupVerified("disputeaccstranger");

    const res = await app.inject({
      method: "POST",
      url: `/v1/submissions/${submissionId}/dispute-acceptance`,
      headers: { cookie: strangerCookie, origin: "http://localhost:3010" },
      payload: { reason: "solution_incorrect", argument: "I have no standing to dispute this item." },
    });

    expect(res.statusCode).toBe(403);

    const unchanged = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(unchanged.status).toBe("accepted");
  });
});
