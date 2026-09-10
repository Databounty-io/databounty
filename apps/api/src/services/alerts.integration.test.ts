// SPDX-License-Identifier: Apache-2.0

/**
 * Contract coverage for the operational-alert rail (services/alerts.ts) and the
 * heartbeat staleness rule (services/worker-heartbeat.ts).
 *
 * These exist because the anti-fatigue contract is the whole value of the
 * feature and is invisible to a typecheck: an alerting system that re-notifies
 * on every sweep trains operators to ignore it, and one that never re-notifies
 * on escalation hides a warning turning into an outage. Both directions are
 * asserted here.
 *
 * Every dedupe key is suffixed with a per-run token so these tests cannot
 * collide with a live worker polling this same database, or with each other
 * under vitest's parallel file execution.
 *
 * WHY THE EXPLICIT TIMEOUTS: `emitAlert` notifies admins inline, and
 * `notifyAdminsEvent` fans out with a sequential `await notifyEvent(...)` per
 * admin user. On a clean database (a handful of admins) each case here runs in
 * milliseconds. On `databounty_community_parity_verify` as it stands today —
 * 1,552 accumulated fixture users hold the `admin` role — a single emitAlert
 * makes 1,552 sequential round-trips and blows the 5s default. The timeout is
 * sized for that polluted state so the contract is still verifiable today; it
 * is NOT evidence that alerting is slow in production. See the parity decision register
 * for the open verify-DB reset item and the O(admins) fan-out note.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SystemAlertStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { emitAlert, resolveAlert, listActiveAlerts } from "./alerts.js";
import { heartbeatStaleAfterMs } from "./worker-heartbeat.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";

requireDisposableDatabase();

// Unique per run — see the file header.
const TOKEN = `test_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
const key = (name: string) => `${name}:${TOKEN}`;

async function cleanup() {
  await prisma.systemAlert.deleteMany({ where: { dedupeKey: { contains: TOKEN } } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
});

describe("emitAlert dedupe contract", { timeout: 120_000 }, () => {
  it("notifies on first activation and stays silent while the condition persists", async () => {
    const dedupeKey = key("persist");

    const first = await emitAlert({
      code: "job_backlog",
      severity: "warning",
      dedupeKey,
      summary: "backlog growing",
      context: { backlogDepth: 501 },
    });
    expect(first).toBe(true); // new activation → admins notified

    const second = await emitAlert({
      code: "job_backlog",
      severity: "warning",
      dedupeKey,
      summary: "backlog still growing",
      context: { backlogDepth: 640 },
    });
    expect(second).toBe(false); // same activation → deduped, no second page

    // One row, not one per sweep.
    const rows = await prisma.systemAlert.findMany({ where: { dedupeKey } });
    expect(rows).toHaveLength(1);
    // ...but the evidence is refreshed so the dashboard is not stale.
    expect((rows[0]?.context as { backlogDepth: number }).backlogDepth).toBe(640);
  });

  it("re-notifies on escalation but never on de-escalation", async () => {
    const dedupeKey = key("escalate");

    await emitAlert({ code: "job_backlog", severity: "warning", dedupeKey, summary: "warning" });

    const escalated = await emitAlert({
      code: "job_backlog",
      severity: "critical",
      dedupeKey,
      summary: "now critical",
    });
    expect(escalated).toBe(true);

    // Dropping back to warning must NOT page again, and must NOT relabel the
    // recorded severity down — an active critical stays critical.
    const deEscalated = await emitAlert({
      code: "job_backlog",
      severity: "warning",
      dedupeKey,
      summary: "back to warning",
    });
    expect(deEscalated).toBe(false);

    const row = await prisma.systemAlert.findUnique({ where: { dedupeKey } });
    expect(row?.severity).toBe("critical");
  });

  it("treats a re-occurrence after resolution as a fresh activation", async () => {
    const dedupeKey = key("reactivate");

    await emitAlert({ code: "worker_stale", severity: "critical", dedupeKey, summary: "died" });
    await resolveAlert(dedupeKey, "recovered");

    const reactivated = await emitAlert({
      code: "worker_stale",
      severity: "critical",
      dedupeKey,
      summary: "died again",
    });
    expect(reactivated).toBe(true); // must page again — this is a new outage

    const row = await prisma.systemAlert.findUnique({ where: { dedupeKey } });
    expect(row?.status).toBe(SystemAlertStatus.active);
    expect(row?.resolvedAt).toBeNull();
  });
});

describe("resolveAlert", { timeout: 120_000 }, () => {
  it("clears an active alert and is a no-op the second time", async () => {
    const dedupeKey = key("resolve");
    await emitAlert({ code: "job_dead_letter", severity: "critical", dedupeKey, summary: "dead letters" });

    expect(await resolveAlert(dedupeKey, "drained")).toBe(true);

    const row = await prisma.systemAlert.findUnique({ where: { dedupeKey } });
    expect(row?.status).toBe(SystemAlertStatus.resolved);
    expect(row?.resolvedAt).not.toBeNull();

    // Nothing active left → no second "recovered" note for the same recovery.
    expect(await resolveAlert(dedupeKey, "drained again")).toBe(false);
  });

  it("does not notify for a condition that was never active", async () => {
    expect(await resolveAlert(key("never-fired"), "nothing to clear")).toBe(false);
  });
});

describe("listActiveAlerts", { timeout: 120_000 }, () => {
  it("returns active alerts and excludes resolved ones", async () => {
    const activeKey = key("listed-active");
    const resolvedKey = key("listed-resolved");

    await emitAlert({ code: "submissions_stuck", severity: "critical", dedupeKey: activeKey, summary: "stuck" });
    await emitAlert({ code: "job_backlog", severity: "warning", dedupeKey: resolvedKey, summary: "backlog" });
    await resolveAlert(resolvedKey);

    const listed = await listActiveAlerts();
    const keys = listed.map((a) => a.dedupeKey);
    expect(keys).toContain(activeKey);
    expect(keys).not.toContain(resolvedKey);
  });
});

describe("heartbeatStaleAfterMs", () => {
  it("scales with the worker's own cadence, so a slow sweep is not judged like a fast one", () => {
    // 10-minute sweep: 3 ticks.
    expect(heartbeatStaleAfterMs(600_000)).toBe(1_800_000);
  });

  it("floors at two minutes so a tight loop does not flap on a GC or deploy pause", () => {
    // 15s dispatcher: 3 × 15s = 45s would flap; the floor wins.
    expect(heartbeatStaleAfterMs(15_000)).toBe(120_000);
  });
});
