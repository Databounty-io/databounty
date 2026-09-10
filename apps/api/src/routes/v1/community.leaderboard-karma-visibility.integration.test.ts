// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-10 follow-up. The single-profile fix (`profiles.ts`, covered by
 * `profiles.tier-disclosure.test.ts`) omits `tier`/`karma` from
 * `GET /v1/handle/:handle` when the member has turned off "karma & tier"
 * (`publicProfilePrefs.showKarma === false`). The open, anonymous
 * `GET /v1/community/leaderboard` is a separate, bulk endpoint that reads the
 * same underlying preference but — before this fix — ignored it entirely:
 * `getLeaderboard()`'s `where` only checked `profilePublic`, so a member who
 * explicitly hid their karma still appeared on the public leaderboard with
 * their exact karma total and rank. This proves that gap is closed and that
 * an ordinary public, karma-visible member is unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
  await prisma.$disconnect();
});

async function makeLeaderboardCandidate(opts: { handlePrefix: string; karmaTotal: number; showKarma?: boolean }) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `${opts.handlePrefix}-${stamp}@example.com`,
      passwordHash: null,
      authMethod: "email",
      handle: `${opts.handlePrefix}${stamp}`.replace(/[^a-z0-9]/gi, "").slice(0, 20),
      displayName: opts.handlePrefix,
      profilePublic: true,
      status: "active",
      karmaTotal: opts.karmaTotal,
      ...(opts.showKarma === undefined ? {} : { publicProfilePrefs: { showKarma: opts.showKarma } }),
    },
  });
  createdUserIds.push(user.id);
  return user;
}

async function leaderboard(query: Record<string, string> = {}) {
  const params = new URLSearchParams(query);
  const res = await app.inject({ method: "GET", url: `/v1/community/leaderboard?${params.toString()}` });
  expect(res.statusCode).toBe(200);
  return res.json() as { leaderboard: { handle: string; karma: number }[]; nextCursor: string | null };
}

describe("SEC-10 · GET /v1/community/leaderboard honors showKarma", () => {
  it("excludes a public profile that explicitly hid karma & tier", async () => {
    const visible = await makeLeaderboardCandidate({ handlePrefix: "lbvisible", karmaTotal: 5_000 });
    const hidden = await makeLeaderboardCandidate({ handlePrefix: "lbhidden", karmaTotal: 999_999, showKarma: false });

    const body = await leaderboard({ q: "lbvisible" });
    expect(body.leaderboard.some((row) => row.handle === visible.handle)).toBe(true);

    const hiddenSearch = await leaderboard({ q: "lbhidden" });
    expect(hiddenSearch.leaderboard.some((row) => row.handle === hidden.handle)).toBe(false);
  });

  it("still lists a member with no stored preference (default showKarma: true) and one who explicitly turned it on", async () => {
    const defaulted = await makeLeaderboardCandidate({ handlePrefix: "lbdefault", karmaTotal: 4_000 });
    const explicitOn = await makeLeaderboardCandidate({ handlePrefix: "lbexpliciton", karmaTotal: 4_100, showKarma: true });

    const defaultedRes = await leaderboard({ q: "lbdefault" });
    expect(defaultedRes.leaderboard.some((row) => row.handle === defaulted.handle)).toBe(true);

    const explicitRes = await leaderboard({ q: "lbexpliciton" });
    expect(explicitRes.leaderboard.some((row) => row.handle === explicitOn.handle)).toBe(true);
  });
});
