// SPDX-License-Identifier: Apache-2.0

/**
 * Alias resolution on the same coherence/canonicalisation path exercised by
 * `community.language-canonicalisation.integration.test.ts` (services/planner.ts
 * `coherenceProblems` and `canonicalLanguageFor`).
 *
 * That sibling file proves CASING is folded (`typescript`/`TYPESCRIPT` →
 * `TypeScript`). This file proves ALIASES are resolved too — `ts` naming the
 * same language as `TypeScript` — which the two functions did not do until
 * now: both compared the caller's input against a template's permitted
 * `id`/`label` with a case-insensitive EXACT match only, never through
 * `normalizeLanguage` (lib/exec-languages.ts), the same alias table the
 * sandbox harness itself dispatches on.
 *
 * The asymmetry this closes: the live `debugging` dataset type's own
 * executable field stores `lang: "ts"`, and `languageSupportFor` (unchanged,
 * out of scope here) already folds THAT onto `{ id: "typescript", label:
 * "TypeScript" }` via the same `normalizeLanguage` call. But a sponsor who
 * typed `ts` into the request body — the identical spelling the template
 * itself uses — was rejected by `coherenceProblems`, because `"ts"` is
 * neither `"typescript"` nor `"TypeScript"` case-insensitively. Same alias,
 * opposite treatment depending on which side of the request it came from.
 *
 * This is a widening of what MATCHES, not a loosening of the match itself: a
 * language that resolves to no permitted canonical id (`Haskell` against a
 * TypeScript-only template) must still 400, exactly as before.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { languageSupportFor } from "../../services/execution.js";
import { requireDisposableDatabase } from "../../test-support/require-disposable-database.js";

requireDisposableDatabase();

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdRequestIds: string[] = [];

// `fix11_lang_` prefix on every row this file creates — this verification
// database is shared with other concurrent sessions, and afterAll deletes by
// recorded id, so a leaked row stays identifiable by name.
const TYPE_FIXED_ALIAS = "fix11_lang_fixed_alias";
const TYPE_CHOICE_ALIAS = "fix11_lang_choice_alias";
const TYPE_ANY = "fix11_lang_any";
const FIXTURE_TYPE_IDS = [TYPE_FIXED_ALIAS, TYPE_CHOICE_ALIAS, TYPE_ANY];

let member: { userId: string; cookie: string };

async function seedType(id: string, fields: unknown[]) {
  await prisma.datasetType.create({
    data: {
      id,
      domain: "coding",
      name: `fix11_lang fixture ${id}`,
      description: "Fixture dataset type for language-alias-resolution coverage.",
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
      email: `fix11-lang-${prefix}-${stamp}@example.com`,
      password: "Test@12345",
      handle: `fix11lang${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 30),
      displayName: `fix11_lang_${prefix}`,
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
      title: `fix11_lang_ ${datasetTypeId} ${language}`,
      description: "Fixture request created to prove alias resolution on this door.",
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
  // Mirrors the live `debugging` type's own bug: an executable field pinned
  // by the ALIAS spelling, not the canonical one. `languageSupportFor` folds
  // this to `{ id: "typescript", label: "TypeScript" }` regardless — that half
  // of the resolver is unchanged and out of scope here.
  await seedType(TYPE_FIXED_ALIAS, [
    { key: "instruction", label: "Instruction", role: "instruction", required: true },
    { key: "solution_code", label: "Solution", role: "solution_code", lang: "ts", required: true },
  ]);
  // A closed set declared in CANONICAL spelling, so a sponsor typing the
  // ALIAS (`py`) is the side under test, not the template's own casing.
  await seedType(TYPE_CHOICE_ALIAS, [
    { key: "instruction", label: "Instruction", role: "instruction", required: true },
    { key: "language", label: "Language", options: ["typescript", "python"], required: true },
  ]);
  // Executable field, no `lang` and no `language` options: mode `any`. Alias
  // resolution must not reach into a template that constrains nothing.
  await seedType(TYPE_ANY, [
    { key: "instruction", label: "Instruction", role: "instruction", required: true },
    { key: "solution_code", label: "Solution", role: "solution_code", required: true },
  ]);

  member = await signupVerified("member");
});

afterAll(async () => {
  await app.close();
  await prisma.datasetRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
  await prisma.datasetRequest.deleteMany({ where: { datasetTypeId: { in: FIXTURE_TYPE_IDS } } });
  await prisma.datasetType.deleteMany({ where: { id: { in: FIXTURE_TYPE_IDS } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("fixture templates resolve to the language-support modes these tests assume", () => {
  it("are fixed / choice / any", async () => {
    const types = await prisma.datasetType.findMany({ where: { id: { in: FIXTURE_TYPE_IDS } } });
    const modeOf = (id: string) => languageSupportFor(types.find((t) => t.id === id)!).mode;
    expect(modeOf(TYPE_FIXED_ALIAS)).toBe("fixed");
    expect(modeOf(TYPE_CHOICE_ALIAS)).toBe("choice");
    expect(modeOf(TYPE_ANY)).toBe("any");
    // The template's own alias is what makes this fixture faithful to the
    // live `debugging` bug: the resolved id/label must already be canonical.
    const fixed = languageSupportFor(types.find((t) => t.id === TYPE_FIXED_ALIAS)!);
    expect(fixed.languages).toEqual([{ id: "typescript", label: "TypeScript", status: "verified" }]);
  });
});

describe("POST /v1/community/requests — alias accepted and canonicalized", () => {
  it("accepts `ts` on a TypeScript-only (fixed) template and stores the canonical label", async () => {
    const res = await createRequest(member.cookie, TYPE_FIXED_ALIAS, "ts");
    expect(res.statusCode).toBe(201);
    expect(res.json().request.language).toBe("TypeScript");
    const stored = await prisma.datasetRequest.findUniqueOrThrow({ where: { id: res.json().request.id } });
    expect(stored.language).toBe("TypeScript");
  });

  it("accepts an alias (`py`) against a choice template's canonically-spelled options", async () => {
    const res = await createRequest(member.cookie, TYPE_CHOICE_ALIAS, "py");
    expect(res.statusCode).toBe(201);
    expect(res.json().request.language).toBe("Python");
  });

  it("still rejects a language that resolves to nothing the template permits", async () => {
    const res = await createRequest(member.cookie, TYPE_FIXED_ALIAS, "Haskell");
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not a language this template can verify/);
    // Confirms the rejection is on evidence, not a side effect of a bad fixture.
    expect(res.json().message).toMatch(/TypeScript/);
  });

  it("leaves an `any` template's language exactly as supplied, alias or not", async () => {
    // Mode `any` has no contract spelling to fold onto — this must behave
    // exactly as it did before this fix, verbatim passthrough.
    const res = await createRequest(member.cookie, TYPE_ANY, "ts");
    expect(res.statusCode).toBe(201);
    expect(res.json().request.language).toBe("ts");
  });
});
