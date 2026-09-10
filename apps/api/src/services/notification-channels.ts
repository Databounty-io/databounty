// SPDX-License-Identifier: Apache-2.0

import { createHash, randomInt } from "node:crypto";
import { ChannelKind, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { renderEmail } from "../lib/email-template.js";
import { sendMail } from "../lib/mailer.js";
import { NotificationDeliveryError, sendNotificationEmail } from "../lib/notification-mailer.js";
import { postSlackMessage } from "./slack.js";
import { sendTelegramMessage } from "./telegram.js";
import { CHANNEL_SYNTAX, renderChatMessage, renderDigestChat, type ChannelSyntax } from "./notifications/chat-render.js";
import type { DigestPayload } from "./notifications/digest.js";
import { digestHtml } from "./notifications/digest.js";
import { digestUnsubscribeUrl } from "../lib/digest-unsubscribe-token.js";

/* ==========================================================================
 * Webhook destinations — an SSRF surface first, a delivery feature second.
 *
 * A webhook address is user-supplied and makes THIS server issue an outbound
 * POST, so the destination is checked as a PARSED `URL` (protocol, then the
 * hostname against a per-provider allowlist, then the path prefix) rather
 * than by a prefix regex over the raw string. It is checked twice: when the
 * address is stored (`connectChannel` / `patchChannel`) and again immediately
 * before EVERY send (`sendWebhook`), so an address that stops being allowed
 * — an allowlist tightened after it was stored, or a row written by any
 * other path — is refused rather than posted to.
 *
 * The transport itself mirrors `mcp-client-metadata.ts`: `redirect: "error"`
 * (a 3xx is a second, unvetted destination and is never followed — with the
 * default `follow`, an open redirect on an allowlisted provider would have
 * been enough to reach an arbitrary host, up to 20 hops, with the message
 * body), a hard timeout, and the response body drained under a byte cap so a
 * slow or oversized responder cannot hold a connection or memory hostage.
 * Which providers are allowed is unchanged: Discord, Google Chat, Teams.
 * ======================================================================== */

interface WebhookHostRule {
  /** Exact, lower-case hostnames accepted for this provider … */
  hosts?: readonly string[];
  /** … or a whole-hostname pattern where the provider uses per-tenant subdomains. */
  hostPattern?: RegExp;
  /** Required leading path, where the provider has a fixed webhook prefix. */
  pathPrefix?: string;
}

const WEBHOOK_HOST_RULES: Partial<Record<ChannelKind, WebhookHostRule>> = {
  discord: { hosts: ["discord.com", "discordapp.com"], pathPrefix: "/api/webhooks/" },
  google_chat: { hosts: ["chat.googleapis.com"], pathPrefix: "/v1/spaces/" },
  // Tenant label is one DNS label: `<tenant>.webhook.office.com` and nothing
  // deeper, so `evil.webhook.office.com.attacker.example` and
  // `a.b.webhook.office.com` both fail.
  microsoft_teams: { hostPattern: /^[a-z0-9-]+\.webhook\.office\.com$/ },
};

/** The 8 s the two previous inline `AbortSignal.timeout(8000)` calls used —
 * unchanged, just named (the metadata fetcher's `CLIENT_METADATA_TIMEOUT_MS`
 * is 5 s; a webhook POST is allowed a little longer because it is retried by
 * the dispatcher, not answered to an interactive OAuth client). */
export const WEBHOOK_TIMEOUT_MS = 8_000;
/** Same cap as `CLIENT_METADATA_MAX_BYTES`. The provider's response body is
 * never used (Discord answers 204, Google Chat echoes the message), so it is
 * drained up to this many bytes and then the stream is cancelled. */
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;

const CODE_TTL_MS = 10 * 60 * 1000;

function isWebhookChannel(channel: ChannelKind): boolean {
  return channel in WEBHOOK_HOST_RULES;
}

/**
 * True iff `address` is an https URL whose HOST (not raw-string prefix) is on
 * the provider's allowlist, with no credentials in the URL and the provider's
 * required path prefix. Everything the constructor cannot parse is refused.
 */
export function isAllowedWebhookUrl(channel: ChannelKind, address: string): boolean {
  const rule = WEBHOOK_HOST_RULES[channel];
  if (!rule) return false;
  if (typeof address !== "string" || address.length === 0 || address.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  // A non-default port would still be the provider's host, but no provider
  // serves webhooks anywhere but 443 — refuse rather than reason about it.
  if (url.port !== "") return false;
  const hostname = url.hostname.toLowerCase();
  if (!hostname) return false;
  const hostOk = rule.hosts ? rule.hosts.includes(hostname) : rule.hostPattern ? rule.hostPattern.test(hostname) : false;
  if (!hostOk) return false;
  if (rule.pathPrefix && !url.pathname.startsWith(rule.pathPrefix)) return false;
  return true;
}

function assertAllowedWebhookUrl(channel: ChannelKind, address: string): void {
  if (!isAllowedWebhookUrl(channel, address)) {
    throw new ChannelError(`That doesn't look like a real ${channel.replace("_", " ")} webhook URL.`);
  }
}

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

let webhookFetchImpl: WebhookFetch = (url, init) => fetch(url, init);

/** Test seam only: replace the transport (pass `null` to restore `fetch`). */
export function setWebhookFetch(impl: WebhookFetch | null): void {
  webhookFetchImpl = impl ?? ((url, init) => fetch(url, init));
}

export interface WebhookSendResult {
  status: number;
  /** Response bytes actually read (never more than `WEBHOOK_MAX_RESPONSE_BYTES`). */
  bodyBytes: number;
  /** True when the response body was longer than the cap and the rest was discarded unread. */
  bodyTruncated: boolean;
}

/** Thrown by `sendWebhook`; `redirected` marks a refused 3xx so callers can
 * classify it as permanent rather than a transient network failure. */
export class WebhookTransportError extends Error {
  constructor(
    message: string,
    public readonly redirected: boolean,
  ) {
    super(message);
    this.name = "WebhookTransportError";
  }
}

/** Read at most `limit` bytes of `response`, then cancel the stream. */
async function drainBodyCapped(response: Response, limit: number): Promise<{ bytes: number; truncated: boolean }> {
  const body = response.body;
  if (!body) return { bytes: 0, truncated: false };
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => undefined);
          return { bytes: limit, truncated: true };
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return { bytes: total, truncated: false };
}

/**
 * The one place a webhook is ever POSTed. Re-validates the destination, never
 * follows a redirect, times out, and caps the response read. Resolves with
 * the status (including non-2xx — the caller decides what a status means);
 * rejects with `ChannelError` for a refused destination and
 * `WebhookTransportError` for a refused redirect or a transport failure.
 */
export async function sendWebhook(channel: ChannelKind, url: string, text: string): Promise<WebhookSendResult> {
  assertAllowedWebhookUrl(channel, url);
  let res: Response;
  try {
    res = await webhookFetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload(channel, text)),
      redirect: "error",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    // undici surfaces a refused redirect as `TypeError: fetch failed` with
    // `cause: Error("unexpected redirect")`; name it so it is not retried as
    // if it were a blip.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    if (/redirect/i.test(cause) || (err instanceof Error && /redirect/i.test(err.message))) {
      throw new WebhookTransportError("Webhook responded with a redirect; redirects are refused.", true);
    }
    throw new WebhookTransportError(err instanceof Error ? err.message : "Webhook request failed.", false);
  }
  // Belt and braces: `redirect: "error"` already rejected any 3xx, but an
  // injected transport that hands one back is refused the same way.
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new WebhookTransportError("Webhook responded with a redirect; redirects are refused.", true);
  }
  const drained = await drainBodyCapped(res, WEBHOOK_MAX_RESPONSE_BYTES);
  return { status: res.status, bodyBytes: drained.bytes, bodyTruncated: drained.truncated };
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export class ChannelError extends Error {}

/** Connect a channel to a destination address. Webhook channels (Discord/
 * Google Chat/Teams) are address-only — there is no OAuth app for any of
 * them, only "Incoming Webhook" URLs the user creates on the provider's own
 * side and pastes here, so the URL itself is the whole connect flow. Email
 * still needs an ownership check, so it starts unverified with a one-time
 * code (see `startEmailVerification`/`verifyChannelCode` below) rather than
 * trusting an arbitrary address. */
export async function connectChannel(userId: string, channel: ChannelKind, address: string) {
  if (isWebhookChannel(channel)) {
    assertAllowedWebhookUrl(channel, address);
    return prisma.notificationChannel.upsert({
      where: { userId_channel: { userId, channel } },
      create: { userId, channel, address, connected: true, verified: false, deliver: true },
      update: { address, connected: true, verified: false, lastError: null },
    });
  }

  if (channel === ChannelKind.email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new ChannelError("That doesn't look like a real email address.");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const row = await prisma.notificationChannel.upsert({
      where: { userId_channel: { userId, channel } },
      create: {
        userId,
        channel,
        address,
        connected: true,
        verified: false,
        deliver: true,
        verifyCodeHash: hashCode(code),
        verifyCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
      update: {
        address,
        connected: true,
        verified: false,
        lastError: null,
        verifyCodeHash: hashCode(code),
        verifyCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    await sendMail({
      to: address,
      subject: "Your DataBounty verification code",
      text: `Your code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
      html: `<p>Your code is <strong>${code}</strong>. It expires in 10 minutes.</p><p>If you didn't request this, ignore this email.</p>`,
    });
    return row;
  }

  throw new ChannelError(`${channel} does not support a direct connect — it needs its own sign-in flow.`);
}

/**
 * A channel becoming deliverable is itself a notification-worthy event
 * (v1's `channel.connected`): it is the one message that proves, through the
 * new destination, that the new destination works. Emitted through the normal
 * outbox so it dispatches like anything else.
 *
 * The import is dynamic on purpose — `services/notifications.ts` imports the
 * `channelRegistry` from this module, so a static import here would be a
 * module-init cycle. Resolving it lazily at call time is not.
 */
async function emitChannelConnected(userId: string, channel: ChannelKind): Promise<void> {
  try {
    const { notifyEvent } = await import("./notifications.js");
    await prisma.$transaction((tx) =>
      notifyEvent(tx, "channel.connected", {
        userId,
        // Idempotent per channel: re-verifying the same channel does not
        // produce a second inbox row.
        keySuffix: `${userId}:${channel}`,
        data: { channel: channel.replace("_", " ") },
      })
    );
  } catch (err) {
    console.error(`[notifications] channel.connected emit failed for ${userId}/${channel}:`, err);
  }
}

export async function verifyChannelCode(userId: string, channel: ChannelKind, code: string) {
  const row = await prisma.notificationChannel.findUnique({ where: { userId_channel: { userId, channel } } });
  if (!row || !row.verifyCodeHash || !row.verifyCodeExpiresAt) throw new ChannelError("No pending verification for this channel.");
  if (row.verifyCodeExpiresAt.getTime() < Date.now()) throw new ChannelError("That code expired. Request a new one.");
  if (hashCode(code) !== row.verifyCodeHash) throw new ChannelError("That code doesn't match.");
  const updated = await prisma.notificationChannel.update({
    where: { id: row.id },
    data: { verified: true, verifiedAt: new Date(), verifyCodeHash: null, verifyCodeExpiresAt: null, lastError: null },
  });
  if (!row.verified) await emitChannelConnected(userId, channel);
  return updated;
}

function webhookPayload(channel: ChannelKind, text: string): unknown {
  if (channel === ChannelKind.discord) return { content: text };
  if (channel === ChannelKind.google_chat) return { text };
  if (channel === ChannelKind.microsoft_teams) return { text };
  return { text };
}

/** Sends one real message through the channel's stored destination — the
 * only honest way to prove a webhook URL actually works, since nothing else
 * here ever calls the provider. A webhook channel becomes `verified` the
 * first time this succeeds (there's no separate ownership-code step for a
 * URL only the connecting user could have created on the provider's side). */
export async function testChannel(userId: string, channel: ChannelKind) {
  const row = await prisma.notificationChannel.findUnique({ where: { userId_channel: { userId, channel } } });
  if (!row || !row.connected) throw new ChannelError("Connect this channel before sending a test.");

  const text = "This is a test notification from DataBounty. If you can see this, delivery to this channel is working.";
  try {
    if (isWebhookChannel(channel)) {
      const res = await sendWebhook(channel, row.address, text);
      if (res.status < 200 || res.status >= 300) throw new Error(`Webhook returned HTTP ${res.status}`);
      await prisma.notificationChannel.update({
        where: { id: row.id },
        data: { verified: true, verifiedAt: row.verifiedAt ?? new Date(), lastSuccessAt: new Date(), lastError: null },
      });
      if (!row.verified) await emitChannelConnected(userId, channel);
      return { ok: true };
    }
    if (channel === ChannelKind.email) {
      if (!row.verified) throw new Error("Verify this email address first.");
      await sendMail({ to: row.address, subject: "DataBounty test notification", text });
      await prisma.notificationChannel.update({ where: { id: row.id }, data: { lastSuccessAt: new Date(), lastError: null } });
      return { ok: true };
    }
    if (channel === ChannelKind.slack) {
      await postSlackMessage(userId, row.address, text);
      await prisma.notificationChannel.update({ where: { id: row.id }, data: { lastSuccessAt: new Date(), lastError: null } });
      return { ok: true };
    }
    if (channel === ChannelKind.telegram) {
      await sendTelegramMessage(row.address, text);
      await prisma.notificationChannel.update({ where: { id: row.id }, data: { lastSuccessAt: new Date(), lastError: null } });
      return { ok: true };
    }
    throw new Error(`${channel} delivery is not wired up yet.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Test delivery failed.";
    await prisma.notificationChannel.update({ where: { id: row.id }, data: { lastFailureAt: new Date(), lastError: message } });
    return { ok: false, error: message };
  }
}

export async function patchChannel(userId: string, channel: ChannelKind, patch: { deliver?: boolean; address?: string }) {
  const data: Prisma.NotificationChannelUpdateInput = {};
  if (patch.deliver !== undefined) data.deliver = patch.deliver;
  if (patch.address !== undefined) {
    if (isWebhookChannel(channel)) assertAllowedWebhookUrl(channel, patch.address);
    data.address = patch.address;
    data.verified = false; // a changed destination needs re-proving, same as a fresh connect.
  }
  return prisma.notificationChannel.update({ where: { userId_channel: { userId, channel } }, data });
}

export async function disconnectChannel(userId: string, channel: ChannelKind) {
  await prisma.notificationChannel.deleteMany({ where: { userId, channel } });
}

/* ==========================================================================
 * Delivery registry — the transport layer the dispatch worker fans out over.
 *
 * Until now the six adapters above were reachable ONLY from the connect/
 * verify/test paths (`connectChannel`, `testChannel`), which is why the
 * platform recorded notifications and never delivered any of them. This is
 * the registry `dispatchPendingNotifications` (services/notifications.ts)
 * injects, mirroring v1's `channelRegistry` in
 * services/notifications/channels.ts.
 *
 * Contract every adapter honours:
 *   - resolve  → the provider accepted the message
 *   - throw    → it did not. Throw `NotificationDeliveryError` with
 *                `retryable: false` for a permanent condition (unconfigured
 *                transport, rejected recipient) so the delivery row
 *                dead-letters instead of burning eight retries.
 * An adapter must NEVER swallow an error: the caller writes `sent` on
 * resolution, so a swallowed failure becomes a fabricated success.
 * ======================================================================== */

export interface ChannelMessage {
  title: string;
  body: string;
  /** Absolute deep link back into the app / admin console. */
  href?: string;
  /** Present only on `digest.summary` rows; adapters render the structure. */
  digest?: DigestPayload;
}

export type ChannelAdapter = (
  address: string,
  message: ChannelMessage,
  ctx: { userId: string }
) => Promise<void>;

function chatText(channel: keyof typeof CHANNEL_SYNTAX, message: ChannelMessage): string {
  const syntax: ChannelSyntax = CHANNEL_SYNTAX[channel];
  return message.digest ? renderDigestChat(syntax, message.digest) : renderChatMessage(syntax, message);
}

async function postWebhook(channel: ChannelKind, url: string, text: string): Promise<void> {
  let res: WebhookSendResult;
  try {
    res = await sendWebhook(channel, url, text);
  } catch (err) {
    // A destination that is no longer allowed, or a redirect, is permanent:
    // retrying will not make the stored address acceptable. Network/timeout
    // is genuinely transient, keep retrying.
    if (err instanceof ChannelError) throw new NotificationDeliveryError(`Webhook destination refused: ${err.message}`.slice(0, 300), false);
    if (err instanceof WebhookTransportError && err.redirected) throw new NotificationDeliveryError(err.message, false);
    throw new NotificationDeliveryError(
      err instanceof Error ? `Webhook request failed: ${err.message}`.slice(0, 300) : "Webhook request failed.",
      true
    );
  }
  if (res.status < 200 || res.status >= 300) {
    // 4xx (except 429) means the webhook URL is revoked/wrong — permanent.
    // 429 and 5xx are worth retrying.
    const retryable = res.status === 429 || res.status >= 500;
    throw new NotificationDeliveryError(`Webhook returned HTTP ${res.status}.`, retryable);
  }
}

/** Wrap a transport whose thrown errors are plain `Error`s so the dispatcher
 * still gets a retryability signal. Unknown failures stay retryable, matching
 * v1's `deliveryFailure` default. */
async function retryable(run: () => Promise<void>, fallback: string): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (err instanceof NotificationDeliveryError) throw err;
    const message = err instanceof Error ? err.message.slice(0, 300) : fallback;
    throw new NotificationDeliveryError(message, true);
  }
}

export const channelRegistry: Record<ChannelKind, ChannelAdapter> = {
  async email(address, message, ctx) {
    // Routine digest mail is the only opted-in bulk mail this platform sends,
    // so it is the only mail that carries an unsubscribe affordance (visible
    // footer + RFC 2369/8058 headers). Transactional, security and deadline
    // mail deliberately does not — see routes/v1/notifications.ts.
    const unsubscribeUrl = message.digest ? digestUnsubscribeUrl(ctx.userId) : undefined;
    // Non-digest mail goes through the shared branded template, which escapes
    // every interpolation. The hand-rolled markup this replaced escaped only
    // `&` and `<` in the body and interpolated `message.href` into an
    // `href="..."` attribute completely unescaped — one un-encoded quote from
    // an attribute breakout — and shipped no branding, no CTA button and no
    // printed link fallback. V1 routes this through its shared renderer too.
    const html = message.digest
      ? digestHtml(message.digest, unsubscribeUrl)
      : renderEmail({
          heading: message.title,
          paragraphs: [message.body],
          button: message.href ? { label: "Open in DataBounty", href: message.href } : undefined,
        }).html;
    await sendNotificationEmail({
      to: address,
      subject: message.title,
      text: unsubscribeUrl
        ? `${chatText("email", message)}\n\nUnsubscribe from digest emails: ${unsubscribeUrl}`
        : chatText("email", message),
      html,
      // One-click unsubscribe: the POST endpoint is token-authenticated, so a
      // mailbox provider can honour it without a session.
      headers: unsubscribeUrl
        ? { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
        : undefined,
    });
  },
  async telegram(address, message) {
    await retryable(() => sendTelegramMessage(address, chatText("telegram", message)), "Telegram delivery failed.");
  },
  async slack(address, message, ctx) {
    await retryable(() => postSlackMessage(ctx.userId, address, chatText("slack", message)), "Slack delivery failed.");
  },
  async discord(address, message) {
    await postWebhook(ChannelKind.discord, address, chatText("discord", message));
  },
  async google_chat(address, message) {
    await postWebhook(ChannelKind.google_chat, address, chatText("google_chat", message));
  },
  async microsoft_teams(address, message) {
    await postWebhook(ChannelKind.microsoft_teams, address, chatText("microsoft_teams", message));
  },
};

export type ChannelRegistry = typeof channelRegistry;
