// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { Brandmark, Wordmark } from "@/components/brand";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-dark px-5 text-dark-text">
      <section className="w-full max-w-md rounded-xl border border-dark-line bg-dark-card p-8 text-center sm:p-10">
        <div className="flex items-center justify-center gap-2.5">
          <Brandmark size={30} />
          <Wordmark size="md" />
        </div>
        <p className="mt-10 font-mono text-xs uppercase tracking-[0.18em] text-dark-dim">404 · route unavailable</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">This admin page does not exist.</h1>
        <p className="mt-3 text-sm leading-6 text-dark-muted">Check the address, or return to the operations overview.</p>
        <Link href="/" className="mt-7 inline-flex rounded-lg bg-lime px-5 py-3 font-mono text-sm font-medium text-dark transition-colors hover:bg-lime-bright">
          return to admin
        </Link>
      </section>
    </main>
  );
}
