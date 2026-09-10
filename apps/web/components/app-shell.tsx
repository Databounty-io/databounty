"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authedFetch, useDemo } from "@/lib/store";
import { API } from "@/lib/api-endpoints";
import { Icon, type IconName } from "./icons";
import { Brandmark, Logo } from "./brand";
import { LANDING_URL } from "@/lib/urls";
import { Popover, TOUCH_TARGET, Toaster, Tooltip } from "./ui";
import { VerifyEmailBanner } from "./verify-email-banner";

const SIDEBAR_COLLAPSED_KEY = "db-sidebar-collapsed";
const sidebarListeners = new Set<() => void>();

function subscribeSidebarCollapsed(onChange: () => void) {
  sidebarListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    sidebarListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function sidebarCollapsedSnapshot() {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
}

function writeSidebarCollapsed(next: boolean) {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
  sidebarListeners.forEach((listener) => listener());
}

const SignInCard = dynamic(() => import("./auth").then((m) => m.SignInCard), { ssr: false });
const OnboardingModal = dynamic(() => import("./auth").then((m) => m.OnboardingModal), { ssr: false });

function isUploadHandoffPath(pathname: string): boolean {
  return pathname === "/upload" || pathname.startsWith("/upload/") || pathname.startsWith("/upload-review");
}

export { PageHeader } from "./ui";

export function GlobalToaster() {
  const { toasts, dismissToast } = useDemo();
  return <Toaster toasts={toasts} onDismiss={dismissToast} />;
}

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

type KarmaSummary = {
  total: number;
  tier: { name: string; label: string; color: string };
  nextTier: { name: string; label: string; minKarma: number; karmaToGo: number } | null;
  tiers: Array<{ name: string; minKarma: number }>;
};

type KarmaSummaryState = {
  data: KarmaSummary | null;
  status: "loading" | "ready" | "error";
};

const KARMA_REFRESH_MS = 15_000;

function useKarmaSummary(enabled: boolean): KarmaSummaryState {
  const [state, setState] = useState<KarmaSummaryState>({
    data: null,
    status: "loading",
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let fetching = false;
    const refresh = async () => {
      if (fetching || document.visibilityState !== "visible") return;
      fetching = true;
      try {
        const res = await authedFetch(API.me.communityKarma);
        if (!res.ok) throw new Error("karma summary unavailable");
        const data = (await res.json()) as KarmaSummary;
        if (!cancelled) {
          setState({ data, status: "ready" });
        }
      } catch {
        if (!cancelled) {
          setState((current) => ({ ...current, status: "error" }));
        }
      } finally {
        fetching = false;
      }
    };

    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(), KARMA_REFRESH_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled]);

  return state;
}

const NAV: NavItem[] = [
  // Owner instruction 2026-09-07: Analytics is the starting page — it is the
  // route every login and every completed sign-up lands on (see
  // lib/home-route.ts), so it leads the sidebar rather than sitting below the
  // three workspaces. Scope stays inside D22 (member-owned charts only).
  { href: "/analytics", label: "Analytics", icon: "chart" },
  { href: "/sponsor", label: "Sponsor", icon: "database" },
  { href: "/contributor", label: "Contributor", icon: "code" },
  { href: "/validator", label: "Validator", icon: "shield" },
  { href: "/karma", label: "Karma", icon: "sparkles" },
  { href: "/profile", label: "Profile", icon: "award" },
  { href: "/developers", label: "API & MCP", icon: "code" },
  { href: "/notifications", label: "Notifications", icon: "bell" },
  { href: "/issues", label: "Support cases", icon: "alert" },
];

export function DashboardSidebarLink({
  href,
  label,
  icon,
  active = false,
  badge,
  collapsed = false,
}: {
  href: string;
  label: string;
  icon: IconName;
  active?: boolean;
  badge?: React.ReactNode;
  collapsed?: boolean;
}) {
  const link = (
    <Link
      href={href}
      aria-label={collapsed ? label : undefined}
      className={`flex items-center gap-[11px] rounded-[7px] px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime focus-visible:ring-offset-2 focus-visible:ring-offset-dark ${
        collapsed ? "justify-center px-0" : ""
      } ${
        active
          ? "bg-[rgba(163,246,10,.12)] text-lime"
          : "text-dark-soft hover:bg-dark-nav-hover hover:text-dark-text"
      }`}
    >
      <Icon name={icon} size={15} />
      {!collapsed && (
        <>
          {label}
          {badge && <span className="ml-auto">{badge}</span>}
        </>
      )}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Tooltip label={label} side="right">
      {link}
    </Tooltip>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    authReady,
    signedIn,
    onboarded,
    user,
    authMethod,
    unreadCount,
    signOut,
  } = useDemo();
  const rawPathname = usePathname();
  const pathname = rawPathname.replace(/\/+$/, "") || "/";
  const router = useRouter();
  const unread = unreadCount;
  const karmaSummary = useKarmaSummary(signedIn);

  const sidebarCollapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    sidebarCollapsedSnapshot,
    () => false
  );
  const toggleSidebar = () => writeSidebarCollapsed(!sidebarCollapsed);

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-panel px-4">
        <div className="card w-full max-w-sm px-8 py-9 text-center">
          <div className="flex justify-center">
            <Brandmark size={32} />
          </div>
          <p className="mt-5 font-mono text-sm text-ink-soft">Restoring session…</p>
        </div>
      </div>
    );
  }

  if (isUploadHandoffPath(pathname)) {
    return <>{children}</>;
  }

  if (!signedIn) {
    return <SignInCard />;
  }


  const accountLabel = user?.name || "account";

  const handleSignOut = () => {
    signOut();
    router.push("/");
  };

  return (
    <div className="flex min-h-screen">
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-dark-line bg-dark transition-[width] duration-150 lg:flex ${
          sidebarCollapsed ? "w-[68px]" : "w-60"
        }`}
      >
        <div
          className={`flex h-16 shrink-0 items-center border-b border-dark-line ${
            sidebarCollapsed ? "justify-center px-2" : "px-[22px]"
          }`}
        >
          {sidebarCollapsed ? (
            <a href={LANDING_URL} aria-label="DataBounty home" className="flex h-8 w-8 shrink-0 items-center justify-center">
              <Brandmark size={22} />
            </a>
          ) : (
            <Logo size="sm" />
          )}
        </div>
        <div className="absolute -right-3 top-[24px] z-50">
          <Tooltip label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} side="right">
            <button
              onClick={toggleSidebar}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-dark-line-soft bg-dark-card text-dark-text shadow-[0_1px_4px_rgba(0,0,0,0.45)] transition-colors hover:border-lime/70 hover:text-lime"
            >
              <Icon
                name="chevron-right"
                size={13}
                className={`transition-transform ${sidebarCollapsed ? "" : "rotate-180"}`}
              />
            </button>
          </Tooltip>
        </div>
        <SidebarNavList pathname={pathname} unread={unread} collapsed={sidebarCollapsed} />
        <SidebarAccountFooter
          accountLabel={accountLabel}
          userEmail={user?.email}
          authMethod={authMethod}
          karmaSummary={karmaSummary}
          onSignOut={handleSignOut}
          collapsed={sidebarCollapsed}
        />
      </aside>

      <div
        className={`flex min-w-0 flex-1 flex-col transition-[padding] duration-150 ${
          sidebarCollapsed ? "lg:pl-[68px]" : "lg:pl-60"
        }`}
      >
        <MobileHeader
          unread={unread}
          pathname={pathname}
          accountLabel={accountLabel}
          userEmail={user?.email}
          authMethod={authMethod}
          karmaSummary={karmaSummary}
          onSignOut={handleSignOut}
        />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <VerifyEmailBanner />
          {children}
        </main>
      </div>

      {!onboarded && <OnboardingModal />}
    </div>
  );
}

function SidebarNavList({
  pathname,
  unread,
  onNavigate,
  collapsed = false,
}: {
  pathname: string;
  unread: number;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  return (
    <nav className="flex-1 space-y-[3px] overflow-visible p-3 font-mono text-[13px]">
      {NAV.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <div key={item.href} className={collapsed ? "flex justify-center" : undefined} onClick={onNavigate}>
            <DashboardSidebarLink
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={active}
              collapsed={collapsed}
              badge={
                item.href === "/notifications" && unread > 0 ? (
                  <span className="ml-auto rounded-full bg-lime px-1.5 py-px text-[10px] font-bold text-dark">
                    {unread}
                  </span>
                ) : null
              }
            />
          </div>
        );
      })}
    </nav>
  );
}

function SidebarAccountFooter({
  accountLabel,
  userEmail,
  authMethod,
  karmaSummary,
  onSignOut,
  onNavigate,
  collapsed = false,
}: {
  accountLabel: string;
  userEmail?: string | null;
  authMethod?: string | null;
  karmaSummary: KarmaSummaryState;
  onSignOut: () => void;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const [handle, setHandle] = useState<string | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void authedFetch(API.me.publicProfile)
      .then(async (res) => {
        if (!res.ok) return;
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setHandle(body.handle ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const closeMenuAndNavigate = () => {
    setProfileMenuOpen(false);
    onNavigate?.();
  };
  const footerClass = collapsed
    ? "relative flex flex-col items-center gap-1.5 border-t border-dark-line p-3 font-mono"
    : "relative border-t border-dark-line p-3 font-mono";

  return (
    <div className={footerClass}>
      <KarmaSidebarSummary summary={karmaSummary} collapsed={collapsed} />
      <Popover
        open={profileMenuOpen}
        onOpenChange={setProfileMenuOpen}
        className={collapsed ? "" : "mt-1"}
        trigger={collapsed ? (
          <Tooltip label="Account menu" side="right">
            <button
              type="button"
              onClick={() => setProfileMenuOpen((current) => !current)}
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[rgba(163,246,10,.14)] text-[12px] font-bold text-lime transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime"
            >
              {accountLabel.slice(0, 1).toUpperCase()}
            </button>
          </Tooltip>
        ) : (
          <button type="button" onClick={() => setProfileMenuOpen((current) => !current)} aria-haspopup="menu" aria-expanded={profileMenuOpen} className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-dark-nav-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[rgba(163,246,10,.14)] text-[12px] font-bold text-lime">
              {accountLabel.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-dark-text">{accountLabel}</span>
              <span className="block truncate text-[10px] text-dark-dim">{userEmail ?? `signed in via ${authMethod ?? "—"}`}</span>
            </span>
            <Icon name="chevron-right" size={13} className={`shrink-0 text-dark-dim transition-transform ${profileMenuOpen ? "rotate-90" : ""}`} />
          </button>
        )}
      >
        <AccountPopover
          accountLabel={accountLabel}
          userEmail={userEmail}
          handle={handle}
          collapsed={collapsed}
          onNavigate={closeMenuAndNavigate}
          onSignOut={() => {
            setProfileMenuOpen(false);
            onSignOut();
          }}
        />
      </Popover>
    </div>
  );
}

function AccountPopover({
  accountLabel,
  userEmail,
  handle,
  collapsed,
  onNavigate,
  onSignOut,
}: {
  accountLabel: string;
  userEmail?: string | null;
  handle: string | null;
  collapsed: boolean;
  onNavigate: () => void;
  onSignOut: () => void;
}) {
  return (
    <div
      role="menu"
      aria-label="Account menu"
      className={`absolute z-50 w-60 rounded-xl border border-dark-line-soft bg-dark-card p-1.5 shadow-[0_14px_32px_rgba(0,0,0,0.45)] ${collapsed ? "bottom-0 left-full ml-2" : "bottom-full left-0 right-0 mb-2"}`}
    >
      <Link href="/profile" onClick={onNavigate} className="block rounded-lg px-2.5 py-2 transition-colors hover:bg-dark-nav-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime">
        <p className="truncate text-[11px] font-semibold text-dark-text">{accountLabel}</p>
        {userEmail && <p className="mt-0.5 truncate text-[10px] text-dark-dim">{userEmail}</p>}
      </Link>
      <div className="border-t border-dark-line py-1">
        {handle && (
          <a href={`${LANDING_URL}/${handle}`} target="_blank" rel="noopener noreferrer" onClick={onNavigate} className="group flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] text-dark-soft transition-colors hover:bg-dark-nav-hover hover:text-dark-text">
            <Icon name="award" size={13} /> Public profile <Icon name="external" size={11} className="ml-auto transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
        )}
        <a href={LANDING_URL} target="_blank" rel="noopener noreferrer" onClick={onNavigate} className="group flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] text-dark-soft transition-colors hover:bg-dark-nav-hover hover:text-dark-text">
          <Icon name="globe" size={13} /><span>Landing page</span><Icon name="external" size={13} className="ml-auto transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </a>
        <a href={`${LANDING_URL}/changelog`} target="_blank" rel="noopener noreferrer" onClick={onNavigate} className="group flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] text-dark-soft transition-colors hover:bg-dark-nav-hover hover:text-dark-text">
          <Icon name="file" size={13} /><span>Changelog</span><Icon name="external" size={13} className="ml-auto transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </a>
      </div>
      <div className="border-t border-dark-line pt-1">
        <button type="button" onClick={onSignOut} className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11px] text-dark-soft transition-colors hover:bg-red-500/10 hover:text-red-300">
          <Icon name="logout" size={13} className="transition-transform duration-150 group-hover:translate-x-0.5" /> Sign out
        </button>
      </div>
    </div>
  );
}

function KarmaSidebarSummary({
  summary,
  collapsed = false,
}: {
  summary: KarmaSummaryState;
  collapsed?: boolean;
}) {
  const { data, status } = summary;
  const currentTier = data?.tiers.find((tier) => tier.name === data.tier.name);
  const currentFloor = currentTier?.minKarma ?? 0;
  const nextFloor = data?.nextTier?.minKarma ?? currentFloor;
  const progress = data?.nextTier && nextFloor > currentFloor
    ? Math.min(100, Math.max(0, ((data.total - currentFloor) / (nextFloor - currentFloor)) * 100))
    : 100;
  const tierColor = data && /^#[0-9a-f]{6}$/i.test(data.tier.color) ? data.tier.color : "var(--color-lime)";
  const label = data
    ? `${data.total.toLocaleString()} karma · ${data.tier.label}${data.nextTier ? ` · ${data.nextTier.karmaToGo.toLocaleString()} to ${data.nextTier.label}` : " · highest tier"}`
    : status === "error"
      ? "Karma status unavailable; retrying automatically"
      : "Loading Karma status";
  const card = (
    <Link
      href="/karma"
      aria-label={label}
      className={`rounded-lg text-dark-soft transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime ${collapsed ? "flex h-9 w-9 items-center justify-center hover:bg-dark-nav-hover" : "relative mb-1 block overflow-hidden border border-dark-line-soft bg-[radial-gradient(circle_at_100%_0%,rgba(163,246,10,0.12),transparent_46%),linear-gradient(135deg,#11180e,#0b0f09)] px-2.5 py-2 hover:border-lime/50"}`}
    >
      {collapsed ? (
        <span
          className="relative flex h-8 w-8 items-center justify-center rounded-full p-[2px]"
          style={{ background: `conic-gradient(${tierColor} ${progress}%, #273120 ${progress}% 100%)` }}
        >
          <span aria-hidden="true" className="absolute inset-[2px] rounded-full bg-dark" />
          <Icon name="sparkles" size={13} className="relative text-lime" />
        </span>
      ) : (
        <Icon name="sparkles" size={15} className="absolute left-2.5 top-[11px] shrink-0 text-lime" />
      )}
      {!collapsed && (
        <div className="relative pl-6">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-[0.12em] text-dark-dim">Karma</span>
            {data && (
              <span
                className="max-w-[72px] truncate rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                style={{ backgroundColor: `${tierColor}22`, color: tierColor }}
                title={data.tier.label}
              >
                {data.tier.label}
              </span>
            )}
          </div>
          {data ? (
            <>
              <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2">
                <span className="truncate font-mono text-[13px] font-semibold tabular-nums text-dark-text" title={`${data.total.toLocaleString()} points`}>{data.total.toLocaleString()} pts</span>
                <span className="max-w-[96px] truncate text-right text-[10px] tabular-nums text-dark-dim" title={data.nextTier ? `${data.nextTier.karmaToGo.toLocaleString()} to ${data.nextTier.label}` : "Highest tier"}>
                  {data.nextTier ? `${data.nextTier.karmaToGo.toLocaleString()} to ${data.nextTier.label}` : "highest tier"}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={data.nextTier ? `Progress toward ${data.nextTier.label}` : "Highest Karma tier reached"}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#192016]"
              >
                <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${progress}%`, backgroundColor: tierColor }} />
              </div>
            </>
          ) : (
            <div className="mt-1 h-7 animate-pulse rounded bg-[#171d14]" aria-hidden="true" />
          )}
          {status === "error" && <span className="mt-1.5 block text-[9px] text-amber-300">Update unavailable</span>}
        </div>
      )}
    </Link>
  );

  return collapsed ? <Tooltip label={label} side="right">{card}</Tooltip> : card;
}

function MobileHeader({
  unread,
  pathname,
  accountLabel,
  userEmail,
  authMethod,
  karmaSummary,
  onSignOut,
}: {
  unread: number;
  pathname: string;
  accountLabel: string;
  userEmail?: string | null;
  authMethod?: string | null;
  karmaSummary: KarmaSummaryState;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = drawerRef.current;
    const selector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const timer = window.setTimeout(() => {
      (panel?.querySelector<HTMLElement>(selector) ?? panel)?.focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
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
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-dark-line bg-dark px-4 lg:hidden">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            // 36x36 measured at the 640 breakpoint — the only way to reach
            // navigation on mobile, and under the 44x44 touch minimum. The
            // header is `h-14` (56px), so `TOUCH_TARGET`'s 44px box fits
            // inside it with room; horizontally it grows to 44 and stops
            // 0px short of the logo lockup beside it, which is a later
            // sibling and so still wins any tap on the seam.
            className={`-ml-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-dark-soft transition-colors hover:bg-dark-nav-hover hover:text-dark-text ${TOUCH_TARGET}`}
          >
            <Icon name="menu" size={18} />
          </button>
          <Logo className={TOUCH_TARGET} />
        </div>
        <Link
          href="/notifications"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
          // 32x32 measured at 640 — same shortfall as the menu button. Already
          // `relative` for the unread dot, which is exactly the positioning
          // context `TOUCH_TARGET` needs; nothing sits within 6px to its left,
          // so the widened box steals no other control's taps.
          className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dark-soft transition-colors hover:bg-dark-nav-hover hover:text-dark-text ${TOUCH_TARGET}`}
        >
          <Icon name="bell" size={16} />
          {unread > 0 && (
            <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-lime" />
          )}
        </Link>
      </header>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            tabIndex={-1}
            className="relative flex h-full w-72 max-w-[80vw] flex-col border-r border-dark-line bg-dark"
          >
            <div className="flex h-16 items-center justify-between border-b border-dark-line px-[18px]">
              <Logo className={TOUCH_TARGET} />
              <button
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                // 32x32 measured at 640 — the drawer's escape hatch, so it has
                // to be as tappable as the button that opened it. The drawer
                // header is `h-16` (64px) and the brand lockup ends 22px to
                // the left, so the 44px box fits without reaching anything.
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dark-soft transition-colors hover:bg-dark-nav-hover hover:text-dark-text ${TOUCH_TARGET}`}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            <SidebarNavList pathname={pathname} unread={unread} onNavigate={() => setOpen(false)} />
            <SidebarAccountFooter
              accountLabel={accountLabel}
              userEmail={userEmail}
              authMethod={authMethod}
              karmaSummary={karmaSummary}
              onSignOut={() => {
                setOpen(false);
                onSignOut();
              }}
              onNavigate={() => setOpen(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}
