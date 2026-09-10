// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmUnavailableError } from "../types.js";

/**
 * `services/llm/consumers/review.ts` — the submission-review consumer's
 * FAIL-CLOSED contract and its verdict normalisation.
 *
 * The LLM service is mocked, so these are pure unit tests: no provider egress,
 * no database, and no dependence on whether OPENROUTER_API_KEY happens to be
 * set in the environment running the suite.
 *
 * The load-bearing test is the first one. `submission_review` is the only
 * feature whose consumer supplies NO deterministic fallback, precisely so the
 * layer raises instead of manufacturing a verdict when no model can answer. If
 * someone "fixes" that by adding a `fallback`, this file is what fails.
 */
const complete = vi.fn();
vi.mock("../service.js", () => ({ llm: { complete } }));

const { reviewSubmission } = await import("./review.js");

const ARGS = {
  datasetTypeName: "Debugging / Bug Fix",
  contractFields: [{ key: "broken_code", role: "input_code" }],
  payload: { broken_code: "const x = 1" },
};

/** A well-formed layer result carrying an already-schema-validated verdict. */
function modelAnswer(data: unknown) {
  return {
    data,
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    usage: { inputTokens: 10, outputTokens: 10, costMicroUsd: 1 },
    fallbackUsed: false,
    failoverUsed: false,
  };
}

beforeEach(() => {
  complete.mockReset();
});

describe("fail-closed: an unavailable model can never produce a pass", () => {
  it("supplies NO fallback, so the layer is free to raise", async () => {
    complete.mockResolvedValue(modelAnswer({ verdict: "pass", score: 91, reasons: [] }));
    await reviewSubmission(ARGS);
    const req = complete.mock.calls[0]![0] as Record<string, unknown>;
    // `undefined` and absent are both fine — what matters is that the layer's
    // `req.fallback === undefined` branch (LlmUnavailableError) is the one that
    // runs when nothing can answer.
    expect(req.fallback).toBeUndefined();
    expect(req.feature).toBe("submission_review");
  });

  it("propagates LlmUnavailableError rather than returning a verdict", async () => {
    // What the real layer does with no key configured / feature disabled /
    // every routed model exhausted / over the spend cap.
    complete.mockRejectedValue(new LlmUnavailableError("submission_review", "no provider credential configured"));
    await expect(reviewSubmission(ARGS)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("propagates a plain provider failure too — no verdict is invented", async () => {
    complete.mockRejectedValue(new Error("OpenRouter returned HTTP 502"));
    await expect(reviewSubmission(ARGS)).rejects.toThrow(/502/);
  });

  it("refuses a result flagged as the deterministic fallback", async () => {
    // Defence in depth: unreachable while no `fallback` is supplied, but if a
    // future edit adds one, a fabricated answer must raise, not score.
    complete.mockResolvedValue({
      ...modelAnswer({ verdict: "pass", score: 100, reasons: ["looks fine"] }),
      provider: "fallback",
      model: "deterministic",
      fallbackUsed: true,
    });
    await expect(reviewSubmission(ARGS)).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

describe("verdict mapping", () => {
  it("reports a real model pass with its score, reasons and the model that answered", async () => {
    complete.mockResolvedValue(modelAnswer({ verdict: "pass", score: 88, reasons: ["complete", "compiles"] }));
    await expect(reviewSubmission(ARGS)).resolves.toEqual({
      passed: true,
      score: 88,
      reasons: ["complete", "compiles"],
      // Taken from the layer's result, not from a constant — so the recorded
      // evidence names whichever candidate in the failover chain answered.
      model: "anthropic/claude-sonnet-4",
    });
  });

  it("reports a fail as a fail", async () => {
    complete.mockResolvedValue(modelAnswer({ verdict: "fail", score: 20, reasons: ["missing tests"] }));
    const verdict = await reviewSubmission(ARGS);
    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBe(20);
  });

  it("clamps an out-of-range score to 0-100, as the pre-layer client did", async () => {
    complete.mockResolvedValue(modelAnswer({ verdict: "pass", score: 140, reasons: [] }));
    expect((await reviewSubmission(ARGS)).score).toBe(100);
    complete.mockResolvedValue(modelAnswer({ verdict: "fail", score: -5, reasons: [] }));
    expect((await reviewSubmission(ARGS)).score).toBe(0);
  });
});

describe("routing request shape", () => {
  it("passes a strict schema that rejects a hedged verdict", async () => {
    complete.mockResolvedValue(modelAnswer({ verdict: "pass", score: 90, reasons: [] }));
    await reviewSubmission(ARGS);
    const req = complete.mock.calls[0]![0] as { schema: { safeParse: (v: unknown) => { success: boolean } } };
    // "uncertain" is treated as NO answer (schema failure -> repair -> next
    // candidate -> absent fallback -> raise), never coerced to pass or fail.
    expect(req.schema.safeParse({ verdict: "uncertain", score: 50, reasons: [] }).success).toBe(false);
    // A quoted score is formatting, not a different verdict, so it is accepted.
    expect(req.schema.safeParse({ verdict: "pass", score: "90", reasons: [] }).success).toBe(true);
  });

  it("sends the submission as user-message DATA and no system prompt of its own", async () => {
    complete.mockResolvedValue(modelAnswer({ verdict: "pass", score: 90, reasons: [] }));
    await reviewSubmission(ARGS);
    const req = complete.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    // The trusted instruction is the admin-resolvable system prompt the layer
    // prepends; a consumer that restated it would make the admin console's
    // prompt control only half-effective.
    expect(req.messages.every((m) => m.role === "user")).toBe(true);
    expect(req.messages[0]!.content).toContain("broken_code");
  });

  it("only sets an idempotencyKey when the caller supplied an item identity", async () => {
    complete.mockResolvedValue(modelAnswer({ verdict: "pass", score: 90, reasons: [] }));
    await reviewSubmission(ARGS);
    expect((complete.mock.calls[0]![0] as Record<string, unknown>).idempotencyKey).toBeUndefined();

    complete.mockClear();
    await reviewSubmission({ ...ARGS, idempotencySuffix: "sub_1:0", userId: "u_1" });
    const req = complete.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.idempotencyKey).toBe("submission-review:sub_1:0");
    expect(req.userId).toBe("u_1");
  });
});
