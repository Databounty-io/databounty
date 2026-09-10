"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AdminButton,
  AdminConfirmDialog,
  AdminDateTime,
  AdminEmptyState,
  AdminErrorBanner,
  AdminLoadingState,
  AdminPageHeader,
  AdminPill,
  AdminSectionHeading,
} from "@/components/admin-shell";
import { useAdminRoleGates } from "@/lib/admin-auth";
import { useAdminResource } from "@/lib/use-admin-resource";
import { useAdminToast } from "@/lib/admin-toast";
import {
  addIssueNote,
  assignIssue,
  type DuplicateCandidates,
  impactTone,
  IssueConflictError,
  isTerminal,
  ISSUE_CATEGORY_LABELS,
  ISSUE_IMPACT_LABELS,
  ISSUE_STATUS_LABELS,
  requestIssueInfo,
  requiresReason,
  setIssueStatus,
  severityTone,
  statusTone,
  type IssueDetail,
  type IssueSeverity,
  type IssueStatus,
} from "@/lib/agent-issues";

/**
 * One agent issue: the safe report, server-collected context, the case
 * timeline (reporter-visible vs internal), and the staff actions.
 *
 * Three rules this page follows deliberately:
 *  1. Every action sends the version it was rendered from. A 409 shows the
 *     conflict and reloads — never last-write-wins.
 *  2. State comes from the server response, never from optimistic guessing.
 *  3. A terminal case shows no transition controls: an admin is never offered
 *     a button the server will only ever reject.
 */

const SEVERITIES: IssueSeverity[] = ["low", "medium", "high", "critical"];

/** Dispositions offered from an open case. `duplicate` is handled separately
 * (admin-only and needs a canonical id). */
const DISPOSITIONS: { value: IssueStatus; label: string }[] = [
  { value: "triaged", label: "Triaged" },
  { value: "investigating", label: "Investigating" },
  { value: "resolved", label: "Resolved" },
  { value: "not_reproducible", label: "Not reproducible" },
  { value: "rejected", label: "Rejected" },
];

const inputClass =
  "w-full rounded-[8px] border border-dark-line bg-dark-bg px-2.5 py-2 text-[13px] text-dark-text placeholder:text-dark-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/60";

export default function AdminIssueDetailView() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const { isAdmin, isMember } = useAdminRoleGates();
  const canAct = isAdmin || isMember;
  const { pushToast } = useAdminToast();

  // One resource, one identity. `enabled` keeps it from firing a request for
  // an empty id when the page is opened without ?id=.
  const {
    data: issue,
    loading,
    error,
    refresh: load,
  } = useAdminResource<IssueDetail>(`/v1/admin/issues/${encodeURIComponent(id)}`, {
    enabled: id.length > 0,
    // Same message whether the case does not exist or is not visible to this
    // tier — the API deliberately does not distinguish them, and neither may
    // the console.
    errorMessage: "Issue not found, or not available to your role.",
  });
  const { data: candidates } = useAdminResource<DuplicateCandidates>(
    `/v1/admin/issues/${encodeURIComponent(id)}/duplicate-candidates`,
    { enabled: id.length > 0, pollMs: 0, errorMessage: "Duplicate suggestions are unavailable." }
  );
  const [busy, setBusy] = useState<string | null>(null);

  // Derived, not synced: null means "follow the server". Mirroring the server
  // value into state from an effect would fight every refetch and re-render.
  const [severityDraft, setSeverityDraft] = useState<IssueSeverity | "" | null>(null);
  const severity = severityDraft ?? issue?.severity ?? "";
  const [question, setQuestion] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [resolutionRef, setResolutionRef] = useState("");
  const [pendingStatus, setPendingStatus] = useState<IssueStatus | null>(null);
  const [canonicalId, setCanonicalId] = useState("");

  /** Wraps every mutation: single-flight per action, 409 handling, and a
   * refetch so the rendered state always came from the server. */
  async function run(action: string, fn: () => Promise<unknown>, successMessage: string) {
    if (busy) return;
    setBusy(action);
    try {
      await fn();
      pushToast({ variant: "success", title: successMessage });
      await load();
    } catch (err) {
      if (err instanceof IssueConflictError) {
        pushToast({ variant: "error", title: "Someone else changed this issue", body: `${err.message} Reloaded with the current state — reapply if still needed.` });
        await load();
      } else {
        pushToast({ variant: "error", title: "That action failed", body: err instanceof Error ? err.message : undefined });
      }
    } finally {
      setBusy(null);
    }
  }

  // The no-id branch must come first: with no ?id= the resource is disabled, so
  // `loading` never flips back to false and a leading loading-guard would spin
  // on "Loading issue…" forever instead of reaching the message below.
  if (id && loading && !issue) return <AdminLoadingState label="Loading issue…" />;

  if (!id) {
    return (
      <div className="space-y-4">
        <AdminPageHeader eyebrow="Operations" title="Agent issue" />
        <AdminErrorBanner message="No issue id was supplied." />
        <Link
          href="/issues"
          className="inline-flex min-h-[24px] items-center px-1 py-1 font-mono text-[11px] text-lime hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/60"
        >
          ← Back to the queue
        </Link>
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="space-y-4">
        <AdminPageHeader eyebrow="Operations" title="Agent issue" />
        <AdminErrorBanner message={error || "This issue is unavailable."} onRetry={() => void load()} />
        <Link
          href="/issues"
          className="inline-flex min-h-[24px] items-center px-1 py-1 font-mono text-[11px] text-lime hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/60"
        >
          ← Back to the queue
        </Link>
      </div>
    );
  }

  const terminal = isTerminal(issue.status);
  const reporterEvents = issue.events.filter((e) => !e.internalOnly);
  const internalEvents = issue.events.filter((e) => e.internalOnly);

  return (
    <div className="space-y-5">
      <AdminPageHeader
        eyebrow="Operations · Agent issues"
        title={issue.summary}
        sub={`${ISSUE_CATEGORY_LABELS[issue.category]} · reported ${new Date(issue.createdAt).toISOString().slice(0, 10)} · v${issue.version}`}
        actions={
          <Link
            href="/issues"
            // min-h/px keeps this above the 24px minimum tap target at 375px;
            // it was 54×17 and failed the target-size check on mobile.
            className="inline-flex min-h-[24px] items-center px-1 py-1 font-mono text-[11px] text-lime hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/60"
          >
            ← Queue
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <AdminPill tone={statusTone(issue.status)}>{ISSUE_STATUS_LABELS[issue.status]}</AdminPill>
        <AdminPill tone={impactTone(issue.impact)}>{ISSUE_IMPACT_LABELS[issue.impact]}</AdminPill>
        <AdminPill tone={severityTone(issue.severity)}>{issue.severity ?? "severity unset"}</AdminPill>
        <AdminPill tone="neutral">{issue.reporterLabel}</AdminPill>
        <AdminPill tone="neutral">{issue.source}</AdminPill>
        {issue.redactionApplied && (
          // Stated, not hidden: staff must know the excerpt they are reading
          // was scrubbed, so a missing detail is not read as the agent's fault.
          <AdminPill tone="warning">secrets redacted before storage</AdminPill>
        )}
      </div>

      {issue.contextCollection !== "complete" && (
        <div className="rounded-[10px] border border-dark-warn-border bg-amber-400/5 px-3.5 py-3 text-[12px] text-amber-300">
          <strong className="font-mono text-[11px] uppercase tracking-[0.06em]">Context {issue.contextCollection}</strong>
          <div className="mt-1 text-dark-soft">
            {issue.contextCollection === "pending"
              ? "The case is saved and evidence collection is still queued. Nothing below has been resolved yet — this is not a finding that no resources were involved."
              : issue.contextCollection === "unavailable"
                ? "Evidence collection failed for this case. The report itself is intact; the context block below is empty because the collector could not run, not because there was nothing to collect."
                : "The case was saved, but at least one resource the reporter named could not be resolved or was not theirs to reference. Treat the context block below as incomplete — not as evidence that nothing else was involved."}
          </div>
        </div>
      )}

      <section>
        <AdminSectionHeading title="Report" sub="Exactly what the agent submitted, after redaction." />
        <dl className="space-y-3 rounded-[10px] border border-dark-line bg-dark-card p-4">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">Expected</dt>
            {/* Untrusted reporter text: rendered as text, never as HTML. */}
            <dd className="mt-1 whitespace-pre-wrap break-words text-[13px] text-dark-text">{issue.expected}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">Actual</dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-[13px] text-dark-text">{issue.actual}</dd>
          </div>
          {issue.steps && (
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">Steps</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-[13px] text-dark-soft">{issue.steps}</dd>
            </div>
          )}
          {issue.logExcerpt && (
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">Log excerpt</dt>
              <dd className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-dark-bg p-2.5 font-mono text-[11px] text-dark-soft">
                {issue.logExcerpt}
              </dd>
            </div>
          )}
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">Server-collected context</dt>
            <dd className="mt-1 overflow-x-auto rounded-[8px] bg-dark-bg p-2.5 font-mono text-[11px] text-dark-soft">
              {issue.context && Object.keys(issue.context).length > 0 ? (
                <pre className="whitespace-pre-wrap break-words">{JSON.stringify(issue.context, null, 2)}</pre>
              ) : (
                "No linked resources were resolved for this report."
              )}
            </dd>
          </div>
        </dl>
      </section>

      {issue.canonicalIssueId && (
        <div className="rounded-[10px] border border-dark-line bg-dark-card px-3.5 py-3 text-[12px] text-dark-soft">
          Merged as a duplicate of{" "}
          <Link href={`/issues/view?id=${encodeURIComponent(issue.canonicalIssueId)}`} className="text-lime hover:underline">
            {issue.canonicalIssueId}
          </Link>
          . This child report stays readable by its own reporter and is not resolved separately.
        </div>
      )}

      {terminal ? (
        <section>
          <AdminSectionHeading
            title="Closed"
            sub="A closed case is never reopened. If the problem recurs, the reporter files a new one."
          />
          <div className="rounded-[10px] border border-dark-line bg-dark-card p-4 text-[13px] text-dark-text">
            <div className="whitespace-pre-wrap break-words">{issue.resolutionNote ?? "No explanation was recorded."}</div>
            {issue.resolutionRef && (
              <div className="mt-2 font-mono text-[11px] text-dark-dim">Reference: {issue.resolutionRef}</div>
            )}
          </div>
        </section>
      ) : canAct ? (
        <section className="space-y-4">
          <AdminSectionHeading title="Actions" sub="Every action records who did it and why." />

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-[10px] border border-dark-line bg-dark-card p-4">
              <label htmlFor="issue-severity" className="font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
                Severity &amp; ownership
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  id="issue-severity"
                  className={inputClass + " max-w-[160px]"}
                  value={severity}
                  onChange={(e) => setSeverityDraft(e.target.value as IssueSeverity | "")}
                >
                  <option value="">Set severity…</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <AdminButton
                  variant="ghost"
                  disabled={!severity || busy !== null}
                  onClick={() =>
                    void run(
                      "severity",
                      () => assignIssue(issue.id, { expectedVersion: issue.version, severity: severity || null }),
                      "Severity updated."
                    ).then(() => setSeverityDraft(null))
                  }
                >
                  {busy === "severity" ? "Saving…" : "Save severity"}
                </AdminButton>
                <AdminButton
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      "assign",
                      () => assignIssue(issue.id, { expectedVersion: issue.version, assignedToUserId: null }),
                      "Assignment cleared."
                    )
                  }
                >
                  Clear owner
                </AdminButton>
              </div>
              <p className="mt-2 text-[11px] text-dark-dim">
                Currently {issue.assignedToUserId ? `assigned to ${issue.assignedToUserId}` : "unassigned"}.
              </p>
            </div>

            <div className="rounded-[10px] border border-dark-line bg-dark-card p-4">
              <label htmlFor="issue-question" className="font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
                Ask the reporter
              </label>
              <textarea
                id="issue-question"
                className={inputClass + " mt-2 min-h-[64px]"}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What extra detail do you need to reproduce this?"
              />
              <div className="mt-2">
                <AdminButton
                  variant="ghost"
                  disabled={question.trim().length < 5 || busy !== null}
                  onClick={() =>
                    void run(
                      "request-info",
                      () => requestIssueInfo(issue.id, { expectedVersion: issue.version, question: question.trim() }),
                      "Question sent to the reporter."
                    ).then(() => setQuestion(""))
                  }
                >
                  {busy === "request-info" ? "Sending…" : "Request more info"}
                </AdminButton>
              </div>
            </div>
          </div>

          <div className="rounded-[10px] border border-dark-line bg-dark-card p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">Disposition</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {DISPOSITIONS.filter((d) => d.value !== issue.status).map((d) => (
                <AdminButton
                  key={d.value}
                  variant={requiresReason(d.value) ? "primary" : "ghost"}
                  disabled={busy !== null}
                  onClick={() => {
                    setPendingStatus(d.value);
                    setReason("");
                    setResolutionRef("");
                  }}
                >
                  {d.label}
                </AdminButton>
              ))}
              {isAdmin && (
                <AdminButton variant="ghost" disabled={busy !== null} onClick={() => setPendingStatus("duplicate")}>
                  Merge as duplicate
                </AdminButton>
              )}
            </div>
            {!isAdmin && (
              <p className="mt-2 text-[11px] text-dark-dim">Merging duplicates requires the admin role.</p>
            )}
          </div>

          <div className="rounded-[10px] border border-dark-line bg-dark-card p-4">
            <label htmlFor="issue-note" className="font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
              Internal note (never shown to the reporter)
            </label>
            <textarea
              id="issue-note"
              className={inputClass + " mt-2 min-h-[56px]"}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="mt-2">
              <AdminButton
                variant="ghost"
                disabled={note.trim().length < 2 || busy !== null}
                onClick={() => void run("note", () => addIssueNote(issue.id, note.trim()), "Note saved.").then(() => setNote(""))}
              >
                {busy === "note" ? "Saving…" : "Add note"}
              </AdminButton>
            </div>
          </div>
        </section>
      ) : (
        <div className="rounded-[10px] border border-dark-line bg-dark-card px-3.5 py-3 text-[12px] text-dark-soft">
          Your role can read this queue but not act on it. Triage requires the member or admin role.
        </div>
      )}

      <section>
        <AdminSectionHeading title="Reporter-visible timeline" sub="Exactly what the reporting agent can see." />
        <ol className="space-y-2">
          {reporterEvents.length === 0 ? (
            <AdminEmptyState message="No reporter-visible events yet." />
          ) : (
            reporterEvents.map((event) => (
              <li key={event.id} className="rounded-[10px] border border-dark-line bg-dark-card px-3.5 py-2.5">
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
                  <span>{event.type.replace(/_/g, " ")}</span>
                  <span>·</span>
                  <span>{event.actorRole}</span>
                  <span>·</span>
                  <AdminDateTime iso={event.createdAt} />
                </div>
                {event.body && (
                  <div className="mt-1 whitespace-pre-wrap break-words text-[13px] text-dark-text">{event.body}</div>
                )}
              </li>
            ))
          )}
        </ol>
      </section>

      <section>
        <AdminSectionHeading title="Internal notes" sub="Staff only. Never part of the reporter projection." />
        <ol className="space-y-2">
          {internalEvents.length === 0 ? (
            <AdminEmptyState message="No internal notes." />
          ) : (
            internalEvents.map((event) => (
              <li key={event.id} className="rounded-[10px] border border-dark-line-soft bg-dark-bg px-3.5 py-2.5">
                <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
                  {event.type.replace(/_/g, " ")} · {event.actorRole} · <AdminDateTime iso={event.createdAt} />
                </div>
                {event.body && (
                  <div className="mt-1 whitespace-pre-wrap break-words text-[13px] text-dark-soft">{event.body}</div>
                )}
              </li>
            ))
          )}
        </ol>
      </section>

      <section>
        <AdminSectionHeading
          title="Similar reports"
          sub="Advisory only — a fingerprint match is a hint, never an automatic merge."
        />
        {candidates && candidates.candidates.length > 0 ? (
          <ul className="space-y-2">
            {candidates.candidates.map((c) => (
              <li key={c.id} className="rounded-[10px] border border-dark-line bg-dark-card px-3.5 py-2.5 text-[13px]">
                <Link href={`/issues/view?id=${encodeURIComponent(c.id)}`} className="text-lime hover:underline">
                  {c.summary}
                </Link>
                <div className="mt-0.5 font-mono text-[10px] text-dark-dim">
                  {ISSUE_STATUS_LABELS[c.status]} · {c.reporterLabel} · <AdminDateTime iso={c.createdAt} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <AdminEmptyState message="No similar reports suggested." />
        )}
      </section>

      <AdminConfirmDialog
        open={pendingStatus !== null}
        title={pendingStatus === "duplicate" ? "Merge as duplicate" : `Mark ${pendingStatus ? ISSUE_STATUS_LABELS[pendingStatus] : ""}`}
        confirmLabel={busy ? "Working…" : "Confirm"}
        busy={busy === "status"}
        danger={pendingStatus ? requiresReason(pendingStatus) : false}
        confirmDisabled={
          pendingStatus
            ? (requiresReason(pendingStatus) && reason.trim().length < 3) ||
              (pendingStatus === "duplicate" && canonicalId.trim().length === 0)
            : true
        }
        description={
          <div className="space-y-2 text-left">
            {pendingStatus && requiresReason(pendingStatus) && (
              <>
                <label htmlFor="issue-reason" className="block font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
                  Reason (shown to the reporter — required)
                </label>
                <textarea
                  id="issue-reason"
                  className={inputClass + " min-h-[64px]"}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </>
            )}
            {pendingStatus === "duplicate" && (
              <>
                <label htmlFor="issue-canonical" className="block font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
                  Canonical issue id (required)
                </label>
                <input
                  id="issue-canonical"
                  className={inputClass}
                  value={canonicalId}
                  onChange={(e) => setCanonicalId(e.target.value)}
                />
              </>
            )}
            {pendingStatus === "resolved" && (
              <>
                <label htmlFor="issue-ref" className="block font-mono text-[10px] uppercase tracking-[0.06em] text-dark-dim">
                  Deploy / PR / bug reference (optional)
                </label>
                <input id="issue-ref" className={inputClass} value={resolutionRef} onChange={(e) => setResolutionRef(e.target.value)} />
              </>
            )}
          </div>
        }
        onCancel={() => setPendingStatus(null)}
        onConfirm={() => {
          if (!pendingStatus) return;
          const target = pendingStatus;
          void run(
            "status",
            () =>
              setIssueStatus(issue.id, {
                expectedVersion: issue.version,
                status: target,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
                ...(resolutionRef.trim() ? { resolutionRef: resolutionRef.trim() } : {}),
                ...(target === "duplicate" ? { canonicalIssueId: canonicalId.trim() } : {}),
              }),
            `Issue marked ${ISSUE_STATUS_LABELS[target].toLowerCase()}.`
          ).then(() => {
            setPendingStatus(null);
            setReason("");
            setCanonicalId("");
            setResolutionRef("");
          });
        }}
      />
    </div>
  );
}
