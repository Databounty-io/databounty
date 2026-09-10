"use client";

// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import { prepareSampleFiles } from "@/lib/sample-expansion";

export function SampleUploadField({
  accept,
  acceptLabel,
  slotMax,
  slotsUsed,
  slotsRequired,
  onFiles,
  submitLabel = "attaching…",
  disabled = false,
  externalError = null,
  footer,
  className = "",
}: {
  accept: string;
  acceptLabel?: string;
  slotMax: number;
  slotsUsed: number;
  slotsRequired: number;
  onFiles: (files: File[]) => Promise<void> | void;
  submitLabel?: string;
  disabled?: boolean;
  externalError?: string | null;
  footer?: React.ReactNode;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef(0);
  const [phase, setPhase] = useState<"idle" | "reading" | "submitting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  const handlePick = async (picked: File[]) => {
    if (!picked.length) return;
    const pick = ++pickRef.current;
    const isCurrent = () => pickRef.current === pick;
    setError(null);
    setNotes([]);
    setPhase("reading");
    try {
      const prepared = await prepareSampleFiles({ files: picked, slotMax, slotsUsed });
      if (!isCurrent()) return;
      setNotes(prepared.notes);
      if (prepared.error) {
        setError(prepared.error);
        return;
      }
      setPhase("submitting");
      await onFiles(prepared.files);
    } catch {
      if (isCurrent()) setError("Couldn't read those files. Choose them again to retry.");
    } finally {
      if (isCurrent()) setPhase("idle");
    }
  };

  const busy = phase !== "idle";
  const locked = disabled || busy;
  const remaining = Math.max(0, slotsRequired - slotsUsed);

  return (
    <div className={className}>
      <input
        ref={inputRef}
        // `file:min-h-11` is the touch-target fix, and it has to be real
        // height rather than the `TOUCH_TARGET` pseudo-box every other small
        // control here uses: the tappable thing is the browser-drawn
        // `::file-selector-button`, which a `::after` on the input cannot
        // reach. Measured 554x32 at the 640 breakpoint before this, under the
        // 44x44 minimum (WCAG 2.5.5). The row grows ~12px; nothing else in the
        // panel is positioned against this input's height.
        className="mt-3 block w-full min-h-11 text-xs text-ink-soft file:mr-3 file:min-h-11 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-2 file:text-xs file:font-semibold file:text-ink"
        type="file"
        multiple
        accept={accept}
        disabled={locked || slotsUsed >= slotMax}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          void handlePick(picked);
        }}
      />

      {footer}

      <div className="mt-2 font-mono text-[11px] text-ink-soft" aria-live="polite">
        {phase === "reading"
          ? "reading your files…"
          : phase === "submitting"
            ? submitLabel
            : remaining === 0
            ? "Minimum met — continue to review."
              : slotsUsed === 0
                ? `Attach ${slotsRequired} example${slotsRequired === 1 ? "" : "s"} to continue — one file holding several is split automatically.${acceptLabel ? ` Accepts ${acceptLabel}.` : ""}`
                : `${remaining} more to continue.`}
      </div>

      {notes.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1" aria-live="polite">
          {notes.map((note) => (
            <li key={note} className="text-[11.5px] leading-snug text-ink-soft">{note}</li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
      {externalError && <p className="mt-2 text-xs text-red-700" role="alert">{externalError}</p>}
    </div>
  );
}
