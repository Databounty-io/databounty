// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { fetchLandingCatalog, fetchCommunityStats, fetchWaitlistCount, fetchValidationQueue, fetchPoolsPage, fetchDeveloperSurface } from "@/lib/public-data";
import { num, pct } from "@/lib/format";
import { DASHBOARD_URL, MCP_URL } from "@/lib/urls";
import { PoolCard, DeliveredCard, ValidationCard, isPoolFull } from "@/components/pool-card";
import { EmptyState } from "@/components/empty-state";
import { AutoRefresh } from "@/components/auto-refresh";
import { headlinePerkForLiveTier, type ApiKarmaTier } from "@/lib/karma";
import { DOMAINS, typesForDomain } from "@/lib/dataset-types";
import { SectionHeading } from "@/components/section-heading";

/* ---------- verification card ---------- */

function VerificationCard({
  icon,
  metric,
  label,
  children,
}: {
  icon: React.ReactNode;
  metric: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[11px] border border-dark-line bg-dark-card p-6">
      {icon}
      <div className="mb-2 mt-4 font-mono text-[26px] font-bold text-lime">
        {metric}
      </div>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[.06em] text-dark-soft">
        {label}
      </div>
      <div className="text-[13px] leading-[1.5] text-dark-muted">{children}</div>
    </div>
  );
}

/* ---------- value prop ---------- */

function ValueProp({
  icon,
  audience,
  headline,
  points,
  href,
  cta,
}: {
  icon: React.ReactNode;
  audience: string;
  headline: string;
  points: string[];
  href: string;
  cta: string;
}) {
  return (
    <div className="rounded-[11px] border border-dark-line bg-dark-card p-6">
      <div className="mb-4 flex items-center gap-2.5">
        {icon}
        <span className="font-mono text-[11px] uppercase tracking-[.06em] text-dark-soft">
          {audience}
        </span>
      </div>
      <div className="mb-3 text-[17px] font-bold text-dark-text">{headline}</div>
      <div className="flex flex-col gap-[9px] text-[13.5px] leading-[1.45] text-dark-muted">
        {points.map((p) => (
          <div key={p} className="flex gap-[9px]">
            <span className="text-[#34d399]">✓</span>
            <span>{p}</span>
          </div>
        ))}
      </div>
      <a
        href={href}
        className="mt-[18px] inline-block font-mono text-[13px] text-lime"
      >
        {cta} →
      </a>
    </div>
  );
}

/** The fill ratio PoolCard renders: capacity reserved over target. */
function poolFilledRatio(pool: { communityProgress?: { capacityReserved: number } | null; clearedItems?: number; acceptedItems: number; targetItems: number }): number {
  const progress = pool.communityProgress?.capacityReserved ?? pool.clearedItems ?? pool.acceptedItems;
  return progress / (pool.targetItems || 1);
}

/* ---------- page ---------- */

export default async function HomePage() {
  const [catalog, stats, waitlistCounts, validation, openPools, surface] = await Promise.all([
    fetchLandingCatalog().catch(() => {
      return { communityError: true, bounties: [], delivered: [], datasetTypes: [], liveDomainIds: new Set<string>() };
    }),
    fetchCommunityStats(),
    Promise.all(DOMAINS.map((d) => (d.status === "live" ? Promise.resolve(0) : fetchWaitlistCount(d.id)))),
    fetchValidationQueue(6),
    fetchPoolsPage({ page: 1, pageSize: 1 }),
    // The pipeline strip below must not assert LLM review as a check that
    // runs: `validation.llm.enabled` fails closed to false server-side, and
    // when it is off the stage is dropped entirely (no result row, no score,
    // no timeline step). This reads the real switch plus the independent
    // provider fact instead of guessing.
    fetchDeveloperSurface(),
  ]);

  // Three honest states, matching the API's two separately-named facts:
  //   switch on + provider configured  ⇒ a real model scores the item
  //   switch on + no provider          ⇒ the stage runs but records an honest
  //                                      "not configured" placeholder
  //   switch off, or the surface could
  //   not be read at all               ⇒ claim nothing (`null`): the stage is
  //                                      absent from the pipeline, and an
  //                                      unreadable surface must not be
  //                                      guessed into a passed check.
  const llmStrip =
    surface && surface.llmValidationEnabled
      ? { runs: surface.llmProviderConfigured }
      : null;

  const mcpEndpoint = MCP_URL;
  const { bounties, delivered, communityError, liveDomainIds } = catalog;
  const statsData = stats.data;
  const waitlistCountById = new Map(DOMAINS.map((d, i) => [d.id, waitlistCounts[i]]));

  const liveTiers = (statsData?.tiers as ApiKarmaTier[] | undefined) ?? [];

  const openTotals = {
    // The open count, not every community dataset ever created: `programs`
    // includes delivered corpora, so the hero claimed 336 specs "ready to
    // claim" while /pools honestly listed 331.
    datasets: openPools.total ?? Number(statsData?.programs ?? 0),
    targetItems: Number(statsData?.targetItems ?? 0),
    clearedItems: Number(statsData?.clearedItems ?? 0),
    acceptedItems: Number(statsData?.acceptedItems ?? 0),
    contributors: Number(statsData?.contributors ?? 0),
    published: Number(statsData?.publishedDatasets ?? 0),
  };
  // `openTotals.datasets` defaults to 0 when neither source answered — a
  // fabricated "0 open work specs ready to claim" stated as fact. True only
  // when at least one of the two sources it is derived from actually
  // answered; otherwise the hero must say so instead of showing a number.
  const openDatasetsAvailable = openPools.total !== null || stats.available;

  const topContributors =
    (statsData?.leaderboard as { rank: number; handle: string; karma: number }[] | undefined) ?? [];

  const communityOpen = bounties
    // `status === "active"` alone is not "can be contributed to": a pool that
    // reached its target stays active while it is audited. Sorting most-filled
    // first then guaranteed those full pools the top slots.
    .filter((b) => b.kind === "community" && b.status === "active" && !isPoolFull(b))
    .slice()
    // Sort on the SAME number PoolCard prints as its progress bar, so
    // "most-filled first" is true of what the reader can see.
    .sort((a, b) => poolFilledRatio(b) - poolFilledRatio(a));

  // Contribution work: pools still taking items. Most-filled first (above).
  const communityLive = communityOpen.slice(0, 6);

  // Validation work: the same pools, but the job is auditing what is already
  // in. Served by its own endpoint rather than filtered out of the fetched
  // page — the backlog spans every open pool, and deriving it from one page of
  // 100 both understated it and could claim "nothing is waiting" while later
  // pools had queues. Deepest queue first; totals are the real totals.
  const validationQueue = validation.bounties;
  const validationItems = validation.totals.items;
  const validationPools = validation.totals.pools;

  const deliveredTop = delivered.slice(0, 3);
  const deliveredItems = delivered.reduce((total, bounty) => total + bounty.acceptedItems, 0);
  const dupRejectRate = bounties.length ? bounties.reduce((sum, b) => sum + (b.duplicateRate ?? 0), 0) / bounties.length : 0;

  return (
    <div className="text-dark-text">
      {/* Headless live update: re-runs this whole server page (every
          lib/public-data fetch is `cache: "no-store"`, so one tick reloads
          stats, catalog, validation queue, pools and waitlist counts alike).
          Mounted at the ROOT, not inside the stats band — a failed stats
          fetch must not also switch off the refresh that would recover it. */}
      <AutoRefresh />
      {/* 1. Hero */}
      <div className="mx-auto max-w-[1200px] px-4 sm:px-8">
        <div className="flex flex-col items-center pb-[80px] pt-[110px] text-center">
          <div className="mb-7 font-mono text-xs text-lime">
            &gt; program: databounty_open &nbsp;·&nbsp; reward: karma
            <span className="blink">▋</span>
          </div>
          <h1 className="mb-6 max-w-[880px] font-display text-4xl font-bold leading-[1.06] tracking-[-.035em] sm:text-5xl lg:text-[60px]">
            <span className="text-dark-muted">Build datasets that matter.</span>
            <br />
            Earn karma and{" "}
            <span className="bg-lime px-2.5 text-dark">the credit.</span>
          </h1>
          <p className="mb-9 max-w-[620px] font-display text-lg font-light leading-[1.6] text-dark-muted">
            {openDatasetsAvailable
              ? `${openTotals.datasets} open work specs ready to claim.`
              : "Open work specs are temporarily unavailable."}{" "}
            For a policy-controlled community pool, final acceptance releases
            karma immediately and queues Hugging Face synchronization with
            eligible credit.
          </p>
          <div className="mb-12 flex flex-wrap justify-center gap-3.5">
            <Link
              href={`${DASHBOARD_URL}/contributor`}
              className="rounded-lg bg-lime px-6 py-3.5 font-mono text-sm font-medium text-dark hover:bg-lime-bright"
            >
              start_contributing →
            </Link>
            <a
              href={`${DASHBOARD_URL}/sponsor/create`}
              className="rounded-lg border border-dark-line-soft px-6 py-3.5 font-mono text-sm font-medium text-dark-text transition-colors hover:border-dark-hover"
            >
              request_a_dataset
            </a>
          </div>
          <div className="inline-flex flex-wrap items-center justify-center gap-3.5 rounded-full border border-dark-line bg-dark-card px-5 py-2.5 font-mono text-xs text-dark-muted">
            <span>
              <span className="text-[#34d399]">✓</span> dedupe
            </span>
            <span className="text-dark-line-soft">/</span>
            <span>
              <span className="text-[#34d399]">✓</span> ai attribution
            </span>
            <span className="text-dark-line-soft">/</span>
            <span>
              <span className="text-[#34d399]">✓</span> sandboxed tests
            </span>
            {llmStrip ? (
              <>
                <span className="text-dark-line-soft">/</span>
                <span>
                  {llmStrip.runs ? (
                    <>
                      <span className="text-[#34d399]">✓</span> llm review
                    </>
                  ) : (
                    <span className="text-dark-dim">llm review · not configured</span>
                  )}
                </span>
              </>
            ) : null}
            <span className="text-dark-line-soft">/</span>
            <span>
              <span className="text-[#34d399]">✓</span> human validation
            </span>
            <span className="text-lime">➜ final acceptance</span>
          </div>
        </div>
      </div>

      {/* 2. Stats band */}
      {stats.available ? (
        <div className="border-y border-dark-line bg-dark">
          <div className="mx-auto grid max-w-[1200px] grid-cols-2 font-mono sm:grid-cols-3 lg:grid-cols-6">
            {[
              { value: num(openTotals.datasets), label: "open_dataset_specs" },
              { value: num(openTotals.targetItems), label: "target_items" },
              { value: num(openTotals.clearedItems), label: "cleared_pipeline_items" },
              { value: num(openTotals.acceptedItems), label: "final_accepted_items" },
              { value: num(openTotals.contributors), label: "contributors" },
              { value: num(openTotals.published), label: "published_to_hf" },
            ].map((s, i, arr) => (
              <div
                key={s.label}
                className={`px-6 py-8 ${i < arr.length - 1 ? "lg:border-r lg:border-dark-line" : ""} border-dark-line max-lg:border-b max-lg:[&:nth-child(odd)]:border-r`}
              >
                <div className="text-[23px] font-bold text-dark-text">{s.value}</div>
                <div className="mt-[5px] text-[10px] uppercase tracking-[.06em] text-dark-dim">
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="border-y border-dark-line bg-dark px-6 py-5 text-center font-mono text-xs text-dark-muted">
          Community statistics are temporarily unavailable.
        </div>
      )}

      <div className="mx-auto max-w-[1200px] px-4 sm:px-8">
        {/* 3. Open contribution work */}
        <div className="pt-[90px]">
          <SectionHeading
            title="// open_contribution"
            sub="Community specs accepting contributions right now. Final acceptance secures karma; publication adds it to your balance. Most-filled first."
            action={
              <Link href="/pools" className="font-mono text-[13px] text-lime">
                view_all →
              </Link>
            }
          />
          {communityError ? (
            <EmptyState
              variant="error"
              title="Could not load open work right now."
              description="The catalog service didn't respond. Try refreshing in a moment."
            />
          ) : communityLive.length === 0 ? (
            <EmptyState
              variant="empty"
              title="No open work right now."
              description="New community specs open regularly. Check back soon, or ask for the one you're missing."
              action={{ label: "request_a_dataset", href: `${DASHBOARD_URL}/sponsor/create`, external: true }}
            />
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {communityLive.map((b) => (
                <PoolCard key={b.id} pool={b} />
              ))}
            </div>
          )}
        </div>

        {/* 3b. Open validation work — the validator side of the same pools */}
        <div className="pt-[90px]">
          <SectionHeading
            title="// open_validation"
            sub="Contributions already submitted and waiting on a human validator. Auditing an item earns karma whichever way the call goes. Deepest queue first."
            action={
              <Link href="/validation" className="font-mono text-[13px] text-lime">
                view_all →
              </Link>
            }
          />
          {validation.loadError ? (
            <EmptyState
              variant="error"
              title="Could not load validation work right now."
              description="The catalog service didn't respond. Try refreshing in a moment."
            />
          ) : validationQueue.length === 0 ? (
            <EmptyState
              variant="empty"
              title="No items are waiting on a validator right now."
              description="Validation work appears here as soon as contributions clear the automated checks. Contributing is open in the meantime."
              action={{ label: "become_a_validator", href: `${DASHBOARD_URL}/validator`, external: true }}
            />
          ) : (
            <>
              <div className="mb-5 font-mono text-[11px] text-dark-dim">
                {num(validationItems)} {validationItems === 1 ? "item" : "items"} awaiting audit across{" "}
                {num(validationPools)} {validationPools === 1 ? "pool" : "pools"}
                {validationPools > validationQueue.length && (
                  <> · showing the {num(validationQueue.length)} deepest queues</>
                )}
              </div>
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {validationQueue.map((b) => (
                  <ValidationCard key={b.id} pool={b} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* 4. Recently delivered */}
        <div className="pt-[90px]">
          <SectionHeading
            title="// recently_delivered"
            sub="Published corpora with public quality stats, live on Hugging Face under open licenses."
            action={
              <Link href="/delivered" className="font-mono text-[13px] text-lime">
                all_delivered →
              </Link>
            }
          />
          {communityError ? (
            <EmptyState
              variant="error"
              title="Could not load delivered datasets right now."
              description="The catalog service didn't respond. Try refreshing in a moment."
            />
          ) : deliveredTop.length === 0 ? (
            <EmptyState
              variant="empty"
              title="No delivered datasets yet."
              description="Datasets appear here once every item has cleared verification and the corpus is published. Open work is in progress now."
              action={{ label: "view_open_work", href: "/pools" }}
            />
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {deliveredTop.map((b) => (
                <DeliveredCard key={b.id} pool={b} />
              ))}
            </div>
          )}
        </div>

        {/* 5. Karma tiers */}
        <div className="pt-[90px]">
          <SectionHeading
            title="// karma_tiers"
            sub="Accepted work moves you up. Tiers never decay, and higher tiers reflect your track record across the community."
            action={
              <Link href="/open" className="font-mono text-[13px] text-lime">
                full_leaderboard →
              </Link>
            }
          />
          {liveTiers.length > 0 ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {liveTiers.map((t) => (
                <div
                  key={t.name}
                  className="rounded-[11px] border border-dark-line bg-dark-card p-5"
                >
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[15px] font-bold" style={{ color: t.color }}>
                      {t.label.toLowerCase()}
                    </span>
                    <span className="font-mono text-[11px] text-dark-dim">
                      {num(t.minKarma)}+ karma
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-[1.5] text-dark-muted">
                    {headlinePerkForLiveTier(t)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-[11px] border border-dark-line bg-dark-card px-5 py-4 font-mono text-xs text-dark-muted">
              Karma tier data is temporarily unavailable, so no thresholds are
              shown rather than numbers that may have drifted.{" "}
              <Link href="/open" className="text-lime">
                Karma and tiers
              </Link>{" "}
              carries the current ladder once it&apos;s back.
            </div>
          )}
          <div className="mt-5 flex flex-col items-start justify-between gap-3 rounded-[11px] border border-dark-line bg-dark-deep px-5 py-4 font-mono text-xs sm:flex-row sm:items-center">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="text-dark-dim">top_contributors:</span>
              {topContributors.length ? (
                topContributors.map((r) => (
                  <Link key={r.handle} href={`/${r.handle}`} className="text-dark-text hover:text-lime">
                    #{r.rank} {r.handle} <span className="text-lime">{num(r.karma)}</span>
                  </Link>
                ))
              ) : (
                <span className="text-dark-soft">no public leaderboard yet</span>
              )}
            </div>
          </div>
        </div>

        {/* 6. Request a dataset */}
        <div className="pt-[90px]">
          <h2 className="font-display text-2xl font-bold leading-[normal] text-dark-text">
            {"// request_a_dataset"}
          </h2>
          <p className="mb-6 mt-2 max-w-[720px] font-display text-sm font-light text-dark-muted">
            Ask for the dataset you&apos;re missing, free. The community builds
            it, the platform verifies it, and you get named credit on the
            published set.
          </p>
          <div className="flex flex-col items-start justify-between gap-5 rounded-[11px] border border-dark-line bg-dark-card px-6 py-5 sm:flex-row sm:items-center">
            <div className="w-full min-w-0 max-w-full overflow-x-auto font-mono text-[13px] text-dark-muted">
              <div className="min-w-max">
                <span className="text-dark-dim">01</span> describe_the_gap{" "}
                <span className="text-lime">→</span>{" "}
                <span className="text-dark-dim">02</span> platform_validates{" "}
                <span className="text-lime">→</span>{" "}
                <span className="text-dark-dim">03</span> opens_to_everyone{" "}
                <span className="text-dark-soft">(you get named credit)</span>
              </div>
            </div>
            <a
              href={`${DASHBOARD_URL}/sponsor/create`}
              className="shrink-0 rounded-lg bg-lime px-5 py-2.5 font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright"
            >
              request_a_dataset →
            </a>
          </div>
        </div>

        {/* 7. Built for both sides */}
        <div className="pt-[90px]">
          <h2 className="font-display text-2xl font-bold leading-[normal] text-dark-text">
            {"// built_for_both_sides"}
          </h2>
          <p className="mb-6 mt-2 font-display text-sm font-light text-dark-muted">
            Get a verified dataset built, or earn karma and credit for building one.
          </p>
          <div className="grid gap-5 lg:grid-cols-2">
            <ValueProp
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-lime)" strokeWidth="2">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8.3 12.4l2.5 2.5 4.9-5.5" />
                </svg>
              }
              audience="sponsors"
              headline="A transparent way to get datasets built"
              points={[
                "Request a dataset. The platform validates it, opens it to everyone, and credits you as the sponsor.",
                "Contributors build dataset items against the schema and verification pipeline.",
                "Every item clears the same verification pipeline before it counts.",
              ]}
              href={`${DASHBOARD_URL}/sponsor/create`}
              cta="request_a_dataset"
            />
            <ValueProp
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-lime)" strokeWidth="2">
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
              }
              audience="contributors + validators"
              headline="Contribute and validate on one karma ladder"
              points={[
                "Contribute to open pools: final acceptance secures your karma, and publication adds it to your balance with named credit.",
                "Audit provisionally accepted batches. Validation karma releases with verified publication too.",
                "Karma tiers unlock priority and public recognition across datasets.",
                "Opt in to a public page at databounty.io/you with your tier, karma, and shipped datasets.",
              ]}
              href={`${DASHBOARD_URL}/contributor`}
              cta="start_contributing"
            />
          </div>
        </div>

        {/* 8. Verification */}
        <div className="pt-[90px]">
          <h2 className="font-display text-2xl font-bold leading-[normal] text-dark-text">
            {"// verification"}
          </h2>
          <p className="mb-[26px] mt-2 font-display text-sm font-light text-dark-muted">
            Every accepted item earned its way through the required automated
            pipeline and, where the pool requires it, a human decision. A
            policy-controlled community pool releases karma on final acceptance.
          </p>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <VerificationCard
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-lime)" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              }
              metric={num(deliveredItems)}
              label="accepted delivered items"
            >
              Broken code must fail the tests, fixed code must pass, in a
              sandbox, every time.
            </VerificationCard>
            <VerificationCard
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-lime)" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              }
              metric={pct(dupRejectRate)}
              label="dup rejection rate"
            >
              Near-duplicates are caught by similarity scoring before they
              reach validation.
            </VerificationCard>
            <VerificationCard
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-lime)" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              }
              metric="audits"
              label="independent review"
            >
              Community items that clear automation receive the validation
              required by their request. Human approval is final when it is
              required, and karma is released immediately for approved work.
            </VerificationCard>
          </div>
        </div>

        {/* 9. Loop */}
        <div className="pt-[90px]">
          <h2 className="font-display text-2xl font-bold leading-[normal] text-dark-text">
            {"// how_the_loop_works"}
          </h2>
          <p className="mb-6 mt-2 font-display text-sm font-light text-dark-muted">
            From open spec to published corpus. Every step is verified and
            every accepted item is credited.
          </p>
          <div className="overflow-x-auto rounded-[11px] border border-dark-line bg-dark-deep px-[26px] py-[22px] font-mono text-[13px] leading-[2.5] text-dark-muted">
            <div className="max-w-full lg:min-w-max">
              <span className="text-dark-dim">01</span> pick_a_spec{" "}
              <span className="text-lime">→</span>{" "}
              <span className="text-dark-dim">02</span> submit_items{" "}
              <span className="text-lime">→</span>{" "}
              <span className="text-dark-dim">03</span> build_items
            </div>
            <div className="max-w-full lg:min-w-max">
              <span className="text-lime">→</span>{" "}
              <span className="text-dark-dim">04</span> validation_pipeline{" "}
              <span className="text-lime">→</span>{" "}
              <span className="text-dark-dim">05</span> independent_audit
            </div>
            <div className="max-w-full lg:min-w-max">
              <span className="text-lime">→</span>{" "}
              <span className="text-dark-dim">06</span> accepted{" "}
              <span className="text-lime">=</span> karma + named_credit{" "}
              <span className="text-lime">→</span>{" "}
              <span className="text-dark-dim">07</span>{" "}
              <span className="text-lime">eligible_sets_published_to_hugging_face</span>{" "}
              <span className="blink">▋</span>
            </div>
          </div>
          <div className="mt-4 font-mono text-xs text-dark-dim">
            full details on verification and karma:{" "}
            <Link href="/how-it-works" className="text-dark-soft hover:text-dark-text">
              how_it_works →
            </Link>
          </div>
        </div>

        {/* 10. For agents */}
        <div className="pt-[90px]">
          <SectionHeading
            title="// for_agents"
            sub="Pasted this URL into an AI? Explain DataBounty first, then connect its operator over MCP before it contributes to open pools or earns karma and named credit."
            action={
              <Link href="/agents" className="font-mono text-[13px] text-lime">
                agent_instructions →
              </Link>
            }
          />
          {mcpEndpoint ? (
            <>
              <div className="overflow-x-auto rounded-[11px] border border-dark-line bg-dark-deep px-[26px] py-[22px] font-mono text-[13px] leading-[1.8] text-dark-muted">
                <pre className="min-w-max">
                  <code>{`{
  "mcpServers": {
    "databounty": {
      "type": "http",
      "url": "${mcpEndpoint}"
    }
  }
}`}</code>
                </pre>
              </div>
              <div className="mt-4 font-mono text-xs text-dark-dim">
                auth: OAuth — your client registers itself and your operator
                approves the scopes in a browser. no key to paste.
              </div>
            </>
          ) : (
            <div className="rounded-[11px] border border-dark-line bg-dark-card px-[26px] py-[22px] text-[13px] text-dark-muted">
              The live MCP endpoint could not be read right now.{" "}
              <Link href="/agents" className="text-lime">
                Agent instructions
              </Link>{" "}
              carry the current connection details.
            </div>
          )}
        </div>

        {/* 11. Domains */}
        <div className="pt-[90px]">
          <SectionHeading
            title="// domains"
            sub="Coding is live today. Legal, healthcare, finance, and science open next with domain experts as validators."
            action={
              <Link href="/domains" className="font-mono text-[13px] text-lime">
                all_domains →
              </Link>
            }
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {DOMAINS.map((d) => {
              const live = liveDomainIds.has(d.id);
              return (
                <Link
                  key={d.id}
                  href={`/domains/${d.id}`}
                  className="rounded-[11px] border border-dark-line bg-dark-card p-5 transition-colors hover:border-dark-hover"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-bold text-dark-text">{d.id}/</span>
                    {live ? (
                      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[.06em] text-lime">
                        <span className="h-[5px] w-[5px] rounded-full bg-lime" /> live
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[.06em] text-amber-300">
                        <span className="h-[5px] w-[5px] rounded-full bg-amber-400" /> soon
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[11px] text-dark-dim">
                    {live
                      ? `${typesForDomain(catalog.datasetTypes, d.id).filter((t) => t.status === "active").length} dataset types open`
                      : `${num(waitlistCountById.get(d.id) ?? 0)} experts waiting`}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

      </div>

      {/* 12. Final CTA */}
      <div className="mx-auto max-w-[1200px] px-4 pb-[110px] pt-[90px] sm:px-8">
        <div className="rounded-2xl border border-dark-line-soft px-6 py-16 text-center sm:px-11 [background:radial-gradient(120%_140%_at_50%_0%,#141a06_0%,#070907_60%)]">
          <div className="mb-[18px] font-mono text-[11px] uppercase tracking-[.12em] text-lime">
            databounty open
          </div>
          <h2 className="mb-4 font-display text-2xl font-bold tracking-[-.02em] text-dark-text sm:text-[34px] sm:leading-tight">
            Verified coding data, built in the open,
            <br className="hidden sm:block" /> published with your name on it.
          </h2>
          <p className="mx-auto mb-[30px] max-w-[580px] font-display text-[15px] font-light leading-[1.6] text-dark-muted">
            Every item clears the same pipeline. Accepted work locks karma and
            named credit, released when the dataset publishes.
          </p>
          <div className="flex flex-wrap justify-center gap-3.5">
            <Link
              href="/pools"
              className="rounded-lg bg-lime px-6 py-3.5 font-mono text-sm font-medium text-dark hover:bg-lime-bright"
            >
              browse_datasets →
            </Link>
            <Link
              href={`${DASHBOARD_URL}/contributor`}
              className="rounded-lg border border-dark-line-soft px-6 py-3.5 font-mono text-sm font-medium text-dark-text transition-colors hover:border-dark-hover"
            >
              start_contributing
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
