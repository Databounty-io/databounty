// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for a real leak found by live browser testing on the
 * dev deployment: an account holding an admin/member/support role got
 * operational alerts (watchdog `admin.system_alert`, agent-issue-aging
 * `admin.agent_issue_aging`, etc.) mixed directly into its PERSONAL
 * contributor/sponsor/validator notification feed — `GET /v1/notifications`
 * filtered only on `userId`, with no exclusion for the `admin.*` type
 * namespace those events use. Confirmed live: every one of a shared admin
 * test account's 7 "personal" notifications was actually an admin ops alert.
 *
 * `routes/v1/admin-notifications.ts` already filters the OPPOSITE direction
 * (`type: { startsWith: "admin." }`, keeping an admin's personal
 * notifications out of the ops console) — this suite proves the missing
 * other half: the personal feed, its unread badge, and "mark all read" must
 * all exclude `admin.*` rows, for both the list/count queries in
 * `listNotifications` and the bulk update in `markAllNotificationsRead`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Role } from "@prisma/client";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { notifyEvent, notifyUser } from "../../services/notifications.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];

beforeEach(async () => {
  app = await buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

function uniqueSuffix(): string {
  return `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

async function signupVerifiedAdmin(prefix: string) {
  const stamp = uniqueSuffix();
  const email = `${prefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${prefix}${stamp}`, displayName: prefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  createdUserIds.push(userId);
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  await prisma.userRole.create({ data: { userId, role: Role.admin } });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

describe("GET /v1/notifications: admin-alert exclusion", () => {
  it("never returns admin.* rows, counts them out of the unread badge, and leaves them untouched by mark-all-read", async () => {
    const admin = await signupVerifiedAdmin("notifleakadmin");

    // One real admin ops alert and one real personal notification, both
    // unread, for the SAME account — exactly the shared-persona case the bug
    // hit. Targets this one admin's userId directly via notifyEvent — the
    // same write notifyAdminsEvent makes per recipient — rather than going
    // through notifyAdminsEvent's real fan-out, which loops every admin/
    // member/support user in this shared verification database inside one
    // transaction and times out once enough accumulate across test runs;
    // that scale problem is orthogonal to what this test proves.
    await prisma.$transaction((tx) =>
      notifyEvent(tx, "admin.system_alert", { userId: admin.userId, keySuffix: `leak-probe-${admin.userId}` })
    );
    await notifyUser({
      userId: admin.userId,
      type: "karma.awarded",
      title: "Karma awarded",
      body: "You earned karma.",
      eventKey: `karma.awarded:leak-probe:${admin.userId}`,
    });

    const before = await prisma.notification.findMany({ where: { userId: admin.userId } });
    expect(before.some((n) => n.type.startsWith("admin."))).toBe(true);
    expect(before.some((n) => !n.type.startsWith("admin."))).toBe(true);

    const listRes = await app.inject({
      method: "GET",
      url: "/v1/notifications?limit=50",
      headers: { cookie: admin.cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const body = listRes.json() as { items: { type: string }[]; total: number; unreadCount: number };

    // Non-vacuous: the personal row IS there — this isn't "everything is
    // filtered out by accident", the admin.* row specifically is gone.
    expect(body.items.some((i) => i.type === "karma.awarded")).toBe(true);
    expect(body.items.some((i) => i.type.startsWith("admin."))).toBe(false);
    expect(body.total).toBe(1);
    expect(body.unreadCount).toBe(1);

    const readAllRes = await app.inject({
      method: "POST",
      url: "/v1/notifications/read-all",
      headers: { cookie: admin.cookie, origin: "http://localhost:3010" },
    });
    expect(readAllRes.statusCode).toBe(200);

    const after = await prisma.notification.findMany({ where: { userId: admin.userId } });
    const adminRow = after.find((n) => n.type.startsWith("admin."));
    const personalRow = after.find((n) => n.type === "karma.awarded");
    // The admin alert is still unread — "mark all read" on the personal
    // inbox must never silently clear a still-open ops alert the admin
    // never saw there.
    expect(adminRow?.read).toBe(false);
    expect(personalRow?.read).toBe(true);
  }, 30_000);
});
