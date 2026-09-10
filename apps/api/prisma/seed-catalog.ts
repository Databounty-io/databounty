// SPDX-License-Identifier: Apache-2.0

/**
 * Idempotently load the 50-type "registry" coding-domain dataset catalog.
 *
 * Source: prisma/dataset-catalog/<id>.json — a verbatim copy of V1's
 * `registry/harnesses/<id>/schema.json` files (V1 is the source of truth for
 * this catalog; the 50 JSON files here are checked in so this repo doesn't
 * depend on a V1 checkout existing on disk at seed time).
 *
 * CORRECTED 2026-09-09: this header used to say Community has no per-type
 * `harness.js` runner and that only metadata needed porting. That stopped
 * being true when V1's registry corpus was vendored to `apps/api/registry/`
 * and wired through `registry-loader.ts` — those per-category harnesses now
 * run here, and are tried BEFORE the generic role-based fallback. The generic
 * path still answers for any contract the registry has no folder for.
 *
 * Pricing (complexityScore/verificationUnits) comes from
 * lib/karma-category-scores.ts, ported verbatim from V1 for the same 50
 * ids. A type absent from that table is deliberately left unpriced (null),
 * matching the schema's fail-closed-at-mint invariant — this seed never
 * invents a score.
 *
 * Idempotent: re-running upserts the same 50 rows without creating
 * duplicates or clobbering admin-edited complexityScore/verificationUnits
 * (seeded on CREATE only, matching V1's seed-catalog.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient, Prisma } from "@prisma/client";
import { createPrismaClient } from "../src/lib/prisma.js";
import { categoryPricingSeed } from "../src/lib/karma-category-scores.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = join(__dirname, "dataset-catalog");

interface RegistrySchema {
  datasetType: string;
  name: string;
  domain: string;
  category: string;
  trustTier: string;
  version: number;
  status: string;
  description: string;
  difficultyLevels: string[];
  pipeline: string[];
  executionEnv?: string;
  dedupeFields: string[];
  auditOptions: number[];
  fields: unknown;
}

function loadCatalog(): RegistrySchema[] {
  return readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(CATALOG_DIR, f), "utf8")) as RegistrySchema);
}

function toCreateInput(schema: RegistrySchema): Prisma.DatasetTypeCreateInput {
  const pricing = categoryPricingSeed(schema.datasetType);
  return {
    id: schema.datasetType,
    version: schema.version,
    domain: schema.domain as Prisma.DatasetTypeCreateInput["domain"],
    name: schema.name,
    description: schema.description,
    status: schema.status as Prisma.DatasetTypeCreateInput["status"],
    origin: "platform",
    category: schema.category as Prisma.DatasetTypeCreateInput["category"],
    trustTier: schema.trustTier as Prisma.DatasetTypeCreateInput["trustTier"],
    fields: schema.fields as Prisma.InputJsonValue,
    verification: {
      pipeline: schema.pipeline,
      ...(schema.executionEnv ? { executionEnv: schema.executionEnv } : {}),
      // The verifier a FORK inherits verbatim. A fork mints its own id, so
      // `buildCategoryHarness`'s direct id lookup cannot find the source's
      // harness — `inheritedRegistryHarnessName` reads THIS key instead, then
      // still gates on field compatibility with the source schema. Without it
      // every fork of a registry-backed type resolves nothing and is recorded
      // as `no_executable_harness`, which is exactly what dev was doing.
      //
      // Self-cancelling for the platform type itself: that resolver returns
      // null when `harness === datasetType.id`, so the direct id match keeps
      // handling non-forks and this key changes nothing for them.
      //
      // DEVIATES FROM V1, deliberately, and needs a decision row to ratify:
      // V1 writes the registry `contract` name here. That resolves through
      // loadCategories' contract alias, which is only built for a contract
      // owned by exactly ONE category — and 5 contracts span 15 categories
      // (fail-then-pass, exact-output-match, exit-code-verify,
      // state-sequence-match, both-pass-identically), so a fork of any of
      // those 15 inherits an ambiguous name and still resolves nothing. V1
      // treats that as correct ("needs an explicit admin binding"), but this
      // rebuild has not ported the bound-harness path, so for us it is simply
      // a dead end. The id is unambiguous for all 50, so forks of every
      // registry-backed type keep their verifier.
      harness: schema.datasetType,
      dedupeFields: schema.dedupeFields,
      auditOptions: schema.auditOptions,
    } as Prisma.InputJsonValue,
    difficultyLevels: schema.difficultyLevels,
    usageCount: 0,
    ...(pricing ? { complexityScore: pricing.complexityScore, verificationUnits: pricing.verificationUnits } : {}),
  };
}

export async function seedCatalog(prisma: PrismaClient): Promise<{ created: number; updated: number }> {
  const catalog = loadCatalog();
  let created = 0;
  let updated = 0;
  for (const schema of catalog) {
    const input = toCreateInput(schema);
    const { id, ...data } = input;
    const existing = await prisma.datasetType.findUnique({ where: { id: id as string } });
    // Registry metadata (fields/verification/etc.) always wins on re-seed —
    // it's the authoritative contract. complexityScore/verificationUnits are
    // excluded from the update branch UNLESS the existing row is still
    // unpriced (null) — an admin's real pricing decision is never reverted,
    // but a row that predates pricing (e.g. an ad hoc pre-seed fixture) gets
    // backfilled, matching V1's own "existing unscored rows are backfilled"
    // migration precedent rather than leaving it permanently unpriced.
    const { complexityScore: _complexityScore, verificationUnits: _verificationUnits, ...updateData } = data;
    const needsPricingBackfill = existing && existing.complexityScore === null && existing.verificationUnits === null;
    if (existing) {
      await prisma.datasetType.update({
        where: { id: id as string },
        data: needsPricingBackfill ? data : updateData,
      });
      updated++;
    } else {
      await prisma.datasetType.create({ data: input });
      created++;
    }
  }
  return { created, updated };
}

async function main() {
  // Catalog seeding is long-lived administrative work, not request traffic, so
  // it runs on the SESSION/direct connection when one is configured — the same
  // reasoning (and the same connection) as migrations. v1 does this explicitly
  // (`prisma/seed-catalog.ts`: `createPrismaClient(process.env.DIRECT_URL)`);
  // this rebuild had dropped it and was seeding over the runtime pooler.
  //
  // `?? undefined` rather than v1's bare `process.env.DIRECT_URL`: DIRECT_URL is
  // OPTIONAL here (see prisma.config.ts) because local Postgres and the bundled
  // compose database are unpooled and need only DATABASE_URL. Passing undefined
  // makes `createPrismaClient` fall back to its own DATABASE_URL default, so an
  // unset DIRECT_URL keeps working instead of connecting to "undefined".
  const prisma = createPrismaClient(process.env.DIRECT_URL ?? undefined);
  try {
    const result = await seedCatalog(prisma);
    console.log(`[seed-catalog] ${result.created} created, ${result.updated} updated`);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
