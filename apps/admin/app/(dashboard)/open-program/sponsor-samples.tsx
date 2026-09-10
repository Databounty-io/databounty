"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import Link from "next/link";
import {
  AdminButton,
  AdminDateTime,
  AdminEmptyState,
  AdminErrorBanner,
  AdminLoadingState,
  AdminPill,
  AdminTable,
  ATd,
  type AdminPillTone,
} from "@/components/admin-shell";
import { adminAuthedFetch } from "@/lib/admin-auth";
import { SponsorReviewControl } from "@/components/sponsor-review-control";

/* Review queue for sponsor reference-example uploads — GET
 * /v1/admin/sponsor-examples (admin-only, oldest-first, up to 100 pending
 * rows). Before this tab existed, the only way to act on one of these files
 * was the flat, platform-wide /artifacts list, with no contract or sponsor
 * scope alongside it — an admin had to already know which row was the one
 * they were after. This is the destination the Requests tab's "review
 * samples" link now points to. */

interface SponsorExampleOwner {
  type: "bounty" | "dataset_request";
  id: string;
  title: string;
  requestStatus?: string;
}

interface SponsorExampleScope {
  description: string | null;
  language: string | null;
  framework: string | null;
  targetItems: number | null;
  difficultyMix: string | null;
  auditCoveragePct: number | null;
  requester: { displayName: string; handle: string | null } | null;
}

interface SponsorExampleEvidence {
  stage: string;
  status: string;
  detail: unknown;
  createdAt: string;
}

interface SponsorExample {
  id: string;
  bountyId: string | null;
  bountyTitle: string;
  owner: SponsorExampleOwner | null;
  filename: string;
  contentType: string;
  status: "pending" | "needs_changes";
  note: string | null;
  createdAt: string;
  downloadUrl: string;
  contract: { id: string; name: string; version: number; fields: unknown } | null;
  scope: SponsorExampleScope | null;
  evidence: {
    llmReview: SponsorExampleEvidence | null;
    similarity: SponsorExampleEvidence | null;
  };
}

export interface SponsorExamplesResponse {
  examples: SponsorExample[];
}

/** Defensive parse of admin-authored `DatasetType.fields` JSON — same shape
 * `ContractField` decodes elsewhere in this app (details/page.tsx). Anything
 * that isn't a plain object with a string `key` is dropped rather than
 * guessed at. */
function parseContractFields(fields: unknown): { key: string; label: string; role: string | null }[] {
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const obj = entry as Record<string, unknown>;
    if (typeof obj.key !== "string") return [];
    return [
      {
        key: obj.key,
        label: typeof obj.label === "string" ? obj.label : obj.key,
        role: typeof obj.role === "string" ? obj.role : null,
      },
    ];
  });
}

/** Pull a human-readable reason out of an evidence stage's `detail` JSON,
 * when one exists, instead of dumping the raw object. */
function extractDetailReason(detail: unknown): string | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const obj = detail as Record<string, unknown>;
  for (const key of ["reason", "note", "evidence"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

const EVIDENCE_STATUS_TONE: Record<string, AdminPillTone> = {
  passed: "success",
  pass: "success",
  clean: "success",
  approved: "success",
  failed: "danger",
  fail: "danger",
  rejected: "danger",
  flagged: "warning",
  flag: "warning",
  advisory: "warning",
  needs_changes: "warning",
  pending: "info",
  skipped: "neutral",
  not_supported: "neutral",
};

/** Never renders a missing evidence stage as if it passed — `null` is always
 * "not run yet", in its own neutral tone, never folded into a positive one. */
function EvidenceChip({ label, evidence }: { label: string; evidence: SponsorExampleEvidence | null }) {
  if (!evidence) {
    return (
      <div>
        <AdminPill tone="neutral">{label}: not run yet</AdminPill>
      </div>
    );
  }
  const reason = extractDetailReason(evidence.detail);
  return (
    <div className="flex flex-col gap-0.5">
      <AdminPill tone={EVIDENCE_STATUS_TONE[evidence.status] ?? "neutral"}>
        {label}: {evidence.status.replaceAll("_", " ")}
      </AdminPill>
      {reason && <div className="max-w-56 text-[10px] leading-snug text-dark-dim">{reason}</div>}
    </div>
  );
}

/** Owner label: a real bounty's title, or an explicit "Dataset request: …"
 * line when the sample is still attached to an unminted request — never
 * rendered as if it belongs to a bounty that doesn't exist yet. */
function OwnerCell({ owner }: { owner: SponsorExampleOwner | null }) {
  if (owner?.type === "bounty") {
    return (
      <Link href={`/details?kind=bounty&id=${encodeURIComponent(owner.id)}`} className="font-mono text-xs text-lime underline">
        {owner.title}
      </Link>
    );
  }
  if (owner?.type === "dataset_request") {
    return (
      <div className="text-dark-soft">
        Dataset request: <span className="text-dark-text">{owner.title}</span>
        <div className="mt-0.5 text-[10px] text-dark-dim">{(owner.requestStatus ?? "unknown").replaceAll("_", " ")}</div>
      </div>
    );
  }
  return <span className="text-[10px] text-dark-dim">No owner recorded</span>;
}

function ScopeCell({ scope }: { scope: SponsorExampleScope | null }) {
  if (!scope) return <span className="text-[10px] text-dark-dim">No scope recorded</span>;
  return (
    <div className="max-w-64 space-y-1 text-[11px] leading-snug">
      {scope.description && <div className="text-dark-text">{scope.description}</div>}
      <div className="text-dark-soft">
        {scope.targetItems != null ? `${scope.targetItems.toLocaleString()} items` : "item count unset"}
        {" · "}
        {scope.language ?? "unspecified language"}
        {scope.framework ? ` · ${scope.framework}` : ""}
        {" · "}
        {(scope.difficultyMix ?? "unspecified").replaceAll("_", " ")}
        {" · "}
        {scope.auditCoveragePct ?? 0}% validator audit
      </div>
      {scope.requester && (
        <div className="text-[10px] text-dark-dim">
          requested by {scope.requester.handle ? `@${scope.requester.handle}` : scope.requester.displayName}
        </div>
      )}
    </div>
  );
}

function ContractCell({ contract }: { contract: SponsorExample["contract"] }) {
  if (!contract) return <span className="text-[10px] text-dark-dim">No contract recorded</span>;
  const fields = parseContractFields(contract.fields);
  return (
    <div className="max-w-56 space-y-1">
      <div className="text-dark-text">
        {contract.name} <span className="text-dark-dim">v{contract.version}</span>
      </div>
      {fields.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {fields.map((f) => (
            <span key={f.key} title={f.role ?? undefined} className="rounded-full border border-dark-line-soft px-1.5 py-0.5 text-[10px] text-dark-soft">
              {f.label}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[10px] text-dark-dim">No fields recorded on this contract.</div>
      )}
    </div>
  );
}

/** Opens the sample's bytes through `adminAuthedFetch`, same as
 * details/page.tsx's `AttachmentRow` — a plain cross-origin `<a href>`
 * wouldn't reliably carry the admin's session cookie to the API origin. */
function FileCell({ example }: { example: SponsorExample }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await adminAuthedFetch(example.downloadUrl);
      if (!res.ok) throw new Error(`Could not read this file (${res.status}).`);
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read this file.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-56">
      <div className="break-all font-semibold leading-snug text-dark-text">{example.filename}</div>
      <div className="mt-0.5 text-[10px] text-dark-dim">{example.contentType}</div>
      <div className="mt-1.5">
        <AdminButton variant="ghost" disabled={busy} onClick={() => void open()}>
          {busy ? "Opening…" : "Open file"}
        </AdminButton>
      </div>
      {error && <div className="mt-1 text-[10px] text-rose-400">{error}</div>}
    </div>
  );
}

/* Fetched by the page, not here: the tab badge needs an accurate count even
 * while this tab is closed (same reasoning as `publishReady` for the
 * Publishing tab), and fetching this endpoint in both places would hit it
 * twice on every load. */
export function SponsorSamplesSection({
  data,
  loading,
  error,
  refresh,
}: {
  data: SponsorExamplesResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}) {
  // Per-row local override so an approve/reject/needs-changes action reflects
  // immediately, applied as a patch over `data.examples` on every render
  // rather than mirrored into its own copy — a fresh fetch (poll, focus,
  // manual refresh) is picked up automatically with no effect required to
  // keep a duplicate in sync.
  type Override = { status: SponsorExample["status"]; note: string | null } | "removed";
  const [overrides, setOverrides] = useState<Record<string, Override>>({});

  const handleReviewed = (id: string, decision: string, note: string | null) => {
    setOverrides((prev) => ({
      ...prev,
      // This endpoint only ever returns pending/needs-changes rows, so a
      // final approve/reject decision removes the row from the queue rather
      // than showing a status this list is never expected to display.
      [id]: decision === "approved" || decision === "rejected" ? "removed" : { status: "needs_changes", note },
    }));
  };

  const rows = (data?.examples ?? []).flatMap((example) => {
    const override = overrides[example.id];
    if (override === "removed") return [];
    if (override) return [{ ...example, ...override }];
    return [example];
  });

  return (
    <div>
      {error && <AdminErrorBanner message={error} onRetry={refresh} />}
      {loading && !data ? (
        <AdminLoadingState label="Loading sponsor samples…" />
      ) : data && rows.length === 0 ? (
        <AdminEmptyState message="No sponsor samples awaiting review." />
      ) : (
        <AdminTable headers={["file", "owner", "contract", "requested scope", "advisory evidence", "review"]}>
          {rows.map((example) => (
            <tr key={example.id}>
              <ATd>
                <FileCell example={example} />
                <div className="mt-1 text-[10px] text-dark-dim">
                  <AdminDateTime iso={example.createdAt} />
                </div>
              </ATd>
              <ATd>
                <OwnerCell owner={example.owner} />
              </ATd>
              <ATd>
                <ContractCell contract={example.contract} />
              </ATd>
              <ATd>
                <ScopeCell scope={example.scope} />
              </ATd>
              <ATd>
                <div className="flex flex-col gap-1.5">
                  <EvidenceChip label="LLM review" evidence={example.evidence.llmReview} />
                  <EvidenceChip label="similarity" evidence={example.evidence.similarity} />
                </div>
              </ATd>
              <ATd>
                <SponsorReviewControl
                  artifact={{ id: example.id, sponsorReviewStatus: example.status, sponsorReviewNote: example.note }}
                  onReviewed={handleReviewed}
                />
              </ATd>
            </tr>
          ))}
        </AdminTable>
      )}
    </div>
  );
}
