// SPDX-License-Identifier: Apache-2.0

import { KarmaEventType, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getAdminSetting } from "./admin-settings.js";
import { notifyEvent } from "./notifications.js";
import { enqueueLeaderboardRankCheck } from "./jobs/leaderboard-movement.js";
import { CATEGORY_PRICING_SEED } from "../lib/karma-category-scores.js";
import {
  isKarmaMatrixConfig,
  isKarmaRulesConfig,
  isKarmaTierConfigList,
  karmaTierForBalanceIn,
  nextKarmaTierIn,
  type KarmaMatrixConfig,
  type KarmaRulesConfig,
  type KarmaTierConfig,
} from "../lib/karma-matrix.js";

export type KarmaTier = "dharma" | "bodhi" | "moksha" | "nirvana";

export const KARMA_TIERS: {
  tier: KarmaTier;
  label: string;
  minKarma: number;
  color: string;
  blurb: string;
  perks: string[];
  earlyAccessHours: number;
  concurrencyBonus: number;
}[] = [
  {
    tier: "dharma",
    label: "Dharma",
    minKarma: 0,
    color: "#8a9382",
    blurb: "The path is taken. Every accepted item carries the contributor's name.",
    perks: ["Leaderboard listing", "Tier badge on profile", "Named credit on published dataset cards you contributed to"],
    earlyAccessHours: 0,
    concurrencyBonus: 0,
  },
  {
    tier: "bodhi",
    label: "Bodhi",
    minKarma: 5_000,
    color: "#d4a24e",
    blurb: "Awakening. The platform sees you before the crowd.",
    perks: ["Everything in Dharma", "24h early access to new community dataset pools", "Batch sizes up to 25 items"],
    earlyAccessHours: 24,
    concurrencyBonus: 1,
  },
  {
    tier: "moksha",
    label: "Moksha",
    minKarma: 50_000,
    color: "#b6ff1c",
    blurb: "Liberation. Work recognized across domains.",
    perks: ["Everything in Bodhi", "48h early access", "Claim priority queue", "Validator qualification fast-track"],
    earlyAccessHours: 48,
    concurrencyBonus: 2,
  },
  {
    tier: "nirvana",
    label: "Nirvana",
    minKarma: 500_000,
    color: "#b9a6f2",
    blurb: "The summit. Direct invites to featured dataset programs.",
    perks: ["Everything in Moksha", "72h first look", "Direct invites to featured dataset programs"],
    earlyAccessHours: 72,
    concurrencyBonus: 3,
  },
];

export function karmaTierForBalance(balance: number): (typeof KARMA_TIERS)[number] {
  let current = KARMA_TIERS[0]!;
  for (const candidate of KARMA_TIERS) {
    if (balance >= candidate.minKarma) current = candidate;
  }
  return current;
}

export const KARMA_RULES = {
  acceptedItem: {
    beginner: 10,
    intermediate: 25,
    advanced: 60,
  },
  auditItem: 8,
  confirmedFlag: 25,
  requestApproved: 25,
  publishBonus: 150,
  bountyPublished: 50,
} as const;

/* ------------------------------------------------------------------------ *
 * Runtime karma configuration
 *
 * `KARMA_TIERS`, `KARMA_RULES` and `CATEGORY_PRICING_SEED` above are the CODE
 * DEFAULTS, not the source of truth. The admin console's karma editor writes
 * `karma.tiers` / `karma.rules` / `karma.matrix` into `admin_settings`, and
 * until these readers existed the editor controlled nothing: every surface
 * rendered the module constants no matter what an operator saved.
 *
 * Three properties this deliberately keeps:
 *  - **Additive.** The synchronous constants and `karmaTierForBalance` are
 *    still exported unchanged, so every existing caller keeps compiling and
 *    behaving exactly as before. New callers use the async readers.
 *  - **Fail-safe.** An absent row, or a stored row that no longer satisfies
 *    its shape, falls back WHOLESALE to the code default. Never a partial
 *    merge — half a saved tier table spliced into half the constants is a
 *    configuration nobody chose and nobody can inspect.
 *  - **Live.** Read per call through `getAdminSetting`, so an operator's save
 *    takes effect on the next request with no deploy and no cache to bust.
 * ------------------------------------------------------------------------ */

export const KARMA_SETTING_KEYS = {
  tiers: "karma.tiers",
  rules: "karma.rules",
  matrix: "karma.matrix",
} as const;

export interface KarmaRuntimeSettings {
  tiers: KarmaTierConfig[];
  rules: KarmaRulesConfig;
  matrix: KarmaMatrixConfig;
  /** Which of the three came from `admin_settings` rather than the code
   *  defaults. Surfaced so an admin screen can say "this is the default"
   *  honestly instead of implying every value was configured. */
  source: { tiers: "stored" | "default"; rules: "stored" | "default"; matrix: "stored" | "default" };
}

export async function getKarmaTiers(): Promise<{ tiers: KarmaTierConfig[]; source: "stored" | "default" }> {
  const stored = await getAdminSetting<unknown>(KARMA_SETTING_KEYS.tiers);
  if (isKarmaTierConfigList(stored)) return { tiers: stored, source: "stored" };
  return { tiers: KARMA_TIERS.map((t) => ({ ...t, perks: [...t.perks] })), source: "default" };
}

export async function getKarmaRules(): Promise<{ rules: KarmaRulesConfig; source: "stored" | "default" }> {
  const stored = await getAdminSetting<unknown>(KARMA_SETTING_KEYS.rules);
  if (isKarmaRulesConfig(stored)) return { rules: stored, source: "stored" };
  return {
    rules: {
      acceptedItem: { ...KARMA_RULES.acceptedItem },
      auditItem: KARMA_RULES.auditItem,
      confirmedFlag: KARMA_RULES.confirmedFlag,
      requestApproved: KARMA_RULES.requestApproved,
      publishBonus: KARMA_RULES.publishBonus,
      bountyPublished: KARMA_RULES.bountyPublished,
    },
    source: "default",
  };
}

export async function getKarmaMatrix(): Promise<{ matrix: KarmaMatrixConfig; source: "stored" | "default" }> {
  const stored = await getAdminSetting<unknown>(KARMA_SETTING_KEYS.matrix);
  if (isKarmaMatrixConfig(stored)) return { matrix: stored, source: "stored" };
  return { matrix: CATEGORY_PRICING_SEED, source: "default" };
}

/** All three at once — one round trip per key, resolved in parallel. */
export async function getKarmaRuntimeSettings(): Promise<KarmaRuntimeSettings> {
  const [tiers, rules, matrix] = await Promise.all([getKarmaTiers(), getKarmaRules(), getKarmaMatrix()]);
  return {
    tiers: tiers.tiers,
    rules: rules.rules,
    matrix: matrix.matrix,
    source: { tiers: tiers.source, rules: rules.source, matrix: matrix.source },
  };
}

/** Live-configured counterpart to the synchronous `karmaTierForBalance`. Use
 *  this anywhere the answer is shown to a member or gates a capability, so an
 *  operator's tier edit is actually the tier the member gets. */
export async function resolveKarmaTier(
  balance: number
): Promise<{ current: KarmaTierConfig; next: KarmaTierConfig | null; progress: number }> {
  const { tiers } = await getKarmaTiers();
  const current = karmaTierForBalanceIn(tiers, balance);
  const next = nextKarmaTierIn(tiers, balance);
  const progress = next ? Math.min(1, Math.max(0, (balance - current.minKarma) / (next.minKarma - current.minKarma))) : 1;
  return { current, next, progress };
}

export async function awardKarma(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    eventType: KarmaEventType;
    amount: number;
    sourceType: string;
    sourceId: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ id: string; amount: number; total: number } | null> {
  const existing = await tx.karmaEvent.findUnique({
    where: {
      userId_eventType_sourceType_sourceId: {
        userId: params.userId,
        eventType: params.eventType,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
      },
    },
  });

  if (existing) {
    return null;
  }

  const event = await tx.karmaEvent.create({
    data: {
      userId: params.userId,
      eventType: params.eventType,
      amount: params.amount,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      metadata: params.metadata as Prisma.InputJsonValue,
    },
  });

  const updatedUser = await tx.user.update({
    where: { id: params.userId },
    data: {
      karmaTotal: { increment: params.amount },
    },
    select: { karmaTotal: true },
  });

  // The `karma.awarded` event has been in the catalog
  // (services/notifications/events.ts) with no emitter, so a member's balance
  // moved with nothing telling them. Emitted INSIDE the `existing` guard above,
  // so it inherits this function's idempotency exactly: a retried award writes
  // no event and therefore sends nothing. Same transaction as the balance
  // change — a transactional outbox write, not a side effect that can survive a
  // rolled-back award. Its catalog cadence is "digest" on purpose, so an active
  // contributor gets one line a day rather than one push per accepted item.
  await notifyEvent(tx, "karma.awarded", {
    userId: params.userId,
    entityId: event.id,
    keySuffix: `${params.sourceType}:${params.sourceId}`,
    data: { amount: String(params.amount), reason: params.eventType.replaceAll("_", " ") },
  });

  // The balance just moved, so the member's Open-leaderboard position may have
  // too. QUEUED rather than computed here: a rank is a range COUNT over users,
  // and this function runs once per accepted item — inline it would add that
  // count to every item of a bulk acceptance, inside this open transaction.
  // Sits after the `existing` guard so it inherits this function's idempotency
  // exactly: a retried award enqueues nothing.
  await enqueueLeaderboardRankCheck(params.userId, new Date(), tx);

  return { id: event.id, amount: params.amount, total: updatedUser.karmaTotal };
}

export async function reverseAcceptedSubmissionKarma(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    sourceType: string;
    sourceId: string;
    reason?: string;
  }
): Promise<boolean> {
  const original = await tx.karmaEvent.findUnique({
    where: {
      userId_eventType_sourceType_sourceId: {
        userId: params.userId,
        eventType: KarmaEventType.community_item_accepted,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
      },
    },
  });

  if (!original) return false;

  await tx.karmaEvent.create({
    data: {
      userId: params.userId,
      eventType: KarmaEventType.community_item_reversed,
      amount: -original.amount,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      metadata: { originalEventId: original.id, reason: params.reason ?? "dispute_upheld" },
    },
  });

  await tx.user.update({
    where: { id: params.userId },
    data: {
      karmaTotal: { decrement: original.amount },
    },
  });

  return true;
}

export async function getKarmaBreakdown(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      karmaTotal: true,
      leaderboardRank: true,
      leaderboardRankPrev: true,
      leaderboardRankMovedAt: true,
    },
  });

  if (!user) return null;

  const events = await prisma.karmaEvent.groupBy({
    by: ["eventType"],
    where: { userId },
    _sum: { amount: true },
    _count: { id: true },
  });

  // Live-configured tier lookup (resolveKarmaTier), not the static
  // KARMA_TIERS/karmaTierForBalance code defaults — this is the shared root
  // GET /v1/community/karma, GET /v1/me/karma, and MCP get_karma_details all
  // read through, so fixing it here makes an admin's karma.tiers edit reach
  // every one of those surfaces without touching them individually.
  const { current: tier, next: nextTier, progress } = await resolveKarmaTier(user.karmaTotal);

  const breakdown: Record<string, { total: number; count: number }> = {};
  for (const ev of events) {
    breakdown[ev.eventType] = {
      total: ev._sum.amount ?? 0,
      count: ev._count.id,
    };
  }

  return {
    totalKarma: user.karmaTotal,
    tier: {
      current: tier,
      next: nextTier,
      progress,
    },
    leaderboardRank: user.leaderboardRank,
    leaderboardRankPrev: user.leaderboardRankPrev,
    leaderboardRankMovedAt: user.leaderboardRankMovedAt,
    breakdown,
  };
}

export async function getKarmaHistory(
  userId: string,
  params?: { limit?: number; offset?: number }
) {
  const take = Math.min(params?.limit ?? 50, 100);
  const skip = params?.offset ?? 0;

  const [events, total] = await Promise.all([
    prisma.karmaEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
    prisma.karmaEvent.count({ where: { userId } }),
  ]);

  return { events, total, limit: take, offset: skip };
}

// Opaque cursor: base64(`${karmaTotal}:${id}`) — matches the compound
// orderBy below (karmaTotal desc, id asc as a stable tiebreak) so a cursor
// unambiguously identifies "everyone after this row" even when many users
// share the same karmaTotal.
function encodeLeaderCursor(karmaTotal: number, id: string): string {
  return Buffer.from(`${karmaTotal}:${id}`, "utf8").toString("base64url");
}

function decodeLeaderCursor(cursor: string): { karmaTotal: number; id: string } | null {
  try {
    const [karmaTotalRaw, id] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
    const karmaTotal = Number(karmaTotalRaw);
    if (!id || !Number.isFinite(karmaTotal)) return null;
    return { karmaTotal, id };
  } catch {
    return null;
  }
}

export async function getLeaderboard(params?: {
  limit?: number;
  cursor?: string | null;
  tier?: KarmaTier;
  q?: string;
}) {
  const take = Math.min(params?.limit ?? 50, 100);

  // SEC-10: `profilePublic` gates whether a profile is public at all, but a
  // member can separately hide "karma & tier" (`publicProfilePrefs.showKarma
  // === false`, same preference GET /v1/handle/:handle honors) while keeping
  // the rest of their profile public. Before this, the open/anonymous
  // leaderboard ignored that preference entirely and still published the
  // member's exact karma total and rank — the same class of leak the
  // single-profile fix closed, just reachable through a different, bulk
  // endpoint. Default (no stored prefs, or a non-boolean value) is
  // showKarma: true, matching profiles.ts/me.ts, so this only excludes an
  // explicit `false`.
  const showKarmaOnly: Prisma.UserWhereInput = {
    OR: [
      { publicProfilePrefs: { equals: Prisma.DbNull } },
      { NOT: { publicProfilePrefs: { path: ["showKarma"], equals: false } } },
    ],
  };

  const where: Prisma.UserWhereInput = {
    profilePublic: true,
    handle: { not: null },
    karmaTotal: { gt: 0 },
    status: "active" as const,
    // Nested under `AND` (its own array entry), not spread onto `where`
    // directly: both the `q` search below and the cursor branch further down
    // also assign the top-level `where.OR` key, and the cursor branch
    // OVERWRITES rather than merges (pre-existing, out of scope here). A
    // sibling `OR` from `showKarmaOnly` would have been clobbered by either
    // one; `AND` is a distinct key so it survives both.
    AND: [showKarmaOnly],
    ...(params?.q ? { OR: [{ handle: { contains: params.q, mode: "insensitive" } }, { displayName: { contains: params.q, mode: "insensitive" } }] } : {}),
  };
  if (params?.tier) {
    const tierIndex = KARMA_TIERS.findIndex((t) => t.tier === params.tier);
    const floor = KARMA_TIERS[tierIndex]!.minKarma;
    const ceilingTier = KARMA_TIERS[tierIndex + 1];
    where.karmaTotal = ceilingTier ? { gte: floor, lt: ceilingTier.minKarma } : { gte: floor };
  }

  const cursor = params?.cursor ? decodeLeaderCursor(params.cursor) : null;
  if (cursor) {
    where.OR = [
      { karmaTotal: { lt: cursor.karmaTotal } },
      { karmaTotal: cursor.karmaTotal, id: { gt: cursor.id } },
    ];
  }

  // +1 to detect "is there another page" without a second count query.
  const users = await prisma.user.findMany({
    where,
    select: { id: true, displayName: true, handle: true, karmaTotal: true },
    orderBy: [{ karmaTotal: "desc" }, { id: "asc" }],
    take: take + 1,
  });
  const hasMore = users.length > take;
  const page = hasMore ? users.slice(0, take) : users;

  // Real accepted-item counts, batched in one groupBy rather than N+1 queries.
  const acceptedByUser = page.length
    ? await prisma.submission.groupBy({
        by: ["contributorUserId"],
        where: { contributorUserId: { in: page.map((u) => u.id) }, status: "accepted" },
        _count: { _all: true },
      })
    : [];
  const acceptedMap = new Map(acceptedByUser.map((row) => [row.contributorUserId, row._count._all]));

  // Rank is a global position, not just this page's index — computed via a
  // count of users who genuinely rank strictly above each row (more karma,
  // or equal karma with a lower tiebreak id).
  const leaderboard = await Promise.all(
    page.map(async (u) => ({
      rank:
        1 +
        (await prisma.user.count({
          where: {
            profilePublic: true,
            handle: { not: null },
            status: "active" as const,
            AND: [showKarmaOnly],
            OR: [{ karmaTotal: { gt: u.karmaTotal } }, { karmaTotal: u.karmaTotal, id: { lt: u.id } }],
          },
        })),
      handle: u.handle!,
      displayName: u.displayName,
      karma: u.karmaTotal,
      acceptedItems: acceptedMap.get(u.id) ?? 0,
    })),
  );

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeLeaderCursor(last.karmaTotal, last.id) : null;

  return { leaderboard, nextCursor };
}
