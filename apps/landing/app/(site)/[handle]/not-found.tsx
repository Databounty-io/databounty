// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";

export default function ProfileNotFound() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col items-center px-4 py-24 text-center">
      <h1 className="font-display text-3xl font-bold text-dark-text">Profile not found</h1>
      <p className="mt-3 text-dark-muted">
        This page is private, unavailable, or doesn&apos;t exist.
      </p>
      <Link
        href="/"
        className="mt-8 rounded-lg bg-lime px-5 py-[11px] font-mono text-[13px] font-medium text-dark transition-colors hover:bg-lime-bright"
      >
        back to DataBounty →
      </Link>
    </main>
  );
}
