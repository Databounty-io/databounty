// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for backfilling a publication target that was enabled
 * AFTER a bounty already published (e.g. GitHub turned on once a bounty is
 * already `published` on Hugging Face only).
 *
 * Before this fix: `POST /v1/admin/community/bounties/:id/publication` with
 * `{ action: "retry" }` rejected every bounty already in `published` status
 * with 409, and `retry` (re-enqueuing `runCommunityPublishJob`) was the only
 * route that calls `enqueueCommunityPublish` — so a bounty with a `github`
 * target enabled after it already published to Hugging Face had NO way to
 * ever get a `github` DatasetPublication row created. `runCommunityPublishJob`
 * itself was always safe to re-run (each target's own idempotent-skip guard
 * — `current?.status === published` before the upsert — means an
 * already-published target is re-verified, never downgraded or double
 * recorded); the route's status guard was the only thing blocking it.
 *
 * `start_publishing` deliberately keeps its narrower allowed-status list
 * unchanged — it means "this hasn't published yet", which `published`
 * contradicts — so that action must still 409 from `published`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AuditMode, CommunityPublicationStatus, DatasetCategory, PublicationTarget } from "@prisma/client";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdBountyIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.datasetPublication.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
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
  return { userId, cookie };
}

async function makePublishedBounty(requesterUserId: string) {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId,
      communityRequesterUserId: requesterUserId,
      kind: "community",
      title: `publication retry-backfill fixture ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      description: "fixture bounty already published to Hugging Face only",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(2),
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: 100,
      holdDays: 0,
      karmaPerAcceptedItem: 10,
      communityLicense: "CC-BY-4.0",
      publicationStatus: CommunityPublicationStatus.published,
      huggingFaceDataset: "databounty-io/already-published-fixture",
    },
  });
  createdBountyIds.push(bounty.id);
  await prisma.datasetPublication.create({
    data: {
      bountyId: bounty.id,
      target: PublicationTarget.huggingface,
      status: CommunityPublicationStatus.published,
      externalId: "databounty-io/already-published-fixture",
      url: "https://huggingface.co/datasets/databounty-io/already-published-fixture",
      pushedAt: new Date(),
      attemptCount: 1,
    },
  });
  // No `github` row at all — exactly the state a target enabled after the
  // fact leaves a bounty in.
  return bounty;
}

describe("POST /v1/admin/community/bounties/:id/publication — backfilling a target enabled after publish", () => {
  it("retry succeeds (202) from status published, so a newly-enabled target can be backfilled", async () => {
    const admin = await signupAdmin("retry-backfill-admin");
    const bounty = await makePublishedBounty(admin.userId);

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/community/bounties/${bounty.id}/publication`,
      headers: { cookie: admin.cookie, origin: "http://localhost:3010" },
      payload: { action: "retry" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ queued: true });

    // The existing huggingface row must still be there and still published —
    // this fix must never touch, downgrade, or delete it.
    const rows = await prisma.datasetPublication.findMany({ where: { bountyId: bounty.id } });
    const hf = rows.find((r) => r.target === PublicationTarget.huggingface);
    expect(hf?.status).toBe(CommunityPublicationStatus.published);
  });

  it("start_publishing still 409s from status published (unchanged — that action means 'not yet published')", async () => {
    const admin = await signupAdmin("start-publishing-admin");
    const bounty = await makePublishedBounty(admin.userId);

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/community/bounties/${bounty.id}/publication`,
      headers: { cookie: admin.cookie, origin: "http://localhost:3010" },
      payload: { action: "start_publishing" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message ?? res.json().error).toMatch(/published/i);
  });
});
