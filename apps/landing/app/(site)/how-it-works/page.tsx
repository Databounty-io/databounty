// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { CONTRIBUTOR_RANKS, VALIDATOR_RANKS } from "@/lib/format";
import { Icon, type IconName } from "@/components/icons";
import { DASHBOARD_HOME_URL, LANDING_URL } from "@/lib/urls";
import { BENCH_LIVE, COMMUNITY_CATALOG_NOTE } from "@/lib/launch";

export const metadata = {
  title: "How It Works",
  description:
    "How DataBounty's open community program works: contributors build dataset items, final acceptance secures karma, and verified datasets publish with eligible credit.",
  alternates: { canonical: `${LANDING_URL}/how-it-works` },
};

/* ---------- The loop ---------- */

const COMMUNITY_LOOP_STEPS: { title: string; detail: string }[] = [
  { title: "Choose an open pool", detail: "Browse the active community pools and read the live contract: field schema, verification profile, remaining capacity, and karma per final accepted item." },
  { title: "Submit useful items", detail: "There is no claim step for an open pool. Submit within the contract and declared generation method; capacity is checked by the server." },
  { title: "Validation and review", detail: "Items move through the dataset contract's declared checks. A required check that is unavailable or unresolved routes the item to review rather than being called verified." },
  { title: "Final acceptance", detail: "For a policy-controlled pool, a validator approval in full-human mode—or a clean required-pipeline result in automation-only mode—is final. Rejected or unresolved items do not qualify." },
  { title: "Immediate karma", detail: "Policy-controlled pools release karma as soon as the item is finally accepted; there is no sponsor dispute or shared hold window." },
  { title: "Asynchronous publication", detail: "Each accepted item is queued for Hugging Face synchronization without delaying karma. Published datasets can include contributor credit when eligible and not opted out." },
];

const COMMUNITY_LOOP_TOKENS: string[] = [
  "choose_open_pool",
  "submit_items",
  "contract_review",
  "final_acceptance",
  "shared_review_window",
  "verified_publication",
];

/* ---------- Verification layers ---------- */

const LAYERS: { icon: IconName; name: string; detail: string }[] = [
  {
    icon: "copy",
    name: "Duplicate wall",
    detail:
      "Each submission is similarity-scored against everything already accepted in the dataset, and across the platform. Near-duplicates are rejected before they cost anyone review time.",
  },
  {
    icon: "play",
    name: "Sandboxed test execution",
    detail:
      "For execution-verified types (debugging, implementation, SQL, regex, translation, performance) the contract is executable: broken code must fail the submitted tests and fixed code must pass all of them. If the checks do not hold in the sandbox, the item bounces automatically.",
  },
  {
    icon: "zap",
    name: "Contract-aware quality review",
    detail:
      "When the dataset contract requires an automated or human quality stage, its completed state is recorded with the item. An unavailable or unresolved required stage routes to review; it is never presented as a pass.",
  },
  {
    icon: "eye",
    name: "Human validation (when required)",
    detail:
      "A policy-controlled community pool is either full-human, where every automation-cleared item is reviewed, or automation-only, where the clean required pipeline is final. The sponsor does not choose coverage or a sampling rate.",
  },
];

/* ---------- FAQ ---------- */

const FAQ: { q: string; a: string }[] = [
  {
    q: "What is available today?",
    a: "The public launch is the community program. Each open pool shows its own contract and karma per final accepted item.",
  },
  {
    q: "What does karma mean?",
    a: "Karma is a reputation record. The exact amount is shown on the pool contract. In a policy-controlled pool it releases on final acceptance; the contract states any other lifecycle explicitly.",
  },
  {
    q: "How long does publication take?",
    a: "Hugging Face synchronization runs asynchronously after final acceptance. It does not delay karma in a policy-controlled pool; unresolved required checks still prevent final acceptance.",
  },
  {
    q: "Is AI-generated work allowed?",
    a: "Yes. AI assistance and full AI generation are allowed, with disclosure. We verify the output rather than the process: every item faces the same duplicate, execution, and validation checks regardless of how it was made. Each dataset publishes its generation mix.",
  },
  {
    q: "How is quality described honestly?",
    a: "The dataset contract names the checks that apply. DataBounty only presents an item as verified after the required stages are completed; otherwise it shows the precise pending, failed, or review state.",
  },
  {
    q: "Can I work with AI assistance?",
    a: "Yes, where the pool contract allows it. Declare the generation method honestly; every submission is evaluated against the same contract and evidence requirements.",
  },
];

/* ---------- Rank ladders ---------- */

const CONTRIBUTOR_UNLOCKS: string[] = [
  "1 active batch",
  "2 active batches",
  "30-item batches",
  "75-item capacity",
  "priority batch access",
  "senior capacity",
  "exclusive datasets",
  "architect capacity",
  "spec consultation invites",
  "top claim priority",
];

const VALIDATOR_UNLOCKS: string[] = [
  "small audit batches",
  "standard batches",
  "standard batches",
  "larger + bonus mult.",
  "full-audit datasets",
  "quality-lead access",
  "verifier duties",
  "dispute-panel access",
  "arbitration duties",
  "top bonus multiplier",
];

function SectionTitle({
  index,
  title,
  sub,
}: {
  index: string;
  title: string;
  sub: string;
}) {
  return (
    <div className="mb-[22px]">
      <div className="mb-1.5 font-mono text-xs text-lime">{index}</div>
      <h2 className="font-display text-[22px] font-bold leading-[normal] tracking-[-.02em] text-dark-text">
        {title}
      </h2>
      <p className="mt-1.5 max-w-2xl text-sm text-dark-muted">{sub}</p>
    </div>
  );
}

function RankColumn({
  label,
  ranks,
  unlocks,
}: {
  label: string;
  ranks: string[];
  unlocks: string[];
}) {
  return (
    <div className="card-dark p-5">
      <div className="mb-3.5 font-mono text-[11px] text-dark-soft">{label}</div>
      <div className="flex flex-col gap-2 font-mono text-xs">
        {ranks.map((rank, i) => (
          <div key={rank} className="flex justify-between gap-3">
            <span className={i === 2 ? "text-lime" : "text-dark-muted"}>
              <span className="text-dark-dim">{i + 1}</span> {rank}
            </span>
            {unlocks[i] && (
              <span className="text-right text-dark-dim">{unlocks[i]}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HowItWorksPage() {
  return (
    <div className="bg-dark text-dark-text">
      <div className="mx-auto max-w-[1200px] px-4 pb-[72px] pt-[60px] sm:px-8">
        {/* Intro */}
        <h1 className="max-w-3xl font-display text-[34px] font-bold leading-[normal] tracking-[-.03em] text-dark-text sm:text-[44px]">
          How DataBounty works
        </h1>
        <p className="mt-4 max-w-[680px] text-[15px] leading-relaxed text-dark-muted sm:text-base">
          DataBounty is a platform for open coding datasets. Sponsors request
          the work, contributors create the items, and validators audit
          quality. A contract-driven verification pipeline sits in the
          middle so that the platform reports what has actually completed.
          {BENCH_LIVE &&
            " Accepted work ships as open datasets and benchmarks, and every benchmark keeps a private held-out eval split."}
        </p>
        <p className="mt-3 max-w-[680px] text-[15px] leading-relaxed text-dark-muted sm:text-base">
          Coding is the live domain today; legal, healthcare, finance, and
          math/science are opening next.{" "}
          <Link
            href="/domains"
            className="font-mono text-[13px] text-lime hover:text-lime-bright"
          >
            see_all_domains →
          </Link>
        </p>

        {/* Launch state banner */}
        <div className="mt-8 flex gap-4 rounded-[10px] border border-dark-line-soft bg-lime/[0.04] p-[18px] sm:px-5">
          <Icon
            name="zap"
            size={16}
            className="mt-0.5 shrink-0 text-lime"
            strokeWidth={2}
          />
          <div>
            <h3 className="font-mono text-[13.5px] font-bold text-lime">
              Live today: open datasets, rewarded with karma

            </h3>
            <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-dark-muted">
              Submit to open pools directly. In a policy-controlled pool,
              final acceptance releases karma immediately and queues eligible
              work for Hugging Face synchronization. {COMMUNITY_CATALOG_NOTE}{" "}
              <Link
                href="/open"
                className="font-mono text-lime hover:text-lime-bright"
              >
                how_karma_works →
              </Link>
            </p>
          </div>
        </div>

        {/* 1. The loop */}
        <section className="mt-14">
          <SectionTitle
            index="01"
            title="The loop"
            sub="The active community path, from a live pool contract to verified publication."
          />

          <div className="mb-6 overflow-x-auto rounded-[11px] border border-dark-line bg-dark-deep px-[26px] py-[22px] font-mono text-[13px] leading-[2.5] text-dark-muted">
            <div className="min-w-max">
              {COMMUNITY_LOOP_TOKENS.map((tok, i, tokens) => (
                <span key={tok}>
                  <span className="text-dark-dim">
                    {String(i + 1).padStart(2, "0")}
                  </span>{" "}
                  <span className={i === tokens.length - 1 ? "text-lime" : ""}>{tok}</span>
                  {i < tokens.length - 1 ? (
                    <span className="text-lime">{" → "}</span>
                  ) : (
                    <>
                      {" "}
                      <span className="blink">▋</span>
                    </>
                  )}
                </span>
              ))}
            </div>
          </div>

          <ol className="grid gap-3 sm:grid-cols-2">
            {COMMUNITY_LOOP_STEPS.map((step, i) => (
              <li key={step.title} className="card-dark flex gap-4 p-5">
                <span className="mono-num shrink-0 pt-0.5 font-mono text-[11px] text-lime">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <div className="font-mono text-[13.5px] font-bold text-dark-text">
                    {step.title}
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-dark-muted">
                    {step.detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* 2. Verification model */}
        <section className="mt-14">
          <SectionTitle
            index="02"
            title="The verification model"
            sub="The contract defines the required checks. A missing or unresolved required check routes to review rather than a verification claim."
          />
          <div className="flex flex-col gap-3">
            {LAYERS.map((layer, i) => (
              <div
                key={layer.name}
                className="card-dark flex gap-4 p-[18px] sm:px-5"
              >
                <span className="shrink-0 pt-0.5 font-mono text-[11px] text-lime">
                  layer {i + 1}
                </span>
                <div>
                  <div className="flex items-center gap-2.5">
                    <Icon
                      name={layer.icon}
                      size={15}
                      className="text-lime"
                      strokeWidth={2}
                    />
                    <h3 className="font-mono text-[13.5px] font-bold text-dark-text">
                      {layer.name}
                    </h3>
                  </div>
                  <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-dark-muted">
                    {layer.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex gap-4 rounded-[10px] border border-dark-line-soft bg-lime/[0.04] p-[18px] sm:px-5">
            <Icon
              name="zap"
              size={16}
              className="mt-0.5 shrink-0 text-lime"
              strokeWidth={2}
            />
            <div>
              <h3 className="font-mono text-[13.5px] font-bold text-lime">
                AI-assisted creation is allowed
              </h3>
              <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-dark-muted">
                We verify the output rather than the process. Contributors may
                use AI tools, or generate items entirely with AI, as long as the generation
                method is disclosed on each submission. Every item faces the same
                pipeline either way, and each dataset publishes its human /
                AI-assisted / AI-generated mix so users know exactly what they
                are getting.
              </p>
            </div>
          </div>
        </section>

        {/* 3. Ranks */}
        <section className="mt-14">
          <SectionTitle
            index="03"
            title="Ranks"
            sub="Ranks are earned per role. Higher ranks unlock capacity and access, but they are never a substitute for passing the pipeline."
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <RankColumn
              label="</> builder_ranks (contributors)"
              ranks={CONTRIBUTOR_RANKS}
              unlocks={CONTRIBUTOR_UNLOCKS}
            />
            <RankColumn
              label="◇ auditor_ranks (validators)"
              ranks={VALIDATOR_RANKS}
              unlocks={VALIDATOR_UNLOCKS}
            />
          </div>
        </section>

        {/* 4. FAQ */}
        <section className="mt-14">
          <SectionTitle
            index="04"
            title="Common questions"
            sub="The short version of the rules everyone plays by."
          />
          <div className="grid gap-4 lg:grid-cols-2">
            {FAQ.map((item) => (
              <div key={item.q} className="card-dark p-5">
                <h3 className="font-mono text-[13.5px] font-bold text-dark-text">
                  {item.q}
                </h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-dark-muted">
                  {item.a}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="mt-14 flex flex-col items-start justify-between gap-5 rounded-[14px] border border-dark-line-soft px-8 py-11 sm:flex-row sm:items-center [background:radial-gradient(120%_140%_at_50%_0%,#141a06_0%,#070907_60%)]">
          <div>
            <div className="font-display text-xl font-bold leading-[normal] tracking-[-.02em] text-dark-text">
              Ready to see it in motion?
            </div>
            <p className="mt-1.5 text-sm text-dark-muted">
              Browse the open datasets or head to the dashboard to start.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <Link
              href="/pools"
              className="rounded-lg bg-lime px-5 py-3 font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright"
            >
              browse_datasets →
            </Link>
            <a
              href={DASHBOARD_HOME_URL}
              className="rounded-lg border border-dark-line-soft px-5 py-3 font-mono text-[13px] font-medium text-dark-text transition-colors hover:border-dark-hover"
            >
              open_dashboard
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
