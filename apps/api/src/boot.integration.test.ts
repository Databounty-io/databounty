// SPDX-License-Identifier: Apache-2.0

/**
 * First real integration tests for the Community API — proves the app
 * actually boots and does real DB-backed work end to end, against the
 * disposable `databounty_community_parity_verify` database configured via
 * .env (NEVER the shared v1 `databounty` database).
 *
 * Uses Fastify's inject() against buildApp() so no port is bound.
 */
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

describe("health", () => {
  it("GET /health returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("databounty-community-api");
  });
});

describe("auth signup/login/me", () => {
  const email = `boot-test-${Date.now()}@example.com`;
  const password = "Test@12345";
  let sessionCookie: string;

  it("POST /v1/auth/signup rejects missing required fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email, password },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /v1/auth/signup creates a real user row and returns a session cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email, password, handle: `boottest${Date.now()}`, displayName: "Boot Test" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe(email);
    expect(body.user.onboarded).toBe(false);

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    sessionCookie = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);

    const dbUser = await prisma.user.findUnique({ where: { email } });
    expect(dbUser).not.toBeNull();
    expect(dbUser?.email).toBe(email);
  });

  it("GET /v1/auth/me returns the authenticated user via the session cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: sessionCookie.split(";")[0]! },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(email);
  });

  it("GET /v1/auth/me without a session is unauthorized", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/auth/login authenticates with the same credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(email);
  });

  it("POST /v1/auth/login rejects a wrong password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("catalog / taxonomy (requires auth)", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    const email = `boot-catalog-${Date.now()}@example.com`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: {
        email,
        password: "Test@12345",
        handle: `boothcat${Date.now()}`,
        displayName: "Boot Catalog Test",
      },
    });
    const setCookie = res.headers["set-cookie"];
    sessionCookie = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  });

  it("GET /v1/bounties returns a paginated real DB query, not a mock", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/bounties",
      headers: { cookie: sessionCookie.split(";")[0]! },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("GET /v1/community/catalog reflects seeded dataset types", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/community/catalog",
      headers: { cookie: sessionCookie.split(";")[0]! },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.datasetTypes)).toBe(true);

    // Scoped to `active`, because that is what the route returns
    // (routes/v1/community.ts filters `status: "active"`). Comparing against an
    // unfiltered count only held on a freshly seeded database where every type
    // happens to be active; on real migrated data it read 50 vs 74 and failed
    // for a reason that had nothing to do with the endpoint.
    const activeCount = await prisma.datasetType.count({ where: { status: "active" } });
    expect(body.datasetTypes.length).toBe(activeCount);
    expect(activeCount).toBeGreaterThan(0);
  });
});
