// SPDX-License-Identifier: Apache-2.0

import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { fetchLandingCatalog } from "@/lib/public-data";

export default async function SiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const liveDomainIds = await fetchLandingCatalog()
    .then((data) => data.liveDomainIds)
    .catch(() => new Set<string>());

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-dark leading-[normal] text-dark-text">
      <SiteHeader />
      <div className="flex-1">{children}</div>
      <SiteFooter liveDomainIds={liveDomainIds} />
    </div>
  );
}
