// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the pool-capacity gate on `submitPoolBatchItems`
 * (services/submissions.ts).
 *
 * WHAT WAS MISSING BEFORE THIS EXISTED: `submitPoolBatchItems`'s only
 * precondition was `bounty.status !== "active"` — unlike its sibling
 * `createBountyPoolItems`, it had NO capacity check at all, so a bulk submit
 * (this function backs both the `/v1/submissions/bulk` REST route and the
 * MCP `submit_pool_items` tool, and will also back an upcoming bulk-source
 * ingest job) could overshoot a pool's `targetItems` by an unbounded amount
 * with zero server-side pushback. This suite proves the fix: the same
 * upfront advisory check `createBountyPoolItems` already has, PLUS a
 * per-item running-budget check inside the loop so a single large call
 * against a nearly-full pool stops itself partway through instead of trying
 * to create every item.
 *
 * As documented at both call sites, this is intentionally advisory/
 * best-effort only (a plain read of `bounty.acceptedItems` taken once before
 * the transaction) — the real, race-safe enforcement is the atomic
 * accept-time UPDATE in services/pool-lifecycle.ts. Nothing here duplicates
 * that lock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SubmissionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { submitPoolBatchItems } from "./submissions.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const TOKEN = `pcg_${process.pid}_${Math.floor(Math.random() * 1e9)}`;

let contributorId = "";
let datasetTypeId = "";
const bountyIds: string[] = [];

function payload(salt: string) {
  return { prompt: `pool capacity probe ${TOKEN} ${salt}` } as Record<string, unknown>;
}

async function makeBounty(label: string, target: number, accepted: number): Promise<string> {
  const b = await prisma.bounty.create({
    data: {
      kind: "community",
      title: `pool-capacity-gate ${label} ${TOKEN}`,
      description: "probe",
      datasetTypeId,
      requesterUserId: contributorId,
      status: "active",
      targetItems: target,
      acceptedItems: accepted,
      datasetCategory: "implementation",
      language: "Python",
      framework: "Community",
      auditMode: "partial",
      auditCoveragePct: 100,
      holdDays: 30,
    },
    select: { id: true },
  });
  bountyIds.push(b.id);
  return b.id;
}

beforeAll(async () => {
  const contributor = await prisma.user.create({
    data: { email: `${TOKEN}-c@local.test`, displayName: "pool capacity probe", authMethod: "email" },
    select: { id: true },
  });
  contributorId = contributor.id;

  const dt = await prisma.datasetType.create({
    data: {
      id: `pool_capacity_probe_${TOKEN}`,
      domain: "coding",
      name: "Pool capacity probe (no file field)",
      description: "Integration-test dataset type with no file field.",
      status: "draft",
      origin: "platform",
      category: "implementation",
      trustTier: "expert_audited",
      fields: [{ key: "prompt", label: "Prompt", role: "prompt", required: true }],
      verification: { pipeline: ["schema", "dedupe"], dedupeFields: ["prompt"], auditOptions: [100] },
    },
    select: { id: true },
  });
  datasetTypeId = dt.id;
});

afterAll(async () => {
  if (bountyIds.length) {
    const subs = await prisma.submission.findMany({ where: { bountyId: { in: bountyIds } }, select: { id: true } });
    if (subs.length) {
      await prisma.jobQueue.deleteMany({ where: { idempotencyKey: { in: subs.map((s) => `val:${s.id}:0`) } } });
    }
    await prisma.submission.deleteMany({ where: { bountyId: { in: bountyIds } } });
    await prisma.bounty.deleteMany({ where: { id: { in: bountyIds } } });
  }
  if (datasetTypeId) await prisma.datasetType.deleteMany({ where: { id: datasetTypeId } });
  if (contributorId) await prisma.user.deleteMany({ where: { id: contributorId } });
  await prisma.$disconnect();
});

describe("submitPoolBatchItems pool-capacity gate", { timeout: 120_000 }, () => {
  it("refuses the whole call upfront when the pool is already at its target", async () => {
    const bountyId = await makeBounty("already-full", 10, 10);

    await expect(
      submitPoolBatchItems({
        bountyId,
        contributorUserId: contributorId,
        items: [{ title: "should never land", payloadJson: payload("full") }],
      })
    ).rejects.toThrow("This pool already reached its item target.");

    expect(await prisma.submission.count({ where: { bountyId } })).toBe(0);
  });

  it("refuses the whole call upfront when the pool is already OVER its target", async () => {
    const bountyId = await makeBounty("already-over", 10, 11);

    await expect(
      submitPoolBatchItems({
        bountyId,
        contributorUserId: contributorId,
        items: [{ title: "should never land", payloadJson: payload("over") }],
      })
    ).rejects.toThrow("This pool already reached its item target.");

    expect(await prisma.submission.count({ where: { bountyId } })).toBe(0);
  });

  it("stops mid-batch once the running count of new items fills the remaining slots", async () => {
    // target 10, accepted 8 -> exactly 2 slots of "room" left.
    const bountyId = await makeBounty("two-remaining", 10, 8);

    const result = await submitPoolBatchItems({
      bountyId,
      contributorUserId: contributorId,
      items: [
        { title: "room item 1", payloadJson: payload("room-1") },
        { title: "room item 2", payloadJson: payload("room-2") },
        { title: "room item 3 (should not land)", payloadJson: payload("room-3") },
        { title: "room item 4 (should not land)", payloadJson: payload("room-4") },
      ],
    });

    expect(result.created).toBe(2);
    expect(result.stoppedAtCapacity).toBe(true);
    expect(result.submissions.map((s) => s.title)).toEqual(["room item 1", "room item 2"]);

    const rows = await prisma.submission.findMany({ where: { bountyId }, select: { title: true, status: true } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === SubmissionStatus.submitted)).toBe(true);
  });

  it("does not stop, and does not flag stoppedAtCapacity, when the whole batch fits", async () => {
    const bountyId = await makeBounty("plenty-of-room", 100, 0);

    const result = await submitPoolBatchItems({
      bountyId,
      contributorUserId: contributorId,
      items: [
        { title: "fits 1", payloadJson: payload("fits-1") },
        { title: "fits 2", payloadJson: payload("fits-2") },
        { title: "fits 3", payloadJson: payload("fits-3") },
      ],
    });

    expect(result.created).toBe(3);
    expect(result.stoppedAtCapacity).toBe(false);
    expect(await prisma.submission.count({ where: { bountyId } })).toBe(3);
  });

  it("never counts duplicate items against the capacity budget", async () => {
    // target 10, accepted 8 -> exactly 2 slots of real room left. The call
    // below carries 2 genuinely NEW items (unique-a, unique-b) plus 2 EXTRA
    // items that are exact duplicates of unique-a. If duplicates wrongly
    // consumed budget, the second duplicate (the 3rd item overall) would
    // trip the capacity stop and unique-b (the 4th item) would never be
    // created. Correct behavior: both duplicates land as `rejected` rows
    // that cost nothing, and unique-b still gets its slot.
    const bountyId = await makeBounty("dup-exempt", 10, 8);
    const uniqueAPayload = payload("unique-a");

    const result = await submitPoolBatchItems({
      bountyId,
      contributorUserId: contributorId,
      items: [
        { title: "unique a", payloadJson: uniqueAPayload },
        // Both exact byte-for-byte copies of unique-a's payload: the first
        // becomes a rejected duplicate of the row above, and the second
        // becomes a rejected duplicate of THAT (still matched via the
        // original submitted row, since dedupe lookups exclude only
        // `rejected` status). Neither should draw against the budget.
        { title: "dup of a, copy 1", payloadJson: uniqueAPayload },
        { title: "dup of a, copy 2", payloadJson: uniqueAPayload },
        { title: "unique b", payloadJson: payload("unique-b") },
      ],
    });

    expect(result.created).toBe(4);
    expect(result.stoppedAtCapacity).toBe(false);

    const rows = await prisma.submission.findMany({
      where: { bountyId },
      select: { title: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.title)).toEqual(["unique a", "dup of a, copy 1", "dup of a, copy 2", "unique b"]);
    // Only "copy 1" is the actual duplicate hit (it matches unique-a, the
    // still-`submitted` row). "copy 2" then matches "copy 1" too — dedupe
    // lookups exclude only `rejected` rows, and "copy 1" is itself rejected,
    // so "copy 2" falls back to matching unique-a directly and is rejected
    // the same way.
    expect(rows.map((r) => r.status)).toEqual([
      SubmissionStatus.submitted,
      SubmissionStatus.rejected,
      SubmissionStatus.rejected,
      SubmissionStatus.submitted,
    ]);
  });

  it("existing happy-path behavior is unchanged: a comfortably-under-capacity call creates every item", async () => {
    const bountyId = await makeBounty("regression-happy-path", 500, 3);

    const result = await submitPoolBatchItems({
      bountyId,
      contributorUserId: contributorId,
      items: [
        { title: "happy 1", payloadJson: payload("happy-1") },
        { title: "happy 2", payloadJson: payload("happy-2") },
      ],
    });

    expect(result.created).toBe(2);
    expect(result.stoppedAtCapacity).toBe(false);
    expect(result.submissions).toHaveLength(2);
  });
});

// Note: a `targetItems: 0` ("unbounded pool") case was intentionally NOT
// added here — the `bounties_required_sponsor_examples_bounds` check
// constraint (`required_sponsor_examples >= 0 AND required_sponsor_examples
// < target_items`, default `required_sponsor_examples` is 3) makes
// `targetItems: 0` an uninsertable row in this schema, so there is no real
// bounty state to exercise that branch against. The `target > 0` guard in
// the implementation stays as defensive code matching `createBountyPoolItems`'s
// existing pattern.
