"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icons";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center px-4">
      <div className="card w-full max-w-md p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
          <Icon name="alert" size={24} />
        </div>
        <h2 className="mt-4 font-mono text-lg font-bold text-ink">Something went wrong</h2>
        <p className="mt-2 text-sm text-ink-soft">
          {error.message || "An unexpected error occurred while rendering this page."}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button onClick={() => reset()} variant="primary">
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
