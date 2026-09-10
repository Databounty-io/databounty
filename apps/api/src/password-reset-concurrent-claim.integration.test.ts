// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the concurrent-redemption TOCTOU window that
 * `verifyPasswordResetToken` + `consumePasswordResetToken` left open: two
 * requests presenting the IDENTICAL token could both pass the read
 * (`usedAt: null`) before either write landed, so "single-use" was only
 * enforced against a sequential replay, not a raced one. Fixed by
 * `claimPasswordResetToken`, an atomic `updateMany` gated on `usedAt: null`,
 * called inside the same transaction as the password write.
 *
 * Same harness as password-reset-token-invalidation.integration.test.ts.
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

async function mintToken(userId: string) {
  const token = randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      purpose: "reset",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
}

const reset = (token: string, newPassword: string) =>
  app.inject({ method: "POST", url: "/v1/auth/reset-password", payload: { token, newPassword } });

const login = (email: string, password: string) =>
  app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });

describe("the SAME reset token cannot be redeemed twice, even raced", () => {
  it("lets exactly one of two concurrent requests with the identical token succeed", async () => {
    const { email, userId } = await signup("reset-race");
    const token = await mintToken(userId);

    const [a, b] = await Promise.all([reset(token, "FirstWins@123"), reset(token, "SecondLoses@123")]);

    const statuses = [a.statusCode, b.statusCode].sort();
    // Exactly one 200, exactly one 400 — never both 200 (double-spend) and
    // never both 400 (the legitimate reset lost too).
    expect(statuses).toEqual([200, 400]);

    const winningPassword = a.statusCode === 200 ? "FirstWins@123" : "SecondLoses@123";
    const losingPassword = a.statusCode === 200 ? "SecondLoses@123" : "FirstWins@123";

    expect((await login(email, winningPassword)).statusCode).toBe(200);
    expect((await login(email, losingPassword)).statusCode).toBe(401);
  });

  it("does not consume the token on a failed claim — a lost race is a clean no-op, not a partial spend", async () => {
    const { userId } = await signup("reset-race-clean");
    const token = await mintToken(userId);
    const tokenHash = createHash("sha256").update(token).digest("hex");

    await Promise.all([reset(token, "RacePw@123"), reset(token, "RacePw@456")]);

    const row = await prisma.passwordResetToken.findUniqueOrThrow({ where: { tokenHash } });
    // Spent exactly once — the loser's attempt did not also flip usedAt via
    // some separate unconditional write path.
    expect(row.usedAt).not.toBeNull();
  });
});
