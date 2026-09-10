/**
 * fail-then-pass, with a type-check gate — broken_code must FAIL against
 * tests, and fixed_code must PASS them. This dataset carries no `language`
 * field: the filename and the type annotations throughout the code identify
 * it as TypeScript, so language is fixed at 'typescript'.
 *
 * One class of these bugs (bug_type "types") is a COMPILE-time defect that
 * tsx/esbuild erase without checking — under a runtime-only contract the
 * broken version would run clean, hiding the bug entirely and making the
 * pair look like it "does not discriminate broken from fixed". Both sides
 * are therefore ALSO type-checked (h.typeCheck), and a type error counts as
 * a legitimate way for the broken side to fail. The fix must clear BOTH
 * gates — a fixed_code that only type-checks without satisfying its own
 * tests is not a fix, and vice versa.
 *
 * Ported from the scratch/catrun prototype (scratch/catrun/reports/debugging.json).
 */
'use strict';

module.exports = {
  contract: 'fail-then-pass',
  // tsc deliberately NOT listed here: unlike tsx (needed to execute every
  // row, unconditionally), tsc is only needed to rule out a compile-time-only
  // bug for rows where the runtime check alone is ambiguous -- see the
  // brokenTc guard below. Declaring it here would fail EVERY row (including
  // plain logic bugs that never need type-checking) whenever tsc happens to
  // be temporarily unavailable, which is more aggressive than correct.
  requires: ['node', 'tsx'],

  verify(row, h) {
    const broken = h.str(row, 'broken_code');
    const fixed = h.str(row, 'fixed_code');
    const tests = h.str(row, 'tests');
    if (!broken || !fixed || !tests) {
      // brokenCodeFailedTests must still be a boolean here, not omitted: the
      // schema declares a `broken_code` field, so the contract layer
      // (executionContractPassed) treats an undefined value as a harness
      // fault ("all_providers_failed") rather than a clean reject.
      return { passed: false, brokenCodeFailedTests: false, detail: { reason: 'missing broken_code, fixed_code, or tests' } };
    }

    const lang = 'typescript';

    // Reduced from 20000: this category is unconditionally TypeScript (see
    // `lang` above), and ALWAYS makes two of these calls plus two
    // h.typeCheck() calls in one verify() -- at the prior value the worst
    // case (2x20000 + 2x typeCheck's own internal tsc ceiling) already
    // summed well past the outer sandbox command budget deployed at the
    // time (30000ms; raised to 120000ms as of the current deploy,
    // infra/terraform/ssm.tf), the same class of gap already
    // found and fixed for individual timeouts throughout this registry's
    // audit. A submission-sized TS snippet plus its tests is not remotely
    // close to even this reduced value in practice.
    const brokenRun = h.runWithTests(lang, broken, tests, 8000);
    if (brokenRun.unavailable) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: (brokenRun.runtime || lang) + ' not available in sandbox',
        detail: { stage: 'broken', runtime: brokenRun.runtime },
      };
    }
    const fixedRun = h.runWithTests(lang, fixed, tests, 8000);
    if (fixedRun.unavailable) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: (fixedRun.runtime || lang) + ' not available in sandbox',
        detail: { stage: 'fixed', runtime: fixedRun.runtime },
      };
    }

    const brokenTc = h.typeCheck(lang, broken + '\n' + tests);
    const fixedTc = h.typeCheck(lang, fixed + '\n' + tests);

    // A missing tsc means a compile-time-only bug (bug_type "types") cannot
    // be ruled out: broken_code running clean is then indistinguishable from
    // "genuinely no bug" and "a real type bug tsx silently erased". Without
    // this guard that ambiguity was misreported as "tests do not discriminate
    // broken from fixed" -- a contributor-blaming reject for an environment
    // fault, on a row that may be entirely correct.
    if (!brokenTc.checked && brokenRun.ok === true) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: (brokenTc.reason || 'tsc unavailable') + ' -- cannot rule out a compile-time-only bug',
        detail: { stage: 'typecheck', reason: brokenTc.reason },
      };
    }
    // The identical ambiguity applies to fixed_code, not just broken_code:
    // fixedPassed below trusts runtime alone whenever fixedTc.checked is
    // false (line ~99), so a fixed_code that STILL has the same (or a new)
    // compile-time-only type bug -- one tsx would silently erase at runtime
    // -- would be certified PASSED purely because this one tsc call happened
    // to time out (a real risk: this row always makes two back-to-back tsc
    // invocations in one verify(), see the comment on the timeoutMs values
    // above). Without this guard that ambiguity was misreported as a clean
    // pass instead of the environment fault it actually is.
    if (!fixedTc.checked && fixedRun.ok === true) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: (fixedTc.reason || 'tsc unavailable') + ' -- cannot rule out a compile-time-only bug in fixed_code',
        detail: { stage: 'typecheck-fixed', reason: fixedTc.reason },
      };
    }

    const brokenFailed = brokenRun.ok === false || (brokenTc.checked && brokenTc.ok === false);
    // The fix must clear BOTH gates; a fix that only type-checks is not a fix.
    const fixedPassed = fixedRun.ok === true && (!fixedTc.checked || fixedTc.ok === true);
    const passed = brokenFailed && fixedPassed;

    return {
      passed,
      // Required at the top level (not just detail): the product-side
      // contract layer (executionContractPassed in
      // src/services/execution-providers/contract.ts) treats an undefined
      // brokenCodeFailedTests as a harness fault for any dataset whose
      // schema declares a `broken_code` field, which this one does.
      brokenCodeFailedTests: brokenFailed,
      logs: passed ? '' : (!brokenFailed
        ? 'tests do not discriminate broken from fixed (broken_code passed both runtime and type-check)'
        : 'fix does not satisfy its own tests'),
      detail: {
        brokenFailedAtRuntime: brokenRun.ok === false,
        brokenFailedTypeCheck: brokenTc.checked ? brokenTc.ok === false : null,
        fixedPassedRuntime: fixedRun.ok === true,
        fixedPassedTypeCheck: fixedTc.checked ? fixedTc.ok === true : null,
        typeCheckAvailable: brokenTc.checked,
        brokenStderr: String(brokenRun.stderr || '').slice(0, 400),
        fixedStderr: String(fixedRun.stderr || '').slice(0, 400),
        brokenTypeDiag: String(brokenTc.diag || '').slice(0, 400),
      },
    };
  },
};
