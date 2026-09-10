"use client";

// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly activity charts for the contributor and validator workspaces, backed
 * by GET /v1/me/analytics.
 *
 * Honesty rules this file follows, because a chart is the easiest place on the
 * platform to imply something the data never said:
 *
 *  - A week with no rows is drawn as a real zero column, never skipped and
 *    never interpolated. Bars, not a line: a line between two weekly totals
 *    draws values on days that have no measurement.
 *  - The y-axis starts at zero and the scale is stated on the chart.
 *  - The server's `notes` are rendered verbatim under the charts. They say
 *    which series are grouped by event time and which by submission week, and
 *    that difference is not visible in the bars themselves.
 *  - Every chart has a table view holding the same numbers, so identity never
 *    depends on telling two colours apart.
 *
 * Colour: the four submission-outcome hues, the two audit hues and the three
 * flag-outcome hues were each checked with the palette validator against the
 * white card surface — lightness band, chroma floor, colour-vision separation,
 * normal-vision separation and contrast. Green/red for cleared-versus-flagged
 * failed deuteranope separation (ΔE 4.9) and is deliberately not used; blue and
 * amber replaced it. The app has no dark theme, so there are no dark steps.
 */

import { useEffect, useMemo, useState } from "react";
import { AsyncState, Pagination, SectionHeader, Table, Td } from "@/components/ui";
import { DateRangePicker, type DateRangeSelection } from "@/components/date-range-picker";
import { SectionNote } from "@/components/workspace";
import { num } from "@/lib/format";
import {
  DEFAULT_ANALYTICS_WINDOW,
  getMemberAnalytics,
  type AuditWeek,
  type KarmaWeek,
  type MemberAnalytics,
  type SubmissionWeek,
} from "@/lib/api-analytics";

/* ---------- palette (validated; see the file header) ---------- */

const COLOR = {
  accepted: "#4f7a00",
  inReview: "#2b6cb0",
  needsFixes: "#b8860b",
  rejected: "#c2334d",
  karma: "#7c5cc4",
};

/* ---------- chart primitive ---------- */

interface Series<T> {
  key: string;
  label: string;
  color: string;
  value: (row: T) => number;
}

/** "2026-08-31" → "Aug 31", read as UTC so the bucket never shifts a day. */
function weekLabel(weekStart: string): string {
  return new Date(`${weekStart}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Stacked weekly bars. One column per week, segments in the order given
 * (first series at the bottom), every segment measured against the same
 * maximum so the column height is the week's total.
 */
function WeeklyStack<T extends { weekStart: string }>({
  rows,
  series,
  unit,
}: {
  rows: T[];
  series: Series<T>[];
  /** What one unit is, for the readout: "items", "karma", "decisions". */
  unit: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const totals = rows.map((row) => series.reduce((t, s) => t + s.value(row), 0));
  // A zero max would divide by zero; an all-zero window still needs a baseline.
  const max = Math.max(1, ...totals);
  const active = hovered ?? rows.length - 1;
  const activeRow = rows[active];

  // Label every nth column so the axis never collides with itself on a
  // 52-week window; the newest week is always labelled.
  const labelEvery = Math.max(1, Math.ceil(rows.length / 6));

  return (
    <div>
      {/* Readout: the hover layer. Defaults to the newest week, so the panel
          holds real numbers before the pointer arrives and on touch, where
          there is no hover at all. */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
        <span className="font-mono font-semibold text-ink">
          {activeRow ? weekLabel(activeRow.weekStart) : "—"}
        </span>
        <span className="text-ink-faint">
          week of {activeRow?.weekStart ?? "—"} ·{" "}
          {hovered === null ? "most recent week" : "hovered"}
        </span>
        {activeRow &&
          series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5 text-ink-soft">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ background: s.color }}
              />
              {s.label} <span className="font-mono text-ink">{num(s.value(activeRow))}</span>
            </span>
          ))}
      </div>

      <div className="relative">
        {/* Recessive gridlines at 0, half and full scale. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {[0, 0.5, 1].map((f) => (
            <div
              key={f}
              className="absolute left-0 right-0 border-t border-line-soft"
              style={{ top: `${f * 100}%` }}
            />
          ))}
        </div>

        <div
          className="flex h-40 items-end gap-[3px]"
          onMouseLeave={() => setHovered(null)}
        >
          {rows.map((row, i) => {
            const total = totals[i] ?? 0;
            // Top of the stack renders first (flex-col + justify-end anchors
            // the column to the baseline), so walk the series backwards.
            const segments = [...series].reverse().filter((s) => s.value(row) > 0);
            return (
              <div
                key={row.weekStart}
                className="relative flex h-full flex-1 flex-col justify-end"
                onMouseEnter={() => setHovered(i)}
                onFocus={() => setHovered(i)}
                tabIndex={0}
                role="img"
                aria-label={`Week of ${row.weekStart}: ${series
                  .map((s) => `${s.value(row)} ${s.label}`)
                  .join(", ")}`}
                title={`${weekLabel(row.weekStart)} — ${total} ${unit}`}
              >
                {total === 0 ? (
                  // A real zero, drawn as a hairline on the baseline rather
                  // than as nothing at all — an absent column reads as "no
                  // data", which is a different claim.
                  <div className="h-[2px] w-full rounded-[1px] bg-line" />
                ) : (
                  segments.map((s, si) => (
                    <div
                      key={s.key}
                      className={si === 0 ? "w-full rounded-t-[4px]" : "w-full"}
                      style={{
                        height: `${(s.value(row) / max) * 100}%`,
                        background: s.color,
                        opacity: hovered === null || hovered === i ? 1 : 0.45,
                        // The 2px separation between segments is drawn INSIDE
                        // the segment as a card-coloured border, not as a flex
                        // gap. A gap adds height the percentages do not know
                        // about, so the flex box shrinks every segment to fit
                        // and the tallest column ends up encoding slightly
                        // less than its value — a chart that lies by ~4% at
                        // exactly the column a reader compares everything to.
                        borderBottom:
                          si === segments.length - 1 ? undefined : "2px solid #fff",
                        boxSizing: "border-box",
                        flexShrink: 0,
                      }}
                    />
                  ))
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-1.5 flex gap-[3px]">
          {rows.map((row, i) => (
            <div key={row.weekStart} className="min-w-0 flex-1 text-center">
              {/* Newest week always; every nth before it, but never one
                  that would sit under the newest label — at mobile width
                  those two overlap by ~10px. */}
              {(i === rows.length - 1 ||
                (i % labelEvery === 0 && rows.length - 1 - i >= labelEvery)) && (
                // nowrap and allowed to overflow its own column: at mobile
                // width a column is ~23px and "15 Jun" otherwise wraps to two
                // ragged lines inside it. Only every nth column is labelled,
                // so the neighbouring space is empty and the overflow paints
                // into it without moving anything.
                <span className="whitespace-nowrap font-mono text-[10px] text-ink-faint">
                  {weekLabel(row.weekStart)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="mt-2 font-mono text-[10px] text-ink-faint">
        Scale 0–{num(max)} {unit} per week · zero baseline
      </p>
    </div>
  );
}

/** Legend with per-series totals. Present whenever there are two or more. */
function Legend<T>({ series, rows }: { series: Series<T>[]; rows: T[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5 text-[12px] text-ink-soft">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-[3px]"
            style={{ background: s.color }}
          />
          {s.label}
          <span className="font-mono text-ink">{num(rows.reduce((t, r) => t + s.value(r), 0))}</span>
        </li>
      ))}
    </ul>
  );
}

/** The same numbers as a table — the relief for anyone the colours fail. */
/** Rows per page in the accessible table view. Twelve because that is the
 *  default window, so the common case is exactly one page and the control
 *  stays hidden (`Pagination` returns null at a single page). At the API's
 *  52-week maximum this is five pages instead of one 52-row scroll. */
const TABLE_PAGE_SIZE = 12;

function SeriesTable<T extends { weekStart: string }>({
  rows,
  series,
}: {
  rows: T[];
  series: Series<T>[];
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));

  // The window selector can shrink the row count under the current page (52
  // weeks on page 5, then back to 12). Clamp during render rather than in an
  // effect: an effect would paint one empty page first.
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * TABLE_PAGE_SIZE;
  const visible = rows.slice(start, start + TABLE_PAGE_SIZE);
  const firstShown = rows.length === 0 ? 0 : start + 1;
  const lastShown = start + visible.length;

  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[12px] text-ink-soft underline decoration-line-strong underline-offset-2">
        Show these numbers as a table
      </summary>
      <div className="mt-2">
        <Table headers={["Week of", ...series.map((s) => s.label)]}>
          {visible.map((row) => (
            <tr key={row.weekStart}>
              <Td className="font-mono text-[12px] text-ink-soft">{row.weekStart}</Td>
              {series.map((s) => (
                <Td key={s.key} className="font-mono text-[12px]">
                  {num(s.value(row))}
                </Td>
              ))}
            </tr>
          ))}
        </Table>
        {/* Says which rows these are, so a paged table can never be mistaken
            for the whole window — the chart above always shows every week. */}
        <p className="mt-2 font-mono text-[11px] text-ink-faint" aria-live="polite">
          {rows.length === 0
            ? "No weeks in this window."
            : `weeks ${firstShown}–${lastShown} of ${rows.length} · the chart above shows all ${rows.length}`}
        </p>
        <Pagination
          page={safePage}
          totalPages={totalPages}
          onPrev={() => setPage(Math.max(1, safePage - 1))}
          onNext={() => setPage(Math.min(totalPages, safePage + 1))}
          className="mt-2"
        />
      </div>
    </details>
  );
}

/** One titled chart block. */
function ChartCard<T extends { weekStart: string }>({
  title,
  sub,
  rows,
  series,
  unit,
}: {
  title: string;
  sub: string;
  rows: T[];
  series: Series<T>[];
  unit: string;
}) {
  return (
    <div className="card p-4">
      <div className="mb-3">
        <h3 className="font-mono text-[13px] font-bold text-ink">{title}</h3>
        <p className="mt-0.5 text-[12px] text-ink-soft">{sub}</p>
      </div>
      {series.length > 1 && (
        <div className="mb-3">
          <Legend series={series} rows={rows} />
        </div>
      )}
      <WeeklyStack rows={rows} series={series} unit={unit} />
      <SeriesTable rows={rows} series={series} />
    </div>
  );
}

/* ---------- series definitions ---------- */

const SUBMISSION_SERIES: Series<SubmissionWeek>[] = [
  { key: "accepted", label: "Accepted", color: COLOR.accepted, value: (r) => r.accepted },
  { key: "inReview", label: "Still in review", color: COLOR.inReview, value: (r) => r.inReview },
  { key: "needsFixes", label: "Needs fixes", color: COLOR.needsFixes, value: (r) => r.needsFixes },
  { key: "rejected", label: "Rejected", color: COLOR.rejected, value: (r) => r.rejected },
];

const KARMA_SERIES: Series<KarmaWeek>[] = [
  { key: "karma", label: "Karma", color: COLOR.karma, value: (r) => r.karma },
];

const AUDIT_SERIES: Series<AuditWeek>[] = [
  {
    key: "cleared",
    label: "Cleared",
    color: COLOR.inReview,
    // Not a stored column: audited minus flagged, which is exactly the rows
    // the validator decided and did not flag. Never negative — `flagged`
    // counts a subset of the same audit items.
    value: (r) => Math.max(0, r.audited - r.flagged),
  },
  { key: "flagged", label: "Flagged", color: COLOR.needsFixes, value: (r) => r.flagged },
];

const FLAG_SERIES: Series<AuditWeek>[] = [
  { key: "confirmed", label: "Upheld", color: COLOR.accepted, value: (r) => r.flagsConfirmed },
  { key: "pending", label: "Still open", color: COLOR.inReview, value: (r) => r.flagsPending },
  { key: "dismissed", label: "Dismissed", color: COLOR.rejected, value: (r) => r.flagsDismissed },
];

/* ---------- window control ---------- */

/** A `YYYY-MM-DD` day in UTC. The endpoint takes plain ISO days and buckets in
 *  UTC, so formatting in local time here would shift the requested window by a
 *  day for anyone west of Greenwich. */
function isoDay(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}

/* ---------- section ---------- */

export function WorkspaceAnalytics({
  audience,
  title = "Your activity",
}: {
  audience: "contributor" | "validator";
  /**
   * Overridable so a page that renders BOTH audiences (app/(app)/analytics)
   * does not end up with two identical "Your activity" headings — a real
   * duplicate-heading problem for anyone navigating by headings. As of the
   * 2026-09-07 owner instruction that is the ONLY caller: the contributor and
   * validator workspaces no longer embed these charts, so both live call sites
   * pass an audience-qualified title and the default is a fallback only.
   */
  title?: string;
}) {
  // Owner instruction 2026-09-07: analytics is chosen by DATE RANGE, the same
  // control the rest of the dashboard uses — not by a week count. `null` means
  // no range picked yet, which falls back to the default trailing window rather
  // than requesting "all time" (the endpoint caps any window at 52 weeks).
  const [range, setRange] = useState<DateRangeSelection | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState<MemberAnalytics | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");

  // One fetch path for both the window selector and the retry button: the
  // button bumps `reloadKey` rather than calling a second copy of this.
  useEffect(() => {
    let live = true;
    void (async () => {
      // Inside the async body, not the effect body: a synchronous setState in
      // an effect triggers a cascading render and the lint rule rejects it.
      setStatus("loading");
      try {
        const next = await getMemberAnalytics(
          range ? { from: isoDay(range.from), to: isoDay(range.to) } : DEFAULT_ANALYTICS_WINDOW,
        );
        if (!live) return;
        setData(next);
        setStatus("ready");
      } catch {
        if (!live) return;
        setData(null);
        setStatus("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [range, reloadKey]);

  const isEmpty = useMemo(() => {
    if (!data) return false;
    return audience === "contributor"
      ? data.contributor.totals.submitted === 0 && data.contributor.totals.karma === 0
      : data.validator.totals.audited === 0 && data.validator.totals.flagsPending === 0;
  }, [data, audience]);

  const notes = useMemo(() => {
    if (!data) return [];
    const wanted = audience === "contributor" ? "contributor." : "validator.";
    return data.notes.filter((note) => note.field.startsWith(wanted));
  }, [data, audience]);

  return (
    <div className="mt-7">
      <SectionHeader
        title={title}
        sub={
          audience === "contributor"
            ? "Weekly submission outcomes and karma, from your own rows."
            : "Weekly audit decisions and what became of the items you flagged."
        }
        action={
          <DateRangePicker
            value={range}
            onChange={setRange}
            allTimeLabel={`Last ${DEFAULT_ANALYTICS_WINDOW} weeks`}
          />
        }
      />

      {/* The served window, restated in prose next to the charts, because the
          bucket rule (ISO weeks, Monday start, UTC) is not visible in a bar. */}
      {status === "ready" && data && (
        <p className="-mt-1 mb-3 font-mono text-[10.5px] text-ink-faint">
          {data.range.weeks} ISO weeks · {data.range.from} – {data.range.to} · weeks start Monday,
          {" "}
          {data.range.timezone}
        </p>
      )}

      <AsyncState
        status={status === "ready" && isEmpty ? "empty" : status}
        icon="chart"
        loadingText="Loading your activity…"
        errorTitle="Could not load your activity"
        errorDescription="The analytics request failed. Nothing is wrong with your work — try again in a moment."
        emptyTitle={`No activity in ${data ? `${data.range.from} – ${data.range.to}` : "this window"}`}
        emptyDescription={
          audience === "contributor"
            ? "Nothing submitted and no karma earned in this window. This is a real zero, not a gap in the data — widen the window if you were active earlier."
            : "No audit decisions in this window. This is a real zero, not a gap in the data — widen the window if you were active earlier."
        }
        emptyAction={
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="text-[12px] text-ink-soft underline underline-offset-2"
          >
            Reload
          </button>
        }
      >
        {data && (
          <div className="space-y-4">
            {audience === "contributor" ? (
              <>
                <ChartCard
                  title="Submissions by the week you sent them"
                  sub="Each column is one week's submissions, split by where those items stand today."
                  rows={data.contributor.submissions}
                  series={SUBMISSION_SERIES}
                  unit="items"
                />
                <ChartCard
                  title="Karma earned"
                  sub="Karma events, in the week each one was recorded."
                  rows={data.contributor.karma}
                  series={KARMA_SERIES}
                  unit="karma"
                />
              </>
            ) : (
              <>
                <ChartCard
                  title="Audit decisions"
                  sub="Items you decided, in the week you decided them."
                  rows={data.validator.audits}
                  series={AUDIT_SERIES}
                  unit="decisions"
                />
                <ChartCard
                  title="What happened to your flags"
                  sub="Flags you raised, in the week you raised them, by where each one stands today."
                  rows={data.validator.audits}
                  series={FLAG_SERIES}
                  unit="flags"
                />
              </>
            )}

            {notes.map((note) => (
              <SectionNote key={note.field}>{note.note}</SectionNote>
            ))}
          </div>
        )}
      </AsyncState>
    </div>
  );
}
