"use client";

// SPDX-License-Identifier: Apache-2.0

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { API } from "@/lib/api-endpoints";
import { authedFetch, useDemo } from "@/lib/store";
import { humanizeKey } from "@/lib/format";
import { BackLink, Button, ConfirmDialog, InfoTip, Pill, Select, TOUCH_TARGET, type PillTone } from "@/components/ui";
import { inputCls } from "@/components/dynamic-item-fields";
import { uploadArtifact, deleteArtifact, occupiesSampleSlot, type ApiArtifact } from "@/lib/api-artifacts";
import { SampleUploadField } from "@/components/sample-upload-field";
import { ArtifactScanStatus } from "@/components/artifact-scan-status";

// Fastify's built-in 404 handler writes messages of the exact shape
// "Route POST:/v1/foo/bar not found" whenever a route genuinely doesn't
// exist server-side — a routing implementation detail, never something a
// real handler would phrase that way. Trusting it blindly meant a missing
// backend route displayed that raw string instead of a friendly fallback.
const FASTIFY_ROUTE_NOT_FOUND = /^Route (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):.* not found$/;
function safeMessage(message: string | undefined, fallback: string): string {
  if (!message || FASTIFY_ROUTE_NOT_FOUND.test(message)) return fallback;
  return message;
}
import { ArtifactChecksPanel } from "@/components/artifacts";
import { useArtifactStatusPolling } from "@/lib/use-artifact-status-polling";
import { sampleAccept, sampleAcceptViolation } from "@/lib/dataset-types";
import {
  RequestReviewConversation,
  RequestSpecGrid,
  ReviewerNote,
} from "@/components/community-request-blocks";
import { PublicationStatus } from "@/components/publication-status";
import { parseDatasetPublication } from "@/lib/publication";
import type { DatasetPublication } from "@/lib/types";

const LICENSE_OPTIONS = [
  { value: "CC-BY-4.0", label: "CC BY 4.0" },
  { value: "CC-BY-SA-4.0", label: "CC BY-SA 4.0" },
  { value: "CC0-1.0", label: "CC0 1.0" },
  { value: "ODC-By-1.0", label: "ODC-By 1.0" },
];

export function communityLicenseLabel(value: string | null | undefined): string {
  if (!value) return "an unspecified license";
  const hit = LICENSE_OPTIONS.find((o) => o.value.toLowerCase() === value.toLowerCase());
  return hit ? hit.label : value;
}

export type DatasetRequestFull = {
  id: string;
  title: string;
  status: string;
  description?: string | null;
  domain?: string | null;
  language?: string | null;
  framework?: string | null;
  targetItems?: number | null;
  difficultyMix?: string | null;
  auditCoveragePct?: number | null;
  proposedLicense?: string | null;
  adminNote?: string | null;
  resubmitCount?: number | null;
  createdAt?: string | null;
  datasetTypeName?: string | null;
  datasetTypeVersion?: number | null;
  datasetTypeId?: string | null;
  reviewedAt?: string | null;
  updatedAt?: string | null;
  mintedBountyId?: string | null;
  mintedBounty?: MintedBounty | null;
};

export type MintedBounty = {
  status?: string | null;
  publicationStatus?: string | null;
  huggingFaceDataset?: string | null;
  /** Every confirmed publication target beyond Hugging Face. */
  publications?: { target: string; url: string; pushedAt: string | null }[];
  acceptedItems?: number | null;
  clearedItems?: number | null;
  targetItems?: number | null;
  karmaPerAcceptedItem?: number | null;
  karmaPricing?: {
    contributorPerItem: number;
    contributorTotal: number;
    validatorPerAuditedItem: number;
    plannedAuditItems: number;
    validatorTotal: number;
    matrixVersion: number | null;
    complexityScore: number | null;
    verificationUnits: number | null;
    difficulty: string;
  } | null;
  duplicateRate?: number | null;
  llmPassRate?: number | null;
  executionPassRate?: number | null;
  submittedItems?: number | null;
  needsFixesItems?: number | null;
  rejectedItems?: number | null;
  totalSubmittedItems?: number | null;
  karmaReleasedTotal?: number | null;
  karmaSecuredTotal?: number | null;
  karmaRecipients?: number | null;
  poolSummary?: {
    policy?: {
      validation: "full_human" | "automation_only";
      sponsorDispute: false;
      karmaRelease: "on_final_accept";
    };
    publication?: DatasetPublication | null;
  } | null;
};

export type SampleGate = {
  ok: boolean;
  approved: number;
  pending: number;
  rejected: number;
  min: number;
  max: number;
  reason: string | null;
};

const SAMPLE_TONE: Record<string, { tone: PillTone; label: string }> = {
  approved: { tone: "success", label: "approved" },
  rejected: { tone: "danger", label: "rejected" },
  needs_changes: { tone: "warning", label: "needs changes" },
  pending: { tone: "neutral", label: "in review" },
};

export const STATUS_TONE: Record<string, PillTone> = {
  under_review: "info",
  submitted: "info",
  approved: "success",
  implemented: "lime",
  changes_requested: "warning",
  declined: "danger",
  disputed: "warning",
};

export const REQUEST_STATUS_HELP: Record<string, string> = {
  submitted:
    "Filed and waiting for a reviewer to pick it up. You can still edit the scope or cancel it.",
  under_review:
    "A reviewer has it open — or you just resubmitted. You can still edit or cancel; otherwise nothing to do until they decide.",
  changes_requested:
    "A reviewer sent it back with a note explaining what to change. Edit the request, then resubmit it for review.",
  approved:
    "A reviewer signed off and your reference samples are now locked. Waiting on an admin to open it as a live community dataset — no longer editable.",
  implemented:
    "Minted: the community dataset is live with your approved samples as the brief, so contributors can submit to it now. Progress and karma awarded show on this card.",
  declined:
    "A reviewer rejected it and left a reason. You can edit and resubmit, or dispute the decision.",
  disputed:
    "You escalated a decline to a human reviewer. Nothing to do until an admin decides — a dispute is never auto-overturned.",
};

export const PUBLICATION_STATUS_HELP: Record<string, string> = {
  pending: "Queued for publication to Hugging Face — the push hasn't started yet.",
  publishing: "Uploading the accepted items to Hugging Face right now.",
  published:
    "Live on Hugging Face under the licence you chose, with DataBounty credit and contributor attribution.",
  failed:
    "The push to Hugging Face failed. An admin can retry it; nothing about the dataset itself is lost.",
  manual_review: "Held for an admin to check before it is pushed to Hugging Face.",
};

export function statusLabel(status: string): string {
  if (status === "under_review") return "In review";
  if (status === "implemented") return "Approved · minted";
  return humanizeKey(status);
}

export function canResubmit(status: string): boolean {
  return status === "changes_requested" || status === "declined";
}

export function canEditOrCancel(status: string): boolean {
  return status === "submitted" || status === "under_review" || status === "changes_requested" || status === "declined";
}

export function canEditSamples(status: string): boolean {
  return (
    status === "submitted" ||
    status === "under_review" ||
    status === "changes_requested" ||
    status === "declined"
  );
}

export function DatasetRequestView({
  request,
  samples = [],
  sampleGate = null,
  onChanged,
  backHref = "/sponsor",
  backLabel = "Back to sponsor",
}: {
  request: DatasetRequestFull;
  samples?: ApiArtifact[];
  sampleGate?: SampleGate | null;
  onChanged?: () => void;
  backHref?: string;
  backLabel?: string;
}) {
  const router = useRouter();
  const { pushToast, datasetTypes } = useDemo();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"reply" | "resubmit" | "save" | "cancel" | null>(null);
  const actionLockRef = useRef(false);

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(request.title);
  const [editDescription, setEditDescription] = useState(request.description ?? "");
  const [editLicense, setEditLicense] = useState(request.proposedLicense ?? LICENSE_OPTIONS[0].value);
  const [editLanguage, setEditLanguage] = useState(request.language ?? "");
  const [editFramework, setEditFramework] = useState(request.framework ?? "");
  const [editTargetItems, setEditTargetItems] = useState(String(request.targetItems ?? ""));
  const [editAuditCoveragePct, setEditAuditCoveragePct] = useState(String(request.auditCoveragePct ?? ""));
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [openChecks, setOpenChecks] = useState<string | null>(null);
  const editable = canEditOrCancel(request.status);
  const samplesEditable = canEditSamples(request.status);

  /**
   * The file types the SERVER will accept for a sample on this request.
   *
   * Derived from the request's own dataset type, exactly as the API does
   * (`services/artifacts.ts` resolves the type from the DatasetRequest and
   * enforces its file-role contract). The picker here was hardcoded to
   * `.txt,.md,.csv,.tsv,.json,.jsonl,.ndjson`, so on a structured template it
   * offered four extensions the server refuses with a 400.
   *
   * When the type is not in the loaded catalog — retired, or the catalog fetch
   * failed — the picker stays UNCONSTRAINED and the server remains the only
   * gate. Narrowing to a contract this side cannot actually read would block
   * uploads the server would have taken, and asserting a permitted set we do
   * not know would be a claim with nothing behind it.
   */
  const requestType = request.datasetTypeId
    ? datasetTypes.find((t) => t.id === request.datasetTypeId) ?? null
    : null;
  const sampleContract = requestType ? sampleAccept(requestType) : { accept: "", label: "" };

  useArtifactStatusPolling(samples.some((sample) => sample.status === "scanning"), () => onChanged?.());

  const addSamples = async (files: File[]) => {
    // Before any bytes move, and for the whole pick: `accept` only constrains
    // the browser's own dialog, and the server's rejection names neither the
    // file nor the permitted types.
    for (const file of files) {
      const violation = sampleAcceptViolation(file, sampleContract.accept, sampleContract.label);
      if (violation) {
        setSampleError(violation);
        return;
      }
    }
    setSampleError(null);
    setSampleBusy(true);
    try {
      for (const file of files) {
        await uploadArtifact(
          file,
          { kind: "sponsor_reference", datasetRequestId: request.id },
          // Name the file — the server's declaration errors carry no filename.
          (message) => setSampleError(`${file.name}: ${message}`)
        );
      }
    } finally {
      setSampleBusy(false);
      onChanged?.();
    }
  };

  const removeSample = async (id: string) => {
    setSampleError(null);
    setSampleBusy(true);
    const ok = await deleteArtifact(id);
    if (!ok) setSampleError("Couldn't remove that sample. Please try again.");
    setSampleBusy(false);
    onChanged?.();
  };

  const startEdit = () => {
    setEditTitle(request.title);
    setEditDescription(request.description ?? "");
    setEditLicense(request.proposedLicense ?? LICENSE_OPTIONS[0].value);
    setEditLanguage(request.language ?? "");
    setEditFramework(request.framework ?? "");
    setEditTargetItems(String(request.targetItems ?? ""));
    setEditAuditCoveragePct(String(request.auditCoveragePct ?? ""));
    setError(null);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (actionLockRef.current) return;
    const targetItemsNum = Number(editTargetItems);
    const auditPctNum = Number(editAuditCoveragePct);
    if (!editTitle.trim() || editTitle.trim().length < 8) return setError("Title must be at least 8 characters.");
    if (!editDescription.trim() || editDescription.trim().length < 30) return setError("Description must be at least 30 characters.");
    if (!Number.isInteger(targetItemsNum) || targetItemsNum < 1) return setError("Item count must be a whole number of at least 1.");
    if (!Number.isInteger(auditPctNum) || auditPctNum < 0 || auditPctNum > 100) return setError("Audit coverage must be a whole percentage between 0 and 100.");

    const patch: Record<string, unknown> = {};
    if (editTitle.trim() !== request.title) patch.title = editTitle.trim();
    if (editDescription.trim() !== (request.description ?? "")) patch.description = editDescription.trim();
    if (editLicense !== request.proposedLicense) patch.proposedLicense = editLicense;
    if (editLanguage.trim() !== (request.language ?? "")) patch.language = editLanguage.trim() || undefined;
    if (editFramework.trim() !== (request.framework ?? "")) patch.framework = editFramework.trim() || undefined;
    if (targetItemsNum !== request.targetItems) patch.targetItems = targetItemsNum;
    if (auditPctNum !== request.auditCoveragePct) patch.auditCoveragePct = auditPctNum;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    actionLockRef.current = true;
    setBusy("save");
    setError(null);
    try {
      const res = await authedFetch(API.community.request(request.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(safeMessage((await res.json().catch(() => ({}))).message, "Couldn't save your changes."));
      setEditing(false);
      pushToast({ variant: "success", title: "Request updated" });
      onChanged?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Couldn't save your changes.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't save changes", body: message });
    } finally {
      setBusy(null);
      actionLockRef.current = false;
    }
  };

  const cancelRequest = async () => {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setBusy("cancel");
    setError(null);
    try {
      const res = await authedFetch(API.community.request(request.id), { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(safeMessage((await res.json().catch(() => ({}))).message, "Couldn't cancel this request."));
      pushToast({ variant: "success", title: "Request cancelled" });
      router.push(backHref);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Couldn't cancel this request.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't cancel request", body: message });
      setConfirmCancel(false);
    } finally {
      setBusy(null);
      actionLockRef.current = false;
    }
  };

  const resubmit = async () => {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setBusy("resubmit");
    setError(null);
    try {
      const res = await authedFetch(API.community.requestResubmit(request.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
      });
      if (!res.ok) throw new Error(safeMessage((await res.json().catch(() => ({}))).message, "Couldn't resubmit this request."));
      pushToast({ variant: "success", title: "Request resubmitted", body: "Admins will review it again." });
      onChanged?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Couldn't resubmit this request.";
      setError(message);
      pushToast({ variant: "error", title: "Couldn't resubmit request", body: message });
    } finally {
      setBusy(null);
      actionLockRef.current = false;
    }
  };

  const resubmittable = canResubmit(request.status);

  return (
    <div className="mx-auto max-w-3xl">
      <BackLink href={backHref}>{backLabel}</BackLink>
      <div className="mt-3 rounded-xl border border-line bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-xs text-ink-faint">dataset request</p>
            {editing ? (
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                aria-label="Title"
                className={`${inputCls} mt-1 text-base font-semibold`}
              />
            ) : (
              <h1 className="mt-1 break-words text-lg font-semibold text-ink">{request.title}</h1>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="inline-flex items-center gap-1">
              <Pill tone={STATUS_TONE[request.status] ?? "neutral"}>{statusLabel(request.status)}</Pill>
              {REQUEST_STATUS_HELP[request.status] && (
                <InfoTip
                  label={`${statusLabel(request.status)} status`}
                  text={REQUEST_STATUS_HELP[request.status]}
                />
              )}
            </span>
            {editable && !editing && (
              <Button size="sm" variant="secondary" onClick={startEdit}>
                Edit
              </Button>
            )}
          </div>
        </div>

        {editing ? (
          <>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              aria-label="Description"
              rows={4}
              className={`${inputCls} mt-3`}
            />
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <label className="block">
                <div className="micro-label mb-1 text-ink-faint">language (optional)</div>
                <input value={editLanguage} onChange={(e) => setEditLanguage(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <div className="micro-label mb-1 text-ink-faint">framework (optional)</div>
                <input value={editFramework} onChange={(e) => setEditFramework(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <div className="micro-label mb-1 text-ink-faint">items</div>
                <input
                  type="number"
                  min={1}
                  value={editTargetItems}
                  onChange={(e) => setEditTargetItems(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <div className="micro-label mb-1 text-ink-faint">audit coverage %</div>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={editAuditCoveragePct}
                  onChange={(e) => setEditAuditCoveragePct(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <div className="micro-label mb-1 text-ink-faint">license</div>
                <Select value={editLicense} onChange={(e) => setEditLicense(e.target.value)}>
                  {LICENSE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy !== null} onClick={saveEdit}>
                {busy === "save" ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </>
        ) : (
          <>
            {request.description && <p className="mt-3 text-sm leading-6 text-ink-soft">{request.description}</p>}
            <RequestSpecGrid className="mt-4" spec={request} licenseLabel={communityLicenseLabel} />
          </>
        )}

        {request.adminNote && <ReviewerNote className="mt-4" note={request.adminNote} />}

        {request.mintedBounty?.karmaPricing ? (
          <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-3.5">
            <div className="micro-label text-violet-700">frozen karma pricing</div>
            <p className="mt-1 text-[13px] text-ink">
              Contributors earn <strong>+{request.mintedBounty.karmaPricing.contributorPerItem} karma</strong> per final accepted item, up to <strong>+{request.mintedBounty.karmaPricing.contributorTotal.toLocaleString()} karma</strong> for this program.
            </p>
            <p className="mt-1 text-[12px] text-ink-soft">
              Validator review: +{request.mintedBounty.karmaPricing.validatorPerAuditedItem} per audited item · {request.mintedBounty.karmaPricing.plannedAuditItems.toLocaleString()} planned audits at this program&apos;s coverage setting. These per-item rates were set when the program was created and will not change.
            </p>
            {/* Coverage sampling of clean items is not live: every item that
                clears automated checks is currently a forced escalation, so
                the "planned audits" figure above understates what will
                actually happen for any coverage between 1-99%. Say so rather
                than let the frozen number read as a guarantee. */}
            {typeof request.auditCoveragePct === "number" &&
              request.auditCoveragePct > 0 &&
              request.auditCoveragePct < 100 && (
                <p className="mt-1 text-[12px] text-ink-soft">
                  Right now every item that clears automated checks still gets a full validator review — the coverage percentage above does not yet reduce that below 100%. It only changes behavior at 0% coverage, which sends cleared items to you instead of a validator.
                </p>
              )}
          </div>
        ) : !request.mintedBounty ? (
          <div className="mt-4 rounded-xl border border-[#e4e6df] bg-panel p-3.5">
            <div className="micro-label text-ink-faint">karma</div>
            <p className="mt-1 text-[13px] text-ink-soft">Karma is set during admin review from the dataset type’s complexity, verification profile, requested difficulty, and audit coverage. Final values appear here once the program is created.</p>
          </div>
        ) : null}

        {/* poolSummary.publication is now real (services/bounties.ts
            buildDatasetPublicationSummary), so PublicationStatus renders the
            actual state/links for every target — no per-target fallback
            branch needed here any more. */}
        {(() => {
          const publication = parseDatasetPublication(request.mintedBounty?.poolSummary?.publication);
          return publication ? <PublicationStatus publication={publication} className="mt-4" /> : null;
        })()}

        {sampleGate && (
          <div className="mt-5">
            <div className="micro-label mb-2 text-ink-faint">reference samples</div>
            <div className={`rounded-xl border p-3.5 ${sampleGate.ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-semibold text-ink">
                  {sampleGate.approved} of {sampleGate.min} approved
                </span>
                <Pill tone={sampleGate.ok ? "success" : "warning"}>
                  {sampleGate.ok ? "ready to go live" : "blocked"}
                </Pill>
              </div>
              <p className="mt-1.5 text-[12px] leading-snug text-ink-soft">
                {sampleGate.reason ?? "Every sample has been reviewed and approved. This request can be minted."}
              </p>
            </div>

            {samples.length > 0 && (
              <ul className="mt-2.5 space-y-1.5">
                {samples.map((s) => {
                  const state = SAMPLE_TONE[s.sponsorReviewStatus ?? "pending"] ?? SAMPLE_TONE.pending;
                  return (
                    <li key={s.id} className="rounded-lg border border-[#eceee7]">
                      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
                        <div className="min-w-0 grow basis-full sm:basis-0">
                          <span className="block truncate text-[12px] text-ink">{s.filename}</span>
                          <ArtifactScanStatus status={s.status} scanStatus={s.scanStatus} className="mt-0.5 block text-[11px] leading-snug empty:mt-0" />
                          {s.sponsorReviewNote && (
                            <span className="mt-0.5 block text-[11px] leading-snug text-amber-700">{s.sponsorReviewNote}</span>
                          )}
                        </div>
                        <Pill tone={state.tone}>{state.label}</Pill>
                        <button
                          type="button"
                          aria-expanded={openChecks === s.id}
                          // 11px links, measured under the 44x44 touch minimum
                          // at the 640 breakpoint. `TOUCH_TARGET` grows the hit
                          // area only — no layout or colour change.
                          className={`shrink-0 text-[11px] text-ink-faint underline hover:text-ink ${TOUCH_TARGET}`}
                          onClick={() => setOpenChecks(openChecks === s.id ? null : s.id)}
                        >
                          {openChecks === s.id ? "hide checks" : "checks"}
                        </button>
                        {samplesEditable && (
                          <button
                            type="button"
                            className={`shrink-0 text-[11px] text-ink-faint underline hover:text-ink ${TOUCH_TARGET}`}
                            disabled={sampleBusy}
                            onClick={() => void removeSample(s.id)}
                          >
                            remove
                          </button>
                        )}
                      </div>
                      {openChecks === s.id && <ArtifactChecksPanel artifact={s} />}
                    </li>
                  );
                })}
              </ul>
            )}
            {samplesEditable && samples.filter(occupiesSampleSlot).length < sampleGate.max && (
              <SampleUploadField
                accept={sampleContract.accept}
                acceptLabel={sampleContract.label || undefined}
                slotMax={sampleGate.max}
                slotsUsed={samples.filter(occupiesSampleSlot).length}
                slotsRequired={sampleGate.min}
                disabled={sampleBusy}
                externalError={sampleError}
                onFiles={addSamples}
              />
            )}
            {sampleBusy && <p className="mt-1.5 text-[12px] text-ink-soft">Uploading…</p>}
            {!samplesEditable && sampleError && <p className="mt-1.5 text-[12px] text-red-700">{sampleError}</p>}
          </div>
        )}

        <RequestReviewConversation className="mt-5" requestId={request.id} />

        <div className="mt-5 border-t border-[#eceee7] pt-4">
          {resubmittable ? (
            <>
              <div className="micro-label mb-1 text-ink-faint">resend for review</div>
              <p className="mb-2 text-[12px] text-ink-soft">
                Add a note describing what you changed, then resend for review.
              </p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="Resubmission note"
                placeholder="What did you change? (optional)"
                rows={2}
                className={inputCls}
              />
              <div className="mt-2 flex justify-end">
                <Button size="sm" disabled={busy !== null} onClick={resubmit}>
                  {busy === "resubmit" ? "Resubmitting…" : "Resubmit for review"}
                </Button>
              </div>
            </>
          ) : editable ? (
            <p className="text-[12px] text-ink-soft">
              This request is still {statusLabel(request.status).toLowerCase()} — use Edit above to change it. Resend-for-review only applies once a reviewer requests changes or declines it.
            </p>
          ) : (
            <p className="text-[12px] text-ink-soft">
              This request is {statusLabel(request.status).toLowerCase()} and can’t be edited right now. You can edit &amp; resubmit only after a reviewer requests changes or declines it.
            </p>
          )}
        </div>

        {editable && (
          <div className="mt-5 border-t border-[#eceee7] pt-4">
            <div className="micro-label mb-1 text-ink-faint">cancel request</div>
            <p className="mb-2 text-[12px] text-ink-soft">
              No longer want this dataset built? Cancel it — this can&apos;t be undone.
            </p>
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
              Cancel request
            </Button>
          </div>
        )}

        <ConfirmDialog
          open={confirmCancel}
          title="Cancel this dataset request?"
          description="This permanently deletes the request and its review conversation. This can't be undone."
          confirmLabel={busy === "cancel" ? "Cancelling…" : "Cancel request"}
          confirmDisabled={busy === "cancel"}
          onConfirm={cancelRequest}
          onCancel={() => setConfirmCancel(false)}
        />

        {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}
      </div>
    </div>
  );
}
