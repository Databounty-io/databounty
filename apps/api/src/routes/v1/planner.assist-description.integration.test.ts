// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level integration tests for `POST /v1/planner/assist` with
 * `intent: "description"` — the planner's starter-description assist — plus
 * the V1 parity gate on `intent: "title"` for a type still in
 * `platform_review`.
 *
 * WHY THIS IS A SEPARATE FILE FROM planner.integration.test.ts. This suite
 * mocks `services/llm/service.js` (the ONE thing every consumer imports) so
 * the model path can be exercised through the real route, the real consumer,
 * the real Zod body union and the real database WITHOUT provider egress and
 * without a non-deterministic verdict. `OPENROUTER_API_KEY` is configured in
 * this workspace, so an unmocked assist call here would make a real, paid,
 * flaky call. planner.integration.test.ts stays fully unmocked; keeping the
 * mock in its own file means it cannot leak into those 11 tests.
 *
 * Everything else matches the sibling suites: Fastify inject() against
 * buildApp(), no port bound, refuses to run outside a disposable database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../../services/llm/service.js", () => ({ llm: { complete } }));

import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";
import { fallbackDescriptions } from "../../services/llm/consumers/suggest-description.js";

requireDisposableDatabase();

let app: FastifyInstance;
/** A real, seeded, ACTIVE catalog type — the launchable path. */
let activeType: { id: string; name: string; fields: unknown };
/** A sponsor-proposed type sitting in `platform_review` — the gated path. */
let reviewTypeId: string;
let cookie: string;

async function signupVerified(prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email,
      password: "Test@12345",
      handle: `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`,
      displayName: prefix,
    },
  });
  expect(res.statusCode).toBe(201);
  const userId = res.json().user.id as string;
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const setCookie = res.headers["set-cookie"];
  return (Array.isArray(setCookie) ? setCookie[0]! : String(setCookie)).split(";")[0]!;
}

/** POST /assist as the verified fixture user. Awaited inside so callers get a
 * plain response rather than fastify's chainable inject type. */
async function assist(payload: Record<string, unknown>) {
  return await app.inject({ method: "POST", url: "/v1/planner/assist", headers: { cookie, origin: "http://localhost:3010" }, payload });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  cookie = await signupVerified("assistdesc");

  const row = await prisma.datasetType.findFirst({
    where: { status: "active" },
    orderBy: { id: "asc" },
    select: { id: true, name: true, fields: true },
  });
  expect(row, "no active dataset type seeded in the verification database").toBeTruthy();
  activeType = row!;

  const proposed = await app.inject({
    method: "POST",
    url: "/v1/planner/dataset-types/requests",
    headers: { cookie, origin: "http://localhost:3010" },
    payload: {
      name: `Assist Description Review Fixture ${Date.now()}`,
      description: "A sponsor-proposed type used to test the platform_review assist gate.",
      fields: [
        { key: "instruction", label: "Instruction", role: "instruction", required: true },
        { key: "response", label: "Response", role: "rationale", required: true },
      ],
      pipeline: ["schema", "dedupe", "human_audit"],
      dedupeFields: ["instruction"],
    },
  });
  expect(proposed.statusCode).toBe(201);
  const created = proposed.json().datasetType as { id: string; status: string };
  expect(created.status).toBe("platform_review");
  reviewTypeId = created.id;
}, 60_000);

afterAll(async () => {
  if (reviewTypeId) await prisma.datasetType.deleteMany({ where: { id: reviewTypeId } });
  await app.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  complete.mockReset();
});

/** The service contract every consumer relies on: a live model answered. */
function modelAnswers(descriptions: string[]) {
  complete.mockResolvedValue({ data: { descriptions }, fallbackUsed: false });
}

/** The service contract on ANY failure: the caller's own deterministic
 * fallback, flagged. This is what a zero-key deployment gets on every call. */
function noModelAnswers() {
  complete.mockImplementation(async (req: { fallback: unknown }) => ({ data: req.fallback, fallbackUsed: true }));
}

describe('POST /v1/planner/assist { intent: "description" } — model path', () => {
  it("returns the model's starter descriptions and labels them source=llm", async () => {
    const copy = [
      "Each item pairs one failing snippet with the minimal fix and a test that proves the fix works.",
      "We want genuine regressions rather than textbook exercises: one concern per item, verifiable output.",
      "Broad coverage over repetition. Every item must stand alone and avoid public-benchmark content.",
    ];
    modelAnswers(copy);

    const res = await assist({ intent: "description", datasetTypeId: activeType.id, title: "Async bug fixes" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ descriptions: copy, source: "llm" });

    // Routed as its own feature, with the requester attributed for rate
    // limiting, and the title carried as JSON data rather than free prose.
    const sent = complete.mock.calls[0]![0];
    expect(sent.feature).toBe("suggest_description");
    expect(typeof sent.userId).toBe("string");
    expect(JSON.parse(sent.messages[0].content).working_title).toBe("Async bug fixes");
  });

  it("works with no title yet — the step can be reached before a title is typed", async () => {
    modelAnswers(["A dataset of self-contained, verifiable items covering this template's required fields."]);
    const res = await assist({ intent: "description", datasetTypeId: activeType.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("llm");
    expect(JSON.parse(complete.mock.calls[0]![0].messages[0].content).working_title).toBeNull();
  });

  it("PERSISTS NOTHING — an assist call is advisory only", async () => {
    modelAnswers(["Each item covers one concrete, reproducible case with every required field populated."]);
    const [sessionsBefore, requestsBefore] = await Promise.all([
      prisma.plannerSession.count(),
      prisma.datasetRequest.count(),
    ]);

    expect((await assist({ intent: "description", datasetTypeId: activeType.id, title: "Async bug fixes" })).statusCode).toBe(200);

    expect(await prisma.plannerSession.count()).toBe(sessionsBefore);
    expect(await prisma.datasetRequest.count()).toBe(requestsBefore);
  });
});

describe('POST /v1/planner/assist { intent: "description" } — fallback path', () => {
  it("returns the deterministic template-grounded starters, honestly labelled source=fallback", async () => {
    noModelAnswers();
    const res = await assist({ intent: "description", datasetTypeId: activeType.id, title: "Async bug fixes" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { descriptions: string[]; source: string };
    // Never labelled as an LLM result...
    expect(body.source).toBe("fallback");
    // ...and never empty: the step must not render a blank box.
    expect(body.descriptions).toEqual(fallbackDescriptions(activeType, "Async bug fixes"));
  });

  it("never turns a model failure into a 500", async () => {
    // A consumer bug that let an exception escape would surface here as a 500.
    // The LLM layer's no-throw contract plus the consumer's fallback mean the
    // route still answers 200 with usable copy.
    complete.mockImplementation(async (req: { fallback: unknown }) => ({ data: req.fallback, fallbackUsed: true }));
    const res = await assist({ intent: "description", datasetTypeId: activeType.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("fallback");
  });
});

describe('POST /v1/planner/assist { intent: "description" } — bounds and gating', () => {
  it("rejects a title over the 120-character bound the planner itself enforces, without spending a model call", async () => {
    modelAnswers(["should never be reached"]);
    const res = await assist({ intent: "description", datasetTypeId: activeType.id, title: "y".repeat(121) });
    expect(res.statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects a title under the 3-character bound", async () => {
    modelAnswers(["should never be reached"]);
    expect((await assist({ intent: "description", datasetTypeId: activeType.id, title: "ab" })).statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects a missing datasetTypeId as a 400, not a 500", async () => {
    expect((await assist({ intent: "description" })).statusCode).toBe(400);
    expect((await assist({ intent: "description", datasetTypeId: "" })).statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects an unknown dataset type as a 400 rather than inventing copy for it", async () => {
    const res = await assist({ intent: "description", datasetTypeId: "no_such_dataset_type_xyz" });
    expect(res.statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects an unknown intent", async () => {
    expect((await assist({ intent: "rewrite_everything", datasetTypeId: activeType.id })).statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/planner/assist",
      payload: { intent: "description", datasetTypeId: activeType.id },
    });
    expect(res.statusCode).toBe(401);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('POST /v1/planner/assist { intent: "title" } — governor attribution', () => {
  it("attributes the title assist to the requesting user, so the per-user rate limit applies", async () => {
    // v1 passes `userId` here (routes/v1/planner.ts:441). Without it
    // `checkGovernor` skips the per-user-per-minute limit outright
    // (services/llm/governor.ts), which made `title` the only un-rate-limited
    // egress path in the planner.
    complete.mockResolvedValue({ data: { titles: ["Async Bug Fix Corpus"] }, fallbackUsed: false });
    const res = await assist({ intent: "title", datasetTypeId: activeType.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("llm");

    const sent = complete.mock.calls[0]![0];
    expect(sent.feature).toBe("suggest");
    expect(typeof sent.userId).toBe("string");
    expect(sent.userId).toBeTruthy();
  });
});

describe("platform_review types — V1's approval gate on model-generated copy", () => {
  // The original application refuses `intent: "title"` for a type that is
  // not `active` server-side, and its planner renders "Custom/forked type
  // under review — no AI ideas by design" client-side. Ported as-is: this is
  // a product rule, not a porting accident.
  it("still refuses AI title ideas for a type awaiting platform review", async () => {
    modelAnswers(["should never be reached"]);
    const res = await assist({ intent: "title", datasetTypeId: reviewTypeId });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not available for new requests/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("still serves DETERMINISTIC description starters for that same type, with zero model egress", async () => {
    // V1's description starters are client-side and template-derived, so they
    // render for a platform_review type too. Refusing outright here would be a
    // regression against V1, not parity with it.
    modelAnswers(["should never be reached"]);
    const res = await assist({ intent: "description", datasetTypeId: reviewTypeId, title: "Fork of the review fixture" });
    expect(res.statusCode).toBe(200);

    const row = await prisma.datasetType.findUniqueOrThrow({
      where: { id: reviewTypeId },
      select: { id: true, name: true, fields: true },
    });
    expect(res.json()).toEqual({
      descriptions: fallbackDescriptions(row, "Fork of the review fixture"),
      source: "fallback",
    });
    // The gate is what matters: no model call was made for an unapproved type.
    expect(complete).not.toHaveBeenCalled();
  });
});
