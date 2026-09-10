// SPDX-License-Identifier: Apache-2.0

import { Suspense } from "react";
import AuditReviewView from "./view";

export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AuditReviewView />
    </Suspense>
  );
}
