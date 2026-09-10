// SPDX-License-Identifier: Apache-2.0

import { FlagStatus, SubmissionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getUserBadges } from "./badges.js";
import {
  computeReputationScore,
  contributorNextRank,
  contributorRankForAcceptedItems,
  rankForScore,
  validatorNextRank,
  validatorRankForAudits,
  type NextRankProgress,
} from "./reputation.js";

// Same three-way split used by the contributor submission-list surfaces:
// terminal-accepted, still-in-the-pipeline, and back-with-the-contributor.
export const ACCEPTED_SUBMISSION_STATUSES: readonly SubmissionStatus[] = [SubmissionStatus.accepted];

export const IN_REVIEW_SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  SubmissionStatus.submitted,
  SubmissionStatus.duplicate_check,
  SubmissionStatus.running_tests,
  SubmissionStatus.llm_validation,
  SubmissionStatus.provisionally_accepted,
  SubmissionStatus.in_audit,
  SubmissionStatus.in_sponsor_review,
  SubmissionStatus.accepted_pending_sample,
  SubmissionStatus.disputed,
];

export const NEEDS_ATTENTION_SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  SubmissionStatus.needs_fixes,
  SubmissionStatus.flagged,
  SubmissionStatus.tests_failed,
];

export interface ProfileSummary {
  reputationScore: number;
  reputation: {
    score: number;
    tier: string;
    verifiedSources: number;
    connectedSources: number;
    maxConcurrentBatches: number;
    profilePublic: boolean;
  };
  ranks: {
    contributor: {
      rank: string;
      acceptedItems: number;
      missedDeadlines: number;
      abandons: number;
      consecutiveCleanDeliveries: number;
      maxConcurrentBatches: number;
      nextRank: NextRankProgress | null;
    };
    validator: {
      rank: string;
      auditsCompleted: number;
      missedDeadlines: number;
      falseFlagRate: number | null;
      decidedFlags: number;
      dismissedFlags: number;
      nextRank: NextRankProgress | null;
      maxConcurrentAudits: number;
    };
  };
  submissions: {
    total: number;
    accepted: number;
    inReview: number;
    needsAttention: number;
    rejected: {
      total: number;
      bySystem: number;
      byHuman: number;
    };
  };
  /** Flattened to the shape every client surface renders (`id` is the key it
   *  renders lists by). `getUserBadges` returns the award row with the catalog
   *  row nested under `badge`; returning that raw here let the two dashboard
   *  endpoints ship a badge with no top-level `id`/`icon`/`label`, which the
   *  web app rendered as an undefined React key and a blank badge. */
  badges: {
    id: string;
    key: string;
    family: string;
    icon: string;
    label: string;
    criteria: string;
    earnedAt: Date;
    manual: boolean;
  }[];
}

/**
 * Real-data profile summary for the credential/reputation surface
 * (`GET /v1/me/profile-sources`). Every figure below is a genuine Prisma
 * read against this API's own schema:
 *
 *  - reputation score/tier: services/reputation.ts, driven by verified
 *    ProfileSource rows (admin-configurable base/multiplier).
 *  - contributor rank: Rank.acceptedItems if a Rank row exists, else derived
 *    live from Submission.status = accepted (Rank is not yet written by any
 *    pipeline in this API, so acceptedItems is computed from Submission
 *    directly rather than trusting a row that nothing populates).
 *  - validator rank/audits: read from the Rank table. NOTE (schema gap): no
 *    service in community/apps/api currently increments
 *    Rank.auditsCompleted — this build's validator flow
 *    (services/audits.ts submitAuditDecisions) posts window-level decisions,
 *    not a per-validator claimed-audit counter. auditsCompleted therefore
 *    reads 0 for every user until that write-path is built; this is an
 *    honest reflection of current state, not a fabricated value.
 *  - false-flag rate: derived from Flag rows raised by this validator
 *    (confirmed vs dismissed), which IS written today.
 *  - rejected bySystem/byHuman: this schema has no AuditItem table, so the
 *    split is derived from whether the rejected submission has any Flag row
 *    attached (byHuman) or none (bySystem, i.e. the automated
 *    dedupe/execution pipeline rejected it before any human
 *    ever saw it).
 */
export async function getProfileSummary(userId: string): Promise<ProfileSummary> {
  const [user, rank, scoreInfo, flagCounts, submissionsByStatus, rejectedBySystem, badges] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { profilePublic: true } }),
    prisma.rank.findUnique({ where: { userId } }),
    computeReputationScore(userId),
    prisma.flag.groupBy({
      by: ["status"],
      where: { validatorUserId: userId, status: { in: [FlagStatus.confirmed, FlagStatus.dismissed] } },
      _count: { _all: true },
    }),
    prisma.submission.groupBy({
      by: ["status"],
      where: { contributorUserId: userId },
      _count: { _all: true },
    }),
    prisma.submission.count({
      where: { contributorUserId: userId, status: SubmissionStatus.rejected, flags: { none: {} } },
    }),
    getUserBadges(userId),
  ]);

  const countFor = (statuses: readonly SubmissionStatus[]): number =>
    submissionsByStatus.reduce((total, row) => (statuses.includes(row.status) ? total + row._count._all : total), 0);

  const submissionTotal = submissionsByStatus.reduce((total, row) => total + row._count._all, 0);
  const acceptedItems = countFor(ACCEPTED_SUBMISSION_STATUSES);
  const inReviewSubmissions = countFor(IN_REVIEW_SUBMISSION_STATUSES);
  const needsAttentionSubmissions = countFor(NEEDS_ATTENTION_SUBMISSION_STATUSES);
  const rejectedTotal = countFor([SubmissionStatus.rejected]);
  const rejectedBySystemClamped = Math.min(rejectedBySystem, rejectedTotal);
  const rejectedByHuman = rejectedTotal - rejectedBySystemClamped;

  const flagCountByStatus = new Map(flagCounts.map((row) => [row.status, row._count._all]));
  const confirmedFlags = flagCountByStatus.get(FlagStatus.confirmed) ?? 0;
  const dismissedFlags = flagCountByStatus.get(FlagStatus.dismissed) ?? 0;
  const decidedFlags = confirmedFlags + dismissedFlags;
  const falseFlagRate = decidedFlags === 0 ? null : dismissedFlags / decidedFlags;

  const reputationTier = rankForScore(scoreInfo.score);
  const contributorTier = contributorRankForAcceptedItems(acceptedItems);
  const contributorLimit = Math.max(reputationTier.maxConcurrentBatches, contributorTier.maxConcurrentBatches);
  const auditsCompleted = rank?.auditsCompleted ?? 0;
  const validatorTier = validatorRankForAudits(auditsCompleted);

  return {
    reputationScore: scoreInfo.score,
    reputation: {
      score: scoreInfo.score,
      tier: reputationTier.name,
      verifiedSources: scoreInfo.verifiedSources,
      connectedSources: scoreInfo.connectedSources,
      maxConcurrentBatches: contributorLimit,
      profilePublic: user.profilePublic,
    },
    ranks: {
      contributor: {
        rank: contributorTier.name,
        acceptedItems,
        missedDeadlines: rank?.contributorMissedDeadlines ?? 0,
        abandons: rank?.contributorAbandons ?? 0,
        consecutiveCleanDeliveries: rank?.contributorConsecutiveCleanDeliveries ?? 0,
        maxConcurrentBatches: contributorLimit,
        nextRank: contributorNextRank(acceptedItems),
      },
      validator: {
        rank: rank?.validatorRank ?? validatorTier.name,
        auditsCompleted,
        missedDeadlines: rank?.validatorMissedDeadlines ?? 0,
        falseFlagRate,
        decidedFlags,
        dismissedFlags,
        nextRank: validatorNextRank(auditsCompleted),
        maxConcurrentAudits: validatorTier.maxConcurrentAudits,
      },
    },
    submissions: {
      total: submissionTotal,
      accepted: acceptedItems,
      inReview: inReviewSubmissions,
      needsAttention: needsAttentionSubmissions,
      rejected: {
        total: rejectedTotal,
        bySystem: rejectedBySystemClamped,
        byHuman: rejectedByHuman,
      },
    },
    badges: badges.map((b) => ({
      id: b.badge.id,
      key: b.badge.key,
      family: b.badge.family,
      icon: b.badge.icon,
      label: b.badge.label,
      criteria: b.badge.criteria,
      earnedAt: b.earnedAt,
      manual: !b.badge.autoGranted,
    })),
  };
}
