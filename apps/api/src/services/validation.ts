// SPDX-License-Identifier: Apache-2.0

import { KarmaEventType, SubmissionStatus, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { awardKarma } from "./karma.js";
import { notifyUser, notifyValidationStageResults } from "./notifications.js";
import { checkAndClosePoolIfTargetReached, claimPoolAcceptanceSlot } from "./pool-lifecycle.js";
import { openRouterConfigured } from "./llm-client.js";
import { reviewSubmission } from "./llm/consumers/review.js";
import { runExecution, executionToStageResult } from "./execution.js";
import type { ExecutionOutcome, ExecutionPending } from "./execution.js";
import { checkAiAttribution } from "./ai-attribution.js";
import { getAdminSetting, llmValidationEnabled } from "./admin-settings.js";

interface DatasetField {
  key: string;
  role?: string;
  lang?: string;
}

/**
 * The `executionEnv` string the dataset type declares, echoed into the evidence
 * row's pending detail so a reviewer can see what the type EXPECTED to run in,
 * even when nothing ran.
 */
function executionEnvOf(verification: unknown): string {
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) return "";
  const env = (verification as { executionEnv?: unknown }).executionEnv;
  return typeof env === "string" ? env : "";
}

/**
 * Wraps `claimPoolAcceptanceSlot` with a replay guard so re-running the SAME
 * (submissionId, validationAttempt) pair — a crash-retry of the
 * `validation.run` job, or a direct replay, both real possibilities this
 * codebase's other stages are already written to tolerate (see
 * notifyEvent's own idempotency) — never asks a target that this exact
 * submission already filled to grant it a SECOND slot, and never re-decides
 * an outcome this exact attempt already reached.
 *
 * Without this guard, replaying the same attempt after it already won a slot
 * would call `claimPoolAcceptanceSlot` again, find the target it just filled
 * no longer has room (because THIS submission counted against it last time),
 * and incorrectly flip an already-accepted submission to `rejected` on
 * nothing more than a harmless retry.
 *
 * `sub.status` is read from the caller's own top-of-function fetch, which on
 * a replay reflects the outcome the PRIOR run already wrote — so this is a
 * cheap in-memory check, not an extra query, for the "already won" case. The
 * "already lost" case is looked up explicitly by the `pool_capacity`
 * ValidationResult row this same function writes on loss (rather than
 * generic `status === rejected`, which could also mean a dedupe/quality
 * rejection from a different code path).
 */
async function resolvePoolAcceptance(
  tx: Prisma.TransactionClient,
  sub: { id: string; bountyId: string; status: SubmissionStatus },
  validationAttempt: number,
): Promise<boolean> {
  if (sub.status === SubmissionStatus.accepted_pending_sample) return true;
  const priorCapacityLoss = await tx.validationResult.findFirst({
    where: { submissionId: sub.id, validationAttempt, stage: "pool_capacity" },
    select: { id: true },
  });
  if (priorCapacityLoss) return false;
  return claimPoolAcceptanceSlot(tx, sub.bountyId);
}

export async function runSubmissionValidation(submissionId: string, validationAttempt = 0) {
  const sub = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { bounty: { include: { datasetType: true } } },
  });

  if (!sub) return;

  // 1. Stage: Duplicate Check — real, computed at submit time from an actual
  // DB lookup (see createBountyPoolItems/submitPoolBatchItems). Nothing
  // fabricated here.
  //
  // Two-tier thresholds, matching V1's evaluateDuplicate() design
  // (databounty-api/src/services/contamination.ts): `review_threshold` is a
  // probabilistic near-dup signal routed to a human instead of auto-rejected
  // (text-similarity systems can false-positive on legitimately
  // similar-but-distinct content, e.g. two independent FizzBuzz solutions,
  // and auto-rejecting them destroys valid work); only `reject_threshold`
  // and above is a near-certain duplicate, auto-rejected with no human
  // needed. Both are read live from the admin-editable
  // `validation.dedupe.review_threshold` / `validation.dedupe.reject_threshold`
  // settings (routes/v1/admin-settings.ts's catalog) rather than hardcoded, so
  // an operator's save on the /settings page actually changes what gets
  // rejected vs. flagged — the catalog's own defaultValue is passed through
  // as the fallback for an environment where the row has never been
  // explicitly set, matching the convention every other `getAdminSetting`
  // call site in this codebase uses.
  const rejectThreshold = await getAdminSetting<number>("validation.dedupe.reject_threshold", 0.9);
  const reviewThreshold = await getAdminSetting<number>("validation.dedupe.review_threshold", 0.8);
  const dedupeDecision: "accepted" | "review_required" | "rejected" =
    sub.duplicateScore === null
      ? "accepted"
      : sub.duplicateScore >= rejectThreshold
        ? "rejected"
        : sub.duplicateScore >= reviewThreshold
          ? "review_required"
          : "accepted";
  await prisma.validationResult.create({
    data: {
      submissionId: sub.id,
      validationAttempt,
      stage: "dedupe",
      passed: dedupeDecision !== "rejected",
      score: sub.duplicateScore ?? 0.0,
      detailJson: { duplicateOfSubmissionId: sub.duplicateOfSubmissionId, duplicateDecision: dedupeDecision },
    },
  });

  if (dedupeDecision === "rejected") {
    await prisma.submission.update({
      where: { id: sub.id },
      data: { status: SubmissionStatus.rejected, duplicateDecision: dedupeDecision },
    });
    await notifyValidationStageResults(prisma, {
      userId: sub.contributorUserId,
      submissionId: sub.id,
      item: sub.title,
      keyBase: `validation:${validationAttempt}`,
      linkBountyId: sub.bountyId,
      steps: [
        {
          stage: "dedupe",
          outcome: "failed",
          detail: "This item matches an existing submission on the configured dedupe fields.",
        },
      ],
    });
    return;
  }

  // Below the reject line but at/above the review line: don't block the
  // pipeline — every item that clears automation in this community-pool
  // design already lands on `accepted_pending_sample` with
  // `pendingHumanReview: true` (unconditional, see the comment further
  // down), so a validator sees the real duplicate_score as evidence and
  // makes the actual call. Record the decision on the submission row too
  // (mirrors ValidationResult's detailJson, per the Submission.duplicateDecision
  // column's own doc comment) so it's queryable without joining evidence rows.
  if (dedupeDecision === "review_required") {
    await prisma.submission.update({
      where: { id: sub.id },
      data: { duplicateDecision: dedupeDecision },
    });
  }

  // 2. Stage: AI attribution — a cheap, deterministic, dependency-free text
  // scan (services/ai-attribution.ts, ported from V1) for EXPLICIT AI/model
  // self-disclosure phrases ("as an AI language model", "generated by
  // ChatGPT", ...). No LLM call, no API key, no external service — it never
  // infers authorship from writing style.
  //
  // Unconditional by owner decision: unlike V1, where this stage is only
  // guaranteed to run because `effectiveValidationPipeline()` force-injects
  // "ai_attribution" into every dataset type's admin-configured pipeline
  // array (databounty-api/src/lib/submission-scoring.ts), this rebuild's
  // validation.ts has no such configurable pipeline array at all — every
  // stage here is hardcoded and always runs. So there is nothing to inject
  // into: this stage simply always runs, with no per-dataset-type opt-in and
  // no admin toggle, which is the same end state V1 guarantees by force.
  // That is also why "ai_attribution" is correctly excluded from the
  // `allowedStages` allowlist in routes/v1/admin-dataset-types.ts — a
  // sponsor/admin must not be able to configure this stage in or out.
  const payload = sub.payloadJson as Record<string, unknown>;
  const aiAttribution = checkAiAttribution(payload);
  await prisma.validationResult.create({
    data: {
      submissionId: sub.id,
      validationAttempt,
      stage: "ai_attribution",
      passed: aiAttribution.passed,
      score: aiAttribution.score,
      detailJson: aiAttribution.detail as Prisma.InputJsonValue,
    },
  });
  // V1's statusAfterAutomatedChecks() checks `executionFailed` BEFORE
  // `aiAttributionFlagged`: a submission whose own tests genuinely fail
  // lands on `tests_failed` regardless of an attribution flag, and a flagged
  // clean pass is forced to human review (`forced()`) rather than
  // auto-accepted. This deployment already sends EVERY automation-cleared
  // item to `accepted_pending_sample` with `pendingHumanReview: true`
  // unconditionally (see the comment on that transaction below), and a
  // failed-execution item still lands on `tests_failed` regardless of this
  // flag — so the same priority order falls out naturally without extra
  // branching. If a future change ever makes human review NOT mandatory for
  // a clean pass, `aiAttribution.passed === false` must be added back as an
  // explicit forcing condition on the accepted_pending_sample branch below.

  // 3. Stage: Execution — runs the submitted tests against the submitted
  // solution INSIDE AN ISOLATED SANDBOX (services/execution-providers/), never
  // in this process. `runExecution` either returns a real verdict from a
  // provider that ran it, or an explicit "no verdict" (`ExecutionPending`).
  //
  // FAIL CLOSED. When no provider is configured — no E2B_API_KEY — the pending
  // reason is `no_provider_configured` and NOTHING is executed anywhere: there
  // is no in-process fallback on this path or any other. `isolationVerified` is
  // recorded from what the provider actually attested (`raw.isolation.verified`)
  // and is null when no run happened, so a skipped check can never be rendered
  // as a passed one.
  const fields = (sub.bounty.datasetType?.fields as unknown as DatasetField[]) ?? [];

  let execution: ExecutionOutcome | ExecutionPending;
  if (!sub.bounty.datasetType) {
    // No contract at all to resolve a harness from — honest "not attempted",
    // handled by exactly the same human-review route as every other hold.
    execution = { available: false, reason: "no_executable_harness", attempts: [] };
  } else {
    execution = await runExecution({
      datasetType: sub.bounty.datasetType,
      payload,
      requestId: `${sub.id}:${validationAttempt}`,
    });
  }
  const executionEnv = executionEnvOf(sub.bounty.datasetType?.verification);
  const execStage = executionToStageResult(execution, executionEnv);
  await prisma.validationResult.create({
    data: {
      submissionId: sub.id,
      validationAttempt,
      stage: "execution",
      passed: execStage.passed,
      score: execStage.score,
      // `runner_completed` ONLY when a sandbox produced a real verdict. Every
      // other value names the specific reason nothing was verified, so the UI's
      // trust claim matches the stored evidence.
      outcome: execution.available ? "runner_completed" : execution.reason,
      durationMs: execution.available ? execution.durationMs : null,
      provider: execution.available ? execution.provider : null,
      // NULL (not false) when no run happened: "unknown/not attempted" is a
      // different claim from "ran, unverified". Never hardcoded true.
      isolationVerified: execution.available ? execution.isolationVerified : null,
      detailJson: execStage.detail as Prisma.InputJsonValue,
    },
  });

  if (!execStage.passed) {
    // A submission is only told its own tests failed when a sandbox actually
    // RAN them and they failed. Every non-verdict — no configured sandbox, a
    // provider that failed, a missing runtime, an infrastructure fault, or no
    // resolvable harness — means we genuinely couldn't verify, which is not the
    // same claim as "tests failed" and must not land the item on tests_failed.
    // Those all take the accepted_pending_sample + pendingHumanReview path, so a
    // validator (via the real HumanAuditWindow sampling mechanism) makes the
    // actual call instead of either side silently winning.
    if (!execution.available) {
      // Cleared automation, but a pool capacity slot must be atomically
      // claimed before this item can actually be counted as accepted — see
      // claimPoolAcceptanceSlot's own doc comment (services/pool-lifecycle.ts)
      // for why the intake-time check alone is not enough.
      const wonSlot = await prisma.$transaction(async (tx) => {
        const won = await resolvePoolAcceptance(tx, sub, validationAttempt);
        await tx.submission.update({
          where: { id: sub.id },
          data: won
            ? { status: SubmissionStatus.accepted_pending_sample, pendingHumanReview: true }
            // Lost the accept-time race: the pool filled up between this
            // item's submission and its (delayed) automated pass. This is a
            // capacity outcome, not a quality one — the item is otherwise
            // identical to one that would have cleared. `rejected` is reused
            // here at parity with the existing dedupe-reject and
            // revision-cap-exceeded paths in this file/submissions.ts, which
            // also reuse it for non-quality terminal outcomes; the
            // ValidationResult row + notification below are what carry the
            // honest "capacity, not quality" distinction to the contributor.
            : { status: SubmissionStatus.rejected },
        });
        return won;
      });

      if (!wonSlot) {
        await prisma.validationResult.create({
          data: {
            submissionId: sub.id,
            validationAttempt,
            stage: "pool_capacity",
            passed: false,
            score: null,
            outcome: "pool_capacity_reached",
            detailJson: { reason: "the pool reached its item target before this submission could be counted" },
          },
        });
        await notifyUser({
          userId: sub.contributorUserId,
          type: "submission.rejected",
          title: "Pool filled before your submission could be counted",
          body: `"${sub.title}" cleared automated checks, but the pool reached its item target moments earlier and no capacity slot was left. This is not a quality rejection — your submission was valid, the pool was simply full.`,
          entityType: "Submission",
          entityId: sub.id,
          linkBountyId: sub.bountyId,
        });
        await notifyValidationStageResults(prisma, {
          userId: sub.contributorUserId,
          submissionId: sub.id,
          item: sub.title,
          keyBase: `validation:${validationAttempt}`,
          linkBountyId: sub.bountyId,
          steps: [
            { stage: "dedupe", outcome: "passed", detail: "No duplicate submission was found." },
            {
              stage: "ai_attribution",
              outcome: aiAttribution.passed ? "passed" : "flagged",
              detail: aiAttribution.passed
                ? "No explicit AI attribution or co-author disclosure was found."
                : "An explicit AI attribution or co-author disclosure was found.",
            },
            {
              stage: "pool_capacity",
              outcome: "failed",
              detail: "The pool reached its item target before this submission could be counted. Your submission was not rejected for quality — the pool was simply full.",
            },
          ],
        });
        // Harmless no-op if another writer already closed this pool (which is
        // the expected case here — losing this race means someone else's
        // accept just hit the target).
        await checkAndClosePoolIfTargetReached(sub.bountyId);
        return;
      }

      await notifyUser({
        userId: sub.contributorUserId,
        type: "submission.accepted",
        title: "Submission routed to validator review",
        body:
          execution.reason === "no_provider_configured"
            ? `"${sub.title}" was not executed — no isolated execution sandbox is configured in this environment — so it now needs a validator's review.`
            : `"${sub.title}" could not be auto-verified (${execution.reason.replace(/_/g, " ")}) and now needs a validator's review.`,
        entityType: "Submission",
        entityId: sub.id,
        linkBountyId: sub.bountyId,
      });
      await notifyValidationStageResults(prisma, {
        userId: sub.contributorUserId,
        submissionId: sub.id,
        item: sub.title,
        keyBase: `validation:${validationAttempt}`,
        linkBountyId: sub.bountyId,
        steps: [
          { stage: "dedupe", outcome: "passed", detail: "No duplicate submission was found." },
          {
            stage: "ai_attribution",
            outcome: aiAttribution.passed ? "passed" : "flagged",
            detail: aiAttribution.passed
              ? "No explicit AI attribution or co-author disclosure was found."
              : "An explicit AI attribution or co-author disclosure was found. This item is queued for validator review.",
          },
          {
            stage: "execution",
            outcome: "pending",
            detail:
              execution.reason === "no_provider_configured"
                ? "No isolated execution sandbox is configured in this environment, so a validator reviews the item instead. Nothing is wrong with your submission."
                : `Automated execution produced no result (${execution.reason.replace(/_/g, " ")}), so a validator reviews the item instead. Nothing is wrong with your submission.`,
          },
        ],
      });
      await checkAndClosePoolIfTargetReached(sub.bountyId);
      return;
    }

    await prisma.submission.update({
      where: { id: sub.id },
      data: { status: SubmissionStatus.tests_failed },
    });
    await notifyUser({
      userId: sub.contributorUserId,
      type: "submission.needs_fixes",
      title: "Submission failed tests",
      body: `Your submission "${sub.title}" failed its own tests. See execution evidence for details.`,
      entityType: "Submission",
      entityId: sub.id,
      linkBountyId: sub.bountyId,
    });
    await notifyValidationStageResults(prisma, {
      userId: sub.contributorUserId,
      submissionId: sub.id,
      item: sub.title,
      keyBase: `validation:${validationAttempt}`,
      linkBountyId: sub.bountyId,
      steps: [
        { stage: "dedupe", outcome: "passed", detail: "No duplicate submission was found." },
        {
          stage: "ai_attribution",
          outcome: aiAttribution.passed ? "passed" : "flagged",
          detail: aiAttribution.passed
            ? "No explicit AI attribution or co-author disclosure was found."
            : "An explicit AI attribution or co-author disclosure was found. This item is queued for validator review.",
        },
        {
          stage: "execution",
          outcome: "failed",
          detail: "One or more of the submission's own tests failed. See the execution evidence for details.",
        },
      ],
    });
    return;
  }

  // 4. Stage: LLM Evaluation — gated on TWO independent facts:
  //
  //   a) the `validation.llm.enabled` admin setting (read through
  //      llmValidationEnabled(), which fails closed to false). This is the
  //      PLATFORM switch. Off ⇒ the stage is dropped from the pipeline
  //      entirely: no ValidationResult row, no score, no stage step in the
  //      contributor's evidence timeline, exactly as the setting's own
  //      catalog description promises ("submissions must skip the stage
  //      entirely and record no LLM score or claim — never a fabricated
  //      pass"). This is v1's behaviour too: there,
  //      `effectiveValidationPipeline(v.pipeline, { llmEnabled })` filters
  //      "llm" out of the pipeline array so no llm row is ever written
  //      (lib/submission-scoring.ts:373). This rebuild has no configurable
  //      pipeline array to filter, so the equivalent is this branch.
  //   b) whether a provider is actually configured (OPENROUTER_API_KEY).
  //      Flag on + no provider is NOT a skip and NOT a pass: it records the
  //      honest `no_provider_configured` evidence row below, so the UI can
  //      say "on, but nothing ran" rather than either lying or going silent.
  //
  // The two are reported separately on the wire (`llmValidationEnabled` vs
  // `llmProviderConfigured`) precisely so a client can tell those two states
  // apart before any evidence row exists.
  //
  // Neither combination changes the accept/reject OUTCOME below: every item
  // that clears execution still goes to a human validator regardless of the
  // LLM's answer — `pendingHumanReview` stays unconditionally true.
  //
  // Original note on the configured case, still true — real when
  // OPENROUTER_API_KEY is configured, honestly unconfigured otherwise. Either
  // way this never changes the accept/reject OUTCOME below: every item that
  // clears execution still goes to a human validator regardless of the LLM's
  // answer — `pendingHumanReview` stays unconditionally true. What changes is
  // whether the recorded LLM evidence is a real model verdict or an honest
  // "not configured" placeholder.
  //
  // The call now runs through the LLM layer
  // (`services/llm/consumers/review.ts` -> `llm.complete()`), so the routing,
  // system prompt and params an admin sets for `submission_review` on the
  // /llm page genuinely apply to it. Before that it went straight out through
  // a hardcoded client, which meant the console offered controls that changed
  // nothing. The consumer supplies NO deterministic fallback on purpose, so an
  // unavailable or misbehaving model RAISES and lands in the catch below
  // rather than ever producing a passing verdict — read its doc comment before
  // changing anything about that call.
  //
  // (External-corpus contamination / plagiarism screening was removed from
  // this pipeline entirely per owner decision. It is not a stage here: no
  // code path writes a `contamination` stage row, and there is deliberately
  // no hardcoded stub standing in for one, because a stub that never ran
  // would be a false trust claim.)
  const llmEnabled = await llmValidationEnabled();
  let llmScoreValue: number | null = null;
  // `null` ⇒ the stage did not run at all (flag off) and must not appear in
  // the contributor's stage timeline. A step object ⇒ the stage ran or was
  // explicitly held, and says which.
  let llmStageStep: { outcome: string; detail: string } | null = null;
  if (!llmEnabled) {
    // Deliberately NOTHING here: no ValidationResult row, no score, no step.
    // See (a) above. `llmScoreValue` stays null so the submission's own
    // `llmScore` column is not written with a fabricated value either.
  } else if (openRouterConfigured()) {
    try {
      const verdict = await reviewSubmission({
        datasetTypeName: sub.bounty.datasetType?.name ?? sub.bounty.datasetCategory,
        contractFields: fields,
        payload,
        // Attribution for the layer's per-user rate limit and for the
        // `llm_audit_log` row, so a recorded verdict is traceable to the exact
        // item and attempt it judged. Not a cache key: `submission_review` is
        // proprietary-class and the service refuses to cache those, so a
        // re-run of the same attempt re-asks a live model.
        userId: sub.contributorUserId,
        idempotencySuffix: `${sub.id}:${validationAttempt}`,
      });
      llmScoreValue = verdict.score;
      await prisma.validationResult.create({
        data: {
          submissionId: sub.id,
          validationAttempt,
          stage: "llm",
          passed: verdict.passed,
          score: verdict.score,
          outcome: verdict.passed ? "llm_pass" : "llm_fail",
          detailJson: { reasons: verdict.reasons, model: verdict.model },
        },
      });
      llmStageStep = {
        outcome: verdict.passed ? "passed" : "failed",
        detail: `Quality score ${verdict.score}/100. This item still goes to a human validator before final acceptance.`,
      };
    } catch (err) {
      // A configured provider that actually failed (timeout, malformed
      // response, HTTP error, every routed model exhausted, the feature
      // disabled by an admin override, or the spend cap reached) is a
      // different honest state than "never configured" — record which one
      // happened rather than collapsing both into the same placeholder. This
      // branch is also the fail-closed landing point for the consumer's
      // deliberate lack of a deterministic fallback: no verdict, no score, and
      // the item goes to a human.
      await prisma.validationResult.create({
        data: {
          submissionId: sub.id,
          validationAttempt,
          stage: "llm",
          passed: false,
          score: null,
          outcome: "provider_error",
          detailJson: { reason: err instanceof Error ? err.message : "LLM call failed" },
        },
      });
      llmStageStep = {
        outcome: "pending",
        detail: "The configured quality reviewer failed to respond. This item goes to a human validator instead.",
      };
    }
  } else {
    await prisma.validationResult.create({
      data: {
        submissionId: sub.id,
        validationAttempt,
        stage: "llm",
        passed: false,
        score: null,
        outcome: "no_provider_configured",
        detailJson: { reason: "no LLM provider configured in this environment", status: "pending_llm_review" },
      },
    });
    llmStageStep = {
      outcome: "pending",
      detail: "No quality-review provider is configured in this environment. This item goes to a human validator instead.",
    };
  }

  // Automated pipeline could not fully clear the item on its own — this
  // deployment has no automated stage that is allowed to grant unconditional
  // `accepted`. Dedupe, AI attribution, execution and LLM can each REJECT or
  // hold an item, but none of them substitutes for human sign-off.
  // The item lands on accepted_pending_sample same as any other cleared
  // item, but with pendingHumanReview set. The pool-sampling step that later
  // resolves accepted_pending_sample into a real HumanAuditWindow
  // (COMMUNITY_OPEN_POOL_PLAN_V2 §3.3) must always select a
  // pendingHumanReview item into that window regardless of the
  // auditCoveragePct dice roll — this is the fail-closed default; it does
  // not fabricate a pass to reach unconditional `accepted`.
  // Cleared automation, but — same as the no-execution-available branch above
  // — a pool capacity slot must be atomically claimed before this item can
  // actually be counted as accepted. See claimPoolAcceptanceSlot's doc
  // comment (services/pool-lifecycle.ts) for why the intake-time check alone
  // is not enough, and why this cannot be a plain unconditional increment.
  const wonSlot = await prisma.$transaction(async (tx) => {
    const won = await resolvePoolAcceptance(tx, sub, validationAttempt);
    await tx.submission.update({
      where: { id: sub.id },
      data: won
        ? {
            status: SubmissionStatus.accepted_pending_sample,
            pendingHumanReview: true,
            duplicateScore: sub.duplicateScore ?? 0.0,
            llmScore: llmScoreValue,
          }
        // Lost the accept-time race: capacity outcome, not a quality one —
        // see the matching comment on the no-execution-available branch above
        // for why `rejected` is reused here rather than a new status.
        : { status: SubmissionStatus.rejected, duplicateScore: sub.duplicateScore ?? 0.0, llmScore: llmScoreValue },
    });
    return won;
  });

  if (!wonSlot) {
    await prisma.validationResult.create({
      data: {
        submissionId: sub.id,
        validationAttempt,
        stage: "pool_capacity",
        passed: false,
        score: null,
        outcome: "pool_capacity_reached",
        detailJson: { reason: "the pool reached its item target before this submission could be counted" },
      },
    });
    await notifyUser({
      userId: sub.contributorUserId,
      type: "submission.rejected",
      title: "Pool filled before your submission could be counted",
      body: `"${sub.title}" passed its own tests, but the pool reached its item target moments earlier and no capacity slot was left. This is not a quality rejection — your submission was valid, the pool was simply full.`,
      entityType: "Submission",
      entityId: sub.id,
      linkBountyId: sub.bountyId,
    });
    await notifyValidationStageResults(prisma, {
      userId: sub.contributorUserId,
      submissionId: sub.id,
      item: sub.title,
      keyBase: `validation:${validationAttempt}`,
      linkBountyId: sub.bountyId,
      steps: [
        { stage: "dedupe", outcome: "passed", detail: "No duplicate submission was found." },
        {
          stage: "ai_attribution",
          outcome: aiAttribution.passed ? "passed" : "flagged",
          detail: aiAttribution.passed
            ? "No explicit AI attribution or co-author disclosure was found."
            : "An explicit AI attribution or co-author disclosure was found.",
        },
        { stage: "execution", outcome: "passed", detail: "All executable tests passed." },
        // Omitted entirely when the platform LLM switch is off — an
        // absent stage, not a "skipped" claim about a check that is not
        // part of this pipeline right now.
        ...(llmStageStep ? [{ stage: "llm", outcome: llmStageStep.outcome, detail: llmStageStep.detail }] : []),
        {
          stage: "pool_capacity",
          outcome: "failed",
          detail: "The pool reached its item target before this submission could be counted. Your submission was not rejected for quality — the pool was simply full.",
        },
      ],
    });
    // Harmless no-op if another writer already closed this pool (the
    // expected case here — losing this race means someone else's accept just
    // hit the target).
    await checkAndClosePoolIfTargetReached(sub.bountyId);
    return;
  }

  await notifyUser({
    userId: sub.contributorUserId,
    type: "submission.accepted",
    title: "Submission passed execution",
    // Three distinct, honest bodies — the flag-off case must NOT say "LLM
    // review is not configured", which would blame the environment for a
    // stage the platform has deliberately switched off.
    body:
      llmScoreValue !== null
        ? `"${sub.title}" passed its own tests and scored ${llmScoreValue}/100 on LLM review. It will still go to a human validator before final acceptance.`
        : !llmEnabled
          ? `"${sub.title}" passed its own tests. Automated LLM review is switched off on this platform, so it goes straight to a human validator for final acceptance.`
          : `"${sub.title}" passed its own tests. LLM review is not configured in this environment, so it will go to a human validator before final acceptance.`,
    entityType: "Submission",
    entityId: sub.id,
    linkBountyId: sub.bountyId,
  });
  await notifyValidationStageResults(prisma, {
    userId: sub.contributorUserId,
    submissionId: sub.id,
    item: sub.title,
    keyBase: `validation:${validationAttempt}`,
    linkBountyId: sub.bountyId,
    steps: [
      { stage: "dedupe", outcome: "passed", detail: "No duplicate submission was found." },
      {
        stage: "ai_attribution",
        outcome: aiAttribution.passed ? "passed" : "flagged",
        detail: aiAttribution.passed
          ? "No explicit AI attribution or co-author disclosure was found."
          : "An explicit AI attribution or co-author disclosure was found. This item is queued for validator review.",
      },
      { stage: "execution", outcome: "passed", detail: "All executable tests passed." },
      // Omitted entirely when the platform LLM switch is off — see above.
      ...(llmStageStep ? [{ stage: "llm", outcome: llmStageStep.outcome, detail: llmStageStep.detail }] : []),
      {
        stage: "human_audit",
        outcome: "pending",
        detail: "Automated checks completed; the item is queued for validator review.",
      },
    ],
  });

  await checkAndClosePoolIfTargetReached(sub.bountyId);
}
