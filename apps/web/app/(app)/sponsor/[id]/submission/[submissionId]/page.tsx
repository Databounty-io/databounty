// SPDX-License-Identifier: Apache-2.0

import { SponsorSubmissionView } from "./view";

export const metadata = {
  title: "Submission Evidence - DataBounty",
  description: "Review submitted item evidence and machine validation signals",
};

export function generateStaticParams() {
  return [{ id: "placeholder", submissionId: "placeholder" }];
}

export default function SponsorSubmissionPage() {
  return <SponsorSubmissionView />;
}
