// SPDX-License-Identifier: Apache-2.0

import { randomBytes, createHash } from "node:crypto";
import type { Role } from "@prisma/client";
import { prisma } from "./prisma.js";
import { writeAuditLog } from "./audit-log.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createAdminInvite(
  email: string,
  role: Extract<Role, "admin" | "member" | "support">,
  invitedById: string,
  context?: { ip?: string; userAgent?: string; requestId?: string }
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await prisma.$transaction(async (tx) => {
    await tx.adminInvite.updateMany({
      where: { email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const invite = await tx.adminInvite.create({
      data: {
        email,
        role,
        tokenHash: hashToken(token),
        invitedById,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await writeAuditLog(tx, {
      actorUserId: invitedById,
      action: "admin.invite.created",
      targetType: "admin_invite",
      targetId: invite.id,
      after: { email, role, expiresAt: invite.expiresAt },
      ip: context?.ip,
      userAgent: context?.userAgent,
      requestId: context?.requestId,
    });
  });
  return token;
}

export async function verifyAdminInviteToken(token: string) {
  if (!token) return null;
  const invite = await prisma.adminInvite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt < new Date()) return null;
  return invite;
}

export async function consumeAdminInvite(id: string): Promise<void> {
  await prisma.adminInvite.update({ where: { id }, data: { acceptedAt: new Date() } });
}
