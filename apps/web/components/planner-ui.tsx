"use client";

// SPDX-License-Identifier: Apache-2.0

import type React from "react";
import { Icon, type IconName } from "@/components/icons";

/* ------------------------------------------------------------------ *
 * Shared planner chrome, ported from V1's sponsor bounty planner screen so
 * the community dataset planner presents the same UI and the same flow.
 *
 * Two deliberate deviations from V1's class strings, both required by
 * this app's own accessibility decisions recorded in `globals.css`:
 *
 *  - Interactive control borders use `line-strong`, not `line`. V1 puts
 *    `border-line` on clickable option cards; `--color-line` is 1.26:1
 *    on white and fails WCAG 1.4.11 for a border that carries meaning.
 *  - Lime is only ever used as a foreground on the dark `bg-ink` fill
 *    (the index pill's hover state), never as text on a light surface —
 *    `--color-lime` is 1.33:1 on white. `lime-ink` is the light-surface
 *    twin where a lime foreground is genuinely wanted.
 * ------------------------------------------------------------------ */

/* `TOUCH_TARGET` used to live here. It now sits in `components/ui.tsx`
 * alongside the other primitives, because the mobile app-shell header needs
 * it too and `app-shell.tsx` already depends on `ui.tsx` — importing a
 * planner-specific module from the shell would have inverted that layering.
 * Planner call sites import it from `@/components/ui`. */

/** Thin determinate bar under the planner's card header. */
export function PlannerProgress({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className="h-[3px] w-full shrink-0 bg-line-soft"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label="Planner progress"
    >
      <div
        className="h-full bg-ink transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * One selectable answer in the planner: a numbered index pill, a label, an
 * optional hint, and a hover ⏎ affordance so the keyboard path is discoverable.
 *
 * `disabled` renders the dashed "unavailable" variant (an option that exists
 * but cannot be chosen). `busy` is the distinct in-flight case — the option is
 * still valid, we are simply waiting on the previous answer — and shows
 * `cursor-wait` rather than pretending the option is gone.
 */
export function PlannerChip({
  index,
  label,
  hint,
  dim = false,
  disabled = false,
  busy = false,
  action,
  onClick,
}: {
  index: number;
  label: string;
  hint?: string;
  dim?: boolean;
  disabled?: boolean;
  busy?: boolean;
  action?: React.ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span
        className={`shrink-0 rounded-md bg-brand-soft px-[7px] py-0.5 font-mono text-[11px] text-ink-soft ${
          disabled ? "" : "group-hover:bg-ink group-hover:text-lime"
        }`}
      >
        {index}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block text-[13.5px] font-medium leading-tight ${
            dim || disabled ? "text-ink-soft" : ""
          }`}
        >
          {label}
        </span>
        {/* `whitespace-pre-line`: hints are allowed to be multi-line (the
            difficulty allocation breakdown is one line per level). */}
        {hint && (
          <span className="mt-0.5 block whitespace-pre-line font-mono text-[11px] leading-snug text-ink-faint">
            {hint}
          </span>
        )}
      </span>
    </>
  );

  if (disabled) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong bg-panel px-3.5 py-[11px]">
        <button
          type="button"
          disabled
          className="flex min-w-0 flex-1 cursor-not-allowed items-start gap-[11px] bg-transparent text-left opacity-70"
        >
          {body}
        </button>
        {action}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      className="group flex cursor-pointer items-start gap-[11px] rounded-lg border border-line-strong bg-transparent px-3.5 py-[11px] text-left transition-colors hover:border-ink hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 disabled:cursor-wait disabled:opacity-60"
    >
      {body}
      <span className="mt-0.5 shrink-0 font-mono text-[13px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
        ↵
      </span>
    </button>
  );
}

/**
 * "Why we ask" line above each step's options. Guidance-first: it says why the
 * question matters and what to do next, so typing a free answer reads as a
 * confident override rather than a guess.
 *
 * Community-track copy throughout. The wording matters: a community dataset is
 * karma-only and never exclusive, so the licence question sets the terms the
 * dataset is published under — it does NOT buy a resale hold, and it must never
 * inherit V1's funded copy, which would be factually wrong here.
 */
const STEP_GUIDANCE: Record<string, string> = {
  template:
    "This fixes the exact fields contributors fill and how each item is verified. Start from a template, fork one to tweak, or define your own.",
  fields:
    "These are the fields every contributor fills for one item. Keep each one single-purpose — a reviewer checks this schema before the type is approved.",
  title:
    "A specific title tells contributors the task at a glance. Type your own, or pick / generate an idea below.",
  description:
    "Describe what a strong submission looks like. Pick a starter below to fill the box, then edit it to match your intent.",
  language: "Scopes every submission to one language, so the dataset stays consistent.",
  items: "Sets the dataset size. Larger datasets cover more ground but take longer to fill.",
  difficulty:
    "Balances how hard the items are — this shapes who can claim and the karma earned per item.",
  audit:
    "How much human validation runs after the automated checks. More coverage means higher quality and a slower intake.",
  license:
    "Sets the terms the published dataset is shared under, and how others may reuse it.",
  samples:
    "Reference examples show contributors the exact structure and quality bar. A reviewer checks each one against the template contract.",
};

export function StepGuidance({ stepKey }: { stepKey: string | null | undefined }) {
  const text = stepKey ? STEP_GUIDANCE[stepKey] : undefined;
  if (!text) return null;
  return (
    <p className="mb-3 flex items-start gap-2 text-[11.5px] leading-snug text-ink-soft">
      <Icon name="info" size={13} className="mt-px shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

/**
 * The template-path question, asked before any catalog or custom screen: the
 * sponsor first picks HOW the dataset contract gets defined, then only the
 * chosen path's screen is shown. One icon per path so the three approaches read
 * as distinct cards rather than a list.
 */
export function PathChoiceCards<T extends string>({
  options,
  onPick,
  disabled = false,
}: {
  options: readonly { key: T; label: string; hint: string; icon: IconName }[];
  onPick: (key: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mb-3.5 grid gap-2.5 sm:grid-cols-3">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onPick(opt.key)}
          disabled={disabled}
          className="group flex cursor-pointer flex-col items-start rounded-xl border border-line-strong bg-white p-4 text-left transition-colors hover:border-ink hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 disabled:cursor-wait disabled:opacity-60"
        >
          <span className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-ink group-hover:bg-ink group-hover:text-lime">
            <Icon name={opt.icon} size={16} aria-hidden="true" />
          </span>
          <span className="text-[13px] font-bold leading-tight text-ink">{opt.label}</span>
          <span className="mt-1 font-mono text-[11px] leading-snug text-ink-faint">{opt.hint}</span>
        </button>
      ))}
    </div>
  );
}
