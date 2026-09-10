// SPDX-License-Identifier: Apache-2.0

import UploadHandoffView from "./view";

// Static export sentinel path for dynamic route hydration.
export function generateStaticParams(): Array<{ token: string }> {
  return [{ token: "placeholder" }];
}

export default function UploadHandoffPage() {
  return <UploadHandoffView />;
}
