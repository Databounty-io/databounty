"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Brandmark, Wordmark } from "./brand";
import { Icon, type IconName } from "./icons";
import { adminRoleGates, type AdminUser } from "@/lib/admin-auth";
import { DASHBOARD_URL, LANDING_URL } from "@/lib/urls";

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  badge?: number;
  /** Only rendered for the `admin` role — pages that 403 for member/support. */
  adminOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Overview", icon: "grid" },
      { href: "/users", label: "Users", icon: "users" },
      { href: "/datasets", label: "Dataset types", icon: "file" },
    ],
  },
  {
    label: "Community",
    items: [
      { href: "/open-program", label: "Open Program", icon: "users" },
      { href: "/open-leaderboard", label: "Open leaderboard", icon: "chart" },
      { href: "/activity", label: "Activity rollup", icon: "chart" },
      { href: "/contributors", label: "Contributors", icon: "code" },
      { href: "/validators", label: "Validators", icon: "shield" },
      { href: "/submissions", label: "Submissions", icon: "layers" },
      { href: "/artifacts", label: "Artifacts", icon: "zap" },
      { href: "/karma", label: "Karma & badges", icon: "award", adminOnly: true },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/disputes", label: "Flags & disputes", icon: "flag" },
      { href: "/issues", label: "Agent issues", icon: "alert" },
      { href: "/notifications", label: "Notifications", icon: "bell" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/health", label: "System health", icon: "alert" },
      { href: "/execution-health", label: "Execution health", icon: "zap", adminOnly: true },
      { href: "/llm", label: "AI settings", icon: "beaker", adminOnly: true },
      { href: "/audit-logs", label: "Audit & jobs", icon: "shield", adminOnly: true },
      { href: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

function isActiveRoute(pathname: string, href: string) {
  return href === "/" ? pathname === href : pathname.startsWith(href);
}

function SidebarNavItem({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate: () => void;
}) {
  const active = isActiveRoute(pathname, item.href);

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group flex items-center gap-[11px] rounded-[7px] px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime focus-visible:ring-offset-2 focus-visible:ring-offset-dark ${
        active
          ? "bg-dark-nav-hover text-dark-text"
          : "text-dark-soft hover:bg-dark-nav-hover hover:text-dark-text"
      }`}
    >
      <Icon name={item.icon} size={15} strokeWidth={2} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {typeof item.badge === "number" && item.badge > 0 && (
        <span className="min-w-[18px] rounded-full bg-[#f5a623] px-1.5 text-center text-[10px] font-bold leading-[18px] text-black">
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}
    </Link>
  );
}

function SidebarNavGroup({
  group,
  pathname,
  onNavigate,
}: {
  group: NavGroup;
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <section aria-labelledby={`sidebar-${group.label.toLowerCase()}`}>
      <h2
        id={`sidebar-${group.label.toLowerCase()}`}
        className="mb-1.5 px-3 text-[9px] font-semibold uppercase tracking-[0.12em] text-dark-dim"
      >
        {group.label}
      </h2>
      <div className="space-y-[3px]">
        {group.items.map((item) => (
          <SidebarNavItem
            key={item.href}
            item={item}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </section>
  );
}

function AdminPopover({
  open,
  onOpenChange,
  trigger,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className="relative">
      {trigger}
      {open && children}
    </div>
  );
}

function AdminIdentityTrigger({
  user,
  open,
  onToggle,
}: {
  user: AdminUser | null;
  open: boolean;
  onToggle: () => void;
}) {
  const { isAdmin, isMember } = adminRoleGates(user);
  const roleLabel = isAdmin ? "Admin" : isMember ? "Member" : "Support";
  const name = user?.displayName?.trim() || user?.email || "Admin";
  const initial = name.charAt(0).toUpperCase();

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Account menu"
      className={`flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime ${
        open ? "bg-dark-nav-hover" : "hover:bg-dark-nav-hover"
      }`}
    >
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dark-line-soft bg-dark text-[12px] font-bold text-dark-text">
        {initial}
        <span
          className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[#050605] bg-emerald-400"
          title="Signed in"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-dark-text" title={user?.email || name}>
          {name}
        </div>
        <div className={`mt-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] ${isAdmin ? "text-amber-400" : "text-dark-dim"}`}>
          {roleLabel}
        </div>
      </div>
      <Icon name="chevron-right" size={12} strokeWidth={2} className={`shrink-0 text-dark-dim transition-transform ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

function AdminAccountPopover({
  user,
  onNavigate,
  onSignOut,
}: {
  user: AdminUser | null;
  onNavigate: () => void;
  onSignOut: () => void;
}) {
  const name = user?.displayName?.trim() || user?.email || "Admin";

  return (
    <div
      role="menu"
      aria-label="Account menu"
      className="absolute bottom-full left-0 right-0 z-50 mb-2 w-full rounded-xl border border-dark-line-soft bg-dark-card p-1.5 font-mono shadow-[0_14px_32px_rgba(0,0,0,0.45)]"
    >
      <Link
        href="/account"
        onClick={onNavigate}
        className="block rounded-lg px-2.5 py-2 transition-colors hover:bg-dark-nav-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime"
      >
        <p className="truncate text-[11px] font-semibold text-dark-text">{name}</p>
        {user?.email && <p className="mt-0.5 truncate text-[10px] text-dark-dim">{user.email}</p>}
      </Link>

      <div className="border-t border-dark-line py-1">
        <SidebarAction
          icon="file"
          label="Changelog"
          href={`${LANDING_URL.replace(/\/+$/, "")}/changelog`}
          newTab
          onClick={onNavigate}
        />
        <SidebarAction
          icon="external"
          label="Main app"
          href={`${DASHBOARD_URL.replace(/\/+$/, "")}/overview`}
          newTab
          onClick={onNavigate}
        />
      </div>
      <div className="border-t border-dark-line pt-1">
        <SidebarAction icon="logout" label="Sign out" destructive onClick={onSignOut} />
      </div>
    </div>
  );
}

function SidebarAction({
  icon,
  label,
  href,
  active = false,
  destructive = false,
  newTab = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  href?: string;
  active?: boolean;
  destructive?: boolean;
  newTab?: boolean;
  onClick?: () => void;
}) {
  const className = `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime focus-visible:ring-offset-2 focus-visible:ring-offset-dark ${
    destructive
      ? "text-dark-soft hover:bg-rose-400/10 hover:text-rose-300"
      : active
        ? "bg-dark-nav-hover text-dark-text"
        : "text-dark-soft hover:bg-dark-nav-hover hover:text-dark-text"
  }`;
  const content = (
    <>
      <Icon name={icon} size={14} strokeWidth={2} />
      <span className="flex-1">{label}</span>
      {active && <Icon name="chevron-right" size={12} strokeWidth={2} className="text-dark-dim" />}
    </>
  );

  if (href) {
    return href.startsWith("/") ? (
      <Link href={href} onClick={onClick} className={className}>
        {content}
      </Link>
    ) : (
      <a
        href={href}
        className={className}
        target={newTab ? "_blank" : undefined}
        rel={newTab ? "noopener noreferrer" : undefined}
      >
        {content}
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} className={`${className} cursor-pointer`}>
      {content}
    </button>
  );
}

export function AdminSidebar({
  pathname,
  open,
  unread,
  user,
  onClose,
  onSignOut,
}: {
  pathname: string;
  open: boolean;
  unread: number;
  user: AdminUser | null;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const { isAdmin } = adminRoleGates(user);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const closeAccountMenu = () => setAccountMenuOpen(false);
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => !item.adminOnly || isAdmin)
      .map((item) => (item.href === "/notifications" ? { ...item, badge: unread } : item)),
  }));

  return (
    <aside
      aria-label="Admin navigation"
      className={`fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-dark-line bg-[#050605] transition-transform lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="border-b border-dark-line px-5 py-[18px]">
        <div className="flex items-center gap-2.5">
          <Brandmark size={28} />
          <div className="leading-tight">
            <Wordmark size="sm" />
            <div className="mt-0.5 font-mono text-[9px] tracking-[0.15em] text-[#f5a623]">
              COMMUNITY ADMIN
            </div>
          </div>
        </div>
      </div>

      <nav className="thin-scroll flex-1 space-y-4 overflow-y-auto p-3 font-mono text-[13px]">
        {groups.map((group) => (
          <SidebarNavGroup
            key={group.label}
            group={group}
            pathname={pathname}
            onNavigate={onClose}
          />
        ))}
      </nav>

      <div className="border-t border-dark-line p-2 font-mono">
        <AdminPopover
          open={accountMenuOpen}
          onOpenChange={setAccountMenuOpen}
          trigger={
            <AdminIdentityTrigger
              user={user}
              open={accountMenuOpen}
              onToggle={() => setAccountMenuOpen((v) => !v)}
            />
          }
        >
          <AdminAccountPopover
            user={user}
            onNavigate={() => {
              closeAccountMenu();
              onClose();
            }}
            onSignOut={() => {
              closeAccountMenu();
              onSignOut();
            }}
          />
        </AdminPopover>
      </div>
    </aside>
  );
}
