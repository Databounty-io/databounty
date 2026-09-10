// SPDX-License-Identifier: Apache-2.0

import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

export const SESSION_COOKIE = "db_session";
export const ADMIN_SESSION_COOKIE = "db_admin_session";

const COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60;

function sameSite(): "lax" | "none" | "strict" {
  const v = (process.env.COOKIE_SAMESITE ?? "lax").toLowerCase();
  return v === "none" || v === "strict" ? v : "lax";
}

function cookieOpts() {
  return {
    httpOnly: true,
    secure: config.isProd || sameSite() === "none",
    sameSite: sameSite(),
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  } as const;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, cookieOpts());
}

export function setAdminSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(ADMIN_SESSION_COOKIE, token, cookieOpts());
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  });
}

export function clearAdminSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(ADMIN_SESSION_COOKIE, {
    path: "/",
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  });
}

export function isAdminOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  return origin.replace(/\/$/, "") === config.adminUrl.replace(/\/$/, "");
}

export function sessionTokenFrom(req: FastifyRequest): string {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  if (isAdminOrigin(req)) return req.cookies?.[ADMIN_SESSION_COOKIE] ?? "";
  return req.cookies?.[SESSION_COOKIE] ?? "";
}
