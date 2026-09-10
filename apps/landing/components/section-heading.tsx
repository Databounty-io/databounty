// SPDX-License-Identifier: Apache-2.0

import React from "react";

/** Shared "// heading" pattern used across public-site content sections */
export function SectionHeading({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h2 className="break-words font-display text-2xl font-bold leading-[normal] text-dark-text">
          {title}
        </h2>
        {sub && (
          <p className="mt-2 font-display text-sm font-light text-dark-muted">
            {sub}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
