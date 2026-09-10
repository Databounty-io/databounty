// SPDX-License-Identifier: Apache-2.0

/**
 * Write-time language canonicalisation on every door onto a stored `language`
 * column (services/planner.ts `canonicalLanguageFor`).
 *
 * Why this is a write-time concern and not a display one: the stored value is
 * served to anonymous callers and GROUPED BY in listings
 * (`GET /v1/community/catalog` builds its language filter from
 * `bounty.groupBy({ by: ["language"] })`), while the `language` filter itself
 * matches case-insensitively. So `typescript`, `TypeScript` and `TYPESCRIPT`
 * became three dropdown entries for one filter that returns the same rows —
 * which is why the read-time `dedupeLanguagesByCase` fold exists in
 * routes/v1/community.ts. Folding on write is the fix at the source; the
 * read-time fold stays, because canonicalisation is deliberately incomplete
 * (see the `any`-support cases below, which pass through unchanged by design).
 *
 * Three doors are covered, one describe block each:
 *   - POST  /v1/community/requests        (create)
 *   - PATCH /v1/community/requests/:id    (edit)
 *   - POST  /v1/planner/sessions/:id/finalize
 *
 * Fixture dataset types rather than catalog ones, so the assertions state what
 * each language-support MODE does and cannot be invalidated by a reseed that
 * changes which real template declares what:
 *   - `choice` — a `language` field with several options
 *   - `fixed`  — one executable field pinned to one `lang`
 *   - `any`    — an executable field with no `lang` at all: the contract
 *                constrains nothing, so there is no spelling to fold onto and
 *                the caller's own text must survive verbatim.
 *
 * Same harness and self-guard as the other route-level integration tests:
 * Fastify inject() against buildApp(), no port bound, refuses to run outside
 * the disposable verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ArtifactKind, ArtifactStatus, SponsorExampleReviewStatus } from "@prisma/client";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { languageSupportFor } from "../../services/execution.js";
import { putArtifactData } from "../../services/storage.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdRequestIds: string[] = [];
const createdSessionIds: string[] = [];
const createdBountyIds: string[] = [];
const createdArtifactIds: string[] = [];

// `fix4_lang_` prefix on every row this file creates: the verification
// database is shared with other sessions, and the afterAll below deletes by
// recorded id, so a leaked row is still identifiable by name.
const TYPE_CHOICE = "fix4_lang_choice";
const TYPE_FIXED = "fix4_lang_fixed";
const TYPE_ANY = "fix4_lang_any";
const FIXTURE_TYPE_IDS = [TYPE_CHOICE, TYPE_FIXED, TYPE_ANY];

// Two signed-up actors for the whole file, not one per test: `POST
// /v1/auth/signup` carries v1's AUTH_RATE_LIMIT of 10/minute per IP, and a
// signup-per-test file exhausted it and 429'd the last tests — a limiter doing
// its job, not a defect in what is under test here. Nothing below depends on a
// fresh identity; each test creates its own request rows.
let member: { userId: string; cookie: string };
let admin: { userId: string; cookie: string };

/** Fixture template. `fields` is what `languageSupportFor` reads, so the
 * language-support mode is decided entirely by what is passed here. */
async function seedType(id: string, fields: unknown[]) {
  await prisma.datasetType.create({
    data: {
      id,
      domain: "coding",
      name: `fix4_lang fixture ${id}`,
      description: "Fixture dataset type for write-time language canonicalisation coverage.",
      status: "active",
      origin: "platform",
      category: "implementation",
      trustTier: "llm_verified",
      fields: fields as object,
      verification: { pipeline: ["schema", "human_audit"], dedupeFields: ["instruction"], auditOptions: [25, 100] },
      difficultyLevels: ["beginner", "intermediate", "advanced"],
      complexityScore: 2,
      verificationUnits: 1,
    },
  });
}

async function signupVerified(prefix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email: `fix4-lang-${prefix}-${stamp}@example.com`,
      password: "Test@12345",
      handle: `fix4lang${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 30),
      displayName: `fix4_lang_${prefix}`,
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

async function createRequest(cookie: string, datasetTypeId: string, language: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/community/requests",
    headers: { cookie, origin: "http://localhost:3010" },
    payload: {
      title: `fix4_lang_ ${datasetTypeId} ${language}`,
      description: "Fixture request created to prove write-time language canonicalisation on this door.",
      datasetTypeId,
      language,
      targetItems: 10,
    },
  });
  if (res.statusCode === 201) createdRequestIds.push(res.json().request.id as string);
  return res;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await prisma.datasetType.deleteMany({ where: { id: { in: FIXTURE_TYPE_IDS } } });
  // A closed set the sponsor picks from. Declared lower-case on purpose: the
  // contract spelling a value is folded onto is `languageLabel`'s canonical
  // label, NOT the raw string in `options` — so a type whose own options are
  // sloppily cased still yields one canonical stored value.
  await seedType(TYPE_CHOICE, [
    { key: "instruction", label: "Instruction", role: "instruction", required: true },
    { key: "language", label: "Language", options: ["typescript", "python"], required: true },
  ]);
  // Exactly one permitted language, pinned by the executable field's `lang`.
  await seedType(TYPE_FIXED, [
    { key: "instruction", label: "Instruction", role: "instruction", required: true },
    { key: "solution_code", label: "Solution", role: "solution_code", lang: "TypeScript", required: true },
  ]);
  // Executable field, no `lang` and no `language` options: mode `any`.
  await seedType(TYPE_ANY, [
    { key: "instruction", label: "Instruction", role: "instruction", required: true },
    { key: "solution_code", label: "Solution", role: "solution_code", required: true },
  ]);

  member = await signupVerified("member");
  admin = await signupVerified("admin");
  await prisma.userRole.create({ data: { userId: admin.userId, role: "admin" } });
});

afterAll(async () => {
  await app.close();
  await prisma.artifact.deleteMany({ where: { id: { in: createdArtifactIds } } });
  await prisma.bounty.deleteMany({
    where: { OR: [{ id: { in: createdBountyIds } }, { datasetTypeId: { in: FIXTURE_TYPE_IDS } }] },
  });
  await prisma.datasetRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
  await prisma.plannerSession.deleteMany({ where: { id: { in: createdSessionIds } } });
  await prisma.datasetRequest.deleteMany({ where: { datasetTypeId: { in: FIXTURE_TYPE_IDS } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: FIXTURE_TYPE_IDS } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("fixture templates resolve to the language-support modes these tests assume", () => {
  // Guard, not decoration: every assertion below is about a MODE. If a fixture
  // stopped resolving to the mode its name claims, the tests would still pass
  // for the wrong reason.
  it("are choice / fixed / any", async () => {
    const types = await prisma.datasetType.findMany({ where: { id: { in: FIXTURE_TYPE_IDS } } });
    const modeOf = (id: string) => languageSupportFor(types.find((t) => t.id === id)!).mode;
    expect(modeOf(TYPE_CHOICE)).toBe("choice");
    expect(modeOf(TYPE_FIXED)).toBe("fixed");
    expect(modeOf(TYPE_ANY)).toBe("any");
  });
});

describe("POST /v1/community/requests — create", () => {
  it("folds a choice template's language onto the contract spelling", async () => {
    const cookie = member.cookie;
    const res = await createRequest(cookie, TYPE_CHOICE, "typescript");
    expect(res.statusCode).toBe(201);
    // The response body and the stored row must agree — the requester is shown
    // what was actually persisted, not what they typed.
    expect(res.json().request.language).toBe("TypeScript");
    const stored = await prisma.datasetRequest.findUniqueOrThrow({ where: { id: res.json().request.id } });
    expect(stored.language).toBe("TypeScript");
  });

  it("folds a fixed template's language, including from all-caps", async () => {
    const cookie = member.cookie;
    const res = await createRequest(cookie, TYPE_FIXED, "TYPESCRIPT");
    expect(res.statusCode).toBe(201);
    expect(res.json().request.language).toBe("TypeScript");
  });

  it("stores an `any` template's language exactly as supplied", async () => {
    const cookie = member.cookie;
    // Not a language the polyglot runner even recognises. A template that
    // constrains nothing has no spelling to fold onto, and inventing one would
    // be fabricating a value the contract never stated.
    const res = await createRequest(cookie, TYPE_ANY, "hAskell");
    expect(res.statusCode).toBe(201);
    expect(res.json().request.language).toBe("hAskell");
  });
});

describe("PATCH /v1/community/requests/:id — edit", () => {
  it("folds an edited language onto the stored template's spelling", async () => {
    const cookie = member.cookie;
    const created = await createRequest(cookie, TYPE_CHOICE, "TypeScript");
    expect(created.statusCode).toBe(201);
    const id = created.json().request.id as string;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/community/requests/${id}`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { language: "pYTHON" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().request.language).toBe("Python");
    const stored = await prisma.datasetRequest.findUniqueOrThrow({ where: { id } });
    expect(stored.language).toBe("Python");
  });

  it("folds against the type the caller switches TO when both change in one PATCH", async () => {
    // The row ends up naming the patched type, so that is the contract whose
    // spelling applies — folding against the stored (old) type would be
    // canonicalising to a template the request no longer uses.
    const cookie = member.cookie;
    const created = await createRequest(cookie, TYPE_ANY, "typescript");
    expect(created.statusCode).toBe(201);
    expect(created.json().request.language).toBe("typescript");
    const id = created.json().request.id as string;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/community/requests/${id}`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { datasetTypeId: TYPE_FIXED, language: "typescript" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().request.language).toBe("TypeScript");
  });

  it("leaves an `any` template's edited language exactly as supplied", async () => {
    const cookie = member.cookie;
    const created = await createRequest(cookie, TYPE_ANY, "TypeScript");
    expect(created.statusCode).toBe(201);
    const id = created.json().request.id as string;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/community/requests/${id}`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { language: "hAskell" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().request.language).toBe("hAskell");
  });

  it("records the STORED casing in the audit log, not the casing the caller sent", async () => {
    // An audit row saying `typescript` for a write that landed `TypeScript`
    // would misreport what the edit actually did.
    const cookie = member.cookie;
    const created = await createRequest(cookie, TYPE_CHOICE, "Python");
    const id = created.json().request.id as string;

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/community/requests/${id}`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { language: "typescript" },
    });
    expect(res.statusCode).toBe(200);

    const entry = await prisma.adminAuditLog.findFirst({
      where: { action: "community_request.edited", targetId: id },
      orderBy: { createdAt: "desc" },
    });
    expect((entry?.after as { language?: string } | null)?.language).toBe("TypeScript");
  });
});

describe("POST /v1/planner/sessions/:id/finalize", () => {
  it("folds the draft's language onto the contract spelling when the session is finalized", async () => {
    const cookie = member.cookie;
    const sessionRes = await app.inject({ method: "POST", url: "/v1/planner/sessions", headers: { cookie, origin: "http://localhost:3010" } });
    expect(sessionRes.statusCode).toBe(200);
    const sessionId = sessionRes.json().session.id as string;
    createdSessionIds.push(sessionId);

    const answersRes = await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/answers`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: {
        answers: {
          category: TYPE_CHOICE,
          title: "fix4_lang_ finalize fixture",
          description: "Fixture planner draft finalized to prove the third door canonicalises language too.",
          // Whatever the client last autosaved — the planner UI normalises to
          // the contract spelling, a direct API caller does not.
          language: "typescript",
          targetItems: 10,
        },
      },
    });
    expect(answersRes.statusCode).toBe(200);

    const finalizeRes = await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/finalize`,
      headers: { cookie, origin: "http://localhost:3010" },
    });
    expect(finalizeRes.statusCode).toBe(201);
    const requestId = finalizeRes.json().request.id as string;
    createdRequestIds.push(requestId);
    expect(finalizeRes.json().request.language).toBe("TypeScript");
    const stored = await prisma.datasetRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(stored.language).toBe("TypeScript");
  });

  it("stores an `any` template's drafted language exactly as supplied", async () => {
    const cookie = member.cookie;
    const sessionRes = await app.inject({ method: "POST", url: "/v1/planner/sessions", headers: { cookie, origin: "http://localhost:3010" } });
    const sessionId = sessionRes.json().session.id as string;
    createdSessionIds.push(sessionId);

    await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/answers`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: {
        answers: {
          category: TYPE_ANY,
          title: "fix4_lang_ finalize any fixture",
          description: "Fixture planner draft on a template that constrains no language at all.",
          language: "hAskell",
          targetItems: 10,
        },
      },
    });

    const finalizeRes = await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/finalize`,
      headers: { cookie, origin: "http://localhost:3010" },
    });
    expect(finalizeRes.statusCode).toBe(201);
    createdRequestIds.push(finalizeRes.json().request.id as string);
    expect(finalizeRes.json().request.language).toBe("hAskell");
  });
});

/* ------------------------------------------------------------------------ *
 * `Bounty.language` — the column the catalog's language filter actually
 * groups by. Both admin mint doors are covered, because a request row
 * canonicalised on write is only half the job: the value still has to reach
 * the bounty uncorrupted, and `/dataset-requests/:id/mint` takes the language
 * from its own request BODY rather than from the request row.
 * ------------------------------------------------------------------------ */

/** A requester who is NOT the admin: both mint doors refuse a self-review. */
async function seedRequester() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await prisma.user.create({
    data: { authMethod: "email", email: `fix4-lang-req-${stamp}@local.test`, displayName: "fix4_lang_ requester" },
  });
  createdUserIds.push(user.id);
  return user.id;
}

/** Seeded through Prisma, deliberately with a stray casing: this stands in for
 * a row written BEFORE the create/edit/finalize doors canonicalised, which no
 * amount of write-time folding fixes retroactively. */
async function seedApprovedRequest(params: { requesterUserId: string; datasetTypeId: string; language: string }) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const request = await prisma.datasetRequest.create({
    data: {
      requesterUserId: params.requesterUserId,
      title: `fix4_lang_ approved request ${stamp}`,
      description: "Fixture approved community request used to prove the mint doors canonicalise language.",
      datasetTypeId: params.datasetTypeId,
      proposedLicense: "CC-BY-4.0",
      language: params.language,
      framework: "Node.js",
      targetItems: 50,
      difficultyMix: "balanced",
      auditCoveragePct: 10,
      idempotencyKey: `fix4-lang-${stamp}`,
      status: "approved",
    },
  });
  createdRequestIds.push(request.id);
  return request.id;
}

/** Owner decision, 2026-09-09 (admin-community.ts `buildApprovedSampleAssets`):
 * both mint doors now refuse to launch a pool with zero approved
 * sponsor_reference samples. Not this file's concern (it's about
 * `Bounty.language`), but the gate applies unconditionally, so the fixture
 * request needs one real, admin-approved sample or every mint call below
 * 409s before the language-folding logic under test ever runs. Content is
 * written through the real storage driver so `buildApprovedSampleAssets`'s
 * own fetch+JSON.parse succeeds instead of skipping an unreadable sample. */
async function seedApprovedSample(params: { requesterUserId: string; datasetRequestId: string }) {
  const storageKey = `artifacts/sponsor_reference/fixture/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  await putArtifactData(storageKey, Buffer.from(JSON.stringify({ instruction: "fix4_lang_ fixture sample" })), "application/json");
  const artifact = await prisma.artifact.create({
    data: {
      kind: ArtifactKind.sponsor_reference,
      status: ArtifactStatus.ready,
      sponsorReviewStatus: SponsorExampleReviewStatus.approved,
      ownerUserId: params.requesterUserId,
      datasetRequestId: params.datasetRequestId,
      filename: "fix4_lang_fixture-sample.json",
      contentType: "application/json",
      storageKey,
    },
  });
  createdArtifactIds.push(artifact.id);
  return artifact.id;
}

describe("admin mint doors — Bounty.language", () => {
  it("POST /v1/admin/community/requests/:id/implement folds a legacy request's casing", async () => {
    const cookie = admin.cookie;
    const requesterUserId = await seedRequester();
    const requestId = await seedApprovedRequest({ requesterUserId, datasetTypeId: TYPE_CHOICE, language: "typescript" });
    await seedApprovedSample({ requesterUserId, datasetRequestId: requestId });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/community/requests/${requestId}/implement`,
      headers: { cookie, origin: "http://localhost:3010", "content-type": "application/json" },
      payload: { targetItems: 50 },
    });
    expect(res.statusCode).toBe(201);
    const bountyId = res.json().bounty.id as string;
    createdBountyIds.push(bountyId);
    const bounty = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(bounty.language).toBe("TypeScript");
  }, 45_000);

  it("POST /v1/admin/dataset-requests/:id/mint folds the caller-supplied body language", async () => {
    // `mintBountyBody.language` is a free string with only a
    // `.default("TypeScript")`, so nothing else constrains its casing.
    const cookie = admin.cookie;
    const requesterUserId = await seedRequester();
    const requestId = await seedApprovedRequest({ requesterUserId, datasetTypeId: TYPE_CHOICE, language: "TypeScript" });
    await seedApprovedSample({ requesterUserId, datasetRequestId: requestId });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/dataset-requests/${requestId}/mint`,
      headers: { cookie, origin: "http://localhost:3010", "content-type": "application/json" },
      payload: {
        title: "fix4_lang_ minted pool",
        description: "Fixture pool minted to prove the mint body's language is canonicalised on write.",
        language: "pYTHON",
        targetItems: 50,
      },
    });
    expect(res.statusCode).toBe(201);
    const bountyId = res.json().bounty.id as string;
    createdBountyIds.push(bountyId);
    const bounty = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    expect(bounty.language).toBe("Python");
  }, 45_000);

  it("leaves the mint body's language alone on a template that constrains nothing", async () => {
    const cookie = admin.cookie;
    const requesterUserId = await seedRequester();
    const requestId = await seedApprovedRequest({ requesterUserId, datasetTypeId: TYPE_ANY, language: "TypeScript" });
    await seedApprovedSample({ requesterUserId, datasetRequestId: requestId });

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/dataset-requests/${requestId}/mint`,
      headers: { cookie, origin: "http://localhost:3010", "content-type": "application/json" },
      payload: {
        title: "fix4_lang_ minted any pool",
        description: "Fixture pool on an any-support template: the supplied spelling must survive verbatim.",
        language: "hAskell",
        targetItems: 50,
      },
    });
    expect(res.statusCode).toBe(201);
    const bountyId = res.json().bounty.id as string;
    createdBountyIds.push(bountyId);
    const bounty = await prisma.bounty.findUniqueOrThrow({ where: { id: bountyId } });
    // Proof that the read-time `dedupeLanguagesByCase` fold in
    // routes/v1/community.ts cannot be retired: this is a stored casing no
    // write-time canonicalisation is allowed to correct.
    expect(bounty.language).toBe("hAskell");
  }, 45_000);
});
