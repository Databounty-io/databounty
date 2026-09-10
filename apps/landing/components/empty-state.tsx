// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { Icon, type IconName } from "./icons";

type Variant = "empty" | "error" | "no-results";

const VARIANT_ICON: Record<Variant, IconName> = {
  empty: "database",
  error: "alert",
  "no-results": "search",
};

const VARIANT_TONE: Record<Variant, string> = {
  empty: "border-dark-line bg-dark-card text-dark-dim",
  error: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  "no-results": "border-dark-line bg-dark-card text-dark-dim",
};

interface EmptyStateAction {
  label: string;
  href: string;
  /** Full page nav (crossing an app boundary) vs. same-app Next <Link>. */
  external?: boolean;
}

/**
 * Shared empty/error/no-results placeholder for any list or grid on the
 * landing site.
 */
export function EmptyState({
  variant = "empty",
  title,
  description,
  action,
  icon,
}: {
  variant?: Variant;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  icon?: IconName;
}) {
  return (
    <div className="card-dark flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div
        className={`flex h-11 w-11 items-center justify-center rounded-full border ${VARIANT_TONE[variant]}`}
      >
        <Icon name={icon ?? VARIANT_ICON[variant]} size={18} strokeWidth={1.6} />
      </div>
      <div className="font-mono text-sm font-medium text-dark-text">{title}</div>
      {description && (
        <p className="max-w-[420px] text-[13px] leading-[1.6] text-dark-muted">{description}</p>
      )}
      {action &&
        (action.external ? (
          <a
            href={action.href}
            className="mt-1 font-mono text-[13px] text-lime hover:text-lime-bright"
          >
            {action.label} →
          </a>
        ) : (
          <Link
            href={action.href}
            className="mt-1 font-mono text-[13px] text-lime hover:text-lime-bright"
          >
            {action.label} →
          </Link>
        ))}
    </div>
  );
}
