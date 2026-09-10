"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon, type IconName } from "./icons";
import { useAdminToast } from "@/lib/admin-toast";
import { Brandmark, Wordmark } from "./brand";
import { AdminSidebar } from "./admin-sidebar";
import { useAdminAuth } from "@/lib/admin-auth";
import { fetchUnreadCount } from "@/lib/api-notifications";
import { useAdminNotificationStream } from "@/lib/use-admin-notification-stream";
import { formatAdminDate, formatAdminDateTime, formatUtcDateTime } from "@/lib/date";

const DETAIL_KIND_TO_HREF: Record<string, string> = {
  program: "/open-program",
  dataset: "/datasets",
  issue: "/issues",
};

export function AdminShell({ children }: { children: React.ReactNode }) {
  // trailingSlash: true in next.config resolves routes with a trailing slash;
  // strip it so exact-match checks don't silently miss.
  const pathname = usePathname().replace(/\/+$/, "") || "/";
  const router = useRouter();
  const searchParams = useSearchParams();
  const detailKind = pathname === "/details" ? searchParams.get("kind") : null;
  const activePathname = (detailKind && DETAIL_KIND_TO_HREF[detailKind]) || pathname;
  const { user, signOut } = useAdminAuth();
  const [unread, setUnread] = useState(0);
  const reloadUnread = useRef(() => {});

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchUnreadCount()
        .then((n) => alive && setUnread(n))
        .catch(() => {});
    reloadUnread.current = () => void load();
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      reloadUnread.current = () => {};
      clearInterval(t);
    };
  }, [pathname]);

  useAdminNotificationStream(() => reloadUnread.current());
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  return (
    <div className="flex min-h-screen bg-dark-shell text-dark-text">
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-dark-line bg-[#050605] px-4 lg:hidden">
        <div className="flex items-center gap-2.5">
          <Brandmark size={24} />
          <Wordmark size="sm" />
        </div>
        <button
          type="button"
          onClick={() => setNavOpen((v) => !v)}
          aria-label={navOpen ? "Close menu" : "Open menu"}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-dark-line-soft text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime focus-visible:ring-offset-2 focus-visible:ring-offset-dark"
        >
          {navOpen ? (
            <Icon name="x" size={18} strokeWidth={2} />
          ) : (
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </header>

      {navOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
        />
      )}

      <AdminSidebar
        pathname={activePathname}
        open={navOpen}
        unread={unread}
        user={user}
        onClose={closeNav}
        onSignOut={() => {
          signOut();
          router.replace("/login");
        }}
      />
      <main className="min-w-0 flex-1 pt-14 lg:ml-56 lg:pt-0">
        <div className="max-w-[1920px] px-4 pb-16 pt-6 sm:px-6 sm:pt-9 lg:px-10">{children}</div>
      </main>
    </div>
  );
}

/* ---------- Shared dark primitives for admin pages ---------- */

export function AdminPageHeader({
  title,
  sub,
  eyebrow,
  actions,
}: {
  title: string;
  sub?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-dark-dim">{eyebrow}</div>}
        <h1 className="font-mono text-2xl font-bold tracking-tight text-dark-text sm:text-[26px]">
          {title}
        </h1>
        {sub && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-dark-soft">{sub}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function AdminSectionHeading({
  title,
  sub,
}: {
  title: string;
  sub?: string;
}) {
  return (
    <div className="mb-3.5">
      <h2 className="font-mono text-base font-bold tracking-tight text-dark-text">
        {title}
      </h2>
      {sub && <p className="mt-1 text-[13px] text-dark-soft">{sub}</p>}
    </div>
  );
}

/** Horizontal tab bar for splitting one console page into sub-views. */
export function AdminTabs<T extends string>({
  tabs,
  active,
  onChange,
  className = "",
}: {
  tabs: { id: T; label: string; count?: number; tone?: "default" | "alert" }[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  const order = tabs.map((t) => t.id);

  return (
    <div
      role="tablist"
      aria-label="Sections"
      className={`thin-scroll -mb-px flex items-end gap-1 overflow-x-auto whitespace-nowrap border-b border-dark-line ${className}`}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const at = order.indexOf(active);
        const next = event.key === "ArrowRight" ? at + 1 : at - 1;
        onChange(order[(next + order.length) % order.length]);
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`shrink-0 cursor-pointer border-b-2 px-3.5 pb-2.5 pt-1.5 font-mono text-[13px] transition-colors ${
              selected
                ? "border-lime text-dark-text"
                : "border-transparent text-dark-soft hover:border-dark-hover hover:text-dark-text"
            }`}
          >
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span
                className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
                  tab.tone === "alert"
                    ? "bg-amber-400/15 text-amber-300"
                    : selected
                      ? "bg-lime/15 text-lime"
                      : "bg-dark-panel text-dark-dim"
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function AdminStat({
  label,
  value,
  sub,
  tone = "default",
  alert = false,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "lime" | "amber" | "rose";
  alert?: boolean;
}) {
  const valueTones = {
    default: "text-dark-text",
    lime: "text-lime",
    amber: "text-amber-400",
    rose: "text-rose-400",
  };
  return (
    <div
      className={`rounded-[11px] border p-[18px] font-mono ${
        alert
          ? "border-dark-danger-border bg-dark-danger-bg"
          : "border-dark-line bg-dark-card"
      }`}
    >
      <div
        className={`mb-2.5 text-[10px] uppercase tracking-normal sm:text-[9px] sm:tracking-[0.05em] ${
          alert ? "text-[#cc9988]" : "text-dark-dim"
        }`}
      >
        {label}
      </div>
      <div className={`break-words text-xl font-bold ${valueTones[tone]}`}>{value}</div>
      {sub && (
        <div
          className={`mt-1 text-[11px] sm:text-[9px] ${alert ? "text-rose-400" : "text-dark-dim"}`}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

type AdminButtonVariant = "primary" | "ghost" | "danger";

export function AdminButton({
  variant = "ghost",
  className = "",
  tooltip,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: AdminButtonVariant;
  /** Short explanation shown on hover/focus for unfamiliar admin actions. */
  tooltip?: string;
}) {
  const variants: Record<AdminButtonVariant, string> = {
    primary: "bg-lime text-dark hover:bg-lime-bright",
    ghost:
      "border border-dark-line-soft text-dark-text hover:border-dark-hover",
    danger:
      "border border-dark-danger-border bg-rose-400/10 text-rose-400 hover:bg-[#c2334d] hover:text-white",
  };
  return (
    <button
      title={tooltip}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2.5 font-mono text-xs font-medium transition-colors sm:py-2 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime focus-visible:ring-offset-2 focus-visible:ring-offset-dark ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

/** Accessible ON/OFF switch for boolean settings. */
export function AdminToggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime focus-visible:ring-offset-2 focus-visible:ring-offset-dark ${
        checked ? "bg-lime" : "border border-dark-line-soft bg-dark-panel"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${
          checked ? "translate-x-[18px] bg-dark" : "translate-x-[3px] bg-dark-soft"
        }`}
      />
    </button>
  );
}

/** Shared inline error banner for admin list/detail pages. */
export function AdminErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
    >
      <span>{message}</span>
      {onRetry && (
        <AdminButton type="button" variant="ghost" onClick={onRetry}>
          Retry
        </AdminButton>
      )}
    </div>
  );
}

/** Consistent non-blocking loading state for admin data surfaces. */
export function AdminLoadingState({ label = "Loading live data…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dark-line bg-dark-card px-6 py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-dark-panel text-lime"><Icon name="refresh" size={19} className="animate-spin" /></span>
      <span className="mt-4 font-mono text-sm text-dark-soft">{label}</span>
    </div>
  );
}

/** Consistent empty state for an available-but-empty admin data set. */
export function AdminEmptyState({ message }: { message: string }) {
  return <div className="px-5 py-4 text-sm text-dark-soft">{message}</div>;
}

/** Consistent state for a console surface that is built but switched off. */
export function AdminComingSoon({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed border-dark-line bg-dark-panel p-5">
      <Icon name="alert" size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-amber-400" />
      <div>
        <div className="font-mono text-sm font-semibold text-dark-text">{title}</div>
        <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-dark-soft">{children}</p>
      </div>
    </div>
  );
}

export type AdminPillTone =
  | "neutral"
  | "lime"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "violet";

const ADMIN_PILL_TONES: Record<AdminPillTone, string> = {
  neutral: "border-dark-line-soft text-dark-soft",
  lime: "border-lime/25 bg-lime/10 text-lime",
  success: "border-emerald-400/25 bg-emerald-400/10 text-emerald-400",
  warning: "border-dark-warn-border bg-amber-400/10 text-amber-400",
  danger: "border-dark-danger-border bg-rose-400/10 text-rose-400",
  info: "border-sky-400/25 bg-sky-400/10 text-sky-400",
  violet: "border-violet-400/25 bg-violet-400/10 text-violet-400",
};

export function AdminPill({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: AdminPillTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[10px] leading-4 ${ADMIN_PILL_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Compact, reusable read-only breakdown for an admin roster/detail row. */
export function AdminOutcomeBreakdown({
  title,
  values,
  empty = "No recorded outcomes.",
}: {
  title: string;
  values: Record<string, number>;
  empty?: string;
}) {
  const entries = Object.entries(values).filter(([, value]) => value > 0);
  return (
    <div>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-dark-dim">{title}</div>
      {entries.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {entries.map(([label, value]) => (
            <AdminPill key={label} tone="neutral">
              {label.replaceAll("_", " ")} · {value.toLocaleString()}
            </AdminPill>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs text-dark-dim">{empty}</p>
      )}
    </div>
  );
}

export function AdminTable({
  headers,
  children,
  className = "",
  caption,
}: {
  // A header may carry its own cell className so a wide table can drop
  // low-value columns at small breakpoints (pair it with the same class on the
  // matching ATd, or the row will desynchronise from the header).
  headers: Array<React.ReactNode | { label: React.ReactNode; className?: string }>;
  children: React.ReactNode;
  className?: string;
  caption?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div className={`overflow-hidden rounded-xl border border-dark-line bg-dark-card ${className}`}>
      <div ref={scrollRef} className="thin-scroll overflow-x-auto">
        <table className="w-full min-w-max text-left font-mono text-xs">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-dark-line">
              {headers.map((h, i) => {
                const cell =
                  h && typeof h === "object" && "label" in h
                    ? (h as { label: React.ReactNode; className?: string })
                    : { label: h as React.ReactNode, className: undefined };
                return (
                  <th
                    key={i}
                    className={`px-3 py-3 text-[10px] font-medium uppercase tracking-[0.05em] text-dark-dim sm:px-5 sm:text-[9.5px] ${cell.className ?? ""}`}
                  >
                    {cell.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-nav-hover [&>tr]:transition-colors [&>tr:hover]:bg-dark-row-hover">
            {children}
          </tbody>
        </table>
      </div>
      {overflowing && (
        <div className="border-t border-dark-line px-3 py-2 font-mono text-[9px] text-dark-dim">
          scroll horizontally to see all columns, including actions →
        </div>
      )}
    </div>
  );
}

export function ATd({
  children,
  className = "",
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className={`px-3 py-3 align-middle text-dark-text sm:px-5 sm:py-3.5 ${className}`}>
      {children}
    </td>
  );
}

/* ---------- Skeleton (loading placeholders) ---------- */

export function AdminSkeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-dark-line-soft ${className}`} />;
}

export function AdminTableSkeletonRows({
  columns,
  rows = 5,
  // A table whose headers drop columns at small breakpoints must drop the same
  // cells here, or the loading rows render more columns than the header and the
  // whole table sits skewed until the data lands. Pass the SAME per-column
  // classNames used on the headers/ATds.
  columnClassNames,
}: {
  columns: number;
  rows?: number;
  columnClassNames?: Array<string | undefined>;
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: columns }).map((_, c) => (
            <ATd key={c} className={columnClassNames?.[c] ?? ""}>
              <AdminSkeleton className="h-3 w-full max-w-[88px]" />
            </ATd>
          ))}
        </tr>
      ))}
    </>
  );
}

export function AdminDate({ iso, className = "" }: { iso: string; className?: string }) {
  return <time className={className} dateTime={iso} title={`UTC: ${formatUtcDateTime(iso)}`}>{formatAdminDate(iso)}</time>;
}

export function AdminDateTime({ iso, className = "" }: { iso: string; className?: string }) {
  return <time className={className} dateTime={iso} title={`UTC: ${formatUtcDateTime(iso)}`}>{formatAdminDateTime(iso)}</time>;
}

/* ---------- Toaster (dark theme) ---------- */

export function AdminGlobalToaster() {
  const { toasts, dismissToast } = useAdminToast();
  if (toasts.length === 0) return null;
  const styles: Record<"error" | "success" | "info", { wrap: string; icon: IconName }> = {
    error: { wrap: "border-dark-danger-border bg-dark-danger-bg text-rose-300", icon: "alert" },
    success: { wrap: "border-emerald-400/25 bg-[#0d1a12] text-emerald-300", icon: "check" },
    info: { wrap: "border-dark-line bg-dark-card text-dark-text", icon: "bell" },
  };
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 px-4 pb-4 sm:inset-x-auto sm:right-4 sm:items-end"
      aria-live="assertive"
    >
      {toasts.map((t) => {
        const s = styles[t.variant];
        return (
          <div
            key={t.id}
            role="alert"
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-3.5 py-3 font-mono text-[13px] shadow-lg ${s.wrap}`}
          >
            <Icon name={s.icon} size={16} className="mt-px shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{t.title}</p>
              {t.body && <p className="mt-0.5 break-words opacity-90">{t.body}</p>}
            </div>
            <button
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss"
              className="shrink-0 cursor-pointer rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Modal (shared overlay primitive, dark theme) ---------- */

export function AdminModal({
  open,
  onClose,
  children,
  panelClassName = "",
  overlayClassName = "",
}: {
  open: boolean;
  onClose?: () => void;
  children: React.ReactNode;
  panelClassName?: string;
  overlayClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const selector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const focusFirst = () => {
      const first = panel?.querySelector<HTMLElement>(selector);
      (first ?? panel)?.focus();
    };
    const timer = window.setTimeout(focusFirst, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (onClose) {
          event.preventDefault();
          onClose();
        }
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(selector));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:items-center ${overlayClassName}`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        // Cap the panel to the visual viewport so a tall dialog (or a short one
        // with the mobile keyboard open) scrolls internally instead of pushing
        // its action row off-screen where nothing can reach it.
        className={`max-h-[calc(100dvh-2rem)] overflow-y-auto ${panelClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/* ---------- Confirm dialog (dark theme) ---------- */

export function AdminConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = true,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AdminModal
      open={open}
      onClose={busy ? undefined : onCancel}
      panelClassName="w-full max-w-sm rounded-[14px] border border-dark-line bg-dark-card p-5 shadow-xl"
    >
      <div role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="font-mono text-[15px] font-bold text-dark-text">{title}</div>
        {description && (
          <div className="mt-2 text-[13px] leading-normal text-dark-soft">{description}</div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <AdminButton variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </AdminButton>
          <AdminButton
            variant={danger ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? "Working…" : confirmLabel}
          </AdminButton>
        </div>
      </div>
    </AdminModal>
  );
}
