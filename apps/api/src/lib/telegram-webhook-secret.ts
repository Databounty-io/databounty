// SPDX-License-Identifier: Apache-2.0

/**
 * Verification of Telegram's webhook `secret_token`.
 *
 * Telegram echoes the secret registered via `setWebhook` back in the
 * `X-Telegram-Bot-Api-Secret-Token` header on every update. That header is the
 * ONLY thing separating a genuine Telegram delivery from anyone who can POST
 * to a public URL, so this module is the trust boundary for
 * `POST /v1/telegram/webhook`.
 *
 * Fail-closed rules, in order:
 *   1. No secret configured  → reject. An endpoint that cannot be verified
 *      must not process input, even in dev.
 *   2. Header absent / not a string / empty → reject.
 *   3. Mismatch → reject, compared in constant time.
 *
 * There is no branch that accepts on absent configuration or absent header.
 *
 * Kept in its own module (rather than inline in the route) so this logic is
 * unit-testable without booting Fastify or a database.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The configured secret, or undefined when unset/blank. */
export function telegramWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.TELEGRAM_WEBHOOK_SECRET;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

/**
 * Constant-time equality. Both sides are first reduced to a fixed-length
 * HMAC-SHA256 digest so `timingSafeEqual` never sees unequal-length buffers
 * (which would throw, and whose very throw would leak the secret's length).
 */
export function verifyTelegramWebhookSecret(
  presentedHeader: unknown,
  configured: string | undefined = telegramWebhookSecret()
): boolean {
  if (!configured) return false;
  if (typeof presentedHeader !== "string" || presentedHeader.length === 0) return false;
  const digest = (value: string): Buffer =>
    createHmac("sha256", "telegram-webhook-secret-compare").update(value).digest();
  return timingSafeEqual(digest(presentedHeader), digest(configured));
}
