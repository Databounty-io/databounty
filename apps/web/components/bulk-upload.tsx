"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, CodeBlock, Pill } from "@/components/ui";
import { Icon } from "@/components/icons";
import { fieldRows, stringValue } from "@/components/dynamic-item-fields";
import { GENERATION_LABELS, SUBMISSION_STATUS_LABELS } from "@/lib/format";
import {
  itemReady,
  MAX_BULK_SOURCE_BYTES,
  parseFile,
  payloadForDataset,
  rowLabel,
  type ParsedItem,
} from "@/lib/bulk-parse";
import type { DatasetType } from "@/lib/dataset-types";
import type { ApiSubmissionDetail, SourceUploadRequirements } from "@/lib/api-work";

/* ---------- Segmented control (distinct from the dark primary Button) ---------- */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex gap-1 rounded-lg border border-line bg-panel p-1">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`rounded-md px-3.5 py-1.5 font-mono text-xs font-medium transition-colors ${
              active ? "bg-white text-ink shadow-sm" : "text-ink-soft hover:text-ink"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export type SubmissionOutcome =
  | { index: number; item: ParsedItem; kind: "created"; submission: ApiSubmissionDetail }
  | { index: number; item: ParsedItem; kind: "failed"; error: string };

/**
 * Shared bulk uploader for the community open-pool flow.
 * Parsing/normalisation come from lib/bulk-parse; the only
 * per-flow differences are passed in as props (reward label, attestation
 * wording, and the over-capacity message).
 */
export function BulkUpload({
  type,
  remainingItems,
  rewardLabel,
  attestLabel,
  overCapacityMessage,
  onSubmitAll,
  submitting,
  sourceUpload,
}: {
  type: DatasetType | null;
  remainingItems: number;
  rewardLabel: React.ReactNode;
  attestLabel: string;
  overCapacityMessage: (itemCount: number, remaining: number) => string;
  onSubmitAll: (items: ParsedItem[], sourceFile?: File) => void;
  submitting: boolean;
  sourceUpload: SourceUploadRequirements;
}) {
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [attested, setAttested] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const readyCount = useMemo(() => items.filter((item) => itemReady(item, type)).length, [items, type]);
  const withinCapacity = items.length <= remainingItems;

  const ingest = (parsed: ParsedItem[], name: string, file?: File) => {
    if (parsed.length === 0) {
      setError("No items found in the file.");
      return;
    }
    setItems(parsed);
    setSelected(0);
    setFileName(name);
    setSourceFile(file ?? null);
    setError("");
    setAttested(false);
  };

  const handleFile = (file: File) => {
    if (!sourceUpload.available) {
      setError(sourceUpload.unavailableReason ?? "This dataset source format is not available for browser upload.");
      return;
    }
    const lowerName = file.name.toLowerCase();
    const extensionAllowed = sourceUpload.extensions.some((extension) => lowerName.endsWith(extension.toLowerCase()));
    const mimeAllowed = !file.type || sourceUpload.mimeTypes.includes(file.type.toLowerCase());
    if (!extensionAllowed || !mimeAllowed) {
      setError(`Choose one of the allowed ${sourceUpload.profile} files: ${sourceUpload.extensions.join(", ")}.`);
      return;
    }
    if (file.size <= 0) {
      setError("The selected file is empty.");
      return;
    }
    if (file.size > MAX_BULK_SOURCE_BYTES) {
      setError("Bulk source files must be 10 MB or smaller. Split this into smaller files.");
      return;
    }
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseFile(file.name, String(reader.result ?? ""));
        ingest(parsed, file.name, file);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not parse this file.");
      }
    };
    reader.onerror = () => setError("Could not read this file.");
    reader.readAsText(file);
  };

  /* -------- No items yet: dropzone -------- */
  if (items.length === 0) {
    const formatList = sourceUpload.extensions.join(", ");
    return (
      <div className="card px-5 py-6 sm:px-6">
        <label
          htmlFor="bulk-file"
          onDragEnter={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (!file) return;
            if (e.dataTransfer.files.length > 1) {
              setError(`Drop one ${sourceUpload.extensions.join(", ")} file at a time.`);
              return;
            }
            handleFile(file);
          }}
          className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${sourceUpload.available ? "cursor-pointer" : "cursor-not-allowed opacity-75"} ${
            dragOver ? "border-[#5b8a00] bg-lime/10" : "border-line bg-panel hover:border-ink"
          }`}
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-lime">
            <Icon name="upload" size={20} />
          </div>
          <div className="mt-3 font-mono text-sm font-bold text-ink">
            {sourceUpload.available ? (dragOver ? "Release to load the file" : `Drop a ${formatList} source file`) : "Browser source upload unavailable"}
          </div>
          <p className="mt-1 max-w-sm text-xs text-ink-soft">
            {sourceUpload.available ? `Allowed by ${sourceUpload.profile}: ${formatList}. Maximum 10 MB for in-browser review.` : sourceUpload.unavailableReason}
          </p>
          <input
            id="bulk-file"
            type="file"
            accept={sourceUpload.accept}
            disabled={!sourceUpload.available}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.currentTarget.value = "";
            }}
          />
        </label>

        <div className="mt-4 border-t border-line-soft pt-3 font-mono text-[11px] text-ink-soft">
          Prefer to submit programmatically?{" "}
          <Link href="/developers" className="inline-flex items-center gap-1 align-middle font-medium text-ink hover:underline">
            API &amp; MCP
            <Icon name="arrow-right" size={11} />
          </Link>
        </div>

        {error && (
          <div role="alert" className="mt-4 flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">
            <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
            <p className="leading-relaxed">{error}</p>
          </div>
        )}
      </div>
    );
  }

  /* -------- Review view -------- */
  const current = items[selected];
  const allReady = readyCount === items.length;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-xs text-ink-soft">
          <Icon name="file" size={14} />
          <span className="max-w-full truncate text-ink">{fileName}</span>
          <span>· item {selected + 1} of {items.length}</span>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
              allReady ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"
            }`}
          >
            {readyCount} of {items.length} ready
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setItems([]);
            setSourceFile(null);
            setError("");
          }}
        >
          <Icon name="refresh" size={13} />
          Choose a different file
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        {/* LEFT list */}
        <div className="card h-max overflow-hidden">
          <div className="border-b border-line-soft px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-[.05em] text-ink-faint">
            parsed items
          </div>
          <ul className="max-h-[520px] overflow-y-auto p-1.5">
            {items.map((it, i) => {
              const ready = itemReady(it, type);
              const active = i === selected;
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => setSelected(i)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                      active ? "bg-brand-soft" : "hover:bg-panel"
                    }`}
                  >
                    <span className="font-mono text-[11px] text-ink-faint">{String(i + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                      {rowLabel(it) || <span className="text-ink-faint">untitled</span>}
                    </span>
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${ready ? "bg-emerald-500" : "bg-amber-500"}`}
                      title={ready ? "ready" : "needs fields"}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* MAIN pane */}
        <div className="card px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[15px] font-bold text-ink">{current.title || "Untitled item"}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Pill tone={current.generationMethod === "human" ? "neutral" : "info"}>
                  {GENERATION_LABELS[current.generationMethod]}
                </Pill>
                {current.bugType && <Pill tone="neutral">{current.bugType}</Pill>}
                {itemReady(current, type) ? <Pill tone="success">ready</Pill> : <Pill tone="warning">needs fields</Pill>}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="secondary" size="sm" disabled={selected === 0} onClick={() => setSelected((s) => Math.max(0, s - 1))}>
                prev
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={selected === items.length - 1}
                onClick={() => setSelected((s) => Math.min(items.length - 1, s + 1))}
              >
                next
              </Button>
            </div>
          </div>

          <div className="mt-4 space-y-4">
            {(type ? fieldRows(type) : []).map((field) => {
              const payload = payloadForDataset(type, current);
              const text = stringValue(payload[field.key]);
              const codeLike = ["input_code", "solution_code", "tests", "expected_output"].includes(field.role);
              return codeLike ? (
                <CodeBlock key={field.key} label={`${field.key} — ${field.label}`} code={text || "// —"} />
              ) : (
                <div key={field.key}>
                  <div className="micro-label mb-1.5 text-ink-soft">
                    {field.key} — {field.label}
                  </div>
                  <p className="break-words rounded-lg border border-line-soft bg-panel px-3 py-2 text-sm leading-relaxed text-ink">
                    {text || <span className="text-ink-faint">— empty —</span>}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {!withinCapacity && (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 font-mono text-xs text-rose-700" role="alert">
          {overCapacityMessage(items.length, remainingItems)}
        </div>
      )}

      {/* Attest + submit all */}
      <div className="card mt-4 px-5 py-4 sm:px-6">
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={attested}
            onChange={(e) => setAttested(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-line accent-[var(--color-brand)]"
          />
          <span className="leading-snug">{attestLabel.replace("{count}", String(items.length))}</span>
        </label>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <span className="font-mono text-xs text-ink-soft">
            {readyCount} of {items.length} ready · {rewardLabel}
          </span>
          <Button
            disabled={!attested || items.length === 0 || !allReady || !withinCapacity || submitting}
            aria-busy={submitting}
            onClick={() => onSubmitAll(items, sourceFile ?? undefined)}
          >
            <Icon name="send" size={15} />
            {submitting ? "Submitting…" : `Submit ${items.length} items`}
          </Button>
        </div>
      </div>
    </>
  );
}

export function BulkSubmissionSummary({
  outcomes,
  submitting,
  onRetry,
}: {
  outcomes: SubmissionOutcome[];
  submitting: boolean;
  onRetry: (index: number) => void;
}) {
  if (outcomes.length === 0) return null;

  const created = outcomes.filter((outcome) => outcome.kind === "created");
  const failed = outcomes.filter((outcome) => outcome.kind === "failed");

  return (
    <section className="card mt-5 scroll-mt-6 overflow-hidden" aria-live="polite" aria-label="Submission results">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft px-5 py-4 sm:px-6">
        <div>
          <h2 className="font-mono text-sm font-bold text-ink">Submission results</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">
            {created.length} item{created.length === 1 ? "" : "s"} reached the API
            {failed.length > 0 ? ` · ${failed.length} item${failed.length === 1 ? "" : "s"} could not be submitted` : ""}
          </p>
        </div>
        {failed.length > 0 && <Pill tone="warning">{failed.length} retry available</Pill>}
      </div>

      <div className="divide-y divide-line-soft">
        {outcomes.map((outcome) => {
          const label =
            outcome.kind === "created"
              ? SUBMISSION_STATUS_LABELS[outcome.submission.status as keyof typeof SUBMISSION_STATUS_LABELS] ?? outcome.submission.status
              : "Not submitted";
          const needsRevision =
            outcome.kind === "created" && ["tests_failed", "needs_fixes", "rejected", "flagged"].includes(outcome.submission.status);

          return (
            <div key={`${outcome.index}-${outcome.kind}`} className="flex flex-wrap items-start gap-3 px-5 py-3.5 sm:px-6">
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                  outcome.kind === "failed" || needsRevision ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                }`}
              >
                <Icon name={outcome.kind === "failed" ? "x" : needsRevision ? "alert" : "check"} size={12} strokeWidth={3} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{outcome.item.title || `Item ${outcome.index + 1}`}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                      outcome.kind === "failed"
                        ? "border-rose-200 bg-rose-50 text-rose-700"
                        : needsRevision
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-emerald-200 bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    {label}
                  </span>
                </div>
                {outcome.kind === "failed" && <p className="mt-1 text-xs leading-relaxed text-rose-700">{outcome.error}</p>}
                {outcome.kind === "created" && needsRevision && (
                  <p className="mt-1 text-xs leading-relaxed text-amber-800">
                    Open the item to see the exact check result and revise this submission.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {outcome.kind === "created" ? (
                  <Link
                    href={`/contributor/submissions/${outcome.submission.id}`}
                    className="inline-flex items-center gap-1 font-mono text-xs font-medium text-accent-strong hover:underline"
                  >
                    {needsRevision ? "open & revise" : "view status"}
                    <Icon name="arrow-right" size={12} />
                  </Link>
                ) : (
                  <Button size="sm" variant="secondary" disabled={submitting} onClick={() => onRetry(outcome.index)}>
                    <Icon name="refresh" size={13} />
                    Retry
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
