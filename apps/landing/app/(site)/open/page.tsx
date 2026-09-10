// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { num } from "@/lib/format";
import { KARMA_TIERS, perksForLiveTier, tierForLive, type ApiKarmaTier } from "@/lib/karma";
import { Icon } from "@/components/icons";
import { DASHBOARD_URL, LANDING_URL } from "@/lib/urls";
import { SectionHeading } from "@/components/section-heading";
import { EmptyState } from "@/components/empty-state";
import { AutoRefresh } from "@/components/auto-refresh";
import { fetchCommunityStats } from "@/lib/public-data";

export const metadata = {
  title: "Karma and the Open Program",
  description:
    "How DataBounty's community karma program works: policy-controlled pools release karma on final acceptance, and accepted items are synchronized to Hugging Face asynchronously.",
  alternates: { canonical: `${LANDING_URL}/open` },
};

export default async function OpenProgramPage() {
  const statsResult = await fetchCommunityStats();
  const stats = statsResult.data;

  if (!statsResult.available) {
    return (
      <div className="bg-dark text-dark-text">
        <div className="mx-auto max-w-[1200px] px-4 pb-[140px] pt-[90px] sm:px-8">
          <div className="mb-10 text-center">
            <div className="mb-4 font-mono text-xs text-lime">&gt; program: databounty_open</div>
            <h1 className="font-display text-4xl font-bold tracking-[-.035em] sm:text-5xl">Community data is temporarily unavailable.</h1>
            <p className="mx-auto mt-4 max-w-xl text-dark-muted">We cannot confirm the current program totals or leaderboard right now. Please refresh in a moment.</p>
          </div>
          <EmptyState variant="error" icon="alert" title="Could not load the Open program." description="The community service did not respond, so no totals are being shown." />
        </div>
      </div>
    );
  }

  const totals = {
    datasets: Number(stats?.programs ?? 0),
    targetItems: Number(stats?.targetItems ?? 0),
    clearedItems: Number(stats?.clearedItems ?? 0),
    acceptedItems: Number(stats?.acceptedItems ?? 0),
    contributors: Number(stats?.contributors ?? 0),
    published: Number(stats?.publishedDatasets ?? 0),
  };
  const liveTiers = (stats?.tiers as ApiKarmaTier[] | undefined) ?? [];

  const leaders = (
    (stats?.leaderboard as { rank: number; handle: string; displayName: string | null; karma: number }[] | undefined) ?? []
  ).map((r) => ({ ...r, tier: tierForLive(r.karma, liveTiers) }));

  return (
    <div className="bg-dark text-dark-text">
      {/* Hero */}
      <div className="mx-auto max-w-[1200px] px-4 sm:px-8">
        <div className="flex flex-col items-center pb-[72px] pt-[90px] text-center">
          <div className="mb-7 font-mono text-xs text-lime">
            &gt; program: databounty_open &nbsp;·&nbsp; reward: karma{" "}
            <span className="blink">▋</span>
          </div>
          <h1 className="mb-6 max-w-[880px] font-display text-4xl font-bold leading-[1.06] tracking-[-.035em] sm:text-5xl lg:text-[56px]">
            Build the open corpus.
            <br />
            Earn karma and{" "}
            <span className="bg-lime px-2.5 text-dark">the credit.</span>
          </h1>
          <p className="mb-9 max-w-[620px] font-display text-lg font-light leading-[1.6] text-dark-muted">
            {totals.datasets} dataset specs open to every contributor. In a
            policy-controlled community pool, final acceptance releases karma
            immediately and queues Hugging Face synchronization with eligible credit.
          </p>
          <div className="flex flex-wrap justify-center gap-3.5">
            <Link
              href={`${DASHBOARD_URL}/contributor`}
              className="rounded-lg bg-lime px-6 py-3.5 font-mono text-sm font-medium text-dark hover:bg-lime-bright"
            >
              start_contributing →
            </Link>
            <a
              href="#leaderboard"
              className="rounded-lg border border-dark-line-soft px-6 py-3.5 font-mono text-sm font-medium text-dark-text"
            >
              view_leaderboard
            </a>
          </div>
        </div>
      </div>

      {/* Stat band */}
      <div className="border-y border-dark-line bg-dark">
        <AutoRefresh />
        <div className="mx-auto grid max-w-[1200px] grid-cols-2 font-mono sm:grid-cols-3 lg:grid-cols-6">
          {[
            { value: num(totals.datasets), label: "community_specs" },
            { value: num(totals.targetItems), label: "target_items" },
            { value: num(totals.clearedItems), label: "cleared_pipeline_items" },
            { value: num(totals.acceptedItems), label: "final_accepted_items" },
            { value: num(totals.contributors), label: "contributors" },
            { value: num(totals.published), label: "published_to_hf" },
          ].map((s, i, arr) => (
            <div
              key={s.label}
              className={`px-6 py-8 ${i < arr.length - 1 ? "lg:border-r lg:border-dark-line" : ""} border-dark-line max-lg:border-b max-lg:[&:nth-child(odd)]:border-r`}
            >
              <div className="text-[23px] font-bold text-dark-text">
                {s.value}
              </div>
              <div className="mt-[5px] text-[10px] uppercase tracking-[.06em] text-dark-dim">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-[1200px] px-4 sm:px-8">
        {/* Why free */}
        <div className="pt-[90px]">
          <h2 className="font-display text-2xl font-bold leading-[normal] text-dark-text">
            {"// why_contribute"}
          </h2>
          <p className="mb-[26px] mt-2 font-display text-sm font-light text-dark-muted">
            Build a visible record of useful work, with the per-item karma shown on each pool.
          </p>
          <div className="grid gap-5 lg:grid-cols-3">
            {[
              {
                icon: "database" as const,
                title: "open by design",
                body: "Finished datasets publish to Hugging Face under Apache-2.0 and similarly permissive licenses. The corpus belongs to everyone, including you, with named credit.",
              },
              {
                icon: "shield" as const,
                title: "same pipeline, same bar",
                body: "Every item follows the verification pipeline declared by its dataset contract. If a required stage is unavailable or unresolved, the item routes to human review instead of being called verified.",
              },
              {
                icon: "zap" as const,
                title: "karma converts to priority",
                body: "Final acceptance secures the pool's listed karma amount until verified publication. Your live tier and its current benefits are shown from account data, not assumed here.",
              },
            ].map((c) => (
              <div
                key={c.title}
                className="rounded-[11px] border border-dark-line bg-dark-card p-6"
              >
                <Icon name={c.icon} size={18} className="text-lime" />
                <div className="mb-2 mt-4 font-mono text-[13px] font-bold text-dark-text">
                  {c.title}
                </div>
                <div className="text-[13px] leading-[1.5] text-dark-muted">
                  {c.body}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Karma tiers */}
        <div className="pt-[90px]">
          <SectionHeading
            title="// karma_tiers"
            sub="Accepted work moves you up. Tiers never decay."
          />
          {liveTiers.length === 0 && (
            <p className="mb-4 text-xs text-dark-dim">
              Live tier data is unavailable right now. Showing the default tier ladder rather than a stale copy.
            </p>
          )}
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {(liveTiers.length > 0 ? liveTiers : KARMA_TIERS).map((t, i) => (
              <div
                key={"minKarma" in t ? t.name : t.id}
                className="rounded-[11px] border border-dark-line bg-dark-card p-6"
              >
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span
                    className="font-mono text-[15px] font-bold"
                    style={{ color: t.color }}
                  >
                    {("minKarma" in t ? t.label : t.name).toLowerCase()}
                  </span>
                  <span className="font-mono text-[11px] text-dark-dim">
                    {num("minKarma" in t ? t.minKarma : t.min)}+ karma
                  </span>
                </div>
                {!("minKarma" in t) && (
                  <p className="mb-4 text-xs leading-[1.5] text-dark-muted">
                    {t.blurb}
                  </p>
                )}
                <div className="flex flex-col gap-[7px] font-mono text-[11px] leading-[1.4]">
                  {("minKarma" in t ? perksForLiveTier(t, i > 0 ? (liveTiers[i - 1] as ApiKarmaTier).label : null) : t.perks).map((p) => (
                    <div key={p} className="flex gap-2">
                      <span className="text-emerald-400">✓</span>
                      <span className="text-dark-muted">{p}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Leaderboard */}
        <div id="leaderboard" className="scroll-mt-24 pt-[90px]">
          <SectionHeading
            title="// leaderboard"
            sub="Top contributors across every community spec, ranked by karma."
          />
          {leaders.length === 0 ? (
            <EmptyState
              variant="empty"
              icon="users"
              title="No public leaderboard yet."
              description="Karma-earning contributors can opt in to a public handle from their profile."
            />
          ) : (
            <div className="overflow-x-auto rounded-[11px] border border-dark-line font-mono">
              <div className="min-w-[620px]">
                <div className="micro-label grid grid-cols-[64px_1.6fr_1.6fr_1fr_1fr] border-b border-dark-line bg-dark-card px-5 py-3 text-dark-dim">
                  <span>rank</span>
                  <span>handle</span>
                  <span>name</span>
                  <span>tier</span>
                  <span className="text-right">karma</span>
                </div>
                {leaders.map((r, i) => (
                  <div
                    key={r.handle}
                    className={`grid grid-cols-[64px_1.6fr_1.6fr_1fr_1fr] items-center px-5 py-3 text-[12.5px] ${
                      i < leaders.length - 1 ? "border-b border-[#131a11]" : ""
                    }`}
                  >
                    <span className="text-dark-dim">#{r.rank}</span>
                    <Link
                      href={`/${r.handle}`}
                      className="text-dark-text hover:text-lime"
                    >
                      {r.handle}
                    </Link>
                    <span className="truncate text-dark-muted">{r.displayName ?? "—"}</span>
                    <span style={{ color: r.tier.color }}>
                      {r.tier.name.toLowerCase()}
                    </span>
                    <span className="text-right text-lime">{num(r.karma)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Final CTA */}
      <div className="mx-auto max-w-[1200px] px-4 pb-[90px] pt-[90px] sm:px-8">
        <div className="flex flex-col items-start justify-between gap-4 rounded-xl border border-dark-line-soft bg-dark-deep px-[30px] py-[26px] sm:flex-row sm:items-center">
          <div>
            <div className="mb-1 text-base font-bold text-dark-text">
              Ready to build the open corpus?
            </div>
            <div className="text-[13px] text-dark-muted">
              Contribute to any open spec: karma secured on final
              acceptance and added to your balance when the dataset ships, with named credit. Or request the
              dataset you&apos;re missing.
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <Link
              href="/pools"
              className="rounded-lg bg-lime px-5 py-[13px] font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright"
            >
              browse_datasets →
            </Link>
            <a
              href={`${DASHBOARD_URL}/sponsor/create`}
              className="rounded-lg border border-dark-line-soft px-5 py-[13px] font-mono text-[13px] font-medium text-dark-text transition-colors hover:border-dark-hover"
            >
              request_a_dataset →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
