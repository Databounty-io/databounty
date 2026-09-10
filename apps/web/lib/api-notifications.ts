// SPDX-License-Identifier: Apache-2.0

/**
 * Typed client for the notifications API (`/v1/notifications`, `/channels`,
 * `/watch-prefs`) on databounty-api.
 */
import { authedFetch, type Channel, type ChannelId, type WatchPrefs } from "@/lib/store";
import { API, withQuery } from "@/lib/api-endpoints";
import { apiClient } from "@/lib/api-client";
import type { DatasetCategory, Notification } from "@/lib/types";

export const WATCH_LANGUAGES = [
  "TypeScript",
  "JavaScript",
  "Python",
  "Java",
  "Go",
  "Rust",
  "SQL",
];

const CATEGORY_KEYS: DatasetCategory[] = [
  "debugging",
  "implementation",
  "test_generation",
  "error_diagnosis",
  "migration",
];
const CHANNEL_IDS: ChannelId[] = ["email", "telegram", "discord", "slack", "google_chat", "microsoft_teams"];

// Fastify's built-in 404 handler writes messages of the exact shape
// "Route POST:/v1/foo/bar not found" whenever a route genuinely doesn't
// exist server-side — that's a routing implementation detail, never
// something a real handler would phrase that way. Trusting `body.message`
// blindly (as every catch block below used to) meant a missing backend
// route silently displayed that raw string to the user instead of the
// friendly fallback the catch block already had ready. A handler's own
// `reply.notFound("Bond not found")`-style message never matches this
// pattern, so it still passes through untouched.
const FASTIFY_ROUTE_NOT_FOUND = /^Route (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):.* not found$/;
function safeMessage(message: string | undefined, fallback: string): string {
  if (!message || FASTIFY_ROUTE_NOT_FOUND.test(message)) return fallback;
  return message;
}

interface ApiNotification {
  id: string;
  type: string;
  category?: string | null;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  href?: string;
}
interface ApiChannel {
  channel: ChannelId;
  address: string;
  connected: boolean;
  verified: boolean;
  deliver: boolean;
  channelLabel?: string | null;
  lastError?: string | null;
  lastFailureAt?: string | null;
  lastSuccessAt?: string | null;
}
export interface SlackChannelOption {
  id: string;
  name: string;
  isMember: boolean;
  isPrivate: boolean;
}
export interface SlackChannelList {
  channels: SlackChannelOption[];
  privateChannelsUnavailable: boolean;
  error?: string;
}
export interface TelegramLink {
  code: string;
  instructions: string;
  botUrl?: string | null;
  botUsername?: string | null;
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

function toStoreNotification(a: ApiNotification): Notification {
  return {
    id: a.id,
    type: a.type.replaceAll(".", "_"),
    category: a.category ?? null,
    title: a.title,
    body: a.body,
    time: relTime(a.createdAt),
    read: a.read,
    href: a.href,
  };
}

function toStoreChannels(list: ApiChannel[]): Record<ChannelId, Channel> {
  const byId = new Map(list.map((c) => [c.channel, c]));
  return Object.fromEntries(
    CHANNEL_IDS.map((id) => {
      const c = byId.get(id);
      return [
        id,
        {
          connected: c?.connected ?? false,
          address: c?.address ?? "",
          deliver: c?.deliver ?? false,
          verified: c?.verified ?? false,
          channelLabel: c?.channelLabel ?? null,
          lastError: c?.lastError ?? null,
          lastFailureAt: c?.lastFailureAt ?? null,
          lastSuccessAt: c?.lastSuccessAt ?? null,
        },
      ];
    })
  ) as Record<ChannelId, Channel>;
}

function toStoreWatchPrefs(a: { enabled: boolean; categories: string[]; languages: string[] }): WatchPrefs {
  const cats = new Set(a.categories);
  const langs = new Set(a.languages);
  const categoryKeys = Array.from(new Set([...CATEGORY_KEYS, ...a.categories])) as DatasetCategory[];
  const languageKeys = Array.from(new Set([...WATCH_LANGUAGES, ...a.languages]));
  return {
    enabled: a.enabled,
    categories: Object.fromEntries(categoryKeys.map((k) => [k, cats.has(k)])) as Record<DatasetCategory, boolean>,
    languages: Object.fromEntries(languageKeys.map((l) => [l, langs.has(l)])),
  };
}

export interface NotificationsPage {
  notifications: Notification[];
  nextCursor: string | null;
  unreadCount: number;
}

// The API (GET /v1/notifications, src/routes/v1/notifications.ts) is
// offset-paginated — `{limit, offset, unreadOnly}` in, `{items, total,
// unreadCount, limit, offset}` out. There is no server-side cursor. The
// store's inbox state (lib/store.tsx) is written against a cursor
// abstraction, so this client encodes the next offset as an opaque cursor
// string rather than reshaping every call site: cursor `"40"` means "resume
// after the 40 items already loaded," and `null` once `offset + items.length
// >= total` means fully caught up.
export async function fetchNotifications(cursor?: string, unread?: boolean): Promise<NotificationsPage> {
  const offset = cursor ? Number(cursor) : 0;
  const data = await apiClient.get<{
    items: ApiNotification[];
    total: number;
    unreadCount: number;
    limit: number;
    offset: number;
  }>(withQuery(API.notifications.list, { limit: 50, offset, unreadOnly: unread || undefined }));
  const items = data.items ?? [];
  const nextOffset = (data.offset ?? offset) + items.length;
  return {
    notifications: items.map(toStoreNotification),
    nextCursor: items.length > 0 && nextOffset < (data.total ?? 0) ? String(nextOffset) : null,
    unreadCount: data.unreadCount ?? 0,
  };
}

export async function fetchChannels(): Promise<Record<ChannelId, Channel>> {
  const data = await apiClient.get<{ channels: ApiChannel[] }>(API.notifications.channels);
  return toStoreChannels(data.channels ?? []);
}

export async function fetchWatchPrefs(): Promise<WatchPrefs> {
  return toStoreWatchPrefs(await apiClient.get(API.watchPrefs));
}

export async function markRead(id: string) {
  const res = await authedFetch(API.notifications.read(id), { method: "POST" });
  if (!res.ok) throw new Error(`markRead failed (${res.status})`);
  return res;
}

export async function markAllRead() {
  const res = await authedFetch(API.notifications.readAll, { method: "POST" });
  if (!res.ok) throw new Error(`markAllRead failed (${res.status})`);
  return res;
}

export async function patchChannel(id: ChannelId, patch: { deliver?: boolean; address?: string }) {
  const res = await authedFetch(API.notifications.channel(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return null;
  return toStoreChannels(((await res.json()) as { channels: ApiChannel[] }).channels ?? []);
}

export type ConnectChannelResult =
  | { ok: true; channels: Record<ChannelId, Channel> }
  | { ok: false; error: string };

export async function connectChannel(id: ChannelId, address: string): Promise<ConnectChannelResult> {
  try {
    const res = await authedFetch(API.notifications.channelConnect(id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      const fallback =
        res.status === 401
          ? "Your session has expired. Please sign in again."
          : res.status === 403
            ? "You do not have permission to connect this channel."
            : res.status === 429
              ? "Too many attempts. Please wait a moment and try again."
              : res.status >= 500
                ? "The notification service is temporarily unavailable. Please try again."
                : `Could not connect this channel (HTTP ${res.status}).`;
      return { ok: false, error: safeMessage(body.message, fallback) };
    }
    return { ok: true, channels: toStoreChannels(((await res.json()) as { channels: ApiChannel[] }).channels ?? []) };
  } catch {
    return { ok: false, error: "Could not reach the notification service. Check your connection and try again." };
  }
}

export async function startIntegrationConnect(provider: "slack" | "google_chat" | "microsoft_teams"): Promise<string | null> {
  const res = await authedFetch(API.notifications.integrationConnect, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { url?: string };
  return data.url ?? null;
}

export const startSlackConnect = () => startIntegrationConnect("slack");

export async function fetchSlackChannels(): Promise<SlackChannelList> {
  const res = await authedFetch(API.notifications.slackChannels, { method: "GET" });
  if (!res.ok) {
    let error = "Couldn't load Slack channels — reconnect Slack and try again.";
    try {
      const body = (await res.json()) as { message?: string };
      error = safeMessage(body?.message, error);
    } catch {
      /* keep the default message */
    }
    return { channels: [], privateChannelsUnavailable: false, error };
  }
  const data = (await res.json()) as { channels?: SlackChannelOption[]; privateChannelsUnavailable?: boolean };
  return { channels: data.channels ?? [], privateChannelsUnavailable: Boolean(data.privateChannelsUnavailable) };
}

export async function selectSlackChannel(channelId: string, channelName?: string) {
  const res = await authedFetch(API.notifications.slackSelectChannel, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId, channelName }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: false as const, error: safeMessage(body.message, "Could not select that channel.") };
  }
  return { ok: true as const, channels: toStoreChannels(((await res.json()) as { channels: ApiChannel[] }).channels ?? []) };
}

export async function verifyChannel(id: ChannelId, code?: string) {
  const res = await authedFetch(API.notifications.channelVerify(id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(code ? { code } : {}),
  });
  if (!res.ok) return null;
  return toStoreChannels(((await res.json()) as { channels: ApiChannel[] }).channels ?? []);
}

export async function sendChannelTest(
  id: ChannelId
): Promise<{ ok: boolean; error?: string; channels?: Record<ChannelId, Channel> }> {
  const res = await authedFetch(API.notifications.channelTest(id), { method: "POST" });
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { channels?: ApiChannel[] };
    return { ok: true, ...(body.channels ? { channels: toStoreChannels(body.channels) } : {}) };
  }
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return { ok: false, error: safeMessage(body.message, "Test delivery failed.") };
}

export async function disconnectChannel(id: ChannelId) {
  const res = await authedFetch(API.notifications.channel(id), { method: "DELETE" });
  if (!res.ok) return null;
  return toStoreChannels(((await res.json()) as { channels: ApiChannel[] }).channels ?? []);
}

export async function startTelegramLink(): Promise<TelegramLink | null> {
  const res = await authedFetch(API.telegram.linkStart, { method: "POST" });
  if (!res.ok) return null;
  return (await res.json()) as TelegramLink;
}

export function putWatchPrefs(prefs: WatchPrefs) {
  const categories = (Object.keys(prefs.categories) as DatasetCategory[]).filter((k) => prefs.categories[k]);
  const languages = Object.keys(prefs.languages).filter((l) => prefs.languages[l] !== false);
  return authedFetch(API.watchPrefs, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: prefs.enabled, categories, languages }),
  });
}
