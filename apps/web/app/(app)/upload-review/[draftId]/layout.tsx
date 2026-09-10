// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

// Sentinel static param for dynamic route hydration.
export function generateStaticParams(): Array<{ draftId: string }> {
  return [{ draftId: "placeholder" }];
}

export default function UploadReviewLayout({ children }: { children: ReactNode }) {
  return children;
}
