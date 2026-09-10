"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useDemo, WATCH_LANGUAGES } from "@/lib/store";
import type { ChannelId } from "@/lib/store";
import type { TelegramLink, SlackChannelOption, SlackChannelList } from "@/lib/api-notifications";
import { PageHeader } from "@/components/app-shell";
import { Button, Empty, Toggle, ChannelStatusBadge, channelStatus } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { CATEGORY_LABELS } from "@/lib/format";
import type { DatasetCategory } from "@/lib/types";

interface ChannelDef {
  id: ChannelId;
  name: string;
  brand: string;
  help: string;
  setup?: string[];
  noServerSetup?: string;
  glyph: React.ReactNode;
}

const CHANNELS: ChannelDef[] = [
  {
    id: "email",
    name: "Email/Gmail",
    brand: "#FFFFFF",
    help: "Deadline and delivery summaries by verified email.",
    glyph: (
      <Image src="/brand/email.svg" alt="" aria-hidden="true" width={22} height={22} />
    ),
  },
  {
    id: "slack",
    name: "Slack",
    brand: "#FFFFFF",
    help: "Install the DataBounty Slack app, then pick the channel alerts post to right here.",
    setup: [
      "Click add to Slack and approve the DataBounty app for your workspace.",
      "Come back here and pick a public channel from the list — the bot joins it automatically.",
      "For a private channel, run /invite @DataBounty in it in Slack first, then refresh the list and pick it.",
    ],
    glyph: (
      <Image src="/brand/slack.svg" alt="" aria-hidden="true" width={22} height={22} />
    ),
  },
  {
    id: "discord",
    name: "Discord",
    brand: "#FFFFFF",
    help: "Paste a Discord incoming webhook URL. No DataBounty Discord bot or token is needed.",
    setup: [
      "Open the Discord channel settings.",
      "Go to Integrations, then Webhooks.",
      "Create a webhook and copy its URL.",
    ],
    noServerSetup: "Nothing else is needed on our side. The connect button sends a test message to verify it.",
    glyph: (
      <Image src="/brand/discord-symbol.svg" alt="" aria-hidden="true" width={22} height={22} />
    ),
  },
  {
    id: "google_chat",
    name: "Google Chat",
    brand: "#FFFFFF",
    help: "Paste a Google Chat incoming webhook URL. No DataBounty Google Chat app is needed.",
    setup: [
      "Open the Google Chat space where you want alerts.",
      "Open the space's Apps & integrations menu, then Webhooks.",
      "Create a webhook and copy its URL.",
    ],
    noServerSetup: "Nothing else is needed on our side. The connect button sends a test message to verify it.",
    glyph: (
      <Image src="/brand/google-chat-2026.svg" alt="" aria-hidden="true" width={22} height={22} />
    ),
  },
  {
    id: "telegram",
    name: "Telegram",
    brand: "#FFFFFF",
    help: "Real-time alerts from the DataBounty Telegram bot.",
    setup: [
      "Click link Telegram to get a one-time code.",
      "Open the DataBounty Telegram bot.",
      "Send /link plus the code shown here.",
    ],
    noServerSetup: "Uses the DataBounty bot. Users do not paste a token or create their own bot.",
    glyph: (
      <Image src="/brand/telegram-symbol.svg" alt="" aria-hidden="true" width={22} height={22} />
    ),
  },
];

const TYPE_ICONS: Record<string, IconName> = {
  telegram_linked: "send",
  channel_connected: "bell",
  new_work: "zap",
  submission_accepted: "check",
  submission_provisional: "check",
  submission_needs_fixes: "alert",
  tests_failed: "x",
  issue_flagged: "flag",
  issue_disputed: "flag",
  rank_changed: "award",
  task_claimed: "code",
  audit_claimed: "shield",
  audit_available: "shield",
  audit_completed: "check",
  final_dataset_ready: "download",
  type_in_review: "file",
  type_approved: "check",
  type_rejected: "alert",
  waitlist_joined: "clock",
  dispute_resolved: "check",
  dispute_upheld: "shield",
  dispute_requeued: "check",
  work_new_match: "zap",
  batch_claimed: "code",
  batch_deadline_approaching: "clock",
  submission_rejected: "x",
  validation_tests_failed: "x",
  validation_stage_result: "check",
  submission_accepted_sponsor: "check",
  audit_item_decision_recorded: "shield",
  audit_completed_validator: "check",
  dataset_final_ready: "download",
};

const TYPE_ICON_STYLES: Record<string, string> = {
  telegram_linked: "bg-accent-soft text-accent-strong",
  channel_connected: "bg-accent-soft text-accent-strong",
  new_work: "bg-ink text-lime",
  submission_accepted: "bg-emerald-50 text-success",
  submission_provisional: "bg-sky-50 text-indigo-600",
  submission_needs_fixes: "bg-amber-50 text-warn-strong",
  tests_failed: "bg-rose-50 text-rose-600",
  issue_flagged: "bg-amber-50 text-warn-strong",
  issue_disputed: "bg-amber-50 text-warn-strong",
  rank_changed: "bg-violet-50 text-violet-600",
  task_claimed: "bg-accent-soft text-accent-strong",
  audit_claimed: "bg-accent-soft text-accent-strong",
  audit_available: "bg-accent-soft text-accent-strong",
  audit_completed: "bg-emerald-50 text-success",
  final_dataset_ready: "bg-emerald-50 text-success",
  type_in_review: "bg-amber-50 text-warn-strong",
  type_approved: "bg-emerald-50 text-success",
  type_rejected: "bg-amber-50 text-warn-strong",
  waitlist_joined: "bg-sky-50 text-indigo-600",
  dispute_resolved: "bg-violet-50 text-violet-600",
  dispute_upheld: "bg-amber-50 text-warn-strong",
  dispute_requeued: "bg-emerald-50 text-success",
  work_new_match: "bg-ink text-lime",
  batch_claimed: "bg-accent-soft text-accent-strong",
  batch_deadline_approaching: "bg-sky-50 text-indigo-600",
  submission_rejected: "bg-rose-50 text-rose-600",
  validation_tests_failed: "bg-rose-50 text-rose-600",
  validation_stage_result: "bg-sky-50 text-indigo-600",
  submission_accepted_sponsor: "bg-emerald-50 text-success",
  audit_item_decision_recorded: "bg-accent-soft text-accent-strong",
  audit_completed_validator: "bg-emerald-50 text-success",
  dataset_final_ready: "bg-emerald-50 text-success",
};

const CATEGORY_ICONS: Record<string, IconName> = {
  sponsor: "layers",
  contributor: "code",
  validator: "shield",
  account: "bell",
  admin: "bell",
};
const CATEGORY_ICON_STYLES: Record<string, string> = {
  sponsor: "bg-accent-soft text-accent-strong",
  contributor: "bg-accent-soft text-accent-strong",
  validator: "bg-accent-soft text-accent-strong",
  account: "bg-sky-50 text-indigo-600",
  admin: "bg-panel text-ink-soft",
};

function NotificationCenterInner() {
  const {
    notifications,
    notifHasMore,
    loadingMoreNotifications,
    loadMoreNotifications,
    unreadCount,
    notifFilter,
    setNotifFilter,
    unreadNotifications,
    unreadHasMore,
    loadingMoreUnread,
    loadMoreUnreadNotifications,
    channels,
    connectChannel,
    connectSlack,
    refreshChannels,
    fetchSlackChannelOptions,
    selectSlackChannel,
    verifyEmailCode,
    disconnectChannel,
    setChannelDeliver,
    testChannel,
    startTelegramLink,
    watchPrefs,
    setWatchEnabled,
    toggleWatchCategory,
    toggleWatchLanguage,
    matchCounts,
    markAllRead,
    markRead,
    taxonomy,
    pushToast,
  } = useDemo();

  const watchCategories: DatasetCategory[] =
    taxonomy.categories.length > 0
      ? taxonomy.categories.map((c) => c.id)
      : (Object.keys(CATEGORY_LABELS) as DatasetCategory[]);
  const watchLanguages: string[] =
    taxonomy.languages.length > 0 ? taxonomy.languages : WATCH_LANGUAGES;

  const [warn, setWarn] = useState<string | null>(null);
  const flash = (msg: string) => {
    setWarn(msg);
    window.setTimeout(() => setWarn((w) => (w === msg ? null : w)), 2600);
  };

  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const slackResult = searchParams.get("slack");
    if (!slackResult) return;
    if (slackResult === "connected") {
      void refreshChannels();
    } else if (slackResult === "error") {
      const reason = searchParams.get("reason");
      queueMicrotask(() => flash(reason ? `Slack connection failed: ${reason}` : "Slack connection failed — try again."));
    }
    router.replace("/notifications", { scroll: false });
  }, [searchParams, refreshChannels, router]);

  const deliveringCount = CHANNELS.filter(
    (c) => channels[c.id]?.connected && channels[c.id]?.verified && channels[c.id]?.deliver
  ).length;
  const connectedCount = CHANNELS.filter((c) => channels[c.id]?.connected).length;
  const orderedChannels = [...CHANNELS].sort(
    (a, b) => Number(channels[b.id]?.connected) - Number(channels[a.id]?.connected)
  );

  const channelName = (id: ChannelId) => CHANNELS.find((c) => c.id === id)?.name ?? "Channel";
  const onToggleDeliver = (id: ChannelId) => {
    const next = !channels[id]?.deliver;
    const ok = setChannelDeliver(id, next);
    if (!ok && channels[id]?.deliver) {
      flash("Keep at least one channel on — notifications need somewhere to go.");
      return;
    }
    if (ok) {
      pushToast({ variant: "success", title: `${channelName(id)} delivery ${next ? "on" : "off"}` });
    }
  };
  const onDisconnect = (id: ChannelId) => {
    const ok = disconnectChannel(id);
    if (!ok) {
      flash("That's your only active channel. Turn on another before disconnecting it.");
      return;
    }
    pushToast({ variant: "success", title: `${channelName(id)} disconnected` });
  };

  const matchingBatches = matchCounts.batches;
  const matchingAudits = matchCounts.audits;
  const matchTotal = matchingBatches + matchingAudits;

  const sorted =
    notifFilter === "unread"
      ? unreadNotifications
      : [...notifications.filter((n) => !n.read), ...notifications.filter((n) => n.read)];
  const activeHasMore = notifFilter === "unread" ? unreadHasMore : notifHasMore;
  const activeLoadingMore = notifFilter === "unread" ? loadingMoreUnread : loadingMoreNotifications;
  const activeLoadMore = notifFilter === "unread" ? loadMoreUnreadNotifications : loadMoreNotifications;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !activeHasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) activeLoadMore();
      },
      { rootMargin: "200px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeHasMore, activeLoadingMore, activeLoadMore]);

  return (
    <div>
      <PageHeader
        title="Notification center"
        sub="See every alert, and choose where they're delivered."
      />

      <section className="mb-9">
        <div className="mb-3.5 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-mono text-base font-bold tracking-tight">
              Delivery channels
            </h2>
            <p className="mt-1 text-[13px] text-ink-soft">
              Connect the places you want alerts, then pick which ones deliver.
              Keep at least one on.
            </p>
          </div>
          <span className="font-mono text-[11px] text-ink-soft">
            <span className="font-bold text-ink">{deliveringCount}</span> of{" "}
            {connectedCount} connected delivering
          </span>
        </div>

        {warn && (
          <div className="mb-3 flex items-center gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-800">
            <Icon name="alert" size={15} className="shrink-0 text-amber-600" />
            {warn}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {orderedChannels.map((c) => (
            <ChannelCard
              key={c.id}
              def={c}
              connected={!!channels[c.id]?.connected}
              address={channels[c.id]?.address ?? ""}
              deliver={!!channels[c.id]?.deliver}
              verified={!!channels[c.id]?.verified}
              channelLabel={channels[c.id]?.channelLabel}
              lastError={channels[c.id]?.lastError}
              onConnect={(addr) => connectChannel(c.id, addr)}
              onConnectSlack={connectSlack}
              onFetchSlackChannels={fetchSlackChannelOptions}
              onSelectSlackChannel={selectSlackChannel}
              onVerifyCode={(cd) => verifyEmailCode(c.id, cd)}
              onStartTelegram={startTelegramLink}
              onDisconnect={() => onDisconnect(c.id)}
              onToggle={() => onToggleDeliver(c.id)}
              onTest={() => testChannel(c.id)}
            />
          ))}
        </div>

        {deliveringCount === 0 && (
          <div className="mt-3 flex items-center gap-2.5 rounded-[10px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">
            <Icon name="alert" size={15} className="shrink-0" />
            No delivery channel is on — you won&apos;t receive alerts anywhere.
            Connect and enable at least one.
          </div>
        )}
      </section>

      <section className="mb-9">
        <div className="mb-3.5 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-mono text-base font-bold tracking-tight">
              New-work alerts
            </h2>
            <p className="mt-1 max-w-2xl text-[13px] text-ink-soft">
              Batches are finite — the fast mover claims them. Pick the work you
              care about and we ping your channels the moment a matching batch
              opens, so you can claim it first.
            </p>
          </div>
          <button
            onClick={() => setWatchEnabled(!watchPrefs.enabled)}
            role="switch"
            aria-checked={watchPrefs.enabled}
            aria-label="New-work alerts"
            className="flex shrink-0 items-center gap-2 font-mono text-[12px]"
          >
            <Toggle on={watchPrefs.enabled} />
            <span className={watchPrefs.enabled ? "font-medium text-ink" : "text-ink-soft"}>
              {watchPrefs.enabled ? "alerts on" : "alerts off"}
            </span>
          </button>
        </div>

        <div
          className={`card p-5 ${watchPrefs.enabled ? "" : "opacity-55"}`}
        >
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[11px] border border-line-soft bg-panel px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <Icon name="zap" size={16} className="shrink-0 text-brand" />
              <span className="font-mono text-[13px] text-ink">
                {watchPrefs.enabled ? (
                  matchTotal > 0 ? (
                    <>
                      <span className="font-bold text-brand">{matchingBatches}</span> task
                      batches ·{" "}
                      <span className="font-bold text-brand">{matchingAudits}</span> audit
                      batches match right now
                    </>
                  ) : (
                    "No open work matches your filters right now."
                  )
                ) : (
                  "Alerts are off — turn them on to hear about new work first."
                )}
              </span>
            </div>
            {watchPrefs.enabled && matchTotal > 0 && (
              <div className="flex gap-2">
                {matchingBatches > 0 && (
                  <Link
                    href="/contributor"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 font-mono text-[12px] font-medium text-lime transition-colors hover:bg-black"
                  >
                    claim batches <Icon name="arrow-right" size={12} />
                  </Link>
                )}
                {matchingAudits > 0 && (
                  <Link
                    href="/validator"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 font-mono text-[12px] font-medium text-ink transition-colors hover:bg-white"
                  >
                    claim audits <Icon name="arrow-right" size={12} />
                  </Link>
                )}
              </div>
            )}
          </div>

          <div className="mb-4">
            <div className="micro-label mb-2 text-ink-faint">categories</div>
            <div className="flex flex-wrap gap-1.5">
              {watchCategories.map((cat) => (
                <FilterChip
                  key={cat}
                  label={CATEGORY_LABELS[cat] ?? cat}
                  on={!!watchPrefs.categories[cat]}
                  disabled={!watchPrefs.enabled}
                  onClick={() => toggleWatchCategory(cat)}
                />
              ))}
            </div>
          </div>

          <div>
            <div className="micro-label mb-2 text-ink-faint">languages</div>
            <div className="flex flex-wrap gap-1.5">
              {watchLanguages.map((lang) => (
                <FilterChip
                  key={lang}
                  label={lang}
                  on={watchPrefs.languages[lang] !== false}
                  disabled={!watchPrefs.enabled}
                  onClick={() => toggleWatchLanguage(lang)}
                />
              ))}
            </div>
          </div>

          <p className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3.5 font-mono text-[11px] text-ink-faint">
            <Icon name="bell" size={12} className="shrink-0" />
            Matching alerts go to the{" "}
            <span className="font-bold text-ink-soft">{deliveringCount}</span>{" "}
            channel{deliveringCount === 1 ? "" : "s"} you have delivering above.
          </p>
        </div>
      </section>

      <section id="inbox" className="scroll-mt-6">
        <div className="mb-3.5 flex items-center justify-between">
          <h2 className="font-mono text-base font-bold tracking-tight">Inbox</h2>
          <span className="font-mono text-[11px] text-ink-soft">
            {unreadCount > 0 ? `${unreadCount} unread` : "all caught up"}
          </span>
        </div>
        <div className="mb-3.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-line-soft bg-panel/60 p-1 font-mono text-[12px]">
            <button
              type="button"
              onClick={() => setNotifFilter("all")}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                notifFilter === "all"
                  ? "bg-lime font-bold text-dark"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setNotifFilter("unread")}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                notifFilter === "unread"
                  ? "bg-lime font-bold text-dark"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              Unread{unreadCount > 0 ? ` (${unreadCount})` : ""}
            </button>
          </div>
          <Button variant="ghost" size="sm" onClick={markAllRead} disabled={unreadCount === 0}>
            <Icon name="check" size={13} /> mark all read
          </Button>
        </div>
        {sorted.length === 0 ? (
          <Empty
            icon="bell"
            description={
              notifFilter === "unread"
                ? "No unread notifications — you're all caught up."
                : "No notifications yet. Activity on your community work will show up here."
            }
          />
        ) : (
        <div className="flex flex-col gap-3">
          {sorted.map((n) => {
            const icon = TYPE_ICONS[n.type] ?? (n.category && CATEGORY_ICONS[n.category]) ?? "bell";
            const iconStyle =
              TYPE_ICON_STYLES[n.type] ?? (n.category && CATEGORY_ICON_STYLES[n.category]) ?? "bg-panel text-ink-soft";
            const actionable = !!n.href && n.href !== "/notifications";
            const inner = (
              <>
                <span
                  className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg ${iconStyle}`}
                >
                  <Icon name={icon} size={16} strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-bold tracking-tight">
                      {n.title}
                    </span>
                    {!n.read && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-lime" />
                    )}
                  </div>
                  <p className="mt-1 line-clamp-6 whitespace-pre-wrap text-[13px] leading-normal text-ink-soft">
                    {n.body}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-ink-faint">
                  {n.time}
                  {actionable ? (
                    <Icon name="chevron-right" size={13} />
                  ) : !n.read ? (
                    <Icon name="check" size={13} className="opacity-0 transition-opacity group-hover:opacity-100" />
                  ) : null}
                </span>
              </>
            );
            const rowClass = `card group flex items-start gap-3.5 px-5 py-[18px] ${
              !n.read ? "border-l-2 border-l-lime" : ""
            }`;
            if (actionable) {
              return (
                <Link
                  key={n.id}
                  href={n.href!}
                  onClick={() => markRead(n.id)}
                  className={`${rowClass} transition-colors hover:bg-panel/50`}
                >
                  {inner}
                </Link>
              );
            }
            if (!n.read) {
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => markRead(n.id)}
                  title="Mark as read"
                  className={`${rowClass} w-full cursor-pointer text-left transition-colors hover:bg-panel/50`}
                >
                  {inner}
                </button>
              );
            }
            return (
              <div key={n.id} className={rowClass}>
                {inner}
              </div>
            );
          })}
        </div>
        )}

        {activeHasMore && (
          <div ref={sentinelRef} className="flex items-center justify-center py-5">
            <span className="font-mono text-[11px] text-ink-faint">
              {activeLoadingMore ? "loading older…" : ""}
            </span>
          </div>
        )}
        {!activeHasMore && sorted.length > 0 && (
          <p className="py-5 text-center font-mono text-[11px] text-ink-faint">
            you&apos;ve reached the beginning
          </p>
        )}
      </section>
    </div>
  );
}

function SlackChannelPicker({
  onFetchChannels,
  onSelectChannel,
  onDisconnect,
}: {
  onFetchChannels: () => Promise<SlackChannelList>;
  onSelectChannel: (channelId: string, channelName?: string) => Promise<{ ok: boolean; error?: string }>;
  onDisconnect: () => void;
}) {
  const [state, setState] = useState<"loading" | "ready">("loading");
  const [options, setOptions] = useState<SlackChannelOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [privateUnavailable, setPrivateUnavailable] = useState(false);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = async () => {
    setState("loading");
    const res = await onFetchChannels();
    setOptions(res.channels);
    setLoadError(res.error ?? null);
    setPrivateUnavailable(res.privateChannelsUnavailable);
    setState("ready");
  };

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;

  useEffect(() => {
    queueMicrotask(() => void load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (opt: SlackChannelOption) => {
    setPickingId(opt.id);
    setPickError(null);
    const res = await onSelectChannel(opt.id, opt.name);
    setPickingId(null);
    if (!res.ok) setPickError(res.error ?? "Could not select that channel.");
  };

  return (
    <div className="w-full rounded-xl border border-line-soft bg-[#f7faf0] p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#4A154B] text-[10px] font-bold text-white">1</span>
        <div className="text-[12px] leading-snug text-ink-soft">
          <span className="font-bold text-ink">Choose where alerts post</span>
          <p className="mt-0.5">
            Pick a public channel below. For a private channel, run{" "}
            <span className="font-mono text-ink">/invite @DataBounty</span> in that channel in Slack first, then refresh this list.
          </p>
        </div>
      </div>

      {state === "loading" && (
        <p className="mt-2.5 border-t border-line-soft pt-2 font-mono text-[11px] text-ink-faint">Loading Slack channels…</p>
      )}

      {state === "ready" && (
        <div className="mt-2.5 border-t border-line-soft pt-2">
          {loadError ? (
            <p className="font-mono text-[11px] leading-snug text-rose-600" role="alert">{loadError}</p>
          ) : privateUnavailable ? (
            <p className="mb-1.5 font-mono text-[11px] leading-snug text-amber-700" role="status">
              Private channels won&apos;t show for this connection — click <span className="text-ink">cancel</span> then reconnect Slack to grant private-channel access.
            </p>
          ) : null}
          {!loadError && options.length === 0 ? (
            <p className="font-mono text-[11px] text-ink-faint">No channels visible yet — run <span className="text-ink">/invite @DataBounty</span> in a channel in Slack, then refresh.</p>
          ) : !loadError ? (
            <>
              {options.length > 6 && (
                <div className="relative mb-1.5">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search channels…"
                    aria-label="Search Slack channels"
                    className="w-full rounded-lg border border-line bg-white px-2.5 py-1.5 pr-6 font-mono text-[12px] text-ink outline-none focus:border-ink"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer font-mono text-[12px] text-ink-faint hover:text-ink"
                    >
                      ×
                    </button>
                  )}
                </div>
              )}
              {filtered.length === 0 ? (
                <p className="font-mono text-[11px] text-ink-faint">No channels match “{query}”.</p>
              ) : (
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {filtered.map((opt) => (
                    <li key={opt.id} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 hover:bg-white">
                      <span className="min-w-0 truncate font-mono text-[12px] text-ink">
                        {opt.isPrivate ? "🔒" : "#"}
                        {opt.name}
                      </span>
                      <Button
                        size="sm"
                        type="button"
                        onClick={() => void pick(opt)}
                        disabled={pickingId === opt.id}
                        className="shrink-0"
                      >
                        {pickingId === opt.id ? "adding…" : "use this"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
          {pickError && <p className="mt-1.5 font-mono text-[11px] text-rose-600">{pickError}</p>}
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between border-t border-line-soft pt-2">
        <button type="button" onClick={() => void load()} className="cursor-pointer font-mono text-[10px] text-ink-faint hover:text-ink">refresh list</button>
        <button type="button" onClick={onDisconnect} className="cursor-pointer font-mono text-[11px] text-ink-faint hover:text-rose-600">cancel</button>
      </div>
    </div>
  );
}

const CONNECT_FIELD: Record<ChannelId, { label: string; placeholder: string; type: string } | null> = {
  email: { label: "Email address", placeholder: "you@gmail.com", type: "email" },
  discord: { label: "Discord webhook URL", placeholder: "https://discord.com/api/webhooks/...", type: "url" },
  google_chat: { label: "Google Chat webhook URL", placeholder: "https://chat.googleapis.com/v1/spaces/...", type: "url" },
  microsoft_teams: { label: "Microsoft Teams webhook URL", placeholder: "https://...webhook.office.com/...", type: "url" },
  slack: null,
  telegram: null,
};

function ChannelCard({
  def,
  connected,
  address,
  deliver,
  verified,
  channelLabel,
  lastError,
  onConnect,
  onVerifyCode,
  onStartTelegram,
  onDisconnect,
  onToggle,
  onConnectSlack,
  onFetchSlackChannels,
  onSelectSlackChannel,
  onTest,
}: {
  def: ChannelDef;
  connected: boolean;
  address: string;
  deliver: boolean;
  verified: boolean;
  channelLabel?: string | null;
  /** Reason the last delivery attempt to this channel failed, if any. */
  lastError?: string | null;
  onConnect: (address?: string) => Promise<{ ok: boolean; error?: string }>;
  onConnectSlack: () => Promise<boolean>;
  onFetchSlackChannels: () => Promise<SlackChannelList>;
  onSelectSlackChannel: (channelId: string, channelName?: string) => Promise<{ ok: boolean; error?: string }>;
  onVerifyCode: (code: string) => Promise<boolean>;
  onStartTelegram: () => Promise<TelegramLink | null>;
  onDisconnect: () => void;
  onToggle: () => void;
  onTest: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const field = CONNECT_FIELD[def.id];
  const [value, setValue] = useState("");
  const [tg, setTg] = useState<TelegramLink | null>(null);
  const [tgBusy, setTgBusy] = useState(false);
  const [code, setCode] = useState("");
  const [codeErr, setCodeErr] = useState(false);
  const [test, setTest] = useState<"idle" | "sending" | "ok" | "err">("idle");
  const [testErr, setTestErr] = useState<string | null>(null);
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackErr, setSlackErr] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectErr, setConnectErr] = useState<string | null>(null);

  const handleSlackOAuth = async () => {
    setSlackBusy(true);
    setSlackErr(null);
    const ok = await onConnectSlack();
    setSlackBusy(false);
    if (!ok) {
      setSlackErr("Couldn't start Slack sign-in. Check the Slack app configuration and try again.");
    }
  };

  const runTest = async () => {
    setTest("sending");
    setTestErr(null);
    const res = await onTest();
    if (res.ok) {
      setTest("ok");
      window.setTimeout(() => setTest((t) => (t === "ok" ? "idle" : t)), 3000);
    } else {
      setTest("err");
      setTestErr(res.error ?? "Test delivery failed.");
    }
  };

  const status = channelStatus({ connected, verified, deliver });
  const isDelivering = status === "delivering";
  const isPending = status === "pending";

  const startTelegram = async () => {
    if (tgBusy) return;
    setTgBusy(true);
    try {
      const res = await onStartTelegram();
      if (res) setTg(res);
    } finally {
      setTgBusy(false);
    }
  };

  const submitCode = async () => {
    if (!code.trim()) return;
    const ok = await onVerifyCode(code.trim());
    if (ok) {
      setCode("");
      setCodeErr(false);
    } else {
      setCodeErr(true);
    }
  };

  const awaitingCode = connected && def.id === "email" && !verified;

  return (
    <div
      className={`card min-w-0 p-4 transition-colors ${
        isDelivering
          ? "border-lime bg-[#f7fce9]"
          : isPending
            ? "border-amber-300"
            : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px]"
          style={{ backgroundColor: def.brand }}
        >
          {def.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold tracking-tight text-ink">
                {def.name}
              </span>
              <ChannelStatusBadge status={status} />
            </div>
            {connected && verified && (
              <button
                type="button"
                role="switch"
                aria-checked={deliver}
                aria-label={`Toggle delivery for ${def.name}`}
                onClick={onToggle}
                className="shrink-0 cursor-pointer"
              >
                <Toggle on={deliver} size="md" />
              </button>
            )}
          </div>
          <p className="mt-1 text-[12.5px] leading-snug text-ink-soft">
            {connected && address ? (
              <span className="block truncate font-mono text-ink">
                {channelLabel ? `${channelLabel} · ` : ""}
                {address}
              </span>
            ) : (
              def.help
            )}
          </p>
          {connected && lastError && (
            <p
              role="alert"
              className="mt-1 font-mono text-[11px] leading-snug text-rose-600"
            >
              Delivery needs attention: {lastError}
            </p>
          )}
        </div>
      </div>

      {awaitingCode && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50/70 p-3">
          <p className="font-mono text-[11px] text-amber-900">
            We sent a verification code to <span className="font-bold">{address}</span>. Enter it to start delivering.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setCodeErr(false);
              }}
              onKeyDown={(e) => e.key === "Enter" && submitCode()}
              placeholder="6-digit code"
              className="w-32 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-ink"
            />
            <Button size="sm" onClick={submitCode}>
              verify
            </Button>
            <button
              type="button"
              onClick={onDisconnect}
              className="font-mono text-[11px] text-ink-faint hover:text-ink"
            >
              change address
            </button>
          </div>
          {codeErr && (
            <p className="mt-1 font-mono text-[11px] text-rose-600">
              Invalid or expired code.
            </p>
          )}
        </div>
      )}

      {connected && def.id === "slack" && !channelLabel && (
        <div className="mt-3">
          <SlackChannelPicker
            onFetchChannels={onFetchSlackChannels}
            onSelectChannel={onSelectSlackChannel}
            onDisconnect={onDisconnect}
          />
        </div>
      )}

      {!connected && (
        <div className="mt-3 border-t border-line-soft pt-3">
          {def.id === "slack" ? (
            <div className="space-y-2">
              <Button size="sm" onClick={handleSlackOAuth} disabled={slackBusy}>
                {slackBusy ? "opening…" : "add to Slack"}
              </Button>
              {slackErr && <p className="font-mono text-[11px] text-rose-600">{slackErr}</p>}
            </div>
          ) : def.id === "telegram" ? (
            <div>
              {!tg ? (
                <Button size="sm" onClick={startTelegram} disabled={tgBusy}>
                  {tgBusy ? "generating code…" : "link Telegram"}
                </Button>
              ) : (
                <div className="rounded-xl border border-line-soft bg-panel p-3 font-mono text-[12px]">
                  <p className="text-ink-soft">Send this code to the Telegram bot:</p>
                  <p className="my-1.5 text-base font-bold text-ink">{tg.code}</p>
                  <p className="text-[11px] text-ink-faint">{tg.instructions}</p>
                  {tg.botUrl && (
                    <a
                      href={tg.botUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block rounded-lg bg-ink px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90"
                    >
                      Open Telegram →
                    </a>
                  )}
                </div>
              )}
            </div>
          ) : field ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  type={field.type}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={field.placeholder}
                  className="flex-1 rounded-lg border border-line bg-white px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    if (!value.trim()) return;
                    setConnectBusy(true);
                    setConnectErr(null);
                    const res = await onConnect(value.trim());
                    setConnectBusy(false);
                    if (!res.ok) setConnectErr(res.error ?? "Failed to connect");
                  }}
                  disabled={connectBusy || !value.trim()}
                >
                  {connectBusy ? "connecting…" : "connect"}
                </Button>
              </div>
              {connectErr && <p className="font-mono text-[11px] text-rose-600">{connectErr}</p>}
            </div>
          ) : null}
        </div>
      )}

      {connected && verified && (
        <div className="mt-3 flex items-center justify-between border-t border-line-soft pt-2.5 font-mono text-[11px]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runTest}
              disabled={test === "sending"}
              className="text-ink-soft hover:text-ink"
            >
              {test === "sending" ? "sending…" : test === "ok" ? "test sent ✓" : "send test"}
            </button>
            {test === "err" && <span className="text-rose-600">{testErr}</span>}
          </div>
          <button
            type="button"
            onClick={onDisconnect}
            className="text-ink-faint hover:text-rose-600"
          >
            disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  label,
  on,
  disabled,
  onClick,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full border px-3 py-1 font-mono text-[11.5px] transition-colors ${
        disabled
          ? "cursor-not-allowed border-line text-ink-faint opacity-60"
          : "cursor-pointer"
      } ${
        on
          ? "border-ink bg-ink text-lime"
          : "border-line text-ink-soft hover:border-ink hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}

export function NotificationCenterView() {
  return (
    <Suspense fallback={<div className="font-mono text-xs text-ink-soft">Loading notifications…</div>}>
      <NotificationCenterInner />
    </Suspense>
  );
}

export default function NotificationCenterPage() {
  return <NotificationCenterView />;
}
