// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for GET /v1/me/audits (a validator's own claimed/decided
 * audit history) and the `workSummary.validator` counts on GET
 * /v1/me/validator-dashboard. Both were previously hardcoded to an empty/zero
 * shape — see services/audits.ts listMyAuditWindows / getMyAuditWorkSummary
 * and the comment this replaced in routes/v1/me.ts — even though
 * HumanAuditWindow carries real claimedByUserId/claimedAt/claimExpiresAt
 * columns (added for T1, services/audits.ts claimAuditWindow) that this route
 * can be scoped against.
 *
 * Same harness/self-guard and fixture shape as audit-claim.integration.test.ts
 * (seeds a HumanAuditWindow + selected HumanAuditWindowMembership rows over
 * real in_audit Submissions directly, rather than driving the full pool
 * sampling pipeline).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuditMode, DatasetCategory, GenerationMethod, SubmissionStatus } from "@prisma/client";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { releaseOverdueAudits } from "./services/audit-lifecycle.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdBountyIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.rank.deleteMany({ where: { userId: { in: createdUserIds } } });
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
      title: `me-audits fixture ${suffix}`,
      description: "fixture bounty for GET /v1/me/audits tests",
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
          title: `me-audits fixture item ${i}`,
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

  return { bountyId: bounty.id, windowId: window.id, submissionIds: submissions.map((s) => s.id) };
}

describe("GET /v1/me/audits", () => {
  it("shows a claimed window as status=claimed, then status=completed once decided", async () => {
    const owner = await signupVerified("meauditowner");
    const contributor = await signupVerified("meauditcontrib");
    const validator = await signupVerified("meauditvalidator");
    const { windowId, submissionIds } = await seedClaimableWindow({
      itemCount: 2,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });

    // Before claiming, nothing shows up in "my" audits — this validator
    // holds no claim yet.
    const beforeClaim = await app.inject({ method: "GET", url: "/v1/me/audits", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(beforeClaim.statusCode).toBe(200);
    expect(beforeClaim.json().audits.find((a: { id: string }) => a.id === windowId)).toBeUndefined();

    const claim = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(claim.statusCode).toBe(200);
    const claimExpiresAt = claim.json().audit.claimExpiresAt as string;

    // Claimed: appears with status "claimed", the real claim-expiry deadline,
    // and zero decisions so far.
    const afterClaim = await app.inject({ method: "GET", url: "/v1/me/audits", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(afterClaim.statusCode).toBe(200);
    const claimedRow = afterClaim.json().audits.find((a: { id: string }) => a.id === windowId);
    expect(claimedRow).toBeDefined();
    expect(claimedRow.status).toBe("claimed");
    expect(claimedRow.deadline).toBe(claimExpiresAt);
    expect(claimedRow.itemCount).toBe(2);
    expect(claimedRow.decidedCount).toBe(0);
    expect(claimedRow.bountyId).toBe(claim.json().audit.bountyId);

    // The status=claimed filter (the workspace's "In Progress" tab) returns it too.
    const filteredClaimed = await app.inject({ method: "GET", url: "/v1/me/audits?status=claimed", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(filteredClaimed.json().audits.map((a: { id: string }) => a.id)).toContain(windowId);
    // ...but the "completed" filter does not, yet.
    const filteredCompletedEarly = await app.inject({ method: "GET", url: "/v1/me/audits?status=completed", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(filteredCompletedEarly.json().audits.map((a: { id: string }) => a.id)).not.toContain(windowId);

    // The validator-dashboard's workSummary reflects the same claim.
    const dashboardMid = await app.inject({ method: "GET", url: "/v1/me/validator-dashboard", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(dashboardMid.json().workSummary.validator.claimedBatches).toBeGreaterThanOrEqual(1);
    expect(dashboardMid.json().workSummary.validator.pendingDecisions).toBeGreaterThanOrEqual(2);

    // Decide both items.
    const memberships = await prisma.humanAuditWindowMembership.findMany({ where: { windowId } });
    const decide = await app.inject({
      method: "POST",
      url: `/v1/audits/${windowId}/decisions`,
      headers: { cookie: validator.cookie, origin: "http://localhost:3010" },
      payload: {
        decisions: memberships.map((m) => ({ auditItemId: m.id, verdict: "ok" })),
      },
    });
    expect(decide.statusCode).toBe(200);

    // Now the window is settled — appears in history with status "completed".
    const afterDecide = await app.inject({ method: "GET", url: "/v1/me/audits", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    const completedRow = afterDecide.json().audits.find((a: { id: string }) => a.id === windowId);
    expect(completedRow).toBeDefined();
    expect(completedRow.status).toBe("completed");
    expect(completedRow.decidedCount).toBe(2);

    const filteredCompleted = await app.inject({ method: "GET", url: "/v1/me/audits?status=completed", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(filteredCompleted.json().audits.map((a: { id: string }) => a.id)).toContain(windowId);

    const dashboardAfter = await app.inject({ method: "GET", url: "/v1/me/validator-dashboard", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(dashboardAfter.json().workSummary.validator.completedBatches).toBeGreaterThanOrEqual(1);

    void submissionIds;
  });

  it("buckets a claim past its expiry as overdue_review, filterable by ?status=overdue", async () => {
    const owner = await signupVerified("meauditowner2");
    const contributor = await signupVerified("meauditcontrib2");
    const validator = await signupVerified("meauditvalidator2");
    const { windowId } = await seedClaimableWindow({
      itemCount: 1,
      contributorUserId: contributor.userId,
      requesterUserId: owner.userId,
    });

    const claim = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(claim.statusCode).toBe(200);

    // Simulate the 24h SLA having passed, without running the reaper yet —
    // this is the live-overdue state the reaper's next tick will act on.
    await prisma.humanAuditWindow.update({
      where: { id: windowId },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    const overdueRes = await app.inject({ method: "GET", url: "/v1/me/audits", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    const overdueRow = overdueRes.json().audits.find((a: { id: string }) => a.id === windowId);
    expect(overdueRow).toBeDefined();
    expect(overdueRow.status).toBe("overdue_review");

    const filteredOverdue = await app.inject({ method: "GET", url: "/v1/me/audits?status=overdue", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(filteredOverdue.json().audits.map((a: { id: string }) => a.id)).toContain(windowId);
    const filteredClaimed = await app.inject({ method: "GET", url: "/v1/me/audits?status=claimed", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(filteredClaimed.json().audits.map((a: { id: string }) => a.id)).not.toContain(windowId);

    // Once the reaper runs and this untouched claim is released back to the
    // pool, it must genuinely disappear from "my" audits — it is no longer
    // this validator's claim, and this route must never show a stale claim.
    const releasedCount = await releaseOverdueAudits();
    expect(releasedCount).toBeGreaterThanOrEqual(1);

    const afterReap = await app.inject({ method: "GET", url: "/v1/me/audits", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(afterReap.json().audits.find((a: { id: string }) => a.id === windowId)).toBeUndefined();
  });

  it("keeps a partially-decided overdue claim visible to its original validator after the reaper runs", async () => {
    const owner = await signupVerified("meauditowner3");
    const contributor = await signupVerified("meauditcontrib3");
    const validator = await signupVerified("meauditvalidator3");
    const { windowId, submissionIds } = await seedClaimableWindow({
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

    await releaseOverdueAudits();

    // A partially-decided overdue window keeps its original validator (the
    // reaper never reassigns recorded decisions) — it must still show up in
    // that validator's history, now with no further SLA tracked (claimed,
    // not overdue_review, since claimExpiresAt was cleared).
    const res = await app.inject({ method: "GET", url: "/v1/me/audits", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    const row = res.json().audits.find((a: { id: string }) => a.id === windowId);
    expect(row).toBeDefined();
    expect(row.status).toBe("claimed");
    expect(row.decidedCount).toBe(1);
    expect(row.deadline).toBeNull();
  });
});
