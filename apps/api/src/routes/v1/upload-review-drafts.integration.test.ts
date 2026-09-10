// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for routes/v1/upload-review-drafts.ts.
 *
 * Two defects fixed here:
 *  1. GET /v1/upload-review-drafts/:id ran with no preHandler at all and
 *     serialized the full `sourceArtifact` relation (filename, storage key,
 *     scan verdict) for ANY draft id, to anyone. Now requires either the
 *     owning dashboard session or the draft-scoped access token minted at
 *     redemption, and never serializes the artifact row.
 *  2. Six endpoints the web app's `/upload/[token]` handoff page depends on
 *     (redeem, rejected-rows, cancel, source-slot, source-complete,
 *     attach-source) did not exist, so that page 404'd unconditionally.
 *
 * The submit describe block below was rewritten for the real async submit
 * pipeline (services/jobs/upload-draft-submit.ts): POST /:id/submit now only
 * CAS-claims the draft into "submitting" and enqueues a job (202), it never
 * creates Submission rows itself. These tests seed a draft directly at
 * status "review_ready" with SubmissionUploadDraftItem rows (what a real
 * bulk-source-parse run would have produced) rather than driving a real file
 * upload/scan/parse — that machinery is covered by
 * services/jobs/bulk-source-parse.integration.test.ts and
 * services/jobs/upload-draft-submit.integration.test.ts covers the job's own
 * ingest/atomicity/capacity behavior in depth; this file only proves the
 * ROUTE's claim/enqueue/idempotency contract.
 *
 * Uses Fastify's inject() against buildApp(), same pattern as
 * pipeline.integration.test.ts. Self-guards against the disposable test
 * database exactly like that file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ArtifactKind, ArtifactStatus, SponsorExampleReviewStatus } from "@prisma/client";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { runUploadDraftSubmitJob } from "../../services/jobs/upload-draft-submit.js";
import { putArtifactData } from "../../services/storage.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdBountyIds: string[] = [];

// A fresh app per test gives each test its own in-memory AUTH_RATE_LIMIT
// bucket (10 signups/min, hardcoded on the route — see auth.ts). Sharing one
// instance across this file's tests means their combined signups stack up
// past the cap within the file's few-second runtime, self-exhausting the
// bucket and failing later tests with 429s unrelated to the drafts logic
// under test.
beforeEach(async () => {
  app = await buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.submissionUploadDraft.deleteMany({ where: { ownerUserId: { in: createdUserIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

function uniqueSuffix(): string {
  return `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

async function signupVerified(prefix: string) {
  const stamp = uniqueSuffix();
  const email = `${prefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${prefix}${stamp}`, displayName: prefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  createdUserIds.push(userId);
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
 * lifecycle and the admin sponsor-review action, which are covered by
 * community.requests-samples.integration.test.ts and
 * bounties.public-samples.integration.test.ts), same fixture used by
 * pipeline.integration.test.ts, since this file's fixtures only need the gate
 * cleared, not the review flow itself exercised.
 */
async function seedApprovedSample(requestId: string, ownerUserId: string) {
  const storageKey = `artifacts/sponsor_reference/upload-draft-fixture/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await putArtifactData(
    storageKey,
    Buffer.from(JSON.stringify({ instruction: "Fixture reference sample for upload-review-drafts.integration.test.ts." }), "utf8"),
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

/** Mints a real, active community bounty via the actual admin-mint route so
 * the draft's `bountyId` refers to a genuine pool, exactly like the rest of
 * the pipeline suite. */
async function mintCommunityBounty(owner: { userId: string; cookie: string }) {
  const admin = await signupVerified("uploaddraftadmin");
  await prisma.userRole.create({ data: { userId: admin.userId, role: "admin" } });

  const reqRes = await app.inject({
    method: "POST",
    url: "/v1/community/requests",
    headers: { cookie: owner.cookie, origin: "http://localhost:3010" },
    payload: {
      title: `Upload Review Draft Test Pool ${uniqueSuffix()}`,
      description: "Exercises the upload-review-drafts routes end to end.",
      datasetTypeId: "debugging",
      domain: "coding",
      targetItems: 10,
      auditCoveragePct: 100,
    },
  });
  expect(reqRes.statusCode).toBe(201);
  const requestId = reqRes.json().request.id as string;
  await seedApprovedSample(requestId, owner.userId);

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
    headers: { cookie: admin.cookie, origin: "http://localhost:3010" },
    payload: {
      title: `Upload Review Draft Test Pool ${uniqueSuffix()}`,
      description: "Minted pool for the upload-review-drafts integration test.",
      targetItems: 10,
      karmaPerAcceptedItem: 25,
      auditCoveragePct: 100,
    },
  });
  expect(mintRes.statusCode).toBe(201);
  const bountyId = mintRes.json().bounty.id as string;
  createdBountyIds.push(bountyId);
  return bountyId;
}

async function createDraft(cookie: string, bountyId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/upload-review-drafts",
    headers: { cookie, origin: "http://localhost:3010" },
    payload: { bountyId, generationMethod: "human", expectedItemCount: 5 },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { draftId: string; handoffUrl: string };
  expect(body.draftId).toBeTruthy();
  // handoffUrl is /upload/<token> — pull the token back out for redeem.
  const token = new URL(body.handoffUrl).pathname.split("/").pop()!;
  expect(token.length).toBeGreaterThanOrEqual(32);
  return { draftId: body.draftId, token };
}

describe("upload-review-drafts: GET /:id authorization leak", () => {
  it("proves the fix is non-vacuous: owner succeeds with safe fields, unauthenticated and non-owner callers are rejected and leak nothing", async () => {
    const owner = await signupVerified("draftowner");
    const stranger = await signupVerified("draftstranger");
    const bountyId = await mintCommunityBounty(owner);
    const { draftId } = await createDraft(owner.cookie, bountyId);

    // Non-vacuity: the endpoint is reachable and DOES return real data for
    // the actual owner — this is not merely "everything 404s".
    const ownerRes = await app.inject({ method: "GET", url: `/v1/upload-review-drafts/${draftId}`, headers: { cookie: owner.cookie } });
    expect(ownerRes.statusCode).toBe(200);
    const ownerBody = ownerRes.json();
    expect(ownerBody.draft.id).toBe(draftId);
    expect(ownerBody.draft.bountyId).toBe(bountyId);
    expect(ownerBody.draft.status).toBe("awaiting_upload");
    // The fix: only the artifact's id may appear, never the artifact row
    // itself (filename / storage key / scan verdict) or either token hash.
    expect(ownerBody.draft.sourceArtifact).toBeUndefined();
    expect(JSON.stringify(ownerBody)).not.toMatch(/storageKey|storage_key|tokenHash|token_hash|accessTokenHash/);

    // No credential at all: 401, and the response carries no draft data.
    const anonRes = await app.inject({ method: "GET", url: `/v1/upload-review-drafts/${draftId}` });
    expect(anonRes.statusCode).toBe(401);
    expect(anonRes.body).not.toContain(draftId);
    expect(anonRes.body).not.toContain(bountyId);

    // Authenticated as a completely unrelated account: must NOT return the
    // draft. (Uniform 404, matching v1's draft-enumeration-prevention
    // choice — see resolveDraftAccess's docstring in the route file.)
    const strangerRes = await app.inject({
      method: "GET",
      url: `/v1/upload-review-drafts/${draftId}`,
      headers: { cookie: stranger.cookie },
    });
    expect(strangerRes.statusCode).toBe(404);
    expect(strangerRes.body).not.toContain(bountyId);
    expect(JSON.stringify(strangerRes.body)).not.toMatch(/storageKey|storage_key|tokenHash/);
  }, 60_000);
});

describe("upload-review-drafts: redeem — the browser handoff", () => {
  it("redeems a valid token with NO session at all, is single-use, and the minted access token then authorizes the draft with no session either", async () => {
    const owner = await signupVerified("draftredeemowner");
    const bountyId = await mintCommunityBounty(owner);
    const { draftId, token } = await createDraft(owner.cookie, bountyId);

    // Redeem with zero cookies / zero credentials of any kind — the link IS
    // the credential.
    const redeemRes = await app.inject({ method: "POST", url: "/v1/upload-review-drafts/redeem", payload: { token } });
    expect(redeemRes.statusCode).toBe(200);
    const redeemBody = redeemRes.json() as { draftId: string; accessToken: string; redirectPath: string };
    expect(redeemBody.draftId).toBe(draftId);
    expect(redeemBody.accessToken).toBeTruthy();
    expect(redeemBody.redirectPath).toBe(`/upload-review/${draftId}`);

    // Single-use: redeeming the same token again fails.
    const secondRedeem = await app.inject({ method: "POST", url: "/v1/upload-review-drafts/redeem", payload: { token } });
    expect(secondRedeem.statusCode).toBe(404);

    // The minted access token authorizes GET /:id with NO session cookie.
    const viaToken = await app.inject({
      method: "GET",
      url: `/v1/upload-review-drafts/${draftId}`,
      headers: { "x-upload-draft-token": redeemBody.accessToken },
    });
    expect(viaToken.statusCode).toBe(200);
    expect(viaToken.json().draft.id).toBe(draftId);

    // A garbage/forged token of the right shape does not work.
    const forged = await app.inject({
      method: "GET",
      url: `/v1/upload-review-drafts/${draftId}`,
      headers: { "x-upload-draft-token": "f".repeat(64) },
    });
    expect(forged.statusCode).toBe(404);

    // A missing/invalid handoff token is rejected the same way.
    const badRedeem = await app.inject({ method: "POST", url: "/v1/upload-review-drafts/redeem", payload: { token: "0".repeat(64) } });
    expect(badRedeem.statusCode).toBe(404);
  }, 60_000);

  it("rejects redeem with a missing/malformed body without ever touching the database", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/upload-review-drafts/redeem", payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe("upload-review-drafts: cancel — ownership and token scoping", () => {
  it("refuses a non-owner session and a wrong token, and burns the access token once cancelled", async () => {
    const owner = await signupVerified("draftcancelowner");
    const stranger = await signupVerified("draftcancelstranger");
    const bountyId = await mintCommunityBounty(owner);
    const { draftId, token } = await createDraft(owner.cookie, bountyId);

    const redeemRes = await app.inject({ method: "POST", url: "/v1/upload-review-drafts/redeem", payload: { token } });
    const { accessToken } = redeemRes.json() as { accessToken: string };

    // A signed-in stranger cannot cancel someone else's draft.
    const strangerCancel = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draftId}/cancel`,
      headers: { cookie: stranger.cookie, origin: "http://localhost:3010" },
    });
    expect(strangerCancel.statusCode).toBe(404);

    // A wrong access token cannot cancel it either.
    const wrongTokenCancel = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draftId}/cancel`,
      headers: { "x-upload-draft-token": "a".repeat(64) },
    });
    expect(wrongTokenCancel.statusCode).toBe(404);

    // The draft is untouched by either failed attempt.
    const stillOpen = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(stillOpen.status).toBe("awaiting_upload");
    expect(stillOpen.revokedAt).toBeNull();

    // The real access token succeeds.
    const cancelRes = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draftId}/cancel`,
      headers: { "x-upload-draft-token": accessToken },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json()).toEqual({ cancelled: true, draftId });

    const cancelled = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.revokedAt).not.toBeNull();
    expect(cancelled.accessTokenHash).toBeNull();

    // The now-burned access token no longer works for anything.
    const afterCancel = await app.inject({
      method: "GET",
      url: `/v1/upload-review-drafts/${draftId}`,
      headers: { "x-upload-draft-token": accessToken },
    });
    expect(afterCancel.statusCode).toBe(404);
  }, 60_000);
});

describe("upload-review-drafts: rejected-rows and source-slot", () => {
  it("rejected-rows is reachable via the access token and returns an honest empty report when nothing has been parsed", async () => {
    const owner = await signupVerified("draftrowsowner");
    const bountyId = await mintCommunityBounty(owner);
    const { draftId, token } = await createDraft(owner.cookie, bountyId);
    const { accessToken } = (
      await app.inject({ method: "POST", url: "/v1/upload-review-drafts/redeem", payload: { token } })
    ).json() as { accessToken: string };

    const res = await app.inject({
      method: "GET",
      url: `/v1/upload-review-drafts/${draftId}/rejected-rows`,
      headers: { "x-upload-draft-token": accessToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ draftId, rejectedRows: [] });

    const anon = await app.inject({ method: "GET", url: `/v1/upload-review-drafts/${draftId}/rejected-rows` });
    expect(anon.statusCode).toBe(401);
  }, 60_000);

  it("source-slot issues a real slot for the default structured-source profile, and rejects an extension outside it", async () => {
    // "debugging" (mintCommunityBounty's fixture type) has no
    // `verification.formatProfile` set, so it falls back to
    // `sourceUploadRequirements`'s "legacy-structured-source-v1" default —
    // .json/.jsonl/.ndjson/.csv/.tsv accepted, same as v1. This used to
    // assert the OPPOSITE (409 "does not use file uploads") because
    // `getPoolContractForBounty` hardcoded `sourceUpload.available: false`
    // for every dataset type; that was the bug, not the intended honesty
    // gate the test's name described, and is now fixed in
    // `lib/dataset-source-upload.ts`.
    const owner = await signupVerified("draftslotowner");
    const bountyId = await mintCommunityBounty(owner);
    const { draftId, token } = await createDraft(owner.cookie, bountyId);
    const { accessToken } = (
      await app.inject({ method: "POST", url: "/v1/upload-review-drafts/redeem", payload: { token } })
    ).json() as { accessToken: string };

    const draftRes = await app.inject({
      method: "GET",
      url: `/v1/upload-review-drafts/${draftId}`,
      headers: { "x-upload-draft-token": accessToken },
    });
    expect(draftRes.json().draft.sourceUpload.available).toBe(true);

    const ok = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draftId}/source-slot`,
      headers: { "x-upload-draft-token": accessToken },
      payload: { filename: "rows.jsonl", contentType: "application/jsonl", sizeBytes: 1024 },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().artifactId).toBeTruthy();

    // The gate is still real, not vacuous: an extension outside the
    // structured-source profile (an image, say) is still refused.
    const draft2 = await createDraft(owner.cookie, bountyId);
    const redeem2 = (
      await app.inject({ method: "POST", url: "/v1/upload-review-drafts/redeem", payload: { token: draft2.token } })
    ).json() as { accessToken: string };
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draft2.draftId}/source-slot`,
      headers: { "x-upload-draft-token": redeem2.accessToken },
      payload: { filename: "photo.png", contentType: "image/png", sizeBytes: 1024 },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().message).toMatch(/file's type is not accepted/i);
  }, 60_000);
});


/** Directly seeds a draft at status "review_ready" with the given usable/
 * unusable rows — what a real `bulk_source.parse` run would have produced —
 * without driving an actual file upload/scan/parse. `usableCount` rows carry
 * a real payload; the rest carry `errorCode` and must never be submitted. */
async function seedReviewReadyDraft(ownerCookie: string, bountyId: string, usableCount: number, unusableCount = 0) {
  const { draftId, token } = await createDraft(ownerCookie, bountyId);
  const { accessToken } = (
    await app.inject({ method: "POST", url: "/v1/upload-review-drafts/redeem", payload: { token } })
  ).json() as { accessToken: string };

  const rows = [
    ...Array.from({ length: usableCount }, (_, i) => ({
      draftId,
      rowNumber: i + 1,
      payload: { instruction: `row ${i + 1}` },
      errorCode: null as string | null,
      errorMessage: null as string | null,
    })),
    ...Array.from({ length: unusableCount }, (_, i) => ({
      draftId,
      rowNumber: usableCount + i + 1,
      payload: undefined,
      errorCode: "NOT_AN_OBJECT",
      errorMessage: "fixture error",
    })),
  ];
  if (rows.length > 0) {
    await prisma.submissionUploadDraftItem.createMany({ data: rows });
  }
  await prisma.submissionUploadDraft.update({ where: { id: draftId }, data: { status: "review_ready" } });

  return { draftId, accessToken };
}

describe("upload-review-drafts: submit — async claim-and-enqueue contract", () => {
  it("claims a review-ready draft into submitting and enqueues the real ingest job; a background run then finalizes it and burns the access token", async () => {
    const owner = await signupVerified("draftsubmitowner");
    const bountyId = await mintCommunityBounty(owner);
    const { draftId, accessToken } = await seedReviewReadyDraft(owner.cookie, bountyId, 3, 1);

    const submitRes = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draftId}/submit`,
      headers: { "x-upload-draft-token": accessToken },
    });
    expect(submitRes.statusCode).toBe(202);
    expect(submitRes.json()).toMatchObject({ submitted: false, submitting: true, draftId, count: 3 });

    const claimed = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(claimed.status).toBe("submitting");
    // Not yet burned — the job hasn't run yet, and the route itself never
    // creates a Submission or finalizes the draft.
    expect(claimed.accessTokenHash).not.toBeNull();
    const submissionsBeforeJob = await prisma.submission.count({ where: { bountyId } });
    expect(submissionsBeforeJob).toBe(0);

    // A second call while "submitting" is a conflict, not a duplicate enqueue.
    const whileSubmitting = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draftId}/submit`,
      headers: { "x-upload-draft-token": accessToken },
    });
    expect(whileSubmitting.statusCode).toBe(409);

    // Run the background job directly (same function worker.ts's
    // "upload_draft.submit" case calls) rather than spinning up the poller.
    await runUploadDraftSubmitJob(draftId);

    const finished = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(finished.status).toBe("submitted");
    expect(finished.submittedAt).not.toBeNull();
    expect(finished.accessTokenHash).toBeNull();
    const submissionsAfterJob = await prisma.submission.count({ where: { bountyId } });
    expect(submissionsAfterJob).toBe(3);

    // The now-burned access token can no longer authorize anything on this draft.
    const afterFinish = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draftId}/submit`,
      headers: { "x-upload-draft-token": accessToken },
    });
    expect(afterFinish.statusCode).toBe(404);

    // But the owner's own session still sees it, idempotently — no new job,
    // no new submissions.
    const ownerReplay = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draftId}/submit`,
      headers: { cookie: owner.cookie, origin: "http://localhost:3010" },
    });
    expect(ownerReplay.statusCode).toBe(200);
    expect(ownerReplay.json()).toMatchObject({ ok: true, draftId, alreadySubmitted: true });
    const submissionsAfterReplay = await prisma.submission.count({ where: { bountyId } });
    expect(submissionsAfterReplay).toBe(3);
  }, 60_000);

  it("refuses to claim a draft that has not finished being reviewed yet", async () => {
    const owner = await signupVerified("draftsubmitnotready");
    const bountyId = await mintCommunityBounty(owner);
    // createDraft() leaves the draft at "awaiting_upload" — never parsed.
    const { draftId, token } = await createDraft(owner.cookie, bountyId);
    const { accessToken } = (
      await app.inject({ method: "POST", url: "/v1/upload-review-drafts/redeem", payload: { token } })
    ).json() as { accessToken: string };

    const res = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draftId}/submit`,
      headers: { "x-upload-draft-token": accessToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/not finished being reviewed/i);

    const draft = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(draft.status).toBe("awaiting_upload"); // untouched
  }, 60_000);

  it("refuses to claim a review-ready draft with zero usable rows", async () => {
    const owner = await signupVerified("draftsubmitnorows");
    const bountyId = await mintCommunityBounty(owner);
    const { draftId, accessToken } = await seedReviewReadyDraft(owner.cookie, bountyId, 0, 2);

    const res = await app.inject({
      method: "POST",
      url: `/v1/upload-review-drafts/${draftId}/submit`,
      headers: { "x-upload-draft-token": accessToken },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/no valid rows/i);

    const draft = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(draft.status).toBe("review_ready"); // untouched — never claimed
  }, 60_000);

  it("two concurrent submit calls on the same draft: exactly one wins the claim (202), the other loses it (409), and the row set is created exactly once", async () => {
    const owner = await signupVerified("draftsubmitrace");
    const bountyId = await mintCommunityBounty(owner);
    const { draftId, accessToken } = await seedReviewReadyDraft(owner.cookie, bountyId, 4);

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/upload-review-drafts/${draftId}/submit`,
        headers: { "x-upload-draft-token": accessToken },
      }),
      app.inject({
        method: "POST",
        url: `/v1/upload-review-drafts/${draftId}/submit`,
        headers: { "x-upload-draft-token": accessToken },
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    // Exactly one 202 (won the CAS claim) and one 409 (lost it) — never two
    // 202s, which would mean the guarded updateMany let both callers through.
    expect(statuses).toEqual([202, 409]);

    const claimed = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(claimed.status).toBe("submitting");

    // Running the job (whichever caller's enqueue "won" points at the same
    // draftId either way, since the idempotency key is draft-scoped) must
    // create the row set exactly once, not twice.
    await runUploadDraftSubmitJob(draftId);
    const submissions = await prisma.submission.count({ where: { bountyId } });
    expect(submissions).toBe(4);
  }, 60_000);
});
