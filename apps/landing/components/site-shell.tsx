"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useState } from "react";
import { Icon } from "./icons";
import { Brandmark, Wordmark } from "./brand";
import { DOMAINS } from "@/lib/dataset-types";
import { DASHBOARD_URL } from "@/lib/urls";

const NAV_LINKS: { href: string; label: string; external?: boolean }[] = [
  { href: "/pools", label: "Datasets" },
  { href: "https://github.com/Databounty-io", label: "GitHub", external: true },
  { href: "/delivered", label: "Delivered" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/agents", label: "Agents" },
];

export function Logo({
  light = false,
  size = "md",
}: {
  light?: boolean;
  size?: "md" | "lg";
}) {
  const lg = size === "lg";
  return (
    <Link href="/" className={`flex items-center ${lg ? "gap-[11px]" : "gap-2.5"}`}>
      <Brandmark size={lg ? 26 : 24} />
      <Wordmark light={light} size={lg ? "md" : "sm"} />
    </Link>
  );
}

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-dark-line bg-[rgba(10,12,10,.86)] backdrop-blur-[10px]">
      <div className="mx-auto flex h-[65px] max-w-[1200px] items-center justify-between gap-6 px-4 sm:px-8">
        <span className="sm:hidden"><Logo size="md" /></span>
        <span className="hidden sm:inline-flex"><Logo size="lg" /></span>
        <nav className="hidden items-center gap-6 whitespace-nowrap font-mono text-[13px] text-dark-muted lg:flex">
          {NAV_LINKS.map((l) =>
            l.external ? (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noreferrer"
                className="hover:text-dark-text"
              >
                {l.label}
              </a>
            ) : (
              <Link key={l.href} href={l.href} className="hover:text-dark-text">
                {l.label}
              </Link>
            )
          )}
        </nav>
        <div className="flex items-center gap-5">
          <a
            href={DASHBOARD_URL}
            className="hidden font-mono text-[13px] font-medium text-dark-soft transition-colors hover:text-dark-text sm:inline-block"
          >
            sign_in
          </a>
          <a
            href={DASHBOARD_URL}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-lg bg-lime px-3.5 py-1.5 font-mono text-[12px] font-semibold text-ink transition-colors hover:bg-lime-bright"
          >
            sign_up →
          </a>
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-dark-line-soft text-dark-text transition-colors hover:border-dark-hover lg:hidden"
          >
            <Icon name={open ? "x" : "menu"} size={18} />
          </button>
        </div>
      </div>
      {open && (
        <nav className="border-t border-dark-line bg-[rgba(10,12,10,.96)] lg:hidden">
          <div className="mx-auto flex max-w-[1200px] flex-col px-4 py-2 font-mono text-sm sm:px-8">
            {NAV_LINKS.map((l) =>
              l.external ? (
                <a
                  key={l.href}
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpen(false)}
                  className="border-b border-dark-line py-3 text-dark-muted last:border-b-0 hover:text-dark-text"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="border-b border-dark-line py-3 text-dark-muted last:border-b-0 hover:text-dark-text"
                >
                  {l.label}
                </Link>
              )
            )}
          </div>
        </nav>
      )}
    </header>
  );
}

export function SiteFooter({ liveDomainIds }: { liveDomainIds?: Set<string> }) {
  return (
    <footer className="border-t border-dark-line">
      <div className="mx-auto max-w-[1200px] px-4 py-16 sm:px-8">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-[280px]">
            <Logo />
            <p className="mt-3.5 text-[13px] leading-[1.6] text-dark-dim">
              Verified coding datasets, built in the open. Contributors earn
              karma and named credit on every published set.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-8 text-[13px] sm:grid-cols-5">
            <div>
              <div className="micro-label mb-3.5 text-dark-dim">explore</div>
              <ul className="space-y-2.5 text-dark-muted">
                <li><Link href="/pools" className="hover:text-dark-text">Datasets</Link></li>
                <li><Link href="/domains" className="hover:text-dark-text">Domains</Link></li>
                <li><Link href="/validation" className="hover:text-dark-text">Validation queue</Link></li>
                <li><Link href="/delivered" className="hover:text-dark-text">Delivered datasets</Link></li>
                <li><Link href="/how-it-works" className="hover:text-dark-text">How it works</Link></li>
                <li><Link href="/agents" className="hover:text-dark-text">For agents</Link></li>
              </ul>
            </div>
            <div>
              <div className="micro-label mb-3.5 text-dark-dim">domains</div>
              <ul className="space-y-2.5 text-dark-muted">
                {DOMAINS.map((d) => {
                  const live = liveDomainIds ? liveDomainIds.has(d.id) : d.status === "live";
                  return (
                    <li key={d.id}>
                      <Link href={`/domains/${d.id}`} className="hover:text-dark-text">
                        {d.id}
                        {!live && <span className="ml-1.5 text-[10px] text-dark-dim">soon</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div>
              <div className="micro-label mb-3.5 text-dark-dim">contribute</div>
              <ul className="space-y-2.5 text-dark-muted">
                <li><a href={`${DASHBOARD_URL}/contributor`} className="hover:text-dark-text">Create datasets</a></li>
                <li><a href={`${DASHBOARD_URL}/validator`} className="hover:text-dark-text">Audit datasets</a></li>
                <li><Link href="/open" className="hover:text-dark-text">Karma &amp; tiers</Link></li>
              </ul>
            </div>
            <div>
              <div className="micro-label mb-3.5 text-dark-dim">sponsors</div>
              <ul className="space-y-2.5 text-dark-muted">
                <li><a href={`${DASHBOARD_URL}/sponsor/create`} className="hover:text-dark-text">Request a dataset</a></li>
                <li><Link href="/how-it-works" className="hover:text-dark-text">Verification model</Link></li>
                <li><Link href="/changelog" className="hover:text-dark-text">Changelog</Link></li>
              </ul>
            </div>
            <div>
              <div className="micro-label mb-3.5 text-dark-dim">legal</div>
              <ul className="space-y-2.5 text-dark-muted">
                <li><Link href="/privacy" className="hover:text-dark-text">Privacy policy</Link></li>
                <li><Link href="/terms" className="hover:text-dark-text">Terms of service</Link></li>
                <li><a href="mailto:support@databounty.io" className="hover:text-dark-text">Support</a></li>
              </ul>
            </div>
          </div>
        </div>
        <div className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t border-dark-line pt-8 font-mono text-[11px] text-dark-dim">
          <span>© 2026 DataBounty. All rights reserved.</span>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5"><Icon name="shield" size={12} /> quality evidence first</span>
            <a
              href="https://github.com/Databounty-io"
              target="_blank"
              rel="noreferrer"
              aria-label="DataBounty on GitHub"
              className="flex items-center gap-1.5 hover:text-dark-text"
            >
              <Icon name="github" size={14} /> GitHub
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
