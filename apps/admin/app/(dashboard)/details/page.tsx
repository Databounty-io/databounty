"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AdminButton, AdminConfirmDialog, AdminErrorBanner, AdminLoadingState, AdminModal, AdminPageHeader, AdminPill, AdminTable, ATd } from "@/components/admin-shell";
import { useAdminResource } from "@/lib/use-admin-resource";
import { useAdminToast } from "@/lib/admin-toast";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { FLAG_REASON_LABELS } from "@/lib/format";
import {
  formatStageScore,
  normalizeValidationStage,
  stageStateFromAdminStage,
  VALIDATION_STAGE_STATE_LABEL,
  VALIDATION_STAGE_STATE_TONE,
} from "@/lib/validation-state";

type DetailKind = "contributor" | "validator" | "submission" | "program" | "bounty";
/** `status` IS the `ValidationResult.outcome` column (both admin stage builders
 *  map `status: r.outcome`). `detailJson` is optional because the API is being
 *  widened to send it: it is the ONLY way to classify `ai_attribution` and a
 *  passing `dedupe`, which are written with no `outcome` at all — absent, the
 *  decoder degrades to `outcome`/`status` rather than guessing. `reason` is
 *  gone: both builders hardcode it to null, so nothing ever read it. */
type Stage = {
  stage: string;
  passed: boolean;
  score: number | null;
  status: string | null;
  detailJson?: Record<string, unknown> | null;
};
type BountyRef = { id: string; title: string; kind?: string; datasetCategory?: string; datasetType?: { id: string; name: string } | null };
type ContractField = { key: string; label: string; role: string | null };
type Attachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  status: string;
  modality: string | null;
  scanStatus: string | null;
  createdAt: string;
};
type History = { id: string; title: string; status: string; createdAt: string; bounty: BountyRef; validationStages: Stage[] };
/** Server-derived answer to "who turned this down and why". `unrecorded` means
 *  the record genuinely holds no reason — it is never rendered as a pass. */
type RejectionSummary = {
  decidedBy: "validator" | "automated_check" | "unrecorded";
  decidedByLabel: string | null;
  reasonCode: string | null;
  reasonText: string | null;
  decidedAt: string | null;
};
/** One validator verdict on this item: the human decision, with the person
 *  who made it and the note they wrote. */
type AuditDecision = {
  id: string;
  verdict: string | null;
  flagReason: string | null;
  note: string | null;
  decidedAt: string | null;
  auditBatchId: string;
  auditBatchStatus: string;
  validatorUserId: string | null;
  validatorLabel: string | null;
};
type Detail = {
  profile?: { id: string; label: string; status: string; rank: string | null };
  history?: History[];
  audits?: { id: string; status: string; itemCount: number; claimedAt: string | null; deadline: string | null; bounty: BountyRef }[];
  flags?: { id: string; reason: string; status: string; createdAt: string; submission: { id: string; title: string; bounty: BountyRef } }[];
  submission?: History & {
    generationMethod: string;
    revisionCount: number;
    validationAttempt: number;
    duplicateScore: number | null;
    llmScore: number | null;
    contributor: { id: string; label: string };
    // The contributor's actual submitted content (broken_code/fixed_code/tests,
    // or whatever fields the dataset type's contract declares). Admin-only —
    // never surfaced to sponsors/contributors/validators.
    payload: unknown;
    /** The dataset type's contract: which payload keys are file references,
     * and which stages this type actually runs. */
    contract?: { fields: ContractField[]; pipeline: string[]; llmValidationEnabled?: boolean };
    /** Files uploaded for this submission's file-role fields. Includes
     * non-`ready` rows (scanning / quarantined) — admin is the reader who
     * needs to see those, not be shown a payload id with nothing behind it. */
    attachments?: Attachment[];
    disputes: { id: string; flagReason: string; contributorArgument: string; validatorArgument: string; status: "open" | "resolved"; resolution: string | null; createdAt: string; resolvedAt: string | null }[];
    flags: { id: string; reason: string; details: string | null; status: string; createdAt: string; validatorUserId: string | null; validatorLabel: string | null }[];
    auditDecisions: AuditDecision[];
    rejection: RejectionSummary | null;
  };
  program?: { id: string; title: string };
  items?: { submissionId: string; submissionStatus: string; duplicateDecision: string | null; llmScore: number | null; routing: { auditBatchStatus: string; verdict: string | null; decidedAt: string | null } | null }[];
  bounty?: { id: string; title: string; kind: string; status: string; datasetCategory: string; datasetType: { id: string; name: string } | null; targetItems: number; acceptedItems: number; createdAt: string };
  /** Similarity spread over every submission on the bounty (not just the
   *  listed page). Null-valued fields mean "not measured", never "unique". */
  similarity?: {
    dedupeConfigured: boolean;
    total: number;
    scored: number;
    mean: number | null;
    max: number | null;
    nearDuplicates: number;
    identical: number;
  };
  submissions?: {
    id: string;
    title: string;
    status: string;
    createdAt: string;
    duplicateScore: number | null;
    llmScore: number | null;
    contributor: { id: string; label: string };
  }[];
  contributors?: { id: string; label: string; submissionCount: number }[];
};

/**
 * The stage pills.
 *
 * `tone={passed ? "success" : "warning"}` with `status ?? "recorded"` collapsed
 * three distinct states into one amber pill: an `ai_attribution` flag read
 * `ai attribution: recorded · 1.00`, and a TERMINAL dedupe rejection read
 * `dedupe: recorded · 0.92` — indistinguishable from a stage that simply had
 * not run. Decoded through the shared contract, so a hold, an escalation, an
 * advisory LLM verdict and a real failure each say what they are.
 *
 * There is no per-stage reason block here any more. Both admin stage builders
 * (`admin-internal.ts` `buildValidationStages`, `admin-submissions.ts`) write
 * `reason: null` unconditionally, so the filter that fed it was always empty
 * and the block never rendered — the comment that used to claim "the API has
 * always sent `reason`" was false. Nothing is invented in its place; the
 * decoded state plus the score is the whole of what the record holds.
 */
function Stages({ stages }: { stages: Stage[] }) {
  if (!stages.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {stages.map((stage, index) => {
        const state = stageStateFromAdminStage(stage);
        const score = formatStageScore(stage.stage, stage.score);
        return (
          <AdminPill key={`${stage.stage}:${index}`} tone={VALIDATION_STAGE_STATE_TONE[state]}>
            {normalizeValidationStage(stage.stage).replaceAll("_", " ")}: {VALIDATION_STAGE_STATE_LABEL[state]}
            {score == null ? "" : ` · ${score}`}
          </AdminPill>
        );
      })}
    </div>
  );
}

/** Every bounty reference on this page carries its id, so render it as a link
 *  to that bounty's own record rather than as dead text. */
function BountyLink({ bounty }: { bounty: BountyRef }) {
  if (!bounty.id) return <span>{bounty.title}</span>;
  return (
    <Link href={`/details?kind=bounty&id=${encodeURIComponent(bounty.id)}`} className="text-lime underline">
      {bounty.title}
    </Link>
  );
}

// "Not accepted" rather than "Rejected": some of these statuses (tests_failed,
// flagged) are revisable, and the status pill beside this label already states
// whether the outcome is terminal.
const REJECTED_BY_LABEL: Record<RejectionSummary["decidedBy"], string> = {
  validator: "Not accepted — validator decision",
  automated_check: "Not accepted — automated check",
  unrecorded: "Not accepted — no reason recorded",
};

/** The single "who turned this down, and why" answer, stated up front instead
 *  of leaving an admin to reconstruct it from pills, flags and audit rows.
 *  `unrecorded` is shown as exactly that — never dressed up as a clean
 *  automated rejection. */
function RejectionBanner({ rejection, status }: { rejection: RejectionSummary; status: string }) {
  const unrecorded = rejection.decidedBy === "unrecorded";
  return (
    <div className={`rounded-xl border p-4 ${unrecorded ? "border-amber-400/30 bg-amber-400/5" : "border-rose-400/30 bg-rose-400/5"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <AdminPill tone={unrecorded ? "warning" : "danger"}>{status.replaceAll("_", " ")}</AdminPill>
        <span className="font-mono text-xs font-semibold text-dark-text">{REJECTED_BY_LABEL[rejection.decidedBy]}</span>
        {rejection.decidedByLabel && <span className="text-[12px] text-dark-soft">· {rejection.decidedByLabel}</span>}
        {rejection.decidedAt && (
          <span className="text-[11px] text-dark-dim">· {new Date(rejection.decidedAt).toLocaleString()}</span>
        )}
      </div>
      {rejection.reasonCode && (
        <div className="mt-2 text-[12px] text-dark-soft">
          {/* A validator picks a reason from a fixed list; an automated stage
              records a status. Labelling a stage status as a "reason" would
              dress up machine state as a judgement. */}
          <span className="text-[10px] uppercase tracking-wide text-dark-dim">
            {rejection.decidedBy === "validator" ? "reason" : "recorded status"}
          </span>{" "}
          {FLAG_REASON_LABELS[rejection.reasonCode] ?? rejection.reasonCode.replaceAll("_", " ")}
        </div>
      )}
      {rejection.reasonText && (
        <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-dark-muted">{rejection.reasonText}</p>
      )}
      {/* The check that failed is known, but it stored no reason of its own.
          Say that, rather than leaving a blank the reader fills in. */}
      {!unrecorded && !rejection.reasonCode && !rejection.reasonText && (
        <p className="mt-1 text-[11px] text-dark-dim">
          This check recorded no reason text. The scores and stage evidence below are all the record holds.
        </p>
      )}
      {unrecorded && (
        <p className="mt-1 text-[11px] text-amber-400/90">
          No validator decision, flag, or failing stage was stored against this item. The rejection cannot be
          explained from the record — investigate before acting on it.
        </p>
      )}
    </div>
  );
}

/** Artifact ids held by one file-role field. Multi-file fields serialize their
 *  ids as a JSON array string; single-file fields store the bare id. Mirrors
 *  parseFileIds in databounty-web's components/dynamic-item-fields.tsx. */
function fileIdsFromValue(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // not JSON — a single bare artifact id
  }
  return [raw];
}

/** dup/llm scores, limited to the stages this dataset type runs. With
 *  no contract recorded, every score is shown rather than silently dropping
 *  evidence that does exist. */
function scoreSummary(submission: {
  duplicateScore: number | null;
  llmScore: number | null;
  contract?: { pipeline: string[]; llmValidationEnabled?: boolean };
}): string {
  const pipeline = submission.contract?.pipeline;
  const runs = (stage: string) => !pipeline || pipeline.length === 0 || pipeline.includes(stage);
  const parts: string[] = [];
  if (runs("dedupe")) {
    const dup = formatStageScore("dedupe", submission.duplicateScore);
    parts.push(`dup ${dup ?? "not recorded"}`);
  }
  if (runs("llm")) {
    // Configured-but-switched-off is stated outright, and stated ACCURATELY:
    // `contract.llmValidationEnabled` is the dataset type's own
    // `verification.auditOptions.llmValidationEnabled`, not the platform's
    // `validation.llm.enabled` switch — no admin route on this console reads
    // that one, so claiming "platform-wide" asserted something this payload
    // cannot know. The absent case says so in words too: a bare "llm —" reads
    // as a check that ran and scored nothing.
    const llm = formatStageScore("llm", submission.llmScore);
    parts.push(
      submission.contract?.llmValidationEnabled === false
        ? "llm off (disabled for this dataset type)"
        : `llm ${llm ?? "not recorded"}`,
    );
  }
  return parts.length ? parts.join(" · ") : "no scoring stages configured";
}

/** Similarity as a percentage, or an explicit "not measured". Never renders a
 *  missing score as 0% — that would claim a uniqueness nothing established. */
function similarityLabel(score: number | null): string {
  return score == null ? "not measured" : `${Math.round(score * 100)}%`;
}

function similarityTone(score: number | null): "neutral" | "warning" | "danger" {
  if (score == null) return "neutral";
  if (score >= 0.9) return "danger";
  if (score >= 0.8) return "warning";
  return "neutral";
}

/**
 * One row of the dataset's upload roster: the item's similarity to its nearest
 * neighbour, plus an on-demand look at what was actually submitted. The
 * content is fetched per row from the submission detail endpoint when opened
 * rather than shipped with the roster — 100 full payloads (code, tests, file
 * references) would be megabytes for a table most rows of which stay closed.
 */
function DatasetUploadRow({
  row,
}: {
  row: NonNullable<Detail["submissions"]>[number];
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail["submission"] | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || detail || loadingDetail) return;
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const response = await adminAuthedFetch(`/v1/admin/internal/submission/${encodeURIComponent(row.id)}`);
      if (!response.ok) throw new Error(`Could not load this item's content (${response.status}).`);
      const body = (await response.json()) as Detail;
      setDetail(body.submission ?? null);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Could not load this item's content.");
    } finally {
      setLoadingDetail(false);
    }
  };

  return (
    <>
      <tr>
        <ATd className="font-semibold">{row.title}</ATd>
        <ATd className="font-mono text-[11px] text-dark-soft break-all">{row.id}</ATd>
        <ATd>
          <Link href={`/details?kind=contributor&id=${encodeURIComponent(row.contributor.id)}`} className="text-lime underline">
            {row.contributor.label}
          </Link>
        </ATd>
        <ATd>
          <AdminPill tone="neutral">{row.status.replaceAll("_", " ")}</AdminPill>
        </ATd>
        <ATd>
          <AdminPill tone={similarityTone(row.duplicateScore)}>{similarityLabel(row.duplicateScore)}</AdminPill>
        </ATd>
        <ATd>{new Date(row.createdAt).toLocaleString()}</ATd>
        <ATd>
          <div className="flex flex-wrap gap-2">
            <AdminButton variant="ghost" onClick={() => void toggle()}>
              {open ? "Hide content" : "View content"}
            </AdminButton>
            <Link href={`/details?kind=submission&id=${encodeURIComponent(row.id)}`} className="font-mono text-xs text-lime underline">
              full record
            </Link>
          </div>
        </ATd>
      </tr>
      {open && (
        <tr>
          <ATd colSpan={7}>
            {/* Bounded width: AdminTable sizes with min-w-max, so an unbounded
                payload line would widen every other row to match it. The lg
                value subtracts the fixed sidebar (14rem) as well as the page
                padding, so the row does not scroll sideways on a small laptop
                purely because the viewport is wider than the content area. */}
            <div className="w-[calc(100vw-4rem)] max-w-3xl lg:w-[calc(100vw-19rem)]">
              {loadingDetail && <div className="text-[11px] text-dark-dim">Loading submitted content…</div>}
              {detailError && <AdminErrorBanner message={detailError} />}
              {detail && (
                <PayloadView payload={detail.payload} contract={detail.contract} attachments={detail.attachments} />
              )}
            </div>
          </ATd>
        </tr>
      )}
    </>
  );
}

/** Stored files this submission's payload does not reference. */
function unreferencedAttachments(submission: {
  payload: unknown;
  contract?: { fields: ContractField[] };
  attachments?: Attachment[];
}): Attachment[] {
  const attachments = submission.attachments ?? [];
  if (attachments.length === 0) return [];
  const payload =
    submission.payload && typeof submission.payload === "object" && !Array.isArray(submission.payload)
      ? (submission.payload as Record<string, unknown>)
      : {};
  const referenced = new Set(
    (submission.contract?.fields ?? [])
      .filter((field) => field.role === "file")
      .flatMap((field) => fileIdsFromValue(payload[field.key])),
  );
  return attachments.filter((artifact) => !referenced.has(artifact.id));
}

function humanSize(bytes: number | null): string {
  if (bytes == null) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One uploaded file. The bytes are fetched through `adminAuthedFetch` rather
 * than linked directly: the artifact content route is on the API origin and
 * authorizes the admin's session cookie, which a plain cross-origin <a href>
 * would not reliably send. */
function AttachmentRow({ artifact }: { artifact: Attachment }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await adminAuthedFetch(`/v1/admin/artifacts/${encodeURIComponent(artifact.id)}/content`);
      if (!response.ok) throw new Error(`Could not read this file (${response.status}).`);
      const url = URL.createObjectURL(await response.blob());
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Could not read this file.");
    } finally {
      setBusy(false);
    }
  };
  const held = artifact.status !== "ready";
  return (
    <div className="rounded-lg border border-dark-line-soft bg-black/20 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all font-mono text-[11px] text-dark-text">{artifact.filename}</span>
        <AdminPill tone={held ? "warning" : "neutral"}>{artifact.status.replaceAll("_", " ")}</AdminPill>
        {artifact.modality && <AdminPill tone="info">{artifact.modality}</AdminPill>}
        <AdminButton variant="ghost" disabled={busy || held} onClick={() => void open()}>
          {busy ? "Opening…" : "Open file"}
        </AdminButton>
      </div>
      <div className="mt-1 text-[10px] text-dark-dim">
        {artifact.contentType} · {humanSize(artifact.sizeBytes)}
        {artifact.scanStatus ? ` · scan: ${artifact.scanStatus.replaceAll("_", " ")}` : ""}
      </div>
      {held && (
        <div className="mt-1 text-[10px] text-amber-400">
          Not readable — this file is still being scanned or was held by security verification.
        </div>
      )}
      {error && <div className="mt-1 text-[10px] text-rose-400">{error}</div>}
    </div>
  );
}

/** Renders the contributor's actual submitted content honestly: a real
 * key/value dump when it's a plain object, a raw string for anything else,
 * and an explicit empty state rather than silently rendering nothing.
 *
 * File-role fields used to print their bare artifact id, which told an admin
 * nothing about what was actually uploaded. They now resolve to the real file
 * — filename, type, size, scan state, and a way to open it — and say so
 * explicitly when the referenced artifact is missing from the record. */
function PayloadView({
  payload,
  contract,
  attachments = [],
}: {
  payload: unknown;
  contract?: { fields: ContractField[]; pipeline: string[] };
  attachments?: Attachment[];
}) {
  if (payload == null) return <div className="text-[11px] text-dark-dim">No submitted content recorded.</div>;
  if (typeof payload === "object" && !Array.isArray(payload)) {
    const entries = Object.entries(payload as Record<string, unknown>);
    if (entries.length === 0) return <div className="text-[11px] text-dark-dim">Empty payload.</div>;
    const fileFieldKeys = new Set((contract?.fields ?? []).filter((f) => f.role === "file").map((f) => f.key));
    const byId = new Map(attachments.map((artifact) => [artifact.id, artifact]));
    return (
      <div className="space-y-2">
        {entries.map(([key, value]) => {
          if (fileFieldKeys.has(key)) {
            const ids = fileIdsFromValue(value);
            return (
              <div key={key}>
                <div className="text-[10px] uppercase tracking-wide text-dark-dim">{key} (file)</div>
                {ids.length === 0 ? (
                  <div className="mt-0.5 text-[11px] text-dark-dim">No file submitted for this field.</div>
                ) : (
                  <div className="mt-0.5 space-y-1.5">
                    {ids.map((artifactId) => {
                      const artifact = byId.get(artifactId);
                      return artifact ? (
                        <AttachmentRow key={artifactId} artifact={artifact} />
                      ) : (
                        <div key={artifactId} className="rounded-lg border border-dark-line-soft bg-black/20 p-2 text-[10px] text-amber-400">
                          Referenced file <span className="font-mono">{artifactId}</span> is not attached to this submission record.
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }
          return (
            <div key={key}>
              <div className="text-[10px] uppercase tracking-wide text-dark-dim">{key}</div>
              <pre className="mt-0.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dark-line-soft bg-black/20 p-2 text-[11px] text-dark-text">
                {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
              </pre>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dark-line-soft bg-black/20 p-2 text-[11px] text-dark-text">
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}

function AdminDetailsPageInner() {
  const { pushToast } = useAdminToast();
  const [pending, setPending] = useState(false);
  const [resolution, setResolution] = useState("");
  const [rulingConfirm, setRulingConfirm] = useState<{ disputeId: string; decision: "uphold_flag" | "overturn_flag" } | null>(null);
  const [restrictTarget, setRestrictTarget] = useState<{ kind: "contributor" | "validator"; id: string; label: string; restricted: boolean } | null>(null);
  const [restrictReason, setRestrictReason] = useState("");
  const [bountyStatusTarget, setBountyStatusTarget] = useState<{ id: string; title: string; action: "pause" | "resume" } | null>(null);
  const [bountyStatusReason, setBountyStatusReason] = useState("");

  // Derived from the query string, not latched on mount. This page links to
  // itself ~12 times (submission -> bounty -> contributor and back); Next does
  // not remount on a query-only change, so a one-shot read left the body
  // showing the previous record while the URL and sidebar moved on.
  const searchParams = useSearchParams();
  const kindParam = searchParams.get("kind");
  const params = {
    kind:
      kindParam === "contributor" || kindParam === "validator" || kindParam === "submission" || kindParam === "program" || kindParam === "bounty"
        ? (kindParam as DetailKind)
        : null,
    id: searchParams.get("id"),
  };
  const path =
    params.kind && params.id
      ? params.kind === "program"
        ? `/v1/admin/community/datasets/${encodeURIComponent(params.id)}/audit-routing?limit=100`
        : `/v1/admin/internal/${params.kind}/${encodeURIComponent(params.id)}`
      : null;
  const { data, loading, error, refresh } = useAdminResource<Detail>(path ?? "/v1/admin/internal/invalid/invalid", {
    errorMessage: "Internal detail is unavailable.",
    enabled: Boolean(path),
  });

  const submitRestrict = async () => {
    const target = restrictTarget;
    const reason = restrictReason.trim();
    if (!target || reason.length < 10) return;
    setPending(true);
    try {
      const response = await adminAuthedFetch(`/v1/admin/${target.kind === "contributor" ? "contributors" : "validators"}/${target.id}/restrict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restricted: target.restricted, reason }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null) as { message?: string } | null)?.message ?? "Account action failed.");
      await refresh();
      pushToast({ variant: "success", title: target.restricted ? `${target.kind === "contributor" ? "Contributor" : "Validator"} restricted` : `${target.kind === "contributor" ? "Contributor" : "Validator"} reinstated` });
      setRestrictTarget(null);
      setRestrictReason("");
    } catch (actionError) {
      pushToast({ variant: "error", title: "Account action failed", body: actionError instanceof Error ? actionError.message : undefined });
    } finally {
      setPending(false);
    }
  };

  const submitBountyStatus = async () => {
    const target = bountyStatusTarget;
    const reason = bountyStatusReason.trim();
    if (!target || reason.length < 10) return;
    setPending(true);
    try {
      const response = await adminAuthedFetch(`/v1/admin/bounties/${target.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: target.action, reason }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null) as { message?: string } | null)?.message ?? "Pool action failed.");
      await refresh();
      pushToast({ variant: "success", title: target.action === "pause" ? "Pool paused" : "Pool resumed" });
      setBountyStatusTarget(null);
      setBountyStatusReason("");
    } catch (actionError) {
      pushToast({ variant: "error", title: "Pool action failed", body: actionError instanceof Error ? actionError.message : undefined });
    } finally {
      setPending(false);
    }
  };

  const confirmResolveDispute = async () => {
    if (!rulingConfirm) return;
    const reason = resolution.trim();
    setPending(true);
    try {
      const response = await adminAuthedFetch(`/v1/admin/disputes/${rulingConfirm.disputeId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: rulingConfirm.decision, resolution: reason }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null) as { message?: string } | null)?.message ?? "Could not resolve dispute.");
      await refresh();
      pushToast({ variant: "success", title: rulingConfirm.decision === "uphold_flag" ? "Flag confirmed" : "Flag overturned" });
    } catch (actionError) {
      pushToast({ variant: "error", title: "Could not resolve dispute", body: actionError instanceof Error ? actionError.message : undefined });
    } finally {
      setPending(false);
      setRulingConfirm(null);
      setResolution("");
    }
  };

  if (!path) {
    return (
      <div className="space-y-5">
        <AdminPageHeader title="Internal detail" sub="Open this page from the Open Program, Validators, Contributors, or Submissions table." />
        <AdminErrorBanner message="No internal record was selected." />
      </div>
    );
  }
  if (loading && !data) return <AdminLoadingState label="Loading internal history…" />;

  const title =
    params.kind === "submission"
      ? data?.submission?.title ?? "Submission detail"
      : params.kind === "program"
        ? data?.program?.title ?? "Community program detail"
        : params.kind === "bounty"
          ? data?.bounty?.title ?? "Pool detail"
          : data?.profile?.label ?? "Internal detail";
  const backHref =
    params.kind === "validator"
      ? "/validators"
      : params.kind === "contributor"
        ? "/contributors"
        : params.kind === "program"
          ? "/open-program?tab=programs"
          : params.kind === "bounty"
            ? "/open-program?tab=programs"
            : "/submissions";

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title={title}
        eyebrow="internal admin detail"
        sub={
          params.kind === "program"
            ? "Per-submission audit-routing evidence for this community program."
            : "Operational history and stored validation evidence. Emails and private reviewer notes are intentionally excluded."
        }
        actions={
          <Link href={backHref} className="font-mono text-xs text-lime underline">
            ← back to roster
          </Link>
        }
      />
      {error && <AdminErrorBanner message={error} onRetry={() => void refresh()} />}

      {data?.profile && (params.kind === "contributor" || params.kind === "validator") && (
        <div className="flex flex-wrap items-center gap-2">
          <AdminPill tone="neutral">{data.profile.status}</AdminPill>
          {data.profile.rank && <AdminPill tone="info">{data.profile.rank}</AdminPill>}
          {data.profile.status === "suspended" ? (
            <AdminButton variant="ghost" disabled={pending} onClick={() => { setRestrictTarget({ kind: params.kind as "contributor" | "validator", id: data.profile!.id, label: data.profile!.label, restricted: false }); setRestrictReason(""); }}>
              Reinstate
            </AdminButton>
          ) : (
            <AdminButton variant="ghost" disabled={pending} onClick={() => { setRestrictTarget({ kind: params.kind as "contributor" | "validator", id: data.profile!.id, label: data.profile!.label, restricted: true }); setRestrictReason(""); }}>
              Restrict
            </AdminButton>
          )}
        </div>
      )}

      {data?.bounty && (
        <div className="rounded-xl border border-dark-line bg-dark-panel p-4">
          <div className="flex flex-wrap items-center gap-2">
            <AdminPill tone="neutral">{data.bounty.status.replaceAll("_", " ")}</AdminPill>
            <AdminPill tone="info">{data.bounty.kind}</AdminPill>
            {data.bounty.datasetType && <AdminPill tone="lime">{data.bounty.datasetType.name}</AdminPill>}
            <span className="text-[11px] text-dark-dim">{data.bounty.datasetCategory}</span>
            {data.bounty.status === "active" && (
              <AdminButton variant="ghost" disabled={pending} onClick={() => { setBountyStatusTarget({ id: data.bounty!.id, title: data.bounty!.title, action: "pause" }); setBountyStatusReason(""); }}>
                Pause
              </AdminButton>
            )}
            {data.bounty.status === "paused" && (
              <AdminButton variant="primary" disabled={pending} onClick={() => { setBountyStatusTarget({ id: data.bounty!.id, title: data.bounty!.title, action: "resume" }); setBountyStatusReason(""); }}>
                Resume
              </AdminButton>
            )}
          </div>
          <div className="mt-2 text-[12px] text-dark-soft">
            {data.bounty.acceptedItems} / {data.bounty.targetItems} items accepted
          </div>
        </div>
      )}

      {/* Stated before the evidence tables, because "why was this turned down"
          is the question this page is opened to answer. */}
      {data?.submission?.rejection && (
        <RejectionBanner rejection={data.submission.rejection} status={data.submission.status} />
      )}

      {data?.submission && (
        <AdminTable headers={["pool", "dataset type", "contributor ID", "revisions", "scores", "validation evidence"]}>
          <tr>
            <ATd>
              <BountyLink bounty={data.submission.bounty} />
            </ATd>
            <ATd className="text-dark-soft">{data.submission.bounty.datasetType?.name ?? "—"}</ATd>
            <ATd>
              <Link
                href={`/details?kind=contributor&id=${encodeURIComponent(data.submission.contributor.id)}`}
                className="text-lime underline"
              >
                {data.submission.contributor.label}
              </Link>
            </ATd>
            <ATd>{data.submission.revisionCount}</ATd>
            {/* Only stages this dataset type actually runs get a score. A
                pipeline that never includes `llm` must not render an "llm —",
                which reads as a check that ran and scored nothing. Falls back
                to showing all three while the contract is unknown. */}
            <ATd>{scoreSummary(data.submission)}</ATd>
            <ATd>
              <Stages stages={data.submission.validationStages} />
            </ATd>
          </tr>
        </AdminTable>
      )}

      {data?.submission && (
        <div className="rounded-xl border border-dark-line bg-dark-panel p-4">
          <div className="mb-2 font-mono text-xs font-semibold text-dark-text">Submitted content</div>
          <PayloadView
            payload={data.submission.payload}
            contract={data.submission.contract}
            attachments={data.submission.attachments}
          />
        </div>
      )}

      {/* Any uploaded file the payload does not point at — an orphan from a
          revision, or a field the contract no longer declares. Listed rather
          than dropped, so the record shows every file really stored against
          this submission. */}
      {data?.submission && unreferencedAttachments(data.submission).length > 0 && (
        <div className="rounded-xl border border-dark-line bg-dark-panel p-4">
          <div className="mb-2 font-mono text-xs font-semibold text-dark-text">
            Other stored files ({unreferencedAttachments(data.submission).length})
          </div>
          <div className="mb-2 text-[10px] text-dark-dim">
            Attached to this submission but not referenced by any current payload field.
          </div>
          <div className="space-y-1.5">
            {unreferencedAttachments(data.submission).map((artifact) => (
              <AttachmentRow key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </div>
      )}

      {data?.submission && data.submission.disputes.length > 0 && (
        <div className="space-y-3">
          <div className="font-mono text-xs font-semibold text-dark-text">Disputes ({data.submission.disputes.length})</div>
          {data.submission.disputes.map((dispute) => (
            <div key={dispute.id} className="rounded-xl border border-dark-line bg-dark-panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <AdminPill tone={dispute.status === "open" ? "warning" : "neutral"}>{dispute.status}</AdminPill>
                <span className="text-[11px] text-dark-dim">{FLAG_REASON_LABELS[dispute.flagReason] ?? dispute.flagReason}</span>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-dark-dim">Contributor argument</div>
                  <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-dark-soft">{dispute.contributorArgument}</p>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-dark-dim">Validator argument</div>
                  <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-dark-soft">{dispute.validatorArgument}</p>
                </div>
              </div>
              {dispute.status === "resolved" ? (
                <p className="mt-2 text-[12px] text-dark-dim">Resolution: {dispute.resolution}</p>
              ) : (
                <div className="mt-3 space-y-2">
                  <textarea
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    placeholder="Resolution reason (required)…"
                    rows={2}
                    className="w-full rounded-lg border border-dark-line-soft bg-transparent px-3 py-2 text-[12px] text-dark-text"
                  />
                  <div className="flex gap-2">
                    <AdminButton
                      variant="danger"
                      disabled={pending || !resolution.trim()}
                      onClick={() => setRulingConfirm({ disputeId: dispute.id, decision: "uphold_flag" })}
                    >
                      Confirm flag
                    </AdminButton>
                    <AdminButton
                      variant="ghost"
                      disabled={pending || !resolution.trim()}
                      onClick={() => setRulingConfirm({ disputeId: dispute.id, decision: "overturn_flag" })}
                    >
                      Overturn and requeue
                    </AdminButton>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The human verdicts on this item. Each names the validator who decided
          and the note they wrote — an audit trail, not just a count. */}
      {data?.submission && data.submission.auditDecisions.length > 0 && (
        <div className="space-y-2">
          <div className="font-mono text-xs font-semibold text-dark-text">
            Validator decisions ({data.submission.auditDecisions.length})
          </div>
          <AdminTable headers={["verdict", "validator", "reason", "note", "decided", "audit batch"]}>
            {/* Currently unreachable: admin-internal.ts sends
                `auditDecisions: []`. Corrected anyway — a decision requires
                BOTH a verdict and a `decidedAt`, and keying the pill on the
                verdict alone would show an undecided row as a settled ruling
                the moment this array is populated. */}
            {data.submission.auditDecisions.map((decision) => {
              const decided = !!decision.verdict && !!decision.decidedAt;
              return (
              <tr key={decision.id}>
                <ATd>
                  <AdminPill tone={!decided ? "neutral" : decision.verdict === "ok" ? "success" : decision.verdict === "flagged" ? "danger" : "neutral"}>
                    {decided && decision.verdict ? decision.verdict.replaceAll("_", " ") : "undecided"}
                  </AdminPill>
                </ATd>
                <ATd>
                  {decision.validatorUserId ? (
                    <Link
                      href={`/details?kind=validator&id=${encodeURIComponent(decision.validatorUserId)}`}
                      className="text-lime underline"
                    >
                      {decision.validatorLabel ?? decision.validatorUserId}
                    </Link>
                  ) : (
                    <span className="text-dark-dim">unassigned</span>
                  )}
                </ATd>
                <ATd className="text-dark-soft">
                  {decision.flagReason
                    ? FLAG_REASON_LABELS[decision.flagReason] ?? decision.flagReason.replaceAll("_", " ")
                    : "—"}
                </ATd>
                <ATd className="max-w-72 whitespace-pre-wrap text-dark-soft">{decision.note ?? "—"}</ATd>
                <ATd className="whitespace-nowrap text-dark-soft">
                  {decision.decidedAt ? new Date(decision.decidedAt).toLocaleString() : "not decided"}
                </ATd>
                <ATd>
                  <AdminPill tone="neutral">{decision.auditBatchStatus.replaceAll("_", " ")}</AdminPill>
                </ATd>
              </tr>
              );
            })}
          </AdminTable>
        </div>
      )}

      {data?.submission && data.submission.flags.length > 0 && (
        <div className="space-y-2">
          <div className="font-mono text-xs font-semibold text-dark-text">Flags ({data.submission.flags.length})</div>
          <AdminTable headers={["reason", "raised by", "written reason", "status", "created"]}>
            {data.submission.flags.map((flag) => (
              <tr key={flag.id}>
                <ATd>{FLAG_REASON_LABELS[flag.reason] ?? flag.reason.replaceAll("_", " ")}</ATd>
                <ATd>
                  {flag.validatorUserId ? (
                    <Link
                      href={`/details?kind=validator&id=${encodeURIComponent(flag.validatorUserId)}`}
                      className="text-lime underline"
                    >
                      {flag.validatorLabel ?? flag.validatorUserId}
                    </Link>
                  ) : (
                    // No validator id means the platform raised it, not a person.
                    <span className="text-dark-dim">automated</span>
                  )}
                </ATd>
                <ATd className="max-w-72 whitespace-pre-wrap text-dark-soft">{flag.details ?? "—"}</ATd>
                <ATd>
                  <AdminPill tone={flag.status === "open" ? "warning" : "neutral"}>{flag.status}</AdminPill>
                </ATd>
                <ATd className="whitespace-nowrap">{new Date(flag.createdAt).toLocaleString()}</ATd>
              </tr>
            ))}
          </AdminTable>
        </div>
      )}

      {data?.history && (
        <AdminTable headers={["submission", "pool", "dataset type", "status", "validation evidence"]}>
          {data.history.map((row) => (
            <tr key={row.id}>
              <ATd>
                <Link href={`/details?kind=submission&id=${encodeURIComponent(row.id)}`} className="text-lime underline">
                  {row.title}
                </Link>
              </ATd>
              <ATd>
                <BountyLink bounty={row.bounty} />
              </ATd>
              <ATd className="text-dark-soft">{row.bounty.datasetType?.name ?? "—"}</ATd>
              <ATd>
                <AdminPill tone="neutral">{row.status.replaceAll("_", " ")}</AdminPill>
              </ATd>
              <ATd>
                <Stages stages={row.validationStages} />
              </ATd>
            </tr>
          ))}
        </AdminTable>
      )}

      {data?.audits && (
        <AdminTable headers={["pool", "dataset type", "status", "items", "claimed", "deadline"]}>
          {data.audits.map((row) => (
            <tr key={row.id}>
              <ATd>
                <BountyLink bounty={row.bounty} />
              </ATd>
              <ATd className="text-dark-soft">{row.bounty.datasetType?.name ?? "—"}</ATd>
              <ATd>{row.status}</ATd>
              <ATd>{row.itemCount}</ATd>
              <ATd>{row.claimedAt ? new Date(row.claimedAt).toLocaleString() : "—"}</ATd>
              <ATd>{row.deadline ? new Date(row.deadline).toLocaleString() : "—"}</ATd>
            </tr>
          ))}
        </AdminTable>
      )}

      {data?.flags && (
        <AdminTable headers={["submission", "pool", "reason", "status", "created"]}>
          {data.flags.map((row) => (
            <tr key={row.id}>
              <ATd>
                <Link href={`/details?kind=submission&id=${encodeURIComponent(row.submission.id)}`} className="text-lime underline">
                  {row.submission.title}
                </Link>
              </ATd>
              <ATd>
                <BountyLink bounty={row.submission.bounty} />
              </ATd>
              <ATd>{FLAG_REASON_LABELS[row.reason] ?? row.reason.replaceAll("_", " ")}</ATd>
              <ATd>{row.status}</ATd>
              <ATd>{new Date(row.createdAt).toLocaleString()}</ATd>
            </tr>
          ))}
        </AdminTable>
      )}

      {/* How varied this dataset actually is. Every figure is measured over
          the whole pool, and states outright when it was not measured at
          all — a dataset whose dedupe stage never ran must not read as one
          where every item came back unique. */}
      {data?.similarity && (
        <div className="rounded-xl border border-dark-line bg-dark-panel p-4">
          <div className="mb-2 font-mono text-xs font-semibold text-dark-text">Dataset variety</div>
          {!data.similarity.dedupeConfigured ? (
            <div className="text-[11px] text-amber-400">
              This dataset type does not run the duplicate check, so item-to-item similarity was never
              measured for this dataset. No variety figure can be reported.
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-dark-dim">measured</div>
                  <div className="font-mono text-sm text-dark-text">
                    {data.similarity.scored} / {data.similarity.total}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-dark-dim">average similarity</div>
                  <div className="font-mono text-sm text-dark-text">{similarityLabel(data.similarity.mean)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-dark-dim">most similar item</div>
                  <div className="font-mono text-sm text-dark-text">{similarityLabel(data.similarity.max)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-dark-dim">near-duplicates (≥80%)</div>
                  <div className="font-mono text-sm text-dark-text">
                    {data.similarity.nearDuplicates}
                    <span className="text-dark-dim"> · {data.similarity.identical} identical</span>
                  </div>
                </div>
              </div>
              {data.similarity.scored < data.similarity.total && (
                <div className="mt-2 text-[10px] text-amber-400">
                  {data.similarity.total - data.similarity.scored} item
                  {data.similarity.total - data.similarity.scored === 1 ? " has" : "s have"} no similarity score yet —
                  still in the pipeline, or the check did not run for them.
                </div>
              )}
              <div className="mt-2 text-[10px] text-dark-dim">
                Similarity is each item&apos;s closest match among the other submissions on this pool. Lower is more
                varied; 100% means an exact match.
              </div>
            </>
          )}
        </div>
      )}

      {data?.submissions && (
        <div>
          <div className="mb-2 font-mono text-xs font-semibold text-dark-text">Uploads ({data.submissions.length})</div>
          <AdminTable headers={["item", "submission ID", "contributor ID", "status", "similarity", "created", "content"]}>
            {data.submissions.map((row) => (
              <DatasetUploadRow key={row.id} row={row} />
            ))}
          </AdminTable>
          {data.similarity && data.submissions.length < data.similarity.total && (
            <div className="mt-2 text-[10px] text-dark-dim">
              Showing the {data.submissions.length} most recent of {data.similarity.total} uploads.
            </div>
          )}
        </div>
      )}

      {data?.contributors && (
        <div>
          <div className="mb-2 font-mono text-xs font-semibold text-dark-text">Contributors ({data.contributors.length})</div>
          <AdminTable headers={["contributor", "submissions"]}>
            {data.contributors.map((row) => (
              <tr key={row.id}>
                <ATd>
                  <Link href={`/details?kind=contributor&id=${encodeURIComponent(row.id)}`} className="text-lime underline">
                    {row.label}
                  </Link>
                </ATd>
                <ATd>{row.submissionCount}</ATd>
              </tr>
            ))}
          </AdminTable>
        </div>
      )}

      {data?.items && (
        <AdminTable headers={["submission", "stage", "dup decision", "llm", "audit batch", "verdict"]}>
          {data.items.map((row) => (
            <tr key={row.submissionId}>
              <ATd>
                <Link
                  href={`/details?kind=submission&id=${encodeURIComponent(row.submissionId)}`}
                  className="font-mono text-[11px] text-lime underline"
                >
                  {row.submissionId}
                </Link>
              </ATd>
              <ATd>
                <AdminPill tone="neutral">{row.submissionStatus.replaceAll("_", " ")}</AdminPill>
              </ATd>
              <ATd>{row.duplicateDecision ?? "—"}</ATd>
              {/* `toFixed(2)` on a raw llm score printed "95.00" in a column
                  whose other stages are 0–1; and a bare "—" read as a check
                  that ran and scored nothing. */}
              <ATd className={row.llmScore == null ? "text-dark-dim" : undefined}>
                {formatStageScore("llm", row.llmScore) ?? "not recorded"}
              </ATd>
              <ATd>
                <AdminPill tone={row.routing ? "info" : "danger"}>{row.routing?.auditBatchStatus ?? "not routed"}</AdminPill>
              </ATd>
              {/* A decision requires BOTH a verdict and a `decidedAt`.
                  `decidedAt` used to be consulted only when the verdict was
                  null, so any non-null verdict read as decided even with no
                  decision timestamp behind it. */}
              <ATd>{row.routing?.verdict && row.routing.decidedAt ? row.routing.verdict : "pending"}</ATd>
            </tr>
          ))}
        </AdminTable>
      )}

      <AdminConfirmDialog
        open={!!rulingConfirm}
        title={rulingConfirm?.decision === "uphold_flag" ? "Confirm this flag?" : "Overturn and requeue this flag?"}
        description="The action is audit logged and cannot be undone."
        confirmLabel={rulingConfirm?.decision === "uphold_flag" ? "Confirm flag" : "Overturn and requeue"}
        danger={rulingConfirm?.decision === "uphold_flag"}
        busy={pending}
        onConfirm={confirmResolveDispute}
        onCancel={() => setRulingConfirm(null)}
      />

      <AdminModal
        open={restrictTarget !== null}
        onClose={pending ? undefined : () => setRestrictTarget(null)}
        panelClassName="w-full max-w-lg rounded-xl border border-dark-line bg-dark-panel p-5 shadow-2xl"
      >
        <h2 className="font-mono text-base font-bold text-dark-text">
          {restrictTarget?.restricted ? `Restrict this ${restrictTarget?.kind}` : `Reinstate this ${restrictTarget?.kind}`}
        </h2>
        <p className="mt-2 text-sm text-dark-soft">
          {restrictTarget?.restricted ? (
            <>This blocks <span className="font-mono text-dark-text">{restrictTarget?.label}</span> from participating in new work until reinstated.</>
          ) : (
            <>This restores <span className="font-mono text-dark-text">{restrictTarget?.label}</span>&rsquo;s ability to participate in new work.</>
          )}
        </p>
        <label className="mt-4 block text-xs font-medium text-dark-text" htmlFor="detail-restrict-reason">
          Reason <span className="text-rose-300">(minimum 10 characters)</span>
        </label>
        <textarea
          id="detail-restrict-reason"
          value={restrictReason}
          onChange={(event) => setRestrictReason(event.target.value)}
          rows={4}
          maxLength={1000}
          placeholder={restrictTarget?.restricted ? "Describe why this account is being restricted…" : "Describe why this account is being reinstated…"}
          className="mt-2 w-full resize-y rounded-lg border border-dark-line-soft bg-dark-card px-3 py-2 text-sm text-dark-text outline-none focus:border-lime"
        />
        <div className="mt-5 flex justify-end gap-2">
          <AdminButton variant="ghost" disabled={pending} onClick={() => setRestrictTarget(null)}>
            Cancel
          </AdminButton>
          <AdminButton disabled={restrictReason.trim().length < 10 || pending} onClick={() => void submitRestrict()}>
            {pending ? "Saving…" : restrictTarget?.restricted ? "Restrict" : "Reinstate"}
          </AdminButton>
        </div>
      </AdminModal>

      <AdminModal
        open={bountyStatusTarget !== null}
        onClose={pending ? undefined : () => setBountyStatusTarget(null)}
        panelClassName="w-full max-w-lg rounded-xl border border-dark-line bg-dark-panel p-5 shadow-2xl"
      >
        <h2 className="font-mono text-base font-bold text-dark-text">
          {bountyStatusTarget?.action === "pause" ? "Pause this pool" : "Resume this pool"}
        </h2>
        <p className="mt-2 text-sm text-dark-soft">
          {bountyStatusTarget?.action === "pause" ? (
            <>This stops new claims and submissions on <span className="font-mono text-dark-text">{bountyStatusTarget?.title}</span> until it is resumed. In-flight work is not affected.</>
          ) : (
            <>This reopens <span className="font-mono text-dark-text">{bountyStatusTarget?.title}</span> for new claims and submissions.</>
          )}
        </p>
        <label className="mt-4 block text-xs font-medium text-dark-text" htmlFor="bounty-status-reason">
          Reason <span className="text-rose-300">(minimum 10 characters)</span>
        </label>
        <textarea
          id="bounty-status-reason"
          value={bountyStatusReason}
          onChange={(event) => setBountyStatusReason(event.target.value)}
          rows={4}
          maxLength={1000}
          placeholder={bountyStatusTarget?.action === "pause" ? "Describe why this pool is being paused…" : "Describe why this pool is being resumed…"}
          className="mt-2 w-full resize-y rounded-lg border border-dark-line-soft bg-dark-card px-3 py-2 text-sm text-dark-text outline-none focus:border-lime"
        />
        <div className="mt-5 flex justify-end gap-2">
          <AdminButton variant="ghost" disabled={pending} onClick={() => setBountyStatusTarget(null)}>
            Cancel
          </AdminButton>
          <AdminButton disabled={bountyStatusReason.trim().length < 10 || pending} onClick={() => void submitBountyStatus()}>
            {pending ? "Saving…" : bountyStatusTarget?.action === "pause" ? "Pause pool" : "Resume pool"}
          </AdminButton>
        </div>
      </AdminModal>
    </div>
  );
}

// useSearchParams needs a Suspense boundary during prerender.
export default function AdminDetailsPage() {
  return (
    <Suspense fallback={<AdminLoadingState label="Loading record…" />}>
      <AdminDetailsPageInner />
    </Suspense>
  );
}
