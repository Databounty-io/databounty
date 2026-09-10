// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the reset-token takeover.
 *
 * `/forgot-password` mints a token per click, and nothing used to invalidate
 * the siblings once one was spent — `verifyPasswordResetToken` checks only
 * `usedAt` and `expiresAt`. That was a full account takeover, proven against a
 * running API: two `/forgot-password` calls, the victim resets with token A
 * (200), the OLDER token B then resets again (200), the attacker's password
 * signs in and the victim's freshly-chosen one is refused. Any stale reset mail
 * stayed a working takeover after the user had already reset in response to
 * suspecting compromise.
 *
 * The tokens are only ever delivered by email and stored as a sha256, so the
 * raw values cannot be read back out of the database. These tests therefore
 * mint rows exactly as `createPasswordResetToken` does — 32 random bytes, hex,
 * hashed with sha256 — which is what lets the second, older token be presented
 * to the real endpoint.
 *
 * Same harness/self-guard pattern as the other *.integration.test.ts files:
 * Fastify inject() against buildApp(), no port bound, refuses to run outside
 * a disposable database.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const VICTIM_PASSWORD = "Victim@12345";
const ATTACKER_PASSWORD = "Attacker@12345";

async function signup(prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Start@12345", displayName: prefix },
  });
  expect(res.statusCode).toBe(201);
  return { email, userId: res.json().user.id as string };
}

/** Mints a reset token the same way createPasswordResetToken does, so the raw
 *  value is known to the test. `expiresInMs` negative = already expired. */
async function mintToken(userId: string, expiresInMs = 60 * 60 * 1000) {
  const token = randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      purpose: "reset",
      expiresAt: new Date(Date.now() + expiresInMs),
    },
  });
  return token;
}

const reset = (token: string, newPassword: string) =>
  app.inject({ method: "POST", url: "/v1/auth/reset-password", payload: { token, newPassword } });

const login = (email: string, password: string) =>
  app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });

describe("password reset tokens are single-use per account, not per row", () => {
  it("refuses a sibling token issued before a completed reset, and keeps the owner's password", async () => {
    const { email, userId } = await signup("reset-sibling");
    const attackerToken = await mintToken(userId); // the older, stale mail
    const victimToken = await mintToken(userId);

    expect((await reset(victimToken, VICTIM_PASSWORD)).statusCode).toBe(200);

    // The core assertion: the older token must no longer work.
    const replay = await reset(attackerToken, ATTACKER_PASSWORD);
    expect(replay.statusCode).toBe(400);

    // ...and prove it by whose password actually survives, not by the status
    // code alone — a 400 with the password already overwritten would be no fix.
    expect((await login(email, ATTACKER_PASSWORD)).statusCode).toBe(401);
    expect((await login(email, VICTIM_PASSWORD)).statusCode).toBe(200);
  });

  it("marks every outstanding token used once one is spent", async () => {
    const { userId } = await signup("reset-burn");
    await mintToken(userId);
    await mintToken(userId);
    const spent = await mintToken(userId);

    expect((await reset(spent, VICTIM_PASSWORD)).statusCode).toBe(200);

    const stillLive = await prisma.passwordResetToken.count({
      where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
    });
    expect(stillLive).toBe(0);
  });

  it("leaves an expired token rejected and unspent, and the password untouched", async () => {
    const { email, userId } = await signup("reset-expired");
    const live = await mintToken(userId);
    expect((await reset(live, VICTIM_PASSWORD)).statusCode).toBe(200);

    const expired = await mintToken(userId, -10 * 60 * 1000);
    expect((await reset(expired, ATTACKER_PASSWORD)).statusCode).toBe(400);
    expect((await login(email, VICTIM_PASSWORD)).statusCode).toBe(200);
  });

  it("invalidates outstanding reset tokens when the password is changed from inside the account", async () => {
    const { email, userId } = await signup("reset-on-change");
    const stale = await mintToken(userId);

    const signedIn = await login(email, "Start@12345");
    expect(signedIn.statusCode).toBe(200);
    const setCookie = signedIn.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;

    const changed = await app.inject({
      method: "POST",
      url: "/v1/auth/change-password",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { currentPassword: "Start@12345", newPassword: VICTIM_PASSWORD },
    });
    expect(changed.statusCode).toBe(200);

    // A change is often the response to a suspected compromise, so the
    // attacker's pending link has to die with it.
    expect((await reset(stale, ATTACKER_PASSWORD)).statusCode).toBe(400);
    expect((await login(email, ATTACKER_PASSWORD)).statusCode).toBe(401);
    expect((await login(email, VICTIM_PASSWORD)).statusCode).toBe(200);
  });
});
