#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runWithMcpPrincipal } from "../lib/mcp-context.js";
import { verifyApiKey } from "../services/api-keys.js";
import { createMcpServer } from "./transport.js";

/**
 * Tier-1 (stdio) MCP server — the transport this port was missing entirely.
 *
 * v1 ships `databounty-api/src/mcp/server.ts` on `StdioServerTransport` with
 * an `"mcp": "tsx src/mcp/server.ts"` npm script, so an operator can wire
 * DataBounty into a desktop MCP client that speaks stdio rather than HTTP.
 * There was no `StdioServerTransport` anywhere in this tree, so that whole
 * class of client had no way to connect. (The existing `src/mcp/server.ts`
 * here is something else — the `GET /mcp/tools` + `POST /mcp/call` REST pair
 * — hence the separate filename.)
 *
 * ONE DELIBERATE DIFFERENCE FROM v1, stated rather than hidden:
 *
 *   v1's stdio process is a THIN REST CLIENT. Its tools call
 *   `restCall(...)` against `https://api.databounty.io/v1` with the API key
 *   as a bearer token, so it needs no database and can run on an operator's
 *   laptop far from the service.
 *
 *   Community's tools are NOT REST adapters — they call the service layer
 *   in-process (see `tool-gate.ts`'s opening comment). There is no
 *   `restCall` core here to reuse, so this process runs the same in-process
 *   catalog and therefore needs the same environment the API server needs
 *   (DATABASE_URL et al, via `../config.js`, reached through the service
 *   imports). It is a co-located transport, not a remote CLI. Turning it
 *   into a laptop-shippable client would mean building the REST-proxy core
 *   v1 has, which is a separate piece of work and is NOT done here.
 *
 * CREDENTIAL: per the MCP authorization spec a stdio transport takes its
 * credential from the environment, not an HTTP header. This reads
 * `DATABOUNTY_API_KEY` — a scoped key issued on the dashboard's developers
 * page — resolves it ONCE at start-up through the same `verifyApiKey` the
 * HTTP surface uses, and pins the resulting principal (userId + the key's
 * real scopes) for every tool call. One process, one credential.
 *
 * FAILS CLOSED: a missing or invalid key exits non-zero before the transport
 * is connected. It never starts unauthenticated — an unauthenticated server
 * would still answer every `public` tool and would look, to the operator's
 * client, like a working connection to their account.
 */

const API_KEY_ENV_VAR = "DATABOUNTY_API_KEY";

export async function startStdioMcpServer(): Promise<McpServer> {
  const token = process.env[API_KEY_ENV_VAR]?.trim();
  if (!token) {
    throw new Error(
      `${API_KEY_ENV_VAR} is not set. Add it to the \`env\` block of this MCP server's client config ` +
        "(e.g. claude_desktop_config.json) — issue a scoped key on the /developers page first.",
    );
  }

  const apiKey = await verifyApiKey(token);
  if (!apiKey) {
    // Deliberately says nothing about WHY (unknown / revoked / expired):
    // this process's stderr is the operator's own, but the same message is
    // the one a misconfigured automation retries against.
    throw new Error(`${API_KEY_ENV_VAR} was not accepted. Issue a new key on the /developers page.`);
  }

  // No `scopeChallenge`: stdio has no OAuth authorization server to step up
  // to, so a scope refusal surfaces as the plain readable error instead of a
  // `WWW-Authenticate` the client could do nothing with.
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  const principal = {
    userId: apiKey.userId,
    keyId: apiKey.id,
    scopes: apiKey.scopes,
    userAgent: "databounty-mcp-stdio",
  };

  await server.connect(transport);

  // Every tool call this transport dispatches runs inside the one principal.
  // The store is entered PER MESSAGE rather than once around `connect()`:
  // wrapping the connect call alone would rely on AsyncLocalStorage
  // propagating from a stream listener registered inside that scope, which is
  // exactly the kind of "usually works" that turns into an unauthenticated
  // tool call under an unrelated Node change. `assertToolAllowed` treats an
  // absent principal as no identity, so a propagation miss would 401 rather
  // than escalate — but the honest fix is to not depend on it.
  const dispatch = transport.onmessage;
  if (!dispatch) throw new Error("stdio transport exposed no message handler after connect()");
  transport.onmessage = (...args: Parameters<typeof dispatch>) => {
    void runWithMcpPrincipal(principal, async () => {
      dispatch(...args);
    });
  };
  return server;
}

/** Only run when executed directly, so the function above stays testable. */
const invokedDirectly = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1]}`).href ||
    process.argv[1].endsWith("mcp/stdio.ts") ||
    process.argv[1].endsWith("mcp/stdio.js")
  : false;

if (invokedDirectly) {
  startStdioMcpServer().catch((err) => {
    // stderr, never stdout: stdout is the JSON-RPC channel.
    console.error("databounty-mcp fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
