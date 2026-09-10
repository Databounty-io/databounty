// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { DASHBOARD_URL } from "@/lib/urls";
import { SectionHeading } from "@/components/section-heading";
import { EmptyState } from "@/components/empty-state";
import { WaitlistForm } from "./waitlist-form";
import {
  DOMAINS,
  TRUST_TIER_LABELS,
  typesForDomain,
  type DatasetType,
  type DomainId,
  type TrustTier,
} from "@/lib/dataset-types";

/* ---------- shared bits ---------- */

const TIER_PILL: Record<TrustTier, string> = {
  execution_verified:
    "border border-[rgba(182,255,28,.25)] bg-[rgba(182,255,28,.08)] text-lime",
  llm_verified: "border border-amber-400/25 bg-amber-400/10 text-amber-300",
  expert_audited:
    "border border-emerald-400/25 bg-emerald-400/10 text-emerald-400",
};

function TierPill({ tier }: { tier: TrustTier }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ${TIER_PILL[tier]}`}
    >
      {TRUST_TIER_LABELS[tier]}
    </span>
  );
}

/* ---------- per-domain credentialing copy ---------- */

const CREDENTIAL_NOTES: Record<DomainId, { who: string; how: string }> = {
  coding: {
    who: "Ranked validators with a track record of confirmed issues.",
    how: "Rank is earned on-platform; GitHub and LinkedIn on your profile boost your standing.",
  },
  legal: {
    who: "Licensed attorneys in the relevant jurisdiction.",
    how: "Bar registration checked against public rolls; LinkedIn on your profile cross-referenced.",
  },
  healthcare: {
    who: "Verified medical professionals: physicians, specialists, clinical researchers.",
    how: "Medical license checked against registries; ORCID and Google Scholar on your profile cross-referenced.",
  },
  finance: {
    who: "Practicing quants and licensed CPAs.",
    how: "CPA license and employment history verified; LinkedIn and Kaggle on your profile cross-referenced.",
  },
  science: {
    who: "Advanced-degree mathematicians and physicists.",
    how: "Degrees and publication record verified via ORCID and Google Scholar on your profile.",
  },
};

/* ---------- coming-soon: type teaser card ---------- */

function TeaserTypeCard({ type }: { type: DatasetType }) {
  return (
    <div className="card-dark p-6">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="font-mono text-[15px] font-bold text-dark-text">
          {type.name}
        </div>
        <TierPill tier={type.trustTier} />
      </div>
      <p className="mb-5 text-[13px] leading-relaxed text-dark-muted">
        {type.description}
      </p>

      <div className="micro-label mb-2 text-dark-dim">
        each accepted item contains
      </div>
      <div className="mb-5 flex flex-col gap-1.5">
        {type.fields.map((f) => (
          <div key={f.key} className="flex items-center gap-2 font-mono text-xs">
            <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-lime" />
            <span className="text-dark-text">{f.key}</span>
            <span className="text-[10px] text-dark-dim">
              {f.role}
              {f.required ? " · required" : ""}
            </span>
          </div>
        ))}
      </div>

      <div className="micro-label mb-2 text-dark-dim">verification pipeline</div>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-dark-soft">
        {type.verification.pipeline.map((p, i) => (
          <span key={p} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-dark-dim">→</span>}
            <span className="rounded bg-[#12160f] px-1.5 py-0.5 text-dark-text">
              {p}
            </span>
          </span>
        ))}
      </div>
      {type.verification.executionEnv && (
        <div className="mt-2 font-mono text-[10px] text-dark-dim">
          sandbox: {type.verification.executionEnv}
        </div>
      )}
    </div>
  );
}

/* ---------- coding: active type row ---------- */

function CodingTypeRow({ type }: { type: DatasetType }) {
  return (
    <Link
      href={`/pools?category=${type.category}`}
      className="card-dark flex min-w-0 items-center justify-between gap-4 p-5"
    >
      <div className="min-w-0">
        <div className="font-mono text-sm font-bold text-dark-text">
          {type.name}
        </div>
        <p className="mt-1 truncate text-[13px] text-dark-muted">
          {type.description}
        </p>
      </div>
      <TierPill tier={type.trustTier} />
    </Link>
  );
}

/* ---------- coding view ---------- */

function CodingView({ datasetTypes }: { datasetTypes: DatasetType[] }) {
  const domain = DOMAINS.find((d) => d.id === "coding")!;
  const active = typesForDomain(datasetTypes, "coding").filter(
    (t) => t.status === "active"
  );

  return (
    <div className="mx-auto max-w-[1200px] px-4 pb-16 sm:px-8">
      <div className="pb-12 pt-16">
        <div className="mb-5 flex items-center gap-3">
          <h1 className="font-mono text-4xl font-bold tracking-[-.03em]">
            coding/
          </h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(182,255,28,.25)] bg-[rgba(182,255,28,.08)] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[.06em] text-lime">
            <span className="h-[6px] w-[6px] rounded-full bg-lime" /> live
          </span>
        </div>
        <p className="max-w-[640px] font-display text-lg font-light leading-[1.6] text-dark-muted">
          {domain.tagline} Every item here runs dedupe, an AI-attribution scan
          and sandboxed execution, then goes to a human validator for the final
          acceptance decision. Automated LLM review is an additional stage that
          runs only while the platform switch for it is on — each dataset type
          below lists the stages it declares.
        </p>
        <p className="mt-3 font-mono text-[13px] text-dark-soft">
          {domain.expertPitch}
        </p>
      </div>

      <SectionHeading
        title="// active_dataset_types"
        sub={`${active.length} types are open for new community requests right now.`}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {active.map((t) => (
          <CodingTypeRow key={t.id} type={t} />
        ))}
      </div>

      <div className="mt-12 flex flex-wrap gap-3.5">
        <Link
          href="/pools"
          className="rounded-lg bg-lime px-6 py-3.5 font-mono text-sm font-medium text-dark transition-colors hover:bg-lime-bright"
        >
          browse_datasets →
        </Link>
        <Link
          href="/how-it-works"
          className="rounded-lg border border-dark-line-soft px-6 py-3.5 font-mono text-sm font-medium text-dark-text transition-colors hover:border-dark-hover"
        >
          how_it_works
        </Link>
      </div>
    </div>
  );
}

/* ---------- coming-soon view ---------- */

function ComingSoonView({
  id,
  datasetTypes,
  waitlistCount,
}: {
  id: DomainId;
  datasetTypes: DatasetType[];
  waitlistCount: number;
}) {
  const domain = DOMAINS.find((d) => d.id === id)!;
  const types = typesForDomain(datasetTypes, id);
  const cred = CREDENTIAL_NOTES[id];

  return (
    <div className="mx-auto max-w-[1200px] px-4 pb-16 sm:px-8">
      {/* Hero */}
      <div className="pb-12 pt-16">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-4xl font-bold tracking-[-.03em]">
            {domain.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}/
          </h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[.06em] text-amber-300">
            <span className="h-[6px] w-[6px] rounded-full bg-amber-400" />{" "}
            coming_soon
          </span>
        </div>
        <p className="max-w-[640px] font-display text-lg font-light leading-[1.6] text-dark-muted">
          {domain.tagline}
        </p>
        <p className="mt-3 max-w-[640px] font-mono text-[13px] text-lime">
          &gt; {domain.expertPitch}
        </p>
      </div>

      {/* What datasets will look like */}
      <SectionHeading
        title="// what_datasets_will_look_like_here"
        sub="Planned dataset types for this domain. Every item is verified before it's accepted."
      />
      {types.length === 0 ? (
        <EmptyState
          variant="empty"
          title="No draft datasets published in this domain yet."
          description="Planned dataset types will show up here once they're added to the catalog."
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {types.map((t) => (
              <TeaserTypeCard key={t.id} type={t} />
            ))}
          </div>
          <p className="mt-4 font-mono text-xs leading-relaxed text-dark-dim">
            verification here: dedupe + LLM review + mandatory audit.
          </p>
        </>
      )}

      {/* Validator credentialing */}
      <div className="mt-12 card-dark p-6">
        <div className="micro-label mb-3 text-dark-dim">
          who validates in this domain
        </div>
        <p className="text-[14px] font-bold text-dark-text">{cred.who}</p>
        <p className="mt-2 max-w-[680px] text-[13px] leading-relaxed text-dark-muted">
          {cred.how} Connect credential sources on your{" "}
          <a
            href={`${DASHBOARD_URL}/profile`}
            className="text-lime hover:text-lime-bright"
          >
            profile
          </a>{" "}
          now. Verified experts get first access to validator pools when the
          domain opens.
        </p>
      </div>

      {/* Waitlist */}
      <div
        id="waitlist"
        className="mt-12 rounded-2xl border border-dark-line-soft px-6 py-12 text-center sm:px-11 [background:radial-gradient(120%_140%_at_50%_0%,#141a06_0%,#070907_60%)]"
      >
        <div className="mb-4 font-mono text-[11px] uppercase tracking-[.12em] text-lime">
          expert waitlist
        </div>
        <WaitlistForm domainId={id} domainName={domain.name} initialCount={waitlistCount} />
        <div className="mt-8 border-t border-dark-line pt-5 font-mono text-[11px] text-dark-dim">
          sponsors: want this domain sooner?{" "}
          <a
            href={`${DASHBOARD_URL}/sponsor/create`}
            className="text-dark-soft hover:text-dark-text"
          >
            request a dataset →
          </a>
        </div>
      </div>
    </div>
  );
}

/* ---------- page view router ---------- */

export default function DomainView({
  id,
  datasetTypes,
  waitlistCount,
}: {
  id: string;
  datasetTypes: DatasetType[];
  waitlistCount: number;
}) {
  const domain = DOMAINS.find((d) => d.id === id);

  return (
    <div className="bg-dark text-dark-text">
      <div className="mx-auto max-w-[1200px] px-4 pt-8 sm:px-8">
        <Link
          href="/domains"
          className="font-mono text-[13px] text-dark-soft hover:text-dark-text"
        >
          ← all_domains
        </Link>
      </div>
      {!domain ? (
        <div className="mx-auto max-w-[1200px] px-4 py-24 text-center sm:px-8">
          <div className="mb-4 font-mono text-xs text-dark-dim">
            &gt; err: domain_not_found <span className="blink">▋</span>
          </div>
          <h1 className="mb-4 font-display text-3xl font-bold leading-[normal] tracking-[-.03em]">
            No such domain.
          </h1>
          <p className="mb-8 text-dark-muted">
            The domain you&apos;re looking for isn&apos;t on the map yet.
          </p>
          <Link
            href="/domains"
            className="rounded-lg bg-lime px-6 py-3.5 font-mono text-sm font-medium text-dark transition-colors hover:bg-lime-bright"
          >
            back_to_domains →
          </Link>
        </div>
      ) : typesForDomain(datasetTypes, domain.id).some((t) => t.status === "active") ? (
        <CodingView datasetTypes={datasetTypes} />
      ) : (
        <ComingSoonView id={domain.id} datasetTypes={datasetTypes} waitlistCount={waitlistCount} />
      )}
    </div>
  );
}
