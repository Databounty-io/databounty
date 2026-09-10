// SPDX-License-Identifier: Apache-2.0

/**
 * The admin-configurable human-audit window size (owner requirement: "the
 * validator claims a batch, 50–100, adjustable from admin").
 *
 * Until now `community.human_audit_window_size` existed in the settings
 * catalog and the console saved it, but nothing read it: every pool close-out
 * opened exactly ONE window holding the whole coverage draw, however large.
 * These tests drive the real `runPoolSamplingJob` against real rows and assert
 * the stored setting actually governs how the selected set is packed into
 * claimable windows, that the 50–100 band is enforced, and that
 * `auditCoveragePct` still decides how many items get human review.
 *
 * Self-guards like the other integration tests: refuses to run unless
 * DATABASE_URL points at the disposable verification database.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AuditMode, DatasetCategory, GenerationMethod, SubmissionStatus, AuthMethod } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { deleteAuditRowsForBounties } from "../test-support/audit-cleanup.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import {
  runPoolSamplingJob,
  clampHumanAuditWindowSize,
  HUMAN_AUDIT_WINDOW_SIZE_MIN,
  HUMAN_AUDIT_WINDOW_SIZE_MAX,
} from "./pool-lifecycle.js";

requireDisposableDatabase();

const SETTING_KEY = "community.human_audit_window_size";
const createdBountyIds: string[] = [];
const createdUserIds: string[] = [];

async function seedPool(params: { itemCount: number; auditCoveragePct: number }): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contributor = await prisma.user.create({
    data: {
      authMethod: AuthMethod.email,
      email: `pool-window-${suffix}@local.test`,
      displayName: "Window Size Fixture",
    },
  });
  createdUserIds.push(contributor.id);

  const bounty = await prisma.bounty.create({
    data: {
      requesterUserId: contributor.id,
      title: `window-size fixture ${suffix}`,
      description: "fixture pool for human-audit window sizing",
      datasetCategory: DatasetCategory.debugging,
      language: "typescript",
      framework: "none",
      targetItems: BigInt(params.itemCount),
      // Must stay BELOW targetItems: the `bounties_required_sponsor_examples_bounds`
      // CHECK (restored from V1 by migration 20260902100000) rejects the schema
      // default of 3 against these fixtures' small itemCount.
      requiredSponsorExamples: 0,
      auditMode: AuditMode.partial,
      auditCoveragePct: params.auditCoveragePct,
      holdDays: 0,
      karmaPerAcceptedItem: 25,
      acceptedItems: BigInt(params.itemCount),
      poolClosedAt: new Date(),
    },
  });
  createdBountyIds.push(bounty.id);

  await prisma.submission.createMany({
    data: Array.from({ length: params.itemCount }, (_, i) => ({
      bountyId: bounty.id,
      contributorUserId: contributor.id,
      title: `item ${i}`,
      payloadJson: { i },
      generationMethod: GenerationMethod.human,
      status: SubmissionStatus.accepted_pending_sample,
    })),
  });

  return bounty.id;
}

async function setWindowSize(value: number | null): Promise<void> {
  if (value === null) {
    await prisma.adminSetting.deleteMany({ where: { key: SETTING_KEY } });
    return;
  }
  await prisma.adminSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value },
    update: { value },
  });
}

async function windowsFor(bountyId: string) {
  return prisma.humanAuditWindow.findMany({
    where: { bountyId },
    orderBy: { windowIndex: "asc" },
    include: { memberships: true },
  });
}

let originalSetting: unknown = undefined;

beforeEach(async () => {
  const row = await prisma.adminSetting.findUnique({ where: { key: SETTING_KEY } });
  if (originalSetting === undefined) originalSetting = row ? row.value : null;
});

afterAll(async () => {
  await setWindowSize(typeof originalSetting === "number" ? originalSetting : null);
  // Audit rows RESTRICT their submissions, which the bounty delete cascades to.
  await deleteAuditRowsForBounties(createdBountyIds);
  await prisma.bounty.deleteMany({ where: { id: { in: createdBountyIds } } });
  // Karma events do not cascade from the user row, so they are cleared first.
  await prisma.karmaEvent.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("human-audit window size is a real admin control", () => {
  it("clamps any stored value into the 50–100 band and falls back to the low end on junk", () => {
    expect(clampHumanAuditWindowSize(10)).toBe(HUMAN_AUDIT_WINDOW_SIZE_MIN);
    expect(clampHumanAuditWindowSize(75)).toBe(75);
    expect(clampHumanAuditWindowSize(5_000)).toBe(HUMAN_AUDIT_WINDOW_SIZE_MAX);
    expect(clampHumanAuditWindowSize("60")).toBeNull();
    expect(clampHumanAuditWindowSize(null)).toBeNull();
    expect(clampHumanAuditWindowSize(12.5)).toBeNull();
  });

  it("splits a 100%-coverage pool into claimable windows of at most the configured size", async () => {
    await setWindowSize(50);
    const bountyId = await seedPool({ itemCount: 130, auditCoveragePct: 100 });

    const outcome = await runPoolSamplingJob(bountyId);
    expect(outcome.skipped).toBe(false);
    expect(outcome.windowSize).toBe(50);
    expect(outcome.selectedCount).toBe(130);

    const windows = await windowsFor(bountyId);
    expect(windows).toHaveLength(3); // 50 + 50 + 30

    const selectedPerWindow = windows.map((w) => w.memberships.filter((m) => m.selected).length);
    expect(selectedPerWindow).toEqual([50, 50, 30]);
    for (const count of selectedPerWindow) expect(count).toBeLessThanOrEqual(50);

    // Every selected submission appears exactly once, across all windows.
    const selectedIds = windows.flatMap((w) => w.memberships.filter((m) => m.selected).map((m) => m.submissionId));
    expect(new Set(selectedIds).size).toBe(130);

    // The continuation windows carry their OWN review load as `quota`, so the
    // settle-time failure threshold in services/audits.ts has an honest
    // denominator on each of them.
    expect(windows.map((w) => w.quota)).toEqual([50, 50, 30]);
    // The primary window still records the pool-wide draw.
    expect(windows[0]!.eligibleCount).toBe(130);
    expect(windows[0]!.closureReason).toBe("pool_target_reached");
    expect(windows[1]!.closureReason).toBe("pool_target_reached_window_split");
  });

  it("obeys a different admin value on the next close-out, with no redeploy", async () => {
    await setWindowSize(100);
    const bountyId = await seedPool({ itemCount: 130, auditCoveragePct: 100 });

    const outcome = await runPoolSamplingJob(bountyId);
    expect(outcome.windowSize).toBe(100);

    const windows = await windowsFor(bountyId);
    expect(windows).toHaveLength(2); // 100 + 30
    expect(windows.map((w) => w.memberships.filter((m) => m.selected).length)).toEqual([100, 30]);
  });

  it("clamps an out-of-band stored value (the catalog's legacy default of 10) up to 50", async () => {
    await setWindowSize(10);
    const bountyId = await seedPool({ itemCount: 60, auditCoveragePct: 100 });

    const outcome = await runPoolSamplingJob(bountyId);
    expect(outcome.windowSize).toBe(HUMAN_AUDIT_WINDOW_SIZE_MIN);

    const windows = await windowsFor(bountyId);
    expect(windows).toHaveLength(2); // 50 + 10, not 6 windows of 10
    expect(windows.map((w) => w.memberships.filter((m) => m.selected).length)).toEqual([50, 10]);
  });

  it("leaves auditCoveragePct in charge of HOW MANY items get human review", async () => {
    await setWindowSize(50);
    const bountyId = await seedPool({ itemCount: 200, auditCoveragePct: 25 });

    const outcome = await runPoolSamplingJob(bountyId);
    expect(outcome.selectedCount).toBe(50); // 25% of 200 — unchanged by the size setting
    expect(outcome.autoAcceptedCount).toBe(150);

    const windows = await windowsFor(bountyId);
    expect(windows).toHaveLength(1);
    // Unselected items keep their membership row on the primary window, so the
    // draw still reconciles against real persisted rows.
    expect(windows[0]!.memberships).toHaveLength(200);
    expect(windows[0]!.memberships.filter((m) => m.selected)).toHaveLength(50);

    const inAudit = await prisma.submission.count({ where: { bountyId, status: SubmissionStatus.in_audit } });
    expect(inAudit).toBe(50);
  });
});
