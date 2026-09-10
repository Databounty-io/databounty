"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useDemo } from "@/lib/store";
import {
  CONTRIBUTOR_RANKS,
  VALIDATOR_RANKS,
  num,
  pct,
} from "@/lib/format";
import { PageHeader } from "@/components/app-shell";
import { SectionHeader } from "@/components/ui";
import { Icon } from "@/components/icons";

function InkBar({ value, max, h = 5 }: { value: number; max: number; h?: number }) {
  const w = max === 0 ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div
      className="w-full overflow-hidden rounded-[3px] bg-line-soft"
      style={{ height: h }}
    >
      <div className="h-full bg-ink transition-all" style={{ width: `${w}%` }} />
    </div>
  );
}

function RankCard({
  roleLabel,
  rank,
  rankIndex,
  ranks,
  nextRank,
  progressLabel,
  value,
  max,
  stats,
  nextUnlock,
}: {
  roleLabel: string;
  rank: string;
  rankIndex: number;
  ranks: string[];
  nextRank: string;
  progressLabel: string;
  value: number;
  max: number;
  stats: { label: string; value: string }[];
  nextUnlock: string;
}) {
  return (
    <div className="card p-[22px]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="micro-label text-ink-faint">{roleLabel} rank</div>
          <div className="mt-1 text-[17px] font-bold tracking-tight">{rank}</div>
        </div>
        <span className="rounded-full bg-brand-soft px-2.5 py-1.5 font-mono text-[11px] text-ink-soft">
          next: {nextRank}
        </span>
      </div>
      <div className="mb-1.5 flex justify-between font-mono text-[11px] text-ink-soft">
        <span>{progressLabel}</span>
        <span className="text-ink">
          {num(value)} / {num(max)}
        </span>
      </div>
      <InkBar value={value} max={max} h={6} />
      <div className="mt-4 flex items-center gap-1.5">
        {ranks.map((r, i) => (
          <span
            key={r}
            title={r}
            className={`h-[7px] w-[7px] rounded-full ${
              i <= rankIndex ? "bg-ink" : "bg-[#d5d8ce]"
            }`}
          />
        ))}
        <span className="ml-1.5 font-mono text-[10px] text-ink-faint">
          {rankIndex + 1} / {ranks.length}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs">
        {stats.map((s) => (
          <div key={s.label}>
            <span className="text-ink-soft">{s.label}</span>{" "}
            <span className="font-bold">{s.value}</span>
          </div>
        ))}
      </div>
      <div className="mt-3.5 border-t border-line-soft pt-3 text-xs text-ink-soft">
        <span className="font-mono font-medium text-ink">next unlock:</span>{" "}
        {nextUnlock}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const {
    user,
    notifications,
    profileSummary,
    refreshProfileSources,
  } = useDemo();
  const contributor = profileSummary.ranks.contributor;
  const validator = profileSummary.ranks.validator;
  const contributorRankIndex = Math.max(0, CONTRIBUTOR_RANKS.indexOf(contributor.rank));
  const validatorRankIndex = Math.max(0, VALIDATOR_RANKS.indexOf(validator.rank));
  const confirmedFlags = Math.max(0, validator.decidedFlags - validator.dismissedFlags);
  const confirmedIssueRate = validator.decidedFlags > 0 ? confirmedFlags / validator.decidedFlags : null;

  const lastFocusRefreshAt = useRef(0);
  useEffect(() => {
    const refresh = () => {
      const now = Date.now();
      if (now - lastFocusRefreshAt.current < 500) return;
      lastFocusRefreshAt.current = now;
      refreshProfileSources();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshProfileSources]);

  const previewNotifications = notifications.slice(0, 3);

  return (
    <div>
      <PageHeader
        title="Overview"
        sub={
          <>
            {user?.name ? (
              <>
                Welcome back,{" "}
                <span className="font-mono text-ink">{user.name}</span> ·{" "}
              </>
            ) : (
              <>Signed in · </>
            )}
            everything across your community work in one place.
          </>
        }
      />

      <div className="mt-6 flex flex-wrap items-center gap-2.5 rounded-[12px] border border-line bg-white px-4 py-3">
        <span className="micro-label text-ink-faint">participation</span>
        <span className="text-[12.5px] text-ink-soft">
          Contribute and validate — all available on every account.
        </span>
        <Link
          href="/profile"
          className="ml-auto flex items-center gap-1 font-mono text-[11px] text-ink-faint hover:text-ink"
        >
          manage in Profile &amp; reputation <Icon name="arrow-right" size={11} />
        </Link>
      </div>

      <div className="mt-9">
        <SectionHeader
          title="Rank progress"
          sub="Higher ranks unlock more concurrent batches and larger capacity."
        />
        <div className="grid gap-4 lg:grid-cols-2">
          <RankCard
            roleLabel="contributor"
            rank={contributor.rank}
            rankIndex={contributorRankIndex}
            ranks={CONTRIBUTOR_RANKS}
            nextRank={CONTRIBUTOR_RANKS[contributorRankIndex + 1] ?? "Top rank"}
            progressLabel="rank position"
            value={contributorRankIndex + 1}
            max={CONTRIBUTOR_RANKS.length}
            stats={[
              { label: "accepted items", value: num(contributor.acceptedItems) },
              { label: "clean streak", value: num(contributor.consecutiveCleanDeliveries) },
              { label: "missed deadlines", value: num(contributor.missedDeadlines) },
            ]}
            nextUnlock={`Current batch limit: ${num(contributor.maxConcurrentBatches)} concurrent batch${contributor.maxConcurrentBatches === 1 ? "" : "es"}`}
          />
          <RankCard
            roleLabel="validator"
            rank={validator.rank}
            rankIndex={validatorRankIndex}
            ranks={VALIDATOR_RANKS}
            nextRank={VALIDATOR_RANKS[validatorRankIndex + 1] ?? "Top rank"}
            progressLabel="rank position"
            value={validatorRankIndex + 1}
            max={VALIDATOR_RANKS.length}
            stats={[
              {
                label: "confirmed issue rate",
                value: confirmedIssueRate == null ? "—" : pct(confirmedIssueRate),
              },
              { label: "false flag rate", value: validator.falseFlagRate == null ? "—" : pct(validator.falseFlagRate) },
              { label: "completed audits", value: num(validator.auditsCompleted) },
            ]}
            nextUnlock={`${num(validator.decidedFlags)} validator flag decision${validator.decidedFlags === 1 ? "" : "s"} recorded`}
          />
        </div>
      </div>

      <div className="mt-9">
        <SectionHeader
          title="Latest notifications"
          action={
            <Link
              href="/notifications#inbox"
              className="flex items-center gap-1 font-mono text-xs text-accent-strong hover:underline"
            >
              view_all <Icon name="arrow-right" size={11} />
            </Link>
          }
        />
        <div className="card overflow-hidden">
          {previewNotifications.map((n, i) => (
            <div
              key={n.id}
              className={`flex items-start gap-3 px-5 py-4 ${
                i > 0 ? "border-t border-line-soft" : ""
              }`}
            >
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  n.read ? "bg-[#d5d8ce]" : "bg-lime"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold tracking-tight">{n.title}</div>
                <p className="mt-0.5 truncate text-[13px] text-ink-soft">{n.body}</p>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                {n.time}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
