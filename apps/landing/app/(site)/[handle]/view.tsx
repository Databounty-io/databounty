// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import type { PublicProfile } from "@/lib/public-data";
import { DASHBOARD_HOME_URL, DASHBOARD_URL, LANDING_URL } from "@/lib/urls";
import { safeJsonLd } from "@/lib/json-ld";

const DISPLAY_HOST = LANDING_URL.replace(/^https?:\/\//, "");

const BADGE_FAMILIES: { id: string; label: string }[] = [
  { id: "build", label: "build" },
  { id: "audit", label: "audit" },
  { id: "platform", label: "platform" },
];

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-4 font-display text-[17px] font-bold text-dark-text">{children}</h2>;
}

export default function PublicProfileView({
  profile,
}: {
  profile: PublicProfile;
}) {
  const { tier } = profile;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    mainEntity: {
      "@type": "Person",
      name: profile.displayName ?? `@${profile.handle}`,
      alternateName: `@${profile.handle}`,
      identifier: profile.handle,
      url: `${LANDING_URL}/${profile.handle}`,
    },
  };

  const stats: { label: string; value: string }[] = [];
  if (profile.datasetsSponsored !== undefined) {
    stats.push({ label: "sponsored", value: profile.datasetsSponsored.toLocaleString() });
  }
  if (profile.datasetsContributed !== undefined) {
    stats.push({ label: "contributed", value: profile.datasetsContributed.toLocaleString() });
  }
  if (profile.acceptedItems !== undefined) {
    stats.push({ label: "items_accepted", value: profile.acceptedItems.toLocaleString() });
    stats.push({ label: "items_audited", value: (profile.audits ?? 0).toLocaleString() });
  }

  return (
    <main className="mx-auto max-w-[760px] px-4 pb-[72px] pt-3 sm:px-8 sm:pt-4">
      {/* SECURITY: profile.displayName is attacker-controlled (any string a
          user sets, no HTML/charset restriction). Found live and exploitable
          2026-09-03: an unescaped JSON.stringify here let a `</script>`
          substring in a display name break out of this tag and inject real
          HTML/JS into every visitor's browser. safeJsonLd() escapes </>/& —
          see lib/json-ld.ts. Never revert to a bare JSON.stringify here. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }} />
      <div className="sticky top-[65px] z-30 -mx-4 mb-8 bg-dark px-4 py-2 sm:-mx-8 sm:mb-10 sm:px-8">
        <section className="flex items-center justify-between gap-3 rounded-lg border border-dark-line-strong bg-dark-deep px-3 py-2 font-mono shadow-[0_8px_24px_rgba(0,0,0,.18)] sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <span className="hidden shrink-0 rounded border border-dark-line-strong px-1.5 py-0.5 text-[9px] font-bold tracking-[.12em] text-lime sm:inline-block">
              DATA/BOUNTY
            </span>
            <p className="min-w-0 text-[11px] leading-5 text-dark-muted sm:text-[12px]">
              <span className="sm:hidden">Build. Verify. Earn karma.</span>
              <span className="hidden sm:inline">Turn your expertise into verified datasets. Earn karma. Get credited.</span>
            </p>
          </div>
          <a
            href={`${DASHBOARD_HOME_URL}?returnToPublicProfile=${encodeURIComponent(profile.handle)}`}
            className="shrink-0 rounded-md bg-lime px-3 py-2 text-[11px] font-bold text-dark transition-colors hover:bg-lime-bright sm:px-3.5 sm:text-[12px]"
          >
            get_started →
          </a>
        </section>
      </div>

      {/* Header */}
      <div className="pb-10 text-center">
        <div className="mb-6 break-all font-mono text-xs text-lime">{DISPLAY_HOST}/{profile.handle}</div>
        <h1 className="break-words font-display text-4xl font-bold leading-[1.06] tracking-[-.035em] text-dark-text sm:text-[44px]">
          {profile.displayName ?? `@${profile.handle}`}
        </h1>
        {profile.displayName && <div className="mt-2.5 font-mono text-sm text-dark-soft">@{profile.handle}</div>}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3 font-mono text-[12.5px]">
          {/* SEC-10: `tier` is now absent whenever the member turned the
              "karma & tier" disclosure off, so the chip is omitted rather
              than rendered blank (or crashing on `tier.color`, which is what
              an unguarded dereference did here). Same treatment the karma
              figure beside it already had. */}
          {tier && (
            <span
              className="rounded-[5px] border px-2.5 py-1 text-[11px] font-bold"
              style={{ color: tier.color, borderColor: `${tier.color}40`, backgroundColor: `${tier.color}0d` }}
            >
              {tier.label.toLowerCase()}
            </span>
          )}
          {profile.karma !== undefined && <span className="text-lime">{profile.karma.toLocaleString()} karma</span>}
          {profile.memberSince && (
            <span className="text-dark-dim">member since {new Date(profile.memberSince).toLocaleDateString()}</span>
          )}
        </div>
      </div>

      {/* Stat row */}
      {stats.length > 0 && (
        <div className="mb-12 grid grid-cols-2 overflow-hidden rounded-[11px] border border-dark-line bg-dark-card font-mono sm:auto-cols-fr sm:grid-flow-col">
          {stats.map((s, i, arr) => {
            const lastMobileRowStart = Math.floor((arr.length - 1) / 2) * 2;
            return (
              <div
                key={s.label}
                className={`border-dark-line px-5 py-[18px] text-center ${i < arr.length - 1 ? "sm:border-r" : ""} ${i % 2 === 0 && i < arr.length - 1 ? "max-sm:border-r" : ""} ${i < lastMobileRowStart ? "max-sm:border-b" : ""}`}
              >
                <div className="text-[21px] font-bold text-dark-text">{s.value}</div>
                <div className="micro-label mt-1.5 text-dark-dim">{s.label}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Badges */}
      {profile.badges && profile.badges.length > 0 && (
        <div className="mb-12">
          <SectionLabel>{"// badges"}</SectionLabel>
          <div className="flex flex-col gap-3">
            {BADGE_FAMILIES.map((fam) => {
              const inFamily = profile.badges!.filter((b) => b.family === fam.id);
              if (inFamily.length === 0) return null;
              return (
                <div key={fam.id} className="flex flex-wrap items-center gap-2">
                  <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[.05em] text-dark-dim">{fam.label}</span>
                  {inFamily.map((b) => (
                    <span key={b.id} className="inline-flex items-center rounded-[5px] border border-dark-line px-2.5 py-1.5 font-mono text-[11px] text-dark-muted">
                      {b.label.toLowerCase()}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Datasets contributed to */}
      {profile.datasets && profile.datasets.length > 0 && (
        <div className="mb-12">
          <SectionLabel>{"// datasets_contributed_to"}</SectionLabel>
          <div className="overflow-hidden rounded-[11px] border border-dark-line font-mono">
            {profile.datasets.map((d, i) => (
              <Link
                key={d.id}
                href={`/pools/${d.id}`}
                className={`flex items-center justify-between gap-4 px-5 py-3.5 text-[12.5px] transition-colors hover:bg-dark-card ${i < profile.datasets!.length - 1 ? "border-b border-dark-line" : ""}`}
              >
                <span className="min-w-0 break-words text-dark-text">{d.title}</span>
                <span className="shrink-0 text-dark-muted">
                  {d.items.toLocaleString()} <span className="text-dark-dim">items</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Published with credit */}
      {profile.publishedCredits.length > 0 && (
        <div className="mb-12">
          <SectionLabel>{"// published_with_credit"}</SectionLabel>
          <div className="flex flex-col gap-2.5">
            {profile.publishedCredits.map((c) => (
              <a
                key={c.hfSlug}
                href={c.hfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-[11px] border border-dark-line bg-dark-deep px-5 py-3.5 font-mono text-[12.5px] transition-colors hover:border-dark-hover hover:bg-dark-card"
              >
                <span className="min-w-0 break-words text-dark-text">{c.title}</span>
                <span className="text-dark-soft">
                  <span className="text-dark-dim">hf:</span> <span className="break-all text-lime">{c.hfSlug} ↗</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Bottom band */}
      <div className="flex flex-col items-start justify-between gap-3 rounded-xl border border-dark-line-soft bg-dark-deep px-[26px] py-5 font-mono text-[13px] sm:flex-row sm:items-center">
        <span className="text-dark-muted">Is this your public page?</span>
        <a href={`${DASHBOARD_URL}/profile`} className="shrink-0 text-lime transition-colors hover:text-lime-bright">
          manage_visibility →
        </a>
      </div>
    </main>
  );
}
