// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { e2bSdkResolvable } from "./e2b-sdk.js";

describe("e2bSdkResolvable", () => {
  it("accepts a loader that can initialise E2B", () => {
    const load = vi.fn(() => ({ Sandbox: {} }));

    expect(e2bSdkResolvable(load)).toBe(true);
    expect(load).toHaveBeenCalledWith("e2b");
  });

  it("rejects a package whose transitive dependency cannot load", () => {
    const load = vi.fn(() => {
      throw new Error("Cannot find module '@connectrpc/connect'");
    });

    expect(e2bSdkResolvable(load)).toBe(false);
  });
});
