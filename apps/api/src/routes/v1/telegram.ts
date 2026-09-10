// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAuth, requireVerifiedEmail, type AuthedUser } from "../../lib/rbac.js";
import { telegramWebhookSecret, verifyTelegramWebhookSecret } from "../../lib/telegram-webhook-secret.js";
import {
  getTelegramStatus,
  handleTelegramWebhook,
  startTelegramLink,
  unlinkTelegram,
} from "../../services/telegram.js";

function authedId(req: FastifyRequest): string {
  return (req as FastifyRequest & { authedUser: AuthedUser }).authedUser.id;
}

export async function telegramRoutes(app: FastifyInstance) {
  app.post("/link/start", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    const link = await startTelegramLink(authedId(req));
    if (!link) return reply.badRequest("Telegram sign-in isn't configured on this deployment.");
    return reply.send({
      code: link.code,
      instructions: `Open Telegram and message @${link.botUsername}, or tap the button below to start automatically.`,
      botUrl: link.botUrl,
      botUsername: link.botUsername,
    });
  });

  // Read-only link state, so the dashboard can show "connected as @handle"
  // and stop showing a stale "waiting for you to message the bot".
  app.get("/status", { preHandler: [requireAuth] }, async (req, reply) => {
    return reply.send(await getTelegramStatus(authedId(req)));
  });

  // Disconnect. Verified-email gated like every other mutation on this API.
  app.delete("/link", { preHandler: [requireAuth, requireVerifiedEmail] }, async (req, reply) => {
    return reply.send(await unlinkTelegram(authedId(req)));
  });

  /**
   * Telegram → us. Unauthenticated by session (Telegram has none) and
   * authenticated ONLY by the shared webhook secret. Fails closed in both
   * directions:
   *   - no secret configured → 401 (the endpoint is unverifiable, so it
   *     refuses rather than trusting arbitrary input),
   *   - secret configured but header missing/wrong → 401.
   * The body is never trusted for identity; the signed link code inside the
   * message text is the only thing that can attach a chat to an account
   * (services/telegram.ts).
   */
  app.post("/webhook", async (req, reply) => {
    const expected = telegramWebhookSecret();
    if (!expected) return reply.unauthorized("Telegram webhook is not configured");
    if (!verifyTelegramWebhookSecret(req.headers["x-telegram-bot-api-secret-token"], expected)) {
      return reply.unauthorized("Invalid Telegram webhook token");
    }
    return reply.send(await handleTelegramWebhook(req.body));
  });
}
