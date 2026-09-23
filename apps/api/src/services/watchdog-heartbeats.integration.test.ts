// SPDX-License-Identifier: Apache-2.0

/**
 * Contract coverage for how the watchdog reports stale worker heartbeats.
 *
 * WHY THIS EXISTS. The old loop emitted one alert per stale worker,
 * unconditionally, and every alert fans out to every admin. Measured on
 * production 2026-09-22: 470 `admin.system_alert`/`admin.system_recovered`
 * rows from roughly nine real incidents — 52x amplification. The deploy on
 * 2026-08-18 alone produced 280 of them, because 28 workers all went stale at
 * the same instant and each one paged 5 admins twice (alert, then recovery
 * 60 seconds later).
 *
 * Both corrections asserted here are about matching the report to reality
 * rather than suppressing information:
 *
 *  - Every worker lives in ONE process (`worker.ts`, SINGLE-PROCESS MODEL), so
 *    "all of them stopped" is one fact, not N. A strict subset going stale is
 *    a genuinely different fact — one loop wedged while the rest tick — and
 *    must still be reported per worker.
 *  - A heartbeat row whose worker no longer exists can never tick again.
 *    Nothing deletes the row on a rename, so `pool-deadline-sweep` (renamed to
 *    `pool-reconcile-and-settle`) has held a false `critical` on the admin
 *    health page since 2026-09-09 and been re-upserted every 60 seconds since.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SystemAlertStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import { runWatchdogSweep } from "./watchdog.js";
import { touchWorkerHeartbeat } from "./worker-heartbeat.js";

requireDisposableDatabase();

const A = "wd-test-alpha";
const B = "wd-test-beta";
const C = "wd-test-gamma";
const ORPHAN = "wd-test-orphan-never-registered";

const INTERVAL_MS = 15_000;
/** Comfortably past `heartbeatStaleAfterMs(15_000)` = max(45s, 120s) = 120s. */
const STALE_AGO_MS = 10 * 60_000;

/** `touchWorkerHeartbeat` both REGISTERS the name and writes its row, which is
 *  what makes a worker "owned" by this process as far as the watchdog cares. */
async function register(...names: string[]) {
  for (const name of names) await touchWorkerHeartbeat(name, INTERVAL_MS);
}

async function setAge(name: string, agoMs: number) {
  await prisma.workerHeartbeat.update({
    where: { name },
    data: { lastRunAt: new Date(Date.now() - agoMs) },
  });
}

const activeWorkerAlerts = async () =>
  prisma.systemAlert.findMany({
    where: { code: "worker_stale", status: SystemAlertStatus.active },
    select: { dedupeKey: true },
    orderBy: { dedupeKey: "asc" },
  });

beforeEach(async () => {
  // The sweep reads EVERY heartbeat row, so the table has to be the only
  // input for these assertions to mean anything.
  await prisma.workerHeartbeat.deleteMany({});
  await prisma.systemAlert.deleteMany({ where: { code: "worker_stale" } });
});

afterAll(async () => {
  await prisma.workerHeartbeat.deleteMany({});
  await prisma.systemAlert.deleteMany({ where: { code: "worker_stale" } });
});

describe("watchdog worker-heartbeat alerts", () => {
  it("raises ONE alert when every worker is stale, not one per worker", async () => {
    // The 2026-08-18 case. Pre-fix this produced three alerts; each would then
    // fan out to every admin and pair with a recovery a minute later.
    await register(A, B, C);
    for (const name of [A, B, C]) await setAge(name, STALE_AGO_MS);

    await runWatchdogSweep();

    expect((await activeWorkerAlerts()).map((a) => a.dedupeKey)).toEqual(["worker_stale:all"]);
  }, 60_000);

  it("still names the individual worker when only a subset is stale", async () => {
    // One wedged loop while the rest tick is a different incident, and the
    // operator needs to know which one. The roll-up must not hide it.
    await register(A, B, C);
    await setAge(B, STALE_AGO_MS);

    await runWatchdogSweep();

    expect((await activeWorkerAlerts()).map((a) => a.dedupeKey)).toEqual([`worker_stale:${B}`]);
  }, 60_000);

  it("never leaves the roll-up and a per-worker alert active together", async () => {
    // Going from "one wedged" to "everything down" must swap representations,
    // not accumulate both — otherwise the admin health page shows the same
    // outage twice under two names.
    await register(A, B, C);
    await setAge(B, STALE_AGO_MS);
    await runWatchdogSweep();

    for (const name of [A, B, C]) await setAge(name, STALE_AGO_MS);
    await runWatchdogSweep();

    expect((await activeWorkerAlerts()).map((a) => a.dedupeKey)).toEqual(["worker_stale:all"]);
  }, 90_000);

  it("ignores a heartbeat row no running worker owns", async () => {
    // The `pool-deadline-sweep` case: a renamed worker's row is stale forever
    // and can never resolve itself, so alerting on it is permanent noise about
    // something that does not exist.
    await register(A);
    await prisma.workerHeartbeat.create({
      data: { name: ORPHAN, lastRunAt: new Date(Date.now() - STALE_AGO_MS), intervalMs: INTERVAL_MS },
    });

    await runWatchdogSweep();

    const keys = (await activeWorkerAlerts()).map((a) => a.dedupeKey);
    expect(keys).not.toContain(`worker_stale:${ORPHAN}`);
    expect(keys).toEqual([]);
  }, 60_000);

  it("clears the alert once the workers tick again", async () => {
    await register(A, B, C);
    for (const name of [A, B, C]) await setAge(name, STALE_AGO_MS);
    await runWatchdogSweep();
    expect(await activeWorkerAlerts()).toHaveLength(1);

    await register(A, B, C);
    await runWatchdogSweep();

    expect(await activeWorkerAlerts()).toEqual([]);
  }, 90_000);
});
