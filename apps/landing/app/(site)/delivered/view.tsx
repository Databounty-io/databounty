"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { CATEGORY_LABELS, num } from "@/lib/format";
import { DASHBOARD_URL } from "@/lib/urls";
import type { DatasetCategory } from "@/lib/types";
import type { PoolsPage } from "@/lib/public-data";
import { DeliveredCard } from "@/components/pool-card";
import { AutoRefresh } from "@/components/auto-refresh";
import { ListingBrowser } from "@/components/listing-browser";

const CATEGORIES = Object.keys(CATEGORY_LABELS) as DatasetCategory[];

const CHIP_LABELS: Record<DatasetCategory, string> = {
  debugging: "debugging",
  implementation: "function/feature",
  test_generation: "test_generation",
  error_diagnosis: "error_diagnosis",
  migration: "migration/refactor",
};

export default function DeliveredView({
  result,
  filter,
  q,
  language,
  datasetTypeId,
}: {
  result: PoolsPage;
  filter: DatasetCategory | "all";
  q: string;
  language: string;
  datasetTypeId: string;
}) {
  const { bounties, total } = result;

  // These describe the page in view, not the whole corpus — the API returns
  // one page, so labelling them "all delivered" would be a claim the data
  // does not support.
  const pageItems = bounties.reduce((sum, b) => sum + b.acceptedItems, 0);

  // Replaced the old "dup rejection rate (page)" / "avg llm pass rate (page)"
  // tiles: those averaged `duplicateRate`/`llmPassRate`, which this catalog
  // does not publish per pool, so both tiles read "—" on every page that ever
  // loaded them — dead weight with no path to ever showing a number. This
  // total is a real, always-known rollup (every community pool tracks
  // flagged/rejected/failedAutomatedChecks), and it directly answers the
  // question a reader has looking at submitted_items vs accepted_items on the
  // cards below: where did the rest of the submissions go.
  const pageRejected = bounties.reduce((sum, b) => {
    const progress = b.communityProgress;
    if (!progress) return sum;
    return sum + (progress.rejected ?? 0) + (progress.flagged ?? 0) + (progress.failedAutomatedChecks ?? 0);
  }, 0);

  return (
    <>
      <ListingBrowser
        basePath="/delivered"
        heading="Delivered datasets"
        countSuffix="delivered"
        noun={{ one: "corpus", many: "delivered datasets" }}
        headerAside={<AutoRefresh />}
        lead={
          total === null ? (
            <>The number of delivered corpora is unavailable right now.</>
          ) : (
            <>
              {num(total)} delivered {total === 1 ? "corpus" : "corpora"} with public quality stats,
              available on Hugging Face under open licenses. Every accepted item cleared this
              platform&apos;s verification pipeline; per-pool pass rates are shown on each dataset&apos;s
              own page where they were measured.
            </>
          )
        }
        result={result}
        q={q}
        searchLabel="Search delivered datasets"
        searchPlaceholder="search title or description…"
        chips={{
          param: "category",
          value: filter,
          allLabel: "all",
          options: CATEGORIES.map((c) => ({ value: c, label: CHIP_LABELS[c] })),
        }}
        selects={[
          {
            id: "delivered-type",
            label: "Dataset type",
            param: "type",
            value: datasetTypeId,
            allLabel: "all dataset types",
            options: result.datasetTypes.map((t) => ({ value: t.id, label: t.name })),
          },
          {
            id: "delivered-language",
            label: "Language",
            param: "language",
            value: language,
            allLabel: "all languages",
            caseInsensitive: true,
            options: result.languages.map((l) => ({ value: l, label: l })),
          },
        ]}
        beforeResults={
          bounties.length > 0 ? (
            <div className="mb-9 grid grid-cols-3 overflow-hidden rounded-[11px] border border-dark-line font-mono">
              {[
                { label: "datasets on this page", value: num(bounties.length) },
                { label: "items accepted (page)", value: num(pageItems) },
                { label: "items rejected (page)", value: num(pageRejected) },
              ].map((s, i, arr) => (
                <div
                  key={s.label}
                  className={`bg-dark-card p-5 ${i < arr.length - 1 ? "sm:border-r sm:border-dark-line" : ""} border-dark-line max-sm:border-b max-sm:[&:nth-child(odd)]:border-r`}
                >
                  <div className="micro-label mb-2 text-dark-dim">{s.label}</div>
                  <div className="text-xl font-bold text-dark-text">{s.value}</div>
                </div>
              ))}
            </div>
          ) : null
        }
        renderCard={(b) => <DeliveredCard key={b.id} pool={b} />}
        noResults={{
          title: "No delivered datasets match those filters.",
          description: "Try a broader search, a different category, or clear the filters to see everything delivered.",
        }}
        empty={{
          title: "No datasets have finished yet.",
          description:
            "Community specs in progress publish here as soon as they reach their target items and pass validation.",
          action: { label: "browse_open_work", href: "/pools" },
        }}
      />

      {/* Request banner */}
      <div className="mx-auto max-w-[1200px] px-4 pb-[72px] sm:px-8">
        <div className="rounded-xl border border-dark-line-soft bg-dark-deep p-7 text-center">
          <h2 className="mb-2 font-display text-xl font-bold leading-[normal] text-dark-text">
            Need a dataset like these for your team?
          </h2>
          <p className="mx-auto mb-5 max-w-[540px] text-sm text-dark-muted">
            Request a dataset spec with your exact schema, tests, and acceptance criteria. The
            community builds it, we verify every item.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <a
              href={`${DASHBOARD_URL}/sponsor/create`}
              className="rounded-lg bg-lime px-5 py-2.5 font-mono text-xs font-medium text-dark hover:bg-lime-bright"
            >
              request_a_dataset →
            </a>
            <Link
              href="/how-it-works"
              className="rounded-lg border border-dark-line px-5 py-2.5 font-mono text-xs font-medium text-dark-text hover:border-dark-hover"
            >
              how_verification_works
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
