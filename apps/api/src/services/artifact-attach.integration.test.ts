// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the artifact -> submission binding
 * (services/artifact-attach.ts, called from every open-pool intake path in
 * services/submissions.ts).
 *
 * WHAT REGRESSED BEFORE THIS EXISTED: nothing in this deployment ever set
 * `artifacts.submission_id`. Files uploaded by a contributor were created,
 * scanned and left orphaned, so `services/sponsor-evidence.ts` (the sponsor's
 * per-submission evidence view) and `services/audits.ts` (the validator's
 * attachments/logs lists) — both of which query on `submissionId` — returned
 * empty for every item of every file-bearing dataset. v1 does this in one
 * shared helper (submission-row-insert.ts:324-370) called inside the same
 * transaction as the insert; that is what is asserted here.
 *
 * The negative cases matter as much as the happy path: each of the six
 * ownership guards is exercised individually, and every rejection is asserted
 * to have created NO submission rows — an attach that fails after the insert
 * commits would leave accepted items whose files never bound, which is worse
 * than refusing the submit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactKind, ArtifactStatus, GenerationMethod } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createBountyPoolItems, createPoolSubmission, submitPoolBatchItems } from "./submissions.js";
import { INVALID_FILE_ARTIFACT_REFERENCE } from "./artifact-attach.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const TOKEN = `afa_${process.pid}_${Math.floor(Math.random() * 1e9)}`;

let contributorId = "";
let otherUserId = "";
let datasetTypeId = "";
let bountyId = "";
let otherBountyId = "";

/** A payload for the file-bearing dataset type below. `screenshot` is the
 * `role: "file"` field, so its value IS an artifact id — the same convention
 * v1 uses and the one services/community-publish.ts already reads. */
function payload(artifactId: string | string[] | null, salt: string) {
  return {
    prompt: `attach probe ${TOKEN} ${salt}`,
    ...(artifactId === null ? {} : { screenshot: artifactId }),
  } as Record<string, unknown>;
}

async function makeArtifact(overrides: {
  ownerUserId?: string;
  bountyId?: string;
  status?: ArtifactStatus;
  kind?: ArtifactKind;
  submissionId?: string;
} = {}) {
  return prisma.artifact.create({
    data: {
      kind: overrides.kind ?? ArtifactKind.submission_attachment,
      status: overrides.status ?? ArtifactStatus.ready,
      ownerUserId: overrides.ownerUserId ?? contributorId,
      bountyId: overrides.bountyId ?? bountyId,
      submissionId: overrides.submissionId,
      filename: `${TOKEN}.png`,
      contentType: "image/png",
      storageKey: `verify/${TOKEN}/${Math.random().toString(36).slice(2)}.png`,
    },
    select: { id: true },
  });
}

async function makeBounty(label: string): Promise<string> {
  const b = await prisma.bounty.create({
    data: {
      kind: "community",
      title: `artifact-attach ${label} ${TOKEN}`,
      description: "probe",
      datasetTypeId,
      requesterUserId: contributorId,
      status: "active",
      targetItems: 100,
      datasetCategory: "implementation",
      language: "Python",
      framework: "Community",
      auditMode: "partial",
      auditCoveragePct: 100,
      holdDays: 30,
    },
    select: { id: true },
  });
  return b.id;
}

/** Submissions this pool holds right now — every rejection case asserts this
 * stays at the count it had before the attempt. */
async function submissionCount(inBounty = bountyId): Promise<number> {
  return prisma.submission.count({ where: { bountyId: inBounty } });
}

beforeAll(async () => {
  const [contributor, other] = await Promise.all([
    prisma.user.create({
      data: { email: `${TOKEN}-c@local.test`, displayName: "attach probe", authMethod: "email" },
      select: { id: true },
    }),
    prisma.user.create({
      data: { email: `${TOKEN}-o@local.test`, displayName: "attach probe other", authMethod: "email" },
      select: { id: true },
    }),
  ]);
  contributorId = contributor.id;
  otherUserId = other.id;

  // A dataset type that actually declares a `role: "file"` field. The seeded
  // catalog has none, and without one there is nothing for the attach step to
  // resolve — the gap this test exists to close would stay invisible.
  const dt = await prisma.datasetType.create({
    data: {
      id: `attach_probe_${TOKEN}`,
      domain: "coding",
      name: "Attach probe (file field)",
      description: "Integration-test dataset type carrying one role:file field.",
      status: "draft",
      origin: "platform",
      category: "implementation",
      trustTier: "expert_audited",
      fields: [
        { key: "prompt", label: "Prompt", role: "prompt", required: true },
        { key: "screenshot", label: "Screenshot", role: "file", required: true },
      ],
      verification: { pipeline: ["schema", "dedupe"], dedupeFields: ["prompt"], auditOptions: [100] },
    },
    select: { id: true },
  });
  datasetTypeId = dt.id;

  bountyId = await makeBounty("main");
  otherBountyId = await makeBounty("other");
});

afterAll(async () => {
  const bounties = [bountyId, otherBountyId].filter(Boolean);
  if (bounties.length) {
    const subs = await prisma.submission.findMany({ where: { bountyId: { in: bounties } }, select: { id: true } });
    if (subs.length) {
      await prisma.jobQueue.deleteMany({
        where: { idempotencyKey: { in: subs.map((s) => `val:${s.id}:0`) } },
      });
    }
    await prisma.artifact.deleteMany({ where: { bountyId: { in: bounties } } });
    await prisma.submission.deleteMany({ where: { bountyId: { in: bounties } } });
    await prisma.bounty.deleteMany({ where: { id: { in: bounties } } });
  }
  if (datasetTypeId) await prisma.datasetType.deleteMany({ where: { id: datasetTypeId } });
  await prisma.user.deleteMany({ where: { id: { in: [contributorId, otherUserId].filter(Boolean) } } });
  await prisma.$disconnect();
});

describe("attachFileArtifacts via the open-pool intake paths", { timeout: 120_000 }, () => {
  it("binds a referenced artifact to the submission it was submitted with", async () => {
    const artifact = await makeArtifact();

    const result = await submitPoolBatchItems({
      bountyId,
      contributorUserId: contributorId,
      items: [{ title: "attach happy path", payloadJson: payload(artifact.id, "happy") }],
    });
    expect(result.created).toBe(1);
    const submissionId = result.submissions[0]!.id;

    const after = await prisma.artifact.findUnique({ where: { id: artifact.id }, select: { submissionId: true } });
    expect(after?.submissionId).toBe(submissionId);

    // The shape both real consumers read: sponsor-evidence.ts and audits.ts
    // both find attachments by querying on submissionId, not by re-parsing
    // the payload. Prove the artifact is reachable that way.
    const bySubmission = await prisma.artifact.findMany({
      where: { submissionId, kind: ArtifactKind.submission_attachment, status: { not: ArtifactStatus.deleted } },
      select: { id: true },
    });
    expect(bySubmission.map((a) => a.id)).toEqual([artifact.id]);
  });

  it("binds on the single-item and raw-payload intake paths too", async () => {
    const single = await makeArtifact();
    const submission = await createPoolSubmission({
      bountyId,
      contributorUserId: contributorId,
      title: "attach single path",
      payloadJson: payload(single.id, "single"),
      generationMethod: GenerationMethod.human,
    });
    expect(
      (await prisma.artifact.findUnique({ where: { id: single.id }, select: { submissionId: true } }))?.submissionId
    ).toBe(submission.id);

    const raw = await makeArtifact();
    const created = await createBountyPoolItems({
      bountyId,
      contributorUserId: contributorId,
      items: [payload(raw.id, "raw")],
      generationMethod: GenerationMethod.human,
    });
    expect(created).toHaveLength(1);
    expect(
      (await prisma.artifact.findUnique({ where: { id: raw.id }, select: { submissionId: true } }))?.submissionId
    ).toBe(created[0]!.id);
  });

  it("rejects an artifact owned by another user, and writes no submission", async () => {
    const foreign = await makeArtifact({ ownerUserId: otherUserId });
    const before = await submissionCount();

    await expect(
      submitPoolBatchItems({
        bountyId,
        contributorUserId: contributorId,
        items: [{ title: "attach cross user", payloadJson: payload(foreign.id, "crossuser") }],
      })
    ).rejects.toThrow(INVALID_FILE_ARTIFACT_REFERENCE);

    expect(await submissionCount()).toBe(before);
    expect(
      (await prisma.artifact.findUnique({ where: { id: foreign.id }, select: { submissionId: true } }))?.submissionId
    ).toBeNull();
  });

  it("rejects an artifact already attached to an earlier submission", async () => {
    const artifact = await makeArtifact();
    const first = await submitPoolBatchItems({
      bountyId,
      contributorUserId: contributorId,
      items: [{ title: "attach reuse first", payloadJson: payload(artifact.id, "reuse-first") }],
    });
    const firstId = first.submissions[0]!.id;
    const before = await submissionCount();

    await expect(
      submitPoolBatchItems({
        bountyId,
        contributorUserId: contributorId,
        items: [{ title: "attach reuse second", payloadJson: payload(artifact.id, "reuse-second") }],
      })
    ).rejects.toThrow(INVALID_FILE_ARTIFACT_REFERENCE);

    expect(await submissionCount()).toBe(before);
    // Still bound to the FIRST submission — a re-reference must never steal it.
    expect(
      (await prisma.artifact.findUnique({ where: { id: artifact.id }, select: { submissionId: true } }))?.submissionId
    ).toBe(firstId);
  });

  it("rejects an artifact that is not `ready`", async () => {
    const scanning = await makeArtifact({ status: ArtifactStatus.scanning });
    const before = await submissionCount();

    await expect(
      submitPoolBatchItems({
        bountyId,
        contributorUserId: contributorId,
        items: [{ title: "attach not ready", payloadJson: payload(scanning.id, "notready") }],
      })
    ).rejects.toThrow(INVALID_FILE_ARTIFACT_REFERENCE);

    expect(await submissionCount()).toBe(before);
    expect(
      (await prisma.artifact.findUnique({ where: { id: scanning.id }, select: { submissionId: true } }))?.submissionId
    ).toBeNull();
  });

  it("rejects an artifact uploaded against a different bounty", async () => {
    const elsewhere = await makeArtifact({ bountyId: otherBountyId });
    const before = await submissionCount();

    await expect(
      submitPoolBatchItems({
        bountyId,
        contributorUserId: contributorId,
        items: [{ title: "attach wrong bounty", payloadJson: payload(elsewhere.id, "wrongbounty") }],
      })
    ).rejects.toThrow(INVALID_FILE_ARTIFACT_REFERENCE);

    expect(await submissionCount()).toBe(before);
    expect(
      (await prisma.artifact.findUnique({ where: { id: elsewhere.id }, select: { submissionId: true } }))?.submissionId
    ).toBeNull();
  });

  it("rejects a whole multi-item submit when only ONE reference is bad", async () => {
    const good = await makeArtifact();
    const bad = await makeArtifact({ status: ArtifactStatus.quarantined });
    const before = await submissionCount();

    await expect(
      submitPoolBatchItems({
        bountyId,
        contributorUserId: contributorId,
        items: [
          { title: "attach partial good", payloadJson: payload(good.id, "partial-good") },
          { title: "attach partial bad", payloadJson: payload(bad.id, "partial-bad") },
        ],
      })
    ).rejects.toThrow(INVALID_FILE_ARTIFACT_REFERENCE);

    // All-or-nothing: neither item survives, and the VALID artifact is left
    // unattached and re-usable rather than bound to a row that was rolled back.
    expect(await submissionCount()).toBe(before);
    const [goodAfter, badAfter] = await Promise.all([
      prisma.artifact.findUnique({ where: { id: good.id }, select: { submissionId: true } }),
      prisma.artifact.findUnique({ where: { id: bad.id }, select: { submissionId: true } }),
    ]);
    expect(goodAfter?.submissionId).toBeNull();
    expect(badAfter?.submissionId).toBeNull();
  });

  it("rejects one artifact referenced twice in the same submit", async () => {
    const artifact = await makeArtifact();
    const before = await submissionCount();

    await expect(
      submitPoolBatchItems({
        bountyId,
        contributorUserId: contributorId,
        items: [
          { title: "attach dup ref a", payloadJson: payload(artifact.id, "dupref-a") },
          { title: "attach dup ref b", payloadJson: payload(artifact.id, "dupref-b") },
        ],
      })
    ).rejects.toThrow(INVALID_FILE_ARTIFACT_REFERENCE);

    expect(await submissionCount()).toBe(before);
    expect(
      (await prisma.artifact.findUnique({ where: { id: artifact.id }, select: { submissionId: true } }))?.submissionId
    ).toBeNull();
  });

  it("submits normally when the contract declares a file field and the item omits it", async () => {
    const before = await submissionCount();
    const result = await submitPoolBatchItems({
      bountyId,
      contributorUserId: contributorId,
      items: [{ title: "attach no file", payloadJson: payload(null, "nofile") }],
    });
    expect(result.created).toBe(1);
    expect(await submissionCount()).toBe(before + 1);
  });
});
