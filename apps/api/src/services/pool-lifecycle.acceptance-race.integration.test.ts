// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for a real bug confirmed live on the dev server: community
 * pools accepting MORE items than their configured `targetItems` ("E2E
 * validator-reject action test" hit 2/1 accepted; "FULL LOOP E2E REGRESSION"
 * hit 106/100 items cleared — both real rows, not test assertions).
 *
 * Root cause: `services/submissions.ts`'s intake-time check
 * (`target > 0 && acceptedItems >= target`) only ever sees the pool's state
 * at SUBMISSION time. For a fast-moving pool near its target, that read is
 * stale by the time the item is actually ACCEPTED — dedupe, execution, and
 * LLM review all run first, possibly much later. `services/validation.ts`'s
 * two accept-time call sites then did a plain, unconditional
 * `bounty.update({ data: { acceptedItems: { increment: 1 } } } })`, so N
 * items all mid-pipeline when the pool had room for only one more could all
 * pass and all increment, overshooting the target.
 *
 * The fix: `claimPoolAcceptanceSlot` (services/pool-lifecycle.ts) — a single
 * atomic conditional UPDATE (`accepted_items = accepted_items + 1 WHERE ...
 * accepted_items < target_items`) run on the same transaction as the
 * submission's own status flip. These tests prove it two ways:
 *
 *  1. Directly hammering `claimPoolAcceptanceSlot` with concurrent callers on
 *     a `targetItems: 1` pool — exactly the race that produced the bug.
 *  2. End-to-end through the real `runSubmissionValidation` pipeline (the
 *     actual code path the two live overshot pools went through), asserting
 *     the loser gets a real, non-silent, non-quality-reason outcome
 *     (`rejected` + a `pool_capacity` ValidationResult row), not a silently
 *     dropped or silently double-accepted item.
 *
 * Self-guards like the other integration tests: refuses to run unless
 * DATABASE_URL points at the disposable verification database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { AuditMode, AuthMethod, DatasetCategory, GenerationMethod, SubmissionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { claimPoolAcceptanceSlot } from "./pool-lifecycle.js";
import { runSubmissionValidation } from "./validation.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const createdBountyIds: string[] = [];
const createdUserIds: string[] = [];

async function seedPool(targetItems: number): Promise<{ bountyId: string; contributorId: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contributor = await prisma.user.create({
    data: {
      authMethod: AuthMethod.email,
      email: `pool-race-${suffix}@local.test`,
      displayName: "Acceptance Race Fixture",
    },
  });
  createdUserIds.push(contributor.id);

  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: contributor.id,
      title: `acceptance-race fixture ${suffix}`,
      description: "fixture pool for the accept-time capacity race regression",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(targetItems),
      // requiredSponsorExamples must stay BELOW targetItems: the
      // `bounties_required_sponsor_examples_bounds` CHECK (restored from V1 by
      // migration 20260902100000) rejects the schema default of 3 on a
      // small-target fixture pool like this one.
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 100,
      holdDays: 0,
      karmaPerAcceptedItem: 25,
      // datasetTypeId left null: runSubmissionValidation treats a bounty with
      // no dataset type as "no_executable_harness", the same
      // !execution.available branch the two live overshot pools went
      // through when no execution sandbox was configured.
    },
  });
  createdBountyIds.push(bounty.id);

  return { bountyId: bounty.id, contributorId: contributor.id };
}

afterAll(async () => {
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("pool close-out accept-time capacity race (the overshoot bug)", () => {
  it("claimPoolAcceptanceSlot lets exactly N winners through a target of N under concurrent callers", async () => {
    const { bountyId } = await seedPool(1);

    // Five concurrent callers race for a pool with room for exactly one more
    // item — this is the exact shape of the bug: several items clearing
    // automation at (near) the same instant when the pool has one slot left.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => prisma.$transaction((tx) => claimPoolAcceptanceSlot(tx, bountyId))),
    );

    const winners = results.filter(Boolean).length;
    expect(winners).toBe(1);

    const bounty = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(Number(bounty.acceptedItems)).toBe(1);
    // Never overshoots, however many callers raced for the last slot.
    expect(Number(bounty.acceptedItems)).toBeLessThanOrEqual(Number(bounty.targetItems));
  });

  it("runSubmissionValidation on a target-1 pool accepts exactly one of two concurrently-clearing submissions, and the loser gets a real capacity outcome", async () => {
    const { bountyId } = await seedPool(1);

    // Two DIFFERENT contributors (not one contributor submitting twice): this
    // sidesteps a separate, pre-existing bug in
    // notifyValidationStageResults's eventKey construction (it doesn't fold
    // the submission id into the per-run notification dedup key, so two
    // submissions from the SAME contributor validated at the same
    // validationAttempt collide on the notifications table's unique
    // constraint) — orthogonal to the capacity race this test targets, and
    // flagged separately rather than fixed here.
    const contributors = await Promise.all(
      ["A", "B"].map(async (label) => {
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const user = await prisma.user.create({
          data: { authMethod: AuthMethod.email, email: `pool-race-${label}-${suffix}@local.test`, displayName: `Racer ${label}` },
        });
        createdUserIds.push(user.id);
        return user;
      }),
    );

    const [subA, subB] = await Promise.all(
      contributors.map((contributor, i) =>
        prisma.submission.create({
          data: {
            bountyId,
            contributorUserId: contributor.id,
            title: `racing item ${i}`,
            payloadJson: { prompt: `racing item ${i}` },
            generationMethod: GenerationMethod.human,
            status: SubmissionStatus.submitted,
          },
        }),
      ),
    ) as [Awaited<ReturnType<typeof prisma.submission.create>>, Awaited<ReturnType<typeof prisma.submission.create>>];

    // Both submissions clear automation (dedupe passes, no executable
    // harness configured -> honest "not attempted") at effectively the same
    // instant, exactly like the live overshoot: intake-time both saw
    // acceptedItems(0) < targetItems(1), so neither was rejected at intake.
    await Promise.all([runSubmissionValidation(subA.id, 0), runSubmissionValidation(subB.id, 0)]);

    const [freshA, freshB] = await Promise.all([
      prisma.submission.findUniqueOrThrow({ where: { id: subA.id } }),
      prisma.submission.findUniqueOrThrow({ where: { id: subB.id } }),
    ]);

    const statuses = [freshA.status, freshB.status].sort();
    // Exactly one accepted-into-the-pool, exactly one lost the race — never
    // both accepted (the bug) and never both silently dropped.
    expect(statuses).toEqual([SubmissionStatus.accepted_pending_sample, SubmissionStatus.rejected].sort());

    const bounty = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(Number(bounty.acceptedItems)).toBe(1);
    expect(Number(bounty.acceptedItems)).toBeLessThanOrEqual(Number(bounty.targetItems));

    // The loser's outcome is real and visible, not silent: a dedicated
    // ValidationResult evidence row exists naming the reason as capacity, not
    // quality.
    const loser = freshA.status === SubmissionStatus.rejected ? freshA : freshB;
    const capacityResult = await prisma.validationResult.findFirst({
      where: { submissionId: loser.id, stage: "pool_capacity" },
    });
    expect(capacityResult).not.toBeNull();
    expect(capacityResult?.passed).toBe(false);
    expect(capacityResult?.outcome).toBe("pool_capacity_reached");
  });
});
