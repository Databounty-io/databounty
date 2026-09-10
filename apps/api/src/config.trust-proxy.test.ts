// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "./config.js";

describe("parseTrustProxy", () => {
  it("treats unset, empty, false and 0 as no proxy", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("  ")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
    expect(parseTrustProxy("0")).toBe(false);
  });

  it("keeps the literal true", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("TRUE")).toBe(true);
  });

  it("preserves a hop count as a number — the deploy script's TRUST_PROXY=2 must not become false", () => {
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy(" 1 ")).toBe(1);
    expect(parseTrustProxy("10")).toBe(10);
  });

  it("passes an address allowlist through as a string", () => {
    expect(parseTrustProxy("loopback, 10.0.0.0/8")).toBe("loopback, 10.0.0.0/8");
    expect(parseTrustProxy("127.0.0.1")).toBe("127.0.0.1");
  });

  it("never returns a bare boolean true for a numeric value", () => {
    // `Boolean("2")` is true — the exact bug this parser replaces.
    expect(parseTrustProxy("2")).not.toBe(true);
  });
});
