// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { JobStatus, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Every job type this deployment can enqueue. The invariant that matters:
 * a type declared here MUST have a real handler in `worker.ts` and at least
 * one real producer. A declared-but-unhandled type is worse than a missing
 * feature — it lets a call site enqueue work that is never done, with no
 * visible symptom beyond rows sitting `pending` forever.
 *
 * Scope authority is `phase0/job-disposition.csv`: every row designated
 * Community / Community+Infra / Community+Enterprise is represented here.
 * These v1 types are deliberately absent:
 *   - `batches.materialize` — designated Enterprise-only (paid batch/financial
 *     lifecycle), recreated in the private enterprise app, not here.
 *   - `community.item_sync` — v1's own handler comment says nothing enqueues
 *     it any more; it exists there solely to DRAIN rows written before
 *     community datasets moved to whole-pool publication. A fresh rebuild has
 *     no such rows, so porting it would create a declared type with no
 *     producer by construction.
 *   - `agent_issue.enrich` — v1 resolves the resources a reporter NAMED into
 *     an authorized snapshot. This rebuild's intake (services/issues.ts)
 *     stores no claimed-resource context and has no ContextCollector, so the
 *     handler would have nothing to read; the fingerprint it fed is computed
 *     from (category, summary) alone. See services/jobs/agent-issue-jobs.ts.
 *   - `pool.audit_window.eligible` — the ONLY consumer of this signal is the
 *     §3.3d *rolling* human-audit-window mode, which this rebuild deliberately
 *     did not build (see the SCOPE DECISION block at the top of
 *     services/pool-lifecycle.ts, and note that
 *     `community.rolling_human_audit_windows.enabled` appears nowhere in this
 *     codebase or its admin-settings catalog). A handler for it would have to
 *     invent that feature; a no-op handler would be worse still, since it
 *     would make an unbuilt mode look wired.
 *   - `community.publish.github` / `community.publish.aikosh` — v1 enqueues
 *     ONE job PER publication target so an older worker mid-rolling-deploy
 *     cannot claim a target it does not understand. This rebuild instead
 *     publishes all targets inside the single `community.publish` job
 *     (services/community-publish.ts:`enqueueCommunityPublish` — "One job per
 *     bounty; the job itself fans out to every configured target"), with
 *     per-target isolation on the `DatasetPublication` rows, so the per-target
 *     types have no producer by construction. `aikosh` additionally has no
 *     provider at all here: `lib/publication/index.ts` documents it as an
 *     out-of-scope manual-portal target with no factory, so `PUBLICATION_TARGETS`
 *     is `["huggingface", "github"]` and aikosh can never be selected.
 */
export type JobType =
  // --- Artifacts / format registry -----------------------------------------
  | "artifact.scan"
  /** Untenanted retention sweep: quarantines + releases provider-side
   * multipart state for upload slots whose `uploadExpiresAt` (plus the
   * admin-configured grace) has passed. Without it, `pending_upload` rows and
   * orphaned multipart parts accumulate forever. Payload: `{}`. */
  | "artifact.purge_expired_uploads"
  /** Format-registry stages. Keyed `${artifactId}:${type}:${handler.version}`
   * so a handler-version bump is what re-arms a recheck — never a flag
   * somebody has to remember to flip. Payload: `{ artifactId }`. */
  | "artifact.parse"
  | "artifact.preview"
  | "artifact.similarity_check"
  /** Streams a `bulk_submission_source` artifact into reviewable
   * `SubmissionUploadDraftItem` rows in bounded chunks, resumable via
   * `Artifact.bulkParseCursor`. Payload: `{ artifactId }`. */
  | "bulk_source.parse"
  /** Ingests one already-reviewed `SubmissionUploadDraft`'s usable rows into
   * real `Submission` rows, in bounded chunks, resumable via
   * `SubmissionUploadDraft.submitCursorRowNumber`. Enqueued exactly once by
   * `POST /v1/upload-review-drafts/:id/submit` after it CAS-claims the draft
   * into `submitting` — never re-armed by any other caller, so this job's
   * idempotency key is never shared with another actor's lifecycle writes.
   * Payload: `{ draftId }`. See services/jobs/upload-draft-submit.ts. */
  | "upload_draft.submit"
  /** Evidence pass over one sponsor reference sample (is it ONE example? is it
   * a near-duplicate of a sibling?). Payload: `{ artifactId }`. */
  | "sponsor_reference.review"
  // --- Validation / pool ----------------------------------------------------
  | "validation.run"
  | "pool.sampling"
  // --- Publication ----------------------------------------------------------
  /** Publish one bounty to every configured target. Unlike v1 this is a SINGLE
   * job that fans out internally (services/community-publish.ts
   * `runCommunityPublishJob` loops `PUBLICATION_TARGETS`, isolating each
   * target's failure on its own `DatasetPublication` row) — see the removal
   * note below for why the per-target types are absent. Payload:
   * `{ bountyId }`. */
  | "community.publish"
  /** Withdraw one bounty from every target it is currently published to.
   * Mirrors `community.publish`: a single job fanning out internally, each
   * target's failure isolated on its own `DatasetPublication` row. A target is
   * only recorded `retracted` once the provider CONFIRMS the withdrawal — a
   * throw leaves the row `published`, because a dataset that is still publicly
   * reachable must never be shown as retracted. Payload: `{ bountyId }`. */
  | "community.unpublish"
  // --- Credentials ----------------------------------------------------------
  /** One provider identity re-check for a connected credential.
   * Payload: `{ profileSourceId, checkType, verificationKey }`. */
  | "profile_source.verify"
  // --- Benchmarks (identifiers only — private holdout bytes never travel in a
  //     queue payload; the trusted worker resolves them from the DB) ---------
  | "benchmark.version_build"
  | "benchmark.run_evaluation"
  // --- Notifications --------------------------------------------------------
  /** Durable watcher fan-out. Payload: see `WatcherFanoutPayload`. */
  | "notifications.fanout_watchers"
  /** "your domain is live" launch email to anonymous waitlist signups.
   * Payload: `{ domain }`. */
  | "waitlist.notify_domain_live"
  // --- Agent issues (support channel) ---------------------------------------
  | "agent_issue.purge_expired"
  | "agent_issue.duplicate_candidates"
  | "agent_issue.notify_filed"
  | "agent_issue.escalation_sweep"
  | "agent_issue.escalate"
  | "agent_issue.notify_canonical_outcome"
  // --- Leaderboard ----------------------------------------------------------
  /** Recomputes one member's Open-leaderboard position after their karma
   * changed and announces a real improvement. Payload: `{ userId }`. */
  | "leaderboard.rank_check"
  // Proof run for an admin-authored bound harness on a sponsor custom/forked
  // dataset type (ported from v1's `harness.proof_run`; see
  // routes/v1/admin-harness.ts): executes the drafted harness against
  // admin-supplied expected-pass/expected-fail samples in the real sandbox
  // chain and records write-once evidence on the harness row. Payload shape:
  // `{ harnessId: string; datasetTypeId: string; sourceSha: string; samples:
  // Array<{ payload: Record<string, unknown>; expected: "pass" | "fail";
  // label?: string }> }`.
  | "harness.proof_run";

/**
 * Payload contract per job type. Enforced at the `enqueueJob()` boundary so a
 * producer cannot hand a handler a shape it does not read — the failure mode
 * this file exists to prevent is a job that runs, finds nothing usable in its
 * payload, and completes as if it did its work.
 */
export interface JobPayloads {
  "artifact.scan": { artifactId: string };
  "artifact.purge_expired_uploads": Record<string, never>;
  "artifact.parse": { artifactId: string };
  "artifact.preview": { artifactId: string };
  "artifact.similarity_check": { artifactId: string };
  "bulk_source.parse": { artifactId: string };
  "upload_draft.submit": { draftId: string };
  "sponsor_reference.review": { artifactId: string };
  "validation.run": { submissionId: string; validationAttempt?: number };
  "pool.sampling": { bountyId: string };
  "community.publish": { bountyId: string };
  "community.unpublish": { bountyId: string };
  "profile_source.verify": { profileSourceId: string; checkType: "initial" | "recheck"; verificationKey: string };
  "benchmark.version_build": { benchmarkVersionId: string };
  "benchmark.run_evaluation": { benchmarkRunId: string };
  "notifications.fanout_watchers": WatcherFanoutPayload;
  "waitlist.notify_domain_live": { domain: string };
  "agent_issue.purge_expired": Record<string, never>;
  "agent_issue.duplicate_candidates": { issueId: string; fingerprintVersion: number };
  "agent_issue.notify_filed": { issueId: string };
  "agent_issue.escalation_sweep": Record<string, never>;
  "agent_issue.escalate": { issueId: string; policyVersion: number };
  "agent_issue.notify_canonical_outcome": { canonicalIssueId: string; version: number };
  "leaderboard.rank_check": { userId: string };
  "harness.proof_run": {
    harnessId: string;
    datasetTypeId: string;
    sourceSha: string;
    samples: Array<{ payload: Record<string, unknown>; expected: "pass" | "fail"; label?: string }>;
  };
}

/** Watcher fan-out payload. Carries the match axes rather than re-reading the
 * bounty, so a bounty edited between enqueue and run cannot silently change
 * who a queued alert reaches. */
export interface WatcherFanoutPayload {
  kind: "new_work_match" | "audit_available";
  entityId: string;
  bountyTitle: string;
  domain: string;
  datasetCategory: string;
  language: string;
  requesterUserId: string;
}

/** Fallback lease when a caller doesn't pass one explicitly. Callers with a
 * job type whose worst-case handler runs longer than this MUST pass their own
 * (larger) `leaseMs` — see `worker.ts` for the per-type values used there. */
const DEFAULT_LEASE_MS = 5 * 60_000;

export interface JobEnvelope<T = Record<string, unknown>> {
  id: string;
  type: JobType;
  idempotencyKey: string;
  payload: T;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
}

export const dbJobQueue = {
  /**
   * `tx` makes this a true transactional outbox write: the queue row and the
   * business change it reacts to commit or roll back together. Omit it only
   * when the producer genuinely has nothing to be atomic with (a periodic
   * sweep, a post-commit follow-up).
   *
   * `runAfter` delays first eligibility by stamping `nextAttemptAt` — the same
   * column `claim()` already treats as "due at". Used by coalescing producers
   * (leaderboard rank checks) that want the job to read a settled balance
   * instead of racing the middle of a bulk acceptance.
   */
  async enqueue<T extends Record<string, unknown>>(
    params: {
      type: JobType;
      idempotencyKey: string;
      payload: T;
      maxAttempts?: number;
      workspaceId?: string;
      runAfter?: Date;
    },
    tx?: Prisma.TransactionClient
  ): Promise<string> {
    const client = tx ?? prisma;

    // Re-arm is intentional and several producers rely on it: the format-registry
    // sweep re-arms stages whose handler version moved on (worker.ts), an
    // upload-review draft re-attach resumes a parse from its persisted cursor
    // (routes/v1/upload-review-drafts.ts), and a policy change re-arms an
    // escalation alert. What it must NOT do is re-arm a row a worker is holding
    // right now: the previous `upsert` flipped ANY existing row back to
    // `pending`, so a second worker could claim it and run the handler
    // concurrently with itself — and a `done` row could be resurrected and
    // re-run. `bulk_source.parse` is shared by two producers on one idempotency
    // key, which is exactly where that double-write would land.
    //
    // So: read first, leave `processing` alone, and re-arm only an idle row.
    // The read/create race is still possible and still lands in the recovery
    // path below, same as before.
    const existing = await client.jobQueue.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
      select: { id: true, status: true },
    });

    if (existing) {
      if (existing.status === JobStatus.processing) return existing.id;
      // `updateMany` + a status guard so a worker claiming the row between the
      // read above and this write wins the race instead of being clobbered.
      // `attempts: 0` resets the retry budget, which is the point of an
      // explicit re-arm — a `dead` row left at attempts=maxAttempts would
      // otherwise be re-armed straight back to `dead` on its next claim.
      await client.jobQueue.updateMany({
        where: { idempotencyKey: params.idempotencyKey, status: { not: JobStatus.processing } },
        data: {
          status: JobStatus.pending,
          payload: params.payload as Prisma.InputJsonValue,
          attempts: 0,
          lastError: null,
          finishedAt: null,
          nextAttemptAt: params.runAfter ?? new Date(),
        },
      });
      return existing.id;
    }

    try {
      const row = await client.jobQueue.create({
        data: {
          type: params.type,
          idempotencyKey: params.idempotencyKey,
          payload: params.payload as Prisma.InputJsonValue,
          maxAttempts: params.maxAttempts ?? 5,
          status: JobStatus.pending,
          workspaceId: params.workspaceId,
          // Always stamped, never NULL. The watchdog's age-based backlog
          // alarms filter on `nextAttemptAt <= now`, and a NULL row is
          // invisible to that filter — which made both OLDEST_PENDING
          // thresholds unfirable for every producer that omits `runAfter`.
          nextAttemptAt: params.runAfter ?? new Date(),
        },
      });
      return row.id;
    } catch {
      // Inside a caller's transaction a failed statement aborts the whole tx,
      // so the recovery read below would fail too — and swallowing the error
      // would report success for a row that will never exist. Only the
      // standalone path gets the "someone else already enqueued it" recovery.
      if (tx) throw new Error(`failed to enqueue ${params.type}`);
      const existing = await prisma.jobQueue.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
      });
      return existing?.id ?? "";
    }
  },

  /**
   * `leaseMs` bounds how long a claimed job may sit `processing` before it
   * becomes reclaimable again. Before this, a worker process that crashed or
   * was killed mid-handler (a real risk for `validation.run`'s sandbox/LLM
   * calls, and for `harness.proof_run`'s sequential sandbox samples — both
   * can hang or OOM-kill the process) left its job row `processing` forever:
   * never retried, never dead-lettered, no visible symptom beyond a silently
   * growing count of stale `processing` rows.
   *
   * Matches v1's design (`databounty-api/src/services/jobs.ts` `claim()`):
   * `nextAttemptAt` is reused as the lease-expiry column rather than adding a
   * separate `leaseExpiresAt` — on claim it is stamped `now + leaseMs`, and
   * the same column already served retry backoff for `pending`/`failed` rows,
   * so a `processing` row whose `nextAttemptAt` has passed simply becomes due
   * again. This is self-healing: reclaim is a WHERE-clause condition inside
   * `claim()` itself, no separate reaper worker/tick needed. Unlike v1, this
   * is a single-candidate Prisma-level claim (not the raw-SQL
   * `FOR UPDATE SKIP LOCKED` batch claim) — matching the loop shape this
   * function already had; the optimistic `updateMany` + re-fetch below still
   * makes concurrent claimers race-safe (the loser gets `count === 0`).
   */
  async claim(types: JobType[], leaseMs = DEFAULT_LEASE_MS): Promise<JobEnvelope | null> {
    const now = new Date();
    const candidate = await prisma.jobQueue.findFirst({
      where: {
        type: { in: types },
        OR: [
          { status: JobStatus.pending, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          // Retry: `fail()` parks a row as `failed` with a backoff stamped in
          // `nextAttemptAt`. Without this arm that row is never claimed again,
          // which made `maxAttempts` (default 5) effectively 1 — every
          // transient error became permanent, `dead` was unreachable, and the
          // `job_dead_letter` alert could never fire. This matches v1's own
          // claim CTE, which claims this state explicitly:
          // `status = 'failed' AND next_attempt_at <= now`.
          { status: JobStatus.failed, nextAttemptAt: { lte: now } },
          // Reclaim: a `processing` row whose lease has expired — its worker
          // never called complete()/fail(), so it never advanced past
          // `processing` on its own.
          { status: JobStatus.processing, nextAttemptAt: { lte: now } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });

    if (!candidate) return null;

    const leaseUntil = new Date(now.getTime() + leaseMs);

    try {
      // `updateMany` (not `update`) so the guard can express "still pending,
      // OR still processing with an expired lease" without relying on
      // Prisma's extended-where-unique support for a non-unique second field.
      // A concurrent claimer that already reclaimed this exact row makes this
      // a no-op (`count === 0`), which is the same "lost the race" outcome
      // the previous single-candidate `update` produced via a thrown P2025.
      const result = await prisma.jobQueue.updateMany({
        where: {
          id: candidate.id,
          OR: [
            { status: JobStatus.pending },
            { status: JobStatus.failed, nextAttemptAt: { lte: now } },
            { status: JobStatus.processing, nextAttemptAt: { lte: now } },
          ],
        },
        data: {
          status: JobStatus.processing,
          attempts: { increment: 1 },
          startedAt: candidate.startedAt ?? now,
          nextAttemptAt: leaseUntil,
        },
      });

      if (result.count === 0) return null;

      const updated = await prisma.jobQueue.findUnique({ where: { id: candidate.id } });
      if (!updated) return null;

      return {
        id: updated.id,
        type: updated.type as JobType,
        idempotencyKey: updated.idempotencyKey,
        payload: updated.payload as Record<string, unknown>,
        status: updated.status,
        attempts: updated.attempts,
        maxAttempts: updated.maxAttempts,
      };
    } catch {
      return null;
    }
  },

  async complete(jobId: string): Promise<void> {
    await prisma.jobQueue.update({
      where: { id: jobId },
      data: {
        status: JobStatus.done,
        finishedAt: new Date(),
      },
    }).catch((err) => {
      // Swallowing this left a completed job stuck in `processing` with no
      // trace; the lease reclaim re-runs it (at-least-once, acceptable) but an
      // operator had nothing to go on. Log, don't throw: throwing here would
      // re-fail an already-successful handler.
      console.error(`[jobs] complete() failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  },

  async fail(jobId: string, error: string): Promise<void> {
    const job = await prisma.jobQueue.findUnique({ where: { id: jobId } });
    if (!job) return;

    const attempts = job.attempts;
    const isDead = attempts >= job.maxAttempts;
    const nextAttemptAt = isDead ? null : new Date(Date.now() + Math.min(60 * 60, Math.pow(2, attempts) * 10) * 1000);

    await prisma.jobQueue.update({
      where: { id: jobId },
      data: {
        status: isDead ? JobStatus.dead : JobStatus.failed,
        lastError: error.slice(0, 1000),
        nextAttemptAt,
        finishedAt: isDead ? new Date() : null,
      },
    }).catch((err) => {
      console.error(`[jobs] fail() failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  },
};

/**
 * Stable JSON: object keys sorted, no insignificant whitespace. Used only to
 * derive a deterministic default idempotency key, so `{a:1,b:2}` and
 * `{b:2,a:1}` are the same job rather than two.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Typed producer façade. Preferred over calling `dbJobQueue.enqueue` directly
 * because the payload is checked against {@link JobPayloads} for the given
 * type — a producer cannot hand a handler a shape it does not read.
 *
 * The default idempotency key is `${type}:sha256(stableJson(payload))`, which
 * is exactly the right grain for the identifier-only payloads this queue uses:
 * `enqueueJob("benchmark.version_build", { benchmarkVersionId })` collapses to
 * one job per version however many times it is called. Pass an explicit
 * `idempotencyKey` when the dedupe grain is NOT the payload (a time-bucketed
 * sweep, a handler-version-keyed recheck).
 */
export async function enqueueJob<T extends JobType>(
  type: T,
  payload: JobPayloads[T],
  opts: {
    idempotencyKey?: string;
    maxAttempts?: number;
    workspaceId?: string;
    runAfter?: Date;
    tx?: Prisma.TransactionClient;
  } = {}
): Promise<string> {
  const key =
    opts.idempotencyKey ??
    `${type}:${createHash("sha256").update(stableJson(payload)).digest("hex").slice(0, 32)}`;
  return dbJobQueue.enqueue(
    {
      type,
      idempotencyKey: key,
      payload: payload as unknown as Record<string, unknown>,
      maxAttempts: opts.maxAttempts,
      workspaceId: opts.workspaceId,
      runAfter: opts.runAfter,
    },
    opts.tx
  );
}

/**
 * Deterministic personal-workspace id for a user — the fairness partition key
 * a tenant-owned job should carry. A pure string function on purpose: enqueue
 * must never have to hit the database (or fail) just to label a job with its
 * tenant, and `job_queue.workspace_id` has no FK, so this works even for a
 * user whose workspace row was never provisioned.
 */
export function workspaceKeyForUser(userId: string): string {
  return `ws_${userId}`;
}
