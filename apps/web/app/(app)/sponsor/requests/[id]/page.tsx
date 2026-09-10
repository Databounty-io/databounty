// SPDX-License-Identifier: Apache-2.0

import { SponsorRequestView } from "./view";

export const metadata = {
  title: "Dataset Request - DataBounty",
  description: "View and manage community dataset request",
};

export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function SponsorRequestPage() {
  return <SponsorRequestView />;
}
