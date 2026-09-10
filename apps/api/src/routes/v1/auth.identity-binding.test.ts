// SPDX-License-Identifier: Apache-2.0

/**
 * SEC-05 / SEC-06 / SEC-07 route-level regressions for `routes/v1/auth.ts`.
 *
 * HERMETIC BY DESIGN. The 2026-09-05 review reproduced these three defects
 * against a disposable PostgreSQL that has since been dropped, so this file
 * reproduces them with the same request shape (real Fastify routing, real
 * hooks, real `@fastify/cookie` + `@fastify/sensible`, the same URL-encoded
 * body parser `app.ts` installs) but with `prisma`, `session` and the Google
 * verifier as explicit doubles. No database, no network, no real Google.
 *
 * What that buys and what it costs: the routing, the preHandler order, the
 * resolution logic and the actual response codes are the product's own; the
 * unique-index enforcement is emulated in the fake store, so a genuine
 * database constraint race is asserted through the code path that handles it
 * (`updateMany` count 0 / `P2002`) rather than by a real concurrent write.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import cookie from "@fastify/cookie";

// ---------------------------------------------------------------------------
// Test doubles. Hoisted so the vi.mock factories below can close over them.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => {
  interface Row {
    [key: string]: unknown;
  }

  const state = {
    users: [] as Row[],
    userRoles: [] as { userId: string; role: string }[],
    tokens: [] as { token: string; userId: string; purpose: string; usedAt: Date | null; expiresAt: Date }[],
    audit: [] as Row[],
    sessions: new Map<string, string>(),
    /** One-shot hook used to simulate a concurrent linking write. */
    beforeUserUpdateMany: null as null | (() => void),
    config: {
      isProd: false,
      corsOrigins: ["http://localhost:3000", "http://localhost:3002"],
      appUrl: "http://localhost:3010",
      adminUrl: "http://localhost:3002",
      landingUrl: "http://localhost:3001",
      googleClientId: "dummy-databounty-oauth-client",
    },
    googleConfigured: true,
    googleIdentity: null as null | Record<string, unknown>,
    verifyCalls: 0,
  };

  /** Equality-only `where` matching — enough for every lookup in auth.ts. */
  function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      const actual = row[key] ?? null;
      return actual === (value ?? null);
    });
  }

  function assertUnique(row: Row, candidate: Row) {
    for (const field of ["email", "googleId"] as const) {
      const value = candidate[field];
      if (value === undefined || value === null) continue;
      if (state.users.some((other) => other !== row && other[field] === value)) {
        const err = new Error(`Unique constraint failed on ${field}`) as Error & { code: string };
        err.code = "P2002";
        throw err;
      }
    }
  }

  const userDelegate = {
    findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number } = {}) => {
      const hits = state.users.filter((u) => matches(u, where));
      return take ? hits.slice(0, take) : hits;
    },
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      state.users.find((u) => matches(u, where)) ?? null,
    findUnique: async ({ where }: { where: Record<string, unknown> }) =>
      state.users.find((u) => matches(u, where)) ?? null,
    findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
      const row = state.users.find((u) => matches(u, where));
      if (!row) throw new Error("Row not found");
      return row;
    },
    create: async ({ data }: { data: Row }) => {
      const row: Row = {
        id: `user_${state.users.length + 1}`,
        email: null,
        googleId: null,
        passwordHash: null,
        displayName: "Dummy",
        handle: null,
        onboarded: false,
        emailVerifiedAt: null,
        authMethod: "email",
        persona: null,
        karmaTotal: 0,
        leaderboardRank: null,
        revocationVersion: 0,
        status: "active",
        ...data,
      };
      assertUnique(row, row);
      state.users.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const row = state.users.find((u) => matches(u, where));
      if (!row) throw new Error("Row not found");
      assertUnique(row, data);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where?: Record<string, unknown>; data: Row }) => {
      state.beforeUserUpdateMany?.();
      state.beforeUserUpdateMany = null;
      const hits = state.users.filter((u) => matches(u, where));
      for (const row of hits) {
        assertUnique(row, data);
        Object.assign(row, data);
      }
      return { count: hits.length };
    },
  };

  const prismaMock: Record<string, unknown> = {
    user: userDelegate,
    userRole: {
      findMany: async ({ where }: { where?: { userId?: string } } = {}) =>
        state.userRoles.filter((r) => !where?.userId || r.userId === where.userId),
    },
    session: { deleteMany: async () => ({ count: 0 }) },
    auditLog: { create: async ({ data }: { data: Row }) => data },
  };
  prismaMock.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock);

  return { state, prismaMock };
});

const { state, prismaMock } = H;

vi.mock("../../config.js", () => ({ config: state.config }));
vi.mock("../../lib/prisma.js", () => ({ prisma: prismaMock }));

vi.mock("../../lib/google-auth.js", () => ({
  isGoogleAuthConfigured: () => state.googleConfigured,
  verifyGoogleIdToken: async () => {
    state.verifyCalls += 1;
    const d = state.googleIdentity;
    if (!d) return null;
    return {
      googleId: String(d.sub),
      email: String(d.email).toLowerCase(),
      name: "Dummy Reviewer",
      emailVerified: d.email_verified !== false,
    };
  },
}));

vi.mock("../../lib/session.js", () => ({
  createSession: async (userId: string) => {
    const token = `session_${userId}_${state.sessions.size + 1}`;
    state.sessions.set(token, userId);
    return token;
  },
  getUserFromSessionToken: async (token: string) => {
    const userId = state.sessions.get(token);
    if (!userId) return null;
    const user = state.users.find((u) => u.id === userId);
    if (!user || user.status !== "active") return null;
    return { ...user, roles: state.userRoles.filter((r) => r.userId === userId) };
  },
  revokeSession: async () => {},
  revokeAllSessions: async () => {},
}));

vi.mock("../../services/api-keys.js", () => ({
  KEY_PREFIX: "dbk_",
  verifyApiKey: async () => null,
}));

vi.mock("../../lib/password.js", () => ({
  hashPassword: async (plain: string) => `hashed:${plain}`,
  verifyPassword: async (plain: string, hash: string) => hash === `hashed:${plain}`,
  verifyPasswordDummy: async () => false,
}));

vi.mock("../../lib/password-reset.js", () => ({
  createPasswordResetToken: async (userId: string, purpose = "reset") => {
    const token = `pwtoken_${purpose}_${userId}_${state.tokens.length + 1}`;
    state.tokens.push({
      token,
      userId,
      purpose,
      usedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return token;
  },
  verifyPasswordResetToken: async (token: string) => {
    const row = state.tokens.find((t) => t.token === token);
    if (!row || row.usedAt || row.expiresAt < new Date()) return null;
    return { userId: row.userId, purpose: row.purpose };
  },
  consumePasswordResetToken: async (token: string) => {
    const row = state.tokens.find((t) => t.token === token);
    if (row) row.usedAt = new Date();
  },
  invalidatePasswordResetTokens: async (userId: string) => {
    let count = 0;
    for (const row of state.tokens) {
      if (row.userId === userId && !row.usedAt) {
        row.usedAt = new Date();
        count += 1;
      }
    }
    return count;
  },
}));

vi.mock("../../lib/email-verification.js", () => ({
  createEmailVerificationToken: async () => "dummy-verification-token",
  consumeEmailVerificationToken: async () => null,
}));

vi.mock("../../lib/admin-invite.js", () => ({
  verifyAdminInviteToken: async () => null,
  consumeAdminInvite: async () => {},
}));

vi.mock("../../lib/audit-log.js", () => ({
  writeAuditLog: async (_tx: unknown, entry: Record<string, unknown>) => {
    state.audit.push(entry);
  },
}));

vi.mock("../../lib/workspace.js", () => ({ ensurePersonalWorkspace: async () => {} }));

vi.mock("../../lib/auth-notify.js", () => ({
  sendWelcomeEmail: async () => {},
  sendWelcomeVerificationEmail: async () => {},
  sendVerificationEmail: async () => {},
  sendPasswordTokenEmail: async () => {},
}));

vi.mock("../../lib/auth-failure-metrics.js", () => ({
  checkLoginLock: async () => ({ locked: false }),
  clearLoginFailures: async () => {},
  loginAccountKey: (email: string) => email,
  recordLoginFailure: async () => {},
}));

vi.mock("../../services/notifications.js", () => ({
  ensureDefaultWatchPref: async () => {},
  seedEmailNotificationChannel: async () => {},
}));

const { authRoutes } = await import("./auth.js");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TRUSTED_ORIGIN = "http://localhost:3000";
const HOSTILE_ORIGIN = "http://untrusted.localhost:9999";
const FORM = "application/x-www-form-urlencoded";

let app: FastifyInstance;

async function buildTestApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(sensible);
  await instance.register(cookie);
  // Mirrors app.ts: the global URL-encoded parser is precisely what made the
  // SEC-07 simple-form POST reach the handler at all.
  instance.addContentTypeParser(FORM, { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  await instance.register(authRoutes, { prefix: "/v1/auth" });
  await instance.ready();
  return instance;
}

function makeUser(overrides: Record<string, unknown> = {}) {
  const index = state.users.length + 1;
  const row: Record<string, unknown> = {
    id: `user_${index}`,
    email: `dummy${index}@example.invalid`,
    googleId: null,
    passwordHash: null,
    displayName: `Dummy ${index}`,
    handle: null,
    onboarded: false,
    emailVerifiedAt: new Date(),
    authMethod: "google",
    persona: null,
    karmaTotal: 0,
    leaderboardRank: null,
    revocationVersion: 0,
    status: "active",
    ...overrides,
  };
  state.users.push(row);
  return row;
}

function grantRole(userId: string, role: string) {
  state.userRoles.push({ userId, role });
}

async function sessionFor(userId: string): Promise<string> {
  const token = `session_${userId}_${state.sessions.size + 1}`;
  state.sessions.set(token, userId);
  return token;
}

/** Provider asserts this subject/email pair on the next login. */
function providerAsserts(sub: string, email: string, emailVerified = true) {
  state.googleIdentity = { sub, email, email_verified: emailVerified };
}

function googleLogin(url = "/v1/auth/google") {
  return app.inject({ method: "POST", url, payload: { idToken: "dummy-identity-token" } });
}

beforeEach(async () => {
  state.users.length = 0;
  state.userRoles.length = 0;
  state.tokens.length = 0;
  state.audit.length = 0;
  state.sessions.clear();
  state.beforeUserUpdateMany = null;
  state.googleConfigured = true;
  state.googleIdentity = null;
  state.verifyCalls = 0;
  state.config.corsOrigins = ["http://localhost:3000", "http://localhost:3002"];
  app = await buildTestApp();
});

// ---------------------------------------------------------------------------
// SEC-05 — the login routes themselves must fail closed
// ---------------------------------------------------------------------------

describe("SEC-05 — Google login routes when the provider is not configured", () => {
  it("refuses the member path with 503 and never reaches the verifier", async () => {
    state.googleConfigured = false;
    providerAsserts("dummy-subject-A", "dummy1@example.invalid");
    const res = await googleLogin();
    expect(res.statusCode).toBe(503);
    expect(state.verifyCalls).toBe(0);
    expect(state.sessions.size).toBe(0);
    expect(state.users).toHaveLength(0);
  });

  it("refuses the admin path with 503 and never reaches the verifier", async () => {
    state.googleConfigured = false;
    const admin = makeUser({ googleId: "dummy-subject-A" });
    grantRole(String(admin.id), "admin");
    providerAsserts("dummy-subject-A", String(admin.email));
    const res = await googleLogin("/v1/auth/google/admin");
    expect(res.statusCode).toBe(503);
    expect(state.verifyCalls).toBe(0);
    expect(state.sessions.size).toBe(0);
  });

  it("returns 401 when the configured verifier rejects the token", async () => {
    // Covers wrong audience, expired token and provider failure alike: the
    // verifier's contract is `null`, and no account may be created or signed
    // in on that answer. Claim-by-claim rejection is asserted in
    // lib/google-auth.audience.test.ts.
    state.googleIdentity = null;
    expect((await googleLogin()).statusCode).toBe(401);
    expect((await googleLogin("/v1/auth/google/admin")).statusCode).toBe(401);
    expect(state.users).toHaveLength(0);
    expect(state.sessions.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SEC-06 — subject-first identity binding
// ---------------------------------------------------------------------------

describe("SEC-06 — Google subject binding", () => {
  it("REGRESSION: refuses a different subject asserting an already-linked account's email", async () => {
    const victim = makeUser({ googleId: "dummy-subject-A", email: "victim@example.invalid" });
    providerAsserts("dummy-subject-B", "victim@example.invalid");

    const res = await googleLogin();

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already linked to a different Google account/i);
    // No session, and the existing binding is untouched — no auto-merge.
    expect(state.sessions.size).toBe(0);
    expect(victim.googleId).toBe("dummy-subject-A");
    expect(state.users).toHaveLength(1);
  });

  it("signs in on subject match and syncs a changed email", async () => {
    const user = makeUser({ googleId: "dummy-subject-A", email: "old@example.invalid" });
    providerAsserts("dummy-subject-A", "new@example.invalid");

    const res = await googleLogin();

    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(user.id);
    expect(user.email).toBe("new@example.invalid");
    expect(state.audit.map((a) => a.action)).toContain("user.google_email_synced");
  });

  it("refuses a subject match whose new email is owned by a second account", async () => {
    const linked = makeUser({ googleId: "dummy-subject-A", email: "first@example.invalid" });
    const other = makeUser({ email: "second@example.invalid" });
    providerAsserts("dummy-subject-A", "second@example.invalid");

    const res = await googleLogin();

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already belongs to a different DataBounty account/i);
    // Neither account moved. Reassigning the address would be a merge.
    expect(linked.email).toBe("first@example.invalid");
    expect(other.email).toBe("second@example.invalid");
    expect(other.googleId).toBeNull();
    expect(state.sessions.size).toBe(0);
  });

  it("links a verified email to an eligible UNLINKED account", async () => {
    const user = makeUser({ googleId: null, email: "unlinked@example.invalid", authMethod: "email" });
    providerAsserts("dummy-subject-A", "unlinked@example.invalid");

    const res = await googleLogin();

    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(user.id);
    expect(user.googleId).toBe("dummy-subject-A");
    expect(state.audit.map((a) => a.action)).toContain("user.google_id_linked");
  });

  it("refuses to link an email Google has not verified", async () => {
    const user = makeUser({ googleId: null, email: "unlinked@example.invalid" });
    providerAsserts("dummy-subject-A", "unlinked@example.invalid", false);

    const res = await googleLogin();

    expect(res.statusCode).toBe(409);
    expect(user.googleId).toBeNull();
  });

  it("creates a fresh account when neither subject nor email matches", async () => {
    providerAsserts("dummy-subject-new", "brand-new@example.invalid");
    const res = await googleLogin();
    expect(res.statusCode).toBe(200);
    expect(state.users).toHaveLength(1);
    expect(state.users[0]!.googleId).toBe("dummy-subject-new");
  });

  it("refuses when the same subject somehow binds two accounts", async () => {
    // Only reachable if the unique index is gone or a backfill went wrong. The
    // point is that the answer is a refusal, not an arbitrary pick.
    makeUser({ googleId: "dummy-subject-A", email: "one@example.invalid" });
    makeUser({ googleId: "dummy-subject-A", email: "two@example.invalid" });
    providerAsserts("dummy-subject-A", "one@example.invalid");

    const res = await googleLogin();

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/more than one DataBounty account/i);
    expect(state.sessions.size).toBe(0);
  });

  it("refuses, rather than merging, when a concurrent login links the row first", async () => {
    const user = makeUser({ googleId: null, email: "racing@example.invalid" });
    providerAsserts("dummy-subject-B", "racing@example.invalid");
    // The other request commits between our resolution and our write.
    state.beforeUserUpdateMany = () => {
      user.googleId = "dummy-subject-A";
    };

    const res = await googleLogin();

    expect(res.statusCode).toBe(409);
    expect(user.googleId).toBe("dummy-subject-A");
    expect(state.sessions.size).toBe(0);
  });
});

describe("SEC-06 — the admin path shares the fix", () => {
  it("refuses a mismatched subject on the admin login", async () => {
    const admin = makeUser({ googleId: "dummy-subject-A", email: "admin@example.invalid" });
    grantRole(String(admin.id), "admin");
    providerAsserts("dummy-subject-B", "admin@example.invalid");

    const res = await googleLogin("/v1/auth/google/admin");

    expect(res.statusCode).toBe(409);
    expect(admin.googleId).toBe("dummy-subject-A");
    expect(state.sessions.size).toBe(0);
  });

  it("signs an administrator in on a subject match and returns the role", async () => {
    const admin = makeUser({ googleId: "dummy-subject-A", email: "admin@example.invalid" });
    grantRole(String(admin.id), "admin");
    providerAsserts("dummy-subject-A", "admin@example.invalid");

    const res = await googleLogin("/v1/auth/google/admin");

    expect(res.statusCode).toBe(200);
    expect(res.json().user.roles).toEqual(["admin"]);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("db_admin_session=");
  });

  it("refuses a subject-matched account that holds no admin role", async () => {
    makeUser({ googleId: "dummy-subject-A", email: "member@example.invalid" });
    providerAsserts("dummy-subject-A", "member@example.invalid");
    const res = await googleLogin("/v1/auth/google/admin");
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/not an administrator/i);
  });

  it("never creates an account from the admin path", async () => {
    providerAsserts("dummy-subject-A", "nobody@example.invalid");
    const res = await googleLogin("/v1/auth/google/admin");
    expect(res.statusCode).toBe(403);
    expect(state.users).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SEC-07 — trusted origin + fresh proof on POST /v1/auth/set-password
// ---------------------------------------------------------------------------

describe("SEC-07 — setting the first password", () => {
  async function oauthOnlyVictim() {
    const user = makeUser({ googleId: "dummy-subject-A", passwordHash: null });
    return { user, cookie: `db_session=${await sessionFor(String(user.id))}` };
  }

  async function setToken(userId: string, purpose = "set") {
    const token = `pwtoken_${purpose}_${userId}_${state.tokens.length + 1}`;
    state.tokens.push({
      token,
      userId,
      purpose,
      usedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return token;
  }

  it("REGRESSION: refuses the hostile-origin form POST and leaves the password unset", async () => {
    const { user, cookie: sessionCookie } = await oauthOnlyVictim();
    const token = await setToken(String(user.id));

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/set-password",
      headers: { origin: HOSTILE_ORIGIN, cookie: sessionCookie, "content-type": FORM },
      payload: `token=${token}&newPassword=DummyReviewOnly123%21`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/untrusted origin/i);
    // The whole point of the finding: the mutation must not have happened.
    expect(user.passwordHash).toBeNull();
    expect(state.tokens[0]!.usedAt).toBeNull();
  });

  it("refuses a cookie-authenticated POST that states no origin at all", async () => {
    const { user, cookie: sessionCookie } = await oauthOnlyVictim();
    const token = await setToken(String(user.id));

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/set-password",
      headers: { cookie: sessionCookie, "content-type": FORM },
      payload: `token=${token}&newPassword=DummyReviewOnly123%21`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/must state its origin/i);
    expect(user.passwordHash).toBeNull();
  });

  it("accepts a trusted Referer when Origin is absent", async () => {
    const { user, cookie: sessionCookie } = await oauthOnlyVictim();
    const token = await setToken(String(user.id));

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/set-password",
      headers: { referer: `${TRUSTED_ORIGIN}/profile`, cookie: sessionCookie },
      payload: { token, newPassword: "DummyReviewOnly123!" },
    });

    expect(res.statusCode).toBe(200);
    expect(user.passwordHash).toBe("hashed:DummyReviewOnly123!");
  });

  it("still works from an allowed origin with a valid set-password link", async () => {
    const { user, cookie: sessionCookie } = await oauthOnlyVictim();
    const token = await setToken(String(user.id));

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/set-password",
      headers: { origin: TRUSTED_ORIGIN, cookie: sessionCookie },
      payload: { token, newPassword: "DummyReviewOnly123!" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(user.passwordHash).toBe("hashed:DummyReviewOnly123!");
    expect(state.audit.map((a) => a.action)).toContain("user.password_set");
    // The pending "prove you own this address" window is spent.
    expect(state.tokens.every((t) => t.usedAt !== null)).toBe(true);
  });

  it("FRESH PROOF: an allowed-origin session alone cannot plant a password", async () => {
    const { user, cookie: sessionCookie } = await oauthOnlyVictim();

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/set-password",
      headers: { origin: TRUSTED_ORIGIN, cookie: sessionCookie },
      payload: { newPassword: "DummyReviewOnly123!" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/set-password link is required/i);
    expect(user.passwordHash).toBeNull();
  });

  it("rejects a token issued for a different account", async () => {
    const { user, cookie: sessionCookie } = await oauthOnlyVictim();
    const attacker = makeUser({ googleId: "dummy-subject-Z" });
    const foreign = await setToken(String(attacker.id));

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/set-password",
      headers: { origin: TRUSTED_ORIGIN, cookie: sessionCookie },
      payload: { token: foreign, newPassword: "DummyReviewOnly123!" },
    });

    expect(res.statusCode).toBe(400);
    expect(user.passwordHash).toBeNull();
  });

  it("rejects a reset-purpose token and an already-spent one", async () => {
    const { user, cookie: sessionCookie } = await oauthOnlyVictim();
    const resetPurpose = await setToken(String(user.id), "reset");
    const spent = await setToken(String(user.id));
    state.tokens.find((t) => t.token === spent)!.usedAt = new Date();

    for (const token of [resetPurpose, spent]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/set-password",
        headers: { origin: TRUSTED_ORIGIN, cookie: sessionCookie },
        payload: { token, newPassword: "DummyReviewOnly123!" },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(user.passwordHash).toBeNull();
  });

  it("exempts bearer-token callers from the origin check but not from fresh proof", async () => {
    // A bearer credential is never attached ambiently by a browser, so it is
    // not a CSRF surface — non-browser API clients must keep working.
    const user = makeUser({ googleId: "dummy-subject-A", passwordHash: null });
    const bearer = await sessionFor(String(user.id));
    const token = await setToken(String(user.id));

    const unproofed = await app.inject({
      method: "POST",
      url: "/v1/auth/set-password",
      headers: { origin: HOSTILE_ORIGIN, authorization: `Bearer ${bearer}` },
      payload: { newPassword: "DummyReviewOnly123!" },
    });
    expect(unproofed.statusCode).toBe(400);
    expect(user.passwordHash).toBeNull();

    const proofed = await app.inject({
      method: "POST",
      url: "/v1/auth/set-password",
      headers: { authorization: `Bearer ${bearer}` },
      payload: { token, newPassword: "DummyReviewOnly123!" },
    });
    expect(proofed.statusCode).toBe(200);
    expect(user.passwordHash).toBe("hashed:DummyReviewOnly123!");
  });

  it("checks the origin BEFORE authenticating, so an anonymous hostile POST leaks nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/set-password",
      headers: { origin: HOSTILE_ORIGIN, "content-type": FORM },
      payload: "newPassword=DummyReviewOnly123%21",
    });
    // No cookie at all, so the origin gate does not apply and requireAuth
    // answers instead.
    expect(res.statusCode).toBe(401);
  });

  it("guards POST /request-set-password the same way", async () => {
    const { cookie: sessionCookie } = await oauthOnlyVictim();

    const hostile = await app.inject({
      method: "POST",
      url: "/v1/auth/request-set-password",
      headers: { origin: HOSTILE_ORIGIN, cookie: sessionCookie, "content-type": FORM },
      payload: "",
    });
    expect(hostile.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/auth/request-set-password",
      headers: { origin: TRUSTED_ORIGIN, cookie: sessionCookie },
    });
    expect(allowed.statusCode).toBe(200);
  });
});
