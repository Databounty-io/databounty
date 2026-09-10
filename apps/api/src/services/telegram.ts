// SPDX-License-Identifier: Apache-2.0

import { ChannelKind } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { signOAuthState, verifyOAuthState } from "../lib/profile-source-crypto.js";

const FETCH_TIMEOUT_MS = 10000;
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
}

export function telegramConfigured(): boolean {
  return Boolean(config.telegramBotToken && config.telegramBotUsername);
}

/** The deep-link code IS the signed OAuth-style state — verified the same
 * way as the GitHub/ORCID/Slack `state` param (see
 * lib/profile-source-crypto.ts). No separate code column is needed on
 * TelegramLink; `linkCodeExpiresAt` is kept purely as a display/debug
 * timestamp, the signature+embedded timestamp is the real source of truth. */
export async function startTelegramLink(userId: string): Promise<{ code: string; botUrl: string; botUsername: string } | null> {
  if (!telegramConfigured()) return null;
  const code = signOAuthState(userId, "telegram");
  await prisma.telegramLink.upsert({
    where: { userId },
    create: { userId, status: "pending", linkCodeExpiresAt: new Date(Date.now() + LINK_CODE_TTL_MS) },
    update: { status: "pending", linkCodeExpiresAt: new Date(Date.now() + LINK_CODE_TTL_MS) },
  });
  return {
    code,
    botUrl: `https://t.me/${config.telegramBotUsername}?start=${code}`,
    botUsername: config.telegramBotUsername!,
  };
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!config.telegramBotToken) throw new Error("Telegram isn't configured.");
  const res = await fetch(apiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!res.ok || !body?.ok) throw new Error(body?.description ? `Telegram said: ${body.description}` : "Telegram message failed to send.");
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number };
    from?: { id: number; username?: string };
  };
}

/** Read-only view of the link state, for `GET /v1/telegram/status`. Ported
 * from v1's `getTelegramStatus`. Never returns the link code. */
export async function getTelegramStatus(userId: string) {
  const link = await prisma.telegramLink.findUnique({ where: { userId } });
  return {
    linked: link?.status === "linked",
    status: link?.status ?? "none",
    handle: link?.telegramHandle ?? null,
    linkedAt: link?.linkedAt?.toISOString() ?? null,
    configured: telegramConfigured(),
  };
}

/**
 * Unlink Telegram: drop the link row AND the delivery channel, so a
 * disconnected user stops receiving messages immediately. Both writes are in
 * one transaction — leaving a connected `NotificationChannel` behind with no
 * `TelegramLink` would keep delivering to a chat the user just disconnected.
 * Idempotent (deleteMany, so unlinking twice is not an error).
 */
export async function unlinkTelegram(userId: string): Promise<{ ok: true }> {
  await prisma.$transaction(async (tx) => {
    await tx.notificationChannel.deleteMany({ where: { userId, channel: ChannelKind.telegram } });
    await tx.telegramLink.deleteMany({ where: { userId } });
  });
  return { ok: true };
}

/**
 * Extract the fields we need from a REAL Telegram Bot API update
 * (`{ message: { text, from: { id, username }, chat: { id } } }`), tolerating
 * `edited_message`. Returns null when the payload is not a usable text
 * message.
 *
 * Every field is checked, never cast: this parses an untrusted webhook body.
 * Nothing here is trusted for identity — the only thing that authorises a
 * link is the signed code inside `text`, verified by `verifyOAuthState`.
 */
export function parseTelegramUpdate(
  body: unknown
): { text: string; chatId: string; handle: string | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const envelope = body as { message?: unknown; edited_message?: unknown };
  const raw = envelope.message ?? envelope.edited_message;
  if (typeof raw !== "object" || raw === null) return null;
  const message = raw as {
    text?: unknown;
    from?: { id?: unknown; username?: unknown };
    chat?: { id?: unknown };
  };
  const text = typeof message.text === "string" ? message.text : "";
  const chatId =
    message.chat?.id != null && (typeof message.chat.id === "number" || typeof message.chat.id === "string")
      ? String(message.chat.id)
      : message.from?.id != null && (typeof message.from.id === "number" || typeof message.from.id === "string")
        ? String(message.from.id)
        : "";
  const handle = typeof message.from?.username === "string" ? message.from.username : null;
  return chatId ? { text, chatId, handle } : null;
}

/** Both the typed `/link <code>` and the deep-link `/start <code>` are
 * accepted, matching v1. The code is the signed state minted by
 * `startTelegramLink`, so it is matched loosely here and validated
 * cryptographically below — never the other way round. */
const LINK_COMMAND = /^\/(?:link|start)\s+(\S{1,4096})$/i;

/**
 * Verify a presented link code and, if it is genuine and unexpired, attach the
 * chat to the user it was minted for. Shared by the webhook and the
 * `getUpdates` poller so both paths enforce the identical rule: the ONLY thing
 * that decides which account a chat is attached to is the HMAC signature on
 * the code (see lib/profile-source-crypto.ts). A chat id, username, or any
 * other webhook field is never treated as an identity claim.
 */
async function completeTelegramLink(
  code: string,
  chatId: string,
  handle: string | null
): Promise<"linked" | "invalid"> {
  const verified = verifyOAuthState(code, "telegram");
  if (!verified) return "invalid";
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.telegramLink.upsert({
      where: { userId: verified.userId },
      create: {
        userId: verified.userId,
        telegramUserId: chatId,
        telegramHandle: handle,
        status: "linked",
        linkedAt: now,
      },
      update: {
        telegramUserId: chatId,
        telegramHandle: handle,
        status: "linked",
        linkedAt: now,
        linkCodeExpiresAt: null,
      },
    });
    await tx.notificationChannel.upsert({
      where: { userId_channel: { userId: verified.userId, channel: ChannelKind.telegram } },
      create: {
        userId: verified.userId,
        channel: ChannelKind.telegram,
        address: chatId,
        connected: true,
        verified: true,
        verifiedAt: now,
        deliver: true,
      },
      update: { address: chatId, connected: true, verified: true, verifiedAt: now, lastError: null },
    });
  });
  return "linked";
}

/** A branded reply Telegram executes inline as the webhook HTTP response — no
 * extra outbound call. Telegram runs a returned method and ignores it if it
 * can't, so this is best-effort. */
function telegramReply(chatId: string, text: string) {
  return { method: "sendMessage", chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
}

/**
 * Webhook entry point for `POST /v1/telegram/webhook` (ported from v1's
 * `handleTelegramWebhook`). The route verifies Telegram's secret header and
 * fails closed BEFORE calling this; everything reaching here is still treated
 * as untrusted data.
 *
 * Returns an inline `sendMessage` payload rather than `{ ok: true }` wherever
 * there is something worth telling the user, so a bad code produces a visible
 * answer in the chat instead of silence.
 */
export async function handleTelegramWebhook(body: unknown): Promise<Record<string, unknown>> {
  const update = parseTelegramUpdate(body);
  if (!update) return { ok: true };
  const match = LINK_COMMAND.exec(update.text);
  if (!match) {
    return telegramReply(
      update.chatId,
      "👋 <b>DataBounty</b>\n\nTo connect, open <b>Notifications → Telegram</b> in your DataBounty dashboard, tap <b>link Telegram</b>, then follow the link (or send the <code>/link</code> code shown there)."
    );
  }
  const result = await completeTelegramLink(match[1]!, update.chatId, update.handle);
  return result === "linked"
    ? telegramReply(
        update.chatId,
        "🟢 <b>Connected to DataBounty</b>\n\nYou'll get alerts here — bounties, submissions, validations and karma. Manage channels anytime in your dashboard."
      )
    : telegramReply(
        update.chatId,
        "⚠️ <b>That link didn't work</b>\n\nIt may have expired. Open <b>Notifications → Telegram</b> in DataBounty and tap <b>link Telegram</b> for a fresh code."
      );
}

/**
 * Long-polls Telegram's `getUpdates` for `/start <code>` messages and
 * completes the link. This substitutes for a real webhook, which needs a
 * public HTTPS URL this local-dev environment doesn't have — polling every
 * few seconds is the honest, fully-functional alternative rather than a
 * stub that only works once deployed somewhere with a public endpoint.
 * `offset` is kept in-memory only (matches the rest of this codebase's
 * "resumable via server restart, not persisted mid-flight" pattern for
 * dev-only background listeners) — a restart re-polls from Telegram's
 * current head, which just means any message sent while the poller was
 * down needs to be sent again.
 */
export async function pollTelegramUpdatesOnce(offset: number | null): Promise<number | null> {
  if (!config.telegramBotToken) return offset;
  const url = new URL(apiUrl("getUpdates"));
  url.searchParams.set("timeout", "5");
  if (offset !== null) url.searchParams.set("offset", String(offset));

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 5000) });
  if (!res.ok) return offset;
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: TelegramUpdate[] } | null;
  if (!body?.ok || !body.result) return offset;

  let nextOffset = offset;
  for (const update of body.result) {
    nextOffset = update.update_id + 1;
    // Same parse + verify + attach path the webhook uses, so the two entry
    // points can never diverge on what counts as a valid link.
    const parsed = parseTelegramUpdate(update);
    if (!parsed || !LINK_COMMAND.test(parsed.text)) continue;
    const code = LINK_COMMAND.exec(parsed.text)![1]!;
    const result = await completeTelegramLink(code, parsed.chatId, parsed.handle);
    await sendTelegramMessage(
      parsed.chatId,
      result === "linked"
        ? "You're linked! DataBounty notifications will be delivered here."
        : "This link has expired. Go back to DataBounty and generate a new one."
    ).catch(() => {});
  }
  return nextOffset;
}

/** Runs the poll loop until the process exits. Every tick failure is
 * caught and logged — a transient Telegram API hiccup must not kill the
 * whole worker process, which also handles the real job queue. */
export async function runTelegramPollLoop(): Promise<void> {
  if (!telegramConfigured()) {
    console.log("[telegram] not configured (no TELEGRAM_BOT_TOKEN) — link polling disabled");
    return;
  }
  console.log(`[telegram] polling getUpdates for @${config.telegramBotUsername}`);
  let offset: number | null = null;
  for (;;) {
    try {
      offset = await pollTelegramUpdatesOnce(offset);
    } catch (err) {
      console.error("[telegram] poll error:", err instanceof Error ? err.message : err);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
