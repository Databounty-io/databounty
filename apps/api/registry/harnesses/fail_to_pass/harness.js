/**
 * fail-then-pass — the contributor's generated_test must FAIL against the
 * buggy code and PASS against the fixed code. That differential is the only
 * mechanical evidence a generated test actually exercises the bug rather than
 * being a vacuous no-op that passes against anything — EXCEPT the
 * differential alone can't tell "the test caught a real bug" apart from "the
 * buggy side crashed for an unrelated reason (e.g. a syntax error) while a
 * completely vacuous test (`assert True`) happened to pass on the fixed
 * side." `testsReferenceCode` closes the concrete version of that gap: a
 * generated_test that never names anything fixed_code actually defines
 * cannot have exercised it, whatever the differential says.
 *
 * `testsReferenceCode` is a purely TEXTUAL check, though -- it proves the
 * name appears as a call site somewhere in generated_test, never that the
 * call site is actually reachable or that anything is asserted about its
 * result. Confirmed exploitable two ways without a further check: (1) a
 * dead-code call the real control flow never reaches (`if (false) {
 * Solution.add(1, 2); }`, satisfying testsReferenceCode textually while
 * never executing), paired with an UNRELATED buggy-side compile/runtime
 * failure to manufacture the differential; (2) a live, reachable call whose
 * result is never checked at all (`try { solve(1, 2) } catch (e) {}`),
 * paired with the same kind of unrelated buggy-side failure. Neither
 * scenario requires the buggy/fixed pair to be adversarially crafted --
 * both are plausible shapes for a lazy or careless generated_test to take
 * on real, ordinary data. `testsHaveRealAssertion` closes both at once:
 * whether or not the referenced call site is reachable, generated_test must
 * ALSO contain a recognizable assertion construct somewhere (a real
 * comparison the test can actually fail on), which neither vacuous shape
 * above provides.
 *
 * No `language` field on this dataset — language is inferred from code shape
 * (h.inferLang) and dispatched through the shared polyglot runner
 * (h.runWithTests), which also carries the per-language false-pass traps
 * already fixed at the catrun stage: JVM assertions off by default,
 * console.assert not throwing, Go/Rust/C/C++ tests needing an entrypoint.
 */
'use strict';

// Java/C#/C++ method signatures use none of def/function/fn/func/class --
// they're bare "NAME(args) {" with no declaring keyword at all, so an
// unextended definedNames() returns an EMPTY set for every method in this
// dataset's own Java/C#/C++ rows, which used to silently disable the whole
// gate (see the removed `size === 0` bypass below). Excluded so control-flow
// keywords that share the same "NAME(...) {" shape (if/for/while/...) are
// never mistaken for a defined name.
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'do', 'try', 'finally']);

/** Top-level def/function/fn/func/class/lambda/arrow/method names, across
 * every language this dataset's h.inferLang can select. */
function definedNames(code) {
  const out = new Set();
  const pats = [
    /\bdef\s+([A-Za-z_]\w*)/g,
    /\bfunction\s+([A-Za-z_]\w*)/g,
    /\bfn\s+([A-Za-z_]\w*)/g,
    /\bfunc\s+([A-Za-z_]\w*)/g,
    /\bclass\s+([A-Za-z_]\w*)/g,
    /(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:\(|function|async|[A-Za-z_]\w*\s*=>)/g,
    // Python lambda assignment: NAME = lambda ...
    /\b([A-Za-z_]\w*)\s*=\s*lambda\b/g,
    // Bare C-style function/method declaration (Java/C#/C++): NAME(args) {
    /\b([A-Za-z_]\w*)\s*\([^()]*\)\s*\{/g,
  ];
  for (const p of pats) {
    let m;
    while ((m = p.exec(code))) {
      if (!CONTROL_KEYWORDS.has(m[1])) out.add(m[1]);
    }
  }
  return out;
}

// C/C++ preprocessor directives are preserved verbatim -- a bare '#' is a
// line comment in Ruby/Python/etc but '#include'/'#define'/... in C/C++, and
// this dataset's C++ rows can legitimately have one in generated_test.
const CPP_DIRECTIVE_RE = /^\s*#\s*(include|define|ifdef|ifndef|endif|pragma|if|else|elif|undef|error)\b/;

// A recognizable assertion construct, across every language h.inferLang can
// select for this dataset -- Python's bare `assert expr` keyword form (no
// trailing paren required), assert()/assertEqual()/assertEquals()/
// assert_eq!/ASSERT_EQ()/EXPECT_EQ() call forms, C#'s Assert.AreEqual(-style
// static-class form, Jest/Chai's expect(...).to.../....should..., Go's
// t.Error/t.Errorf/t.Fatal/t.Fatalf/t.Fail convention, Ruby's idiomatic
// frameworkless `raise "msg" unless condition`/`fail "msg" unless
// condition` (and the equivalent `if not condition: raise ...` ordering),
// and Go/Rust's conditional-`panic!`/`panic(...)` idiom (`if check(...) !=
// expected { panic("...") }`) -- confirmed real, non-adversarial patterns in
// this dataset's own generated_test rows (a Ruby `raise ... unless` row, and
// NINE consecutive Go rows using this exact if/panic shape), and missing
// either initially false-rejected genuinely-correct, real-assertion rows as
// "vacuous". Deliberately broad (case-insensitive, tolerant of underscores)
// since this is an ADDITIONAL signal alongside testsReferenceCode, not a
// replacement for it -- the goal is to rule out a test with NO recognizable
// assertion anywhere, not to validate assertion syntax precisely.
const ASSERTION_RE = /\bassert\b\s|\bassert\w*\s*[!(.]|\bASSERT_\w+\s*\(|\bEXPECT_\w+\s*\(|\bexpect\s*\([^)]*\)\s*\.\s*to\b|\.\s*should\b|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail)\b|\b(?:raise|fail|panic)\b\s*!?[\s\S]{0,80}?\b(?:unless|if)\b|\bif\b[\s\S]{0,80}?\b(?:raise|throw|fail|panic)\s*!?\s*\(/i;

/** Blank out comment text and string-literal CONTENTS (quote-aware), so a
 * name match below can't be satisfied by a name that only appears in a
 * comment or inside a string literal -- neither is evidence the test
 * actually calls anything. */
function stripCommentsAndStrings(code) {
  return String(code)
    .split('\n')
    .map((line) => {
      if (CPP_DIRECTIVE_RE.test(line)) return line;
      let out = '';
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote && line[i - 1] !== '\\') quote = null;
          out += ' ';
          continue;
        }
        if (c === "'" || c === '"' || c === '`') { quote = c; out += ' '; continue; }
        if (c === '#') break;
        if (c === '/' && line[i + 1] === '/') break;
        out += c;
      }
      return out;
    })
    .join('\n');
}

module.exports = {
  contract: 'fail-then-pass',
  requires: [],

  verify(row, h) {
    const buggy = h.str(row, 'buggy_code');
    const fixed = h.str(row, 'fixed_code');
    const tests = h.str(row, 'generated_test');
    if (!buggy || !fixed || !tests) {
      // brokenCodeFailedTests must still be a boolean here, not omitted: the
      // schema declares a `buggy_code` field, so the contract layer
      // (executionContractPassed in src/services/execution-providers/contract.ts)
      // treats an undefined value as a harness fault ("harness omitted the
      // required broken-code assertion") rather than a clean reject. false
      // because buggy_code was never run against generated_test at all.
      return { passed: false, brokenCodeFailedTests: false, detail: { reason: 'missing buggy_code, fixed_code, or generated_test' } };
    }

    const definedInFixed = definedNames(fixed);
    // An empty set used to auto-pass this gate (silently disabling it for
    // any code shape definedNames didn't recognize -- a Python lambda
    // assignment or bare-arrow-param function, both ordinary, not exotic).
    // An empty set means the check literally cannot verify anything, which
    // is not evidence the test is fine -- route to manual review instead.
    // Requiring an actual call site (name + '(', not a bare name anywhere in
    // the raw text) and stripping comments/strings first closes the
    // complementary gap: a name mentioned only in a comment or a string
    // literal is not evidence the test calls anything either.
    const testsForCheck = stripCommentsAndStrings(tests);
    const testsReferenceCode = definedInFixed.size > 0 && [...definedInFixed].some((name) => new RegExp('\\b' + name + '\\s*\\(').test(testsForCheck));
    if (!testsReferenceCode) {
      if (definedInFixed.size === 0) {
        // runtimeUnavailable:true -- environment/analysis fault (this file's
        // own name-detection couldn't recognize anything in fixed_code's
        // shape), not a contributor defect. brokenCodeFailedTests
        // deliberately omitted here, matching debugging/harness.js's own
        // runtimeUnavailable paths: the field is only required for genuine
        // pass/fail verdicts.
        return {
          passed: false,
          runtimeUnavailable: true,
          logs: 'could not identify any function/class/method defined in fixed_code — cannot mechanically verify generated_test exercises it',
          detail: { definedInFixed: [...definedInFixed] },
        };
      }
      return {
        passed: false,
        // false: buggy_code was never actually run against generated_test,
        // so its intended failure was never demonstrated.
        brokenCodeFailedTests: false,
        logs: 'generated_test does not call any function/class defined in fixed_code (' + [...definedInFixed].join(', ') + ') — it cannot be exercising this code',
        detail: { definedInFixed: [...definedInFixed] },
      };
    }
    // testsReferenceCode is purely textual (see module doc comment): it
    // cannot tell a live call site from a dead one, or a checked result from
    // a discarded one. Requiring a real assertion construct somewhere in
    // generated_test closes both the dead-code-call and the swallowed-
    // exception/unchecked-call shapes at once, regardless of which one
    // produced the differential.
    const testsHaveRealAssertion = ASSERTION_RE.test(testsForCheck);
    if (!testsHaveRealAssertion) {
      return {
        passed: false,
        // false: buggy_code was never actually run against generated_test.
        brokenCodeFailedTests: false,
        logs: 'generated_test calls code from fixed_code but contains no recognizable assertion construct — it cannot be verifying anything about the result',
        detail: { definedInFixed: [...definedInFixed] },
      };
    }

    const lang = h.inferLang(buggy);
    // Reduced from 20000: this file ALWAYS makes two of these calls per
    // verify() (buggy + fixed) -- at the prior value the worst case
    // (2x20000, plus a compiled language's own compile-step ceiling on top
    // of each) already summed well past the outer sandbox command budget
    // deployed at the time (30000ms; raised to 120000ms as of the current
    // deploy, infra/terraform/ssm.tf), the same class of
    // gap already found and fixed for individual timeouts throughout this
    // registry's audit. A submission-sized buggy/fixed snippet plus its
    // tests is not remotely close to even this reduced value in practice.
    const buggyRun = h.runWithTests(lang, buggy, tests, 8000);
    if (buggyRun.unavailable) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: (buggyRun.runtime || lang) + ' not available in sandbox',
        detail: { runtime: buggyRun.runtime || lang, inferredLang: lang },
      };
    }
    const fixedRun = h.runWithTests(lang, fixed, tests, 8000);
    if (fixedRun.unavailable) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: (fixedRun.runtime || lang) + ' not available in sandbox',
        detail: { runtime: fixedRun.runtime || lang, inferredLang: lang },
      };
    }

    const testFailedOnBuggy = buggyRun.ok === false;
    const testPassedOnFixed = fixedRun.ok === true;
    const passed = testFailedOnBuggy && testPassedOnFixed;
    return {
      passed,
      brokenCodeFailedTests: testFailedOnBuggy,
      logs: passed ? '' : ('buggy: ' + (testFailedOnBuggy ? 'failed (correct)' : 'passed (WRONG — test does not catch the bug)') +
        '; fixed: ' + (testPassedOnFixed ? 'passed (correct)' : 'failed (WRONG — test rejects the fix)')),
      detail: {
        inferredLang: lang,
        testFailedOnBuggy,
        testPassedOnFixed,
        buggyStderr: String(buggyRun.stderr || '').slice(0, 500),
        fixedStderr: String(fixedRun.stderr || '').slice(0, 500),
      },
    };
  },
};
