// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetType } from "@prisma/client";

/**
 * `services/llm/consumers/suggest-description.ts` — the three things that can
 * actually go wrong with a suggestion consumer:
 *
 *  1. the model path is reported as the model path, and only when a model
 *     really answered;
 *  2. the zero-key/failure path still returns usable, submittable copy and is
 *     labelled `fallback`, never `llm`;
 *  3. a model answer the planner could NOT submit (too short, too long, wrong
 *     shape) is rejected by the schema rather than handed to the requester.
 *
 * The LLM service is mocked, so no provider egress and no database. (3) is
 * asserted against the exported schema bounds and by driving the service's
 * real contract: on a schema failure `llm.complete` returns the caller's own
 * `fallback` with `fallbackUsed: true` — see services/llm/service.ts.
 */
const complete = vi.fn();
vi.mock("../service.js", () => ({ llm: { complete } }));

const {
  suggestRequestDescriptions,
  fallbackDescriptions,
  requiredFieldLabels,
  DESCRIPTION_MIN,
  DESCRIPTION_MAX,
} = await import("./suggest-description.js");

const type = {
  id: "debugging",
  version: 3,
  name: "Debugging / Bug Fix",
  domain: "coding",
  description: "A broken snippet, a fix, and tests that prove the fix.",
  fields: [
    { key: "prompt", label: "Prompt", role: "instruction", required: true },
    { key: "broken_code", label: "Broken code", role: "input_code", required: true },
    { key: "rationale", label: "Rationale", role: "rationale", required: false },
  ],
} as unknown as DatasetType;

beforeEach(() => {
  complete.mockReset();
});

describe("requiredFieldLabels", () => {
  it("returns only the required fields' labels, in declaration order", () => {
    expect(requiredFieldLabels(type.fields)).toEqual(["Prompt", "Broken code"]);
  });

  it("falls back to a field's key when it declares no label", () => {
    expect(requiredFieldLabels([{ key: "tests", required: true }])).toEqual(["tests"]);
  });

  const malformed: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "prompt, tests"],
    ["a number", 7],
    ["an object instead of an array", { prompt: true }],
    ["an array of primitives", ["prompt", 3, null]],
    ["fields with no key and no label", [{ required: true }]],
    ["required as a truthy string rather than true", [{ key: "prompt", required: "yes" }]],
  ];
  for (const [name, fields] of malformed) {
    it(`never throws on a malformed fields blob (${name})`, () => {
      expect(() => requiredFieldLabels(fields)).not.toThrow();
      expect(Array.isArray(requiredFieldLabels(fields))).toBe(true);
    });
  }
});

describe("fallbackDescriptions", () => {
  it("returns three template-grounded starters naming the required fields", () => {
    const out = fallbackDescriptions(type, "Async bug fixes in TypeScript");
    expect(out).toHaveLength(3);
    for (const starter of out) {
      expect(starter).toContain("Async bug fixes in TypeScript");
      expect(starter).toContain("Prompt, Broken code");
      // Never leaks a non-required field into the "you must fill" list.
      expect(starter).not.toContain("Rationale");
    }
  });

  it("uses the type name as the subject when no title has been chosen yet", () => {
    for (const starter of fallbackDescriptions(type)) {
      expect(starter).toContain("debugging / bug fix");
    }
  });

  it("says so honestly when the template declares no required fields", () => {
    const bare = { name: "Custom Type", fields: [] } as unknown as DatasetType;
    for (const starter of fallbackDescriptions(bare)) {
      expect(starter).toContain("the fields defined by the template");
    }
  });

  // The whole point of the fallback: the requester must be able to CLICK it.
  // A starter under the planner's own 30-character floor would be rejected on
  // submit, which is worse than showing nothing.
  it("produces only values the planner would accept", () => {
    for (const candidate of [
      fallbackDescriptions(type, "Async bug fixes"),
      fallbackDescriptions(type),
      fallbackDescriptions({ name: "X", fields: null } as unknown as DatasetType),
      fallbackDescriptions(type, "y".repeat(120)),
    ].flat()) {
      expect(candidate.trim().length).toBeGreaterThanOrEqual(DESCRIPTION_MIN);
      expect(candidate.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    }
  });
});

describe("suggestRequestDescriptions — model path", () => {
  it('returns the model\'s descriptions and reports source "llm"', async () => {
    const modelCopy = [
      "Each item pairs a failing TypeScript snippet with the minimal fix and a test that proves it.",
      "We want real regressions, not textbook exercises: one concern per item, fix verified by its own test.",
    ];
    complete.mockResolvedValue({ data: { descriptions: modelCopy }, fallbackUsed: false });

    const out = await suggestRequestDescriptions(type, { title: "Async bug fixes", userId: "u1" });
    expect(out).toEqual({ descriptions: modelCopy, source: "llm" });
  });

  it("caps the model at three suggestions even if it returns more", async () => {
    const many = Array.from({ length: 6 }, (_, i) => `Suggestion number ${i} with enough characters to be valid.`);
    complete.mockResolvedValue({ data: { descriptions: many }, fallbackUsed: false });

    const out = await suggestRequestDescriptions(type);
    expect(out.descriptions).toHaveLength(3);
    expect(out.source).toBe("llm");
  });

  it("routes as the suggest_description feature with a schema, a fallback and a stable idempotency key", async () => {
    complete.mockResolvedValue({ data: { descriptions: ["a".repeat(60)] }, fallbackUsed: false });
    await suggestRequestDescriptions(type, { title: "Async bug fixes", userId: "u1", accountId: "acct-1" });

    const req = complete.mock.calls[0]![0];
    expect(req.feature).toBe("suggest_description");
    expect(req.userId).toBe("u1");
    expect(req.accountId).toBe("acct-1");
    expect(req.schema).toBeTruthy(); // model output is schema-validated
    expect(req.fallback.descriptions).toHaveLength(3); // deterministic default present
    expect(req.idempotencyKey).toBe("suggest-description:v1:debugging:3:Async bug fixes");
    // No consumer-supplied system message: the admin-editable feature prompt
    // is injected by the service, so an admin override really applies.
    expect(req.messages.every((m: { role: string }) => m.role === "user")).toBe(true);
    // The type/title reach the model as JSON data, not as free prose that
    // could read as an instruction.
    expect(() => JSON.parse(req.messages[0].content)).not.toThrow();
  });

  it("keys separately per title so one title's answer is never served for another", async () => {
    complete.mockResolvedValue({ data: { descriptions: ["a".repeat(60)] }, fallbackUsed: false });
    await suggestRequestDescriptions(type, { title: "First title" });
    await suggestRequestDescriptions(type, { title: "Second title" });
    expect(complete.mock.calls[0]![0].idempotencyKey).not.toBe(complete.mock.calls[1]![0].idempotencyKey);
  });
});

describe("suggestRequestDescriptions — fallback path", () => {
  it('reports source "fallback" and returns the deterministic starters when no model answered', async () => {
    // What the real service does with zero keys: hands back the caller's own
    // `fallback` and flags it.
    complete.mockImplementation(async (req: { fallback: { descriptions: string[] } }) => ({
      data: req.fallback,
      fallbackUsed: true,
    }));

    const out = await suggestRequestDescriptions(type, { title: "Async bug fixes" });
    expect(out.source).toBe("fallback");
    expect(out.descriptions).toEqual(fallbackDescriptions(type, "Async bug fixes"));
  });

  it("never labels a fallback as an LLM result", async () => {
    complete.mockImplementation(async (req: { fallback: { descriptions: string[] } }) => ({
      data: req.fallback,
      fallbackUsed: true,
    }));
    expect((await suggestRequestDescriptions(type)).source).not.toBe("llm");
  });
});

describe("suggestRequestDescriptions — bounds rejection", () => {
  /** The exact schema the consumer hands the service, exercised directly:
   * this is what decides whether a model answer is usable. */
  function parseModelAnswer(value: unknown) {
    const schema = complete.mock.calls[0]![0].schema;
    return schema.safeParse(value);
  }

  beforeEach(async () => {
    complete.mockResolvedValue({ data: { descriptions: ["a".repeat(60)] }, fallbackUsed: false });
    await suggestRequestDescriptions(type, { title: "Async bug fixes" });
  });

  it("accepts a well-formed answer at both inclusive bounds", () => {
    expect(parseModelAnswer({ descriptions: ["a".repeat(DESCRIPTION_MIN)] }).success).toBe(true);
    expect(parseModelAnswer({ descriptions: ["a".repeat(DESCRIPTION_MAX)] }).success).toBe(true);
  });

  const rejected: Array<[string, unknown]> = [
    ["a description under the planner's own floor", { descriptions: ["too short"] }],
    ["one short description among valid ones", { descriptions: ["a".repeat(60), "nope"] }],
    ["a description over the stored column bound", { descriptions: ["a".repeat(DESCRIPTION_MAX + 1)] }],
    ["an empty list", { descriptions: [] }],
    ["more than three suggestions", { descriptions: Array.from({ length: 4 }, () => "a".repeat(60)) }],
    ["a non-string entry", { descriptions: [42] }],
    ["a null entry", { descriptions: [null] }],
    ["descriptions as a bare string", { descriptions: "a".repeat(60) }],
    ["a missing key", {}],
    ["the wrong key", { titles: ["a".repeat(60)] }],
    ["not an object at all", "a".repeat(60)],
  ];
  for (const [name, answer] of rejected) {
    it(`rejects ${name}, so the service falls back instead of offering it`, () => {
      expect(parseModelAnswer(answer).success).toBe(false);
    });
  }

  it("hands back the deterministic starters when the model's answer fails the schema", async () => {
    // The service's real behaviour on an unparseable answer: exhaust the
    // failover chain, then return the caller's fallback flagged as such.
    complete.mockReset();
    complete.mockImplementation(async (req: { schema: { safeParse: (v: unknown) => { success: boolean } }; fallback: { descriptions: string[] } }) => {
      const bad = { descriptions: ["too short"] };
      expect(req.schema.safeParse(bad).success).toBe(false);
      return { data: req.fallback, fallbackUsed: true };
    });

    const out = await suggestRequestDescriptions(type, { title: "Async bug fixes" });
    expect(out.source).toBe("fallback");
    expect(out.descriptions).toEqual(fallbackDescriptions(type, "Async bug fixes"));
  });
});
