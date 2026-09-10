// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone job-queue poller — the consumer for every `JobQueue` row this API
 * enqueues.
 *
 * The invariant this file has to hold up (stated in services/jobs.ts): every
 * member of the `JobType` union has a real handler HERE and at least one real
 * producer. Both halves were broken before this pass — the union had grown to
 * ~28 types and six handler modules had been written under
 * `services/jobs/`, but nothing imported them and this switch dispatched five
 * types. Everything else was enqueue-able and never processed, or (worse)
 * never even enqueued: dead code that reads as a shipped feature.
 *
 * Two kinds of work run here, deliberately kept apart:
 *
 *   1. CLAIM_PLAN / handle() — the discrete per-row job queue. A type appears
 *      in exactly one plan entry, whose `leaseMs` is derived from that group's
 *      worst-case tick (never one flat lease for everything: a crashed
 *      lightweight job should not wait out a sandbox-sized lease to be
 *      reclaimed).
 *   2. SWEEPS — the periodic PRODUCERS. Several job types are only ever
 *      enqueued by a time-based sweep (`artifact.purge_expired_uploads`,
 *      `agent_issue.*` sweeps, the leaderboard/waitlist/profile-source
 *      scanners, the format-registry staleness recheck). v1 runs exactly these
 *      from its own worker tick list; without them the handlers below would be
 *      correct and never called. Each sweep self-limits and is idempotent on a
 *      time bucket, so running several worker processes is safe.
 *
 * V1's src/worker.ts remains the reference for shape; this rebuild's queue is
 * a single-candidate Prisma-level claim rather than v1's batched
 * `FOR UPDATE SKIP LOCKED`, so dispatch is one central switch instead of one
 * `processXJobs()` per service.
 */
import { prisma } from "./lib/prisma.js";
import { dbJobQueue, type JobEnvelope, type JobType, type WatcherFanoutPayload } from "./services/jobs.js";
import { runSubmissionValidation } from "./services/validation.js";
import { assertConfiguredProvidersBootable } from "./services/execution.js";
import { runPoolSamplingJob, reconcileOpenCommunityPools, settleDueCommunityPools } from "./services/pool-lifecycle.js";
import { runArtifactScanJob } from "./services/artifacts.js";
import { runTelegramPollLoop } from "./services/telegram.js";
import {
  dispatchPendingNotifications,
  flushDigests,
  runWatcherFanoutJob,
} from "./services/notifications.js";
import { createHeartbeatWorker, touchWorkerHeartbeat } from "./services/worker-heartbeat.js";
import { runWatchdogSweep } from "./services/watchdog.js";
import { refreshCommunityQualityMetricsSnapshot } from "./services/admin-quality-metrics.js";
import { releaseOverdueAudits } from "./services/audit-lifecycle.js";
import { releaseDueKarmaHolds } from "./services/karma-holds.js";
import { cleanupMcpOAuth } from "./services/mcp-oauth.js";
import { runCommunityPublishJob, runCommunityUnpublishJob } from "./services/community-publish.js";
import { runHarnessProofJob, PROOF_LEASE_MS, type HarnessProofJobPayload } from "./routes/v1/admin-harness.js";
import {
  enqueueExpiredUploadPurge,
  enqueueStaleFormatRechecks,
  purgeExpiredArtifactUploads,
  runArtifactParseJob,
  runArtifactPreviewJob,
  runArtifactSimilarityJob,
} from "./services/jobs/artifact-jobs.js";
import { runBulkSourceParseJob } from "./services/jobs/bulk-source-parse.js";
import { runUploadDraftSubmitJob } from "./services/jobs/upload-draft-submit.js";
import { runSponsorReferenceReviewJob } from "./services/jobs/sponsor-reference-review.js";
import {
  enqueueAgentIssueSweeps,
  purgeExpiredAgentIssues,
  runCanonicalOutcomeFanout,
  runDuplicateCandidatesJob,
  runEscalation,
  runEscalationSweep,
  runFiledNotification,
} from "./services/jobs/agent-issue-jobs.js";
import {
  enqueueDueLeaderboardRankChecks,
  runLeaderboardRankCheck,
} from "./services/jobs/leaderboard-movement.js";
import {
  enqueueDueDomainLiveNotifications,
  runWaitlistNotifyJob,
} from "./services/jobs/waitlist-notify.js";
import {
  failClosedBenchmarkEvaluation,
  runBenchmarkVersionBuildJob,
} from "./services/jobs/benchmark-jobs.js";
import {
  revalidateDueProfileSources,
  runProfileSourceVerifyJob,
} from "./services/jobs/profile-source-verify.js";
import { config } from "./config.js";
import { configuredProviders } from "./services/execution-providers/provider-order.js";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);

/**
 * Lease derived from the worst-case tick, not a flat guess: a `validation.run`
 * can call each configured sandbox provider in turn (up to
 * `config.execution.timeoutMs` each) and then the LLM review stage — a flat
 * lease shorter than that would let a second worker re-claim a job whose
 * first worker is still genuinely in flight. Same reasoning as
 * `PROOF_LEASE_MS` in admin-harness.ts. `+1` and the LLM allowance are slack
 * for the always-present duplicate/attribution checks either side of the
 * sandbox call.
 */
const VALIDATION_LEASE_MS = (() => {
  const providerSlots = Math.max(1, configuredProviders().length);
  const llmAllowance = 60_000;
  return Math.max(5 * 60_000, config.execution.timeoutMs * (providerSlots + 1) * 2 + llmAllowance);
})();

const DEFAULT_LEASE_MS = 5 * 60_000;
/** Ceiling for a job that does real I/O beyond the database. */
const HEAVY_LEASE_MS = 10 * 60_000;

/**
 * Per-type lease, and — because this is a `Record<JobType, number>` — the
 * COMPILE-TIME proof that every declared job type is actually claimed. Add a
 * member to `JobType` without adding it here and `tsc` fails; that is the
 * whole point. The previous shape (a hand-maintained `HANDLED_TYPES` array
 * plus a separate claim plan) is exactly how this file drifted to dispatching
 * 5 of ~28 declared types with no error anywhere.
 *
 * Lease values are sized from each group's worst-case tick, never one flat
 * guess: a crashed lightweight job should not have to wait out a
 * sandbox-sized lease before it can be reclaimed.
 */
const LEASE_BY_TYPE: Record<JobType, number> = {
  // Real sandbox execution — leases derived from the provider chain.
  "harness.proof_run": PROOF_LEASE_MS,
  "validation.run": VALIDATION_LEASE_MS,

  // Bounded but not instant: reads artifact bytes, calls an LLM reviewer, or
  // pushes to a publication provider.
  "artifact.scan": HEAVY_LEASE_MS,
  "artifact.parse": HEAVY_LEASE_MS,
  "artifact.preview": HEAVY_LEASE_MS,
  "artifact.similarity_check": HEAVY_LEASE_MS,
  "bulk_source.parse": HEAVY_LEASE_MS,
  // Same class of work as bulk_source.parse: chunked DB writes plus the same
  // per-item ingest path (dedupe reads, LSH scoring, file-artifact attach)
  // submitPoolBatchItems uses. HEAVY_LEASE_MS matches that risk profile.
  "upload_draft.submit": HEAVY_LEASE_MS,
  "sponsor_reference.review": HEAVY_LEASE_MS,
  "community.publish": HEAVY_LEASE_MS,
  "community.unpublish": HEAVY_LEASE_MS,
  "benchmark.version_build": HEAVY_LEASE_MS,

  // Short database-only ticks (plus two bounded outbound calls: the credential
  // provider check and waitlist mail, both individually timeout-bounded).
  "pool.sampling": DEFAULT_LEASE_MS,
  "artifact.purge_expired_uploads": DEFAULT_LEASE_MS,
  "profile_source.verify": DEFAULT_LEASE_MS,
  "benchmark.run_evaluation": DEFAULT_LEASE_MS,
  "notifications.fanout_watchers": DEFAULT_LEASE_MS,
  "waitlist.notify_domain_live": DEFAULT_LEASE_MS,
  "agent_issue.purge_expired": DEFAULT_LEASE_MS,
  "agent_issue.duplicate_candidates": DEFAULT_LEASE_MS,
  "agent_issue.notify_filed": DEFAULT_LEASE_MS,
  "agent_issue.escalation_sweep": DEFAULT_LEASE_MS,
  "agent_issue.escalate": DEFAULT_LEASE_MS,
  "agent_issue.notify_canonical_outcome": DEFAULT_LEASE_MS,
  "leaderboard.rank_check": DEFAULT_LEASE_MS,
};

/** Every type this worker claims — derived from {@link LEASE_BY_TYPE}, never
 * maintained by hand. */
export const HANDLED_TYPES = Object.keys(LEASE_BY_TYPE) as JobType[];

/**
 * Types grouped by lease, longest first. Longest-first matters: the expensive
 * groups are also the ones a user is waiting on (a submission's validation, an
 * admin's harness proof), so they get first refusal on each tick.
 *
 * One claim attempt per group per tick; the first group with a due job wins the
 * tick (`drained = true` short-circuits to keep the next tick immediate rather
 * than waiting out `POLL_INTERVAL_MS` while other groups may also have work).
 */
const CLAIM_PLAN: Array<{ types: JobType[]; leaseMs: number }> = [
  ...new Set(Object.values(LEASE_BY_TYPE)),
]
  .sort((a, b) => b - a)
  .map((leaseMs) => ({
    leaseMs,
    types: HANDLED_TYPES.filter((type) => LEASE_BY_TYPE[type] === leaseMs),
  }));

async function handle(job: JobEnvelope): Promise<void> {
  switch (job.type) {
    case "validation.run": {
      const payload = job.payload as { submissionId: string; validationAttempt?: number };
      await runSubmissionValidation(payload.submissionId, payload.validationAttempt ?? 0);
      return;
    }
    case "pool.sampling": {
      const payload = job.payload as { bountyId: string };
      await runPoolSamplingJob(payload.bountyId);
      return;
    }
    case "artifact.scan": {
      const payload = job.payload as { artifactId: string };
      await runArtifactScanJob(payload.artifactId);
      return;
    }
    case "artifact.purge_expired_uploads": {
      await purgeExpiredArtifactUploads();
      return;
    }
    case "artifact.parse": {
      const payload = job.payload as { artifactId: string };
      await runArtifactParseJob(payload.artifactId);
      return;
    }
    case "artifact.preview": {
      const payload = job.payload as { artifactId: string };
      await runArtifactPreviewJob(payload.artifactId);
      return;
    }
    case "artifact.similarity_check": {
      const payload = job.payload as { artifactId: string };
      await runArtifactSimilarityJob(payload.artifactId);
      return;
    }
    case "bulk_source.parse": {
      const payload = job.payload as { artifactId: string };
      await runBulkSourceParseJob(payload.artifactId);
      return;
    }
    case "upload_draft.submit": {
      const payload = job.payload as { draftId: string };
      await runUploadDraftSubmitJob(payload.draftId);
      return;
    }
    case "sponsor_reference.review": {
      const payload = job.payload as { artifactId: string };
      // The handler needs the attempt counters: a transient LLM blip should be
      // retried, while an unconfigured reviewer must, on the LAST attempt,
      // record an honest "waiting on a human" instead of a machine verdict.
      await runSponsorReferenceReviewJob(payload.artifactId, {
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      });
      return;
    }
    case "community.publish": {
      // runCommunityPublishJob already self-gates on the
      // community.publish.enabled admin setting before doing any real work,
      // so no separate kill-switch check is needed here.
      const payload = job.payload as { bountyId: string };
      await runCommunityPublishJob(payload.bountyId);
      return;
    }
    case "community.unpublish": {
      const payload = job.payload as { bountyId: string };
      await runCommunityUnpublishJob(payload.bountyId);
      return;
    }
    case "profile_source.verify": {
      await runProfileSourceVerifyJob(
        job.payload as { profileSourceId: string; checkType: "initial" | "recheck"; verificationKey: string }
      );
      return;
    }
    case "benchmark.version_build": {
      const payload = job.payload as { benchmarkVersionId: string };
      // Attempt counters again, for the same reason: an ineligible manifest is
      // permanent and must land the release in `failed` with a real reason
      // rather than looping until the queue dead-letters it and the admin
      // console shows `building` forever.
      await runBenchmarkVersionBuildJob(payload.benchmarkVersionId, {
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      });
      return;
    }
    case "benchmark.run_evaluation": {
      // Deliberately fail-closed: no contract-tested evaluator is configured,
      // so this records an explicit BENCHMARK_EVALUATOR_UNAVAILABLE terminal
      // failure and never invents a score.
      const payload = job.payload as { benchmarkRunId: string };
      await failClosedBenchmarkEvaluation(payload.benchmarkRunId);
      return;
    }
    case "notifications.fanout_watchers": {
      await runWatcherFanoutJob(job.payload as unknown as WatcherFanoutPayload);
      return;
    }
    case "waitlist.notify_domain_live": {
      const payload = job.payload as { domain: string };
      const result = await runWaitlistNotifyJob(payload.domain);
      // The handler itself throws when anything is still owed; this guard is a
      // belt-and-braces restatement of the same rule — acking while people are
      // still un-emailed would record the promise as kept when it was not.
      if (result.remaining > 0) {
        throw new Error(`waitlist.notify_domain_live: ${result.remaining} recipient(s) still owed for ${payload.domain}`);
      }
      return;
    }
    case "agent_issue.purge_expired": {
      await purgeExpiredAgentIssues();
      return;
    }
    case "agent_issue.escalation_sweep": {
      await runEscalationSweep();
      return;
    }
    case "agent_issue.escalate": {
      // `policyVersion` is carried in the payload purely as part of the
      // idempotency key (a policy change re-arms the alert); the handler
      // re-reads the current policy itself.
      const payload = job.payload as { issueId: string };
      await runEscalation(payload.issueId);
      return;
    }
    case "agent_issue.notify_filed": {
      const payload = job.payload as { issueId: string };
      await runFiledNotification(payload.issueId);
      return;
    }
    case "agent_issue.duplicate_candidates": {
      const payload = job.payload as { issueId: string };
      await runDuplicateCandidatesJob(payload.issueId);
      return;
    }
    case "agent_issue.notify_canonical_outcome": {
      const payload = job.payload as { canonicalIssueId: string; version: number };
      await runCanonicalOutcomeFanout(payload.canonicalIssueId, payload.version);
      return;
    }
    case "leaderboard.rank_check": {
      const payload = job.payload as { userId: string };
      await runLeaderboardRankCheck(payload.userId);
      return;
    }
    case "harness.proof_run": {
      await runHarnessProofJob(job.payload as unknown as HarnessProofJobPayload);
      return;
    }
    default: {
      // COMPILE-TIME exhaustiveness proof: with every `JobType` handled above,
      // `job.type` narrows to `never` here, so this assignment only compiles
      // while the switch is complete. Add a member to `JobType` and forget its
      // case and `tsc` fails — it can no longer become a job that enqueues
      // fine and is silently never processed.
      const unhandled: never = job.type;
      // Still a real runtime guard: a `type` column value that predates a
      // rename reaches here, and must fail loudly rather than ack work nobody
      // did.
      throw new Error(`No handler for job type: ${String(unhandled)}`);
    }
  }
}

async function runJobQueueLoop(): Promise<void> {
  // Provider bootability is asserted once by the process entrypoint
  // (src/server.ts) before it starts listening — `validation.run` dispatches
  // contributor code to the execution sandbox, so a misconfigured provider
  // must stop startup rather than surface as a held item on the first job.
  //
  // Process lifetime and SIGTERM/SIGINT belong to the server too. This loop
  // deliberately installs no signal handler of its own: two handlers racing to
  // `process.exit(0)` is how an in-flight job gets killed mid-write instead of
  // being left for the lease to reclaim.
  console.log(`[worker] polling every ${POLL_INTERVAL_MS}ms for: ${HANDLED_TYPES.join(", ")}`);

  // The job-queue consumer is the single most important loop in this process —
  // it drains every one of the 23 job types — and until 2026-09-02 it was the
  // ONLY loop that wrote no heartbeat, so services/watchdog.ts (which iterates
  // workerHeartbeat rows) could not see it. If it wedged or the process died,
  // `worker_stale` never fired and the sole symptom was the job_backlog
  // threshold. It is not wrapped in createHeartbeatWorker because this loop
  // owns process lifetime and shutdown; it reports directly instead.
  //
  // The interval declared to the watchdog is the poll interval, and staleness
  // is max(3 x interval, 120s) — comfortably longer than a poll, and the write
  // happens once per pass whether or not a job was claimed, so an idle queue
  // still looks alive.
  const JOB_LOOP_HEARTBEAT = "job-dispatch";

  // Drain-then-wait loop rather than a fixed setInterval: a burst of
  // enqueued jobs gets processed back-to-back instead of one per tick.
  for (;;) {
    let drained = false;
    try {
      for (const plan of CLAIM_PLAN) {
        const job = await dbJobQueue.claim(plan.types, plan.leaseMs);
        if (!job) continue;
        drained = true;
        try {
          await handle(job);
          await dbJobQueue.complete(job.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[worker] job ${job.id} (${job.type}) failed:`, message);
          await dbJobQueue.fail(job.id, message);
        }
        break; // re-enter the plan from the top next tick rather than continuing this pass
      }
    } catch (err) {
      console.error("[worker] tick error:", err);
    }
    // After the pass, not before: a heartbeat written before the work would
    // report health for a tick that then threw.
    await touchWorkerHeartbeat(JOB_LOOP_HEARTBEAT, POLL_INTERVAL_MS);
    if (!drained) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

/**
 * Starts every background loop this platform needs: the job-queue consumer,
 * the Telegram long-poll listener, notification dispatch/digest, and the
 * time-based sweeps.
 *
 * SINGLE-PROCESS MODEL (owner decision, 2026-09-02). These used to run as a
 * second process (`dist/worker.js`) started with a different command against
 * the same image. That is now gone, and `src/server.ts` calls this after it
 * starts listening. The reason is not elegance — it is that the second process
 * was never actually deployed: `infra/` defines only `databounty-api.service`
 * and the rebuild's server started no loops, so on the deployed box nothing
 * drained the queue. Submissions never validated, pools never sampled, karma
 * never released, notifications never delivered — with no error anywhere,
 * because the work was simply never picked up. One process cannot be half
 * deployed.
 *
 * TRADE-OFF, stated plainly: heavy jobs (sandbox execution, LLM review, large
 * file parses) now share a CPU with web requests, so API latency rises while a
 * big job runs. On a single instance that was already true — a separate
 * process on the same box competes for the same core.
 *
 * SCALING RULE: this is safe while ONE instance runs. Two API instances would
 * both run the time-based sweeps. The job queue itself is safe under
 * concurrency (the claim is a guarded compare-and-swap, so two workers cannot
 * take one row), but the sweeps are not partitioned. If the API is ever put
 * behind a load balancer with more than one instance, split these back out
 * into a dedicated process — the export below is all that is needed to do it.
 */
export function startBackgroundWorkers(): void {
  // Fire-and-forget: the job loop never returns. An escaped rejection would
  // otherwise become an unhandled rejection and take the API down with it.
  void runJobQueueLoop().catch((err) => {
    console.error("[worker] job-queue loop exited unexpectedly:", err);
  });

  // Independent of the job-queue loop above — Telegram link confirmation is a
  // continuous long-poll listener, not a discrete per-row job, so it runs as
  // its own loop rather than forcing it into the JobQueue shape.
  void runTelegramPollLoop();

  // Notification delivery. Until now nothing drained the notification outbox, so
  // every recorded notification stayed undelivered — 371 rows, zero deliveries.
  // These poll notification/delivery rows directly rather than JobQueue, so no
  // JobType change is needed. Both timers unref(), so the job loop above still
  // owns process lifetime and shutdown is unchanged. The per-delivery lease claim
  // inside dispatchPendingNotifications makes running several instances safe:
  // the loser of a claim never sends.
  createHeartbeatWorker({
    name: "dispatch",
    runOnce: () => dispatchPendingNotifications(),
    intervalMs: Number(process.env.NOTIFICATIONS_DISPATCH_INTERVAL_MS ?? 15_000),
  }).start();

  // The flusher self-gates on the admin-configured digest time, so a frequent
  // tick is cheap: it returns immediately until the local schedule is due.
  createHeartbeatWorker({
    name: "digest",
    runOnce: () => flushDigests(),
    intervalMs: Number(process.env.NOTIFICATIONS_DIGEST_INTERVAL_MS ?? 300_000),
  }).start();

  // T3 — the reaper (services/audit-lifecycle.ts). Runs on the same generic
  // interval-worker runtime as the two notification workers above (it knows
  // nothing about channels; `createNotificationWorker` is really just "run
  // this async function on an interval, never overlapping, never fatal" —
  // reused here rather than hand-rolling a second copy of that scheduling
  // logic). Without this, a claimed HumanAuditWindow that its validator
  // abandons is stranded forever — nothing else ever clears
  // claimedByUserId/claimExpiresAt.
  createHeartbeatWorker({
    name: "audit-reaper",
    runOnce: () => releaseOverdueAudits(),
    intervalMs: Number(process.env.AUDIT_REAPER_INTERVAL_MS ?? 300_000),
  }).start();

  // services/karma-holds.ts — a held award that has passed its dispute window
  // needs something to actually pay it out. Without this worker,
  // PendingKarmaAward rows just accumulate forever and no karma held under
  // `community.karma_holds.enabled` is ever converted into a real KarmaEvent,
  // even once the window has closed. Same interval-worker runtime as the
  // notification/audit-reaper workers above.
  createHeartbeatWorker({
    name: "karma-hold-release",
    runOnce: () => releaseDueKarmaHolds(),
    intervalMs: Number(process.env.KARMA_HOLD_RELEASE_INTERVAL_MS ?? 300_000),
  }).start();

  // MCP OAuth: expired requests/codes/tokens, plus client registrations that
  // have gone entirely unused for a day (see cleanupMcpOAuth's own doc for
  // why that predicate is safe). Without this, POST /mcp/oauth/register
  // (unauthenticated, RFC 7591) grows oauth_clients without bound — Zed alone
  // re-registers on every connection because its callback port changes.
  createHeartbeatWorker({
    name: "mcp-oauth-cleanup",
    runOnce: () => cleanupMcpOAuth(),
    intervalMs: Number(process.env.MCP_OAUTH_CLEANUP_INTERVAL_MS ?? 300_000),
  }).start();

  /* ==========================================================================
   * Sweep PRODUCERS
   *
   * The job types below have no request-path producer by design — they are
   * platform maintenance or backstops. Each sweep is idempotent on a time
   * bucket (or on a per-row terminal marker), so a tick with nothing eligible is
   * a cheap no-op and several worker processes ticking together still enqueue
   * one job per window. Mirrors the equivalent tick entries in v1's worker.
   * ======================================================================== */

  // Retention: quarantine + release provider-side multipart state for upload
  // slots whose `uploadExpiresAt` (plus the admin-configured grace) has passed.
  // Also re-arms format-registry stages whose handler version has moved on —
  // that staleness scan is what makes a handler-version bump mean something
  // instead of needing somebody to remember to flip a flag.
  createHeartbeatWorker({
    name: "artifact-sweeps",
    runOnce: async () => {
      await enqueueExpiredUploadPurge();
      await enqueueStaleFormatRechecks();
    },
    intervalMs: Number(process.env.ARTIFACT_SWEEP_INTERVAL_MS ?? 300_000),
  }).start();

  // Agent-issues support channel: retention purge, aging escalation, and
  // canonical-outcome fan-out. Each self-limits (retention to terminal cases past
  // `agent_issues.retention_days`, escalation to open cases past their impact's
  // threshold), so this is always registered rather than gated on a flag.
  createHeartbeatWorker({
    name: "agent-issue-sweeps",
    runOnce: () => enqueueAgentIssueSweeps(),
    intervalMs: Number(process.env.AGENT_ISSUE_SWEEP_INTERVAL_MS ?? 300_000),
  }).start();

  // Leaderboard movement backstop. `awardKarma` enqueues a rank check directly
  // (immediate, no polling lag); this sweep only catches a member whose award
  // path failed to enqueue, and the time-bucketed queue key collapses the
  // overlap into one job.
  createHeartbeatWorker({
    name: "leaderboard-rank-sweep",
    runOnce: () => enqueueDueLeaderboardRankChecks(),
    intervalMs: Number(process.env.LEADERBOARD_SWEEP_INTERVAL_MS ?? 600_000),
  }).start();

  // "Your domain is live" waitlist mail. Keyed on the domain alone, and
  // `WaitlistSignup.notifiedAt` makes each recipient single-send, so this is
  // safe to run every tick.
  createHeartbeatWorker({
    name: "waitlist-notify-sweep",
    runOnce: () => enqueueDueDomainLiveNotifications(),
    intervalMs: Number(process.env.WAITLIST_SWEEP_INTERVAL_MS ?? 600_000),
  }).start();

  // The same tick recounts every still-open community pool's
  // `acceptedItems`/`finalAcceptedItems` from its submission rows
  // (reconcileOpenCommunityPools): flagged/rejected items release their
  // capacity slots, and a pool whose true count already reached its target
  // closes and enqueues sampling. Self-healing for the counter drift that
  // existed before every membership transition recounted inline — no manual
  // data fix needed.
  createHeartbeatWorker({
    name: "pool-reconcile-and-settle",
    runOnce: async () => {
      const reconciled = await reconcileOpenCommunityPools();
      // Same tick, after reconcile: a pool reconcile just closed is exactly
      // the case whose dispute window should now start being watched, and a
      // pool that closed on a PRIOR tick may have just crossed its window.
      // This is the step that was missing entirely before today — closing
      // and sampling worked, but nothing ever settled a closed pool into a
      // final `completed`/`partially_completed` status, so it stayed
      // `active` (and invisible on the public delivered-datasets listing)
      // forever, however long ago it actually finished.
      const settled = await settleDueCommunityPools();
      return { ...reconciled, ...settled };
    },
    intervalMs: Number(process.env.POOL_RECONCILE_INTERVAL_MS ?? 600_000),
  }).start();

  // Credential re-verification scanner. Enqueues only — it never calls an
  // identity provider itself; the `profile_source.verify` handler does that
  // inside the worker. Without this, a credential verified once at connect time
  // was trusted forever and kept paying reputation points after its grant was
  // revoked.
  createHeartbeatWorker({
    name: "profile-source-revalidation",
    runOnce: () => revalidateDueProfileSources(),
    intervalMs: Number(process.env.PROFILE_SOURCE_SWEEP_INTERVAL_MS ?? 600_000),
  }).start();

  /* ==========================================================================
   * Operational telemetry
   *
   * Both loops below are heartbeat-wrapped like every other worker, so the
   * watchdog can detect the watchdog itself dying.
   * ======================================================================= */

  // The detector behind admin → health. Turns the silent failure modes (a job
  // backlog nobody is draining, a dead-lettered job, a worker loop that stopped
  // ticking, an open provider circuit, a submission stranded with no live
  // validation job) into deduped SystemAlert rows and ONE admin notification per
  // activation. Until this landed, `admin.system_alert` and
  // `admin.system_recovered` existed in the notification catalog with no emitter
  // and the health page's `activeAlerts` list was permanently empty.
  createHeartbeatWorker({
    name: "watchdog",
    runOnce: () => runWatchdogSweep(),
    intervalMs: Number(process.env.WATCHDOG_INTERVAL_MS ?? 60_000),
  }).start();

  // Refreshes the rolling-7-day quality snapshot the admin overview and
  // submissions routes read. Without it those routes recompute four aggregates
  // over submissions/validation_results on every page load.
  createHeartbeatWorker({
    name: "admin-metrics-snapshot",
    runOnce: () => refreshCommunityQualityMetricsSnapshot(),
    intervalMs: Number(process.env.ADMIN_METRICS_SNAPSHOT_INTERVAL_MS ?? 300_000),
  }).start();

}
