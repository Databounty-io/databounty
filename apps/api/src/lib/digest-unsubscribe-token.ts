// SPDX-License-Identifier: Apache-2.0

/**
 * Opaque capability links for routine-digest unsubscribe.
 *
 * Ported from v1's `lib/digest-unsubscribe-token.ts`.
 *
 * Why a capability token and not a session: a digest email's unsubscribe link
 * has to work from a mail client, on a device that is not logged in — that is
 * the entire point of RFC 8058 one-click unsubscribe. So the link itself is
 * the credential.
 *
 * Properties that make that safe:
 *  - The link carries no email address and no readable user id. The payload is
 *    AES-256-GCM encrypted, so it is both confidential and authenticated —
 *    GCM's auth tag makes any tampered byte fail decryption outright (the
 *    timing-safe comparison is inside OpenSSL's tag check, not a hand-rolled
 *    `===` on a digest).
 *  - The key is derived in a DISTINCT domain from `SESSION_SECRET`
 *    (`databounty:routine-digest-unsubscribe:v1`), so a session HMAC can never
 *    be replayed as an unsubscribe token and vice versa.
 *  - It is scoped to exactly one preference: turn routine digest mail OFF for
 *    one user. It grants no account access, cannot enable anything, and never
 *    touches transactional, security, payment, or deadline mail.
 *  - It expires (`exp`, 1 year — long enough that an old newsletter in an
 *    archive still honours an unsubscribe, which is the compliance-relevant
 *    direction).
 *  - Every failure mode — wrong prefix, non-base64url, truncated buffer, bad
 *    auth tag, unparseable JSON, missing/blank `sub`, non-integer or elapsed
 *    `exp` — returns `null`. There is no branch that returns a userId on
 *    unverified input.
 *
 * No schema column is needed: the token is fully stateless.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

const PREFIX = "du1";
const TTL_MS = 365 * 24 * 60 * 60 * 1000;

function key(): Buffer {
  return createHash("sha256")
    .update("databounty:routine-digest-unsubscribe:v1\0")
    .update(config.sessionSecret)
    .digest();
}

export function createDigestUnsubscribeToken(userId: string, now = Date.now()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = JSON.stringify({ sub: userId, exp: now + TTL_MS });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${PREFIX}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

export function readDigestUnsubscribeToken(token: string, now = Date.now()): { userId: string } | null {
  if (!token.startsWith(`${PREFIX}.`)) return null;
  try {
    const bytes = Buffer.from(token.slice(PREFIX.length + 1), "base64url");
    // iv(12) + tag(16) + at least one ciphertext byte.
    if (bytes.length < 12 + 16 + 1) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const value = JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")
    ) as { sub?: unknown; exp?: unknown };
    if (
      typeof value.sub !== "string" ||
      !value.sub ||
      typeof value.exp !== "number" ||
      !Number.isSafeInteger(value.exp) ||
      value.exp < now
    ) {
      return null;
    }
    return { userId: value.sub };
  } catch {
    return null;
  }
}

/**
 * Absolute URL of the public unsubscribe endpoint, token included.
 *
 * Built from `config.publicApiBaseUrl` (this API's own public base URL, no
 * `/v1` suffix — the `/v1` route prefix is appended here), which is env-pinned
 * via `PUBLIC_API_BASE_URL` and boot-guarded against a localhost default in
 * production (see `config.ts`).
 */
export function digestUnsubscribeUrl(userId: string): string {
  const url = new URL(`${config.publicApiBaseUrl}/v1/notifications/unsubscribe-digest`);
  url.searchParams.set("token", createDigestUnsubscribeToken(userId));
  return url.toString();
}
