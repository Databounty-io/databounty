// SPDX-License-Identifier: Apache-2.0

import { Suspense } from "react";
import ValidatorWorkspaceView from "./view";

export default function ValidatorPage() {
  return (
    <Suspense fallback={null}>
      <ValidatorWorkspaceView />
    </Suspense>
  );
}
