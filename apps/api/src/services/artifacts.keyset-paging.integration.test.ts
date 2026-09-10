// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for stable keyset paging on `listUserArtifacts`
 * (services/artifacts.ts), the service behind the `list_files` MCP tool.
 *
 * WHAT REGRESSED BEFORE THIS EXISTED: every list tool in this port paged with
 * `offset`. An offset page re-runs the query and skips N rows, so a row
 * inserted between two pages shifts every later row by one — the walk silently
 * REPEATS an item and silently SKIPS another. Nothing failed loudly; the caller
 * just got a wrong set. That is exactly what the mid-walk-insert test below
 * would catch and an offset implementation could not pass.
 *
 * `list_files` also regained v1's `bountyId` filter here: without it an agent
 * holding a bounty id had to page an entire account to find that pool's files.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactKind, ArtifactStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { listUserArtifacts } from "./artifacts.js";
import { CursorFilterMismatchError } from "../lib/keyset-cursor.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const TOKEN = `ksp_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
let ownerUserId = "";
let bountyAId = "";

/** Artifacts are ordered `createdAt desc, id desc`. Explicit, strictly
 * increasing timestamps keep the expected order deterministic instead of
 * depending on how many rows share a millisecond. */
async function makeArtifact(label: string, minuteOffset: number, bountyId: string | null) {
  const id = `art_${TOKEN}_${label}`;
  return prisma.artifact.create({
    data: {
      id,
      ownerUserId,
      kind: ArtifactKind.submission_attachment,
      filename: `${label}.json`,
      contentType: "application/json",
      storageKey: `artifacts/submission_attachment/${id}/${label}.json`,
      status: ArtifactStatus.ready,
      bountyId,
      createdAt: new Date(Date.UTC(2026, 8, 7, 10, minuteOffset, 0)),
    },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      authMethod: "email",
      email: `${TOKEN}@local.test`,
      passwordHash: "x",
      displayName: `Keyset Paging ${TOKEN}`,
      status: "active",
      handle: `h${TOKEN}`.slice(0, 30),
      emailVerifiedAt: new Date(),
    },
  });
  ownerUserId = user.id;

  const datasetType = await prisma.datasetType.findFirst({ select: { id: true } });
  if (!datasetType) throw new Error("catalog is empty; seed dataset_types before running this suite");

  const bounty = await prisma.bounty.create({
    data: {
      kind: "community",
      title: `Keyset paging pool ${TOKEN}`,
      description: "probe",
      datasetTypeId: datasetType.id,
      requesterUserId: ownerUserId,
      status: "active",
      targetItems: 100,
      datasetCategory: "implementation",
      language: "Python",
      framework: "Community",
      auditMode: "partial",
      auditCoveragePct: 100,
      holdDays: 30,
    },
  });
  bountyAId = bounty.id;

  // Six rows, newest first by construction: f6 (10:06) ... f1 (10:01).
  for (let i = 1; i <= 6; i += 1) await makeArtifact(`f${i}`, i, i <= 3 ? bountyAId : null);
});

afterAll(async () => {
  await prisma.artifact.deleteMany({ where: { ownerUserId } });
  await prisma.bounty.deleteMany({ where: { id: bountyAId } });
  await prisma.user.deleteMany({ where: { id: ownerUserId } });
});

describe("listUserArtifacts keyset paging", () => {
  it("walks every row exactly once across pages, with hasMore telling the truth", async () => {
    const first = await listUserArtifacts(ownerUserId, undefined, { limit: 4 });
    expect(first.items.map((a) => a.filename)).toEqual(["f6.json", "f5.json", "f4.json", "f3.json"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await listUserArtifacts(ownerUserId, undefined, { limit: 4, cursor: first.nextCursor! });
    expect(second.items.map((a) => a.filename)).toEqual(["f2.json", "f1.json"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("reports hasMore=false when the row count is an exact multiple of the page size", async () => {
    // 6 rows at limit 3: the second page ends the walk. A naive
    // `rows.length === limit` check would advertise a phantom third page.
    const p1 = await listUserArtifacts(ownerUserId, undefined, { limit: 3 });
    expect(p1.hasMore).toBe(true);
    const p2 = await listUserArtifacts(ownerUserId, undefined, { limit: 3, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(3);
    expect(p2.hasMore).toBe(false);
  });

  it("SKIPS NOTHING AND REPEATS NOTHING when a row is inserted mid-walk", async () => {
    // The offset bug, made concrete. Page 1 is read, then a NEWER row lands at
    // the head of the ordering. Under `skip: 3` the second page would re-serve
    // f3 (shifted down by the insert) and drop f1 off the end entirely.
    const p1 = await listUserArtifacts(ownerUserId, undefined, { limit: 3 });
    expect(p1.items.map((a) => a.filename)).toEqual(["f6.json", "f5.json", "f4.json"]);

    const intruder = await makeArtifact("intruder", 30, null); // 10:30 — newest of all

    const p2 = await listUserArtifacts(ownerUserId, undefined, { limit: 3, cursor: p1.nextCursor! });
    const walked = [...p1.items, ...p2.items].map((a) => a.filename);

    expect(p2.items.map((a) => a.filename)).toEqual(["f3.json", "f2.json", "f1.json"]);
    expect(new Set(walked).size).toBe(walked.length); // no duplicate
    expect(walked).not.toContain("intruder.json"); // a row added after the walk began is not injected mid-walk
    expect(walked).toEqual(["f6.json", "f5.json", "f4.json", "f3.json", "f2.json", "f1.json"]);

    await prisma.artifact.delete({ where: { id: intruder.id } });
  });

  it("PROOF the cursor test is not vacuous: the legacy offset path repeats a row under the same conditions", async () => {
    // Same scenario as the test above, paged with `offset` instead of `cursor`.
    // If this ever starts passing, the mid-walk-insert test above has stopped
    // discriminating between the two and is no longer evidence of anything.
    const p1 = await listUserArtifacts(ownerUserId, undefined, { limit: 3, offset: 0 });
    expect(p1.items.map((a) => a.filename)).toEqual(["f6.json", "f5.json", "f4.json"]);

    const intruder = await makeArtifact("intruder_offset", 31, null); // newest of all

    const p2 = await listUserArtifacts(ownerUserId, undefined, { limit: 3, offset: 3 });
    const walked = [...p1.items, ...p2.items].map((a) => a.filename);

    // The insert shifted everything down one, so row 4 of the new ordering is
    // f4 — already served on page 1. The walk repeats it and never reaches f1.
    expect(p2.items.map((a) => a.filename)).toEqual(["f4.json", "f3.json", "f2.json"]);
    expect(new Set(walked).size).toBeLessThan(walked.length); // duplicate, unlike the cursor walk
    expect(walked).not.toContain("f1.json"); // and a row was silently skipped

    await prisma.artifact.delete({ where: { id: intruder.id } });
  });

  it("refuses a cursor minted under a different filter instead of paging the wrong set", async () => {
    const unfiltered = await listUserArtifacts(ownerUserId, undefined, { limit: 2 });
    expect(unfiltered.nextCursor).toBeTruthy();
    // Same account, but now scoped to one pool: the cursor's position is
    // meaningless against this row set, so it must be refused, not honoured.
    await expect(
      listUserArtifacts(ownerUserId, undefined, { limit: 2, cursor: unfiltered.nextCursor!, bountyId: bountyAId }),
    ).rejects.toThrow(CursorFilterMismatchError);
  });

  it("filters by bountyId — v1's filter, dropped in this port and restored", async () => {
    const scoped = await listUserArtifacts(ownerUserId, undefined, { limit: 50, bountyId: bountyAId });
    expect(scoped.items.map((a) => a.filename).sort()).toEqual(["f1.json", "f2.json", "f3.json"]);
    expect(scoped.items.every((a) => a.bountyId === bountyAId)).toBe(true);
  });

  it("pages a bountyId-filtered walk with its own cursor", async () => {
    const p1 = await listUserArtifacts(ownerUserId, undefined, { limit: 2, bountyId: bountyAId });
    expect(p1.items).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    const p2 = await listUserArtifacts(ownerUserId, undefined, {
      limit: 2,
      bountyId: bountyAId,
      cursor: p1.nextCursor!,
    });
    expect(p2.items.map((a) => a.filename)).toEqual(["f1.json"]);
    expect(p2.hasMore).toBe(false);
  });

  it("never lists a deleted artifact", async () => {
    const doomed = await makeArtifact("doomed", 40, null);
    await prisma.artifact.update({ where: { id: doomed.id }, data: { status: ArtifactStatus.deleted } });
    const all = await listUserArtifacts(ownerUserId, undefined, { limit: 50 });
    expect(all.items.map((a) => a.filename)).not.toContain("doomed.json");
    await prisma.artifact.delete({ where: { id: doomed.id } });
  });
});
