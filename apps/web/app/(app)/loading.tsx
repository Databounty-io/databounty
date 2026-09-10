// SPDX-License-Identifier: Apache-2.0

import { Brandmark } from "@/components/brand";

export default function Loading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center px-4">
      <div className="card w-full max-w-sm px-8 py-9 text-center">
        <div className="flex justify-center">
          <Brandmark size={32} className="animate-pulse" />
        </div>
        <p className="mt-5 font-mono text-sm text-ink-soft">Loading…</p>
      </div>
    </div>
  );
}
