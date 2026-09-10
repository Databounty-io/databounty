// SPDX-License-Identifier: Apache-2.0

import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { zodToJsonSchema } from "zod-to-json-schema";
import { tools } from "./tools.js";
import { toolSecuritySchemes } from "./core/contract.js";
import { disableSdkInputValidation, makeToolHandler, MCP_OPERATING_INSTRUCTIONS } from "./transport.js";
import { MCP_SERVER_METADATA } from "./server.js";
import { config } from "../config.js";

/**
 * Modern (2026-07-28) MCP server. Deliberately separate from the sessionful
 * server in `./transport.ts`: the modern era is stateless per request (every
 * request carries its own `_meta` envelope), while the clients that exist
 * today still rely on `Mcp-Session-Id`. Both eras register the SAME tool
 * catalog through the SAME `makeToolHandler`, so authorization, argument
 * validation, the audit trail and error shaping cannot drift between them.
 *
 * Mirrors `databounty-api/src/routes/mcp.ts` (`createHostedServerV2`), built
 * from Community's own pieces.
 */

// A modern client may refuse an icon hosted on a different origin than the
// one it was pointed at. `config.appUrl` is the member dashboard, which serves
// this PNG from `apps/web/public/icon-192.png`.
const modernMcpIconUrl = new URL("/icon-192.png", config.appUrl).toString();

type ScopeChallenge = (input: { scope: string; description: string }) => unknown;

/**
 * Each tool in the catalog is authored as a Zod v3 `z.object` for the
 * sessionful server. The modern SDK wants a Standard Schema (Zod v4 or a
 * JSON Schema wrapped with `fromJsonSchema`), so convert here rather than
 * duplicating the catalog or forcing a project-wide Zod upgrade.
 */
function modernInputSchema(schema: (typeof tools)[number]["schema"]) {
  return fromJsonSchema(zodToJsonSchema(schema) as Parameters<typeof fromJsonSchema>[0]);
}

export function createModernMcpServer(options: { scopeChallenge?: ScopeChallenge } = {}): McpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER_METADATA.name,
      title: MCP_SERVER_METADATA.title,
      version: MCP_SERVER_METADATA.version,
      description: MCP_SERVER_METADATA.description,
      websiteUrl: config.landingUrl,
      icons: [{ src: modernMcpIconUrl, mimeType: "image/png", sizes: ["192x192"] }],
    },
    {
      // The catalog is principal-aware (scope gating happens per call), so
      // let only the requesting client cache it, and only briefly: new tools
      // and scope changes must become visible promptly.
      cacheHints: {
        "server/discover": { ttlMs: 60_000, cacheScope: "private" },
        "tools/list": { ttlMs: 60_000, cacheScope: "private" },
      },
      instructions: MCP_OPERATING_INSTRUCTIONS,
    },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: modernInputSchema(tool.schema), _meta: toolSecuritySchemes(tool) },
      // Cast: the SDK types the callback against the schema it was given; the
      // shared handler is shape-agnostic and re-validates with the tool's own
      // Zod schema before calling it.
      makeToolHandler(tool, options) as never,
    );
  }
  // Same authorization-before-validation ordering as the sessionful era: this
  // SDK also runs `validateToolInput` ahead of the registered callback, so
  // without this an unscoped caller with malformed arguments would still get
  // a parameter-naming -32602 and leave no audit row on THIS era only.
  disableSdkInputValidation(server);
  return server;
}

/**
 * `legacy: "reject"` means this handler NEVER serves 2025-era traffic in the
 * SDK's stateless compatibility mode: `handleMcpByEra` in `routes/mcp.ts`
 * classifies each request with `isLegacyRequest` first and hands legacy
 * traffic to the existing sessionful transport. Anything legacy that still
 * reaches this handler is a routing bug and is answered with the
 * unsupported-protocol-version error rather than silently downgraded.
 */
export const modernMcpHandler = createMcpHandler(
  // Read at factory time (once per request), so a challenge registered by the
  // route module after import is honoured; unset means "no challenge", which
  // `makeToolHandler` treats as a plain `isError` result.
  () => createModernMcpServer({ scopeChallenge: scopeChallengeForModern }),
  { legacy: "reject" },
);

/**
 * Node `(req, res, parsedBody)` face of the modern handler, for use after
 * `reply.hijack()` inside `runWithMcpPrincipal(...)`.
 */
export const modernMcpNodeHandler = toNodeHandler(modernMcpHandler);

let scopeChallengeForModern: ScopeChallenge | undefined;

/**
 * The route module owns `bearerChallenge` (it needs the OAuth discovery URLs
 * from `services/mcp-oauth`). Register it once at route setup so scope
 * refusals over the modern era carry the same `WWW-Authenticate` challenge
 * the sessionful era emits, instead of importing the route from here.
 */
export function setModernScopeChallenge(challenge: ScopeChallenge): void {
  scopeChallengeForModern = challenge;
}
