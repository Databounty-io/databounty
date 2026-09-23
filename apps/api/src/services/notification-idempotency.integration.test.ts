// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for notification idempotency — the property that decides whether a
 * user's inbox is signal or noise.
 *
 * WHAT REGRESSED BEFORE THIS EXISTED: `notifyUser` defaulted its `eventKey` to
 * `${type}:${entityId ?? userId}:${Date.now()}`. v1's default is
 * `${type}:${keySuffix ?? entityId ?? userId}` with NO timestamp
 * (`v1 services/notifications.ts:766`). The appended clock made every key
 * unique, which silently disabled the entire deduplication mechanism below it
 * — the `pg_advisory_xact_lock` and the `userId_eventKey` upsert were correct
 * all along, they were just never handed a stable key.
 *
 * Measured on production 2026-09-22: 4,241 notifications carrying a 13-digit
 * epoch suffix, and real duplicates in real inboxes — `admin.system_alert`
 * +235 rows, `admin.system_recovered` +225, `community.request_status_changed`
 * +50, `submission.accepted` +12.
 *
 * The fix is not "dedupe everything". An event that can legitimately happen
 * AGAIN for the same entity — a submission re-validated after a revision, an
 * issue whose status changes twice — must still notify twice. v1 expresses
 * that with an explicit suffix (`validation:${submission.revisionCount}`), and
 * so does this port now. Both halves are asserted here, because a fix that
 * only collapsed duplicates would silently swallow the second real event.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import { notifyUser } from "./notifications.js";

requireDisposableDatabase();

const created: string[] = [];

async function makeUser(prefix: string) {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      authMethod: "email",
      email: `${prefix}-${stamp}@example.com`,
      displayName: prefix,
      emailVerifiedAt: new Date(),
      status: "active",
    },
  });
  created.push(user.id);
  return user;
}

const inboxCount = (userId: string, type: string) => prisma.notification.count({ where: { userId, type } });

beforeAll(async () => {
  // Nothing to set up beyond users; each test makes its own.
});

afterAll(async () => {
  if (created.length > 0) await prisma.user.deleteMany({ where: { id: { in: created } } });
});

describe("notification idempotency", () => {
  it("collapses a repeated emit for the same entity into ONE inbox row", async () => {
    // The production bug, directly: the same event emitted twice — a retry, a
    // re-run, two workers racing — must not reach the inbox twice.
    const user = await makeUser("dedupe");
    const args = {
      userId: user.id,
      type: "submission.accepted" as const,
      title: "Submission accepted",
      body: "Your submission was accepted.",
      entityType: "Submission",
      entityId: "sub_fixed_id",
    };

    await notifyUser(args);
    await notifyUser(args);
    await notifyUser(args);

    expect(await inboxCount(user.id, "submission.accepted")).toBe(1);
  });

  it("keeps different entities apart", async () => {
    // Dedupe must be per entity, not per type — two different submissions
    // accepted are two different pieces of news.
    const user = await makeUser("entities");
    for (const entityId of ["sub_a", "sub_b", "sub_c"]) {
      await notifyUser({
        userId: user.id,
        type: "submission.accepted",
        title: "Submission accepted",
        body: "Accepted.",
        entityType: "Submission",
        entityId,
      });
    }

    expect(await inboxCount(user.id, "submission.accepted")).toBe(3);
  });

  it("still notifies again when an explicit key says it is a NEW occurrence", async () => {
    // The half that matters most. A submission re-validated after a revision
    // is genuinely new news, and v1 encodes that as
    // `validation:${revisionCount}`. If this collapsed to one row, the
    // contributor would never learn their revision had failed too.
    const user = await makeUser("revisions");
    for (const revision of [0, 1, 2]) {
      await notifyUser({
        userId: user.id,
        type: "submission.needs_fixes",
        eventKey: `submission.needs_fixes:sub_same:validation:${revision}`,
        title: "Submission failed tests",
        body: "It failed again.",
        entityType: "Submission",
        entityId: "sub_same",
      });
    }

    expect(await inboxCount(user.id, "submission.needs_fixes")).toBe(3);
  });

  it("does not let one user's event suppress another's", async () => {
    // The key is unique per (userId, eventKey). A fan-out to several people
    // about one entity must reach all of them.
    const first = await makeUser("fanout-a");
    const second = await makeUser("fanout-b");
    for (const user of [first, second]) {
      await notifyUser({
        userId: user.id,
        type: "submission.accepted",
        title: "Submission accepted",
        body: "Accepted.",
        entityType: "Submission",
        entityId: "sub_shared",
      });
    }

    expect(await inboxCount(first.id, "submission.accepted")).toBe(1);
    expect(await inboxCount(second.id, "submission.accepted")).toBe(1);
  });

  it("writes no wall-clock suffix into the stored key", async () => {
    // A direct guard on the regression itself: if a 13-digit epoch ever
    // reappears in a default key, deduplication is off again and every
    // assertion above starts passing for the wrong reason.
    const user = await makeUser("nokey");
    await notifyUser({
      userId: user.id,
      type: "submission.accepted",
      title: "Submission accepted",
      body: "Accepted.",
      entityType: "Submission",
      entityId: "sub_key_shape",
    });

    const row = await prisma.notification.findFirst({ where: { userId: user.id } });
    expect(row?.eventKey).toBe("submission.accepted:sub_key_shape");
    expect(row?.eventKey).not.toMatch(/\d{13}/);
  });
});
