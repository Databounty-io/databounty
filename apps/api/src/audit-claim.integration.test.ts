// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for T1 (POST /v1/audits/:id/claim, evidence gated behind
 * the claim) and T3 (services/audit-lifecycle.ts releaseOverdueAudits, the
 * reaper). Same harness/self-guard as pipeline.integration.test.ts: Fastify
 * inject() against buildApp(), no port bound, refuses to run outside the
 * disposable verification database.
 *
 * Windows here are seeded directly (HumanAuditWindow + selected
 * HumanAuditWindowMembership rows over real Submission rows in `in_audit`),
 * rather than driving the full pool-close-out/sampling pipeline — that path
 * is already covered end to end by pipeline.integration.test.ts (which now
 * also exercises the claim step). This file isolates the claim/evidence/
 * reaper behavior itself.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ArtifactKind, ArtifactStatus, ArtifactVisibility, AuditMode, AuthMethod, DatasetCategory, GenerationMethod, SponsorExampleReviewStatus, SubmissionStatus } from "@prisma/client";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { deleteAuditRowsForBounties } from "./test-support/audit-cleanup.js";
import { releaseOverdueAudits } from "./services/audit-lifecycle.js";
import { CLAIM_SLA_MS } from "./services/audits.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdBountyIds: string[] = [];
const createdUserIds: string[] = [];

// A fresh app per test gives each test its own in-memory AUTH_RATE_LIMIT
// bucket (10 signups/min, hardcoded on the route — see auth.ts). Sharing one
// instance across this file's tests means their combined signups (up to 33
// across the file) stack up past the cap within the file's runtime,
// self-exhausting the bucket and failing later tests with 429s unrelated to
// the claim/reaper logic under test.
beforeEach(async () => {
  app = await buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.rank.deleteMany({ where: { userId: { in: createdUserIds } } });
  // Audit rows RESTRICT their submissions, which the bounty delete cascades to.
  await deleteAuditRowsForBounties(createdBountyIds);
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function signupVerified(emailPrefix: string) {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${emailPrefix}${Date.now()}${Math.random().toString(36).slice(2, 5)}`, displayName: emailPrefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

/** A community bounty with `itemCount` submissions already `in_audit`, and
 * one open HumanAuditWindow selecting all of them. */
async function seedClaimableWindow(params: { itemCount: number; contributorUserId: string; requesterUserId: string }) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: params.requesterUserId,
      title: `claim fixture ${suffix}`,
      description: "fixture bounty for audit-window claim tests",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(params.itemCount),
      // Must stay BELOW targetItems: the `bounties_required_sponsor_examples_bounds`
      // CHECK (restored from V1 by migration 20260902100000) rejects the schema
      // default of 3 against these fixtures' small itemCount.
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 100,
      holdDays: 0,
      karmaPerAcceptedItem: 25,
    },
  });
  createdBountyIds.push(bounty.id);

  const submissions = await Promise.all(
    Array.from({ length: params.itemCount }, (_, i) =>
      prisma.submission.create({
        data: {
          bountyId: bounty.id,
          contributorUserId: params.contributorUserId,
          title: `claim fixture item ${i}`,
          payloadJson: { i },
          generationMethod: GenerationMethod.human,
          status: SubmissionStatus.in_audit,
        },
      })
    )
  );

  const window = await prisma.humanAuditWindow.create({
    data: {
      bountyId: bounty.id,
      windowIndex: 1,
      eligibleCount: submissions.length,
      quota: submissions.length,
      closureReason: "test_fixture",
    },
  });
  await prisma.humanAuditWindowMembership.createMany({
    data: submissions.map((s, i) => ({
      windowId: window.id,
      submissionId: s.id,
      rank: `rank-${suffix}-${i}`,
      selected: true,
    })),
  });

  // The claimable batch that carries this window's per-item verdicts, exactly
  // as pool-lifecycle creates it at close-out (1:1 with the window chunk).
  // Without it the fixture would exercise a code path production no longer has
  // — and `submitAuditDecisions` would silently skip its verdict write.
  const auditBatch = await prisma.auditBatch.create({
    data: {
      bountyId: bounty.id,
      itemCount: submissions.length,
      status: "available",
      items: { create: submissions.map((s) => ({ submissionId: s.id })) },
    },
    select: { id: true },
  });
  await prisma.humanAuditWindow.update({
    where: { id: window.id },
    data: { auditBatchId: auditBatch.id },
  });

  return {
    bountyId: bounty.id,
    windowId: window.id,
    auditBatchId: auditBatch.id,
    submissionIds: submissions.map((s) => s.id),
  };
}

describe("POST /v1/audits/:id/claim — exclusivity", () => {
  it("lets exactly one of two racing validators win; the loser gets 409", async () => {
    const owner = await signupVerified("claimowner");
    const contributor = await signupVerified("claimcontrib");
    const validatorA = await signupVerified("claimvalidatora");
    const validatorB = await signupVerified("claimvalidatorb");
    const { windowId } = await seedClaimableWindow({
      itemCount: 3,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });

    const [resA, resB] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validatorA.cookie, origin: "http://localhost:3010" } }),
      app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validatorB.cookie, origin: "http://localhost:3010" } }),
    ]);

    const codes = [resA.statusCode, resB.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const winner = resA.statusCode === 200 ? { res: resA, userId: validatorA.userId } : { res: resB, userId: validatorB.userId };
    expect(winner.res.json().audit.claimedByUserId).toBe(winner.userId);

    // Live state agrees with the winner — a real exclusive claim, not just a
    // 200-vs-409 coin flip with the DB left ambiguous.
    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } });
    expect(stored.claimedByUserId).toBe(winner.userId);
    expect(stored.claimedAt).not.toBeNull();
    expect(stored.claimExpiresAt).not.toBeNull();
  });

  it("re-claiming your own already-claimed window is idempotent (200, same claimedAt), not a 409", async () => {
    const owner = await signupVerified("claimowner2");
    const contributor = await signupVerified("claimcontrib2");
    const validator = await signupVerified("claimvalidatorc");
    const { windowId } = await seedClaimableWindow({
      itemCount: 2,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });

    const first = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(second.statusCode).toBe(200);
    expect(second.json().audit.claimedAt).toBe(first.json().audit.claimedAt);
  });

  it("refuses a claim on a window the validator has a conflict on (own submission)", async () => {
    const owner = await signupVerified("claimowner3");
    const validator = await signupVerified("claimvalidatord");
    // The validator IS the contributor here — self-conflict.
    const { windowId } = await seedClaimableWindow({
      itemCount: 1,
      contributorUserId: validator.userId,
      requesterUserId: owner.userId,
    });

    const res = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(res.statusCode).toBe(403);
    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } });
    expect(stored.claimedByUserId).toBeNull();
  });
});

describe("POST /v1/audits/:id/claim — per-rank concurrency cap (T-capacity)", () => {
  it("rejects a second claim once a fresh (cap-1) validator already holds one window", async () => {
    const owner = await signupVerified("capowner1");
    const contributor = await signupVerified("capcontrib1");
    const validator = await signupVerified("capvalidator1");
    // Fresh validator, no Rank row yet -> auditsCompleted 0 -> Observer tier ->
    // maxConcurrentAudits 1 (services/reputation.ts VALIDATOR_RANK_TIERS).
    const windowA = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributor.userId, requesterUserId: owner.userId });
    const windowB = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributor.userId, requesterUserId: owner.userId });

    const first = await app.inject({ method: "POST", url: `/v1/audits/${windowA.windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: `/v1/audits/${windowB.windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toMatch(/maximum of 1 concurrent audits/);

    // The second window was genuinely left unclaimed, not silently granted.
    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowB.windowId } });
    expect(stored.claimedByUserId).toBeNull();
  });

  it("under real concurrency, lets exactly one of two claims through when the validator is one slot from their cap", async () => {
    const owner = await signupVerified("capowner2");
    const contributor = await signupVerified("capcontrib2");
    const validator = await signupVerified("capvalidator2");
    // Reviewer tier (minAudits 10) -> maxConcurrentAudits 2.
    await prisma.rank.upsert({
      where: { userId: validator.userId },
      update: { auditsCompleted: 10 },
      create: { userId: validator.userId, auditsCompleted: 10 },
    });

    const windowFilled = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributor.userId, requesterUserId: owner.userId });
    const windowB = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributor.userId, requesterUserId: owner.userId });
    const windowC = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributor.userId, requesterUserId: owner.userId });

    // Fill the first of 2 slots up front so the validator is exactly one slot
    // away from their cap before the real race below.
    const fill = await app.inject({ method: "POST", url: `/v1/audits/${windowFilled.windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(fill.statusCode).toBe(200);

    // Two DIFFERENT windows claimed truly concurrently by the same validator —
    // this is the actual race the naive "count active, then claim" approach
    // would lose: both requests could see activeCount=1 (< cap 2) and both
    // succeed, pushing the validator to 3/2. The transaction-scoped
    // pg_advisory_xact_lock in claimAuditWindow (services/audits.ts) serializes
    // these two attempts so the second one re-counts AFTER the first commits.
    const [resB, resC] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/audits/${windowB.windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } }),
      app.inject({ method: "POST", url: `/v1/audits/${windowC.windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } }),
    ]);

    const codes = [resB.statusCode, resC.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const rejected = resB.statusCode === 409 ? resB : resC;
    expect(rejected.json().message).toMatch(/maximum of 2 concurrent audits/);

    // Live DB state agrees: exactly 2 of the 3 windows are claimed by this
    // validator, never 3 — proving the guard is atomic, not just a
    // sequential check that happened to run fast enough in this one test.
    const claimedCount = await prisma.humanAuditWindow.count({
      where: { id: { in: [windowFilled.windowId, windowB.windowId, windowC.windowId] }, claimedByUserId: validator.userId },
    });
    expect(claimedCount).toBe(2);
  });
});

describe("GET /v1/audits/:id — evidence gated behind the claim", () => {
  it("refuses an unclaimed window with 409, and someone-else's claim with 403", async () => {
    const owner = await signupVerified("evidowner");
    const contributor = await signupVerified("evidcontrib");
    const validatorA = await signupVerified("evidvalidatora");
    const validatorB = await signupVerified("evidvalidatorb");
    const { windowId } = await seedClaimableWindow({
      itemCount: 2,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });

    const beforeClaim = await app.inject({ method: "GET", url: `/v1/audits/${windowId}`, headers: { cookie: validatorA.cookie, origin: "http://localhost:3010" } });
    expect(beforeClaim.statusCode).toBe(409);

    const claim = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validatorA.cookie, origin: "http://localhost:3010" } });
    expect(claim.statusCode).toBe(200);

    const otherValidator = await app.inject({ method: "GET", url: `/v1/audits/${windowId}`, headers: { cookie: validatorB.cookie, origin: "http://localhost:3010" } });
    expect(otherValidator.statusCode).toBe(403);

    const claimant = await app.inject({ method: "GET", url: `/v1/audits/${windowId}`, headers: { cookie: validatorA.cookie, origin: "http://localhost:3010" } });
    expect(claimant.statusCode).toBe(200);
    expect(claimant.json().audit.items).toHaveLength(2);
  });

  it("returns only ready, approved sponsor work-brief artifacts to the claimed validator", async () => {
    const owner = await signupVerified("briefowner");
    const contributor = await signupVerified("briefcontributor");
    const validator = await signupVerified("briefvalidator");
    const { bountyId, windowId } = await seedClaimableWindow({
      itemCount: 1,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });
    const visible = await prisma.artifact.create({
      data: {
        bountyId,
        ownerUserId: owner.userId,
        kind: ArtifactKind.sponsor_reference,
        visibility: ArtifactVisibility.work_brief,
        status: ArtifactStatus.ready,
        sponsorReviewStatus: SponsorExampleReviewStatus.approved,
        filename: "validator-brief.json",
        contentType: "application/json",
        storageKey: `artifacts/sponsor_reference/audit-claim/${windowId}/visible.json`,
      },
    });
    await prisma.artifact.create({
      data: {
        bountyId,
        ownerUserId: owner.userId,
        kind: ArtifactKind.sponsor_reference,
        visibility: ArtifactVisibility.private,
        status: ArtifactStatus.ready,
        sponsorReviewStatus: SponsorExampleReviewStatus.approved,
        filename: "private-owner-note.json",
        contentType: "application/json",
        storageKey: `artifacts/sponsor_reference/audit-claim/${windowId}/private.json`,
      },
    });

    const claim = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(claim.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/v1/audits/${windowId}`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().sponsorReferences).toEqual([
      expect.objectContaining({
        id: visible.id,
        filename: "validator-brief.json",
        downloadUrl: `/v1/artifacts/${visible.id}/content`,
      }),
    ]);
  });

  it("also refuses decisions from an unclaimed or someone-else's window (409 / 403)", async () => {
    const owner = await signupVerified("decowner");
    const contributor = await signupVerified("deccontrib");
    const validatorA = await signupVerified("decvalidatora");
    const validatorB = await signupVerified("decvalidatorb");
    const { windowId, submissionIds } = await seedClaimableWindow({
      itemCount: 1,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });
    const membership = await prisma.humanAuditWindowMembership.findFirstOrThrow({
      where: { windowId, submissionId: submissionIds[0] },
    });

    const unclaimedDecision = await app.inject({
      method: "POST",
      url: `/v1/audits/${windowId}/decisions`,
      headers: { cookie: validatorA.cookie, origin: "http://localhost:3010" },
      payload: { decisions: [{ auditItemId: membership.id, verdict: "ok" }] },
    });
    expect(unclaimedDecision.statusCode).toBe(409);

    await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validatorA.cookie, origin: "http://localhost:3010" } });

    const otherValidatorDecision = await app.inject({
      method: "POST",
      url: `/v1/audits/${windowId}/decisions`,
      headers: { cookie: validatorB.cookie, origin: "http://localhost:3010" },
      payload: { decisions: [{ auditItemId: membership.id, verdict: "ok" }] },
    });
    expect(otherValidatorDecision.statusCode).toBe(403);

    const claimantDecision = await app.inject({
      method: "POST",
      url: `/v1/audits/${windowId}/decisions`,
      headers: { cookie: validatorA.cookie, origin: "http://localhost:3010" },
      payload: { decisions: [{ auditItemId: membership.id, verdict: "ok" }] },
    });
    expect(claimantDecision.statusCode).toBe(200);
  });
});

describe("services/audit-lifecycle.ts releaseOverdueAudits — the reaper", () => {
  it("releases an overdue claim with nothing decided back to the pool, and records the miss", async () => {
    const owner = await signupVerified("reaperowner");
    const contributor = await signupVerified("reapercontrib");
    const validator = await signupVerified("reapervalidator");
    const { windowId, bountyId } = await seedClaimableWindow({
      itemCount: 2,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });

    const claim = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(claim.statusCode).toBe(200);

    // Simulate the 24h SLA having passed.
    await prisma.humanAuditWindow.update({
      where: { id: windowId },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    const releasedCount = await releaseOverdueAudits();
    expect(releasedCount).toBeGreaterThanOrEqual(1);

    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } });
    expect(stored.claimedByUserId).toBeNull();
    expect(stored.claimedAt).toBeNull();
    expect(stored.claimExpiresAt).toBeNull();

    const rank = await prisma.rank.findUnique({ where: { userId: validator.userId } });
    expect(rank?.validatorMissedDeadlines).toBe(1);

    // Released back to the pool — visible again via the listing endpoint.
    // Scoped with ?bountyId for the same reason as pipeline.integration.test:
    // an unscoped listing is ONE page ordered by closedAt desc, and the
    // v1 -> community cutover backfill stamps every migrated window with
    // closed_at = now(), so on migrated data those fill page 1 and this
    // `.find()` returned undefined.
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/audits?bountyId=${bountyId}`,
      headers: { cookie: validator.cookie, origin: "http://localhost:3010" },
    });
    const relisted = listRes.json().audits.find((a: { id: string }) => a.id === windowId);
    expect(relisted).toBeDefined();
  });

  it("keeps a partially-decided overdue claim with its original validator instead of releasing it", async () => {
    const owner = await signupVerified("reaperowner2");
    const contributor = await signupVerified("reapercontrib2");
    const validator = await signupVerified("reapervalidator2");
    const { windowId, bountyId, submissionIds } = await seedClaimableWindow({
      itemCount: 2,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });

    await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    const membership = await prisma.humanAuditWindowMembership.findFirstOrThrow({
      where: { windowId, submissionId: submissionIds[0] },
    });
    const decideOne = await app.inject({
      method: "POST",
      url: `/v1/audits/${windowId}/decisions`,
      headers: { cookie: validator.cookie, origin: "http://localhost:3010" },
      payload: { decisions: [{ auditItemId: membership.id, verdict: "ok" }] },
    });
    expect(decideOne.statusCode).toBe(200);

    await prisma.humanAuditWindow.update({
      where: { id: windowId },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    const releasedCount = await releaseOverdueAudits();
    expect(releasedCount).toBeGreaterThanOrEqual(1);

    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } });
    // Still owned by the original validator — a decided item's evidence and
    // reward must not be misattributed to whoever claims it next.
    expect(stored.claimedByUserId).toBe(validator.userId);
    expect(stored.claimedAt).not.toBeNull();
    // No further SLA tracked on this pass.
    expect(stored.claimExpiresAt).toBeNull();

    const rank = await prisma.rank.findUnique({ where: { userId: validator.userId } });
    expect(rank?.validatorMissedDeadlines).toBe(1);

    // Not released back to the pool.
    // Scoped with ?bountyId for the same reason as pipeline.integration.test:
    // an unscoped listing is ONE page ordered by closedAt desc, and the
    // v1 -> community cutover backfill stamps every migrated window with
    // closed_at = now(), so on migrated data those fill page 1 and this
    // `.find()` returned undefined.
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/audits?bountyId=${bountyId}`,
      headers: { cookie: validator.cookie, origin: "http://localhost:3010" },
    });
    const relisted = listRes.json().audits.find((a: { id: string }) => a.id === windowId);
    expect(relisted).toBeUndefined();
  });

  it("does not touch a claim that is still within its SLA", async () => {
    const owner = await signupVerified("reaperowner3");
    const contributor = await signupVerified("reapercontrib3");
    const validator = await signupVerified("reapervalidator3");
    const { windowId } = await seedClaimableWindow({
      itemCount: 1,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });
    await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });

    await releaseOverdueAudits();

    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } });
    expect(stored.claimedByUserId).toBe(validator.userId);
    expect(stored.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(stored.claimExpiresAt!.getTime() - stored.claimedAt!.getTime()).toBe(CLAIM_SLA_MS);
  });
});

/**
 * The gap that motivated porting AuditBatch/AuditItem in the first place.
 *
 * Before this, a validator's decision was never stored — the verdict was
 * re-derived from `submissions.status` and the reason/note came from the
 * `flags` table. That works for a FLAGGED item. It cannot work for an approved
 * one: `flags` has no row for an accepted submission, so `submitAuditDecisions`
 * accepted a `note` on an `ok` verdict and silently discarded it.
 *
 * Not hypothetical — the 16,988 audit items migrated from v1 carry 1,287 notes,
 * and 422 of them sit on `verdict: ok` items this deployment could not have
 * represented at all.
 */
describe("validator decisions are recorded, not just derived", () => {
  it("keeps an APPROVING validator's note — the case flags could never hold", async () => {
    const owner = await signupVerified("noteowner");
    const contributor = await signupVerified("notecontrib");
    const validator = await signupVerified("notevalidator");
    const { windowId, auditBatchId, submissionIds } = await seedClaimableWindow({
      itemCount: 1,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });
    await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });

    const membership = await prisma.humanAuditWindowMembership.findFirstOrThrow({ where: { windowId } });
    const note = "Ran the harness locally; output matches the expected trace exactly.";

    const res = await app.inject({
      method: "POST",
      url: `/v1/audits/${windowId}/decisions`,
      headers: { cookie: validator.cookie, origin: "http://localhost:3010" },
      payload: { decisions: [{ auditItemId: membership.id, verdict: "ok", note }] },
    });
    expect(res.statusCode).toBe(200);

    const item = await prisma.auditItem.findFirstOrThrow({
      where: { auditBatchId, submissionId: submissionIds[0]! },
    });
    expect(item.verdict).toBe("ok");
    expect(item.note).toBe(note);          // the whole point
    expect(item.flagReason).toBeNull();    // an approval carries no flag reason
    expect(item.decidedAt).not.toBeNull(); // and a real decision timestamp

    // The submission is genuinely accepted, and no flag was invented to carry
    // the note — that would have made an approval look like a rejection.
    const sub = await prisma.submission.findUniqueOrThrow({ where: { id: submissionIds[0]! } });
    expect(sub.status).toBe(SubmissionStatus.accepted);
    expect(await prisma.flag.count({ where: { submissionId: submissionIds[0]! } })).toBe(0);
  });

  it("records a flagged verdict with its reason and note, alongside the Flag row", async () => {
    const owner = await signupVerified("flagowner2");
    const contributor = await signupVerified("flagcontrib2");
    const validator = await signupVerified("flagvalidator2");
    const { windowId, auditBatchId, submissionIds } = await seedClaimableWindow({
      itemCount: 1,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });
    await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });

    const membership = await prisma.humanAuditWindowMembership.findFirstOrThrow({ where: { windowId } });
    const note = "The provided tests never exercise the branch the task asks for.";

    const res = await app.inject({
      method: "POST",
      url: `/v1/audits/${windowId}/decisions`,
      headers: { cookie: validator.cookie, origin: "http://localhost:3010" },
      payload: {
        decisions: [{ auditItemId: membership.id, verdict: "flagged", flagReason: "tests_invalid", note }],
      },
    });
    expect(res.statusCode).toBe(200);

    const item = await prisma.auditItem.findFirstOrThrow({
      where: { auditBatchId, submissionId: submissionIds[0]! },
    });
    expect(item.verdict).toBe("flagged");
    expect(item.flagReason).toBe("tests_invalid");
    expect(item.note).toBe(note);
    expect(item.decidedAt).not.toBeNull();

    // The Flag row still exists — the audit item records the DECISION, it does
    // not replace the flag that drives the contributor's revision flow.
    const flag = await prisma.flag.findFirstOrThrow({ where: { submissionId: submissionIds[0]! } });
    expect(flag.reason).toBe("tests_invalid");
    expect(flag.details).toBe(note);
  });
});
