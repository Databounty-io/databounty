// SPDX-License-Identifier: Apache-2.0

import { McpToolError } from "./core/errors.js";
import { PUBLIC_SCOPE, type McpTool } from "./core/contract.js";
import { assertOnboardedForTool } from "./onboarding-gate.js";
import { prisma } from "../lib/prisma.js";

/**
 * The single authorization choke point for an MCP tool call, shared by EVERY
 * transport this service mounts (the legacy `POST /mcp/call` pair and the
 * JSON-RPC streamable-HTTP endpoint alike).
 *
 * It exists because Community's MCP tools are NOT thin adapters over the REST
 * routes the way v1's are — they call the service layer in-process. That makes
 * this the ONLY place the REST preHandler chain's guarantees can be restated,
 * so a check written per-transport would silently protect one surface and not
 * the other.
 *
 * Order matters and is part of the contract:
 *   1. credential required        — 401, unless the tool is genuinely public
 *   2. scope enforcement          — 403, mirrors lib/rbac.ts requireScope
 *   3. verified email             — 403, mirrors requireVerifiedEmail
 *   4. onboarding precondition    — 428, MCP-only (the dashboard gates in UI)
 */

export interface McpCallerIdentity {
  userId?: string;
  /**
   * Scopes carried by the credential, or `undefined` for a full dashboard
   * session — which is not scope-limited, exactly as `lib/rbac.ts`
   * `requireScope` treats a session (`user.apiKeyScopes` unset).
   */
  scopes?: string[];
}

/**
 * Tools whose REST counterpart carries `requireVerifiedEmail`. Because MCP
 * tools bypass the route preHandlers entirely, without this list an account
 * that never verified its email could submit dataset items and cast validator
 * verdicts through MCP while being refused both over REST.
 *
 * Kept as an explicit list rather than derived from scope: `contribute` also
 * covers reads that REST does not gate, and silently widening the gate would
 * lock accounts out of tools the dashboard lets them use.
 */
const REQUIRES_VERIFIED_EMAIL = new Set([
  // routes/v1/submissions.ts POST / , POST /bulk , routes/v1/bounties.ts POST /:id/items
  "submit_pool_items",
  // routes/v1/submissions.ts POST /:id/revise
  "revise_submission",
  // routes/v1/submissions.ts POST /:id/rerun-validation
  "rerun_submission_validation",
  // routes/v1/submissions.ts POST /:id/dispute
  "dispute_submission",
  // routes/v1/upload-review-drafts.ts POST /
  "create_upload_review_link",
  // routes/v1/audits.ts POST /:id/decisions
  "submit_decisions",
  // routes/v1/issues.ts POST /:id/reply
  "reply_to_issue",
  // routes/v1/submissions.ts POST /:id/dispute-acceptance (requireVerifiedEmail)
  "dispute_accepted_submission",
  // routes/v1/audits.ts POST /:id/claim (requireVerifiedEmail)
  "claim_audit",
  // routes/v1/artifacts.ts — every upload-lifecycle route carries
  // requireVerifiedEmail. Without these an unverified account could upload
  // and assemble files through MCP while being refused over REST.
  "prepare_file_upload",
  "complete_file_upload",
  "prepare_large_file_upload",
  "complete_large_file_upload",
  "abort_large_file_upload",
  // routes/v1/artifacts.ts DELETE /:id (requireVerifiedEmail). Found missing
  // during the Pass-3 MCP tool audit (2026-09-08): every other artifact
  // lifecycle route above was already listed, but this one was not, so an
  // unverified account could delete its own artifacts through MCP's
  // `delete_file` while the identical REST call would be refused with 403.
  "delete_file",
  // routes/v1/me.ts POST /handle (requireVerifiedEmail) — the handle is the
  // operator's public identity and what published dataset credit attaches to.
  "claim_handle",
]);

export function toolRequiresVerifiedEmail(toolName: string): boolean {
  return REQUIRES_VERIFIED_EMAIL.has(toolName);
}

async function assertVerifiedEmail(userId: string, toolName: string): Promise<void> {
  if (!REQUIRES_VERIFIED_EMAIL.has(toolName)) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
  if (user?.emailVerifiedAt) return;
  throw new McpToolError(
    `${toolName} needs a verified email address. Call resend_email_verification, then open the link that arrives ` +
      "before retrying — nothing was submitted.",
    403,
    "email_unverified",
  );
}

/**
 * Throws an `McpToolError` when this caller may not run this tool. Returns
 * normally — and only then — when every gate above has passed.
 */
export async function assertToolAllowed(tool: McpTool, caller: McpCallerIdentity): Promise<void> {
  if (tool.scope === PUBLIC_SCOPE) return;

  if (!caller.userId) {
    throw new McpToolError(
      `Authentication required: ${tool.name} needs a credential carrying the \`${tool.scope}\` scope.`,
      401,
    );
  }
  if (caller.scopes && !caller.scopes.includes(tool.scope)) {
    throw new McpToolError(`This credential is missing the required scope: ${tool.scope}`, 403);
  }
  await assertVerifiedEmail(caller.userId, tool.name);
  await assertOnboardedForTool(caller.userId, tool.name);
}
