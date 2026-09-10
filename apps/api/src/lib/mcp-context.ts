// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is making an MCP tool call, for scope enforcement and the per-call audit
 * trail. OAuth principals carry userId + clientId; API-key principals carry
 * userId + keyId. NEVER holds the raw bearer secret.
 *
 * AsyncLocalStorage rather than a module-level "current principal": several MCP
 * clients are served concurrently by one process, and a module global would
 * leak one connection's identity into another's tool call under any real load.
 */
export interface McpPrincipal {
  userId: string;
  clientId?: string;
  keyId?: string;
  scopes: string[];
  ip?: string;
  userAgent?: string;
}

const context = new AsyncLocalStorage<McpPrincipal>();

export function runWithMcpPrincipal<T>(principal: McpPrincipal, fn: () => Promise<T>): Promise<T> {
  return context.run(principal, fn);
}

/** The principal for the in-flight MCP request, if any. Undefined means the
 *  call did not arrive through an authenticated MCP transport — callers MUST
 *  treat that as "no identity", never as "trusted". */
export function currentMcpPrincipal(): McpPrincipal | undefined {
  return context.getStore();
}
