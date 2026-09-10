// SPDX-License-Identifier: Apache-2.0

/**
 * Notification service — inbox write path, transactional outbox, dispatch
 * worker and daily digest flusher.
 *
 * Ported from v1 (`databounty-api/src/services/notifications.ts`), minus the
 * paid track. Before this port, community recorded `Notification` rows and a
 * live SSE bus and stopped there: `notificationDelivery.create` appeared
 * nowhere in the codebase, so 371 notifications had produced 0 delivery rows
 * and the six channel adapters were reachable only from the connect/test
 * paths. Everything below the "outbox" heading is what closes that.
 *
 * Shape of the pipeline (identical to v1):
 *
 *   business code ──notifyEvent(tx, type, …)──▶ Notification row  ┐ one tx
 *                                            └▶ NotificationDelivery rows ┘
 *                                                      │ committed
 *   dispatchPendingNotifications() ◀── worker tick ─────┘
 *        claims each delivery with a LEASE, sends via channelRegistry,
 *        writes sent / failed(+backoff) / dead(+lastError)
 *
 *   flushDigests() collapses a user's buffered `digesting` rows into ONE
 *        `digest.summary` notification, which then dispatches normally.
 *
 * Delivery contract: the in-app row is EXACTLY-once (unique on
 * userId+eventKey). External fan-out is AT-LEAST-once — the lease stops two
 * workers sending concurrently, but a crash between "provider accepted" and
 * "row marked sent" re-delivers. None of the six transports exposes an
 * idempotency key that could close that window, so it is documented rather
 * than pretended away.
 */
import {
  ChannelKind,
  NotificationDeliveryStatus,
  NotificationStatus,
  Prisma,
  Role,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { EventEmitter } from "node:events";
import {
  channelRegistry,
  type ChannelRegistry,
} from "./notification-channels.js";
import { NotificationDeliveryError } from "../lib/notification-mailer.js";
import { enqueueJob, type WatcherFanoutPayload } from "./jobs.js";
import { EVENTS, isEventType, type EventData, type EventDefinition, type EventType } from "./notifications/events.js";
import { absoluteNotificationUrl, notificationHref } from "./notifications/href.js";
import {
  buildDigestPayload,
  digestPayloadFor,
  digestText,
  digestTitle,
} from "./notifications/digest.js";

export { notificationHref, absoluteNotificationUrl } from "./notifications/href.js";
export { EVENTS, type EventType } from "./notifications/events.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

const notificationEmitter = new EventEmitter();
notificationEmitter.setMaxListeners(1000);

export function subscribeNotificationStream(userId: string, listener: (data: unknown) => void): () => void {
  const eventName = `notify:${userId}`;
  notificationEmitter.on(eventName, listener);
  return () => {
    notificationEmitter.off(eventName, listener);
  };
}

export function subscribeAdminNotificationStream(listener: (data: unknown) => void): () => void {
  const eventName = `notify:admin`;
  notificationEmitter.on(eventName, listener);
  return () => {
    notificationEmitter.off(eventName, listener);
  };
}

/* ==========================================================================
 * Runtime settings (admin-configurable, live-read — no deploy to retune)
 * ======================================================================== */

const NOTIFICATION_SETTING_KEYS = [
  "notifications.delivery.max_attempts",
  "notifications.delivery.lease_seconds",
  "notifications.delivery.backoff_seconds",
  "notifications.digest.time",
  "notifications.digest.timezone",
] as const;

export interface NotificationRuntimeSettings {
  deliveryMaxAttempts: number;
  deliveryLeaseMs: number;
  deliveryBackoffSeconds: number[];
  /** Local "HH:MM" the daily digest is due at. */
  digestTime: string;
  digestTimeZone: string;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationRuntimeSettings = {
  deliveryMaxAttempts: 8,
  deliveryLeaseMs: 60_000,
  deliveryBackoffSeconds: [30, 60, 300, 900, 3_600, 10_800, 21_600],
  digestTime: "09:00",
  digestTimeZone: "UTC",
};

function asPositiveInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
}

function asBackoffSeconds(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback;
  const parsed = value.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function asDigestTime(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? value : fallback;
}

function asTimeZone(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value) return fallback;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return value;
  } catch {
    return fallback;
  }
}

export async function getNotificationRuntimeSettings(tx: DbClient = prisma): Promise<NotificationRuntimeSettings> {
  const rows = await tx.adminSetting.findMany({ where: { key: { in: [...NOTIFICATION_SETTING_KEYS] } } });
  const values = new Map(rows.map((row) => [row.key, row.value as unknown]));
  return {
    deliveryMaxAttempts: asPositiveInt(
      values.get("notifications.delivery.max_attempts"),
      DEFAULT_NOTIFICATION_SETTINGS.deliveryMaxAttempts,
      20
    ),
    deliveryLeaseMs:
      asPositiveInt(
        values.get("notifications.delivery.lease_seconds"),
        DEFAULT_NOTIFICATION_SETTINGS.deliveryLeaseMs / 1000,
        3_600
      ) * 1000,
    deliveryBackoffSeconds: asBackoffSeconds(
      values.get("notifications.delivery.backoff_seconds"),
      DEFAULT_NOTIFICATION_SETTINGS.deliveryBackoffSeconds
    ),
    digestTime: asDigestTime(values.get("notifications.digest.time"), DEFAULT_NOTIFICATION_SETTINGS.digestTime),
    digestTimeZone: asTimeZone(
      values.get("notifications.digest.timezone"),
      DEFAULT_NOTIFICATION_SETTINGS.digestTimeZone
    ),
  };
}

function backoffForAttempt(settings: NotificationRuntimeSettings, attempt: number): number {
  return settings.deliveryBackoffSeconds[Math.min(attempt - 1, settings.deliveryBackoffSeconds.length - 1)] ?? 60;
}

/**
 * Classify a transport failure. Unknown failures stay retryable (v1's
 * default). The persisted message is truncated and never carries a raw
 * provider response body — those can echo destination data into a
 * user-visible field.
 */
function deliveryFailure(err: unknown): { message: string; retryable: boolean } {
  if (err instanceof NotificationDeliveryError) {
    return { message: err.message.slice(0, 300), retryable: err.retryable };
  }
  if (err && typeof err === "object" && "retryable" in err && typeof (err as { retryable?: unknown }).retryable === "boolean") {
    const message = err instanceof Error ? err.message : "Destination is unavailable.";
    return { message: message.slice(0, 300), retryable: (err as { retryable: boolean }).retryable };
  }
  return { message: "Delivery failed unexpectedly. DataBounty will retry.", retryable: true };
}

/* ==========================================================================
 * Outbox — the inbox row and its delivery intents, written in ONE transaction
 * ======================================================================== */

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  eventKey: string;
  entityType?: string | null;
  entityId?: string | null;
  linkBountyId?: string | null;
  status?: NotificationStatus;
  data?: Prisma.InputJsonValue;
}

/**
 * High-priority events already represent a deadline, a blocked workflow or a
 * direct request for action; they stay on the immediate external path.
 * Everything else is real-time in the in-app feed but collected into the one
 * daily digest so a bulk upload cannot mail a contributor 400 times.
 */
function notificationStatusForType(type: string, override?: NotificationStatus): NotificationStatus {
  if (override) return override;
  if (!isEventType(type)) return NotificationStatus.pending;
  return EVENTS[type].cadence === "immediate" ? NotificationStatus.pending : NotificationStatus.digesting;
}

/**
 * Materialise delivery intents for a committed notification.
 *
 * THIS is the write that was missing. It runs inside the caller's transaction
 * alongside the `Notification` row, so a rolled-back business transaction can
 * never leave an orphan delivery, and a committed one can never leave a
 * notification with no delivery intent (the defect this port fixes).
 *
 * `digesting` rows deliberately get NO delivery rows: by definition they are
 * not delivered individually — the flusher collapses them into one
 * `digest.summary`, and that row gets its own delivery intents. Creating rows
 * here for them would either double-send or leave permanently-pending rows.
 *
 * `createMany({ skipDuplicates })` rather than upsert: the unique
 * (notificationId, channel) makes a re-emit of the same event a no-op, which
 * is what preserves v1's idempotency under retry.
 */
async function createDeliveryIntents(
  tx: DbClient,
  notification: { id: string; userId: string; status: NotificationStatus; type: string }
): Promise<number> {
  if (notification.status !== NotificationStatus.pending) return 0;
  const channels = await tx.notificationChannel.findMany({
    where: {
      userId: notification.userId,
      connected: true,
      verified: true,
      deliver: true,
      ...(notification.type === "digest.summary" ? { deliverDigest: true } : {}),
    },
    select: { channel: true, address: true },
  });
  if (channels.length === 0) return 0;
  const created = await tx.notificationDelivery.createMany({
    data: channels.map((channel) => ({
      notificationId: notification.id,
      channel: channel.channel,
      address: channel.address,
      status: NotificationDeliveryStatus.pending,
    })),
    skipDuplicates: true,
  });
  return created.count;
}

/**
 * Low-level inbox write. Idempotent on (userId, eventKey): the same event
 * emitted twice produces ONE row and ONE set of delivery intents.
 *
 * The advisory lock serialises only that one idempotency key — Prisma's
 * upsert can still take a read-then-insert path under concurrent interactive
 * transactions, so two workers emitting the same event would otherwise race
 * into a P2002. Unrelated users/events proceed independently.
 */
export async function notify(tx: DbClient, input: NotifyInput) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`notification:${input.userId}:${input.eventKey}`}))`;
  const status = notificationStatusForType(input.type, input.status);
  const row = await tx.notification.upsert({
    where: { userId_eventKey: { userId: input.userId, eventKey: input.eventKey } },
    create: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      status,
      eventKey: input.eventKey,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      linkBountyId: input.linkBountyId ?? null,
      data: input.data ?? Prisma.DbNull,
    },
    // Empty on purpose: a re-emitted event must not resurrect a row the user
    // already read, nor reset its delivery state.
    update: {},
  });
  await createDeliveryIntents(tx, row);
  notificationEmitter.emit(`notify:${input.userId}`, row);
  return row;
}

export interface EmitEventInput {
  userId: string;
  entityId?: string | null;
  data?: EventData;
  /** Overrides the eventKey suffix; defaults to entityId (falls back to
   * userId). The suffix is what makes an event idempotent. */
  keySuffix?: string;
  /** Bounty id for an audience-specific deep link when entityId is a
   * batch/audit id rather than the dataset itself. */
  linkBountyId?: string | null;
}

/**
 * The one call site business code should use. Emits a catalog **event** — the
 * definition supplies category/entityType/priority/cadence and renders the
 * neutral title/body, so callers never hand-write strings or pick channels.
 * Runs inside the caller's tx (transactional outbox).
 */
export async function notifyEvent(tx: DbClient, type: EventType, input: EmitEventInput) {
  const def: EventDefinition = EVENTS[type];
  const { title, body } = def.render(input.data ?? {});
  const suffix = input.keySuffix ?? input.entityId ?? input.userId;
  return notify(tx, {
    userId: input.userId,
    type,
    title,
    body,
    eventKey: `${type}:${suffix}`,
    entityType: def.entityType,
    entityId: input.entityId ?? null,
    linkBountyId: input.linkBountyId ?? null,
  });
}

/**
 * Role-addressed fan-out for admin-console events. Resolves the CURRENT set
 * of admin/member/support users and emits to each — reusing the same outbox
 * path as any other notification, never a globally visible row. Per-admin
 * idempotent: the eventKey is namespaced per recipient, so a retried business
 * transaction never doubles an admin's inbox row.
 */
export async function notifyAdminsEvent(
  tx: DbClient,
  type: EventType,
  input: { entityId?: string | null; data?: EventData; keySuffix?: string; adminOnly?: boolean } = {}
): Promise<number> {
  const roles = input.adminOnly ? [Role.admin] : [Role.admin, Role.member, Role.support];
  const admins = await tx.userRole.findMany({
    where: { role: { in: roles } },
    select: { userId: true },
    distinct: ["userId"],
  });
  for (const { userId } of admins) {
    await notifyEvent(tx, type, {
      userId,
      entityId: input.entityId ?? null,
      data: input.data,
      keySuffix: input.keySuffix,
    });
  }
  notificationEmitter.emit("notify:admin", { type, ...input });
  return admins.length;
}

/* ==========================================================================
 * Backwards-compatible façade
 *
 * Every existing caller in this codebase (routes/v1/community.ts,
 * routes/v1/bounties.ts, routes/v1/admin-issues.ts, services/validation.ts,
 * services/audits.ts, services/issues.ts, services/pool-lifecycle.ts) passes
 * an explicit type/title/body. Those signatures are preserved EXACTLY so the
 * delivery fix lands without touching a single call site — they route through
 * `notify()` now, so they materialise delivery rows and actually get sent.
 *
 * New code should prefer `notifyEvent` / `notifyAdminsEvent`, which take the
 * title/body from the catalog.
 * ======================================================================== */

export async function notifyUser(params: {
  userId: string;
  type: string;
  title: string;
  body: string;
  eventKey?: string;
  entityType?: string;
  entityId?: string;
  linkBountyId?: string;
  data?: Record<string, unknown>;
  /** Pass the caller's transaction to make this a true transactional outbox
   * write. Omitted → its own implicit transaction (still atomic for the
   * notification + its delivery intents, just not with the business change). */
  tx?: DbClient;
}) {
  const eventKey =
    params.eventKey ?? `${params.type}:${params.entityId ?? params.userId}:${Date.now()}`;
  const run = (db: DbClient) =>
    notify(db, {
      userId: params.userId,
      type: params.type,
      title: params.title,
      body: params.body,
      eventKey,
      entityType: params.entityType,
      entityId: params.entityId,
      linkBountyId: params.linkBountyId,
      data: params.data as Prisma.InputJsonValue | undefined,
    });

  try {
    if (params.tx) return await run(params.tx);
    return await prisma.$transaction((tx) => run(tx));
  } catch (err) {
    // A notification must never take down the business action that triggered
    // it. The failure is logged, not swallowed silently — and because nothing
    // was written, nothing is later reported as delivered.
    console.error(`[notifications] failed to notify user ${params.userId}:`, err);
    return null;
  }
}

export async function notifyAdmins(params: {
  type: string;
  title: string;
  body: string;
  eventKey?: string;
  entityType?: string;
  entityId?: string;
  linkBountyId?: string;
  data?: Record<string, unknown>;
  /** Restrict to full `admin` role holders for sensitive events. */
  adminOnly?: boolean;
  tx?: DbClient;
}) {
  const roles = params.adminOnly ? [Role.admin] : [Role.admin, Role.member, Role.support];
  const db = params.tx ?? prisma;
  const admins = await db.userRole.findMany({
    where: { role: { in: roles } },
    select: { userId: true },
    distinct: ["userId"],
  });

  for (const { userId } of admins) {
    await notifyUser({
      userId,
      type: params.type,
      title: params.title,
      body: params.body,
      // Namespaced per recipient so the (userId, eventKey) unique makes each
      // admin's row idempotent rather than colliding across admins.
      eventKey: params.eventKey ? `admin:${userId}:${params.eventKey}` : undefined,
      entityType: params.entityType,
      entityId: params.entityId,
      linkBountyId: params.linkBountyId,
      data: params.data,
      tx: params.tx,
    });
  }

  notificationEmitter.emit("notify:admin", params);
  return admins.length;
}

/** Persist one idempotent inbox event for every validation stage in a run. */
export async function notifyValidationStageResults(
  tx: DbClient,
  input: {
    userId: string;
    submissionId: string;
    item: string;
    keyBase: string;
    steps: { stage: string; outcome: string; detail?: string }[];
    linkBountyId?: string | null;
  }
): Promise<void> {
  for (const step of input.steps) {
    await notifyEvent(tx, "validation.stage_result", {
      userId: input.userId,
      entityId: input.submissionId,
      linkBountyId: input.linkBountyId ?? null,
      keySuffix: `${input.keyBase}:${step.stage}`,
      data: { item: input.item, stage: step.stage, outcome: step.outcome, detail: step.detail },
    });
  }
}

/* ==========================================================================
 * New-work / audit-available watch alerts
 *
 * These go through the durable `notifications.fanout_watchers` job, exactly as
 * v1 does (services/notifications.ts `emitNewWorkMatches` /
 * `processNotificationFanoutJobs`). The emit functions write ONE cheap queue
 * row — optionally inside the caller's transaction, making it a true
 * transactional outbox write — and `runWatcherFanoutJob` does the paginated
 * watch-matching plus the per-recipient `notifyEvent` loop afterwards, in the
 * worker, outside any business transaction.
 *
 * An earlier note here claimed community's `dbJobQueue` had "a closed JobType
 * union and no tx-aware enqueue" and therefore ran the matcher inline. Both
 * halves of that are false now: `notifications.fanout_watchers` is in the
 * union with a documented payload, and `enqueue`/`enqueueJob` both accept a
 * `tx`. Running it inline also meant a worker/API crash in the window between
 * the business commit and the scan silently lost every watcher alert for that
 * dataset, with nothing left to retry from.
 *
 * Two independent dedupe layers keep repeats harmless: the queue key is
 * entity-scoped (one job per bounty/window), and `notifyEvent`'s per-recipient
 * eventKey upsert means a retried or double-claimed job re-notifies nobody.
 * ======================================================================== */

const WATCHER_PAGE_SIZE = 500;

async function fanOutWatchers(
  eventType: EventType,
  bounty: { id: string; title: string; datasetCategory: string; language: string; requesterUserId: string; domain: string }
): Promise<number> {
  const where = {
    enabled: true,
    domains: { has: bounty.domain },
    ...(bounty.domain === "coding"
      ? { categories: { has: bounty.datasetCategory }, languages: { has: bounty.language } }
      : {}),
    // Never alert the dataset's own requester about their own dataset.
    userId: { not: bounty.requesterUserId },
  };
  let cursor: string | undefined;
  let notified = 0;
  for (;;) {
    const page = await prisma.watchPref.findMany({
      where,
      select: { userId: true },
      take: WATCHER_PAGE_SIZE,
      ...(cursor ? { cursor: { userId: cursor }, skip: 1 } : {}),
      orderBy: { userId: "asc" },
    });
    for (const { userId } of page) {
      await prisma
        .$transaction((tx) =>
          notifyEvent(tx, eventType, { userId, entityId: bounty.id, data: { bounty: bounty.title } })
        )
        .then(() => {
          notified += 1;
        })
        .catch((err) => {
          console.error(`[notifications] watch alert failed for ${userId}`, err);
        });
    }
    if (page.length < WATCHER_PAGE_SIZE) break;
    cursor = page[page.length - 1]?.userId;
  }
  return notified;
}

interface WatchAlertBounty {
  id: string;
  title: string;
  datasetCategory: string;
  language: string;
  requesterUserId: string;
  domain: string;
}

function fanoutPayload(kind: WatcherFanoutPayload["kind"], bounty: WatchAlertBounty): WatcherFanoutPayload {
  return {
    kind,
    // Always the BOUNTY id: user-facing idempotency and the queue deep-link
    // are bounty-scoped. Never substitute a window/batch id here or the same
    // dataset produces one duplicate-looking card per window.
    entityId: bounty.id,
    bountyTitle: bounty.title,
    domain: bounty.domain,
    datasetCategory: bounty.datasetCategory,
    language: bounty.language,
    requesterUserId: bounty.requesterUserId,
  };
}

/** A community dataset opened to the pool — alert matching contributors.
 * Enqueues the fan-out job; pass `tx` to make it atomic with the mint. */
export async function emitNewWorkMatches(
  bounty: WatchAlertBounty,
  tx?: Prisma.TransactionClient
): Promise<void> {
  await enqueueJob("notifications.fanout_watchers", fanoutPayload("new_work_match", bounty), {
    idempotencyKey: `fanout:new_work_match:${bounty.id}`,
    // Watcher fan-out writes rows for every matching watcher platform-wide,
    // not for the sponsor's tenant, so it is deliberately untenanted.
    tx,
  });
}

/**
 * Validator-side counterpart: audit work became claimable on a dataset.
 *
 * `windowId` (v1's `auditId`) only scopes the QUEUE key, so several windows
 * opening for one bounty each get their own retryable job. The recipient
 * notification stays keyed to the DATASET — validators work from one queue per
 * dataset, so a card per window creates duplicate-looking alerts when several
 * become available together.
 */
export async function emitAuditAvailableMatches(
  bounty: WatchAlertBounty,
  windowId?: string,
  tx?: Prisma.TransactionClient
): Promise<void> {
  await enqueueJob("notifications.fanout_watchers", fanoutPayload("audit_available", bounty), {
    idempotencyKey: `fanout:audit_available:${windowId ?? bounty.id}`,
    tx,
  });
}

/**
 * `notifications.fanout_watchers` handler. Expands one fan-out job into the
 * real per-watcher notifications, paginated (never one unbounded `findMany`)
 * and outside any business transaction.
 *
 * The payload carries the match axes rather than re-reading the bounty, so a
 * bounty edited between enqueue and run cannot silently change who the queued
 * alert reaches.
 */
export async function runWatcherFanoutJob(payload: WatcherFanoutPayload): Promise<number> {
  const eventType: EventType = payload.kind === "new_work_match" ? "work.new_match" : "audit.available";
  return fanOutWatchers(eventType, {
    id: payload.entityId,
    title: payload.bountyTitle,
    datasetCategory: payload.datasetCategory,
    language: payload.language,
    requesterUserId: payload.requesterUserId,
    domain: payload.domain,
  });
}

/* ==========================================================================
 * Reads
 * ======================================================================== */

/** Opaque keyset cursor: base64url(`${createdAt ISO}|${id}`), matching the
 *  `createdAt desc, id desc` ordering below. Offset paging is not stable here
 *  — every notification that arrives mid-walk shifts the whole list, so a
 *  client either re-reads or skips rows — which is why v1 pages notifications
 *  by cursor. `offset` is retained for existing callers; `cursor` wins when
 *  both are supplied. */
function encodeNotificationCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

export class NotificationCursorError extends Error {}

function decodeNotificationCursor(cursor: string): { createdAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const createdAt = at ? new Date(at) : null;
  // A malformed cursor is an ERROR, never an empty page: an empty page reads
  // to an agent as "you have no more notifications", which is a lie.
  if (!id || !createdAt || Number.isNaN(createdAt.getTime())) throw new NotificationCursorError("Invalid notification cursor.");
  return { createdAt, id };
}

export async function listNotifications(
  userId: string,
  params?: { limit?: number; offset?: number; unreadOnly?: boolean; cursor?: string }
) {
  const take = Math.min(params?.limit ?? 50, 100);
  const skip = params?.offset ?? 0;
  const where: Prisma.NotificationWhereInput = {
    userId,
    // `admin.*` rows (notifyAdminsEvent — system alerts, agent-issue aging,
    // dispute filings) belong exclusively in the dedicated admin console
    // feed (routes/v1/admin-notifications.ts, which filters the OPPOSITE
    // direction — `type: { startsWith: "admin." } }` — to keep an admin's
    // own personal notifications out of their ops view). This is the other
    // half of that same separation: without it, any account that also holds
    // an admin/member/support role got operational alerts (job dead-letter,
    // stuck-submission watchdog, agent-issue escalation) mixed directly into
    // their personal contributor/sponsor/validator bell — confirmed live on
    // the dev deployment, where every one of an admin test account's 7
    // "personal" notifications was actually an admin.* ops alert.
    type: { not: { startsWith: "admin." } },
    ...(params?.unreadOnly ? { read: false } : {}),
  };
  const decoded = params?.cursor ? decodeNotificationCursor(params.cursor) : null;
  const pageWhere: Prisma.NotificationWhereInput = decoded
    ? {
        ...where,
        OR: [{ createdAt: { lt: decoded.createdAt } }, { createdAt: decoded.createdAt, id: { lt: decoded.id } }],
      }
    : where;

  const [rows, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: pageWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(decoded ? {} : { skip }),
    }),
    prisma.notification.count({ where }),
    // Same admin.* exclusion as `where` above — this is a separately
    // constructed literal (the unread-badge count), not derived from `where`,
    // so it needs its own copy of the filter or the personal unread badge
    // would still count admin ops alerts.
    prisma.notification.count({ where: { userId, read: false, type: { not: { startsWith: "admin." } } } }),
  ]);

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const last = items[items.length - 1];
  return {
    items,
    total,
    unreadCount,
    limit: take,
    offset: decoded ? null : skip,
    hasMore,
    nextCursor: hasMore && last ? encodeNotificationCursor(last) : null,
  };
}

export async function markNotificationRead(userId: string, notificationId: string) {
  return prisma.notification.updateMany({ where: { id: notificationId, userId }, data: { read: true } });
}

export async function markAllNotificationsRead(userId: string) {
  // Same admin.* exclusion as listNotifications: only the personal route and
  // the list_notifications/mark-all-read MCP tool call this. Without the
  // exclusion, marking a personal inbox "all read" would silently clear an
  // admin's still-open ops alerts (e.g. a dead-lettered job needing manual
  // retry) that they never actually saw here — the admin console's own
  // unread badge would then read 0 for something still unresolved.
  return prisma.notification.updateMany({
    where: { userId, read: false, type: { not: { startsWith: "admin." } } },
    data: { read: true },
  });
}

export async function seedEmailNotificationChannel(userId: string, email: string) {
  try {
    await prisma.notificationChannel.upsert({
      where: { userId_channel: { userId, channel: ChannelKind.email } },
      create: {
        userId,
        channel: ChannelKind.email,
        address: email.toLowerCase(),
        connected: true,
        verified: true,
        verifiedAt: new Date(),
        deliver: true,
        deliverDigest: true,
      },
      update: { address: email.toLowerCase() },
    });
  } catch (err) {
    console.error(`[notifications] failed to seed email channel for user ${userId}:`, err);
  }
}

export async function ensureDefaultWatchPref(userId: string) {
  try {
    const existing = await prisma.watchPref.findUnique({ where: { userId } });
    if (!existing) {
      await prisma.watchPref.create({
        data: {
          userId,
          enabled: true,
          domains: ["coding"],
          categories: ["debugging", "implementation", "test_generation"],
          languages: ["TypeScript", "Python", "JavaScript", "Go", "Rust"],
        },
      });
    }
  } catch (err) {
    console.error(`[notifications] failed to ensure watch prefs for user ${userId}:`, err);
  }
}

export async function getWatchPref(userId: string) {
  return prisma.watchPref.findUnique({ where: { userId } });
}

export async function updateWatchPref(
  userId: string,
  params: { enabled?: boolean; domains?: string[]; categories?: string[]; languages?: string[] }
) {
  return prisma.watchPref.upsert({
    where: { userId },
    create: {
      userId,
      enabled: params.enabled ?? true,
      domains: params.domains ?? ["coding"],
      categories: params.categories ?? [],
      languages: params.languages ?? [],
    },
    update: {
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(params.domains !== undefined ? { domains: params.domains } : {}),
      ...(params.categories !== undefined ? { categories: params.categories } : {}),
      ...(params.languages !== undefined ? { languages: params.languages } : {}),
    },
  });
}

/* ==========================================================================
 * Dispatch worker
 * ======================================================================== */

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const DISPATCH_BATCH_LIMIT = positiveIntFromEnv(process.env.NOTIFICATIONS_DISPATCH_LIMIT, 250);
const DISPATCH_CONCURRENCY = positiveIntFromEnv(process.env.NOTIFICATIONS_DISPATCH_CONCURRENCY, 16);

/**
 * Poll one batch of committed `pending` (and retry-due) notifications and fan
 * them out. Transport is injected via `adapters` so this stays decoupled from
 * any concrete channel — this function never imports a transport SDK.
 *
 * Concurrency-safe under multiple workers: each delivery is claimed with a
 * lease before sending, so overlapping dispatchers never double-deliver.
 *
 * Per-user ordering: the candidate set is reduced to at most ONE row per user
 * per tick (their oldest not-yet-done one), so a user's next notification is
 * never attempted until the current one reaches a terminal state. That is a
 * hard invariant, not a probability. Different users still dispatch in
 * parallel.
 */
export async function dispatchPendingNotifications(
  limit = DISPATCH_BATCH_LIMIT,
  adapters: ChannelRegistry = channelRegistry,
  concurrency = DISPATCH_CONCURRENCY
): Promise<{ processed: number; failed: number }> {
  const now = new Date();
  const settings = await getNotificationRuntimeSettings();

  const candidates = await prisma.notification.findMany({
    where: {
      OR: [
        { status: NotificationStatus.pending },
        {
          status: NotificationStatus.done,
          deliveries: {
            some: {
              OR: [
                { status: NotificationDeliveryStatus.failed, nextAttemptAt: { lte: now } },
                { status: NotificationDeliveryStatus.processing, nextAttemptAt: { lte: now } },
              ],
            },
          },
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    // Prisma applies `distinct` post-query on relational databases, so the
    // limit applies to distinct users rather than the first N rows — one user
    // with a large backlog cannot starve everyone else out of the batch.
    distinct: ["userId"],
    take: limit,
  });

  const rows = candidates.slice(0, limit);

  /**
   * Deliver ONE notification over ONE channel. Resolves `true` when the
   * delivery is still expected to be retried (so the parent notification must
   * stay out of `done`), `false` when it reached a terminal state.
   */
  const dispatchChannel = async (
    row: (typeof rows)[number],
    channel: { id: string; userId: string; channel: ChannelKind; address: string }
  ): Promise<boolean> => {
    // Re-check the preference immediately before delivering. This closes the
    // "muted while queued" race: a routine digest queued before the user
    // opted out is completed without an external send.
    if (row.type === "digest.summary") {
      const current = await prisma.notificationChannel.findUnique({
        where: { id: channel.id },
        select: { connected: true, verified: true, deliver: true, deliverDigest: true },
      });
      if (!current?.connected || !current.verified || !current.deliver || !current.deliverDigest) return false;
    }

    // Create-or-get the delivery row. The intent normally already exists
    // (written in the same transaction as the notification); this covers the
    // late-binding case where the user connected a channel AFTER the
    // notification was recorded. Under concurrent workers two passes can both
    // find no row and race to create it; the loser gets P2002 on
    // (notificationId, channel) — tolerate it by re-reading rather than
    // failing the whole tick.
    const deliveryWhere = { notificationId_channel: { notificationId: row.id, channel: channel.channel } };
    const delivery = await prisma.notificationDelivery
      .upsert({
        where: deliveryWhere,
        create: { notificationId: row.id, channel: channel.channel, address: channel.address },
        update: {},
      })
      .catch(async (err) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return prisma.notificationDelivery.findUniqueOrThrow({ where: deliveryWhere });
        }
        throw err;
      });

    if (delivery.status === NotificationDeliveryStatus.sent || delivery.status === NotificationDeliveryStatus.dead) {
      return false;
    }
    if (delivery.status === NotificationDeliveryStatus.failed && delivery.nextAttemptAt && delivery.nextAttemptAt > now) {
      return true;
    }
    if (delivery.status === NotificationDeliveryStatus.processing && delivery.nextAttemptAt && delivery.nextAttemptAt > now) {
      return true;
    }

    const leaseUntil = new Date(Date.now() + settings.deliveryLeaseMs);
    const claimed = await prisma.notificationDelivery.updateMany({
      where: {
        id: delivery.id,
        OR: [
          { status: NotificationDeliveryStatus.pending },
          { status: NotificationDeliveryStatus.failed, nextAttemptAt: { lte: now } },
          { status: NotificationDeliveryStatus.processing, nextAttemptAt: { lte: now } },
        ],
      },
      data: { status: NotificationDeliveryStatus.processing, nextAttemptAt: leaseUntil },
    });
    if (claimed.count === 0) {
      // Another worker (or another task in this same tick) holds the lease.
      // This is the DB-level guard that makes parallel dispatch safe.
      return true;
    }

    try {
      const href = absoluteNotificationUrl(row.type, row.entityType, row.entityId, row.linkBountyId);
      await adapters[channel.channel](
        channel.address,
        {
          title: row.title,
          body: row.body,
          href,
          digest: digestPayloadFor(row),
        },
        { userId: channel.userId }
      );
      // Keep the crash window minimal: write `sent` immediately after the
      // adapter returns (see the at-least-once note in the file header).
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: NotificationDeliveryStatus.sent,
          attempts: { increment: 1 },
          sentAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
        },
      });
      // Channel health is a CURRENT-state indicator: a retry that succeeds
      // after a transient failure must clear the stale warning, or the UI
      // keeps saying "will retry" with nothing queued.
      await prisma.notificationChannel.updateMany({
        where: { id: channel.id },
        data: { lastError: null, lastFailureAt: null, lastSuccessAt: new Date() },
      });
      return false;
    } catch (err) {
      const attempts = delivery.attempts + 1;
      const failure = deliveryFailure(err);
      const terminal = !failure.retryable || attempts >= settings.deliveryMaxAttempts;
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: terminal ? NotificationDeliveryStatus.dead : NotificationDeliveryStatus.failed,
          attempts: { increment: 1 },
          nextAttemptAt: terminal ? null : new Date(Date.now() + backoffForAttempt(settings, attempts) * 1000),
          lastError: failure.message,
        },
      });
      await prisma.notificationChannel.updateMany({
        where: { id: channel.id },
        data: {
          lastError: failure.message,
          lastFailureAt: new Date(),
          // A permanently-failing destination stops being delivered to. The
          // channel keeps its row and its honest error, so the user sees WHY
          // it stopped rather than silently receiving nothing.
          ...(terminal && !failure.retryable ? { deliver: false } : {}),
        },
      });
      return !terminal;
    }
  };

  const dispatchRow = async (row: (typeof rows)[number]) => {
    const channels = await prisma.notificationChannel.findMany({
      where: {
        userId: row.userId,
        connected: true,
        verified: true,
        deliver: true,
        ...(row.type === "digest.summary" ? { deliverDigest: true } : {}),
      },
      select: { id: true, userId: true, channel: true, address: true },
    });
    // Channels of one notification are independent transports; a stalled
    // webhook must not hold up that user's email, and there is no ordering
    // relationship BETWEEN channels — only within one.
    const outcomes = await Promise.all(channels.map((channel) => dispatchChannel(row, channel)));
    if (!outcomes.some(Boolean)) {
      await prisma.notification.update({ where: { id: row.id }, data: { status: NotificationStatus.done } });
    }
  };

  // Bounded-concurrency fan-out. `rows` is already at most one row per user,
  // so parallelism cannot reorder any single user's notifications, and
  // double-delivery is still prevented by the per-delivery lease claim.
  let cursor = 0;
  const failures: unknown[] = [];
  const runners = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++]!;
      try {
        await dispatchRow(row);
      } catch (err) {
        failures.push(err);
        console.error(`[notifications] dispatch failed for notification ${row.id}`, err);
      }
    }
  });
  await Promise.all(runners);

  return { processed: rows.length, failed: failures.length };
}

/* ==========================================================================
 * Digest flusher
 * ======================================================================== */

const DIGEST_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function digestSchedule(now: Date, settings: Pick<NotificationRuntimeSettings, "digestTime" | "digestTimeZone">) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: settings.digestTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  const [scheduledHour = 0, scheduledMinute = 0] = settings.digestTime.split(":").map(Number);
  const currentMinutes = Number(value("hour")) * 60 + Number(value("minute"));
  return {
    day,
    // Stable UTC day: the local schedule controls WHEN it runs, but a
    // time-zone change must not produce a second routine email on the same
    // durable delivery day.
    idempotencyDay: now.toISOString().slice(0, 10),
    due: currentMinutes >= scheduledHour * 60 + scheduledMinute,
  };
}

/**
 * Collapse each user's buffered `digesting` rows into ONE `digest.summary`
 * notification, which then dispatches through the normal path.
 *
 * Race-safe: the summary is written inside a transaction that ATOMICALLY
 * claims exactly the rows it summarises (`updateMany` guarded on
 * `status: digesting`). Two flushers can read the same set; the one that
 * commits first flips them to `done` and the loser's updateMany matches 0 and
 * backs off, so only one summary is ever produced. The deterministic eventKey
 * is a second guard.
 */
export async function flushDigests(maxUsers = 100, now = new Date()) {
  const settings = await getNotificationRuntimeSettings();
  const schedule = digestSchedule(now, settings);
  if (!schedule.due) return { flushedUsers: 0, failedUsers: 0 };

  const grouped = await prisma.notification.groupBy({
    by: ["userId"],
    where: { status: NotificationStatus.digesting },
    _count: { _all: true },
    _min: { createdAt: true },
    orderBy: { userId: "asc" },
    take: maxUsers,
  });
  if (grouped.length === 0) return { flushedUsers: 0, failedUsers: 0 };

  const floor = new Date(now.getTime() - DIGEST_MAX_WINDOW_MS);

  const flushOne = async (group: (typeof grouped)[number]): Promise<boolean> => {
    return prisma.$transaction(async (tx) => {
      const digestEventKey = `digest:${group.userId}:${schedule.idempotencyDay}`;
      const alreadyFlushed = await tx.notification.findUnique({
        where: { userId_eventKey: { userId: group.userId, eventKey: digestEventKey } },
        select: { id: true },
      });
      if (alreadyFlushed) return false;

      const rows = await tx.notification.findMany({
        where: {
          userId: group.userId,
          status: NotificationStatus.digesting,
          // Never resurrect a week-old backlog into today's digest.
          createdAt: { gte: floor },
        },
        orderBy: { createdAt: "asc" },
      });
      if (rows.length === 0) return false;

      const claimed = await tx.notification.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, status: NotificationStatus.digesting },
        data: { status: NotificationStatus.done },
      });
      if (claimed.count === 0) return false;

      const payload = buildDigestPayload(rows, notificationHref, schedule.day, settings.digestTimeZone);
      await notify(tx, {
        userId: group.userId,
        type: "digest.summary",
        title: digestTitle(payload),
        body: digestText(payload),
        eventKey: digestEventKey,
        entityType: "digest",
        entityId: null,
        status: NotificationStatus.pending,
        data: payload as unknown as Prisma.InputJsonValue,
      });
      return true;
    });
  };

  let flushedUsers = 0;
  let failedUsers = 0;
  // Per-recipient error isolation: recipients are selected `orderBy userId
  // asc, take N`, so one that reliably throws would otherwise sit in the
  // window every tick and block everyone behind it — head-of-line blocking on
  // a once-daily job.
  for (const group of grouped) {
    try {
      if (await flushOne(group)) flushedUsers += 1;
    } catch (err) {
      failedUsers += 1;
      console.error("[notifications] digest flush failed for a recipient", {
        userId: group.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { flushedUsers, failedUsers };
}

/* ==========================================================================
 * Operator visibility
 * ======================================================================== */

/**
 * Per-channel delivery counts by status over a lookback window, plus the
 * actual dead-lettered rows (listed, not just counted) so an operator can see
 * WHAT failed. Pure read over data the dispatcher already records.
 */
export async function getNotificationDeliveryHealth(windowHours = 24) {
  const since = new Date(Date.now() - windowHours * 3_600_000);
  const grouped = await prisma.notificationDelivery.groupBy({
    by: ["channel", "status"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });

  const byChannel: Record<string, Record<NotificationDeliveryStatus, number> & { total: number }> = {};
  for (const kind of Object.values(ChannelKind)) {
    byChannel[kind] = { pending: 0, processing: 0, sent: 0, failed: 0, dead: 0, total: 0 };
  }
  for (const g of grouped) {
    const bucket = byChannel[g.channel];
    if (!bucket) continue;
    bucket[g.status] = g._count._all;
    bucket.total += g._count._all;
  }

  const deadWhere = { status: NotificationDeliveryStatus.dead, createdAt: { gte: since } };
  const [deadLetterCount, deadLetters] = await Promise.all([
    prisma.notificationDelivery.count({ where: deadWhere }),
    prisma.notificationDelivery.findMany({
      where: deadWhere,
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true,
        channel: true,
        attempts: true,
        lastError: true,
        updatedAt: true,
        notification: { select: { userId: true, type: true, title: true } },
      },
    }),
  ]);

  return {
    windowHours,
    byChannel,
    deadLetterCount,
    deadLetters,
    deadLettersTruncated: deadLetterCount > deadLetters.length,
  };
}

/**
 * Requeue one dead-lettered delivery: reset it (and the parent notification,
 * so the dispatcher's candidate query picks it back up) to `pending`. Also
 * re-enables the channel if a non-retryable failure had flipped `deliver`
 * off, since a manual retry implies the operator believes the cause is fixed.
 * A fresh attempt, not a guarantee.
 */
export async function requeueDeadLetter(deliveryId: string) {
  return prisma.$transaction(async (tx) => {
    const delivery = await tx.notificationDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) return { notFound: true } as const;
    if (delivery.status !== NotificationDeliveryStatus.dead) return { notRetryable: true } as const;

    const updated = await tx.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: NotificationDeliveryStatus.pending, attempts: 0, nextAttemptAt: null, lastError: null },
    });
    const notification = await tx.notification.update({
      where: { id: delivery.notificationId },
      data: { status: NotificationStatus.pending },
    });
    await tx.notificationChannel.updateMany({
      where: { userId: notification.userId, channel: delivery.channel, deliver: false },
      data: { deliver: true },
    });
    return { notFound: false, notRetryable: false, delivery: updated } as const;
  });
}
