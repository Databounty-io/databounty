// SPDX-License-Identifier: Apache-2.0

/**
 * The canonical execution-language vocabulary.
 *
 * Four layers of this system each spoke their own dialect and none of them
 * agreed. A dataset type's field metadata says `py`/`ts`/`sh`; its enum options
 * say `Python`/`TypeScript`/`C++`; the sandbox harness helper normalises both to
 * `python`/`typescript`/`cpp`; and the sponsor planner offered a hardcoded list
 * of seven display names borrowed from the NOTIFICATION watch-preference
 * defaults, which is not a statement about execution at all. The visible symptom
 * was a planner offering "Java" on a Python-only WebSocket template and then
 * rejecting the answer one call later.
 *
 * This module is the single translation table between those dialects. It is
 * deliberately dependency-free (no Prisma, no config, no fs) so the planner, the
 * catalog route, the activation gate and the drift test can all share it without
 * an import cycle — the same leaf-module discipline as `difficulty.ts`.
 *
 * `ALIASES` MUST stay in sync with `normLang()` in registry/lib/helpers.js. That
 * function is the one that actually dispatches a submission to a runtime, but it
 * lives inside the sandbox bundle and is loaded as a string, so it cannot be
 * imported here. The drift test asserts the two tables agree.
 */

/** Every language the sandbox harness helper can dispatch. Canonical ids only —
 * these are the values everything downstream compares on. */
export const CANONICAL_LANGUAGES = [
  "python",
  "javascript",
  "typescript",
  "java",
  "go",
  "rust",
  "cpp",
  "c",
  "ruby",
  "php",
  "csharp",
] as const;

export type CanonicalLanguage = (typeof CANONICAL_LANGUAGES)[number];

/** Mirrors `normLang()` in registry/lib/helpers.js, alias for alias. */
const ALIASES: Readonly<Record<string, CanonicalLanguage>> = {
  py: "python", python: "python", python3: "python",
  js: "javascript", javascript: "javascript", node: "javascript", jsx: "javascript",
  ts: "typescript", typescript: "typescript", tsx: "typescript",
  java: "java",
  go: "go", golang: "go",
  rust: "rust", rs: "rust",
  "c++": "cpp", cpp: "cpp", cxx: "cpp",
  c: "c",
  ruby: "ruby", rb: "ruby",
  php: "php",
  "c#": "csharp", csharp: "csharp", cs: "csharp",
};

/** Sponsor-facing spelling. The stored `Bounty.language` uses these, so a label
 * change here changes what contributors see AND what is persisted — the two
 * must not diverge again. */
export const LANGUAGE_LABELS: Readonly<Record<CanonicalLanguage, string>> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  java: "Java",
  go: "Go",
  rust: "Rust",
  cpp: "C++",
  c: "C",
  ruby: "Ruby",
  php: "PHP",
  csharp: "C#",
};

/**
 * Which sandbox binaries a language needs before its rows can be executed.
 *
 * Read off the real dispatch in registry/lib/helpers.js `runCode()`, not from
 * the prose `executionEnv` strings — those are documentation and drift. Compiled
 * languages list the compiler only: every one of them runs the produced binary
 * directly, so there is no separate runtime to probe. `java` is the exception
 * that needs both halves of the JDK, and `csharp` needs the mono runtime beside
 * its compiler.
 */
export const LANGUAGE_RUNTIMES: Readonly<Record<CanonicalLanguage, readonly string[]>> = {
  python: ["python3"],
  javascript: ["node"],
  // tsx is installed on demand inside the sandbox by `ensureNodeToolchain()`,
  // so node is the only thing the image must ship.
  typescript: ["node"],
  java: ["javac", "java"],
  go: ["go"],
  rust: ["rustc"],
  cpp: ["g++"],
  c: ["gcc"],
  ruby: ["ruby"],
  php: ["php"],
  csharp: ["mcs", "mono"],
};

/**
 * Resolve any dialect's spelling to a canonical id, or null when the value
 * names something the harness helper cannot dispatch.
 *
 * Returning null is meaningful and must NOT be treated as "unsupported": the
 * catalog legitimately carries `sh` (two bash templates), `regex`, `graphql` and
 * `sql`, each verified by that category's own purpose-built harness rather than
 * by the polyglot runner. Callers decide what null means in their context; see
 * the conservative rule in `language-support.ts`.
 */
export function normalizeLanguage(raw: string | null | undefined): CanonicalLanguage | null {
  const key = String(raw ?? "").trim().toLowerCase();
  if (!key) return null;
  return ALIASES[key] ?? null;
}

/**
 * Presentation-only spellings for languages the POLYGLOT runner does not
 * dispatch but a category's own harness does.
 *
 * Kept separate from `LANGUAGE_LABELS` on purpose: entries here are not
 * canonical languages and must never gain runtime requirements or a support
 * verdict — they are verified by a purpose-built harness, not by `runCode()`.
 * They exist because four templates store `lang: "sh"`, and "sh" is a filename
 * extension, not something to put in front of a sponsor.
 */
const CATEGORY_LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  sh: "Bash",
  bash: "Bash",
  shell: "Bash",
  sql: "SQL",
  regex: "Regex",
  graphql: "GraphQL",
};

/** The canonical id's sponsor-facing label, falling back to a category-specific
 * spelling and then to the raw value, so a language this module does not model
 * still renders as itself rather than disappearing. */
export function languageLabel(raw: string): string {
  const canonical = normalizeLanguage(raw);
  if (canonical) return LANGUAGE_LABELS[canonical];
  const trimmed = raw.trim();
  return CATEGORY_LANGUAGE_LABELS[trimmed.toLowerCase()] ?? trimmed;
}

/** Exposed for the drift test only — it re-reads normLang() out of the sandbox
 * helper source and compares the two tables entry for entry. */
export function aliasTable(): Readonly<Record<string, CanonicalLanguage>> {
  return ALIASES;
}
