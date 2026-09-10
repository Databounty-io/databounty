// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { tools } from "./tools.js";
import { toolSecuritySchemes } from "./core/contract.js";
import { getAuthedUser } from "../lib/rbac.js";
import { SESSION_COOKIE, ADMIN_SESSION_COOKIE } from "../lib/session-cookie.js";
import { config } from "../config.js";
import { McpToolError, safeMcpErrorMessage } from "./core/errors.js";
import { assertToolAllowed } from "./tool-gate.js";
import { recordMcpToolInvocation } from "../services/mcp-oauth.js";
import { zodToJsonSchema } from "zod-to-json-schema";

export async function mcpPlugin(app: FastifyInstance) {
  // List MCP Tools
  app.get("/tools", async (req, reply) => {
    const serializedTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      scope: t.scope,
      inputSchema: zodToJsonSchema(t.schema),
      _meta: toolSecuritySchemes(t),
    }));
    return reply.send({ tools: serializedTools });
  });

  // Call MCP Tool
  app.post("/call", async (req, reply) => {
    // CSRF guard. There is no CSRF token anywhere in this codebase, so a
    // request actually AUTHENTICATING VIA THE SESSION COOKIE rests entirely
    // on `sameSite`. Under the `lax` default a cross-site POST never carries
    // the cookie, so that was safe; but `COOKIE_SAMESITE=none`, which a
    // split-origin deployment needs, made every zero-argument mutating tool
    // (`complete_onboarding`, `mark_notifications_read` with no id = mark-all,
    // `resend_email_verification`) forgeable by any origin against a logged-in
    // operator. Scoped narrowly to an actual cookie present: a request with
    // no cookie and no bearer is simply unauthenticated and must still fall
    // through to the normal 401 from `assertToolAllowed`, in the MCP
    // tool-error shape every other refusal here uses.
    const hasSessionCookie = Boolean(req.cookies?.[SESSION_COOKIE] || req.cookies?.[ADMIN_SESSION_COOKIE]);
    const auth = req.headers.authorization ?? "";
    if (hasSessionCookie && !auth.startsWith("Bearer ")) {
      const origin = req.headers.origin;
      if (!origin || !config.corsOrigins.includes(origin)) {
        return reply.code(403).send({
          content: [{ type: "text", text: "This request's origin is not allowed to use cookie authentication on this endpoint." }],
          isError: true,
        });
      }
    }

    const authedUser = await getAuthedUser(req);
    const body = req.body as { name: string; arguments?: Record<string, unknown> };

    if (!body || !body.name) {
      return reply.badRequest("Tool name is required");
    }

    const tool = tools.find((t) => t.name === body.name);
    if (!tool) {
      return reply.notFound(`Unknown tool: ${body.name}`);
    }

    // Authentication, scope, verified-email and onboarding all live in the one
    // shared gate so this legacy REST pair and the JSON-RPC transport in
    // routes/mcp.ts can never diverge. Refusals are returned as MCP tool-error
    // results carrying the real HTTP status, rather than a bare Fastify error
    // body: an MCP client expects `{ content, isError }` and would otherwise
    // surface a scope problem as an opaque transport failure.
    try {
      await assertToolAllowed(tool, {
        userId: authedUser?.id,
        scopes: authedUser?.apiKeyScopes,
      });
    } catch (err) {
      const status = err instanceof McpToolError ? err.status : 403;
      return reply.code(status).send({
        content: [{ type: "text", text: safeMcpErrorMessage(err) }],
        isError: true,
      });
    }

    const parseResult = tool.schema.safeParse(body.arguments ?? {});
    if (!parseResult.success) {
      return reply.badRequest(parseResult.error.message);
    }

    try {
      const startedAt = Date.now();
      // `AuthedUser.credentialKind` already distinguishes "session" from
      // "api_key" (lib/rbac.ts); `/mcp/call` never sees an OAuth principal
      // (that rides the JSON-RPC transports in routes/mcp.ts only).
      const result = await tool.call(parseResult.data, {
        userId: authedUser?.id,
        credentialKind: authedUser?.credentialKind,
      });
      recordMcpToolInvocation({
        principal: authedUser ? { userId: authedUser.id } : undefined,
        tool: tool.name,
        ok: true,
        durationMs: Date.now() - startedAt,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return reply.send({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      });
    } catch (err) {
      recordMcpToolInvocation({
        principal: authedUser ? { userId: authedUser.id } : undefined,
        tool: tool.name,
        ok: false,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      const message = safeMcpErrorMessage(err);
      return reply.send({
        content: [{ type: "text", text: message }],
        isError: true,
      });
    }
  });

  // NOTE: the former `app.all("/")` metadata handler moved to routes/mcp.ts,
  // where `/mcp` is now the real JSON-RPC / streamable-HTTP MCP endpoint. It
  // still answers a plain unauthenticated GET with the same metadata body, so
  // nothing that pointed at `/mcp` for a health/identity check changed.
}

export const MCP_SERVER_METADATA = {
  name: "DataBounty Community MCP",
  /** Human-facing label, separate from `name`: the transport was passing the
   *  wire name straight through as the title, so a client had nothing shorter
   *  to render than the protocol identifier. */
  title: "DataBounty Community",
  version: "0.1.0",
  description:
    "DataBounty Community helps contributors, validators, and dataset requesters complete verified dataset work across supported dataset types, and build a public karma record. " +
    "Use the server instructions and each tool's returned data to guide the operator to the right next step.",
  get toolsCount() {
    return tools.length;
  },
};
