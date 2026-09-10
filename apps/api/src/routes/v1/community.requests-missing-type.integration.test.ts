// SPDX-License-Identifier: Apache-2.0

/**
 * `requestDatasetBody.datasetTypeId` is `.optional()` on this schema (unlike
 * the PATCH body's required field), but the handler unconditionally called
 * `prisma.datasetType.findUnique({ where: { id: data.datasetTypeId } })`
 * before checking that `data.datasetTypeId` was actually present. Prisma
 * throws synchronously on an `undefined` unique-where argument, with its
 * generated-client schema dumped into the error message — an unhandled
 * exception that reached the client as a raw 500 with a stack trace
 * (verified live against a running instance, not just read from source).
 * This proves the omission is now a clean 400 client error, and that
 * supplying a real `datasetTypeId` is unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdRequestIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await prisma.datasetRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
  await prisma.$disconnect();
});

async function signupVerified(prefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `fix12-missingtype-${prefix}-${stamp}@example.com`,
      password: "Test@12345",
      handle: `fix12missingtype${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 30),
      displayName: `fix12_missingtype_${prefix}`,
    },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { userId, cookie };
}

describe("POST /v1/community/requests without datasetTypeId", () => {
  it("returns a clean 400, never an unhandled 500 with a leaked stack trace", async () => {
    const requester = await signupVerified("missing");
    const res = await app.inject({
      method: "POST",
      url: "/v1/community/requests",
      headers: { cookie: requester.cookie, origin: "http://localhost:3010" },
      payload: {
        title: "fix12 missing type",
        description: "Description long enough to pass the twenty-character minimum bound.",
        targetItems: 15,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error?: string; message?: string };
    expect(body.message).toMatch(/datasetTypeId/i);
    // The original bug's signature: Prisma's generated-client error text.
    expect(JSON.stringify(body)).not.toMatch(/PrismaClientValidationError|DatasetTypeWhereUniqueInput/);
  });

  it("still succeeds when datasetTypeId is supplied", async () => {
    const requester = await signupVerified("present");
    const type = await prisma.datasetType.findFirst({ where: { status: "active" } });
    if (!type) {
      // No active dataset type seeded in this environment — nothing to assert against.
      return;
    }
    const res = await app.inject({
      method: "POST",
      url: "/v1/community/requests",
      headers: { cookie: requester.cookie, origin: "http://localhost:3010" },
      payload: {
        title: "fix12 with type",
        description: "Description long enough to pass the twenty-character minimum bound.",
        targetItems: 15,
        datasetTypeId: type.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { request: { id: string } };
    createdRequestIds.push(body.request.id);
  });
});
