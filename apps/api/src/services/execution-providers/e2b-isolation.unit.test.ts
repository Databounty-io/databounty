// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { verifyIsolation } from "./e2b.js";

const blockedPosture = { egress: "blocked" as const, allowlist: [] };

describe("verifyIsolation VM-size attestation", () => {
  it("fails closed when E2B omits the vCPU count", async () => {
    const sandbox = {
      getInfo: vi.fn().mockResolvedValue({ memoryMB: 2048, allowInternetAccess: false }),
    };

    await expect(verifyIsolation(sandbox as never, blockedPosture)).rejects.toThrow(
      "provider did not report sandbox vCPU count"
    );
  });

  it("fails closed when E2B omits the memory limit", async () => {
    const sandbox = {
      getInfo: vi.fn().mockResolvedValue({ cpuCount: 2, allowInternetAccess: false }),
    };

    await expect(verifyIsolation(sandbox as never, blockedPosture)).rejects.toThrow(
      "provider did not report sandbox memory limit"
    );
  });
});
