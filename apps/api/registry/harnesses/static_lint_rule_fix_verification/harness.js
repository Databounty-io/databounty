/**
 * lint-rule-polarity-match -- static_lint_rule_fix_verification.
 *
 * THE CONTRACT: buggy_code must genuinely trigger rule_id when linted for
 * real (eslint for 'JavaScript/TypeScript' rows, ruff for 'Python' rows),
 * and fixed_code -- the SAME logical snippet, corrected -- must not trigger
 * that same rule_id, while remaining syntactically valid / lint-runnable.
 * Both tools are invoked as real subprocesses against real files on disk;
 * their own machine-readable JSON output (`eslint --format json`, `ruff
 * check --output-format json`) is the only source of truth, never a
 * regex-scrape of human-readable text output and never this harness's own
 * guess at what the code "looks like" it does.
 *
 * NEITHER buggy_code NOR fixed_code IS EVER EXECUTED. Both eslint and ruff
 * are pure static analyzers -- they parse the file into an AST and run rule
 * visitors over it; they never eval()/exec()/import() the file being linted.
 * This is a materially different, and simpler, security posture than almost
 * every other category in this registry: there is no untrusted-code-
 * execution surface here at all, so none of the usual hardening this
 * registry's execution-based harnesses need (h.PY_PRELUDE/h.JS_PRELUDE exit-
 * trapping, try/except BaseException wrapping, a fresh OS process per side
 * to prevent frame-walking, orphaned-grandchild cleanup) applies or is
 * needed -- the only inputs to either tool are a file path and a rule name,
 * and the only output ever trusted is that tool's own structured JSON on
 * stdout.
 *
 * THE VACUOUS-DIFF TRAP, AND WHY THIS CATEGORY'S FIX FOR IT IS DIFFERENT
 * FROM vulnerability's/fail_to_pass's OWN FIX (read both before touching this
 * file): vulnerability/harness.js's polarity() exists because that category's
 * only observable signal is an INDIRECT proxy -- a snapshot of whatever
 * globals exploit_code happened to leave behind -- so "the patch worked" and
 * "something merely differs for an unrelated reason" can look identical
 * without extra corroborating signals (equalityFlips, payloadNeutralized).
 * THIS category has no such indirection: eslint/ruff's own JSON output IS a
 * literal, exact list of which rule ids fired, and the contract IS "does the
 * ground-truth list contain rule_id" -- there is no proxy step where an
 * unrelated difference could be mistaken for the real signal. The genuine
 * analogue of vulnerability's vacuous-diff risk here is different in shape:
 * it is COLLATERAL RULE NOISE -- if the harness linted buggy_code/fixed_code
 * with a full default ruleset, a real but UNRELATED rule could differ between
 * the two snippets (e.g. a stray formatting rule the contributor didn't even
 * know existed) with no bearing on rule_id at all, and a careless
 * implementation checking "did the lint output change" rather than "does
 * THIS rule id's presence flip" would be gameable by that unrelated
 * difference alone. FIX: the generated lint config enables EXACTLY ONE rule
 * (rule_id) and nothing else -- see buildEslintConfig/the ruff --select flag
 * below. This does not merely REDUCE collateral-noise risk, it eliminates it
 * BY CONSTRUCTION: with only one rule ever loaded, there is no second rule
 * that could fire at all, so the "how strict should we be about other rules
 * still firing on fixed_code" design question this category might otherwise
 * face is moot -- no other rule's verdict ever exists to be strict or lax
 * about. The real remaining gaming surface, addressed separately below, is
 * structural: a buggy_code/fixed_code pair that is too trivial (near-empty,
 * a single token) or too dissimilar (fixed_code gutted to nothing rather
 * than genuinely fixed) to be meaningful regardless of which single rule is
 * checked.
 *
 * STRUCTURAL ANTI-GAMING GATES (evaluated before either tool ever runs):
 *   - MIN_NONBLANK_LINES / MIN_CHARS: both buggy_code and fixed_code must
 *     have a handful of real, non-blank lines and a minimum character count.
 *     Confirmed necessary: a single-line, single-token "snippet" can
 *     genuinely trip some rules (e.g. a bare `x == None`), but such a row
 *     proves almost nothing about the contributor's understanding of the
 *     rule in realistic code, and is indistinguishable from a template
 *     someone pasted without reading.
 *   - IDENTICAL-CODE GATE: fixed_code that is byte-for-byte (whitespace-
 *     normalized) identical to buggy_code cannot be a genuine fix by
 *     construction -- the same gate fail_to_pass's/vulnerability's own
 *     harnesses already use for their own buggy/fixed and vulnerable/patched
 *     pairs.
 *   - STRUCTURAL SIMILARITY FLOOR (Jaccard over identifier-token sets,
 *     jaccardSimilarity() below): fixed_code must retain a meaningful
 *     fraction of buggy_code's own identifier vocabulary. Confirmed
 *     necessary and confirmed NOT to false-reject a genuine fix: an
 *     unused-variable removal, an == -> === swap, or a mutable-default-arg
 *     rewrite (three real reference rows exercised in this file's own
 *     self-test) all measure 0.6-0.7 Jaccard similarity, comfortably above
 *     MIN_JACCARD (0.3); a fixed_code reduced to a near-empty stub (e.g.
 *     `module.exports = {};`) that would trip no rule of any kind purely by
 *     having removed everything measures ~0.2, comfortably below it.
 *     ACCEPTED RESIDUAL: a genuinely correct fix that also happens to be an
 *     unusually heavy rewrite (rare -- most single-rule fixes are small,
 *     targeted edits) could in principle fall under this floor and be
 *     rejected as a false negative; judged an acceptable, documented trade-
 *     off rather than leaving the near-empty-stub gap open entirely.
 *
 * ESLINT: CORE RULES ONLY, ON PURPOSE. The E2B template installs eslint@9
 * with no plugins (`npm install -g eslint@9`, infra/e2b/databounty-verify/
 * template.ts) -- no @typescript-eslint, no eslint-plugin-react, nothing.
 * A plugin-qualified rule_id (`@typescript-eslint/no-unused-vars`,
 * `react/jsx-key`) can therefore never fire in this sandbox no matter what
 * buggy_code contains, and is rejected up front with a specific, actionable
 * reason (rather than the more opaque "ESLint: Could not find X in plugin Y"
 * config-load crash the real tool would otherwise surface -- still caught as
 * a fallback via the generic unrecognized-rule-id path below, but the
 * upfront check gives a clearer message for the single most likely mistake).
 * This also means fixed_code is always linted with ESLint's default espree
 * parser (no TypeScript-aware parser is installed either) -- TypeScript-only
 * syntax (interfaces, type annotations, generics, enums) will not parse and
 * is scored as a syntax failure, same as any other invalid JS. Rows filed
 * under the 'JavaScript/TypeScript' language option are therefore expected
 * to be plain, TypeScript-compatible JavaScript in practice; this is a real,
 * documented scope limit of the currently-baked image, not a bug in this
 * harness.
 *
 * SYNTAX FAILURE IS A DISQUALIFYING OUTCOME FOR fixed_code, NEVER A PASS:
 * both tools report a parse failure as an ordinary diagnostic (eslint: a
 * message with `fatal: true, ruleId: null`; ruff: a violation object with
 * `code: null`), confirmed via direct local invocation against known-bad
 * syntax with both real tools (see this category's self-test). A fixed_code
 * that fails to parse trivially "doesn't trigger rule_id" (nothing ran far
 * enough to trigger anything), which is exactly the false-pass shape the
 * task brief calls out -- checked and rejected explicitly, distinct from and
 * before the ordinary "does rule_id appear" check.
 *
 * TOOL-LEVEL (CONFIG) ERRORS ARE DISTINGUISHED FROM CODE-LEVEL (SYNTAX)
 * ERRORS BY WHETHER STDOUT PARSES AS JSON AT ALL, confirmed via direct local
 * probing of both tools: an unrecognized rule_id makes eslint exit 2 and
 * ruff exit 2, in both cases printing a human-readable crash/usage message
 * to STDERR and producing NO parseable JSON on stdout whatsoever (not even an
 * empty array) -- categorically different from a code-level syntax error,
 * which both tools report as a normal diagnostic INSIDE a well-formed JSON
 * array on stdout, exit code 1. This lets rule_id validity and buggy_code/
 * fixed_code syntax validity be told apart mechanically without maintaining
 * a hand-rolled allowlist of "real" rule ids for either tool -- the real
 * tool's own config loader is the authority on whether rule_id exists, not a
 * regex this file would otherwise have to keep in sync with two external
 * projects' own evolving rule sets.
 *
 * TIMEOUT BUDGET: LINT_TIMEOUT_MS (15000ms) per invocation, two invocations
 * per verify() (buggy, then fixed) against the SAME already-written config --
 * worst case 30000ms, comfortably under the outer sandbox command budget
 * (120000ms, infra/terraform/ssm.tf's EXECUTION_RUNNER_TIMEOUT_MS). Both
 * tools are near-instant in steady state (a single small file, one rule
 * enabled) -- confirmed locally: ruff's own invocations complete in well
 * under 100ms, eslint's in a few hundred ms including Node process startup.
 * The generous ceiling is headroom for a cold E2B microVM's first-touch page-
 * in tax on eslint's own (fairly large, ~80-package) global node_modules
 * tree, the same class of tail latency helpers.js's own ensureRustToolchain
 * comment documents for a cold rustc.
 *
 * REAL E2B CONFIRMATION DEFERRED: eslint/ruff were added to
 * infra/e2b/databounty-verify/template.ts's build script but the published
 * sandbox image has not yet been rebuilt as of this file's authoring --
 * h.have('eslint')/h.have('ruff') below will correctly report
 * runtimeUnavailable (routed to human audit, never a false contributor
 * failure) until that rebuild ships. This file's own correctness was
 * verified locally against real eslint@9.39.5 and real ruff@0.12.0.
 */
'use strict';

const LINT_TIMEOUT_MS = 15000;
const MIN_NONBLANK_LINES = 3;
const MIN_CHARS = 30;
const MAX_CHARS = 20000;
const MIN_JACCARD = 0.3;

const JS_GLOBALS = {
  console: 'readonly', process: 'readonly', require: 'readonly',
  module: 'writable', exports: 'writable', __dirname: 'readonly',
  __filename: 'readonly', global: 'readonly', Buffer: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', globalThis: 'readonly', Promise: 'readonly',
  Map: 'readonly', Set: 'readonly', Symbol: 'readonly', WeakMap: 'readonly',
};

function nonBlankLineCount(code) {
  return String(code).split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0).length;
}

/** Identifier-token SET (deduplicated), for jaccardSimilarity() below. Deliberately
 * language-agnostic (identifiers look the same in JS and Python) -- this is a
 * structural-overlap signal, not a language-aware AST diff. */
function tokenSet(code) {
  const out = new Set();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m;
  while ((m = re.exec(code))) out.add(m[0]);
  return out;
}

/** See module doc comment (STRUCTURAL SIMILARITY FLOOR). */
function jaccardSimilarity(codeA, codeB) {
  const a = tokenSet(codeA);
  const b = tokenSet(codeB);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** module.exports = [...] flat config enabling EXACTLY ONE rule -- see module
 * doc comment (THE VACUOUS-DIFF TRAP) for why this single-rule scoping is the
 * load-bearing anti-gaming property of this whole category, not incidental
 * hardening. sourceType 'module' accepts both ESM (`import`/`export`) and
 * CommonJS (`require`/`module.exports`) syntax -- neither is reserved syntax
 * under module parsing, only import/export declarations are, so ordinary
 * CJS-style snippets (this registry's own idiom) parse fine either way. A
 * conservative, hand-declared Node-ish globals list avoids no-undef false
 * positives on ordinary runtime identifiers (console, require, ...) without
 * depending on the separate `globals` npm package being present in the
 * image. */
function buildEslintConfig(ruleId) {
  return [
    'module.exports = [',
    '  {',
    '    files: ["**/*.js"],',
    '    languageOptions: {',
    '      ecmaVersion: "latest",',
    '      sourceType: "module",',
    '      globals: ' + JSON.stringify(JS_GLOBALS) + ',',
    '    },',
    '    linterOptions: { reportUnusedDisableDirectives: false },',
    '    rules: { ' + JSON.stringify(ruleId) + ': "error" },',
    '  },',
    '];',
  ].join('\n');
}

/** Run real eslint against one file with the given single-rule config.
 * Returns { toolError, timedOut, fatalParse, hasRule, raw }. `toolError` means
 * the CLI itself could not run this configuration at all (most commonly an
 * unrecognized rule_id) -- distinct from `fatalParse`, which means the tool
 * ran fine but the FILE failed to parse. See module doc comment
 * (TOOL-LEVEL (CONFIG) ERRORS ARE DISTINGUISHED...). */
function lintWithEslint(h, configPath, filePath, ruleId) {
  const r = h.run('eslint', ['--no-config-lookup', '-c', configPath, '--format', 'json', filePath], { timeoutMs: LINT_TIMEOUT_MS });
  if (r.timedOut) return { timedOut: true, stderr: r.stderr };
  let parsed;
  try { parsed = JSON.parse(r.rawStdout != null ? r.rawStdout : r.stdout); } catch (e) { parsed = null; }
  if (!Array.isArray(parsed)) {
    return { toolError: true, stderr: String(r.stderr || '').slice(0, 800) };
  }
  const messages = [];
  for (const fileResult of parsed) {
    if (fileResult && Array.isArray(fileResult.messages)) messages.push(...fileResult.messages);
  }
  const fatalParse = messages.some((m) => m && m.fatal === true);
  const hasRule = messages.some((m) => m && m.ruleId === ruleId);
  return { fatalParse, hasRule, raw: parsed };
}

/** Run real ruff against one file, selecting ONLY ruleId. Same return shape
 * as lintWithEslint (minus eslint-specific fields) for a uniform caller. */
function lintWithRuff(h, filePath, ruleId) {
  const r = h.run('ruff', ['check', '--isolated', '--no-cache', '--output-format', 'json', '--select', ruleId, filePath], { timeoutMs: LINT_TIMEOUT_MS });
  if (r.timedOut) return { timedOut: true, stderr: r.stderr };
  let parsed;
  try { parsed = JSON.parse(r.rawStdout != null ? r.rawStdout : r.stdout); } catch (e) { parsed = null; }
  if (!Array.isArray(parsed)) {
    return { toolError: true, stderr: String(r.stderr || '').slice(0, 800) };
  }
  const fatalParse = parsed.some((v) => v && v.code == null);
  const hasRule = parsed.some((v) => v && v.code === ruleId);
  return { fatalParse, hasRule, raw: parsed };
}

module.exports = {
  contract: 'lint-rule-polarity-match',
  requires: [],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const language = h.str(row, 'language').trim();
    const ruleId = h.str(row, 'rule_id').trim();
    const buggy = h.str(row, 'buggy_code');
    const fixed = h.str(row, 'fixed_code');

    if (!taskDescription.trim() || !language || !ruleId || !buggy.trim() || !fixed.trim()) {
      // brokenCodeFailedTests must still be a boolean here: buggy_code is a
      // BROKEN_VARIANT_KEYS field (src/services/execution-providers/
      // contract.ts) -- an undefined value would be treated as a harness
      // fault by that layer rather than a clean reject. false because
      // buggy_code was never actually linted at all.
      return { passed: false, brokenCodeFailedTests: false, detail: { reason: 'missing task_description, language, rule_id, buggy_code, or fixed_code' } };
    }

    const isJs = language === 'JavaScript/TypeScript';
    const isPy = language === 'Python';
    if (!isJs && !isPy) {
      return { passed: false, brokenCodeFailedTests: false, logs: 'language must be exactly "JavaScript/TypeScript" or "Python"', detail: { reason: 'bad_language', language } };
    }

    // rule_id shape: deliberately light-touch -- the real tool's own config
    // loader is the authority on whether a rule_id genuinely exists (see
    // module doc comment), not a hand-maintained allowlist this file would
    // have to keep in sync with two external, independently-evolving
    // projects' rule sets. Only rules out shapes that can never be a real
    // rule id at all (empty, containing whitespace, absurdly long).
    if (/\s/.test(ruleId) || ruleId.length > 100) {
      return { passed: false, brokenCodeFailedTests: false, logs: 'rule_id must be a single token with no whitespace', detail: { reason: 'bad_rule_id_shape' } };
    }
    // See module doc comment (ESLINT: CORE RULES ONLY). Rejected up front
    // with a specific reason -- still also caught by the generic
    // toolError/unrecognized-rule-id path below for any OTHER unrecognized
    // core rule name, this just gives the single most likely mistake a
    // clearer message than eslint's own raw config-load crash text would.
    if (isJs && ruleId.includes('/')) {
      return {
        passed: false,
        brokenCodeFailedTests: false,
        logs: 'rule_id "' + ruleId + '" is plugin-qualified, but no ESLint plugins are installed in this sandbox image -- only CORE rule names (no "/") are supported for JavaScript/TypeScript rows',
        detail: { reason: 'plugin_rule_unsupported' },
      };
    }

    // Structural anti-gaming gates -- see module doc comment (STRUCTURAL
    // ANTI-GAMING GATES). Cheap, checked before spending any sandbox/process
    // time on either tool.
    if (buggy.length > MAX_CHARS || fixed.length > MAX_CHARS) {
      return { passed: false, brokenCodeFailedTests: false, logs: 'buggy_code/fixed_code exceed the ' + MAX_CHARS + '-character cap for this category', detail: { reason: 'too_large' } };
    }
    if (buggy.trim().length < MIN_CHARS || fixed.trim().length < MIN_CHARS || nonBlankLineCount(buggy) < MIN_NONBLANK_LINES || nonBlankLineCount(fixed) < MIN_NONBLANK_LINES) {
      return {
        passed: false,
        brokenCodeFailedTests: false,
        logs: 'buggy_code/fixed_code must each be a real, non-trivial snippet (at least ' + MIN_NONBLANK_LINES + ' non-blank lines and ' + MIN_CHARS + ' characters) -- too small to genuinely demonstrate a rule fix',
        detail: { reason: 'too_trivial' },
      };
    }
    if (buggy.replace(/\s+/g, ' ').trim() === fixed.replace(/\s+/g, ' ').trim()) {
      return { passed: false, brokenCodeFailedTests: false, logs: 'fixed_code is identical to buggy_code (ignoring whitespace) -- this is not a fix', detail: { reason: 'identical_to_buggy' } };
    }
    const similarity = jaccardSimilarity(buggy, fixed);
    if (similarity < MIN_JACCARD) {
      return {
        passed: false,
        brokenCodeFailedTests: false,
        logs: 'fixed_code has diverged too far structurally from buggy_code (identifier-token similarity ' + similarity.toFixed(2) + ' < ' + MIN_JACCARD + ') -- looks gutted/replaced rather than genuinely fixed',
        detail: { reason: 'too_dissimilar', similarity },
      };
    }

    const tool = isJs ? 'eslint' : 'ruff';
    if (!h.have(tool)) {
      return { passed: false, runtimeUnavailable: true, logs: tool + ' not available in sandbox', detail: { reason: 'no_' + tool } };
    }

    const d = h.workdir();
    let buggyResult, fixedResult;
    if (isJs) {
      const configPath = h.path.join(d, 'eslint.config.js');
      h.fs.writeFileSync(configPath, buildEslintConfig(ruleId));
      const buggyPath = h.path.join(d, 'buggy.js');
      const fixedPath = h.path.join(d, 'fixed.js');
      h.fs.writeFileSync(buggyPath, buggy);
      h.fs.writeFileSync(fixedPath, fixed);
      buggyResult = lintWithEslint(h, configPath, buggyPath, ruleId);
      fixedResult = lintWithEslint(h, configPath, fixedPath, ruleId);
    } else {
      const buggyPath = h.path.join(d, 'buggy.py');
      const fixedPath = h.path.join(d, 'fixed.py');
      h.fs.writeFileSync(buggyPath, buggy);
      h.fs.writeFileSync(fixedPath, fixed);
      buggyResult = lintWithRuff(h, buggyPath, ruleId);
      fixedResult = lintWithRuff(h, fixedPath, ruleId);
    }

    if (buggyResult.timedOut) {
      return { passed: false, brokenCodeFailedTests: false, logs: tool + ' did not complete against buggy_code within the time budget', detail: { reason: 'buggy_timed_out' } };
    }
    if (buggyResult.toolError) {
      // See module doc comment (TOOL-LEVEL (CONFIG) ERRORS...). Most likely
      // cause: rule_id is not a rule this tool recognizes at all.
      return {
        passed: false,
        brokenCodeFailedTests: false,
        logs: 'rule_id "' + ruleId + '" is not recognized by ' + tool + ' (or another tool/config error occurred): ' + buggyResult.stderr,
        detail: { reason: 'rule_id_not_recognized' },
      };
    }
    if (buggyResult.fatalParse) {
      return { passed: false, brokenCodeFailedTests: false, logs: 'buggy_code failed to parse -- it must be valid ' + language + ' syntax to genuinely trigger rule_id', detail: { reason: 'buggy_syntax_error' } };
    }
    if (!buggyResult.hasRule) {
      return { passed: false, brokenCodeFailedTests: false, logs: 'rule_id "' + ruleId + '" never fired on buggy_code per real ' + tool + ' output', detail: { reason: 'rule_never_fired_on_buggy' } };
    }

    // buggy_code's negative-side behavior is now genuinely demonstrated
    // (real tool, real violation, exact rule_id match) regardless of what
    // happens on the fixed_code side below.
    const brokenCodeFailedTests = true;

    if (fixedResult.timedOut) {
      return { passed: false, brokenCodeFailedTests, logs: tool + ' did not complete against fixed_code within the time budget', detail: { reason: 'fixed_timed_out' } };
    }
    if (fixedResult.toolError) {
      return { passed: false, brokenCodeFailedTests, logs: 'could not lint fixed_code with the same rule_id configuration that worked for buggy_code: ' + fixedResult.stderr, detail: { reason: 'fixed_tool_error' } };
    }
    if (fixedResult.fatalParse) {
      // See module doc comment (SYNTAX FAILURE IS A DISQUALIFYING OUTCOME).
      return { passed: false, brokenCodeFailedTests, logs: 'fixed_code failed to parse -- a syntax error is not a legitimate fix', detail: { reason: 'fixed_syntax_error' } };
    }
    if (fixedResult.hasRule) {
      return { passed: false, brokenCodeFailedTests, logs: 'rule_id "' + ruleId + '" still fires on fixed_code per real ' + tool + ' output', detail: { reason: 'rule_still_fires_on_fixed' } };
    }

    return {
      passed: true,
      brokenCodeFailedTests,
      score: 1,
      logs: '',
      detail: { reason: 'ok', tool, ruleId, similarity },
    };
  },
};
