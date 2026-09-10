// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { LANDING_URL } from "@/lib/urls";

export const metadata: Metadata = {
  title: "Validation Queue",
  description:
    "Contributions waiting on a human validator. Audit an item on DataBounty and earn karma whichever way the call goes.",
  alternates: { canonical: `${LANDING_URL}/validation` },
};

// This route's data (the queue of items waiting on a human validator) is
// already fetched with `cache: "no-store"` in lib/public-data.ts, so it's
// live on every request already — this just makes that guarantee explicit at
// the route level instead of leaving it implicit in the nested fetch calls,
// matching the same pattern already used for llms.txt (see
// app/llms.txt/route.ts).
export const dynamic = "force-dynamic";

export default function ValidationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
