// SPDX-License-Identifier: Apache-2.0

import type { Prisma } from "@prisma/client";

/**
 * AuditBatch / AuditItem routing — the half of V1's validator flow this rebuild
 * did not have.
 *
 * PORTED FROM V1 `src/services/audit-routing.ts`, MINUS THE MONEY. V1 sets
 * `baseReward`, `issueBonus` and `bondRequired` on every batch it creates or
 * appends to, but every one of those lines is already `args.isCommunity ? 0 :
 * <usd expression>` — so for a community bounty V1 itself writes 0/0/false.
 * Those fields do not exist on this schema (D18) and dropping them changes no
 * community behaviour whatsoever. The `perItemUsd` / `isCommunity` parameters
 * go with them: every pool here is community, so the branch had one live side.
 *
 * WHY THIS MODULE EXISTS AT ALL. V1 runs two audit models side by side and they
 * are complementary, not alternatives:
 *
 *   HumanAuditWindow  — the SAMPLING record. Which items were eligible at pool
 *                       close, the quota, and the reproducible HMAC selection.
 *   AuditBatch/Item   — the WORK UNIT. What a validator claims, and the verdict,
 *                       note and timestamp they record per item.
 *
 * This rebuild had only the first, so validators claimed a sampling window
 * directly and no per-item verdict was stored — it was re-derived from
 * `submissions.status` (`services/audits.ts:400`), which cannot represent a
 * note on an APPROVED item at all. This module restores the second half.
 *
 * DEVIATION FROM V1, deliberate: v1 pools items into batches of
 * `community.audit_batch_size` (25) because it has no other batching layer.
 * This deployment already batches at the window level — 50–100 per
 * `community.human_audit_window_size`, an owner requirement — so a batch is
 * created 1:1 with a window chunk instead. See `createWindowAuditBatch`.
 */

/**
 * 24h claim-to-decision SLA — the same window `POST /v1/audits/:id/claim`
 * stamps (`services/audits.ts` CLAIM_SLA_MS). Kept here because reopening a
 * partially decided batch has to re-arm that window itself.
 */
export const AUDIT_REVIEW_SLA_MS = 24 * 60 * 60 * 1000;

/**
 * Put ONE audit item back up for review without disturbing the verdicts its
 * batch already carries.
 *
 * A re-queue is per item (a revision to re-review, a dead validation job
 * falling back to manual review, a dispute overturned back into audit), but
 * `AuditBatch.status` is per batch. The naive version resets the item and flips
 * the WHOLE batch to `available` with `validatorUserId: null`. On a batch whose
 * other items are already decided that is wrong three ways, and V1 records all
 * three as observed in its own production (agent issue cmsvv9y9n054iuvp2bnue09bq,
 * 2026-08-16):
 *
 *   1. It re-offers settled items as fresh work.
 *   2. A second validator can claim it, decide the one genuinely open item,
 *      complete the batch and collect the reward priced on the FULL itemCount.
 *      V1 saw 12 batches pay two validators this way.
 *   3. The first validator's in-progress hold is silently revoked.
 *
 * So: return to the pool only when nothing else in the batch is decided, or
 * when there is no owner to hand it back to. Otherwise keep the owner, mark the
 * batch `in_progress` and re-arm the SLA.
 */
export async function reopenAuditItemForReview(
  tx: Prisma.TransactionClient,
  item: { id: string; auditBatchId: string }
): Promise<{ auditBatchId: string; returnedToPool: boolean; retainedValidatorUserId: string | null }> {
  await tx.auditItem.update({
    where: { id: item.id },
    data: { verdict: null, flagReason: null, note: null, decidedAt: null },
  });
  // Both fields, matching isDecidedAuditItem in services/audits.ts. The write
  // above clears the pair together and submitAuditDecisions sets it together,
  // so `decidedAt` alone is consistent TODAY — but this count decides whether
  // a partially decided batch is handed back to the open pool, so a
  // half-written row would silently re-offer already-settled work. Ask the
  // same question every other surface asks.
  const decidedElsewhere = await tx.auditItem.count({
    where: { auditBatchId: item.auditBatchId, verdict: { not: null }, decidedAt: { not: null } },
  });
  const batch = await tx.auditBatch.findUnique({
    where: { id: item.auditBatchId },
    select: { validatorUserId: true },
  });
  // No owner to hand a partially decided batch back to (it should not happen —
  // audit-lifecycle.ts keeps the owner precisely so it can't — but an
  // unclaimable `in_progress` batch would strand the item forever, and the open
  // pool is then the only way it gets reviewed at all). An honest `decidedCount`
  // on the queues is what stops this reading as fresh work.
  const returnToPool = decidedElsewhere === 0 || batch?.validatorUserId == null;
  await tx.auditBatch.update({
    where: { id: item.auditBatchId },
    data: returnToPool
      ? { status: "available", validatorUserId: null, claimedAt: null, deadline: null }
      : { status: "in_progress", deadline: new Date(Date.now() + AUDIT_REVIEW_SLA_MS) },
  });

  // THE WINDOW MUST MOVE WITH THE BATCH, or the item is unreachable.
  //
  // Reopening the batch alone is not enough: the validator surface
  // (`GET /v1/audits` -> listAvailableAudits) lists HumanAuditWindows and
  // filters on `settledAt IS NULL` and an unclaimed `claimedByUserId`. A window
  // that already settled keeps those set, so the item lands back in `in_audit`
  // with `verdict: null` and an `available` batch — and NO validator can see or
  // claim it.
  //
  // Measured over HTTP before this was added: submission `in_audit`, verdict
  // cleared, `batch_status=available`, `window_settled=true`,
  // `window_claimed_by=true`, and the item ABSENT from `GET /v1/audits`. Every
  // row was correct and the work was still lost. This is the fourth defect of
  // that exact shape in this codebase ("batch without a claimable window"),
  // after the rebuild's original gap, 1,955 stranded items at the v1 cutover,
  // and the dispute resolver's mint path.
  //
  // Clearing `settledAt` is right even on a shared window chunk: one of its
  // items is undecided again, so the window is genuinely no longer settled.
  // The other items' verdicts live on their own `audit_items`/`submissions`
  // rows and are untouched — nobody's completed work is discarded.
  await tx.humanAuditWindow.updateMany({
    where: { auditBatchId: item.auditBatchId },
    data: returnToPool
      ? // Nothing else decided (or no owner): make it freely claimable again.
        { settledAt: null, claimedByUserId: null, claimedAt: null, claimExpiresAt: null }
      : // Owner retained: keep their claim, un-settle it, and re-arm the SLA so
        // the reopened item has a deadline rather than sitting open forever.
        { settledAt: null, claimExpiresAt: new Date(Date.now() + AUDIT_REVIEW_SLA_MS) },
  });

  return {
    auditBatchId: item.auditBatchId,
    returnedToPool: returnToPool,
    retainedValidatorUserId: returnToPool ? null : (batch?.validatorUserId ?? null),
  };
}

/**
 * Create the claimable AuditBatch for ONE human-audit window chunk, with an
 * undecided AuditItem per selected submission. Returns the batch id.
 *
 * WHY 1:1 WITH A WINDOW, and not v1's independent pooling. v1's
 * `findOrAppendAuditBatch` groups items by bounty up to
 * `community.audit_batch_size` (default 25) because v1 has no other batching
 * layer. This deployment does: `community.human_audit_window_size` is
 * documented in the settings catalog as "how many submissions one human-audit
 * window holds — **the batch a validator claims**. 50–100 (owner requirement)",
 * and `pool-lifecycle.ts` already packs the selected set into chunks of exactly
 * that size, calling each one "the claimable unit". Porting v1's pooling on top
 * would give two batching layers with different sizes, both claiming to be the
 * unit a validator claims — and would quietly contradict the 50–100 owner
 * requirement with a 25.
 *
 * So the window keeps its role as the claimable unit, and the batch exists for
 * the thing the window genuinely cannot express: a per-item verdict, with the
 * validator's note and decision timestamp. Before this, `submitAuditDecisions`
 * accepted a `note` and used it only on the flagged branch — an approving
 * validator's comment was silently discarded, which is why 16,988 migrated v1
 * audit items carried 422 notes with nowhere to live.
 *
 * Items are created undecided (`verdict: null`); `submitAuditDecisions` fills
 * them in. `itemCount` is set once here and never incremented, because a window
 * chunk's membership is fixed at close-out — the hand-maintained counter that
 * v1 has to keep in step with appends cannot drift here.
 *
 * NOT idempotent on its own — calling this twice creates two batches. The
 * caller owns replay safety by linking under an `auditBatchId: null` guard and
 * deleting the loser. The `@unique` on `HumanAuditWindow.auditBatchId` only
 * stops two windows sharing one batch; it does NOT stop a window's link being
 * reassigned, so it is not a replay guard and must not be relied on as one.
 */
export async function createWindowAuditBatch(
  tx: Prisma.TransactionClient,
  args: { bountyId: string; submissionIds: string[] }
): Promise<string | null> {
  if (args.submissionIds.length === 0) return null;
  const batch = await tx.auditBatch.create({
    data: {
      bountyId: args.bountyId,
      itemCount: args.submissionIds.length,
      status: "available",
      items: { create: args.submissionIds.map((submissionId) => ({ submissionId })) },
    },
    select: { id: true },
  });
  return batch.id;
}
