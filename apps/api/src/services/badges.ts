// SPDX-License-Identifier: Apache-2.0

import { FlagStatus, SubmissionStatus, UserStatus, type Badge, type BadgeMetric, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { notifyEvent } from "./notifications.js";

/**
 * Badge catalog reads, the auto-award evaluator, and admin grant/revoke.
 *
 * Before this, the module was CRUD only: nothing ever evaluated a member
 * against the catalog, so no badge could be earned by doing anything — the
 * only way to hold one was an admin grant, and the admin grant route did not
 * exist either. Awards are WRITTEN, not derived on read, because holder counts,
 * earned-at history and manual grants all depend on the row existing.
 */

type DbClient = Prisma.TransactionClient | typeof prisma;

/**
 * The countable facts the platform has actually measured for one member. Every
 * auto-granted badge resolves against exactly one of these, so a badge can
 * never assert something the platform did not measure.
 */
export interface BadgeMetrics {
  verifiedCredentials: number;
  acceptedItems: number;
  cleanDeliveryStreak: number;
  completedAudits: number;
  confirmedFlags: number;
  karmaTotal: number;
  abandons: number;
  decidedFlags: number;
  dismissedFlags: number;
  publishedDatasets: number;
  /** Null when the member is not on the public leaderboard at all — an absent
   *  rank must never be treated as a good rank. */
  leaderboardRank: number | null;
}

/** Metrics where a *lower* measured value is better, so qualification is
 *  `measured <= threshold` instead of `measured >= threshold`. Getting this
 *  direction wrong on `leaderboard_rank` would hand "top 10" to everyone
 *  ranked 11th or worse. */
const INVERTED_METRICS = new Set<BadgeMetric>(["leaderboard_rank"]);

export interface EarnedBadge {
  id: string;
  key: string;
  family: Badge["family"];
  icon: Badge["icon"];
  /** Catalog label with `{value}` resolved against the measured amount. */
  label: string;
  criteria: string;
  earnedAt: string;
  /** True when an admin granted it by hand rather than the evaluator awarding it. */
  manual: boolean;
  measuredValue: number | null;
}

/** Resolves the measured value a badge is judged on. Null for metrics that are
 *  not a simple count (`manual`) or that have no data yet — never 0, which
 *  would be compared against a threshold as though it were a measurement. */
export function measuredValueFor(metric: BadgeMetric, metrics: BadgeMetrics): number | null {
  switch (metric) {
    case "verified_credentials":
      return metrics.verifiedCredentials;
    case "accepted_items":
      return metrics.acceptedItems;
    case "clean_delivery_streak":
      return metrics.cleanDeliveryStreak;
    case "completed_audits":
      return metrics.completedAudits;
    case "confirmed_flags":
      return metrics.confirmedFlags;
    case "karma_total":
      return metrics.karmaTotal;
    case "zero_abandons":
      // Judged on accepted items: a spotless record only counts once there is
      // work behind it. The zero-abandon condition itself is checked in
      // qualifiesFor.
      return metrics.acceptedItems;
    case "zero_dismissed_flags":
      return metrics.decidedFlags;
    case "published_datasets":
      return metrics.publishedDatasets;
    case "flag_accuracy_pct":
      // Undefined with no decided flags — 0/0 is not 0% accuracy, it is no
      // data, and must not be compared against a threshold at all.
      return metrics.decidedFlags === 0
        ? null
        : Math.floor(((metrics.decidedFlags - metrics.dismissedFlags) / metrics.decidedFlags) * 100);
    case "leaderboard_rank":
      return metrics.leaderboardRank;
    case "manual":
      return null;
    default:
      return null;
  }
}

/** Whether a member currently satisfies an active auto-granted badge. */
export function qualifiesFor(
  badge: Pick<Badge, "metric" | "threshold" | "minSample" | "autoGranted" | "active">,
  metrics: BadgeMetrics
): boolean {
  if (!badge.active || !badge.autoGranted || badge.metric === "manual") return false;
  const measured = measuredValueFor(badge.metric, metrics);
  if (measured === null) return false;

  // Ratio metrics need enough underlying decisions to mean anything: one
  // confirmed flag is 100% accuracy but is not evidence of accuracy.
  if (badge.metric === "flag_accuracy_pct" && metrics.decidedFlags < badge.minSample) return false;

  const meetsThreshold = INVERTED_METRICS.has(badge.metric)
    ? measured <= badge.threshold
    : measured >= badge.threshold;
  if (!meetsThreshold) return false;

  // Spotless-record metrics carry an extra condition beyond the threshold.
  if (badge.metric === "zero_abandons") return metrics.abandons === 0;
  if (badge.metric === "zero_dismissed_flags") return metrics.dismissedFlags === 0;
  return true;
}

/** Substitutes the measured amount into a catalog label. Admins write labels
 *  like "{value} accepted items"; a label without the token renders verbatim. */
export function renderLabel(label: string, measured: number | null): string {
  if (measured === null) return label;
  return label.replaceAll("{value}", measured.toLocaleString("en-US"));
}

/**
 * Reads every fact the evaluator judges on, from the real rows that record it.
 *
 * `leaderboardRank` carries the private-profile exclusion: a member who is not
 * actually listed on `GET /v1/community/leaderboard` has NO rank, and reporting
 * a stale `User.leaderboardRank` for them would hand out a "top 10" badge for a
 * position they do not hold on any surface anyone can see. The conditions here
 * are the same ones `getLeaderboard()` filters on.
 */
export async function collectBadgeMetrics(userId: string): Promise<BadgeMetrics> {
  const [user, rank, verifiedCredentials, acceptedItems, flagsByStatus, publishedDatasets] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { karmaTotal: true, leaderboardRank: true, profilePublic: true, handle: true, status: true },
    }),
    prisma.rank.findUnique({
      where: { userId },
      select: { auditsCompleted: true, contributorAbandons: true, contributorConsecutiveCleanDeliveries: true },
    }),
    prisma.profileSource.count({ where: { userId, verified: true } }),
    prisma.submission.count({ where: { contributorUserId: userId, status: SubmissionStatus.accepted } }),
    prisma.flag.groupBy({
      by: ["status"],
      where: { validatorUserId: userId, status: { in: [FlagStatus.confirmed, FlagStatus.dismissed] } },
      _count: { _all: true },
    }),
    // Distinct published programs the member has accepted work in. `distinct`
    // on bountyId rather than a count of submissions — 40 accepted items in one
    // published dataset is one shipped dataset, not forty.
    prisma.submission
      .findMany({
        where: {
          contributorUserId: userId,
          status: SubmissionStatus.accepted,
          bounty: { publicationStatus: "published" },
        },
        select: { bountyId: true },
        distinct: ["bountyId"],
      })
      .then((rows) => rows.length),
  ]);

  const confirmedFlags = flagsByStatus.find((f) => f.status === FlagStatus.confirmed)?._count._all ?? 0;
  const dismissedFlags = flagsByStatus.find((f) => f.status === FlagStatus.dismissed)?._count._all ?? 0;

  const karmaTotal = user?.karmaTotal ?? 0;
  const onLeaderboard =
    Boolean(user?.profilePublic) && Boolean(user?.handle) && user?.status === UserStatus.active && karmaTotal > 0;

  return {
    verifiedCredentials,
    acceptedItems,
    cleanDeliveryStreak: rank?.contributorConsecutiveCleanDeliveries ?? 0,
    completedAudits: rank?.auditsCompleted ?? 0,
    confirmedFlags,
    karmaTotal,
    abandons: rank?.contributorAbandons ?? 0,
    decidedFlags: confirmedFlags + dismissedFlags,
    dismissedFlags,
    publishedDatasets,
    leaderboardRank: onLeaderboard ? (user?.leaderboardRank ?? null) : null,
  };
}

/**
 * Awards every active auto-granted badge the member now qualifies for and
 * returns their full badge list.
 *
 * Re-running is safe: the unique `(userId, badgeId)` constraint plus
 * `skipDuplicates` makes each award idempotent, and a badge is never revoked
 * automatically once earned — a member who drops back below a threshold keeps
 * the record of having met it.
 */
export async function syncAndListBadges(
  userId: string,
  metrics?: BadgeMetrics,
  db: DbClient = prisma
): Promise<EarnedBadge[]> {
  const resolved = metrics ?? (await collectBadgeMetrics(userId));

  const [catalog, existing] = await Promise.all([
    db.badge.findMany({ orderBy: [{ family: "asc" }, { sortOrder: "asc" }] }),
    db.userBadge.findMany({ where: { userId } }),
  ]);

  const heldBadgeIds = new Set(existing.map((award) => award.badgeId));
  const newlyEarned = catalog.filter((badge) => !heldBadgeIds.has(badge.id) && qualifiesFor(badge, resolved));

  if (newlyEarned.length > 0) {
    // skipDuplicates keeps a concurrent dashboard load from failing the write:
    // two requests racing to award the same badge is a no-op, not an error.
    await db.userBadge.createMany({
      data: newlyEarned.map((badge) => ({
        userId,
        badgeId: badge.id,
        measuredValue: measuredValueFor(badge.metric, resolved),
      })),
      skipDuplicates: true,
    });
    // Keyed on badge.id, matching the award constraint, so two racing calls
    // that both computed the same list still produce one inbox row each.
    // Best-effort and non-fatal: a notification outbox problem must not fail
    // the profile read this runs on, but it is logged rather than swallowed.
    for (const badge of newlyEarned) {
      try {
        await notifyEvent(db, "badge.earned", {
          userId,
          entityId: badge.id,
          keySuffix: `${userId}:${badge.id}`,
          data: { badge: renderLabel(badge.label, measuredValueFor(badge.metric, resolved)) },
        });
      } catch (err) {
        console.error(`[badges] failed to notify ${userId} of badge ${badge.key}:`, err);
      }
    }
  }

  const badgesById = new Map(catalog.map((badge) => [badge.id, badge]));
  const now = new Date();
  const held = [
    ...existing.map((award) => ({ badge: badgesById.get(award.badgeId), award })),
    ...newlyEarned.map((badge) => ({ badge, award: null })),
  ];

  return held
    // A deactivated badge stops being shown, but the award row is retained so
    // reactivating it restores the member's history intact.
    .filter((entry): entry is { badge: Badge; award: (typeof existing)[number] | null } => Boolean(entry.badge?.active))
    .sort((a, b) => a.badge.family.localeCompare(b.badge.family) || a.badge.sortOrder - b.badge.sortOrder)
    .map(({ badge, award }) => {
      const measured = award?.measuredValue ?? measuredValueFor(badge.metric, resolved);
      return {
        id: badge.id,
        key: badge.key,
        family: badge.family,
        icon: badge.icon,
        label: renderLabel(badge.label, measured),
        criteria: badge.criteria,
        earnedAt: (award?.earnedAt ?? now).toISOString(),
        manual: award?.grantedByUserId != null,
        measuredValue: measured,
      };
    });
}

export async function listBadges() {
  return prisma.badge.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
  });
}

/**
 * A member's badges, evaluated first.
 *
 * The evaluation runs HERE rather than at each caller because this is the only
 * member-facing badge read in the API (routes/v1/me.ts, services/profile-summary.ts):
 * putting it anywhere else would mean a member could look at their badges and
 * see a badge they had already earned still missing. Same award-on-read shape
 * v1 uses from its profile summary.
 *
 * The return shape is unchanged from before the evaluator existed, so both
 * existing callers keep working untouched.
 */
export async function getUserBadges(userId: string) {
  try {
    await syncAndListBadges(userId);
  } catch (err) {
    // A read of someone's profile must not 500 because the evaluator hit a
    // problem; they simply see the badges already recorded. Logged, not hidden.
    console.error(`[badges] badge evaluation failed for ${userId}:`, err);
  }
  const awards = await prisma.userBadge.findMany({
    where: { userId },
    include: { badge: true },
    orderBy: { earnedAt: "desc" },
  });
  return awards.map((a) => ({
    badge: a.badge,
    earnedAt: a.earnedAt,
    measuredValue: a.measuredValue,
  }));
}

export async function grantBadge(params: {
  userId: string;
  badgeId: string;
  grantedByUserId?: string;
  measuredValue?: number;
}) {
  return prisma.userBadge.upsert({
    where: {
      userId_badgeId: {
        userId: params.userId,
        badgeId: params.badgeId,
      },
    },
    create: {
      userId: params.userId,
      badgeId: params.badgeId,
      grantedByUserId: params.grantedByUserId,
      measuredValue: params.measuredValue,
    },
    update: {
      measuredValue: params.measuredValue,
    },
  });
}

export async function revokeBadge(userId: string, badgeId: string) {
  return prisma.userBadge.deleteMany({
    where: { userId, badgeId },
  });
}
