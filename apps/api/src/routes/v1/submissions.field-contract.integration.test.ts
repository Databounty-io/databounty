// SPDX-License-Identifier: Apache-2.0

/**
 * Intake enforces the pool's field contract on the server
 * (services/item-contract.ts).
 *
 * Before this, only the dashboard's form checked required fields, in the
 * browser. The REST routes and the MCP tools stored whatever JSON object
 * arrived, so an agent could fill a pool with items missing the fields its
 * type requires, and the first thing to notice was a validator. These tests
 * drive every intake path a contributor or agent can reach and pin that a
 * non-conforming item is refused with a structured 400 naming the item and
 * field, and that nothing is written when it is.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { BountyKind, BountyStatus, DatasetTypeStatus, GenerationMethod, Prisma, SubmissionStatus } from "@prisma/client";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { tools } from "../../mcp/tools.js";
import { McpToolError } from "../../mcp/core/errors.js";
import { computeDedupeKey, createPoolSubmission } from "../../services/submissions.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORIGIN = "http://localhost:3010";

let app: FastifyInstance;
let userId = "";
let cookie = "";
let datasetTypeId = "";
let bountyId = "";
const bountyIds: string[] = [];

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no such MCP tool: ${name}`);
  return found;
};

function item(salt: string, overrides: Record<string, unknown> = {}) {
  return { instruction: `Explain step ${salt} ${stamp}`, tags: ["field-contract"], ...overrides };
}

async function createPool(withDatasetType: boolean) {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: userId,
      title: `Field contract pool ${stamp}`,
      description: "Fixture pool for the intake field-contract tests.",
      datasetCategory: "implementation",
      language: "TypeScript",
      framework: "Node.js",
      auditCoveragePct: 10,
      auditMode: "partial",
      holdDays: 0,
      disputeWindowHours: 48,
      communityLicense: "CC-BY-4.0",
      kind: BountyKind.community,
      status: BountyStatus.active,
      targetItems: 1000,
      ...(withDatasetType ? { datasetTypeId } : {}),
    },
  });
  bountyIds.push(bounty.id);
  return bounty.id;
}

/** A submission already sent back for fixing, created directly so that no
 * validation job is queued for it: the suite shares one job queue, and a job
 * run from another test file would move the row out of a revisable status
 * while this file is still asserting on it. */
async function revisable(status: SubmissionStatus, payload: Record<string, unknown>, title: string) {
  const row = await prisma.submission.create({
    data: {
      bountyId,
      contributorUserId: userId,
      title,
      payloadJson: payload as Prisma.InputJsonValue,
      generationMethod: GenerationMethod.human,
      dedupeKey: computeDedupeKey(payload),
      status,
    },
    select: { id: true },
  });
  return row.id;
}

async function submissionCount(pool = bountyId) {
  return prisma.submission.count({ where: { bountyId: pool } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const email = `field-contract-${stamp}@example.com`;
  const signup = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", displayName: "field contract" },
  });
  expect(signup.statusCode).toBe(201);
  userId = signup.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const setCookie = signup.headers["set-cookie"];
  cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;

  const type = await prisma.datasetType.create({
    data: {
      id: `field-contract-${stamp}`,
      name: `Field contract ${stamp}`,
      description: "Fixture dataset type for the intake field-contract tests.",
      domain: "coding",
      status: DatasetTypeStatus.active,
      origin: "platform",
      category: "implementation",
      trustTier: "llm_verified",
      fields: [
        { key: "instruction", label: "Instruction", role: "instruction", required: true },
        { key: "difficulty", label: "Difficulty", role: "enum", options: ["easy", "hard"] },
        { key: "tags", label: "Tags", role: "list", required: true },
      ],
      verification: { pipeline: ["schema", "human_audit"] },
    },
  });
  datasetTypeId = type.id;
  bountyId = await createPool(true);
});

afterAll(async () => {
  await app.close();
  const subs = await prisma.submission.findMany({ where: { bountyId: { in: bountyIds } }, select: { id: true } });
  if (subs.length) {
    await prisma.jobQueue.deleteMany({
      where: { OR: subs.map((s) => ({ idempotencyKey: { startsWith: `val:${s.id}:` } })) },
    });
  }
  await prisma.submission.deleteMany({ where: { bountyId: { in: bountyIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: bountyIds } } });
  await prisma.datasetType.deleteMany({ where: { id: datasetTypeId } });
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("REST intake refuses items that break the pool's field contract", () => {
  it("POST /v1/submissions names the missing field and writes nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/submissions",
      headers: { cookie, origin: ORIGIN },
      payload: { bountyId, title: "Missing its instruction", payloadJson: { tags: ["x"] } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      statusCode: 400,
      error: "Bad Request",
      code: "ITEM_FIELDS_INVALID",
      message: 'This item does not match the pool\'s field contract: "instruction" is required.',
      items: [{ index: 0, problems: [{ field: "instruction", reason: "missing" }] }],
    });
    expect(await submissionCount()).toBe(0);
  });

  it("POST /v1/submissions treats an empty required list as missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/submissions",
      headers: { cookie, origin: ORIGIN },
      payload: { bountyId, title: "Empty tags", payloadJson: item("empty-tags", { tags: [] }) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().items).toEqual([{ index: 0, problems: [{ field: "tags", reason: "missing" }] }]);
  });

  it("POST /v1/submissions still accepts a conforming item, extra keys included", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/submissions",
      headers: { cookie, origin: ORIGIN },
      payload: { bountyId, title: "Conforming item", payloadJson: item("single", { difficulty: "hard", agentRunId: "r-1" }) },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().submission.status).toBe(SubmissionStatus.submitted);
  });

  it("POST /v1/submissions/bulk refuses the whole batch, listing only the failing items", async () => {
    const before = await submissionCount();
    const res = await app.inject({
      method: "POST",
      url: "/v1/submissions/bulk",
      headers: { cookie, origin: ORIGIN },
      payload: {
        bountyId,
        items: [
          { title: "Fine bulk item", payloadJson: item("bulk-1") },
          { title: "Blank instruction", payloadJson: item("bulk-2", { instruction: "  " }) },
          { title: "Unknown difficulty", payloadJson: item("bulk-3", { difficulty: "medium" }) },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("ITEM_FIELDS_INVALID");
    expect(body.message).toMatch(/^2 of 3 items do not match the pool's field contract, so none were submitted\./);
    expect(body.items).toEqual([
      { index: 1, problems: [{ field: "instruction", reason: "missing" }] },
      { index: 2, problems: [{ field: "difficulty", reason: "not_an_option", allowed: ["easy", "hard"] }] },
    ]);
    expect(await submissionCount()).toBe(before);
  });

  it("POST /v1/bounties/:id/items refuses an enum value the type does not allow", async () => {
    const before = await submissionCount();
    const res = await app.inject({
      method: "POST",
      url: `/v1/bounties/${bountyId}/items`,
      headers: { cookie, origin: ORIGIN },
      payload: { items: [item("pool-items", { difficulty: "expert" })], generationMethod: GenerationMethod.human },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "ITEM_FIELDS_INVALID",
      message: 'This item does not match the pool\'s field contract: "difficulty" must be one of "easy", "hard".',
    });
    expect(await submissionCount()).toBe(before);
  });

  it("POST /v1/submissions/:id/revise refuses a non-conforming correction without spending a revision attempt", async () => {
    const submissionId = await revisable(SubmissionStatus.needs_fixes, item("revise"), "Item to revise");

    const refused = await app.inject({
      method: "POST",
      url: `/v1/submissions/${submissionId}/revise`,
      headers: { cookie, origin: ORIGIN },
      payload: { payloadJson: { instruction: "revised, but the tags were dropped" } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().items).toEqual([{ index: 0, problems: [{ field: "tags", reason: "missing" }] }]);

    const untouched = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(untouched.revisionCount).toBe(0);
    expect(untouched.status).toBe(SubmissionStatus.needs_fixes);
    expect((untouched.payloadJson as Record<string, unknown>).tags).toEqual(["field-contract"]);

    const accepted = await app.inject({
      method: "POST",
      url: `/v1/submissions/${submissionId}/revise`,
      headers: { cookie, origin: ORIGIN },
      payload: { payloadJson: item("revise-fixed") },
    });
    expect(accepted.statusCode).toBe(200);
    expect((await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } })).revisionCount).toBe(1);
  });
});

describe("MCP intake refuses items that break the pool's field contract", () => {
  it("submit_pool_items fails with a 400 tool error carrying ITEM_FIELDS_INVALID, and writes nothing", async () => {
    const before = await submissionCount();
    const error = await tool("submit_pool_items")
      .call(
        {
          bountyId,
          items: [
            { title: "Agent item one", payloadJson: item("mcp-1") },
            { title: "Agent item two", payloadJson: { instruction: "no tags at all" } },
          ],
        },
        { userId },
      )
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(McpToolError);
    expect(error).toMatchObject({ status: 400, code: "ITEM_FIELDS_INVALID" });
    expect((error as McpToolError).message).toContain('item 2: "tags" is required');
    expect(await submissionCount()).toBe(before);
  });

  it("revise_submission fails the same way, before an attempt is reserved", async () => {
    const submission = { id: await revisable(SubmissionStatus.flagged, item("mcp-revise"), "Agent item to revise") };

    await expect(
      tool("revise_submission").call(
        { submissionId: submission.id, payloadJson: item("mcp-revise-2", { difficulty: "impossible" }) },
        { userId },
      ),
    ).rejects.toMatchObject({ status: 400, code: "ITEM_FIELDS_INVALID" });
    expect((await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } })).revisionCount).toBe(0);
  });
});

describe("a pool with no dataset type", () => {
  it("has no contract to enforce, so any object is taken as before", async () => {
    const untyped = await createPool(false);
    const submission = await createPoolSubmission({
      bountyId: untyped,
      contributorUserId: userId,
      title: "Free-form item",
      payloadJson: { anything: "goes" },
      generationMethod: GenerationMethod.human,
    });
    expect(submission.status).toBe(SubmissionStatus.submitted);
  });
});
