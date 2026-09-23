// SPDX-License-Identifier: Apache-2.0
//
// One-off backfill: give an email notification channel to accounts that never
// got one, so they stop silently receiving nothing.
//
// WHY THIS IS NEEDED. `createDeliveryIntents` (services/notifications.ts)
// selects the user's notification channels and returns 0 when there are none —
// silently, with no delivery row and no error. An account with no channel is
// therefore unreachable by email forever, and nothing anywhere records that a
// notification went undelivered. Measured on production 2026-09-22: 60 of 167
// users had no email channel, and 373 of 1,596 daily digests were never
// delivered to anyone. The cause was that the channel was seeded from only two
// of the routes that can create a user. That hole is now closed in the
// application (services/user-provisioning.ts), and every sign-in, invite
// acceptance and email verification now repairs the channel the way v1 did —
// but an account whose owner never signs in again is not reached by that, and
// this script is for them.
//
// WHY IT IS NOT AN AUTOMATIC SWEEP. A user may DELETE their email channel
// (`disconnectChannel`, services/notification-channels.ts does a bare
// `deleteMany`), and no tombstone distinguishes "never had one" from
// "deliberately removed". Blindly recreating every missing channel would mail
// people who switched it off on purpose. So this runs deliberately, prints
// what it would do first, and applies the discriminator below.
//
// THE DISCRIMINATOR. A user who once had an email channel will have
// `notification_deliveries` rows on the email channel from that period. Past
// email deliveries + no channel now == the channel was removed, so that
// account is SKIPPED and reported separately. Zero email deliveries ever ==
// the channel never existed, which is the accident this repairs. Accounts
// without a verified email are skipped too, matching the guard in
// `seedEmailNotificationChannel`.
//
// Read-only (DRY_RUN=1, default) unless DRY_RUN=0 is set.
import { ChannelKind } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { seedEmailNotificationChannel } from "../src/services/notifications.js";

const DRY_RUN = process.env.DRY_RUN !== "0";

async function main() {
  console.log(`=== backfill email notification channels — DRY_RUN=${DRY_RUN} ===`);

  const candidates = await prisma.user.findMany({
    where: {
      email: { not: null },
      emailVerifiedAt: { not: null },
      channels: { none: { channel: ChannelKind.email } },
    },
    select: { id: true, email: true, emailVerifiedAt: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`users with a verified email and NO email channel: ${candidates.length}`);
  if (candidates.length === 0) return;

  const seeded: string[] = [];
  const skippedRemoved: string[] = [];
  const failed: string[] = [];

  for (const user of candidates) {
    // Did this account ever actually receive email? If so it once held a
    // channel, and the absence of one now is a deletion to respect, not an
    // accident to repair.
    const priorEmailDeliveries = await prisma.notificationDelivery.count({
      where: { channel: ChannelKind.email, notification: { userId: user.id } },
    });

    if (priorEmailDeliveries > 0) {
      skippedRemoved.push(`${user.email} (${priorEmailDeliveries} past email deliveries)`);
      continue;
    }

    if (DRY_RUN) {
      seeded.push(`${user.email} (created ${user.createdAt.toISOString().slice(0, 10)})`);
      continue;
    }

    // Reuse the application's own seeding function rather than reimplementing
    // the row shape — it carries the `emailVerifiedAt` guard and the
    // deliberate choice not to overwrite `deliver`/`deliverDigest`.
    const result = await seedEmailNotificationChannel(user);
    if (result) seeded.push(`${user.email}`);
    else failed.push(`${user.email}`);
  }

  console.log(`\n--- ${DRY_RUN ? "WOULD SEED" : "SEEDED"} (${seeded.length}) ---`);
  for (const line of seeded) console.log(`  ${line}`);

  console.log(`\n--- SKIPPED, channel looks deliberately removed (${skippedRemoved.length}) ---`);
  for (const line of skippedRemoved) console.log(`  ${line}`);

  if (failed.length > 0) {
    console.log(`\n--- FAILED (${failed.length}) ---`);
    for (const line of failed) console.log(`  ${line}`);
  }

  if (DRY_RUN) {
    console.log("\nNothing was written. Re-run with DRY_RUN=0 to apply.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
