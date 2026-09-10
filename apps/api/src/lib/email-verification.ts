// SPDX-License-Identifier: Apache-2.0

import { randomBytes, createHash } from "node:crypto";
import { prisma } from "./prisma.js";

const DEFAULT_VERIFY_TTL_HOURS = 24;
const VERIFY_TTL_SETTING_KEY = "auth.email_verification.ttl_hours";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function verifyTokenTtlMs(): Promise<number> {
  try {
    const row = await prisma.adminSetting.findUnique({ where: { key: VERIFY_TTL_SETTING_KEY } });
    const hours = row?.value;
    const valid =
      typeof hours === "number" && Number.isFinite(hours) && hours >= 1 && hours <= 720
        ? hours
        : DEFAULT_VERIFY_TTL_HOURS;
    return valid * 60 * 60 * 1000;
  } catch {
    return DEFAULT_VERIFY_TTL_HOURS * 60 * 60 * 1000;
  }
}

export async function createEmailVerificationToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const ttlMs = await verifyTokenTtlMs();
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  return token;
}

export async function consumeEmailVerificationToken(token: string): Promise<string | null> {
  if (!token) return null;
  const record = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) return null;
  await prisma.emailVerificationToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });
  return record.userId;
}
