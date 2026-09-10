// SPDX-License-Identifier: Apache-2.0

export class McpToolError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "McpToolError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Errors returned through MCP are part of an operator-facing conversation.
 * Deliberate, actionable domain errors (`McpToolError`) are preserved verbatim;
 * anything else is replaced with a generic message.
 *
 * This previously returned `err.message` for ANY Error, which handed an agent
 * raw Prisma failures — table and column names, constraint identifiers, query
 * fragments — that are useless to the operator and a disclosure to anyone else.
 * The original error is still available to the caller's audit logger at the
 * catch site, so nothing is lost server-side.
 */
export function safeMcpErrorMessage(err: unknown): string {
  if (err instanceof McpToolError) return err.message;
  return (
    "That request could not be completed just now. Nothing was changed. " +
    "Try again in a moment, or reconnect the MCP server if it continues."
  );
}
