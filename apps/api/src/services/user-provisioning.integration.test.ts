// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for account provisioning — the personal workspace, the email
 * notification channel and the default watch preferences a new account needs.
 *
 * WHAT REGRESSED BEFORE THIS EXISTED (production, 2026-09-22): these were
 * three loose `void` calls copy-pasted into the two signup routes, and absent
 * entirely from `POST /auth/accept-invite`, which is how a real admin account
 * is created. `createDeliveryIntents` (services/notifications.ts) selects a
 * user's channels and returns 0 when there are none — silently, no delivery
 * row, no error — so an account with no channel was unreachable by email
 * forever and nothing recorded that anything went undelivered. 60 of 167
 * production users were in that state and 373 of 1,596 daily digests were
 * never delivered to anyone.
 *
 * Three properties are asserted here because each one is a distinct way the
 * original broke:
 *
 *  1. The work is ENQUEUED, not done inline and not fired-and-forgotten. The
 *     `void` calls were lost on any transient failure; awaiting them instead
 *     would bind account creation to writes unrelated to returning a session.
 *     The job row committing with the account is what makes it neither.
 *  2. The email channel waits for a VERIFIED address. The pre-fix code wrote
 *     `verified: true` straight from `/signup`, so a mistyped address received
 *     real platform mail. v1 guards on `emailVerifiedAt`; this port had not.
 *  3. The repair is free in the common case. It sits on the login path, so a
 *     sign-in by an account that is already fine must not cost a queue write.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import { requireDisposableDatabase } from "../test-support/require-disposable-database.js";
import { healUserProvisioning, runUserProvisionJob } from "./user-provisioning.js";

requireDisposableDatabase();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function signup(prefix: string) {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const email = `${prefix}-${stamp}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: {
      email,
      password: "Test@12345",
      handle: `${prefix}${stamp}`.toLowerCase().slice(0, 20),
      displayName: prefix,
    },
  });
  expect(res.statusCode).toBe(201);
  return { userId: res.json().user.id as string, email };
}

function provisionJobFor(userId: string) {
  return prisma.jobQueue.findFirst({
    where: { type: "user.provision", payload: { path: ["userId"], equals: userId } },
  });
}

function emailChannelFor(userId: string) {
  return prisma.notificationChannel.findUnique({
    where: { userId_channel: { userId, channel: "email" } },
  });
}

describe("account provisioning", () => {
  it("enqueues a provisioning job when an account is created", async () => {
    // Committed with the User row, inside the same transaction: a rolled-back
    // signup leaves no job, and a committed one can never lose its
    // provisioning the way a detached `void` call could.
    const { userId } = await signup("prov");
    const job = await provisionJobFor(userId);
    expect(job).not.toBeNull();
  });

  it("does not create an email channel while the address is unverified", async () => {
    // The pre-fix code wrote `verified: true` directly from /signup. A typo'd
    // or someone-else's address would then receive real mail.
    const { userId } = await signup("unverified");
    await runUserProvisionJob(userId);

    expect(await emailChannelFor(userId)).toBeNull();
    // The rest of provisioning still happened — the guard is on the channel
    // only, and must not skip the other two steps.
    expect(await prisma.watchPref.findUnique({ where: { userId } })).not.toBeNull();
    expect(
      await prisma.workspaceMember.findFirst({ where: { userId, workspace: { kind: "personal" } } }),
    ).not.toBeNull();
  });

  it("creates the email channel once the address is verified", async () => {
    const { userId, email } = await signup("verified");
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });

    await runUserProvisionJob(userId);

    const channel = await emailChannelFor(userId);
    expect(channel?.address).toBe(email.toLowerCase());
    expect(channel?.verified).toBe(true);
    expect(channel?.deliver).toBe(true);
  });

  it("re-running the job changes nothing and never throws", async () => {
    // The queue retries on failure, so the handler has to be safe to re-run.
    const { userId } = await signup("idem");
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });

    await runUserProvisionJob(userId);
    const first = await emailChannelFor(userId);
    await runUserProvisionJob(userId);
    const second = await emailChannelFor(userId);

    expect(second?.id).toBe(first?.id);
    expect(await prisma.notificationChannel.count({ where: { userId } })).toBe(1);
  });

  it("does not resurrect a delivery preference the user turned off", async () => {
    // A user may switch email delivery off. Re-running the repair must fix the
    // channel's existence and never the user's choice about it — v1's blanket
    // `deliver: true` re-assert on every sign-in is the bug not being ported.
    const { userId } = await signup("optout");
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    await runUserProvisionJob(userId);

    await prisma.notificationChannel.update({
      where: { userId_channel: { userId, channel: "email" } },
      data: { deliver: false, deliverDigest: false },
    });

    await runUserProvisionJob(userId);

    const channel = await emailChannelFor(userId);
    expect(channel?.deliver).toBe(false);
    expect(channel?.deliverDigest).toBe(false);
  });

  it("completes rather than retrying forever when the user is gone", async () => {
    const { userId } = await signup("deleted");
    await prisma.user.delete({ where: { id: userId } });
    await expect(runUserProvisionJob(userId)).resolves.toBeUndefined();
  });

  describe("the repair path", () => {
    it("enqueues nothing when the channel already exists", async () => {
      // This runs on every sign-in. Steady state must cost one indexed count
      // and no queue write at all.
      const { userId } = await signup("healnoop");
      await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
      await runUserProvisionJob(userId);
      await prisma.jobQueue.deleteMany({ where: { payload: { path: ["userId"], equals: userId } } });

      await healUserProvisioning(userId);

      expect(await provisionJobFor(userId)).toBeNull();
    });

    it("enqueues when the channel is missing", async () => {
      // The 60-user case: an account that exists but was never given a
      // channel, seen again at sign-in, invite acceptance or verification.
      const { userId } = await signup("healfix");
      await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
      await prisma.notificationChannel.deleteMany({ where: { userId } });
      await prisma.jobQueue.deleteMany({ where: { payload: { path: ["userId"], equals: userId } } });

      await healUserProvisioning(userId);

      expect(await provisionJobFor(userId)).not.toBeNull();
    });
  });
});
