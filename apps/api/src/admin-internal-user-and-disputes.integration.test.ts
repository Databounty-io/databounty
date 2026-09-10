// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for two admin.ts/admin-internal.ts bug fixes:
 *
 *  1. GET /v1/admin/internal/user/:id — previously did not exist at all,
 *     so community/apps/admin's /users/view page 404'd looking up a real
 *     user. Covered by admin-internal.ts's new "user" kind handler.
 *  2. GET /v1/admin/disputes?status=all — previously passed the literal
 *     string "all" straight into a Prisma `where: { status: ... }` clause,
 *     throwing "Invalid value for argument status" (500). Covered by
 *     admin.ts translating status === "all" to undefined before querying.
 *
 * Same harness/self-guard pattern as the other *.integration.test.ts files
 * in this directory: Fastify inject() against buildApp(), no port bound,
 * refuses to run outside the disposable verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdDisputeIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.dispute.deleteMany({ where: { id: { in: createdDisputeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function signup(emailPrefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${emailPrefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${emailPrefix}${stamp}`.slice(0, 30), displayName: emailPrefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

async function signupAdmin(emailPrefix: string) {
  const account = await signup(emailPrefix);
  await prisma.user.update({ where: { id: account.userId }, data: { emailVerifiedAt: new Date() } });
  await prisma.userRole.create({ data: { userId: account.userId, role: "admin" } });
  return account;
}

describe("GET /v1/admin/internal/user/:id", () => {
  it("returns 200 with the account's profile for a real user id (was a 404 — route didn't exist)", async () => {
    const admin = await signupAdmin("internaluseradmin");
    const target = await signup("internaluserplain");

    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/internal/user/${target.userId}`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.id).toBe(target.userId);
    expect(body.profile.email).toBe(target.email);
    expect(body.metrics).toBeTruthy();
    expect(Array.isArray(body.submissions)).toBe(true);
    expect(Array.isArray(body.flags)).toBe(true);
    expect(Array.isArray(body.karmaEvents)).toBe(true);
    // Honest empty — no per-validator claimed-audit record exists in this
    // schema (see file header comment in admin-internal.ts).
    expect(body.audits).toEqual([]);
  });

  it("returns 404 for a nonexistent user id", async () => {
    const admin = await signupAdmin("internaluseradmin404");

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/internal/user/does-not-exist",
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects a non-admin caller", async () => {
    const plain = await signup("internaluserplaincaller");

    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/internal/user/${plain.userId}`,
      headers: { cookie: plain.cookie },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("GET /v1/admin/disputes?status=all", () => {
  it("returns 200 with both open and resolved disputes instead of 500ing on the literal 'all'", async () => {
    const admin = await signupAdmin("disputesalladmin");
    const raiser = await signup("disputesallraiser");

    const openDispute = await prisma.dispute.create({
      data: {
        raisedByUserId: raiser.userId,
        bountyTitle: "Parity test bounty",
        submissionTitle: "Parity test submission",
        flagReason: "off_spec",
        contributorArgument: "This was actually on spec.",
        validatorArgument: "This was off spec.",
        status: "open",
      },
    });
    const resolvedDispute = await prisma.dispute.create({
      data: {
        raisedByUserId: raiser.userId,
        bountyTitle: "Parity test bounty",
        submissionTitle: "Parity test submission 2",
        flagReason: "low_quality",
        contributorArgument: "This was high quality.",
        validatorArgument: "This was low quality.",
        status: "resolved",
        resolution: "Upheld.",
        resolvedAt: new Date(),
      },
    });
    createdDisputeIds.push(openDispute.id, resolvedDispute.id);

    const allRes = await app.inject({
      method: "GET",
      url: "/v1/admin/disputes?status=all",
      headers: { cookie: admin.cookie },
    });
    expect(allRes.statusCode).toBe(200);
    const allIds = allRes.json().disputes.map((d: { id: string }) => d.id);
    expect(allIds).toContain(openDispute.id);
    expect(allIds).toContain(resolvedDispute.id);

    // Sanity check that a real status filter still narrows correctly, so the
    // fix didn't just make every value fall through to unfiltered.
    const openRes = await app.inject({
      method: "GET",
      url: "/v1/admin/disputes?status=open",
      headers: { cookie: admin.cookie },
    });
    expect(openRes.statusCode).toBe(200);
    const openIds = openRes.json().disputes.map((d: { id: string }) => d.id);
    expect(openIds).toContain(openDispute.id);
    expect(openIds).not.toContain(resolvedDispute.id);
  });
});
