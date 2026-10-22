// SPDX-License-Identifier: Apache-2.0

/**
 * Linking Google to an account whose email was never verified must take the
 * account away from whoever registered it, against the real database.
 *
 * Email signup signs the registrant in before the address is proven. Before
 * this fix, someone could register an address they do not own, stay signed in,
 * and keep both their password and their session after the address's real
 * owner signed in with Google and the identity was linked to that account.
 * auth.identity-binding.test.ts covers the decision logic hermetically; this
 * file proves the revocation queries themselves against PostgreSQL.
 *
 * Only the Google verifier is a double: the routes, sessions, tokens and
 * database are real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const google = vi.hoisted(() => ({ identity: null as null | { googleId: string; email: string } }));

vi.mock("../../lib/google-auth.js", () => ({
  isGoogleAuthConfigured: () => true,
  verifyGoogleIdToken: async () =>
    google.identity ? { ...google.identity, name: "Address Owner", emailVerified: true } : null,
}));

const { buildApp } = await import("../../app.js");
const { prisma } = await import("../../lib/prisma.js");
const { requireDisposableDatabase } = await import("../../test-support/require-disposable-database.js");

requireDisposableDatabase();

const unique = `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
const EMAIL = `reclaim-${unique}@example.com`;
const PASSWORD = "SquatterOnly123!";
const CLIENT_ID = `reclaim-test-client-${unique}`;

let app: FastifyInstance;
let userId: string;
let squatterCookie: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  // The squatter registers the owner's address and is signed in at once.
  const signup = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email: EMAIL, password: PASSWORD, displayName: "Squatter" },
  });
  expect(signup.statusCode).toBe(201);
  userId = signup.json().user.id as string;
  const setCookie = signup.headers["set-cookie"];
  squatterCookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;

  // ...and authorizes an MCP client, which needs no verified email.
  await prisma.oAuthClient.create({ data: { clientId: CLIENT_ID, redirectUris: ["https://example.com/cb"] } });
  await prisma.oAuthAccessToken.create({
    data: {
      tokenHash: `reclaim-access-${unique}`,
      clientId: CLIENT_ID,
      userId,
      scope: ["read"],
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.oAuthClient.deleteMany({ where: { clientId: CLIENT_ID } });
  await app.close();
  await prisma.$disconnect();
});

describe("Google sign-in by the address's owner reclaims a squatted account", () => {
  it("links the owner and revokes everything the squatter held", async () => {
    // Precondition: the squatter really is signed in and unverified.
    const before = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: squatterCookie } });
    expect(before.statusCode).toBe(200);
    expect(await prisma.emailVerificationToken.count({ where: { userId, usedAt: null } })).toBeGreaterThan(0);

    google.identity = { googleId: `reclaim-subject-${unique}`, email: EMAIL };
    const login = await app.inject({ method: "POST", url: "/v1/auth/google", payload: { idToken: "dummy" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.id).toBe(userId);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.googleId).toBe(`reclaim-subject-${unique}`);
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.passwordHash).toBeNull();

    // The squatter's session no longer authenticates...
    const after = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: squatterCookie } });
    expect(after.statusCode).toBe(401);
    // ...their password no longer signs in...
    const passwordLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(passwordLogin.statusCode).toBe(401);
    // ...their MCP grant is revoked, and no pending verification link survives.
    const access = await prisma.oAuthAccessToken.findUniqueOrThrow({ where: { tokenHash: `reclaim-access-${unique}` } });
    expect(access.revokedAt).not.toBeNull();
    expect(await prisma.emailVerificationToken.count({ where: { userId, usedAt: null } })).toBe(0);

    // The owner's own new session works.
    const ownerSetCookie = login.headers["set-cookie"];
    const ownerCookie = (Array.isArray(ownerSetCookie) ? ownerSetCookie[0]! : String(ownerSetCookie)).split(";")[0]!;
    const owner = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: ownerCookie } });
    expect(owner.statusCode).toBe(200);

    const audit = await prisma.adminAuditLog.findFirst({ where: { targetId: userId, action: "user.google_id_linked" } });
    expect(audit?.metadata).toEqual({ reclaimedUnverifiedAccount: true });
  });
});
