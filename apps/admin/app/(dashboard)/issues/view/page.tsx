// SPDX-License-Identifier: Apache-2.0

// No dynamic path segment: the issue id is read from the ?id= query string
// client-side in view.tsx — the same pattern the user and dataset-type detail
// pages use, matching the V1 admin route shape.
import { Suspense } from "react";
import AdminIssueDetailView from "./view";
import { AdminLoadingState } from "@/components/admin-shell";

export default function Page() {
  return (
    // useSearchParams needs a Suspense boundary during prerender.
    <Suspense fallback={<AdminLoadingState label="Loading issue…" />}>
      <AdminIssueDetailView />
    </Suspense>
  );
}
