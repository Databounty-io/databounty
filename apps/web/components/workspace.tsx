"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { InfoTip } from "@/components/ui";
import { num, shadeHex } from "@/lib/format";
import type { KarmaTier, NextKarmaTier } from "@/lib/use-community-karma";

/* ---------------------------------------------------------------------------
 * Shared chrome for the role workspaces (/contributor, /validator).
 *
 * Both pages used to open with four stacked full-width cards — karma strip,
 * rank card, lifetime funnel, activity strip — roughly 530px of status before
 * the first thing a developer can act on. Each card was a two-column
 * `justify-between` row, so at desktop width most of that height was also
 * horizontally empty. The same numbers were repeated across cards (accepted
 * items in two places, karma in three), and `RankTrack`/`EarningCard` were
 * copy-pasted into each page and had already drifted apart (px-5 py-4 vs
 * px-6 py-5, one supporting a unit suffix and the other hardcoding "karma").
 *
 * These primitives collapse that into: one status bar (identity + rank
 * progress + account metrics) and hairline stat rails (one card, N segments)
 * instead of a card per number. Nothing was dropped — the rank ladder moved
 * behind the rank chip, which is where it belongs for something you read once.
 * ------------------------------------------------------------------------- */

/* ---------- Karma tier chip ---------- */

export function KarmaTierChip({ tier }: { tier: { label: string; color: string } }) {
  return (
    <span
      className="rounded-full px-2 py-[2px] font-mono text-[10.5px] font-medium leading-4"
      style={{ backgroundColor: `${tier.color}26`, color: shadeHex(tier.color, 0.55) }}
    >
      {tier.label}
    </span>
  );
}

/* ---------- Status bar ---------- */

export interface WorkspaceMetric {
  label: string;
  value: React.ReactNode;
  /** Optional hover/description text for a metric whose label is terse. */
  title?: string;
}

export interface WorkspaceKarma {
  total: number;
  tier: KarmaTier | null;
  nextTier: NextKarmaTier | null;
  /** Earned work that has not entered the released balance. This belongs in
   * the same account summary as `total`, not in a duplicate dashboard card. */
  secured?: { amount: number; label: string; title: string };
}

/**
 * One-card workspace header: role identity, rank standing, progress to the next
 * rank, the account's karma cluster, and a rail of secondary metrics.
 *
 * The progress column is deliberately `flex-1`: it is the element that absorbs
 * the horizontal slack at wide viewports, so the card stays a single dense row
 * instead of two labels marooned at opposite edges of 1200px.
 */
export function WorkspaceStatusBar({
  icon,
  rank,
  rankIndex,
  ranks,
  nextRank,
  progressLabel,
  progressValue,
  // progressMax intentionally not destructured: rank progress folded into the
  // plain-text metrics line below (no bar), so the fraction isn't needed here
  // — the prop stays in the type below since callers still pass it.
  metrics,
  karma,
}: {
  icon: IconName;
  rank: string;
  rankIndex: number;
  ranks: string[];
  nextRank: { name: string; itemsToGo: number } | null;
  /** What the progress bar counts, e.g. "accepted items". */
  progressLabel: string;
  progressValue: number;
  /** Total needed for the next rank. 0/undefined renders a full bar (top rank). */
  progressMax: number;
  metrics: WorkspaceMetric[];
  karma?: WorkspaceKarma | null;
}) {
  const [ladderOpen, setLadderOpen] = useState(false);
  // Karma is the reputation the account is building during the karma-only
  // launch (karma rails are dormant — karma is never currency or spendable),
  // so it now LEADS the card as the hero number — a new
  // user's eye should land on one big, obvious thing first, not a wall of
  // equal-weight rows they have to parse to figure out what matters. Rank and
  // the day-to-day operational metrics (capacity, streak, deadlines) all
  // collapse into one compact line underneath instead of their own rows.
  const karmaPct = karma?.nextTier && karma.nextTier.minKarma > 0
    ? Math.min(100, (karma.total / karma.nextTier.minKarma) * 100)
    : 100;

  return (
    <div className="card shadow-[0_1px_2px_rgba(20,23,15,0.04)]">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-4 sm:px-5">
        {karma ? (
          <>
            {/* Hero: karma, the account's reputation standing right now */}
            <div className="flex shrink-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#f3eefc] to-[#e9defa] text-karma ring-1 ring-inset ring-[#e2d6f7]">
                <Icon name="sparkles" size={19} />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-[27px] font-bold leading-none tracking-tight text-ink">
                    {num(karma.total)}
                  </span>
                  <span className="font-mono text-[11px] text-ink-faint">karma</span>
                  {karma.tier && <KarmaTierChip tier={karma.tier} />}
                </div>
                <div className="mt-1 flex items-center gap-1 font-mono text-[10.5px] text-ink-faint">
                  <Icon name={icon} size={10.5} />
                  <span className="truncate">{rank}</span>
                  <button
                    type="button"
                    onClick={() => setLadderOpen((open) => !open)}
                    aria-expanded={ladderOpen}
                    // 24px minimum touch target (WCAG 2.2 AA 2.5.8): this pill
                    // measured 74x18 on /validator. Height comes from a
                    // centred `before:` overlay rather than more `py-`, so the
                    // pill still LOOKS 18px tall and the row does not grow —
                    // owner's call (2026-09-02) was to enlarge the hit area
                    // only, leaving v1's visual design untouched.
                    className="relative inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-full px-1.5 py-[1px] text-ink-faint underline decoration-dotted transition-colors before:absolute before:inset-x-0 before:top-1/2 before:h-6 before:-translate-y-1/2 before:content-[''] hover:bg-panel hover:text-ink-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-1"
                  >
                    rank {rankIndex + 1}/{ranks.length}
                    <Icon name={ladderOpen ? "chevron-down" : "chevron-right"} size={10} />
                  </button>
                </div>
                {/* Only when there is something secured. This row used to
                    render for anyone whose page passed a `secured` object,
                    which every workspace does unconditionally — so a member
                    with nothing held read "secured from your work 0 karma"
                    with a tooltip explaining a hold they do not have. The
                    karma hub is the surface that teaches the three states at
                    zero (it keeps all three cells and says "Nothing is being
                    held for you right now"); this compact status strip should
                    not spend a line on an empty one. */}
                {karma.secured && karma.secured.amount > 0 && (
                  <div className="mt-1 flex items-center gap-1 font-mono text-[10.5px] text-karma">
                    <Icon name="award" size={10.5} />
                    <span>{karma.secured.label}</span>
                    <span className="font-bold text-ink">{num(karma.secured.amount)}</span>
                    <span>karma</span>
                    <InfoTip label={karma.secured.label} text={karma.secured.title} />
                  </div>
                )}
              </div>
            </div>

            {/* Karma progress to next tier — absorbs the horizontal slack */}
            <div className="min-w-[190px] flex-1">
              <div className="flex items-baseline justify-between gap-3 font-mono text-[10.5px] text-ink-soft">
                <span>{karma.nextTier ? `next tier · ${karma.nextTier.label}` : "top karma tier"}</span>
                {karma.nextTier && <span className="text-ink">{num(karma.nextTier.karmaToGo)} to go</span>}
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line-soft">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#a48cd9] to-karma transition-all"
                  style={{ width: `${karmaPct}%` }}
                />
              </div>
            </div>

            <Link
              href="/karma"
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#f7f4fd] px-3 py-1.5 font-mono text-[10.5px] font-medium text-karma ring-1 ring-inset ring-[#e2d6f7] transition-colors hover:bg-[#efe7fb]"
            >
              karma hub
              <Icon name="chevron-right" size={11} />
            </Link>
          </>
        ) : (
          <>
            {/* No karma data (fetch failed or account-level read disabled) —
                rank stays the lead so the card never renders empty. */}
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#f3eefc] to-[#e9defa] text-karma ring-1 ring-inset ring-[#e2d6f7]">
                <Icon name={icon} size={17} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[16px] font-bold leading-tight tracking-tight">{rank}</span>
                  <button
                    type="button"
                    onClick={() => setLadderOpen((open) => !open)}
                    aria-expanded={ladderOpen}
                    className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-accent-soft px-2 py-[2px] font-mono text-[10.5px] leading-4 text-accent-strong transition-colors hover:bg-[#e9f2d4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-1"
                  >
                    rank {rankIndex + 1} of {ranks.length}
                    <Icon name={ladderOpen ? "chevron-down" : "chevron-right"} size={11} />
                  </button>
                </div>
                <div className="mt-0.5 font-mono text-[10.5px] text-ink-faint">
                  {nextRank ? `next · ${nextRank.name}` : "top rank reached"}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {ladderOpen && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line-soft px-4 py-2.5 font-mono text-[10.5px] sm:px-5">
          {ranks.map((name, i) => (
            <span
              key={name}
              className={`inline-flex items-center gap-1 ${
                i === rankIndex ? "font-bold text-ink" : i < rankIndex ? "text-accent-strong" : "text-ink-faint"
              }`}
            >
              <span aria-hidden>{i === rankIndex ? "◉" : i < rankIndex ? "●" : "○"}</span>
              {name}
            </span>
          ))}
        </div>
      )}

      {/* Everything else — rank progress plus the operational metrics — as one
          dense, plain-text line. This used to be a whole second visual row
          (progress bar + label) above a separate metrics row; folded together
          it reads in one scan and leaves the karma hero as the only thing on
          the card that asks for a second look. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line-soft bg-panel/50 px-4 py-2.5 font-mono text-[10.5px] sm:px-5">
        <span className="inline-flex items-center gap-1">
          <span className="text-ink-soft">{progressLabel}</span>{" "}
          <span className="font-bold text-ink">
            {nextRank ? `${num(progressValue)} · ${num(nextRank.itemsToGo)} to go` : num(progressValue)}
          </span>
          <InfoTip label={progressLabel} text={`Total ${progressLabel} accepted toward your next rank.`} />
        </span>
        {metrics.map((metric) => (
          <span key={metric.label} className="inline-flex items-center gap-1">
            <span className="text-ink-soft">{metric.label}</span>{" "}
            <span className="font-bold text-ink">{metric.value}</span>
            {metric.title && <InfoTip label={metric.label} text={metric.title} />}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------- Stat rail ---------- */

export type StatTone = "neutral" | "accepted" | "action" | "review" | "karma";

/* Same palette as the .validation-stat-* rules in globals.css, applied to the
 * cell instead of a bordered tile — the rail's hairline gaps already separate
 * the segments, so a per-tile border would double the line weight. */
/* A flat white cell with a slim colour-coded top edge reads as a metrics
 * dashboard (Grafana/Vercel-style) rather than a grid of pastel candy tiles —
 * the tone still carries the semantic (accepted/rejected/etc.), just as an
 * accent instead of a full cell wash. */
const TONES: Record<StatTone, { accent: string; value: string; icon: string }> = {
  neutral: { accent: "transparent", value: "text-ink", icon: "text-ink-faint" },
  accepted: { accent: "#8fbb3a", value: "text-[#4f6f12]", icon: "text-[#7a9b3a]" },
  action: { accent: "#d1a13a", value: "text-[#8a6412]", icon: "text-[#b3902f]" },
  review: { accent: "#a9b39f", value: "text-[#53604c]", icon: "text-[#8b9483]" },
  karma: { accent: "#a48cd9", value: "text-karma", icon: "text-[#a48cd9]" },
};

export interface StatCell {
  label: string;
  value: React.ReactNode;
  /** Rendered small and grey after the value, e.g. "karma", "karma". */
  unit?: string;
  sub?: React.ReactNode;
  tone?: StatTone;
  title?: string;
  /** Optional glyph for quick scanning, e.g. "upload" for "submitted". */
  icon?: IconName;
  /** Drill-down for the items behind this number. Only the VALUE becomes a
   *  link, never the whole tile — see the hover-background note in `StatRail`:
   *  a tile-wide hit area on a rail where most cells are inert reads as
   *  "everything here is clickable", which is a lie. */
  href?: string;
  /** Accessible name for the drill-down link, e.g. "Show the rejected items".
   *  Required-in-spirit whenever `href` is set: the visible link text is just
   *  a number, which tells a screen-reader user nothing about the destination. */
  hrefLabel?: string;
}

/**
 * A row of related numbers as ONE card with hairline-separated segments, in
 * place of a grid of individual cards.
 *
 * CSS grid with equal-width columns, so every cell is the same width and lines
 * up in a clean matrix across rows — instead of a `flex-wrap` row where each
 * wrapped line grows its own cells independently, so a full row of three and a
 * short last row of one don't share column edges and the lone cell balloons to
 * span the whole card (the "clumsy" ragged last row this replaced).
 *
 * `auto-fill` (NOT `auto-fit`) is the key: it keeps unused trailing tracks in
 * the last row EMPTY rather than collapsing them, so a short final row's cells
 * keep their column width and sit left-aligned beside plain white space instead
 * of stretching across it. Separators are per-cell top/left hairlines with the
 * grid pulled -1px up/left so the outer edges tuck under the card's own border
 * (no doubled lines); trailing empty tracks carry no border and stay white, so
 * there's no grey blank block where a `gap-px`-on-tinted-background grid would
 * have shown one.
 *
 * Pass `groups` instead of `cells` to keep distinct sets on their OWN rows in
 * order (e.g. karma / submission funnel / overview), separated by a heavier
 * divider. A grouped section fills the full row width and distributes its cells
 * evenly (`flex-1`), because a group is a small, known set — three or four
 * cells stretched to equal thirds/quarters reads as balanced, not clumsy, and
 * leaves no blank trailing space the way a fixed-column grid does. A flat
 * `cells` rail keeps the fixed-column grid instead: it can hold an arbitrary
 * odd count (7, 13…) where a short final row would otherwise stretch a lone
 * cell across the whole card.
 */
export function StatRail({
  cells,
  groups,
  className = "",
}: {
  cells?: StatCell[];
  /** Cell sets kept on their own rows, in order, each separated by a divider. */
  groups?: StatCell[][];
  className?: string;
}) {
  const grouped = groups !== undefined;
  const sections = (groups ?? (cells ? [cells] : [])).filter((section) => section.length > 0);
  return (
    <div className={`card overflow-hidden ${className} shadow-[0_1px_2px_rgba(20,23,15,0.04)]`}>
      {sections.map((section, si) =>
        grouped ? (
          // Fill-width row: cells grow to share the row equally, hairlines from
          // the `gap-px` over a tinted background. Later groups get a heavier
          // top divider so the sections read as distinct rows.
          <div
            key={si}
            className={`flex flex-wrap gap-px bg-line-soft ${si > 0 ? "border-t border-line" : ""}`}
          >
            {section.map((cell) => (
              <StatCellView key={cell.label} cell={cell} className="min-w-[180px] flex-1 basis-[180px]" />
            ))}
          </div>
        ) : (
          // Fixed-column grid: equal columns, a short final row left-aligned
          // beside white space rather than stretching a lone cell. First
          // section tucks its outer hairline under the card border.
          <div
            key={si}
            className={`-ml-px grid [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))] ${
              si === 0 ? "-mt-px" : "border-t border-line"
            }`}
          >
            {section.map((cell) => (
              <StatCellView key={cell.label} cell={cell} className="border-l border-t border-line-soft" />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

/** One StatRail cell — the shared inner markup for both the grouped
 *  (fill-width flex) and flat (fixed-column grid) layouts. The wrapper's
 *  sizing/border classes come from `className`; everything inside is identical
 *  so a karma cell and a overview cell always render the same way. */
function StatCellView({ cell, className = "" }: { cell: StatCell; className?: string }) {
  const tone = TONES[cell.tone ?? "neutral"];
  return (
    <div
      // No hover background here on purpose: the cell itself isn't interactive
      // (only the info glyph inside is), so tinting the whole tile on hover
      // implied it was clickable when it wasn't.
      className={`group relative bg-white px-4 py-2.5 ${className}`}
      style={{ boxShadow: `inset 0 2px 0 0 ${tone.accent}` }}
    >
      {/* No reserved min-height: at the >=180px column width every label here
          fits on one line, so reserving room for a hypothetical second line
          just padded every cell with dead space. */}
      <div className="flex items-start gap-1.5">
        {cell.icon && <Icon name={cell.icon} size={11} className={`mt-px shrink-0 ${tone.icon}`} />}
        <div className="micro-label min-w-0 flex-1 leading-snug text-ink-soft">{cell.label}</div>
        {/* A dedicated info glyph, not a native `title` — it portals its bubble
            to `document.body` so the card's `overflow-hidden` (which keeps the
            rounded corners clean) can't clip a tooltip near the edge. */}
        {cell.title && <InfoTip text={cell.title} label={cell.label} />}
      </div>
      <div className={`mt-1 font-mono text-[21px] font-bold leading-none tracking-tight tabular-nums ${tone.value}`}>
        {cell.href ? (
          <Link
            href={cell.href}
            aria-label={cell.hrefLabel ?? `${cell.label}: ${String(cell.value)}`}
            className="underline decoration-line decoration-dotted decoration-2 underline-offset-4 hover:decoration-solid hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
          >
            {cell.value}
          </Link>
        ) : (
          cell.value
        )}
        {cell.unit && <span className="text-[11px] font-normal text-ink-faint"> {cell.unit}</span>}
      </div>
      {cell.sub && <div className="mt-1 font-mono text-[10px] text-ink-soft">{cell.sub}</div>}
    </div>
  );
}

/* ---------- First-run card ---------- */

export interface FirstRunStep {
  icon: IconName;
  title: string;
  body: React.ReactNode;
}

/**
 * What a workspace shows where its lifetime funnel goes, before there is any
 * lifetime to report.
 *
 * A funnel is a returning-user instrument: with nothing submitted (or audited)
 * it is four cells reading 0 in the most valuable slot on the page, above the
 * work itself. Both role workspaces hit that state on a first visit, so this
 * lives here rather than as a copy in each page — the same reason
 * `WorkspaceStatusBar` and `StatRail` do.
 *
 * Steps state MECHANISM only — how work is picked up, how it's checked, when
 * reward lands. Never an amount: per-item rates belong on the work card and in
 * the karma hub, and repeating one here creates a second source of truth that
 * drifts from the row the user is about to act on.
 */
export function WorkspaceFirstRun({
  sub,
  steps,
  ctaHref,
  ctaLabel,
  className = "",
}: {
  sub: string;
  steps: FirstRunStep[];
  ctaHref: string;
  /** Label the destination for what it actually covers, not what you wish it did. */
  ctaLabel: string;
  className?: string;
}) {
  return (
    <div className={`card p-4 shadow-[0_1px_2px_rgba(20,23,15,0.04)] sm:p-5 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="font-mono text-[13px] font-bold tracking-tight">Start here</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-soft">{sub}</p>
        </div>
        <Link
          href={ctaHref}
          className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-white px-3 font-mono text-[11px] text-ink-soft transition-colors hover:border-ink hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
        >
          {ctaLabel}
          <Icon name="arrow-right" size={13} />
        </Link>
      </div>
      <ol className="mt-4 grid gap-3 sm:grid-cols-3">
        {steps.map((step, i) => (
          <li key={step.title} className="rounded-lg border border-line-soft bg-panel/50 p-3">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white text-ink-soft ring-1 ring-inset ring-line">
                <Icon name={step.icon} size={12} />
              </span>
              <span className="font-mono text-[11px] font-bold text-ink">
                <span className="text-ink-faint">{i + 1}.</span> {step.title}
              </span>
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------- Section note ---------- */

/**
 * A standing rule that belongs to the section below it (claim limits, how
 * karma works). These were full-width tinted banners styled like alerts, which reads
 * as "something needs your attention" for text that never changes. Same words,
 * quiet treatment, attached to the section it governs.
 */
export function SectionNote({
  icon = "info",
  children,
  className = "",
}: {
  icon?: IconName;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border border-line-soft bg-panel/60 px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-soft ${className}`}
    >
      <Icon name={icon} size={13} className="mt-[3px] shrink-0 text-ink-faint" />
      <div>{children}</div>
    </div>
  );
}

/* ---------- Filter bar ---------- */

/**
 * One-row filter chrome: search grows, selects sit at a fixed width, the result
 * count and reset anchor right. The two pages each hand-rolled a two-row
 * version of this (search row, then a full-width 3-column select grid), which
 * spent ~110px of vertical space on controls that fit on one line at desktop.
 */
export function FilterBar({
  children,
  meta,
  onClear,
  className = "",
}: {
  children: React.ReactNode;
  meta?: React.ReactNode;
  /** Omit to hide the reset control (nothing is filtered). */
  onClear?: () => void;
  className?: string;
}) {
  return (
    <div className={`mb-3 flex flex-wrap items-center gap-2 ${className}`}>
      {children}
      {/* Own right-aligned row on mobile: inline, the count reads like a label
          for whichever control it happens to land beside. */}
      <div className="flex basis-full items-center justify-end gap-2 sm:ml-auto sm:basis-auto">
        {meta && <span className="shrink-0 font-mono text-[10.5px] text-ink-soft">{meta}</span>}
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 font-mono text-[10.5px] text-ink-soft transition-colors hover:border-ink hover:text-ink"
          >
            <Icon name="x" size={11} />
            clear
          </button>
        )}
      </div>
    </div>
  );
}
