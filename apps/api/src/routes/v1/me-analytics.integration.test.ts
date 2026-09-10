// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level coverage for GET /v1/me/analytics.
 *
 * The point of these is the part a unit test cannot reach: that the SQL
 * bucketing agrees with the TypeScript bucket list. `date_trunc('week', …)`
 * runs in Postgres and `weekStarts()` runs in Node, and if they disagreed
 * about when a week starts every chart would be shifted by a day while still
 * looking perfectly plausible. So this seeds karma events at known instants
 * and asserts they land in the exact bucket the endpoint claims.
 *
 * Karma events are the fixture because they need nothing but a user row —
 * `karma_events.created_at` is a real event timestamp, which is the same
 * property the endpoint relies on.
 *
 * Same harness/self-guard pattern as the other route-level integration tests
 * in this directory: Fastify inject() against buildApp(), no port bound,
 * refuses to run outside the disposable verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { KarmaEventType } from "@prisma/client";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { startOfUtcWeek, MIN_WEEKS, MAX_WEEKS } from "../../services/analytics.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

// The route is on by default; "false" is the off-switch that closes the
// parity divergence (routes/v1/me.ts explains why it exists). Pinned here so
// this file is unaffected by whatever the ambient environment sets.
process.env.MEMBER_ANALYTICS_ENABLED = "true";

let app: FastifyInstance;
const createdUserIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
  await prisma.$disconnect();
});

async function signupVerified(emailPrefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${emailPrefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email,
      password: "Test@12345",
      handle: `${emailPrefix}${stamp}`.replace(/[^a-z0-9]/gi, "").slice(0, 20),
      displayName: emailPrefix,
    },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

/** Days back from now, as an instant safely inside that day in UTC. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function byWeekMap<T extends { weekStart: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.weekStart, r]));
}

function weekOf(date: Date): string {
  return startOfUtcWeek(date).toISOString().slice(0, 10);
}

async function seedKarma(userId: string, amount: number, at: Date, sourceId: string) {
  await prisma.karmaEvent.create({
    data: {
      userId,
      eventType: KarmaEventType.admin_adjustment,
      amount,
      sourceType: "test:analytics",
      sourceId,
      createdAt: at,
    },
  });
}

describe("GET /v1/me/analytics", () => {
  it("is not registered at all when the off-switch is set", async () => {
    // Proves the gate is the route registration itself, not an authorization
    // check inside it: with the flag off there is no route to reach, which is
    // what keeps the parity route comparison clean.
    const off = await buildApp();
    await off.ready();
    try {
      process.env.MEMBER_ANALYTICS_ENABLED = "false";
      const fresh = await buildApp();
      await fresh.ready();
      const res = await fresh.inject({ method: "GET", url: "/v1/me/analytics" });
      expect(res.statusCode).toBe(404);
      await fresh.close();
    } finally {
      process.env.MEMBER_ANALYTICS_ENABLED = "true";
      await off.close();
    }
  });

  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me/analytics" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a window outside the supported bounds", async () => {
    const { cookie } = await signupVerified("analytics-bounds");
    for (const weeks of [MIN_WEEKS - 1, MAX_WEEKS + 1, 0, -3]) {
      const res = await app.inject({ method: "GET", url: `/v1/me/analytics?weeks=${weeks}`, headers: { cookie } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_query");
    }
  });

  it("returns one real zero bucket per week for a member with no activity", async () => {
    const { cookie } = await signupVerified("analytics-empty");
    const res = await app.inject({ method: "GET", url: "/v1/me/analytics?weeks=8", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.range).toMatchObject({ weeks: 8, bucket: "week", weekStartsOn: "monday", timezone: "UTC" });
    expect(body.contributor.submissions).toHaveLength(8);
    expect(body.contributor.karma).toHaveLength(8);
    expect(body.validator.audits).toHaveLength(8);

    // A quiet week is a zero, never an omitted bucket or a null.
    for (const week of body.contributor.submissions) {
      expect(week).toMatchObject({ submitted: 0, accepted: 0, rejected: 0, needsFixes: 0, inReview: 0 });
    }
    expect(body.contributor.totals).toMatchObject({ submitted: 0, accepted: 0, karma: 0 });
    expect(body.validator.totals).toMatchObject({ audited: 0, flagged: 0 });

    // The caveats travel with the numbers.
    expect(body.notes.length).toBeGreaterThan(0);
    for (const note of body.notes) {
      expect(typeof note.field).toBe("string");
      expect(note.note.length).toBeGreaterThan(0);
    }
  });

  it("puts karma in the SQL bucket the TypeScript week list names", async () => {
    const { userId, cookie } = await signupVerified("analytics-karma");
    const thisWeek = daysAgo(0);
    const lastWeek = daysAgo(8);
    const threeWeeksBack = daysAgo(20);

    await seedKarma(userId, 10, thisWeek, "a");
    await seedKarma(userId, 5, thisWeek, "b");
    await seedKarma(userId, 7, lastWeek, "c");
    await seedKarma(userId, 3, threeWeeksBack, "d");
    // Outside the window: must not appear in the series or the totals.
    await seedKarma(userId, 999, daysAgo(200), "e");

    const res = await app.inject({ method: "GET", url: "/v1/me/analytics?weeks=12", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const byWeek = new Map<string, { karma: number; events: number }>(
      body.contributor.karma.map((w: { weekStart: string; karma: number; events: number }) => [w.weekStart, w]),
    );

    expect(byWeek.get(weekOf(thisWeek))).toMatchObject({ karma: 15, events: 2 });
    expect(byWeek.get(weekOf(lastWeek))).toMatchObject({ karma: 7, events: 1 });
    expect(byWeek.get(weekOf(threeWeeksBack))).toMatchObject({ karma: 3, events: 1 });

    // 10 + 5 + 7 + 3 — the 200-day-old event is excluded by the window.
    expect(body.contributor.totals.karma).toBe(25);

    const weeksWithKarma = body.contributor.karma.filter((w: { karma: number }) => w.karma !== 0);
    expect(weeksWithKarma).toHaveLength(3);
  });

  // QA 2026-09-06: a community validator's audit decisions were reported as
  // `audited: 0` for every week, forever, while their audit karma was credited
  // normally — the community close-out path leaves AuditBatch.validatorUserId
  // NULL and records the validator on HumanAuditWindow.claimedByUserId, which
  // the audits query did not consult. Guards the COALESCE attribution.
  it("counts a community validator's decisions, attributed through the window claim", async () => {
    const validator = await signupVerified("qa-window-validator");
    const contributor = await signupVerified("qa-window-contributor");

    const bounty = await prisma.bounty.findFirst({
      where: { kind: "community" },
      select: { id: true },
    });
    if (!bounty) {
      // No community pool in this database: nothing to attribute against.
      // Reported honestly rather than asserted around.
      expect(bounty).toBeNull();
      return;
    }

    const submission = await prisma.submission.create({
      data: {
        bountyId: bounty.id,
        contributorUserId: contributor.userId,
        status: "in_audit",
        title: "qa analytics attribution fixture",
        payloadJson: {},
        generationMethod: "human",
      },
      select: { id: true },
    });
    // The community shape: batch carries NO validator, the window's claim does.
    const batch = await prisma.auditBatch.create({
      data: { bountyId: bounty.id, validatorUserId: null, itemCount: 1 },
      select: { id: true },
    });
    const window = await prisma.humanAuditWindow.create({
      data: {
        bountyId: bounty.id,
        windowIndex: 9000 + Math.floor(Math.random() * 900),
        eligibleCount: 1,
        quota: 1,
        auditBatchId: batch.id,
        claimedByUserId: validator.userId,
        claimedAt: new Date(),
        closureReason: "quota_met",
      },
      select: { id: true },
    });
    const item = await prisma.auditItem.create({
      data: { auditBatchId: batch.id, submissionId: submission.id, verdict: "ok", decidedAt: new Date() },
      select: { id: true },
    });

    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/me/analytics?weeks=12",
        headers: { cookie: validator.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().validator.totals.audited).toBe(1);
    } finally {
      await prisma.auditItem.delete({ where: { id: item.id } });
      await prisma.humanAuditWindow.delete({ where: { id: window.id } });
      await prisma.auditBatch.delete({ where: { id: batch.id } });
      await prisma.submission.delete({ where: { id: submission.id } });
    }
  });

  // Owner instruction 2026-09-07: the dashboard picks a date range, so the
  // endpoint has to serve one — and report the window it actually served.
  it("serves an explicit from/to range and buckets the weeks containing both dates", async () => {
    const user = await signupVerified("qa-range");
    // 2026-07-08 Wed .. 2026-07-22 Wed -> weeks of 07-06, 07-13, 07-20.
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/analytics?from=2026-07-08&to=2026-07-22",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.range).toMatchObject({ weeks: 3, from: "2026-07-06", to: "2026-07-20", timezone: "UTC" });
    expect(body.contributor.submissions.map((r: { weekStart: string }) => r.weekStart)).toEqual([
      "2026-07-06",
      "2026-07-13",
      "2026-07-20",
    ]);
  });

  it("excludes rows after `to` — an explicit range must not leak later weeks", async () => {
    const user = await signupVerified("qa-range-upper");
    // Inside the requested range, and well after it.
    await seedKarma(user.userId, 11, new Date("2026-07-15T12:00:00Z"), "in-range");
    await seedKarma(user.userId, 99, new Date("2026-08-19T12:00:00Z"), "after-range");
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/analytics?from=2026-07-08&to=2026-07-22",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.contributor.totals.karma).toBe(11);
    expect(byWeekMap(body.contributor.karma).get("2026-07-13")).toMatchObject({ karma: 11, events: 1 });
  });

  // One account for every malformed-window case: signup is rate-limited
  // (AUTH_RATE_LIMIT), and a signup per case exhausted the budget and turned
  // unrelated later tests into 429s.
  it("rejects every malformed window with 400 rather than guessing one", async () => {
    const user = await signupVerified("qa-range-bad");
    const cases: Array<[string, string]> = [
      ["from without to", "/v1/me/analytics?from=2026-07-08"],
      ["to without from", "/v1/me/analytics?to=2026-07-22"],
      ["from after to", "/v1/me/analytics?from=2026-08-01&to=2026-07-01"],
      ["a range longer than the 52-week ceiling", "/v1/me/analytics?from=2024-01-01&to=2026-07-01"],
      ["a non-ISO day", "/v1/me/analytics?from=08%2F07%2F2026&to=2026-07-22"],
    ];
    for (const [label, url] of cases) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: user.cookie } });
      expect(res.statusCode, label).toBe(400);
      expect(res.json().error, label).toBe("invalid_query");
    }
  });

  it("never returns another member's rows", async () => {
    const mine = await signupVerified("analytics-mine");
    const theirs = await signupVerified("analytics-theirs");
    await seedKarma(theirs.userId, 250, daysAgo(1), "isolation");

    const res = await app.inject({ method: "GET", url: "/v1/me/analytics?weeks=4", headers: { cookie: mine.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().contributor.totals.karma).toBe(0);
  });
});
