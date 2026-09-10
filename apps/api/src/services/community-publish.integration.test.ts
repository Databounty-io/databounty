// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the new publish orchestration in
 * services/community-publish.ts: `runCommunityPublishJob` (the
 * `community.publish` job handler) and the credit-manifest wiring it uses
 * from services/reputation.ts (built earlier this session).
 *
 * These tests never call a live Hugging Face or GitHub API. Neither
 * `HUGGINGFACE_API_TOKEN` nor `GITHUB_PUBLICATION_TOKEN` is set in this
 * environment (verified below, and enforced by the DB-name self-guard
 * pattern other integration tests in this repo use), so every
 * `publicationProvider(...).isConfigured()` call resolves `ok: false` before
 * any network attempt — the "not configured" honesty path is exercised for
 * real, not mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditMode, CommunityPublicationStatus, DatasetCategory, GenerationMethod, PublicationTarget, SubmissionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  buildManifest,
  datasetCard,
  runCommunityPublishJob,
  PUBLISH_BOUNTY_SELECT,
  selectAcceptedSubmissionsForPublication,
} from "./community-publish.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

if (process.env.HUGGINGFACE_API_TOKEN || process.env.GITHUB_PUBLICATION_TOKEN) {
  throw new Error(
    "Refusing to run: HUGGINGFACE_API_TOKEN or GITHUB_PUBLICATION_TOKEN is set in this " +
      "environment. These tests assert the NOT-CONFIGURED path and must never have live " +
      "publication credentials available (they would otherwise attempt a real push)."
  );
}

const createdBountyIds: string[] = [];
const createdUserIds: string[] = [];

/** A fresh, collision-proof id suffix per fixture — same pattern used by
 * other integration tests in this repo (e.g. `mcp/tools.audit-claim.test.ts`
 * `createVerifiedUser`) — so a re-run, a partial-cleanup from an interrupted
 * prior run, or another session's concurrent test run against the same
 * shared DB never collides on `users_email_key` / `users_handle_key`. */
function uniqueStamp(): string {
  return `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

async function makeUser(suffix: string, opts: { handle?: string | null; attributionOptOut?: boolean } = {}) {
  const stamp = uniqueStamp();
  const user = await prisma.user.create({
    data: {
      authMethod: "email",
      email: `community-publish-${suffix}-${stamp}@test.local`,
      passwordHash: "x",
      displayName: `Publish Test ${suffix}`,
      status: "active",
      handle: opts.handle === undefined ? `pub_test_${suffix}_${stamp}` : opts.handle,
      publicProfilePrefs: opts.attributionOptOut ? { attributionOptOut: true } : undefined,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

async function makeCommunityBounty(params: { requesterUserId: string; communityRequesterUserId?: string; communityLicense?: string | null }) {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: params.requesterUserId,
      communityRequesterUserId: params.communityRequesterUserId ?? params.requesterUserId,
      kind: "community",
      title: `community publish fixture ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      description: "fixture bounty for community-publish tests",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(2),
      // requiredSponsorExamples must stay BELOW targetItems: the
      // `bounties_required_sponsor_examples_bounds` CHECK (restored from V1 by
      // migration 20260902100000) rejects the schema default of 3 on a
      // small-target fixture pool like this one.
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 100,
      holdDays: 0,
      karmaPerAcceptedItem: 10,
      communityLicense: params.communityLicense === undefined ? "CC-BY-4.0" : params.communityLicense,
    },
  });
  createdBountyIds.push(bounty.id);
  return bounty;
}

async function acceptSubmission(bountyId: string, contributorUserId: string, title: string) {
  return prisma.submission.create({
    data: {
      bountyId,
      contributorUserId,
      title,
      payloadJson: { prompt: title, answer: "42" },
      generationMethod: GenerationMethod.human,
      status: SubmissionStatus.accepted,
    },
  });
}

afterAll(async () => {
  await prisma.datasetPublication.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.submission.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.adminSetting.deleteMany({ where: { key: "community.publish.enabled" } });
  await prisma.$disconnect();
});

describe("runCommunityPublishJob — fail-closed when publication is not configured", () => {
  it("records an honest not_configured DatasetPublication row for both targets, and never flips the bounty to published", async () => {
    const requester = await makeUser("req1");
    const bounty = await makeCommunityBounty({ requesterUserId: requester.id });

    await prisma.adminSetting.upsert({
      where: { key: "community.publish.enabled" },
      create: { key: "community.publish.enabled", value: true },
      update: { value: true },
    });

    await runCommunityPublishJob(bounty.id);

    const rows = await prisma.datasetPublication.findMany({ where: { bountyId: bounty.id } });
    const byTarget = new Map(rows.map((r) => [r.target, r]));

    const hf = byTarget.get(PublicationTarget.huggingface);
    expect(hf?.status).toBe(CommunityPublicationStatus.not_configured);
    expect(hf?.lastError).toMatch(/HUGGINGFACE_API_TOKEN/);

    const gh = byTarget.get(PublicationTarget.github);
    expect(gh?.status).toBe(CommunityPublicationStatus.not_configured);
    expect(gh?.lastError).toMatch(/GITHUB_PUBLICATION_TOKEN/);

    // Never a fake success: the bounty must not read as published when
    // nothing was actually pushed anywhere.
    const refreshed = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
    expect(refreshed.publicationStatus).not.toBe(CommunityPublicationStatus.published);
    expect(refreshed.huggingFaceDataset).toBeNull();
  });

  it("records a failed (not not_configured) row when the community license is missing, without touching either provider", async () => {
    const requester = await makeUser("req2");
    const bounty = await makeCommunityBounty({ requesterUserId: requester.id, communityLicense: null });

    await prisma.adminSetting.upsert({
      where: { key: "community.publish.enabled" },
      create: { key: "community.publish.enabled", value: true },
      update: { value: true },
    });

    await runCommunityPublishJob(bounty.id);

    const rows = await prisma.datasetPublication.findMany({ where: { bountyId: bounty.id } });
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.status).toBe(CommunityPublicationStatus.failed);
      expect(row.lastError).toMatch(/license/i);
    }
  });

  it("throws (does not silently no-op) when community.publish.enabled is off, and does not touch any DatasetPublication row", async () => {
    const requester = await makeUser("req3");
    const bounty = await makeCommunityBounty({ requesterUserId: requester.id });

    await prisma.adminSetting.upsert({
      where: { key: "community.publish.enabled" },
      create: { key: "community.publish.enabled", value: false },
      update: { value: false },
    });

    await expect(runCommunityPublishJob(bounty.id)).rejects.toThrow(/disabled/i);

    const rows = await prisma.datasetPublication.findMany({ where: { bountyId: bounty.id } });
    expect(rows.length).toBe(0);
  });
});

describe("public dataset item boundary", () => {
  it("publishes no more than targetItems and chooses the same rows deterministically", async () => {
    const requester = await makeUser("req-cap");
    const contributor = await makeUser("contributor-cap");
    const bounty = await makeCommunityBounty({ requesterUserId: requester.id });
    const inserted = [
      await acceptSubmission(bounty.id, contributor.id, "item one"),
      await acceptSubmission(bounty.id, contributor.id, "item two"),
      await acceptSubmission(bounty.id, contributor.id, "item three — over target"),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

    const selected = await selectAcceptedSubmissionsForPublication(bounty.id, bounty.targetItems);

    expect(selected).toHaveLength(2);
    expect(selected.map((row) => row.id)).toEqual(inserted.slice(0, 2).map((row) => row.id));
    expect(selected.map((row) => row.id)).not.toContain(inserted[2]!.id);
  });
});

describe("credit-manifest integration — buildManifest / datasetCard", () => {
  it("credits an opted-in contributor by handle and anonymizes an opted-out one, matching services/reputation.ts's rules exactly", async () => {
    const stamp = uniqueStamp();
    const creditedHandle = `credited_handle_${stamp}`;
    const optedOutHandle = `opted_out_handle_${stamp}`;
    const requester = await makeUser("req-credit");
    const creditedContributor = await makeUser("credited", { handle: creditedHandle });
    const optedOutContributor = await makeUser("optedout", { handle: optedOutHandle, attributionOptOut: true });
    const noHandleContributor = await makeUser("nohandle", { handle: null });

    const bounty = await makeCommunityBounty({ requesterUserId: requester.id });
    await acceptSubmission(bounty.id, creditedContributor.id, "item one");
    await acceptSubmission(bounty.id, optedOutContributor.id, "item two");
    await acceptSubmission(bounty.id, noHandleContributor.id, "item three");

    const publishBounty = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id }, select: PUBLISH_BOUNTY_SELECT });
    const manifest = await buildManifest(publishBounty, 3);

    // The opted-in, handled contributor is named; the opted-out contributor
    // and the handle-less contributor are both folded into the anonymized
    // count — never named, and never silently dropped either.
    expect(manifest.contributors.credited).toEqual([creditedHandle]);
    expect(manifest.contributors.anonymizedCount).toBe(2);
    expect(manifest.acceptedItems).toBe(3);
    expect(manifest.license).toBe("CC-BY-4.0");

    const card = datasetCard(publishBounty, manifest);
    expect(card).toContain(`@${creditedHandle}`);
    expect(card).not.toContain(optedOutHandle);
    expect(card).toMatch(/and 2 contributor\(s\) who opted out of public credit\./);
    // The pinned data path must appear in the YAML `configs:` block so the Hub
    // viewer never falls back to auto-detecting `manifest.json` as a second,
    // incompatible split.
    expect(card).toContain("path: data/items.jsonl");
    // license: tag present in YAML front matter, normalized to HF's lowercase form
    expect(card).toMatch(/license: cc-by-4\.0/);
  });

  it("renders the honest empty-credit sentence when nobody credited opted in", async () => {
    const requester = await makeUser("req-credit-2");
    const optedOutOnly = await makeUser("optedout2", { handle: `handle_two_${uniqueStamp()}`, attributionOptOut: true });
    const bounty = await makeCommunityBounty({ requesterUserId: requester.id });
    await acceptSubmission(bounty.id, optedOutOnly.id, "only item");

    const publishBounty = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id }, select: PUBLISH_BOUNTY_SELECT });
    const manifest = await buildManifest(publishBounty, 1);

    expect(manifest.contributors.credited).toEqual([]);
    expect(manifest.contributors.anonymizedCount).toBe(1);
    const card = datasetCard(publishBounty, manifest);
    expect(card).toContain("_No contributors opted into public credit._");
  });
});
