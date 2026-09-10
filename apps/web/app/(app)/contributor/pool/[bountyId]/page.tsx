// SPDX-License-Identifier: Apache-2.0

// Server wrapper: enumerates real open-pool bounty IDs for static export,
// renders the client view. Mirrors contributor/submit/[batchId]/page.tsx.
import { API_URL } from "@/lib/urls";
import PoolSubmitView from "./view";

// Pools opened after the build hydrate client-side.
export async function generateStaticParams() {
  try {
    const res = await fetch(`${API_URL}/v1/community/pools?limit=200`);
    if (!res.ok) return [];
    const data = (await res.json()) as { pools: { id: string }[] };
    return data.pools.map((p) => ({ bountyId: p.id }));
  } catch {
    return [];
  }
}

export default function Page() {
  return <PoolSubmitView />;
}
