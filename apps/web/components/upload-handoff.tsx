"use client";

// SPDX-License-Identifier: Apache-2.0

import type React from "react";
import { Brandmark } from "@/components/brand";
import { Button, Pill } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";

/**
 * Shared building blocks for the upload handoff surfaces
 * (`/upload/[token]` and `/upload-review/[draftId]`).
 */

export type UploadWorkType = "community" | "unknown";

export function workTypeOf(targetKind: "claimed_batch" | "community_pool" | undefined | null): UploadWorkType {
  if (targetKind === "community_pool") return "community";
  if (targetKind) return "community";
  return "unknown";
}

export function UploadBackdrop({ focus = "top" }: { focus?: "top" | "center" }) {
  const mask = focus === "center"
    ? "[mask-image:radial-gradient(ellipse_75%_65%_at_50%_45%,black_25%,transparent_78%)]"
    : "[mask-image:radial-gradient(ellipse_75%_65%_at_50%_38%,black_25%,transparent_78%)]";
  return (
    <>
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 [background-image:linear-gradient(to_right,rgba(20,25,15,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(20,25,15,0.05)_1px,transparent_1px)] [background-size:34px_34px] ${mask}`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute left-1/2 h-72 w-[28rem] -translate-x-1/2 rounded-full bg-lime-300/30 blur-3xl ${focus === "center" ? "top-1/3" : "top-16"}`}
      />
    </>
  );
}

export function WorkTypeBadge({ workType, className = "" }: { workType: UploadWorkType; className?: string }) {
  if (workType === "unknown") return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-semibold text-karma ${className}`}
    >
      <Icon name="sparkles" size={14} className="shrink-0" />
      Community pool · earns karma
    </span>
  );
}

export function rewardNoun(_workType?: UploadWorkType): string {
  return "karma";
}

export function UploadHandoffHeader({
  workType,
  title = "Upload dataset",
  status,
  statusTone = "warning",
}: {
  workType: UploadWorkType;
  title?: string;
  status?: string;
  statusTone?: "success" | "info" | "warning" | "danger" | "neutral";
}) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-white shadow-sm">
          <Brandmark size={24} />
        </span>
        <h1 className="min-w-0 flex-1 truncate font-mono text-lg font-bold leading-tight sm:text-xl">{title}</h1>
        {status && (
          <span className="shrink-0">
            <Pill tone={statusTone}>{status}</Pill>
          </span>
        )}
      </div>
      {workType !== "unknown" && (
        <div className="mt-2 sm:pl-[52px]">
          <WorkTypeBadge workType={workType} />
        </div>
      )}
    </div>
  );
}

export function UploadStepRail({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="mb-5 flex items-center gap-2" aria-label="Upload progress">
      {steps.map((label, i) => {
        const done = current > i;
        const active = current === i;
        const grows = i < steps.length - 1;
        return (
          <li key={label} className={`flex min-w-0 items-center gap-2 ${grows ? "flex-1" : "flex-none"}`}>
            <span
              aria-hidden
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold leading-none ${
                done ? "bg-ink text-white" : active ? "border-2 border-ink bg-white text-ink" : "border border-line bg-white text-ink-faint"
              }`}
            >
              {done ? "✓" : i + 1}
            </span>
            <span
              className={`text-xs ${
                active ? "shrink-0 font-semibold text-ink" : done ? "hidden truncate text-ink-soft sm:inline" : "hidden truncate text-ink-faint sm:inline"
              }`}
            >
              {label}
            </span>
            {i < steps.length - 1 && <span aria-hidden className={`h-px min-w-3 flex-1 ${done ? "bg-ink" : "bg-line"}`} />}
            <span className="sr-only">{done ? "(done)" : active ? "(current step)" : "(upcoming)"}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function UploadStateCard({
  icon,
  tone = "neutral",
  title,
  message,
  children,
  role,
  busy = false,
}: {
  icon?: IconName;
  tone?: "neutral" | "danger" | "success";
  title: string;
  message?: React.ReactNode;
  children?: React.ReactNode;
  role?: "alert";
  busy?: boolean;
}) {
  const toneClass =
    tone === "danger"
      ? "border-rose-200 bg-rose-50 text-rose-500"
      : tone === "success"
        ? "border-emerald-200 bg-emerald-50 text-emerald-600"
        : "border-line bg-white text-ink";
  return (
    <section
      className="card mx-auto max-w-md px-6 py-10 text-center sm:px-8"
      {...(role ? { role } : {})}
      aria-live={role ? undefined : "polite"}
    >
      <div className="flex items-center justify-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-white shadow-sm">
          <Brandmark size={26} />
        </span>
        {(icon || busy) && (
          <>
            <span className="h-px w-6 bg-line" aria-hidden />
            <span className={`flex h-11 w-11 items-center justify-center rounded-xl border shadow-sm ${toneClass}`}>
              {busy ? (
                <span className="block h-5 w-5 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden />
              ) : (
                <Icon name={icon as IconName} size={22} />
              )}
            </span>
          </>
        )}
      </div>
      <h2 className="mt-5 font-mono text-lg font-bold">{title}</h2>
      {message && <p className="mt-3 text-sm leading-relaxed text-ink-soft">{message}</p>}
      {children && <div className="mt-6 flex flex-col gap-2">{children}</div>}
    </section>
  );
}

export function UploadTrustNote({ submitted = false, className = "" }: { submitted?: boolean; className?: string }) {
  return (
    <p className={`mx-auto flex w-fit items-center gap-2 rounded-full border border-line bg-white/70 px-4 py-2 text-center text-xs text-ink-soft shadow-sm ${className}`}>
      <Icon name="shield" size={14} className="shrink-0 text-emerald-600" />
      <span>
        Secured by <span className="font-semibold text-ink">DataBounty</span> —{" "}
        {submitted ? "we submitted exactly the rows you approved, nothing more" : "nothing is submitted until you press submit"}
      </span>
    </p>
  );
}

export function UploadHandoffStage({
  children,
  center = false,
  focus = "top",
  width = "wide",
}: {
  children: React.ReactNode;
  center?: boolean;
  focus?: "top" | "center";
  width?: "wide" | "narrow";
}) {
  return (
    <main
      className={`relative flex min-h-screen justify-center overflow-hidden bg-panel px-4 py-8 sm:px-6 sm:py-12 ${center ? "items-center" : ""}`}
    >
      <UploadBackdrop focus={focus} />
      <div className={`relative w-full ${width === "narrow" ? "max-w-md" : "max-w-xl lg:max-w-2xl"}`}>{children}</div>
    </main>
  );
}

export function WorkspaceLink({ label = "Go to my workspace" }: { label?: string }) {
  return (
    <Button href="/contributor" className="w-full justify-center">
      {label}
    </Button>
  );
}
