// SPDX-License-Identifier: Apache-2.0

import React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import type { BountyStatus, SubmissionStatus } from "@/lib/types";
import {
  BOUNTY_STATUS_LABELS,
  SUBMISSION_STATUS_LABELS,
} from "@/lib/format";
import { Icon, type IconName } from "./icons";

/**
 * Hit-box expander for a deliberately small text or icon control.
 *
 * Several controls across the app are 11px links or sub-36px icon buttons —
 * the planner spec panel's `edit` measures 43.4x16.5 and its sample `remove`
 * 43x16 at the 640 breakpoint with touch emulated, the mobile header's menu
 * button 36x36 and its notification bell 32x32, all under the 44x44 minimum
 * (WCAG 2.5.8, and 2.5.5 at AAA). Those sizes are right for their surfaces'
 * density, and `edit` is the whole affordance for editing any answered step,
 * so they have to be reliably tappable.
 *
 * A centred, transparent `::after` box grows ONLY the hit area: it is
 * absolutely positioned, so layout, rhythm and alignment are untouched, and no
 * colour is introduced — it adds no visual surface at all. `w-full` with
 * `min-w-11` means a control already wider than 44px keeps its own width
 * rather than shrinking its target.
 *
 * The control must establish a positioning context, which the leading
 * `relative` here does. Two cautions when applying it:
 *  - The pseudo-box can overlap a neighbour, and paint order decides which
 *    control a tap in the overlap reaches. Re-measure the neighbours (not just
 *    the control being fixed) after adding it.
 *  - It cannot reach a browser-drawn sub-widget such as
 *    `::file-selector-button`; those need real height instead.
 */
export const TOUCH_TARGET =
  "relative after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-full after:min-w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']";

/* ---------- Tooltip ---------- */

/** Hover/focus label for icon-only controls (buttons/links with no visible
 * text). Wrap the trigger element directly — it needs its own `aria-label`
 * or accessible name already, since this tooltip is `aria-hidden` to avoid
 * double-announcing the same string to screen readers.
 *
 * This root span is always `position: relative` (it's the tooltip bubble's
 * containing block) — never pass a `position` utility to a parent wrapper
 * expecting it to override this; Tailwind can't guarantee `absolute` beats
 * `relative` at equal specificity, so the two silently fight instead of one
 * cleanly winning. If the trigger itself needs absolute placement (e.g.
 * pinned to a container edge), wrap this whole `<Tooltip>` in a plain
 * positioned `<div>` instead. */
export function Tooltip({
  label,
  side = "right",
  wrap = false,
  children,
}: {
  label: string;
  side?: "top" | "right" | "bottom";
  /** For a sentence-length explanation rather than a short label: wraps at a
   * fixed width and left-aligns instead of forcing one unreadable nowrap line. */
  wrap?: boolean;
  children: React.ReactNode;
}) {
  const sideClasses =
    side === "top"
      ? "bottom-full left-1/2 mb-2 -translate-x-1/2"
      : side === "bottom"
        ? "top-full left-1/2 mt-2 -translate-x-1/2"
        : "left-full top-1/2 ml-2 -translate-y-1/2";
  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        aria-hidden="true"
        className={`pointer-events-none absolute z-50 rounded-md border border-dark-line-soft bg-dark-card px-2 py-1 font-mono text-[11px] leading-snug text-dark-text opacity-0 shadow-[0_1px_4px_rgba(0,0,0,0.45)] transition-opacity delay-150 duration-100 group-hover/tooltip:opacity-100 group-has-[:focus-visible]/tooltip:opacity-100 ${
          wrap ? "w-56 whitespace-normal text-left" : "whitespace-nowrap"
        } ${sideClasses}`}
      >
        {label}
      </span>
    </span>
  );
}

/* ---------- InfoTip ---------- */

/** A small ⓘ button that explains the thing next to it — a status pill, a stat
 * label — on hover or keyboard focus.
 *
 * Lives here (rather than beside its first caller in `workspace.tsx`) because
 * every surface that shows a status needs the same affordance; a second copy
 * would drift. A portal, not the sibling `Tooltip`'s inline absolute bubble,
 * because the callers are cards that clip overflow to keep their rounded
 * corners clean — an inline bubble near a card edge gets silently clipped to a
 * sliver. `left` is clamped so the bubble never runs past the viewport, and the
 * bubble FLIPS BELOW the trigger when there isn't room above it.
 *
 * That vertical flip was missing: the bubble was hard-positioned above the
 * trigger with `-translate-y-[calc(100%+8px)]`, so every tooltip near the top of
 * the viewport — a page-header pill, the "cannot be stopped" note on the sponsor
 * tracking header — had its first lines cut off by the top of the window. Only
 * `left` was clamped, so the failure showed up exclusively on the vertical axis
 * and only on triggers high on the page. */
export function InfoTip({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number; below: boolean } | null>(null);
  const ref = React.useRef<HTMLButtonElement>(null);

  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) {
      const halfWidth = 128; // w-64 bubble, centered on the trigger
      const margin = 8;
      const left = Math.min(
        Math.max(rect.left + rect.width / 2, halfWidth + margin),
        window.innerWidth - halfWidth - margin,
      );
      // Room needed above for the bubble. It is measured, not guessed at a fixed
      // height: this text is caller-supplied and some of it runs to several
      // lines, which is exactly the case a constant would get wrong. Estimated
      // from the wrapped line count at the bubble's own width; erring high is
      // safe because the fallback (flipping below) is never clipped in practice.
      const estimatedLines = Math.ceil(text.length / 34);
      const estimatedHeight = 14 + estimatedLines * 14;
      const below = rect.top < estimatedHeight + margin * 2;
      setPos({ top: below ? rect.bottom : rect.top, left, below });
    }
    setOpen(true);
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={`About ${label}`}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        // WCAG 2.2 AA (2.5.8 Target Size, Minimum) wants a 24x24 CSS-px
        // target; this control measured 11x11 on /validator. The hit area is
        // expanded with a centred `before:` pseudo-element instead of by
        // resizing the button, so the icon still renders at 10.5px and the
        // layout is pixel-identical to v1 — the parity contract protects the
        // VISUAL design, not an undersized touch target. Owner's call
        // (2026-09-02): enlarge the hit area only.
        //
        // `before:` rather than padding: padding would grow the flex item and
        // shift the label beside it. The pseudo-element overlays instead, so
        // nothing reflows.
        className="relative mt-px flex shrink-0 cursor-help items-center text-ink-faint/70 transition-colors before:absolute before:left-1/2 before:top-1/2 before:h-6 before:w-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] hover:text-ink-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-1"
      >
        <Icon name="info" size={10.5} />
      </button>
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="tooltip"
            className={`pointer-events-none fixed z-50 w-64 -translate-x-1/2 break-words rounded-md border border-dark-line-soft bg-dark-card px-2.5 py-1.5 font-mono text-[11px] leading-snug text-dark-text shadow-[0_1px_4px_rgba(0,0,0,0.45)] ${
              pos.below ? "translate-y-2" : "-translate-y-[calc(100%+8px)]"
            }`}
            style={{ top: pos.top, left: pos.left }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ---------- Popover ---------- */

/** Reusable click-triggered surface for compact account/actions menus. It owns
 * dismissal (outside click and Escape) while callers own the content and
 * navigation, keeping menu behavior consistent without forcing a visual skin. */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  className = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
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
    <div ref={rootRef} className={`relative ${className}`}>
      {trigger}
      {open && children}
    </div>
  );
}

/** Compact section title with an optional discoverable explanation. */
export function SectionHeading({
  icon,
  title,
  info,
  className = "",
}: {
  icon: IconName;
  title: string;
  info?: string;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 text-base font-bold tracking-tight ${className}`}>
      <Icon name={icon} size={16} className="text-ink-soft" />
      {title}
      {info && (
        <Tooltip label={info} side="bottom" wrap>
          <button type="button" aria-label={`About ${title}`} className="relative flex h-4 w-4 items-center justify-center text-[#71804f] transition-colors before:absolute before:left-1/2 before:top-1/2 before:h-6 before:w-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-[#aebd82]">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M12 10.5v5" strokeLinecap="round" />
              <path d="M12 7.25h.01" strokeLinecap="round" strokeWidth="2.5" />
            </svg>
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/* ---------- Button ---------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";

/** When `href` is set the Button renders a Next `<Link>` styled identically to
 * the button variants — use it for navigation actions that should look like a
 * primary/secondary button (so link-styled-as-button markup isn't hand-rolled).
 * `target`/`rel` are forwarded to the link (e.g. external `_blank` links). */
export function Button({
  variant = "primary",
  size = "md",
  className = "",
  href,
  target,
  rel,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  href?: string;
  target?: string;
  rel?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg font-mono font-medium transition-colors disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
  const sizes = {
    sm: "text-xs px-2.5 py-1.5",
    md: "text-[13px] px-3.5 py-2",
    lg: "text-sm px-5 py-2.5",
  };
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-brand text-lime hover:bg-black",
    secondary:
      "border border-line bg-white text-ink hover:border-ink hover:bg-panel",
    ghost: "text-ink-soft hover:bg-brand-soft hover:text-ink",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
  };
  const cls = `${base} ${sizes[size]} ${variants[variant]} ${className}`;
  if (href) {
    return (
      <Link
        href={href}
        target={target}
        rel={rel}
        className={cls}
        onClick={props.onClick as React.MouseEventHandler<HTMLAnchorElement> | undefined}
      >
        {props.children}
      </Link>
    );
  }
  return <button className={cls} {...props} />;
}

/* ---------- Select ---------- */

/** Native <select> with a custom chevron and reserved right padding so long
 * option labels never crowd the arrow. Use in place of raw <select> elements. */
export function Select({
  className = "",
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative min-w-0">
      <select
        className={`h-9 w-full appearance-none rounded-lg border border-line bg-white pl-3 pr-9 font-mono text-[12px] text-ink focus:border-ink focus:outline-none ${className}`}
        {...props}
      />
      <Icon
        name="chevron-down"
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-soft"
      />
    </div>
  );
}

/** Shared, honest treatment for intentionally unavailable launch-gated work.
 * The CTA remains visible so users know the capability exists, but no client
 * action is implied until the server-side launch flag enables it. */
export function ComingSoonDialog({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  // Rendered through the shared Modal so it inherits a real focus trap, Escape
  // to close, and focus restore on close — the previous hand-rolled overlay had
  // none of those (keyboard/screen-reader users could tab out behind it and
  // couldn't dismiss it with Escape).
  return (
    <Modal
      open={open}
      onClose={onClose}
      overlayClassName="z-[110]"
      panelClassName="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-line bg-white p-6 shadow-xl"
    >
      <div className="flex items-start justify-between gap-4"><div><p className="font-mono text-xs text-ink-faint">update coming soon</p><h2 id="coming-soon-title" className="mt-1 text-lg font-semibold text-ink">{title}</h2></div><button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-soft hover:bg-panel"><Icon name="x" size={18} /></button></div>
      <p className="mt-3 text-sm leading-6 text-ink-soft">{description}</p>
      {children && <div className="mt-5">{children}</div>}
    </Modal>
  );
}

/* ---------- Toaster ---------- */

/** Renders the store's transient toasts as a fixed, stacked overlay. Mount once
 * (in the app-shell). Errors are red and stick around longer; success is green;
 * info is neutral. Each toast is dismissible and announces itself via
 * `role="alert"` for screen readers. */
export function Toaster({
  toasts,
  onDismiss,
}: {
  toasts: import("@/lib/types").Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  const styles: Record<
    import("@/lib/types").Toast["variant"],
    { wrap: string; icon: IconName }
  > = {
    error: {
      wrap: "border-rose-200 bg-rose-50 text-rose-800",
      icon: "alert",
    },
    success: {
      wrap: "border-emerald-200 bg-emerald-50 text-emerald-800",
      icon: "check",
    },
    info: {
      wrap: "border-line bg-white text-ink",
      icon: "info",
    },
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
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[13px] shadow-lg ${s.wrap}`}
          >
            <Icon name={s.icon} size={16} className="mt-px shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-mono font-semibold">{t.title}</p>
              {t.body && <p className="mt-0.5 break-words opacity-90">{t.body}</p>}
            </div>
            <button
              onClick={() => onDismiss(t.id)}
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

/** Inline sibling of {@link ComingSoonDialog}: the honest, non-blocking
 * treatment for a surface that exists but is switched off by a server-side
 * launch flag (today only `launch.community.enabled`).
 *
 * Every one of these used to be hand-rolled per page — a banner on `/account`, a
 * dashed box  a bare `card` on `/contributor` — each
 * with its own padding, icon, and wording. Same claim, four different looks. Use
 * this so "not live yet" reads identically everywhere, and so the copy stays in
 * one place when the flag flips for good.
 *
 * `tone="notice"` is the page-level banner; `tone="placeholder"` is the dashed
 * box that stands in for a control that would otherwise render. Never use it to
 * imply a capability is broken — off is a launch state, not a failure.
 */
export function ComingSoonNotice({
  children,
  tone = "notice",
  icon = "clock",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "notice" | "placeholder";
  icon?: IconName;
  className?: string;
}) {
  const wrap =
    tone === "placeholder"
      ? "border-dashed border-line bg-panel p-4"
      : "border-line-soft bg-panel px-4 py-2.5";
  return (
    <div
      className={`flex items-start gap-2 rounded-xl border text-[12.5px] text-ink-soft ${wrap} ${className}`}
    >
      <Icon name={icon} size={14} className="mt-0.5 shrink-0 text-ink-faint" />
      <span>{children}</span>
    </div>
  );
}


export function BackLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 font-mono text-xs text-ink-soft transition-colors hover:text-ink ${className}`}
    >
      <Icon name="arrow-left" size={13} />
      {children}
    </Link>
  );
}

export function PageHeader({
  title,
  sub,
  action,
  compact = false,
}: {
  title: string;
  sub?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`${compact ? "mb-4 items-center" : "mb-6 items-end"} flex flex-wrap justify-between gap-3`}>
      <div className={compact ? "flex flex-wrap items-baseline gap-x-2.5 gap-y-1" : ""}>
        <h1 className="font-mono text-[22px] font-bold tracking-tight">{title}</h1>
        {sub && <p className={compact ? "font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-faint" : "mt-1 text-[13.5px] text-ink-soft"}>{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/** Back-link + title/meta + right-aligned action header used by detail pages
 * (submission detail, audit detail, etc). Title/meta wrap within their own
 * column so `right` stays pinned to the top-right instead of falling below. */
export function DetailHeader({
  backHref,
  backLabel,
  title,
  meta,
  right,
}: {
  /** Omit both to render the header with no back row — the shape needed when
   * this detail is embedded in a drawer that already has its own close and
   * "open full page" controls, where a second way back is just noise. */
  backHref?: string;
  backLabel?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-6 border-b border-line-soft pb-5">
      {backHref && backLabel && (
        <Link
          href={backHref}
          className="mb-3 inline-flex items-center gap-1 font-mono text-xs text-ink-soft hover:text-ink"
        >
          <Icon name="chevron-right" size={12} className="rotate-180" />
          {backLabel}
        </Link>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-bold leading-tight tracking-tight">{title}</h1>
          {meta && <div className="mt-2.5 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {right && <div className="flex shrink-0 items-center gap-3">{right}</div>}
      </div>
    </div>
  );
}

export function SectionHeader({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3.5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="font-mono text-base font-bold tracking-tight">{title}</h2>
        {sub && <p className="mt-1 text-[13px] text-ink-soft">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---------- Pill ---------- */

export type PillTone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "lime"
  | "sky"
  | "violet"
  | "karma";

const PILL_TONES: Record<PillTone, string> = {
  neutral: "bg-brand-soft text-ink-soft border-line",
  brand: "bg-brand text-lime border-brand",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  danger: "bg-rose-50 text-rose-700 border-rose-200",
  info: "bg-sky-50 text-sky-700 border-sky-200",
  lime: "bg-accent-soft text-accent-strong border-[#e3ecc8]",
  sky: "bg-sky-50 text-sky-700 border-sky-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
  // Karma accent — matches the karma sparkle icon (karma-soft bg / karma text)
  // so every karma signal reads with one consistent color.
  karma: "bg-karma-soft text-karma border-[#e4dcf5]",
};

export function Pill({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: PillTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-medium leading-4 ${PILL_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/* ---------- Filter controls ---------- */

export function PillTabs<T extends string>({
  items,
  value,
  onChange,
  className = "",
}: {
  items: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {items.map((item) => {
        const active = value === item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
              active
                ? "border-ink bg-ink text-lime"
                : "border-line text-ink-soft hover:border-ink hover:text-ink"
            }`}
          >
            {item.label}
            {item.count !== undefined && (
              <span
                className={`rounded-full px-1.5 text-[10px] font-bold ${
                  active ? "bg-lime text-dark" : "bg-brand-soft text-ink-soft"
                }`}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder = "Search",
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`relative block w-full sm:w-72 ${className}`}>
      <Icon
        name="search"
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        // Right padding opens up only when there's a value, so the text never
        // slides under the clear button; it reverts to pr-3 when empty.
        className={`h-9 w-full rounded-lg border border-line bg-white py-1 pl-8 ${value ? "pr-8" : "pr-3"} font-mono text-[12px] outline-none transition-colors placeholder:text-ink-faint focus:border-ink`}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-panel hover:text-ink"
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </label>
  );
}

/* ---------- ChatInput ---------- */

/** Auto-growing single-to-multi-line composer for the planner chat rows.
 * Starts one row tall, grows with the content, then scrolls once it hits
 * `maxHeight`. Enter submits; Shift+Enter inserts a newline. Pair it with a
 * `flex items-end` wrapper so the send button stays pinned to the bottom
 * instead of stretching as the box grows. */
export const ChatInput = React.forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    placeholder?: string;
    disabled?: boolean;
    maxHeight?: number;
    ariaLabel?: string;
    className?: string;
  }
>(function ChatInput(
  { value, onChange, onSubmit, placeholder, disabled = false, maxHeight = 200, ariaLabel, className = "" },
  forwardedRef
) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  // Callers (the planner's "fill the box, then edit it" starter chips) need
  // the real textarea node to move focus and the caret after a programmatic
  // fill — see the comment on `applyStarter` in sponsor/create/view.tsx for
  // why. `useImperativeHandle` would work too, but exposing the plain node
  // keeps the caller's `focus()`/`setSelectionRange()` calls ordinary DOM
  // calls instead of a bespoke imperative API for one method.
  React.useImperativeHandle(forwardedRef, () => ref.current as HTMLTextAreaElement, []);

  const resize = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Reset to auto first, or scrollHeight stays stuck at the previous
    // (taller) height and the box can never shrink back down.
    el.style.height = "auto";
    // scrollHeight is content + padding but excludes the border, and these
    // inputs are border-box — assigning it raw renders the row 2px shorter
    // than the `<input>` this replaced, which shows up as a visible jump
    // against the send button beside it.
    const cs = getComputedStyle(el);
    const border =
      parseFloat(cs.borderTopWidth || "0") + parseFloat(cs.borderBottomWidth || "0");
    const full = el.scrollHeight + border;
    el.style.height = `${Math.min(full, maxHeight)}px`;
    el.style.overflowY = full > maxHeight ? "auto" : "hidden";
  }, [maxHeight]);

  // Keyed on `value` so programmatic clears (the planner empties the draft on
  // send) collapse the box back to one row rather than leaving it tall.
  React.useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // Shift+Enter is a newline, and an open IME composition must commit its
        // candidate on Enter instead of submitting a half-typed word.
        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
        e.preventDefault();
        onSubmit();
      }}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`min-w-0 flex-1 resize-none rounded-lg border border-line bg-white px-3.5 py-3 text-sm text-ink placeholder:text-ink-faint transition-colors focus:border-ink focus:outline-none disabled:cursor-not-allowed disabled:border-[#d8dbcf] disabled:bg-[#eceee7] disabled:text-ink-soft disabled:placeholder:text-ink-soft ${className}`}
    />
  );
});

export function ResultCount({
  loading,
  count,
  singular,
  plural,
  className = "",
}: {
  loading?: boolean;
  count: number;
  singular: string;
  plural: string;
  className?: string;
}) {
  return (
    <div className={`font-mono text-[11px] leading-none text-ink-soft ${className}`}>
      {loading ? "Loading…" : `${count.toLocaleString()} ${count === 1 ? singular : plural}`}
    </div>
  );
}

/** Prev/Next pager for keyset/cursor-paginated lists — no "of N" total,
 * since that's the entire point of cursor pagination (no per-page count
 * query). Shows the page number reached instead of a page/total ratio. */
export function CursorPager({
  pageNumber,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  disabled = false,
  className = "",
}: {
  pageNumber: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  disabled?: boolean;
  className?: string;
}) {
  if (!hasPrev && !hasNext) return null;
  return (
    <div
      className={`flex items-center justify-between border-t border-line-soft pt-4 ${className}`}
    >
      <Button variant="secondary" size="sm" onClick={onPrev} disabled={disabled || !hasPrev}>
        <Icon name="arrow-left" size={13} />
        Previous
      </Button>
      <div className="font-mono text-xs text-ink-soft">
        page <span className="font-bold text-ink">{pageNumber}</span>
      </div>
      <Button variant="secondary" size="sm" onClick={onNext} disabled={disabled || !hasNext}>
        Next
        <Icon name="arrow-right" size={13} />
      </Button>
    </div>
  );
}

/** Prev/Next pager shared by offset-paginated lists with a real total-pages
 * count (submission history, audit logs, …). Sponsor bounties moved to
 * {@link CursorPager} — its list endpoint is keyset-paginated and no longer
 * returns a total (scalability plan §2.2). */
export function Pagination({
  page,
  totalPages,
  onPrev,
  onNext,
  disabled = false,
  className = "",
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  disabled?: boolean;
  className?: string;
}) {
  if (totalPages <= 1) return null;
  return (
    <div
      className={`flex items-center justify-between border-t border-line-soft pt-4 ${className}`}
    >
      <Button variant="secondary" size="sm" onClick={onPrev} disabled={disabled || page <= 1}>
        <Icon name="arrow-left" size={13} />
        Previous
      </Button>
      <div className="font-mono text-xs text-ink-soft">
        page <span className="font-bold text-ink">{page}</span> of{" "}
        <span className="font-bold text-ink">{totalPages}</span>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onNext}
        disabled={disabled || page >= totalPages}
      >
        Next
        <Icon name="arrow-right" size={13} />
      </Button>
    </div>
  );
}

const BOUNTY_STATUS_TONES: Partial<Record<BountyStatus, PillTone>> = {
  active: "success",
  planning: "brand",
  platform_review: "warning",
  paused: "neutral",
  closing: "warning",
  completed: "brand",
  partially_completed: "violet",
  export_ready: "brand",
  cancelled: "danger",
  disputed: "danger",
  draft: "neutral",
};

export function BountyStatusPill({ status }: { status: BountyStatus }) {
  return (
    <Pill tone={BOUNTY_STATUS_TONES[status] ?? "neutral"}>
      {BOUNTY_STATUS_LABELS[status]}
    </Pill>
  );
}

const SUBMISSION_STATUS_TONES: Partial<Record<SubmissionStatus, PillTone>> = {
  submitted: "neutral",
  duplicate_check: "info",
  running_tests: "info",
  llm_validation: "info",
  tests_failed: "danger",
  needs_fixes: "warning",
  provisionally_accepted: "brand",
  accepted_pending_sample: "info",
  in_audit: "violet",
  in_sponsor_review: "violet",
  flagged: "warning",
  disputed: "danger",
  accepted: "success",
  rejected: "danger",
  completed_settled: "success",
};

const RUNNING: SubmissionStatus[] = [
  "duplicate_check",
  "running_tests",
  "llm_validation",
];

export function SubmissionStatusPill({ status }: { status: SubmissionStatus }) {
  const running = RUNNING.includes(status);
  return (
    <Pill tone={SUBMISSION_STATUS_TONES[status] ?? "neutral"}>
      {running && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
        </span>
      )}
      {SUBMISSION_STATUS_LABELS[status]}
    </Pill>
  );
}

/* ---------- Progress ---------- */

export function Progress({
  value,
  max,
  tone = "brand",
  track = "brand",
  className = "",
}: {
  value: number;
  max: number;
  tone?: "brand" | "success" | "warning" | "lime" | "olive" | "ink" | "sky";
  track?: "brand" | "line";
  className?: string;
}) {
  const pctVal = max === 0 ? 0 : Math.min(100, (value / max) * 100);
  const tones = {
    brand: "bg-brand",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    lime: "bg-lime",
    olive: "bg-accent-strong",
    ink: "bg-ink",
    sky: "bg-sky-500",
  };
  const tracks = {
    brand: "bg-brand-soft",
    line: "bg-line-soft",
  };
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full ${tracks[track]} ${className}`}>
      <div
        className={`h-full rounded-full ${tones[tone]} transition-all`}
        style={{ width: `${pctVal}%` }}
      />
    </div>
  );
}

/* ---------- Stat ---------- */

export function Stat({
  label,
  value,
  sub,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card px-4 py-3.5 ${className}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-soft">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight mono-num">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-soft">{sub}</div>}
    </div>
  );
}

/**
 * Inline `label value` pair for a card's footer stat row — the compact sibling
 * of the card-style `Stat` above. Lives here because the sponsor request
 * row and the community request card had grown byte-identical private copies
 * (`Stat` and `Metric` respectively); the two card footers must stay visually
 * identical, so they now share one definition instead of drifting apart.
 * Inherits its type scale from the parent row (`font-mono text-xs`).
 */
export function InlineStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <span className="text-ink-soft">{label}</span>{" "}
      <span className="font-bold">{value}</span>
    </div>
  );
}

/* ---------- Table ---------- */

export function Table({
  headers,
  children,
  className = "",
  tbodyClassName = "divide-y divide-line",
}: {
  headers: React.ReactNode[];
  children: React.ReactNode;
  className?: string;
  tbodyClassName?: string;
}) {
  return (
    <div className={`card overflow-x-auto ${className}`}>
      <table className="w-full min-w-max text-left text-sm">
        <thead>
          <tr className="border-b border-line">
            {headers.map((h, i) => (
              <th
                key={i}
                className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-soft"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={tbodyClassName}>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}

/* ---------- Copy button ----------
 * One implementation for "copy this value to the clipboard" — used to be
 * three near-identical hand-rolled buttons (API key reveal modal, MCP config
 * blocks, developers-page value rows) each with their own copied-state timer
 * and slightly different Tailwind. `tone="highlight"` is for a copy action
 * that IS the point of the row (reveal-once secrets, config to paste
 * elsewhere); `tone="neutral"` (default) is for a secondary affordance next
 * to a value the user is mainly just reading. */
export function CopyButton({
  value,
  label,
  text = "copy",
  tone = "neutral",
  iconOnly = false,
  title,
  className = "",
}: {
  value: string;
  label: string;
  text?: string;
  tone?: "neutral" | "highlight";
  iconOnly?: boolean;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onClick = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };
  const toneClass =
    tone === "highlight"
      ? "border-accent-soft-border bg-accent-soft text-accent-strong hover:border-accent-strong"
      : "border-line bg-white text-ink-faint hover:border-accent-strong hover:text-accent-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={title ?? (copied ? "copied" : `Copy ${label}`)}
      className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] border font-mono transition-colors ${
        iconOnly ? "p-1" : "px-2.5 py-1.5 text-[11px]"
      } ${copied ? "border-emerald-200 bg-emerald-50 text-emerald-700" : toneClass} ${className}`}
    >
      <Icon name={copied ? "check" : "copy"} size={iconOnly ? 10.5 : 12} />
      {!iconOnly && (copied ? "copied" : text)}
    </button>
  );
}

/* ---------- Code block ---------- */

export function CodeBlock({
  code,
  label,
  tone = "neutral",
  actions,
  className = "",
}: {
  code: string;
  label?: string;
  tone?: "neutral" | "danger" | "success";
  /** Extra controls (copy/download, etc.) rendered at the right edge of the
   *  label bar. Only relevant when `label` is set — additive and optional so
   *  every existing caller that doesn't pass it renders exactly as before. */
  actions?: React.ReactNode;
  className?: string;
}) {
  const borders = {
    neutral: "border-slate-700",
    danger: "border-rose-500/60",
    success: "border-emerald-500/60",
  };
  const labelTones = {
    neutral: "text-slate-400",
    danger: "text-rose-400",
    success: "text-emerald-400",
  };
  return (
    <div
      className={`overflow-hidden rounded-lg border bg-slate-900 ${borders[tone]} ${className}`}
    >
      {label && (
        <div
          className={`flex items-center justify-between gap-2 border-b border-slate-700/60 px-3 py-1.5 font-mono text-[11px] font-medium ${labelTones[tone]}`}
        >
          <span className="truncate">{label}</span>
          {actions && <span className="flex shrink-0 items-center gap-1.5">{actions}</span>}
        </div>
      )}
      <pre className="code-scroll overflow-x-auto p-3 font-mono text-xs leading-relaxed text-slate-200">
        {code}
      </pre>
    </div>
  );
}

/* ---------- Skeleton (loading placeholders) ---------- */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-line-soft ${className}`} />;
}

/** Shimmering row placeholders shown in place of a list/table while its first
 * fetch is in flight — replaces a bare "Loading…" string with something that
 * reads as "content is coming" rather than "the page might be broken". */
export function SkeletonRows({
  rows = 4,
  className = "",
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={`card divide-y divide-line p-0 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-1/4" />
          </div>
          <Skeleton className="h-3 w-14 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * Card-shaped loading placeholders for the list surfaces built out of full
 * cards rather than compact rows — the sponsor dataset-request list and the
 * dataset pool list.
 *
 * `SkeletonRows` above is the wrong shape for those: it draws a tight
 * 8px-avatar row about 57px tall inside a single divided card, while the real
 * rows are separate `card p-6` blocks roughly 150px tall with a title, a pill
 * row, and a bordered footer stat line. Loading therefore rendered short grey
 * strips and then the page jumped as the real cards replaced them. This mirrors
 * the real card's geometry — same padding, same gaps, same footer rule — so the
 * layout doesn't move when the fetch lands.
 */
export function SkeletonCards({
  cards = 3,
  progress = false,
  className = "",
}: {
  cards?: number;
  /** Adds the two side-by-side progress bars the pool cards show. */
  progress?: boolean;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: cards }).map((_, i) => (
        /* Heights are the real card's line boxes, not the bar thicknesses: a
           26px title row holding a 14px bar, a 22px pill row, a 17px stat row.
           Measured against a live row (title 26 · pill row 22 · footer 17,
           p-6 / mb-4 / pt-3.5), so a loading card is the same 155px tall as
           the row that replaces it and nothing shifts on arrival. */
        <div key={i} className="card p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex h-[26px] items-center">
                <Skeleton className="h-3.5 w-2/5" />
              </div>
              <div className="mt-2.5 flex h-[22px] items-center gap-[7px]">
                <Skeleton className="h-[18px] w-20 rounded-full" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
            <Skeleton className="h-4 w-4 shrink-0" />
          </div>
          {progress && (
            <div className="grid gap-4 sm:grid-cols-2 sm:gap-7">
              <Skeleton className="h-2 w-full rounded-[3px]" />
              <Skeleton className="h-2 w-full rounded-[3px]" />
            </div>
          )}
          <div className="mt-3.5 border-t border-line-soft pt-3.5">
            <div className="flex h-[17px] items-center gap-x-7 overflow-hidden">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Empty state ---------- */

export function Empty({
  title,
  description,
  icon = "database",
  action,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: IconName;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  if (!title && !description && !action) {
    return (
      <div className="card flex items-center justify-center px-6 py-10 text-center text-sm text-ink-soft">
        {children}
      </div>
    );
  }

  return (
    <div className="card flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-panel text-ink-soft">
        <Icon name={icon} size={20} />
      </div>
      {title && <h2 className="mt-4 font-mono text-base font-bold">{title}</h2>}
      {description && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-soft">
          {description}
        </p>
      )}
      {children && (
        <div className="mt-2 max-w-md text-sm leading-relaxed text-ink-soft">
          {children}
        </div>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * The "nothing here yet" state for a surface worth explaining rather than
 * apologising for: a headline, a one-line promise, three concrete points, and
 * the action that starts it.
 *
 * Distinct from `Empty` on purpose. `Empty` is right when the user already
 * knows what the list is and it simply has no rows ("No matching requests" for
 * a filtered view). It is wrong for a first-run surface, where the blank state
 * is the only chance to say what the thing does — a sponsor who has never filed
 * a dataset request learns nothing from "No dataset requests yet".
 *
 * Every point must be a real, currently-true product fact. A first-run pitch is
 * exactly where invented capability does the most damage, because the reader has
 * no experience yet to contradict it — so anything not yet live belongs in
 * `footnote`, stated plainly, not in the points.
 */
export function EmptyPitch({
  icon,
  eyebrow,
  title,
  description,
  points,
  action,
  footnote,
  className = "",
}: {
  // No default — `sparkles` is the karma icon specifically (see the karma
  // hub, its nav link, and the profile karma card). A generic fallback here
  // is exactly how it ends up on unrelated first-run pitches like "community
  // datasets"; every caller must pick an icon that actually fits.
  icon: IconName;
  /** Small mono kicker above the headline, e.g. "community datasets". */
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  points?: { icon: IconName; title: string; body: string }[];
  action?: React.ReactNode;
  /** Caveats and honest not-yet-live notes. Rendered small, below the action. */
  footnote?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card px-6 py-9 sm:px-8 ${className}`}>
      <div className="mx-auto max-w-2xl text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-panel text-ink-soft">
          <Icon name={icon} size={20} />
        </div>
        {eyebrow && (
          <div className="mt-4 font-mono text-[10px] uppercase tracking-[.08em] text-ink-faint">
            {eyebrow}
          </div>
        )}
        <h2 className="mt-2 text-[19px] font-bold tracking-tight">{title}</h2>
        {description && (
          <p className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-ink-soft">
            {description}
          </p>
        )}
      </div>

      {points && points.length > 0 && (
        <div className="mx-auto mt-7 grid max-w-3xl gap-5 text-left sm:grid-cols-3 sm:gap-6">
          {points.map((p) => (
            <div key={p.title}>
              <div className="flex items-center gap-2">
                <Icon name={p.icon} size={14} className="shrink-0 text-ink-soft" />
                <div className="font-mono text-[11px] font-bold tracking-tight">{p.title}</div>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{p.body}</p>
            </div>
          ))}
        </div>
      )}

      {action && <div className="mt-7 flex flex-wrap justify-center gap-2.5">{action}</div>}
      {footnote && (
        <p className="mx-auto mt-4 max-w-xl text-center text-[11px] leading-relaxed text-ink-faint">
          {footnote}
        </p>
      )}
    </div>
  );
}

/* ---------- Async list state (error / loading / empty / ready) ----------
 * Every list-backed section (sponsor bounties, submission history, audit logs,
 * …) needs the same three-way branch before it can render real rows: a
 * fetch that failed, a fetch still in flight, and a fetch that succeeded
 * with zero rows. This centralizes that branch so each page only supplies
 * its own copy, not its own control flow. */

export function AsyncState({
  status,
  icon = "database",
  loadingText = "Loading…",
  errorTitle = "Could not load data",
  errorDescription = "Try refreshing the page.",
  emptyTitle,
  emptyDescription,
  emptyChildren,
  emptyAction,
  skeleton,
  children,
}: {
  status: "error" | "loading" | "empty" | "ready";
  icon?: IconName;
  loadingText?: React.ReactNode;
  /** Placeholder shown while loading, for lists whose real rows aren't the
   * compact shape `SkeletonRows` draws (e.g. `<SkeletonCards />`). Supplying
   * the matching shape is what keeps the layout from jumping when data lands. */
  skeleton?: React.ReactNode;
  errorTitle?: React.ReactNode;
  errorDescription?: React.ReactNode;
  emptyTitle?: React.ReactNode;
  emptyDescription?: React.ReactNode;
  emptyChildren?: React.ReactNode;
  emptyAction?: React.ReactNode;
  children?: React.ReactNode;
}) {
  if (status === "error") {
    return <Empty title={errorTitle} description={errorDescription} icon="alert" />;
  }
  if (status === "loading") {
    return (
      <div role="status" aria-live="polite">
        <span className="sr-only">{loadingText}</span>
        {skeleton ?? <SkeletonRows />}
      </div>
    );
  }
  if (status === "empty") {
    return (
      <Empty icon={icon} title={emptyTitle} description={emptyDescription} action={emptyAction}>
        {emptyChildren}
      </Empty>
    );
  }
  return <>{children}</>;
}

/* ---------- Key-value row ---------- */

export function KV({
  label,
  value,
  strong = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-ink-soft">{label}</span>
      <span className={`mono-num text-right ${strong ? "font-semibold" : "font-medium"}`}>
        {value}
      </span>
    </div>
  );
}

/* ---------- Modal (shared overlay/positioning primitive for all dialogs) ---------- */

export function Modal({
  open,
  onClose,
  children,
  align = "center",
  panelClassName = "",
  overlayClassName = "",
}: {
  open: boolean;
  /** Called on backdrop click. Omit to make the modal non-dismissable that way. */
  onClose?: () => void;
  children: React.ReactNode;
  /**
   * `right` turns the same modal into a full-height side drawer — the shape
   * used for "open this record beside the list I am scanning". A prop rather
   * than a caller-supplied `justify-end` class because Tailwind resolves
   * conflicting utilities by stylesheet order, not by class-string order, so an
   * appended override is not reliably the winner.
   */
  align?: "center" | "right";
  panelClassName?: string;
  overlayClassName?: string;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
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
      className={`fixed inset-0 z-50 flex bg-black/40 ${
        align === "right" ? "items-stretch justify-end" : "items-center justify-center p-4"
      } ${overlayClassName}`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={panelClassName}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/* ---------- Confirm dialog (shared, replaces window.confirm) ---------- */

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = true,
  overlayClassName,
  // Callers pass this while their onConfirm handler is in flight (e.g.
  // `claiming`) so a double-click/double-tap can't fire the action twice —
  // changing confirmLabel to "…ing" text alone doesn't stop the button from
  // still being clickable.
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
  /** Use when confirming an action from inside another modal. */
  overlayClassName?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      overlayClassName={overlayClassName}
      panelClassName="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-[14px] border border-line bg-white p-5 shadow-xl"
    >
      <div role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="text-[15px] font-bold text-ink">{title}</div>
        {description && (
          <div className="mt-2 text-[13px] leading-normal text-ink-soft">{description}</div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={confirmDisabled}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} size="sm" onClick={onConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Toggle switch (shared visual switch) ---------- */

/**
 * Visual on/off switch. Renders a `<span>` so it can sit inside a parent
 * `<button>` (e.g. a whole-row toggle) without nesting interactive elements —
 * the parent owns the click and ARIA. For a standalone control, wrap it in a
 * `<button role="switch" aria-checked>`.
 *
 * `size`: "sm" (30×18, inline row toggles) or "md" (38×22, settings rows).
 */
export function Toggle({ on, size = "sm" }: { on: boolean; size?: "sm" | "md" }) {
  const md = size === "md";
  const track = md ? "h-[22px] w-[38px]" : "h-[18px] w-[30px]";
  const knob = md ? "h-[18px] w-[18px]" : "h-3.5 w-3.5";
  const off = md ? "translate-x-[2px]" : "translate-x-[2px]";
  const onX = md ? "translate-x-[18px]" : "translate-x-[13px]";
  return (
    <span
      className={`relative inline-flex ${track} shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-ink" : "bg-line"
      }`}
    >
      <span
        className={`inline-block ${knob} rounded-full shadow transition-transform ${
          on ? onX : off
        }`}
        style={{ backgroundColor: on ? "var(--color-lime)" : "#ffffff" }}
      />
    </span>
  );
}

/* ---------- Notification channel status badge ---------- */

export type ChannelStatus = "delivering" | "pending" | "muted" | "disconnected";

/** Derive a channel's status from its connection flags. Delivering requires
 * connected + verified + deliver (matches the API's delivering-count rule). */
export function channelStatus(c: {
  connected: boolean;
  verified: boolean;
  deliver: boolean;
}): ChannelStatus {
  if (!c.connected) return "disconnected";
  if (!c.verified) return "pending";
  return c.deliver ? "delivering" : "muted";
}

/** Small dot + label badge for a delivery channel's live status. */
export function ChannelStatusBadge({ status }: { status: ChannelStatus }) {
  if (status === "delivering") {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] font-medium text-lime-ink">
        <span className="h-1.5 w-1.5 rounded-full bg-lime ring-1 ring-lime-ink/30" />
        delivering
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-700">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        pending
      </span>
    );
  }
  if (status === "muted") {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-soft">
        <span className="h-1.5 w-1.5 rounded-full bg-ink-soft" />
        connected · muted
      </span>
    );
  }
  return <span className="font-mono text-[10px] text-ink-faint">not connected</span>;
}
