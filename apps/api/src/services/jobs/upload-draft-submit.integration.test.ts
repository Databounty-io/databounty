// SPDX-License-Identifier: Apache-2.0

/**
 * Integration coverage for `runUploadDraftSubmitJob` (services/jobs/upload-draft-submit.ts).
 *
 * This job replaces the old synchronous no-op `POST /:id/submit` stub, which
 * flipped `SubmissionUploadDraft.status` to "submitted" and created nothing.
 * These tests pin the real contract:
 *
 *  - usable rows (errorCode IS NULL) become real Submission rows, and each
 *    source row is marked with the `submissionId` it became;
 *  - a stray/duplicate execution against a draft that has moved on from
 *    "submitting" (already finished, or never claimed) is a safe no-op;
 *  - the row-insert(s) for a chunk and the `submitCursorRowNumber` advance
 *    for that chunk happen in ONE transaction — after any run (partial or
 *    complete), the cursor and the actual set of items with `submissionId`
 *    set are always consistent: no row beyond the cursor has a
 *    `submissionId`, and no unsubmitted row at/before the cursor exists
 *    unless the run stopped early for a documented reason;
 *  - a draft revoked (cancelled) mid-run stops the job with NO further
 *    writes — the in-flight chunk's transaction rolls back whole rather than
 *    half-committing;
 *  - a pool at/near its item-count capacity truncates the final chunk and
 *    still reaches `status: "submitted"` (never stuck at "submitting"), with
 *    `submitError: "pool_full"` recorded honestly.
 *
 * Against the disposable test database — same guard as the other
 * integration tests in this package.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { BountyKind, BountyStatus, DatasetTypeStatus, GenerationMethod } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { runUploadDraftSubmitJob } from "./upload-draft-submit.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let datasetTypeId: string;
let userId: string;

const bountyIds: string[] = [];
const draftIds: string[] = [];

beforeAll(async () => {
  const dt = await prisma.datasetType.create({
    data: {
      id: `uds-${stamp}`,
      name: `Upload Draft Submit ${stamp}`,
      description: "Fixture dataset type for upload-draft-submit job tests.",
      domain: "coding",
      status: DatasetTypeStatus.active,
      origin: "platform",
      category: "implementation",
      trustTier: "llm_verified",
      fields: [{ key: "instruction", label: "Instruction", role: "instruction", required: true }],
      verification: { pipeline: ["schema", "human_audit"] },
    },
  });
  datasetTypeId = dt.id;
  const user = await prisma.user.create({
    data: {
      email: `uds-${stamp}@example.com`,
      handle: `uds${stamp}`.slice(0, 20),
      displayName: "uds",
      authMethod: "email",
      passwordHash: "x",
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.submission.deleteMany({ where: { bountyId: { in: bountyIds } } });
  await prisma.submissionUploadDraftItem.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.submissionUploadDraft.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: bountyIds } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.datasetType.deleteMany({ where: { id: datasetTypeId } });
  await prisma.$disconnect();
});

/** A fresh active community pool per test that needs its own capacity/status
 * (several tests deliberately manipulate `targetItems`/`status`, so sharing
 * one bounty across tests would make them interfere). */
async function createPool(params: { targetItems: number; status?: BountyStatus }) {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: userId,
      title: `Upload Draft Submit Pool ${stamp}-${randomBytes(4).toString("hex")}`,
      description: "Fixture pool for upload-draft-submit job tests.",
      datasetCategory: "implementation",
      language: "TypeScript",
      framework: "Node.js",
      auditCoveragePct: 10,
      auditMode: "partial",
      holdDays: 0,
      disputeWindowHours: 48,
      communityLicense: "CC-BY-4.0",
      kind: BountyKind.community,
      status: params.status ?? BountyStatus.active,
      datasetTypeId,
      targetItems: params.targetItems,
    },
  });
  bountyIds.push(bounty.id);
  return bounty;
}

/** A `SubmissionUploadDraft` in `status: "submitting"` (the state the real
 * submit route CAS-claims into right before enqueuing the job) plus its
 * `SubmissionUploadDraftItem` rows. `rows` lets a test mix usable rows
 * (`errorCode: undefined`) with unusable ones (`errorCode: "X"`), matching
 * what a real parse produces. */
async function createSubmittingDraft(params: {
  bountyId: string;
  rows: Array<{ payload?: Record<string, unknown>; errorCode?: string }>;
  status?: string;
  revokedAt?: Date;
}) {
  const draft = await prisma.submissionUploadDraft.create({
    data: {
      ownerUserId: userId,
      targetKind: "community_pool",
      bountyId: params.bountyId,
      generationMethod: GenerationMethod.human,
      tokenHash: `uds-token-${randomBytes(16).toString("hex")}`,
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      draftExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      status: params.status ?? "submitting",
      revokedAt: params.revokedAt,
    },
  });
  draftIds.push(draft.id);

  await prisma.submissionUploadDraftItem.createMany({
    data: params.rows.map((row, index) => ({
      draftId: draft.id,
      rowNumber: index + 1,
      payload: row.errorCode ? undefined : { instruction: `row ${index + 1}`, ...row.payload },
      errorCode: row.errorCode ?? null,
      errorMessage: row.errorCode ? "fixture error" : null,
    })),
  });

  return draft;
}

describe("runUploadDraftSubmitJob — real ingest", () => {
  it("creates a Submission per usable row, marks each source row with its submissionId, and finalizes to submitted", async () => {
    const bounty = await createPool({ targetItems: 1000 });
    const draft = await createSubmittingDraft({
      bountyId: bounty.id,
      rows: [
        { payload: { instruction: "a" } },
        { errorCode: "NOT_AN_OBJECT" }, // unusable — must never be submitted
        { payload: { instruction: "b" } },
        { payload: { instruction: "c" } },
      ],
    });

    await runUploadDraftSubmitJob(draft.id);

    const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.status).toBe("submitted");
    expect(updated.submittedAt).not.toBeNull();
    expect(updated.accessTokenHash).toBeNull();
    expect(updated.submitError).toBeNull();
    expect(updated.submitCursorRowNumber).toBe(4);
    const summary = updated.previewSummary as Record<string, unknown>;
    expect(summary.submittedRows).toBe(3);
    expect(summary.stoppedEarly).toBe(false);

    const items = await prisma.submissionUploadDraftItem.findMany({
      where: { draftId: draft.id },
      orderBy: { rowNumber: "asc" },
    });
    expect(items[0]!.submissionId).not.toBeNull();
    expect(items[1]!.submissionId).toBeNull(); // the errorCode row
    expect(items[2]!.submissionId).not.toBeNull();
    expect(items[3]!.submissionId).not.toBeNull();

    const submissions = await prisma.submission.findMany({ where: { bountyId: bounty.id } });
    expect(submissions).toHaveLength(3);
    for (const s of submissions) expect(s.contributorUserId).toBe(userId);
  });

  it("is a safe no-op when the draft is not in status submitting (e.g. still review_ready, or already finished)", async () => {
    const bounty = await createPool({ targetItems: 1000 });
    const draft = await createSubmittingDraft({
      bountyId: bounty.id,
      rows: [{ payload: { instruction: "a" } }],
      status: "review_ready",
    });

    await runUploadDraftSubmitJob(draft.id);

    const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.status).toBe("review_ready"); // untouched
    const submissions = await prisma.submission.findMany({ where: { bountyId: bounty.id } });
    expect(submissions).toHaveLength(0);
  });

  it("running the job again after it already finished is idempotent (no duplicate submissions)", async () => {
    const bounty = await createPool({ targetItems: 1000 });
    const draft = await createSubmittingDraft({
      bountyId: bounty.id,
      rows: [{ payload: { instruction: "a" } }, { payload: { instruction: "b" } }],
    });

    await runUploadDraftSubmitJob(draft.id);
    const afterFirst = await prisma.submission.count({ where: { bountyId: bounty.id } });
    expect(afterFirst).toBe(2);

    // A stray duplicate execution (e.g. two workers claiming the same
    // idempotency key in a lease-reclaim race) must not create more rows —
    // the draft is no longer "submitting" once the first run finalized it.
    await runUploadDraftSubmitJob(draft.id);
    const afterSecond = await prisma.submission.count({ where: { bountyId: bounty.id } });
    expect(afterSecond).toBe(2);
  });

  it("spans multiple chunks (>200 usable rows) and keeps submitCursorRowNumber exactly consistent with which rows carry a submissionId", async () => {
    const bounty = await createPool({ targetItems: 100_000 });
    const rowCount = 250; // > the job's 200-row chunk size, so this exercises two committed chunk transactions
    const rows = Array.from({ length: rowCount }, (_, i) => ({ payload: { instruction: `bulk row ${i}`, unique: `${stamp}-${i}` } }));
    const draft = await createSubmittingDraft({ bountyId: bounty.id, rows });

    await runUploadDraftSubmitJob(draft.id);

    const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.status).toBe("submitted");
    expect(updated.submitCursorRowNumber).toBe(rowCount);
    expect(updated.submitError).toBeNull();

    // THE ATOMICITY INVARIANT: every row at/before the cursor has a
    // submissionId, and no row beyond it does — proving the two chunk
    // transactions (rows 1-200, rows 201-250) each committed their inserts
    // and their cursor advance together, never leaving one half without the
    // other.
    const items = await prisma.submissionUploadDraftItem.findMany({
      where: { draftId: draft.id },
      orderBy: { rowNumber: "asc" },
    });
    for (const item of items) {
      if (item.rowNumber <= updated.submitCursorRowNumber!) {
        expect(item.submissionId, `row ${item.rowNumber} should have a submissionId`).not.toBeNull();
      } else {
        expect(item.submissionId, `row ${item.rowNumber} should NOT have a submissionId`).toBeNull();
      }
    }

    const submissions = await prisma.submission.count({ where: { bountyId: bounty.id } });
    expect(submissions).toBe(rowCount);
  }, 60_000);

  it("stops at pool capacity, truncates the final chunk, and still reaches submitted (not stuck) with submitError pool_full", async () => {
    // acceptedItems defaults to 0, so targetItems IS the remaining room.
    const roomForItems = 5;
    const bounty = await createPool({ targetItems: roomForItems });
    const totalUsableRows = 12;
    const rows = Array.from({ length: totalUsableRows }, (_, i) => ({ payload: { instruction: `capped row ${i}` } }));
    const draft = await createSubmittingDraft({ bountyId: bounty.id, rows });

    await runUploadDraftSubmitJob(draft.id);

    const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.status).toBe("submitted"); // reached a terminal state, not stuck at "submitting"
    expect(updated.submitError).toBe("pool_full");
    const summary = updated.previewSummary as Record<string, unknown>;
    expect(summary.submittedRows).toBe(roomForItems);
    expect(summary.stoppedEarly).toBe(true);
    expect(summary.stopReason).toBe("pool_full");

    const submissions = await prisma.submission.count({ where: { bountyId: bounty.id } });
    expect(submissions).toBe(roomForItems);

    const remainingUnsubmitted = await prisma.submissionUploadDraftItem.count({
      where: { draftId: draft.id, submissionId: null },
    });
    expect(remainingUnsubmitted).toBe(totalUsableRows - roomForItems);
  });

  it("stops immediately (0 created) when the target pool is not active, and still reaches submitted with submitError pool_closed", async () => {
    const bounty = await createPool({ targetItems: 1000, status: BountyStatus.paused });
    const draft = await createSubmittingDraft({
      bountyId: bounty.id,
      rows: [{ payload: { instruction: "a" } }],
    });

    await runUploadDraftSubmitJob(draft.id);

    const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updated.status).toBe("submitted");
    expect(updated.submitError).toBe("pool_closed");
    const submissions = await prisma.submission.count({ where: { bountyId: bounty.id } });
    expect(submissions).toBe(0);
  });

  it("stops with NO further writes when the draft is revoked mid-run — the chunk transaction rolls back whole, and the draft is never finalized by this job", async () => {
    const bounty = await createPool({ targetItems: 1000 });
    // Mirrors the real race: the cancel route sets both `status: "cancelled"`
    // and `revokedAt` together, but the job's OWN top-of-function check only
    // reads `status`. Forcing `status: "submitting"` with `revokedAt` already
    // set isolates the in-transaction guard (services/jobs/upload-draft-submit.ts)
    // rather than the earlier top-level early return.
    const draft = await createSubmittingDraft({
      bountyId: bounty.id,
      rows: [{ payload: { instruction: "a" } }, { payload: { instruction: "b" } }],
      status: "submitting",
      revokedAt: new Date(),
    });

    await runUploadDraftSubmitJob(draft.id);

    const updated = await prisma.submissionUploadDraft.findUniqueOrThrow({ where: { id: draft.id } });
    // Untouched by this job: still "submitting", submitError still null,
    // previewSummary still whatever it was (null here) — ownership of a
    // revoked draft's terminal state belongs to the cancel route, not this job.
    expect(updated.status).toBe("submitting");
    expect(updated.submitError).toBeNull();
    expect(updated.submitCursorRowNumber).toBeNull();

    // Nothing partially committed: the whole chunk transaction (both
    // submissions plus the cursor advance) rolled back together.
    const submissions = await prisma.submission.count({ where: { bountyId: bounty.id } });
    expect(submissions).toBe(0);
    const itemsWithSubmission = await prisma.submissionUploadDraftItem.count({
      where: { draftId: draft.id, submissionId: { not: null } },
    });
    expect(itemsWithSubmission).toBe(0);
  });
});
