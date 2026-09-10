// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { fetchLandingCatalog, fetchWaitlistCount } from "@/lib/public-data";
import {
  DOMAINS,
  TRUST_TIER_LABELS,
  typesForDomain,
  type DatasetType,
  type Domain,
} from "@/lib/dataset-types";

/* ---------- status pill ---------- */

function StatusPill({ live }: { live: boolean }) {
  return live ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(182,255,28,.25)] bg-[rgba(182,255,28,.08)] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[.06em] text-lime">
      <span className="h-[6px] w-[6px] rounded-full bg-lime" /> live
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[.06em] text-amber-300">
      <span className="h-[6px] w-[6px] rounded-full bg-amber-400" /> coming_soon
    </span>
  );
}

/* ---------- domain card ---------- */

function DomainCard({
  domain,
  types,
  waitlistCount,
}: {
  domain: Domain;
  types: ReturnType<typeof typesForDomain>;
  waitlistCount: number;
}) {
  const activeCount = types.filter((t) => t.status === "active").length;
  const live = activeCount > 0;

  return (
    <div className="card-dark relative flex min-w-0 flex-col p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Link
          href={`/domains/${domain.id}`}
          className="font-mono text-lg font-bold text-dark-text after:absolute after:inset-0 after:content-['']"
        >
          {domain.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}/
        </Link>
        <StatusPill live={live} />
      </div>
      <p className="mb-5 text-[13.5px] leading-relaxed text-dark-muted">
        {domain.tagline}
      </p>

      {live ? (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 font-mono">
            <div className="rounded-lg border border-dark-line bg-dark-deep px-3.5 py-2.5">
              <div className="text-[19px] font-bold text-lime">{activeCount}</div>
              <div className="micro-label mt-0.5 text-dark-dim">active_types</div>
            </div>
            <div className="rounded-lg border border-dark-line bg-dark-deep px-3.5 py-2.5">
              <div className="text-[19px] font-bold text-dark-text">
                {
                  types.filter(
                    (t) =>
                      t.status === "active" &&
                      t.trustTier === "execution_verified"
                  ).length
                }
              </div>
              <div className="micro-label mt-0.5 text-dark-dim">exec_verified</div>
            </div>
          </div>
          <div className="mt-auto flex items-center justify-between font-mono text-[13px]">
            <Link
              href="/pools"
              className="relative z-10 text-lime hover:text-lime-bright"
            >
              browse_datasets →
            </Link>
            <span className="text-dark-dim">view_domain →</span>
          </div>
        </>
      ) : (
        <>
          <div className="mb-5 flex flex-col gap-2">
            {types.length === 0 ? (
              <div className="rounded-lg border border-dark-line bg-dark-deep px-3.5 py-2.5 font-mono text-xs text-dark-dim">
                No draft dataset types published in this domain yet.
              </div>
            ) : (
              types.slice(0, 3).map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-dark-line bg-dark-deep px-3.5 py-2"
                >
                  <span className="truncate font-mono text-xs text-dark-soft">
                    {t.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-dark-dim">
                    {TRUST_TIER_LABELS[t.trustTier]}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="mt-auto flex items-center justify-between gap-3 font-mono text-[13px]">
            <Link
              href={`/domains/${domain.id}#waitlist`}
              className="relative z-10 text-amber-300 hover:text-amber-200"
            >
              join_expert_waitlist →
            </Link>
            <span className="text-[11px] text-dark-dim">
              {waitlistCount} {waitlistCount === 1 ? "expert" : "experts"} waiting
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- page ---------- */

export default async function DomainsPage() {
  const catalog = await fetchLandingCatalog().catch(() => ({ datasetTypes: [] as DatasetType[] }));
  // Same live check the "live" badge below uses (typesForDomain(...).some(active)),
  // so the waitlist fetch can never disagree with what the badge shows.
  const liveByDomain = new Map(
    DOMAINS.map((d) => [d.id, typesForDomain(catalog.datasetTypes, d.id).some((t) => t.status === "active")])
  );
  const waitlistCounts = await Promise.all(
    DOMAINS.map((d) => (liveByDomain.get(d.id) ? Promise.resolve(0) : fetchWaitlistCount(d.id)))
  );
  const countByDomain = new Map(DOMAINS.map((d, i) => [d.id, waitlistCounts[i]]));
  const liveCount = DOMAINS.filter((d) => liveByDomain.get(d.id)).length;
  const soonCount = DOMAINS.length - liveCount;

  return (
    <div className="bg-dark text-dark-text">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-8">
        {/* Hero */}
        <div className="flex flex-col items-center pb-14 pt-20 text-center">
          <div className="mb-6 font-mono text-xs text-lime">
            &gt; domains: {liveCount} live &nbsp;·&nbsp; {soonCount} opening{" "}
            <span className="blink">▋</span>
          </div>
          <h1 className="mb-5 max-w-[820px] font-display text-[34px] font-bold leading-[normal] tracking-[-.03em] sm:text-[44px]">
            Coding is <span className="bg-lime px-2.5 text-dark">live</span>{" "}
            today.
            <br />
            More verified marketplaces are opening.
          </h1>
          <p className="max-w-[600px] font-display text-lg font-light leading-[1.6] text-dark-muted">
            Legal, healthcare, finance, and science open next, with domain
            experts as validators. Join a waitlist and be first in when
            your domain opens.
          </p>
        </div>

        {/* Grid */}
        <div className="grid gap-4 pb-16 sm:grid-cols-2 lg:grid-cols-3">
          {DOMAINS.map((d) => (
            <DomainCard
              key={d.id}
              domain={d}
              types={typesForDomain(catalog.datasetTypes, d.id)}
              waitlistCount={countByDomain.get(d.id) ?? 0}
            />
          ))}
        </div>
      </div>

      {/* Footer strip */}
      <div className="border-t border-dark-line">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 px-4 py-6 font-mono text-xs text-dark-muted sm:px-8">
          <span>
            <span className="text-dark-dim">$</span> every domain ships with the
            same pipeline: dedupe → ai attribution → verification → human
            validation
          </span>
          <Link href="/how-it-works" className="text-lime hover:text-lime-bright">
            how_it_works →
          </Link>
        </div>
      </div>
    </div>
  );
}
