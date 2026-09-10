// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the open pool intake dedup race, verified live
 * against a scratch DB.
 *
 * BEFORE THIS FIX: `createPoolSubmission`, `createBountyPoolItems`, and
 * `submitPoolBatchItems` each ran their own `existingDup` SELECT + insert
 * inside their own `$transaction`, with no per-bounty advisory lock and no
 * `try/catch` around `tx.submission.create()`. Two genuinely concurrent
 * requests to the same bounty with the same `dedupeKey` could both read
 * `existingDup = null` (READ COMMITTED cannot see the other's uncommitted
 * insert) and both attempt to insert. The database's own partial unique
 * index (`submissions_bounty_batch_dedupe_key_active_unique`) caught the
 * collision, but the resulting `PrismaClientKnownRequestError` (P2002) was
 * never caught: it propagated out of the `$transaction` callback, Prisma
 * rolled back the WHOLE transaction — for the bulk routes, destroying every
 * OTHER unrelated item created earlier in the same call — and the route's
 * generic `catch (err: any) => reply.badRequest(err.message)` leaked a raw
 * Postgres constraint-violation message to the client.
 *
 * THE FIX (services/submissions.ts): layer 1, a per-bounty Postgres advisory
 * transaction lock (`acquireBountyLock(tx, bountyId, "dedupe")`, v1 parity
 * with `withBountyDedupeLock`) serializes the check-then-insert critical
 * section per bounty, so a second concurrent transaction's `existingDup`
 * read can no longer race the first's insert. Layer 2, a `try/catch` around
 * each `tx.submission.create()` that treats the exact partial-unique-index
 * P2002 as "duplicate, reject" instead of a fatal error, is a defensive
 * backstop that should never fire with layer 1 in place, but guarantees a
 * stray race can never surface a raw DB error to a contributor.
 *
 * This suite proves both the single-item and bulk-call shapes of the bug are
 * closed: every concurrent call resolves cleanly (no thrown exception),
 * exactly one submission per colliding dedupeKey ends up non-rejected, and —
 * critically for the bulk path — every OTHER, unrelated item in a colliding
 * bulk call still lands as a real row instead of the whole call being wiped
 * out by one collision.
 *
 * Self-guard like the other integration tests: refuses to run outside a
 * disposable database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { AuditMode, AuthMethod, BountyStatus, DatasetCategory, SubmissionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createPoolSubmission, submitPoolBatchItems } from "./submissions.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const createdBountyIds: string[] = [];
const createdUserIds: string[] = [];

async function seedPool(): Promise<{ bountyId: string; contributorId: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contributor = await prisma.user.create({
    data: {
      authMethod: AuthMethod.email,
      email: `dedupe-race-${suffix}@local.test`,
      displayName: "Dedupe Race Fixture",
    },
  });
  createdUserIds.push(contributor.id);

  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: contributor.id,
      title: `dedupe-race fixture ${suffix}`,
      description: "fixture pool for the C10 intake dedupe race regression",
      status: BountyStatus.active,
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      // Large target so the pool-capacity gate (a separate concern) never
      // interferes with this test's assertions.
      targetItems: BigInt(1000),
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 100,
      holdDays: 0,
      karmaPerAcceptedItem: 25,
      // datasetTypeId left null: fileFieldsForBounty resolves an empty file-
      // field list for a bounty with no dataset type, which is all these
      // intake functions need — the pipeline itself is never run here.
    },
  });
  createdBountyIds.push(bounty.id);

  return { bountyId: bounty.id, contributorId: contributor.id };
}

afterAll(async () => {
  if (createdBountyIds.length) {
    await prisma.submission.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
    await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  }
  if (createdUserIds.length) {
    await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

async function concurrentIdenticalSubmits(concurrency: number) {
  const { bountyId, contributorId } = await seedPool();
  const payloadJson = { prompt: `identical payload, concurrency ${concurrency}` };

  // Every call fires at once with BYTE-IDENTICAL content to the same bounty —
  // this is the exact repro shape from the original C10 diagnosis.
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, (_, i) =>
      createPoolSubmission({
        bountyId,
        contributorUserId: contributorId,
        title: `identical item ${i}`,
        payloadJson,
        generationMethod: "human",
      }),
    ),
  );

  return { bountyId, results };
}

describe("C10 fix: open-pool intake dedupe race", () => {
  it("two genuinely concurrent identical-payload createPoolSubmission calls both resolve, and exactly one wins", async () => {
    const { bountyId, results } = await concurrentIdenticalSubmits(2);

    // (a) Every call resolves successfully — no thrown exception, no
    // rejected promise. Before the fix, one of these was a rejected promise
    // carrying a raw PrismaClientKnownRequestError P2002.
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }

    const rows = await prisma.submission.findMany({
      where: { bountyId },
      select: { id: true, status: true, duplicateOfSubmissionId: true, dedupeKey: true },
    });
    expect(rows).toHaveLength(2);

    // (b) Exactly one resulting submission is non-rejected.
    const nonRejected = rows.filter((r) => r.status !== SubmissionStatus.rejected);
    expect(nonRejected).toHaveLength(1);

    // (c) The rest are cleanly rejected with a real duplicateOfSubmissionId
    // pointing at the winner — never a thrown error, never a null reference
    // on the loser.
    const rejected = rows.filter((r) => r.status === SubmissionStatus.rejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.duplicateOfSubmissionId).toBe(nonRejected[0]!.id);
  });

  it("ten genuinely concurrent identical-payload createPoolSubmission calls all resolve, and exactly one wins (higher-confidence race window)", async () => {
    const { bountyId, results } = await concurrentIdenticalSubmits(10);

    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }

    const rows = await prisma.submission.findMany({
      where: { bountyId },
      select: { id: true, status: true, duplicateOfSubmissionId: true },
    });
    expect(rows).toHaveLength(10);

    const nonRejected = rows.filter((r) => r.status !== SubmissionStatus.rejected);
    expect(nonRejected).toHaveLength(1);

    const rejected = rows.filter((r) => r.status === SubmissionStatus.rejected);
    expect(rejected).toHaveLength(9);
    for (const r of rejected) {
      expect(r.duplicateOfSubmissionId).toBe(nonRejected[0]!.id);
    }
  });

  it("bulk: two concurrent submitPoolBatchItems calls sharing one colliding item never wipe out the other call's unrelated items", async () => {
    const { bountyId, contributorId } = await seedPool();

    // The two calls share ONE colliding payload (same dedupeKey) plus two
    // genuinely unique items each. Before the fix, whichever call's insert
    // lost the race threw an uncaught P2002 out of its OWN `$transaction`,
    // which rolled back that call's ENTIRE transaction — destroying its two
    // unrelated, non-colliding items along with the collision.
    const sharedPayload = { prompt: "shared colliding item" };

    const [resultA, resultB] = await Promise.allSettled([
      submitPoolBatchItems({
        bountyId,
        contributorUserId: contributorId,
        items: [
          { title: "unique A1", payloadJson: { prompt: "unique A1" } },
          { title: "unique A2", payloadJson: { prompt: "unique A2" } },
          { title: "shared (from A)", payloadJson: sharedPayload },
        ],
      }),
      submitPoolBatchItems({
        bountyId,
        contributorUserId: contributorId,
        items: [
          { title: "unique B1", payloadJson: { prompt: "unique B1" } },
          { title: "unique B2", payloadJson: { prompt: "unique B2" } },
          { title: "shared (from B)", payloadJson: sharedPayload },
        ],
      }),
    ]);

    // Every call resolves — neither call's transaction was rolled back by
    // the other's collision.
    expect(resultA.status).toBe("fulfilled");
    expect(resultB.status).toBe("fulfilled");

    const rows = await prisma.submission.findMany({
      where: { bountyId },
      select: { title: true, status: true },
    });

    // All 6 items land as real rows — 3 from each call. Before the fix, the
    // losing call's transaction rolled back entirely, so this could be as
    // few as 3 rows (only the winning call's items) or the run could have
    // thrown outright.
    expect(rows).toHaveLength(6);

    const byTitle = new Map(rows.map((r) => [r.title, r.status]));
    // Every genuinely unique item from BOTH calls survived as `submitted` —
    // none were collateral damage from the other call's collision.
    for (const title of ["unique A1", "unique A2", "unique B1", "unique B2"]) {
      expect(byTitle.get(title)).toBe(SubmissionStatus.submitted);
    }

    // Exactly one of the two colliding "shared" items won; the other is a
    // clean, non-thrown `rejected` duplicate.
    const sharedStatuses = rows.filter((r) => r.title.startsWith("shared")).map((r) => r.status);
    expect(sharedStatuses).toHaveLength(2);
    expect(sharedStatuses.filter((s) => s === SubmissionStatus.submitted)).toHaveLength(1);
    expect(sharedStatuses.filter((s) => s === SubmissionStatus.rejected)).toHaveLength(1);
  });
});
