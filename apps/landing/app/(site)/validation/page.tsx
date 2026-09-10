// SPDX-License-Identifier: Apache-2.0

import { redirect } from "next/navigation";
import { fetchValidationPage } from "@/lib/public-data";
import ValidationView from "./view";

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.trim() || undefined;
}

export const PAGE_SIZE = 12;

/**
 * The public validation queue: pools with contributions already submitted and
 * waiting on a human validator. Search and paging are URL params handled by
 * the API, same as the pool browser.
 */
export default async function ValidationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = one(sp.q);
  const pageRaw = one(sp.page);
  const page = pageRaw && /^[0-9]{1,7}$/.test(pageRaw) && Number(pageRaw) >= 1 ? Number(pageRaw) : 1;

  const result = await fetchValidationPage({ q, page, pageSize: PAGE_SIZE });

  // A page past the end was clamped to the real last page. Redirect so the URL
  // matches the screen — otherwise Back, refresh and a copied link all
  // disagree with what is rendered. Same contract as /pools and /delivered.
  // Also fires for a non-canonical param ("abc", "0", "-1", "007"): those
  // silently coerce to page 1, so the URL kept a value the page ignored.
  const canonicalPage = result.page > 1 ? String(result.page) : undefined;
  if (!result.loadError && (result.page !== page || (pageRaw ?? undefined) !== canonicalPage)) {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (result.page > 1) next.set("page", String(result.page));
    const qs = next.toString();
    redirect(qs ? `/validation/?${qs}` : "/validation/");
  }

  return <ValidationView result={result} q={q ?? ""} />;
}
