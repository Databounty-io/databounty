// SPDX-License-Identifier: Apache-2.0

import { createPrismaClient } from "../src/lib/prisma.js";
import { BountyKind, BountyStatus, DatasetTypeStatus, DatasetTypeOrigin } from "@prisma/client";

const prisma = createPrismaClient();

// Real "Debugging / Bug Fix" DatasetType — the platform's flagship
// execution-verified type. Field shape (TypeField[]) and verification shape
// mirror the live catalog entry in community/apps/web/lib/dataset-types.ts
// (id: "debugging") exactly, so anything parsing DatasetType.fields/
// verification elsewhere in the app reads real, expected data — not a guess.
const DATASET_TYPE_ID = "debugging";

async function ensureDatasetType() {
  const existing = await prisma.datasetType.findUnique({ where: { id: DATASET_TYPE_ID } });
  if (existing) return { id: existing.id, created: false };

  const dt = await prisma.datasetType.create({
    data: {
      id: DATASET_TYPE_ID,
      version: 1,
      domain: "coding",
      name: "Debugging / Bug Fix",
      description:
        "Broken code paired with its corrected version, driven by failing tests. The flagship execution-verified type.",
      status: DatasetTypeStatus.active,
      origin: DatasetTypeOrigin.platform,
      category: "debugging",
      trustTier: "execution_verified",
      fields: [
        { key: "prompt", label: "Bug description", role: "instruction", required: true },
        { key: "broken_code", label: "Broken code", role: "input_code", lang: "ts", required: true },
        { key: "fixed_code", label: "Fixed code", role: "solution_code", lang: "ts", required: true },
        {
          key: "tests",
          label: "Tests",
          role: "tests",
          lang: "ts",
          required: true,
          help: "Broken code must FAIL these; fixed code must PASS.",
        },
        { key: "explanation", label: "Explanation", role: "rationale", required: true },
        {
          key: "bug_type",
          label: "Bug type",
          role: "enum",
          options: ["logic", "state", "async", "types", "perf", "memory"],
        },
      ],
      verification: {
        pipeline: ["schema", "dedupe", "contamination", "execution", "llm", "human_audit"],
        executionEnv: "node:20 / python:3.11",
        dedupeFields: ["prompt", "broken_code"],
        auditOptions: [0, 25, 100],
      },
      // Unpriced on purpose (schema.prisma comment on DatasetType.complexityScore/
      // verificationUnits): no lib/karma-category-scores.ts registry exists yet in
      // this rebuild to source real values from, and the schema explicitly says
      // null must mean "unpriced" rather than a fabricated mid-band guess.
      complexityScore: null,
      verificationUnits: null,
      difficultyLevels: ["beginner", "intermediate", "expert"],
    },
  });
  return { id: dt.id, created: true };
}

// Real open community pool Bounty — same field set and values a real
// admin-approved mint produces (POST /community/requests/:id/implement in
// src/routes/v1/admin-community.ts), so the contributor UI's pool contract
// (services/bounties.ts getPoolContractForBounty) renders and validates it
// exactly like a genuinely-minted pool. karmaPerAcceptedItem 25 = KARMA_RULES
// .acceptedItem.intermediate (services/karma.ts); auditCoveragePct 10 is the
// admin-community.ts mint-route default; holdDays 0 + disputeWindowHours 48
// are the exact values that route hardcodes for every community mint.
const BOUNTY_TITLE = "E2E Pipeline: Debugging / Bug Fix Open Pool";

async function ensureBounty(datasetTypeId: string, requesterUserId: string) {
  const existing = await prisma.bounty.findFirst({
    where: { kind: BountyKind.community, datasetTypeId, title: BOUNTY_TITLE },
  });
  if (existing) return { id: existing.id, created: false };

  const b = await prisma.bounty.create({
    data: {
      requesterUserId,
      kind: BountyKind.community,
      title: BOUNTY_TITLE,
      description:
        "Seeded open pool for exercising the real contributor -> validator -> karma pipeline end to end in a browser. Submit debugging items directly (no claiming) via /v1/bounties/:id/items.",
      datasetCategory: "debugging",
      language: "TypeScript",
      framework: "Node.js",
      targetItems: 20n,
      karmaPerAcceptedItem: 25,
      auditCoveragePct: 10,
      auditMode: "partial",
      holdDays: 0,
      disputeWindowHours: 48,
      poolDifficulty: "intermediate",
      status: BountyStatus.active,
      datasetTypeId,
      datasetTypeVersion: 1,
    },
  });
  return { id: b.id, created: true };
}

async function main() {
  console.log("=== Seeding E2E Pipeline Data (community_test only) ===");

  const owner = await prisma.user.findUnique({ where: { email: "test@gmail.com" } });
  if (!owner) {
    throw new Error(
      'test@gmail.com not found — run scripts/seed-e2e-accounts.ts first (DATABASE_URL must point at community_test).',
    );
  }

  const datasetType = await ensureDatasetType();
  console.log(`DatasetType "${datasetType.id}": ${datasetType.created ? "CREATED" : "PRESENT"}`);

  const bounty = await ensureBounty(datasetType.id, owner.id);
  console.log(`Bounty "${bounty.id}": ${bounty.created ? "CREATED" : "PRESENT"}`);

  // Read back for confirmation.
  const confirmDt = await prisma.datasetType.findUniqueOrThrow({ where: { id: datasetType.id } });
  const confirmBounty = await prisma.bounty.findUniqueOrThrow({ where: { id: bounty.id } });

  console.log("\n--- Confirmed rows ---");
  console.log(
    JSON.stringify(
      {
        datasetType: { id: confirmDt.id, status: confirmDt.status, category: confirmDt.category },
        bounty: {
          id: confirmBounty.id,
          title: confirmBounty.title,
          status: confirmBounty.status,
          targetItems: confirmBounty.targetItems.toString(),
          karmaPerAcceptedItem: confirmBounty.karmaPerAcceptedItem,
          auditCoveragePct: confirmBounty.auditCoveragePct,
        },
      },
      null,
      2,
    ),
  );
  console.log("\n>>> E2E pipeline seed ready <<<");
}

main()
  .catch((err) => {
    console.error("Pipeline seeding failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
