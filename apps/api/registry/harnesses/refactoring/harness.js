/**
 * both-pass-identically — original_code and refactored_code must BOTH pass
 * the same tests. A refactor that changes behavior (breaks the tests) is not
 * a valid refactor regardless of how much cleaner the code looks.
 *
 * `tests` here is always a complete, self-sufficient fragment — a bare
 * `assert` sequence for scripting languages, but for Java/Go/Rust/C++ a full
 * `main()`/entrypoint (Java even splits mid-class: original_code opens
 * `public class Main {` and leaves it unclosed; tests supplies the rest of
 * the body plus the closing brace). h.runWithTests's compiled-language
 * branches assume the OPPOSITE — bare statements needing an entrypoint
 * synthesized around them — which double-wraps an already-complete main()
 * and fails to compile. Plain concatenation (h.runCode) is what this
 * dataset's convention actually needs, for every language, not just the
 * scripting ones.
 *
 * REARM re-applies JS_PRELUDE's console.assert override (JS/TS) / PHP's
 * assertion ini flags immediately before `tests` runs, same rationale and
 * same string h.runWithTests uses for its own re-arm: code that runs
 * BETWEEN the prelude and `tests` -- here, the entire submission, since
 * concatenation is manual -- can otherwise silently neuter the very check
 * `tests` depends on. Confirmed exploitable without it: a JS refactored_code
 * that does `console.assert = function () {};` before a genuinely broken
 * function definition passed outright against tests written in the
 * `console.assert(...)` style (JS_PRELUDE's own override only ever installs
 * ONCE, before any submission code runs the first time). Not needed for
 * Python -- PY_DRIVER's try/except SystemExit and PY_PRELUDE's exit traps
 * are already structural inside runCode itself, independent of any rearm
 * point, and Python's `assert` statement has no monkeypatchable re-arm
 * surface at all. Not attempted for Ruby/PHP's exit()/die() early-exit
 * gap specifically (a different mechanism than assertion-neutering,
 * language constructs rather than overridable functions) -- that gap lives
 * in shared runCode (no exit-trap exists there for either language) and
 * would need a sentinel-file, verify-completion-from-outside-the-process
 * architecture change to close safely; no local php/ruby interpreter was
 * available to verify a fix, and shipping one unverified risked breaking
 * every legitimate PHP/Ruby row instead of just the exploit -- same call
 * made for Ruby's re-arm during this registry's `implementation` audit.
 *
 * Same residual, same reason, now also confirmed for Java/Go/Rust/C/C++/C#
 * specifically via this file's own use of h.runCode (a later, dedicated
 * audit of helpers.js itself): System.exit(0)/os.Exit(0)/
 * std::process::exit(0)/exit(0)/Environment.Exit(0), called from anywhere
 * in original_code/refactored_code, forces a clean exit runCode's bare
 * status===0 check cannot distinguish from a genuine pass. Closed for
 * h.runWithTests's OWN synthesized entrypoints elsewhere in this registry
 * (a completion marker printed as the entrypoint's literal last statement,
 * which an early exit prevents from ever printing) -- not applicable here,
 * since this file hands runCode an ALREADY-COMPLETE program with no
 * harness-controlled "append after everything" point to inject a marker
 * into, the same structural reason PHP/Ruby's gap couldn't be closed this
 * way either.
 */
'use strict';

const REARM = {
  javascript: "globalThis.assert = require('assert'); console.assert = function (c) { if (!c) { throw new Error('console.assert failed: ' + Array.prototype.slice.call(arguments,1).join(' ')); } };\n",
  typescript: "globalThis.assert = require('assert'); console.assert = function (c) { if (!c) { throw new Error('console.assert failed: ' + Array.prototype.slice.call(arguments,1).join(' ')); } };\n",
  php: "ini_set('zend.assertions', '1'); ini_set('assert.exception', '1');\n",
};

module.exports = {
  contract: 'both-pass-identically',
  requires: [],

  verify(row, h) {
    const original = h.str(row, 'original_code');
    const refactored = h.str(row, 'refactored_code');
    const tests = h.str(row, 'tests');
    const language = h.str(row, 'language');
    if (!original || !refactored || !tests) {
      return { passed: false, detail: { reason: 'missing original_code, refactored_code, or tests' } };
    }

    // "Both pass the same tests" is satisfied trivially — with zero
    // refactoring effort — when refactored_code is just original_code
    // again. Whitespace-insensitive so re-indenting alone doesn't dodge
    // this: dedupeFields only catches the SAME pair submitted across
    // different rows, not this within-row case, and nothing else here
    // (or in `detail`, surfaced to the llm/human_audit stages) flags it.
    const collapse = (s) => s.replace(/\s+/g, ' ').trim();
    if (collapse(original) === collapse(refactored)) {
      return {
        passed: false,
        logs: 'refactored_code is identical to original_code (ignoring whitespace) — this is not a refactor',
        detail: { language, identicalToOriginal: true },
      };
    }

    // Two sequential compile+run calls in one outer sandbox command: for the
    // compiled languages this schema allows (Java/Go/Rust/C++), helpers.js's
    // own per-language COMPILE ceilings (60-90s each, hardcoded independent
    // of the timeoutMs passed here) are not derived from or asserted against
    // the outer sandbox command budget anywhere in the registry-harness
    // execution path (unlike the separate, non-registry harness system,
    // which does enforce that invariant). Two such calls back to back could
    // in principle exceed the outer budget on a slow/cold-cache compile,
    // surfacing as an opaque infra timeout instead of a clean verdict.
    // Dormant against the current reference dataset (compiles in ~1-2s), and
    // fixing it properly means threading the outer budget into shared
    // per-language ceilings across every registry harness that compiles code
    // -- out of scope for a single category's fix; flagged for awareness.
    const rearm = REARM[h.normLang(language)] || '';
    const a = h.runCode(language, original + '\n' + rearm + tests, 20000);
    if (a.unavailable) {
      return { passed: false, runtimeUnavailable: true, logs: (a.runtime || language) + ' not available in sandbox', detail: { language } };
    }
    const b = h.runCode(language, refactored + '\n' + rearm + tests, 20000);
    if (b.unavailable) {
      return { passed: false, runtimeUnavailable: true, logs: (b.runtime || language) + ' not available in sandbox', detail: { language } };
    }

    const originalPasses = a.ok === true;
    const refactoredPasses = b.ok === true;
    const passed = originalPasses && refactoredPasses;
    return {
      passed,
      logs: passed ? '' : ('original: ' + (originalPasses ? 'passed' : 'FAILED') + '; refactored: ' + (refactoredPasses ? 'passed' : 'FAILED')),
      detail: {
        language, originalPasses, refactoredPasses, identicalToOriginal: false,
        originalStderr: String(a.stderr || '').slice(0, 500),
        refactoredStderr: String(b.stderr || '').slice(0, 500),
      },
    };
  },
};
