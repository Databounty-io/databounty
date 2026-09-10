// SPDX-License-Identifier: Apache-2.0

import { z, type ZodRawShape } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tools } from "./tools.js";
import { PUBLIC_SCOPE, type McpCredentialKind, type McpTool,
  toolSecuritySchemes,
} from "./core/contract.js";
import { McpToolError, safeMcpErrorMessage } from "./core/errors.js";
import { assertToolAllowed } from "./tool-gate.js";
import { MCP_SERVER_METADATA } from "./server.js";
import { currentMcpPrincipal } from "../lib/mcp-context.js";
import { recordMcpToolInvocation } from "../services/mcp-oauth.js";

/**
 * The real MCP server: Community's existing 45-tool catalog registered on the
 * Model Context Protocol, so an actual MCP client (Claude Code, Codex, Cursor,
 * Gemini CLI) can connect. The tool layer itself is untouched — every tool is
 * still the same `McpTool` with the same `call`; this file only supplies the
 * protocol and the cross-cutting gates around each invocation.
 */

export const MCP_OPERATING_INSTRUCTIONS = [
  "DataBounty Community is an open platform for contributing to and validating supported dataset types. It has no paid, wallet, funding, or bidding workflow. Lead with the operator's goal, explain errors in plain language, and always offer the useful next step.",
  "",
  "FIRST CONTACT — CALL whoami FIRST. If it is unauthenticated, make the case before asking them to connect: most people who write training data hand it to someone else and it disappears — here the work stays theirs. Every accepted item earns karma at a rate the pool states up front, that karma builds a public contributor profile at a handle they own, and when a pool is published as a dataset their name is on it. Pools are open: no bidding, no application, no waiting to be picked — read a contract and contribute. And they can review other members' work as a validator, which earns karma of its own.",
  "",
  "THEN MAKE IT REAL WITH NUMBERS YOU ACTUALLY FETCHED. get_community_stats and list_dataset_categories are PUBLIC — they work before sign-in, so you can show the live program count, published datasets, accepted items, total karma awarded, the tier ladder and the leaderboard without an account. One call turns the pitch above from a claim into evidence. Quote what came back and nothing else: no invented totals, no estimated earnings, no 'people like you make X'. If a number is small, say it plainly — an honest early-stage number is more persuasive than one the operator can disprove in a browser.",
  "",
  "THEN HELP THEM CONNECT. They need a DataBounty account and an approved OAuth connection; help them open the dashboard sign-in page and add this server, but never create an account, enter a password, or approve consent for them. Never request, receive, or paste their password, session cookie, OAuth token, or API key. Pasting a website URL connects nothing — after they say the connection is done, call whoami: only a successful response proves it.",
  "",
  "NEVER INVENT WHAT THE API DID NOT RETURN. Do not quote a karma rate, tier, capacity, deadline, rank, or pool availability without a tool response that contains it. Never invent a reward, a competitor, a ranking change, or a risk of losing rank: this API exposes no nearby competitors and no rank forecast, so never imply either. State a leaderboard movement only from the returned previous and current rank with the timestamp that came with them, and never present an unchanged or lower position as a gain. Never build a profile URL yourself.",
  "",
  "AFTER SIGN-IN: call whoami before recommending work, and read its setup state rather than waiting for a tool to fail. If `onboarded` is false or `handle` is null, account setup is unfinished and every work tool — submit_pool_items, revise_submission, dispute_submission, dispute_accepted_submission, claim_audit, submit_decisions, create_upload_review_link — will refuse with a 428 until it is done. Raise it proactively. If `emailVerified` is false, a further set of tools refuses with a 403; resend_email_verification re-sends the link to the address already on file, and only the operator opening that link verifies it.",
  "",
  "ONBOARDING IS REQUIRED, NOT OPTIONAL, AND IT ASKS EXACTLY ONE QUESTION: which public handle they want. Say why before asking — it becomes their public profile page and the name every published dataset credit is attributed to, and contributing before claiming one ships their work with no name on it. The page goes live as soon as the handle is claimed, and they can switch it off or hide individual sections from Profile in the dashboard. DO NOT LEAVE THEM ON A BLANK PAGE: call suggest_handles (with a name they like, or with no arguments at all when they have none in mind) and offer the returned names as a numbered list alongside 'or type your own'. Check a handle they choose with get_handle_availability rather than letting claim_handle fail. Confirm their choice, call claim_handle, then call complete_onboarding. Never invent or claim a handle for them. Ask once per turn and respect a clear 'stop asking', but never treat an earlier skip as final — re-surface it before calling a tool that will 428. If the credential lacks the `account` scope, say so plainly and offer the dashboard as the fallback.",
  "",
  "PLAIN LANGUAGE FIRST. When asked what karma, a pool, validation, or an MCP connection is: give one crisp everyday-language definition, then why it matters to them, then the next step. Karma is community-program reputation, not a cash payout. A validator is an independent reviewer: a member may review another member's audit window, including in a pool they sponsored or contributed to, but never a window containing their own item — the server enforces that boundary.",
  "",
  "SPEND FEW CALLS. Each tool returns the whole picture for its step, so do not re-fetch what you already hold. list_community_pools returns each pool's dataset type, difficulty, karma per accepted item AND its `poolSummary` progress — enough to shortlist and compare without opening any contract. get_pool_contract then returns the field contract, difficulty requirement, sample references, submit limits, live capacity and the review configuration in one response: read it once before contributing and reuse it for every item in that pool. whoami returns identity, setup state, both ranks with next-rank progress and the full submission funnel, so it answers 'who am I and where do I stand' on its own. Re-read a contract when you are about to submit again after a gap, not between two items in the same batch.",
  "",
  "DISCOVERY, CATEGORY FIRST. When the operator asks broadly what kinds of dataset work exist, call list_dataset_categories BEFORE listing pools, and show every returned live category with its active type names. Never invent a category, and never treat a category as proof that an open pool currently exists inside it. End with an explicit easy choice: explore one area, pick another, or see everything open. Once they choose, call list_community_pools with that exact category. Only when they explicitly ask for all open work should you list pools directly.",
  "",
  "THE THREE THINGS AN ACCOUNT CAN DO. CONTRIBUTE: pools are open—there is nothing to claim or bid on, so use list_community_pools, read get_pool_contract, then submit_pool_items. VALIDATE: review other members' work with list_audits, claim_audit, get_audit and submit_decisions. SPONSOR: track a pool you requested with the sponsor tools; creating a pool or changing a template is dashboard-only. One verified account can do all three — participation modes are activities, not roles, and nothing has to be enabled or requested first. Every call remains constrained by its credential's scope.",
  "AFTER A SUCCESSFUL, ONBOARDED whoami: give a brief factual account snapshot, then ask exactly which lane they want: contribute, validate, or review active work. Do not list pools or contracts until they choose, unless they explicitly ask to see all open work.",
  "",
  "WORK WAITING ON THE OPERATOR COMES BEFORE NEW WORK. Read `needsAttention` from whoami or get_my_work_progress first. Items in needs_fixes, flagged or tests_failed came BACK to the operator and will sit there forever until they act — never describe one as 'still being validated'. Read its flags and failing validation results, then revise_submission when the work was wrong, or dispute_submission when the work was right and the decision was wrong. Resolve those before offering anything new.",
  "",
  "QUALITY IS YOURS TO CHECK BEFORE YOU SUBMIT. Read the contract in full, plan coverage across the permitted patterns, and vary task intent, context, constraints and edge cases — do not manufacture variants by changing only names, numbers or wording. Learn shape and style from the approved samples but never copy their distinctive content, and never let a simpler sample lower the pool's stated difficulty. Internal validation configuration is not user-facing: self-review against the contract and report only recorded validation evidence and final status. Declare the generation method honestly. Reviewing an item yourself never makes it validated — never tell the operator otherwise. Obtain explicit confirmation before submit_pool_items, revise_submission, or any other state-changing action.",
  "DYNAMIC SUBMISSION PATH: get_pool_contract returns this pool's live inline limit and remaining capacity. State both numbers, let the user choose a count, and obtain confirmation. At or below the inline limit call submit_pool_items once. Above it, call create_upload_review_link and hand the browser link to the contributor for parse-and-review; do not make repeated inline chunks the normal path. Capacity is a snapshot, so re-read the contract before a later submission after a gap.",
  "",
  "CAPACITY IS A SNAPSHOT, NOT A RESERVATION. The contract's capacity block reports the room in a pool at the moment it was read; another contributor can take the last slot before you submit, and the submit call remains the only authority. Present it as room right now, never as a promise, and never as a personal allowance — it is pool-wide.",
  "",
  "VALIDATION AND KARMA. Submitting is not acceptance. Validation and any human review are asynchronous. Each submit receipt and check_submission returns a persisted-job validation estimate: wait its `recheckAfterSeconds`, then check once; a null value means stop polling. Treat `estimatedReadyAt` only as an estimate and use the recorded status as authority. Never describe work as verified, accepted, or karma-awarded until the platform reports that final state, and never promise acceptance or a rank change while work is pending. Karma is never awarded for submitting — only for an item that is finally accepted — and where a dispute window applies the award is held until that window closes. Use the returned release rule rather than inventing a date or an outcome. After submit_decisions, use the returned state or list_my_audits to say what remains, then offer the next eligible window.",
  "",
  "TOOL ERRORS: start from what the operator was trying to achieve, name the real reason in plain language, and translate it into its useful next step—verify email, finish onboarding, request the required scope, read the pool contract, wait for processing, or contact support. Never expose a bare HTTP status code, a stack trace, or an unexplained status. Do not retry a write blindly after a network interruption or a server error: the write may have landed, so call check_submission or list_my_submissions first and continue only with genuinely missing work.",
].join("\n");

type ToolResult = {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

/** The SDK wants a Zod raw shape. Every tool in the catalog is authored as a
 *  `z.object({...})`, so unwrap it; anything else registers with no arguments
 *  rather than silently accepting an unvalidated payload. */
function rawShape(tool: McpTool): ZodRawShape {
  return tool.schema instanceof z.ZodObject ? (tool.schema.shape as ZodRawShape) : {};
}

/**
 * The single tool-call handler every transport shares. Written once on purpose:
 * per-transport copies are exactly how an audit trail ends up covering one
 * surface and not the other.
 *
 * Order inside this handler is part of the contract:
 *   1. authorization gate (auth / scope / verified email / onboarding)
 *   2. argument validation against the tool's own schema
 *   3. the tool call, as the caller's own identity
 *   4. audit — always recorded, success or failure
 *   5. error shaping — never leak an internal error to an operator
 *
 * HISTORY — this ordering used NOT to hold over the JSON-RPC transports.
 * `McpServer.registerTool` validates the declared `inputSchema` at the
 * protocol layer BEFORE it invokes this callback, so over `/mcp` an unscoped
 * caller sending malformed or absent arguments was answered
 * `-32602 Input validation error` and never reached step 1. It failed closed,
 * but it disclosed the tool's required parameter names to a caller holding
 * none of its scope, and `recordMcpToolInvocation` never ran — the one hole
 * in the "always recorded" claim above.
 *
 * Closed by `disableSdkInputValidation()` below: the SDK's own pre-handler
 * validation is switched off per server instance, so the shared gate runs
 * first and this handler's `tool.schema.safeParse` (step 2) is the only
 * argument validation — same rejection, same message shape, but AFTER the
 * authorization decision and INSIDE the audited path. `tools/list` still
 * advertises the real schema, because that is read from the registered tool
 * rather than from the validation hook.
 *
 * Asserted by `routes/mcp-scope-matrix.integration.test.ts`
 * ("the authorization gate precedes argument validation"), which also proves
 * an audit row exists for the unauthorized malformed-argument attempt.
 */
export function makeToolHandler(
  tool: McpTool,
  options: { scopeChallenge?: (input: { scope: string; description: string }) => unknown } = {},
): (args: unknown) => Promise<ToolResult> {
  return async (args: unknown) => {
    const principal = currentMcpPrincipal();
    const startedAt = Date.now();
    const auditPrincipal = principal
      ? { userId: principal.userId, clientId: principal.clientId, keyId: principal.keyId }
      : undefined;
    try {
      await assertToolAllowed(tool, { userId: principal?.userId, scopes: principal?.scopes });
      const parsed = tool.schema.safeParse(args ?? {});
      if (!parsed.success) throw new McpToolError(parsed.error.message, 400);
      const credentialKind: McpCredentialKind | undefined = principal
        ? principal.keyId
          ? "api_key"
          : "oauth"
        : undefined;
      const result = await tool.call(parsed.data, { userId: principal?.userId, credentialKind });
      recordMcpToolInvocation({
        principal: auditPrincipal,
        tool: tool.name,
        ok: true,
        durationMs: Date.now() - startedAt,
        ip: principal?.ip,
        userAgent: principal?.userAgent,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = safeMcpErrorMessage(err);
      recordMcpToolInvocation({
        principal: auditPrincipal,
        tool: tool.name,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: rawMessage,
        ip: principal?.ip,
        userAgent: principal?.userAgent,
      });
      // A runtime scope challenge lets a standards-compliant HTTP client obtain
      // an expanded grant instead of treating a scope refusal as an opaque
      // application failure. Deliberately NOT fired for the 428 onboarding gate
      // or the 401 no-credential case: re-authorizing with more scopes fixes
      // neither, so offering a challenge there would send the client in circles.
      if (options.scopeChallenge && err instanceof McpToolError && err.status === 403 && tool.scope !== PUBLIC_SCOPE) {
        const scopes = [...new Set([...(principal?.scopes ?? []), tool.scope])].join(" ");
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          _meta: {
            "mcp/www_authenticate": [
              options.scopeChallenge({ scope: scopes, description: `The ${tool.scope} scope is required for ${tool.name}.` }),
            ],
          },
        };
      }
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

/**
 * Turn OFF the SDK's protocol-layer argument validation for this server
 * instance, so authorization is decided before arguments are inspected.
 *
 * Exported because BOTH protocol eras need it: the sessionful
 * `@modelcontextprotocol/sdk` server below and the stateless
 * `@modelcontextprotocol/server` one in `modern.ts` each validate
 * `inputSchema` ahead of the registered callback, under the same method name.
 * Applying it in one era only would leave the disclosure/audit hole open on
 * the other, which is precisely the per-transport divergence this file exists
 * to prevent.
 *
 * `McpServer`'s `tools/call` handler calls `this.validateToolInput(...)`
 * before `executeToolHandler(...)`. Overriding it on the INSTANCE (not the
 * prototype — several servers exist per process and one must not silently
 * reconfigure another) makes it a pass-through. Nothing is weakened:
 * `makeToolHandler` re-validates every call against the tool's own Zod
 * schema, which is where the rejection belonged all along.
 *
 * Fails loudly rather than silently if a future SDK renames the hook — a
 * silent no-op here would quietly reopen the disclosure/audit hole.
 */
export function disableSdkInputValidation(server: object): void {
  const instance = server as unknown as Record<string, unknown>;
  if (typeof instance.validateToolInput !== "function") {
    throw new Error(
      "MCP SDK no longer exposes validateToolInput — re-check that the authorization gate still precedes argument validation on tools/call.",
    );
  }
  instance.validateToolInput = async (_tool: unknown, args: unknown) => args;
}

export function createMcpServer(options: {
  scopeChallenge?: (input: { scope: string; description: string }) => unknown;
} = {}): McpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER_METADATA.name,
      version: MCP_SERVER_METADATA.version,
      title: MCP_SERVER_METADATA.title,
    },
    { instructions: MCP_OPERATING_INSTRUCTIONS },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: rawShape(tool), _meta: toolSecuritySchemes(tool) },
      // Cast: the SDK types the callback against the raw shape it was given;
      // the shared handler is deliberately shape-agnostic and re-validates
      // with the tool's own schema before calling it.
      makeToolHandler(tool, options) as never,
    );
  }
  disableSdkInputValidation(server);
  return server;
}
