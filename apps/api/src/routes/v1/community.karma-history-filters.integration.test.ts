// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the karma-history projection of `GET /v1/community/karma`
 * (`?view=history`) and its three server-side filters — event kind, date
 * window, and free-text `q` — plus keyset paging.
 *
 * WHY THIS EXISTS. The member karma page filters and pages history entirely on
 * the server: the browser sends `eventType`, `from`/`to`, `q` and `cursor`, and
 * renders whatever comes back. Before this file nothing tested that endpoint at
 * all, so a filter could silently widen (returning rows it should not) or
 * narrow (hiding a member's own award) and every check would still pass. The
 * `q` filter matters most: it is the only one that reads `metadata`, and it is
 * the newest, so it is the one most likely to drift.
 *
 * WHAT IS ASSERTED, in the order a reader should care about:
 *   1. `q` is scoped to the caller — another member's matching event is never
 *      returned. This is the security-shaped case, so it comes first.
 *   2. `q` matches what the row actually shows: the source title (stored in
 *      `metadata.title`, case-insensitively), the event-kind label, and an
 *      exact source id.
 *   3. `eventCount` is the count of the FILTERED set, not the member's total —
 *      the page prints it as "Showing N of M", so a total here would lie.
 *   4. Filters compose, and the date window bounds inclusively by instant.
 *   5. `cursor` walks pages without overlap or omission under a live filter.
 *
 * Same harness as the other route-level integration tests here: Fastify
 * `inject()` against `buildApp()`, no port bound, refuses to run outside a
 * disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];

/** Fixed, well-separated days so a date-window assertion is unambiguous. */
const DAY_1 = new Date("2026-03-01T12:00:00.000Z");
const DAY_2 = new Date("2026-03-05T12:00:00.000Z");
const DAY_3 = new Date("2026-03-10T12:00:00.000Z");

type HistoryBody = {
  events: { id: string; eventType: string; label: string; amount: number; sourceType: string; sourceId: string; sourceLabel: string | null; createdAt: string }[];
  nextCursor: string | null;
  hasMore: boolean;
  eventCount: number;
};

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
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `${emailPrefix}-${stamp}@example.com`,
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
  return { userId, cookie };
}

/** One karma award. `title` lands in `metadata.title`, which is what the API
 *  serializes as `sourceLabel` and what `q` searches. */
async function award(
  userId: string,
  opts: { eventType: "community_item_accepted" | "community_audit_completed" | "community_request_approved"; sourceId: string; title?: string; createdAt: Date; amount?: number },
) {
  await prisma.karmaEvent.create({
    data: {
      userId,
      eventType: opts.eventType,
      amount: opts.amount ?? 25,
      sourceType: "Submission",
      sourceId: opts.sourceId,
      metadata: opts.title ? { title: opts.title } : undefined,
      createdAt: opts.createdAt,
    },
  });
}

async function history(cookie: string, query: Record<string, string>) {
  const params = new URLSearchParams({ view: "history", ...query });
  const res = await app.inject({ method: "GET", url: `/v1/community/karma?${params.toString()}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as HistoryBody;
}

describe("GET /v1/community/karma?view=history — server-side filters", () => {
  it("filters by search text, kind and date window, counts only matches, and never leaks another member's events", async () => {
    const me = await signupVerified("karmahist-me");
    const other = await signupVerified("karmahist-other");

    // Mine: three events, deliberately distinct on every axis `q` can match.
    await award(me.userId, { eventType: "community_item_accepted", sourceId: "sub-clamp-001", title: "Implement clamp(value, lo, hi)", createdAt: DAY_1 });
    await award(me.userId, { eventType: "community_audit_completed", sourceId: "sub-audit-002", title: "Audit window on parity walk", createdAt: DAY_2 });
    await award(me.userId, { eventType: "community_request_approved", sourceId: "req-003", createdAt: DAY_3 });

    // Someone else's event carrying the SAME searchable title.
    await award(other.userId, { eventType: "community_item_accepted", sourceId: "sub-clamp-999", title: "Implement clamp(value, lo, hi)", createdAt: DAY_2 });

    // 1. Scoping. The other member's identically-titled event must not appear,
    //    and must not be counted either.
    const mine = await history(me.cookie, { q: "clamp" });
    expect(mine.events).toHaveLength(1);
    expect(mine.events[0]!.sourceId).toBe("sub-clamp-001");
    expect(mine.eventCount).toBe(1);

    // 2a. Title match is case-insensitive and substring-based.
    for (const term of ["CLAMP", "clamp(value", "implement"]) {
      const hit = await history(me.cookie, { q: term });
      expect(hit.events.map((e) => e.sourceId)).toEqual(["sub-clamp-001"]);
    }

    // 2b. Event-kind label ("Completed audit") is searchable even though it is
    //     display copy for an enum, not a stored column.
    const byLabel = await history(me.cookie, { q: "completed audit" });
    expect(byLabel.events.map((e) => e.sourceId)).toEqual(["sub-audit-002"]);

    // 2c. An exact source id resolves to its own award — the "paste an id from
    //     a link" case. A partial id must NOT match, so an id fragment can
    //     never sweep in a neighbour's row.
    const byId = await history(me.cookie, { q: "req-003" });
    expect(byId.events.map((e) => e.sourceId)).toEqual(["req-003"]);
    expect((await history(me.cookie, { q: "req-00" })).events).toHaveLength(0);

    // 2d. No match is an honest empty set, not an unfiltered fallback.
    const none = await history(me.cookie, { q: "no-such-karma-anywhere" });
    expect(none.events).toHaveLength(0);
    expect(none.eventCount).toBe(0);
    expect(none.hasMore).toBe(false);

    // 3. eventCount tracks the filtered set. Unfiltered it is 3; the page
    //    renders this as "Showing N of M", so a total here would misreport.
    expect((await history(me.cookie, {})).eventCount).toBe(3);

    // 4a. Kind filter.
    const audits = await history(me.cookie, { eventType: "community_audit_completed" });
    expect(audits.events.map((e) => e.sourceId)).toEqual(["sub-audit-002"]);

    // 4b. Date window is inclusive at both ends, by instant.
    const window = await history(me.cookie, {
      from: new Date(DAY_2.getTime() - 3_600_000).toISOString(),
      to: new Date(DAY_2.getTime() + 3_600_000).toISOString(),
    });
    expect(window.events.map((e) => e.sourceId)).toEqual(["sub-audit-002"]);

    // 4c. Filters compose (AND, not OR): a kind that excludes the q match
    //     yields nothing rather than falling back to either filter alone.
    expect((await history(me.cookie, { q: "clamp", eventType: "community_audit_completed" })).events).toHaveLength(0);
    expect((await history(me.cookie, { q: "audit", eventType: "community_audit_completed" })).events.map((e) => e.sourceId)).toEqual(["sub-audit-002"]);

    // 5. An unparseable date degrades to the unfiltered view rather than 400 —
    //    a malformed ?from= in a shared link must not break the whole page.
    expect((await history(me.cookie, { from: "not-a-date" })).eventCount).toBe(3);
  });

  it("pages with a cursor under a live filter, without overlap or omission", async () => {
    const me = await signupVerified("karmahist-page");

    // Five matching events plus one that must never appear in the walk.
    for (let i = 0; i < 5; i += 1) {
      await award(me.userId, {
        eventType: "community_item_accepted",
        sourceId: `page-item-${i}`,
        title: `Paged item ${i}`,
        createdAt: new Date(DAY_1.getTime() + i * 60_000),
      });
    }
    await award(me.userId, { eventType: "community_request_approved", sourceId: "page-excluded", title: "Excluded by kind", createdAt: DAY_3 });

    const first = await history(me.cookie, { eventType: "community_item_accepted", limit: "2" });
    expect(first.events).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.eventCount).toBe(5);
    expect(first.nextCursor).toBe(first.events[1]!.id);

    const second = await history(me.cookie, { eventType: "community_item_accepted", limit: "2", cursor: first.nextCursor! });
    const third = await history(me.cookie, { eventType: "community_item_accepted", limit: "2", cursor: second.nextCursor! });

    expect(second.events).toHaveLength(2);
    expect(third.events).toHaveLength(1);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();

    // The three pages together are exactly the five matching rows, newest
    // first, each seen once — and the excluded row is in none of them.
    const walked = [...first.events, ...second.events, ...third.events].map((e) => e.sourceId);
    expect(walked).toEqual(["page-item-4", "page-item-3", "page-item-2", "page-item-1", "page-item-0"]);
    expect(new Set(walked).size).toBe(5);
    expect(walked).not.toContain("page-excluded");

    // Every page carries the filtered count, so "Showing N of M" stays honest
    // as the member pages deeper.
    expect([second.eventCount, third.eventCount]).toEqual([5, 5]);
  });

  it("rejects a cursor that no longer resolves with 400, so the client can restart from the top", async () => {
    const me = await signupVerified("karmahist-cursor");
    await award(me.userId, { eventType: "community_item_accepted", sourceId: "cursor-item", title: "Cursor item", createdAt: DAY_1 });

    const res = await app.inject({
      method: "GET",
      url: "/v1/community/karma?view=history&limit=1&cursor=karma_event_that_does_not_exist",
      headers: { cookie: me.cookie },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/out of date/i);
  });

  it("returns only the history projection for view=history — not the whole karma summary", async () => {
    const me = await signupVerified("karmahist-shape");
    await award(me.userId, { eventType: "community_item_accepted", sourceId: "shape-item", title: "Shape item", createdAt: DAY_1 });

    const body = await history(me.cookie, {});
    // The "load more" follow-up deliberately skips the tier/matrix/badge work.
    expect(Object.keys(body).sort()).toEqual(["eventCount", "events", "hasMore", "nextCursor"]);
    expect(body.events[0]).toMatchObject({
      eventType: "community_item_accepted",
      label: "Accepted item",
      sourceType: "Submission",
      sourceId: "shape-item",
      sourceLabel: "Shape item",
      amount: 25,
    });
  });
});
