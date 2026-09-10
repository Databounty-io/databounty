// SPDX-License-Identifier: Apache-2.0

/**
 * Product decision confirmed 2026-09-01: a member's very first handle claim
 * (onboarding) should default `profilePublic` to true, since a freshly
 * onboarded member with a claimed handle but `profilePublic: false` (the
 * schema default) is invisible everywhere — the public profile page, the
 * leaderboard — until they separately discover and flip a settings toggle
 * they never knew existed.
 *
 * The one hard constraint: this default-on must apply ONLY to the very
 * first claim. If a member later explicitly opts back out
 * (`profilePublic: false`), a subsequent handle RENAME must never silently
 * re-enable it — otherwise "turn my profile private" would be a setting
 * that randomly un-does itself the next time the member changes their
 * handle for an unrelated reason.
 *
 * Covers both real entry points that can claim a handle: the web route
 * (`POST /v1/me/handle/claim`) and the MCP `claim_handle` tool, since an
 * agent operating on a member's behalf over MCP is a first-class onboarding
 * path in this product, not a secondary one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { tools } from "../../mcp/tools.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
// Hyphen, NOT underscore. `normalizePublicHandle` (services/public-handles.ts)
// allows lowercase letters, numbers and single hyphens only, so the previous
// `hclaim_...` token made every handle in this file invalid and each claim came
// back 400 "Use lowercase letters, numbers, and single hyphens only." The suite
// could never have passed — which means the behaviour it exists to guard
// (first claim flips profilePublic true; a later rename never re-enables an
// explicit opt-out) was UNTESTED rather than merely failing.
// Length stays inside HANDLE_MAX_LENGTH (20): 7 + ~8 base36 + a 3-4 char suffix.
const RUN = `hclaim-${Date.now().toString(36)}`;
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

async function signupVerified(emailPrefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${emailPrefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", displayName: emailPrefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

const claimHandleTool = tools.find((t) => t.name === "claim_handle")!;

describe("first handle claim defaults profilePublic to true, but never re-enables it on rename", () => {
  it("POST /v1/me/handle/claim: fresh signup has profilePublic=false, first claim flips it true", async () => {
    const { userId, cookie } = await signupVerified(`${RUN}-web`);

    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(before.handle).toBeNull();
    expect(before.profilePublic).toBe(false);

    const claim = await app.inject({
      method: "POST",
      url: "/v1/me/handle/claim",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { handle: `${RUN}web`.toLowerCase() },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().profilePublic).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.profilePublic).toBe(true);
  });

  it("a rename after an explicit opt-out never re-enables profilePublic", async () => {
    const { userId, cookie } = await signupVerified(`${RUN}-renameweb`);

    const firstClaim = await app.inject({
      method: "POST",
      url: "/v1/me/handle/claim",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { handle: `${RUN}rn1`.toLowerCase() },
    });
    expect(firstClaim.json().profilePublic).toBe(true);

    // Member deliberately goes private.
    const optOut = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile-sources/visibility",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { profilePublic: false },
    });
    expect(optOut.statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).profilePublic).toBe(false);

    // Unrelated handle rename must not silently undo that choice.
    const rename = await app.inject({
      method: "POST",
      url: "/v1/me/handle/claim",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { handle: `${RUN}rn2`.toLowerCase() },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().profilePublic).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).profilePublic).toBe(false);
  });

  it("MCP claim_handle: first claim flips profilePublic true, a later rename leaves an opt-out alone", async () => {
    const { userId } = await signupVerified(`${RUN}-mcp`);

    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(before.profilePublic).toBe(false);

    const firstClaim = (await claimHandleTool.call({ handle: `${RUN}mcp1`.toLowerCase() }, { userId })) as {
      ok: boolean;
      handle: string;
      profilePublic: boolean;
    };
    expect(firstClaim.profilePublic).toBe(true);

    await prisma.user.update({ where: { id: userId }, data: { profilePublic: false } });

    const rename = (await claimHandleTool.call({ handle: `${RUN}mcp2`.toLowerCase() }, { userId })) as {
      profilePublic: boolean;
    };
    expect(rename.profilePublic).toBe(false);
  });
});
