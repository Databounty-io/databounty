"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, ConfirmDialog } from "@/components/ui";
import { Icon } from "@/components/icons";
import {
  UploadHandoffHeader,
  UploadHandoffStage,
  UploadStateCard,
  UploadStepRail,
  UploadTrustNote,
  WorkspaceLink,
  rewardNoun,
  workTypeOf,
} from "@/components/upload-handoff";
import { uploadDraftSource } from "@/lib/api-artifacts";
import { draftAuthHeaders, forgetDraftToken } from "@/lib/upload-draft-session";
import { API } from "@/lib/api-endpoints";
import { apiClient, ApiError } from "@/lib/api-client";
import { authedFetch } from "@/lib/store";
import type { SourceUploadRequirements } from "@/lib/api-work";

type Summary = {
  rowsRead?: number;
  acceptedRows?: number;
  rejectedRows?: number;
  submittedRows?: number;
  stoppedEarly?: boolean;
  stopReason?: string | null;
  parserVersion?: string;
  error?: string;
};
type RejectedRow = { rowNumber: number; errorCode: string | null; errorMessage: string | null };
type Draft = {
  id: string;
  targetKind: "claimed_batch" | "community_pool";
  bountyId: string | null;
  batchId: string | null;
  generationMethod: string;
  expectedItemCount: number | null;
  sourceDescription: string | null;
  autoSubmitWhenReady: boolean;
  status:
    | "awaiting_upload"
    | "uploading"
    | "parsing"
    | "review_ready"
    | "submitting"
    | "submitted"
    | "cancelled"
    | "failed";
  sourceArtifactId: string | null;
  previewSummary: Summary | null;
  draftExpiresAt: string;
  sourceUpload: SourceUploadRequirements;
};

export function UploadReviewDraftView() {
  const params = useParams<{ draftId?: string | string[] }>();
  const router = useRouter();
  const id = Array.isArray(params.draftId) ? params.draftId[0] : params.draftId;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [expired, setExpired] = useState(false);
  const [issues, setIssues] = useState<RejectedRow[] | "unavailable" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await apiClient.get<{ draft: Draft }>(API.uploadReviewDrafts.one(id), {
        headers: draftAuthHeaders(id),
      });
      setDraft(data.draft);
      setError(null);
    } catch (cause) {
      const gone = cause instanceof ApiError && cause.status === 404;
      if (gone) setDraft(null);
      setError(
        gone
          ? "This review session has wrapped up or timed out. Nothing was lost — start a new upload from your workspace whenever you're ready."
          : "We couldn't load this upload review just now. Please try again in a moment."
      );
    }
  }, [id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!draft || !["uploading", "parsing", "submitting"].includes(draft.status)) return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [draft, load]);

  useEffect(() => {
    if (!draft || ["submitted", "cancelled", "failed"].includes(draft.status)) return;
    const remaining = new Date(draft.draftExpiresAt).getTime() - Date.now();
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    if (
      !draft ||
      draft.status !== "review_ready" ||
      !(draft.previewSummary?.rejectedRows ?? 0) ||
      issues !== null
    )
      return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(API.uploadReviewDrafts.rejectedRows(draft.id), {
          headers: draftAuthHeaders(draft.id),
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { rejectedRows: RejectedRow[] };
        if (!cancelled) setIssues(body.rejectedRows);
      } catch {
        if (!cancelled) setIssues("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draft, issues]);

  const selectFile = async (file: File) => {
    if (!draft || busy || inFlightRef.current || draft.status !== "awaiting_upload") return;
    if (!draft.sourceUpload.available) {
      setError(draft.sourceUpload.unavailableReason ?? "This dataset source format is unavailable.");
      return;
    }
    const lowerName = file.name.toLowerCase();
    const extensionAllowed = draft.sourceUpload.extensions.some((ext) =>
      lowerName.endsWith(ext.toLowerCase())
    );
    if (!extensionAllowed) {
      setError(
        `That file type isn't supported here. Choose one of: ${draft.sourceUpload.extensions.join(", ")}.`
      );
      return;
    }
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    setUploadProgress(0);
    try {
      const uploaded = await uploadDraftSource(draft.id, file, setError, setUploadProgress);
      if (uploaded) await load();
    } finally {
      inFlightRef.current = false;
      setBusy(false);
      setUploadProgress(null);
    }
  };

  const submit = async () => {
    if (!draft || busy || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(API.uploadReviewDrafts.submit(draft.id), undefined, {
        headers: draftAuthHeaders(draft.id),
      });
      await load();
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "We couldn't submit this review just now. It's safe to try again.";
      await load();
      setError(message);
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!draft || busy || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      await apiClient.post(API.uploadReviewDrafts.cancel(draft.id), undefined, {
        headers: draftAuthHeaders(draft.id),
      });
      forgetDraftToken(draft.id);
      router.replace("/contributor");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "We couldn't cancel this review. Please try again."
      );
      inFlightRef.current = false;
      setBusy(false);
      setConfirmCancel(false);
    }
  };

  const downloadErrors = async () => {
    if (!draft) return;
    try {
      const res = await authedFetch(API.uploadReviewDrafts.rejectedRows(draft.id), {
        headers: draftAuthHeaders(draft.id),
      });
      if (!res.ok) {
        setError("We couldn't download the rejected-row report. Please try again.");
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "rejected-rows.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("We couldn't download the rejected-row report. Please try again.");
    }
  };

  const workType = workTypeOf(draft?.targetKind);
  const reward = rewardNoun(workType);
  const statusTone =
    draft?.status === "submitted"
      ? "success"
      : draft?.status === "review_ready"
        ? "info"
        : draft?.status === "failed"
          ? "danger"
          : "warning";

  const stepIndex = !draft
    ? 0
    : draft.status === "awaiting_upload"
      ? 0
      : ["uploading", "parsing"].includes(draft.status)
        ? 1
        : draft.status === "review_ready" || draft.status === "submitting"
          ? 2
          : draft.status === "submitted"
            ? 3
            : 0;

  const terminal = draft && ["failed", "cancelled"].includes(draft.status);
  const rejected = draft?.previewSummary?.rejectedRows ?? 0;
  const accepted = draft?.previewSummary?.acceptedRows ?? 0;
  const parsedRows = draft?.previewSummary?.rowsRead ?? 0;

  const issueGroups = Array.isArray(issues)
    ? [
        ...issues
          .reduce((map, row) => {
            const key = row.errorMessage || row.errorCode || "Unreadable row";
            const entry = map.get(key) ?? { message: key, rows: [] as number[] };
            entry.rows.push(row.rowNumber);
            return map.set(key, entry);
          }, new Map<string, { message: string; rows: number[] }>())
          .values(),
      ].sort((a, b) => b.rows.length - a.rows.length)
    : [];

  const rowsLabel = (rows: number[]) =>
    rows.length <= 3
      ? `row${rows.length === 1 ? "" : "s"} ${rows.join(", ")}`
      : `rows ${rows.slice(0, 3).join(", ")} +${rows.length - 3} more`;

  const STEPS = ["Choose file", "We check it", "You submit"];

  if (expired) {
    return (
      <UploadHandoffStage center width="narrow">
        <UploadStateCard
          role="alert"
          icon="clock"
          tone="danger"
          title="This review timed out"
          message="This upload session sat idle past its expiry, so it closed for your security. Nothing was submitted — start a fresh upload from your workspace whenever you're ready."
        >
          <WorkspaceLink />
        </UploadStateCard>
        <UploadTrustNote className="mt-6" />
      </UploadHandoffStage>
    );
  }

  return (
    <UploadHandoffStage center={!draft}>
      {draft && (
        <UploadHandoffHeader
          workType={workType}
          title="Upload dataset"
          status={draft.status.replace(/_/g, " ")}
          statusTone={statusTone as "success" | "info" | "warning" | "danger"}
        />
      )}

      {draft && !terminal && <UploadStepRail steps={STEPS} current={stepIndex} />}

      {error && draft && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      )}

      {error && !draft && (
        <UploadStateCard
          role="alert"
          icon="alert"
          tone="danger"
          title="This review isn’t available"
          message={error}
        >
          <WorkspaceLink />
          <Button variant="secondary" className="w-full justify-center" onClick={() => void load()}>
            Try again
          </Button>
        </UploadStateCard>
      )}

      {!draft && !error && (
        <UploadStateCard
          busy
          title="Opening your upload"
          message="Fetching your secure upload review…"
        />
      )}

      {draft && (
        <section className="card overflow-hidden">
          {draft.status === "awaiting_upload" && (
            <div
              className="cursor-pointer p-6 text-center transition-colors hover:bg-panel/50 sm:p-10"
              onClick={() => !busy && draft.sourceUpload.available && fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file && !busy) void selectFile(file);
              }}
            >
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-dashed border-line bg-white [background-image:radial-gradient(rgba(20,25,15,0.14)_1px,transparent_1px)] [background-size:7px_7px]">
                <Icon name="upload" size={26} className="text-ink" />
              </span>
              <h2 className="mt-4 font-mono text-base font-bold">Drop your dataset file here</h2>
              <p className="mt-1 text-sm text-ink-soft">or click anywhere in this card to browse</p>
              <p className="mx-auto mt-3 max-w-sm text-xs leading-relaxed text-ink-faint">
                {draft.sourceUpload.available
                  ? `One source file — we accept ${draft.sourceUpload.extensions.join(", ")}. Its format and safety requirements are checked before review; nothing is submitted until you confirm.`
                  : draft.sourceUpload.unavailableReason}
              </p>
              <p className="mx-auto mt-2 max-w-sm text-xs font-medium text-ink-soft">
                This is community work — accepted rows earn karma and credit.
              </p>
              <input
                ref={fileRef}
                className="hidden"
                type="file"
                accept={draft.sourceUpload.accept}
                disabled={!draft.sourceUpload.available}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void selectFile(file);
                  e.currentTarget.value = "";
                }}
              />
              {busy && uploadProgress != null ? (
                <div className="mx-auto mt-5 max-w-xs" role="status" aria-live="polite">
                  <div
                    className="h-2 overflow-hidden rounded-full bg-panel"
                    role="progressbar"
                    aria-valuenow={Math.round(uploadProgress * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="h-full rounded-full bg-sky-500 transition-[width]"
                      style={{ width: `${Math.max(2, Math.round(uploadProgress * 100))}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs font-medium text-ink-soft">
                    {uploadProgress >= 1
                      ? "Finishing up…"
                      : `Uploading… ${Math.round(uploadProgress * 100)}%`}
                  </p>
                </div>
              ) : (
                <Button
                  className="mt-5 w-full justify-center sm:w-auto"
                  disabled={busy || !draft.sourceUpload.available}
                  onClick={(e) => {
                    e.stopPropagation();
                    fileRef.current?.click();
                  }}
                >
                  Choose file
                </Button>
              )}
            </div>
          )}

          {["uploading", "parsing"].includes(draft.status) && (
            <div className="p-6 text-center sm:p-10" aria-live="polite">
              <span
                className="mx-auto block h-8 w-8 animate-spin rounded-full border-2 border-sky-200 border-t-sky-600"
                aria-hidden
              />
              <h2 className="mt-4 font-mono text-base font-bold">Checking your file…</h2>
              <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-ink-soft">
                Security scan and parsing are running. This page updates by itself — keep it open, no need to refresh.
              </p>
            </div>
          )}

          {draft.status === "review_ready" && (
            <div className="p-6 sm:p-8">
              <div className="text-center">
                <p className="font-mono text-4xl font-bold tabular-nums text-emerald-700">
                  {accepted}
                </p>
                <p className="mt-1 text-sm font-semibold">
                  row{accepted === 1 ? "" : "s"} ready to submit
                </p>
                <p className="mt-0.5 text-xs text-ink-faint">from {parsedRows} read in your file</p>
              </div>
              <div className="mx-auto mt-4 max-w-sm">
                <div
                  className="h-2 overflow-hidden rounded-full bg-panel"
                  role="img"
                  aria-label={`${accepted} of ${parsedRows} rows ready`}
                >
                  <div
                    className="h-full rounded-full bg-emerald-500"
                    style={{
                      width: `${parsedRows ? Math.max(2, Math.round((accepted / parsedRows) * 100)) : 0}%`,
                    }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-[11px]">
                  <span className="text-emerald-700">{accepted} ready</span>
                  {rejected > 0 ? (
                    <span className="font-medium text-amber-700">{rejected} need a fix</span>
                  ) : (
                    <span className="text-ink-faint">no issues found</span>
                  )}
                </div>
              </div>

              {rejected > 0 && (
                <div className="mx-auto mt-5 max-w-md rounded-lg border border-amber-200 bg-amber-50 p-4 text-left">
                  <p className="text-sm font-semibold text-amber-900">
                    Why {rejected === 1 ? "that row needs" : `these ${rejected} rows need`} a fix
                  </p>
                  {issues === null && <p className="mt-2 text-xs text-amber-800">Loading the reasons…</p>}
                  {issues === "unavailable" && (
                    <p className="mt-2 text-xs text-amber-800">
                      We couldn&rsquo;t load the reasons here — the downloadable report below has every row and message.
                    </p>
                  )}
                  {issueGroups.length > 0 && (
                    <ul className="mt-2 space-y-1.5">
                      {issueGroups.map((group) => (
                        <li
                          key={group.message}
                          className="flex items-start justify-between gap-3 text-xs leading-relaxed text-amber-900"
                        >
                          <span>
                            {group.message}{" "}
                            <span className="text-amber-700">({rowsLabel(group.rows)})</span>
                          </span>
                          <span className="shrink-0 font-mono font-bold tabular-nums">
                            ×{group.rows.length}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-3 text-xs text-amber-800">
                    <button
                      type="button"
                      className="font-medium text-amber-900 underline underline-offset-2 hover:text-amber-950"
                      onClick={() => void downloadErrors()}
                    >
                      Download the full report
                    </button>{" "}
                    · these rows are simply left out — your {accepted} good row
                    {accepted === 1 ? "" : "s"} submit fine.
                  </p>
                </div>
              )}

              <p className="mx-auto mt-4 max-w-sm text-center text-xs leading-relaxed text-ink-soft">
                Nothing has been submitted yet — that happens only when you press the button below. Rows that pass validation earn {reward}.
              </p>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
                <Button
                  className="justify-center"
                  disabled={busy || accepted === 0}
                  onClick={() => void submit()}
                >
                  {busy ? "Submitting…" : `Submit ${accepted} row${accepted === 1 ? "" : "s"}`}
                </Button>
                <Button
                  className="justify-center"
                  disabled={busy}
                  variant="secondary"
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {draft.status === "submitting" && (
            <div className="p-6 text-center sm:p-10" aria-live="polite">
              <span
                className="mx-auto block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-ink"
                aria-hidden
              />
              <h2 className="mt-4 font-mono text-base font-bold">
                Adding your rows in secure batches…
              </h2>
              <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">
                Large sources continue in the background. This page updates automatically; you can keep it open or return to your workspace.
              </p>
            </div>
          )}

          {draft.status === "submitted" && (
            <div className="p-6 text-center sm:p-10">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50">
                <Icon name="check" size={28} className="text-emerald-600" />
              </span>
              <h2 className="mt-4 font-mono text-base font-bold text-emerald-800">
                {(draft.previewSummary?.submittedRows ?? accepted) > 0
                  ? `${draft.previewSummary?.submittedRows ?? accepted} row${(draft.previewSummary?.submittedRows ?? accepted) === 1 ? "" : "s"} submitted!`
                  : "All set — submitted!"}
              </h2>
              <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-ink-soft">
                Validation continues in the background, and rows it accepts will earn {reward}. You can close this page and track progress from your workspace.
              </p>
              {draft.previewSummary?.stoppedEarly && draft.previewSummary.stopReason && (
                <p className="mx-auto mt-3 max-w-sm text-xs leading-relaxed text-amber-800">
                  This source reached the available capacity before every row could be added: {draft.previewSummary.stopReason}
                </p>
              )}
              <Button href="/contributor" className="mt-5 w-full justify-center sm:w-auto">
                Go to my workspace
              </Button>
            </div>
          )}

          {draft.status === "failed" && (
            <div className="p-6 text-center sm:p-10">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-rose-200 bg-rose-50">
                <Icon name="alert" size={26} className="text-rose-500" />
              </span>
              <h2 className="mt-4 font-mono text-base font-bold text-rose-800">
                We couldn&apos;t process this upload
              </h2>
              <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-rose-800">
                {draft.previewSummary?.error ??
                  "This file couldn't be turned into reviewable rows. Start a fresh upload and we'll try again."}
              </p>
              <Button href="/contributor" className="mt-5 w-full justify-center sm:w-auto">
                Go to my workspace
              </Button>
            </div>
          )}

          {draft.status === "cancelled" && (
            <div className="p-6 text-center sm:p-10">
              <h2 className="font-mono text-base font-bold">Review cancelled</h2>
              <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-ink-soft">
                Nothing was submitted. Start a new upload from your workspace whenever you&rsquo;re ready.
              </p>
              <Button href="/contributor" className="mt-5 w-full justify-center sm:w-auto">
                Go to my workspace
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-line bg-panel/40 px-4 py-3 text-[11px] text-ink-faint">
            <span>
              Generation: <span className="text-ink-soft">{draft.generationMethod.replace(/_/g, " ")}</span>
            </span>
            {draft.expectedItemCount != null && (
              <span>
                Expected: <span className="text-ink-soft">{draft.expectedItemCount}</span>
              </span>
            )}
            {!["submitted", "cancelled", "failed"].includes(draft.status) && (
              <span>
                Expires: <span className="text-ink-soft">{new Date(draft.draftExpiresAt).toLocaleString()}</span>
              </span>
            )}
          </div>
        </section>
      )}

      <UploadTrustNote submitted={draft?.status === "submitted"} className="mt-6" />

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this upload review?"
        description="Your file will not be submitted and this link will stop working. You can always start a fresh upload from your workspace."
        confirmLabel={busy ? "Cancelling…" : "Yes, cancel it"}
        cancelLabel="Keep reviewing"
        confirmDisabled={busy}
        onConfirm={() => void cancel()}
        onCancel={() => setConfirmCancel(false)}
      />
    </UploadHandoffStage>
  );
}
