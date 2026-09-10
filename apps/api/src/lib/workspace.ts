// SPDX-License-Identifier: Apache-2.0

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export async function ensurePersonalWorkspace(userId: string, displayName: string): Promise<void> {
  const existing = await prisma.workspaceMember.findFirst({
    where: { userId, workspace: { kind: "personal" } },
    select: { workspaceId: true },
  });
  if (existing) return;
  try {
    await prisma.workspace.create({
      data: {
        id: `ws_${userId}`,
        name: displayName.trim() || "Personal",
        kind: "personal",
        ownerId: userId,
        members: { create: { userId, role: "owner" } },
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    // Log workspace creation error without breaking login
    console.error(`[workspace] failed to ensure personal workspace for ${userId}:`, err);
  }
}
