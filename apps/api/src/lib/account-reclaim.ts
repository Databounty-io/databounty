// SPDX-License-Identifier: Apache-2.0

import type { Prisma } from "@prisma/client";

/**
 * Remove every way back into an account that its email owner did not create.
 *
 * Email signup issues a session before the address is proven, so an account
 * whose email was never verified may belong to someone other than the
 * address's owner: anyone can register an address they do not control and stay
 * signed in. When the owner later proves the address through an identity
 * provider and that identity is linked to the existing account, the account
 * becomes theirs, and everything the unproven registrant could still use has to
 * stop working in the same transaction:
 *
 *  - the password they chose,
 *  - every session, API key and MCP OAuth grant,
 *  - any authorization request still waiting for consent,
 *  - any outstanding email-verification or password link.
 *
 * The owner keeps signing in through the provider, and can set a password later
 * through the normal emailed flow. Linking to an account whose email WAS
 * verified never calls this: whoever verified it already proved the address.
 *
 * Run it inside the linking transaction, then drop the API-key cache with
 * invalidateUserApiKeys() after the commit, as account suspension does.
 */
export async function revokeUnprovenAccess(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const now = new Date();
  await tx.user.update({ where: { id: userId }, data: { passwordHash: null } });
  await tx.session.deleteMany({ where: { userId } });
  await tx.apiKey.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await tx.oAuthAccessToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await tx.oAuthRefreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await tx.oAuthAuthorizationCode.deleteMany({ where: { userId, usedAt: null } });
  await tx.oAuthAuthorizationRequest.updateMany({
    where: { userId, approvedAt: null, deniedAt: null },
    data: { deniedAt: now },
  });
  await tx.passwordResetToken.deleteMany({ where: { userId, usedAt: null } });
  await tx.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } });
}
