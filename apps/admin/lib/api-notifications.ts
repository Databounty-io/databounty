"use client";

// SPDX-License-Identifier: Apache-2.0

/**
 * Typed client for the isolated admin notification feed. The server exposes
 * only admin events here and requires an interactive admin session.
 */
import { adminAuthedFetch } from "./admin-auth";

async function requireOk(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  throw new Error(body?.message ?? fallback);
}

export interface AdminNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  href: string;
}

export async function fetchNotifications(limit = 50): Promise<AdminNotification[]> {
  const res = await adminAuthedFetch(`/v1/admin/notifications?limit=${limit}`);
  await requireOk(res, "Could not load notifications.");
  const data = (await res.json()) as { notifications?: AdminNotification[] };
  return data.notifications ?? [];
}

export async function fetchUnreadCount(): Promise<number> {
  const res = await adminAuthedFetch(`/v1/admin/notifications?unread=true&limit=1`);
  await requireOk(res, "Could not load unread notification count.");
  const data = (await res.json()) as { unreadCount?: number };
  return data.unreadCount ?? 0;
}

export async function markNotificationRead(id: string): Promise<void> {
  const res = await adminAuthedFetch(`/v1/admin/notifications/${id}/read`, { method: "POST" });
  await requireOk(res, "Could not mark notification read.");
}

export async function markAllNotificationsRead(): Promise<void> {
  const res = await adminAuthedFetch("/v1/admin/notifications/read-all", { method: "POST" });
  await requireOk(res, "Could not mark notifications read.");
}
