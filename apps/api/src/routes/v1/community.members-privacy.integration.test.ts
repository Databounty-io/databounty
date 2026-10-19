// SPDX-License-Identifier: Apache-2.0

/**
 * The anonymous member profile, `GET /v1/community/members/:handle`, must
 * disclose no more than the anonymous public profile
 * (`GET /v1/profiles/handle/:handle`) does.
 *
 * The finding: its guard was `!profilePublic && !handle`, so any member who
 * had claimed a handle was served even with their profile private, and the
 * `publicProfilePrefs` it selected were never read, so a member who hid their
 * karma, activity or badges had all of them returned anyway. These tests drive
 * the real route over HTTP against the real database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
let badgeId: string;
const createdUserIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const badge = await prisma.badge.create({
    data: {
      key: `members_privacy_${Date.now().toString(36)}`,
      family: "build",
      label: "Members privacy test badge",
      criteria: "Granted by community.members-privacy.integration.test.ts",
      icon: "code",
      metric: "manual",
      autoGranted: false,
    },
  });
  badgeId = badge.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.badge.deleteMany({ where: { id: badgeId } });
  await app.close();
  await prisma.$disconnect();
});

async function makeMember(opts: { prefix: string; profilePublic: boolean; prefs?: Record<string, boolean> }) {
  const unique = `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
  const user = await prisma.user.create({
    data: {
      email: `${opts.prefix}-${unique}@example.com`,
      passwordHash: null,
      authMethod: "email",
      handle: `${opts.prefix}${unique}`.slice(0, 20),
      displayName: `Member ${opts.prefix}`,
      profilePublic: opts.profilePublic,
      status: "active",
      karmaTotal: 7_500,
      ...(opts.prefs ? { publicProfilePrefs: opts.prefs } : {}),
    },
  });
  createdUserIds.push(user.id);
  await prisma.userBadge.create({ data: { userId: user.id, badgeId } });
  return user;
}

const getMember = (handle: string) => app.inject({ method: "GET", url: `/v1/community/members/${handle}` });

describe("GET /v1/community/members/:handle discloses only what the member made public", () => {
  it("404s a member who claimed a handle but kept their profile private", async () => {
    const member = await makeMember({ prefix: "mpprivate", profilePublic: false });
    const res = await getMember(member.handle!);
    expect(res.statusCode).toBe(404);
    // Nothing about the member may leak through the error body either.
    expect(res.body).not.toContain(String(member.karmaTotal));
  });

  it("serves a public member with every section when nothing is hidden", async () => {
    const member = await makeMember({ prefix: "mppublic", profilePublic: true });
    const res = await getMember(member.handle!);
    expect(res.statusCode).toBe(200);
    const body = res.json().member;
    expect(body.handle).toBe(member.handle);
    expect(body.karmaTotal).toBe(7_500);
    expect(body.tier).toBeDefined();
    expect(body).toHaveProperty("leaderboardRank");
    expect(body.acceptedItemsCount).toBe(0);
    expect(body.badges).toHaveLength(1);
  });

  it("leaves out karma, tier and rank together when the member hid karma & tier", async () => {
    const member = await makeMember({ prefix: "mpnokarma", profilePublic: true, prefs: { showKarma: false } });
    const body = (await getMember(member.handle!)).json().member;
    expect(body).not.toHaveProperty("karmaTotal");
    expect(body).not.toHaveProperty("tier");
    expect(body).not.toHaveProperty("leaderboardRank");
    // Sections the member did not hide are unaffected.
    expect(body.acceptedItemsCount).toBe(0);
    expect(body.badges).toHaveLength(1);
  });

  it("leaves out activity and badges when the member hid them", async () => {
    const member = await makeMember({
      prefix: "mpnobadges",
      profilePublic: true,
      prefs: { showActivity: false, showBadges: false },
    });
    const body = (await getMember(member.handle!)).json().member;
    expect(body).not.toHaveProperty("acceptedItemsCount");
    expect(body).not.toHaveProperty("badges");
    expect(body.karmaTotal).toBe(7_500);
  });

  it("404s a handle nobody holds", async () => {
    const res = await getMember("nobody-holds-this");
    expect(res.statusCode).toBe(404);
  });
});
