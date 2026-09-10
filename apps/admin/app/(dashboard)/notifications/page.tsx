"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AdminButton, AdminConfirmDialog, AdminErrorBanner, AdminModal, AdminPageHeader, AdminSectionHeading, AdminStat } from "@/components/admin-shell";
import { Icon } from "@/components/icons";
import { adminAuthedFetch, useAdminRoleGates } from "@/lib/admin-auth";
import { useAdminToast } from "@/lib/admin-toast";
import { useAdminResource } from "@/lib/use-admin-resource";
import { useAdminNotificationStream } from "@/lib/use-admin-notification-stream";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type AdminNotification,
} from "@/lib/api-notifications";

/** Compact relative time from an ISO string (no dep). */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Only admin-console routes are safe to deep-link from here; a notification
 * that points at the user dashboard (an admin who also contributes) is shown
 * as plain text so we never link to a route this app doesn't have. The API
 * still tags admin links with an `/admin` prefix — this app serves them at the
 * root, so the prefix is the discriminator, not part of the route. */
const isAdminHref = (href: string) => href.startsWith("/admin/");
const toAdminRoute = (href: string) => href.slice("/admin".length);

interface NotificationHealth {
  windowHours: number;
  byChannel: Record<string, { pending: number; processing: number; sent: number; failed: number; dead: number; total: number }>;
  deadLetterCount: number;
  deadLettersTruncated?: boolean;
  deadLetters: {
    id: string;
    channel: string;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
    notification: { userId: string; type: string; title: string };
  }[];
}

export default function AdminNotificationsPage() {
  const [items, setItems] = useState<AdminNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [retryTarget, setRetryTarget] = useState<{ id: string; title: string } | null>(null);
  const [retryReason, setRetryReason] = useState("");
  const { isAdmin } = useAdminRoleGates();
  const { pushToast } = useAdminToast();
  const health = useAdminResource<NotificationHealth>("/v1/admin/notifications/health?hours=168", { errorMessage: "Delivery health is unavailable." });

  const rotateSecrets = async () => {
    setRotating(true);
    try {
      const response = await adminAuthedFetch("/v1/admin/notifications/rotate-keys", { method: "POST" });
      if (!response.ok) throw new Error((await response.json().catch(() => null) as { message?: string } | null)?.message ?? "Secret rotation failed.");
      const result = await response.json() as { notificationChannels: { rotated: number; remaining: number }; profileSourceTokens: { rotated: number; remaining: number; unprotected: number } };
      const pending = result.notificationChannels.remaining + result.profileSourceTokens.remaining + result.profileSourceTokens.unprotected;
      pushToast({ variant: pending ? "error" : "success", title: pending ? "Rotation needs attention" : "Secrets rotated", body: `${result.notificationChannels.rotated + result.profileSourceTokens.rotated} values migrated.` });
    } catch (cause) {
      pushToast({ variant: "error", title: "Secret rotation failed", body: cause instanceof Error ? cause.message : undefined });
    } finally {
      setRotating(false);
      setRotateConfirmOpen(false);
    }
  };

  const submitRetryDeadLetter = async () => {
    const target = retryTarget;
    const reason = retryReason.trim();
    if (!target || reason.length < 10) return;
    setRetrying(target.id);
    try {
      const response = await adminAuthedFetch(`/v1/admin/notifications/dead-letters/${target.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null) as { message?: string } | null)?.message ?? "Retry failed.");
      pushToast({ variant: "success", title: "Delivery requeued" });
      await health.refresh();
      setRetryTarget(null);
      setRetryReason("");
    } catch (cause) {
      pushToast({ variant: "error", title: "Retry failed", body: cause instanceof Error ? cause.message : undefined });
    } finally {
      setRetrying(null);
    }
  };

  const loadNotifications = () => {
    setLoading(true);
    setError(null);
    return fetchNotifications()
      .then((rows) => setItems(rows))
      .catch((cause) => {
        setItems([]);
        setError(cause instanceof Error ? cause.message : "Could not load notifications.");
      })
      .finally(() => setLoading(false));
  };

  // Background refresh: same request, but it never flips `loading` back on, so
  // an arriving row can't blank the list the operator is reading.
  const refreshInBackground = useRef(() => {});
  useEffect(() => {
    let alive = true;
    const load = (initial: boolean) =>
      fetchNotifications()
        .then((rows) => {
          if (!alive) return;
          setItems(rows);
          setError(null);
        })
        .catch((cause) => {
          // A failed background refresh must not wipe rows already on screen;
          // only the first load has nothing to preserve.
          if (alive && initial) setError(cause instanceof Error ? cause.message : "Could not load notifications.");
        })
        .finally(() => {
          if (alive && initial) setLoading(false);
        });
    refreshInBackground.current = () => void load(false);
    void load(true);
    // Fallback poll. The SSE subscription below is what makes an urgent row
    // show up instantly; this is what guarantees it shows up at all when the
    // stream never connects or the browser drops it.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshInBackground.current();
    }, 30_000);
    return () => {
      alive = false;
      refreshInBackground.current = () => {};
      clearInterval(timer);
    };
  }, []);

  // Push parity with the user dashboard: re-read the canonical feed the moment
  // the server says something landed, instead of waiting out the poll.
  useAdminNotificationStream(() => refreshInBackground.current());

  const unread = items.filter((n) => !n.read).length;

  const readOne = (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    markNotificationRead(id).catch((cause) => {
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: false } : n)));
      setError(cause instanceof Error ? cause.message : "Could not mark notification read.");
    });
  };
  const readAll = () => {
    const before = items;
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    markAllNotificationsRead().catch((cause) => {
      setItems(before);
      setError(cause instanceof Error ? cause.message : "Could not mark notifications read.");
    });
  };

  const channels = health.data ? Object.entries(health.data.byChannel) : [];

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Notifications"
        sub="Platform events addressed to admins — disputes, signups, and escalations."
      />

      {(error || health.error) && (
        <AdminErrorBanner
          message={error || health.error}
          onRetry={() => { void loadNotifications(); void health.refresh(); }}
        />
      )}

      <section>
        <div className="flex items-center justify-between gap-3"><AdminSectionHeading title="// delivery_health" sub="Live delivery outcomes and dead letters from the last 7 days." />{isAdmin && <AdminButton variant="ghost" disabled={rotating} onClick={() => setRotateConfirmOpen(true)}>{rotating ? "Rotating…" : "Rotate secrets"}</AdminButton>}</div>
        {health.loading ? <div role="status" className="font-mono text-sm text-dark-soft">Loading delivery health…</div> : health.data && <>
          {channels.length === 0 ? <div className="font-mono text-sm text-dark-soft">No delivery attempts in the last 7 days.</div> : <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {channels.map(([channel, counts]) => <AdminStat key={channel} label={channel} value={`${counts.sent}/${counts.total} sent`} sub={`${counts.pending + counts.processing} queued · ${counts.failed} retrying · ${counts.dead} dead`} tone={counts.dead ? "rose" : "default"} alert={counts.dead > 0} />)}
          </div>}
          {health.data.deadLetters.length > 0 && <div className="mt-3 overflow-hidden rounded-xl border border-rose-400/25 bg-dark-card">
            <div className="border-b border-dark-line px-4 py-3 font-mono text-xs font-bold text-rose-300">{health.data.deadLetterCount} dead-lettered deliver{health.data.deadLetterCount === 1 ? "y" : "ies"}{health.data.deadLettersTruncated ? " · showing latest 100" : ""}</div>
            {health.data.deadLetters.map((row) => <div key={row.id} className="grid items-center gap-2 border-b border-dark-line px-4 py-3 text-xs last:border-b-0 md:grid-cols-[120px_1fr_90px_auto]">
              <span className="font-mono text-dark-soft">{row.channel} · {row.attempts} tries</span>
              <span className="min-w-0 break-words text-dark-text"><strong>{row.notification.title}</strong><br /><span className="text-rose-300">{row.lastError || "No error was recorded."}</span></span>
              <span className="font-mono text-dark-dim">{ago(row.updatedAt)}</span>
              {isAdmin && (
                <AdminButton
                  variant="ghost"
                  tooltip="Reset this delivery to pending so the dispatcher attempts it again."
                  disabled={retrying === row.id}
                  onClick={() => { setRetryTarget({ id: row.id, title: row.notification.title }); setRetryReason(""); }}
                >
                  {retrying === row.id ? "Retrying…" : "Retry"}
                </AdminButton>
              )}
            </div>)}
          </div>}
        </>}
      </section>

      <div className="flex items-center justify-between">
        <div className="font-mono text-[12px] text-dark-soft">
          {loading ? "Loading…" : `${unread} unread · ${items.length} total`}
        </div>
        {unread > 0 && (
          <AdminButton variant="ghost" onClick={readAll}>
            Mark all read
          </AdminButton>
        )}
      </div>

      {!loading && !error && items.length === 0 && (
        <div className="flex items-center gap-2.5 rounded-[10px] border border-dark-line bg-dark-card px-[18px] py-4 text-[13px] text-dark-soft">
          <Icon name="bell" size={15} strokeWidth={2} className="shrink-0" />
          <span>No notifications yet.</span>
        </div>
      )}

      <div className="space-y-2">
        {items.map((n) => {
          const body = (
            <div
              className={`flex items-start gap-3 rounded-xl border px-[18px] py-3.5 transition-colors ${
                n.read
                  ? "border-dark-line bg-dark-card"
                  : "border-amber-400/30 bg-amber-400/[0.06]"
              }`}
            >
              <span
                className={`mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full ${
                  n.read ? "bg-dark-dim" : "bg-amber-400"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="truncate text-[14px] font-bold tracking-tight text-dark-text">
                    {n.title}
                  </h2>
                  <span className="shrink-0 font-mono text-[10px] text-dark-dim">
                    {ago(n.createdAt)}
                  </span>
                </div>
                <p className="mt-0.5 text-[13px] leading-relaxed text-dark-muted">
                  {n.body}
                </p>
              </div>
              {isAdminHref(n.href) && (
                <Icon
                  name="chevron-right"
                  size={14}
                  strokeWidth={2}
                  className="mt-1 shrink-0 text-dark-dim"
                />
              )}
            </div>
          );

          return isAdminHref(n.href) ? (
            <Link key={n.id} href={toAdminRoute(n.href)} onClick={() => readOne(n.id)} className="block">
              {body}
            </Link>
          ) : (
            <button
              key={n.id}
              type="button"
              onClick={() => readOne(n.id)}
              className="block w-full cursor-pointer text-left"
            >
              {body}
            </button>
          );
        })}
      </div>

      <AdminConfirmDialog
        open={rotateConfirmOpen}
        title="Rotate all notification secrets?"
        description="This generates new encryption secrets for every notification channel and profile-source token platform-wide, replacing the current ones. Channels or integrations that cache the old secret will fail to deliver until they pick up the new value. This action cannot be undone."
        confirmLabel="Rotate secrets"
        busy={rotating}
        onConfirm={() => void rotateSecrets()}
        onCancel={() => setRotateConfirmOpen(false)}
      />

      <AdminModal
        open={retryTarget !== null}
        onClose={retrying ? undefined : () => setRetryTarget(null)}
        panelClassName="w-full max-w-lg rounded-xl border border-dark-line bg-dark-panel p-5 shadow-2xl"
      >
        <h2 className="font-mono text-base font-bold text-dark-text">Retry this delivery</h2>
        <p className="mt-2 text-sm text-dark-soft">
          This requeues the dead-lettered notification <span className="font-mono text-dark-text">{retryTarget?.title}</span> for delivery. Confirm the underlying delivery problem is fixed before retrying.
        </p>
        <label className="mt-4 block text-xs font-medium text-dark-text" htmlFor="dead-letter-retry-reason">
          Reason for retry <span className="text-rose-300">(minimum 10 characters)</span>
        </label>
        <textarea
          id="dead-letter-retry-reason"
          value={retryReason}
          onChange={(event) => setRetryReason(event.target.value)}
          rows={4}
          maxLength={1000}
          placeholder="Describe what was fixed before retrying…"
          className="mt-2 w-full resize-y rounded-lg border border-dark-line-soft bg-dark-card px-3 py-2 text-sm text-dark-text outline-none focus:border-lime"
        />
        <div className="mt-5 flex justify-end gap-2">
          <AdminButton variant="ghost" disabled={Boolean(retrying)} onClick={() => setRetryTarget(null)}>
            Cancel
          </AdminButton>
          <AdminButton disabled={retryReason.trim().length < 10 || Boolean(retrying)} onClick={() => void submitRetryDeadLetter()}>
            {retrying ? "Requeueing…" : "Retry delivery"}
          </AdminButton>
        </div>
      </AdminModal>
    </div>
  );
}
