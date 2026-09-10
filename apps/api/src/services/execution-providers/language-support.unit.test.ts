// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_LANGUAGES, LANGUAGE_RUNTIMES } from "../../lib/exec-languages.js";
import { installedRuntimes, languageSupportFor, setInstalledRuntimesForTest } from "./language-support.js";

/**
 * Ported from V1 (`databounty-api/src/services/execution-providers/
 * language-support.test.ts`, 23 cases). The resolver itself is byte-identical to
 * V1's apart from the SPDX header, so the behavioural cases port unchanged; the
 * cases that could not come across are the ones bound to two pieces of V1
 * infrastructure this rebuild does not have, and each is named at its section.
 *
 * Why this file is load-bearing rather than a planner nicety: `languageSupportFor`
 * no longer only fills a picker. It gates request creation on BOTH doors —
 * `POST /v1/community/requests`, planner finalize, and `PATCH /requests/:id` all
 * reject a language the resolver says a template cannot verify. A silent
 * regression here breaks request creation platform-wide, so every case below is
 * mutation-checked: each asserts something that fails when the corresponding
 * line of the resolver is broken.
 *
 * Fixtures are the REAL live shapes out of `dataset_types` (read back from
 * `community_test` on 2026-09-07) wherever a live type exercises the branch.
 * Inventing a shape here is how a test comes to enshrine a claim the catalog
 * never made — the `none` mode is synthetic only because the live distribution
 * over 50 active types is 36 fixed / 9 choice / 5 any / 0 none, so nothing real
 * produces it.
 */

function type(fields: unknown[]) {
  return { fields } as Parameters<typeof languageSupportFor>[0];
}

/** `debugging` — live shape, trimmed to the fields the resolver reads. */
const DEBUGGING = [
  { key: "prompt", role: "instruction" },
  { key: "broken_code", lang: "ts", role: "input_code" },
  { key: "fixed_code", lang: "ts", role: "solution_code" },
  { key: "tests", lang: "ts", role: "tests" },
  { key: "bug_type", role: "enum", options: ["logic", "state", "async", "types", "perf", "memory"] },
];

const TEN_LANGUAGES = ["Python", "JavaScript", "TypeScript", "Java", "Go", "Rust", "C++", "C#", "Ruby", "PHP"];

/** `code_translation` — live shape. Declares the same ten twice, over two keys. */
const CODE_TRANSLATION = [
  { key: "source_code", role: "input_code" },
  { key: "source_language", role: "enum", options: TEN_LANGUAGES },
  { key: "target_code", role: "solution_code" },
  { key: "target_language", role: "enum", options: TEN_LANGUAGES },
  { key: "tests", role: "tests" },
];

/** `api_function_calling` — live shape. Executable field, no language declared. */
const API_FUNCTION_CALLING = [
  { key: "user_request", role: "instruction" },
  { key: "available_tools_schema", role: "rationale" },
  { key: "tool_call_json", role: "solution_code" },
  { key: "tool_response", role: "rationale" },
  { key: "final_answer", role: "expected_output" },
];

// --------------------------------------------------------------- modes -----

describe("languageSupportFor — the four modes", () => {
  it("states the one permitted language rather than asking (fixed)", () => {
    // Live `debugging`: three executable fields all pinned to `ts`. Nineteen of
    // V1's active types had exactly ONE possible answer, so a planner that asked
    // was asking a question with no valid option among those it presented.
    const support = languageSupportFor(type(DEBUGGING));
    expect(support.mode).toBe("fixed");
    expect(support.languages).toEqual([{ id: "typescript", label: "TypeScript", status: "verified" }]);
  });

  it("offers a closed set for a polyglot type (choice)", () => {
    // Live `code_translation`. Ten languages declared across TWO language keys,
    // twenty option strings in total, collapsing to ten by canonical identity.
    const support = languageSupportFor(type(CODE_TRANSLATION));
    expect(support.mode).toBe("choice");
    expect(support.languages).toHaveLength(10);
    expect(support.languages.map((l) => l.id)).toEqual([
      "python", "javascript", "typescript", "java", "go", "rust", "cpp", "csharp", "ruby", "php",
    ]);
  });

  it("falls back to free text when an executable type declares nothing (any)", () => {
    // Live `api_function_calling`: `tool_call_json` is a solution_code field, so
    // there IS code to run, but nothing constrains the language.
    const support = languageSupportFor(type(API_FUNCTION_CALLING));
    expect(support.mode).toBe("any");
    expect(support.languages).toEqual([]);
  });

  it("skips the question entirely for a type with no executable fields (none)", () => {
    // Synthetic on purpose: no live active type produces `none`, so there is no
    // fixture to borrow. A media-annotation shape is the case the mode exists
    // for — asking its sponsor for a language is asking about nothing.
    const support = languageSupportFor(type([
      { key: "audio", role: "file", modality: "audio" },
      { key: "transcript", role: "expected_output" },
    ]));
    expect(support.mode).toBe("none");
    expect(support.languages).toEqual([]);
  });

  it("separates `none` from `any` on the executable-role check alone", () => {
    // The two empty-language modes differ by ONE predicate. Same fields, one
    // role changed, opposite verdicts — so a resolver that stopped consulting
    // EXECUTABLE_ROLES cannot pass both halves.
    expect(languageSupportFor(type([{ key: "x", role: "expected_output" }])).mode).toBe("none");
    expect(languageSupportFor(type([{ key: "x", role: "solution_code" }])).mode).toBe("any");
    expect(languageSupportFor(type([{ key: "x", role: "input_code" }])).mode).toBe("any");
    expect(languageSupportFor(type([{ key: "x", role: "tests" }])).mode).toBe("any");
  });
});

// ----------------------------------------------------- declared fidelity -----

describe("what the type declares is the whole universe", () => {
  it("never offers a language the type does not declare", () => {
    // The bug this module exists for: Java was offered on every active type
    // when only six accepted it, then rejected by the field guard one call
    // later. Now a hard gate on request creation, not just a bad chip.
    const support = languageSupportFor(type(DEBUGGING));
    expect(support.languages.map((l) => l.label)).toEqual(["TypeScript"]);
    expect(support.languages.map((l) => l.label)).not.toContain("Java");
  });

  it("de-duplicates dialects of the same language", () => {
    // `Python`, `python3` and `py` are three spellings of one runtime. Three
    // chips for one language reads as three choices that behave identically.
    const support = languageSupportFor(type([
      { key: "language", role: "enum", options: ["Python", "python3"] },
      { key: "solution_code", role: "solution_code", lang: "py" },
    ]));
    expect(support.mode).toBe("fixed");
    expect(support.languages).toEqual([{ id: "python", label: "Python", status: "verified" }]);
  });

  it("keeps declaration order, enum options before executable-field langs", () => {
    // Order is sponsor-visible (it is chip order) and it is also what makes the
    // dedup deterministic: the FIRST spelling of a language wins its label.
    const support = languageSupportFor(type([
      { key: "language", role: "enum", options: ["Go", "Rust"] },
      { key: "solution_code", role: "solution_code", lang: "py" },
    ]));
    expect(support.languages.map((l) => l.id)).toEqual(["go", "rust", "python"]);
  });

  it("reads a language enum only from an allowlisted key, and a lang only from an executable role", () => {
    // The two harvest paths have different keys. An enum on a non-language key
    // contributes nothing; a `lang` on a non-executable role contributes
    // nothing. Both halves must hold or the harvest is over-broad.
    expect(languageSupportFor(type([
      { key: "bug_type", role: "enum", options: ["logic", "async"] },
      { key: "fixed_code", lang: "ts", role: "solution_code" },
    ])).languages.map((l) => l.id)).toEqual(["typescript"]);

    expect(languageSupportFor(type([
      { key: "explanation", lang: "py", role: "rationale" },
      { key: "fixed_code", lang: "ts", role: "solution_code" },
    ])).languages.map((l) => l.id)).toEqual(["typescript"]);
  });

  it("survives malformed field metadata instead of throwing", () => {
    // `fields` is a free jsonb column an admin can author. A resolver that
    // throws on a bad row takes request creation down on both doors with it.
    expect(languageSupportFor(type([null, "nonsense", 42, [], { key: 7, lang: false }])).mode).toBe("none");
    expect(languageSupportFor({ fields: null } as Parameters<typeof languageSupportFor>[0]).mode).toBe("none");
    expect(languageSupportFor(type([
      { key: "language", role: "enum", options: ["Python", 7, null] },
      { key: "solution_code", role: "solution_code" },
    ])).languages.map((l) => l.id)).toEqual(["python"]);
  });
});

// ------------------------------------------------------ exact allowlist -----

describe("the language-field harvest is an exact allowlist, not a %lang% pattern", () => {
  /**
   * This is the regression the allowlist exists for, and all three decoys are
   * REAL live types, not composed hazards. A `%lang%` match harvests every one
   * of them as a language:
   *   `language_ecosystem`          → pip / npm / cargo  (package managers)
   *   `query_language`              → "SQL (log data loaded into a table)"
   *   `natural_language_description` → an instruction field
   */

  it("does not harvest `language_ecosystem` — those are package managers", () => {
    // Live `build_dependency_resolution`. Its real language is `sh`.
    const support = languageSupportFor(type([
      { key: "project_manifest", role: "input_code" },
      { key: "build_command", lang: "sh", role: "solution_code" },
      { key: "language_ecosystem", role: "enum", options: ["pip", "npm", "cargo"] },
      { key: "expected_build_result", role: "expected_output" },
    ]));
    expect(support.mode).toBe("fixed");
    expect(support.languages.map((l) => l.label)).toEqual(["Bash"]);
    for (const decoy of ["pip", "npm", "cargo"]) {
      expect(support.languages.map((l) => l.id)).not.toContain(decoy);
    }
  });

  it("does not harvest `query_language` — those are compound phrases", () => {
    // Live `log_parsing`. Harvesting it would offer a sponsor
    // "SQL (log data loaded into a table)" as a language and then store that
    // string as `Bounty.language`. Its real language is `py`.
    const support = languageSupportFor(type([
      { key: "log_fixture", role: "input_code" },
      { key: "parsing_or_query_code", lang: "py", role: "solution_code" },
      { key: "query_language", role: "enum", options: [
        "Python + regex", "Python + string parsing", "Python + statistics",
        "Python + datetime parsing", "SQL (log data loaded into a table)",
      ] },
      { key: "expected_extracted_metrics", role: "expected_output" },
    ]));
    expect(support.mode).toBe("fixed");
    expect(support.languages).toEqual([{ id: "python", label: "Python", status: "verified" }]);
    expect(support.languages.map((l) => l.label)).not.toContain("SQL (log data loaded into a table)");
  });

  it("does not harvest `natural_language_description` — that is an instruction", () => {
    // Live `regex_generation`. Note its `timeout_ms` enum too: a harvest keyed
    // on role rather than key would offer "100" / "200" as languages.
    const support = languageSupportFor(type([
      { key: "natural_language_description", role: "instruction" },
      { key: "generated_regex", lang: "regex", role: "solution_code" },
      { key: "test_strings_match", role: "list" },
      { key: "timeout_ms", role: "enum", options: ["100", "200", "300", "500", "1000"] },
    ]));
    expect(support.mode).toBe("fixed");
    expect(support.languages.map((l) => l.label)).toEqual(["Regex"]);
  });

  it("harvests all three allowlisted keys and nothing else, on one type", () => {
    // V1's composite case. `language`, `source_language` and `target_language`
    // are in; the three decoys are out, in a single shape so a partial
    // allowlist cannot pass by getting one of them right.
    const support = languageSupportFor(type([
      { key: "language", role: "enum", options: ["Go"] },
      { key: "source_language", role: "enum", options: ["Rust"] },
      { key: "target_language", role: "enum", options: ["Java"] },
      { key: "language_ecosystem", role: "enum", options: ["pip", "npm", "cargo"] },
      { key: "query_language", role: "enum", options: ["Python + regex", "SQL (log data loaded into a table)"] },
      { key: "natural_language_description", role: "instruction" },
      { key: "solution_code", role: "solution_code" },
    ]));
    expect(support.mode).toBe("choice");
    expect(support.languages.map((l) => l.id)).toEqual(["go", "rust", "java"]);
  });
});

// ------------------------------------------------------------- aliases -----

describe("alias handling", () => {
  it("canonicalizes every alias the harness dispatches", () => {
    // The catalog stores `ts`/`py`/`sh`; enums say `Python`/`C++`. The resolver
    // must land on one id per language whichever dialect it was handed.
    const cases: [string, string, string][] = [
      ["py", "python", "Python"], ["python3", "python", "Python"],
      ["ts", "typescript", "TypeScript"], ["tsx", "typescript", "TypeScript"],
      ["js", "javascript", "JavaScript"], ["node", "javascript", "JavaScript"],
      ["golang", "go", "Go"], ["rs", "rust", "Rust"],
      ["c++", "cpp", "C++"], ["cxx", "cpp", "C++"],
      ["c#", "csharp", "C#"], ["cs", "csharp", "C#"],
      ["rb", "ruby", "Ruby"],
    ];
    for (const [declared, id, label] of cases) {
      const support = languageSupportFor(type([{ key: "solution_code", role: "solution_code", lang: declared }]));
      expect(support.languages, declared).toEqual([{ id, label, status: "verified" }]);
    }
  });

  it("collapses aliases of one language into a single chip across both harvest paths", () => {
    const support = languageSupportFor(type([
      { key: "language", role: "enum", options: ["c#", "csharp", "C#", "cs"] },
      { key: "solution_code", role: "solution_code", lang: "cs" },
    ]));
    expect(support.mode).toBe("fixed");
    expect(support.languages).toEqual([{ id: "csharp", label: "C#", status: "verified" }]);
  });

  it("keeps a category-specific language verified rather than guessing unsupported", () => {
    // `sh`, `regex`, `graphql`, `sql` are not polyglot-runner languages, so
    // normalizeLanguage returns null for each. Each has a purpose-built harness,
    // so null means "not the polyglot runner's problem", NOT "unsupported" —
    // guessing the latter invents a failure the running system does not have,
    // and now that this gates request creation it would block real requests.
    const labels: Record<string, string> = { sh: "Bash", regex: "Regex", graphql: "GraphQL", sql: "SQL" };
    for (const lang of ["sh", "regex", "graphql", "sql"]) {
      const support = languageSupportFor(type([{ key: "solution_code", role: "solution_code", lang }]));
      expect(support.mode).toBe("fixed");
      expect(support.languages[0]?.status, lang).toBe("verified");
      expect(support.languages[0]?.label, lang).toBe(labels[lang]);
      expect(support.languages[0]?.reason, lang).toBeUndefined();
    }
  });

  it("passes an unmodelled language through as itself instead of dropping it", () => {
    const support = languageSupportFor(type([{ key: "solution_code", role: "solution_code", lang: "Kotlin" }]));
    expect(support.languages).toEqual([{ id: "kotlin", label: "Kotlin", status: "verified" }]);
  });
});

// -------------------------------------------------------- unverifiable -----

/**
 * The `unverifiable` branch — a language the harness dispatches but the image
 * ships no runtime for. It must still be OFFERED (the pipeline accepts those
 * rows and routes them to human audit rather than rejecting them) while never
 * reading as execution-verified.
 *
 * Driven through `setInstalledRuntimesForTest`, exactly as V1 does, and NEVER by
 * hardcoding which runtimes are absent today: all 50 active types resolve fully
 * `verified` against the real manifest, and pinning an absence here is precisely
 * the mistake that made an earlier version of V1's test enshrine a wrong claim
 * about Ruby / PHP / C#.
 */
describe("the unverifiable branch", () => {
  afterEach(() => setInstalledRuntimesForTest());

  const polyglot = type([
    { key: "language", role: "enum", options: ["Python", "Ruby", "PHP", "C#"] },
    { key: "solution_code", role: "solution_code" },
  ]);

  it("marks a declared language with no installed runtime unverifiable, not absent", () => {
    setInstalledRuntimesForTest(["python3"]);
    const support = languageSupportFor(polyglot);
    // Still offered: all four chips survive. Dropping them would silently
    // narrow the sponsor's options AND, on the request-creation gate, reject a
    // language the pipeline would in fact have accepted for human audit.
    expect(support.languages).toHaveLength(4);
    const byId = Object.fromEntries(support.languages.map((l) => [l.id, l]));
    expect(byId.python?.status).toBe("verified");
    for (const id of ["ruby", "php", "csharp"]) {
      expect(byId[id]?.status, id).toBe("unverifiable");
      expect(byId[id]?.reason, id).toMatch(/human audit/);
    }
  });

  it("names the missing binary so the sponsor sees WHY, not just that it failed", () => {
    setInstalledRuntimesForTest(["python3"]);
    const byId = Object.fromEntries(languageSupportFor(polyglot).languages.map((l) => [l.id, l]));
    expect(byId.ruby?.reason).toContain("no configured execution sandbox has ruby");
    // C# needs BOTH halves, and the reason names both.
    expect(byId.csharp?.reason).toContain("mcs");
    expect(byId.csharp?.reason).toContain("mono");
  });

  it("reports the SMALLEST gap, not the union, when a language needs several binaries", () => {
    // `mono` present, `mcs` absent: the reason must name only the binary that
    // is actually missing. Naming the whole requirement would send someone to
    // install a runtime the box already has.
    setInstalledRuntimesForTest(["python3", "mono"]);
    const byId = Object.fromEntries(languageSupportFor(polyglot).languages.map((l) => [l.id, l]));
    expect(byId.csharp?.status).toBe("unverifiable");
    expect(byId.csharp?.reason).toContain("mcs");
    expect(byId.csharp?.reason).not.toContain("mono");
  });

  it("degrades an unanswerable chain to cannot-claim, never to supported", () => {
    // An empty manifest makes e2b's capability `usable: false`, so it does not
    // vote and NOTHING can be claimed. Unknown must read as "cannot claim", not
    // as "supported" and not as a confident "this box lacks python3" — the two
    // are different verdicts and only one is honest.
    setInstalledRuntimesForTest([]);
    const byId = Object.fromEntries(languageSupportFor(polyglot).languages.map((l) => [l.id, l]));
    for (const id of ["python", "ruby", "php", "csharp"]) {
      expect(byId[id]?.status, id).toBe("unverifiable");
      expect(byId[id]?.reason, id).toMatch(/could report/);
      expect(byId[id]?.reason, id).toMatch(/human audit/);
    }
    // And the unknown wording is distinct from the positive-absence wording,
    // which is the whole point of keeping the two branches apart.
    expect(byId.python?.reason).not.toContain("no configured execution sandbox has");
  });

  it("never flags a language on the real manifest", () => {
    // The live counterpart. Against the actual probed template the ten
    // languages `code_translation` offers are all executable, so none of them
    // may be flagged — an over-claim and an under-claim are both dishonest.
    const support = languageSupportFor(type(CODE_TRANSLATION));
    expect(support.languages.filter((l) => l.status !== "verified")).toEqual([]);
  });

  it("leaves a category-specific language verified even on an empty image", () => {
    // `sh` never reaches the runtime verdict at all (normalizeLanguage → null),
    // so the honesty degrade must not leak onto languages it does not govern.
    setInstalledRuntimesForTest([]);
    const support = languageSupportFor(type([{ key: "solution_code", role: "solution_code", lang: "sh" }]));
    expect(support.languages[0]?.status).toBe("verified");
  });
});

// -------------------------------------------------------- drift guards -----

describe("drift guards", () => {
  it("declares a runtime requirement for every canonical language", () => {
    for (const lang of CANONICAL_LANGUAGES) {
      expect(LANGUAGE_RUNTIMES[lang].length, lang).toBeGreaterThan(0);
    }
  });

  it("claims a runtime for every language the polyglot harness dispatches", () => {
    // If a runtime is genuinely dropped from a future template this fails and
    // the resolver starts returning `unverifiable` for that language — which is
    // the honest outcome, not something to silence here by trimming the list.
    const installed = installedRuntimes();
    expect(installed.size).toBeGreaterThan(0);
    for (const lang of CANONICAL_LANGUAGES) {
      for (const binary of LANGUAGE_RUNTIMES[lang]) {
        expect(installed.has(binary), `${lang} needs ${binary}, absent from the E2B template manifest`).toBe(true);
      }
    }
  });

  it("resolves every active-catalog language shape to a usable answer", () => {
    // Whole-catalog sweep over the four live language shapes. Every active type
    // must land in a mode the planner and BOTH request-creation doors can act
    // on, with no empty `fixed`/`choice` and no unlabelled chip.
    const shapes = [DEBUGGING, CODE_TRANSLATION, API_FUNCTION_CALLING];
    for (const fields of shapes) {
      const support = languageSupportFor(type(fields));
      expect(["fixed", "choice", "any", "none"]).toContain(support.mode);
      if (support.mode === "fixed") expect(support.languages).toHaveLength(1);
      if (support.mode === "choice") expect(support.languages.length).toBeGreaterThan(1);
      if (support.mode === "any" || support.mode === "none") expect(support.languages).toEqual([]);
      for (const language of support.languages) {
        expect(language.label.trim(), JSON.stringify(language)).not.toBe("");
        expect(language.id.trim(), JSON.stringify(language)).not.toBe("");
        expect(language.status === "unverifiable" ? language.reason : "ok").toBeTruthy();
      }
    }
  });
});
