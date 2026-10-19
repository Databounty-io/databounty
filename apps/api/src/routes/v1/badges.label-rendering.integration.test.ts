// SPDX-License-Identifier: Apache-2.0

/**
 * Every badge label a member or a visitor reads must have its `{value}` filled
 * in. The catalog stores templates ("{value} items accepted"), and three routes
 * sent them through raw, so the member dashboard, the karma page's list of all
 * possible badges, and public profiles on databounty.io all showed the literal
 * token. These tests drive the real routes over HTTP against the real database
 * and the seeded badge catalog.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
let userId: string;
let handle: string;
let cookie: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const unique = `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
  handle = `lbl${unique}`.slice(0, 20);
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email: `labels-${unique}@example.com`, password: "Test@12345", displayName: "Label Check" },
  });
  expect(res.statusCode).toBe(201);
  userId = res.json().user.id as string;
  // Signup takes no handle (one is claimed at onboarding), and the public
  // profile needs both a handle and a public profile.
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date(), handle, profilePublic: true } });
  const setCookie = res.headers["set-cookie"];
  cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;

  // Two seeded "{value}" badges: one awarded with the amount measured at the
  // time, one recorded without an amount, as a manual grant or an award older
  // than the measured_value column would be.
  const items50 = await prisma.badge.findUniqueOrThrow({ where: { key: "items_50" } });
  const items100 = await prisma.badge.findUniqueOrThrow({ where: { key: "items_100" } });
  await prisma.userBadge.createMany({
    data: [
      { userId, badgeId: items50.id, measuredValue: 57 },
      { userId, badgeId: items100.id },
    ],
  });
});

afterAll(async () => {
  await prisma.userBadge.deleteMany({ where: { userId } });
  await prisma.notification.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await app.close();
  await prisma.$disconnect();
});

const stillTemplated = (labels: string[]) => labels.filter((label) => label.includes("{value}"));

describe("badge labels reach readers rendered, never as the {value} template", () => {
  it("in the member's own badges (GET /v1/me/profile-sources)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me/profile-sources", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const labels = (res.json().badges as { label: string }[]).map((b) => b.label);
    expect(labels).toEqual(expect.arrayContaining(["57 items accepted", "100 items accepted"]));
    expect(stillTemplated(labels)).toEqual([]);
  });

  it("in the karma page's list of all possible badges (GET /v1/community/karma)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/community/karma", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const catalog = res.json().badgeCatalog as { key: string; label: string }[];
    expect(catalog.find((b) => b.key === "items_50")?.label).toBe("50 items accepted");
    expect(stillTemplated(catalog.map((b) => b.label))).toEqual([]);
  });

  it("on the anonymous public profile (GET /v1/profiles/handle/:handle)", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/profiles/handle/${handle}` });
    expect(res.statusCode).toBe(200);
    const labels = (res.json().badges as { label: string }[]).map((b) => b.label);
    expect(labels).toEqual(expect.arrayContaining(["57 items accepted", "100 items accepted"]));
    expect(stillTemplated(labels)).toEqual([]);
  });
});
