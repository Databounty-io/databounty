// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import {
  CHANGELOG,
  CHANGELOG_KIND_LABEL,
  type ChangeKind,
} from "@/lib/changelog";
import { LANDING_URL } from "@/lib/urls";
import { safeJsonLd } from "@/lib/json-ld";

export const metadata: Metadata = {
  title: "Changelog",
  description:
    "Everything new on DataBounty — product updates, improvements, and fixes across the platform, Karma program, and contributor and validator workspaces.",
  alternates: { canonical: `${LANDING_URL}/changelog` },
  openGraph: {
    title: "DataBounty Changelog",
    description:
      "Product updates, improvements, and fixes across the DataBounty platform.",
    url: `${LANDING_URL}/changelog`,
    type: "website",
  },
};

const KIND_TONE: Record<ChangeKind, string> = {
  added: "border-lime/40 bg-lime/10 text-lime",
  changed: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  fixed: "border-amber-400/30 bg-amber-400/10 text-amber-300",
};

function KindTag({ kind }: { kind: ChangeKind }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] ${KIND_TONE[kind]}`}
    >
      {CHANGELOG_KIND_LABEL[kind]}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function versionAnchor(version: string): string {
  return `v${version.replace(/\./g, "-")}`;
}

function changelogJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "DataBounty Changelog",
    itemListElement: CHANGELOG.map((release, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "CreativeWork",
        name: `${release.version} — ${release.title}`,
        datePublished: release.date,
        abstract: release.summary,
      },
    })),
  };
}

export default function ChangelogPage() {
  return (
    <main className="bg-dark text-dark-text">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(changelogJsonLd()) }}
      />
      <section className="mx-auto max-w-[1000px] px-4 py-16 sm:px-8 lg:py-24">
        {/* Centered header */}
        <header className="mx-auto max-w-2xl text-center">
          <div className="font-mono text-xs text-lime">product/changelog</div>
          <h1 className="mt-4 font-display text-[36px] font-bold leading-tight text-dark-text sm:text-[52px]">
            Changelog
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-8 text-dark-muted">
            Every change to DataBounty as it ships — new features, improvements,
            and fixes across the platform, the open Karma program, and the
            contributor and validator workspaces.
          </p>
          <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-dark-line-soft bg-dark-card px-3.5 py-1.5 font-mono text-[11px] text-dark-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-lime pulse-soft" />
            {CHANGELOG.length} {CHANGELOG.length === 1 ? "entry" : "releases"} · newest
            first
          </div>
        </header>

        {/* Two-column developer layout: sticky version rail + content */}
        <ol className="mt-16 sm:mt-20">
          {CHANGELOG.map((release) => {
            const anchor = versionAnchor(release.version);
            return (
              <li
                key={release.version}
                id={anchor}
                className="grid scroll-mt-24 gap-x-12 gap-y-5 border-t border-dark-line py-12 first:border-t-0 first:pt-0 md:grid-cols-[220px_1fr] lg:py-14"
              >
                {/* Left rail — sticky version + date */}
                <div className="md:sticky md:top-24 md:self-start">
                  <a
                    href={`#${anchor}`}
                    className="group inline-flex items-center gap-2 font-mono text-xl font-bold text-dark-text"
                  >
                    <span className="text-lime opacity-0 transition-opacity group-hover:opacity-100">
                      #
                    </span>
                    {release.version}
                  </a>
                  {release.date && (
                    <div className="mt-1.5 font-mono text-xs text-dark-dim">
                      <time dateTime={release.date}>{formatDate(release.date)}</time>
                    </div>
                  )}
                </div>

                {/* Right — content card */}
                <div className="rounded-2xl border border-dark-line bg-dark-card p-6 sm:p-7">
                  <h2 className="font-display text-xl font-bold text-dark-text sm:text-2xl">
                    {release.title}
                  </h2>
                  {release.summary && (
                    <p className="mt-2 text-sm leading-7 text-dark-muted">
                      {release.summary}
                    </p>
                  )}

                  <ul className="mt-6 space-y-3.5 border-t border-dark-line pt-6">
                    {release.entries.map((entry, i) => (
                      <li key={i} className="flex items-start gap-3">
                        <KindTag kind={entry.kind} />
                        <span className="text-sm leading-7 text-dark-muted">
                          {entry.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            );
          })}
        </ol>

        <p className="mx-auto mt-16 max-w-2xl border-t border-dark-line pt-8 text-center font-mono text-xs text-dark-dim">
          Building on DataBounty? Follow this page for changes that affect
          datasets, karma, and the validation pipeline.
        </p>
      </section>
    </main>
  );
}
