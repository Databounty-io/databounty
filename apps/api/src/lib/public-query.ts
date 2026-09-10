// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { BountyStatus } from "@prisma/client";

/**
 * The single lifecycle-phase vocabulary for every public listing.
 *
 * It lives here because two endpoints previously defined their own: the pool
 * catalog called the in-flight phase `open` while /v1/bounties called it
 * `production`, so a client that learned one name from one endpoint got a
 * permanently empty grid from the other. `open` and `production` are kept as
 * synonyms so neither existing caller breaks.
 */
export const PHASE_STATUSES: Record<string, BountyStatus[]> = {
  open: [BountyStatus.active, BountyStatus.paused, BountyStatus.closing],
  production: [BountyStatus.active, BountyStatus.paused, BountyStatus.closing],
  delivered: [BountyStatus.export_ready, BountyStatus.completed, BountyStatus.partially_completed],
};

const PHASE_NAMES = Object.keys(PHASE_STATUSES) as [string, ...string[]];

/** An unknown phase must be a 400, never an empty 200 — silently answering
 * `status IN ()` turns a client-side typo into "there is nothing here". */
export const phaseSchema = z.enum(PHASE_NAMES);

/**
 * A query-string boolean. `z.coerce.boolean()` is wrong for query params: it
 * is JS truthiness, so `?flag=false`, `?flag=0` and `?flag=no` all mean TRUE.
 * Only the spellings listed here count as true.
 */
export const queryBoolean = z
  .string()
  .trim()
  .transform((v) => ["1", "true", "yes", "on"].includes(v.toLowerCase()))
  .optional();

/**
 * A user-supplied free-text query param. Rejects NUL, which Postgres cannot
 * accept in a text comparison and which surfaced as an unauthenticated 500
 * (SQLSTATE 22021) that also echoed an absolute source path to the caller.
 */
export function publicText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !v.includes("\u0000"), { message: "Value must not contain a null byte." });
}

/**
 * The dataset-type fields an UNAUTHENTICATED caller may see.
 *
 * This is an allowlist, not a denylist, and that is the point: these routes
 * used to hand Prisma no `select` at all, so every column of the row went out
 * on a public endpoint — including `authorUserId` (who wrote the type),
 * `reviewNote` (the internal reviewer's decision note) and
 * `sponsorHarnessNote` (a sponsor's private harness instructions). They were
 * all NULL in the databases checked, so nothing had leaked yet, but the shape
 * meant the next column anyone adds to the model would be published by
 * default. With an allowlist a new column is private until someone chooses
 * otherwise.
 *
 * Everything here is already public elsewhere on the site: the type's
 * identity, its contract (`fields`/`verification`), its trust tier, its
 * difficulty levels and how many pools use it. `/v1/meta/public-catalog`
 * already applied the same discipline; these routes did not.
 */
export const PUBLIC_DATASET_TYPE_SELECT = {
  id: true,
  familyId: true,
  supersedesId: true,
  forkedFromId: true,
  version: true,
  domain: true,
  name: true,
  description: true,
  status: true,
  origin: true,
  category: true,
  trustTier: true,
  fields: true,
  verification: true,
  sampleAssets: true,
  complexityScore: true,
  verificationUnits: true,
  difficultyLevels: true,
  usageCount: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The harness fields a public caller may see. Same reasoning: the public
 * dataset-type detail route pulled the whole harness row, which carries
 * `authorUserId`, `reviewNote` and `proofJobId` (an internal job handle).
 * The verifiable facts — what the harness runs and the hash of its source —
 * stay public.
 */
export const PUBLIC_HARNESS_SELECT = {
  id: true,
  version: true,
  status: true,
  source: true,
  sourceSha: true,
  declaredRuntimes: true,
  proofEvidence: true,
  proofSamples: true,
  createdAt: true,
  updatedAt: true,
} as const;
