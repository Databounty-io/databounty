// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchBounty } from "@/lib/public-data";
import { LANDING_URL } from "@/lib/urls";
import PoolDetailView from "./view";

/** Per-pool title and description. Every pool page previously inherited the
 * listing's "Open Work · DataBounty" — identical for all of them, and wrong
 * for a delivered corpus — which is bad for both a shared link and search. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const bounty = await fetchBounty(id);
  if (!bounty) return { title: "Dataset not found" };
  const delivered = ["completed", "export_ready", "partially_completed"].includes(bounty.status);
  return {
    title: bounty.title,
    description:
      bounty.description?.slice(0, 200) ||
      (delivered
        ? `A delivered DataBounty corpus, published under an open license with public quality stats.`
        : `An open DataBounty dataset spec accepting contributions for karma and named credit.`),
    alternates: { canonical: `${LANDING_URL}/pools/${id}` },
  };
}

export function generateStaticParams() {
  return [{ id: "bounty-placeholder" }];
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bounty = await fetchBounty(id);
  // A real 404, not a 200 rendering "Dataset not found": the soft version is
  // indexable and gives crawlers an unbounded URL space of identical pages.
  if (!bounty) notFound();
  return <PoolDetailView bounty={bounty} />;
}
