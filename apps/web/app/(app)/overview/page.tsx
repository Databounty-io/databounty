"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Brandmark } from "@/components/brand";
import { useDemo } from "@/lib/store";
import { resolveHomeRoute } from "@/lib/home-route";

export default function RetiredOverviewPage() {
  const router = useRouter();
  const { authReady, persona } = useDemo();

  useEffect(() => {
    if (!authReady) return;
    router.replace(resolveHomeRoute(persona));
  }, [authReady, persona, router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="card w-full max-w-sm px-8 py-9 text-center">
        <div className="flex justify-center">
          <Brandmark size={32} className="pulse-soft" />
        </div>
        <p className="mt-5 font-mono text-sm text-ink-soft">Loading…</p>
      </div>
    </div>
  );
}
