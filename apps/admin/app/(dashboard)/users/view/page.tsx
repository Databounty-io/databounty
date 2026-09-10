// SPDX-License-Identifier: Apache-2.0

// No dynamic path segment: the account id is read from the ?id= query string
// client-side in view.tsx. This matches the V1 admin route shape and keeps the
// optional `NEXT_OUTPUT=export` build working without generateStaticParams.
import { Suspense } from "react";
import AdminUserView from "./view";
import { AdminLoadingState } from "@/components/admin-shell";

export default function Page() {
  return (
    // useSearchParams needs a Suspense boundary during prerender.
    <Suspense fallback={<AdminLoadingState label="Loading account…" />}>
      <AdminUserView />
    </Suspense>
  );
}
