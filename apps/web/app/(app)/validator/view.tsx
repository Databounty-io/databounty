"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Icon } from "@/components/icons";
import {
  AsyncState,
  Button,
  PageHeader,
  Select,
  Pill,
  PillTabs,
  Pagination,
  EmptyPitch,
  SearchField,
} from "@/components/ui";
import {
  WorkspaceStatusBar,
  WorkspaceFirstRun,
  StatRail,
  FilterBar,
  SectionNote,
  type FirstRunStep,
  type StatCell,
} from "@/components/workspace";
import { PublicationStatus } from "@/components/publication-status";
import { LANDING_URL } from "@/lib/urls";
import { useDemo } from "@/lib/store";
import { useCommunityKarma } from "@/lib/use-community-karma";
import { useDebouncedValue, useLatestRequest } from "@/lib/use-list-search";
import { num, deadlineLabel, VALIDATOR_RANKS } from "@/lib/format";
import {
  getMyAuditsPage,
  auditRowPublication,
  type AuditBatchRow,
} from "@/lib/api-work";
import { securedReleaseText } from "@/lib/karma-state";
import { DOMAINS } from "@/lib/dataset-types";

// Rank ladder comes from lib/format's VALIDATOR_RANKS (the API's
// VALIDATOR_RANK_TIERS in order) — the same list /profile draws. A local copy
// here used names the API never sends ("Specialist", "Lead Auditor"), so
// `indexOf` fell through to 0 and every validator sat at the bottom rung.

// Categories and languages for the audit-queue filter bar come from the
// shared taxonomy (GET /v1/meta/taxonomy via `hydrateTaxonomy`/`taxonomy` on
// useDemo()), the same live catalog `components/auth.tsx` uses for its
// domain/dataset-type/language pickers — never a hardcoded list, so a new
// category or language showing up in the real catalog doesn't require a
// frontend deploy to become filterable here.

const AUDIT_HISTORY_PAGE_SIZE = 10;
// GET /v1/me/audits caps a page at 200 (services/audits.ts listMyAuditWindows),
// while the largest rank cap is 15 concurrent audits (VALIDATOR_RANK_TIERS).
// The endpoint orders unsettled claims first (`settledAt asc, claimedAt
// desc`), so one unfiltered page always contains every active row.
const OWNED_AUDITS_SNAPSHOT_LIMIT = 200;

// The three statuses GET /v1/me/audits derives (no stored column): `claimed`
// (held, deadline not passed), `overdue_review` (held, deadline passed — still
// the validator's to finish) and `completed` (settled). Filter values map to
// `myAuditWindowStatusWhere` on the server, which accepts these keys.
type AuditHistoryFilter = "all" | "in_progress" | "overdue" | "completed";

const AUDIT_HISTORY_STATUSES: Record<AuditHistoryFilter, string | undefined> = {
  all: undefined,
  in_progress: "claimed",
  overdue: "overdue_review",
  completed: "completed",
};

const ACTIVE_AUDIT_STATUSES = new Set<string>(["claimed", "overdue_review"]);

function validatorFirstRunSteps(): FirstRunStep[] {
  return [
    {
      icon: "database",
      title: "Claim an audit batch",
      body: "Claim any open batch below. That reserves it to you against a deadline — nobody else can review it while you hold it. (The one exception: you can never claim a batch containing an item you submitted yourself as a contributor.)",
    },
    {
      icon: "eye",
      title: "Judge each item against the spec",
      body: "Every item shows the sponsor's contract, the machine evidence already gathered, and the rubric. Approve it, or flag it with a reason.",
    },
    {
      icon: "check",
      title: "Complete the batch to earn karma",
      body: "Finishing every item earns the batch's karma. A flag the platform upholds earns more; one it dismisses costs reputation, so flag what you can evidence.",
    },
  ];
}

export default function ValidatorWorkspaceView() {
  const {
    profileSummary,
    roleDashboardLoading,
    roleDashboardError,
    refreshRoleDashboard,
    availableAudits,
    availableAuditsTotal,
    availableAuditsConflictExcluded,
    availableAuditsConflictExcludedByReason,
    loadMoreAvailableAudits,
    loadingMoreAudits,
    auditFilters,
    setAuditFilters,
    workSummary,
    canParticipate,
    claimAudit,
    taxonomy,
  } = useDemo();

  const karma = useCommunityKarma();
  const validator = profileSummary.ranks.validator;
  const rankIndex = Math.max(0, VALIDATOR_RANKS.indexOf(validator.rank));

  const [historyFilter, setHistoryFilter] = useState<AuditHistoryFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  // Typing is not a query. The box updates on every keystroke; the request
  // waits for the reader to stop, and the sequence guard below keeps a slow
  // early response from repainting the list after a newer one.
  const debouncedHistorySearch = useDebouncedValue(historySearch);
  const beginHistoryRequest = useLatestRequest();
  const beginOwnedRequest = useLatestRequest();
  const [historyAudits, setHistoryAudits] = useState<AuditBatchRow[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [, startHistoryTransition] = useTransition();
  const [ownedAudits, setOwnedAudits] = useState<AuditBatchRow[]>([]);
  const [ownedAuditsLoading, setOwnedAuditsLoading] = useState(true);
  const [ownedAuditsError, setOwnedAuditsError] = useState<string | null>(null);
  // Which audit is mid-claim — guards against a double-click firing two POSTs
  // and drives the per-card "claiming…" disabled state below.
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const fetchHistory = useCallback(
    async (page: number, filter: AuditHistoryFilter, query: string) => {
      const isStale = beginHistoryRequest();
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const res = await getMyAuditsPage({
          status: AUDIT_HISTORY_STATUSES[filter],
          q: query.trim() || undefined,
          limit: AUDIT_HISTORY_PAGE_SIZE,
          skip: (page - 1) * AUDIT_HISTORY_PAGE_SIZE,
        });
        if (isStale()) return;
        setHistoryAudits(res.audits);
        setHistoryTotal(res.total);
      } catch (err) {
        // A superseded request's failure must not surface as an error over a
        // newer request's good result.
        if (isStale()) return;
        setHistoryError(err instanceof Error ? err.message : "Failed to load audit history.");
      } finally {
        if (!isStale()) setHistoryLoading(false);
      }
    },
    [beginHistoryRequest]
  );

  const fetchOwnedAudits = useCallback(async () => {
    const isStale = beginOwnedRequest();
    setOwnedAuditsLoading(true);
    setOwnedAuditsError(null);
    try {
      const res = await getMyAuditsPage({
        limit: OWNED_AUDITS_SNAPSHOT_LIMIT,
        skip: 0,
      });
      if (isStale()) return;
      setOwnedAudits(res.audits);
    } catch (err) {
      if (isStale()) return;
      setOwnedAuditsError(
        err instanceof Error ? err.message : "Failed to load your active audits."
      );
    } finally {
      if (!isStale()) setOwnedAuditsLoading(false);
    }
  }, [beginOwnedRequest]);

  useEffect(() => {
    void refreshRoleDashboard("validator");
  }, [refreshRoleDashboard]);

  // Claim happens HERE, on the list, before any navigation — the detail page
  // (`/validator/audit/[id]`) 409s on GET for a window nobody holds yet, so
  // clicking straight through to it without claiming first is a dead end.
  // On success the claimed audit disappears from `availableAudits` (the store
  // does that) and we refresh the history page so it shows up under "Active
  // Audits" with its own "Start audit" link — which is now safe to follow.
  // On failure (already claimed by someone else, at capacity, network error)
  // the store's `claimAudit` raises the same error toast this page already
  // uses elsewhere, and we simply stay put.
  const handleClaim = useCallback(
    async (auditId: string) => {
      if (claimingId) return;
      setClaimingId(auditId);
      try {
        const ok = await claimAudit(auditId);
        if (ok) {
          void Promise.all([
            fetchOwnedAudits(),
            fetchHistory(historyPage, historyFilter, debouncedHistorySearch),
          ]);
        }
      } finally {
        setClaimingId(null);
      }
    },
    [claimingId, claimAudit, fetchOwnedAudits, fetchHistory, historyPage, historyFilter, debouncedHistorySearch]
  );

  useEffect(() => {
    startHistoryTransition(() => {
      void fetchOwnedAudits();
    });
  }, [fetchOwnedAudits, startHistoryTransition]);

  useEffect(() => {
    startHistoryTransition(() => {
      void fetchHistory(historyPage, historyFilter, debouncedHistorySearch);
    });
  }, [historyPage, historyFilter, debouncedHistorySearch, fetchHistory]);

  // Active cards come from an independent UNFILTERED ownership snapshot
  // (GET /v1/me/audits, no status/q, first page). The history section below is
  // filtered and paginated, so deriving ownership from `historyAudits` made a
  // claim disappear when a validator selected Completed, searched, or moved to
  // another page. `overdue_review` still belongs to the validator and remains
  // actionable. Not read from the store's dashboard payload either: that
  // endpoint's `audits` is an intentionally empty array (routes/v1/me.ts).
  const activeAudits = ownedAudits.filter((audit) => ACTIVE_AUDIT_STATUSES.has(audit.status));
  const completedAudits = ownedAudits.filter((audit) => audit.status === "completed");
  // Held-audit count for the claim guard. Server-owned aggregates first:
  // `workSummary.validator` (getMyAuditWorkSummary) counts over the validator's
  // whole history and is untouched by either request's filters or paging.
  // If the dashboard failed, fall back to the unfiltered ownership snapshot;
  // if THAT failed too the count is unknown, and claiming is disabled rather
  // than enabled on a fabricated 0.
  const ownedSnapshotReady = !ownedAuditsLoading && !ownedAuditsError;
  const capacityKnown = workSummary != null || ownedSnapshotReady;
  const claimedAuditCount = workSummary
    ? Math.max(0, workSummary.validator.claimedBatches - workSummary.validator.completedBatches)
    : ownedSnapshotReady
      ? activeAudits.length
      : 0;
  // Mirrors the rank-scaled cap the claim endpoint enforces transactionally
  // (POST /v1/audits/:id/claim → services/audits.ts claimAuditWindow, which
  // 409s with `capacity` under a per-validator advisory lock). The client gate
  // only avoids a request that would be refused; the API stays the authority
  // for races, second tabs and non-browser clients.
  const maxConcurrentAudits = validator.maxConcurrentAudits;
  const atCapacity = capacityKnown && claimedAuditCount >= maxConcurrentAudits;
  const claimBlocked = !capacityKnown || atCapacity;
  const isFirstRun =
    !roleDashboardLoading.validator &&
    ownedSnapshotReady &&
    validator.auditsCompleted === 0 &&
    claimedAuditCount === 0;

  const confirmedFlags = Math.max(0, validator.decidedFlags - validator.dismissedFlags);
  const confirmedIssueRate =
    validator.decidedFlags > 0 ? Math.round((confirmedFlags / validator.decidedFlags) * 100) : null;

  // Server aggregates first; the unfiltered ownership snapshot is only a
  // fallback when the dashboard request failed (never the filtered history).
  const statGroups: StatCell[][] = [
    [
      {
        label: "total claimed",
        value: workSummary?.validator.claimedBatches ?? (activeAudits.length + completedAudits.length),
        title: "All audit batches you have claimed.",
      },
      {
        label: "completed batches",
        value: workSummary?.validator.completedBatches ?? completedAudits.length,
        tone: "accepted",
        title: "Batches where all decisions were submitted before the deadline.",
      },
      {
        label: "open items pending",
        value:
          workSummary?.validator.pendingDecisions ??
          activeAudits.reduce((acc, a) => acc + (a.itemCount - (a.decidedCount ?? 0)), 0),
        tone: "review",
        title: "Items in your currently claimed batches awaiting review.",
      },
      {
        label: "decisions recorded",
        value: workSummary?.validator.decidedItems ?? activeAudits.reduce((acc, a) => acc + (a.decidedCount ?? 0), 0),
        tone: "accepted",
        title: "Total individual item judgments recorded across all batches.",
      },
    ],
    // Flag outcomes — the same funnel v1's validator page shows, read from the
    // server's rank summary (`ranks.validator`), so it is never derived from
    // whichever history page happens to be loaded.
    [
      {
        label: "flags decided",
        value: validator.decidedFlags,
        title: "Flags you raised that have since been resolved, either confirmed or dismissed.",
      },
      {
        label: "confirmed",
        value: confirmedFlags,
        tone: "accepted",
        title: "Flags you raised that review upheld. These count toward your confirmed-issue rate.",
      },
      {
        label: "dismissed",
        value: validator.dismissedFlags,
        tone: "review",
        title: "Flags you raised that review did not uphold. These drive the false-flag rate.",
      },
    ],
  ];

  const hasAppliedAuditFilters =
    auditFilters.domain !== "all" ||
    auditFilters.category !== "all" ||
    auditFilters.language !== "all" ||
    Boolean(auditFilters.search.trim());
  const historyHasActiveFilters = historyFilter !== "all" || Boolean(historySearch.trim());

  return (
    <div className="space-y-6">
      <PageHeader
        title="Community Validator Workspace"
        sub="Audit dataset items against the pool spec. Karma for every completed batch, more for each confirmed issue."
        action={
          <div className="flex items-center gap-2">
            {/* /rules has never existed — not in this app and not in V1, which
                has no chip here at all. The link 404'd on every click. The real
                verification-model copy lives in the landing site's
                how-it-works page (the same destination its own footer calls
                "Verification model"), so the chip points there, the way the
                karma leaderboard and profile rows already link cross-app. */}
            <Link
              href={`${LANDING_URL}/how-it-works/`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 font-mono text-xs text-ink-soft hover:border-ink hover:text-ink"
            >
              <Icon name="shield" size={13} />
              Verification rules
            </Link>
            <Link
              href="/karma"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 font-mono text-xs text-ink-soft hover:border-ink hover:text-ink"
            >
              <Icon name="sparkles" size={13} />
              Karma hub
            </Link>
          </div>
        }
      />

      {/* Top status bar */}
      <WorkspaceStatusBar
        icon="eye"
        rank={validator.rank}
        rankIndex={rankIndex}
        ranks={VALIDATOR_RANKS}
        nextRank={validator.nextRank}
        progressLabel="audits completed"
        progressValue={validator.auditsCompleted}
        progressMax={validator.nextRank?.itemsToGo ? validator.auditsCompleted + validator.nextRank.itemsToGo : validator.auditsCompleted || 100}
        metrics={[
          {
            label: "claimed slots",
            value: capacityKnown ? `${claimedAuditCount} / ${maxConcurrentAudits}` : `— / ${maxConcurrentAudits}`,
            title: "Audits you may hold claimed at once at your current rank — enforced server-side on claim.",
          },
          {
            label: "confirmed issue rate",
            value: confirmedIssueRate != null ? `${confirmedIssueRate}%` : "—",
            title: "Confirmed issues as a percentage of all decided flags you raised.",
          },
          {
            label: "false flag rate",
            value: validator.falseFlagRate != null ? `${validator.falseFlagRate}%` : "—",
            title: "Dismissed flags as a percentage of all decided flags you raised.",
          },
          {
            label: "missed deadlines",
            value: String(validator.missedDeadlines),
            title: "Audits abandoned or missed before completion.",
          },
        ]}
        karma={{
          total: karma.total ?? 0,
          tier: karma.tier,
          nextTier: karma.nextTier,
          secured:
            karma.securedTotal > 0
              ? {
                  amount: karma.securedTotal,
                  label: "secured from your work",
                  title: securedReleaseText(karma.releaseRule),
                }
              : undefined,
        }}
      />

      {/* Lifetime Stat Rail */}
      <StatRail groups={statGroups} />

      {/* Active Claimed Audits or First-Run */}
      {ownedAuditsLoading ? (
        <AsyncState status="loading" loadingText="Loading your active audits…" />
      ) : ownedAuditsError ? (
        <div className="space-y-3">
          <AsyncState
            status="error"
            errorTitle="Could not load your active audits"
            errorDescription={ownedAuditsError}
          />
          <div className="flex justify-center">
            <Button variant="secondary" size="sm" onClick={() => void fetchOwnedAudits()}>
              Retry
            </Button>
          </div>
        </div>
      ) : isFirstRun ? (
        <WorkspaceFirstRun
          sub="How community validation works on DataBounty:"
          steps={validatorFirstRunSteps()}
          ctaHref="#available-audits"
          ctaLabel="Explore open audit batches"
        />
      ) : activeAudits.length > 0 ? (
        <section aria-label="Active Audits" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-mono text-sm font-bold text-ink">Active Audits ({activeAudits.length})</h2>
            <span className="font-mono text-xs text-ink-faint">
              {claimedAuditCount} / {maxConcurrentAudits} slots used
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {activeAudits.map((audit) => {
              const decided = audit.decidedCount ?? 0;
              const total = audit.itemCount;
              const pct = total > 0 ? Math.round((decided / total) * 100) : 0;
              return (
                // `min-w-0` on the grid ITEM, not just the inner title block.
                // A grid item defaults to `min-width: auto`, so the track is
                // floored at the item's min-content width — here the title
                // (363px) plus the due-date pill (100px) plus padding, which
                // came to 505px inside a 343px container and pushed 146px of
                // horizontal scroll onto the whole page at 375px. The
                // `min-w-0` already present on the inner div let the TITLE
                // shrink but could not shrink the card, so the track never
                // came back inside the container.
                <div key={audit.id} className="card min-w-0 p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="micro-label text-ink-faint">{audit.category}</span>
                        <h3 className="font-mono text-sm font-bold text-ink truncate">{audit.bountyTitle}</h3>
                      </div>
                      <Pill tone={audit.status === "overdue_review" ? "danger" : "info"}>
                        {deadlineLabel(audit.deadline)}
                      </Pill>
                    </div>
                    <div className="mt-3">
                      <div className="flex items-center justify-between font-mono text-[11px] text-ink-soft">
                        <span>Progress</span>
                        <span>
                          {decided} / {total} items ({pct}%)
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full rounded-full bg-line-soft overflow-hidden">
                        <div className="h-full bg-lime-500 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between pt-3 border-t border-line-soft">
                    <span className="font-mono text-xs text-karma font-medium">
                      +{num((audit.karmaReward ?? 0) * total)} karma
                    </span>
                    <Link
                      href={`/validator/audit/${audit.id}`}
                      className="inline-flex items-center gap-1 rounded-md bg-ink px-3 py-1.5 font-mono text-xs font-semibold text-white hover:bg-ink-light"
                    >
                      {decided === 0 ? "Start audit" : "Resume audit"}
                      <Icon name="arrow-right" size={12} />
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Available Audit Queue */}
      <section id="available-audits" aria-label="Available Audit Queue" className="space-y-4 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft pb-3">
          <div>
            <h2 className="font-mono text-base font-bold text-ink">Available Community Audits</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              Open batches needing human peer review. Review items, verify against the spec, and earn karma.
            </p>
          </div>
          <span className="font-mono text-xs text-ink-soft">
            {availableAuditsTotal} batch{availableAuditsTotal === 1 ? "" : "es"} available
          </span>
        </div>

        {/* A validator may sponsor, contribute, and review. The only audit
            batches hidden here are ones involving their own submitted work,
            which preserves an independent reviewer for every decision. */}
        {availableAuditsConflictExcluded > 0 && (
          <SectionNote icon="alert">
            <span className="font-bold text-ink">Why {availableAuditsConflictExcluded === 1 ? "this batch is" : "these batches are"} hidden: </span>
            {[
              availableAuditsConflictExcludedByReason.ownSubmission > 0 &&
                `${availableAuditsConflictExcludedByReason.ownSubmission} ${availableAuditsConflictExcludedByReason.ownSubmission === 1 ? "contains" : "contain"} a submission you made`,
              availableAuditsConflictExcludedByReason.duplicateOfOwnWork > 0 &&
                `${availableAuditsConflictExcludedByReason.duplicateOfOwnWork} ${availableAuditsConflictExcludedByReason.duplicateOfOwnWork === 1 ? "contains" : "contain"} work that is very similar to one of your submissions`,
            ]
              .filter((part): part is string => Boolean(part))
              .join("; ")}
            . You can still review any batch that does not involve your submitted work.
          </SectionNote>
        )}

        {atCapacity && (
          <SectionNote icon="info">
            <span className="font-bold text-ink">Audit capacity reached: </span>
            You are holding {claimedAuditCount} of {maxConcurrentAudits} concurrent audit slots allowed for your {validator.rank} rank.
            Complete or abandon an active audit to claim new work.
          </SectionNote>
        )}

        {!capacityKnown && !ownedAuditsLoading && (
          <SectionNote icon="alert">
            <span className="font-bold text-ink">Claiming paused: </span>
            We could not confirm how many audits you already hold, so new claims are disabled until your
            active audits load. Retry above, or refresh the page.
          </SectionNote>
        )}

        {/* Filter bar */}
        <FilterBar
          meta={
            availableAuditsTotal > 0 ? (
              <span>Showing {availableAudits.length} of {availableAuditsTotal}</span>
            ) : null
          }
          onClear={
            hasAppliedAuditFilters
              ? () => setAuditFilters({ domain: "all", category: "all", language: "all", search: "" })
              : undefined
          }
        >
          <SearchField
            placeholder="Search open audits…"
            value={auditFilters.search}
            onChange={(val) => setAuditFilters({ search: val })}
            className="w-full sm:w-64"
          />
          <Select
            value={auditFilters.domain}
            onChange={(e) => setAuditFilters({ domain: e.target.value })}
            className="w-full sm:w-40"
          >
            <option value="all">All Domains</option>
            {DOMAINS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Select
            value={auditFilters.category}
            onChange={(e) => setAuditFilters({ category: e.target.value })}
            className="w-full sm:w-44"
          >
            <option value="all">All Categories</option>
            {taxonomy.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
          <Select
            value={auditFilters.language}
            onChange={(e) => setAuditFilters({ language: e.target.value })}
            className="w-full sm:w-40"
          >
            <option value="all">All Languages</option>
            {taxonomy.languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </FilterBar>

        {/* Available list */}
        {roleDashboardError.validator && (
          <div className="flex justify-center">
            <Button variant="secondary" size="sm" onClick={() => void refreshRoleDashboard("validator")}>
              Retry loading open audits
            </Button>
          </div>
        )}
        <AsyncState
          status={roleDashboardLoading.validator && availableAudits.length === 0 ? "loading" : roleDashboardError.validator ? "error" : "ready"}
          errorTitle="Could not load open audits"
          errorDescription={roleDashboardError.validator ?? "Try refreshing the page."}
        >
          {availableAudits.length === 0 ? (
            <EmptyPitch
              icon="database"
              title="No open audit batches"
              description={
                hasAppliedAuditFilters
                  ? "No open audits match your selected filters. Try clearing filters to see more."
                  : "All submitted items are currently audited. Check back soon for newly submitted contributor batches."
              }
              action={
                hasAppliedAuditFilters ? (
                  <button
                    type="button"
                    onClick={() => setAuditFilters({ domain: "all", category: "all", language: "all", search: "" })}
                    className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-3 py-1.5 font-mono text-xs text-ink hover:bg-panel"
                  >
                    Reset filters
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {availableAudits.map((batch) => {
                const totalKarma = (batch.karmaReward ?? 0) * batch.itemCount;
                return (
                  <div key={batch.id} className="card p-4 flex flex-col justify-between hover:border-ink/30 transition-colors">
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-soft uppercase">
                          {batch.category}
                        </span>
                        {batch.language && (
                          <span className="rounded bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
                            {batch.language}
                          </span>
                        )}
                        <span className="ml-auto font-mono text-[11px] text-ink-faint">
                          {batch.itemCount} items
                        </span>
                      </div>
                      <h3 className="mt-2 font-mono text-sm font-bold text-ink line-clamp-2">
                        {batch.bountyTitle}
                      </h3>
                    </div>

                    <div className="mt-4 pt-3 border-t border-line-soft space-y-3">
                      <div className="flex items-baseline justify-between font-mono text-xs">
                        <span className="text-ink-soft">Reward</span>
                        <div className="text-right">
                          <span className="font-bold text-karma">+{num(totalKarma)} karma</span>
                          <span className="text-[10.5px] text-ink-faint block">
                            +{num(batch.karmaReward ?? 0)} / item
                          </span>
                        </div>
                      </div>

                      {canParticipate ? (
                        <button
                          type="button"
                          disabled={claimingId !== null || claimBlocked}
                          title={
                            atCapacity
                              ? `You're holding ${claimedAuditCount} of ${maxConcurrentAudits} concurrent audit slots allowed for your ${validator.rank} rank. Complete or abandon an active audit to claim new work.`
                              : !capacityKnown
                                ? "Your active audits could not be loaded, so we can't confirm you have a free slot."
                                : undefined
                          }
                          onClick={() => void handleClaim(batch.id)}
                          className="block w-full rounded-md bg-ink py-2 text-center font-mono text-xs font-semibold text-white hover:bg-ink-light transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {claimingId === batch.id
                            ? "Claiming…"
                            : atCapacity
                              ? "At capacity"
                              : !capacityKnown
                                ? "Claiming paused"
                                : "Claim audit"}
                        </button>
                      ) : (
                        <span className="block w-full cursor-not-allowed rounded-md bg-ink py-2 text-center font-mono text-xs font-semibold text-white opacity-40">
                          Verify email to open
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {availableAudits.length < availableAuditsTotal && (
            <div className="mt-4 text-center">
              <button
                type="button"
                disabled={loadingMoreAudits}
                onClick={loadMoreAvailableAudits}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-4 py-2 font-mono text-xs font-semibold text-ink hover:bg-panel disabled:opacity-50"
              >
                {loadingMoreAudits ? "Loading more open audits…" : "Load more open audits"}
              </button>
            </div>
          )}
        </AsyncState>
      </section>

      {/* Audit History / Claimed Work Tab */}
      <section aria-label="Audit History" className="space-y-4 pt-4 border-t border-line">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-mono text-base font-bold text-ink">My Audit History</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              Every audit batch you&apos;ve claimed, in progress or completed. An unfinished claim releases back
              to the pool 24 hours after you claim it if nothing was decided.
            </p>
          </div>
          <PillTabs
            /* No count on "All". `historyTotal` is the total of the CURRENT
               request, which carries the selected status and the search — so
               on the Completed tab the All pill was displaying the completed
               count, and with a search active it displayed the match count.
               The honest total for the visible result set now sits in the
               filter bar's `meta` below, where it describes what is on
               screen. */
            items={[
              { key: "all", label: "All" },
              { key: "in_progress", label: "In Progress" },
              { key: "overdue", label: "Overdue" },
              { key: "completed", label: "Completed" },
            ]}
            value={historyFilter}
            onChange={(tab) => {
              setHistoryFilter(tab as AuditHistoryFilter);
              setHistoryPage(1);
            }}
          />
        </div>

        {/* Same filter-bar contract the open-audits queue above and the
            contributor workspace already use: the result count and a way out
            of a zero-result filter live with the control, not somewhere else
            on the page. */}
        <FilterBar
          meta={
            historyLoading
              ? "loading…"
              : `${historyTotal} ${historyTotal === 1 ? "audit" : "audits"}`
          }
          onClear={
            historyHasActiveFilters
              ? () => {
                  setHistoryFilter("all");
                  setHistorySearch("");
                  setHistoryPage(1);
                }
              : undefined
          }
        >
          <SearchField
            placeholder="Filter your audits by pool title…"
            value={historySearch}
            onChange={(val) => {
              setHistorySearch(val);
              setHistoryPage(1);
            }}
            className="w-full sm:w-72"
          />
        </FilterBar>

        <AsyncState
          status={historyLoading ? "loading" : historyError ? "error" : "ready"}
          errorTitle="Could not load audit history"
          errorDescription={typeof historyError === "string" ? historyError : "Try refreshing the page."}
        >
          {historyAudits.length === 0 ? (
            <EmptyPitch
              icon="eye"
              title="No audits found"
              description={
                historyHasActiveFilters
                  ? "No audits match your filter or search query."
                  : "You haven't claimed any audit batches yet."
              }
            />
          ) : (
            <div className="card overflow-hidden divide-y divide-line-soft">
              {historyAudits.map((audit) => {
                const pub = auditRowPublication(audit);
                return (
                  <div key={audit.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-ink-faint uppercase">{audit.category}</span>
                        <Pill
                          tone={
                            audit.status === "completed"
                              ? "lime"
                              : audit.status === "overdue_review"
                                ? "danger"
                                : "info"
                          }
                        >
                          {audit.status === "claimed"
                            ? "in progress"
                            : audit.status === "overdue_review"
                              ? "overdue"
                              : audit.status}
                        </Pill>
                        {pub && <PublicationStatus publication={pub} compact />}
                      </div>
                      <h3 className="mt-1 font-mono text-sm font-bold text-ink">{audit.bountyTitle}</h3>
                      <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[11px] text-ink-soft">
                        <span>{audit.itemCount} items</span>
                        <span>·</span>
                        <span>{audit.decidedCount ?? 0} decided</span>
                        <span>·</span>
                        <span className="text-karma">+{num((audit.karmaReward ?? 0) * audit.itemCount)} karma</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Link
                        href={`/validator/audit/${audit.id}`}
                        className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-3 py-1.5 font-mono text-xs font-semibold text-ink hover:bg-panel"
                      >
                        {audit.status === "completed" ? "View audit" : "Review batch"}
                        <Icon name="arrow-right" size={12} />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {historyTotal > AUDIT_HISTORY_PAGE_SIZE && (
            <div className="mt-4 flex justify-end">
              <Pagination
                page={historyPage}
                totalPages={Math.ceil(historyTotal / AUDIT_HISTORY_PAGE_SIZE)}
                disabled={historyLoading}
                onPrev={() => setHistoryPage((p) => Math.max(1, p - 1))}
                onNext={() =>
                  setHistoryPage((p) =>
                    Math.min(Math.ceil(historyTotal / AUDIT_HISTORY_PAGE_SIZE), p + 1)
                  )
                }
              />
            </div>
          )}
        </AsyncState>
      </section>
    </div>
  );
}
