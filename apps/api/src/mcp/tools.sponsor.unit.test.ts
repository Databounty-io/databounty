// SPDX-License-Identifier: Apache-2.0

/**
 * Registration and gate coverage for the two requester ("sponsor") MCP tools:
 * `get_sponsor_submission_evidence` and `dispute_accepted_submission`.
 *
 * Before these landed, the Community MCP server exposed no tool under the
 * `sponsor` scope even though the scope existed on API keys and OAuth grants
 * (`ApiKeyScope.sponsor`, `MCP_SCOPES`) and the REST routes were gated on it.
 * These checks pin:
 *
 *  1. both tools are registered, under scope `sponsor`, with the schema the
 *     REST routes accept (reason enum = `FlagReason`, argument 10..2000);
 *  2. `assertToolAllowed` (mcp/tool-gate.ts) refuses a credential that lacks
 *     the `sponsor` scope with a 403, and refuses an anonymous caller with a
 *     401 — the same order every other scoped tool follows;
 *  3. a credential carrying `sponsor` clears the scope gate for the read tool
 *     (which needs no verified-email/onboarding lookup, so no database here);
 *  4. the write tool is listed as onboarding-gated, matching the dashboard.
 *
 * No database: nothing here reaches the service layer. The behaviour of the
 * tools' `call` against real rows is covered by
 * services/sponsor-evidence.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { FlagReason } from "@prisma/client";
import { tools } from "./tools.js";
import { assertToolAllowed } from "./tool-gate.js";
import { toolRequiresOnboarding } from "./onboarding-gate.js";
import { McpToolError } from "./core/errors.js";
import { MCP_SCOPES } from "../services/mcp-oauth.js";

const evidenceTool = tools.find((t) => t.name === "get_sponsor_submission_evidence");
const disputeTool = tools.find((t) => t.name === "dispute_accepted_submission");

async function gateError(fn: () => Promise<void>): Promise<McpToolError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(McpToolError);
    return err as McpToolError;
  }
  throw new Error("expected the gate to refuse");
}

describe("sponsor-scoped MCP tools", () => {
  it("registers both tools under the sponsor scope, which OAuth grants can carry", () => {
    expect(evidenceTool).toBeDefined();
    expect(disputeTool).toBeDefined();
    expect(evidenceTool!.scope).toBe("sponsor");
    expect(disputeTool!.scope).toBe("sponsor");
    expect(MCP_SCOPES).toContain("sponsor");
    expect(tools.filter((t) => t.scope === "sponsor").map((t) => t.name).sort()).toEqual([
      "dispute_accepted_submission",
      "get_sponsor_submission_evidence",
    ]);
    // Names are unique across the whole registry.
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("get_sponsor_submission_evidence accepts the route's query shape", () => {
    const schema = evidenceTool!.schema;
    expect(schema.safeParse({ bountyId: "b1" }).success).toBe(true);
    expect(schema.safeParse({ bountyId: "b1", page: 2, pageSize: 100, status: "accepted", search: "x" }).success).toBe(true);
    expect(schema.safeParse({ bountyId: "b1", page: 0 }).success).toBe(false);
    expect(schema.safeParse({ bountyId: "b1", pageSize: 101 }).success).toBe(false);
    expect(schema.safeParse({ bountyId: "b1", pageSize: 1.5 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("dispute_accepted_submission accepts exactly the route's body shape", () => {
    const schema = disputeTool!.schema;
    for (const reason of Object.values(FlagReason)) {
      expect(schema.safeParse({ submissionId: "s1", reason, argument: "ten chars!" }).success).toBe(true);
    }
    expect(schema.safeParse({ submissionId: "s1", reason: "not_a_reason", argument: "ten chars!" }).success).toBe(false);
    // Same 10..2000 bounds as `disputeAcceptanceBody` in routes/v1/submissions.ts.
    expect(schema.safeParse({ submissionId: "s1", reason: "low_quality", argument: "short" }).success).toBe(false);
    expect(schema.safeParse({ submissionId: "s1", reason: "low_quality", argument: "x".repeat(2001) }).success).toBe(false);
    expect(schema.safeParse({ submissionId: "s1", reason: "low_quality", argument: "x".repeat(2000) }).success).toBe(true);
  });

  it("the gate refuses a credential without the sponsor scope (403) and an anonymous caller (401)", async () => {
    for (const tool of [evidenceTool!, disputeTool!]) {
      const missing = await gateError(() => assertToolAllowed(tool, { userId: "u1", scopes: ["read", "contribute", "validate", "artifact", "account"] }));
      expect(missing.status).toBe(403);
      expect(missing.message).toContain("sponsor");

      const anonymous = await gateError(() => assertToolAllowed(tool, {}));
      expect(anonymous.status).toBe(401);
    }
  });

  it("the gate lets a sponsor-scoped credential through to the evidence tool", async () => {
    await expect(assertToolAllowed(evidenceTool!, { userId: "u1", scopes: ["sponsor"] })).resolves.toBeUndefined();
  });

  it("the dispute tool is onboarding-gated like every other work-judging tool", () => {
    expect(toolRequiresOnboarding("dispute_accepted_submission")).toBe(true);
    expect(toolRequiresOnboarding("get_sponsor_submission_evidence")).toBe(false);
  });
});
