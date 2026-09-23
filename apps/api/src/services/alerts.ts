// SPDX-License-Identifier: Apache-2.0

import { SystemAlertSeverity, SystemAlertStatus, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { notifyAdminsEvent } from "./notifications.js";

/**
 * Admin alerting: detectors call emitAlert / resolveAlert and everything else
 * rides the EXISTING notification rail — transactional outbox, admin fan-out,
 * channel adapters. No parallel alert system.
 *
 * Anti-fatigue contract:
 * - A persisting condition notifies ONCE per activation (dedupeKey), then only
 *   bumps `lastSeenAt` while it persists.
 * - It re-notifies only on severity ESCALATION (warning → critical), never on
 *   de-escalation or repetition.
 * - resolveAlert posts a low-priority "recovered" note when an active
 *   condition clears, closing the loop for whoever was paged.
 *
 * Ported from v1 `src/services/alerts.ts`. The `admin.system_alert` and
 * `admin.system_recovered` events were already present in this rebuild's
 * notification catalog (`notifications/events.ts:438,445`) but had no emitter —
 * they were dead catalog entries until this service landed.
 */

const SEVERITY_RANK: Record<SystemAlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

export interface EmitAlertInput {
  /** Stable condition class, e.g. "job_backlog", "worker_stale". */
  code: string;
  severity: SystemAlertSeverity;
  /** Identity of the specific condition instance, e.g. "worker_stale:dispatch". */
  dedupeKey: string;
  /** One human sentence for the admin inbox/channel. */
  summary: string;
  /** Structured evidence for the health dashboard (counts, ages, names). */
  context?: Record<string, string | number | boolean | null>;
}

/**
 * Returns true when an admin notification was actually sent (new activation or
 * escalation), false when the alert was deduped into an existing one.
 */
export async function emitAlert(input: EmitAlertInput): Promise<boolean> {
  const now = new Date();
  const context = (input.context ?? {}) as Prisma.InputJsonValue;

  const existing = await prisma.systemAlert.findUnique({ where: { dedupeKey: input.dedupeKey } });

  const isNewActivation = !existing || existing.status === SystemAlertStatus.resolved;
  const isEscalation =
    !!existing &&
    existing.status === SystemAlertStatus.active &&
    SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity];

  const row = await prisma.systemAlert.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      code: input.code,
      dedupeKey: input.dedupeKey,
      severity: input.severity,
      status: SystemAlertStatus.active,
      context,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    update: {
      lastSeenAt: now,
      context,
      // Keep the recorded severity at the highest seen during this activation —
      // a critical alert must not quietly relabel as warning.
      ...(isNewActivation || isEscalation ? { severity: input.severity } : {}),
      ...(isNewActivation
        ? { status: SystemAlertStatus.active, firstSeenAt: now, resolvedAt: null }
        : {}),
    },
  });

  if (!isNewActivation && !isEscalation) return false;

  await notifyAdminsEvent(prisma, "admin.system_alert", {
    entityId: null,
    // Operational health alerts are for the admin console only. A regular
    // member must never receive worker/watchdog state in their personal bell.
    adminOnly: true,
    // Keyed on the ACTIVATION, not the wall clock. `firstSeenAt` is stamped
    // once when the condition activates and does not move while it stays
    // active, so this is stable for exactly as long as the incident is —
    // which is what makes the (userId, eventKey) upsert able to collapse a
    // double emit. The previous `now.getTime()` made every key unique, so if
    // one activation ever emitted twice — a retry, or two worker instances
    // racing the guard above — both rows landed in every admin's inbox with
    // nothing able to merge them. Severity stays in the key so a genuine
    // escalation within one activation is still its own notification.
    keySuffix: `${input.dedupeKey}:${input.severity}:${row.firstSeenAt.getTime()}`,
    data: { code: input.code, severity: input.severity, summary: input.summary },
  });
  return true;
}

/**
 * Clears an active alert; posts a "recovered" note so a paged admin knows the
 * condition ended. No-op (and no notification) if nothing was active.
 */
export async function resolveAlert(dedupeKey: string, summary?: string): Promise<boolean> {
  const updated = await prisma.systemAlert.updateMany({
    where: { dedupeKey, status: SystemAlertStatus.active },
    data: { status: SystemAlertStatus.resolved, resolvedAt: new Date() },
  });
  if (updated.count === 0) return false;

  const alert = await prisma.systemAlert.findUnique({ where: { dedupeKey } });
  await notifyAdminsEvent(prisma, "admin.system_recovered", {
    entityId: null,
    // Keep recoveries on the same admin-only rail as the alert that preceded
    // them; otherwise a routine worker restart leaks into member dashboards.
    adminOnly: true,
    // Same reasoning as the activation key above: `resolvedAt` identifies THIS
    // recovery and stops a re-run posting a second "recovered" note for one
    // incident. Falls back to the dedupe key alone if the row vanished.
    keySuffix: `${dedupeKey}:recovered:${alert?.resolvedAt?.getTime() ?? "unknown"}`,
    data: {
      code: alert?.code ?? dedupeKey,
      summary: summary ?? `The "${alert?.code ?? dedupeKey}" condition has cleared.`,
    },
  });
  return true;
}

/** Active alerts, most recent first — the health endpoint's alert feed. */
export async function listActiveAlerts() {
  return prisma.systemAlert.findMany({
    where: { status: SystemAlertStatus.active },
    orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }],
    take: 100,
  });
}
