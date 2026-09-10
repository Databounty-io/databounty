// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `services/llm/consumers/validate-field.ts` — the deterministic gibberish
 * pre-filter and, more importantly, the FAIL-CLOSED contract.
 *
 * The LLM service is mocked so these are pure unit tests: no provider egress,
 * no database, and no dependence on whether an API key happens to be set in
 * the environment the suite runs in.
 */
const complete = vi.fn();
vi.mock("../service.js", () => ({ llm: { complete } }));

const { looksLikeGibberish, maskLooksMashed, validateSponsorField, defaultRejectReason } = await import(
  "./validate-field.js"
);

beforeEach(() => {
  complete.mockReset();
});

describe("looksLikeGibberish — titles and languages (strict)", () => {
  it("rejects empty and whitespace-only values", () => {
    expect(looksLikeGibberish("title", "")).toBe(true);
    expect(looksLikeGibberish("title", "   ")).toBe(true);
  });

  it("rejects the literal placeholder set, case- and punctuation-insensitively", () => {
    for (const value of ["test", "TEST", "test123", "asdf", "qwerty", "n/a", "TBD", "foobar", "aaa"]) {
      expect(looksLikeGibberish("title", value), value).toBe(true);
    }
    // `collapsed` strips non-alphanumerics, so decorated placeholders still hit.
    expect(looksLikeGibberish("title", "t.e.s.t")).toBe(true);
  });

  it("rejects a repeated short cycle", () => {
    expect(looksLikeGibberish("title", "asdasdasd")).toBe(true); // "asd" x3
    expect(looksLikeGibberish("title", "ababab")).toBe(true); // "ab" x3
    expect(looksLikeGibberish("title", "abcabcabcabc")).toBe(true); // "abc" x4
  });

  it("does NOT fire on a cycle repeated only twice — the check needs three", () => {
    // Deliberate: two repeats is common in real names ("Nono", "Papa"), so the
    // tuned threshold is three. Documented here so a future tightening is a
    // conscious decision rather than an accident.
    expect(looksLikeGibberish("title", "abab")).toBe(false);
  });

  it("rejects a long single token with no vowel", () => {
    expect(looksLikeGibberish("title", "jkhgfds")).toBe(true);
  });

  it("accepts real, even terse, titles and languages", () => {
    for (const value of [
      "Python Bug Fixes",
      "React hook migrations",
      "SQL query optimisation corpus",
      "Rust",
      "TypeScript · React",
    ]) {
      expect(looksLikeGibberish("title", value), value).toBe(false);
    }
    expect(looksLikeGibberish("language", "Python")).toBe(false);
    expect(looksLikeGibberish("language", "Go")).toBe(false); // <4 letters: not judged
  });
});

describe("looksLikeGibberish — descriptions and briefs (lenient by design)", () => {
  it("accepts a terse but real prose description", () => {
    expect(looksLikeGibberish("description", "Fix off-by-one loop bugs.")).toBe(false);
    // Prose is only judged when it is BOTH very short and space-free.
    expect(looksLikeGibberish("description", "short but real text")).toBe(false);
  });

  it("still rejects a mashed short description", () => {
    expect(looksLikeGibberish("description", "asdasdasd")).toBe(true);
  });

  it("accepts a terse multi-word brief without penalising brevity", () => {
    expect(looksLikeGibberish("brief", "add a difficulty label, drop the rationale")).toBe(false);
  });

  it("rejects a brief that reads as mashed even with spaces", () => {
    // Whitespace is collapsed before judging, so spacing out a mash does not
    // launder it: "asd asd asd" -> "asdasdasd".
    expect(looksLikeGibberish("brief", "asd asd asd")).toBe(true);
  });

  it("is more lenient for a brief than for a title on the same value", () => {
    expect(looksLikeGibberish("title", "qwerty")).toBe(true); // placeholder list
    expect(looksLikeGibberish("brief", "qwerty")).toBe(false); // no placeholder list for prose
  });
});

describe("maskLooksMashed", () => {
  it("does not judge strings with fewer than four letters", () => {
    expect(maskLooksMashed("ab")).toBe(false);
    expect(maskLooksMashed("go")).toBe(false);
  });

  it("fires on low character variety at or below the 0.34 ratio", () => {
    expect(maskLooksMashed("aaaaab")).toBe(true); // 2/6 = 0.33
    expect(maskLooksMashed("aaaaaab")).toBe(true); // 2/7 = 0.29
  });

  it("does not fire just above the ratio", () => {
    expect(maskLooksMashed("aaaab")).toBe(false); // 2/5 = 0.40
  });
});

describe("validateSponsorField — fail-closed contract", () => {
  it("returns ok:false with the review-unavailable reason when the layer fell back", async () => {
    // A fallback verdict of "ok" must NEVER be surfaced as a pass.
    complete.mockResolvedValue({
      data: { verdict: "ok", reason: "" },
      provider: "fallback",
      model: "deterministic",
      usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
      fallbackUsed: true,
      failoverUsed: false,
    });
    const result = await validateSponsorField("title", "A Genuinely Real Dataset Title");
    expect(result.ok).toBe(false);
    expect(result.source).toBe("fallback");
    expect(result.reason).toContain("AI review is currently unavailable");
  });

  it("still returns ok:false on the fallback path for junk (never a silent pass either way)", async () => {
    complete.mockResolvedValue({
      data: { verdict: "reject", reason: "placeholder" },
      provider: "fallback",
      model: "deterministic",
      usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
      fallbackUsed: true,
      failoverUsed: false,
    });
    const result = await validateSponsorField("title", "asdasdasd");
    expect(result).toEqual({
      ok: false,
      reason:
        "AI review is currently unavailable. This answer is saved as a draft and needs review before you can continue.",
      source: "fallback",
    });
  });

  it("passes the deterministic pre-filter verdict to the layer as the caller-owned fallback", async () => {
    complete.mockResolvedValue({
      data: { verdict: "ok", reason: "" },
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      usage: { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 },
      fallbackUsed: false,
      failoverUsed: false,
    });
    await validateSponsorField("title", "asdasdasd");
    const req = complete.mock.calls[0]![0] as { feature: string; fallback: { verdict: string } };
    expect(req.feature).toBe("field_validate");
    expect(req.fallback.verdict).toBe("reject");
  });

  it("reports source:'llm' only when a live model answered", async () => {
    complete.mockResolvedValue({
      data: { verdict: "ok", reason: "" },
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      usage: { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 },
      fallbackUsed: false,
      failoverUsed: false,
    });
    const result = await validateSponsorField("description", "Real prose about the dataset.");
    expect(result).toEqual({ ok: true, reason: "", source: "llm" });
  });

  it("substitutes the per-field default reason when a live reject carries no reason", async () => {
    complete.mockResolvedValue({
      data: { verdict: "reject", reason: "   " },
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      usage: { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 },
      fallbackUsed: false,
      failoverUsed: false,
    });
    const result = await validateSponsorField("language", "zzzz");
    expect(result.ok).toBe(false);
    expect(result.source).toBe("llm");
    expect(result.reason).toBe(defaultRejectReason("language"));
  });

  it("never rewrites the submitted value — only a verdict is returned", async () => {
    complete.mockResolvedValue({
      data: { verdict: "reject", reason: "try 'Python Bug Fixes'" },
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      usage: { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 },
      fallbackUsed: false,
      failoverUsed: false,
    });
    const result = await validateSponsorField("title", "asdf");
    expect(Object.keys(result).sort()).toEqual(["ok", "reason", "source"]);
  });
});
