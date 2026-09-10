// SPDX-License-Identifier: Apache-2.0

/**
 * Event catalog — the semantic contract between business code and the
 * notification pipeline. Callers emit an **event**
 * (`notifyEvent(tx, "submission.accepted", …)`), never a channel or a raw
 * title/body string. Each definition declares its audience category,
 * deep-link entity type, priority and delivery cadence, and renders a neutral
 * title/body from typed data.
 *
 * This module is pure (no DB, no transport) so it stays free of cycles and is
 * trivially unit-testable. `notifyEvent` in ../notifications.ts is the only
 * code that turns a definition into a persisted row.
 *
 * Ported from v1 (`databounty-api/src/services/notifications/events.ts`) with
 * the **paid track removed**. Community has no wallet, escrow, bond, payout,
 * deposit, USDC, funding tranche or pilot-funding vocabulary, so every event
 * about those was deliberately dropped rather than reworded — see the
 * "Deliberately NOT ported" block at the bottom of this file for the list and
 * the reason for each.
 *
 * Adding an event = one entry here. Nothing else changes.
 */

export type EventCategory = "sponsor" | "contributor" | "validator" | "account" | "admin";
export type EventPriority = "high" | "medium" | "low";
/** immediate → delivered on the next dispatch tick; digest → buffered as
 * `digesting` and collapsed by the digest flusher into one daily summary. */
export type EventCadence = "immediate" | "digest";

export type EntityType =
  | "bounty"
  | "dataset_request"
  | "dataset_type"
  | "batch"
  | "submission"
  | "audit"
  | "channel"
  | "profile"
  | "rank"
  | "karma_event"
  | "badge"
  | "agent_issue"
  | "digest"
  | "system";

export type EventData = Record<string, string | number | undefined>;

export interface EventDefinition {
  category: EventCategory;
  entityType: EntityType;
  priority: EventPriority;
  cadence: EventCadence;
  /** Neutral inbox render. Never embeds secrets/PII beyond what the row shows. */
  render(data: EventData): { title: string; body: string };
}

/** Safe field access with a fallback, so a missing template var never throws. */
function f(data: EventData, key: string, fallback = "your item"): string {
  const v = data[key];
  return v === undefined || v === "" ? fallback : String(v);
}

/** Upper-cases the first character only — the rest of a rendered phrase keeps
 * its own casing, so a handle, title or id embedded in it is never mangled. */
const sentenceCase = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

export const EVENTS = {
  // ── Community dataset requests (review loop) ───────────────────────
  "community.request_submitted": {
    category: "admin", entityType: "dataset_request", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Community request submitted", body: `“${f(d, "title", "A dataset request")}” needs an operator review.` }),
  },
  "community.request_status_changed": {
    category: "sponsor", entityType: "dataset_request", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Community request updated", body: `“${f(d, "title", "Your dataset request")}” is now ${f(d, "status", "updated")}.` }),
  },
  "community.request_implemented": {
    category: "sponsor", entityType: "dataset_request", priority: "high", cadence: "digest",
    // "dataset", not "program"/"bounty": on the community track the thing a
    // request becomes is a dataset. `Bounty` stays the storage model.
    render: (d) => ({ title: "Community dataset created", body: `“${f(d, "title", "Your dataset request")}” was approved and is now open for community contributions.` }),
  },
  "community.request_changes_requested": {
    category: "sponsor", entityType: "dataset_request", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Changes requested", body: `Reviewer requested changes on “${f(d, "title", "your dataset request")}”. Open it to see the notes, then resubmit or reply.` }),
  },
  "community.request_resubmitted": {
    category: "admin", entityType: "dataset_request", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Request resubmitted", body: `“${f(d, "title", "A dataset request")}” was updated and is back in the review queue.` }),
  },
  "community.request_comment_added": {
    category: "sponsor", entityType: "dataset_request", priority: "low", cadence: "digest",
    render: (d) => ({ title: "New comment on request", body: `New comment on “${f(d, "title", "a dataset request")}”.` }),
  },
  "community.request_disputed": {
    category: "admin", entityType: "dataset_request", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Request decision disputed", body: `“${f(d, "title", "A dataset request")}” decision was disputed and needs a handler.` }),
  },
  "community.request_declined": {
    category: "sponsor", entityType: "dataset_request", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Dataset request declined", body: `“${f(d, "title", "Your dataset request")}” was declined${d.reason ? `: ${f(d, "reason")}` : "."}` }),
  },
  "community.request_possible_duplicate": {
    category: "admin", entityType: "dataset_request", priority: "low", cadence: "digest",
    render: (d) => ({ title: "Possible duplicate request", body: `“${f(d, "title", "A dataset request")}” looks similar to “${f(d, "match", "an existing dataset")}” (${f(d, "score", "?")}% overlap) — review for duplication before approving.` }),
  },
  "dataset_type.review_decided": {
    category: "sponsor", entityType: "dataset_type", priority: "high", cadence: "digest",
    render: (d) =>
      d.approved === "1"
        ? { title: "Dataset type approved", body: `“${f(d, "name", "Your dataset type")}” was approved and is now active.` }
        : { title: "Dataset type declined", body: `“${f(d, "name", "Your dataset type")}” was declined: ${f(d, "reason", "no reason given")}` },
  },
  // A reference sample attached to a dataset request was reviewed. Sample
  // review is an evidence check, not a money gate — it applies unchanged here.
  "sponsor.request_example_reviewed": {
    category: "sponsor", entityType: "dataset_request", priority: "high", cadence: "immediate",
    render: (d) => ({
      title: f(d, "decision") === "approved" ? "Reference sample approved" : "Reference sample needs attention",
      body: `${f(d, "filename", "A sample")} on “${f(d, "request", "your dataset request")}” was marked ${f(d, "decision", "reviewed").replaceAll("_", " ")}.`,
    }),
  },
  // Sibling of the above for a sample already attached to a minted BOUNTY
  // (`POST /v1/artifacts/:id/sponsor-review` — see routes/v1/artifacts.ts).
  // Correction, 2026-09-03: this key used to be listed below as "deliberately
  // NOT ported — funded-bounty variant". That was wrong. `Bounty` in this
  // schema is not paid-only — every community pool is a `Bounty` row too
  // (`kind: community`), and the sponsor's post-mint "Reference examples"
  // panel (`SponsorReferenceManager` on `/sponsor/[id]`) attaches samples by
  // `bountyId`, not `datasetRequestId`. Without this event a sponsor's sample
  // getting approved/rejected on a live community pool fired no notification
  // at all.
  "sponsor.example_reviewed": {
    category: "sponsor", entityType: "bounty", priority: "high", cadence: "immediate",
    render: (d) => ({
      title: f(d, "decision") === "approved" ? "Reference sample approved" : "Reference sample needs attention",
      body: `${f(d, "filename", "A sample")} on “${f(d, "bounty", "your dataset pool")}” was marked ${f(d, "decision", "reviewed").replaceAll("_", " ")}.`,
    }),
  },

  // ── Work / batches ─────────────────────────────────────────────────
  "work.new_match": {
    category: "contributor", entityType: "bounty", priority: "high", cadence: "digest",
    render: (d) => ({ title: "New work available", body: `A new community dataset matches your watch preferences: “${f(d, "bounty", "a new dataset")}”.` }),
  },
  "batch.claimed": {
    category: "sponsor", entityType: "batch", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Batch claimed", body: `${f(d, "contributor", "A contributor")} claimed a batch on “${f(d, "bounty", "your dataset")}”.` }),
  },
  "batch.deadline_approaching": {
    category: "contributor", entityType: "batch", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Batch deadline approaching", body: `Your batch on “${f(d, "bounty", "a dataset")}” is due ${f(d, "due", "soon")}.` }),
  },
  "batch.settled": {
    category: "sponsor", entityType: "batch", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Batch settled", body: `Batch “${f(d, "slot", "a batch")}” on “${f(d, "bounty", "your dataset")}” is ${f(d, "status", "settled")}.` }),
  },
  "batch.abandoned": {
    category: "contributor", entityType: "batch", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Batch abandoned", body: `Batch “${f(d, "slot", "your batch")}” passed its deadline and was marked abandoned.` }),
  },
  "batch.abandoned_sponsor": {
    category: "sponsor", entityType: "batch", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Batch abandoned", body: `Batch “${f(d, "slot", "a batch")}” on “${f(d, "bounty", "your dataset")}” passed its deadline unfinished and was marked abandoned.` }),
  },

  // ── Submission / validation (contributor) ──────────────────────────
  "submission.accepted": {
    category: "contributor", entityType: "submission", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Submission accepted", body: `${f(d, "item")} was accepted.` }),
  },
  "submission.needs_fixes": {
    // A bulk submission can need fixes on hundreds of items. Keep each item
    // visible in the in-app feed, but batch external delivery into the one
    // daily digest instead of one email per item.
    category: "contributor", entityType: "submission", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Fixes requested", body: `${f(d, "item")} needs fixes${d.reason ? `: ${f(d, "reason")}` : ""}${d.note ? ` — ${f(d, "note")}` : ""}.` }),
  },
  "submission.rejected": {
    category: "contributor", entityType: "submission", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Submission rejected", body: `${f(d, "item")} was rejected.` }),
  },
  "submission.rejected_final": {
    category: "sponsor", entityType: "submission", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Submission rejected", body: `${f(d, "item", "A submission")} on “${f(d, "bounty", "your dataset")}” was rejected${d.reason ? `: ${f(d, "reason")}` : "."}` }),
  },
  /** Community-only: an item that cleared automation is waiting on the pool
   * requester's own approve/reject (a pool with no validator coverage). */
  "submission.pending_sponsor_review": {
    category: "sponsor", entityType: "submission", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Submission awaiting your review", body: `${f(d, "item", "A submission")} on “${f(d, "bounty", "your dataset")}” cleared automated validation and is waiting for you to approve or reject it.` }),
  },
  "submission.queued_for_audit": {
    category: "sponsor", entityType: "submission", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Submission requires validator review", body: `${f(d, "item", "A submission")} on “${f(d, "bounty", "your dataset")}” is queued for validator review. Open the submission evidence for the validation outcome.` }),
  },
  "submission.auto_accepted": {
    category: "sponsor", entityType: "submission", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Submission accepted", body: `${f(d, "item", "A submission")} on “${f(d, "bounty", "your dataset")}” was automatically accepted.` }),
  },
  /** Community-only: a validator raised a flag on the contributor's item. */
  "submission.flagged": {
    category: "contributor", entityType: "submission", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Submission flagged", body: `${f(d, "item", "Your submission")} was flagged during review${d.reason ? `: ${f(d, "reason")}` : "."} You can dispute the flag if you disagree.` }),
  },
  "validation.tests_failed": {
    category: "contributor", entityType: "submission", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Tests failed", body: `Automated tests failed for ${f(d, "item")}.` }),
  },
  "validation.stage_result": {
    // Fires once per pipeline stage per submission, so a bulk upload of N
    // items with a P-stage pipeline emits N*P of these — the most voluminous
    // event in the catalog. Digest cadence collapses a user's buffered stage
    // results into ONE summary rather than one push per stage per item.
    category: "contributor", entityType: "submission", priority: "medium", cadence: "digest",
    render: (d) => ({
      title: `${f(d, "stage", "Validation step")} ${f(d, "outcome", "updated")}`,
      body: `${f(d, "item", "Your submission")}: ${f(d, "detail", "See the submission evidence for details.")}`,
    }),
  },
  "validation.manual_review_contributor": {
    category: "contributor", entityType: "submission", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Validation needs manual review", body: `Automated validation could not finish for ${f(d, "item")}. Your submission is preserved and has been sent to a validator.` }),
  },
  "validation.manual_review_sponsor": {
    category: "sponsor", entityType: "submission", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Submission sent to manual review", body: `Automated validation could not finish for ${f(d, "item", "a submission")} on “${f(d, "bounty", "your dataset")}”; it has been routed to a validator.` }),
  },
  "submission.accepted_sponsor": {
    category: "sponsor", entityType: "submission", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Submission accepted", body: `${f(d, "item", "A submission")} on “${f(d, "bounty", "your dataset")}” was accepted by the validator.` }),
  },

  // ── Audit (validator / requester) ──────────────────────────────────
  "audit.available": {
    category: "validator", entityType: "bounty", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Audits available", body: `Audit work is available for “${f(d, "bounty", "a dataset")}”.` }),
  },
  "audit.claimed": {
    category: "validator", entityType: "audit", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Audit claimed", body: `You claimed an audit on “${f(d, "bounty", "a dataset")}”.` }),
  },
  "audit.reopened": {
    category: "validator", entityType: "audit", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Audit item reopened", body: `An item on “${f(d, "bounty", "a dataset")}” came back for review — your other decisions on that audit stand.` }),
  },
  "audit.deadline_missed": {
    category: "validator", entityType: "audit", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Audit deadline missed", body: `Your decision window on “${f(d, "bounty", "a dataset")}” passed — it's back in the open pool.` }),
  },
  "audit.completed": {
    category: "sponsor", entityType: "audit", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Audit completed", body: `An audit completed for “${f(d, "bounty", "your dataset")}”.` }),
  },
  "audit.item_decision_recorded": {
    category: "validator", entityType: "audit", priority: "low", cadence: "digest",
    render: (d) => ({ title: "Audit decision saved", body: `${f(d, "item", "An item")} was marked ${f(d, "verdict", "updated")}${d.reason ? `: ${f(d, "reason")}` : "."}` }),
  },
  "audit.completed_validator": {
    category: "validator", entityType: "audit", priority: "high", cadence: "digest",
    // v1 appended a USDC base reward here. Community pays karma, not money,
    // and the karma award has its own `karma.awarded` event.
    render: (d) => ({ title: "Audit completed", body: `Your audit for “${f(d, "bounty", "a dataset")}” is complete.` }),
  },

  // ── Flags & disputes ───────────────────────────────────────────────
  "issue.flagged": {
    category: "sponsor", entityType: "audit", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Issue flagged", body: `A validator flagged an issue on “${f(d, "bounty", "your dataset")}”${d.reason ? `: ${f(d, "reason")}` : ""}${d.note ? ` — ${f(d, "note")}` : ""}.` }),
  },
  "issue.disputed": {
    category: "validator", entityType: "submission", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Flag disputed", body: `A flag you raised on “${f(d, "bounty", "a dataset")}” was disputed by the contributor.` }),
  },
  "issue.dispute_filed": {
    category: "sponsor", entityType: "submission", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Submission dispute filed", body: `${f(d, "item", "A submission")} was disputed by its contributor and needs platform review.` }),
  },
  /** Counterpart to `issue.dispute_filed` above: the REQUESTER disputes an
   * item a validator (or the auto-accept path) already accepted, during the
   * post-accept hold window (routes/v1/submissions.ts `dispute-acceptance`).
   * Targets the contributor, not the sponsor. */
  "issue.sponsor_disputed": {
    category: "contributor", entityType: "submission", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Accepted item disputed", body: `The requester of “${f(d, "bounty", "a dataset")}” disputed acceptance of ${f(d, "item", "your submission")} and it now needs platform review.` }),
  },
  "dispute.requeued": {
    category: "contributor", entityType: "submission", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Dispute overturned", body: `${f(d, "item", "Your submission")} was returned to validator review after the dispute was upheld.` }),
  },
  "dispute.upheld": {
    category: "contributor", entityType: "submission", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Dispute resolved", body: `The flag on ${f(d, "item", "your submission")} was upheld${d.resolution ? `: ${f(d, "resolution")}` : "."}` }),
  },
  "issue.dispute_resolved": {
    category: "sponsor", entityType: "submission", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Dispute resolved", body: `The platform resolved the dispute on ${f(d, "item", "a submission")} for “${f(d, "bounty", "your dataset")}”.` }),
  },

  // ── Community open-pool lifecycle ──────────────────────────────────
  "pool.sampling_started": {
    category: "sponsor", entityType: "bounty", priority: "medium", cadence: "digest",
    render: (d) => ({
      title: "Pool closed, final review starting",
      body: `“${f(d, "bounty", "Your community pool")}” reached its target — ${f(d, "sampledCount", "some")} items are entering final human review.`,
    }),
  },
  "pool.sponsor_review_ready": {
    category: "sponsor", entityType: "bounty", priority: "high", cadence: "immediate",
    render: (d) => ({
      title: "Your review is needed",
      body: `“${f(d, "bounty", "Your community pool")}” reached its target — ${f(d, "reviewCount", "all")} items are ready for you to approve or reject.`,
    }),
  },
  "submission.sampled_for_audit": {
    category: "contributor", entityType: "submission", priority: "medium", cadence: "digest",
    render: () => ({
      title: "Your submission was sampled for review",
      body: "Your contribution was randomly sampled for a validator's final review before the pool closes.",
    }),
  },
  "dataset.final_ready": {
    category: "sponsor", entityType: "bounty", priority: "high", cadence: "digest",
    render: (d) => ({ title: "Dataset ready", body: `“${f(d, "bounty", "Your community pool")}” finished final review — the accepted dataset is ready.` }),
  },
  "community.bounty_published": {
    category: "contributor", entityType: "bounty", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Dataset published", body: `“${f(d, "bounty", "A community dataset")}” you contributed to was published${d.datasetUrl ? `: ${f(d, "datasetUrl")}` : d.dataset ? ` (${f(d, "dataset")})` : "."}` }),
  },
  "community.publish_bonus_awarded": {
    category: "contributor", entityType: "bounty", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Publish bonus earned", body: `You were a top contributor on “${f(d, "bounty", "a published dataset")}” — +${f(d, "amount", "150")} karma.` }),
  },

  // ── Reputation / karma (account) ───────────────────────────────────
  "karma.awarded": {
    // Low cadence on purpose: an active contributor earns karma on every
    // accepted item, so "immediate" would mean one push per accepted item.
    category: "contributor", entityType: "karma_event", priority: "low", cadence: "digest",
    render: (d) => ({ title: "Karma earned", body: `+${f(d, "amount", "Karma")} for ${f(d, "reason", "recent work")}.` }),
  },
  "badge.earned": {
    category: "contributor", entityType: "badge", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Badge earned", body: `You earned the “${f(d, "badge", "a new")}” badge.` }),
  },
  "rank.changed": {
    category: "account", entityType: "rank", priority: "medium", cadence: "digest",
    render: (d) => ({ title: "Rank changed", body: `Your rank is now ${f(d, "rank", "updated")}.` }),
  },
  "rank.near_next": {
    category: "account", entityType: "rank", priority: "low", cadence: "digest",
    render: (d) => ({
      title: "Almost there",
      body: `${f(d, "itemsToGo", "A few more")} more ${f(d, "unit", "items")} and you'll rank up to ${f(d, "rank", "the next tier")}.`,
    }),
  },
  "leaderboard.rank_improved": {
    category: "contributor", entityType: "rank", priority: "medium", cadence: "digest",
    render: (d) => ({
      title: d.previousRank ? "You moved up the leaderboard" : "You're on the leaderboard",
      body: d.previousRank
        ? `${sentenceCase(f(d, "work", "recent work"))} moved you from #${f(d, "previousRank")} to #${f(d, "rank")} on the Open leaderboard.`
        : `${sentenceCase(f(d, "work", "recent work"))} puts you at #${f(d, "rank")} on the Open leaderboard.`,
    }),
  },
  "profile.credential_recheck_failed": {
    category: "account", entityType: "profile", priority: "high", cadence: "immediate",
    render: (d) => ({
      title: "Credential needs reconnecting",
      body: `We could not reverify your ${f(d, "provider", "profile")} credential. Reconnect it to restore its reputation benefit.`,
    }),
  },
  "channel.connected": {
    category: "account", entityType: "channel", priority: "low", cadence: "immediate",
    render: (d) => ({ title: "Channel connected", body: `${f(d, "channel", "A channel")} notifications are now delivering.` }),
  },

  // ── Agent Issues (support/defect channel) ─────────────────────────
  "agent_issue.updated": {
    category: "account", entityType: "agent_issue", priority: "medium", cadence: "digest",
    render: (d) => ({
      title: "Issue update",
      body: `Your reported issue is now ${f(d, "status", "updated")}.${d["reason"] ? ` ${f(d, "reason")}` : ""}`,
    }),
  },
  /** Community's own emitter name for the same thing (routes/v1/admin-issues.ts). */
  "agent_issue.status_changed": {
    category: "account", entityType: "agent_issue", priority: "medium", cadence: "digest",
    render: (d) => ({
      title: "Issue update",
      body: `Your reported issue is now ${f(d, "status", "updated")}.${d["reason"] ? ` ${f(d, "reason")}` : ""}`,
    }),
  },
  "agent_issue.info_requested": {
    category: "account", entityType: "agent_issue", priority: "high", cadence: "immediate",
    render: (d) => ({
      title: "More info needed on your issue",
      body: `Support asked a follow-up question: ${f(d, "question", "please add detail to your report")}`,
    }),
  },
  "agent_issue.canonical_outcome": {
    category: "account", entityType: "agent_issue", priority: "medium", cadence: "digest",
    render: (d) => ({
      title: "Outcome on the issue yours was merged into",
      body:
        `The case your report was merged into is now ${f(d, "status", "closed")}.` +
        (d["reason"] ? ` ${f(d, "reason")}` : "") +
        (d["resolutionRef"] ? ` Fix reference: ${f(d, "resolutionRef")}.` : ""),
    }),
  },

  // ── Admin (role-addressed — see notifyAdmins) ──────────────────────
  "admin.new_signup": {
    category: "admin", entityType: "profile", priority: "low", cadence: "digest",
    render: (d) => ({ title: "New signup", body: `${f(d, "who", "A new user")} just created an account (${f(d, "method", "email")}).` }),
  },
  "admin.dispute_filed": {
    category: "admin", entityType: "submission", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Dispute filed", body: `A flag on “${f(d, "bounty", "a dataset")}” was disputed and needs a ruling.` }),
  },
  "admin.harness_proof_completed": {
    category: "admin", entityType: "dataset_type", priority: "medium", cadence: "immediate",
    render: (d) => ({
      title: "Harness proof run finished",
      body: `The harness proof run for “${f(d, "name", "a dataset type")}” ${f(d, "outcome", "finished")} — ${f(d, "summary", "open the type's harness panel for evidence")}.`,
    }),
  },
  "admin.validation_job_dead": {
    category: "admin", entityType: "submission", priority: "high", cadence: "immediate",
    render: (d) => ({ title: "Validation job needs review", body: `Automated validation exhausted its retries for ${f(d, "item", "a submission")} on “${f(d, "bounty", "a dataset")}”; the item was routed to manual audit.` }),
  },
  /** Community's own emitter name (services/issues.ts). */
  "agent_issue.created": {
    category: "admin", entityType: "agent_issue", priority: "medium", cadence: "immediate",
    render: (d) => ({
      title: "Agent issue filed",
      body: `A ${f(d, "impact", "reported")} ${f(d, "category", "platform")} issue needs triage: ${f(d, "summary", "no summary")}`,
    }),
  },
  "admin.agent_issue_filed": {
    category: "admin", entityType: "agent_issue", priority: "medium", cadence: "immediate",
    render: (d) => ({
      title: "Agent issue filed",
      body: `A ${f(d, "impact", "reported")} ${f(d, "category", "platform")} issue needs triage: ${f(d, "summary", "no summary")}`,
    }),
  },
  "admin.agent_issue_aging": {
    category: "admin", entityType: "agent_issue", priority: "high", cadence: "immediate",
    render: (d) => ({
      title: `Agent issue still open after ${f(d, "ageHours", "its threshold")}h`,
      body:
        `A ${f(d, "impact", "reported")} ${f(d, "category", "platform")} issue has been open past its ${f(d, "thresholdHours", "escalation")}h ` +
        `threshold and is still ${f(d, "status", "untriaged")}: ${f(d, "summary", "no summary")}`,
    }),
  },
  "admin.system_alert": {
    category: "admin", entityType: "system", priority: "high", cadence: "immediate",
    render: (d) => ({
      title: `System alert: ${f(d, "code", "condition detected")}`,
      body: `${f(d, "summary", "A system health condition needs attention.")} (severity: ${f(d, "severity", "warning")})`,
    }),
  },
  "admin.system_recovered": {
    category: "admin", entityType: "system", priority: "low", cadence: "digest",
    render: (d) => ({
      title: `Recovered: ${f(d, "code", "condition cleared")}`,
      body: f(d, "summary", "A previously alerted system condition has cleared."),
    }),
  },

  // ── The digest itself ──────────────────────────────────────────────
  // Not emitted by business code — written by the digest flusher. Present in
  // the catalog so cadence/priority/category resolution never has to special-
  // case it, and so `sectionFor` can classify it.
  "digest.summary": {
    category: "account", entityType: "digest", priority: "low", cadence: "immediate",
    render: (d) => ({ title: f(d, "title", "Updates from DataBounty"), body: f(d, "body", "") }),
  },
} as const satisfies Record<string, EventDefinition>;

export type EventType = keyof typeof EVENTS;

export function eventDefinition(type: EventType): EventDefinition {
  return EVENTS[type];
}

/** Catalog membership test for a free-form `type` string coming from a legacy
 * caller. Used by `notify()` to resolve cadence without asserting a cast. */
export function isEventType(type: string): type is EventType {
  return Object.prototype.hasOwnProperty.call(EVENTS, type);
}

/* --------------------------------------------------------------------------
 * Deliberately NOT ported from v1 — every one of these is a paid-track event.
 * Community has no wallet, escrow, bond, deposit, payout or funding tranche,
 * so porting them would introduce vocabulary for machinery that does not
 * exist here and could never fire.
 *
 *   pilot.tranche_confirmed          escrow tranche funding
 *   funding.full_tranche_confirmed   escrow tranche funding
 *   bounty.cancelled                 "any funded amount refunded"
 *   pilot.sample_ready               paid pilot-review loop
 *   pilot.review_reminder            paid pilot-review loop
 *   pilot.auto_approved              paid pilot-review loop
 *   pilot.change_requested           paid pilot-review loop
 *   pilot.revised_ready              paid pilot-review loop
 *   issue.bonus_awarded              USDC issue bonus
 *   payout.pending                   money
 *   payout.sent                      money
 *   payout.failed                    money
 *   withdrawal.requested             money
 *   kyc.required                     money (payout gating)
 *   admin.kyc_hold                   money
 *   admin.payout_exception           money
 *   admin.payout_batch_ready         money
 *   admin.pilot_revision_stalled     paid pilot-review loop
 *   paid_creation.launched           paid-launch announcement
 *   bounty.bucket_released           renamed: the community equivalent is
 *                                    `dataset.final_ready` above, without the
 *                                    escrow-bucket wording
 *
 * This list covers PAID-TRACK drops only. It is not a general index of every
 * v1 event absent from this catalog, and its presence is not evidence that a
 * missing event was reviewed.
 *
 * Separately, and for a different reason than the paid-track drops above:
 * v1's `validation.contamination_rejected` and `admin.contamination_flag`
 * have no counterpart here because external-corpus contamination /
 * plagiarism screening was removed from this product per owner decision.
 * There is no stage left to emit them.
 * ----------------------------------------------------------------------- */
