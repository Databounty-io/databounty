// SPDX-License-Identifier: Apache-2.0

import { createPrismaClient } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { config } from "../src/config.js";

const prisma = createPrismaClient();

/**
 * Bootstrap the first admin. `admin` is not a self-assignable role (there is
 * no admin signup — apps/admin's sign-in page says so explicitly: "admin
 * accounts are provisioned separately, not created here") and nothing else
 * in this codebase grants it, so without this script a fresh deployment has
 * zero admins and no way to create one.
 *
 * Deliberately DOES NOT bake in a default password the way `SUPER_ADMIN_PASSWORD
 * ?? "some-literal"` would — a literal committed to source is a public admin
 * password in every environment that forgets to override it. In production
 * (`config.isProd`) a missing `SUPER_ADMIN_PASSWORD` is a hard failure, not a
 * silent skip, so ops can't believe an admin exists when none does. Outside
 * production it warns and skips (so `npm run seed` still exits 0 for anyone
 * who hasn't set it up yet), letting `scripts/seed-e2e-accounts.ts` cover
 * local/CI accounts instead.
 *
 * Idempotent: re-running only ensures the role exists on an already-created
 * account. It never rewrites an existing user's password — this is a
 * bootstrap for the FIRST admin, not a password-reset tool.
 */
async function seedSuperAdmin(): Promise<void> {
  const email = (process.env.SUPER_ADMIN_EMAIL ?? "superadmin@databounty.io").toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;

  if (!password) {
    // A redeploy re-runs this one-shot every time. Once any admin exists the
    // bootstrap has nothing left to do, so a missing password is not an error
    // — only a FIRST boot with zero admins may refuse.
    const adminCount = await prisma.userRole.count({ where: { role: "admin" } });
    if (adminCount > 0) {
      console.log(`[seed-admin] ${adminCount} admin account(s) already present — nothing to bootstrap.`);
      return;
    }
    if (config.isProd) {
      throw new Error(
        "SUPER_ADMIN_PASSWORD is required in production to bootstrap the first admin " +
          "account (no admin exists yet). Set it and re-run this seed — refusing to boot " +
          "with no admin and no way to create one.",
      );
    }
    console.warn(
      "[seed-admin] SUPER_ADMIN_PASSWORD is unset — skipping admin bootstrap. " +
        "Set SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD to create one, or use " +
        "scripts/seed-e2e-accounts.ts for local/CI test accounts.",
    );
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  const user =
    existing ??
    (await prisma.user.create({
      data: {
        authMethod: "email",
        email,
        displayName: "Admin",
        passwordHash: await hashPassword(password),
        onboarded: true,
        emailVerifiedAt: new Date(),
      },
    }));

  await prisma.userRole.upsert({
    where: { userId_role: { userId: user.id, role: "admin" } },
    update: {},
    create: { userId: user.id, role: "admin" },
  });

  console.log(
    existing
      ? `[seed-admin] Admin present: ${email} (role ensured; password left unchanged)`
      : `[seed-admin] Admin created: ${email}`,
  );
}

seedSuperAdmin()
  .catch((err) => {
    console.error("[seed-admin] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
