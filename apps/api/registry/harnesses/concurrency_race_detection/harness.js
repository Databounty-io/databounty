/**
 * fail-then-pass (Go real-race-detector flavor) -- concurrency_race_detection.
 *
 * THE CONTRACT: buggy_code is a complete, standalone Go program with a real,
 * unsynchronized concurrent access to shared state; fixed_code is the same
 * task implemented with real synchronization. Verified by actually compiling
 * and RUNNING both under `go run -race` -- Go's real ThreadSanitizer-derived
 * dynamic data-race detector -- never by static inspection of the source,
 * never by "run it a few times and eyeball whether the printed number looks
 * wrong". buggy_code must trigger a genuine `WARNING: DATA RACE` report on
 * at least one of up to 3 attempts; fixed_code must run clean (no race
 * reported) AND print exactly expected_functional_output on EVERY attempt
 * tried (up to 3), not merely one lucky run.
 *
 * ZERO LOCAL EXECUTION CAPABILITY ON THE AUTHORING HOST, DOCUMENTED HONESTLY:
 * this file was authored on a host with NO `go` binary on PATH at all (unlike
 * this project's other new categories, e.g. redis_data_structure_semantics,
 * which had a legitimate local stand-in -- fakeredis -- for redis-server;
 * there is no meaningful local stand-in for the Go compiler + race detector).
 * This is the same shape of constraint memory_safety's own harness.js was
 * authored under (no gcc/clang/valgrind locally either) -- see that file's
 * module doc comment and blind-tester/verify-memory_safety.mjs for the
 * precedent this project already established: every fact this file's logic
 * depends on (the exact `WARNING: DATA RACE` / exit-66 protocol, cgo's role,
 * the GOCACHE/GOPATH cold-start cost) is sourced from EITHER (a) go.dev's own
 * published race-detector documentation (https://go.dev/doc/articles/race_detector,
 * fetched and quoted below at each load-bearing point) or (b) this registry's
 * own already-proven-on-real-E2B-hardware Go execution code (helpers.js's
 * `runCode`'s `L === 'go'` branch, and unit_test_gen's own harness.js Go
 * branch, whose comments document concrete E2B timing measurements for a cold
 * vs warm GOCACHE) -- never guessed. E2B is the SOLE real gate for this
 * category; nothing here has been executed against a real Go toolchain by the
 * author. See the bottom of this file's PR description / task report for the
 * explicit, itemized list of what remains genuinely unverified pending real
 * E2B execution.
 *
 * THE WARNING: DATA RACE / EXIT-CODE-66 PROTOCOL, per go.dev/doc/articles/race_detector
 * (the "Options" section, fetched verbatim):
 *   - `log_path` (default `stderr`): "The race detector writes its report to
 *     a file named log_path._pid_. The special names stdout and stderr cause
 *     reports to be written to standard output and standard error,
 *     respectively." -- GORACE is never set by this harness, so the default
 *     (stderr) applies; the literal string is checked in stderr only, not
 *     stdout, matching this default.
 *   - `exitcode` (default `66`): "The exit status to use when exiting after a
 *     detected race."
 *   - `halt_on_error` (default `0`, i.e. off): the process does NOT stop at
 *     the first detected race by default -- goroutines keep running and
 *     main() runs to whatever completion it would otherwise reach -- but the
 *     race detector's runtime still forces the FINAL process exit status to
 *     `exitcode` (66) rather than whatever the program's own logic would
 *     have exited with, once at least one race was recorded during that
 *     run. This is exactly why BOTH signals (the literal `WARNING: DATA
 *     RACE` text in stderr, AND a non-zero final exit status) are checked
 *     together below, per this category's own design brief -- neither alone
 *     is as strong evidence as the pair: the text alone could in principle
 *     appear inside an unrelated string a submission itself prints (a
 *     residual explicitly not chased further, see ANTI-GAMING below, since
 *     requiring the pair already makes that specific forgery need a matching
 *     forged non-zero exit too), and a non-zero exit alone could be an
 *     ordinary unrelated panic/os.Exit(1) with nothing to do with a race.
 *   - False positives: the race detector is widely documented (Go team
 *     talks, go.dev's own FAQ) as having no known false positives -- a
 *     reported race is always a real one; the risk this category's retry
 *     logic exists for is a FALSE NEGATIVE (a real race that simply didn't
 *     manifest on a given scheduling), never a spurious report.
 *   - go.dev's own docs state races are only found "at runtime" for
 *     "code paths that are ... executed" -- i.e. detection is inherently
 *     probabilistic across goroutine-scheduling outcomes, not a static
 *     guarantee -- which is exactly why buggy_code gets up to 3 attempts
 *     (stopping at the first genuine detection) rather than being judged on
 *     one single run.
 *
 * CGO / TOOLCHAIN REQUIREMENT: go.dev's race detector docs and multiple
 * golang.org/x/website/golang.org/issue threads (fetched during authoring)
 * agree the race detector's runtime is a C library (ThreadSanitizer-derived)
 * linked in via cgo -- CGO_ENABLED=1 and a working C compiler are required on
 * non-Darwin platforms. `sandbox/runtimes.json` (probed 2026-08-07 against
 * the actually-published template, not assumed from the Dockerfile) already
 * lists BOTH `go` and `gcc` as present, and
 * infra/e2b/databounty-verify/template.ts installs gcc and go1.22.5 in the
 * same image -- so CGO_ENABLED should already autodetect to 1 here. Set
 * explicitly anyway (never left to autodetection) per this registry's
 * "probed, not assumed" discipline; see looksLikeRaceUnsupported below for
 * the defensive, environment-fault-routed fallback if this ever turns out
 * false on some future template rebuild.
 *
 * SHARED BUILD CACHE / TIMEOUT DISCIPLINE, reused verbatim from
 * unit_test_gen's own Go fix (its harness.js comment, itself confirmed
 * against real E2B hardware): a genuinely cold GOCACHE pays the real cost of
 * compiling the standard-library packages a program imports (measured there
 * at ~8.6-11s for `testing` alone) before running anything; a warm cache
 * (the SAME GOCACHE/GOPATH directory reused across every `go run` call this
 * verify() makes) reduces a repeat compile+run to ~100-200ms. `-race` adds
 * REAL, DOCUMENTED overhead beyond a plain build on top of that baseline (a
 * race-instrumented rebuild of every stdlib package actually imported, plus
 * cgo-linking the ThreadSanitizer-derived runtime) -- this file cannot
 * measure that overhead directly (no local Go toolchain), so the FIRST call
 * of this verify() invocation is budgeted more generously than
 * unit_test_gen's own already-generous 20000ms first-call figure (see
 * GO_RACE_FIRST_TIMEOUT_MS below), and every subsequent call reuses the by
 * -then-warm cache under a materially smaller, still-generous budget.
 *
 * TIMEOUT BUDGET ARITHMETIC: up to MAX_BUGGY_ATTEMPTS (3) buggy attempts
 * (stopping early on the first genuine race detection) plus up to
 * MAX_FIXED_ATTEMPTS (3) fixed attempts (stopping early on the first
 * failure) -- worst case that still returns a real verdict is 3+3=6 calls:
 * one at GO_RACE_FIRST_TIMEOUT_MS (25000ms) plus five at
 * GO_RACE_WARM_TIMEOUT_MS (10000ms) = 25000 + 50000 = 75000ms, comfortably
 * under the outer sandbox command budget (120000ms,
 * infra/terraform/ssm.tf's EXECUTION_RUNNER_TIMEOUT_MS, duplicated in
 * helpers.js as OUTER_SANDBOX_BUDGET_MS) with roughly 45000ms of margin left
 * for process/file-IO overhead (spawning node, writing source files,
 * JSON-encoding the verdict) -- the same "stay strictly under the outer
 * budget, with an explicit documented margin" discipline this registry
 * already enforces everywhere else (helpers.js's own
 * MAX_COMPILE_PLUS_RUN_MS/SANDBOX_OVERHEAD_MARGIN_MS comments,
 * redis_data_structure_semantics's own TIMEOUT_MS comment). Both retry loops
 * exit EARLY as soon as sufficient evidence is gathered (a genuine race on
 * the buggy side; any disqualifying outcome on the fixed side) rather than
 * always running the maximum -- the 75000ms figure is a worst case, not the
 * expected common case.
 *
 * GOMAXPROCS=4: explicitly set (rather than left at the sandbox's own
 * default core count) to maximize real OS-thread-level parallelism available
 * to the Go scheduler during each run -- the race detector can only report a
 * race it actually OBSERVES during one execution (per go.dev, races are
 * found "at runtime" only for code paths actually exercised), so more real
 * parallelism raises, and never lowers, the odds that two goroutines are
 * genuinely executing concurrently at the instant they touch the same
 * unsynchronized memory. 4 is deliberately modest, not maximal: this
 * authoring host cannot confirm the real sandbox's own vCPU allotment, and
 * redis_data_structure_semantics's own harness.js doc comment separately
 * notes "this sandbox's constrained 2 vCPU" for at least one observed E2B
 * configuration -- GOMAXPROCS may legitimately request more logical
 * processors than there are physical cores; Go's M:N scheduler multiplexes
 * goroutines onto OS threads regardless and handles this safely either way,
 * it is purely a hint, never a hard requirement.
 *
 * ANTI-GAMING RESIDUAL, EXPLICITLY NOT FULLY CLOSEABLE HERE (documented, not
 * chased further -- the same honest-residual convention this registry uses
 * throughout, e.g. memory_safety's ASan-log-forgery residual,
 * redis_data_structure_semantics's "late writer" residual): `-race` reports
 * ANY race anywhere in the program's actual execution, not specifically "the
 * one the task_description describes". A buggy_code file with an accidental,
 * task-irrelevant race (e.g. a stray unsynchronized debug counter that has
 * nothing to do with the described shared-state bug) would still satisfy
 * step 1 of this contract. This is inherent to how a dynamic race detector
 * works and cannot be closed at the harness level without static analysis
 * of WHICH memory location raced and whether it matches the described task
 * -- a materially harder, more fragile check this pass does not attempt. The
 * mitigation is dataset-AUTHORING discipline, not verification-time logic:
 * keep every row's buggy_code a minimal, single-race, textbook-unambiguous
 * shape (one shared variable, one missing synchronization primitive),
 * mirroring memory_safety's own documented "one bug class per program, no
 * plausible alternate finding" convention -- schema.json's own buggy_code
 * help text states this explicitly for dataset curators.
 *
 * SECOND RESIDUAL, SPECIFIC TO ONE TASK SHAPE (map-based races), NOT
 * EMPIRICALLY CONFIRMED HERE: an unsynchronized concurrent map write is a bug
 * shape Go's OWN runtime independently guards against (a built-in
 * "fatal error: concurrent map writes"/"concurrent map read and map write"
 * check, unrelated to -race, present even in a non-race build) -- multiple
 * secondary sources (fetched during authoring; no local Go toolchain to
 * confirm directly) describe the race detector's own WARNING: DATA RACE as
 * USUALLY winning that race and printing first when running under -race, but
 * this was not found stated as an unconditional, 100%-of-the-time guarantee
 * in go.dev's own primary documentation -- if the runtime's built-in fatal
 * crash were ever observed firing on a given attempt WITHOUT the detector
 * also having recorded/printed WARNING: DATA RACE first, that attempt would
 * read as inconclusive here (not a match for raceWarningPresent), silently
 * costing one of buggy_code's 3 attempts rather than counting as evidence.
 * Mitigated the same way as the general residual above -- dataset-authoring
 * discipline: prefer non-map shared-state shapes for buggy_code (a shared
 * counter, a shared slice/array index, a shared struct field) wherever the
 * task allows, since those have no competing runtime-level detector to race
 * against -race's own report. A map-based row is not rejected outright by
 * this harness (doing so would need language-level static analysis this
 * pass does not attempt), just flagged here as carrying elevated,
 * unconfirmed risk relative to the other shapes.
 */
'use strict';

var GO_RACE_FIRST_TIMEOUT_MS = 25000;
var GO_RACE_WARM_TIMEOUT_MS = 10000;
var MAX_BUGGY_ATTEMPTS = 3;
var MAX_FIXED_ATTEMPTS = 3;

/** Cheap, no-compiler-needed structural sanity: is this even a shape that
 * COULD be a complete standalone Go program? Catches an obviously malformed
 * row (a bare snippet, not a full program) before spending a `go run -race`
 * attempt on it. Not a substitute for real compilation -- just avoids
 * wasting timeout budget on rows the schema itself already promises won't
 * compile as a standalone program. */
function hasCompleteGoProgramShape(code) {
  var s = String(code || '');
  return /\bpackage\s+main\b/.test(s) && /\bfunc\s+main\s*\(\s*\)/.test(s);
}

function raceWarningPresent(text) {
  return /WARNING:\s*DATA RACE/.test(String(text || ''));
}

/** Distinguishes a genuine Go COMPILE error (source-level defect, always
 * reproducible, no point retrying) from a runtime race report or an
 * unrelated runtime crash. `# command-line-arguments` is the header `go
 * build`/`go run` prints for an ad hoc (non-module) single-file package's
 * own compile diagnostics; `file.go:LINE:COL: ` (three colon-delimited
 * parts, trailing a space before the message) is the Go compiler's own
 * per-diagnostic line format. Deliberately distinct from a race report's OWN
 * stack-trace lines (`  /tmp/x/main.go:12 +0x1a4` -- file:LINE then a space
 * and a hex offset, no second colon/column/message) so a genuine race
 * report's embedded file:line references are never misread as a compile
 * error. Checked only when raceWarningPresent is false, as an extra
 * safety margin on top of that structural distinction. */
function looksLikeGoCompileError(stderrText) {
  var s = String(stderrText || '');
  if (raceWarningPresent(s)) return false;
  return /^# command-line-arguments/m.test(s) || /\.go:\d+:\d+:\s/.test(s);
}

/** Environment/toolchain fault (this sandbox's go cannot run -race at all),
 * never a contributor defect -- routed to runtimeUnavailable. Expected to
 * never fire in practice (gcc + go both confirmed present in the published
 * template, sandbox/runtimes.json), kept as a defensive fallback only. */
function looksLikeRaceUnsupported(stderrText) {
  var s = String(stderrText || '');
  return /-race is only supported on|race detector requires cgo|cgo:\s*C compiler[^\n]*not found|flag provided but not defined:\s*-race|unrecognized (command.line )?option[^\n]*-race|CGO_ENABLED=0/i.test(s);
}

module.exports = {
  contract: 'fail-then-pass',
  requires: ['go'],

  verify(row, h) {
    var taskDescription = h.str(row, 'task_description');
    var buggyCode = h.str(row, 'buggy_code');
    var fixedCode = h.str(row, 'fixed_code');
    var expectedOutput = h.str(row, 'expected_functional_output');

    if (!taskDescription.trim() || !buggyCode.trim() || !fixedCode.trim() || !expectedOutput.trim()) {
      // brokenCodeFailedTests must still be a boolean here, not omitted: the
      // schema declares a `buggy_code` field, so the contract layer
      // (executionContractPassed in src/services/execution-providers/contract.ts)
      // treats an undefined value as a harness fault ("all_providers_failed" /
      // "harness omitted the required broken-code assertion") rather than a
      // clean reject. false because buggy_code's intended failure mode (a
      // genuine, detector-confirmed data race) was never demonstrated --
      // execution never even started. Same convention as debugging/harness.js.
      return { passed: false, brokenCodeFailedTests: false, detail: { reason: 'missing task_description, buggy_code, fixed_code, or expected_functional_output' } };
    }
    if (!hasCompleteGoProgramShape(buggyCode)) {
      return {
        passed: false,
        brokenCodeFailedTests: false,
        logs: 'buggy_code is not a complete standalone Go program (missing "package main" or "func main()") -- this category requires a full program, never a snippet',
        detail: { reason: 'buggy_code_not_standalone' },
      };
    }
    if (!hasCompleteGoProgramShape(fixedCode)) {
      return {
        passed: false,
        brokenCodeFailedTests: false,
        logs: 'fixed_code is not a complete standalone Go program (missing "package main" or "func main()") -- this category requires a full program, never a snippet',
        detail: { reason: 'fixed_code_not_standalone' },
      };
    }

    if (!h.have('go')) {
      return { passed: false, runtimeUnavailable: true, logs: 'go not available in sandbox', detail: { reason: 'no_go' } };
    }

    // GOCACHE/GOPATH created ONCE per row (two independent h.workdir() calls,
    // matching unit_test_gen's own runGo() pattern verbatim) and shared
    // across EVERY `go run -race` call below, buggy and fixed alike -- see
    // module doc comment (SHARED BUILD CACHE). HOME is set fresh per call
    // below (to that call's own workdir), also matching that precedent.
    var goCacheDir = h.path.join(h.workdir(), '.gocache');
    var goPathDir = h.path.join(h.workdir(), '.gopath');

    /** Compile+run one complete Go program under -race in its own fresh
     * workdir (source file only -- never a go.mod, matching helpers.js's own
     * runCode `L === 'go'` branch: a single ad hoc file with stdlib-only
     * imports builds fine without one), sharing the row-wide GOCACHE/GOPATH
     * above. Returns a normalized outcome the two retry loops below both
     * consume identically. */
    function runGoRace(code, timeoutMs) {
      var d = h.workdir();
      var f = h.path.join(d, 'main.go');
      h.fs.writeFileSync(f, code);
      var r = h.run('go', ['run', '-race', f], {
        cwd: d,
        timeoutMs: timeoutMs,
        env: {
          HOME: d,
          GOCACHE: goCacheDir,
          GOPATH: goPathDir,
          GOFLAGS: '-mod=mod',
          CGO_ENABLED: '1',
          GOMAXPROCS: '4',
        },
      });
      // rawStdout/rawStderr (uncapped) -- see helpers.js's OUT_CAP comment:
      // a verbose race report (a full multi-goroutine stack trace) must not
      // have the literal WARNING text truncated away by the report-bounding
      // cap applied to the plain stdout/stderr fields.
      var stdoutText = String((r.rawStdout != null ? r.rawStdout : r.stdout) || '');
      var stderrText = String((r.rawStderr != null ? r.rawStderr : r.stderr) || '');
      return {
        timedOut: !!r.timedOut,
        status: r.status,
        stdout: stdoutText,
        stderr: stderrText,
        // BOTH signals required together -- see module doc comment's
        // WARNING: DATA RACE / EXIT-CODE-66 PROTOCOL section for why neither
        // alone is treated as sufficient.
        raceDetected: raceWarningPresent(stderrText) && r.status !== 0,
        compileFailed: looksLikeGoCompileError(stderrText),
        raceUnsupported: looksLikeRaceUnsupported(stderrText),
      };
    }

    // ---- Step 1: buggy_code must show a real race within up to 3 attempts ----
    var buggyEvidence = null;
    var buggyAttempts = [];
    for (var i = 0; i < MAX_BUGGY_ATTEMPTS; i++) {
      var bTimeout = i === 0 ? GO_RACE_FIRST_TIMEOUT_MS : GO_RACE_WARM_TIMEOUT_MS;
      var bRes = runGoRace(buggyCode, bTimeout);
      buggyAttempts.push({ attempt: i + 1, raceDetected: bRes.raceDetected, status: bRes.status, timedOut: bRes.timedOut, compileFailed: bRes.compileFailed });

      // Toolchain-level fault is deterministic across attempts -- checked
      // once, on the first attempt, rather than repeated.
      if (i === 0 && bRes.raceUnsupported) {
        return {
          passed: false,
          runtimeUnavailable: true,
          logs: 'this sandbox\'s go toolchain could not run -race (cgo/C-compiler unavailable) -- an environment fault, not a contributor defect',
          detail: { reason: 'race_unsupported', stderr: bRes.stderr.slice(0, 500), attempts: buggyAttempts },
        };
      }
      // A source-level compile error is deterministic given identical
      // source -- no point burning the remaining attempts against it.
      if (bRes.compileFailed) {
        return {
          passed: false,
          // false: a compile error means buggy_code never even ran, so its
          // intended failure mode (a genuine, detector-confirmed data race)
          // was never demonstrated.
          brokenCodeFailedTests: false,
          logs: 'buggy_code failed to compile: ' + bRes.stderr.slice(0, 1500),
          detail: { reason: 'buggy_code_compile_failed', attempt: i + 1, attempts: buggyAttempts },
        };
      }
      if (bRes.raceDetected) {
        buggyEvidence = bRes;
        break; // one genuine detection is sufficient proof -- stop early
      }
      // A timeout, or a clean/non-race-nonzero run, is INCONCLUSIVE for this
      // one attempt (goroutine scheduling is inherently non-deterministic --
      // see module doc comment) -- simply move on to the next attempt.
    }

    if (!buggyEvidence) {
      return {
        passed: false,
        // false: 3 attempts exhausted with no detector-confirmed race ever
        // observed -- buggy_code's intended failure mode was never
        // demonstrated.
        brokenCodeFailedTests: false,
        logs: 'go run -race did not report a data race against buggy_code in ' + MAX_BUGGY_ATTEMPTS + ' attempts -- this row\'s "buggy" code is not reliably racy (a real dataset defect, not detector flakiness: the race detector has no known false positives, only false negatives, so repeated non-detection across independent attempts is real evidence, not noise)',
        detail: { reason: 'buggy_code_no_race_detected', attempts: buggyAttempts },
      };
    }

    // ---- Step 2: fixed_code must be race-free AND output-correct on EVERY attempt ----
    var expectedTrimmed = expectedOutput.trim();
    var fixedAttempts = [];
    for (var j = 0; j < MAX_FIXED_ATTEMPTS; j++) {
      // GOCACHE/GOPATH are already warm from step 1's own calls -- every
      // fixed-side attempt uses the smaller, warm-cache budget.
      var fRes = runGoRace(fixedCode, GO_RACE_WARM_TIMEOUT_MS);
      var attemptDetail = { attempt: j + 1, raceDetected: fRes.raceDetected, status: fRes.status, timedOut: fRes.timedOut, compileFailed: fRes.compileFailed };
      fixedAttempts.push(attemptDetail);

      // brokenCodeFailedTests: true on every return path below (including
      // the final success) -- by this point buggyEvidence (a genuine,
      // detector-confirmed WARNING: DATA RACE with a matching non-zero exit)
      // has already been confirmed against buggy_code, above. "Broken code
      // correctly failed" (i.e. correctly demonstrated the race) is true
      // regardless of what fixed_code does afterward.
      if (fRes.compileFailed) {
        return {
          passed: false,
          brokenCodeFailedTests: true,
          logs: 'fixed_code failed to compile: ' + fRes.stderr.slice(0, 1500),
          detail: { reason: 'fixed_code_compile_failed', attempt: j + 1, attempts: fixedAttempts },
        };
      }
      if (fRes.timedOut) {
        return {
          passed: false,
          brokenCodeFailedTests: true,
          logs: 'fixed_code (attempt ' + (j + 1) + ') did not complete within the time budget under -race -- possibly a deadlock introduced by the synchronization fix (e.g. a double-lock, or a channel with no reader)',
          detail: { reason: 'fixed_code_timed_out', attempt: j + 1, attempts: fixedAttempts },
        };
      }
      if (fRes.raceDetected) {
        return {
          passed: false,
          brokenCodeFailedTests: true,
          logs: 'go run -race reported a data race against fixed_code on attempt ' + (j + 1) + ' -- fixed_code is not actually race-free: ' + fRes.stderr.slice(0, 1000),
          detail: { reason: 'fixed_code_still_racy', attempt: j + 1, attempts: fixedAttempts },
        };
      }
      if (fRes.status !== 0) {
        return {
          passed: false,
          brokenCodeFailedTests: true,
          logs: 'fixed_code (attempt ' + (j + 1) + ') exited with a non-zero, non-race status (' + fRes.status + ') -- a genuine runtime error, not a race: ' + fRes.stderr.slice(0, 1000),
          detail: { reason: 'fixed_code_runtime_error', attempt: j + 1, attempts: fixedAttempts },
        };
      }
      var actualOutput = fRes.stdout.trim();
      if (actualOutput !== expectedTrimmed) {
        return {
          passed: false,
          brokenCodeFailedTests: true,
          logs: 'fixed_code (attempt ' + (j + 1) + ') stdout does not match expected_functional_output -- actual: ' + JSON.stringify(actualOutput.slice(0, 300)) + ', expected: ' + JSON.stringify(expectedTrimmed.slice(0, 300)),
          detail: { reason: 'fixed_code_output_mismatch', attempt: j + 1, attempts: fixedAttempts },
        };
      }
      attemptDetail.outputMatched = true;
    }

    return {
      passed: true,
      score: 1,
      // true: buggyEvidence (a genuine, detector-confirmed race against
      // buggy_code) was confirmed above, and every fixed_code attempt in the
      // loop just above also passed cleanly.
      brokenCodeFailedTests: true,
      logs: '',
      detail: {
        reason: 'ok',
        buggyAttempts: buggyAttempts,
        fixedAttempts: fixedAttempts,
      },
    };
  },
};
