// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { fetchLandingCatalog, fetchWaitlistCount } from "@/lib/public-data";
import { DOMAINS, typesForDomain, type DatasetType } from "@/lib/dataset-types";
import { LANDING_URL } from "@/lib/urls";
import DomainView from "./view";

/** Per-domain metadata. Without this the page inherited the /domains index's
 * title, description and canonical, telling search engines every domain page
 * is a duplicate of the index. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const domain = DOMAINS.find((d) => d.id === id);
  if (!domain) return { title: "Domain not found" };
  return {
    title: domain.name,
    description: domain.tagline || `${domain.name} datasets on DataBounty — built in the open and verified item by item.`,
    alternates: { canonical: `${LANDING_URL}/domains/${id}` },
  };
}

export function generateStaticParams() {
  return DOMAINS.map((d) => ({ id: d.id }));
}

export default async function DomainPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const domain = DOMAINS.find((d) => d.id === id);
  const catalog = await fetchLandingCatalog().catch(() => ({ datasetTypes: [] as DatasetType[] }));
  // Same live check the "live" badge uses (typesForDomain(...).some(active)),
  // so the waitlist fetch can never disagree with what the badge shows.
  // Waitlist counts only matter for coming-soon domains; skip the extra
  // request for a live domain or an unknown id.
  const live = domain ? typesForDomain(catalog.datasetTypes, domain.id).some((t) => t.status === "active") : true;
  const waitlistCount = live ? 0 : await fetchWaitlistCount(id);

  return (
    <DomainView
      id={id}
      datasetTypes={catalog.datasetTypes}
      waitlistCount={waitlistCount}
    />
  );
}
