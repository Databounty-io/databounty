// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ChannelKind } from "@prisma/client";
import { requireAuth, type AuthedUser } from "../../lib/rbac.js";
import { prisma } from "../../lib/prisma.js";
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  subscribeNotificationStream,
} from "../../services/notifications.js";
import { connectChannel, verifyChannelCode, testChannel, patchChannel, disconnectChannel, ChannelError } from "../../services/notification-channels.js";
import { listSlackChannels, slackConnected, SlackError } from "../../services/slack.js";
import { config } from "../../config.js";
import { readDigestUnsubscribeToken } from "../../lib/digest-unsubscribe-token.js";

function serializeChannel(row: { channel: string; address: string; connected: boolean; verified: boolean; deliver: boolean; lastError: string | null; lastFailureAt: Date | null; lastSuccessAt: Date | null }) {
  return {
    channel: row.channel,
    address: row.address,
    connected: row.connected,
    verified: row.verified,
    deliver: row.deliver,
    channelLabel: CHANNEL_LABELS[row.channel] ?? row.channel,
    lastError: row.lastError,
    lastFailureAt: row.lastFailureAt,
    lastSuccessAt: row.lastSuccessAt,
  };
}

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  google_chat: "Google Chat",
  microsoft_teams: "Microsoft Teams",
};

export async function notificationRoutes(app: FastifyInstance) {
  /* ------------------------------------------------------------------------
   * Public, token-authenticated digest unsubscribe (ported from v1's
   * routes/v1/notifications.ts `GET|POST /unsubscribe-digest`).
   *
   * Deliberately NOT session-authenticated: the link is followed from a mail
   * client on a device that is not logged in — that is the whole point. The
   * signed AES-GCM capability token IS the credential (see
   * lib/digest-unsubscribe-token.ts for why that is safe and how it fails
   * closed). It can only turn routine digest mail off, for exactly one user,
   * and never touches security/transactional/deadline delivery.
   * ---------------------------------------------------------------------- */

  // A browser GET must not mutate a preference: mail clients, link scanners
  // and prefetchers routinely follow URLs. The user gets a confirmation form.
  app.get("/unsubscribe-digest", async (req, reply) => {
    const token = (req.query as { token?: unknown }).token;
    if (typeof token !== "string" || !readDigestUnsubscribeToken(token)) {
      return reply.code(400).type("text/plain").send("This unsubscribe link is invalid or has expired.");
    }
    // Echoed back into a hidden input, so escape it even though a verified
    // token is base64url by construction (defence in depth, not a claim that
    // the value is attacker-controlled at this point).
    const safeToken = token.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    return reply
      .type("text/html; charset=utf-8")
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Unsubscribe from digest emails</title><body><h1>Unsubscribe from digest emails</h1><p>This stops routine DataBounty digest emails only. Account security, verification, deadline, and other essential messages remain enabled.</p><form method="post"><input type="hidden" name="token" value="${safeToken}"><button type="submit">Unsubscribe</button></form></body></html>`
      );
  });

  // RFC 8058 one-click unsubscribe target. Idempotent: a mail client may
  // POST this more than once, and a token whose user no longer has an email
  // channel row is still reported as unsubscribed rather than 404 — there is
  // nothing to deliver, and a distinguishable error here would be an account
  // enumeration oracle on an unauthenticated endpoint.
  app.post("/unsubscribe-digest", async (req, reply) => {
    const body = req.body as { token?: unknown } | undefined;
    const raw = body?.token;
    const parsed = typeof raw === "string" ? readDigestUnsubscribeToken(raw) : null;
    if (!parsed) {
      return reply.code(400).type("text/plain").send("This unsubscribe link is invalid or has expired.");
    }
    // Scoped to exactly (this user, email channel, digest delivery). It never
    // disconnects the channel and never clears `deliver`, so immediate,
    // security and action-required mail is untouched. `deliverDigest` is the
    // flag the dispatcher already gates digest rows on
    // (services/notifications.ts — `digest.summary` requires deliverDigest).
    await prisma.notificationChannel.updateMany({
      where: { userId: parsed.userId, channel: ChannelKind.email },
      data: { deliverDigest: false },
    });
    return reply.code(200).type("text/plain").send("You have been unsubscribed from routine digest emails.");
  });

  // List Notifications
  app.get("/", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const query = req.query as { limit?: string; offset?: string; unreadOnly?: string };

    const notifications = await listNotifications(user.id, {
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
      unreadOnly: query.unreadOnly === "true",
    });

    return reply.send(notifications);
  });

  // Mark single notification read
  app.post("/:id/read", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const { id } = req.params as { id: string };

    await markNotificationRead(user.id, id);
    return reply.send({ ok: true });
  });

  // Mark all notifications read
  app.post("/read-all", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    await markAllNotificationsRead(user.id);
    return reply.send({ ok: true });
  });

  // List notification channels
  app.get("/channels", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const rows = await prisma.notificationChannel.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });

    return reply.send({ channels: rows.map(serializeChannel) });
  });

  // Every mutation route below returns the caller's FULL current channel
  // list, not just the one row touched — the frontend's connect/verify/
  // patch/disconnect helpers all read `body.channels` unconditionally
  // (defaulting to `[]` when absent), so returning only the touched row
  // silently wiped every other connected channel from the client's view.
  async function currentChannels(userId: string) {
    const rows = await prisma.notificationChannel.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    return rows.map(serializeChannel);
  }

  function parseChannelId(req: FastifyRequest, reply: import("fastify").FastifyReply): ChannelKind | null {
    const { id } = req.params as { id: string };
    if (!(Object.values(ChannelKind) as string[]).includes(id)) {
      reply.notFound(`Unknown channel: ${id}`);
      return null;
    }
    return id as ChannelKind;
  }

  const connectBody = z.object({ address: z.string().trim().min(1).max(500) });

  app.post("/channels/:id/connect", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const channel = parseChannelId(req, reply);
    if (!channel) return;
    const parsed = connectBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    try {
      await connectChannel(user.id, channel, parsed.data.address);
      return reply.send({ channels: await currentChannels(user.id) });
    } catch (err) {
      if (err instanceof ChannelError) return reply.badRequest(err.message);
      throw err;
    }
  });

  const verifyBody = z.object({ code: z.string().trim().min(1).max(20) });

  app.post("/channels/:id/verify", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const channel = parseChannelId(req, reply);
    if (!channel) return;
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    try {
      await verifyChannelCode(user.id, channel, parsed.data.code);
      return reply.send({ channels: await currentChannels(user.id) });
    } catch (err) {
      if (err instanceof ChannelError) return reply.badRequest(err.message);
      throw err;
    }
  });

  app.post("/channels/:id/test", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const channel = parseChannelId(req, reply);
    if (!channel) return;
    try {
      const result = await testChannel(user.id, channel);
      return reply.send({ ...result, channels: await currentChannels(user.id) });
    } catch (err) {
      if (err instanceof ChannelError) return reply.badRequest(err.message);
      throw err;
    }
  });

  const patchBody = z.object({ deliver: z.boolean().optional(), address: z.string().trim().min(1).max(500).optional() });

  app.patch("/channels/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const channel = parseChannelId(req, reply);
    if (!channel) return;
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    try {
      await patchChannel(user.id, channel, parsed.data);
      return reply.send({ channels: await currentChannels(user.id) });
    } catch (err) {
      if (err instanceof ChannelError) return reply.badRequest(err.message);
      throw err;
    }
  });

  app.delete("/channels/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const channel = parseChannelId(req, reply);
    if (!channel) return;
    await disconnectChannel(user.id, channel);
    return reply.send({ channels: await currentChannels(user.id) });
  });

  // Channels the connected Slack bot can post to — the picker
  // `POST /select-channel` (below) reads from. See services/slack.ts for
  // why private channels are never included.
  app.get("/slack/channels", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    try {
      const result = await listSlackChannels(user.id);
      return reply.send(result);
    } catch (err) {
      if (err instanceof SlackError) return reply.badRequest(err.message);
      throw err;
    }
  });

  const selectSlackChannelBody = z.object({ channelId: z.string().trim().min(1), channelName: z.string().trim().optional() });

  // Finishes the Slack connect flow: the OAuth install (services/slack.ts's
  // callback) only proves the workspace trusts this app — it doesn't say
  // where to post. Picking a channel from the bot-visible list is what
  // actually activates delivery, so this is the point NotificationChannel
  // gets its `slack` row (connected + verified — being on the picker list
  // already proves the bot can post there).
  app.post("/slack/select-channel", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = selectSlackChannelBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    if (!(await slackConnected(user.id))) return reply.badRequest("Slack isn't connected. Reconnect and try again.");

    await prisma.notificationChannel.upsert({
      where: { userId_channel: { userId: user.id, channel: ChannelKind.slack } },
      create: {
        userId: user.id,
        channel: ChannelKind.slack,
        // The real posting target for chat.postMessage — a channel ID, not
        // the friendly name, which Slack doesn't need and can be renamed
        // out from under a stored string anyway.
        address: parsed.data.channelId,
        connected: true,
        verified: true,
        verifiedAt: new Date(),
        deliver: true,
      },
      update: {
        address: parsed.data.channelId,
        connected: true,
        verified: true,
        verifiedAt: new Date(),
        lastError: null,
      },
    });
    return reply.send({ channels: await currentChannels(user.id) });
  });

  // SSE Stream
  app.get("/stream", { preHandler: [requireAuth] }, async (req, reply) => {
    const user = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;

    // Writing straight to reply.raw bypasses Fastify's normal reply
    // lifecycle, so @fastify/cors (which stages its headers via
    // reply.header() for Fastify's own send path) never applies them here —
    // same gap as the admin notification stream, fixed the same way.
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      reply.raw.setHeader("Vary", "Origin");
    }
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    reply.raw.write(`data: ${JSON.stringify({ type: "connected", userId: user.id })}\n\n`);

    const unsubscribe = subscribeNotificationStream(user.id, (notification) => {
      reply.raw.write(`data: ${JSON.stringify(notification)}\n\n`);
    });

    const interval = setInterval(() => {
      reply.raw.write(": keep-alive\n\n");
    }, 25000);

    req.raw.on("close", () => {
      clearInterval(interval);
      unsubscribe();
    });
  });
}
