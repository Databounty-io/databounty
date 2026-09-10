// SPDX-License-Identifier: Apache-2.0

import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyScope } from "@prisma/client";
import { getUserFromSessionToken } from "./session.js";
import { sessionTokenFrom } from "./session-cookie.js";
import { verifyApiKey, KEY_PREFIX } from "../services/api-keys.js";
import { prisma } from "./prisma.js";

export { ADMIN_ROLES, type AdminRole } from "./admin-roles.js";

export const ADMIN_ONLY = ["admin"] as const;
export const ADMIN_AND_MEMBER = ["admin", "member"] as const;
export const ADMIN_AND_ABOVE_READONLY = ["admin", "member", "support"] as const;

export interface AuthedUser {
  id: string;
  email: string | null;
  displayName: string;
  roles: string[];
  emailVerifiedAt: Date | null;
  apiKeyScopes?: ApiKeyScope[];
  credentialKind?: "session" | "api_key";
}

export async function getAuthedUser(req: FastifyRequest): Promise<AuthedUser | null> {
  const token = sessionTokenFrom(req);
  if (!token) return null;

  if (token.startsWith(KEY_PREFIX)) {
    const apiKey = await verifyApiKey(token);
    if (apiKey) {
      const user = await prisma.user.findUnique({
        where: { id: apiKey.userId },
        include: { roles: true },
      });
      if (!user || user.status !== "active") return null;
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        roles: user.roles.map((r) => r.role),
        emailVerifiedAt: user.emailVerifiedAt,
        apiKeyScopes: apiKey.scopes,
        credentialKind: "api_key",
      };
    }
    return null;
  }

  const user = await getUserFromSessionToken(token);
  if (user) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      roles: user.roles.map((r) => r.role),
      emailVerifiedAt: user.emailVerifiedAt,
      credentialKind: "session",
    };
  }

  return null;
}

function unauthorizedMessage(req: FastifyRequest): string {
  return sessionTokenFrom(req).startsWith(KEY_PREFIX)
    ? "API key is invalid, revoked, or expired"
    : "Sign in required";
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const user = await getAuthedUser(req);
  if (!user) return reply.unauthorized(unauthorizedMessage(req));
  if (user.apiKeyScopes) return reply.forbidden("This endpoint requires a dashboard session.");
  (req as FastifyRequest & { authedUser: AuthedUser }).authedUser = user;
}

export function requireRole(...roles: string[]) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const user = await getAuthedUser(req);
    if (!user) return reply.unauthorized(unauthorizedMessage(req));
    if (user.apiKeyScopes) {
      return reply.forbidden("Admin operations require a dashboard session.");
    }
    if (!roles.some((r) => user.roles.includes(r))) {
      return reply.forbidden(`Requires one of role(s): ${roles.join(", ")}`);
    }
    (req as FastifyRequest & { authedUser: AuthedUser }).authedUser = user;
  };
}

export function requireScope(scope: ApiKeyScope) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const user = await getAuthedUser(req);
    if (!user) return reply.unauthorized(unauthorizedMessage(req));
    if (user.apiKeyScopes && !user.apiKeyScopes.includes(scope)) {
      return reply.forbidden(`API key missing required scope: ${scope}`);
    }
    (req as FastifyRequest & { authedUser: AuthedUser }).authedUser = user;
  };
}

export function requireAnyScope(...scopes: ApiKeyScope[]) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const user = await getAuthedUser(req);
    if (!user) return reply.unauthorized(unauthorizedMessage(req));
    if (user.apiKeyScopes && !scopes.some((scope) => user.apiKeyScopes!.includes(scope))) {
      return reply.forbidden(`API key missing one of the required scopes: ${scopes.join(", ")}`);
    }
    (req as FastifyRequest & { authedUser: AuthedUser }).authedUser = user;
  };
}

export async function requireVerifiedEmail(req: FastifyRequest, reply: FastifyReply) {
  const user =
    (req as FastifyRequest & { authedUser?: AuthedUser }).authedUser ?? (await getAuthedUser(req));
  if (!user) return reply.unauthorized(unauthorizedMessage(req));
  if (!user.emailVerifiedAt) {
    return reply.code(403).send({
      statusCode: 403,
      error: "Forbidden",
      code: "email_unverified",
      message: "Please verify your email before you can do this. Check your inbox for the link.",
    });
  }
  (req as FastifyRequest & { authedUser: AuthedUser }).authedUser = user;
}
