// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { normalizeMcpPublicUrl } from "./config.js";

describe("normalizeMcpPublicUrl", () => {
  it("keeps a bare origin", () => {
    expect(normalizeMcpPublicUrl("https://api.example.com")).toBe("https://api.example.com");
  });
  it("strips trailing slashes", () => {
    expect(normalizeMcpPublicUrl("https://api.example.com///")).toBe("https://api.example.com");
  });
  it("strips one trailing /mcp so the resource path is never doubled", () => {
    expect(normalizeMcpPublicUrl("https://api.example.com/mcp")).toBe("https://api.example.com");
    expect(normalizeMcpPublicUrl("https://api.example.com/mcp/")).toBe("https://api.example.com");
  });
  it("does not touch a path that merely ends in the letters mcp", () => {
    expect(normalizeMcpPublicUrl("https://api.example.com/xmcp")).toBe("https://api.example.com/xmcp");
  });
  it("keeps a non-mcp base path", () => {
    expect(normalizeMcpPublicUrl("https://api.example.com/api/")).toBe("https://api.example.com/api");
  });
});
