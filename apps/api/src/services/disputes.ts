// SPDX-License-Identifier: Apache-2.0

import { DisputeStatus, FlagReason, SubmissionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { notifyEvent, notifyAdminsEvent } from "./notifications.js";

/**
 * Filing a dispute on a submission — the ONE implementation.
 *
 * This used to live inline in `routes/v1/submissions.ts` while the MCP tool
 * `dispute_submission` had its own, shorter copy. The copies had diverged in
 * three ways that all mattered, and every one of them favoured the MCP path
 * being wrong:
 *
 *  1. NO STATE GATE. REST refuses anything but `flagged`/`rejected`; MCP
 *     refused nothing, so an agent could open a dispute on a `submitted`,
 *     `in_audit` or already-`accepted` item — including the `llm_fail`
 *     advisory case, where nothing has been decided against the contributor
 *     at all.
 *  2. A FABRICATED VERDICT. With no open flag (the normal case for a
 *     non-flagged item) MCP wrote the literal string "Flagged during review"
 *     into `Dispute.validatorArgument`, asserting a human review verdict that
 *     never happened — and persisting it for the admin who arbitrates.
 *  3. NO STATUS FLIP AND NO NOTIFICATIONS. MCP left the submission in its old
 *     status and emitted none of the three events, so a dispute existed that
 *     the contested validator, the pool requester and the operators never
 *     heard about, on an item still claiming it was not disputed.
 *
 * Both callers now share this function, so the gate cannot be bypassed by
 * choosing a different transport.
 */

export type FileDisputeResult =
  | { ok: true; dispute: { id: string } }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_disputable"; status: SubmissionStatus };

/** The only statuses a contributor can dispute — a decision must exist to contest. */
const DISPUTABLE_STATUSES: SubmissionStatus[] = [SubmissionStatus.flagged, SubmissionStatus.rejected];

export async function fileSubmissionDispute(params: {
  submissionId: string;
  contributorUserId: string;
  contributorArgument: string;
}): Promise<FileDisputeResult> {
  const sub = await prisma.submission.findUnique({
    where: { id: params.submissionId },
    include: { bounty: true, flags: { where: { status: "open" } } },
  });

  if (!sub || sub.contributorUserId !== params.contributorUserId) return { ok: false, reason: "not_found" };
  if (!DISPUTABLE_STATUSES.includes(sub.status)) return { ok: false, reason: "not_disputable", status: sub.status };

  const flag = sub.flags[0];

  const dispute = await prisma.$transaction(async (tx) => {
    const disp = await tx.dispute.create({
      data: {
        bountyId: sub.bountyId,
        submissionId: sub.id,
        raisedByUserId: params.contributorUserId,
        bountyTitle: sub.bounty.title,
        submissionTitle: sub.title,
        flagReason: flag?.reason ?? FlagReason.other,
        contributorArgument: params.contributorArgument,
        // No invented verdict. When there is no flag to quote, say so plainly
        // rather than asserting a review that did not happen — the admin
        // arbitrator reads this field.
        validatorArgument: flag?.details ?? "No validator note was recorded for this decision.",
        status: DisputeStatus.open,
      },
    });

    await tx.submission.update({
      where: { id: sub.id },
      data: { status: SubmissionStatus.disputed },
    });

    // Transactional outbox: the three parties who must know a dispute was
    // filed are notified in the SAME transaction that opens it, so a
    // rolled-back dispute can never leave a notification claiming one exists —
    // and an opened dispute can never leave the validator, the pool requester
    // and the operators unaware.
    const notifyData = { item: sub.title, bounty: sub.bounty.title, reason: flag?.reason ?? FlagReason.other };

    // 1. The validator whose flag is being contested.
    if (flag?.validatorUserId) {
      await notifyEvent(tx, "issue.disputed", {
        userId: flag.validatorUserId,
        entityId: sub.id,
        linkBountyId: sub.bountyId,
        keySuffix: disp.id,
        data: notifyData,
      });
    }

    // 2. The pool requester whose dataset the item belongs to.
    const requesterUserId = sub.bounty.communityRequesterUserId ?? sub.bounty.requesterUserId;
    if (requesterUserId && requesterUserId !== params.contributorUserId) {
      await notifyEvent(tx, "issue.dispute_filed", {
        userId: requesterUserId,
        entityId: sub.id,
        linkBountyId: sub.bountyId,
        keySuffix: disp.id,
        data: notifyData,
      });
    }

    // 3. Operators — a dispute needs a ruling and never auto-overturns.
    await notifyAdminsEvent(tx, "admin.dispute_filed", {
      entityId: sub.id,
      keySuffix: disp.id,
      data: notifyData,
    });

    return disp;
    // 15s: the original inline route carried this timeout because the three
    // notifyEvent writes happen inside the transaction. Preserved verbatim in
    // the move — dropping it would have quietly changed failure behavior
    // under load.
  }, { timeout: 15_000 });

  return { ok: true, dispute };
}
