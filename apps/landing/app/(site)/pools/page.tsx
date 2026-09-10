// SPDX-License-Identifier: Apache-2.0

import { redirect } from "next/navigation";
import { fetchPoolsPage } from "@/lib/public-data";
import { CATEGORY_LABELS } from "@/lib/format";
import type { DatasetCategory } from "@/lib/types";
import PoolsView from "./view";

const CATEGORIES = Object.keys(CATEGORY_LABELS) as DatasetCategory[];

function isCategory(value: string | undefined): value is DatasetCategory {
  return !!value && (CATEGORIES as string[]).includes(value);
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

export const PAGE_SIZE = 12;

/**
 * Public pool browser. Search, category/language/type filters and the page
 * number all live in the URL and are forwarded to the API — the page never
 * fetches everything and filters or slices in the browser, so the result stays
 * correct (and cheap) however many pools exist.
 */
export default async function PoolsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const categoryParam = one(sp.category);
  const filter: DatasetCategory | "all" = isCategory(categoryParam) ? categoryParam : "all";
  const q = one(sp.q);
  const language = one(sp.language);
  const datasetTypeId = one(sp.type);
  // Strict integer parse: Number() accepts "1e9" and "1.5", which then became
  // an offset the API rejects — surfaced to the reader as a fake outage.
  const pageRaw = one(sp.page);
  const page = pageRaw && /^[0-9]{1,7}$/.test(pageRaw) && Number(pageRaw) >= 1 ? Number(pageRaw) : 1;

  const result = await fetchPoolsPage({
    q,
    category: filter === "all" ? undefined : filter,
    language,
    datasetTypeId,
    page,
    pageSize: PAGE_SIZE,
  });

  // A page past the end was clamped to the real last page. Redirect so the URL
  // matches what is rendered — otherwise Back, refresh and a copied link all
  // disagree with the screen.
  // Also fires for a non-canonical param ("abc", "0", "-1", "007"): those
  // silently coerce to page 1, so the URL kept a value the page ignored.
  const canonicalPage = result.page > 1 ? String(result.page) : undefined;
  if (!result.loadError && (result.page !== page || (pageRaw ?? undefined) !== canonicalPage)) {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (filter !== "all") next.set("category", filter);
    if (language) next.set("language", language);
    if (datasetTypeId) next.set("type", datasetTypeId);
    if (result.page > 1) next.set("page", String(result.page));
    const qs = next.toString();
    redirect(qs ? `/pools/?${qs}` : "/pools/");
  }

  return (
    <PoolsView
      result={result}
      filter={filter}
      q={q ?? ""}
      language={language ?? ""}
      datasetTypeId={datasetTypeId ?? ""}
    />
  );
}
