// SPDX-License-Identifier: Apache-2.0

import { randomBytes, createHmac } from "node:crypto";
import { config } from "../config.js";
import { prisma } from "./prisma.js";
import type { User } from "@prisma/client";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_RENEW_THRESHOLD_MS = SESSION_TTL_MS / 2;

export type SessionUser = User & { roles: { role: string }[] };

function hashToken(token: string): string {
  return createHmac("sha256", config.sessionSecret).update(token).digest("hex");
}

async function maybeCleanupExpiredSessions(): Promise<void> {
  if (Math.random() >= 0.05) return;
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
}

export async function createSession(
  userId: string,
  opts?: { userAgent?: string; ip?: string }
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      userAgent: opts?.userAgent,
      ip: opts?.ip,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  void maybeCleanupExpiredSessions();
  return token;
}

export async function getUserFromSessionToken(token: string): Promise<SessionUser | null> {
  if (!token || typeof token !== "string") return null;
  const tokenHash = hashToken(token);

  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: { roles: true },
      },
    },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (session.user.status !== "active") return null;

  const msRemaining = session.expiresAt.getTime() - Date.now();
  if (msRemaining < SESSION_RENEW_THRESHOLD_MS) {
    await prisma.session
      .update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      })
      .catch(() => {});
  }

  return session.user;
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  await prisma.session.delete({ where: { tokenHash } }).catch(() => {});
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } }).catch(() => {});
}
