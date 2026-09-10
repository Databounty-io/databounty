// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { LANDING_URL } from "@/lib/urls";

export const metadata: Metadata = {
  title: "Delivered Datasets",
  description:
    "Verified, delivered coding datasets from DataBounty — execution-verified and validator-audited work ready for training or evaluation.",
  alternates: { canonical: `${LANDING_URL}/delivered` },
};

// This route's data (delivered-dataset search/filter results) is already
// fetched with `cache: "no-store"` in lib/public-data.ts, so it's live on
// every request already — this just makes that guarantee explicit at the
// route level instead of leaving it implicit in the nested fetch calls,
// matching the same pattern already used for llms.txt (see
// app/llms.txt/route.ts).
export const dynamic = "force-dynamic";

export default function DeliveredLayout({ children }: { children: React.ReactNode }) {
  return children;
}
