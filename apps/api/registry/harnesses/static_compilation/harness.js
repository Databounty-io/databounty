/**
 * expected-failure-match — source_code must compile/type-check cleanly when
 * expected_result says "success", and must fail with the SPECIFIC error code
 * named in error_details (Rust E-codes, Java/C++ C-codes, TS TS-codes) when
 * expected_result says "compile failure". Dispatched by `language`, not the
 * row's own `compiler_or_checker` label — a mismatched label (e.g. a Rust
 * row naming "gcc") is itself one of this dataset's planted flaws.
 *
 * The "specific code" claim is only mechanically checkable for languages
 * whose real toolchain emits one at all: Rust (E####) and TypeScript
 * (TS####) always do. Java/Go/C/C++ never emit a numbered code (javac/gcc/
 * go vet only ever produce free text), and Python's syntax checker doesn't
 * either -- for those, error_details naming a code is impossible by
 * construction, so the check is skipped rather than silently treated as
 * satisfied by any failure (see CODE_RE/LANGS_WITH_CODES below; this was a
 * confirmed exploit against the prior version: a "compile failure" row
 * whose error_details described an entirely unrelated defect than the
 * code's real one passed outright whenever no code happened to be present).
 */
'use strict';

// Toolchain name -> the one language family it can possibly belong to. gcc
// and g++ are treated as interchangeable with each other (people say "gcc"
// loosely for C++ too) but not with anything else — a Rust row naming "gcc"
// as its checker is impossible regardless: gcc cannot compile Rust at all.
const TOOLCHAIN_LANG = [
  [/\brustc\b/i, 'rust'],
  [/\bjavac\b/i, 'java'],
  [/\bgo\s+(build|vet)\b/i, 'go'],
  [/\btsc\b/i, 'typescript'],
  [/\bpython3?\b|py_compile|mypy/i, 'python'],
  [/\bg(cc|\+\+)\b/i, 'c/cpp'],
];
function checkerBelongsToLanguage(checkerText, lang) {
  for (const [re, checkerLang] of TOOLCHAIN_LANG) {
    if (re.test(checkerText)) {
      if (checkerLang === 'c/cpp') return lang === 'c' || lang === 'cpp';
      return checkerLang === lang;
    }
  }
  return true; // no recognized toolchain name mentioned — nothing to contradict
}

// TS error codes are not always 4 digits (e.g. TS18047) -- a stricter
// \d{4} silently failed to match that shape at all, making a real code
// look absent. E-codes (Rust) and C-codes (MSVC-style) stay at their
// conventional 4 digits.
const CODE_RE = /\b(E\d{3,4}|C\d{4}|TS\d{3,5})\b/;
// Compilers for these two languages always emit a numbered code for a real
// compile error -- confirmed against the real reference dataset (every
// Rust/TypeScript compile-failure row includes one). Java/Go/C/C++/Python
// never do, so absence there is normal, not a red flag.
const LANGS_WITH_CODES = new Set(['rust', 'typescript']);

module.exports = {
  contract: 'expected-failure-match',
  requires: [],

  verify(row, h) {
    const code = h.str(row, 'source_code');
    const language = h.str(row, 'language');
    const checkerLabel = h.str(row, 'compiler_or_checker');
    const expectedResult = h.str(row, 'expected_result');
    const errorDetails = h.str(row, 'error_details');
    if (!code || !language) return { passed: false, detail: { reason: 'missing source_code or language' } };

    const lang = h.normLang(language);
    if (checkerLabel && !checkerBelongsToLanguage(checkerLabel, lang)) {
      return {
        passed: false,
        logs: 'compiler_or_checker ("' + checkerLabel + '") names a toolchain that cannot compile ' + language + ' at all',
        detail: { language, checkerLabel, contradiction: 'checker-language-mismatch' },
      };
    }
    // Confirmed against a real E2B run (New_Tester's own reference data): a
    // genuinely "Success:"-classified row ("Success: Scenario SCN-062
    // (partial failure across a multi-step operation; ...)") was wrongly
    // treated as a compile-failure expectation, because the OLD check
    // scanned the ENTIRE string for the substring "fail" anywhere -- and
    // this dataset's own scenario descriptions are free-text business-case
    // names that can legitimately contain the word "fail"/"failure" (this
    // one, "lost update", "timeout/cancellation completion race", etc.)
    // with no bearing on the row's actual compile-vs-typecheck outcome.
    // Checked in BOTH corpora's real conventions ("Success: Scenario ..."
    // and the shorter "success, no type errors") -- the classification is
    // always the LEADING token, never something to hunt for as a substring
    // anywhere in the free-text remainder.
    const expectSuccess = /^\s*success\b/i.test(expectedResult);

    const d = h.workdir();
    let r, runtime;
    // Every in-sandbox timeout below is well under the outer sandbox
    // command budget deployed at the time (30000ms; raised to 120000ms as
    // of the current deploy, infra/terraform/ssm.tf) -- the
    // previous values (60000-90000ms) individually EXCEEDED it, so a
    // genuine compiler hang or a loaded sandbox could only ever be stopped
    // by tearing down the whole outer command with no verdict at all,
    // rather than a clean runtimeUnavailable from a per-call timeout.
    if (lang === 'rust') {
      if (!h.have('rustc')) return { passed: false, runtimeUnavailable: true, logs: 'rustc not available', detail: { language } };
      const f = h.path.join(d, 'm.rs'); h.fs.writeFileSync(f, code);
      r = h.run('rustc', ['--edition', '2021', '-o', h.path.join(d, 'app'), f], { cwd: d, timeoutMs: 15000 }); runtime = 'rustc';
    } else if (lang === 'java') {
      if (!h.have('javac')) return { passed: false, runtimeUnavailable: true, logs: 'javac not available', detail: { language } };
      const cls = h.javaClassName(code);
      const f = h.path.join(d, cls + '.java'); h.fs.writeFileSync(f, code);
      r = h.run('javac', [f], { cwd: d, timeoutMs: 10000 }); runtime = 'javac';
    } else if (lang === 'go') {
      if (!h.have('go')) return { passed: false, runtimeUnavailable: true, logs: 'go not available', detail: { language } };
      const f = h.path.join(d, 'main.go'); h.fs.writeFileSync(f, code);
      // go build, not go vet: vet's exit status also reflects vet-only
      // diagnostics (e.g. Printf format mismatches, unreachable code) that
      // are not compile errors at all per Go's own documented semantics --
      // a strict superset of what this category's contract (compile-time
      // correctness, not linting) is actually about. Unverified locally (no
      // go toolchain on this dev box) but this is Go's own documented
      // vet-vs-build distinction, not a guess.
      r = h.run('go', ['build', '-o', h.path.join(d, 'app'), f], {
        cwd: d, timeoutMs: 10000,
        env: { HOME: d, GOCACHE: h.path.join(d, '.gc'), GOPATH: h.path.join(d, '.gp'), GOFLAGS: '-mod=mod' },
      }); runtime = 'go build';
    } else if (lang === 'cpp' || lang === 'c') {
      const cc = lang === 'cpp' ? 'g++' : 'gcc';
      if (!h.have(cc)) return { passed: false, runtimeUnavailable: true, logs: cc + ' not available', detail: { language } };
      const f = h.path.join(d, 'm.' + (lang === 'cpp' ? 'cpp' : 'c')); h.fs.writeFileSync(f, code);
      r = h.run(cc, ['-fsyntax-only', '-std=' + (lang === 'cpp' ? 'c++17' : 'c11'), f], { cwd: d, timeoutMs: 10000 }); runtime = cc;
    } else if (lang === 'typescript') {
      // Routed through the shared h.typeCheck() rather than a bare
      // `tsc --strict --noEmit` invocation: bare tsc rejects valid TS that
      // imports Node builtins (node:test, assert, ...) with TS2792/TS2664
      // in the absence of @types/node -- a toolchain gap that would
      // misreport as a "compile failure" the row never asked to test.
      // h.typeCheck injects the ambient declarations that fix exactly that.
      const tc = h.typeCheck(lang, code);
      if (!tc.checked) return { passed: false, runtimeUnavailable: true, logs: tc.reason || 'tsc unavailable', detail: { language } };
      r = { status: tc.ok ? 0 : 1, stdout: '', stderr: tc.diag || '' };
      runtime = 'tsc --strict --noEmit (shared h.typeCheck)';
    } else if (lang === 'python') {
      if (!h.have('python3')) return { passed: false, runtimeUnavailable: true, logs: 'python3 not available', detail: { language } };
      const f = h.path.join(d, 'm.py'); h.fs.writeFileSync(f, code);
      const syntaxR = h.run('python3', ['-m', 'py_compile', f], { cwd: d, timeoutMs: 8000 });
      if (syntaxR.status !== 0) {
        r = syntaxR; runtime = 'py_compile';
      } else if (h.have('mypy')) {
        // py_compile alone is SYNTAX only, not type checking -- confirmed
        // exploitable: a genuine static type error (e.g. returning an int
        // where -> str is annotated) previously compiled cleanly, so a row
        // claiming exactly that as a "compile failure" was always wrongly
        // rejected, and the same code claiming "success, no type errors"
        // was always wrongly accepted. mypy is the real type checker.
        r = h.run('python3', ['-m', 'mypy', '--strict', f], {
          cwd: d, timeoutMs: 12000, env: { MYPY_CACHE_DIR: h.path.join(d, '.mypy_cache') },
        });
        runtime = 'py_compile + mypy --strict';
      } else if (expectSuccess) {
        // mypy unavailable: only syntax was verified, but this dataset's own
        // contract for a "success" row is "compile/type-check cleanly", not
        // merely "parses" -- py_compile alone cannot confirm the type-check
        // half of that claim. Silently falling through to a syntax-only pass
        // here (the prior behavior) was the SAME false-pass gap already
        // fixed above for the "compile failure" direction, just unguarded
        // on this side: a row claiming "success, no type errors" whose code
        // has a genuine static type error would pass outright whenever this
        // sandbox image happens to lack mypy -- confirmed live, not
        // hypothetical, since neither this harness's own setup.sh nor
        // infra/e2b installs mypy anywhere.
        return { passed: false, runtimeUnavailable: true, logs: 'mypy unavailable in this sandbox image -- cannot verify a claimed clean type-check ("success" requires more than syntax-only verification)', detail: { language, runtime: 'mypy' } };
      } else if (!/syntaxerror/i.test(errorDetails)) {
        // mypy unavailable: only syntax was verified. A row claiming a
        // TYPE (not syntax) failure can't be confirmed either way without
        // it -- ambiguous, not a free pass or a contributor-blaming reject.
        return { passed: false, runtimeUnavailable: true, logs: 'mypy unavailable in this sandbox image -- cannot verify a claimed non-syntax compile failure', detail: { language, runtime: 'mypy' } };
      } else {
        r = syntaxR; runtime = 'py_compile';
      }
    } else {
      return { passed: false, runtimeUnavailable: true, logs: 'unsupported language: ' + language, detail: { language } };
    }

    if (r.timedOut) {
      return { passed: false, runtimeUnavailable: true, logs: runtime + ' did not finish within the time budget', detail: { language, runtime } };
    }

    const compiled = r.status === 0;
    const diag = String(r.stderr || '') + String(r.stdout || '');

    // A compile-failure row whose error_details describes something that can
    // only happen AFTER compilation succeeds ("NullPointerException at
    // runtime") contradicts its own expected_result — that mismatch is a
    // planted flaw in the reference data, not something a code checker
    // dispatched by language would ever surface on its own.
    if (!expectSuccess && /\bruntime\b/i.test(errorDetails) && !/compile[- ]?time/i.test(errorDetails)) {
      return {
        passed: false,
        logs: 'error_details describes a runtime failure but expected_result claims a compile failure',
        detail: { language, expectSuccess, compiled, contradiction: 'runtime-error-details-for-compile-failure' },
      };
    }

    let errMatched = null;
    let unverifiedSpecificClaim = false;
    if (!expectSuccess) {
      const codeM = errorDetails.match(CODE_RE);
      if (codeM) {
        errMatched = diag.includes(codeM[1]);
      } else if (LANGS_WITH_CODES.has(lang)) {
        return {
          passed: false,
          runtimeUnavailable: true,
          logs: 'error_details claims a compile failure but names no ' + (lang === 'rust' ? 'Rust E-code' : 'TypeScript TS-code') + ' to verify against',
          detail: { language },
        };
      } else {
        // Java/Go/C/C++ toolchains never emit a numbered code -- the
        // specific-code check is structurally inapplicable. Still scored
        // on whether compilation genuinely failed at all, but flagged so
        // downstream llm/human_audit stages know the SPECIFIC claim wasn't
        // mechanically confirmed, only "did it fail".
        unverifiedSpecificClaim = true;
      }
    }

    const passed = expectSuccess ? compiled : (!compiled && errMatched !== false);
    return {
      passed,
      logs: passed ? '' : (expectSuccess ? 'expected clean compile but got: ' + diag.slice(0, 500) : 'expected failure did not reproduce: ' + diag.slice(0, 500)),
      detail: {
        language, expectSuccess, compiled, expectedErrorCodeFound: errMatched, unverifiedSpecificClaim,
        expectedResult: expectedResult.slice(0, 120), diag: diag.slice(0, 400),
      },
    };
  },
};
