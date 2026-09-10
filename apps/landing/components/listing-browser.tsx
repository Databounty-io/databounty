"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { num } from "@/lib/format";
import type { Bounty } from "@/lib/types";
import type { PoolsPage } from "@/lib/public-data";
import { EmptyState } from "@/components/empty-state";

/** A dropdown filter backed by one URL param. */
export type ListingSelect = {
  id: string;
  /** Accessible label. Rendered visually hidden. */
  label: string;
  /** URL param this control owns. */
  param: string;
  /** Current value from the URL (may be absent from `options`). */
  value: string;
  allLabel: string;
  options: { value: string; label: string }[];
  /** Compare values case-insensitively — used for `language`, whose API filter
   * is itself case-insensitive, so ?language=typescript must select the
   * canonical "TypeScript" option rather than falling back to "all". */
  caseInsensitive?: boolean;
};

/** A row of pill filters backed by one URL param, with an "all" pill. */
export type ListingChips = {
  param: string;
  value: string | "all";
  allLabel: string;
  options: { value: string; label: string }[];
};

const SELECT_CLASS =
  "h-11 sm:h-9 min-w-[150px] rounded-lg border border-dark-line bg-dark-card px-3 font-mono text-xs " +
  "text-dark-text focus:border-lime focus:outline-none";

/**
 * The shared search + filter + pagination browser behind /pools, /delivered
 * and /validation.
 *
 * It exists as one component because all three pages must behave identically
 * and every behaviour here was a bug found in QA on the first copy:
 * every filter lives in the URL and is applied server-side; changing any
 * filter resets to page 1; a filter value missing from its option list is
 * still shown in the control rather than silently reading "all"; the pager
 * ends are inert controls, not dead links; an unknown total renders as "—"
 * rather than a fabricated 0; and result changes are announced to assistive
 * tech, which a soft navigation otherwise does not do.
 */
export function ListingBrowser({
  basePath,
  heading,
  countSuffix,
  noun,
  lead,
  result,
  q,
  searchPlaceholder,
  searchLabel,
  chips,
  selects = [],
  renderCard,
  headerAside,
  beforeResults,
  empty,
  noResults,
}: {
  basePath: string;
  heading: string;
  /** Word after the count in the header chip, e.g. "open", "delivered". */
  countSuffix: string;
  noun: { one: string; many: string };
  lead: ReactNode;
  result: PoolsPage;
  q: string;
  searchPlaceholder: string;
  searchLabel: string;
  chips?: ListingChips;
  selects?: ListingSelect[];
  renderCard: (bounty: Bounty) => ReactNode;
  headerAside?: ReactNode;
  beforeResults?: ReactNode;
  empty: { title: string; description: string; action?: { label: string; href: string; external?: boolean } };
  noResults: { title: string; description: string };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { bounties, total, page, pageCount, pageSize, loadError, invalidQuery, rateLimited } = result;

  // total is null when the request failed: the count is UNKNOWN, not zero.
  const countLabel = total === null ? "—" : num(total);
  const anyFilter =
    Boolean(q) || selects.some((s) => s.value) || (chips ? chips.value !== "all" : false);

  /** A URL with some params changed. Any change other than `page` itself
   * resets paging — staying on page 7 of a now 2-page result shows nothing. */
  function urlWith(changes: Record<string, string | undefined>): string {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!("page" in changes)) next.delete("page");
    const qs = next.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  function apply(changes: Record<string, string | undefined>) {
    router.push(urlWith(changes), { scroll: false });
  }

  const from = !total ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total ?? 0);

  return (
    <div className="bg-dark text-dark-text">
      <div className="mx-auto max-w-[1200px] px-4 pb-[72px] pt-14 sm:px-8">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3.5">
          <div className="flex items-baseline gap-3.5">
            <h1 className="font-display text-[34px] font-bold leading-[normal] tracking-[-.03em] sm:text-[40px]">
              {heading}
            </h1>
            <span className="font-mono text-sm text-lime">
              {countLabel} {countSuffix}
            </span>
          </div>
          {headerAside}
        </div>
        <p className="mb-7 text-[15px] text-dark-muted">{lead}</p>

        <form
          role="search"
          className="mb-4 flex flex-wrap items-center gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get("q");
            apply({ q: (typeof value === "string" ? value.trim() : "") || undefined });
          }}
        >
          <label className="sr-only" htmlFor={`${basePath}-search`}>
            {searchLabel}
          </label>
          {/* Uncontrolled and keyed on the URL term: the URL is the source of
              truth, so back/forward or a cleared filter remounts the box with
              the right value instead of leaving stale text in it. maxLength
              matches the API's cap so an over-long term can't be submitted. */}
          <input
            key={q}
            id={`${basePath}-search`}
            name="q"
            type="search"
            defaultValue={q}
            maxLength={120}
            placeholder={searchPlaceholder}
            className="h-11 min-w-[220px] flex-1 rounded-lg border border-dark-line bg-dark-card px-3 font-mono text-xs text-dark-text placeholder:text-dark-dim focus:border-lime focus:outline-none sm:h-9"
          />

          {selects.map((select) => {
            // A value the option list does not contain must still be VISIBLE
            // in its control, or the reader is told no filter is set while one
            // is narrowing their results and being carried forward by every
            // later change.
            const match = select.options.find((o) =>
              select.caseInsensitive ? o.value.toLowerCase() === select.value.toLowerCase() : o.value === select.value
            );
            const options =
              select.value && !match ? [...select.options, { value: select.value, label: select.value }] : select.options;
            return (
              <span key={select.id} className="contents">
                <label className="sr-only" htmlFor={select.id}>
                  {select.label}
                </label>
                <select
                  id={select.id}
                  className={SELECT_CLASS}
                  value={match ? match.value : select.value}
                  onChange={(e) => apply({ [select.param]: e.target.value || undefined })}
                >
                  <option value="">{select.allLabel}</option>
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </span>
            );
          })}

          <button
            type="submit"
            className="h-11 rounded-lg border border-lime bg-lime px-4 font-mono text-xs font-medium text-dark hover:bg-lime-bright sm:h-9"
          >
            search
          </button>
          {anyFilter && (
            <Link
              href={basePath}
              className="h-11 rounded-lg border border-dark-line px-4 font-mono text-xs leading-[2.75rem] text-dark-muted hover:border-dark-hover hover:text-dark-text sm:h-9 sm:leading-9"
            >
              clear_all
            </Link>
          )}
        </form>

        {/* Soft navigation swaps the grid without moving focus or changing the
            title, so a screen-reader user gets no signal that anything
            happened. This announces the outcome of every filter change. */}
        <p role="status" aria-live="polite" className="sr-only">
          {loadError
            ? "Results could not be loaded."
            : total === 0
              ? noResults.title
              : `${countLabel} ${countSuffix}, showing page ${page} of ${pageCount}.`}
        </p>

        {chips && (
          <div className="mb-7 flex flex-wrap gap-[9px] font-mono text-xs">
            {[{ value: "all", label: chips.allLabel }, ...chips.options].map((chip) => {
              const active = chips.value === chip.value;
              return (
                <Link
                  key={chip.value}
                  href={urlWith({ [chips.param]: chip.value === "all" ? undefined : chip.value })}
                  scroll={false}
                  className={`rounded-full border px-3.5 py-[7px] transition-colors ${
                    active
                      ? "border-lime bg-lime text-dark"
                      : "border-dark-line bg-transparent text-dark-muted hover:border-dark-hover hover:text-dark-text"
                  }`}
                >
                  {chip.label}
                </Link>
              );
            })}
          </div>
        )}

        {beforeResults}

        {loadError && rateLimited ? (
          // A 429 is neither bad input nor an outage. It used to fall into the
          // invalid-query branch below, which told the reader their search term
          // or a filter value "wasn't accepted" and offered clear_all as the
          // fix — both false, and clearing the filters does not help.
          <EmptyState
            variant="error"
            title="Too many requests just now."
            description="The catalog service is rate-limiting this browser. Your search and filters are fine — wait a moment and try again."
          />
        ) : loadError && invalidQuery ? (
          <EmptyState
            variant="no-results"
            title="That search couldn't be run."
            description="The search term or a filter value wasn't accepted. Try a shorter term, or clear the filters and start again."
            action={{ label: "clear_all", href: basePath }}
          />
        ) : loadError ? (
          <EmptyState
            variant="error"
            title={`Could not load ${noun.many} right now.`}
            description="The catalog service didn't respond. Try refreshing in a moment."
          />
        ) : bounties.length === 0 && anyFilter ? (
          <EmptyState
            variant="no-results"
            title={noResults.title}
            description={noResults.description}
            action={{ label: "clear_all", href: basePath }}
          />
        ) : bounties.length === 0 ? (
          <EmptyState variant="empty" title={empty.title} description={empty.description} action={empty.action} />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{bounties.map(renderCard)}</div>

            <nav
              aria-label="Pagination"
              className="mt-8 flex flex-wrap items-center justify-between gap-3 font-mono text-xs"
            >
              <span className="text-dark-dim" data-testid="pool-range">
                showing {num(from)}–{num(to)} of {countLabel}
              </span>
              <div className="flex items-center gap-2">
                <PagerLink href={urlWith({ page: String(page - 1) })} disabled={page <= 1} label="← prev" />
                <span className="px-1 text-dark-muted" data-testid="pool-page">
                  page {num(page)} / {num(pageCount)}
                </span>
                <PagerLink href={urlWith({ page: String(page + 1) })} disabled={page >= pageCount} label="next →" />
              </div>
            </nav>
          </>
        )}
      </div>
    </div>
  );
}

/** A pager control that is a real link when usable and an inert, correctly
 * labelled disabled control at either end — never a link that goes nowhere. */
function PagerLink({ href, disabled, label }: { href: string; disabled: boolean; label: string }) {
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className="cursor-not-allowed rounded-lg border border-dark-line px-3 py-[7px] text-dark-dim opacity-50"
      >
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      scroll={false}
      className="rounded-lg border border-dark-line px-3 py-[7px] text-dark-muted hover:border-dark-hover hover:text-dark-text"
    >
      {label}
    </Link>
  );
}
