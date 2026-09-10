// SPDX-License-Identifier: Apache-2.0

import { randomBytes, createHash } from "node:crypto";
import type { PasswordTokenPurpose, Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

/**
 * These writes belong to the caller's credential-change transaction (the
 * password row, the session wipe and the audit entry all commit together), so
 * every mutator takes a client. Defaulting to the global `prisma` keeps the
 * non-transactional callers working unchanged.
 */
type DbClient = Prisma.TransactionClient | typeof prisma;

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createPasswordResetToken(
  userId: string,
  purpose: PasswordTokenPurpose = "reset"
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      purpose,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });
  return token;
}

export async function verifyPasswordResetToken(
  token: string
): Promise<{ userId: string; purpose: PasswordTokenPurpose } | null> {
  if (!token) return null;
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) return null;
  return { userId: record.userId, purpose: record.purpose };
}

export async function consumePasswordResetToken(token: string, db: DbClient = prisma): Promise<void> {
  await db.passwordResetToken.update({
    where: { tokenHash: hashToken(token) },
    data: { usedAt: new Date() },
  });
}

/**
 * Verify AND consume in one atomic step, closing a TOCTOU window
 * `verifyPasswordResetToken` + `consumePasswordResetToken` left open: two
 * concurrent requests presenting the SAME token could both pass the read
 * (`usedAt: null`) before either write landed, so "single-use" wasn't
 * actually enforced against a raced double-redemption of one token — only
 * against a *sequential* replay. Every other token in this codebase (session,
 * email-verification, MCP OAuth refresh) claims via a conditional
 * `updateMany` gated on its own unused-ness; this token type is now
 * consistent with that pattern.
 *
 * Call this INSIDE the same transaction as the credential change it
 * authorizes, so a claim that isn't followed by a successful password write
 * rolls back together with it — a failed write never leaves the token spent
 * with nothing to show for it.
 */
export async function claimPasswordResetToken(
  token: string,
  db: DbClient = prisma
): Promise<{ userId: string; purpose: PasswordTokenPurpose } | null> {
  const tokenHash = hashToken(token);
  const record = await db.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!record || record.usedAt || record.expiresAt < new Date()) return null;

  // The compare-and-swap: only a caller that flips `usedAt` from null itself
  // gets a non-zero count. A concurrent claimant loses this race cleanly
  // instead of both succeeding.
  const claimed = await db.passwordResetToken.updateMany({
    where: { tokenHash, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return null;

  return { userId: record.userId, purpose: record.purpose };
}

/**
 * Burns every still-usable reset token the user holds, and returns how many
 * were burned.
 *
 * WHY THIS EXISTS. `/forgot-password` mints a token per click and nothing used
 * to invalidate the siblings, so N independently-valid tokens coexisted for
 * their whole hour. `verifyPasswordResetToken` only checks `usedAt` and
 * `expiresAt`, so spending one left the others live — and this was a full
 * account takeover, not just untidy bookkeeping. Proven against a running API:
 * two `/forgot-password` calls, the victim resets with token A (200), the older
 * token B then also resets (200), the attacker's password logs in and the
 * victim's freshly-chosen one is refused. Any old, unread or forwarded reset
 * mail stayed a working takeover AFTER the user had reset their password in
 * response to suspecting compromise — exactly when it must not.
 *
 * So a completed credential change now burns the lot. Call it for any change
 * of the password itself (reset / change / set): each one invalidates the
 * "prove you own this address" pending window that the outstanding tokens
 * represent. Rows are marked used rather than deleted so the audit trail of
 * what was issued survives.
 */
export async function invalidatePasswordResetTokens(userId: string, db: DbClient = prisma): Promise<number> {
  const { count } = await db.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
  return count;
}
