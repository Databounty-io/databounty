"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";

export default function ProfileError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col items-center px-4 py-24 text-center">
      <h1 className="font-display text-3xl font-bold text-dark-text">This page didn&apos;t load</h1>
      <p className="mt-3 text-dark-muted">
        We couldn&apos;t reach DataBounty just now, so we can&apos;t show this profile. It hasn&apos;t gone anywhere —
        try again in a moment.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-lime px-5 py-[11px] font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright"
        >
          try again →
        </button>
        <Link
          href="/"
          className="rounded-lg border border-dark-line px-5 py-[11px] font-mono text-[13px] text-dark-muted transition-colors hover:border-dark-hover hover:text-dark-text"
        >
          back to DataBounty
        </Link>
      </div>
    </main>
  );
}
