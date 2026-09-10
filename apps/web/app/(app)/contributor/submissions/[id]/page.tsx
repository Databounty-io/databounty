// SPDX-License-Identifier: Apache-2.0

import SubmissionDetailView from "./view";

export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function Page() {
  return <SubmissionDetailView />;
}
