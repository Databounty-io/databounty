"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import Link from "next/link";
import { Brandmark } from "@/components/brand";
import { Icon } from "@/components/icons";
import { AsyncState, Pill } from "@/components/ui";
import { API, withQuery } from "@/lib/api-endpoints";
import { apiClient } from "@/lib/api-client";
import type { DatasetPublication } from "@/lib/types";

type DatasetRow = {
  id: string;
  title: string;
  description?: string;
  domain?: string;
  finalAcceptedItems?: number;
  acceptedItems?: number;
  publication?: DatasetPublication | null;
};

/** Public, read-only index of datasets that have at least one real external
 * destination. Failed, queued, disabled, and unconfigured destinations are
 * intentionally absent: a catalog link is a claim that someone can open data. */
export default function DatasetsPage() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [datasets, setDatasets] = useState<DatasetRow[]>([]);

  useEffect(() => {
    // `bounties` is the real published-dataset listing GET /v1/community/catalog
    // serves (see the route's `listCommunityCatalog` call). `?? []` is a
    // defensive default only — a body without the field must read as "nothing
    // published", never as a crash.
    void apiClient
      .get<{ bounties?: DatasetRow[] }>(
        withQuery(API.community.catalog, { publicationStatus: "published", limit: 48 })
      )
      .then((response) => {
        setDatasets(response.bounties ?? []);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, []);

  return (
    <main className="min-h-screen bg-panel px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <Link href="/" className="inline-flex items-center gap-2 text-ink-soft">
          <Brandmark size={26} />
          <span className="font-mono text-sm">DataBounty</span>
        </Link>
        <header className="mt-12 max-w-3xl">
          <p className="micro-label text-lime-700">Open community datasets</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-ink sm:text-5xl">
            Published datasets, with source links.
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-ink-soft">
            Each destination below is backed by its own publication record. AIKosh links are explicitly marked when an administrator recorded the upload.
          </p>
        </header>
        <section className="mt-10">
          <AsyncState
            status={status === "ready" && !datasets.length ? "empty" : status}
            loadingText="Loading published datasets…"
            errorTitle="Could not load datasets"
            emptyTitle="No published datasets yet"
            emptyDescription="Completed community datasets will appear here once a destination URL is available."
          >
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {datasets.map((dataset) => (
                <DatasetCard dataset={dataset} key={dataset.id} />
              ))}
            </div>
          </AsyncState>
        </section>
      </div>
    </main>
  );
}

function DatasetCard({ dataset }: { dataset: DatasetRow }) {
  // Only destinations that actually resolved to a URL are linked — a catalog
  // link is a claim that someone can open the data. The catalog listing does
  // not carry per-target publication evidence (V1's `/v1/community/catalog`
  // does not either), so a row without it renders with no links rather than
  // with a link this page cannot back.
  const links =
    dataset.publication?.targets?.filter((target) => target.state === "published" && target.url) ?? [];
  return (
    <article className="card flex min-h-56 flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <Pill tone="success">published</Pill>
        <span className="font-mono text-xs text-ink-faint">
          {dataset.finalAcceptedItems ?? dataset.acceptedItems ?? 0} items
        </span>
      </div>
      <h2 className="mt-4 text-xl font-semibold text-ink">{dataset.title}</h2>
      {dataset.description && (
        <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-ink-soft">{dataset.description}</p>
      )}
      <div className="mt-auto space-y-2 pt-5">
        {links.map((target) => (
          <a
            key={target.target}
            href={target.url!}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm font-medium text-lime-700 hover:bg-lime-50"
          >
            <span>
              {target.name}
              {target.attested ? " · admin-attested" : ""}
            </span>
            <Icon name="external" size={14} />
          </a>
        ))}
      </div>
    </article>
  );
}
