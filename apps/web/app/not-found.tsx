// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { Brandmark, Wordmark } from "@/components/brand";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-panel px-5">
      <section className="card w-full max-w-md p-8 text-center sm:p-10">
        <div className="flex items-center justify-center gap-2.5">
          <Brandmark size={30} />
          <Wordmark size="md" />
        </div>
        <p className="mt-10 font-mono text-xs uppercase tracking-[0.18em] text-ink-faint">404 · page not found</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink">This page is not here.</h1>
        <p className="mt-3 text-sm leading-6 text-ink-soft">The link may be outdated, or the page may have moved.</p>
        <Link href="/" className="mt-7 inline-flex rounded-lg bg-ink px-5 py-3 font-mono text-sm font-medium text-white transition-colors hover:bg-black">
          return to dashboard
        </Link>
      </section>
    </main>
  );
}
