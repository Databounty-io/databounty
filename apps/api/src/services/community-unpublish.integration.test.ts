// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `runCommunityUnpublishJob` — the `community.unpublish`
 * job behind the admin "retract" action.
 *
 * No live provider is ever called: neither publication token is set (asserted
 * below), so `isConfigured()` resolves `ok: false` before any network attempt.
 * That is exactly the path worth proving, because it is where the honesty rule
 * bites — a withdrawal that could NOT be performed must leave the dataset
 * recorded as still published, since it really is still public.
 */
import { afterAll, describe, expect, it } from "vitest";
import { AuditMode, CommunityPublicationStatus, DatasetCategory, PublicationTarget } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { runCommunityUnpublishJob } from "./community-publish.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

if (process.env.HUGGINGFACE_API_TOKEN || process.env.GITHUB_PUBLICATION_TOKEN) {
  throw new Error(
    "Refusing to run: a publication token is set. These tests assert the not-configured " +
      "withdrawal path and must never have live credentials available."
  );
}

const bountyIds: string[] = [];
const userIds: string[] = [];
const stamp = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

async function makeBounty(publicationStatus: CommunityPublicationStatus) {
  const s = stamp();
  const user = await prisma.user.create({
    data: {
      authMethod: "email", email: `unpub-${s}@test.local`, passwordHash: "x",
      displayName: "Unpublish Test", status: "active", handle: `unpub_${s}`,
    },
  });
  userIds.push(user.id);
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: user.id, communityRequesterUserId: user.id, kind: "community",
      title: `unpublish fixture ${s}`, description: "fixture", datasetCategory: DatasetCategory.debugging,
      language: "typescript", framework: "none", targetItems: BigInt(2), requiredSponsorExamples: 0,
      auditMode: AuditMode.partial, auditCoveragePct: 100, holdDays: 0, karmaPerAcceptedItem: 10,
      communityLicense: "CC-BY-4.0", publicationStatus,
    },
  });
  bountyIds.push(bounty.id);
  return bounty;
}

const publish = (bountyId: string, target: PublicationTarget, externalId: string | null) =>
  prisma.datasetPublication.create({
    data: { bountyId, target, status: CommunityPublicationStatus.published, externalId, url: "https://example.test/x", pushedAt: new Date() },
  });

const rows = (bountyId: string) =>
  prisma.datasetPublication.findMany({ where: { bountyId }, orderBy: { target: "asc" } });

afterAll(async () => {
  await prisma.datasetPublication.deleteMany({ where: { bountyId: { in: bountyIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: bountyIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("runCommunityUnpublishJob — never claims a withdrawal that did not happen", () => {
  it("leaves both targets published when no credential can perform the withdrawal", async () => {
    const bounty = await makeBounty(CommunityPublicationStatus.published);
    await publish(bounty.id, PublicationTarget.huggingface, "ns/ds");
    await publish(bounty.id, PublicationTarget.github, "owner/ds");

    await runCommunityUnpublishJob(bounty.id);

    const after = await rows(bounty.id);
    expect(after).toHaveLength(2);
    for (const row of after) {
      // Still public, so still `published` — the whole point.
      expect(row.status).toBe(CommunityPublicationStatus.published);
      expect(row.lastError).toMatch(/not set|not configured/i);
    }
    const b = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
    expect(b.publicationStatus).toBe(CommunityPublicationStatus.published);
  });

  it("records why each target could not be withdrawn, in the audit log", async () => {
    const bounty = await makeBounty(CommunityPublicationStatus.published);
    await publish(bounty.id, PublicationTarget.huggingface, "ns/ds");

    await runCommunityUnpublishJob(bounty.id);

    const logs = await prisma.adminAuditLog.findMany({ where: { targetId: bounty.id, action: "community_publication.retract_failed" } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses to withdraw a target with no recorded repo id rather than guessing one", async () => {
    const bounty = await makeBounty(CommunityPublicationStatus.published);
    await publish(bounty.id, PublicationTarget.github, null);

    await runCommunityUnpublishJob(bounty.id);

    const [row] = await rows(bounty.id);
    expect(row!.status).toBe(CommunityPublicationStatus.published);
  });

  it("is a no-op when nothing is published — retracting twice is safe", async () => {
    const bounty = await makeBounty(CommunityPublicationStatus.retracted);
    await prisma.datasetPublication.create({
      data: { bountyId: bounty.id, target: PublicationTarget.huggingface, status: CommunityPublicationStatus.retracted, externalId: "ns/ds" },
    });

    await expect(runCommunityUnpublishJob(bounty.id)).resolves.toBeUndefined();

    const [row] = await rows(bounty.id);
    expect(row!.status).toBe(CommunityPublicationStatus.retracted);
    expect(row!.lastError).toBeNull();
  });

  it("does not touch a bounty that was never published at all", async () => {
    const bounty = await makeBounty(CommunityPublicationStatus.not_requested);
    await expect(runCommunityUnpublishJob(bounty.id)).resolves.toBeUndefined();
    expect(await rows(bounty.id)).toHaveLength(0);
  });
});
