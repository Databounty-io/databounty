"use client";

// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import { AsyncState, Button, ComingSoonNotice, Empty, Pagination, Pill, PillTabs, Progress, SearchField, Select, SubmissionStatusPill } from "@/components/ui";
import { pipelineWithPlatformStages, stageLabel } from "@/lib/dataset-types";
import { useDebouncedValue } from "@/lib/use-list-search";
import {
  getPoolContract,
  getPoolSubmissions,
  submitPoolItemsReal,
  type BatchSubmissionPage,
  type PoolContract,
  type SubmissionListFilter,
} from "@/lib/api-work";
import { BOUNTY_STATUS_LABELS } from "@/lib/format";
import { useDemo } from "@/lib/store";
import { DynamicFieldsEditor, Field, payloadFromValues, requiredMissing } from "@/components/dynamic-item-fields";
import { DatasetContractPanel } from "@/components/dataset-contract";
import { PublicationStatus } from "@/components/publication-status";
import { parseDatasetPublication } from "@/lib/publication";
import { SponsorReferenceExamples } from "@/components/artifacts";
import { BulkSubmissionSummary, BulkUpload, Segmented, type SubmissionOutcome } from "@/components/bulk-upload";
import { payloadForDataset, type ParsedItem } from "@/lib/bulk-parse";
import type { GenerationMethod, SubmissionStatus } from "@/lib/types";

type Mode = "single" | "bulk";

function poolReviewSummary(counts: Record<string, number>) {
  const accepted = counts.accepted ?? 0;
  const actionNeeded = ["needs_fixes", "tests_failed", "flagged", "rejected"].reduce(
    (total, status) => total + (counts[status] ?? 0),
    0
  );
  const disputed = counts.disputed ?? 0;
  const automatedChecks = ["draft", "submitted", "duplicate_check", "running_tests", "llm_validation"].reduce(
    (total, status) => total + (counts[status] ?? 0),
    0
  );
  const validatorAudit = (counts.in_audit ?? 0) + (counts.provisionally_accepted ?? 0);
  const poolCloseReview = counts.accepted_pending_sample ?? 0;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    total,
    accepted,
    actionNeeded,
    disputed,
    automatedChecks,
    validatorAudit,
    poolCloseReview,
    inReview: Math.max(0, total - accepted - actionNeeded - disputed),
  };
}

function evidenceScore(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}


/**
 * Direct, no-claim submission to a community open pool
 * (COMMUNITY_OPEN_POOL_PLAN_V2). Supports single-item entry and bulk upload
 * (shared BulkUpload component).
 * Bulk capacity is what the pool still needs (targetItems − clearedItems),
 * i.e. the dataset's requested quantity, not a fixed cap. Items are POSTed
 * one per call so the API's per-request 100-item cap never limits a large upload.
 */
export default function PoolSubmitView() {
  const params = useParams<{ bountyId: string }>();
  const { authReady, hasRealSession, pushToast, dashboardSubmissionsLive } = useDemo();

  const [contract, setContract] = useState<PoolContract | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [values, setValues] = useState<Record<string, string>>({});
  const [generationMethod, setGenerationMethod] = useState<GenerationMethod | "">("");
  const [attestOriginal, setAttestOriginal] = useState(false);
  const [attestNoPrivate, setAttestNoPrivate] = useState(false);
  const [attestRights, setAttestRights] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const submitLockRef = useRef(false);

  // Bulk-upload state. `mode` is null until the contributor picks a tab, then defaults to single.
  const [mode, setMode] = useState<Mode>("single");
  const [submittingMode, setSubmittingMode] = useState<"single" | "bulk" | "retry" | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);
  const [submissionOutcomes, setSubmissionOutcomes] = useState<SubmissionOutcome[]>([]);
  const [lastBulkItems, setLastBulkItems] = useState<ParsedItem[]>([]);
  const [formResetKey, setFormResetKey] = useState(0);

  // The contributor's own submissions to this pool — paginated list scoped to the bounty.
  const [subFilter, setSubFilter] = useState<SubmissionListFilter>("all");
  const [subPage, setSubPage] = useState(1);
  const subLimit = 10;
  const [subSearch, setSubSearch] = useState("");
  const [subData, setSubData] = useState<BatchSubmissionPage>({
    submissions: [],
    submissionCounts: {},
    total: 0,
    page: 1,
    limit: 10,
    totalPages: 0,
  });
  const [subLoading, setSubLoading] = useState(true);
  const [subError, setSubError] = useState<string | null>(null);
  const subQueryRef = useRef<string>("");

  // Shared debounce (lib/use-list-search) rather than a fifth private copy of
  // the same timer. The page reset moved to the input's own handler, which is
  // where every other list in this app already does it — resetting it from
  // inside the debounce meant a keystroke silently jumped the reader off
  // page 3 up to 300ms later.
  const debouncedSubSearch = useDebouncedValue(subSearch);

  useEffect(() => {
    if (!hasRealSession) return;
    let cancelled = false;
    const queryKey = `${params.bountyId}:${subPage}:${subLimit}:${subFilter}:${debouncedSubSearch}:${attempt}`;
    const foreground = subQueryRef.current !== queryKey;
    queueMicrotask(() => {
      if (!cancelled && foreground) {
        setSubLoading(true);
        setSubError(null);
      }
    });
    getPoolSubmissions(params.bountyId, {
      page: subPage,
      limit: subLimit,
      filter: subFilter,
      search: debouncedSubSearch,
    })
      .then((data) => {
        if (cancelled) return;
        subQueryRef.current = queryKey;
        setSubData(data);
        setSubError(null);
        if (data.totalPages > 0 && data.page > data.totalPages) setSubPage(data.totalPages);
      })
      .catch((e) => {
        if (!cancelled && foreground) setSubError(e instanceof Error ? e.message : "Could not load your submissions.");
      })
      .finally(() => {
        if (!cancelled && foreground) setSubLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hasRealSession, params.bountyId, subPage, subLimit, subFilter, debouncedSubSearch, attempt]);

  const subSummary = useMemo(() => poolReviewSummary(subData.submissionCounts), [subData.submissionCounts]);
  const allSubCount = useMemo(
    () => Object.values(subData.submissionCounts).reduce((sum, count) => sum + count, 0),
    [subData.submissionCounts]
  );

  useEffect(() => {
    if (!hasRealSession) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
        setError(null);
      }
    });
    getPoolContract(params.bountyId)
      .then((next) => {
        if (cancelled) return;
        if (!next) {
          setError("This pool could not be found.");
          return;
        }
        setContract(next);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load this pool. Please try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hasRealSession, params.bountyId, attempt]);

  const type = contract?.datasetType ?? null;
  const payload = useMemo(() => (type ? payloadFromValues(type, values) : {}), [type, values]);
  const missing = type ? requiredMissing(type, payload) : [];
  const hasEditedField = Object.values(values).some((value) => value.trim() !== "");
  const canSubmit = generationMethod !== "" && missing.length === 0 && attestOriginal && attestNoPrivate && attestRights;

  // Contributing needs a verified email, not a role. The server rejects an
  // unverified account with `email_unverified`, which the submit handler
  // surfaces; the only thing worth blocking the page on is being signed out.
  if (!authReady || !hasRealSession) {
    return (
      <>
        <PageHeader title="Contribute to pool" />
        <div className="card px-6 py-10 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-dark text-lime">
            <Icon name="code" size={20} />
          </div>
          <h2 className="mt-3 font-mono text-base font-bold">
            {authReady ? "Sign in to contribute" : "Loading your session…"}
          </h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">
            Sign in to submit dataset items to this pool.
          </p>
        </div>
      </>
    );
  }

  if (loading && !contract) {
    return (
      <>
        <PageHeader title="Contribute to pool" />
        <AsyncState status="loading" loadingText="Loading pool contract…" />
      </>
    );
  }

  if (error || !contract || !type) {
    return (
      <>
        <PageHeader title="Contribute to pool" />
        <Empty
          icon="alert"
          title="Could not load this pool"
          description={error ?? "This pool has no usable dataset type contract."}
          action={
            <Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
              <Icon name="refresh" size={14} />
              Try again
            </Button>
          }
        />
      </>
    );
  }

  const { bounty } = contract;
  const target = Number(bounty.targetItems) || 0;
  // CAPACITY, not acceptance. Every use below — the capacity bar, the
  // "cleared by automation" label, targetReached (which gates the submit form),
  // and the bulk remaining cap — asks "how full is this pool", and the answer is
  // the count of items that cleared automation and hold a slot. `acceptedItems`
  // is FINAL acceptance only (validator-passed/published), so reading it here
  // would report a full pool as empty, leave the submit form open, and let the
  // server 409 POOL_CLOSED — the same class of bug the comment below records.
  // `clearedItems` is absent only on an API older than that split.
  const cleared = bounty.clearedItems == null
    ? Number(bounty.acceptedItems) || 0
    : Number(bounty.clearedItems) || 0;
  const poolSummary = bounty.poolSummary ?? null;
  const communityPolicy = poolSummary?.policy ?? null;
  // The pool publishes ONCE, as a whole pool, when it is complete and every
  // validator decision is in. This is the contributor's only honest answer to
  // "has the dataset my accepted work is part of shipped yet".
  const publication = parseDatasetPublication(poolSummary?.publication);
  const usesFinalPerItemDecision = communityPolicy?.validation === "full_human" || communityPolicy?.validation === "automation_only";
  const fullHumanValidation = communityPolicy?.validation === "full_human";
  const finalAccepted = poolSummary?.finalAccepted ?? (Number(bounty.acceptedItems) || 0);
  const reserved = poolSummary?.capacityReserved ?? cleared;
  // Mirrors the real accept gate (services/pool-submission.ts
  // POOL_OPEN_STATUSES = [active]) exactly. Without the status check, a
  // paused/closing/disputed bounty with poolClosedAt still null and
  // accepted < target rendered an open submission form the server would
  // then reject with 409 POOL_CLOSED.
  const statusClosed = bounty.status !== "active";
  const targetReached = target > 0 && (usesFinalPerItemDecision ? finalAccepted : reserved) >= target;
  const poolClosed = Boolean(bounty.poolClosedAt) || targetReached || statusClosed;

  const handleSubmit = () => {
    if (submitting || submitLockRef.current || !generationMethod) return;
    submitLockRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitNotice(null);
    void submitPoolItemsReal({
      bountyId: params.bountyId,
      items: [payload],
      generationMethod,
    })
      .then((created) => {
        const submission = created[0];
        setValues({});
        setGenerationMethod("");
        setAttestOriginal(false);
        setAttestNoPrivate(false);
        setAttestRights(false);
        setSubmitNotice(
          submission
            ? "Item submitted and queued for validation."
            : "Item submitted."
        );
        pushToast({ variant: "success", title: "Item submitted" });
        setAttempt((a) => a + 1); // refresh pool progress
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : "Submission failed. Please try again.";
        setSubmitError(message);
        pushToast({ variant: "error", title: "Submission failed", body: message });
      })
      .finally(() => {
        submitLockRef.current = false;
        setSubmitting(false);
      });
  };

  // One API call per item so each row carries its own
  // generation method and can be retried independently. The pool endpoint also
  // accepts a batch of items, but per-item calls give per-item outcomes.
  const submitBulkOne = async (
    item: ParsedItem,
    index: number
  ): Promise<Extract<SubmissionOutcome, { kind: "created" }>> => {
    const created = await submitPoolItemsReal({
      bountyId: params.bountyId,
      items: [payloadForDataset(type, item)],
      generationMethod: item.generationMethod,
    });
    const submission = created[0];
    if (!submission?.id) throw new Error("The API did not return a submission id. Please check your submissions before retrying.");
    return { index, item, kind: "created", submission };
  };

  const handleBulk = (items: ParsedItem[]) => {
    if (submittingMode || submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmittingMode("bulk");
    setSubmitError(null);
    setSubmitNotice(null);
    setLastBulkItems(items);
    setSubmissionOutcomes([]);
    void (async () => {
      // Submit the whole file in as few requests as possible and let the async
      // validation queue process them — rather than one HTTP round-trip per
      // row. Items are grouped by their disclosed generation method (the pool
      // endpoint takes one method per call) and each group is chunked to the
      // API's 100-items-per-request cap.
      const CHUNK = 100;
      const byMethod = new Map<GenerationMethod, number[]>();
      items.forEach((item, index) => {
        const list = byMethod.get(item.generationMethod) ?? [];
        list.push(index);
        byMethod.set(item.generationMethod, list);
      });
      const chunks: { method: GenerationMethod; indices: number[] }[] = [];
      for (const [method, indices] of byMethod) {
        for (let i = 0; i < indices.length; i += CHUNK) {
          chunks.push({ method, indices: indices.slice(i, i + CHUNK) });
        }
      }

      const outcomes: SubmissionOutcome[] = [];
      for (let c = 0; c < chunks.length; c += 1) {
        const { method, indices } = chunks[c];
        setBulkProgress({ current: c + 1, total: chunks.length });
        try {
          const created = await submitPoolItemsReal({
            bountyId: params.bountyId,
            items: indices.map((idx) => payloadForDataset(type, items[idx])),
            generationMethod: method,
          });
          indices.forEach((idx, j) => {
            const submission = created[j];
            outcomes.push(
              submission?.id
                ? { index: idx, item: items[idx], kind: "created", submission }
                : { index: idx, item: items[idx], kind: "failed", error: "The API did not return a submission for this row." }
            );
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Submission failed.";
          indices.forEach((idx) => outcomes.push({ index: idx, item: items[idx], kind: "failed", error: message }));
        }
        // Keep the results list in the file's original row order.
        outcomes.sort((a, b) => a.index - b.index);
        setSubmissionOutcomes([...outcomes]);
      }
      const createdCount = outcomes.filter((o) => o.kind === "created").length;
      const failedCount = outcomes.length - createdCount;
      if (createdCount > 0 && failedCount === 0) setFormResetKey((key) => key + 1);
      setSubmitNotice(
        failedCount > 0
          ? `${createdCount} of ${outcomes.length} items reached the API. Review the failed rows below and retry them.`
          : `All ${createdCount} items reached the API. Review each live validation status below.`
      );
      pushToast(
        failedCount > 0
          ? { variant: "error", title: `${createdCount} of ${outcomes.length} items submitted`, body: "Review and retry the failed rows below." }
          : { variant: "success", title: `${createdCount} item${createdCount === 1 ? "" : "s"} submitted` }
      );
    })()
      .catch((e) => {
        const message = e instanceof Error ? e.message : "Bulk submission failed. Please try again.";
        setSubmitError(message);
        pushToast({ variant: "error", title: "Bulk submission failed", body: message });
      })
      .finally(() => {
        submitLockRef.current = false;
        setSubmittingMode(null);
        setBulkProgress(null);
        setAttempt((a) => a + 1); // refresh pool progress + submissions list
      });
  };

  const retryBulkItem = (index: number) => {
    if (submittingMode || submitLockRef.current) return;
    const item = lastBulkItems[index];
    const existing = submissionOutcomes.find((o) => o.index === index);
    if (!item || !existing || existing.kind !== "failed") return;
    submitLockRef.current = true;
    setSubmitError(null);
    setSubmitNotice(null);
    setSubmittingMode("retry");
    setBulkProgress({ current: 1, total: 1 });
    void submitBulkOne(item, index)
      .then((outcome) => {
        setSubmissionOutcomes((prev) => prev.map((entry) => (entry.index === index ? outcome : entry)));
        setSubmitNotice(`Item ${index + 1} was submitted successfully. Its live validation status is shown below.`);
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : "Submission failed. Please try again.";
        setSubmissionOutcomes((prev) => prev.map((entry) => (entry.index === index ? { index, item, kind: "failed", error: message } : entry)));
        setSubmitError(`Item ${index + 1} still could not be submitted. You can retry again.`);
      })
      .finally(() => {
        submitLockRef.current = false;
        setSubmittingMode(null);
        setBulkProgress(null);
        setAttempt((a) => a + 1);
      });
  };

  // How many items the pool still needs — the requested quantity minus what's
  // already accepted. When the target is unknown, don't impose an artificial cap.
  const poolBulkRemaining = target > 0 ? Math.max(0, target - reserved) : Number.MAX_SAFE_INTEGER;
  const remainingToPoolClose = poolSummary?.remainingToTarget ?? (target > 0 ? Math.max(0, target - cleared) : null);
  const poolDeadline = bounty.deadline ? new Date(bounty.deadline) : null;
  const poolDeadlineLabel = poolDeadline && !Number.isNaN(poolDeadline.getTime())
    ? poolDeadline.toLocaleDateString()
    : null;
  const rollingAudit = bounty.humanAudit?.mode === "rolling_window";
  const auditProgress = bounty.humanAudit
    ? `${bounty.humanAudit.completedDecisions} of ${bounty.humanAudit.selectedItems} selected audits decided`
    : null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={bounty.title} sub={<span>Community open pool · +{bounty.karmaPricing.contributorPerItem} karma / accepted item · up to +{bounty.karmaPricing.contributorTotal} karma</span>} />

      <div className="card mb-6 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Pill tone="karma">no claim needed — submit directly</Pill>
          <span className="font-mono text-xs text-ink-soft" title={usesFinalPerItemDecision ? "Only final accepted items count toward this community pool target." : "Items that clear every applicable automated check reserve capacity. They are not finally accepted and do not earn karma until their required final review finishes."}>
            {usesFinalPerItemDecision
              ? `${finalAccepted} / ${target} final accepted · ${reserved} capacity reserved`
              : `${reserved} / ${target} capacity reserved · ${finalAccepted} final accepted`}
          </span>
        </div>
        <Progress value={usesFinalPerItemDecision ? finalAccepted : reserved} max={target} tone="ink" track="line" className="mt-3 rounded-[3px]" />
        {poolSummary && (
          <p className="mt-2 font-mono text-[11px] text-ink-soft">
            {usesFinalPerItemDecision
              ? fullHumanValidation
                ? `${poolSummary.processing} in automated checks · ${poolSummary.validatorReview} awaiting validator decision · ${poolSummary.finalAccepted} final accepted · ${poolSummary.rejected} rejected`
                : `${poolSummary.processing} in automated checks · ${poolSummary.finalAccepted} final accepted · ${poolSummary.rejected} rejected · clean pipeline results release karma immediately`
              : `${poolSummary.awaitingNextWindow} awaiting next window · ${poolSummary.validatorReview} with validators · ${poolSummary.awaitingCurrentWindowOutcome} held for this window · ${poolSummary.rejected} excluded`}
          </p>
        )}
        {subSummary.total > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line-soft pt-3 font-mono text-[11px] sm:grid-cols-3">
            <div className="validation-stat validation-stat-accepted rounded-md px-3 py-2" title="Final accepted items count toward the pool target and earn karma."><strong>{subSummary.accepted}</strong> final accepted</div>
            <div className="validation-stat validation-stat-action rounded-md px-3 py-2"><strong>{subSummary.actionNeeded}</strong> rejected / needs action</div>
            <div className="validation-stat validation-stat-review rounded-md px-3 py-2"><strong>{subSummary.automatedChecks}</strong> automated checks running</div>
            <div className="validation-stat validation-stat-review rounded-md px-3 py-2" title={fullHumanValidation ? "Every item that clears the automated pipeline receives an individual human validator decision." : "A validator must make the final decision because a safety check was unavailable or inconclusive, or the item was selected for audit. Open the item to see the exact reason."}><strong>{subSummary.validatorAudit}</strong> {fullHumanValidation ? "awaiting validator" : "requires validator"}</div>
            {usesFinalPerItemDecision ? (
              <div className="validation-stat validation-stat-accepted rounded-md px-3 py-2" title={fullHumanValidation ? "A human approval is final and releases karma immediately." : "A clean automated result is final and releases karma immediately."}><strong>{subSummary.accepted}</strong> karma released</div>
            ) : (
              <div className="validation-stat validation-stat-review rounded-md px-3 py-2" title={rollingAudit ? "Automated checks passed. Rolling windows select the configured human-audit sample as they fill." : "Automated checks passed. Final pool-wide sampling begins when the pool fills or reaches its deadline."}><strong>{subSummary.poolCloseReview}</strong> {rollingAudit ? "awaiting audit window" : "waiting for pool close"}</div>
            )}
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800"><strong>{subSummary.disputed}</strong> disputed</div>
          </div>
        )}
        {usesFinalPerItemDecision ? (
          <p className="mt-3 border-t border-line-soft pt-3 text-xs leading-relaxed text-ink-soft">
            <strong className="text-ink">How this community pool works:</strong>{" "}
            {/* No per-item publication claim here. The dataset is published ONCE,
                as a whole pool, once the pool is complete and every validator
                decision is in — the live state of that single event is the
                `PublicationStatus` block below, straight from the server. */}
            {fullHumanValidation
              ? "every item that clears the automated pipeline goes directly to a human validator. Their item-level approval is final and releases karma immediately."
              : "a complete clean automated pipeline result is final and releases karma immediately."}{" "}
            Rejected items receive their own reason, earn no karma, and never reduce another contributor’s result. There is no sponsor review, sampling window, or batch-wide rejection.
          </p>
        ) : subSummary.poolCloseReview > 0 && remainingToPoolClose !== null && (
          <p className="mt-3 border-t border-line-soft pt-3 text-xs leading-relaxed text-ink-soft">
            <strong className="text-ink">What the {subSummary.poolCloseReview.toLocaleString()} means:</strong> these items cleared every applicable automated check and safely reserve pool capacity. They are not final accepts yet. {rollingAudit ? <>The pool uses {bounty.humanAudit?.windowSize}-item rolling audit windows; {auditProgress}. </> : <>Final review starts after <strong className="text-ink">{remainingToPoolClose.toLocaleString()} more validated item{remainingToPoolClose === 1 ? "" : "s"}</strong>{poolDeadlineLabel ? <> or on <strong className="text-ink">{poolDeadlineLabel}</strong></> : ""}. </>}Karma is awarded only after that final decision. The <strong className="text-ink">{subSummary.validatorAudit.toLocaleString()} requiring a validator</strong> are separate items where a human must make the final decision—they are not automatically rejected.
          </p>
        )}
      </div>

      <PublicationStatus publication={publication} className="mb-6" />

      <DatasetContractPanel
        type={type}
        audience="contributor"
        className="mb-6"
        llmEnabled={contract.llmValidationEnabled === true}
      />

      {contract.sponsorReferences && contract.sponsorReferences.length > 0 && (
        <SponsorReferenceExamples
          artifacts={contract.sponsorReferences}
          type={type}
          // Only offer prefill when the item form is actually on the page.
          // With launch.dashboard_submissions.enabled off the form is replaced
          // by a coming-soon notice, and the button would be a dead control
          // that silently does nothing.
          onPrefill={dashboardSubmissionsLive ? (v) => setValues((prev) => ({ ...prev, ...v })) : undefined}
        />
      )}

      {poolClosed ? (
        <Empty
          icon="check"
          title="This pool is closed"
          description={
            // Honest about the real reason rather than always claiming the
            // target was reached — a sponsor-paused or disputed pool is
            // closed for a different reason than a full one.
            targetReached
              ? "This pool already reached its item target and is no longer accepting contributions."
              : statusClosed
                ? `This pool is not accepting contributions right now (${BOUNTY_STATUS_LABELS[bounty.status]}).`
                : "This pool is no longer accepting contributions."
          }
        />
      ) : !dashboardSubmissionsLive ? (
        // Server-gated (launch.dashboard_submissions.enabled): the submit
        // routes reject a dashboard session while this is off, so the form is
        // not rendered rather than shown and then refused.
        /* Framed as the way in, not as a thing that's switched off — and
            corrected while we were here. The previous copy invited "your own
            script" with an API key, which the server REFUSES: submission is
            MCP-only (`submissionChannelBlockReason` in the API allows an MCP
            OAuth token or an API key carrying `x-databounty-client: mcp`, and
            gates the plain-API channel behind `launch.api_submissions.enabled`,
            default off). So it sent contributors to build an integration that
            would 4xx on the first submit. */
        <ComingSoonNotice icon="code">
          <span className="font-bold">Contribute with your coding agent.</span>{" "}
          Items for this pool come in through an MCP client — Claude Code, Codex, Cursor,
          or any MCP-capable agent connected to DataBounty. Your agent reads this pool&apos;s
          contract, builds items against it, and submits them for you, so a run of fifty
          items is one prompt instead of fifty forms. Browsing the pool, its contract, and
          your submissions below all work as normal.{" "}
          <Link href="/developers" className="font-medium underline">
            Connect an MCP client
          </Link>
          .
        </ComingSoonNotice>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <Segmented<Mode>
              value={mode}
              disabled={submittingMode !== null}
              onChange={setMode}
              options={[
                { value: "single", label: "Single item" },
                { value: "bulk", label: "Bulk upload" },
              ]}
            />
            <span className="font-mono text-[11px] text-ink-soft">
              Bulk: JSON / JSONL / CSV / TSV
              {target > 0 ? ` · pool still needs ${poolBulkRemaining.toLocaleString()}` : ""}
            </span>
          </div>

          {submittingMode && (
            <div className="mb-5 flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 font-mono text-xs text-sky-800" role="status">
              <span className="h-2 w-2 animate-pulse rounded-full bg-sky-600" />
              {bulkProgress
                ? `Submitting item ${bulkProgress.current} of ${bulkProgress.total}… Do not close this page.`
                : "Submitting… Do not close this page."}
            </div>
          )}

          {submitError && (
            <div role="alert" className="mb-5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 font-mono text-xs text-rose-700">
              {submitError}
            </div>
          )}
          {submitNotice && (
            <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 font-mono text-xs text-emerald-700">
              {submitNotice}
            </div>
          )}

          {mode === "single" ? (
        <div className="card space-y-5 px-5 py-5 sm:px-6">
          <DynamicFieldsEditor
            type={type}
            bountyId={params.bountyId}
            values={values}
            onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
          />

          <Field label="Generation method" required hint="AI assistance is allowed, but disclosure is required and saved with the submission.">
            <Select
              value={generationMethod}
              aria-label="How this item was produced"
              onChange={(e) => setGenerationMethod(e.target.value as GenerationMethod | "")}
            >
              <option value="" disabled>Select how this item was produced...</option>
              <option value="human">Human</option>
              <option value="ai_assisted">AI-assisted</option>
              <option value="ai_generated">AI-generated</option>
            </Select>
          </Field>

          {hasEditedField && missing.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 font-mono text-xs text-amber-800">
              Missing required field keys: {missing.join(", ")}
            </div>
          )}

          <div className="rounded-lg border border-line-soft bg-panel px-4 py-3.5">
            <div className="micro-label text-ink-soft">attestations</div>
            <div className="mt-2.5 space-y-2.5">
              {[
                { checked: attestOriginal, set: setAttestOriginal, label: "This is my original work." },
                { checked: attestNoPrivate, set: setAttestNoPrivate, label: "It contains no private code and is not copied from a public benchmark." },
                { checked: attestRights, set: setAttestRights, label: `I grant the license this pool publishes under (${bounty.license ?? "open license"}).` },
              ].map((a, i) => (
                <label key={i} className="flex cursor-pointer items-start gap-2.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={a.checked}
                    onChange={(e) => a.set(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-line accent-[var(--color-brand)]"
                  />
                  <span className="leading-snug">
                    {a.label}
                    <span className="ml-0.5 text-rose-500">*</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-dark-line bg-dark px-4 py-3 font-mono text-[12px] text-dark-muted">
            <Icon name="beaker" size={15} className="mt-0.5 shrink-0 text-lime" />
            <p className="leading-relaxed">
              Validation stages: {pipelineWithPlatformStages(type.verification.pipeline, { llmEnabled: contract.llmValidationEnabled === true }).map(stageLabel).join(" → ")}. Dedupe identity:{" "}
              {type.verification.dedupeFields.join(" + ") || "schema fields"}.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
            <span className="font-mono text-xs text-ink-soft">
              earns <span className="font-bold text-ink">+{bounty.karmaPricing.contributorPerItem} karma</span> on acceptance
            </span>
            <Button disabled={!canSubmit || submitting} aria-busy={submitting} onClick={handleSubmit}>
              <Icon name="send" size={15} />
              {submitting ? "Submitting…" : "Submit item"}
            </Button>
          </div>
        </div>
          ) : (
            <BulkUpload
              key={formResetKey}
              type={type}
              sourceUpload={contract.sourceUpload}
              remainingItems={poolBulkRemaining}
              rewardLabel={<>earns <span className="font-bold text-ink">+{bounty.karmaPricing.contributorPerItem} karma</span> / accepted item</>}
              attestLabel="I attest all {count} items are my original work, contain no private code, are not copied from a public benchmark, and I grant the license this pool publishes under."
              overCapacityMessage={(count, remaining) =>
                `This file has ${count} items, but the pool only needs ${remaining.toLocaleString()} more. Remove the extra rows or split the file.`
              }
              submitting={submittingMode !== null}
              onSubmitAll={(items) => handleBulk(items)}
            />
          )}

          <BulkSubmissionSummary outcomes={submissionOutcomes} submitting={submittingMode !== null} onRetry={retryBulkItem} />
        </>
      )}

      <section className="card mt-6 overflow-hidden" aria-label="Your pool submissions">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft px-5 py-4">
          <div>
            <h2 className="font-mono text-sm font-bold text-ink">Your submissions to this pool</h2>
            <p className="mt-1 text-xs text-ink-soft">
              {subLoading
                ? "Loading your submitted items…"
                : `${subData.total} submitted item${subData.total === 1 ? "" : "s"}. Open any item for its exact validation reasons, issues, dispute status, and revision history.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 font-mono text-[11px]">
            <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-ink-soft">Automated checks running: <strong className="text-ink">{subSummary.automatedChecks}</strong></span>
            <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-ink-soft">Requires validator: <strong className="text-ink">{subSummary.validatorAudit}</strong></span>
            <span className="rounded-full border border-line bg-panel px-2.5 py-1 text-ink-soft">Waiting for pool close: <strong className="text-ink">{subSummary.poolCloseReview}</strong></span>
          </div>
        </div>

        <div className="border-b border-line-soft px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <PillTabs
              value={subFilter}
              onChange={(next) => {
                setSubFilter(next);
                setSubPage(1);
              }}
              items={[
                { key: "all", label: "all", count: allSubCount },
                { key: "action_needed", label: "needs action", count: subSummary.actionNeeded },
                { key: "in_review", label: "needs final outcome", count: subSummary.inReview },
                { key: "accepted", label: "final accepted", count: subSummary.accepted },
              ]}
            />
            <SearchField
              value={subSearch}
              onChange={(next) => {
                setSubSearch(next);
                setSubPage(1);
              }}
              placeholder="Search your items…"
              className="min-w-52 flex-1 sm:w-64"
            />
          </div>
        </div>

        <div className="border-b border-line-soft bg-panel px-5 py-3 text-[11px] leading-relaxed text-ink-soft">
          <strong className="text-ink">How progress works:</strong> items that clear automated checks reserve pool capacity; only final accepted items earn karma. {rollingAudit ? "This pool selects rolling audit windows as cleared items arrive; the shown decision count is the completed evidence, not the configured target percentage." : "“Waiting for pool close” means automated checks passed and the item awaits the pool-wide final sample."} “Requires validator” means an exact item-level reason is available in its evidence, and a validator must decide it. Duplicate is a similarity score—higher means a closer match and more risk. LLM quality is a rubric score—higher is better.
        </div>

        {subLoading ? (
          <div className="px-5 py-6">
            <AsyncState status="loading" loadingText="Loading submissions…" />
          </div>
        ) : subError ? (
          <div className="px-5 py-6">
            <AsyncState status="error" errorTitle="Could not load submissions" errorDescription={subError} />
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>Retry</Button>
            </div>
          </div>
        ) : subData.submissions.length === 0 ? (
          <div className="px-5 py-6">
            <AsyncState
              status="empty"
              emptyChildren={subFilter === "all" && !debouncedSubSearch ? "You have not submitted any items to this pool yet." : "No submissions match these filters."}
            />
          </div>
        ) : (
          <div className="divide-y divide-line-soft">
            {subData.submissions.map((submission) => (
              <div key={submission.id} className="grid gap-3 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{submission.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-ink-faint">
                    <span className="max-w-[10rem] truncate sm:max-w-[14rem]" title={submission.id}>#{submission.id}</span>
                    <SubmissionStatusPill status={submission.status as SubmissionStatus} />
                    {submission.issueCount > 0 && (
                      <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-rose-700">
                        {submission.issueCount} issue{submission.issueCount === 1 ? "" : "s"}
                      </span>
                    )}
                    {submission.actionable && (
                      <span>· {submission.revisionsRemaining >= 9999 ? "unlimited" : submission.revisionsRemaining} revision attempt{submission.revisionsRemaining === 1 ? "" : "s"} remaining</span>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 font-mono text-[10px] text-ink-soft" aria-label="Validation scores">
                  <span title="Higher duplicate similarity means greater duplicate risk">dup <strong className="text-ink">{evidenceScore(submission.duplicateScore)}</strong></span>
                  <span title="Higher LLM rubric score means better assessed quality">quality <strong className="text-ink">{submission.llmScore == null ? "—" : `${Math.round(submission.llmScore)}%`}</strong></span>
                </div>
                <Link href={`/contributor/submissions/${submission.id}`} className="inline-flex items-center gap-1 font-mono text-xs font-medium text-accent-strong hover:underline">
                  {submission.actionable ? "review & resubmit" : "view evidence"}
                  <Icon name="arrow-right" size={12} />
                </Link>
              </div>
            ))}
          </div>
        )}

        <Pagination
          page={subData.page}
          totalPages={subData.totalPages}
          disabled={subLoading}
          onPrev={() => setSubPage((page) => Math.max(1, page - 1))}
          onNext={() => setSubPage((page) => Math.min(subData.totalPages, page + 1))}
          className="mx-5 mb-4"
        />
      </section>

      <div className="mt-4">
        <Link href="/contributor" className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-soft hover:text-ink hover:underline">
          <Icon name="arrow-right" size={12} className="rotate-180" />
          Back to Contributor dashboard
        </Link>
      </div>
    </div>
  );
}
