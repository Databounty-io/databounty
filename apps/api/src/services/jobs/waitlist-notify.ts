// SPDX-License-Identifier: Apache-2.0

/**
 * `waitlist.notify_domain_live` — the launch email behind the public site's
 * "we'll notify you the moment it opens" promise.
 *
 * Ported from v1 `databounty-api/src/services/waitlist-notify.ts`
 * (`enqueueDomainLiveNotificationIfNewlyLive`, `drainDomainWaitlist`,
 * `sendDomainLiveEmail`, `processWaitlistNotifyJobs`). Recipients are
 * anonymous public-site `WaitlistSignup` rows — no User account, so this
 * cannot go through the notification outbox; it is direct mail.
 */
import type { DomainId, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { config } from "../../config.js";
import { sendMail } from "../../lib/mailer.js";
import { renderEmail } from "../../lib/email-template.js";
import { enqueueJob } from "../jobs.js";

/** Bounded per-run batch so one domain's waitlist cannot hold a worker slot
 * open indefinitely. A launch waitlist is realistically tens-to-low-thousands
 * of rows, so this drains in a handful of runs even at worst case. */
const NOTIFY_BATCH_SIZE = 200;

/**
 * Display names for the launch email subject/body. Deliberately a local map
 * rather than an import from routes/v1/meta.ts, whose `DOMAIN_COPY` is not
 * exported — and a worker reaching into a route module for copy is the wrong
 * dependency direction anyway. Falls back to the raw domain id, which is
 * honest (never a fabricated pretty name).
 */
const DOMAIN_DISPLAY: Record<string, string> = {
  coding: "Coding",
  legal: "Legal",
  healthcare: "Healthcare",
  finance: "Finance",
  science: "Science",
};

function domainDisplayName(domain: string): string {
  return DOMAIN_DISPLAY[domain] ?? domain;
}

/**
 * Called at the exact moment a domain's status could change: right before
 * persisting a create/update that sets a dataset type `active`.
 * `domainHadNoActiveTypesBefore` MUST be computed by the caller inside the
 * same transaction (a COUNT of other active types in this domain, evaluated
 * before the write) — this function only decides whether to enqueue, it never
 * re-derives the fact, so it cannot race the write it is reacting to.
 *
 * The idempotency key is the domain ALONE: even when a second type in the same
 * domain activates next month, the upsert makes every call after the first a
 * no-op. The launch email goes out once per domain, not once per activation.
 */
export async function enqueueDomainLiveNotificationIfNewlyLive(
  domain: DomainId,
  domainHadNoActiveTypesBefore: boolean,
  tx?: Prisma.TransactionClient
): Promise<void> {
  if (!domainHadNoActiveTypesBefore) return;
  await enqueueJob("waitlist.notify_domain_live", { domain }, {
    idempotencyKey: `waitlist-notify:${domain}`,
    maxAttempts: 5,
    tx,
  });
}

/**
 * Sweep producer.
 *
 * v1's only producer was the admin dataset-type route (the transactional
 * "this domain just went live" hook above), which is not part of this change.
 * This reads the same fact from the other side — a domain that HAS an active
 * dataset type and still has unnotified signups — so the promise is kept even
 * if no route ever calls the hook.
 *
 * Safe to run every tick: the queue key is the domain alone (so at most one
 * job per domain ever exists), and `notifiedAt` makes each recipient
 * single-send regardless of how many times the job runs.
 */
export async function enqueueDueDomainLiveNotifications(): Promise<{ enqueued: number }> {
  const liveDomains = await prisma.datasetType.findMany({
    where: { status: "active" },
    select: { domain: true },
    distinct: ["domain"],
  });
  let enqueued = 0;
  for (const { domain } of liveDomains) {
    const owed = await prisma.waitlistSignup.count({ where: { domain, notifiedAt: null } });
    if (owed === 0) continue;
    await enqueueJob("waitlist.notify_domain_live", { domain }, {
      idempotencyKey: `waitlist-notify:${domain}`,
      maxAttempts: 5,
    });
    enqueued += 1;
  }
  return { enqueued };
}

async function sendDomainLiveEmail(to: string, domain: string): Promise<void> {
  const name = domainDisplayName(domain);
  // `/domains/:id` lives on the LANDING app, not the member dashboard — this
  // used `appUrl` and 404'd for every waitlist recipient (fixed 2026-09-02).
  const link = `${config.landingUrl.replace(/\/+$/, "")}/domains/${domain}`;
  const { html, text } = renderEmail({
    heading: `${name} is live on DataBounty`,
    paragraphs: [
      `${name} just opened for datasets and validator work — you're getting this because you joined the waitlist.`,
      "Head over to see the active dataset types and claim early validator credentialing.",
    ],
    button: { label: `view ${name.toLowerCase()} datasets`, href: link },
    footnote: "You're receiving this because you joined the DataBounty expert waitlist for this domain.",
  });
  await sendMail({ to, subject: `${name} is now live on DataBounty`, html, text });
}

/**
 * `waitlist.notify_domain_live` handler.
 *
 * Per-row idempotent: `notifiedAt` is set immediately after each successful
 * send, so a mid-batch crash or a retried job never double-emails anyone — the
 * next run picks up wherever `notifiedAt IS NULL` still holds.
 *
 * A single recipient's mail failure never aborts the batch (one bad address
 * must not block everyone else). THROWS when anything is still owed, so the
 * queue's own backoff retries: acking while people are still un-emailed would
 * record the promise as kept when it was not.
 */
export async function runWaitlistNotifyJob(domain: string): Promise<{ sent: number; remaining: number }> {
  const pending = await prisma.waitlistSignup.findMany({
    where: { domain: domain as DomainId, notifiedAt: null },
    select: { id: true, email: true },
    take: NOTIFY_BATCH_SIZE,
    orderBy: { createdAt: "asc" },
  });

  let sent = 0;
  let anyFailed = false;
  for (const row of pending) {
    try {
      await sendDomainLiveEmail(row.email, domain);
      await prisma.waitlistSignup.update({ where: { id: row.id }, data: { notifiedAt: new Date() } });
      sent += 1;
    } catch (error) {
      // Transient (SMTP hiccup, bad address, provider timeout): skip this
      // recipient this pass. `notifiedAt` stays null so they are retried on the
      // job's next attempt rather than silently dropped.
      anyFailed = true;
      console.error(`[waitlist-notify] failed to email ${row.email} for domain ${domain}`, error);
    }
  }

  const remaining = await prisma.waitlistSignup.count({
    where: { domain: domain as DomainId, notifiedAt: null },
  });
  if (remaining > 0 || anyFailed) {
    throw new Error(`waitlist drain incomplete for ${domain}: ${remaining} remaining, anyFailed=${anyFailed}`);
  }
  return { sent, remaining };
}
