// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  computeLshBands,
  computeMinHashSignature,
  estimateJaccardSimilarity,
  canonicalizePayload,
  LSH_CONFIG,
} from "./dedup-lsh.js";

/**
 * Pure unit tests — no database, no network. Proves the MinHash/LSH
 * implementation actually behaves like a near-duplicate detector: identical
 * payloads band identically, near-identical payloads band mostly-identically
 * with high estimated similarity, and unrelated payloads band mostly
 * differently with low estimated similarity.
 */
describe("canonicalizePayload", () => {
  it("is independent of JSON key order", () => {
    const a = { title: "Fix off-by-one", broken_code: "for (i = 0; i <= n; i++)", fixed_code: "for (i = 0; i < n; i++)" };
    const b = { fixed_code: "for (i = 0; i < n; i++)", title: "Fix off-by-one", broken_code: "for (i = 0; i <= n; i++)" };
    expect(canonicalizePayload(a)).toBe(canonicalizePayload(b));
  });

  it("flattens nested objects/arrays and numbers/booleans", () => {
    const text = canonicalizePayload({ tags: ["bug", "loop"], meta: { severity: 3, verified: true } });
    expect(text).toContain("bug");
    expect(text).toContain("loop");
    expect(text).toContain("3");
    expect(text).toContain("true");
  });
});

describe("computeLshBands / computeMinHashSignature", () => {
  it("produces the configured number of bands and hash functions", () => {
    const bands = computeLshBands({ title: "hello world this is a real submission payload for testing" });
    expect(bands).toHaveLength(LSH_CONFIG.numBands);
    for (const band of bands) {
      expect(typeof band.bandIndex).toBe("number");
      expect(typeof band.bandHash).toBe("string");
      expect(band.bandHash.length).toBeGreaterThan(0);
    }
    const sig = computeMinHashSignature({ title: "hello world this is a real submission payload for testing" });
    expect(sig).toHaveLength(LSH_CONFIG.numHashes);
  });

  it("(a) identical payloads produce identical bands and identical signatures, regardless of key order", () => {
    const payloadA = {
      title: "Fix array sum off-by-one bug",
      broken_code: "function sum(arr) { let t = 0; for (let i = 0; i <= arr.length; i++) t += arr[i]; return t; }",
      fixed_code: "function sum(arr) { let t = 0; for (let i = 0; i < arr.length; i++) t += arr[i]; return t; }",
      prompt: "The sum function reads one element past the end of the array. Fix the loop bound.",
    };
    const payloadB = {
      fixed_code: payloadA.fixed_code,
      prompt: payloadA.prompt,
      title: payloadA.title,
      broken_code: payloadA.broken_code,
    };

    const bandsA = computeLshBands(payloadA);
    const bandsB = computeLshBands(payloadB);
    expect(bandsA).toEqual(bandsB);

    const sigA = computeMinHashSignature(payloadA);
    const sigB = computeMinHashSignature(payloadB);
    expect(sigA).toEqual(sigB);
    expect(estimateJaccardSimilarity(sigA, sigB)).toBe(1);
  });

  it("(b) near-identical payloads (one field tweaked / whitespace changed) share many bands and score high similarity", () => {
    const original = {
      title: "Fix array sum off-by-one bug",
      broken_code: "function sum(arr) { let t = 0; for (let i = 0; i <= arr.length; i++) t += arr[i]; return t; }",
      fixed_code: "function sum(arr) { let t = 0; for (let i = 0; i < arr.length; i++) t += arr[i]; return t; }",
      prompt:
        "The sum function reads one element past the end of the array because the loop uses <= instead of <. Fix the loop bound so it stops at the correct index.",
    };
    // Same content, reformatted whitespace + a trivial reworded prompt clause.
    const nearDup = {
      title: "Fix   array sum   off-by-one bug",
      broken_code: "function sum(arr) {\n  let t = 0;\n  for (let i = 0; i <= arr.length; i++) t += arr[i];\n  return t;\n}",
      fixed_code: original.fixed_code,
      prompt:
        "The sum function reads one element past the end of the array since the loop uses <= instead of <. Fix the loop bound so it stops at the correct index.",
    };

    const sigOriginal = computeMinHashSignature(original);
    const sigNearDup = computeMinHashSignature(nearDup);
    const similarity = estimateJaccardSimilarity(sigOriginal, sigNearDup);
    expect(similarity).toBeGreaterThan(0.6);

    const bandsOriginal = computeLshBands(original);
    const bandsNearDup = computeLshBands(nearDup);
    const overlapKeys = new Set(bandsOriginal.map((b) => `${b.bandIndex}:${b.bandHash}`));
    const sharedBandCount = bandsNearDup.filter((b) => overlapKeys.has(`${b.bandIndex}:${b.bandHash}`)).length;
    expect(sharedBandCount).toBeGreaterThan(0);
  });

  it("(c) genuinely different payloads share few/no bands and score low similarity", () => {
    const bugFix = {
      title: "Fix array sum off-by-one bug",
      broken_code: "function sum(arr) { let t = 0; for (let i = 0; i <= arr.length; i++) t += arr[i]; return t; }",
      fixed_code: "function sum(arr) { let t = 0; for (let i = 0; i < arr.length; i++) t += arr[i]; return t; }",
      prompt: "The sum function reads one element past the end of the array. Fix the loop bound.",
    };
    const unrelated = {
      title: "Implement debounce utility",
      broken_code: "function debounce(fn, ms) { return fn; }",
      fixed_code:
        "function debounce(fn, ms) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }; }",
      prompt: "Implement a debounce higher-order function that delays invoking fn until ms have elapsed since the last call.",
    };

    const sigA = computeMinHashSignature(bugFix);
    const sigB = computeMinHashSignature(unrelated);
    const similarity = estimateJaccardSimilarity(sigA, sigB);
    expect(similarity).toBeLessThan(0.3);

    const bandsA = computeLshBands(bugFix);
    const bandsB = computeLshBands(unrelated);
    const keysA = new Set(bandsA.map((b) => `${b.bandIndex}:${b.bandHash}`));
    const sharedBandCount = bandsB.filter((b) => keysA.has(`${b.bandIndex}:${b.bandHash}`)).length;
    expect(sharedBandCount).toBe(0);
  });

  it("handles empty/degenerate payloads without throwing", () => {
    expect(() => computeLshBands({})).not.toThrow();
    expect(() => computeLshBands(null)).not.toThrow();
    expect(() => computeLshBands({ a: "" })).not.toThrow();
    const sig = computeMinHashSignature({});
    expect(sig).toHaveLength(LSH_CONFIG.numHashes);
  });
});
