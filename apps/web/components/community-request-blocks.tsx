"use client";

// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { API } from "@/lib/api-endpoints";
import { authedFetch, useDemo } from "@/lib/store";
import { humanizeKey } from "@/lib/format";
import { Button, Pill } from "@/components/ui";
import { inputCls } from "@/components/dynamic-item-fields";
import { ArtifactChecksPanel, humanSize } from "@/components/artifacts";
import { ArtifactScanStatus } from "@/components/artifact-scan-status";
import { listBountyArtifacts, type ApiArtifact } from "@/lib/api-artifacts";
import { useArtifactStatusPolling } from "@/lib/use-artifact-status-polling";

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

export interface RequestSpec {
  description?: string | null;
  datasetTypeName?: string | null;
  datasetTypeVersion?: number | null;
  datasetTypeId?: string | null;
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
  reviewedAt?: string | null;
}

export function dateLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Field({
  label,
  value,
  alwaysShow = false,
}: {
  label: string;
  value: React.ReactNode;
  alwaysShow?: boolean;
}) {
  const empty = value == null || value === "";
  if (empty && !alwaysShow) return null;
  return (
    <div>
      <div className="micro-label mb-0.5 text-ink-faint">{label}</div>
      <div className={`text-[13px] ${empty ? "text-ink-faint" : "text-ink"}`}>
        {empty ? "not specified" : value}
      </div>
    </div>
  );
}

export function RequestSpecGrid({
  spec,
  licenseLabel,
  className = "",
}: {
  spec: RequestSpec;
  licenseLabel: (value: string) => string;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${className}`}>
      <Field
        label="dataset type"
        alwaysShow
        value={
          spec.datasetTypeName
            ? `${spec.datasetTypeName}${spec.datasetTypeVersion ? ` · v${spec.datasetTypeVersion}` : ""}`
            : spec.datasetTypeId
              ? humanizeKey(spec.datasetTypeId)
              : null
        }
      />
      <Field label="domain" alwaysShow value={spec.domain ? humanizeKey(spec.domain) : null} />
      <Field label="language" alwaysShow value={spec.language} />
      <Field label="framework" alwaysShow value={spec.framework} />
      <Field
        label="items requested"
        alwaysShow
        value={spec.targetItems != null ? spec.targetItems.toLocaleString() : null}
      />
      <Field label="difficulty" alwaysShow value={spec.difficultyMix ? humanizeKey(spec.difficultyMix) : null} />
      <Field
        label="audit coverage"
        alwaysShow
        value={spec.auditCoveragePct != null ? `${spec.auditCoveragePct}%` : null}
      />
      <Field
        label="license"
        alwaysShow
        value={spec.proposedLicense ? licenseLabel(spec.proposedLicense) : spec.proposedLicense}
      />
      <Field label="filed" alwaysShow value={dateLabel(spec.createdAt)} />
      {spec.reviewedAt && <Field label="reviewed" value={dateLabel(spec.reviewedAt)} />}
      {spec.resubmitCount ? <Field label="resubmissions" value={spec.resubmitCount} /> : null}
    </div>
  );
}

export function ReviewerNote({ note, className = "" }: { note: string; className?: string }) {
  return (
    <div className={`rounded-lg border border-[#e4e6df] bg-panel p-3 ${className}`}>
      <div className="micro-label mb-1 text-ink-faint">reviewer note</div>
      <p className="text-[13px] text-ink">{note}</p>
    </div>
  );
}

export function ReferenceSampleTable({
  bountyId,
  className = "",
}: {
  bountyId: string;
  className?: string;
}) {
  const [samples, setSamples] = useState<ApiArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [openChecks, setOpenChecks] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reload = useCallback(async () => {
    const rows = await listBountyArtifacts(bountyId, "sponsor_reference");
    if (!mountedRef.current) return;
    setSamples(rows);
    setLoading(false);
  }, [bountyId]);

  useEffect(() => { void reload(); }, [reload]);
  useArtifactStatusPolling(samples.some((s) => s.status === "scanning"), reload);

  if (loading) return <p className={`text-[12.5px] text-ink-soft ${className}`}>Loading samples…</p>;
  if (!samples.length) {
    return (
      <p className={`text-[12.5px] text-ink-soft ${className}`}>
        No reference samples are attached to this program.
      </p>
    );
  }

  return (
    <div className={className}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left">
          <thead>
            <tr className="border-b border-line-soft">
              {["file", "type", "size", "review", ""].map((head) => (
                <th
                  key={head}
                  className="pb-1.5 font-mono text-[10px] font-normal uppercase tracking-wide text-ink-faint"
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {samples.map((sample) => {
              const state = SAMPLE_TONE[sample.sponsorReviewStatus ?? "pending"] ?? SAMPLE_TONE.pending;
              return (
                <tr key={sample.id} className="border-b border-line-soft align-top last:border-b-0">
                  <td className="py-2 pr-3 text-[12.5px] text-ink">
                    <span className="block max-w-[220px] truncate">{sample.filename}</span>
                    <ArtifactScanStatus
                      status={sample.status}
                      className="mt-0.5 block text-[10.5px] leading-snug empty:mt-0"
                    />
                    {sample.sponsorReviewNote && (
                      <span className="mt-0.5 block text-[11px] leading-snug text-amber-700">
                        {sample.sponsorReviewNote}
                      </span>
                    )}
                    {openChecks === sample.id && (
                      <div className="mt-2 overflow-hidden rounded-lg border border-line-soft">
                        <ArtifactChecksPanel artifact={sample} />
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[10.5px] text-ink-soft">{sample.contentType}</td>
                  <td className="py-2 pr-3 font-mono text-[10.5px] text-ink-soft">{humanSize(sample.sizeBytes)}</td>
                  <td className="py-2 pr-3"><Pill tone={state.tone}>{state.label}</Pill></td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      aria-expanded={openChecks === sample.id}
                      className="text-[11px] text-ink-faint underline hover:text-ink"
                      onClick={() => setOpenChecks(openChecks === sample.id ? null : sample.id)}
                    >
                      {openChecks === sample.id ? "hide checks" : "checks"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-soft">
        These are the examples contributors and validators work against. They were locked when this program was
        approved and can no longer be changed — open <span className="font-mono">checks</span> on any row to see
        exactly which checks the platform ran on it.
      </p>
    </div>
  );
}

const SAMPLE_TONE: Record<string, { tone: "success" | "danger" | "warning" | "neutral"; label: string }> = {
  approved: { tone: "success", label: "approved" },
  rejected: { tone: "danger", label: "rejected" },
  needs_changes: { tone: "warning", label: "needs changes" },
  pending: { tone: "neutral", label: "in review" },
};

interface Comment {
  id: string;
  authorRole: string;
  body: string;
  internalOnly?: boolean;
  createdAt: string;
}

export function RequestReviewConversation({
  requestId,
  className = "",
}: {
  requestId: string;
  className?: string;
}) {
  const { pushToast } = useDemo();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch(API.community.requestComments(requestId));
      if (!res.ok) return;
      const data = (await res.json()) as { comments?: Comment[] };
      setComments(data.comments ?? []);
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => { void load(); }, [load]);

  const postReply = async () => {
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      const res = await authedFetch(API.community.requestComments(requestId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: reply.trim() }),
      });
      if (!res.ok) {
        const message = safeMessage((await res.json().catch(() => ({}))).message, "Couldn't send your reply.");
        pushToast({ variant: "error", title: "Reply not sent", body: message });
        return;
      }
      setReply("");
      await load();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={className}>
      <div className="micro-label mb-2 text-ink-faint">review conversation</div>
      {loading ? (
        <p className="text-[13px] text-ink-soft">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-[13px] text-ink-soft">No messages yet.</p>
      ) : (
        <ul className="space-y-2">
          {comments.map((comment) => (
            <li key={comment.id} className="rounded-lg border border-[#eceee7] p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Pill tone={comment.authorRole === "sponsor" ? "neutral" : "info"}>
                  {humanizeKey(comment.authorRole)}
                </Pill>
                {comment.internalOnly && <Pill tone="warning">internal</Pill>}
                <span className="text-[11px] text-ink-faint">
                  {new Date(comment.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-[13px] text-ink">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <textarea
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          aria-label="Reply to the reviewer"
          placeholder="Reply to the reviewer…"
          rows={2}
          className={inputCls}
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="secondary" disabled={!reply.trim() || sending} onClick={postReply}>
            {sending ? "Sending…" : "Send reply"}
          </Button>
        </div>
      </div>
    </div>
  );
}
