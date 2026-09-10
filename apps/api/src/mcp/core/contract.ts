// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * Scope name for a tool that needs NO credential at all.
 *
 * This used to be `"read"`, which silently collapsed two different things:
 * both auth gates in `../server.ts` test `tool.scope !== PUBLIC_SCOPE`, so
 * every one of the 19 `read`-scoped tools was reachable with no credential and
 * the `read` API-key scope was never enforced anywhere. v1 keeps `public` and
 * `read` as separate scopes for exactly this reason
 * (`databounty-api/src/mcp/core/contract.ts`).
 *
 * `public` is now a real, deliberately tiny scope: only catalog//reference
 * lookups that the unauthenticated REST surface already serves may carry it.
 * Anything that reads a specific user's row, or writes anything at all, must
 * name a credential scope from `ApiKeyScope`.
 */
export const PUBLIC_SCOPE = "public";

/**
 * Which kind of credential is calling. A tool that needs to know — because a
 * REST route it mirrors is `requireAuth`-gated, session-only, and REST
 * refuses any API key outright (`lib/rbac.ts` — `requireAuth`/`requireRole`
 * reject an `apiKeyScopes`-carrying caller with 403) — must check this
 * rather than assume MCP and REST admit the same credentials. `"session"`
 * means a full dashboard session on `/mcp/call`; that surface never sees an
 * OAuth principal.
 */
export type McpCredentialKind = "session" | "api_key" | "oauth";

/**
 * Per-tool `_meta.securitySchemes`, in the shape ChatGPT's Apps SDK
 * documents (`https://developers.openai.com/apps-sdk/build/auth`):
 * `"noauth"` for a genuinely public tool, `"oauth2"` with its required
 * `scopes` otherwise. ChatGPT's tool-level OAuth linking UI needs BOTH this
 * declaration AND a runtime `_meta["mcp/www_authenticate"]` on a scope
 * refusal (already emitted — `transport.ts`'s `makeToolHandler`); without
 * this half, ChatGPT never shows the linking prompt for a gated tool at all,
 * so the runtime challenge alone was unreachable from that client.
 */
export function toolSecuritySchemes(tool: Pick<McpTool, "scope">): Record<string, unknown> {
  return {
    securitySchemes:
      tool.scope === PUBLIC_SCOPE
        ? { noauth: {} }
        : { oauth2: { scopes: [tool.scope] } },
  };
}

export interface McpTool<TArgs = any, TResult = any> {
  name: string;
  description: string;
  scope: string;
  schema: z.ZodType<TArgs>;
  call: (args: TArgs, context?: { userId?: string; credentialKind?: McpCredentialKind }) => Promise<TResult>;
}
