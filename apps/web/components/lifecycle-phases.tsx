// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/components/icons";

export type LifecyclePhaseState = "done" | "current" | "upcoming" | "blocked";

export interface LifecyclePhase {
  key: string;
  label: string;
  state: LifecyclePhaseState;
  detail: string | null;
  waitingOn?: string;
  progress?: number | null;
}

export interface CommunityLifecycle {
  phases: LifecyclePhase[];
  currentIndex: number;
}

const MARK: Record<LifecyclePhaseState, { icon: "check" | "clock" | "alert"; ring: string; text: string }> = {
  done: { icon: "check", ring: "border-accent-strong bg-[#eaf3d6] text-accent-strong", text: "text-ink" },
  current: { icon: "clock", ring: "border-karma bg-karma-soft text-karma", text: "text-ink" },
  blocked: { icon: "alert", ring: "border-amber-400 bg-amber-50 text-amber-700", text: "text-ink" },
  upcoming: { icon: "clock", ring: "border-line bg-white text-ink-faint", text: "text-ink-faint" },
};

const STATE_LABEL: Record<LifecyclePhaseState, string> = {
  done: "done",
  current: "in progress",
  blocked: "needs attention",
  upcoming: "not started",
};

function humanizeDetail(detail: string): string {
  return detail.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  });
}

export function LifecyclePhases({
  lifecycle,
  className = "",
}: {
  lifecycle: CommunityLifecycle;
  className?: string;
}) {
  return (
    <ol className={`card divide-y divide-line-soft ${className}`}>
      {lifecycle.phases.map((phase) => {
        const mark = MARK[phase.state];
        const pct = phase.progress != null ? Math.round(phase.progress * 100) : null;
        return (
          <li key={phase.key} className="flex gap-3 px-4 py-3 sm:px-5">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${mark.ring}`}
              aria-hidden
            >
              <Icon name={mark.icon} size={11} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className={`text-[13px] font-semibold ${mark.text}`}>
                  {phase.label}
                  <span className="sr-only"> — {STATE_LABEL[phase.state]}</span>
                </span>
                <span className="font-mono text-[10px] text-ink-faint">
                  {phase.detail ? humanizeDetail(phase.detail) : STATE_LABEL[phase.state]}
                </span>
              </div>
              {pct != null && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line-soft">
                  <div
                    className={`h-full rounded-full ${phase.state === "done" ? "bg-accent-strong" : "bg-karma"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              {phase.waitingOn && (
                <p className={`mt-1.5 text-[12px] leading-relaxed ${phase.state === "blocked" ? "text-amber-700" : "text-ink-soft"}`}>
                  {phase.waitingOn}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
