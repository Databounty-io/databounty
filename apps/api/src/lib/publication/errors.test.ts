// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PublicationError, isPermanentStatus } from "./errors.js";

describe("isPermanentStatus", () => {
  it("treats 4xx (except 429) as permanent", () => {
    expect(isPermanentStatus(400)).toBe(true);
    expect(isPermanentStatus(401)).toBe(true);
    expect(isPermanentStatus(404)).toBe(true);
    expect(isPermanentStatus(422)).toBe(true);
    expect(isPermanentStatus(499)).toBe(true);
  });

  it("treats 429 (rate limit) as transient, not permanent", () => {
    expect(isPermanentStatus(429)).toBe(false);
  });

  it("treats 5xx as transient", () => {
    expect(isPermanentStatus(500)).toBe(false);
    expect(isPermanentStatus(503)).toBe(false);
  });

  it("treats 2xx/3xx as not permanent (not an error status at all)", () => {
    expect(isPermanentStatus(200)).toBe(false);
    expect(isPermanentStatus(302)).toBe(false);
  });
});

describe("PublicationError", () => {
  it("carries the permanent flag and a normal Error message/name", () => {
    const err = new PublicationError("bad token", true);
    expect(err.permanent).toBe(true);
    expect(err.message).toBe("bad token");
    expect(err.name).toBe("PublicationError");
    expect(err).toBeInstanceOf(Error);
  });
});
