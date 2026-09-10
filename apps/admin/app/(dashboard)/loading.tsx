// SPDX-License-Identifier: Apache-2.0

import { Brandmark } from "@/components/brand";

export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <Brandmark size={32} className="pulse-soft" />
    </div>
  );
}
