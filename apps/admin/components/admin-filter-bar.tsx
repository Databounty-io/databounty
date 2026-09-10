"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import {
  browserTimeZone,
  dateFromInput,
  dateInputValue,
  endOfLocalDay,
  formatDateInput,
  localDateBounds,
  startOfLocalDay,
} from "@/lib/date";

export type DatePreset = "today" | "7d" | "14d" | "30d" | "90d" | "365d" | "all" | "custom";

export interface DateRangeValue {
  preset: DatePreset;
  /** yyyy-mm-dd, only meaningful when preset === "custom". */
  from?: string;
  to?: string;
}

const PRESETS: { key: Exclude<DatePreset, "custom">; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "1 week" },
  { key: "14d", label: "2 weeks" },
  { key: "30d", label: "1 month" },
  { key: "90d", label: "3 months" },
  { key: "365d", label: "1 year" },
  { key: "all", label: "All time" },
];

/** Resolve inclusive local calendar days into UTC instants for the API. */
export function resolveDateRange(value: DateRangeValue): { from?: string; to?: string } {
  if (value.preset === "custom") {
    if (!value.from || !value.to || dateFromInput(value.from) > dateFromInput(value.to)) return {};
    const from = localDateBounds(value.from);
    const to = localDateBounds(value.to);
    return { from: from.from, to: to.to };
  }
  if (value.preset === "all") return {};

  const today = new Date();
  const from = startOfLocalDay(today);
  const to = endOfLocalDay(today);
  const daysBack = value.preset === "today"
    ? 0
    : value.preset === "7d"
      ? 6
      : value.preset === "14d"
        ? 13
        : value.preset === "30d"
          ? 29
          : value.preset === "90d"
            ? 89
            : 364;
  from.setDate(from.getDate() - daysBack);
  return { from: from.toISOString(), to: to.toISOString() };
}

function rangeLabel(value: DateRangeValue): string {
  if (value.preset !== "custom") return PRESETS.find((p) => p.key === value.preset)?.label ?? "All time";
  if (!value.from || !value.to) return "Custom range";
  return `${formatDateInput(value.from)} – ${formatDateInput(value.to)}`;
}

interface AdminDateRangePickerProps {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function calendarDateValue(year: number, month: number, day: number): string {
  return dateInputValue(new Date(year, month, day));
}

function calendarDays(month: Date): Array<number | null> {
  const firstWeekday = month.getDay();
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  return [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: count }, (_, index) => index + 1),
  ];
}

function displayRange(from: string, to: string): string {
  if (!from && !to) return "Select a range";
  if (from && to) return `${formatDateInput(from)} – ${formatDateInput(to)}`;
  return `From ${formatDateInput(from)}`;
}

/** Gutter kept between an open panel and either edge of the viewport. */
const PANEL_EDGE_GUTTER_PX = 12;

/** A popover panel that keeps itself inside the viewport.
 *
 * WHY IT MEASURES INSTEAD OF PICKING AN ANCHOR. The panel is `sm:right-0`,
 * i.e. its right edge is anchored to the trigger's. That is correct only for a
 * trigger near the right of the viewport; every filter bar here puts the date
 * control mid-row, so a 660px panel right-anchored to it hung off the LEFT
 * edge — measured x = -57 at a 640px viewport on `/submissions`, putting the
 * Quick-select rail and the first month's left column out of reach. `sm:left-0`
 * fails the mirror case, and a `max-w` cap cannot help when the panel fits and
 * is merely mispositioned. So the panel keeps its anchor and is then pulled
 * back inside a fixed gutter, vertically as well — the footer of a panel opened
 * from a low trigger otherwise lands under the fold. A panel taller than the
 * viewport is capped so its own scroll takes over.
 *
 * Rendered only while open (the caller unmounts it), so the measurement runs
 * once per opening plus on resize.
 *
 * Mirrors `PickerPanel` in `apps/web/components/date-range-picker.tsx`. The two
 * apps share no component layer, so this is duplicated deliberately — change
 * both together. */
function ClampedPanel({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;

    const clamp = () => {
      // Measure with any previous correction removed, so corrections are
      // computed from the layout position instead of compounding.
      node.style.transform = "";
      let rect = node.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const room = vh - PANEL_EDGE_GUTTER_PX * 2;

      const cap = rect.height > room ? Math.round(room) : null;
      setMaxHeight(cap);
      if (cap !== null) {
        node.style.maxHeight = `${cap}px`;
        rect = node.getBoundingClientRect();
      }

      let dx = 0;
      if (rect.width > vw - PANEL_EDGE_GUTTER_PX * 2 || rect.left < PANEL_EDGE_GUTTER_PX) {
        // Wider than the viewport, or off the left edge: pin the left edge to
        // the gutter. Shifting cannot make an over-wide panel fit, and pulling
        // it further left to chase the right edge only hides more of it.
        dx = PANEL_EDGE_GUTTER_PX - rect.left;
      } else if (rect.right > vw - PANEL_EDGE_GUTTER_PX) {
        dx = vw - PANEL_EDGE_GUTTER_PX - rect.right;
      }

      let dy = 0;
      if (rect.bottom > vh - PANEL_EDGE_GUTTER_PX) {
        // Pull the bottom into view, but never so far that the top leaves it.
        dy = Math.max(vh - PANEL_EDGE_GUTTER_PX - rect.bottom, PANEL_EDGE_GUTTER_PX - rect.top);
      }

      setShift({ x: Math.round(dx), y: Math.round(dy) });
    };

    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      style={{
        ...(shift.x || shift.y ? { transform: `translate(${shift.x}px, ${shift.y}px)` } : {}),
        ...(maxHeight !== null ? { maxHeight } : {}),
      }}
      className={className}
    >
      {children}
    </div>
  );
}

/** Shared date picker. Displayed dates are local calendar dates; the API
 * receives the corresponding UTC start/end instants. */
export function AdminDateRangePicker({ value, onChange }: AdminDateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(value.from ?? "");
  const [draftTo, setDraftTo] = useState(value.to ?? "");
  const [timeZone, setTimeZone] = useState("local time");
  const [viewMonth, setViewMonth] = useState(monthStart(new Date()));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Avoid a server/browser timezone hydration mismatch on first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTimeZone(browserTimeZone());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pickPreset = (key: Exclude<DatePreset, "custom">) => {
    onChange({ preset: key });
    setOpen(false);
  };

  const customInvalid = Boolean(draftFrom && draftTo && dateFromInput(draftFrom) > dateFromInput(draftTo));
  const chooseDate = (iso: string) => {
    if (!draftFrom || draftTo) {
      setDraftFrom(iso);
      setDraftTo("");
      return;
    }
    if (iso < draftFrom) {
      setDraftFrom(iso);
      setDraftTo(draftFrom);
    } else {
      setDraftTo(iso);
    }
  };

  const applyCustom = () => {
    if (!draftFrom || !draftTo || customInvalid) return;
    onChange({ preset: "custom", from: draftFrom, to: draftTo });
    setOpen(false);
  };

  const clearCustom = () => {
    setDraftFrom("");
    setDraftTo("");
  };

  const today = dateInputValue(new Date());
  const activeQuery = resolveDateRange(value);
  const utcWindow = activeQuery.from && activeQuery.to
    ? `${new Date(activeQuery.from).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} – ${new Date(activeQuery.to).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`
    : "No date boundary sent (all records)";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setDraftFrom(value.from ?? "");
          setDraftTo(value.to ?? "");
          setViewMonth(monthStart(value.from ? dateFromInput(value.from) : new Date()));
          setOpen((o) => !o);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Date range: ${rangeLabel(value)}`}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-dark-line bg-dark-panel px-3 py-2 font-mono text-xs text-dark-text transition-colors hover:border-dark-hover sm:w-auto sm:min-w-[210px]"
      >
        <span className="truncate">{rangeLabel(value)}</span>
        <span className="text-dark-dim">▾</span>
      </button>

      {open && (
        /* Width steps at 820px, not `sm` (640px): the two-month layout needs
           ~660px plus gutters, so between 640 and 820 the panel was wider than
           the space it had. Below 820 it is a 420px one-month panel; `max-w` is
           a last-resort cap for a viewport narrower than that.
           The `!` on the 820px width is load-bearing, not sloppiness: Tailwind
           emits the `sm:` utility AFTER the arbitrary `min-[820px]:` one, so
           without it `sm:w-[420px]` wins at every width and the wide panel
           renders two months inside a 420px box — measured w = 420 with both
           months visible at 1440px before the modifier was added. */
        <ClampedPanel
          label="Choose date range"
          className="fixed left-3 right-3 top-16 z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain rounded-2xl border border-dark-line bg-dark-card shadow-2xl sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:mt-2 sm:max-h-[min(620px,calc(100dvh-2rem))] sm:w-[420px] sm:max-w-[calc(100vw-1.5rem)] min-[820px]:w-[660px]!"
        >
          <div className="grid min-h-[360px] grid-cols-1 sm:grid-cols-[160px_1fr]">
            <div className="border-b border-dark-line p-3 sm:border-b-0 sm:border-r">
              <div className="mb-3 px-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-dark-dim">Quick select</div>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-1">
                {PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.key}
                    onClick={() => pickPreset(p.key)}
                    className={`cursor-pointer rounded-xl px-3 py-2 text-left font-mono text-xs transition-colors ${
                      value.preset === p.key ? "bg-lime text-dark" : "text-dark-text hover:bg-dark-panel"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-w-0 p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-dark-dim">Custom range</div>
                <div className="flex items-center gap-2">
                  <button type="button" aria-label="Previous month" onClick={() => setViewMonth((m) => addMonths(m, -1))} className="grid h-10 w-10 place-items-center rounded-md text-lg text-dark-text hover:bg-dark-panel sm:h-7 sm:w-7">‹</button>
                  <button type="button" aria-label="Next month" onClick={() => setViewMonth((m) => addMonths(m, 1))} className="grid h-10 w-10 place-items-center rounded-md text-lg text-dark-text hover:bg-dark-panel sm:h-7 sm:w-7">›</button>
                </div>
              </div>

              {/* One month until the panel is actually 660px wide (820px viewport).
                  Two 7-column grids inside the narrow panel gave ~22px day
                  cells and overflowed the box. */}
              <div className="grid grid-cols-1 gap-4 min-[820px]:grid-cols-2">
                {[viewMonth, addMonths(viewMonth, 1)].map((month, monthIndex) => (
                  <div key={`${month.getFullYear()}-${month.getMonth()}`} className={monthIndex === 1 ? "hidden min-[820px]:block" : undefined}>
                    <div className="mb-3 text-center font-mono text-xs font-bold text-dark-text">{MONTHS[month.getMonth()]} {month.getFullYear()}</div>
                    <div className="grid grid-cols-7 gap-y-1 text-center font-mono text-[9px] text-dark-dim">
                      {WEEKDAYS.map((day) => <span key={day} className="pb-1">{day}</span>)}
                      {calendarDays(month).map((day, index) => {
                        if (!day) return <span key={`blank-${index}`} className="h-10 sm:h-7" />;
                        const iso = calendarDateValue(month.getFullYear(), month.getMonth(), day);
                        const disabled = iso > today;
                        const inRange = Boolean(draftFrom && draftTo && iso >= draftFrom && iso <= draftTo);
                        const selected = iso === draftFrom || iso === draftTo;
                        return (
                          <button
                            type="button"
                            key={iso}
                            disabled={disabled}
                            aria-label={formatDateInput(iso)}
                            onClick={() => chooseDate(iso)}
                            className={`h-10 rounded-md text-xs transition-colors sm:h-7 ${
                              selected ? "bg-lime font-bold text-dark" : inRange ? "bg-lime/20 text-dark-text" : "text-dark-text hover:bg-dark-panel"
                            } ${disabled ? "cursor-not-allowed text-dark-dim/40" : "cursor-pointer"}`}
                          >
                            {day}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-5 flex flex-col gap-3 border-t border-dark-line-soft pt-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] text-dark-dim">{displayRange(draftFrom, draftTo)}</div>
                  <div className="mt-1 truncate font-mono text-[9px] text-dark-dim">{timeZone} · API: UTC · {utcWindow}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button type="button" onClick={clearCustom} className="rounded-lg px-3 py-2 font-mono text-xs text-dark-soft hover:bg-dark-panel hover:text-dark-text">Clear</button>
                  <button type="button" onClick={applyCustom} disabled={!draftFrom || !draftTo || customInvalid} className="rounded-lg bg-lime px-4 py-2 font-mono text-xs font-medium text-dark transition-colors hover:bg-lime-bright disabled:cursor-not-allowed disabled:opacity-40">Apply</button>
                </div>
              </div>
            </div>
          </div>
        </ClampedPanel>
      )}
    </div>
  );
}

interface AdminFilterBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  searchPlaceholder?: string;
  dateRange: DateRangeValue;
  onDateRangeChange: (v: DateRangeValue) => void;
}

/** Shared server-side search and date filters for admin list pages. */
export function AdminFilterBar({
  search,
  onSearchChange,
  searchPlaceholder = "search…",
  dateRange,
  onDateRangeChange,
}: AdminFilterBarProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dark-line bg-dark-card p-3 sm:flex-row sm:items-center sm:justify-between">
      <label className="relative w-full sm:max-w-xs">
        <span className="sr-only">{searchPlaceholder}</span>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="w-full rounded-lg border border-dark-line bg-dark-panel px-3 py-2 font-mono text-xs text-dark-text placeholder:text-dark-dim focus:border-dark-hover focus:outline-none"
        />
        {search && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onSearchChange("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-1 font-mono text-sm text-dark-dim hover:text-dark-text"
          >
            ×
          </button>
        )}
      </label>
      <div className="flex flex-col gap-1 sm:items-end">
        <AdminDateRangePicker value={dateRange} onChange={onDateRangeChange} />
        <span className="font-mono text-[9px] text-dark-dim">local calendar days · UTC query</span>
      </div>
    </div>
  );
}

interface AdminPaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

/** Shared server-side pager driving skip/limit query params. */
export function AdminPagination({ page, pageSize, total, onPageChange }: AdminPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  const pages = Array.from({ length: totalPages }, (_, i) => i).filter((p) => p === 0 || p === totalPages - 1 || Math.abs(p - page) <= 1);
  const pageItems: Array<number | "ellipsis"> = [];
  pages.forEach((p, i) => {
    if (i > 0 && p - pages[i - 1] > 1) pageItems.push("ellipsis");
    pageItems.push(p);
  });

  return (
    <nav aria-label="Pagination" className="flex flex-col gap-3 rounded-xl border border-dark-line bg-dark-card px-3 py-3 font-mono text-[11px] text-dark-soft sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <span className="text-center sm:text-left">
        {from}–{to} of {total} <span className="text-dark-dim">· page {page + 1} of {totalPages}</span>
      </span>
      <div className="flex items-center justify-center gap-1.5">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 0}
          onClick={() => onPageChange(page - 1)}
          className="cursor-pointer rounded-lg border border-dark-line-soft px-3 py-2.5 text-dark-text transition-colors hover:border-dark-hover disabled:cursor-not-allowed disabled:opacity-40 sm:py-1.5"
        >
          ← prev
        </button>
        <div className="hidden items-center gap-1 sm:flex">
          {pageItems.map((item, index) => item === "ellipsis" ? (
            <span key={`ellipsis-${index}`} className="px-1.5 text-dark-dim">…</span>
          ) : (
            <button
              type="button"
              key={item}
              aria-label={`Go to page ${item + 1}`}
              aria-current={item === page ? "page" : undefined}
              onClick={() => onPageChange(item)}
              className={`min-w-8 rounded-lg border px-2 py-2.5 transition-colors sm:py-1.5 ${item === page ? "border-lime bg-lime text-dark" : "border-dark-line-soft text-dark-text hover:border-dark-hover"}`}
            >
              {item + 1}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Next page"
          disabled={page + 1 >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="cursor-pointer rounded-lg border border-dark-line-soft px-3 py-2.5 text-dark-text transition-colors hover:border-dark-hover disabled:cursor-not-allowed disabled:opacity-40 sm:py-1.5"
        >
          next →
        </button>
      </div>
    </nav>
  );
}
