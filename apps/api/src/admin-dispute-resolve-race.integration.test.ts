// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for a TOCTOU race on POST /v1/admin/disputes/:id/resolve
 * (routes/v1/admin.ts).
 *
 * Before the fix: the "still open" precondition was a plain `findUnique`
 * OUTSIDE any transaction, with no row lock taken anywhere. Two concurrent
 * /resolve calls on the SAME dispute (a double-click, a client retry, or two
 * admins racing with different verdicts within the same window) could both
 * observe `status === "open"` before either write landed, and both commit —
 * `Bounty.finalAcceptedItems` could be double-incremented and the
 * submission's terminal status would end up non-deterministic depending on
 * write order.
 *
 * After the fix: the status check and every write share one transaction that
 * takes a `SELECT ... FOR UPDATE` lock on the `disputes` row first — same
 * idiom this file's sibling route (POST /community/requests/:id/implement,
 * see admin-community-implement.integration.test.ts) already uses. The
 * second concurrent call now waits for the first transaction to commit, then
 * re-checks status INSIDE the lock and gets a clean, real
 * "already resolved" rejection instead of double-processing.
 *
 * Same harness/self-guard pattern as the other *.integration.test.ts files in
 * this directory: Fastify inject() against buildApp(), no port bound,
 * refuses to run outside the disposable verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { deleteAuditRowsForBounties } from "./test-support/audit-cleanup.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdBountyIds: string[] = [];
const createdSubmissionIds: string[] = [];
const createdDisputeIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.dispute.deleteMany({ where: { id: { in: createdDisputeIds } } });
  await prisma.flag.deleteMany({ where: { submissionId: { in: createdSubmissionIds } } });
  await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  // The overturn winner deliberately creates a real audit batch/item. The
  // submission relation is RESTRICT (matching v1), so clear those test-owned
  // audit rows before deleting the fixture submissions.
  await deleteAuditRowsForBounties(createdBountyIds);
  await prisma.submission.deleteMany({ where: { id: { in: createdSubmissionIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function signupAdmin(emailPrefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${emailPrefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${emailPrefix}${stamp}`.slice(0, 30), displayName: emailPrefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  await prisma.userRole.create({ data: { userId, role: "admin" } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

async function seedContributor() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await prisma.user.create({
    data: { authMethod: "email", email: `dispute-race-contrib-${stamp}@local.test`, displayName: "Dispute Race Fixture Contributor" },
  });
  createdUserIds.push(user.id);
  return user.id;
}

async function seedBountyWithFlaggedSubmission(params: { contributorUserId: string }) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: params.contributorUserId,
      title: `dispute-resolve-race fixture ${stamp}`,
      description: "fixture pool for the dispute-resolve concurrency race regression",
      datasetCategory: "debugging",
      language: "typescript",
      framework: "none",
      targetItems: 100,
      auditMode: "partial",
      auditCoveragePct: 100,
      holdDays: 0,
      karmaPerAcceptedItem: 25,
      finalAcceptedItems: 0,
    },
  });
  createdBountyIds.push(bounty.id);

  const submission = await prisma.submission.create({
    data: {
      bountyId: bounty.id,
      contributorUserId: params.contributorUserId,
      title: `dispute-race item ${stamp}`,
      payloadJson: { prompt: `dispute-race item ${stamp}` },
      generationMethod: "human",
      status: "rejected",
    },
  });
  createdSubmissionIds.push(submission.id);

  await prisma.flag.create({
    data: {
      submissionId: submission.id,
      reason: "solution_incorrect",
      status: "open",
    },
  });

  const dispute = await prisma.dispute.create({
    data: {
      bountyId: bounty.id,
      submissionId: submission.id,
      raisedByUserId: params.contributorUserId,
      bountyTitle: bounty.title,
      submissionTitle: submission.title,
      flagReason: "solution_incorrect",
      contributorArgument: "My fix is correct, the validator misjudged it.",
      validatorArgument: "The submitted fix does not pass the tests.",
      status: "open",
    },
  });
  createdDisputeIds.push(dispute.id);

  return { bountyId: bounty.id, submissionId: submission.id, disputeId: dispute.id };
}

describe("POST /v1/admin/disputes/:id/resolve", () => {
  it("under two concurrent resolve calls with different verdicts, exactly one wins and finalAcceptedItems increments exactly once (row-lock race fix)", async () => {
    // The whole point of the fix is that the second call now WAITS on the
    // first call's transaction (real Postgres lock contention, not a no-op),
    // so this needs more headroom than vitest's 5s default.
    const { cookie } = await signupAdmin("disputerace");
    const contributorUserId = await seedContributor();
    const { bountyId, submissionId, disputeId } = await seedBountyWithFlaggedSubmission({ contributorUserId });

    const fire = (decision: "uphold_flag" | "overturn_flag") =>
      app.inject({
        method: "POST",
        url: `/v1/admin/disputes/${disputeId}/resolve`,
        headers: { cookie, origin: "http://localhost:3010", "content-type": "application/json" },
        payload: { decision, resolution: `Resolving with ${decision} under concurrency race test.` },
      });

    // One admin clicks "uphold" (validator was right, submission stays
    // rejected), another clicks "overturn" (contributor wins, item goes BACK
    // TO AUDIT) — the exact double-click / two-admin-racing shape of the bug,
    // fired at effectively the same instant.
    const [upheld, overturned] = await Promise.all([fire("uphold_flag"), fire("overturn_flag")]);

    const statusCodes = [upheld.statusCode, overturned.statusCode].sort();
    // Exactly one call succeeds; the loser gets a real, clear rejection —
    // never a silent double-process and never both succeeding.
    expect(statusCodes).toEqual([200, 400]);

    const loser = upheld.statusCode === 400 ? upheld : overturned;
    expect(loser.json().message).toMatch(/already been resolved/i);

    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute.status).toBe("resolved");

    const submission = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    const bounty = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });

    if (upheld.statusCode === 200) {
      // "uphold_flag" won the race: validator confirmed, submission stays
      // rejected, no karma/accepted-item side effects.
      expect(dispute.resolutionDecision).toBe("dismissed");
      expect(submission.status).toBe("rejected");
      expect(Number(bounty.finalAcceptedItems)).toBe(0);
    } else {
      // "overturn_flag" won the race: the contributor wins the DISPUTE, so the
      // item returns to human audit — it is NOT accepted here, and no karma or
      // accepted-item counter moves on an admin's signature.
      //
      // Changed deliberately when the validator flow was aligned with v1: an
      // admin rules on whether the validator's stated REASON holds; a validator
      // rules on whether the ITEM is good. Overturning "too_trivial" does not
      // establish the submission passes. Karma now flows only through
      // submitAuditDecisions when the re-audit accepts, so there is exactly one
      // award site.
      expect(dispute.resolutionDecision).toBe("upheld");
      expect(submission.status).toBe("in_audit");
      expect(submission.acceptedAt).toBeNull();
      expect(Number(bounty.finalAcceptedItems)).toBe(0);

      // It must be genuinely re-reviewable, not stranded in `in_audit` with
      // nothing able to pick it up. The flagged item here predates any audit
      // batch, so the resolver has to mint one.
      const items = await prisma.auditItem.findMany({ where: { submissionId } });
      expect(items).toHaveLength(1);
      expect(items[0]!.verdict).toBeNull();
      const batch = await prisma.auditBatch.findUniqueOrThrow({ where: { id: items[0]!.auditBatchId } });
      expect(batch.status).toBe("available");
      expect(batch.itemCount).toBe(1);

      // A BATCH ALONE IS NOT REACHABLE — this is the assertion that matters.
      // The validator surface (`GET /v1/audits` -> listAvailableAudits) lists
      // HumanAuditWindows, not AuditBatches, so an earlier version of the
      // resolver that minted only a batch left the item in `in_audit`,
      // "audited" on paper, and invisible to every validator. Verified over
      // HTTP at the time: `GET /v1/audits` did not return it. So the window,
      // its link to the batch, and the selected membership are all asserted.
      const window = await prisma.humanAuditWindow.findFirstOrThrow({
        where: { auditBatchId: batch.id },
        include: { memberships: true },
      });
      expect(window.memberships).toHaveLength(1);
      expect(window.memberships[0]!.submissionId).toBe(submissionId);
      expect(window.memberships[0]!.selected).toBe(true);
      // Claimable: unclaimed, unsettled, not superseded.
      expect(window.claimedByUserId).toBeNull();
      expect(window.settledAt).toBeNull();
      expect(window.supersededAt).toBeNull();
      // Honestly labelled — this is a dispute re-review, NOT a sampling draw,
      // so it must not claim the `hmac-sha256-v1` selectionVersion default.
      expect(window.selectionVersion).toBe("dispute-overturn-reaudit");
      expect(window.closureReason).toBe("dispute_overturn_reaudit");

      // The overturned flag is closed out, so the contributor's issueCount
      // badge does not contradict the item's new state.
      const openFlags = await prisma.flag.count({ where: { submissionId, status: "open" } });
      expect(openFlags).toBe(0);
    }

    // The real assertion this test exists for: no double-increment happened
    // regardless of which verdict actually won the race.
    expect(Number(bounty.finalAcceptedItems)).toBeLessThanOrEqual(1);
  }, 45_000);

  it("a resolve call on an already-resolved dispute is rejected with a clear message and makes no further writes", async () => {
    const { cookie } = await signupAdmin("disputeresolved");
    const contributorUserId = await seedContributor();
    const { submissionId, disputeId } = await seedBountyWithFlaggedSubmission({ contributorUserId });

    const first = await app.inject({
      method: "POST",
      url: `/v1/admin/disputes/${disputeId}/resolve`,
      headers: { cookie, origin: "http://localhost:3010", "content-type": "application/json" },
      payload: { decision: "uphold_flag", resolution: "First resolution, validator was right." },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/v1/admin/disputes/${disputeId}/resolve`,
      headers: { cookie, origin: "http://localhost:3010", "content-type": "application/json" },
      payload: { decision: "overturn_flag", resolution: "Second, conflicting resolution attempt." },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().message).toMatch(/already been resolved/i);

    // The second, rejected call must not have flipped the submission back to
    // accepted despite requesting "overturn_flag".
    const submission = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(submission.status).toBe("rejected");

    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute.resolutionDecision).toBe("dismissed");
  });
});
