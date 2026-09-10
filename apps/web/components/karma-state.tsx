"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { InfoTip, Pill } from "@/components/ui";
import {
  HOLD_REASON_LABEL,
  HOLD_REASON_TONE,
  ROLE_LABEL,
  securedReleaseText,
  windowCountdown,
  type KarmaHold,
  type KarmaHoldsByRole,
  type KarmaReleaseRule,
} from "@/lib/karma-state";

export function KarmaStateCard({
  earned,
  secured,
  inReview,
  reversedTotal = 0,
  holds,
  byRole,
  releaseRule,
  variant = "full",
  className = "",
}: {
  earned: number;
  secured: number;
  inReview: { items: number; projected: number; label: string } | null;
  reversedTotal?: number;
  holds: KarmaHold[];
  byRole?: KarmaHoldsByRole | null;
  releaseRule: KarmaReleaseRule | null;
  variant?: "full" | "compact";
  className?: string;
}) {
  const [ruleOpen, setRuleOpen] = useState(false);
  const [holdsOpen, setHoldsOpen] = useState(variant === "full");
  const nothingHeld = secured === 0 && (inReview?.items ?? 0) === 0;

  return (
    <div className={`card px-4 py-3.5 sm:px-5 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="micro-label text-ink-faint">where your karma is</div>
        {releaseRule && (
          <button
            type="button"
            onClick={() => setRuleOpen((open) => !open)}
            aria-expanded={ruleOpen}
            className="font-mono text-[10px] text-ink-soft underline underline-offset-2 hover:text-ink"
          >
            {ruleOpen ? "hide how karma is released" : "how karma is released"}
          </button>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap gap-px overflow-hidden rounded-lg bg-line-soft">
        <StateCell
          label="earned"
          value={earned}
          tone="earned"
          hint="Karma that has landed in your balance. This is the number that counts toward your tier and your place on the leaderboard."
        />
        <StateCell
          label="secured"
          value={secured}
          tone="secured"
          hint={`Karma you have earned on accepted work and set aside for you. The amount is locked in and cannot go down. ${securedReleaseText(releaseRule)}`}
        />
        {inReview && (
          <StateCell
            label="in review"
            value={inReview.projected}
            tone="estimate"
            suffix="est."
            sub={inReview.label}
            hint={
              releaseRule?.projectionCaveat ??
              "A rough guide for work still being checked. It is not being held for you yet, is not in your balance, and is worth nothing if the work is not accepted."
            }
          />
        )}
      </div>

      {nothingHeld && (
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-soft">
          Nothing is being held for you right now. Karma lands in your balance as soon as your work is finally
          accepted — submitting on its own never earns karma.
        </p>
      )}

      {reversedTotal > 0 && (
        <p className="mt-2.5 text-[12px] leading-relaxed text-amber-700">
          {reversedTotal.toLocaleString()} karma was set aside and then cancelled after an accepted item was
          overturned. That is why the held amount can go down.
        </p>
      )}

      {ruleOpen && releaseRule && <KarmaReleaseRuleBlock rule={releaseRule} className="mt-3" />}

      {byRole && variant === "full" && secured > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-ink-soft">
          {(["contributor", "validator", "sponsor"] as const)
            .filter((role) => byRole[role].pending > 0)
            .map((role) => (
              <span key={role}>
                from {ROLE_LABEL[role]}{" "}
                <span className="font-bold text-ink">{byRole[role].pending.toLocaleString()}</span>
              </span>
            ))}
        </div>
      )}

      {holds.length > 0 && variant === "compact" && (
        <button
          type="button"
          onClick={() => setHoldsOpen((open) => !open)}
          aria-expanded={holdsOpen}
          className="mt-3 font-mono text-[10px] text-ink-soft underline underline-offset-2 hover:text-ink"
        >
          {holdsOpen
            ? "hide what is holding it"
            : `what is holding it (${holds.length} ${holds.length === 1 ? "program" : "programs"})`}
        </button>
      )}

      {holds.length > 0 && holdsOpen && (
        <ul className="mt-3 space-y-2">
          {holds.map((hold) => (
            <KarmaHoldRow key={`${hold.bountyId}:${hold.role}`} hold={hold} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function KarmaReleaseRuleBlock({
  rule,
  className = "",
}: {
  rule: KarmaReleaseRule;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-line-soft bg-panel/50 p-3 ${className}`}>
      <p className="text-[12.5px] leading-relaxed text-ink">{rule.summary}</p>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12px] leading-relaxed text-ink-soft marker:font-mono marker:text-[10px] marker:font-bold marker:text-karma">
        {rule.gates.map((gate) => (
          <li key={gate} className="pl-0.5">{gate}</li>
        ))}
      </ol>
      <p className="mt-2.5 border-t border-line-soft pt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
        The review window is set per program; right now it defaults to{" "}
        {rule.defaultDisputeWindowHours}h.
      </p>
    </div>
  );
}

const TONES = {
  earned: { accent: "var(--color-accent-strong)", value: "text-ink" },
  secured: { accent: "var(--color-karma)", value: "text-ink" },
  estimate: { accent: "#c9cdbf", value: "text-ink-soft" },
} as const;

function StateCell({
  label,
  value,
  tone,
  hint,
  sub,
  suffix,
}: {
  label: string;
  value: number;
  tone: keyof typeof TONES;
  hint: string;
  sub?: string;
  suffix?: string;
}) {
  const spec = TONES[tone];
  return (
    <div
      className="min-w-[140px] flex-1 basis-[140px] bg-white px-3.5 py-2.5"
      style={{ boxShadow: `inset 0 2px 0 0 ${spec.accent}` }}
    >
      <div className="flex items-start gap-1.5">
        <div className="micro-label min-w-0 flex-1 leading-snug text-ink-soft">{label}</div>
        <InfoTip text={hint} label={label} />
      </div>
      <div className={`mt-1 font-mono text-[19px] font-bold leading-none tabular-nums ${spec.value}`}>
        {value.toLocaleString()}
        {suffix && <span className="ml-1 text-[10px] font-normal text-ink-faint">{suffix}</span>}
      </div>
      {sub && <div className="mt-1 font-mono text-[10px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function KarmaHoldRow({ hold }: { hold: KarmaHold }) {
  const countdown = windowCountdown(hold.windowClosesAt);
  return (
    <li className="rounded-lg border border-line-soft bg-panel/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Link
          href={`/karma`}
          className="min-w-0 truncate text-[12.5px] font-semibold text-ink underline-offset-2 hover:underline"
          title={hold.bountyTitle}
        >
          {hold.bountyTitle}
        </Link>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
          <span className="font-bold text-ink">+{hold.amount.toLocaleString()}</span>
          <Pill tone={HOLD_REASON_TONE[hold.reason]} className="text-[9.5px]">
            {HOLD_REASON_LABEL[hold.reason]}
          </Pill>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-ink-faint">
        <span>from {ROLE_LABEL[hold.role]}</span>
        <span aria-hidden>·</span>
        <span>
          {hold.awardCount} {hold.awardCount === 1 ? "award" : "awards"}
        </span>
        {countdown && (
          <>
            <span aria-hidden>·</span>
            <span className="text-ink-soft">window clears {countdown}</span>
          </>
        )}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">{hold.explanation}</p>
      {hold.reason === "publication_failed" && (
        <p className="mt-1 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-amber-700">
          <Icon name="alert" size={12} className="mt-px shrink-0" />
          <span>Nothing you can do from here — this one needs an admin to retry the publication.</span>
        </p>
      )}
    </li>
  );
}
