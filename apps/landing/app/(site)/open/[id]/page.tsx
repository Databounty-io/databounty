// SPDX-License-Identifier: Apache-2.0

import { redirect } from "next/navigation";

export function generateStaticParams() {
  return [{ id: "dataset-placeholder" }];
}

export default async function OpenDatasetRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/pools/${id}`);
}
