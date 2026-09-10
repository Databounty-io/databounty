// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage: `/login/admin` was missing the same lockout state
 * machine `/login` (member) already had, despite admin accounts being the
 * higher-value target. Credential-stuffing spread across a rotating IP pool
 * faced zero per-account throttling here, while the same attack against
 * `/login` was halted after 5 failures regardless of source IP.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { __resetLoginFailureState } from "./lib/auth-failure-metrics.js";
import { requireDisposableDatabase } from "./test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterEach(() => {
  __resetLoginFailureState();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function signupAdmin(prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const signupRes = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Correct@12345", displayName: prefix },
  });
  expect(signupRes.statusCode).toBe(201);
  const userId = signupRes.json().user.id as string;
  await prisma.userRole.create({ data: { userId, role: "admin" } });
  return { email, userId };
}

// Each test uses its own fake source IP so the shared 10-req/min-per-IP
// AUTH_RATE_LIMIT (which every request in a Fastify `inject()` test would
// otherwise share as one IP) can't bleed failures from one test's request
// count into the next test's lockout assertions.
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.77.0.${ipCounter}`;
}

const loginAdmin = (email: string, password: string, ip: string) =>
  app.inject({ method: "POST", url: "/v1/auth/login/admin", payload: { email, password }, remoteAddress: ip });

describe("POST /v1/auth/login/admin has the same lockout member login has", () => {
  it("locks after repeated failures against ONE admin account, independent of source IP", async () => {
    const { email } = await signupAdmin("admin-lockout");

    // A DIFFERENT ip per failing request proves the lockout is truly keyed by
    // account, not by IP (which the pre-existing AUTH_RATE_LIMIT already
    // covers) — this is the exact gap the fix closes.
    for (let i = 0; i < 5; i++) {
      const res = await loginAdmin(email, "WrongPassword!", nextIp());
      expect(res.statusCode).toBe(401);
    }

    // The 6th attempt, even with the CORRECT password from yet another IP, is
    // now locked out.
    const lockedOut = await loginAdmin(email, "Correct@12345", nextIp());
    expect(lockedOut.statusCode).toBe(401);
    expect(lockedOut.json().message).toMatch(/too many failed attempts/i);
  });

  it("clears the lockout counter on a successful login", async () => {
    const { email } = await signupAdmin("admin-lockout-clear");
    const ip = nextIp();

    for (let i = 0; i < 4; i++) {
      expect((await loginAdmin(email, "WrongPassword!", ip)).statusCode).toBe(401);
    }
    // 4 failures is under the 5-failure threshold — this should still succeed
    // and reset the counter.
    expect((await loginAdmin(email, "Correct@12345", ip)).statusCode).toBe(200);

    // Immediately follow with 4 more failures — if the counter carried over
    // from before, this would already be locked; it must not be.
    for (let i = 0; i < 4; i++) {
      expect((await loginAdmin(email, "WrongPassword!", ip)).statusCode).toBe(401);
    }
    expect((await loginAdmin(email, "Correct@12345", ip)).statusCode).toBe(200);
  });

  it("does not lock a DIFFERENT admin account out because of another one's failures", async () => {
    const victim = await signupAdmin("admin-lockout-victim");
    const other = await signupAdmin("admin-lockout-other");

    for (let i = 0; i < 6; i++) {
      await loginAdmin(other.email, "WrongPassword!", nextIp());
    }
    // The victim account, never touched, must still be able to log in.
    expect((await loginAdmin(victim.email, "Correct@12345", nextIp())).statusCode).toBe(200);
  });

  it("keeps an admin lockout separate from a member lockout on the SAME email", async () => {
    const email = `admin-member-split-${Date.now()}@example.com`;
    const signupRes = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email, password: "Correct@12345", displayName: "split" },
    });
    const userId = signupRes.json().user.id as string;
    await prisma.userRole.create({ data: { userId, role: "admin" } });

    const loginMember = (password: string, ip: string) =>
      app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password }, remoteAddress: ip });

    for (let i = 0; i < 6; i++) {
      await loginMember("WrongPassword!", nextIp());
    }
    // The member endpoint is now locked for this email...
    expect((await loginMember("Correct@12345", nextIp())).statusCode).toBe(401);
    // ...but the admin endpoint, keyed separately, is not.
    expect((await loginAdmin(email, "Correct@12345", nextIp())).statusCode).toBe(200);
  });
});
