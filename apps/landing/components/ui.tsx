// SPDX-License-Identifier: Apache-2.0

import React from "react";
import type { BountyStatus, SubmissionStatus } from "@/lib/types";
import {
  BOUNTY_STATUS_LABELS,
  SUBMISSION_STATUS_LABELS,
} from "@/lib/format";

/* ---------- Button ---------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg font-mono font-medium transition-colors disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap";
  const sizes = {
    sm: "text-xs px-2.5 py-1.5",
    md: "text-[13px] px-3.5 py-2",
    lg: "text-sm px-5 py-2.5",
  };
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-brand text-lime hover:bg-black",
    secondary:
      "border border-line bg-white text-ink hover:border-ink hover:bg-panel",
    ghost: "text-ink-soft hover:bg-brand-soft hover:text-ink",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
  };
  return (
    <button
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

/* ---------- Pill ---------- */

export type PillTone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "violet";

const PILL_TONES: Record<PillTone, string> = {
  neutral: "bg-brand-soft text-ink-soft border-line",
  brand: "bg-brand text-lime border-brand",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  danger: "bg-rose-50 text-rose-700 border-rose-200",
  info: "bg-sky-50 text-sky-700 border-sky-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
};

export function Pill({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: PillTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-medium leading-4 ${PILL_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

const BOUNTY_STATUS_TONES: Partial<Record<BountyStatus, PillTone>> = {
  active: "success",
  platform_review: "warning",
  paused: "neutral",
  completed: "brand",
  partially_completed: "violet",
  export_ready: "brand",
  cancelled: "danger",
  disputed: "danger",
  draft: "neutral",
  planning: "neutral",
  closing: "neutral",
};

export function BountyStatusPill({ status }: { status: BountyStatus }) {
  return (
    <Pill tone={BOUNTY_STATUS_TONES[status] ?? "neutral"}>
      {BOUNTY_STATUS_LABELS[status]}
    </Pill>
  );
}

const SUBMISSION_STATUS_TONES: Partial<Record<SubmissionStatus, PillTone>> = {
  submitted: "neutral",
  duplicate_check: "info",
  contamination_check: "neutral",
  running_tests: "info",
  llm_validation: "info",
  tests_failed: "danger",
  needs_fixes: "warning",
  provisionally_accepted: "brand",
  in_audit: "violet",
  accepted_pending_sample: "warning",
  flagged: "warning",
  disputed: "danger",
  accepted: "success",
  rejected: "danger",
};

// `contamination_check` is deliberately absent: it is a deprecated status no
// code path writes, and showing it as "running" would claim a check that this
// pipeline does not perform.
const RUNNING: SubmissionStatus[] = [
  "duplicate_check",
  "running_tests",
  "llm_validation",
];

export function SubmissionStatusPill({ status }: { status: SubmissionStatus }) {
  const running = RUNNING.includes(status);
  return (
    <Pill tone={SUBMISSION_STATUS_TONES[status] ?? "neutral"}>
      {running && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
        </span>
      )}
      {SUBMISSION_STATUS_LABELS[status]}
    </Pill>
  );
}

/* ---------- Progress ---------- */

export function Progress({
  value,
  max,
  tone = "brand",
  className = "",
}: {
  value: number;
  max: number;
  tone?: "brand" | "success" | "warning" | "lime";
  className?: string;
}) {
  const pctVal = max === 0 ? 0 : Math.min(100, (value / max) * 100);
  const tones = {
    brand: "bg-brand",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    lime: "bg-lime",
  };
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-brand-soft ${className}`}>
      <div
        className={`h-full rounded-full ${tones[tone]} transition-all`}
        style={{ width: `${pctVal}%` }}
      />
    </div>
  );
}

/* ---------- Stat ---------- */

export function Stat({
  label,
  value,
  sub,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card px-4 py-3.5 ${className}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-soft">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight mono-num">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-soft">{sub}</div>}
    </div>
  );
}

/* ---------- Section heading ---------- */

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
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-0.5 text-sm text-ink-soft">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---------- Table ---------- */

export function Table({
  headers,
  children,
  className = "",
}: {
  headers: React.ReactNode[];
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card overflow-x-auto ${className}`}>
      <table className="w-full min-w-max text-left text-sm">
        <thead>
          <tr className="border-b border-line">
            {headers.map((h, i) => (
              <th
                key={i}
                className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-soft"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}

/* ---------- Code block ---------- */

export function CodeBlock({
  code,
  label,
  tone = "neutral",
  className = "",
}: {
  code: string;
  label?: string;
  tone?: "neutral" | "danger" | "success";
  className?: string;
}) {
  const borders = {
    neutral: "border-slate-700",
    danger: "border-rose-500/60",
    success: "border-emerald-500/60",
  };
  const labelTones = {
    neutral: "text-slate-400",
    danger: "text-rose-400",
    success: "text-emerald-400",
  };
  return (
    <div
      className={`overflow-hidden rounded-lg border bg-slate-900 ${borders[tone]} ${className}`}
    >
      {label && (
        <div
          className={`border-b border-slate-700/60 px-3 py-1.5 font-mono text-[11px] font-medium ${labelTones[tone]}`}
        >
          {label}
        </div>
      )}
      <pre className="code-scroll overflow-x-auto p-3 font-mono text-xs leading-relaxed text-slate-200">
        {code}
      </pre>
    </div>
  );
}

/* ---------- Empty state ---------- */

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="card flex items-center justify-center px-6 py-10 text-sm text-ink-soft">
      {children}
    </div>
  );
}

/* ---------- Key-value row ---------- */

export function KV({
  label,
  value,
  strong = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-ink-soft">{label}</span>
      <span className={`mono-num text-right ${strong ? "font-semibold" : "font-medium"}`}>
        {value}
      </span>
    </div>
  );
}
