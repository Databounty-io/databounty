// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the 2026-09-10 owner decision: an under-target community pool
 * whose dispute window elapses should REOPEN (go back to accepting
 * contributions) instead of settling `partially_completed` forever —
 * UNLESS the sponsor has explicitly asked to close it early via the new
 * `POST /v1/bounties/:id/close-pool` route (`Bounty.sponsorClosedAt`).
 *
 * Two things under test:
 *  1. `settleDueCommunityPools` (services/pool-lifecycle.ts) — the reopen-vs-
 *     settle branch added for this decision.
 *  2. The new route itself, end to end via a real Fastify app and
 *     `app.inject()`, same harness as
 *     `routes/v1/admin-community.sponsor-examples.integration.test.ts`.
 *
 * Self-guarded like every other integration test in this repo: refuses to
 * run unless DATABASE_URL points at a disposable local database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  AuditMode,
  CommunityPublicationStatus,
  DatasetCategory,
  GenerationMethod,
  SubmissionStatus,
} from "@prisma/client";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { settleDueCommunityPools } from "./pool-lifecycle.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

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
  await prisma.jobQueue.deleteMany({ where: { idempotencyKey: { in: createdBountyIds.flatMap((id) => [`pool-sample:${id}`, `community.publish:${id}`]) } } });
  await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: createdBountyIds } } });
  await prisma.datasetPublication.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.submission.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

function uniqueStamp(): string {
  return `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

async function makeUser(suffix: string) {
  const stamp = uniqueStamp();
  const user = await prisma.user.create({
    data: {
      authMethod: "email",
      email: `sponsor-close-${suffix}-${stamp}@test.local`,
      passwordHash: "x",
      displayName: `Sponsor Close Test ${suffix}`,
      status: "active",
      handle: `sc_test_${suffix}_${stamp}`,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

/** Signs up (and verifies) a fresh user through the real HTTP auth routes so
 * the returned session cookie is the genuine article, same pattern as
 * `admin-community.sponsor-examples.integration.test.ts`. */
async function signupUser(emailPrefix: string) {
  const stamp = uniqueStamp();
  const email = `${emailPrefix}-${stamp}@test.local`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${emailPrefix}${stamp}`.slice(0, 30), displayName: emailPrefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { userId, cookie };
}

async function makeCommunityBounty(params: { requesterUserId: string; targetItems?: number; poolClosedAt?: Date | null; disputeCycleWindowOpensAt?: Date | null; sponsorClosedAt?: Date | null }) {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: params.requesterUserId,
      kind: "community",
      status: "active",
      title: `sponsor-close fixture ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      description: "fixture bounty for sponsor early-close / reopen-vs-settle tests",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(params.targetItems ?? 2),
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 100,
      holdDays: 0,
      disputeWindowHours: 0, // elapses immediately once opened — no real wait in a test
      karmaPerAcceptedItem: 10,
      communityLicense: "CC-BY-4.0",
      poolClosedAt: params.poolClosedAt ?? null,
      disputeCycleWindowOpensAt: params.disputeCycleWindowOpensAt ?? null,
      sponsorClosedAt: params.sponsorClosedAt ?? null,
    },
  });
  createdBountyIds.push(bounty.id);
  return bounty;
}

async function acceptSubmission(bountyId: string, contributorUserId: string, title: string) {
  return prisma.submission.create({
    data: {
      bountyId,
      contributorUserId,
      title,
      payloadJson: { prompt: title, answer: "42" },
      generationMethod: GenerationMethod.human,
      status: SubmissionStatus.accepted,
    },
  });
}

describe("settleDueCommunityPools — reopen vs settle (owner decision 2026-09-10)", () => {
  it("reopens an under-target pool whose dispute window elapsed, when the sponsor never asked to close early", async () => {
    const requester = await makeUser("reopen");
    const past = new Date(Date.now() - 60_000);
    const bounty = await makeCommunityBounty({
      requesterUserId: requester.id,
      targetItems: 2,
      poolClosedAt: past,
      disputeCycleWindowOpensAt: past,
      sponsorClosedAt: null,
    });
    // Only 1 of 2 target items final-accepted — genuinely under target.
    await acceptSubmission(bounty.id, requester.id, "only item");

    const outcome = await settleDueCommunityPools();
    expect(outcome.reopened).toBeGreaterThanOrEqual(1);

    const reopened = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
    expect(reopened.poolClosedAt).toBeNull();
    expect(reopened.disputeCycleWindowOpensAt).toBeNull();
    expect(reopened.poolSamplingStartedAt).toBeNull();
    expect(reopened.poolSamplingCompletedAt).toBeNull();
    expect(reopened.status).toBe("active");
    expect(reopened.disputeCycleSettledAt).toBeNull();
    expect(reopened.publicationStatus).toBe(CommunityPublicationStatus.not_requested);

    const job = await prisma.jobQueue.findUnique({ where: { idempotencyKey: `community.publish:${bounty.id}` } });
    expect(job).toBeNull();

    const auditRow = await prisma.adminAuditLog.findFirst({ where: { targetId: bounty.id, action: "community_pool.reopened" } });
    expect(auditRow).not.toBeNull();
  });

  it("settles an under-target pool partially_completed (and still auto-publishes) when the sponsor explicitly closed it early", async () => {
    const requester = await makeUser("sponsor-closed-settle");
    const past = new Date(Date.now() - 60_000);
    const bounty = await makeCommunityBounty({
      requesterUserId: requester.id,
      targetItems: 2,
      poolClosedAt: past,
      disputeCycleWindowOpensAt: past,
      sponsorClosedAt: past, // sponsor already asked to close early
    });
    await acceptSubmission(bounty.id, requester.id, "only item");

    const outcome = await settleDueCommunityPools();
    expect(outcome.settled).toBeGreaterThanOrEqual(1);
    expect(outcome.partiallyCompleted).toBeGreaterThanOrEqual(1);

    const settled = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
    expect(settled.status).toBe("partially_completed");
    expect(settled.disputeCycleSettledAt).not.toBeNull();
    expect(settled.publicationStatus).toBe(CommunityPublicationStatus.pending);

    const job = await prisma.jobQueue.findUnique({ where: { idempotencyKey: `community.publish:${bounty.id}` } });
    expect(job).not.toBeNull();
  });
});

describe("POST /v1/bounties/:id/close-pool", () => {
  it("force-closes an in-progress (not-yet-closed) pool for its owning sponsor", async () => {
    const sponsor = await signupUser("close-inprogress");
    const bounty = await makeCommunityBounty({ requesterUserId: sponsor.userId, poolClosedAt: null, disputeCycleWindowOpensAt: null });

    const res = await app.inject({
      method: "POST",
      url: `/v1/bounties/${bounty.id}/close-pool`,
      headers: { cookie: sponsor.cookie, origin: "http://localhost:3010" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { bounty: { id: string }; alreadyClosed: boolean };
    expect(body.alreadyClosed).toBe(false);
    expect(body.bounty.id).toBe(bounty.id);

    const updated = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
    expect(updated.sponsorClosedAt).not.toBeNull();
    expect(updated.poolClosedAt).not.toBeNull();
    expect(updated.disputeCycleWindowOpensAt).not.toBeNull();

    const job = await prisma.jobQueue.findUnique({ where: { idempotencyKey: `pool-sample:${bounty.id}` } });
    expect(job).not.toBeNull();

    const auditRow = await prisma.adminAuditLog.findFirst({ where: { targetId: bounty.id, action: "community_pool.sponsor_closed" } });
    expect(auditRow).not.toBeNull();
  });

  it("only sets sponsorClosedAt (does not re-touch poolClosedAt) for a pool already mid dispute-window", async () => {
    const sponsor = await signupUser("close-midwindow");
    const past = new Date(Date.now() - 30_000);
    const bounty = await makeCommunityBounty({ requesterUserId: sponsor.userId, poolClosedAt: past, disputeCycleWindowOpensAt: past });

    const res = await app.inject({
      method: "POST",
      url: `/v1/bounties/${bounty.id}/close-pool`,
      headers: { cookie: sponsor.cookie, origin: "http://localhost:3010" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { alreadyClosed: boolean }).alreadyClosed).toBe(false);

    const updated = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
    expect(updated.sponsorClosedAt).not.toBeNull();
    // poolClosedAt / disputeCycleWindowOpensAt untouched — still the original timestamps.
    expect(updated.poolClosedAt?.getTime()).toBe(past.getTime());
    expect(updated.disputeCycleWindowOpensAt?.getTime()).toBe(past.getTime());

    // No fresh pool.sampling job — the pool was already closed and sampled
    // through its normal close path, this route must not re-enqueue it.
    const job = await prisma.jobQueue.findUnique({ where: { idempotencyKey: `pool-sample:${bounty.id}` } });
    expect(job).toBeNull();
  });

  it("is idempotent — calling it twice does not error and reports alreadyClosed on the repeat", async () => {
    const sponsor = await signupUser("close-twice");
    const bounty = await makeCommunityBounty({ requesterUserId: sponsor.userId, poolClosedAt: null, disputeCycleWindowOpensAt: null });

    const first = await app.inject({ method: "POST", url: `/v1/bounties/${bounty.id}/close-pool`, headers: { cookie: sponsor.cookie, origin: "http://localhost:3010" } });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { alreadyClosed: boolean }).alreadyClosed).toBe(false);

    const second = await app.inject({ method: "POST", url: `/v1/bounties/${bounty.id}/close-pool`, headers: { cookie: sponsor.cookie, origin: "http://localhost:3010" } });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { alreadyClosed: boolean }).alreadyClosed).toBe(true);

    // Only one audit row and one sampling job — the repeat call is a genuine no-op.
    const auditRows = await prisma.adminAuditLog.count({ where: { targetId: bounty.id, action: "community_pool.sponsor_closed" } });
    expect(auditRows).toBe(1);
    const jobs = await prisma.jobQueue.count({ where: { idempotencyKey: `pool-sample:${bounty.id}` } });
    expect(jobs).toBe(1);
  });

  it("rejects a caller who is not this pool's sponsor", async () => {
    const owner = await makeUser("real-owner");
    const stranger = await signupUser("not-the-owner");
    const bounty = await makeCommunityBounty({ requesterUserId: owner.id, poolClosedAt: null, disputeCycleWindowOpensAt: null });

    const res = await app.inject({
      method: "POST",
      url: `/v1/bounties/${bounty.id}/close-pool`,
      headers: { cookie: stranger.cookie, origin: "http://localhost:3010" },
    });
    expect(res.statusCode).toBe(404);

    const untouched = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
    expect(untouched.sponsorClosedAt).toBeNull();
    expect(untouched.poolClosedAt).toBeNull();
  });
});
