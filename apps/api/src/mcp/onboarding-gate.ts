// SPDX-License-Identifier: Apache-2.0

import { McpToolError } from "./core/errors.js";
import { prisma } from "../lib/prisma.js";

/**
 * Onboarding gate for MCP tool calls.
 *
 * The dashboard refuses to let an un-onboarded account do anything. MCP had no
 * equivalent, so an agent could submit work for an operator who had never
 * claimed a handle — and the handle is what published dataset credit is
 * attributed to, so that work shipped with nobody's name on it. This closes
 * that asymmetry.
 *
 * Deliberately enforced HERE, at the single MCP tool-call choke point, and not
 * on the REST routes: the UI enforces in the UI, MCP enforces in MCP, one
 * choke point per surface, each honest about its own contract.
 *
 * Scope of the block: tools that CREATE or JUDGE work. Reads, file handling,
 * notifications and the account/onboarding tools themselves stay open — an
 * agent must be able to see what is available, explain the situation, and fix
 * it without being locked out of the very tools that unblock it.
 */
const REQUIRES_ONBOARDING = new Set([
  "submit_pool_items",
  "revise_submission",
  "rerun_submission_validation",
  "dispute_submission",
  "dispute_accepted_submission",
  "claim_audit",
  "submit_decisions",
  "create_upload_review_link",
  // Deliberately ABSENT: report_issue / reply_to_issue. A broken onboarding is
  // exactly the kind of platform defect this channel exists to hear about, so
  // gating the report on completing onboarding would silence the reports that
  // matter most. Reporting creates no work and judges none.
]);

export function toolRequiresOnboarding(toolName: string): boolean {
  return REQUIRES_ONBOARDING.has(toolName);
}

/** Short-lived cache so a bulk submit does not re-read the row per call. Keyed
 *  on user; only ever caches the TRUE result, because a just-completed
 *  onboarding must take effect immediately rather than after a TTL. */
const onboardedUntil = new Map<string, number>();
const CACHE_TTL_MS = 60_000;

export type OnboardingLookup = (userId: string) => Promise<{ onboarded: boolean; handle: string | null } | null>;

const lookupFromDatabase: OnboardingLookup = (userId) =>
  prisma.user.findUnique({ where: { id: userId }, select: { onboarded: true, handle: true } });

/** Test seam only. Production always uses the database lookup. */
export function resetOnboardingCache(): void {
  onboardedUntil.clear();
}

export async function assertOnboardedForTool(
  userId: string | undefined,
  toolName: string,
  lookupOnboarding: OnboardingLookup = lookupFromDatabase,
): Promise<void> {
  if (!toolRequiresOnboarding(toolName)) return;
  if (!userId) {
    throw new McpToolError(
      "The MCP transport could not identify the calling account; refusing work until identity is available.",
      401,
    );
  }

  const cached = onboardedUntil.get(userId);
  if (cached && cached > Date.now()) return;

  const row = await lookupOnboarding(userId);
  if (row?.onboarded && row.handle) {
    onboardedUntil.set(userId, Date.now() + CACHE_TTL_MS);
    return;
  }

  // 428 Precondition Required, deliberately NOT 403: the hosted transport turns
  // a 403 into an OAuth `insufficient_scope` challenge, and this is not a scope
  // problem — re-authorizing with more scopes would not fix it. 428 falls
  // through to the plain error result the agent can act on.
  throw new McpToolError(
    `Account setup is not finished, so ${toolName} is unavailable. ` +
      (row?.handle
        ? "Call complete_onboarding to finish — it takes no input and asks nothing further."
        : "Ask the operator which public handle they want — that is the only question setup asks — then call claim_handle and complete_onboarding.") +
      " The handle becomes their public profile and the name every published dataset credit is attributed to, so work submitted before setup would ship with no name on it. " +
      "This needs the `account` scope; if the credential lacks it, the operator can finish setup in the dashboard instead.",
    428,
  );
}
