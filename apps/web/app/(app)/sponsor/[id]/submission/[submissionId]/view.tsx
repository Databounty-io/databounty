"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useDemo, authedFetch } from "@/lib/store";
import { API } from "@/lib/api-endpoints";
import { BackLink, Button, Empty, SubmissionStatusPill } from "@/components/ui";
import { AutoRefreshControl } from "@/components/auto-refresh";
import { SponsorSubmissionDetail, SubmissionAuditHistoryDrawer } from "@/components/sponsor-submission-detail";
import { fieldRows } from "@/components/dynamic-item-fields";
import {
  getSponsorSubmissionEvidence,
  submissionDisplayFromApi,
  type ApiSubmissionDetail,
} from "@/lib/api-work";
import { getArtifactProcessingEvents, type ArtifactProcessingEventsResponse } from "@/lib/api-artifacts";
import type { DatasetType } from "@/lib/dataset-types";
import type { Submission, SubmissionStatus } from "@/lib/types";

const ACTIVE: SubmissionStatus[] = [
  "submitted",
  "duplicate_check",
  "running_tests",
  "llm_validation",
  "provisionally_accepted",
  "in_audit",
  "disputed",
];

export function SponsorSubmissionView() {
  const params = useParams<{ id: string; submissionId: string }>();
  const bountyId = params?.id;
  const submissionId = params?.submissionId;
  const { datasetTypes } = useDemo();

  const [apiSub, setApiSub] = useState<ApiSubmissionDetail | null>(null);
  const [display, setDisplay] = useState<Submission | null>(null);
  const [datasetType, setDatasetType] = useState<DatasetType | null>(null);
  const [bountyTitle, setBountyTitle] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modalityEvents, setModalityEvents] = useState<Record<string, ArtifactProcessingEventsResponse | null | undefined>>({});

  const load = useCallback(
    async (initial = false) => {
      if (!submissionId || !bountyId) return;
      if (initial) setLoading(true);
      else setRefreshing(true);
      try {
        const sub = await getSponsorSubmissionEvidence(bountyId, submissionId);
        if (!sub) {
          setError("not_found");
          return;
        }
        setApiSub(sub);
        setDisplay(submissionDisplayFromApi(sub));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "request_failed");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [bountyId, submissionId],
  );

  useEffect(() => {
    // One-shot data load on mount/id change, not a React-state sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!bountyId) return;
    let alive = true;
    authedFetch(API.bounties.one(bountyId))
      .then(async (r) => {
        if (!alive || !r.ok) return;
        const data = await r.json();
        const bounty = data?.bounty;
        if (!bounty) return;
        setBountyTitle(String(bounty.title ?? ""));
        const dt = (bounty.datasetType as DatasetType | null | undefined) ?? null;
        setDatasetType(dt ?? datasetTypes.find((t) => t.id === bounty.datasetTypeId) ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bountyId, datasetTypes]);

  const attachments = useMemo(() => apiSub?.attachments ?? [], [apiSub]);
  const hasFileField = Boolean(datasetType && fieldRows(datasetType).some((f) => f.role === "file"));
  useEffect(() => {
    if (!hasFileField || attachments.length === 0) return;
    let alive = true;
    Promise.all(
      attachments.map(async (artifact) => [artifact.id, await getArtifactProcessingEvents(artifact.id)] as const),
    ).then((entries) => {
      if (!alive) return;
      setModalityEvents(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [hasFileField, attachments]);

  if (loading && !display) {
    return (
      <div className="space-y-4">
        <BackLink href={`/sponsor/${bountyId}`}>Back to program</BackLink>
        <div className="card p-8 text-center text-ink-soft">Loading submission evidence…</div>
      </div>
    );
  }

  if (error === "not_found" || (!display && !loading)) {
    return (
      <div className="space-y-4">
        <BackLink href={`/sponsor/${bountyId}`}>Back to program</BackLink>
        <Empty
          title="Cannot load this submission"
          description="It may not exist, or you may not have access to view it."
        />
      </div>
    );
  }

  if (!display || !apiSub) return null;

  const isActive = ACTIVE.includes(display.status);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <BackLink href={`/sponsor/${bountyId}`} className="mb-2 inline-flex">
            {bountyTitle || "Back to program"}
          </BackLink>
          <h1 className="break-words text-2xl font-bold tracking-tight text-ink">{display.title}</h1>
          <div className="mt-2">
            <SubmissionStatusPill status={display.status} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <AutoRefreshControl
            onRefresh={() => load(false)}
            refreshing={refreshing}
            enabled={isActive}
          />
          <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}>
            Audit history
          </Button>
        </div>
      </div>

      <SponsorSubmissionDetail
        display={display}
        payload={apiSub.payloadJson ?? {}}
        datasetType={datasetType}
        validationResults={apiSub.validationResults ?? []}
        auditItems={apiSub.auditItems ?? []}
        attachments={attachments}
        modalityEvents={modalityEvents}
        llmValidationEnabled={apiSub.llmValidationEnabled}
      />

      <SubmissionAuditHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        validationResults={apiSub.validationResults ?? []}
        revisions={apiSub.revisions ?? []}
        auditItems={apiSub.auditItems ?? []}
        flags={apiSub.flags ?? []}
      />
    </div>
  );
}
