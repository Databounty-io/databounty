// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { LANDING_URL } from "@/lib/urls";

export const metadata: Metadata = {
  title: "Dataset Domains",
  description:
    "Explore dataset domains and types on DataBounty — coding, and upcoming legal, healthcare, finance, and science categories.",
  alternates: { canonical: `${LANDING_URL}/domains` },
};

// This route's data (per-domain live/coming-soon status, waitlist counts) is
// already fetched with `cache: "no-store"` in lib/public-data.ts, so it's
// live on every request already — this just makes that guarantee explicit at
// the route level instead of leaving it implicit in the nested fetch calls,
// matching the same pattern already used for llms.txt (see
// app/llms.txt/route.ts).
export const dynamic = "force-dynamic";

export default function DomainsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
