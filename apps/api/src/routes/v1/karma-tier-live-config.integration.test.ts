// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the karma-tier display bug: `resolveKarmaTier()`
 * (services/karma.ts) is the live-configured, admin-setting-aware tier
 * lookup — its own doc comment says to use it "anywhere the answer is shown
 * to a member or gates a capability" — but it was called nowhere. Every real
 * display path (`getKarmaBreakdown`, which GET /v1/community/karma,
 * GET /v1/me/karma, and the MCP `get_karma_details` tool all share) still
 * read the static `KARMA_TIERS` constant / synchronous `karmaTierForBalance`,
 * so an admin editing `karma.tiers` never changed what any member actually
 * saw.
 *
 * This test proves the fix propagates: it edits `karma.tiers` through the
 * real admin settings endpoint (the same one the admin console's karma page
 * calls) and checks that all three member-facing surfaces immediately report
 * the new tier for the same balance — no redeploy, no cache to bust.
 *
 * Same harness/self-guard pattern as the other route-level integration tests
 * in this directory: Fastify inject() against buildApp(), no port bound,
 * refuses to run outside the disposable verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { tools } from "../../mcp/tools.js";
import { KARMA_TIERS } from "../../services/karma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];

const getKarmaDetailsTool = tools.find((t) => t.name === "get_karma_details")!;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await prisma.adminSettingHistory.deleteMany({ where: { key: "karma.tiers", changedBy: { in: createdUserIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  // Restore the code-default tiers so this test never leaves a stray
  // karma.tiers override behind for other tests/runs in the same database.
  await prisma.adminSetting.deleteMany({ where: { key: "karma.tiers" } });
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

async function signupAdmin(emailPrefix: string) {
  const created = await signupVerified(emailPrefix);
  await prisma.userRole.create({ data: { userId: created.userId, role: "admin" } });
  return created;
}

describe("admin-configured karma.tiers reaches member-facing surfaces", () => {
  it("propagates a tier edit to GET /v1/community/karma, GET /v1/me/karma, and MCP get_karma_details", async () => {
    const { userId, cookie } = await signupVerified("karmatier-member");
    const { cookie: adminCookie } = await signupAdmin("karmatier-admin");

    // Balance sits in the code default's "bodhi" band (5,000–49,999).
    const balance = 5_000;
    await prisma.user.update({ where: { id: userId }, data: { karmaTotal: balance } });

    // --- Baseline: code-default tiers, before any admin edit -------------
    const baselineCommunity = await app.inject({
      method: "GET",
      url: "/v1/community/karma",
      headers: { cookie },
    });
    expect(baselineCommunity.statusCode).toBe(200);
    expect(baselineCommunity.json().tier.name).toBe("bodhi");
    expect(baselineCommunity.json().tier.label).toBe("Bodhi");

    const baselineMe = await app.inject({ method: "GET", url: "/v1/me/karma", headers: { cookie } });
    expect(baselineMe.statusCode).toBe(200);
    expect(baselineMe.json().tier.current.tier).toBe("bodhi");

    const baselineMcp = (await getKarmaDetailsTool.call({}, { userId })) as {
      tier: { current: { tier: string; label: string } };
    };
    expect(baselineMcp.tier.current.tier).toBe("bodhi");

    // --- Admin edits karma.tiers through the real settings endpoint ------
    // Raise "bodhi"'s floor above the member's balance and relabel "dharma"
    // distinctively, so the same balance now resolves to a visibly different
    // tier/label if (and only if) the edit actually propagates.
    const editedTiers = KARMA_TIERS.map((t) => ({
      tier: t.tier,
      label: t.tier === "dharma" ? "Dharma (live-config test)" : t.label,
      minKarma: t.tier === "bodhi" ? balance + 5_000 : t.minKarma,
      color: t.color,
      blurb: t.blurb,
      perks: t.perks,
      earlyAccessHours: t.earlyAccessHours,
      concurrencyBonus: t.concurrencyBonus,
    }));

    const putRes = await app.inject({
      method: "PUT",
      url: "/v1/admin/settings/karma.tiers",
      headers: { cookie: adminCookie, origin: "http://localhost:3010" },
      payload: { value: editedTiers },
    });
    expect(putRes.statusCode).toBe(200);

    // --- Same balance, same three surfaces, no redeploy -------------------
    const afterCommunity = await app.inject({
      method: "GET",
      url: "/v1/community/karma",
      headers: { cookie },
    });
    expect(afterCommunity.statusCode).toBe(200);
    expect(afterCommunity.json().tier.name).toBe("dharma");
    expect(afterCommunity.json().tier.label).toBe("Dharma (live-config test)");
    // The tier ladder returned alongside the breakdown must also reflect the
    // live table, not the static KARMA_TIERS constant.
    const ladderDharma = (afterCommunity.json().tiers as { name: string; label: string; state: string }[]).find(
      (t) => t.name === "dharma"
    );
    expect(ladderDharma?.label).toBe("Dharma (live-config test)");
    expect(ladderDharma?.state).toBe("current");

    const afterMe = await app.inject({ method: "GET", url: "/v1/me/karma", headers: { cookie } });
    expect(afterMe.statusCode).toBe(200);
    expect(afterMe.json().tier.current.tier).toBe("dharma");
    expect(afterMe.json().tier.current.label).toBe("Dharma (live-config test)");

    const afterMcp = (await getKarmaDetailsTool.call({}, { userId })) as {
      tier: { current: { tier: string; label: string } };
    };
    expect(afterMcp.tier.current.tier).toBe("dharma");
    expect(afterMcp.tier.current.label).toBe("Dharma (live-config test)");

    // --- Public member profile also reads the live table -----------------
    const { handle: memberHandle } = (await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { handle: true },
    })) as { handle: string | null };
    if (memberHandle) {
      const profileRes = await app.inject({ method: "GET", url: `/v1/community/members/${memberHandle}` });
      expect(profileRes.statusCode).toBe(200);
      expect(profileRes.json().member.tier.tier).toBe("dharma");
      expect(profileRes.json().member.tier.label).toBe("Dharma (live-config test)");
    }
  });
});
