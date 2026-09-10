// SPDX-License-Identifier: Apache-2.0

// Backward-compatible role route for legacy /creator/submissions/:id links.
import SubmissionDetailView from "../../../contributor/submissions/[id]/view";

export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function Page() {
  return <SubmissionDetailView />;
}
