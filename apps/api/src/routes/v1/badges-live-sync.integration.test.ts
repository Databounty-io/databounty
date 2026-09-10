// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the badge-auto-award-never-fires-on-a-real-request
 * defect: `syncAndListBadges` (services/badges.ts) is the real evaluator —
 * real metrics, real qualification logic — but a fact-check audit flagged
 * that its only caller across the whole codebase was its own unit test, so a
 * contributor could satisfy every threshold and never actually see the badge
 * on any page they hit.
 *
 * That specific claim did not hold for `GET /v1/me/badges` and
 * `GET /v1/me/profile-sources` — both already route through
 * `getUserBadges()`, which itself calls `syncAndListBadges()` before reading
 * — but it DID hold for `GET /v1/community/karma`: that route built its
 * `badgeCatalog.earned` flags straight off a `userBadge.findMany` read with
 * no sync in front of it, so a member's own karma page could show a
 * just-qualified badge as `earned: false` until some unrelated surface
 * happened to trigger the sync first. That call site is fixed in this same
 * change (community.ts now awaits `syncAndListBadges(user.id)` before
 * building the catalog).
 *
 * This test proves the fix at the HTTP layer, not just by calling
 * `syncAndListBadges` directly (that path is already covered by
 * karma-badges-attribution.integration.test.ts): it drives a contributor
 * across the `accepted_work` badge's threshold via real submission rows,
 * then hits the real routes and asserts the badge actually appears —
 * without ever calling `syncAndListBadges` itself from the test.
 *
 * Same harness/self-guard pattern as the other route-level integration tests
 * in this directory: Fastify inject() against buildApp(), no port bound,
 * refuses to run outside the disposable verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SubmissionStatus } from "@prisma/client";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const RUN = `blsync_${Date.now().toString(36)}`;
const createdUserIds: string[] = [];
const createdBountyIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  // The badge catalog is seeded by migration 20260831120000_seed_badge_catalog.
  // If it is missing, every assertion below would pass vacuously because
  // "earned: false" would be the only possible value for any badge.
  const accepted = await prisma.badge.findUnique({ where: { key: "accepted_work" } });
  if (!accepted) {
    throw new Error("Badge catalog not seeded: 'accepted_work' badge is missing.");
  }
});

afterAll(async () => {
  await prisma.userBadge.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.submission.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.rank.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
  await prisma.$disconnect();
});

async function signupVerified(emailPrefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${emailPrefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email,
      password: "Test@12345",
      handle: `${emailPrefix}${stamp}`.replace(/[^a-z0-9]/gi, "").slice(0, 20),
      displayName: emailPrefix,
    },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

async function makeCommunityBounty(requesterUserId: string) {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId,
      communityRequesterUserId: requesterUserId,
      kind: "community",
      karmaPerAcceptedItem: 10,
      title: `${RUN} pool`,
      description: "Badge live-sync route regression fixture.",
      datasetCategory: "debugging",
      language: "typescript",
      framework: "none",
      targetItems: BigInt(10),
      auditMode: "partial",
      auditCoveragePct: 10,
      holdDays: 0,
      disputeWindowHours: 1,
      status: "active",
    },
  });
  createdBountyIds.push(bounty.id);
  return bounty;
}

async function makeAcceptedSubmission(bountyId: string, contributorUserId: string) {
  return prisma.submission.create({
    data: {
      bountyId,
      contributorUserId,
      title: `${RUN} item`,
      payloadJson: { prompt: "x" },
      generationMethod: "human",
      status: SubmissionStatus.accepted,
      acceptedAt: new Date(),
    },
  });
}

describe("badge auto-award fires on the real request path, not just when called directly", () => {
  it("GET /v1/me/badges awards a newly-qualified badge on the hit itself", async () => {
    const { userId, cookie } = await signupVerified("badgeroute-me");
    const bounty = await makeCommunityBounty(userId);

    // Before crossing the threshold: no accepted_work badge yet.
    const before = await app.inject({ method: "GET", url: "/v1/me/badges", headers: { cookie } });
    expect(before.statusCode).toBe(200);
    expect((before.json().badges as { badge: { key: string } }[]).map((b) => b.badge.key)).not.toContain(
      "accepted_work"
    );
    expect(await prisma.userBadge.count({ where: { userId, badge: { key: "accepted_work" } } })).toBe(0);

    // Cross the threshold via a real accepted submission row — no call to
    // syncAndListBadges anywhere in this test.
    await makeAcceptedSubmission(bounty.id, userId);

    // Hitting the route itself must both award AND surface the badge.
    const after = await app.inject({ method: "GET", url: "/v1/me/badges", headers: { cookie } });
    expect(after.statusCode).toBe(200);
    expect((after.json().badges as { badge: { key: string } }[]).map((b) => b.badge.key)).toContain(
      "accepted_work"
    );
    expect(await prisma.userBadge.count({ where: { userId, badge: { key: "accepted_work" } } })).toBe(1);

    // Idempotent: hitting the route again must not create a second award row.
    const again = await app.inject({ method: "GET", url: "/v1/me/badges", headers: { cookie } });
    expect(again.statusCode).toBe(200);
    expect(await prisma.userBadge.count({ where: { userId, badge: { key: "accepted_work" } } })).toBe(1);
  });

  it("GET /v1/community/karma marks a newly-qualified badge earned in badgeCatalog on the hit itself", async () => {
    const { userId, cookie } = await signupVerified("badgeroute-karma");
    const bounty = await makeCommunityBounty(userId);

    const before = await app.inject({ method: "GET", url: "/v1/community/karma", headers: { cookie } });
    expect(before.statusCode).toBe(200);
    const beforeCatalog = before.json().badgeCatalog as { key: string; earned: boolean }[];
    const beforeEntry = beforeCatalog.find((b) => b.key === "accepted_work");
    expect(beforeEntry?.earned).toBe(false);

    await makeAcceptedSubmission(bounty.id, userId);

    const after = await app.inject({ method: "GET", url: "/v1/community/karma", headers: { cookie } });
    expect(after.statusCode).toBe(200);
    const afterCatalog = after.json().badgeCatalog as { key: string; earned: boolean }[];
    const afterEntry = afterCatalog.find((b) => b.key === "accepted_work");
    expect(afterEntry?.earned).toBe(true);
    expect(await prisma.userBadge.count({ where: { userId, badge: { key: "accepted_work" } } })).toBe(1);
  });
});
