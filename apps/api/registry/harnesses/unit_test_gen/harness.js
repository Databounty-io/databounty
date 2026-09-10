/**
 * single-suite-pass — the contributor's generated_tests must PASS when run
 * against source_code, using the framework the row declares (pytest / jest /
 * go test / rustc --test). Unlike fail-then-pass, there is no negative side —
 * a valid item just needs its own claimed test suite to actually run green.
 *
 * "Runs green with at least one real test case" (the pre-existing zero-test
 * guards below) is necessary but NOT sufficient: a test suite consisting of
 * nothing but `assert True` / `expect(1).toBe(1)` / an always-true condition
 * also runs green with a nonzero test count, while verifying literally
 * nothing about source_code. Confirmed exploitable: a deliberately wrong
 * add() (returns a-b) paired with `def test_dummy(): assert True` passed
 * outright. MUTATION-TESTING closes this: once the suite passes against the
 * real source_code, a small textual mutation (flip a comparison operator,
 * a boolean literal, or an arithmetic operator — whichever is found first,
 * skipping string/comment contents) is applied to source_code, and the SAME
 * suite is re-run against the mutant. A suite that also passes against the
 * mutant has been shown not to depend on the mutated behavior; up to
 * MAX_MUTANTS distinct mutations are tried (not just one) before concluding
 * the suite is vacuous, since a single missed mutation landing in dead code
 * or an untested branch is a real risk with a genuinely well-targeted
 * suite, not just possible for a vacuous one. A mutant that fails to
 * compile (Go/Rust) is inconclusive, not a "catch" — it says nothing about
 * whether the tests are any good, so that candidate is skipped rather than
 * counted either way.
 */
'use strict';

const MAX_MUTANTS = 3;

/** Blanks string-literal contents and line comments (keeping length and
 * quote/comment-marker characters intact) so a mutation candidate search
 * never touches text that isn't live code -- mirrors the same quote-aware
 * masking pattern used elsewhere in this registry (e.g. network_protocol_fsm,
 * serialization) rather than inventing a new one. */
function maskStringsAndComments(code, hashComments) {
  let out = '';
  let quote = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      out += c === '\n' ? '\n' : ' ';
      if (c === quote && code[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += ' '; continue; }
    if (hashComments && c === '#') {
      while (i < code.length && code[i] !== '\n') { out += ' '; i++; }
      out += '\n';
      continue;
    }
    if (!hashComments && c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') { out += ' '; i++; }
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

const CMP_FLIP = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<=': '>', '>=': '<', '<': '>=', '>': '<=' };
// The bare `<`/`>` alternatives exclude the specific two-character tokens
// that share one of those characters but mean something else entirely in
// this file's own supported languages: `<(?!-)` skips Go's channel-receive
// operator `<-` (e.g. `v := <-ch`), and `(?<!-)(?<!=)>` skips the `>` of a
// Python/Rust `->` return-type arrow AND a JS/TS `=>` arrow function.
// Confirmed exploitable for `->` specifically on real E2B: an unqualified
// bare `>` match constructed a syntactically INVALID mutant from source
// containing either arrow (e.g. "def f(x: int) -> int:" becoming
// "def f(x: int) -<= int:"), which then let a genuinely vacuous test suite
// (one that imports source_code but never actually exercises it) pass
// mutation testing outright -- Python's own `runPy()` has no
// compile/import-failure guard (unlike Go/Rust/TS below), so the resulting
// ImportError from the broken mutant's import was misread as `r.passed:
// false`, i.e. a genuine "catch", when it proved nothing about the suite at
// all. Excluding these tokens here (rather than only in the arithmetic
// tier below) matters because this comparison tier runs FIRST and would
// otherwise construct the same broken mutant before arithFlip is ever
// reached.
const CMP_RE_G = /===|!==|<=|>=|==|!=|<(?!-)|(?<!-)(?<!=)>/g;

/** Up to `max` distinct single-token mutations of `source`, most-behavior-
 * changing first (comparison flip, then boolean-literal flip, then
 * arithmetic-operator flip), skipping string/comment contents. Returns []
 * when nothing mutable was found -- e.g. a function with no comparisons,
 * booleans, or +/- at all -- rather than forcing a mutation that would
 * change nothing observable. */
function findMutants(source, lang, max) {
  const hashComments = lang === 'python';
  const masked = maskStringsAndComments(source, hashComments);
  const boolRe = lang === 'python' ? /\bTrue\b|\bFalse\b/g : /\btrue\b|\bfalse\b/g;
  const boolFlip = lang === 'python' ? { True: 'False', False: 'True' } : { true: 'false', false: 'true' };
  // Excludes a "-" immediately followed by ">" -- i.e. never targets the "-"
  // inside a "->" return-type arrow (Python type hints: "def f(x: int) ->
  // int:"; Rust fn signatures: "fn f(x: i32) -> i32"). Confirmed on real E2B
  // to matter, not a theoretical concern: for source_code whose earliest
  // "+"/"-" character is inside such an arrow (true for nearly every
  // type-hinted Python function and every non-unit-returning Rust fn), the
  // OLD unconditional /[+-]/g matched that arrow's "-" FIRST (leftmost wins),
  // producing a syntactically invalid mutant (e.g. "def f(x: int) +> int:").
  // For Rust (mutant cap 1) this only defeated the check safely -- the
  // resulting compile failure is already caught as `inconclusive`
  // ("mutant failed to compile"), so mutation testing silently never ran at
  // all rather than falsely passing. For Python (mutant cap 2, and no
  // equivalent compile-failure guard -- runPy() has none), it was a genuine,
  // confirmed FALSE PASS: a vacuous suite that imports source_code but never
  // exercises it (e.g. `from source import add` + `def test_dummy(): assert
  // True`) got the syntax-broken arrow-mutant's resulting ImportError
  // (r.passed=false, but for a reason that says NOTHING about whether the
  // suite tests real behavior) miscounted as `ok:true`, a genuine "catch" --
  // exactly the false-pass class this whole mutation-testing mechanism's own
  // module docstring says it exists to close.
  const arithRe = /-(?!>)|\+/g;
  const arithFlip = { '+': '-', '-': '+' };
  const tiers = [
    { re: CMP_RE_G, flip: CMP_FLIP },
    { re: boolRe, flip: boolFlip },
    { re: arithRe, flip: arithFlip },
  ];
  const out = [];
  for (const tier of tiers) {
    let m;
    tier.re.lastIndex = 0;
    while (out.length < max && (m = tier.re.exec(masked))) {
      const token = m[0];
      const replacement = tier.flip[token];
      out.push(source.slice(0, m.index) + replacement + source.slice(m.index + token.length));
    }
    if (out.length >= max) break;
  }
  return out;
}

/** Runs `runOnce(mutatedSource)` against up to MAX_MUTANTS candidate
 * mutations of `source`, stopping at the first one the suite fails to pass
 * (a genuine "catch", proving the suite depends on real behavior). A
 * mutant `runOnce` reports as inconclusive (e.g. it failed to compile, so
 * nothing about the TESTS was exercised at all) doesn't count against or
 * for the suite -- tried, then skipped. Returns {ok:true} once caught,
 * {ok:false} if every mutant tried was either survived or inconclusive and
 * at least one real attempt was made, or {ok:null, skipped:true} when no
 * mutant could be constructed at all (accepted on the original-source
 * result alone in that case). */
function mutationTest(source, lang, runOnce, maxMutants) {
  const mutants = findMutants(source, lang, maxMutants || MAX_MUTANTS);
  if (!mutants.length) return { ok: null, skipped: true, tried: 0 };
  let anyConclusive = false;
  for (const mutated of mutants) {
    const r = runOnce(mutated);
    if (r.inconclusive) continue;
    anyConclusive = true;
    if (!r.passed) return { ok: true, tried: mutants.length };
  }
  return { ok: !anyConclusive ? null : false, skipped: !anyConclusive, tried: mutants.length };
}

module.exports = {
  contract: 'single-suite-pass',
  requires: [],

  verify(row, h) {
    const source = h.str(row, 'source_code');
    const tests = h.str(row, 'generated_tests');
    const language = h.str(row, 'language').toLowerCase();
    const framework = h.str(row, 'framework').toLowerCase();
    if (!source || !tests) return { passed: false, detail: { reason: 'missing source_code or generated_tests' } };

    if (language === 'python') {
      // The framework enum is global (not scoped per-language), so a
      // language:"Python" + framework:"go test" row is schema-legal. The old
      // fallback for "framework doesn't say pytest" was to run
      // `python3 test_gen.py` directly with no test-collection framework at
      // all — a file containing nothing but `pass` exits 0 there, an
      // unconditional false pass. Python has exactly one supported
      // framework; treat anything else as a language/framework mismatch.
      if (framework.indexOf('pytest') === -1) {
        return { passed: false, logs: 'language is Python but framework is "' + row.framework + '", not pytest', detail: { language, framework: row.framework, contradiction: 'language-framework-mismatch' } };
      }
      if (!h.have('python3')) return { passed: false, runtimeUnavailable: true, logs: 'python3 not available', detail: {} };
      if (!h.have('pytest')) return { passed: false, runtimeUnavailable: true, logs: 'pytest not available', detail: { framework: row.framework } };
      const runPy = (src) => {
        const d = h.workdir();
        // conftest.py is imported by pytest before it collects ANY test
        // module in this directory -- installing PY_PRELUDE's patches here
        // guarantees they're live before source.py's own module-level code
        // (executed via test_gen.py's `from source import X`) ever runs.
        // Without this, source_code calling os._exit(0) at module level
        // (e.g. a genuinely wrong add() paired with os._exit(0) right after
        // its definition) terminates the WHOLE pytest process immediately at
        // the OS level, with exit code 0 and zero tests ever collected --
        // confirmed exploitable against the prior version (a plain sys.exit
        // is already safely caught as a pytest collection INTERNALERROR
        // regardless, since sys.exit() is just `raise SystemExit(...)` and
        // pytest's own collection machinery re-raises and reports that as a
        // nonzero-exit internal error; os._exit() bypasses that entirely,
        // since it never raises a Python exception at all).
        h.fs.writeFileSync(h.path.join(d, 'conftest.py'), h.PY_PRELUDE);
        // The tests import explicitly ("from source import X"), same convention
        // as the JS rows' require('./source') — the SUT must be named source.py.
        h.fs.writeFileSync(h.path.join(d, 'source.py'), src);
        h.fs.writeFileSync(h.path.join(d, 'test_gen.py'), tests);
        const r = h.run('pytest', ['-q', 'test_gen.py'], { cwd: d, timeoutMs: 8000 });
        return { passed: r.status === 0, out: String(r.stdout || r.stderr).slice(0, 1500) };
      };
      const first = runPy(source);
      if (!first.passed) return { passed: false, logs: first.out, detail: { framework: row.framework } };
      // Capped at 2 (not MAX_MUTANTS=3): at the default, four total attempts
      // (source plus three mutants -- and a weak/vacuous suite that survives
      // every mutant is exactly the worst case this check exists to catch,
      // not a rare edge case) at 10000ms each could sum to 40000ms, past the
      // outer sandbox command budget deployed at the time (30000ms; raised
      // to 120000ms as of the current deploy, infra/terraform/ssm.tf).
      const mt = mutationTest(source, 'python', (mutated) => runPy(mutated), 2);
      if (mt.ok === false) {
        return { passed: false, logs: 'generated_tests passed against every mutated variant tried -- does not appear to depend on source_code\'s real behavior', detail: { framework: row.framework, vacuousTests: true, mutantsTried: mt.tried } };
      }
      return { passed: true, logs: '', detail: { framework: row.framework, mutantsTried: mt.tried, mutationSkipped: !!mt.skipped } };
    }

    if (language === 'javascript' || language === 'typescript') {
      const isJest = framework.indexOf('jest') !== -1;
      const isMocha = framework.indexOf('mocha') !== -1;
      const isVitest = framework.indexOf('vitest') !== -1;
      if (isJest || isMocha || isVitest) {
        const bin = isJest ? 'jest' : isMocha ? 'mocha' : 'vitest';
        if (!h.have(bin)) return { passed: false, runtimeUnavailable: true, logs: bin + ' not installed in sandbox', detail: { framework: row.framework } };
        if (language === 'typescript' && !h.have('tsc')) {
          return { passed: false, runtimeUnavailable: true, logs: 'tsc not installed in sandbox (required to compile TypeScript for ' + bin + ')', detail: { framework: row.framework } };
        }

        // Writes a fresh copy of `src` + the (unchanged) tests, compiling
        // TS first when needed, and runs the declared framework against it.
        // Reused for the real source AND each mutant -- a fresh workdir
        // each time avoids any stale compiled .js from a previous attempt.
        const runJs = (src) => {
          const d = h.workdir();
          let sourceOut = h.path.join(d, 'source.js');
          let testOut = h.path.join(d, 'source.test.js');
          if (language === 'typescript') {
            // None of jest/mocha/vitest have TypeScript understanding wired up
            // in this sandbox (no ts-jest/babel-preset-typescript confirmed
            // present) — every TS row here used to be false-failed outright
            // (jest: "Unexpected reserved word" on `interface`; mocha/vitest:
            // "Cannot find module './source'", since only tsx's own loader
            // resolves an extensionless require to a .ts file). Pre-compile
            // with tsc instead (confirmed present — sandbox/runtimes.json) so
            // the test runner only ever sees plain CommonJS JavaScript. tsc
            // still emits valid .js even when it reports type errors for
            // jest/mocha/vitest's own ambient-undeclared globals
            // (describe/it/expect) as long as there's no real syntax error —
            // that's tsc's default behavior without --noEmitOnError.
            const srcTs = h.path.join(d, 'source.ts');
            const testTs = h.path.join(d, 'source.test.ts');
            h.fs.writeFileSync(srcTs, src);
            h.fs.writeFileSync(testTs, tests);
            h.run('tsc', ['--target', 'es2022', '--module', 'commonjs', '--skipLibCheck', '--outDir', d, srcTs, testTs], { cwd: d, timeoutMs: 6000 });
            if (!h.fs.existsSync(sourceOut) || !h.fs.existsSync(testOut)) {
              return { inconclusive: true, reason: 'tsc did not emit JavaScript (a real syntax error, not just a missing test-framework type)' };
            }
          } else {
            // The tests require('./source') by convention (seeded samples all do
            // this) — write the SUT under that exact name rather than guessing.
            h.fs.writeFileSync(sourceOut, src);
            h.fs.writeFileSync(testOut, tests);
          }
          if (isJest) {
            // Jest runs source.js (required by source.test.js) in the SAME
            // worker process as the test framework itself, unlike mocha
            // (whose stdout goes empty when process.exit(0) fires mid-import,
            // which h.jsonOf then fails to parse -- correctly falling through
            // to the zero-tests inconclusive branch below) and vitest (whose
            // own environment traps process.exit and reports it as a test
            // FAILURE with a nonzero exit code) -- both confirmed already
            // safe against this by their own architecture. Jest is not:
            // confirmed exploitable with a hand-built repro where source.js
            // calls process.exit(0) right after module.exports (a genuinely
            // wrong implementation paired with this) crashes the worker
            // before source.test.js's own callback ever runs, and the
            // resulting jest output contains neither "no tests found" nor a
            // "Tests:" summary line at all for the zeroTests regex below to
            // catch, while the overall jest CLI still exits 0 -- a
            // confirmed false pass. setupFiles installs JS_PRELUDE's
            // process.exit trap (turning the call into a thrown error
            // instead) before jest requires source.js, closing this the
            // same way runWithTests/runCode already do for every other
            // category sharing this same worker-process shape.
            const preload = h.path.join(d, '__preload__.js');
            h.fs.writeFileSync(preload, h.JS_PRELUDE);
            // --rootDir/--testMatch alone still make jest search upward for a
            // config file and fail with "Could not find a config file" when it
            // finds none — an inline --config bypasses that discovery entirely.
            const jestConfig = JSON.stringify({ rootDir: d, testMatch: ['**/*.test.js'], setupFiles: [preload] });
            const r = h.run(bin, ['--config', jestConfig, '--silent', '--colors=false'], { cwd: d, timeoutMs: 8000 });
            const jestOut = String(r.stdout || '') + String(r.stderr || '');
            // Jest's own summary ALWAYS prints a "Snapshots:   0 total" line,
            // even on a fully passing run with a nonzero real test count --
            // a bare /0 total/ substring check matches that unconditionally,
            // confirmed to misreport every jest run (passing or not) as zero
            // tests collected. Anchored to the "Tests:" line specifically,
            // which is the one that actually reports the real test count.
            const zeroTests = /no tests found|Tests:\s*0 total/i.test(jestOut);
            if (zeroTests) return { inconclusive: true, reason: 'zero tests collected' };
            return { passed: r.status === 0, out: jestOut.slice(0, 1500) };
          } else if (isMocha) {
            // Plain exit-code checking is unsafe for mocha specifically: an
            // empty/no-op test file exits 0 with "0 passing", a silent false
            // pass for zero actual testing work. --reporter json gives a real
            // count to gate on instead of trusting the exit code alone.
            const r = h.run(bin, [testOut, '--reporter', 'json'], { cwd: d, timeoutMs: 8000 });
            const summary = h.jsonOf(r.stdout || '');
            const passes = summary && summary.stats ? Number(summary.stats.passes) || 0 : 0;
            const failures = summary && summary.stats ? Number(summary.stats.failures) || 0 : 0;
            if (passes === 0 && failures === 0) return { inconclusive: true, reason: 'zero tests collected' };
            return { passed: r.status === 0 && failures === 0 && passes > 0, out: String(r.stdout || r.stderr).slice(0, 1500) };
          } else {
            const r = h.run(bin, ['run', testOut], { cwd: d, timeoutMs: 8000 });
            const zeroTests = /no test (files|suite) found/i.test(String(r.stdout || '') + String(r.stderr || ''));
            if (zeroTests) return { inconclusive: true, reason: 'zero tests collected' };
            return { passed: r.status === 0, out: String(r.stdout || r.stderr).slice(0, 1500) };
          }
        };

        const first = runJs(source);
        if (first.inconclusive) {
          return { passed: false, logs: first.reason, detail: { framework: row.framework, zeroTests: true } };
        }
        if (!first.passed) return { passed: false, logs: first.out, detail: { framework: row.framework } };
        // Capped at 1 (not MAX_MUTANTS): each attempt is a full tsc compile
        // (TS) plus a real jest/mocha/vitest process spawn -- the most
        // expensive per-attempt cost in this file. At MAX_MUTANTS=3, the
        // worst case (four total attempts: the real source plus three
        // mutants -- and the worst case is exactly the scenario this check
        // exists to catch, a weak suite that survives every mutant tried,
        // so the loop never exits early) could sum to roughly 4x a single
        // attempt's own cost, well past the outer sandbox command budget
        // deployed at the time (30000ms; raised to 120000ms as of the
        // current deploy, infra/terraform/ssm.tf) even after the
        // per-call timeouts above were already reduced.
        const mt = mutationTest(source, language, (mutated) => runJs(mutated), 1);
        if (mt.ok === false) {
          return { passed: false, logs: 'generated_tests passed against every mutated variant tried -- does not appear to depend on source_code\'s real behavior', detail: { framework: row.framework, vacuousTests: true, mutantsTried: mt.tried } };
        }
        return { passed: true, logs: '', detail: { framework: row.framework, mutantsTried: mt.tried, mutationSkipped: !!mt.skipped } };
      }
      const runPlain = (src) => {
        const r = h.runWithTests(language, src, tests, 12000);
        if (r.unavailable) return { inconclusive: true, reason: (r.runtime || language) + ' not available' };
        return { passed: r.ok === true, out: String(r.stderr || '').slice(0, 1500) };
      };
      const first = runPlain(source);
      if (first.inconclusive) return { passed: false, runtimeUnavailable: true, logs: first.reason, detail: { framework: row.framework } };
      if (!first.passed) return { passed: false, logs: first.out, detail: { framework: row.framework } };
      // Capped at 1 (not MAX_MUTANTS): at the default 3, four total attempts
      // (the real source plus three mutants -- and again, a weak/vacuous
      // suite that never gets caught is exactly the worst case this check
      // exists to detect, not a rare edge case) at 12000ms each could sum to
      // 48000ms, well past the outer sandbox command budget deployed at the
      // time (30000ms; raised to 120000ms as of the current deploy,
      // infra/terraform/ssm.tf).
      const mt = mutationTest(source, language, (mutated) => runPlain(mutated), 1);
      if (mt.ok === false) {
        return { passed: false, logs: 'generated_tests passed against every mutated variant tried -- does not appear to depend on source_code\'s real behavior', detail: { framework: row.framework, vacuousTests: true, mutantsTried: mt.tried } };
      }
      return { passed: true, logs: '', detail: { framework: row.framework, mutantsTried: mt.tried, mutationSkipped: !!mt.skipped } };
    }

    if (language === 'go') {
      if (!h.have('go')) return { passed: false, runtimeUnavailable: true, logs: 'go not available', detail: { framework: row.framework } };
      // GOCACHE/GOPATH are created ONCE per row and shared across every
      // runGo() call below (original source + every mutant), not re-derived
      // from a fresh h.workdir() per call as before. Confirmed on real E2B
      // hardware: a genuinely cold GOCACHE (this sandbox's constrained 2
      // vCPU) takes ~8.6-11s just to compile the stdlib packages `testing`
      // pulls in, before running a single test — comfortably BLOWING the
      // previous per-call 8000ms timeout on the very first attempt (every Go
      // row observed failing with "spawnSync go ETIMEDOUT" on real E2B,
      // never a genuine test failure). A warm cache reduces the identical
      // compile+run cycle to ~100-200ms (also confirmed on real E2B) since
      // only the changed file — never the underlying stdlib — needs
      // recompiling; sharing one cache turns "cold every time" into "cold
      // once per row", independent of the timeout value chosen.
      const goCacheDir = h.path.join(h.workdir(), '.gocache');
      const goPathDir = h.path.join(h.workdir(), '.gopath');
      const runGo = (src, timeoutMs) => {
        const d = h.workdir();
        h.fs.writeFileSync(h.path.join(d, 'go.mod'), 'module m\n\ngo 1.22\n');
        h.fs.writeFileSync(h.path.join(d, 'sol.go'), src);
        h.fs.writeFileSync(h.path.join(d, 'sol_test.go'), tests);
        const r = h.run('go', ['test', '-v', './...'], {
          cwd: d, timeoutMs: timeoutMs,
          env: { HOME: d, GOCACHE: goCacheDir, GOPATH: goPathDir, GOFLAGS: '-mod=mod' },
        });
        const out = String(r.stdout || '') + String(r.stderr || '');
        // `go test` on a file with zero `func TestXxx` functions reports
        // "[no tests to run]" and still exits 0 — a silent false pass for a
        // test file that never actually tested anything. A build failure on
        // the MUTATED source (not the original, already-known-to-compile
        // source) says nothing about the tests -- inconclusive, not a catch.
        if (/\[no tests to run\]|no test files/i.test(out)) return { inconclusive: true, reason: 'zero tests collected' };
        if (/^# m$|build failed/im.test(out)) return { inconclusive: true, reason: 'mutant failed to build' };
        return { passed: r.status === 0, out };
      };
      // 20000ms (not 8000ms): the ONLY call that ever needs the cold-compile
      // budget above -- every mutant attempt below reuses the now-warm
      // goCacheDir/goPathDir and, confirmed on real E2B, completes in
      // ~100-200ms regardless of timeoutMs.
      const first = runGo(source, 20000);
      if (first.inconclusive) return { passed: false, logs: first.reason, detail: { framework: row.framework, zeroTests: true } };
      if (!first.passed) return { passed: false, logs: first.out.slice(0, 1500), detail: { framework: row.framework } };
      // Capped at 1 (not MAX_MUTANTS, and lower than the previous 2): with a
      // warm shared cache each mutant attempt is fast in practice, but the
      // 5000ms ceiling below is a safety bound against a genuinely hung
      // process, not the expected runtime -- kept to 1 attempt so the sum of
      // worst-case ceilings (20000 + 5000 = 25000ms) stays comfortably under
      // the outer sandbox command budget deployed at the time (30000ms;
      // raised to 120000ms as of the current deploy, infra/terraform/ssm.tf)
      // even if that bound were ever actually hit.
      const mt = mutationTest(source, 'go', (mutated) => runGo(mutated, 5000), 1);
      if (mt.ok === false) {
        return { passed: false, logs: 'generated_tests passed against every mutated variant tried -- does not appear to depend on source_code\'s real behavior', detail: { framework: row.framework, vacuousTests: true, mutantsTried: mt.tried } };
      }
      return { passed: true, logs: '', detail: { framework: row.framework, mutantsTried: mt.tried, mutationSkipped: !!mt.skipped } };
    }

    if (language === 'rust') {
      if (!h.have('rustc')) return { passed: false, runtimeUnavailable: true, logs: 'rustc not available', detail: { framework: row.framework } };
      if (!h.ensureRustToolchain()) return { passed: false, runtimeUnavailable: true, logs: 'rustc has no default toolchain', detail: { framework: row.framework } };
      const runRust = (src) => {
        const d = h.workdir();
        // generated_tests is a full `#[cfg(test)] mod tests { use super::*; ... }`
        // block, designed to sit alongside the source in one file — concatenate
        // rather than wrap, and let rustc's own --test harness drive it.
        h.fs.writeFileSync(h.path.join(d, 'lib.rs'), src + '\n\n' + tests);
        const c = h.run('rustc', ['--edition', '2021', '--test', h.path.join(d, 'lib.rs'), '-o', h.path.join(d, 'test_bin')], { cwd: d, timeoutMs: 8000 });
        if (c.status !== 0) return { inconclusive: true, reason: 'mutant failed to compile', compileFailed: true, out: String(c.stderr).slice(0, 1500) };
        const r = h.run(h.path.join(d, 'test_bin'), [], { cwd: d, timeoutMs: 5000 });
        // rustc's --test binary on a #[cfg(test)] block with zero #[test] fns
        // prints "running 0 tests ... test result: ok. 0 passed" and exits 0 —
        // a silent false pass for zero actual test cases.
        //
        // Gated on the "running N tests" line specifically, NOT on the
        // summary's "0 passed" count -- confirmed on real E2B that a single
        // #[test] fn which genuinely RAN and FAILED (a real assertion
        // mismatch, or exactly the "the suite caught this mutation" signal
        // mutation testing exists to detect) reports the IDENTICAL "0
        // passed" in its own summary line ("test result: FAILED. 0 passed;
        // 1 failed; ..."), which a bare /(\d+)\s+passed/ match cannot tell
        // apart from a genuinely empty test block. That previously
        // misclassified a real failure/catch as inconclusive (skipped, not
        // counted against OR for the suite) rather than the real, conclusive
        // result it actually was.
        const out = String(r.stdout || '') + String(r.stderr || '');
        const runningMatch = out.match(/running\s+(\d+)\s+tests?/);
        const testsRun = runningMatch ? Number(runningMatch[1]) : null;
        if (testsRun === 0) return { inconclusive: true, reason: 'zero #[test] cases actually ran' };
        // The "running N tests" header prints BEFORE any individual #[test]
        // fn executes, so testsRun !== 0 alone does not prove the run
        // actually finished -- unlike Go (whose own testing package already
        // intercepts os.Exit() during a test and turns it into a panic/
        // failure, confirmed on real E2B) and JS's process.exit (trapped via
        // JS_PRELUDE's setupFiles preload above), Rust's --test harness has
        // no equivalent guard against std::process::exit()/abort() called
        // from source_code itself. Confirmed exploitable on real E2B: a
        // source_code function whose ENTIRE body is `std::process::exit(0)`
        // (never computing or returning anything) reported passed:true here,
        // since "running 1 test" alone already satisfied testsRun !== 0 and
        // the whole test binary's own exit code was a legitimate 0 -- the
        // process died before ever reaching its own "test test_x ... ok"
        // line or final "test result: ..." summary, so nothing about the
        // test's real outcome was ever actually observed. Requiring that
        // summary line closes it: its absence means the binary terminated
        // mid-run, which is not evidence of a pass.
        if (testsRun !== null && !/test result: /i.test(out)) {
          return { passed: false, out: out + '\n[unit_test_gen] test binary exited before printing a final "test result: ..." summary -- likely process::exit()/abort() called from inside submission or test code' };
        }
        return { passed: r.status === 0, out };
      };
      const first = runRust(source);
      if (first.inconclusive) {
        return { passed: false, logs: first.compileFailed ? 'rustc:\n' + first.out : first.reason, detail: { framework: row.framework, compileFailed: !!first.compileFailed } };
      }
      if (!first.passed) return { passed: false, logs: first.out.slice(0, 1500), detail: { framework: row.framework } };
      // Capped at 1 (not MAX_MUTANTS): unlike Go's runGo() above, this
      // per-mutant rustc --test compile has no shared warm-cache mitigation
      // (rustc has no persistent incremental-compile cache equivalent to
      // GOCACHE wired up here), so each attempt still pays close to its full
      // 8000+5000ms ceiling in the worst case. At a cap of 2 (3 total
      // attempts including the real source) that would sum to 39000ms in
      // the worst case (a weak/vacuous suite surviving every mutant -- the
      // exact scenario this check exists to catch, not a rare edge case),
      // past the outer sandbox command budget deployed at the time
      // (30000ms; raised to 120000ms as of the current deploy,
      // infra/terraform/ssm.tf).
      const mt = mutationTest(source, 'rust', (mutated) => runRust(mutated), 1);
      if (mt.ok === false) {
        return { passed: false, logs: 'generated_tests passed against every mutated variant tried -- does not appear to depend on source_code\'s real behavior', detail: { framework: row.framework, vacuousTests: true, mutantsTried: mt.tried } };
      }
      return { passed: true, logs: '', detail: { framework: row.framework, mutantsTried: mt.tried, mutationSkipped: !!mt.skipped } };
    }

    return { passed: false, runtimeUnavailable: true, logs: 'unsupported language: ' + language, detail: { language } };
  },
};
