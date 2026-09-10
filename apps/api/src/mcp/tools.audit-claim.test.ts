// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the MCP claim_audit / submit_decisions fix.
 *
 * Earlier this session a real per-validator claim landed on HumanAuditWindow
 * (services/audits.ts claimAuditWindow, submitAuditDecisions now requires the
 * caller to be the window's claimant). The MCP `claim_audit` tool predated
 * that and never actually claimed anything, so `submit_decisions` started
 * throwing AuditWindowNotClaimedError for every MCP validator. These tests
 * exercise the tool functions directly (bypassing the OAuth/transport layer,
 * which is owned elsewhere and already covered by
 * mcp/transport.integration.test.ts) to prove:
 *
 *  1. MCP claim_audit performs a real, exclusive claim (verified via a
 *     direct DB read and via get_audit's claim-state fields).
 *  2. A second MCP claim_audit on the same window is rejected (409-style
 *     McpToolError), and does not disturb the first claimant's hold.
 *  3. MCP submit_decisions now succeeds end to end after a real MCP claim —
 *     the path that was broken.
 *  4. MCP submit_decisions without a prior claim surfaces a clear,
 *     actionable McpToolError instead of an unhandled/generic exception.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuditMode, AuthMethod, DatasetCategory, GenerationMethod, SubmissionStatus } from "@prisma/client";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { tools } from "./tools.js";
import { McpToolError } from "./core/errors.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdBountyIds: string[] = [];
const createdUserIds: string[] = [];

const claimAuditTool = tools.find((t) => t.name === "claim_audit")!;
const submitDecisionsTool = tools.find((t) => t.name === "submit_decisions")!;
const getAuditTool = tools.find((t) => t.name === "get_audit")!;

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

async function createVerifiedUser(prefix: string) {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  // Handle is capped at 20 chars app-side. Slicing the concatenated string
  // truncated off the trailing random suffix that made it unique, so two
  // calls with the same prefix inside the same millisecond-decade collided
  // on `users_handle_key`. Base36-encode the timestamp (short) and keep the
  // full random suffix instead of truncating it away.
  const uniquePart = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-${stamp}@example.com`,
      handle: `${prefix.slice(0, 6)}${uniquePart}`.toLowerCase().slice(0, 20),
      displayName: prefix,
      authMethod: AuthMethod.email,
      passwordHash: "not-used-in-these-tests",
      emailVerifiedAt: new Date(),
      onboarded: true,
    },
  });
  createdUserIds.push(user.id);
  return user.id;
}

/** A community bounty with `itemCount` submissions already `in_audit`, and
 * one open HumanAuditWindow selecting all of them — same fixture shape as
 * audit-claim.integration.test.ts. */
async function seedClaimableWindow(params: { itemCount: number; contributorUserId: string; requesterUserId: string }) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: params.requesterUserId,
      title: `mcp claim fixture ${suffix}`,
      description: "fixture bounty for MCP audit-claim tool tests",
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
          title: `mcp claim fixture item ${i}`,
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
      rank: `mcp-rank-${suffix}-${i}`,
      selected: true,
    })),
  });

  return { bountyId: bounty.id, windowId: window.id, submissionIds: submissions.map((s) => s.id) };
}

describe("MCP claim_audit — real exclusive claim", () => {
  it("actually claims the window: DB row and get_audit both reflect the claim", async () => {
    const owner = await createVerifiedUser("mcpclaimowner");
    const contributor = await createVerifiedUser("mcpclaimcontrib");
    const validator = await createVerifiedUser("mcpclaimvalidator");
    const { windowId } = await seedClaimableWindow({ itemCount: 2, contributorUserId: contributor, requesterUserId: owner });

    // Before claiming, get_audit is REFUSED — evidence is claim-gated, as it
    // is on GET /v1/audits/:id. It previously returned the full bundle (raw
    // item payloads, contributor identities, dedupe/LLM scores) for any
    // unclaimed window, so any `validate`-scoped credential could enumerate
    // windows and read other contributors' work it was never assigned.
    await expect(getAuditTool.call({ windowId }, { userId: validator })).rejects.toThrow(/Claim this audit/);

    const result = await claimAuditTool.call({ windowId }, { userId: validator });
    expect(result.ok).toBe(true);
    expect(result.window.id).toBe(windowId);
    expect(result.window.claimedByUserId).toBe(validator);
    expect(result.window.itemCount).toBe(2);
    expect(new Date(result.window.claimExpiresAt).getTime()).toBeGreaterThan(new Date(result.window.claimedAt).getTime());

    // Direct DB read — not just trusting the tool's own response.
    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } });
    expect(stored.claimedByUserId).toBe(validator);
    expect(stored.claimedAt).not.toBeNull();
    expect(stored.claimExpiresAt).not.toBeNull();

    // get_audit now reflects the real claim state too.
    const after = await getAuditTool.call({ windowId }, { userId: validator });
    expect(after.claimedByUserId).toBe(validator);
    expect(after.status).toBe("claimed");
  });

  it("rejects a second claim from another validator on an already-claimed window (409-style McpToolError)", async () => {
    const owner = await createVerifiedUser("mcpclaimowner2");
    const contributor = await createVerifiedUser("mcpclaimcontrib2");
    const validatorA = await createVerifiedUser("mcpclaimvalidatora");
    const validatorB = await createVerifiedUser("mcpclaimvalidatorb");
    const { windowId } = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributor, requesterUserId: owner });

    const first = await claimAuditTool.call({ windowId }, { userId: validatorA });
    expect(first.ok).toBe(true);

    await expect(claimAuditTool.call({ windowId }, { userId: validatorB })).rejects.toMatchObject({
      status: 409,
    });
    await expect(claimAuditTool.call({ windowId }, { userId: validatorB })).rejects.toBeInstanceOf(McpToolError);

    // The first claimant's hold is untouched by the rejected second attempt.
    const stored = await prisma.humanAuditWindow.findUniqueOrThrow({ where: { id: windowId } });
    expect(stored.claimedByUserId).toBe(validatorA);
  });

  it("rejects a conflict-of-interest claim with a 403-style McpToolError, and a missing window with 404", async () => {
    const owner = await createVerifiedUser("mcpclaimowner3");
    const validator = await createVerifiedUser("mcpclaimvalidatorc");
    // The validator IS the contributor — self-conflict.
    const { windowId } = await seedClaimableWindow({ itemCount: 1, contributorUserId: validator, requesterUserId: owner });

    await expect(claimAuditTool.call({ windowId }, { userId: validator })).rejects.toMatchObject({ status: 403 });

    await expect(claimAuditTool.call({ windowId: "does-not-exist" }, { userId: validator })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("MCP submit_decisions — now gated on a real MCP claim", () => {
  it("succeeds end to end after a real MCP claim_audit (the previously-broken path)", async () => {
    const owner = await createVerifiedUser("mcpdecowner");
    const contributor = await createVerifiedUser("mcpdeccontrib");
    const validator = await createVerifiedUser("mcpdecvalidator");
    const { windowId, submissionIds } = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributor, requesterUserId: owner });
    const membership = await prisma.humanAuditWindowMembership.findFirstOrThrow({
      where: { windowId, submissionId: submissionIds[0] },
    });

    const claimed = await claimAuditTool.call({ windowId }, { userId: validator });
    expect(claimed.ok).toBe(true);

    const decided = await submitDecisionsTool.call(
      { windowId, decisions: [{ auditItemId: membership.id, verdict: "ok" as const }] },
      { userId: validator }
    );
    expect(decided.ok).toBe(true);
    expect(decided.decisionsCount).toBe(1);

    const submission = await prisma.submission.findUniqueOrThrow({ where: { id: submissionIds[0] } });
    expect(submission.status).toBe(SubmissionStatus.accepted);
  });

  it("without any prior claim, surfaces a clear 409 McpToolError rather than an unhandled exception", async () => {
    const owner = await createVerifiedUser("mcpdecowner2");
    const contributor = await createVerifiedUser("mcpdeccontrib2");
    const validator = await createVerifiedUser("mcpdecvalidator2");
    const { windowId, submissionIds } = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributor, requesterUserId: owner });
    const membership = await prisma.humanAuditWindowMembership.findFirstOrThrow({
      where: { windowId, submissionId: submissionIds[0] },
    });

    const attempt = submitDecisionsTool.call(
      { windowId, decisions: [{ auditItemId: membership.id, verdict: "ok" as const }] },
      { userId: validator }
    );
    await expect(attempt).rejects.toBeInstanceOf(McpToolError);
    await expect(attempt).rejects.toMatchObject({ status: 409 });

    // Nothing was decided — the submission is still awaiting audit.
    const submission = await prisma.submission.findUniqueOrThrow({ where: { id: submissionIds[0] } });
    expect(submission.status).toBe(SubmissionStatus.in_audit);
  });

  it("when claimed by a different validator, surfaces a clear 403 McpToolError", async () => {
    const owner = await createVerifiedUser("mcpdecowner3");
    const contributor = await createVerifiedUser("mcpdeccontrib3");
    const validatorA = await createVerifiedUser("mcpdecvalidatora3");
    const validatorB = await createVerifiedUser("mcpdecvalidatorb3");
    const { windowId, submissionIds } = await seedClaimableWindow({ itemCount: 1, contributorUserId: contributor, requesterUserId: owner });
    const membership = await prisma.humanAuditWindowMembership.findFirstOrThrow({
      where: { windowId, submissionId: submissionIds[0] },
    });

    await claimAuditTool.call({ windowId }, { userId: validatorA });

    const attempt = submitDecisionsTool.call(
      { windowId, decisions: [{ auditItemId: membership.id, verdict: "ok" as const }] },
      { userId: validatorB }
    );
    await expect(attempt).rejects.toBeInstanceOf(McpToolError);
    await expect(attempt).rejects.toMatchObject({ status: 403 });
  });
});
