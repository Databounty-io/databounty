"use client";

// SPDX-License-Identifier: Apache-2.0

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useDemo, authedFetch, safeMessage } from "@/lib/store";
import { useDebouncedValue, useLatestRequest } from "@/lib/use-list-search";
import { API } from "@/lib/api-endpoints";
import type { Bounty, SubmissionStatus } from "@/lib/types";
import { apiToBounty } from "@/lib/api-bounty";
import { type ApiValidationResult } from "@/lib/api-work";
import { AutoRefreshControl } from "@/components/auto-refresh";
import {
  BountyStatusPill,
  BackLink,
  Button,
  ConfirmDialog,
  AsyncState,
  Empty,
  Modal,
  PillTabs,
  Pagination,
  SearchField,
  Select,
  SubmissionStatusPill,
  Table,
  Td,
} from "@/components/ui";
import { SponsorReferenceManager } from "@/components/artifacts";
import { StatRail, type StatCell } from "@/components/workspace";
import { pct, karmaPerItemLabel } from "@/lib/format";
import {
  RequestReviewConversation,
  RequestSpecGrid,
  ReviewerNote,
  type RequestSpec,
} from "@/components/community-request-blocks";
import { communityLicenseLabel } from "@/components/dataset-request-detail";
import { LifecyclePhases, type CommunityLifecycle } from "@/components/lifecycle-phases";
import { PublicationStatus } from "@/components/publication-status";
import { parseDatasetPublication } from "@/lib/publication";

type CommunityRequestBlock = RequestSpec & { id: string; status: string };

type SponsorSubmission = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  flags?: Array<{ reason: string; details: string | null; status: string }>;
  payloadJson?: Record<string, unknown> | null;
  generationMethod?: string;
  duplicateScore?: number | null;
  llmScore?: number | null;
  validationResults?: ApiValidationResult[];
  /** ISO timestamp, or null. Set only for `accepted` submissions — mirrors
   * the server's own hold-window anchor (services/karma-holds.ts
   * `holdReleasesAt`), which is what `POST /submissions/:id/dispute-acceptance`
   * actually enforces. UX only; the server remains the source of truth. */
  disputeWindowClosesAt?: string | null;
};

type SponsorSubmissionPage = {
  submissions: SponsorSubmission[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const SUBMISSION_PAGE_SIZE = 10;
const REJECT_NOTE_MIN = 10;

const DISPUTE_REASONS = [
  { value: "solution_incorrect", label: "Solution incorrect" },
  { value: "tests_invalid", label: "Tests invalid" },
  { value: "duplicate", label: "Duplicate or near-duplicate" },
  { value: "contaminated", label: "Contaminated against a public benchmark" },
  { value: "too_trivial", label: "Too trivial" },
  { value: "low_quality", label: "Low quality" },
  { value: "off_spec", label: "Doesn't match the dataset spec" },
] as const;

const SECTIONS = [
  { key: "overview" as const, label: "Overview" },
  { key: "submissions" as const, label: "Submissions" },
  { key: "delivery" as const, label: "Delivery" },
];
type Section = (typeof SECTIONS)[number]["key"];

export function SponsorProgramView() {
  const params = useParams();
  const id = params?.id as string;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { pushToast } = useDemo();

  const [bounty, setBounty] = useState<Bounty | null>(null);
  const [communityRequest, setCommunityRequest] = useState<CommunityRequestBlock | null>(null);
  const [lifecycle, setLifecycle] = useState<CommunityLifecycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // `Date.now()` is impure and may not be read during render (react-hooks/purity).
  // Measured once on mount and refreshed on a coarse tick — the dispute window is
  // measured in days, so a minute of staleness on the button's visibility is fine.
  // Null (before the first tick) hides the dispute button rather than guessing.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    // First clock read runs from the effect body (subscription setup), same
    // pattern as lib/use-expiry-countdown.ts — never read Date.now() during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const sectionParam = searchParams?.get("section");
  const section: Section =
    sectionParam === "submissions" || sectionParam === "delivery"
      ? sectionParam
      : "overview";

  const setSection = (s: Section) => {
    const q = new URLSearchParams(searchParams?.toString() ?? "");
    if (s === "overview") q.delete("section");
    else q.set("section", s);
    router.replace(`/sponsor/${id}?${q.toString()}`, { scroll: false });
  };

  const [submissionsData, setSubmissionsData] = useState<SponsorSubmissionPage>({
    submissions: [],
    total: 0,
    page: 1,
    pageSize: SUBMISSION_PAGE_SIZE,
    totalPages: 1,
  });
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [submissionSearch, setSubmissionSearch] = useState("");
  // Debounced before it becomes a query, and sequence-guarded on assignment —
  // this list is paged AND filtered, so an out-of-order response repaints it
  // with rows that do not match the controls above.
  const debouncedSubmissionSearch = useDebouncedValue(submissionSearch);
  const beginSubmissionsRequest = useLatestRequest();
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  // Bumped to force SponsorReferenceManager's own artifact list to reload
  // after an upload/approval changes the count — mirrors v1's `setReload`.
  const [reload, setReload] = useState(0);

  const [actingSubmission, setActingSubmission] = useState<SponsorSubmission | null>(null);
  const [actionType, setActionType] = useState<"accept" | "reject" | "dispute" | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [disputeReason, setDisputeReason] = useState<string>(DISPUTE_REASONS[0].value);
  const [disputeArgument, setDisputeArgument] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  const fetchProgram = useCallback(async () => {
    if (!id) return;
    try {
      const res = await authedFetch(API.bounties.one(id));
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = (await res.json()) as {
        bounty: Record<string, unknown>;
        communityRequest?: CommunityRequestBlock | null;
        communityLifecycle?: CommunityLifecycle | null;
      };
      setBounty(apiToBounty(data.bounty));
      setCommunityRequest(data.communityRequest ?? null);
      setLifecycle(data.communityLifecycle ?? null);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchSubmissions = useCallback(async () => {
    if (!id) return;
    const isStale = beginSubmissionsRequest();
    setSubmissionsLoading(true);
    try {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(SUBMISSION_PAGE_SIZE),
      });
      if (statusFilter !== "all") query.set("status", statusFilter);
      if (debouncedSubmissionSearch) query.set("search", debouncedSubmissionSearch);

      const res = await authedFetch(`${API.bounties.submissions(id)}?${query.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as SponsorSubmissionPage;
      if (isStale()) return;
      setSubmissionsData(data);
    } finally {
      if (!isStale()) setSubmissionsLoading(false);
    }
  }, [id, page, statusFilter, debouncedSubmissionSearch, beginSubmissionsRequest]);

  useEffect(() => {
    // One-shot data load on mount/id change, not a React-state sync.
    // `reload` is bumped by SponsorReferenceManager's `onChanged` so an
    // uploaded/approved reference example refreshes `approvedSponsorExamples`
    // on the bounty without a manual page refresh.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchProgram();
  }, [fetchProgram, reload]);

  useEffect(() => {
    if (section === "submissions") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchSubmissions();
    }
  }, [section, fetchSubmissions]);

  const handleReviewAction = async () => {
    if (!actingSubmission || !actionType || !bounty) return;
    setActionBusy(true);
    try {
      if (actionType === "accept" || actionType === "reject") {
        if (actionType === "reject" && rejectNote.trim().length < REJECT_NOTE_MIN) {
          pushToast({
            variant: "error",
            title: "Rejection note required",
            body: `Please provide at least ${REJECT_NOTE_MIN} characters explaining the rejection to the contributor.`,
          });
          return;
        }

        const res = await authedFetch(API.bounties.sponsorReview(bounty.id, actingSubmission.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision: actionType,
            note: actionType === "reject" ? rejectNote.trim() : undefined,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(safeMessage(err.message, "Review action failed"));
        }

        pushToast({
          variant: "success",
          title: actionType === "accept" ? "Submission accepted" : "Submission rejected",
          body: actionType === "accept" ? "Karma awarded to contributor." : "Sent back with your note.",
        });
      } else if (actionType === "dispute") {
        if (!disputeArgument.trim()) {
          pushToast({
            variant: "error",
            title: "Dispute argument required",
            body: "Please describe why this item requires reviewer dispute escalation.",
          });
          return;
        }

        // The sponsor disputes an ALREADY-ACCEPTED item — a distinct, sponsor-
        // owned endpoint from the contributor's own-rejection `/dispute`
        // route (that one 404s/403s for a sponsor: it's scoped to the
        // contributor who filed the submission).
        const res = await authedFetch(API.submissions.disputeAcceptance(actingSubmission.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: disputeReason,
            argument: disputeArgument.trim(),
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(safeMessage(err.message, "Dispute submission failed"));
        }

        pushToast({
          variant: "success",
          title: "Dispute filed",
        });
      }

      setActingSubmission(null);
      setActionType(null);
      setRejectNote("");
      setDisputeArgument("");
      await fetchSubmissions();
      await fetchProgram();
    } catch (err) {
      // The throw sites above already resolve a real server message via
      // safeMessage() before throwing — surface it here instead of a bare
      // "Action failed" toast that discards the specific reason.
      pushToast({
        variant: "error",
        title: "Action failed",
        body: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setActionBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <BackLink href="/sponsor">Back to sponsor</BackLink>
        <div className="card p-8 text-center text-ink-soft">Loading program details…</div>
      </div>
    );
  }

  if (error || !bounty) {
    return (
      <div className="space-y-4">
        <BackLink href="/sponsor">Back to sponsor</BackLink>
        <AsyncState
          status="error"
          errorTitle="Could not find program"
          errorDescription="The program requested does not exist or you do not have permission to view it."
        />
      </div>
    );
  }

  const publication = parseDatasetPublication(bounty.communityPublication);
  const requiredExamples = bounty.requiredSponsorExamples ?? 0;
  const approvedExamples = bounty.approvedSponsorExamples ?? 0;
  // v1 gates this on `isCommunity || (!pilotFunded && !fullFunded)` — every
  // pool in this tree IS a community pool (D18: no paid/funded track), so the
  // condition collapses to just `requiredExamples > 0`. Matches v1: the panel
  // stays visible even once every example is approved, since for community it
  // doubles as the durable "brief contributors build against", not just a
  // pre-mint blocker.
  const needsSponsorExamples = requiredExamples > 0;
  const accepted = bounty.acceptedItems ?? 0;
  const target = bounty.targetItems ?? 0;
  const pctAccepted = target > 0 ? Math.round((accepted / target) * 100) : 0;

  const statCells: StatCell[] = [
    {
      label: "accepted items",
      value: `${accepted.toLocaleString()} / ${target.toLocaleString()}`,
      sub: `${pctAccepted}% complete`,
      tone: "accepted",
      icon: "check",
    },
    {
      label: "in pipeline",
      value: bounty.submittedItems ?? 0,
      icon: "upload",
    },
    {
      label: "needs fixes",
      value: bounty.needsFixesItems ?? 0,
      tone: bounty.needsFixesItems && bounty.needsFixesItems > 0 ? "action" : "neutral",
      icon: "alert",
    },
    {
      label: "contributors",
      value: bounty.contributorCount ?? 0,
      icon: "users",
    },
    {
      label: "validators",
      value: bounty.validatorCount ?? 0,
      icon: "sparkles",
    },
    {
      label: "karma / item",
      value: karmaPerItemLabel(bounty.karmaPerAcceptedItem ?? 0),
      tone: "karma",
      icon: "award",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header Stack */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BackLink href="/sponsor">Back to sponsor requests</BackLink>
          <AutoRefreshControl
            onRefresh={async () => {
              await fetchProgram();
              if (section === "submissions") await fetchSubmissions();
            }}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-ink-faint">community program</span>
              <span className="text-ink-faint">·</span>
              <span className="font-mono text-xs text-ink-soft">
                {[bounty.language, bounty.framework].filter(Boolean).join(" · ") || "General"}
              </span>
            </div>
            <h1 className="mt-1 break-words text-2xl font-bold tracking-tight text-ink">{bounty.title}</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <BountyStatusPill status={bounty.status} />
            {publication && <PublicationStatus publication={publication} compact />}
          </div>
        </div>
      </div>

      {/* Hero Progress Rail */}
      <StatRail cells={statCells} />

      {/* Main Section Navigation */}
      <div className="border-b border-line">
        <PillTabs
          items={SECTIONS.map((s) => ({ key: s.key, label: s.label }))}
          value={section}
          onChange={(k) => setSection(k as Section)}
        />
      </div>

      {/* OVERVIEW SECTION */}
      {section === "overview" && (
        <div className="space-y-6">
          {needsSponsorExamples && (
            <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-5">
              <div className="font-mono text-sm font-semibold text-ink">
                Reference examples — the brief contributors build against
              </div>
              <p className="mt-1 text-sm text-ink-soft">
                Add {requiredExamples} examples that match your dataset contract. Each example must clear file
                checks, pass LLM contract review, and receive platform approval before the dataset goes live to
                contributors. {approvedExamples}/{requiredExamples} approved so far.
              </p>
              <div className="mt-4">
                <SponsorReferenceManager
                  bountyId={bounty.id}
                  requiredCount={requiredExamples}
                  onChanged={() => setReload((value) => value + 1)}
                />
              </div>
            </div>
          )}

          {lifecycle && (
            <div className="space-y-2">
              <div className="micro-label text-ink-faint">community program lifecycle</div>
              <LifecyclePhases lifecycle={lifecycle} />
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="card space-y-4 p-5">
              <div className="text-sm font-bold text-ink">Delivered Request Specification</div>
              {communityRequest ? (
                <RequestSpecGrid spec={communityRequest} licenseLabel={communityLicenseLabel} />
              ) : (
                <div className="text-xs text-ink-soft">No original request specification attached.</div>
              )}
            </div>

            <div className="card space-y-4 p-5">
              <div className="text-sm font-bold text-ink">License & Distribution</div>
              <p className="text-xs text-ink-soft leading-relaxed">
                This community pool is open for public AI model training. When complete, dataset items publish under {communityLicenseLabel(bounty.communityLicense)}.
              </p>
              {publication && <PublicationStatus publication={publication} />}
            </div>
          </div>

          {communityRequest?.adminNote && (
            <ReviewerNote note={communityRequest.adminNote} />
          )}

          {communityRequest && (
            <div className="card p-5">
              <RequestReviewConversation requestId={communityRequest.id} />
            </div>
          )}
        </div>
      )}

      {/* SUBMISSIONS SECTION */}
      {section === "submissions" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Select
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
                className="w-44"
              >
                <option value="all">All statuses</option>
                <option value="in_sponsor_review">In sponsor review</option>
                <option value="provisionally_accepted">Provisionally accepted</option>
                <option value="accepted">Final accepted</option>
                <option value="needs_fixes">Needs fixes</option>
                <option value="rejected">Rejected</option>
                <option value="disputed">Disputed</option>
              </Select>
            </div>

            <SearchField
              value={submissionSearch}
              onChange={(val) => { setSubmissionSearch(val); setPage(1); }}
              placeholder="Search by title…"
              className="w-56"
            />
          </div>

          {submissionsLoading ? (
            <div className="card p-8 text-center text-ink-soft">Loading submissions…</div>
          ) : submissionsData.submissions.length === 0 ? (
            <Empty
              title="No submissions found"
              description="No contributor submissions match your current filter or search criteria."
            />
          ) : (
            <div className="card overflow-hidden">
              <Table headers={["Title", "Status", "Signals", "Submitted", "Actions"]} tbodyClassName="divide-y divide-line-soft text-xs">
                  {submissionsData.submissions.map((sub) => {
                    const flags = sub.flags ?? [];
                    const openFlags = flags.filter((f) => f.status === "open" || f.status === "disputed");
                    return (
                      <tr key={sub.id} className="hover:bg-panel/40">
                        <Td>
                          <Link
                            href={`/sponsor/${bounty.id}/submission/${sub.id}`}
                            className="font-semibold text-ink hover:underline line-clamp-1"
                          >
                            {sub.title}
                          </Link>
                          {openFlags.length > 0 && (
                            <span className="mt-0.5 inline-block font-mono text-[10.5px] text-amber-700">
                              {openFlags.length} open validator flag{openFlags.length === 1 ? "" : "s"}
                            </span>
                          )}
                        </Td>
                        <Td>
                          <SubmissionStatusPill status={sub.status as SubmissionStatus} />
                        </Td>
                        <Td>
                          <div className="font-mono text-[11px] text-ink-soft">
                            {sub.duplicateScore != null && <span>dup: {pct(sub.duplicateScore)} </span>}
                            {sub.llmScore != null && <span>llm: {Math.round(sub.llmScore)}%</span>}
                          </div>
                        </Td>
                        <Td>
                          <span className="font-mono text-[11px] text-ink-faint">
                            {sub.createdAt ? new Date(sub.createdAt).toLocaleDateString() : "—"}
                          </span>
                        </Td>
                        <Td className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Link href={`/sponsor/${bounty.id}/submission/${sub.id}`}>
                              <Button size="sm" variant="secondary">
                                Review
                              </Button>
                            </Link>
                            {sub.status === "in_sponsor_review" && (
                              <>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => { setActingSubmission(sub); setActionType("accept"); }}
                                >
                                  Accept
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => { setActingSubmission(sub); setActionType("reject"); }}
                                >
                                  Reject
                                </Button>
                              </>
                            )}
                            {/* Only an ACCEPTED item within its still-open hold
                                window has anything to dispute — this mirrors what
                                the server actually enforces (dispute-acceptance
                                route), not just "not already disputed", which used
                                to show the button for every other status too
                                (submitted, needs_fixes, rejected, …) where the
                                dispute call would always fail. */}
                            {sub.status === "accepted" &&
                              !!sub.disputeWindowClosesAt &&
                              nowMs !== null &&
                              new Date(sub.disputeWindowClosesAt).getTime() > nowMs && (
                                <button
                                  type="button"
                                  onClick={() => { setActingSubmission(sub); setActionType("dispute"); }}
                                  className="font-mono text-[11px] text-ink-faint hover:text-ink px-1.5 py-1"
                                >
                                  dispute
                                </button>
                              )}
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
              </Table>

              {submissionsData.totalPages > 1 && (
                <div className="border-t border-line p-3 flex justify-center">
                  <Pagination
                    page={page}
                    totalPages={submissionsData.totalPages}
                    onPrev={() => setPage((p) => Math.max(1, p - 1))}
                    onNext={() => setPage((p) => p + 1)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* DELIVERY SECTION */}
      {section === "delivery" && (
        <div className="space-y-6">
          <div className="card p-6 space-y-4">
            <div className="text-base font-bold text-ink">Dataset Publication & Delivery</div>
            <p className="text-xs text-ink-soft leading-relaxed">
              Once this community program finishes intake and every validator decision settles, the dataset publishes automatically to public repositories under {communityLicenseLabel(bounty.communityLicense)}.
            </p>
            {publication ? (
              <PublicationStatus publication={publication} />
            ) : (
              <div className="rounded-xl border border-line bg-panel p-4 text-xs text-ink-soft">
                Dataset publication is queued once the pool reaches 100% final verified items.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Rejection / Review Modal Dialog */}
      {actionType === "reject" && actingSubmission && (
        <Modal
          open={true}
          onClose={() => { setActingSubmission(null); setActionType(null); setRejectNote(""); }}
        >
          <div className="space-y-3">
            <h3 className="font-mono text-base font-bold text-ink">Reject submission & send back for fixes</h3>
            <p className="text-xs text-ink-soft">
              Please provide a specific note explaining what must be corrected. The contributor will receive this feedback (minimum {REJECT_NOTE_MIN} characters).
            </p>
            <textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={3}
              placeholder="Explain the specific issue with the solution or tests…"
              className="w-full rounded-lg border border-line bg-white p-2.5 text-xs text-ink focus:border-ink focus:outline-none"
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => { setActingSubmission(null); setActionType(null); setRejectNote(""); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={actionBusy || rejectNote.trim().length < REJECT_NOTE_MIN}
                onClick={handleReviewAction}
              >
                {actionBusy ? "Rejecting…" : "Reject submission"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Accept Dialog */}
      {actionType === "accept" && actingSubmission && (
        <ConfirmDialog
          open={true}
          title="Accept this submission?"
          description={`This marks the submission as final accepted and queues the karma award for the contributor.`}
          confirmLabel={actionBusy ? "Accepting…" : "Accept submission"}
          confirmDisabled={actionBusy}
          onConfirm={handleReviewAction}
          onCancel={() => { setActingSubmission(null); setActionType(null); }}
        />
      )}

      {/* Dispute Modal Dialog */}
      {actionType === "dispute" && actingSubmission && (
        <Modal
          open={true}
          onClose={() => { setActingSubmission(null); setActionType(null); setDisputeArgument(""); }}
        >
          <div className="space-y-3">
            <h3 className="font-mono text-base font-bold text-ink">File sponsor dispute</h3>
            <p className="text-xs text-ink-soft">
              Escalate this item to a platform human reviewer for arbitration.
            </p>
            <Select
              value={disputeReason}
              onChange={(e) => setDisputeReason(e.target.value)}
              className="w-full text-xs"
            >
              <option value="solution_incorrect">Solution incorrect / invalid</option>
              <option value="tests_invalid">Tests invalid or failing incorrectly</option>
              <option value="low_quality">Low quality / off specification</option>
              <option value="duplicate">Duplicate content</option>
              <option value="other">Other</option>
            </Select>
            <textarea
              value={disputeArgument}
              onChange={(e) => setDisputeArgument(e.target.value)}
              rows={3}
              placeholder="Detailed explanation of why this item requires escalation…"
              className="w-full rounded-lg border border-line bg-white p-2.5 text-xs text-ink focus:border-ink focus:outline-none"
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => { setActingSubmission(null); setActionType(null); setDisputeArgument(""); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={actionBusy || !disputeArgument.trim()}
                onClick={handleReviewAction}
              >
                {actionBusy ? "Filing…" : "File dispute"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
