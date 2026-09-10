// SPDX-License-Identifier: Apache-2.0

import { createPrismaClient } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";

const prisma = createPrismaClient();

type AdminRoleName = "admin" | "member" | "support";

async function ensureAccount(email: string, password: string, handle: string, roles: AdminRoleName[] = []) {
  const existing = await prisma.user.findUnique({ where: { email } });
  const user =
    existing ??
    (await prisma.user.create({
      data: {
        email,
        handle,
        displayName: handle,
        authMethod: "email",
        onboarded: true,
        passwordHash: await hashPassword(password),
        emailVerifiedAt: new Date(),
      },
    }));

  for (const role of roles) {
    await prisma.userRole.upsert({
      where: { userId_role: { userId: user.id, role } },
      update: {},
      create: { userId: user.id, role },
    });
  }

  return { email, id: user.id, roles, created: !existing };
}

async function main() {
  console.log("=== Seeding E2E Accounts for Real-Time Testing ===");
  const results = [];
  results.push(await ensureAccount("test@gmail.com", "Test@123", "test", ["admin", "member"]));
  results.push(await ensureAccount("test2@gmail.com", "Test@123", "test2"));
  results.push(await ensureAccount("test3@gmail.com", "Test@123", "test3"));

  for (const r of results) {
    console.log(`✓ ${r.email} (${r.roles.length ? r.roles.join(", ") : "user"}): ${r.created ? "CREATED" : "PRESENT"}`);
  }
  console.log("\n>>> Test accounts ready: test@gmail.com, test2@gmail.com, test3@gmail.com (Password: Test@123) <<<");
}

main().catch(err => {
  console.error("Account seeding failed:", err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
