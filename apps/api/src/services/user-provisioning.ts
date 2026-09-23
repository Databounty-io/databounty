// SPDX-License-Identifier: Apache-2.0

import type { Prisma } from "@prisma/client";
import { ensurePersonalWorkspace } from "../lib/workspace.js";
import { prisma } from "../lib/prisma.js";
import { enqueueJob, workspaceKeyForUser } from "./jobs.js";
import { ensureDefaultWatchPref, seedEmailNotificationChannel } from "./notifications.js";

/**
 * One-time setup for a new account — personal workspace, email notification
 * channel, default watch preferences — and the idempotent repair of the same
 * for an account that somehow lacks them.
 *
 * WHY THIS EXISTS. These three side effects used to be three loose `void`
 * calls copy-pasted into the two signup routes in `routes/v1/auth.ts`. The
 * third user-creation path — `POST /auth/accept-invite`, which is how a real
 * admin account comes into being — had none of them. The consequence was
 * invisible rather than noisy: `createDeliveryIntents`
 * (services/notifications.ts) selects the user's notification channels and
 * returns 0 when there are none, silently, so an account with no channel row
 * simply never receives mail and nothing anywhere records that it didn't.
 * Measured on production 2026-09-22: 60 of 167 users had no email channel,
 * and 373 of 1,596 daily digests were therefore never delivered to anyone.
 * Admins were in that set, so `admin.*` alerts were landing in an inbox
 * nobody was emailed about.
 *
 * A list of calls that a new route must remember to copy is the bug. One
 * enqueue that every path makes is the fix.
 *
 * ASYNCHRONOUS AND DECOUPLED, BY WAY OF THE JOB QUEUE. Neither of the two
 * obvious shapes is right. The original `void` calls were detached but
 * unowned: a transient failure or the process exiting between the response
 * and the write lost the work permanently, with at most a log line. Awaiting
 * them instead binds account creation to three writes that have nothing to do
 * with returning a session, and puts a database hiccup on the signup path.
 *
 * So the routes do neither — they enqueue `user.provision` and return. For a
 * new account the enqueue happens INSIDE the same transaction as the `User`
 * row, which is what makes it atomic: a rolled-back signup leaves no job, and
 * a committed one can never lose its provisioning. The work then runs on the
 * worker with the queue's own lease and bounded-retry budget.
 *
 * The queue's idempotency key is derived from the payload, so every enqueue
 * for one user collapses onto a single row — and `dbJobQueue.enqueue` re-arms
 * an idle row rather than creating a second one, which is exactly what the
 * repair path needs: a heal requested months later re-runs the same job
 * instead of being deduplicated away as "already done".
 */

/**
 * Called from every path that creates a `User`. Pass the caller's `tx` so the
 * job and the account commit or roll back together.
 */
export async function enqueueUserProvisioning(
  userId: string,
  opts: { tx?: Prisma.TransactionClient } = {},
): Promise<void> {
  await enqueueJob("user.provision", { userId }, { workspaceId: workspaceKeyForUser(userId), tx: opts.tx });
}

/**
 * The idempotent repair v1 ran on every sign-in, invite acceptance and email
 * verification (`routes/v1/auth.ts` 329, 479, 802) and this port had dropped.
 *
 * Deliberately does the cheap existence check inline and enqueues nothing in
 * the common case. Sitting on the login path, it must not add a queue write to
 * every sign-in that is already fine — steady state is one indexed count and
 * no job at all.
 *
 * Never throws. This is a repair on an authentication path; it must not be the
 * reason someone cannot log in.
 */
export async function healUserProvisioning(userId: string): Promise<void> {
  try {
    const missing = await prisma.notificationChannel.count({ where: { userId, channel: "email" } });
    if (missing === 0) await enqueueUserProvisioning(userId);
  } catch (err) {
    console.error(`[provisioning] heal check failed for user ${userId}:`, err);
  }
}

/**
 * The `user.provision` handler. Re-reads the user rather than trusting a
 * snapshot taken at enqueue time, so it acts on current state — which matters
 * for the repair path, where the account may have verified its email between
 * the enqueue and the run.
 */
export async function runUserProvisionJob(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerifiedAt: true, displayName: true },
  });
  // Deleted between enqueue and run. Nothing to do, and not an error — the
  // job must complete rather than retry to death against a missing row.
  if (!user) return;

  // Per step, not one try/catch around all three: a failure in the first must
  // not skip the other two. Each is idempotent, so the queue's retry re-runs
  // the whole handler safely, and a step that already succeeded is a no-op.
  await settle("personal workspace", user.id, () => ensurePersonalWorkspace(user.id, user.displayName ?? ""));
  await settle("email channel", user.id, () => seedEmailNotificationChannel(user));
  await settle("watch preferences", user.id, () => ensureDefaultWatchPref(user.id));
}

async function settle(step: string, userId: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`[provisioning] ${step} failed for user ${userId}:`, err);
  }
}
