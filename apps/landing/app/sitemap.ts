// SPDX-License-Identifier: Apache-2.0

import type { MetadataRoute } from "next";
import { LANDING_URL } from "@/lib/urls";
import { serverApiUrl } from "@/lib/public-data";
import { DOMAINS } from "@/lib/dataset-types";

type SitemapProfilePage = { profiles?: Array<{ handle: string; lastModified: string }>; nextCursor?: string | null };

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const routes = [
    "",
    "/pools",
    "/open",
    "/validation",
    "/delivered",
    "/how-it-works",
    "/domains",
    "/agents",
    "/changelog",
    "/privacy",
    "/terms",
  ];

  const entries: MetadataRoute.Sitemap = routes.map((path) => ({
    url: `${LANDING_URL}${path}${path ? "/" : ""}`,
    lastModified: new Date(),
    changeFrequency: "daily" as const,
    priority: path === "" ? 1 : 0.7,
  }));

  // Domain detail pages are a fixed, known set.
  for (const domain of DOMAINS) {
    entries.push({
      url: `${LANDING_URL}/domains/${domain.id}/`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.6,
    });
  }

  const apiUrl = serverApiUrl();
  if (!apiUrl) return entries;

  // Pool detail pages. They now carry their own canonical and title, so they
  // are real indexable pages rather than duplicates of the listing — but a
  // crawler can only reach the ones linked from page 1 of a 28-page grid
  // unless they are listed here.
  try {
    const poolRes = await fetch(`${apiUrl}/v1/community/catalog?limit=100`, { cache: "no-store" });
    if (poolRes.ok) {
      const body = (await poolRes.json()) as { bounties?: Array<{ id?: unknown; updatedAt?: unknown }> };
      for (const pool of body.bounties ?? []) {
        if (typeof pool.id !== "string") continue;
        entries.push({
          url: `${LANDING_URL}/pools/${pool.id}/`,
          lastModified: new Date(),
          changeFrequency: "daily",
          priority: 0.6,
        });
      }
    }
  } catch {
    // A sitemap missing the pool pages is better than a 500 sitemap.
  }

  let cursor: string | null = null;
  while (entries.length < 50_000) {
    const query = new URLSearchParams({ limit: String(Math.min(500, 50_000 - entries.length)), ...(cursor ? { cursor } : {}) });
    const response = await fetch(`${apiUrl}/v1/profiles/sitemap?${query}`, { cache: "no-store" });
    if (!response.ok) break;
    const page = (await response.json()) as SitemapProfilePage;
    for (const profile of page.profiles ?? []) {
      entries.push({
        url: `${LANDING_URL}/${encodeURIComponent(profile.handle)}/`,
        lastModified: new Date(profile.lastModified),
        changeFrequency: "weekly",
        priority: 0.5,
      });
    }
    if (!page.nextCursor || (page.profiles?.length ?? 0) === 0) break;
    cursor = page.nextCursor;
  }
  return entries;
}
