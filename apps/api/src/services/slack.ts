// SPDX-License-Identifier: Apache-2.0

import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { encryptToken, decryptToken, signOAuthState, verifyOAuthState } from "../lib/profile-source-crypto.js";

const FETCH_TIMEOUT_MS = 8000;
// Bot scopes only — this app never reads message content or user data, just
// posts notifications and lists channel names to build the picker.
const BOT_SCOPES = "chat:write,channels:read";

export class SlackError extends Error {}

export function slackConfigured(): boolean {
  return Boolean(config.slackOAuth.clientId && config.slackOAuth.clientSecret);
}

function callbackUrl(req: { protocol: string; headers: { host?: string } }): string {
  return `${req.protocol}://${req.headers.host}/v1/integrations/slack/callback`;
}

export function buildSlackAuthorizeUrl(req: { protocol: string; headers: { host?: string } }, userId: string): string | null {
  if (!config.slackOAuth.clientId) return null;
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", config.slackOAuth.clientId);
  url.searchParams.set("scope", BOT_SCOPES);
  url.searchParams.set("redirect_uri", callbackUrl(req));
  url.searchParams.set("state", signOAuthState(userId, "slack"));
  return url.toString();
}

/** Handles the redirect back from Slack's "Add to Slack" consent screen.
 * Exchanges the code for a real bot token via oauth.v2.access and stores it
 * per-user (SlackWorkspaceConnection, never on NotificationChannel — see
 * that model's own comment on why). Returns the userId on success. */
export async function completeSlackConnect(
  req: { protocol: string; headers: { host?: string } },
  state: string,
  code: string
): Promise<string | null> {
  const verified = verifyOAuthState(state, "slack");
  if (!verified) return null;
  if (!config.slackOAuth.clientId || !config.slackOAuth.clientSecret) return null;

  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.slackOAuth.clientId,
      client_secret: config.slackOAuth.clientSecret,
      code,
      redirect_uri: callbackUrl(req),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    access_token?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string };
  } | null;
  if (!res.ok || !body?.ok || !body.access_token || !body.team?.id) return null;

  await prisma.slackWorkspaceConnection.upsert({
    where: { userId: verified.userId },
    create: {
      userId: verified.userId,
      teamId: body.team.id,
      teamName: body.team.name ?? body.team.id,
      botUserId: body.bot_user_id ?? "",
      botTokenEnc: encryptToken(body.access_token),
    },
    update: {
      teamId: body.team.id,
      teamName: body.team.name ?? body.team.id,
      botUserId: body.bot_user_id ?? "",
      botTokenEnc: encryptToken(body.access_token),
    },
  });
  return verified.userId;
}

async function botToken(userId: string): Promise<string | null> {
  const conn = await prisma.slackWorkspaceConnection.findUnique({ where: { userId } });
  if (!conn) return null;
  return decryptToken(conn.botTokenEnc);
}

export interface SlackChannelOption {
  id: string;
  name: string;
}

/** Public channels the bot can see. Private channels need an explicit
 * `groups:read` scope AND the bot to be invited to each one individually —
 * neither is true here, so `privateChannelsUnavailable` is always honestly
 * `true` rather than silently returning an incomplete private-channel list. */
export async function listSlackChannels(userId: string): Promise<{ channels: SlackChannelOption[]; privateChannelsUnavailable: boolean }> {
  const token = await botToken(userId);
  if (!token) throw new SlackError("Slack isn't connected. Reconnect and try again.");

  const url = new URL("https://slack.com/api/conversations.list");
  url.searchParams.set("types", "public_channel");
  url.searchParams.set("exclude_archived", "true");
  url.searchParams.set("limit", "200");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; channels?: { id: string; name: string }[]; error?: string } | null;
  if (!res.ok || !body?.ok) throw new SlackError(body?.error ? `Slack said: ${body.error}` : "Couldn't load Slack channels — reconnect Slack and try again.");

  return {
    channels: (body.channels ?? []).map((c) => ({ id: c.id, name: c.name })),
    privateChannelsUnavailable: true,
  };
}

export async function slackConnected(userId: string): Promise<boolean> {
  return (await prisma.slackWorkspaceConnection.findUnique({ where: { userId } })) !== null;
}

/** Real delivery — `chat.postMessage` with the connected workspace's bot
 * token. Slack's API returns 200 even on failure (the real error is in the
 * JSON body's `ok`/`error` fields), so an HTTP-status-only check would
 * silently treat a bad channel id as a success. */
export async function postSlackMessage(userId: string, channelId: string, text: string): Promise<void> {
  const token = await botToken(userId);
  if (!token) throw new SlackError("Slack isn't connected. Reconnect and try again.");

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: channelId, text }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !body?.ok) throw new SlackError(body?.error ? `Slack said: ${body.error}` : "Slack message failed to send.");
}
