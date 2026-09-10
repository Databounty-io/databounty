// SPDX-License-Identifier: Apache-2.0

import { SponsorProgramView } from "./view";

export const metadata = {
  title: "Community Program - DataBounty",
  description: "Track community dataset intake and review evidence",
};

export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function SponsorProgramPage() {
  return <SponsorProgramView />;
}
