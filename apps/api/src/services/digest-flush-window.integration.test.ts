// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for which digesting rows a digest flush CLAIMS versus which it
 * SUMMARISES.
 *
 * WHAT REGRESSED BEFORE THIS EXISTED: `flushDigests` applied the 7-day window
 * (`DIGEST_MAX_WINDOW_MS`) to the query that selects rows, and claimed only
 * what that query returned. A notification older than the window was
 * therefore never summarised AND never claimed — it stayed `digesting`
 * permanently. v1 applies the same constant only as the stats-window anchor
 * and claims every digesting row (`v1 services/notifications.ts:2562`), so
 * this was a port-only defect.
 *
 * The second-order effect is the damaging one. The `groupBy` that picks
 * recipients has no window filter and runs `orderBy: userId asc, take 100`,
 * so a user holding only stale rows came back in that window on every tick,
 * forever, with nothing flushable — permanently consuming one of the hundred
 * slots and starving every user sorting after them. That is exactly the
 * head-of-line blocking the flush loop already documents guarding against for
 * a recipient that throws; this variant did it silently by returning false.
 *
 * The fix keeps the stated intent — a week-old backlog must not reappear in
 * today's digest — but retires those rows instead of orphaning them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotificationStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import { flushDigests } from "./notifications.js";

requireDisposableDatabase();

/** Well after the 09:00 default, so `digestSchedule(...).due` is true. */
const NOW = new Date("2026-09-22T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const created: string[] = [];

async function makeUser(prefix: string) {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      authMethod: "email",
      email: `${prefix}-${stamp}@example.com`,
      displayName: prefix,
      emailVerifiedAt: NOW,
      status: "active",
    },
  });
  created.push(user.id);
  return user;
}

async function digesting(userId: string, label: string, ageDays: number) {
  return prisma.notification.create({
    data: {
      userId,
      type: "pool.opened",
      title: label,
      body: label,
      eventKey: `${label}:${userId}`,
      status: NotificationStatus.digesting,
      createdAt: new Date(NOW.getTime() - ageDays * DAY_MS),
    },
  });
}

const stillDigesting = (userId: string) =>
  prisma.notification.count({ where: { userId, status: NotificationStatus.digesting } });

const digestSummaryFor = (userId: string) =>
  prisma.notification.findFirst({ where: { userId, type: "digest.summary" } });

beforeAll(async () => {
  // Any other recipient with digesting rows would be swept by the same call.
  // Start from a clean slate so the assertions below describe only this file.
  await prisma.notification.deleteMany({ where: { status: NotificationStatus.digesting } });
});

afterAll(async () => {
  if (created.length > 0) await prisma.user.deleteMany({ where: { id: { in: created } } });
});

describe("digest flush window", () => {
  it("summarises only recent rows but claims the stale ones too", async () => {
    const user = await makeUser("mixed");
    await digesting(user.id, "recent-a", 1);
    await digesting(user.id, "recent-b", 3);
    await digesting(user.id, "ancient", 30);

    const result = await flushDigests(100, NOW);
    expect(result.failedUsers).toBe(0);

    // Nothing is left behind — this is the property that was broken.
    expect(await stillDigesting(user.id)).toBe(0);

    const summary = await digestSummaryFor(user.id);
    expect(summary).not.toBeNull();
    const payload = summary!.data as { total: number };
    // The 30-day-old row is retired, not resurrected into today's digest.
    expect(payload.total).toBe(2);
  });

  it("retires a recipient whose rows are ALL stale, and sends them nothing", async () => {
    // The starvation case: before the fix this user returned false on every
    // tick forever while still occupying a slot in the 100-recipient window.
    const user = await makeUser("allstale");
    await digesting(user.id, "old-a", 20);
    await digesting(user.id, "old-b", 40);

    const result = await flushDigests(100, NOW);
    expect(result.failedUsers).toBe(0);

    expect(await stillDigesting(user.id)).toBe(0);
    expect(await digestSummaryFor(user.id)).toBeNull();
  });

  it("does not let a stale-only recipient block a later one in the same window", async () => {
    // `orderBy: userId asc` decides the window, so the guarantee that matters
    // is that a stale-only recipient consumes its slot exactly once.
    const blocker = await makeUser("blocker");
    await digesting(blocker.id, "old", 25);
    const real = await makeUser("real");
    await digesting(real.id, "fresh", 1);

    const result = await flushDigests(100, NOW);

    expect(result.failedUsers).toBe(0);
    expect(await stillDigesting(blocker.id)).toBe(0);
    expect(await digestSummaryFor(real.id)).not.toBeNull();
  });
});
