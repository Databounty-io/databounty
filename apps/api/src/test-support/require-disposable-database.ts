// SPDX-License-Identifier: Apache-2.0

/**
 * Refuses to run destructive integration tests against a database that is not
 * disposable.
 *
 * WHY THIS EXISTS AS A HELPER. Every integration test used to carry this guard
 * inline, pinned to one exact database name:
 *
 *   if (!process.env.DATABASE_URL?.includes("databounty_community_parity_verify")) throw ...
 *
 * The intent was right — these suites truncate and rewrite rows, so pointing
 * them at a real database would be destructive — but one hardcoded name forced
 * every concurrent session on the machine onto a SINGLE database. Measured
 * consequence, not theory: a full-suite run showed 13 failures across 7 files
 * (`jobs.integration.test.ts`'s lease/reclaim and retry/backoff cases most of
 * all) while 8 other connections from other sessions were open to that same
 * database. Each of those files passes in isolation. So the pin did not just
 * inconvenience parallel work, it produced false failures that look exactly
 * like product defects.
 *
 * WHAT IS ALLOWED NOW. The database must be BOTH:
 *
 *   1. local — a loopback host. A remote host is refused outright, which is
 *      what actually protects staging: the Supabase pooler could never match
 *      the name rule anyway, but "is it local" is the check that generalises.
 *   2. named as disposable — the name has to carry an explicit marker
 *      (`_verify`, `_test`, `_shadow`, `_scratch`, or the historical
 *      `databounty_community_parity_verify` prefix). A per-session suffix such
 *      as `databounty_community_parity_verify_allflags_20260902` now passes,
 *      so two sessions can run the suite at the same time on their own copies.
 *
 * And explicitly refused regardless of the above, because they are real:
 * `databounty` (the V1 local dev database) and anything containing
 * `staging_backup` (the frozen staging snapshot documented in the workspace
 * CLAUDE.md as never-write).
 */

/** Markers that say "this database exists to be thrown away". */
const DISPOSABLE_MARKERS = [/_verify(_|$)/, /_test(_|$)/, /_shadow(_|$)/, /_scratch(_|$)/];

/** Named real databases, refused even if a marker somehow matched. */
const PROTECTED_EXACT = new Set(["databounty", "postgres"]);
const PROTECTED_SUBSTRINGS = ["staging_backup"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

export function requireDisposableDatabase(url: string | undefined = process.env.DATABASE_URL): void {
  if (!url) {
    throw new Error("Refusing to run integration tests: DATABASE_URL is not set.");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refusing to run integration tests: DATABASE_URL is not a parseable URL.");
  }

  const host = parsed.hostname;
  // A non-local host is refused before the name is even considered: no
  // hosted database should ever be truncated by a test run.
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run integration tests: DATABASE_URL points at the non-local host "${host}". ` +
        "Integration tests truncate and rewrite rows and may only run against a local disposable database.",
    );
  }

  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!name) {
    throw new Error("Refusing to run integration tests: DATABASE_URL names no database.");
  }

  if (PROTECTED_EXACT.has(name) || PROTECTED_SUBSTRINGS.some((s) => name.includes(s))) {
    throw new Error(
      `Refusing to run integration tests: "${name}" is a real database, not a disposable one. ` +
        "Create your own copy (any name carrying _verify / _test / _shadow / _scratch) and point DATABASE_URL at it.",
    );
  }

  const disposable =
    name.startsWith("databounty_community_parity_verify") || DISPOSABLE_MARKERS.some((re) => re.test(name));

  if (!disposable) {
    throw new Error(
      `Refusing to run integration tests: "${name}" is not marked as disposable. ` +
        "Use a database name containing _verify, _test, _shadow or _scratch — e.g. " +
        "databounty_community_parity_verify_<yourname>. Running two sessions against one " +
        "database produces false failures in the job-queue timing tests.",
    );
  }
}
