/**
 * implementation — solution-passes-tests. solution_code must PASS the
 * row's own `tests` when executed in its declared `language` (one of the 10
 * languages this dataset carries: Python, JavaScript, TypeScript, Java, Go,
 * Rust, C++, C#, Ruby, PHP), via the shared polyglot runner (h.runWithTests),
 * which also carries the per-language false-pass traps already fixed at the
 * catrun stage (JVM assertions off by default, console.assert not throwing,
 * Debug.Assert compiled out unless DEBUG is defined, Go/Rust/C/C++ tests
 * needing an entrypoint).
 *
 * `starter_code` is DELIBERATELY never read here. It is a stub only (a bare
 * function signature, often literally just `pass` / `{ }` / a TODO body) —
 * documentation for the contributor showing what signature to implement, not
 * a thing that is itself correct or checkable. Executing it would either be a
 * no-op (nothing to assert against) or, worse, a guaranteed FAIL that has
 * nothing to do with whether solution_code is right — there is no fail-then-
 * pass obligation on this dataset, unlike debugging/fail_to_pass/vulnerability.
 * Only solution_code, tests, and language ever feed verify() -- instruction
 * is a natural-language requirement that execution can't check and belongs
 * to the llm/human_audit pipeline stages instead.
 */
'use strict';

module.exports = {
  contract: 'solution-passes-tests',
  requires: [],

  verify(row, h) {
    const solution = h.str(row, 'solution_code');
    const tests = h.str(row, 'tests');
    const language = h.str(row, 'language');
    if (!solution || !tests || !language) {
      return { passed: false, detail: { reason: 'missing solution_code, tests, or language' } };
    }

    const lang = h.normLang(language);
    // Reduced from 20000: the only call in this verify(), but a compiled
    // language's own compile-step ceiling (helpers.js's COMPILE_TIMEOUT_MS/
    // RUST_COMPILE_TIMEOUT_MS) adds on top of whatever's passed here --
    // 20000 plus that ceiling could already exceed the outer sandbox
    // command budget deployed at the time (30000ms; raised to 120000ms as
    // of the current deploy, infra/terraform/ssm.tf). A
    // submission-sized solution plus its tests is not remotely close to
    // even this reduced value in practice.
    const r = h.runWithTests(lang, solution, tests, 15000);
    if (r.unavailable) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: (r.runtime || lang) + ' not available in sandbox',
        detail: { language, inferredLang: lang, runtime: r.runtime },
      };
    }

    const passed = r.ok === true;
    return {
      passed,
      logs: passed ? '' : 'solution_code failed its own tests: ' + String(r.stderr || r.stdout || '').slice(0, 600),
      detail: {
        language,
        inferredLang: lang,
        runtime: r.runtime,
        compileFailed: !!r.compileFailed,
        timedOut: !!r.timedOut,
        stdout: String(r.stdout || '').slice(0, 400),
        stderr: String(r.stderr || '').slice(0, 400),
      },
    };
  },
};
