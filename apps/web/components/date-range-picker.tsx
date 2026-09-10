"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { Icon } from "@/components/icons";
import { Popover } from "@/components/ui";

/**
 * Shared date-range picker: a quick-select preset rail beside a two-month
 * custom range calendar with an explicit Apply step.
 *
 * Built on react-day-picker (headless — no vendor stylesheet imported), with
 * every visual class supplied from this app's own theme tokens via the
 * `classNames` prop, so the calendar always matches the design language and a
 * re-brand needs nothing beyond the tokens in globals.css.
 *
 * Value contract: `null` means "all time" (no bounds). A non-null selection
 * carries inclusive local calendar dates; `resolveApiRange` converts them to
 * the UTC instants an API expects (from = start of day, to = end of day) so
 * callers never re-implement that off-by-one-day conversion.
 *
 * Kept behaviourally aligned with the admin console's `AdminDateRangePicker`
 * (`apps/admin/components/admin-filter-bar.tsx`), which is the V1 parity source
 * for a date-range control in this product — V1's web app had no picker at all,
 * only two bare `<input type="date">` fields. Same preset list in the same
 * order, same `Clear` / `Apply` pair, and the same timezone + exact-UTC-window
 * disclosure, so a reader can see which instants the query actually carried.
 * Only the palette differs: admin is a dark theme, this app is light.
 *
 * `WeekWindowPicker` (below) is the same shell for an API that accepts a week
 * COUNT rather than dates.
 */
export interface DateRangeSelection {
  /** Short human label for the closed trigger, e.g. "1 month" or "12 Aug – 01 Sep 2026". */
  label: string;
  /** Set when the selection came from a preset, so the rail highlights by
   *  identity rather than by comparing display labels. Absent for a custom range. */
  presetKey?: string;
  /** Inclusive first local calendar day. */
  from: Date;
  /** Inclusive last local calendar day. */
  to: Date;
}

export interface DateRangePreset {
  key: string;
  label: string;
  /** Days back from today (inclusive window). */
  days: number;
}

export const DEFAULT_DATE_RANGE_PRESETS: DateRangePreset[] = [
  { key: "today", label: "Today", days: 1 },
  { key: "1w", label: "1 week", days: 7 },
  { key: "2w", label: "2 weeks", days: 14 },
  { key: "1m", label: "1 month", days: 30 },
  { key: "3m", label: "3 months", days: 90 },
  { key: "1y", label: "1 year", days: 365 },
];

/** Start-of-local-day / end-of-local-day API instants for a selection.
 *  Returns {} for null (all time) so callers can spread it into query params. */
export function resolveApiRange(selection: DateRangeSelection | null): { from?: string; to?: string } {
  if (!selection) return {};
  const from = new Date(selection.from);
  from.setHours(0, 0, 0, 0);
  const to = new Date(selection.to);
  to.setHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1)); // inclusive window: "1 week" = today plus the 6 days before it
  return d;
}

function fmtDay(date: Date): string {
  return date.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function browserTimeZone(): string {
  if (typeof Intl === "undefined") return "local time";
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
}

function fmtUtcInstant(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

/** The literal window the API is being sent for the applied selection — not a
 *  restatement of the label. "All time" sends no bounds at all, and says so. */
function utcWindowText(selection: DateRangeSelection | null): string {
  const range = resolveApiRange(selection);
  if (!range.from || !range.to) return "No date boundary sent (all records)";
  return `${fmtUtcInstant(range.from)} – ${fmtUtcInstant(range.to)} UTC`;
}

/** True when the viewport is at least `minWidthPx` wide. SSR-safe: it starts
 *  false, so the first paint is the narrow layout and only widens after mount —
 *  a hydration mismatch here would be a visible calendar jump.
 *
 *  Exists because the month count is a react-day-picker PROP, not a CSS
 *  concern: no media query can turn a two-month calendar into a one-month one,
 *  which is the actual reason the panel used to overflow (see TWO_MONTH_MIN_PX). */
function useMinWidth(minWidthPx: number): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(`(min-width: ${minWidthPx}px)`);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMatches(query.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [minWidthPx]);
  return matches;
}

/** Below this viewport width the range calendar shows ONE month instead of two.
 *
 *  Measured, not guessed: the two-month panel's CONTENT is ~739px wide (a 144px
 *  quick-select rail + two ~252px month grids + padding). `sm:max-w` could cap
 *  the box at the viewport but nothing shrank the content, so between `sm`
 *  (640px) and ~765px the panel overflowed its own box — at a 700px viewport,
 *  measured `scrollWidth 739` inside `clientWidth 674`, with the right-anchored
 *  box starting at x = -13, i.e. off the left edge. The visible symptom was a
 *  calendar clipped down its left side with the weekday header cut in half.
 *
 *  Dropping to one month removes the cause rather than hiding it: content that
 *  fits needs no cap, no inner scroll, and no off-screen anchor. 820px leaves
 *  headroom over the 765px the two-month layout actually needs, so the wide
 *  layout only appears where it comfortably fits. */
const TWO_MONTH_MIN_PX = 820;

/** Timezone name, resolved after mount so the server and browser renders match. */
function useBrowserTimeZone(): string {
  const [timeZone, setTimeZone] = useState("local time");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTimeZone(browserTimeZone());
  }, []);
  return timeZone;
}

/* Every class below comes from this app's theme tokens (globals.css), keyed by
 * react-day-picker's stable UI element names. The nav is absolutely positioned
 * across the top so the chevrons flank both month captions, like the reference
 * design. */
const DAY_PICKER_CLASSNAMES = {
  root: "relative",
  months: "flex flex-wrap gap-8",
  month: "space-y-3",
  nav: "absolute inset-x-0 top-0 flex items-center justify-between",
  button_previous:
    "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-panel hover:text-ink disabled:cursor-default disabled:opacity-35",
  button_next:
    "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-panel hover:text-ink disabled:cursor-default disabled:opacity-35",
  chevron: "h-3.5 w-3.5 fill-current",
  month_caption: "flex h-7 items-center justify-center",
  caption_label: "font-mono text-[13px] font-bold text-ink",
  month_grid: "border-separate border-spacing-y-0.5",
  weekdays: "",
  weekday: "h-8 w-9 text-center font-mono text-[10.5px] font-medium uppercase text-ink-faint",
  week: "",
  day: "p-0 text-center",
  day_button:
    "h-8 w-9 cursor-pointer rounded-md font-mono text-[12px] text-ink transition-colors hover:bg-panel disabled:cursor-default disabled:opacity-30",
  today: "[&>button]:font-bold [&>button]:underline [&>button]:underline-offset-2",
  outside: "[&>button]:text-ink-faint/60",
  disabled: "[&>button]:opacity-30",
  hidden: "invisible",
  selected: "[&>button]:bg-karma [&>button]:text-white [&>button]:hover:bg-karma",
  range_start: "rounded-l-md bg-karma-soft",
  range_end: "rounded-r-md bg-karma-soft",
  range_middle: "bg-karma-soft [&>button]:bg-transparent [&>button]:text-ink [&>button]:hover:bg-karma/15",
} as const;

/**
 * The one popover panel both pickers below render into.
 *
 * Positioning is ported from the admin console's `AdminDateRangePicker`
 * (`community/apps/admin/components/admin-filter-bar.tsx`), which is
 * byte-identical to V1 admin's and is therefore the parity source for a
 * date-range control — V1's web app never had one. Two things it gets right
 * that the previous web markup did not:
 *
 *  - **Right-anchored on desktop** (`sm:right-0`). The old panel was
 *    `absolute left-0`, so when the trigger sits on the right of a toolbar the
 *    panel ran off the right edge of the viewport. `max-w` capped its width but
 *    could not pull it back on-screen, which put Clear/Apply out of reach —
 *    observed clipping ~260px at 1280px on /issues.
 *  - **A fixed inset sheet below `sm`** rather than an absolutely positioned
 *    box, so on a phone it can never be clipped by its own trigger's position.
 *
 * The desktop width is also capped at `sm:max-w-[calc(100vw-1.5rem)]`. Being
 * right-anchored stops the panel running off the RIGHT edge, but a fixed width
 * wider than the viewport then hangs off the LEFT instead — measured at a
 * 723px-wide pane, the 741px date-range panel sat at x = -62. The cap makes it
 * shrink to fit instead; the panel already scrolls its own content.
 *
 * Both pickers share this so the two can no longer drift apart: the previous
 * code duplicated the whole class string and had already diverged on the
 * anchor (`left-0` vs `right-0`) and the width.
 */
/** Gutter kept between the panel and either edge of the viewport. */
const PANEL_EDGE_GUTTER_PX = 12;

function PickerPanel({
  label,
  width,
  children,
}: {
  /** Accessible name for the dialog. */
  label: string;
  /** Desktop width classes, e.g. "sm:w-[420px] lg:w-[741px]". Below `sm` the
   *  sheet spans the fixed inset and this is ignored. */
  width: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Correction applied after measuring, and a height cap for the case where the
  // panel is simply taller than the viewport. See the comment below for why an
  // anchor class alone cannot get this right.
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  /* WHY THIS MEASURES INSTEAD OF PICKING AN ANCHOR.
   *
   * `sm:right-0` anchors the panel's right edge to the trigger's. That is
   * correct only when the trigger sits near the right of the viewport. On
   * /karma the trigger is the third control in a filter bar, i.e. mid-row, and
   * a 420px panel right-anchored to it then hangs off the LEFT edge —
   * measured x = -268 at a 640px viewport. `sm:left-0` fails the mirror case
   * (a right-hand trigger pushes it off the right), and `max-w` cannot help
   * either: the panel FITS, it is simply in the wrong place. No static
   * combination of anchor classes is right for every trigger position, so the
   * panel is placed by its anchor and then pulled back inside the viewport.
   *
   * The same argument applies vertically. The panel opens BELOW its trigger,
   * so a trigger low in the page put Clear/Apply under the fold — measured at
   * an 860px-wide, 800px-tall viewport with the two-month layout. `max-h`
   * bounds the panel's height but not where its bottom lands, so the bottom is
   * pulled up the same way, and only when it would otherwise be off-screen.
   *
   * Only the absolutely-positioned desktop panel needs this; below `sm` the
   * panel is a fixed inset sheet whose edges are already the viewport's, and
   * the measurement then resolves to 0 on its own. */
  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;

    const clamp = () => {
      // Measure with any previous correction removed, so each correction is
      // computed from the layout position rather than compounding.
      node.style.transform = "";
      let rect = node.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const room = vh - PANEL_EDGE_GUTTER_PX * 2;

      // Taller than the viewport: cap it and let it scroll its own content,
      // then re-measure, because the cap changes where the bottom is.
      const cap = rect.height > room ? Math.round(room) : null;
      setMaxHeight(cap);
      if (cap !== null) {
        node.style.maxHeight = `${cap}px`;
        rect = node.getBoundingClientRect();
      }

      let dx = 0;
      if (rect.width > vw - PANEL_EDGE_GUTTER_PX * 2) {
        // Wider than the viewport: shifting cannot make it fit, so pin the left
        // edge to the gutter rather than pulling it off-screen chasing the right.
        dx = PANEL_EDGE_GUTTER_PX - rect.left;
      } else if (rect.left < PANEL_EDGE_GUTTER_PX) {
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
      className={`fixed inset-x-3 top-16 z-50 flex max-h-[calc(100dvh-5rem)] flex-col overflow-auto overscroll-contain rounded-2xl border border-line bg-white shadow-[0_14px_36px_rgba(20,23,15,0.14)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+6px)] sm:z-40 sm:max-h-[min(620px,calc(100dvh-2rem))] sm:max-w-[calc(100vw-1.5rem)] sm:flex-row ${width}`}
    >
      {children}
    </div>
  );
}

export function DateRangePicker({
  value,
  onChange,
  presets = DEFAULT_DATE_RANGE_PRESETS,
  allTimeLabel = "All time",
}: {
  value: DateRangeSelection | null;
  onChange: (selection: DateRangeSelection | null) => void;
  presets?: DateRangePreset[];
  allTimeLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // The in-panel draft: committed only on Apply (custom) or immediately on a
  // preset click, matching the reference interaction.
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const timeZone = useBrowserTimeZone();
  // Two month grids only where they fit; see TWO_MONTH_MIN_PX.
  const twoMonths = useMinWidth(TWO_MONTH_MIN_PX);

  const openPanel = () => {
    setDraft(value ? { from: value.from, to: value.to } : undefined);
    setOpen(true);
  };

  const pickPreset = (preset: DateRangePreset | null) => {
    onChange(
      preset
        ? { label: preset.label, presetKey: preset.key, from: daysAgo(preset.days), to: new Date() }
        : null,
    );
    setOpen(false);
  };

  const applyDraft = () => {
    if (!draft?.from || !draft.to) return;
    onChange({ label: `${fmtDay(draft.from)} – ${fmtDay(draft.to)}`, from: draft.from, to: draft.to });
    setOpen(false);
  };

  const clearDraft = () => setDraft(undefined);

  const activePresetKey = value === null ? "all" : value.presetKey ?? "custom";

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Date range: ${value?.label ?? allTimeLabel}`}
          onClick={() => (open ? setOpen(false) : openPanel())}
          className="flex cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-white px-3 py-1.5 font-mono text-[12px] text-ink transition-colors hover:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        >
          <Icon name="clock" size={13} className="text-ink-soft" />
          <span>{value?.label ?? allTimeLabel}</span>
          <Icon name="chevron-down" size={11} className={`text-ink-faint transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      }
    >
      <PickerPanel label="Choose a date range" width={twoMonths ? "sm:w-[741px]" : "sm:w-[420px]"}>
        {/* Quick-select rail */}
        <div className="flex w-full shrink-0 flex-col border-b border-line-soft p-2.5 sm:w-36 sm:border-b-0 sm:border-r">
          <div className="px-2.5 pb-2 pt-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
            Quick select
          </div>
          {presets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => pickPreset(preset)}
              className={`cursor-pointer rounded-lg px-2.5 py-2 text-left font-mono text-[12px] transition-colors ${
                activePresetKey === preset.key ? "bg-karma font-medium text-white" : "text-ink hover:bg-panel"
              }`}
            >
              {preset.label}
            </button>
          ))}
          {/* Last in the rail, as in the admin console: the widest window sits
              at the end of a list ordered shortest-first. */}
          <button
            type="button"
            onClick={() => pickPreset(null)}
            className={`cursor-pointer rounded-lg px-2.5 py-2 text-left font-mono text-[12px] transition-colors ${
              activePresetKey === "all" ? "bg-karma font-medium text-white" : "text-ink hover:bg-panel"
            }`}
          >
            {allTimeLabel}
          </button>
        </div>

        {/* Custom range calendar. `min-w-0` is load-bearing, not cosmetic: this
            is a flex child of the panel, and the UTC-window disclosure below
            uses `truncate` (i.e. `white-space: nowrap`), which sets this
            column's min-content width to the full un-wrapped string — measured
            563px, which is what pushed the panel's scrollWidth to 739 inside a
            418px box. Without it `truncate` cannot truncate. The sibling
            WeekWindowPicker already had it; this one had not. */}
        <div className="min-w-0 p-4">
          <div className="pb-3 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
            Custom range
          </div>
          <DayPicker
            mode="range"
            numberOfMonths={twoMonths ? 2 : 1}
            // Only past dates are selectable, so open on LAST month + current
            // month (current on the right) — the library's default of current
            // + next would present a fully-disabled future month. With one
            // month there is no room for that pair, so open on the current
            // month: the alternative shows last month and hides today.
            defaultMonth={draft?.from ?? (twoMonths ? new Date(new Date().getFullYear(), new Date().getMonth() - 1) : new Date())}
            endMonth={new Date()}
            selected={draft}
            onSelect={setDraft}
            disabled={{ after: new Date() }}
            classNames={DAY_PICKER_CLASSNAMES}
          />
          <div className="mt-3 flex flex-col gap-3 border-t border-line-soft pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="font-mono text-[12px] text-ink-soft">
                {draft?.from
                  ? draft.to
                    ? `${fmtDay(draft.from)} – ${fmtDay(draft.to)}`
                    : `${fmtDay(draft.from)} – pick an end date`
                  : "Select a range"}
              </div>
              {/* The instants the CURRENT (applied) selection actually sends,
                  so the closed trigger's short label is never the only claim
                  on screen about which rows were queried. */}
              <div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
                {timeZone} · API: UTC · {utcWindowText(value)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={clearDraft}
                className="cursor-pointer rounded-lg px-3 py-2 font-mono text-[12px] text-ink-soft transition-colors hover:bg-panel hover:text-ink"
              >
                Clear
              </button>
              <button
                type="button"
                disabled={!draft?.from || !draft.to}
                onClick={applyDraft}
                className="cursor-pointer rounded-lg bg-karma px-4 py-2 font-mono text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      </PickerPanel>
    </Popover>
  );
}

/* ------------------------------------------------------------------ *
 * Week-count window picker
 * ------------------------------------------------------------------ */

export interface WeekWindowOption {
  weeks: number;
  label: string;
}

/** Offered windows. Every value is inside the endpoint's 4–52 range. */
export const DEFAULT_WEEK_WINDOWS: WeekWindowOption[] = [
  { weeks: 4, label: "4 weeks" },
  { weeks: 8, label: "8 weeks" },
  { weeks: 12, label: "12 weeks" },
  { weeks: 26, label: "26 weeks" },
  { weeks: 52, label: "52 weeks" },
];

/** What the server said it actually served, straight from the response. */
export interface ServedWeekWindow {
  weeks: number;
  /** First bucket's Monday, as the API returned it (yyyy-mm-dd, UTC). */
  from: string;
  /** Last bucket's Monday, as the API returned it (yyyy-mm-dd, UTC). */
  to: string;
}

/**
 * The same popover shell as `DateRangePicker`, for a series endpoint whose
 * contract is a WEEK COUNT rather than two dates.
 *
 * Why not a calendar here. `GET /v1/me/analytics` takes exactly one parameter,
 * `weeks` (4–52), and always returns the trailing run of ISO weeks ending with
 * the current one — it has no `from`/`to` and cannot serve an arbitrary
 * historic window. Handing the reader a calendar and then quietly snapping the
 * request to "the last N weeks ending today" would put a range on screen that
 * the API never served, so the control stays in the unit the API accepts and
 * discloses the window the response reported.
 */
export function WeekWindowPicker({
  value,
  onChange,
  options = DEFAULT_WEEK_WINDOWS,
  minWeeks = 4,
  maxWeeks = 52,
  served,
  label = "Window",
}: {
  value: number;
  onChange: (weeks: number) => void;
  options?: WeekWindowOption[];
  minWeeks?: number;
  maxWeeks?: number;
  /** `null` until a response has landed. Never inferred from `value`. */
  served: ServedWeekWindow | null;
  /** Visible label beside the trigger. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const timeZone = useBrowserTimeZone();

  const openPanel = () => {
    setDraft(String(value));
    setOpen(true);
  };

  const pickOption = (weeks: number) => {
    onChange(weeks);
    setOpen(false);
  };

  const draftWeeks = Number.parseInt(draft, 10);
  const draftValid =
    Number.isInteger(draftWeeks) && draftWeeks >= minWeeks && draftWeeks <= maxWeeks;

  const applyDraft = () => {
    if (!draftValid) return;
    onChange(draftWeeks);
    setOpen(false);
  };

  const triggerLabel = `${value} ${value === 1 ? "week" : "weeks"}`;

  return (
    <label className="flex items-center gap-2 text-[12px] text-ink-soft">
      <span>{label}</span>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`Analytics window: ${triggerLabel}`}
            onClick={() => (open ? setOpen(false) : openPanel())}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-white px-3 py-1.5 font-mono text-[12px] text-ink transition-colors hover:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          >
            <Icon name="clock" size={13} className="text-ink-soft" />
            <span>{triggerLabel}</span>
            <Icon
              name="chevron-down"
              size={11}
              className={`text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        }
      >
        <PickerPanel label="Choose an analytics window" width="sm:w-[380px]">
          {/* Quick-select rail — same classes as the date-range picker's. */}
          <div className="flex w-full shrink-0 flex-col border-b border-line-soft p-2.5 sm:w-36 sm:border-b-0 sm:border-r">
            <div className="px-2.5 pb-2 pt-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
              Quick select
            </div>
            {options.map((option) => (
              <button
                key={option.weeks}
                type="button"
                onClick={() => pickOption(option.weeks)}
                className={`cursor-pointer rounded-lg px-2.5 py-2 text-left font-mono text-[12px] transition-colors ${
                  value === option.weeks
                    ? "bg-karma font-medium text-white"
                    : "text-ink hover:bg-panel"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="min-w-0 p-4">
            <div className="pb-3 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
              Custom window
            </div>
            <p className="mb-2.5 text-[12px] text-ink-soft">
              Any whole number of weeks from {minWeeks} to {maxWeeks}. The window always ends with
              the current week — this report is not available for an arbitrary past range.
            </p>
            <input
              type="number"
              inputMode="numeric"
              min={minWeeks}
              max={maxWeeks}
              step={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyDraft();
                }
              }}
              aria-label={`Number of weeks, ${minWeeks} to ${maxWeeks}`}
              className="h-9 w-full rounded-lg border border-line bg-white px-2.5 font-mono text-[12px] text-ink outline-none transition-colors focus:border-ink"
            />

            <div className="mt-3 flex flex-col gap-3 border-t border-line-soft pt-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                {/* Straight from the response's `range`. Before the first
                    response there is nothing to report, and it says so rather
                    than echoing the requested number back as if it were data. */}
                <div className="font-mono text-[10px] text-ink-faint">
                  {served
                    ? `Served: ${served.weeks} ISO weeks · ${served.from} – ${served.to}`
                    : "No window served yet"}
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
                  {timeZone} · buckets: ISO weeks, Monday start, UTC
                </div>
              </div>
              <button
                type="button"
                disabled={!draftValid || draftWeeks === value}
                onClick={applyDraft}
                className="shrink-0 cursor-pointer rounded-lg bg-karma px-4 py-2 font-mono text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          </div>
        </PickerPanel>
      </Popover>
    </label>
  );
}
