// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the three engines that had no live write path at all:
 * karma holds (`PendingKarmaAward` was read but never written), the badge
 * auto-award evaluator (no badge could ever be earned), and public attribution
 * (no preference, no credit manifest).
 *
 * Real rows against the disposable database — no mocks — because every defect
 * these cover was "the table is empty / the row is never written", which a
 * mocked client cannot demonstrate.
 *
 * Self-guards exactly like the other integration suites: refuses to run unless
 * DATABASE_URL points at databounty_community_parity_verify.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthMethod, KarmaEventType, SubmissionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  awardOrHoldAcceptedItemKarma,
  holdReleasesAt,
  queuePendingKarmaAward,
  releaseDueKarmaHolds,
  reverseAcceptedItemKarma,
} from "./karma-holds.js";
import { collectBadgeMetrics, qualifiesFor, renderLabel, syncAndListBadges } from "./badges.js";
import { buildContributorCredits, renderContributorCredits, setAttributionPreference } from "./reputation.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

const RUN = `kbat_${Date.now().toString(36)}`;
const createdUserIds: string[] = [];
const createdBountyIds: string[] = [];

async function makeUser(tag: string, overrides: { handle?: string | null; profilePublic?: boolean } = {}) {
  const user = await prisma.user.create({
    data: {
      authMethod: AuthMethod.email,
      email: `${RUN}-${tag}@example.test`,
      displayName: `${tag} tester`,
      handle: overrides.handle === null ? null : (overrides.handle ?? `${RUN}${tag}`),
      profilePublic: overrides.profilePublic ?? true,
      emailVerifiedAt: new Date(),
      onboarded: true,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

async function makeCommunityBounty(requesterUserId: string, disputeWindowHours: number) {
  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId,
      communityRequesterUserId: requesterUserId,
      kind: "community",
      karmaPerAcceptedItem: 25,
      title: `${RUN} pool`,
      description: "Karma-hold integration fixture.",
      datasetCategory: "debugging",
      language: "typescript",
      framework: "none",
      targetItems: BigInt(10),
      auditMode: "partial",
      auditCoveragePct: 10,
      holdDays: 0,
      disputeWindowHours,
      status: "active",
    },
  });
  createdBountyIds.push(bounty.id);
  return bounty;
}

async function makeAcceptedSubmission(bountyId: string, contributorUserId: string, acceptedAt: Date) {
  return prisma.submission.create({
    data: {
      bountyId,
      contributorUserId,
      title: `${RUN} item`,
      payloadJson: { prompt: "x" },
      generationMethod: "human",
      status: SubmissionStatus.accepted,
      acceptedAt,
    },
  });
}

beforeAll(async () => {
  // The badge catalog is seeded by migration 20260831120000_seed_badge_catalog.
  // If it is missing, every badge assertion below would pass vacuously.
  const catalogSize = await prisma.badge.count();
  expect(catalogSize).toBeGreaterThanOrEqual(20);
});

afterAll(async () => {
  await prisma.pendingKarmaAward.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.userBadge.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.submission.deleteMany({ where: { bountyId: { in: createdBountyIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  await prisma.rank.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("karma holds", () => {
  it("writes a PendingKarmaAward on accept instead of moving the public balance, and releases it only once the dispute window has closed", async () => {
    const contributor = await makeUser("holder");
    // A 1-hour window, and an item accepted right now: the hold must NOT be
    // releasable yet.
    const bounty = await makeCommunityBounty(contributor.id, 1);
    const submission = await makeAcceptedSubmission(bounty.id, contributor.id, new Date());

    const result = await prisma.$transaction((tx) =>
      awardOrHoldAcceptedItemKarma(
        tx,
        {
          bountyId: bounty.id,
          userId: contributor.id,
          eventType: KarmaEventType.community_item_accepted,
          amount: 25,
          sourceType: "Submission",
          sourceId: submission.id,
        },
        { holdsEnabled: true },
      ),
    );
    expect(result).toEqual({ held: true, written: true });

    // The row the endpoint reads now genuinely exists — this is the defect.
    const hold = await prisma.pendingKarmaAward.findFirstOrThrow({
      where: { userId: contributor.id, sourceId: submission.id },
    });
    expect(hold.amount).toBe(25);
    expect(hold.releasedAt).toBeNull();
    expect(hold.reversedAt).toBeNull();

    // ...and nothing public moved: no karma event, balance untouched.
    expect(await prisma.karmaEvent.count({ where: { userId: contributor.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: contributor.id } })).karmaTotal).toBe(0);

    // Re-running the accept path is idempotent — no second hold.
    const replay = await prisma.$transaction((tx) =>
      awardOrHoldAcceptedItemKarma(
        tx,
        {
          bountyId: bounty.id,
          userId: contributor.id,
          eventType: KarmaEventType.community_item_accepted,
          amount: 25,
          sourceType: "Submission",
          sourceId: submission.id,
        },
        { holdsEnabled: true },
      ),
    );
    expect(replay).toEqual({ held: true, written: false });
    expect(await prisma.pendingKarmaAward.count({ where: { userId: contributor.id } })).toBe(1);

    // Sweeping NOW must not release THIS hold: its window is still open.
    // Asserting the sweep's global `released` total is 0 was wrong — the sweep
    // is machine-wide, so on a populated database it correctly releases other
    // users' genuinely-due awards (measured: 200 on migrated staging data) and
    // a working sweep read as a failure. Scope the assertion to the fixture.
    await releaseDueKarmaHolds({ now: new Date() });
    expect(
      await prisma.pendingKarmaAward.count({ where: { userId: contributor.id, releasedAt: null } }),
    ).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: contributor.id } })).karmaTotal).toBe(0);

    // Sweep after the window closes — release, and the balance moves once.
    const after = new Date(Date.now() + 2 * 3_600_000);
    const late = await releaseDueKarmaHolds({ now: after });
    expect(late.released).toBeGreaterThanOrEqual(1);

    const releasedHold = await prisma.pendingKarmaAward.findUniqueOrThrow({ where: { id: hold.id } });
    expect(releasedHold.releasedAt).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: contributor.id } })).karmaTotal).toBe(25);

    // A second sweep must not pay twice — the claim is conditional on
    // releasedAt still being null.
    await releaseDueKarmaHolds({ now: after });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: contributor.id } })).karmaTotal).toBe(25);
    expect(
      await prisma.karmaEvent.count({
        where: { userId: contributor.id, eventType: KarmaEventType.community_item_accepted },
      }),
    ).toBe(1);
  });

  it("cancels a still-held award on an upheld dispute so the sweep can never pay it out", async () => {
    const contributor = await makeUser("disputed");
    const bounty = await makeCommunityBounty(contributor.id, 1);
    const submission = await makeAcceptedSubmission(bounty.id, contributor.id, new Date());

    await prisma.$transaction((tx) =>
      queuePendingKarmaAward(tx, {
        bountyId: bounty.id,
        userId: contributor.id,
        eventType: KarmaEventType.community_item_accepted,
        amount: 25,
        sourceType: "Submission",
        sourceId: submission.id,
      }),
    );

    const reversal = await prisma.$transaction((tx) =>
      reverseAcceptedItemKarma(tx, {
        userId: contributor.id,
        sourceType: "Submission",
        sourceId: submission.id,
        reason: "dispute_upheld",
      }),
    );
    expect(reversal).toEqual({ reversed: true, state: "held" });

    const row = await prisma.pendingKarmaAward.findFirstOrThrow({ where: { sourceId: submission.id } });
    expect(row.reversedAt).not.toBeNull();
    expect(row.reversedReason).toBe("dispute_upheld");

    // Long after the window: still nothing paid, because the row was cancelled.
    await releaseDueKarmaHolds({ now: new Date(Date.now() + 72 * 3_600_000) });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: contributor.id } })).karmaTotal).toBe(0);
  });

  it("reverses a released award by appending an equal negative event, never by deleting evidence", async () => {
    const contributor = await makeUser("clawback");
    const bounty = await makeCommunityBounty(contributor.id, 1);
    const submission = await makeAcceptedSubmission(bounty.id, contributor.id, new Date(Date.now() - 5 * 3_600_000));

    await prisma.$transaction((tx) =>
      queuePendingKarmaAward(tx, {
        bountyId: bounty.id,
        userId: contributor.id,
        eventType: KarmaEventType.community_item_accepted,
        amount: 40,
        sourceType: "Submission",
        sourceId: submission.id,
      }),
    );
    await releaseDueKarmaHolds({ now: new Date() });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: contributor.id } })).karmaTotal).toBe(40);

    const reversal = await prisma.$transaction((tx) =>
      reverseAcceptedItemKarma(tx, { userId: contributor.id, sourceType: "Submission", sourceId: submission.id }),
    );
    expect(reversal.state).toBe("released");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: contributor.id } })).karmaTotal).toBe(0);
    // Both the original award and the reversal survive as evidence.
    const events = await prisma.karmaEvent.findMany({ where: { userId: contributor.id }, orderBy: { amount: "asc" } });
    expect(events.map((e) => e.amount)).toEqual([-40, 40]);
  });

  it("takes the LATER of the per-item and batch dispute clocks, so it can never release inside a window a surface is showing as open", () => {
    const acceptedAt = new Date("2026-01-01T00:00:00Z");
    const award = { sourceType: "Submission", createdAt: acceptedAt };

    // Per-item clock only.
    expect(
      holdReleasesAt(award, { disputeWindowHours: 24, disputeCycleWindowOpensAt: null }, acceptedAt, 48).toISOString(),
    ).toBe("2026-01-02T00:00:00.000Z");

    // A batch clock that opens LATER wins.
    expect(
      holdReleasesAt(
        award,
        { disputeWindowHours: 24, disputeCycleWindowOpensAt: new Date("2026-01-05T00:00:00Z") },
        acceptedAt,
        48,
      ).toISOString(),
    ).toBe("2026-01-06T00:00:00.000Z");

    // No per-bounty window snapshotted → the live admin default applies.
    expect(
      holdReleasesAt(award, { disputeWindowHours: null, disputeCycleWindowOpensAt: null }, acceptedAt, 48).toISOString(),
    ).toBe("2026-01-03T00:00:00.000Z");
  });
});

describe("badge auto-award", () => {
  it("awards an accepted-items badge only once its threshold is actually met", async () => {
    const contributor = await makeUser("badger", { profilePublic: false });
    const bounty = await makeCommunityBounty(contributor.id, 1);

    // One accepted item: "accepted_work" (threshold 1) qualifies, "items_50"
    // (threshold 50) must NOT.
    await makeAcceptedSubmission(bounty.id, contributor.id, new Date());

    const first = await syncAndListBadges(contributor.id);
    const firstKeys = first.map((b) => b.key);
    expect(firstKeys).toContain("accepted_work");
    expect(firstKeys).not.toContain("items_50");
    // A manual badge is never auto-awarded, whatever the member has done.
    expect(firstKeys).not.toContain("founding_member");

    // The award is a real persisted row, not a derived list.
    const stored = await prisma.userBadge.findMany({ where: { userId: contributor.id }, include: { badge: true } });
    expect(stored.map((r) => r.badge.key)).toContain("accepted_work");
    // Auto-awarded, so no granting admin is recorded.
    expect(stored.every((r) => r.grantedByUserId === null)).toBe(true);

    // Cross the 50-item threshold and re-evaluate.
    await prisma.submission.createMany({
      data: Array.from({ length: 49 }, (_, i) => ({
        bountyId: bounty.id,
        contributorUserId: contributor.id,
        title: `${RUN} bulk ${i}`,
        payloadJson: { prompt: `x${i}` },
        generationMethod: "human" as const,
        status: SubmissionStatus.accepted,
        acceptedAt: new Date(),
      })),
    });

    const second = await syncAndListBadges(contributor.id);
    const items50 = second.find((b) => b.key === "items_50");
    expect(items50).toBeDefined();
    // `{value}` in the catalog label resolves to the real measured amount.
    expect(items50!.label).toBe("50 items accepted");
    expect(items50!.measuredValue).toBe(50);

    // Idempotent: re-running awards nothing new.
    const before = await prisma.userBadge.count({ where: { userId: contributor.id } });
    await syncAndListBadges(contributor.id);
    expect(await prisma.userBadge.count({ where: { userId: contributor.id } })).toBe(before);
  });

  it("reports no leaderboard rank for a member who is not actually listed, so a rank badge cannot be earned off a private profile", async () => {
    const priv = await makeUser("privrank", { profilePublic: false });
    await prisma.user.update({ where: { id: priv.id }, data: { karmaTotal: 9_000, leaderboardRank: 2 } });
    expect((await collectBadgeMetrics(priv.id)).leaderboardRank).toBeNull();

    const pub = await makeUser("pubrank", { profilePublic: true });
    await prisma.user.update({ where: { id: pub.id }, data: { karmaTotal: 9_000, leaderboardRank: 2 } });
    expect((await collectBadgeMetrics(pub.id)).leaderboardRank).toBe(2);

    const top10 = await prisma.badge.findUniqueOrThrow({ where: { key: "leaderboard_top_10" } });
    // Inverted comparison: rank 2 is inside "top 10", rank 40 is not.
    expect(qualifiesFor(top10, { ...(await collectBadgeMetrics(pub.id)), leaderboardRank: 2 })).toBe(true);
    expect(qualifiesFor(top10, { ...(await collectBadgeMetrics(pub.id)), leaderboardRank: 40 })).toBe(false);
    expect(qualifiesFor(top10, { ...(await collectBadgeMetrics(pub.id)), leaderboardRank: null })).toBe(false);
  });

  it("holds a ratio badge back until its minimum sample is reached", async () => {
    const accuracy = await prisma.badge.findUniqueOrThrow({ where: { key: "flag_accuracy_95" } });
    expect(accuracy.minSample).toBe(25);
    const base = {
      verifiedCredentials: 0,
      acceptedItems: 0,
      cleanDeliveryStreak: 0,
      completedAudits: 0,
      confirmedFlags: 0,
      karmaTotal: 0,
      abandons: 0,
      publishedDatasets: 0,
      leaderboardRank: null,
    };
    // 1-for-1 is 100% accuracy and is not evidence of accuracy.
    expect(qualifiesFor(accuracy, { ...base, decidedFlags: 1, dismissedFlags: 0 })).toBe(false);
    // 30 decided, 1 dismissed = 96% over a real sample.
    expect(qualifiesFor(accuracy, { ...base, decidedFlags: 30, dismissedFlags: 1 })).toBe(true);
    // No decided flags at all is no data, not 0%.
    expect(qualifiesFor(accuracy, { ...base, decidedFlags: 0, dismissedFlags: 0 })).toBe(false);
  });

  it("renders a {value} label verbatim when there is nothing measured", () => {
    expect(renderLabel("{value} items accepted", 1234)).toBe("1,234 items accepted");
    expect(renderLabel("Founding contributor", null)).toBe("Founding contributor");
  });
});

describe("attribution", () => {
  it("excludes an opted-out contributor from the credit manifest and reports them only as a count", async () => {
    const credited = await makeUser("credited");
    const optedOut = await makeUser("optout");
    const noHandle = await makeUser("nohandle", { handle: null });
    const bounty = await makeCommunityBounty(credited.id, 1);

    for (const u of [credited, optedOut, noHandle]) {
      await makeAcceptedSubmission(bounty.id, u.id, new Date());
    }

    // Default is opt-IN: everyone with a handle is credited.
    const before = await buildContributorCredits(bounty.id, "community");
    expect(before!.credited).toEqual([credited.handle, optedOut.handle].sort());
    // The handle-less contributor is un-nameable, so counted, not named.
    expect(before!.anonymizedCount).toBe(1);

    await setAttributionPreference(optedOut.id, true);

    const after = await buildContributorCredits(bounty.id, "community");
    expect(after!.credited).toEqual([credited.handle]);
    expect(after!.credited).not.toContain(optedOut.handle);
    expect(after!.anonymizedCount).toBe(2);

    // The opt-out did not disturb the member's other visibility prefs.
    const prefs = (await prisma.user.findUniqueOrThrow({ where: { id: optedOut.id } })).publicProfilePrefs as Record<
      string,
      unknown
    >;
    expect(prefs.attributionOptOut).toBe(true);
    expect(prefs.showKarma).toBe(true);
    expect(prefs.showBadges).toBe(true);

    // ...and it is a separate axis from profile visibility.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: optedOut.id } })).profilePublic).toBe(true);

    // Rendered manifest names only the credited and states the rest honestly.
    const markdown = renderContributorCredits(after);
    expect(markdown).toContain(`- @${credited.handle}`);
    expect(markdown).not.toContain(optedOut.handle);
    expect(markdown).toContain("2 contributor(s) who opted out of public credit");
  });

  it("says so explicitly when nobody opted into public credit, rather than leaving a blank section", () => {
    expect(renderContributorCredits({ credited: [], anonymizedCount: 3 })).toContain(
      "_No contributors opted into public credit._",
    );
    // Not a community dataset → credit does not apply, which is not the same
    // as an empty credit list.
    expect(renderContributorCredits(null)).toBe("");
  });

  it("returns null for a non-community dataset instead of an empty credit list", async () => {
    const owner = await makeUser("supported");
    const bounty = await makeCommunityBounty(owner.id, 1);
    expect(await buildContributorCredits(bounty.id, "supported")).toBeNull();
  });
});
