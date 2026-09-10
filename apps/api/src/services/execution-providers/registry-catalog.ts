// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Per-category execution policy and harness metadata, read from `registry/`.
 *
 * Ported from V1 (databounty-api/src/services/execution-providers/
 * registry-catalog.ts). This module intentionally has no runtime-harness
 * imports: the catalog seed reads it from TypeScript source, while harness
 * execution runs from compiled JavaScript.
 *
 * BEFORE THIS PORT this file was a stub whose `categoryAllowsNetworkEgress()`
 * returned `false` unconditionally, because the `registry/` corpus was not part
 * of the rebuild. The corpus is now vendored at `apps/api/registry/`, so the
 * real, per-category declarations are back in force. The security properties
 * that made the stub safe are preserved and are stated on each function below.
 *
 * TWO DEVIATIONS FROM V1, both strictly narrowing or internal:
 *
 *  1. `SAFE_CATEGORY_ID` (below) is a defence-in-depth shape guard applied
 *     before ANY filesystem path is built from a category id. V1 relies solely
 *     on the categories.json allowlist for that, which is sufficient today —
 *     but ids reaching these functions come from `DatasetType.id`, i.e. from
 *     the database, and a sponsor fork mints its own id. A guard that can only
 *     ever REJECT an id (never admit one the allowlist wouldn't) costs nothing
 *     and removes the whole class.
 *  2. Staleness is keyed on the file's real `mtimeMs` rather than V1's
 *     `readFileSync(file).length + (minutes === 0)` heuristic, which misses an
 *     edit that preserves the byte length until the top of the hour. V1's own
 *     `registry-loader` already uses `mtimeMs` for the same purpose; this makes
 *     the two consistent and is the honest implementation of the comment V1
 *     wrote here ("picked up without a restart").
 */

/**
 * `process.cwd()/registry` is where V1 looks, and how the app is normally
 * started (from `apps/api`). The module-relative fallback covers a process
 * launched from a different working directory (a monorepo-root script, a
 * container entrypoint) — resolution only, never a different corpus: both
 * candidates must contain `categories.json` to be accepted.
 */
function resolveRegistryDir(): string {
  const candidates = [
    join(process.cwd(), "registry"),
    // dist/services/execution-providers -> dist -> apps/api
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "registry"),
    // src/services/execution-providers -> src -> apps/api (tsx / ts-node)
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "registry"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "categories.json"))) return dir;
  }
  return candidates[0]!;
}

const REGISTRY_DIR = resolveRegistryDir();
const HARNESS_DIR = join(REGISTRY_DIR, "harnesses");

/**
 * SECURITY-RELEVANT. Every category id that reaches a `join()` in this module
 * is checked against this first. Registry ids are lower-snake-case by
 * construction (see registry/categories.json); anything else — a path
 * separator, `..`, a NUL, an absolute path — is refused before it can name a
 * file. This is a rejection-only gate: it never admits an id that
 * `loadCategories()` would not also have to admit.
 */
const SAFE_CATEGORY_ID = /^[a-z0-9][a-z0-9_]{0,63}$/;

function isSafeCategoryId(id: unknown): id is string {
  return typeof id === "string" && SAFE_CATEGORY_ID.test(id);
}

export interface CategoryEntry {
  id: string;
  datasetType: string;
  name: string;
  contract: string;
  requires: string[];
  referenceDataset?: string;
  verified?: boolean;
  /** SECURITY-RELEVANT: true only for the registry's declared network
   * exceptions (see `categoryAllowsNetworkEgress` below). Read from
   * categories.json verbatim — never inferred, never defaulted to true. */
  networkEgress?: boolean;
}

export interface CategorySchema {
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
  fields: Array<Record<string, unknown>>;
}

interface RegistryFile {
  version: number;
  categories: CategoryEntry[];
}

let cached: { entries: Map<string, CategoryEntry>; mtimeMs: number } | null = null;

/** The routing table, re-read when categories.json changes. */
export function loadCategories(): Map<string, CategoryEntry> {
  const file = join(REGISTRY_DIR, "categories.json");
  if (!existsSync(file)) return new Map();
  const mtimeMs = statSync(file).mtimeMs;
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries;

  let parsed: RegistryFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as RegistryFile;
  } catch {
    // A corrupt routing table must not grant anything. Empty map = every
    // category resolves no registry harness and no category gets egress.
    cached = { entries: new Map(), mtimeMs };
    return cached.entries;
  }

  const entries = new Map<string, CategoryEntry>();
  const list = Array.isArray(parsed.categories) ? parsed.categories : [];
  for (const c of list) {
    // An id that cannot safely name a directory is dropped from the table
    // entirely, so nothing downstream can resolve or path-join it.
    if (!c || !isSafeCategoryId(c.id)) continue;
    entries.set(c.id, { ...c, requires: Array.isArray(c.requires) ? c.requires : [] });
    if (isSafeCategoryId(c.datasetType) && c.datasetType !== c.id) {
      entries.set(c.datasetType, entries.get(c.id)!);
    }
  }
  // A contract name that maps to exactly one category is also usable as an
  // alias, matching V1. Ambiguous contracts are deliberately not aliased.
  const byContract = new Map<string, CategoryEntry[]>();
  for (const c of list) {
    const entry = c && isSafeCategoryId(c.id) ? entries.get(c.id) : undefined;
    if (!c?.contract || !entry) continue;
    const bucket = byContract.get(c.contract) ?? [];
    bucket.push(entry);
    byContract.set(c.contract, bucket);
  }
  for (const [contract, matches] of byContract) {
    const only = matches[0];
    if (matches.length === 1 && only && !entries.has(contract)) entries.set(contract, only);
  }

  cached = { entries, mtimeMs };
  return entries;
}

/**
 * SECURITY-RELEVANT: whether this category's sandbox run is one of the
 * registry's declared network exceptions (`build_dependency_resolution`,
 * `dependency_vuln_audit`, `package_publishing` — the three
 * `networkEgress: true` entries in categories.json).
 *
 * This is a NARROWING gate layered on top of the deployment's global egress
 * posture (see `requestedPostureForCategory` in posture.ts): returning `true`
 * here can only ever DECLINE TO REMOVE access the operator's own config already
 * granted. It cannot open the network on a deployment whose config says
 * `blocked` — with the default config (`EXECUTION_SANDBOX_ALLOW_EGRESS` unset
 * and an empty allowlist) `requestedPosture()` is `blocked`, so all three of
 * these categories still run with egress denied until an operator explicitly
 * configures egress. Nothing here is the sole reason a sandbox reaches the
 * network.
 *
 * An unknown id, an unsafe id, a missing corpus or a corrupt categories.json
 * all yield `false` — the same answer the pre-port stub always gave.
 */
export function categoryAllowsNetworkEgress(categoryId: string): boolean {
  if (!isSafeCategoryId(categoryId)) return false;
  return loadCategories().get(categoryId)?.networkEgress === true;
}

/** One category's schema.json, or null when the folder has none. */
export function readCategorySchema(categoryId: string): CategorySchema | null {
  if (!isSafeCategoryId(categoryId)) return null;
  const file = join(HARNESS_DIR, categoryId, "schema.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CategorySchema;
  } catch {
    return null;
  }
}

/** Every category's schema.json, for seeding and drift checks. */
export function loadSchemas(): CategorySchema[] {
  if (!existsSync(HARNESS_DIR)) return [];
  const out: CategorySchema[] = [];
  for (const dir of readdirSync(HARNESS_DIR)) {
    const schema = readCategorySchema(dir);
    if (schema) out.push(schema);
  }
  return out;
}

export { HARNESS_DIR, REGISTRY_DIR, isSafeCategoryId };
