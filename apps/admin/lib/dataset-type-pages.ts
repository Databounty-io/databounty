"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { adminAuthedFetch } from "@/lib/admin-auth";

/* Exhaustive paging for GET /v1/admin/dataset-types.
 *
 * That route pages: it returns 50 rows by default, caps `limit` at 200, takes
 * `skip` (or `offset`) as the cursor, and reports the unpaged `total` next to
 * the page. A caller that asks for one fixed page and renders it as the whole
 * catalog silently drops every row past that ceiling — no error, no empty
 * state, nothing on screen to notice. The console's karma-rate table and the
 * sponsor-type review queues are configuration surfaces, so a type missing
 * from the list cannot be rated or decided at all; they need the complete set,
 * not the first page of it. */

/** The route's own cap — its `listQuery` Zod schema is `limit: …max(200)`, and
 *  asking for more is rejected with a 400 that would break the page outright. */
const PAGE_SIZE = 200;

/** Hard stop, so a server that keeps reporting a `total` it never delivers
 *  rows for cannot spin the browser forever. 40 × 200 = 8,000 rows, far above
 *  any real catalog. */
const MAX_PAGES = 40;

export interface AllDatasetTypes<T> {
  ok: true;
  datasetTypes: T[];
  /** The server's unpaged count for this query. */
  total: number;
  /** True when MAX_PAGES ran out with rows still outstanding. The list really
   *  is incomplete then, and it is reported as such rather than rendered as if
   *  it were whole. */
  truncated: boolean;
}

/** Failure carries the HTTP status back so each call site keeps its own error
 *  copy instead of inheriting a message from this module. */
export type DatasetTypesResult<T> = AllDatasetTypes<T> | { ok: false; status: number };

/**
 * Collect every dataset type matching `query` (the filter params — `origin`,
 * `status`, … — without `limit`/`skip`, which this owns).
 */
export async function fetchAllDatasetTypes<T>(query = ""): Promise<DatasetTypesResult<T>> {
  const datasetTypes: T[] = [];
  let total = 0;
  let truncated = false;

  /** One report for either way this sweep can end below the server's own
   *  count. Both are anomalies, so neither is allowed to pass as complete. */
  const reportShortfall = (why: string) => {
    truncated = true;
    console.warn(
      `[admin/dataset-types] ${why} — holding ${datasetTypes.length} of ${total} reported rows` +
        `${query ? ` (query: ${query})` : ""}. The rendered list is INCOMPLETE.`
    );
  };

  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      reportShortfall(`stopped at the ${MAX_PAGES}-page ceiling`);
      break;
    }

    const params = new URLSearchParams(query);
    params.set("limit", String(PAGE_SIZE));
    params.set("skip", String(datasetTypes.length));
    const res = await adminAuthedFetch(`/v1/admin/dataset-types?${params.toString()}`);
    if (!res.ok) return { ok: false, status: res.status };

    const body = (await res.json()) as { datasetTypes?: T[]; total?: number };
    const rows = body.datasetTypes ?? [];
    total = body.total ?? datasetTypes.length + rows.length;
    datasetTypes.push(...rows);

    // Having the whole count is the clean exit, and it is checked first so the
    // exactly-one-full-page case ends without complaint.
    if (datasetTypes.length >= total) break;
    // The route honours `limit` (it 400s rather than clamping), so a short page
    // is the last page — which means the server ended this list BELOW its own
    // reported total. Whatever the cause (a clamped limit, rows deleted
    // mid-sweep), the list is short and saying so beats rendering it as whole.
    if (rows.length < PAGE_SIZE) {
      reportShortfall("the server ended the list below its reported total");
      break;
    }
  }

  return { ok: true, datasetTypes, total, truncated };
}

interface UseAllDatasetTypesOptions {
  /** Background poll interval in ms. Defaults to 30s; pass 0 to disable. */
  pollMs?: number;
  /** Error text surfaced when a page request fails or returns non-OK. */
  errorMessage?: string;
}

/**
 * Live wrapper around the loop above, shaped exactly like `useAdminResource`
 * (data / loading / error / refresh, refetching on focus, tab visibility and a
 * light poll) so a call site can swap one for the other. It cannot simply wrap
 * that hook: `useAdminResource` issues exactly one request for one path, which
 * is the truncation this module exists to remove.
 */
export function useAllDatasetTypes<T>(
  query: string,
  { pollMs = 30_000, errorMessage = "Data is unavailable." }: UseAllDatasetTypesOptions = {}
) {
  const [data, setData] = useState<AllDatasetTypes<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    // Focus and visibilitychange commonly arrive as a pair. Reuse the active
    // refresh for this hook instead of issuing an identical second sweep.
    if (inFlight.current) return inFlight.current;
    const request = (async () => {
      try {
        const result = await fetchAllDatasetTypes<T>(query);
        if (!result.ok) throw new Error(errorMessage);
        setData(result);
        setError("");
      } catch {
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    })();
    inFlight.current = request;
    void request.finally(() => {
      if (inFlight.current === request) inFlight.current = null;
    });
    return request;
  }, [query, errorMessage]);

  useEffect(() => {
    void refresh();

    const onFocus = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    const timer =
      pollMs > 0
        ? setInterval(() => {
            if (document.visibilityState === "visible") void refresh();
          }, pollMs)
        : null;

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearInterval(timer);
    };
  }, [refresh, pollMs]);

  return { data, loading, error, refresh };
}
