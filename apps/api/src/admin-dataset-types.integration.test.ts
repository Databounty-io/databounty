// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for POST/PATCH/GET /v1/admin/dataset-types, added
 * alongside the widened admin dataset-type CRUD (routes/v1/admin-dataset-types.ts).
 *
 * Covers the three cases called out for this change:
 *  1. Create a dataset type end-to-end and confirm it is immediately visible
 *     via the existing public GET /v1/community/catalog endpoint.
 *  2. PATCH rejects an invalid `fields` shape (contract integrity check).
 *  3. GET /v1/admin/dataset-types/availability resolves correctly and is NOT
 *     swallowed by the `:id` param route — the literal regression test for
 *     the route-ordering bug this change fixes.
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
const createdDatasetTypeIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.datasetTypeHarness.deleteMany({ where: { datasetTypeId: { in: createdDatasetTypeIds } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: createdDatasetTypeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function signupAdmin(emailPrefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${emailPrefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email, password: "Test@12345", handle: `${emailPrefix}${stamp}`.slice(0, 30), displayName: emailPrefix },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  await prisma.userRole.create({ data: { userId, role: "admin" } });
  createdUserIds.push(userId);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

function newDatasetTypeBody(idSuffix: string, overrides: Record<string, unknown> = {}) {
  const id = `parity_test_type_${idSuffix}`;
  return {
    id,
    domain: "coding",
    name: `Parity Test Type ${idSuffix}`,
    description: "A dataset type created by an integration test.",
    category: "implementation",
    trustTier: "llm_verified",
    fields: [
      { key: "instruction", label: "Instruction", role: "instruction", required: true },
      { key: "response", label: "Response", role: "rationale", required: true },
    ],
    verification: {
      pipeline: ["schema", "dedupe", "human_audit"],
      dedupeFields: ["instruction"],
      auditOptions: [25, 100],
    },
    difficultyLevels: ["beginner", "intermediate", "advanced"],
    ...overrides,
  };
}

describe("admin dataset-type CRUD", () => {
  it("creates a dataset type end-to-end and it is immediately visible via GET /v1/community/catalog once active", async () => {
    const { cookie } = await signupAdmin("dtcreate");
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const body = newDatasetTypeBody(suffix, {
      status: "active",
      complexityScore: 1,
      verificationUnits: 0,
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/admin/dataset-types",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: body,
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().datasetType as { id: string; status: string };
    expect(created.id).toBe(body.id);
    expect(created.status).toBe("active");
    createdDatasetTypeIds.push(created.id);

    const catalogRes = await app.inject({ method: "GET", url: "/v1/community/catalog" });
    expect(catalogRes.statusCode).toBe(200);
    const catalog = catalogRes.json().datasetTypes as Array<{ id: string }>;
    expect(catalog.some((t) => t.id === created.id)).toBe(true);
  });

  it("creates a draft dataset type that does NOT appear in the public catalog until activated", async () => {
    const { cookie } = await signupAdmin("dtdraft");
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const body = newDatasetTypeBody(suffix); // no status → defaults to draft

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/admin/dataset-types",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: body,
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().datasetType as { id: string; status: string };
    expect(created.status).toBe("draft");
    createdDatasetTypeIds.push(created.id);

    const catalogRes = await app.inject({ method: "GET", url: "/v1/community/catalog" });
    const catalog = catalogRes.json().datasetTypes as Array<{ id: string }>;
    expect(catalog.some((t) => t.id === created.id)).toBe(false);
  });

  it("PATCH rejects an invalid `fields` shape instead of silently accepting it", async () => {
    const { cookie } = await signupAdmin("dtpatchbad");
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const body = newDatasetTypeBody(suffix);

    const createRes = await app.inject({ method: "POST", url: "/v1/admin/dataset-types", headers: { cookie, origin: "http://localhost:3010" }, payload: body });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().datasetType as { id: string };
    createdDatasetTypeIds.push(created.id);

    // Duplicate field keys — contractIntegrityError must reject this.
    const invalidFields = [
      { key: "instruction", label: "Instruction", role: "instruction", required: true },
      { key: "instruction", label: "Duplicate key", role: "rationale", required: true },
    ];
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/admin/dataset-types/${created.id}`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { fields: invalidFields },
    });
    expect(patchRes.statusCode).toBe(400);
    expect(patchRes.json().message).toMatch(/unique/i);

    // The dataset type must be unchanged in the database — no partial write.
    const stillOriginal = await prisma.datasetType.findUnique({ where: { id: created.id } });
    expect(stillOriginal?.fields).toEqual(body.fields);
  });

  it("PATCH also rejects a malformed schema request body (e.g. wrong type for `status`)", async () => {
    const { cookie } = await signupAdmin("dtpatchbad2");
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const body = newDatasetTypeBody(suffix);
    const createRes = await app.inject({ method: "POST", url: "/v1/admin/dataset-types", headers: { cookie, origin: "http://localhost:3010" }, payload: body });
    const created = createRes.json().datasetType as { id: string };
    createdDatasetTypeIds.push(created.id);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/admin/dataset-types/${created.id}`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { status: "not_a_real_status" },
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it("POST rejects a pipeline naming the removed 'contamination' stage as an unsupported stage, not a silently-ignored one", async () => {
    const { cookie } = await signupAdmin("dtcontam");
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const body = newDatasetTypeBody(suffix, {
      verification: {
        pipeline: ["schema", "dedupe", "contamination", "execution", "llm", "human_audit"],
        dedupeFields: ["instruction"],
        auditOptions: [25, 100],
      },
    });

    const createRes = await app.inject({ method: "POST", url: "/v1/admin/dataset-types", headers: { cookie, origin: "http://localhost:3010" }, payload: body });
    expect(createRes.statusCode).toBe(400);
    expect(createRes.json().message).toMatch(/duplicate or unsupported stage/i);

    // Never created — a rejected proposal must not leave a row behind.
    const row = await prisma.datasetType.findUnique({ where: { id: body.id } });
    expect(row).toBeNull();
  });

  it("PATCH also rejects re-adding 'contamination' to an existing type's pipeline", async () => {
    const { cookie } = await signupAdmin("dtcontampatch");
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const body = newDatasetTypeBody(suffix);
    const createRes = await app.inject({ method: "POST", url: "/v1/admin/dataset-types", headers: { cookie, origin: "http://localhost:3010" }, payload: body });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().datasetType as { id: string };
    createdDatasetTypeIds.push(created.id);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/admin/dataset-types/${created.id}`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: {
        verification: {
          pipeline: ["schema", "dedupe", "contamination", "human_audit"],
          dedupeFields: ["instruction"],
          auditOptions: [25, 100],
        },
      },
    });
    expect(patchRes.statusCode).toBe(400);
    expect(patchRes.json().message).toMatch(/duplicate or unsupported stage/i);
  });

  it("POST rejects a pipeline naming 'ai_attribution' as an unsupported stage — it is a real, always-on stage now (services/ai-attribution.ts), and is excluded from this allowlist precisely because it is unconditional, not admin-configurable", async () => {
    const { cookie } = await signupAdmin("dtaiattr");
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const body = newDatasetTypeBody(suffix, {
      verification: {
        pipeline: ["schema", "dedupe", "ai_attribution", "llm", "human_audit"],
        dedupeFields: ["instruction"],
        auditOptions: [25, 100],
      },
    });

    const createRes = await app.inject({ method: "POST", url: "/v1/admin/dataset-types", headers: { cookie, origin: "http://localhost:3010" }, payload: body });
    expect(createRes.statusCode).toBe(400);
    expect(createRes.json().message).toMatch(/duplicate or unsupported stage/i);

    // Never created — a rejected proposal must not leave a row behind.
    const row = await prisma.datasetType.findUnique({ where: { id: body.id } });
    expect(row).toBeNull();
  });

  it("PATCH also rejects re-adding 'ai_attribution' to an existing type's pipeline", async () => {
    const { cookie } = await signupAdmin("dtaiattrpatch");
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const body = newDatasetTypeBody(suffix);
    const createRes = await app.inject({ method: "POST", url: "/v1/admin/dataset-types", headers: { cookie, origin: "http://localhost:3010" }, payload: body });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().datasetType as { id: string };
    createdDatasetTypeIds.push(created.id);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/admin/dataset-types/${created.id}`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: {
        verification: {
          pipeline: ["schema", "dedupe", "ai_attribution", "human_audit"],
          dedupeFields: ["instruction"],
          auditOptions: [25, 100],
        },
      },
    });
    expect(patchRes.statusCode).toBe(400);
    expect(patchRes.json().message).toMatch(/duplicate or unsupported stage/i);
  });

  it("GET /v1/admin/dataset-types/availability resolves as the availability check, NOT as a phantom :id lookup for a type literally named 'availability'", async () => {
    const { cookie } = await signupAdmin("dtavail");

    // The regression this proves: if `:id` were registered before the
    // literal `/availability` path, this request would 404 with "dataset
    // type not found" (Fastify would treat "availability" as an :id value)
    // instead of returning the { id, available, suggestions } shape.
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/dataset-types/availability?name=A%20Brand%20New%20Type%20Name",
      headers: { cookie, origin: "http://localhost:3010" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    // The :id-lookup response shape is `{ datasetType: {...} }` or a 404 with
    // "Dataset type not found" — neither of those matches this shape, so
    // asserting on it directly proves the availability route, not the :id
    // route, handled the request.
    expect(data).not.toHaveProperty("datasetType");
    expect(data).toHaveProperty("available");
    expect(data).toHaveProperty("id");
    expect(data.id).toBe("a_brand_new_type_name");
    expect(data.available).toBe(true);

    // And once a real type with that derived id exists, availability must
    // correctly report it taken — proving both routes share the same slug
    // logic and the availability route is doing real work, not a stub.
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const takenName = `Parity Avail Check ${suffix}`;
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/admin/dataset-types",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: newDatasetTypeBody(suffix, { name: takenName, id: `parity_avail_check_${suffix}` }),
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().datasetType as { id: string };
    createdDatasetTypeIds.push(created.id);

    const takenRes = await app.inject({
      method: "GET",
      url: `/v1/admin/dataset-types/availability?name=${encodeURIComponent(takenName)}`,
      headers: { cookie, origin: "http://localhost:3010" },
    });
    expect(takenRes.statusCode).toBe(200);
    const takenData = takenRes.json();
    expect(takenData.available).toBe(false);
    expect(takenData.id).toBe(created.id);
  });

  it("GET /v1/admin/dataset-types/:id still resolves a real id correctly (sibling route unaffected by the ordering fix)", async () => {
    const { cookie } = await signupAdmin("dtgetid");
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/admin/dataset-types",
      headers: { cookie, origin: "http://localhost:3010" },
      payload: newDatasetTypeBody(suffix),
    });
    const created = createRes.json().datasetType as { id: string };
    createdDatasetTypeIds.push(created.id);

    const getRes = await app.inject({ method: "GET", url: `/v1/admin/dataset-types/${created.id}`, headers: { cookie, origin: "http://localhost:3010" } });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().datasetType.id).toBe(created.id);
  });
});
