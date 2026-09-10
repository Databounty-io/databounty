"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { PUBLIC_API_URL } from "@/lib/public-data";
import type { DomainId } from "@/lib/dataset-types";

const WAITLIST_PLACEHOLDER: Record<DomainId, string> = {
  coding: "you@databounty.io",
  legal: "you@lawfirm.com",
  healthcare: "you@hospital.org",
  finance: "you@fund.com",
  science: "you@university.edu",
};

export function WaitlistForm({ domainId, domainName, initialCount }: { domainId: DomainId; domainName: string; initialCount: number }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "joined" | "error">("idle");
  const [count, setCount] = useState(initialCount);
  const emailValid = /\S+@\S+\.\S+/.test(email);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailValid || state === "submitting") return;
    setState("submitting");
    try {
      const res = await fetch(`${PUBLIC_API_URL}/v1/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: domainId, email }),
      });
      if (!res.ok) throw new Error("failed");
      const body = (await res.json()) as { count?: number };
      if (typeof body.count === "number") setCount(body.count);
      setState("joined");
    } catch {
      setState("error");
    }
  };

  return (
    <>
      {state === "joined" ? (
        <>
          <h2 className="mb-3 font-display text-2xl font-bold leading-[normal] tracking-[-.02em]">
            you&apos;re on the list <span className="text-emerald-400">✓</span>
          </h2>
          <p className="mx-auto max-w-[480px] text-[15px] leading-relaxed text-dark-muted">
            We&apos;ll notify you the moment {domainName.toLowerCase()} opens
            for datasets and validator work.
          </p>
        </>
      ) : (
        <>
          <h2 className="mb-3 font-display text-2xl font-bold leading-[normal] tracking-[-.02em]">
            Be first in when {domainName.toLowerCase()} opens.
          </h2>
          <p className="mx-auto mb-7 max-w-[480px] text-[15px] leading-relaxed text-dark-muted">
            Waitlisted experts get early validator credentialing and first
            access to open dataset verification.
          </p>
          <form onSubmit={submit} className="mx-auto flex max-w-[440px] flex-col gap-2.5 sm:flex-row">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={WAITLIST_PLACEHOLDER[domainId]}
              className="min-w-0 flex-1 rounded-lg border border-dark-line-soft bg-dark-deep px-4 py-3 font-mono text-sm text-dark-text placeholder:text-dark-dim focus:border-lime focus:outline-none"
            />
            <button
              type="submit"
              disabled={!emailValid || state === "submitting"}
              className="cursor-pointer rounded-lg bg-lime px-5 py-3 font-mono text-sm font-medium text-dark transition-colors hover:bg-lime-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              {state === "submitting" ? "joining…" : "join_expert_waitlist →"}
            </button>
          </form>
          {state === "error" && (
            <p className="mt-3 font-mono text-xs text-amber-300">
              Could not join the waitlist right now — try again in a moment.
            </p>
          )}
        </>
      )}
      <div className="mt-6 font-mono text-xs text-dark-soft">
        {count} {count === 1 ? "expert" : "experts"} already waiting
      </div>
    </>
  );
}
