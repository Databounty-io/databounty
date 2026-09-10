// SPDX-License-Identifier: Apache-2.0

import type { DatasetType } from "@prisma/client";
import { config } from "../../config.js";
import { BROKEN_VARIANT_KEYS } from "./contract.js";
import { buildCategoryHarness } from "./registry-loader.js";
import type { JsonRecord } from "./types.js";
import { parseVerdictLine } from "./verdict-parse.js";

/**
 * Language harness builders — turn a submission payload into a self-contained
 * script a SandboxProvider can run, plus a parser for its stdout contract.
 *
 * Every harness is a Node orchestrator (the provider runs it with `node`) that
 * shells out to the target runtime. The multi-language template adds go, rust
 * and a JDK on top of node/python3/gcc/bash; a runtime that isn't installed is
 * reported `runtimeUnavailable` and the item routes to human audit rather than
 * a false failure. Interpreted languages (python/node) run the contributor's
 * tests; compiled languages (java/go/rust/c) are compiled (and run when they
 * have an entry point, or `go test` when tests are provided).
 */

export interface HarnessResult {
  passed: boolean;
  score: number | null;
  testsRun?: number;
  brokenCodeFailedTests?: boolean;
  runtimeUnavailable?: boolean;
  unverifiable?: string[];
  logs: string;
  detail: JsonRecord;
}

export interface Harness {
  script: string;
  parse(stdout: string): HarnessResult | null;
}

function pickString(payload: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * In-sandbox timeouts. These MUST stay strictly below the outer sandbox
 * command budget (`config.execution.timeoutMs`), otherwise the outer timeout
 * stops being a backstop: a child that outlives it can only be stopped by
 * tearing the whole sandbox down mid-command. They used to be hardcoded
 * literals (25_000 here, 60_000 in the language verifier) against a 30s outer
 * default — i.e. the compile/test path could run twice as long as the budget
 * that was supposed to bound it. Both are now derived in config.ts, where a
 * boot assertion enforces `2×child + probe < command < sandbox lifetime`.
 */
const CHILD_TIMEOUT_MS = config.execution.harness.childTimeoutMs;
const PROBE_TIMEOUT_MS = config.execution.harness.probeTimeoutMs;

/** Shared orchestrator preamble: temp dir, runtime probe, child runner, emit. */
const ORCH = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { spawnSync } = require("node:child_process");',
  'const dir = fs.mkdtempSync("/tmp/db-exec-");',
  `const CHILD_TIMEOUT_MS = ${CHILD_TIMEOUT_MS};`,
  `const PROBE_TIMEOUT_MS = ${PROBE_TIMEOUT_MS};`,
  'function have(cmd){ try { const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }); return r.status === 0 || !!(r.stdout || r.stderr); } catch { return false; } }',
  'function run(cmd, args, input){ return spawnSync(cmd, args, { cwd: dir, encoding: "utf8", timeout: CHILD_TIMEOUT_MS, input: input, env: { PATH: process.env.PATH || "", HOME: dir } }); }',
  'function emit(o){ console.log(JSON.stringify(o)); }',
].join("\n");

/**
 * verifyLang(lang, code, tests) — the shared multi-language verifier injected
 * into harnesses that run contributor code. Returns { ok, log } or
 * { unavailable, runtime } when the sandbox lacks the toolchain.
 *  - python/node: run the tests (or a syntax/run check when no tests)
 *  - go: `go test` with tests, else gofmt/build syntax check
 *  - java: javac compile (run when a main exists)
 *  - rust: rustc compile (bin+run when fn main exists, else lib)
 *  - c: gcc compile (run when main exists)
 */
const LANG_VERIFIER = String.raw`
function _classJava(code){ var m = code.match(/public\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/) || code.match(/(?:^|\s)class\s+([A-Za-z_][A-Za-z0-9_]*)/); return m ? m[1] : "Main"; }
function verifyLang(lang, code, tests){
  lang = (lang || "").toLowerCase();
  const cwd = fs.mkdtempSync(path.join(dir, "v-"));
  function sh(cmd, args, opts){ return spawnSync(cmd, args, Object.assign({ cwd: cwd, encoding: "utf8", timeout: CHILD_TIMEOUT_MS, env: { PATH: process.env.PATH || "", HOME: cwd, GOCACHE: "/tmp/go-build", GOPATH: cwd + "/go", RUSTUP_HOME: "/opt/rust", CARGO_HOME: "/opt/rust" } }, opts || {})); }
  // Distinguish a genuine test failure from an INFRASTRUCTURE fault, so the
  // broken-code obligation is never satisfied by code that failed to LOAD
  // rather than failed its TESTS — the same fraud the node harness guards
  // against, propagated here to python and every compiled language. High-
  // precision signatures only; an unrecognised non-zero exit is treated as a
  // real test failure (the honest default for the broken variant), while a
  // recognised load/compile/timeout fault becomes "unverifiable".
  function _infra(r, log){
    if (r.status === null || (r.signal && r.signal !== null)) return true; // killed / timed out
    return /ModuleNotFoundError|No module named|ImportError|SyntaxError|IndentationError|cannot find package|cannot find module|undefined reference|compilation terminated|cannot find symbol|error\[E[0-9]+\]|error: expected|error: cannot|LoadError|cannot load such file|require': cannot load|PHP Parse error|Fatal error: Uncaught Error: Failed opening|CS[0-9]{4}:|Unhandled Exception: System\.IO/.test(String(log || ""));
  }
  function res(r, note){ const log = (note ? note + "\n" : "") + (r.stdout || "") + (r.stderr || ""); return { ok: r.status === 0, infra: r.status !== 0 && _infra(r, log), log: log }; }
  if (["py","python","python3"].includes(lang)){
    if (!have("python3")) return { unavailable: true, runtime: "python3" };
    fs.writeFileSync(path.join(cwd, "solution.py"), code);
    if (!tests) return res(sh("python3", ["-I","-m","py_compile","solution.py"]), "python syntax check");
    const main = "import runpy\nglobals().update({k:v for k,v in runpy.run_path('solution.py').items() if not k.startswith('__')})\n" + tests + "\n";
    fs.writeFileSync(path.join(cwd, "main.py"), main);
    return res(sh("python3", ["-I","main.py"]));
  }
  if (["js","jsx","javascript","node"].includes(lang)){
    if (!have("node")) return { unavailable: true, runtime: "node" };
    if (tests){ fs.writeFileSync(path.join(cwd,"submission.js"), code); fs.writeFileSync(path.join(cwd,"submission.test.js"), tests); return res(sh("node",["--test","submission.test.js"])); }
    fs.writeFileSync(path.join(cwd,"s.js"), code); return res(sh("node",["--check","s.js"]));
  }
  if (["ts","tsx","typescript"].includes(lang)){
    fs.writeFileSync(path.join(cwd,"s.ts"), tests ? code + "\n" + tests : code);
    if (have("tsx")) return res(sh("npx",["tsx","s.ts"]));
    if (have("node")) return res(sh("node",["--check","s.ts"]), "no tsx; syntax-checked as js");
    return { unavailable: true, runtime: "tsx/node" };
  }
  if (lang === "java"){
    if (!have("javac")) return { unavailable: true, runtime: "javac" };
    const cls = _classJava(code); fs.writeFileSync(path.join(cwd, cls + ".java"), code);
    const c = sh("javac", [cls + ".java"]); if (c.status !== 0) return { ok: false, infra: true, log: "javac:\n" + (c.stdout||"") + (c.stderr||"") };
    if (/static\s+void\s+main\s*\(/.test(code)) return res(sh("java", [cls]), "compiled; ran main");
    return { ok: true, log: "compiled OK (no main)" };
  }
  if (lang === "go"){
    if (!have("go")) return { unavailable: true, runtime: "go" };
    fs.writeFileSync(path.join(cwd,"go.mod"),"module m\n\ngo 1.22\n");
    if (tests){
      var tsrc = code.replace(/^\s*package\s+\w+/m, "package m"); if (!/package\s+\w+/.test(tsrc)) tsrc = "package m\n" + tsrc;
      var ttest = tests.replace(/^\s*package\s+\w+/m, "package m"); if (!/package\s+\w+/.test(ttest)) ttest = "package m\nimport \"testing\"\nvar _ = testing.T{}\n" + tests;
      fs.writeFileSync(path.join(cwd,"sol.go"), tsrc); fs.writeFileSync(path.join(cwd,"sol_test.go"), ttest);
      return res(sh("go",["test","./..."]));
    }
    // Validity/type-check: compile as a library package so a function-only file
    // (no func main) still type-checks fully.
    var gsrc = code.replace(/^\s*package\s+\w+/m, "package p"); if (!/package\s+\w+/.test(gsrc)) gsrc = "package p\n" + gsrc;
    fs.writeFileSync(path.join(cwd,"p.go"), gsrc);
    return res(sh("go",["build","./..."]), "go type-check");
  }
  if (["rs","rust"].includes(lang)){
    if (!have("rustc")) return { unavailable: true, runtime: "rustc" };
    fs.writeFileSync(path.join(cwd,"main.rs"), code);
    const isBin = /fn\s+main\s*\(/.test(code);
    const c = sh("rustc", ["--edition","2021","--crate-type", isBin?"bin":"lib", "main.rs","-o", path.join(cwd,"out")]);
    if (c.status !== 0) return { ok: false, infra: true, log: "rustc:\n" + (c.stderr||"") };
    if (isBin) return res(sh(path.join(cwd,"out"), []), "compiled; ran");
    return { ok: true, log: "compiled OK (lib)" };
  }
  if (lang === "c"){
    if (!have("gcc")) return { unavailable: true, runtime: "gcc" };
    fs.writeFileSync(path.join(cwd,"main.c"), code);
    const isBin = /int\s+main\s*\(/.test(code);
    const c = isBin ? sh("gcc",["main.c","-o",path.join(cwd,"out")]) : sh("gcc",["-fsyntax-only","main.c"]);
    if (c.status !== 0) return { ok: false, infra: true, log: "gcc:\n" + (c.stderr||"") };
    if (isBin) return res(sh(path.join(cwd,"out"), []), "compiled; ran");
    return { ok: true, log: "compiled OK" };
  }
  if (["c++","cpp","cxx"].includes(lang)){
    if (!have("g++")) return { unavailable: true, runtime: "g++" };
    fs.writeFileSync(path.join(cwd,"main.cpp"), code);
    const isBin = /int\s+main\s*\(/.test(code);
    const c = isBin ? sh("g++",["-std=c++17","main.cpp","-o",path.join(cwd,"out")]) : sh("g++",["-std=c++17","-fsyntax-only","main.cpp"]);
    if (c.status !== 0) return { ok: false, infra: true, log: "g++:\n" + (c.stderr||"") };
    if (isBin) return res(sh(path.join(cwd,"out"), []), "compiled; ran");
    return { ok: true, log: "compiled OK" };
  }
  if (["rb","ruby"].includes(lang)){
    // Present in runtimes.json but previously absent here, so a ruby-lang type
    // reported "ruby not available in sandbox" even where Ruby is installed — a
    // false runtime_unavailable that sent every item to human audit. -c is a
    // syntax check; with tests we run them.
    if (!have("ruby")) return { unavailable: true, runtime: "ruby" };
    fs.writeFileSync(path.join(cwd,"solution.rb"), code);
    if (!tests) return res(sh("ruby",["-c","solution.rb"]), "ruby syntax check");
    fs.writeFileSync(path.join(cwd,"test.rb"), "require './solution'\n" + tests);
    return res(sh("ruby",["test.rb"]));
  }
  if (["php"].includes(lang)){
    if (!have("php")) return { unavailable: true, runtime: "php" };
    fs.writeFileSync(path.join(cwd,"solution.php"), code);
    if (!tests) return res(sh("php",["-l","solution.php"]), "php lint");
    fs.writeFileSync(path.join(cwd,"test.php"), "<?php require 'solution.php';\n?>" + tests);
    return res(sh("php",["test.php"]));
  }
  if (["cs","csharp","c#"].includes(lang)){
    // mcs (Mono) compiles a single-file program; run when it has an entry point.
    if (!have("mcs")) return { unavailable: true, runtime: "mcs" };
    fs.writeFileSync(path.join(cwd,"Main.cs"), code);
    const c = sh("mcs",["Main.cs","-out:main.exe"]);
    if (c.status !== 0) return { ok: false, infra: true, log: "mcs:\n" + (c.stdout||"") + (c.stderr||"") };
    if (have("mono") && /static\s+.*\bMain\s*\(/.test(code)) return res(sh("mono",["main.exe"]), "compiled; ran");
    return { ok: true, log: "compiled OK (no entry point run)" };
  }
  return { unavailable: true, runtime: lang || "unknown" };
}
`;

/** Wrap orchestrator body in a main() so early `return` is always legal. */
function makeScript(consts: string, body: string, withVerifier = false): string {
  return `${ORCH}\n${withVerifier ? LANG_VERIFIER + "\n" : ""}${consts}\nfunction main(){\n${body}\n}\nmain();`;
}

/** Shared, fail-closed stdout→verdict contract. See verdict-parse.ts for why
 * a SECOND `passed`-bearing line is treated as tampering rather than as the
 * verdict. */
const parseLastJson = parseVerdictLine;

const NODE_LANGS = new Set(["js", "jsx", "javascript", "node", "ts", "tsx", "typescript"]);
const PYTHON_LANGS = new Set(["py", "python", "python3"]);
// "compiled" here means "handled by LANG_VERIFIER / buildCompiledHarness",
// which now includes the interpreted-but-not-node/python languages (ruby, php,
// c#) too — keeping this in sync with LANG_VERIFIER's branches is why they were
// out of step before (ruby ran through node-less paths and reported
// unavailable). Kept as one list here; the language table consolidation
// (a JSON manifest driving both this and exec-languages.ts) is the follow-up
// that removes the duplication entirely.
const COMPILED_LANGS = new Set(["java", "go", "rust", "rs", "c", "c++", "cpp", "cxx", "rb", "ruby", "php", "cs", "csharp", "c#"]);

type Runtime = "node" | "python" | "compiled" | null;
function runtimeForLang(lang: string): Runtime {
  const l = lang.trim().toLowerCase();
  if (NODE_LANGS.has(l)) return "node";
  if (PYTHON_LANGS.has(l)) return "python";
  if (COMPILED_LANGS.has(l)) return "compiled";
  return null;
}

const SOLUTION_KEYS = ["fixed_code", "solution_code", "translated_code", "optimized_code", "fast_code", "migrated_code"];
/** Imported, not redeclared: `contract.ts` enforces the broken-variant
 * obligation against this same list, and two copies drifting apart is exactly
 * how the gate came to be enforced for only one of the five keys. */
const BROKEN_KEYS = BROKEN_VARIANT_KEYS;
const TEST_KEYS = ["tests", "test_code", "benchmark"];

// --------------------------------------------------------------- node -------

/** Node/JS/TS harness (interpreted). Runs the fixed (and, for debugging,
 * broken) code against the contributor's tests. TypeScript must stay on its
 * own path: writing typed source as `submission.js` and invoking plain Node
 * turns valid annotations into a SyntaxError and falsely reports a sandbox
 * test failure. */
export function buildNodeHarness(payload: JsonRecord, language = "node"): Harness | null {
  const tests = pickString(payload, TEST_KEYS);
  if (!tests) return null;
  const solutionCode = pickString(payload, SOLUTION_KEYS);
  const brokenCode = pickString(payload, BROKEN_KEYS);
  if (!solutionCode && !brokenCode) return null;

  const consts = [
    `const testCode = ${jsString(tests)};`,
    `const fixedCode = ${jsString(solutionCode || brokenCode)};`,
    `const brokenCode = ${jsString(brokenCode)};`,
  ].join("\n");
  const typeScript = ["ts", "tsx", "typescript"].includes(language.trim().toLowerCase());
  const extension = typeScript ? "ts" : "js";
  const runner = typeScript ? "tsx" : "node";
  // The temp package.json `type` is derived from the payload rather than pinned
  // to "module": contributors (and the seeded samples) write either CommonJS
  // (`require("./submission")` / `module.exports`) or ESM (`import`/`export`).
  // Pinning ESM made every CommonJS item fail with "require is not defined",
  // which surfaced as a false `tests_failed` instead of a real verdict.
  const body = `
  if (!have(${jsString(runner)})) { emit({ passed:false, score:null, runtimeUnavailable:true, logs:${jsString(`${runner} not available`)}, detail:{ runtime:${jsString(runner)} } }); return; }
  function moduleType(code){ const s = String(code) + "\\n" + String(testCode); if (s.indexOf("require(") !== -1 || s.indexOf("module.exports") !== -1 || s.indexOf("exports.") !== -1) return "commonjs"; return "module"; }
  function writeCase(name, code){ const c = path.join(dir, name); fs.mkdirSync(c, { recursive: true }); fs.writeFileSync(path.join(c,"package.json"), JSON.stringify({ type: moduleType(code) })); fs.writeFileSync(path.join(c,${jsString(`submission.${extension}`)}), code); fs.writeFileSync(path.join(c,${jsString(`submission.test.${extension}`)}), testCode); return c; }
  // The reporter is PINNED. Node's default changed between versions (20 emits
  // TAP "# tests 1" when piped, 24 emits spec "i tests 1"), and a verdict that
  // depends on the host's Node build is not a verdict. The parser below still
  // accepts both, so a sandbox whose Node rejects the flag degrades to
  // "unverifiable → human audit" rather than to a wrong answer.
  function runCase(name, code){ const cwd = writeCase(name, code); const r = spawnSync(${jsString(runner)}, ${typeScript ? '["--test","--test-reporter=tap","submission.test.ts"]' : '["--test","--test-reporter=tap","submission.test.js"]'}, { cwd, encoding:"utf8", timeout:CHILD_TIMEOUT_MS, env:{ PATH: process.env.PATH || "" } }); return { status:r.status, stdout:r.stdout||"", stderr:r.stderr||"" }; }
  // A non-zero exit is NOT evidence that tests failed. \`node --test\` exits
  // non-zero for a SyntaxError, a missing module, an OOM kill or a timeout just
  // as readily as for a failing assertion — so inferring the broken-code
  // obligation from the exit code let an infrastructure fault MINT a passing,
  // execution-verified verdict on work that never demonstrated a bug. Read the
  // runner's own TAP summary instead, and treat "no parseable summary" as
  // unverifiable rather than as a failure we can bank on.
  // Accepts both reporter dialects: TAP ("# tests 1") and spec ("i tests 1",
  // where the marker is a non-ASCII info glyph). Anything else yields null =
  // unverifiable, which is the safe direction.
  function tapSummary(out){ const t = /^[^0-9a-zA-Z]*tests\\s+(\\d+)\\s*$/m.exec(out); const f = /^[^0-9a-zA-Z]*fail\\s+(\\d+)\\s*$/m.exec(out); return (t && f) ? { tests: Number(t[1]), fail: Number(f[1]) } : null; }
  const fixed = runCase("fixed", fixedCode);
  const broken = brokenCode ? runCase("broken", brokenCode) : null;
  const fixedTap = tapSummary(fixed.stdout + fixed.stderr);
  const brokenTap = broken ? tapSummary(broken.stdout + broken.stderr) : null;
  // true  = the broken variant ran its tests and at least one genuinely failed
  // false = the broken variant ran its tests and they all passed (invalid pair)
  // undefined = we could not tell → contract returns null → human audit
  // The summary alone is still not enough: \`node --test\` reports a file that
  // FAILED TO LOAD as one failing test, indistinguishable in the counts from a
  // genuine assertion failure. The diagnostics do distinguish them — a real
  // failure carries code ERR_ASSERTION (or the contributor's own thrown error),
  // a load fault carries MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND / a
  // SyntaxError, and a timeout carries failureType testTimeoutFailure.
  // Infrastructure and syntax faults are NOT evidence that a bug was
  // demonstrated, so they resolve to "unverifiable", never to "obligation met".
  // Matched against the run's whole output rather than per-test diagnostics: a
  // module that fails to load at the TOP of the test file takes the file down
  // before any test is attributed, so node reports it as a file-level TAP
  // comment with no per-test \`code:\` at all. Signature matching catches both
  // shapes. A contributor whose test legitimately asserts on one of these
  // strings is pushed to human audit — the safe direction.
  function infraFault(out){
    return /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM|ERR_INVALID_MODULE_SPECIFIER|SyntaxError|testTimeoutFailure|test timed out/.test(out);
  }
  function failedOnItsOwnLogic(out){ return !infraFault(out); }
  const brokenOut = broken ? broken.stdout + broken.stderr : "";
  const brokenCodeFailedTests = !broken ? undefined
    : (brokenTap && brokenTap.tests > 0 && brokenTap.fail > 0 && failedOnItsOwnLogic(brokenOut)) ? true
    : (brokenTap && brokenTap.tests > 0 && brokenTap.fail === 0) ? false
    : undefined;
  const brokenRunUnverifiable = !!broken && brokenCodeFailedTests === undefined;
  // A FIXED variant that failed to LOAD (missing module, syntax error, OOM,
  // timeout) rather than failing its tests is not the contributor's fix being
  // wrong — it's an infrastructure fault. Failing it here would burn a revision
  // on our problem. Flag it so the API routes to human audit instead. (A fixed
  // variant that loaded and genuinely failed its tests is still a real fail.)
  const fixedRunUnverifiable = fixed.status !== 0 && infraFault(fixed.stdout + fixed.stderr);
  const passed = fixed.status === 0 && (!broken || brokenCodeFailedTests === true);
  emit({ passed, score: passed?1:0, testsRun: fixedTap ? fixedTap.tests : 0, brokenCodeFailedTests, logs:["fixed:\\n"+fixed.stdout+fixed.stderr, broken?"broken:\\n"+broken.stdout+broken.stderr:""].filter(Boolean).join("\\n---\\n"), detail:{ runtime:"node:test", fixedExitCode:fixed.status, brokenExitCode: broken?broken.status:null, fixedTap, brokenTap, brokenRunUnverifiable, fixedRunUnverifiable } });`;
  return { script: makeScript(consts, body), parse: parseLastJson };
}

// --------------------------------------------------------------- python -----

/** Python harness (interpreted). Loads the solution namespace then runs the
 * tests — works whether tests import the solution or call it directly. */
export function buildPythonHarness(payload: JsonRecord): Harness | null {
  const tests = pickString(payload, TEST_KEYS);
  if (!tests) return null;
  const solutionCode = pickString(payload, SOLUTION_KEYS);
  const brokenCode = pickString(payload, BROKEN_KEYS);
  if (!solutionCode && !brokenCode) return null;

  const consts = [
    `const tests = ${jsString(tests)};`,
    `const solutionCode = ${jsString(solutionCode || brokenCode)};`,
    `const brokenCode = ${jsString(brokenCode)};`,
  ].join("\n");
  const body = `
  const fixed = verifyLang("python", solutionCode, tests);
  if (fixed.unavailable) { emit({ passed:false, score:null, runtimeUnavailable:true, logs:"python3 not available", detail:{ runtime:"python3" } }); return; }
  const broken = brokenCode ? verifyLang("python", brokenCode, tests) : null;
  // A broken variant that FAILED TO LOAD (missing module, SyntaxError, timeout)
  // is not proof it failed its TESTS — undefined → contract null → human audit,
  // never a satisfied broken-code obligation. Same guard as the node harness.
  const brokenCodeFailedTests = !broken ? undefined : (broken.ok ? false : (broken.infra ? undefined : true));
  const passed = fixed.ok && (!broken || brokenCodeFailedTests === true);
  // Fixed variant failed to LOAD, not its tests → infra fault → human audit,
  // not a failed submission (see the node harness for the rationale).
  emit({ passed, score: passed?1:0, testsRun:0, brokenCodeFailedTests, logs:["fixed:\\n"+(fixed.log||""), broken?"broken:\\n"+(broken.log||""):""].filter(Boolean).join("\\n---\\n"), detail:{ runtime:"python3", brokenRunUnverifiable: !!(broken && broken.infra), fixedRunUnverifiable: !!fixed.infra } });`;
  return { script: makeScript(consts, body, true), parse: parseLastJson };
}

// ------------------------------------------------------- compiled langs -----

/** Java/Go/Rust/C harness. Compiles (and runs/`go test` where possible) the
 * solution; for debugging shape the broken version must fail. */
export function buildCompiledHarness(payload: JsonRecord, lang: string): Harness | null {
  const solutionCode = pickString(payload, SOLUTION_KEYS);
  const brokenCode = pickString(payload, BROKEN_KEYS);
  const tests = pickString(payload, TEST_KEYS);
  if (!solutionCode && !brokenCode) return null;

  const consts = [
    `const lang = ${jsString(lang)};`,
    `const solutionCode = ${jsString(solutionCode || brokenCode)};`,
    `const brokenCode = ${jsString(brokenCode)};`,
    `const tests = ${jsString(tests)};`,
  ].join("\n");
  const body = `
  const fixed = verifyLang(lang, solutionCode, tests);
  if (fixed.unavailable) { emit({ passed:false, score:null, runtimeUnavailable:true, logs:(fixed.runtime||lang)+" not available in sandbox", detail:{ runtime: fixed.runtime||lang } }); return; }
  const broken = brokenCode ? verifyLang(lang, brokenCode, tests) : null;
  // A broken variant that failed to COMPILE / load / timed out did not run its
  // tests, so it cannot satisfy the broken-code obligation — undefined →
  // contract null → human audit. Only a compile-clean run that actually failed
  // its tests counts.
  const brokenCodeFailedTests = !broken ? undefined : (broken.ok ? false : (broken.infra ? undefined : true));
  const passed = fixed.ok && (!broken || brokenCodeFailedTests === true);
  // Fixed variant failed to COMPILE/load, not its tests → infra fault → human
  // audit, not a failed submission (see the node harness for the rationale).
  emit({ passed, score: passed?1:0, brokenCodeFailedTests, logs:["fixed:\\n"+(fixed.log||""), broken?"broken:\\n"+(broken.log||""):""].filter(Boolean).join("\\n---\\n"), detail:{ runtime: lang, brokenRunUnverifiable: !!(broken && broken.infra), fixedRunUnverifiable: !!fixed.infra } });`;
  return { script: makeScript(consts, body, true), parse: parseLastJson };
}

// --------------------------------------------------------------- sql --------

/** SQL harness via python's sqlite3 module (the sqlite3 CLI is not installed).
 * Builds the schema, runs the query, verifies it executes and (given an
 * expected shape) the column count matches. */
export function buildSqlHarness(payload: JsonRecord): Harness | null {
  const schema = pickString(payload, ["schema_definition", "schema", "table_schema", "ddl"]);
  const sql = pickString(payload, ["sql_query", "sql", "query", "solution_code"]);
  if (!sql) return null;
  const expected = pickString(payload, ["expected_output_shape", "expected_output", "expected_json_output"]);

  const consts = [
    `const schema = ${jsString(schema)};`,
    `const sql = ${jsString(sql)};`,
    `const expected = ${jsString(expected)};`,
  ].join("\n");
  const body = `
  if (!have("python3")) { emit({ passed:false, score:null, runtimeUnavailable:true, logs:"python3 not available", detail:{ runtime:"python3-sqlite3" } }); return; }
  fs.writeFileSync(path.join(dir,"schema.sql"), schema);
  fs.writeFileSync(path.join(dir,"query.sql"), sql);
  fs.writeFileSync(path.join(dir,"expected.json"), expected || "");
  const py = [
    "import sqlite3, json",
    "conn = sqlite3.connect(':memory:'); cur = conn.cursor()",
    "ok=True; err=None; cols=[]; rows=[]",
    "try:",
    "    schema=open('schema.sql').read().strip()",
    "    if schema: cur.executescript(schema)",
    "    cur.execute(open('query.sql').read())",
    "    cols=[d[0] for d in cur.description] if cur.description else []",
    "    rows=cur.fetchmany(50)",
    "except Exception as e:",
    "    ok=False; err=str(e)",
    "exp=None",
    "try:",
    "    t=open('expected.json').read().strip()",
    "    exp=json.loads(t) if t else None",
    "except Exception: exp=None",
    "shape_ok=True",
    "if isinstance(exp, dict) and isinstance(exp.get('columns'), list):",
    "    shape_ok = (len(cols)==len(exp['columns']))",
    "print(json.dumps({'ok':ok,'err':err,'cols':cols,'rowCount':len(rows),'shape_ok':shape_ok}))",
  ].join("\\n");
  fs.writeFileSync(path.join(dir,"sqlrun.py"), py);
  const r = run("python3", ["sqlrun.py"]);
  let res = null;
  const line = (r.stdout||"").trim().split("\\n").filter(Boolean).pop();
  try { res = JSON.parse(line); } catch {}
  // OUR wrapper failing to produce output is not the contributor's SQL being
  // wrong. python3 may exist while the sqlite3 module does not, the script can
  // be killed by CHILD_TIMEOUT_MS, the temp dir can be unwritable — all of
  // which used to collapse into \`passed:false\`, i.e. a real execution verdict
  // that failed the submission and burned one of its revision attempts. Report
  // it the way every other harness here reports a platform fault: unavailable,
  // which routes to human audit and costs nobody an attempt.
  if (!res) {
    emit({ passed:false, score:null, runtimeUnavailable:true, logs:(r.stdout||"")+(r.stderr?("\\n"+r.stderr):""), detail:{ runtime:"python3-sqlite3", reason:"sql wrapper produced no parseable output" } });
    return;
  }
  // Only now is a false a genuine verdict: the query really ran and errored,
  // or the result shape really did not match.
  const executed = !!res.ok;
  const shapeOk = !!res.shape_ok;
  const passed = executed && shapeOk;
  emit({ passed, score: passed?1:0, logs:(r.stdout||"")+(r.stderr?("\\n"+r.stderr):""), detail:{ runtime:"python3-sqlite3", executed, error: res.err, columns: res.cols, rowCount: res.rowCount, shapeMatched: shapeOk } });`;
  return { script: makeScript(consts, body), parse: parseLastJson };
}

// ---------------------------------------------------- code + expected out ---

/** Run a script, feed the raw input on stdin, compare stdout to the expected
 * output (data-extraction shape). */
export function buildExpectedOutputHarness(payload: JsonRecord, runtime: "python" | "node"): Harness | null {
  const code = pickString(payload, ["extraction_script", "solution_code", "script", "code"]);
  const expected = pickString(payload, ["expected_json_output", "expected_output", "expected"]);
  if (!code || !expected) return null;
  const input = pickString(payload, ["raw_input_data", "input", "input_context", "stdin"]);
  const cmd = runtime === "python" ? "python3" : "node";
  const file = runtime === "python" ? "script.py" : "script.js";

  const consts = [
    `const code = ${jsString(code)};`,
    `const expected = ${jsString(expected)};`,
    `const input = ${jsString(input)};`,
    `const cmd = ${jsString(cmd)};`,
    `const file = ${jsString(file)};`,
  ].join("\n");
  const body = `
  if (!have(cmd)) { emit({ passed:false, score:null, runtimeUnavailable:true, logs:cmd+" not available", detail:{ runtime:cmd } }); return; }
  fs.writeFileSync(path.join(dir, file), code);
  const r = run(cmd, [file], input);
  const norm = (s) => (s||"").replace(/\\s+/g, " ").trim();
  let match = norm(r.stdout) === norm(expected);
  if (!match) { try { match = JSON.stringify(JSON.parse(r.stdout)) === JSON.stringify(JSON.parse(expected)); } catch {} }
  const passed = r.status === 0 && match;
  emit({ passed, score: passed?1:0, logs:"stdout:\\n"+(r.stdout||"")+"\\nstderr:\\n"+(r.stderr||""), detail:{ runtime:cmd, exitCode:r.status, outputMatched: match } });`;
  return { script: makeScript(consts, body), parse: parseLastJson };
}

// --------------------------------------------------------- translation ------

/** Code-translation harness. Each side is COMPILED / type-checked in its own
 * language (python py_compile, node --check, java/go/rust/c/c++ compile) — this
 * catches genuinely broken translations. The `tests` are NOT executed here: in
 * real translation datasets they are written in ONE language's framework and
 * cannot be run against the other side, so behavioral equivalence is left to the
 * LLM review + human audit. A side whose runtime is missing → `unverifiable`;
 * passes when every checkable side is valid code. */
export function buildTranslationHarness(payload: JsonRecord, sourceLang: string, targetLang: string): Harness | null {
  const source = pickString(payload, ["source_code"]);
  const translated = pickString(payload, ["translated_code", "target_code"]);
  const sides = [
    { key: "source_code", code: source, lang: sourceLang },
    { key: "translated_code", code: translated, lang: targetLang },
  ].filter((s) => s.code);
  if (sides.length === 0) return null;

  const consts = [`const sides = ${JSON.stringify(sides)};`].join("\n");
  const body = `
  const results = []; const unverifiable = []; let ranAny = false; let allPass = true;
  for (const s of sides){
    const v = verifyLang(s.lang, s.code, "");   // compile/validity check, no cross-language tests
    if (v.unavailable){ unverifiable.push(s.key + " (" + (s.lang||v.runtime||"unknown") + ")"); continue; }
    ranAny = true; if (!v.ok) allPass = false;
    results.push({ side: s.key, lang: s.lang, valid: v.ok, log: (v.log||"").slice(0, 1500) });
  }
  if (!ranAny) { emit({ passed:false, score:null, runtimeUnavailable:true, unverifiable, logs:"no side checkable in this sandbox", detail:{ unverifiable, note:"tests deferred to LLM + human audit" } }); return; }
  emit({ passed: allPass, score: allPass?1:0, unverifiable, logs: results.map(r=>r.side+" ("+r.lang+"): "+(r.valid?"valid":"invalid")+"\\n"+r.log).join("\\n---\\n"), detail:{ method:"per-side compile/type-check", verifiedSides: results.map(r=>({ side:r.side, lang:r.lang, valid:r.valid })), unverifiable, note:"behavioral equivalence judged by LLM + human audit (cross-language tests not executed)" } });`;
  return { script: makeScript(consts, body, true), parse: parseLastJson };
}

// --------------------------------------------------------- selection --------

function fieldsOf(datasetType: Pick<DatasetType, "fields">): Array<{ key?: string; role?: string; lang?: string }> {
  return Array.isArray(datasetType.fields)
    ? (datasetType.fields as Array<{ key?: unknown; role?: unknown; lang?: unknown }>).map((f) => ({
        key: typeof f.key === "string" ? f.key : undefined,
        role: typeof f.role === "string" ? f.role : undefined,
        lang: typeof f.lang === "string" ? f.lang : undefined,
      }))
    : [];
}

function executionEnvOf(datasetType: Pick<DatasetType, "verification">): string {
  const v = datasetType.verification && typeof datasetType.verification === "object"
    ? (datasetType.verification as { executionEnv?: unknown })
    : {};
  return typeof v.executionEnv === "string" ? v.executionEnv : "";
}

/** Kept for the existing test + as the node-eligibility check. */
export function supportsNodeHarness(datasetType: Pick<DatasetType, "fields" | "verification">): boolean {
  const env = executionEnvOf(datasetType);
  if (!/\bnode(?::|\b)/i.test(env)) return false;
  const executableFields = fieldsOf(datasetType).filter((f) => ["input_code", "solution_code", "tests"].includes(f.role ?? ""));
  if (!executableFields.length) return false;
  const langs = executableFields.map((f) => (f.lang ?? "").trim().toLowerCase()).filter(Boolean);
  return langs.length > 0 && langs.every((l) => NODE_LANGS.has(l));
}

/** Kept for the existing test + as a config-time activation check: proves a
 * dataset type's execution stage has a supported all-Python harness path. */
export function supportsPythonHarness(datasetType: Pick<DatasetType, "fields" | "verification">): boolean {
  const env = executionEnvOf(datasetType);
  if (!/\bpython(?::|\b)/i.test(env)) return false;
  const executableFields = fieldsOf(datasetType).filter((f) => ["input_code", "solution_code", "tests"].includes(f.role ?? ""));
  if (!executableFields.length) return false;
  const langs = executableFields.map((f) => (f.lang ?? "").trim().toLowerCase()).filter(Boolean);
  return langs.length > 0 && langs.every((l) => PYTHON_LANGS.has(l));
}

/**
 * Pick a harness from the versioned dataset contract:
 * SQL → translation → code+tests (by language) → script+expected-output.
 * Returns null only when the contract has no executable shape at all.
 */
export function buildHarness(payload: JsonRecord, datasetType: Pick<DatasetType, "id" | "fields" | "verification">): Harness | null {
  return resolveHarness(payload, datasetType)?.harness ?? null;
}

/** Which resolution branch produced the verdict — stamped into execution
 * evidence so a trust claim is always traceable to the code that made it.
 *
 * SECURITY-RELEVANT: `service.ts` gates network egress on this being
 * `"registry"`, so a role-fallback harness can never inherit the network
 * access one of the three declared network categories is allowed, merely by
 * sharing its dataset-type id. */
export type HarnessProvenance = { harnessSource: "registry" } | { harnessSource: "role_fallback" };

/**
 * Resolve a harness from the versioned dataset contract, or null.
 *
 * V1's resolution order is: registry category harness (by dataset-type id) →
 * verified admin-bound `DatasetTypeHarness` row → role-based fallback → null.
 * TWO of those three are now ported, in V1's order:
 *
 *  · The REGISTRY branch reads `registry/` — the corpus of human-written,
 *    human-reviewed per-category harnesses, vendored into this app at
 *    `apps/api/registry/`. It is tried FIRST, exactly as in V1, so a category
 *    with a real harness is never verified by the generic fallback instead.
 *  · The ROLE-BASED FALLBACK is unchanged, and still answers for every contract
 *    the registry has no folder for (sponsor custom types, and forks until the
 *    catalog seeds `verification.harness`).
 *  · The BOUND branch (admin-authored `DatasetTypeHarness.source`) is still not
 *    ported — see registry-loader.ts's header for why. A dataset type whose
 *    only verifier would be a bound harness still resolves to null here.
 *
 * A null still fails in the SAFE direction: `service.ts` reports it as
 * `no_executable_harness` — an explicit "not attempted" that routes the item to
 * human review. Nothing is claimed as verified, and no substitute verifier is
 * invented.
 */
export function resolveHarness(
  payload: JsonRecord,
  datasetType: Pick<DatasetType, "id" | "fields" | "verification">
): { harness: Harness; provenance: HarnessProvenance } | null {
  const registry = buildCategoryHarness(payload, datasetType);
  if (registry) return { harness: registry, provenance: { harnessSource: "registry" } };
  const role = buildRoleHarness(payload, datasetType);
  return role ? { harness: role, provenance: { harnessSource: "role_fallback" } } : null;
}

/**
 * Canonical key each role's value is ALSO exposed under, so a builder that
 * reads by a fixed key list still finds a field the contract named differently.
 * The dispatcher below decides what to run from the ROLE; the builders read the
 * payload by KEY — so a contract with role `solution_code` on a field keyed
 * `formatting_code` (i18n) passed the activation gate but then resolved no
 * harness at runtime, a false-allow. Bridging role→canonical-key closes it.
 */
const ROLE_CANONICAL_KEY: Record<string, string> = {
  solution_code: "solution_code",
  input_code: "source_code",
  broken_code: "broken_code",
  tests: "tests",
  expected_output: "expected_output",
};

function normalizeByRole(payload: JsonRecord, fields: Array<{ key?: string; role?: string }>): JsonRecord {
  const out: JsonRecord = { ...payload };
  for (const f of fields) {
    const canonical = f.role ? ROLE_CANONICAL_KEY[f.role] : undefined;
    if (!canonical || !f.key || f.key === canonical) continue;
    // Only fill the canonical key if the contract didn't already provide it —
    // never clobber a value the contract set under the canonical name.
    if (typeof out[canonical] !== "string" && typeof payload[f.key] === "string") {
      out[canonical] = payload[f.key];
    }
  }
  return out;
}

function buildRoleHarness(payloadRaw: JsonRecord, datasetType: Pick<DatasetType, "id" | "fields" | "verification">): Harness | null {
  const fields = fieldsOf(datasetType);
  const payload = normalizeByRole(payloadRaw, fields);
  const env = executionEnvOf(datasetType).toLowerCase();
  const hasRole = (role: string) => fields.some((f) => f.role === role);
  const langOfRole = (role: string) => (fields.find((f) => f.role === role)?.lang ?? "").toLowerCase();

  const solutionLang = langOfRole("solution_code");
  // 1) SQL
  if (solutionLang === "sql" || /\b(sqlite|postgres|postgresql|sql)\b/.test(env)) {
    return buildSqlHarness(payload);
  }

  // 2) Translation (distinct source/target languages)
  const hasTranslation =
    (typeof payload.source_code === "string" && typeof payload.translated_code === "string") ||
    (typeof payload.source_language === "string" && typeof payload.target_language === "string");
  if (hasTranslation) {
    const sourceLang = (typeof payload.source_language === "string" ? payload.source_language : "") || langOfRole("input_code");
    const targetLang = (typeof payload.target_language === "string" ? payload.target_language : "") || langOfRole("solution_code");
    const h = buildTranslationHarness(payload, sourceLang, targetLang);
    if (h) return h;
  }

  // 3) Code + tests, dispatched by the solution/input language.
  if (hasRole("tests")) {
    const lang =
      solutionLang ||
      langOfRole("input_code") ||
      (/(^|\W)python(:|\b)/.test(env) ? "python" : /(^|\W)node(:|\b)/.test(env) ? "node" : /(^|\W)go(:|\b)/.test(env) ? "go" : "");
    const rt = runtimeForLang(lang);
    if (rt === "node") return buildNodeHarness(payload, lang);
    if (rt === "python") return buildPythonHarness(payload);
    if (rt === "compiled") return buildCompiledHarness(payload, lang);
    return null;
  }

  // 4) Script + expected output
  if (hasRole("expected_output") && hasRole("solution_code")) {
    const rt = runtimeForLang(solutionLang);
    if (rt === "python" || rt === "node") return buildExpectedOutputHarness(payload, rt);
  }

  return null;
}
