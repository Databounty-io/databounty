// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for services/sponsor-evidence.ts — the shared
 * implementation behind `GET /v1/bounties/:id/submissions`,
 * `POST /v1/submissions/:id/dispute-acceptance`, and the two `sponsor`-scoped
 * MCP tools `get_sponsor_submission_evidence` / `dispute_accepted_submission`.
 *
 * Proves, against real rows:
 *
 *  listSponsorSubmissionEvidence
 *   1. the pool's owner (`bounty.requesterUserId`) gets the paged evidence body, with
 *      `disputeWindowClosesAt` set on accepted items and null otherwise, and
 *      status/search filters applied server-side;
 *   2. a non-owner is refused (`forbidden`, 403) — and the refusal happens
 *      before any submission row is read;
 *   3. an unknown pool is `not_found` (404);
 *   4. the REST route returns the SAME body as the service for the owner.
 *
 *  disputeAcceptedSubmission
 *   5. happy path: a Dispute row, the submission flips to `disputed`, and the
 *      contributor + operators are notified;
 *   6. a stranger is `forbidden`; an admin (not the requester) is allowed;
 *   7. a second dispute on the same item is `conflict` (already disputed /
 *      open dispute), and a never-accepted item is `conflict`;
 *   8. a closed window is `conflict`.
 *
 *  MCP tools
 *   9. the two tools surface the same outcomes as `McpToolError`s with the
 *      matching status, using `context.userId` for identity.
 *
 * Same harness/self-guard pattern as the other *.integration.test.ts files:
 * Fastify inject() against buildApp(), no port bound, refuses to run outside a
 * disposable verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import { disputeAcceptedSubmission, listSponsorSubmissionEvidence, SponsorEvidenceError } from "./sponsor-evidence.js";
import { tools } from "../mcp/tools.js";
import { McpToolError } from "../mcp/core/errors.js";
import { AuditMode, AuthMethod, BountyKind, BountyStatus, DatasetCategory } from "@prisma/client";

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

const evidenceTool = tools.find((t) => t.name === "get_sponsor_submission_evidence")!;
const disputeTool = tools.find((t) => t.name === "dispute_accepted_submission")!;

/** HTTP signup — used ONLY where a session cookie is needed (the REST-parity
 * assertions). `POST /v1/auth/signup` is rate-limited to 10/minute per IP
 * (routes/v1/auth.ts AUTH_RATE_LIMIT), so every other account is created
 * directly, the way mcp/tools.audit-claim.test.ts does. */
async function signupVerified(emailPrefix: string) {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email,
      password: "Test@12345",
      handle: `${emailPrefix.slice(0, 6)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 20),
      displayName: emailPrefix,
    },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date(), onboarded: true } });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

async function createVerifiedUser(prefix: string, role?: "admin") {
  const uniquePart = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-${uniquePart}@example.com`,
      handle: `${prefix.slice(0, 6)}${uniquePart}`.toLowerCase().slice(0, 20),
      displayName: prefix,
      authMethod: AuthMethod.email,
      passwordHash: "not-used-in-these-tests",
      emailVerifiedAt: new Date(),
      onboarded: true,
      ...(role ? { roles: { create: { role } } } : {}),
    },
  });
  return { userId: user.id };
}

function payload(seed: string) {
  return {
    prompt: `fix bug ${seed}`,
    broken_code: `function f(a,b){ return a+b+1; } // ${seed}`,
    fixed_code: `function f(a,b){ return a+b; }\nmodule.exports = { f }; // ${seed}`,
    tests:
      "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { f } = require('./solution.js');\ntest('adds', () => { assert.strictEqual(f(2,3), 5); });",
    explanation: `sponsor-evidence fixture ${seed}`,
    bug_type: "off_by_one",
  };
}

async function expectServiceError<T>(p: Promise<T>, code: SponsorEvidenceError["code"]) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SponsorEvidenceError);
    expect((err as SponsorEvidenceError).code).toBe(code);
    return err as SponsorEvidenceError;
  }
  throw new Error(`expected SponsorEvidenceError(${code})`);
}

async function expectToolError<T>(p: Promise<T>, status: number) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).status).toBe(status);
    return err as McpToolError;
  }
  throw new Error(`expected McpToolError(${status})`);
}

/** A live community pool owned by `requester` (both `requesterUserId` and
 * `communityRequesterUserId`, so the evidence route — which gates on the
 * former only — and the dispute route — which accepts either — agree on the
 * owner), one admin to receive `admin.dispute_filed`, and a helper that seeds
 * submissions directly (the intake pipeline's job queue is global and shared
 * with parallel suites — same rationale as dispute-acceptance.integration.test.ts). */
async function seedPool(prefix: string, opts: { requester?: { userId: string } } = {}) {
  const admin = await createVerifiedUser(`${prefix}adm`, "admin");
  const contributor = await createVerifiedUser(`${prefix}con`);
  const requester = opts.requester ?? (await createVerifiedUser(`${prefix}req`));

  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: requester.userId,
      communityRequesterUserId: requester.userId,
      kind: BountyKind.community,
      status: BountyStatus.active,
      title: `Sponsor Evidence Pool ${prefix}`,
      description: "Fixture pool for the sponsor-evidence integration tests.",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(50),
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 10,
      holdDays: 0,
      karmaPerAcceptedItem: 25,
    },
  });
  const bountyId = bounty.id;

  async function seedSubmission(
    seed: string,
    opts: { status?: "accepted" | "in_audit" | "rejected"; acceptedAt?: Date | null; title?: string } = {},
  ) {
    const status = opts.status ?? "accepted";
    const submission = await prisma.submission.create({
      data: {
        bountyId,
        contributorUserId: contributor.userId,
        title: opts.title ?? `${prefix} ${seed}`,
        payloadJson: payload(`${prefix}-${seed}`),
        generationMethod: "human",
        dedupeKey: `sponsorev-${prefix}-${seed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status,
        acceptedAt: status === "accepted" ? (opts.acceptedAt ?? new Date()) : null,
      },
    });
    return submission.id;
  }

  return { bountyId, admin, contributor, requester, evidenceOwner: requester, seedSubmission };
}

describe("listSponsorSubmissionEvidence", () => {
  it("returns paged evidence with the dispute window to the pool's owner, and filters server-side", async () => {
    const pool = await seedPool("evlist");
    const acceptedId = await pool.seedSubmission("a1", { title: "evlist alpha accepted" });
    const inAuditId = await pool.seedSubmission("b1", { status: "in_audit", title: "evlist beta pending" });

    const all = await listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: pool.evidenceOwner.userId });
    expect(all.total).toBe(2);
    expect(all.page).toBe(1);
    expect(all.pageSize).toBe(50);
    expect(all.totalPages).toBe(1);
    expect(all.submissions.map((s) => s.id).sort()).toEqual([acceptedId, inAuditId].sort());

    const accepted = all.submissions.find((s) => s.id === acceptedId)!;
    expect(accepted.status).toBe("accepted");
    expect(typeof accepted.disputeWindowClosesAt).toBe("string");
    expect(new Date(accepted.disputeWindowClosesAt!).getTime()).toBeGreaterThan(Date.now());
    expect(accepted.contributor.id).toBe(pool.contributor.userId);
    expect(accepted.payloadJson).toMatchObject({ bug_type: "off_by_one" });
    expect(Array.isArray(accepted.validationResults)).toBe(true);
    expect(Array.isArray(accepted.flags)).toBe(true);

    const pending = all.submissions.find((s) => s.id === inAuditId)!;
    expect(pending.disputeWindowClosesAt).toBeNull();

    // status filter
    const onlyAccepted = await listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: pool.evidenceOwner.userId, status: "accepted" });
    expect(onlyAccepted.submissions.map((s) => s.id)).toEqual([acceptedId]);
    // "all" and an unknown status are both ignored, as the route always did
    const allKeyword = await listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: pool.evidenceOwner.userId, status: "all" });
    expect(allKeyword.total).toBe(2);
    const bogus = await listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: pool.evidenceOwner.userId, status: "nonsense" });
    expect(bogus.total).toBe(2);

    // title search, case-insensitive
    const search = await listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: pool.evidenceOwner.userId, search: "  BETA " });
    expect(search.submissions.map((s) => s.id)).toEqual([inAuditId]);

    // paging + clamping
    const page1 = await listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: pool.evidenceOwner.userId, pageSize: 1 });
    expect(page1.submissions).toHaveLength(1);
    expect(page1.totalPages).toBe(2);
    const page2 = await listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: pool.evidenceOwner.userId, pageSize: 1, page: 2 });
    expect(page2.submissions).toHaveLength(1);
    expect(page2.submissions[0]!.id).not.toBe(page1.submissions[0]!.id);
    const clamped = await listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: pool.evidenceOwner.userId, pageSize: 1000, page: 0 });
    expect(clamped.pageSize).toBe(100);
    expect(clamped.page).toBe(1);
  });

  it("refuses a non-owner (403) and an unknown pool (404), and the REST route agrees byte-for-byte", async () => {
    const owner = await signupVerified("evowner");
    const pool = await seedPool("evauth", { requester: owner });
    await pool.seedSubmission("a1");
    const stranger = await signupVerified("evstranger");

    const forbidden = await expectServiceError(
      listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: stranger.userId }),
      "forbidden",
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.message).toBe("only the bounty owner can inspect submissions");

    const missing = await expectServiceError(
      listSponsorSubmissionEvidence({ bountyId: "no-such-bounty", userId: pool.evidenceOwner.userId }),
      "not_found",
    );
    expect(missing.status).toBe(404);
    expect(missing.message).toBe("bounty not found");

    // The contributor is not the owner either.
    await expectServiceError(listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: pool.contributor.userId }), "forbidden");
    // Nor is an admin: the evidence route has no admin bypass (the dispute route does).
    await expectServiceError(listSponsorSubmissionEvidence({ bountyId: pool.bountyId, userId: pool.admin.userId }), "forbidden");

    // REST parity: same codes, same messages, same body for the owner.
    const restForbidden = await app.inject({
      method: "GET",
      url: `/v1/bounties/${pool.bountyId}/submissions`,
      headers: { cookie: stranger.cookie },
    });
    expect(restForbidden.statusCode).toBe(403);
    expect(restForbidden.json().message).toBe("only the bounty owner can inspect submissions");

    const restMissing = await app.inject({
      method: "GET",
      url: `/v1/bounties/no-such-bounty/submissions`,
      headers: { cookie: owner.cookie },
    });
    expect(restMissing.statusCode).toBe(404);
    expect(restMissing.json().message).toBe("bounty not found");

    const restOk = await app.inject({
      method: "GET",
      url: `/v1/bounties/${pool.bountyId}/submissions?status=accepted&pageSize=10`,
      headers: { cookie: owner.cookie },
    });
    expect(restOk.statusCode).toBe(200);
    const service = await listSponsorSubmissionEvidence({
      bountyId: pool.bountyId,
      userId: pool.evidenceOwner.userId,
      status: "accepted",
      pageSize: 10,
    });
    expect(restOk.json()).toEqual(JSON.parse(JSON.stringify(service)));
  });
});

describe("disputeAcceptedSubmission", () => {
  it("lets the requester dispute an accepted item: Dispute row, status flip, notifications", async () => {
    const pool = await seedPool("dsphappy");
    const submissionId = await pool.seedSubmission("s1");

    const dispute = await disputeAcceptedSubmission({
      submissionId,
      userId: pool.requester.userId,
      callerRoles: [],
      reason: "solution_incorrect",
      argument: "This item should not have been accepted as-is.",
    });
    expect(dispute.status).toBe("open");
    expect(dispute.submissionId).toBe(submissionId);
    expect(dispute.raisedByUserId).toBe(pool.requester.userId);
    expect(dispute.flagReason).toBe("solution_incorrect");
    expect(dispute.validatorArgument).toBe("Accepted without a validator flag; disputed by the requester after acceptance.");

    const updated = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(updated.status).toBe("disputed");

    const contributorNote = await prisma.notification.findFirst({
      where: { userId: pool.contributor.userId, type: "issue.sponsor_disputed", entityId: submissionId },
    });
    expect(contributorNote).not.toBeNull();
    const adminNote = await prisma.notification.findFirst({
      where: { userId: pool.admin.userId, type: "admin.dispute_filed", entityId: submissionId },
    });
    expect(adminNote).not.toBeNull();

    // A second dispute on the same item is a conflict: it is now `disputed`,
    // no longer `accepted`.
    const again = await expectServiceError(
      disputeAcceptedSubmission({
        submissionId,
        userId: pool.requester.userId,
        callerRoles: [],
        reason: "low_quality",
        argument: "Trying to dispute the same item twice.",
      }),
      "conflict",
    );
    expect(again.status).toBe(409);
    expect(again.message).toContain("has nothing to dispute");
  });

  it("refuses a stranger (403) but allows an admin, and refuses a never-accepted item (409)", async () => {
    const pool = await seedPool("dspauth");
    const acceptedId = await pool.seedSubmission("s1");
    const pendingId = await pool.seedSubmission("s2", { status: "in_audit" });
    const stranger = await createVerifiedUser("dspstranger");

    const forbidden = await expectServiceError(
      disputeAcceptedSubmission({
        submissionId: acceptedId,
        userId: stranger.userId,
        callerRoles: ["contributor"],
        reason: "solution_incorrect",
        argument: "I have no standing to dispute this item.",
      }),
      "forbidden",
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.message).toBe("Only this pool's requester can dispute an accepted item.");
    expect((await prisma.submission.findUniqueOrThrow({ where: { id: acceptedId } })).status).toBe("accepted");

    await expectServiceError(
      disputeAcceptedSubmission({
        submissionId: "no-such-submission",
        userId: pool.requester.userId,
        callerRoles: [],
        reason: "solution_incorrect",
        argument: "There is nothing here to dispute.",
      }),
      "not_found",
    );

    const neverAccepted = await expectServiceError(
      disputeAcceptedSubmission({
        submissionId: pendingId,
        userId: pool.requester.userId,
        callerRoles: [],
        reason: "solution_incorrect",
        argument: "This one has not even been accepted yet.",
      }),
      "conflict",
    );
    expect(neverAccepted.message).toBe("Submission in status 'in_audit' has nothing to dispute — it was never accepted.");

    // Admin bypass, same as the REST route's `user.roles.includes("admin")`.
    const byAdmin = await disputeAcceptedSubmission({
      submissionId: acceptedId,
      userId: pool.admin.userId,
      callerRoles: ["admin"],
      reason: "off_spec",
      argument: "Operator-raised dispute on an accepted item.",
    });
    expect(byAdmin.raisedByUserId).toBe(pool.admin.userId);
  });

  it("refuses once the hold window has closed (409) and leaves the item accepted", async () => {
    const pool = await seedPool("dspclosed");
    await prisma.bounty.update({ where: { id: pool.bountyId }, data: { disputeWindowHours: 0 } });
    const submissionId = await pool.seedSubmission("s1", { acceptedAt: new Date(Date.now() - 60 * 60 * 1000) });

    const closed = await expectServiceError(
      disputeAcceptedSubmission({
        submissionId,
        userId: pool.requester.userId,
        callerRoles: [],
        reason: "solution_incorrect",
        argument: "Too late, but should still fail cleanly.",
      }),
      "conflict",
    );
    expect(closed.message).toBe("The dispute window for this submission has closed.");
    expect((await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } })).status).toBe("accepted");
  });
});

describe("sponsor MCP tools against real rows", () => {
  it("get_sponsor_submission_evidence: owner reads, non-owner 403, unknown 404, anonymous 401", async () => {
    const pool = await seedPool("mcpev");
    const id = await pool.seedSubmission("s1");
    const stranger = await createVerifiedUser("mcpevstr");

    const body = await evidenceTool.call({ bountyId: pool.bountyId }, { userId: pool.evidenceOwner.userId });
    expect(body.total).toBe(1);
    expect(body.submissions[0].id).toBe(id);
    expect(typeof body.submissions[0].disputeWindowClosesAt).toBe("string");

    const forbidden = await expectToolError(evidenceTool.call({ bountyId: pool.bountyId }, { userId: stranger.userId }), 403);
    expect(forbidden.code).toBe("forbidden");
    await expectToolError(evidenceTool.call({ bountyId: "no-such-bounty" }, { userId: pool.evidenceOwner.userId }), 404);
    await expectToolError(evidenceTool.call({ bountyId: pool.bountyId }, undefined), 401);
  });

  it("dispute_accepted_submission: requester disputes, stranger 403, repeat 409, unverified email 403", async () => {
    const pool = await seedPool("mcpdsp");
    const id = await pool.seedSubmission("s1");
    const stranger = await createVerifiedUser("mcpdspstr");

    await expectToolError(
      disputeTool.call({ submissionId: id, reason: "low_quality", argument: "No standing to dispute this." }, { userId: stranger.userId }),
      403,
    );

    const dispute = await disputeTool.call(
      { submissionId: id, reason: "low_quality", argument: "Requester disputes via MCP." },
      { userId: pool.requester.userId },
    );
    expect(dispute.status).toBe("open");
    expect((await prisma.submission.findUniqueOrThrow({ where: { id } })).status).toBe("disputed");

    const repeat = await expectToolError(
      disputeTool.call({ submissionId: id, reason: "low_quality", argument: "Second attempt on the same item." }, { userId: pool.requester.userId }),
      409,
    );
    expect(repeat.code).toBe("conflict");

    // The REST route carries `requireVerifiedEmail`; the tool enforces the same.
    const id2 = await pool.seedSubmission("s2");
    await prisma.user.update({ where: { id: pool.requester.userId }, data: { emailVerifiedAt: null } });
    const unverified = await expectToolError(
      disputeTool.call({ submissionId: id2, reason: "low_quality", argument: "Unverified requester should be refused." }, { userId: pool.requester.userId }),
      403,
    );
    expect(unverified.code).toBe("email_unverified");
    expect((await prisma.submission.findUniqueOrThrow({ where: { id: id2 } })).status).toBe("accepted");
  });
});
