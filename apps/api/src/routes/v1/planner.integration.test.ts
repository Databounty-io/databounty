// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the community planner (routes/v1/planner.ts +
 * services/planner.ts) — the previously-missing surface behind
 * community/apps/web's `hydratePlannerCatalog`/session hooks
 * (community/apps/web/lib/store.tsx). Before these routes existed, every
 * `/v1/planner/*` call 404'd and the sponsor-create UI silently fell back to
 * a hardcoded catalog three of whose five offered types don't exist in the
 * real DB, 500ing on submit.
 *
 * Same harness and self-guard as the other route-level integration tests in
 * this app (see submission-revision.integration.test.ts): Fastify inject()
 * against buildApp(), no port bound, refuses to run outside the disposable
 * verification database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";
import { languageSupportFor } from "../../services/execution.js";

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

async function signupVerified(emailPrefix: string) {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email,
      password: "Test@12345",
      handle: `${emailPrefix}${Date.now()}${Math.floor(Math.random() * 1000)}`,
      displayName: emailPrefix,
    },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
  return { email, userId, cookie };
}

describe("GET /v1/planner/catalog", () => {
  it("returns real seeded active dataset types, not the web app's hardcoded fallback catalog", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/planner/catalog" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      datasetTypes: { id: string; status: string }[];
      deadlineSettings: unknown;
      sampleGate: { min: number; max: number };
      llmValidationEnabled: boolean;
      steps: unknown[];
    };

    const ids = body.datasetTypes.map((t) => t.id);
    // Real, seeded, active types — must be present.
    expect(ids).toContain("debugging");
    expect(ids).toContain("implementation");
    // The three phantom types the web app's bundled dataset-types.ts fallback
    // offers that do NOT exist as real DatasetType rows (verified directly
    // against the DB before writing this test) — picking one of these in the
    // old fallback-catalog UI is exactly what 500'd on submit. This endpoint
    // existing and being wired to the real catalog must never surface them.
    expect(ids).not.toContain("test_generation");
    expect(ids).not.toContain("error_diagnosis");
    expect(ids).not.toContain("migration");
    // Every returned type is genuinely active — the catalog must not leak
    // platform_review/draft/coming_soon candidates into the public picker.
    expect(body.datasetTypes.every((t) => t.status === "active")).toBe(true);

    // The envelope the web client's hydratePlannerCatalog destructures
    // (community/apps/web/lib/store.tsx) must be present with the right
    // shapes, not undefined.
    expect(body.deadlineSettings).toBeTruthy();
    expect(typeof body.sampleGate.min).toBe("number");
    expect(typeof body.sampleGate.max).toBe("number");
    expect(typeof body.llmValidationEnabled).toBe("boolean");
    expect(Array.isArray(body.steps)).toBe(true);
  });

  // Route WIRING for languageSupport, not the resolver — the resolver has its
  // own unit tests in services/execution-providers/language-support.test.ts.
  // What can only break here is the serialisation: the field being absent, or
  // being computed from something other than the row the route returned. The
  // sponsor planner's language step reads this to decide whether to ask at all
  // (`fixed`/`none` → don't ask), and the web client deliberately treats an
  // ABSENT field as "the server hasn't told me" and falls back to free text —
  // so an omitted field silently reintroduces the hardcoded-list defect.
  it("serves languageSupport for every catalog type, computed from that type's own contract", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/planner/catalog" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      datasetTypes: {
        id: string;
        fields: unknown;
        languageSupport?: { mode: string; languages: { id: string; label: string; status: string }[] };
      }[];
    };
    expect(body.datasetTypes.length).toBeGreaterThan(0);

    for (const type of body.datasetTypes) {
      const support = type.languageSupport;
      // Never absent, and never a fabricated stand-in for "I don't know".
      expect(support, `languageSupport missing for ${type.id}`).toBeTruthy();
      expect(["fixed", "choice", "any", "none"]).toContain(support!.mode);
      expect(Array.isArray(support!.languages)).toBe(true);
      // The two modes that carry no options must carry no languages, and the
      // two that do must be non-empty — otherwise the client cannot tell
      // "nothing to ask" from "ask, but I have no options for you".
      if (support!.mode === "any" || support!.mode === "none") {
        expect(support!.languages).toHaveLength(0);
      } else {
        expect(support!.languages.length).toBeGreaterThan(0);
      }
      // `fixed` means exactly one permitted answer — the step states it
      // instead of asking, so more than one here would be a silent lie.
      if (support!.mode === "fixed") expect(support!.languages).toHaveLength(1);
      for (const lang of support!.languages) {
        expect(typeof lang.id).toBe("string");
        expect(lang.id.length).toBeGreaterThan(0);
        expect(typeof lang.label).toBe("string");
        expect(["verified", "unverifiable"]).toContain(lang.status);
      }
      // Computed from THIS row's contract, not from a shared default: run the
      // resolver over the fields the route itself returned and require the
      // same answer.
      expect(languageSupportFor({ fields: type.fields as never })).toEqual(support);
    }

    // At least one real seeded type must resolve to a closed set — if every
    // type came back `any`/`none` the assertions above would pass vacuously
    // while the planner still fell back to free text everywhere.
    expect(
      body.datasetTypes.some((t) => t.languageSupport!.mode === "fixed" || t.languageSupport!.mode === "choice")
    ).toBe(true);
  });

  it("is honest about active-only filtering when a domain/category filter is applied", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/planner/catalog?domain=coding" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { datasetTypes: { domain: string }[] };
    expect(body.datasetTypes.length).toBeGreaterThan(0);
    expect(body.datasetTypes.every((t) => t.domain === "coding")).toBe(true);
  });
});

describe("planner session lifecycle", () => {
  it("creates a session, reuses the same in-progress draft, saves answers, and finalizes into a real DatasetRequest", async () => {
    const { cookie, userId } = await signupVerified("plansess");

    // No active session yet.
    const noneRes = await app.inject({ method: "GET", url: "/v1/planner/sessions/active", headers: { cookie, origin: "http://localhost:3010" } });
    expect(noneRes.statusCode).toBe(200);
    expect(noneRes.json().session).toBeNull();

    const createRes = await app.inject({ method: "POST", url: "/v1/planner/sessions", headers: { cookie, origin: "http://localhost:3010" } });
    expect(createRes.statusCode).toBe(200);
    const sessionId = createRes.json().session.id as string;
    expect(createRes.json().reused).toBe(false);

    // Re-opening the planner reuses the same draft rather than minting a
    // second row (v1's single-active-draft-per-user rule, ported as-is).
    const createAgainRes = await app.inject({ method: "POST", url: "/v1/planner/sessions", headers: { cookie, origin: "http://localhost:3010" } });
    expect(createAgainRes.statusCode).toBe(200);
    expect(createAgainRes.json().session.id).toBe(sessionId);
    expect(createAgainRes.json().reused).toBe(true);

    const answers = {
      category: "debugging",
      title: "Planner round-trip fixture",
      description: "A description long enough to satisfy the 20-character minimum on requestDatasetBody.",
      targetItems: 250,
      difficultyMix: "balanced",
      auditCoveragePct: 15,
      proposedLicense: "CC-BY-4.0",
      language: "TypeScript",
      framework: "Node.js",
    };

    const answersRes = await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/answers`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { answers, transcript: [{ role: "u", text: "I want a debugging dataset" }] },
    });
    expect(answersRes.statusCode).toBe(200);
    expect(answersRes.json().session.answersJson).toMatchObject(answers);
    expect(answersRes.json().session.version).toBe(1);

    // A stale expectedVersion is refused with 409, not silently applied.
    const staleRes = await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/answers`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { answers: { title: "Clobber attempt" }, expectedVersion: 0 },
    });
    expect(staleRes.statusCode).toBe(409);

    const readRes = await app.inject({ method: "GET", url: `/v1/planner/sessions/${sessionId}`, headers: { cookie, origin: "http://localhost:3010" } });
    expect(readRes.statusCode).toBe(200);
    expect(readRes.json().session.completed).toBe(false);

    const finalizeRes = await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/finalize`,
      headers: { cookie, origin: "http://localhost:3010" },
    });
    expect(finalizeRes.statusCode).toBe(201);
    const request = finalizeRes.json().request as {
      id: string;
      requesterUserId: string;
      title: string;
      datasetTypeId: string;
      targetItems: number;
      difficultyMix: string;
      auditCoveragePct: number;
      proposedLicense: string;
    };
    expect(request.requesterUserId).toBe(userId);
    expect(request.title).toBe(answers.title);
    expect(request.datasetTypeId).toBe("debugging");
    expect(request.targetItems).toBe(250);
    expect(request.difficultyMix).toBe("balanced");
    expect(request.auditCoveragePct).toBe(15);
    expect(request.proposedLicense).toBe("CC-BY-4.0");

    // Idempotent: finalizing an already-finalized session again returns the
    // SAME request, never a second row.
    const finalizeAgainRes = await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/finalize`,
      headers: { cookie, origin: "http://localhost:3010" },
    });
    expect(finalizeAgainRes.statusCode).toBe(201);
    expect(finalizeAgainRes.json().request.id).toBe(request.id);
    const requestCount = await prisma.datasetRequest.count({ where: { requesterUserId: userId } });
    expect(requestCount).toBe(1);

    // The session is marked completed and cannot be edited or deleted further.
    const postFinalizeAnswers = await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/answers`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { answers: { title: "too late" } },
    });
    expect(postFinalizeAnswers.statusCode).toBe(409);

    const deleteRes = await app.inject({ method: "DELETE", url: `/v1/planner/sessions/${sessionId}`, headers: { cookie, origin: "http://localhost:3010" } });
    expect(deleteRes.statusCode).toBe(409);
  }, 30_000);

  it("refuses to finalize a session missing required answers, with no DatasetRequest created", async () => {
    const { cookie, userId } = await signupVerified("planbad");
    const createRes = await app.inject({ method: "POST", url: "/v1/planner/sessions", headers: { cookie, origin: "http://localhost:3010" } });
    const sessionId = createRes.json().session.id as string;

    // Only a category, nothing else — title/description/targetItems missing.
    await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/answers`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { answers: { category: "debugging" } },
    });

    const finalizeRes = await app.inject({ method: "POST", url: `/v1/planner/sessions/${sessionId}/finalize`, headers: { cookie, origin: "http://localhost:3010" } });
    expect(finalizeRes.statusCode).toBe(400);

    const requestCount = await prisma.datasetRequest.count({ where: { requesterUserId: userId } });
    expect(requestCount).toBe(0);
    const session = await prisma.plannerSession.findUnique({ where: { id: sessionId } });
    expect(session?.completed).toBe(false);
  }, 30_000);

  it("refuses to read or edit another user's session (404, not leaked)", async () => {
    const owner = await signupVerified("planowner");
    const stranger = await signupVerified("planstranger");
    const createRes = await app.inject({ method: "POST", url: "/v1/planner/sessions", headers: { cookie: owner.cookie, origin: "http://localhost:3010" } });
    const sessionId = createRes.json().session.id as string;

    const readRes = await app.inject({ method: "GET", url: `/v1/planner/sessions/${sessionId}`, headers: { cookie: stranger.cookie, origin: "http://localhost:3010" } });
    expect(readRes.statusCode).toBe(404);

    const answersRes = await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/answers`,
      headers: { cookie: stranger.cookie, origin: "http://localhost:3010" },
      payload: { answers: { title: "hijack attempt" } },
    });
    expect(answersRes.statusCode).toBe(404);
  }, 30_000);

  it("PATCH /answers/:step edits a single step's answer without disturbing the rest", async () => {
    const { cookie } = await signupVerified("planpatch");
    const createRes = await app.inject({ method: "POST", url: "/v1/planner/sessions", headers: { cookie, origin: "http://localhost:3010" } });
    const sessionId = createRes.json().session.id as string;

    await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/answers`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { answers: { category: "debugging", title: "Original title" } },
    });

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/planner/sessions/${sessionId}/answers/title`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { value: "Patched title" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().session.answersJson.title).toBe("Patched title");
    expect(patchRes.json().session.answersJson.category).toBe("debugging");

    const badStepRes = await app.inject({
      method: "PATCH",
      url: `/v1/planner/sessions/${sessionId}/answers/not_a_real_step`,
      headers: { cookie, origin: "http://localhost:3010" },
      payload: { value: "x" },
    });
    expect(badStepRes.statusCode).toBe(400);
  }, 30_000);
});

describe("planner finalize parity with POST /v1/community/requests", () => {
  it("produces a DatasetRequest with the same field values a direct community-request submission would", async () => {
    const direct = await signupVerified("planparitydirect");
    const viaSession = await signupVerified("planparitysession");

    const shared = {
      title: "Parity fixture request",
      description: "Identical description used on both the direct and planner-finalize paths, 60+ chars long here.",
      datasetTypeId: "debugging",
      domain: "coding",
      proposedLicense: "CC-BY-4.0",
      // "Python" until 2026-09-07, when both creation doors gained the
      // server-side coherence check they had been missing. `debugging`
      // resolves to languageSupport `{mode: "fixed", languages: ["TypeScript"]}`
      // — its harness can only run TypeScript — so a request naming Python
      // was incoherent, and on a type whose trust tier is
      // `execution_verified` it made that badge false. This fixture asserted
      // the old permissive behaviour; the ASSERTIONS below are unchanged, only
      // the input is now a combination the template actually permits, so the
      // parity claim is exercised with coherent data rather than data the
      // server should refuse.
      language: "TypeScript",
      framework: "vitest",
      targetItems: 500,
      difficultyMix: "mostly_advanced",
      auditCoveragePct: 20,
    };

    const directRes = await app.inject({
      method: "POST",
      url: "/v1/community/requests",
      headers: { cookie: direct.cookie, origin: "http://localhost:3010" },
      payload: shared,
    });
    expect(directRes.statusCode).toBe(201);
    const directRequest = directRes.json().request;

    const sessionRes = await app.inject({ method: "POST", url: "/v1/planner/sessions", headers: { cookie: viaSession.cookie, origin: "http://localhost:3010" } });
    const sessionId = sessionRes.json().session.id as string;
    await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/answers`,
      headers: { cookie: viaSession.cookie, origin: "http://localhost:3010" },
      payload: {
        answers: {
          category: shared.datasetTypeId,
          title: shared.title,
          description: shared.description,
          proposedLicense: shared.proposedLicense,
          language: shared.language,
          framework: shared.framework,
          targetItems: shared.targetItems,
          difficultyMix: shared.difficultyMix,
          auditCoveragePct: shared.auditCoveragePct,
        },
      },
    });
    const finalizeRes = await app.inject({
      method: "POST",
      url: `/v1/planner/sessions/${sessionId}/finalize`,
      headers: { cookie: viaSession.cookie, origin: "http://localhost:3010" },
    });
    expect(finalizeRes.statusCode).toBe(201);
    const viaSessionRequest = finalizeRes.json().request;

    // Same shape, same values, for every field the planner collects — only
    // requester identity, id, and idempotencyKey legitimately differ.
    for (const field of [
      "title",
      "description",
      "datasetTypeId",
      "domain",
      "proposedLicense",
      "language",
      "framework",
      "targetItems",
      "difficultyMix",
      "auditCoveragePct",
      "status",
    ] as const) {
      expect(viaSessionRequest[field]).toEqual(directRequest[field]);
    }
    expect(viaSessionRequest.id).not.toBe(directRequest.id);
  }, 30_000);
});

describe("POST /v1/planner/dataset-types/requests — unified contract-integrity check", () => {
  // This endpoint used to run its OWN copy of `contractIntegrityError`
  // (formerly in services/planner.ts): laxer than the one
  // routes/v1/admin-dataset-types.ts uses to gate activation — no
  // schema-then-dedupe ordering rule, no human_audit-last rule, no "at
  // least one quality/human gate" rule, and it still allowed the
  // now-removed `contamination` stage. A sponsor-proposed type could pass
  // here, land in `platform_review`, and only fail later when an admin
  // tried to activate it. Both tests below prove the two checks now agree
  // from proposal time onward.
  const createdIds: string[] = [];
  afterAll(async () => {
    if (createdIds.length) await prisma.datasetType.deleteMany({ where: { id: { in: createdIds } } });
  });

  it("rejects a proposed pipeline naming the removed 'contamination' stage", async () => {
    const user = await signupVerified("plannercontam");
    const res = await app.inject({
      method: "POST",
      url: "/v1/planner/dataset-types/requests",
      headers: { cookie: user.cookie, origin: "http://localhost:3010" },
      payload: {
        name: `Contamination Stage Fixture ${Date.now()}`,
        description: "A sponsor-proposed type that still names the removed contamination stage.",
        fields: [
          { key: "instruction", label: "Instruction", role: "instruction", required: true },
          { key: "response", label: "Response", role: "rationale", required: true },
        ],
        pipeline: ["schema", "dedupe", "contamination", "human_audit"],
        dedupeFields: ["instruction"],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/unsupported stage|unknown pipeline stage/i);
  });

  it("rejects, at proposal time, a pipeline that the old lax planner check would have passed but the admin activation check would have failed (wrong stage order)", async () => {
    const user = await signupVerified("plannerstrict");
    // Old lax check only verified: >=2 fields, unique keys, every stage in
    // its allowlist, and dedupe fields not file-role — it never checked
    // ordering. This pipeline satisfies all of that (every stage is a real,
    // known stage; "dedupe" is present) but violates the admin route's
    // "must start with schema then dedupe" rule.
    const res = await app.inject({
      method: "POST",
      url: "/v1/planner/dataset-types/requests",
      headers: { cookie: user.cookie, origin: "http://localhost:3010" },
      payload: {
        name: `Bad Order Fixture ${Date.now()}`,
        description: "A sponsor-proposed type whose pipeline has dedupe before schema.",
        fields: [
          { key: "instruction", label: "Instruction", role: "instruction", required: true },
          { key: "response", label: "Response", role: "rationale", required: true },
        ],
        pipeline: ["dedupe", "schema", "human_audit"],
        dedupeFields: ["instruction"],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/start with schema then dedupe/i);
  });

  it("still accepts a well-formed proposal (schema, dedupe, human_audit — no contamination) end to end", async () => {
    const user = await signupVerified("plannergood");
    const res = await app.inject({
      method: "POST",
      url: "/v1/planner/dataset-types/requests",
      headers: { cookie: user.cookie, origin: "http://localhost:3010" },
      payload: {
        name: `Valid Proposal Fixture ${Date.now()}`,
        description: "A sponsor-proposed type with a valid, contamination-free pipeline.",
        fields: [
          { key: "instruction", label: "Instruction", role: "instruction", required: true },
          { key: "response", label: "Response", role: "rationale", required: true },
        ],
        pipeline: ["schema", "dedupe", "human_audit"],
        dedupeFields: ["instruction"],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().datasetType as { id: string; status: string };
    expect(created.status).toBe("platform_review");
    createdIds.push(created.id);
  });
});
