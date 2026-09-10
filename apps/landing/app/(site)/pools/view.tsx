"use client";

// SPDX-License-Identifier: Apache-2.0

import { CATEGORY_LABELS, num } from "@/lib/format";
import { DASHBOARD_URL } from "@/lib/urls";
import type { DatasetCategory } from "@/lib/types";
import type { PoolsPage } from "@/lib/public-data";
import { PoolCard } from "@/components/pool-card";
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

export default function PoolsView({
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
  const total = result.total;
  return (
    <ListingBrowser
      basePath="/pools"
      heading="Open work"
      countSuffix="open"
      noun={{ one: "spec", many: "open work" }}
      headerAside={<AutoRefresh />}
      lead={
        total === null ? (
          <>
            The number of open specs is unavailable right now. Karma per accepted item, published to
            Hugging Face under open licenses.
          </>
        ) : (
          <>
            {num(total)} community {total === 1 ? "spec" : "specs"} accepting contributions
            {filter !== "all" && <> in {CHIP_LABELS[filter]}</>}. Karma per accepted item, published
            to Hugging Face under open licenses. Every item clears the same verification pipeline.
          </>
        )
      }
      result={result}
      q={q}
      searchLabel="Search open work"
      searchPlaceholder="search title or description…"
      chips={{
        param: "category",
        value: filter,
        allLabel: "all",
        options: CATEGORIES.map((c) => ({ value: c, label: CHIP_LABELS[c] })),
      }}
      selects={[
        {
          id: "pool-type",
          label: "Dataset type",
          param: "type",
          value: datasetTypeId,
          allLabel: "all dataset types",
          options: result.datasetTypes.map((t) => ({ value: t.id, label: t.name })),
        },
        {
          id: "pool-language",
          label: "Language",
          param: "language",
          value: language,
          allLabel: "all languages",
          caseInsensitive: true,
          options: result.languages.map((l) => ({ value: l, label: l })),
        },
      ]}
      renderCard={(b) => <PoolCard key={b.id} pool={b} />}
      noResults={{
        title: "No open work matches those filters.",
        description: "Try a broader search, a different category, or clear the filters to browse everything open.",
      }}
      empty={{
        title: "No open work right now.",
        description: "New community specs open regularly. Check back soon, or ask for the one you're missing.",
        action: { label: "request_a_dataset", href: `${DASHBOARD_URL}/sponsor/create`, external: true },
      }}
    />
  );
}
