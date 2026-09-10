// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `docs/configuration.md` claims to be the COMPLETE list of environment
 * variables this API reads — that is the whole point of the page, and the
 * ✱ marker only makes sense if the list is exhaustive. Nothing enforced the
 * claim, and it drifted badly: 32 variables were read in `src/` with no row
 * on the page (every `worker.ts` sweep interval, `COOKIE_DOMAIN`,
 * `COOKIE_SAMESITE`, `DB_POOL_MAX`, `MCP_ALLOWED_ORIGINS`, the rate limits),
 * and the page asserted `SMTP_SECURE` was "a stale example entry, which
 * nothing in apps/api/src reads at all" while `config.ts` was reading it.
 *
 * A doc that is confidently wrong about configuration is worse than no doc:
 * an operator sets a variable that does nothing, or fails to set one that
 * matters, and there is no error either way. So the claim is now a test.
 *
 * `lib/publication/env-documented.unit.test.ts` does the same job for
 * `.env.example` and the publication credentials specifically. This one is
 * the whole surface against the reference page.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = here;
const CONFIG_DOC = resolve(here, "../../../docs/configuration.md");

/**
 * Names that are legitimately absent from an operator reference:
 *  - `PATH` is forwarded into sandbox child processes, not configuration.
 *  - `CLAUDE_SCRATCHPAD_DIR` / `RUN_S3_MULTIPART_E2E` gate developer tooling
 *    and an opt-in e2e suite.
 *  - `API_KEY_ENV_VAR` is the *name* of a variable, not one itself.
 */
const NOT_CONFIGURATION = new Set(["PATH", "CLAUDE_SCRATCHPAD_DIR", "RUN_S3_MULTIPART_E2E", "API_KEY_ENV_VAR"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    // Test files may reference throwaway variables; the reference page
    // documents what a deployment reads, not what a fixture sets.
    if (/\.(test|spec)\.ts$/.test(entry) || full.includes("/test-support/")) continue;
    out.push(full);
  }
  return out;
}

function envNamesRead(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
  for (const m of source.matchAll(/process\.env\[["']?([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
  // config.ts reads through helpers: getEnv/getNumber/getList/getBool("NAME").
  for (const m of source.matchAll(/get(?:Env|Number|List|Bool)\("([A-Z][A-Z0-9_]*)"/g)) names.add(m[1]!);
  return [...names];
}

/**
 * Whether the doc really has a row for `name`. A plain `doc.includes(name)`
 * is NOT sufficient and was the first version of this check: it is a
 * substring match, so a typo'd `COOKIE_DOMAIN_TYPO` row satisfies a lookup
 * for `COOKIE_DOMAIN` and the test passes while the variable is effectively
 * undocumented. `_` is a word character, so `\b` anchors correctly reject
 * that while still matching a name inside backticks, a table cell, or prose.
 */
function documents(doc: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(doc);
}

describe("docs/configuration.md documents every variable the API reads", () => {
  const doc = readFileSync(CONFIG_DOC, "utf8");
  const files = sourceFiles(SRC);
  const read = new Map<string, string>();
  for (const file of files) {
    for (const name of envNamesRead(readFileSync(file, "utf8"))) {
      if (NOT_CONFIGURATION.has(name)) continue;
      if (!read.has(name)) read.set(name, file.slice(SRC.length + 1));
    }
  }

  it("finds the variables it is supposed to be checking", () => {
    // Guards the scan itself: a regex that silently matches nothing would
    // make this whole suite pass while checking absolutely nothing.
    expect(files.length).toBeGreaterThan(100);
    expect(read.size).toBeGreaterThan(80);
    for (const name of ["DATABASE_URL", "SESSION_SECRET", "STORAGE_DRIVER", "SMTP_SECURE", "COOKIE_DOMAIN"]) {
      expect([...read.keys()], `${name} should be detected as read`).toContain(name);
    }
  });

  it("has a row for every variable read outside tests", () => {
    const missing = [...read.entries()]
      .filter(([name]) => !documents(doc, name))
      .map(([name, file]) => `${name} (read in ${file})`)
      .sort();
    expect(missing, `undocumented in docs/configuration.md:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("rejects a near-miss row rather than substring-matching it", () => {
    expect(documents("| `COOKIE_DOMAIN` | unset |", "COOKIE_DOMAIN")).toBe(true);
    expect(documents("| `COOKIE_DOMAIN_TYPO` | unset |", "COOKIE_DOMAIN")).toBe(false);
    expect(documents("prose mentioning COOKIE_DOMAIN inline", "COOKIE_DOMAIN")).toBe(true);
  });

  it("documents the variables only the Prisma CLI reads", () => {
    // Read by prisma.config.ts, never by anything under src/, so the scan
    // above can never catch them — and leaving DIRECT_URL undocumented is
    // exactly the gap that made `prisma migrate` hang with no explanation.
    // Asserted by name rather than scanned, because prisma.config.ts sits
    // outside the tree this file walks.
    for (const name of ["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL"]) {
      expect(documents(doc, name), `${name} should have a row`).toBe(true);
    }
  });
});
