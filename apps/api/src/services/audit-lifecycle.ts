// SPDX-License-Identifier: Apache-2.0

/**
 * T3 — the reaper. A claim without one strands work permanently: once T1
 * (services/audits.ts claimAuditWindow) lets a validator hold a
 * HumanAuditWindow exclusively, something has to take it back if they never
 * finish deciding it, or every abandoned claim removes that window from the
 * pool forever.
 *
 * Direct port of v1's `releaseOverdueAudits` (v1 databounty-api
 * src/services/audit-lifecycle.ts:12-80, AuditBatch.validatorUserId) onto
 * this schema's HumanAuditWindow/HumanAuditWindowMembership model:
 *
 *  - an untouched claim (nothing decided) is released back to the open pool
 *    — `claimedByUserId`/`claimedAt`/`claimExpiresAt` cleared — so another
 *    validator can pick it up.
 *  - a PARTIALLY decided claim keeps its owner and its immutable decisions.
 *    Handing it to somebody else would misattribute evidence and the
 *    completion reward, exactly the "12 batches in production paid two
 *    validators" failure documented in v1 services/audit-routing.ts:44-80.
 *    There is no separate `overdue_review` status column on this schema
 *    (HumanAuditWindow has no status enum, only settledAt/supersededAt), so
 *    a partially-decided overdue window is marked the schema-honest way:
 *    `claimExpiresAt` cleared (no further SLA is being tracked) while
 *    `claimedByUserId`/`claimedAt` are left in place — still claimed by the
 *    original validator, no longer racing a deadline. The original validator
 *    may still finish deciding it; only a second `releaseOverdueAudits` pass
 *    would look at it again, and it will never match this scan's `WHERE
 *    claimExpiresAt < now` filter again once `claimExpiresAt` is null.
 *  - either way, the miss is recorded on `Rank.validatorMissedDeadlines` —
 *    the same column v1 increments — and the validator is notified.
 */
import { prisma } from "../lib/prisma.js";
import { emitAuditAvailableMatches, notifyUser } from "./notifications.js";

export async function releaseOverdueAudits(now: Date = new Date()): Promise<number> {
  const overdue = await prisma.humanAuditWindow.findMany({
    where: {
      claimedByUserId: { not: null },
      claimExpiresAt: { lt: now },
      settledAt: null,
      supersededAt: null,
    },
    include: {
      bounty: {
        select: {
          id: true,
          title: true,
          datasetCategory: true,
          language: true,
          requesterUserId: true,
          communityRequesterUserId: true,
          datasetType: { select: { domain: true } },
        },
      },
      memberships: {
        where: { selected: true },
        select: { submission: { select: { status: true } } },
      },
    },
  });

  let releasedCount = 0;
  for (const window of overdue) {
    const validatorId = window.claimedByUserId;
    if (!validatorId) continue;

    const decidedItems = window.memberships.filter(
      (m) => m.submission.status !== "in_audit"
    ).length;

    const released = await prisma.$transaction(async (tx) => {
      // Re-check-and-flip atomically: the validator may have finished
      // deciding every item (window settled), or a second reaper tick may
      // already have released this same window, between the findMany above
      // and this transaction. Only touch a window that is STILL held by
      // this same validator with this same overdue deadline.
      const result = await tx.humanAuditWindow.updateMany({
        where: {
          id: window.id,
          claimedByUserId: validatorId,
          claimExpiresAt: { lt: now },
          settledAt: null,
        },
        data:
          decidedItems === 0
            ? { claimedByUserId: null, claimedAt: null, claimExpiresAt: null }
            : { claimExpiresAt: null },
      });
      if (result.count === 0) return false; // already resolved by someone else — do not penalize

      await tx.rank.upsert({
        where: { userId: validatorId },
        create: { userId: validatorId, validatorMissedDeadlines: 1 },
        update: { validatorMissedDeadlines: { increment: 1 } },
      });
      return true;
    });

    if (!released) continue;
    releasedCount += 1;

    // Only an UNTOUCHED window (no decisions at all) actually returns to the
    // open pool for anyone else to claim — a partially-decided one keeps its
    // original validator (see the module doc comment above), so only the
    // first case is genuinely "new audit work available" for other watchers.
    if (decidedItems === 0) {
      await emitAuditAvailableMatches({
        id: window.bountyId,
        title: window.bounty.title,
        datasetCategory: window.bounty.datasetCategory,
        language: window.bounty.language,
        requesterUserId: window.bounty.communityRequesterUserId ?? window.bounty.requesterUserId,
        domain: window.bounty.datasetType?.domain ?? "coding",
      });
    }

    await notifyUser({
      userId: validatorId,
      type: "audit.deadline_missed",
      title: decidedItems === 0 ? "Audit claim released — deadline missed" : "Audit claim overdue — partial decisions kept",
      body:
        decidedItems === 0
          ? `Your claim on "${window.bounty.title}" was released back to the pool after the 24h review deadline passed with no decisions recorded.`
          : `Your claim on "${window.bounty.title}" passed its 24h review deadline. Your ${decidedItems} recorded decision(s) are kept — finish deciding the rest when you can.`,
      entityType: "HumanAuditWindow",
      entityId: window.id,
      linkBountyId: window.bountyId,
    });
  }

  return releasedCount;
}
