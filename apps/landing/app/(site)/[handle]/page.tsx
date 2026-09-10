// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchPublicProfile } from "@/lib/public-data";
import PublicProfileView from "./view";

const RESERVED_HANDLES = new Set([
  "admin", "api", "bounties", "dashboard", "databounty", "delivered",
  "developers", "domains", "how-it-works", "login", "logout", "mcp",
  "notifications", "open", "privacy", "profile", "settings", "signup",
  "terms", "validator", "www", "agents", "changelog",

]);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const notFoundMeta: Metadata = { title: "Profile not found", robots: { index: false, follow: false } };
  if (RESERVED_HANDLES.has(handle)) return notFoundMeta;
  const result = await fetchPublicProfile(handle);
  if (result.status !== "ok") {
    if (result.status === "missing") return notFoundMeta;
    return { title: "Profile temporarily unavailable", robots: { index: false, follow: false } };
  }
  const profile = result.profile;

  const name = profile.displayName ?? `@${profile.handle}`;
  const title = `${name} (@${profile.handle})`;
  // SEC-10: tier, like karma, is absent when the member hid "karma & tier",
  // so it is only stated when the payload actually carries it.
  const facts: string[] = [];
  if (profile.tier) facts.push(`${profile.tier.label} tier`);
  if (profile.karma !== undefined) facts.push(`${profile.karma.toLocaleString()} karma`);
  if (profile.datasetsContributed) facts.push(`${profile.datasetsContributed} dataset${profile.datasetsContributed === 1 ? "" : "s"} contributed`);
  const hasContributions = (profile.acceptedItems ?? 0) > 0 || (profile.datasetsContributed ?? 0) > 0;
  const hasPublishedCorpora = profile.publishedCredits.length > 0;
  const evidence = hasContributions || hasPublishedCorpora
    ? ` ${[
        hasContributions ? "Verified open-dataset contributions" : null,
        hasPublishedCorpora ? "published corpora" : null,
      ].filter(Boolean).join(" and ")}.`
    : "";
  // With every disclosure off there are no facts to state, so the dash and
  // the empty list are dropped instead of emitting "— ." (SEC-10).
  const description = facts.length > 0
    ? `${name} on DataBounty — ${facts.join(", ")}.${evidence}`
    : `${name} on DataBounty.${evidence}`;
  const url = `/${profile.handle}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: { type: "profile", url, title, description },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  if (RESERVED_HANDLES.has(handle)) notFound();
  const result = await fetchPublicProfile(handle);
  if (result.status === "missing") notFound();
  if (result.status !== "ok") {
    throw new Error(`Profile service unavailable for handle "${handle}"`);
  }
  return <PublicProfileView profile={result.profile} />;
}
