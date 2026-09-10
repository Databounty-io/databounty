// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import type { Bounty, DatasetCategory } from "@/lib/types";
import { num } from "@/lib/format";

/* ---------- terminal-style label helpers ---------- */

const CATEGORY_SNAKE: Record<DatasetCategory, string> = {
  debugging: "debugging",
  implementation: "function/feature",
  test_generation: "test_generation",
  error_diagnosis: "error_diagnosis",
  migration: "migration",
};

/* ---------- community accents ---------- */

const COMMUNITY_BORDER = "border-violet-400/35! hover:border-violet-400/60!";

function CommunityChip() {
  return (
    <span className="shrink-0 whitespace-nowrap rounded-[4px] border border-violet-400/40 bg-violet-400/10 px-1.5 py-px text-violet-300">
      community pool
    </span>
  );
}

/** A pool at or past its target takes no more contributions even though its
 * status stays "active" while the remaining items are audited. Saying "open"
 * there invited a contribution the server would reject. */
export function isPoolFull(pool: Bounty): boolean {
  if (pool.poolClosedAt) return true;
  const reserved = pool.communityProgress?.capacityReserved ?? pool.clearedItems ?? pool.acceptedItems;
  return pool.targetItems > 0 && reserved >= pool.targetItems;
}

function CommunityOpenState({ full }: { full: boolean }) {
  if (full) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-dark-dim" title="Target reached — no longer accepting contributions">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-dark-dim" />
        full
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-emerald-400" title="Accepting contributions">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_7px_rgba(52,211,153,0.8)]" />
      open
    </span>
  );
}

function karmaValue(pool: Bounty): string {
  return pool.karmaPerItem ? num(pool.karmaPerItem) : "0";
}

function communityTypeLabel(pool: Bounty): string {
  return [pool.language, pool.framework].filter(Boolean).join(" · ") || "community dataset";
}

/** ISO timestamp -> YYYY-MM-DD. The row is omitted entirely when the API sent
 * no date, rather than printing an empty value next to its label. */
function deliveredDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10);
}

/** Submitted count for a pool, or "—" when the API returned no rollup for it.
 * A missing count and a genuine zero must never render the same. */
function submittedLabel(pool: Bounty): string {
  const submitted = pool.communityProgress?.totalSubmitted;
  return typeof submitted === "number" ? num(submitted) : "—";
}

/** Every item that did not clear verification: validator-flagged,
 * validator-rejected, or failed an automated check (dedup/contamination/
 * execution/schema). This is what separates submitted_items from
 * accepted_items — without it the gap between the two numbers looked
 * unexplained. Absent (not zero) when the API returned no rollup at all,
 * same honesty rule as submittedLabel above. */
function rejectedLabel(pool: Bounty): string {
  const progress = pool.communityProgress;
  if (!progress) return "—";
  const total = (progress.rejected ?? 0) + (progress.flagged ?? 0) + (progress.failedAutomatedChecks ?? 0);
  return num(total);
}

/** Items sitting with a human validator right now. 0 when the pool has none;
 * undefined when the API returned no rollup at all. */
export function validatorReviewCount(pool: Bounty): number | undefined {
  return pool.communityProgress?.validatorReview;
}

/* ---------- PoolCard ---------- */

export function PoolCard({ pool }: { pool: Bounty }) {
  const progressItems =
    pool.communityProgress?.capacityReserved ?? pool.clearedItems ?? pool.acceptedItems;
  const pctVal =
    pool.targetItems === 0
      ? 0
      : progressItems >= pool.targetItems
        ? 100
        : Math.min(99, Math.round((progressItems / pool.targetItems) * 100));

  return (
    <Link
      href={`/pools/${pool.id}`}
      className={`card-dark flex flex-col p-5 ${COMMUNITY_BORDER}`}
    >
      <div className="mb-3.5 flex items-start justify-between gap-3 font-mono text-[10px]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-dark-soft">
          <span className="min-w-0">{communityTypeLabel(pool)}</span>
          <CommunityChip />
        </div>
        <CommunityOpenState full={isPoolFull(pool)} />
      </div>

      <div className="mb-3.5 break-words font-mono text-[15px] font-medium text-dark-text">
        {pool.title}
      </div>

      <div className="mb-3.5 flex items-baseline gap-2">
        <span className="font-mono text-[22px] font-bold text-violet-300">
          {karmaValue(pool)}
        </span>
        <span className="font-mono text-[11px] text-dark-dim">karma/item</span>
      </div>

      <div className="mb-[7px] flex justify-between font-mono text-[11px] text-dark-muted">
        <span>
          {num(progressItems)} / {num(pool.targetItems)} capacity reserved
        </span>
        <span>{pctVal}%</span>
      </div>
      <div className="h-[5px] overflow-hidden rounded-[3px] bg-dark-track">
        <div
          className="h-full bg-lime"
          style={{ width: `${Math.min(100, pctVal)}%` }}
        />
      </div>

      <div className="mt-2 font-mono text-[10px] text-dark-dim">
        <span title="Only human-validator-approved items count toward publishing and karma.">
          final accepted: {num(pool.communityProgress?.finalAccepted ?? pool.acceptedItems)}
        </span>
        {pool.communityProgress?.validatorReview ? (
          <span className="ml-2" title="These items reserve a contribution place while a human validator decides.">
            · {num(pool.communityProgress.validatorReview)} in review
          </span>
        ) : null}
      </div>

      <div className="mt-3.5 flex items-center justify-between border-t border-dashed border-dark-line pt-3 font-mono text-[10px] text-dark-dim">
        {pool.status === "completed" && pool.hfSlug ? (
          <span className="truncate" title={pool.hfSlug}>hf: {pool.hfSlug}</span>
        ) : (
          <>
            <span>{pool.openLicense?.toLowerCase() ?? "open"}</span>
            {pool.deadline ? <span>{pool.deadline}</span> : null}
          </>
        )}
        <span className="shrink-0 text-lime">view →</span>
      </div>
    </Link>
  );
}

/* ---------- DeliveredCard ---------- */

export function DeliveredCard({ pool }: { pool: Bounty }) {
  const partial = pool.status === "partially_completed";
  return (
    <Link
      href={`/pools/${pool.id}`}
      className={`card-dark flex flex-col p-5 ${COMMUNITY_BORDER}`}
    >
      {/* Same header pattern as PoolCard and ValidationCard above. This card
          inherited V1's markup, where the label and the chip were siblings
          inside one inline <span> with nothing between them: it rendered
          "function/featurecommunity pool" with no separator, and because the
          chip was an inline box it split its own border across two lines
          whenever it wrapped — a boxed "community" on one line and a boxed
          "pool" on the next. Invisible in V1, where the chip only appeared on
          community rows and other bounty kinds dominated the grid; unmissable here,
          where every row is a community pool and the default three-column card
          is 296px wide. */}
      <div className="mb-3.5 flex items-start justify-between gap-3 font-mono text-[10px]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-dark-soft">
          <span className="min-w-0">{CATEGORY_SNAKE[pool.category]}</span>
          <CommunityChip />
        </div>
        <span className={`shrink-0 whitespace-nowrap ${partial ? "text-violet-400" : "text-lime"}`}>
          {partial ? "◐ partial" : "● delivered"}
        </span>
      </div>

      <div className="mb-4 break-words font-mono text-[15px] font-medium text-dark-text">
        {pool.title}
      </div>

      <div className="flex flex-col gap-[9px] font-mono text-xs text-dark-text">
        <div className="flex justify-between">
          <span className="text-dark-dim">submitted_items</span>
          {/* Real count from the pool's submission rollup. When the API did not
              return one it is absent, not zero — say so rather than print a
              number the stored evidence does not back. */}
          <span title="Every item contributors submitted to this pool, before verification.">
            {submittedLabel(pool)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-dark-dim">accepted_items</span>
          <span>{num(pool.acceptedItems)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-dark-dim">rejected_items</span>
          <span title="Flagged, rejected, or failed an automated check (dedup, contamination, execution, or schema).">
            {rejectedLabel(pool)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-dark-dim">karma_per_item</span>
          <span className="text-violet-300">{karmaValue(pool)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-dark-dim">hf_dataset</span>
          {/* `truncate` is V1's; the title is not. A slug long enough to be cut
              ("databounty/full-pipeli…") was otherwise unreadable — the card is
              one big <Link>, so there is nothing to click to reveal the rest. */}
          <span className="truncate" title={pool.hfSlug ?? undefined}>
            {pool.hfSlug ?? "pending"}
          </span>
        </div>
        {/* Generic: any confirmed publication target beyond Hugging Face
            (github, aikosh, whatever comes next) gets a row with zero new
            code here — same reasoning as publicPublicationsOf() on the API
            side. Plain text, not its own <a>: the card is one big <Link> to
            the pool detail page, so the real clickable link lives there. */}
        {pool.publications?.map((p) => (
          <div key={p.target} className="flex justify-between gap-3">
            <span className="text-dark-dim">{p.target}</span>
            <span className="truncate text-dark-text" title={p.url}>
              published
            </span>
          </div>
        ))}
        <div className="flex justify-between">
          <span className="text-dark-dim">license</span>
          <span>{pool.openLicense ?? "open"}</span>
        </div>
        {pool.deliveredAt && (
          <div className="flex justify-between">
            <span className="text-dark-dim" title="When this corpus was last successfully published to its target.">published</span>
            <span>{deliveredDate(pool.deliveredAt)}</span>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-dashed border-dark-line pt-3.5 font-mono text-[11px]">
        <span className="text-dark-dim">sponsor: {pool.requesterNickname}</span>
        <span className="text-lime">public_sample →</span>
      </div>
    </Link>
  );
}

/* ---------- ValidationCard ---------- */

/**
 * A pool that has items waiting on a human validator. Same pool, different
 * job: this card leads with the audit queue depth and the validator karma
 * rate, where PoolCard leads with contribution capacity and the contributor
 * rate. Only rendered for pools whose rollup reports validatorReview > 0, so
 * the queue depth shown is always a real stored count.
 */
export function ValidationCard({ pool }: { pool: Bounty }) {
  const inReview = validatorReviewCount(pool) ?? 0;
  const perItem = pool.karmaPerAuditedItem;

  return (
    <Link
      href={`/pools/${pool.id}`}
      className="card-dark flex flex-col border-sky-400/35! p-5 hover:border-sky-400/60!"
    >
      <div className="mb-3.5 flex items-start justify-between gap-3 font-mono text-[10px]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-dark-soft">
          <span className="min-w-0">{communityTypeLabel(pool)}</span>
          <span className="rounded-[4px] border border-sky-400/40 bg-sky-400/10 px-1.5 py-px text-sky-300">
            needs validation
          </span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sky-300" title="Items waiting on a human validator">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-sky-400 shadow-[0_0_7px_rgba(56,189,248,0.8)]" />
          queue
        </span>
      </div>

      <div className="mb-3.5 break-words font-mono text-[15px] font-medium text-dark-text">
        {pool.title}
      </div>

      <div className="mb-3.5 flex items-baseline gap-2">
        <span className="font-mono text-[22px] font-bold text-sky-300">{num(inReview)}</span>
        <span className="font-mono text-[11px] text-dark-dim">
          {inReview === 1 ? "item awaiting audit" : "items awaiting audit"}
        </span>
      </div>

      <div className="flex flex-col gap-[7px] font-mono text-[11px] text-dark-muted">
        <div className="flex justify-between">
          <span className="text-dark-dim">karma_per_audited_item</span>
          <span className="text-sky-300">{typeof perItem === "number" ? num(perItem) : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-dark-dim">audit_coverage</span>
          <span>{typeof pool.auditCoveragePct === "number" ? `${pool.auditCoveragePct}%` : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-dark-dim">submitted_total</span>
          <span>{submittedLabel(pool)}</span>
        </div>
      </div>

      <div className="mt-3.5 flex items-center justify-between border-t border-dashed border-dark-line pt-3 font-mono text-[10px] text-dark-dim">
        <span>{pool.openLicense?.toLowerCase() ?? "open"}</span>
        <span className="shrink-0 text-lime">validate →</span>
      </div>
    </Link>
  );
}
