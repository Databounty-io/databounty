// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "./harness.js";
import {
  HARNESS_DIR,
  REGISTRY_DIR,
  isSafeCategoryId,
  loadCategories,
  readCategorySchema,
  type CategorySchema,
} from "./registry-catalog.js";
import type { JsonRecord } from "./types.js";
import { parseVerdictLine } from "./verdict-parse.js";

export {
  categoryAllowsNetworkEgress,
  loadCategories,
  loadSchemas,
  readCategorySchema,
  type CategoryEntry,
  type CategorySchema,
} from "./registry-catalog.js";

/**
 * Resolves a category id to its real, human-written verification harness by
 * reading `registry/`.
 *
 * Ported from V1 (databounty-api/src/services/execution-providers/
 * registry-loader.ts). Adding a category is adding a folder there — this loader
 * needs no change, and neither does the API. The category id is the only
 * pipeline selector.
 *
 * The registry files are INLINED into a single self-contained script rather than
 * uploaded as a file tree. That is deliberate: `SandboxProvider` exposes only
 * `runScript`, precisely so the vendor stays swappable (see types.ts). Adding a
 * file-upload method to that interface for the sake of directory layout would
 * blur the one abstraction that keeps E2B replaceable.
 *
 * DELIBERATELY NOT PORTED: V1's `buildBoundHarness()`, which assembles and runs
 * an ADMIN-AUTHORED harness stored in `DatasetTypeHarness.source`. That is a
 * different privilege boundary (arbitrary operator-written JS executed in the
 * sandbox), the rebuild currently has zero such rows, and none of the 16
 * categories this port exists to fix needs it. Leaving it out keeps the new
 * execution surface to exactly the vendored, reviewed corpus. A dataset type
 * whose only verifier would be a bound harness keeps resolving to `null`, i.e.
 * `no_executable_harness` → human review, which is the same honest outcome it
 * has today.
 */

/**
 * Read-through cache keyed on the file's mtime, for the registry files that sit
 * on the PER-SUBMISSION execution path. All are immutable for the life of a
 * deploy; a dev edit is still picked up because the mtime changes. Returns null
 * (never throws) for a missing file so callers can decide.
 */
const fileCache = new Map<string, { mtimeMs: number; value: string }>();

function readCachedFile(file: string): string | null {
  if (!existsSync(file)) return null;
  const mtimeMs = statSync(file).mtimeMs;
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  const value = readFileSync(file, "utf8");
  fileCache.set(file, { mtimeMs, value });
  return value;
}

/** SECURITY-RELEVANT: `categoryId` must already be allowlisted by
 * `loadCategories()` AND shape-checked — both callers below do that first, and
 * this re-checks the shape so no future caller can reach the filesystem with a
 * database-supplied string. */
function readHarnessSource(categoryId: string): string | null {
  if (!isSafeCategoryId(categoryId)) return null;
  return readCachedFile(join(HARNESS_DIR, categoryId, "harness.js"));
}

function readShared(name: string): string {
  const value = readCachedFile(join(REGISTRY_DIR, name));
  if (value === null) throw new Error(`registry: missing ${name}`);
  return value;
}

/**
 * Strip CommonJS plumbing so the source can be concatenated into one script.
 *
 * The files are written as ordinary modules — so they can be unit-tested and
 * read standalone — but the sandbox receives a single flat script, so `require`
 * of a sibling and `module.exports` must be rewritten rather than executed.
 */
function inlineModule(source: string, assignTo: string): string {
  return [
    `const ${assignTo} = (function () {`,
    `  const module = { exports: {} };`,
    `  const exports = module.exports;`,
    source.replace(/require\(\s*['"]\.\.?\/[^'"]+['"]\s*\)/g, "HELPERS"),
    `  return module.exports;`,
    `})();`,
  ].join("\n");
}

/** The one stdout line that parses as JSON and carries a `passed` key. Shared
 * with harness.ts — a second such line is tampering, not a verdict. See
 * verdict-parse.ts. */
const parseLastJson = parseVerdictLine;

/**
 * Build the sandbox script for one category + payload, or null when the
 * registry has no harness for it (the caller then falls through to the
 * role-based dispatch, and ultimately reports `no_executable_harness`).
 */
export function buildRegistryHarness(categoryId: string, payload: JsonRecord): Harness | null {
  if (!isSafeCategoryId(categoryId)) return null;
  const entry = loadCategories().get(categoryId);
  if (!entry) return null;
  const harnessSource = readHarnessSource(entry.id);
  if (!harnessSource) return null;
  return assembleHarnessScript(harnessSource, payload);
}

/**
 * Script assembly for a registry harness — one verdict contract, one runner.
 *
 * `requires` is the runtime contract `run.js` probes BEFORE calling `verify()`:
 * a declared-but-absent binary returns `runtimeUnavailable` and routes the item
 * to human review instead of recording a false failure. A registry harness
 * declares it in its own module (`requires: ['node']`), so nothing is injected
 * here.
 */
function assembleHarnessScript(harnessSource: string, payload: JsonRecord): Harness {
  const helpers = readShared(join("lib", "helpers.js"));
  const runner = readShared("run.js");

  const script = [
    "'use strict';",
    inlineModule(helpers, "HELPERS"),
    inlineModule(harnessSource, "HARNESS"),
    inlineModule(runner, "RUNNER"),
    `const ROW = ${jsonLiteral(payload)};`,
    // One JSON line on stdout is the whole contract with the provider side.
    "const REPORT = RUNNER.main(HARNESS, HELPERS, ROW);",
    "console.log(JSON.stringify(REPORT));",
  ].join("\n");

  return { script, parse: parseLastJson };
}

/**
 * SECURITY-RELEVANT: the submission payload is embedded in JS SOURCE, so it has
 * to survive as data and nothing else.
 *
 * `JSON.stringify` already escapes quotes, backslashes and control characters,
 * which is what makes this safe in general. The two characters it does NOT
 * escape are U+2028/U+2029: legal inside a JSON string, but historically
 * line terminators in JS source, where they would end the statement mid-string.
 * ES2019 made them legal in string literals and every runtime this sandbox uses
 * is well past that — but the cost of not depending on that is two `replace`
 * calls, so it is not worth depending on.
 */
function jsonLiteral(payload: JsonRecord): string {
  return JSON.stringify(payload).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Category ids that have both a routing entry and a harness file. */
export function registryCategoryIds(): string[] {
  const ids: string[] = [];
  for (const [, entry] of loadCategories()) {
    if (!ids.includes(entry.id) && readHarnessSource(entry.id)) ids.push(entry.id);
  }
  return ids;
}

/**
 * Resolve a per-category harness for this dataset type, or null when the
 * registry has none for it (the caller falls through to the role-based dispatch
 * in harness.ts, and ultimately reports `no_executable_harness`).
 */
export function buildCategoryHarness(
  payload: JsonRecord,
  datasetType: { id?: string; fields?: unknown; verification?: unknown }
): Harness | null {
  // 1) Direct id match — the platform-category path.
  if (datasetType.id) {
    const direct = buildRegistryHarness(datasetType.id, payload);
    if (direct) return direct;
  }
  // 2) Inherited harness name — the FORK path. A fork mints a new id but
  // inherits the source's `verification` verbatim, including the
  // `harness: "<category>"` key. Resolving only by id would silently drop the
  // source's registry harness from every fork. Guarded on executable-contract
  // compatibility: the harness reads the payload by the source schema's field
  // keys, so a fork that renamed, re-roled or re-langed any source field falls
  // through for a reviewer to re-bind instead of running a harness against
  // fields it cannot read.
  //
  // NOTE for this rebuild: the vendored catalog (`prisma/dataset-catalog/`)
  // does not currently seed a `verification.harness` key, so this branch is
  // inert here — forks keep resolving `no_executable_harness` until that key is
  // seeded. Ported faithfully rather than dropped, because it fails closed and
  // because seeding that key is a catalog-data decision, not a loader one.
  const inherited = inheritedRegistryHarnessName(datasetType);
  return inherited ? buildRegistryHarness(inherited, payload) : null;
}

/**
 * Does a REGISTRY (file) harness resolve for this contract? Cheap, total, and
 * never throws — checks only existence + fork-compatibility, never assembling a
 * script just to throw it away (`readShared` THROWS on a missing shared file,
 * so doing that would turn a packaging problem into a 500 on callers that only
 * wanted a yes/no).
 */
export function hasRegistryHarness(datasetType: { id?: string; fields?: unknown; verification?: unknown }): boolean {
  const categories = loadCategories();
  if (datasetType.id && isSafeCategoryId(datasetType.id)) {
    const direct = categories.get(datasetType.id);
    if (direct && readHarnessSource(direct.id) !== null) return true;
  }
  return inheritedRegistryHarnessName(datasetType) !== null;
}

/**
 * The registry category a FORK still inherits and can still legitimately run —
 * i.e. `verification.harness` names a real category folder AND the fork's
 * fields are still contract-compatible with that category's schema. Null
 * otherwise.
 */
export function inheritedRegistryHarnessName(datasetType: {
  id?: string;
  fields?: unknown;
  verification?: unknown;
}): string | null {
  const inherited = inheritedHarnessName(datasetType.verification);
  if (!inherited || inherited === datasetType.id) return null;
  if (!isSafeCategoryId(inherited)) return null;
  const entry = loadCategories().get(inherited);
  if (!entry || readHarnessSource(entry.id) === null) return null;
  const schema = readCategorySchema(entry.id);
  if (!schema || !fieldsCompatibleWithSchema(datasetType.fields, schema)) return null;
  return entry.id;
}

/** `verification.harness` when present — written by the seed for a
 * registry-backed type, and inherited verbatim by forks. */
function inheritedHarnessName(verification: unknown): string | null {
  if (!verification || typeof verification !== "object") return null;
  const h = (verification as { harness?: unknown }).harness;
  return typeof h === "string" && h.trim() ? h.trim() : null;
}

/** Every field the source schema declares must survive in the fork with the
 * same key, role and lang (extra fork-added fields are fine — the harness
 * simply never reads them). Fail closed on any unreadable shape. */
function fieldsCompatibleWithSchema(fields: unknown, schema: CategorySchema): boolean {
  if (!Array.isArray(fields)) return false;
  const byKey = new Map<string, { role?: unknown; lang?: unknown }>();
  for (const f of fields as Array<Record<string, unknown>>) {
    if (f && typeof f.key === "string") byKey.set(f.key, { role: f.role, lang: f.lang });
  }
  for (const source of schema.fields) {
    const key = typeof source.key === "string" ? source.key : null;
    if (!key) return false;
    const fork = byKey.get(key);
    if (!fork) return false;
    if ((source.role ?? undefined) !== (fork.role ?? undefined)) return false;
    if ((source.lang ?? undefined) !== (fork.lang ?? undefined)) return false;
  }
  return true;
}
