// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for the near-dup-of-own-work validator conflict —
 * ported from v1's `auditDuplicateOfValidatorConflict`, which had NO
 * equivalent in this rebuild's `services/audits.ts` until this fix.
 *
 * The pre-existing self-audit guard (`auditConflictReasonFor`) only catches a
 * submission literally attributed to the validator's own account. It misses
 * the case where a DIFFERENT contributor's submission is a documented
 * near/exact duplicate of content the validator themselves authored: the
 * dedupe engine's review-required band does not reject such a submission, it
 * forces it into human audit while still recording `duplicateOfSubmissionId`
 * — so a near-copy of a validator's own prior work could reach their OWN
 * audit queue with zero conflict signal. `hasDuplicateOfOwnWorkConflict`
 * (services/audits.ts) closes that gap, checked in both directions, wired
 * into the same two call sites as the pre-existing guard: `listAvailableAudits`
 * and `claimAuditWindow`.
 *
 * Same harness/self-guard as audit-claim.integration.test.ts: Fastify
 * inject() against buildApp(), no port bound, refuses to run outside the
 * disposable verification database.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuditMode, DatasetCategory, GenerationMethod, SubmissionStatus } from "@prisma/client";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { deleteAuditRowsForBounties } from "./test-support/audit-cleanup.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdBountyIds: string[] = [];
const createdUserIds: string[] = [];

// A fresh app per test isolates each test's signup calls from the shared
// AUTH_RATE_LIMIT bucket — same rationale as audit-claim.integration.test.ts.
beforeEach(async () => {
  app = await buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
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
    payload: {
      email,
      password: "Test@12345",
      handle: `${emailPrefix}${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
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

/** A community bounty with one `in_audit` submission (by `contributorUserId`)
 * and one open HumanAuditWindow selecting it — the minimum shape both
 * listAvailableAudits and claimAuditWindow need. No AuditBatch: neither
 * function under test reads one. */
async function seedWindowWithOneItem(params: { contributorUserId: string; requesterUserId: string }) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: params.requesterUserId,
      title: `dup-conflict fixture ${suffix}`,
      description: "fixture bounty for the near-dup-of-own-work validator conflict",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(1),
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 100,
      holdDays: 0,
      karmaPerAcceptedItem: 25,
    },
  });
  createdBountyIds.push(bounty.id);

  const submission = await prisma.submission.create({
    data: {
      bountyId: bounty.id,
      contributorUserId: params.contributorUserId,
      title: `dup-conflict fixture item ${suffix}`,
      payloadJson: { suffix },
      generationMethod: GenerationMethod.human,
      status: SubmissionStatus.in_audit,
    },
  });

  const window = await prisma.humanAuditWindow.create({
    data: {
      bountyId: bounty.id,
      windowIndex: 1,
      eligibleCount: 1,
      quota: 1,
      closureReason: "test_fixture",
    },
  });
  await prisma.humanAuditWindowMembership.create({
    data: { windowId: window.id, submissionId: submission.id, rank: `rank-${suffix}`, selected: true },
  });

  return { bountyId: bounty.id, windowId: window.id, submissionId: submission.id };
}

/** A standalone Submission row (not a window member) — used to give the
 * validator "own work" for the dedupe engine to have matched against. */
async function createOwnedSubmission(params: {
  contributorUserId: string;
  bountyId: string;
  duplicateOfSubmissionId?: string | null;
}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.submission.create({
    data: {
      bountyId: params.bountyId,
      contributorUserId: params.contributorUserId,
      title: `validator's own submission ${suffix}`,
      payloadJson: { suffix },
      generationMethod: GenerationMethod.human,
      status: SubmissionStatus.accepted,
      duplicateOfSubmissionId: params.duplicateOfSubmissionId ?? null,
    },
  });
}

describe("near-dup-of-own-work validator conflict (C13)", () => {
  it("direction (a): blocks a validator whose OWN submission is what the item under audit duplicates", async () => {
    const owner = await signupVerified("dupaowner");
    const stranger = await signupVerified("dupastranger");
    const validator = await signupVerified("dupavalidator");
    const { windowId, submissionId } = await seedWindowWithOneItem({
      contributorUserId: stranger.userId,
      requesterUserId: owner.userId,
    });

    // The dedupe engine matched the stranger's (window) submission to
    // something the validator themselves authored earlier.
    const ownedByValidator = await createOwnedSubmission({ contributorUserId: validator.userId, bountyId: (await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } })).bountyId });
    await prisma.submission.update({ where: { id: submissionId }, data: { duplicateOfSubmissionId: ownedByValidator.id } });

    const list = await app.inject({ method: "GET", url: "/v1/audits", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(list.statusCode).toBe(200);
    const listed = list.json().audits.find((a: { id: string }) => a.id === windowId);
    expect(listed).toBeUndefined(); // never offered

    const claim = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(claim.statusCode).toBe(403); // and refused if attempted anyway
    expect(claim.json().message).toContain("conflicts with your own submissions");

    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } });
    expect(stored.claimedByUserId).toBeNull(); // refused claim never writes
  });

  it("direction (b): blocks a validator who LATER submitted a near-dup of the item under audit", async () => {
    const owner = await signupVerified("dupbowner");
    const stranger = await signupVerified("dupbstranger");
    const validator = await signupVerified("dupbvalidator");
    const { windowId, submissionId, bountyId } = await seedWindowWithOneItem({
      contributorUserId: stranger.userId,
      requesterUserId: owner.userId,
    });

    // The validator's own (later) submission was itself flagged by the
    // dedupe engine as a near/exact duplicate of the item now under audit.
    await createOwnedSubmission({
      contributorUserId: validator.userId,
      bountyId,
      duplicateOfSubmissionId: submissionId,
    });

    const list = await app.inject({ method: "GET", url: "/v1/audits", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(list.statusCode).toBe(200);
    expect(list.json().audits.find((a: { id: string }) => a.id === windowId)).toBeUndefined();

    const claim = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(claim.statusCode).toBe(403);

    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } });
    expect(stored.claimedByUserId).toBeNull();
  });

  it("an unrelated validator with no duplicate link at all is listed AND can claim", async () => {
    const owner = await signupVerified("dupcowner");
    const stranger = await signupVerified("dupcstranger");
    const validator = await signupVerified("dupcvalidator");
    const { windowId } = await seedWindowWithOneItem({
      contributorUserId: stranger.userId,
      requesterUserId: owner.userId,
    });

    const list = await app.inject({ method: "GET", url: "/v1/audits", headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(list.statusCode).toBe(200);
    expect(list.json().audits.find((a: { id: string }) => a.id === windowId)).toBeDefined();

    const claim = await app.inject({ method: "POST", url: `/v1/audits/${windowId}/claim`, headers: { cookie: validator.cookie, origin: "http://localhost:3010" } });
    expect(claim.statusCode).toBe(200);

    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } });
    expect(stored.claimedByUserId).toBe(validator.userId);
  });
});
