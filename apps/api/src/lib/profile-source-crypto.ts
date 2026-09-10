// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * AES-256-GCM at rest for `ProfileSource.accessTokenEnc`/`refreshTokenEnc`.
 * Key is SHA-256 of the configured secret so any string length works; never
 * logged, never returned to a client.
 */
function deriveKey(): Buffer {
  return createHmac("sha256", "profile-source-token-key").update(config.profileSourceSecret).digest();
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptToken(stored: string): string | null {
  try {
    const buf = Buffer.from(stored, "base64url");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a real OAuth consent screen, short enough to bound replay.

/**
 * Signed, stateless OAuth `state` param: binds the callback back to the
 * user who started the connect flow (never trust a bare `userId` query
 * param from the redirect — that would let anyone attach a stolen GitHub
 * token to an arbitrary account) and to the provider (so a callback can't
 * be replayed against a different connect route).
 */
export function signOAuthState(userId: string, provider: string): string {
  const payload = `${userId}.${provider}.${Date.now()}`;
  const sig = createHmac("sha256", config.profileSourceSecret).update(payload).digest("base64url");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

export function verifyOAuthState(state: string, provider: string): { userId: string } | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 4) return null;
    const [userId, stateProvider, tsRaw, sig] = parts;
    if (stateProvider !== provider) return null;
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || Date.now() - ts > STATE_TTL_MS) return null;
    const payload = `${userId}.${stateProvider}.${tsRaw}`;
    const expected = createHmac("sha256", config.profileSourceSecret).update(payload).digest("base64url");
    const a = Buffer.from(sig!, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { userId: userId! };
  } catch {
    return null;
  }
}
