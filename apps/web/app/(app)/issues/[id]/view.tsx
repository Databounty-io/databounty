"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/icons";
import { AsyncState, Button, CopyButton, DetailHeader, KV, Pill } from "@/components/ui";
import { useDemo } from "@/lib/store";
import {
  ISSUE_CATEGORY_LABELS,
  ISSUE_IMPACT_LABELS,
  ISSUE_STATUS_LABELS,
  contextCollectionLabel,
  fetchMyIssue,
  humanizeGuidance,
  isIssueClosed,
  issueEventLabel,
  issueImpactTone,
  issueStatusTone,
  needsReporterAnswer,
  replyToIssue,
  type IssueDetail,
} from "@/lib/agent-issues";

const REPLY_MAX = 2000;

function absTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Deep-links to the specific named resource, not just the workspace root.
// Kinds come from the server's `collectContext` (bounty, submission,
// auditBatch, contributorBatch, datasetType — see
// docs/engineering/AGENT_ISSUES_CHANNEL_PLAN.md). Every branch here is a real
// route verified against its page file:
//   - bounty        -> /sponsor/[id] (paid) or /contributor/pool/[bountyId]
//                      (community open pool), keyed by `bountyKind`
//   - submission     -> /contributor/submissions/[id] (getSubmission(id))
//   - auditBatch     -> /validator/audit/[id] (getAuditDetail(id))
// `contributorBatch` and `datasetType` have no per-resource detail page
// anywhere in this app (only list/workspace views), so they fall through to
// `null` rather than link to a page that isn't about this specific resource.
function resourceHref(resource: { kind: string; id: string; [key: string]: unknown }): string | null {
  switch (resource.kind) {
    case "submission":
      return `/contributor/submissions/${encodeURIComponent(resource.id)}`;
    case "bounty":
      // No paid/community branch: V1 keyed this off `bountyKind`, which the
      // API deliberately no longer emits — every bounty in this product is a
      // community pool (AGENTS.md §1 / D18), so the paid `/sponsor/{id}`
      // destination would have been wrong for every case that reached it.
      return `/contributor/pool/${encodeURIComponent(resource.id)}`;
    // `audit_window` is what the API emits; `auditBatch`/`audit` are V1's
    // names for the same thing and are kept so an older stored snapshot still
    // links instead of rendering as bare text.
    case "audit_window":
    case "auditBatch":
    case "audit":
      return `/validator/audit/${encodeURIComponent(resource.id)}`;
    default:
      return null;
  }
}

export default function IssueDetailView({ issueId }: { issueId?: string } = {}) {
  const params = useParams<{ id: string }>();
  const routeId = typeof params?.id === "string" ? params.id : "";
  const id = issueId ?? routeId;
  const embedded = Boolean(issueId);
  const { pushToast } = useDemo();

  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [state, setState] = useState<"loading" | "error" | "missing" | "ready">("loading");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const invalidId = !id || id === "placeholder";

  useEffect(() => {
    if (invalidId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setState("loading");
    }, 0);

    void fetchMyIssue(id)
      .then((data) => {
        if (cancelled) return;
        setIssue(data);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const notFound = Boolean(err && typeof err === "object" && "status" in err && err.status === 404);
        setState(notFound ? "missing" : "error");
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, invalidId, reloadToken]);

  async function send() {
    const body = reply.trim();
    if (body.length < 2 || sending) return;
    setSending(true);
    const result = await replyToIssue(id, body);
    setSending(false);
    if (result.ok) {
      setReply("");
      pushToast({ variant: "success", title: "Reply sent" });
      setReloadToken((token) => token + 1);
      return;
    }
    pushToast({ variant: "error", title: "Couldn't send your reply", body: result.error });
    if (result.closed) setReloadToken((token) => token + 1);
  }

  if (invalidId || state === "missing") {
    return (
      <>
        <DetailHeader backHref={embedded ? undefined : "/issues"} backLabel={embedded ? undefined : "Support cases"} title="Case not found" />
        <div className="card px-6 py-10 text-center text-sm text-ink-soft">
          <p>This case does not exist, or it was filed by a different account.</p>
          <p className="mt-2">
            <Link href="/issues" className="text-ink underline">
              Back to your support cases
            </Link>
          </p>
        </div>
      </>
    );
  }

  if (state !== "ready" || !issue) {
    return (
      <>
        <DetailHeader backHref={embedded ? undefined : "/issues"} backLabel={embedded ? undefined : "Support cases"} title="Support case" />
        <AsyncState
          status={state === "error" ? "error" : "loading"}
          loadingText="Loading this support case…"
          errorTitle="Could not load this case"
          errorDescription="The support service did not respond. Refresh to try again."
        />
      </>
    );
  }

  const closed = isIssueClosed(issue.status);
  const context = contextCollectionLabel(issue.contextCollection);

  return (
    <>
      <DetailHeader
        backHref={embedded ? undefined : "/issues"}
        backLabel={embedded ? undefined : "Support cases"}
        title={issue.summary}
        meta={
          <>
            <Pill tone={issueStatusTone(issue.status)}>{ISSUE_STATUS_LABELS[issue.status]}</Pill>
            <Pill tone={issueImpactTone(issue.impact)}>{ISSUE_IMPACT_LABELS[issue.impact]}</Pill>
            <Pill>{ISSUE_CATEGORY_LABELS[issue.category]}</Pill>
            <Pill tone={context.tone}>{context.label}</Pill>
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-faint">
              {issue.id}
              <CopyButton value={issue.id} label="case id" iconOnly />
            </span>
          </>
        }
      />

      <div
        className={`mb-5 flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[13px] leading-relaxed ${
          needsReporterAnswer(issue.status)
            ? "border-amber-200 bg-amber-50 text-amber-800"
            : "border-line bg-panel text-ink-soft"
        }`}
      >
        <Icon name={needsReporterAnswer(issue.status) ? "alert" : "info"} size={15} className="mt-0.5 shrink-0" />
        <p>{humanizeGuidance(issue.guidance)}</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-5">
          <section className="card p-5">
            <h2 className="mb-3 font-mono text-[13px] font-bold uppercase tracking-[0.06em]">What you reported</h2>
            <dl className="flex flex-col gap-3 text-[13.5px] leading-relaxed">
              <div>
                <dt className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-faint">Expected</dt>
                <dd className="mt-1 whitespace-pre-wrap break-words text-ink">{issue.expected}</dd>
              </div>
              <div>
                <dt className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-faint">Actual</dt>
                <dd className="mt-1 whitespace-pre-wrap break-words text-ink">{issue.actual}</dd>
              </div>
              {issue.steps && (
                <div>
                  <dt className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-faint">Steps</dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words text-ink">{issue.steps}</dd>
                </div>
              )}
            </dl>
          </section>

          {closed && (issue.resolutionNote || issue.resolutionRef) && (
            <section className="card p-5">
              <h2 className="mb-3 font-mono text-[13px] font-bold uppercase tracking-[0.06em]">Outcome</h2>
              {issue.resolutionNote && (
                <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink">{issue.resolutionNote}</p>
              )}
              {issue.resolutionRef && (
                <p className="mt-2 font-mono text-[11.5px] text-ink-soft">Fix reference: {issue.resolutionRef}</p>
              )}
              {issue.resolvedAt && (
                <p className="mt-2 font-mono text-[11px] text-ink-faint">Closed {absTime(issue.resolvedAt)}</p>
              )}
            </section>
          )}

          {issue.mergedOutcome && (
            <section className="card p-5">
              <h2 className="mb-1 font-mono text-[13px] font-bold uppercase tracking-[0.06em]">
                Outcome of the case yours was merged into
              </h2>
              <p className="mb-3 flex items-center gap-2 text-[12px] text-ink-soft">
                <Pill tone={issueStatusTone(issue.mergedOutcome.status)}>
                  {ISSUE_STATUS_LABELS[issue.mergedOutcome.status]}
                </Pill>
                <span>Your report was counted toward it.</span>
              </p>
              {issue.mergedOutcome.resolutionNote && (
                <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink">
                  {issue.mergedOutcome.resolutionNote}
                </p>
              )}
              {issue.mergedOutcome.resolutionRef && (
                <p className="mt-2 font-mono text-[11.5px] text-ink-soft">
                  Fix reference: {issue.mergedOutcome.resolutionRef}
                </p>
              )}
              {issue.mergedOutcome.resolvedAt && (
                <p className="mt-2 font-mono text-[11px] text-ink-faint">
                  Closed {absTime(issue.mergedOutcome.resolvedAt)}
                </p>
              )}
            </section>
          )}

          <section className="card p-5">
            <h2 className="mb-3 font-mono text-[13px] font-bold uppercase tracking-[0.06em]">History</h2>
            {issue.events.length === 0 ? (
              <p className="text-[13px] text-ink-soft">No activity on this case yet.</p>
            ) : (
              <ol className="flex flex-col gap-3.5">
                {issue.events.map((event) => (
                  <li key={event.id} className="border-l-2 border-line pl-3.5">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[13px] font-semibold text-ink">{issueEventLabel(event.type)}</span>
                      <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-faint">
                        {event.actorRole === "reporter" ? "you" : event.actorRole}
                      </span>
                      <span className="font-mono text-[10.5px] text-ink-faint">{absTime(event.createdAt)}</span>
                    </div>
                    {event.body && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-soft">{event.body}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="card p-5">
            <h2 className="mb-1 font-mono text-[13px] font-bold uppercase tracking-[0.06em]">
              {closed ? "This case is closed" : "Add a reply"}
            </h2>
            {closed ? (
              <p className="text-[13px] leading-relaxed text-ink-soft">
                Closed cases accept no further replies. If the problem is still happening, file a new report and
                reference <span className="font-mono text-[12px] text-ink">{issue.id}</span>.
              </p>
            ) : (
              <>
                <p className="mb-3 text-[13px] leading-relaxed text-ink-soft">
                  {needsReporterAnswer(issue.status)
                    ? "Answer the question above — this case is waiting on you."
                    : "A smaller or more reliable reproduction is the single most useful thing you can add."}
                </p>
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value.slice(0, REPLY_MAX))}
                  rows={4}
                  maxLength={REPLY_MAX}
                  aria-label="Your reply"
                  placeholder="What you tried, what you saw, and the exact inputs if you have them."
                  className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-[13.5px] leading-relaxed text-ink focus:border-ink focus:outline-none"
                />
                <div className="mt-2.5 flex items-center justify-between gap-3">
                  <span className="font-mono text-[10.5px] text-ink-faint">
                    {reply.trim().length}/{REPLY_MAX}
                  </span>
                  <Button size="sm" onClick={send} disabled={sending || reply.trim().length < 2}>
                    {sending ? "Sending…" : "Send reply"}
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-5">
          <section className="card p-5">
            <h2 className="mb-3 font-mono text-[13px] font-bold uppercase tracking-[0.06em]">Case</h2>
            <div className="flex flex-col gap-2">
              <KV label="Filed" value={absTime(issue.createdAt)} />
              <KV label="Last update" value={absTime(issue.updatedAt)} />
              <KV
                label="Also reported by"
                value={
                  issue.alsoReportedBy > 0
                    ? `${issue.alsoReportedBy} other report${issue.alsoReportedBy === 1 ? "" : "s"}`
                    : "No one else yet"
                }
              />
              {issue.canonicalIssueId && (
                <KV label="Merged into" value={<span className="font-mono text-[12px]">{issue.canonicalIssueId}</span>} />
              )}
            </div>
          </section>

          <section className="card p-5">
            <h2 className="mb-1 font-mono text-[13px] font-bold uppercase tracking-[0.06em]">What it is about</h2>
            <p className="mb-3 text-[12px] leading-relaxed text-ink-soft">
              Resources the server confirmed from what you named — ids only.
            </p>
            {issue.resources.length === 0 && issue.unresolvedIds.length === 0 ? (
              <p className="text-[13px] text-ink-soft">No resources were named on this case.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {issue.resources.map((resource) => {
                  const href = resourceHref(resource);
                  return (
                    <li key={`${resource.kind}:${resource.id}`} className="text-[13px]">
                      <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-faint">
                        {resource.kind}
                      </span>
                      <div className="mt-0.5">
                        {href ? (
                          <Link href={href} className="font-mono text-[12px] text-ink underline">
                            {resource.id}
                          </Link>
                        ) : (
                          <span className="font-mono text-[12px] text-ink">{resource.id}</span>
                        )}
                        {resource.status && (
                          <span className="ml-2 font-mono text-[11px] text-ink-soft">{String(resource.status)}</span>
                        )}
                      </div>
                    </li>
                  );
                })}
                {issue.unresolvedIds.map((unresolved) => (
                  <li key={`unresolved:${unresolved}`} className="text-[13px]">
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-faint">
                      not confirmed
                    </span>
                    <div className="mt-0.5 font-mono text-[12px] text-ink-soft">{unresolved}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-5">
            <h2 className="mb-2 font-mono text-[13px] font-bold uppercase tracking-[0.06em]">A case is not a dispute</h2>
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              Nothing on this page changes a submission, audit, or karma. If an item of yours was rejected,{" "}
              <Link href="/contributor" className="text-ink underline">
                revise or dispute it
              </Link>{" "}
              — those are the only paths that can change an outcome.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
