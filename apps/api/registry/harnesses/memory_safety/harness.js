/**
 * dynamic-analysis claim-vs-reality — compile+run the row's C program under
 * the named tool (Valgrind memcheck or AddressSanitizer), extract the real
 * finding, and judge whether expected_findings truthfully characterizes it.
 *
 * expected_findings mixes a literal, quotable tool-output fragment (e.g.
 * "definitely lost: 400 bytes in 1 blocks") with paraphrase/inference (e.g.
 * ", allocated in process()", which comes from the backtrace, not the
 * summary line) — so this is a fact-presence match against parsed real
 * output, never a whole-string comparison.
 *
 * FLAWED: convention (same family as vulnerability/build_dependency_resolution)
 * — a handful of rows prefix expected_findings with "FLAWED:" to mark a
 * deliberately inaccurate reference claim. Per that convention, such rows
 * are rejected immediately without trying to verify the embedded
 * self-refutation text itself — simpler and more reliable than generic
 * semantic-flaw detection.
 *
 * The real finding is read from the ANALYSIS TOOL'S OWN dedicated report
 * channel, never from the target program's stdout/stderr. Both Valgrind and
 * AddressSanitizer support redirecting their own diagnostic output to a
 * file separate from the target program's -- `--log-file=` for Valgrind (an
 * external process wrapping the target, so the target binary has no
 * built-in way to introspect Valgrind's own CLI flags and thus cannot know
 * this path at all), and ASAN_OPTIONS=log_path= for ASan (whose runtime is
 * linked INTO the target binary, so the target CAN read the path back via
 * getenv -- a real but meaningfully higher bar than the one-line printf that
 * this closes; see the exitedAbnormally cross-check below). Earlier this
 * category read stdout+stderr directly, which the target program's OWN
 * printf/fprintf calls also write to -- a single hardcoded print of a fake
 * "AddressSanitizer: heap-use-after-free" (or a fake Valgrind leak summary)
 * line, needing no real bug at all, was accepted as truthful. Confirmed
 * exploitable against this exact prior logic.
 */
'use strict';

const ASAN_CATEGORIES = [
  'heap-use-after-free',
  'heap-buffer-overflow',
  'global-buffer-overflow',
  'stack-buffer-overflow',
  'stack-use-after-return',
  'stack-use-after-scope',
  'double-free',
  // LeakSanitizer is bundled with AddressSanitizer by default on Linux, and
  // its trailing report line ("N byte(s) leaked in M allocation(s)")
  // contains "leak" as a literal substring, so this needs no separate regex
  // -- without this entry, a truthful leak claim against a real ASan/LSan
  // leak report had no category to match at all and was always rejected.
  'leak',
];

function detectRealAsanCategory(output) {
  const s = String(output || '');
  if (!/AddressSanitizer/i.test(s)) return 'clean';
  const low = s.toLowerCase();
  for (const cat of ASAN_CATEGORIES) {
    if (low.includes(cat)) return cat;
  }
  return 'unknown';
}

function claimIsCleanAsan(text) {
  return /clean run|no errors/i.test(String(text || ''));
}

function claimAsanCategories(text) {
  const low = String(text || '').toLowerCase();
  return ASAN_CATEGORIES.filter((cat) => low.includes(cat));
}

/** Row 14 hedges with "stack-use-after-return (or stack-use-after-scope)" —
 * both tokens are extracted as acceptable real outcomes for that claim.
 *
 * exitedAbnormally is required for any non-clean category: every category
 * ASan reports here is a hard error its runtime aborts the process for --
 * a claimed non-clean category paired with a clean (status 0) exit is
 * self-contradictory and cannot be genuine ASan output, regardless of what
 * the (trusted, log-file-sourced) realCategory text otherwise says. This is
 * the second layer against a contributor who reads ASAN_OPTIONS' log_path
 * back via getenv() and hand-writes a fabricated report there: forging a
 * plausible report file AND a matching abnormal exit is a materially higher
 * bar than the original one-line-printf forgery this fix primarily closes,
 * and is accepted as a residual (chasing full report-structure validation
 * — canonical ==PID== framing, a real backtrace — is disproportionate
 * against that narrower, more exotic threat). */
function asanClaimMatchesReal(claimText, realCategory, exitedAbnormally) {
  if (claimIsCleanAsan(claimText)) return realCategory === 'clean';
  if (realCategory === 'clean') return false;
  if (!exitedAbnormally) return false;
  const cats = claimAsanCategories(claimText);
  if (!cats.length) return false;
  return cats.includes(realCategory);
}

function parseValgrindReal(logText) {
  const s = String(logText || '');
  if (/All heap blocks were freed -- no leaks are possible/i.test(s)) {
    return { clean: true, bytes: 0, blocks: 0, allocFunc: null };
  }
  const m = s.match(/definitely lost:\s*([\d,]+)\s*bytes? in\s*(\d+)\s*blocks?/i);
  const bytes = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
  const blocks = m ? parseInt(m[2], 10) : null;
  // Function name comes from the backtrace under "... are definitely lost in
  // loss record N of M", not from the LEAK SUMMARY line itself — the first
  // "by 0x...: <func> (file:line)" frame after that header is the direct
  // caller of malloc, i.e. the allocating function.
  let allocFunc = null;
  const idx = s.search(/definitely lost in loss record/i);
  if (idx !== -1) {
    const tail = s.slice(idx, idx + 1500);
    const fm = tail.match(/by 0x[0-9A-Fa-f]+:\s*([A-Za-z_]\w*)\s*\(/);
    if (fm) allocFunc = fm[1];
  }
  return { clean: bytes === 0, bytes, blocks, allocFunc };
}

/** Some claims deliberately elide the byte count ("bytes for exactly N
 * blocks") because true struct-padding size is platform-dependent — those
 * are checked on block count only, never a byte number that isn't present. */
function parseValgrindClaim(text) {
  const s = String(text || '');
  if (/no leaks? possible/i.test(s) || (/no leaks/i.test(s) && /freed/i.test(s))) {
    return { clean: true };
  }
  let m = s.match(/definitely lost:\s*([\d,]+)\s*bytes? in\s*(\d+)\s*blocks?/i);
  if (m) return { bytes: parseInt(m[1].replace(/,/g, ''), 10), blocks: parseInt(m[2], 10) };
  m = s.match(/bytes for exactly\s*(\d+)\s*blocks?/i);
  if (m) return { blocks: parseInt(m[1], 10), bytesElided: true };
  return {};
}

function valgrindClaimMatchesReal(claimText, real) {
  const claim = parseValgrindClaim(claimText);
  if (claim.clean) return real.clean === true;
  if (real.clean) return false;
  if (typeof claim.blocks !== 'number' && typeof claim.bytes !== 'number') return false;
  if (typeof claim.blocks === 'number' && claim.blocks !== real.blocks) return false;
  if (typeof claim.bytes === 'number' && claim.bytes !== real.bytes) return false;
  const fm = claimText.match(/\b([A-Za-z_]\w*)\(\)/);
  if (fm && real.allocFunc && fm[1] !== real.allocFunc) return false;
  return true;
}

/** Concatenate every file in `dir` whose name is or starts with `prefix.` —
 * the sanitizer's own log-file convention (ASan appends ".<pid>"; a fixed
 * literal Valgrind --log-file has no suffix at all). Missing entirely means
 * the tool never emitted a report (a clean run), not an error — swallow. */
function readSanitizerLog(h, dir, prefix) {
  let names;
  try { names = h.fs.readdirSync(dir); } catch (e) { return ''; }
  let out = '';
  for (const name of names) {
    if (name === prefix || name.indexOf(prefix + '.') === 0) {
      try { out += h.fs.readFileSync(h.path.join(dir, name), 'utf8') + '\n'; } catch (e) { /* ignore */ }
    }
  }
  return out;
}

module.exports = {
  contract: 'dynamic-analysis-claim-vs-reality',
  // gcc is unconditional (both the Valgrind and ASan paths compile with it).
  // valgrind/clang are NOT listed here even though the harness uses them:
  // which one a row needs is decided dynamically by `analysis_tool` (mirrors
  // how build_dependency_resolution/dependency_vuln_audit keep their
  // per-ecosystem tools out of the static array) and self-checked below via
  // h.have() -- declaring valgrind here would route every AddressSanitizer
  // row to manual review too whenever valgrind alone happened to be absent.
  requires: ['gcc'],

  verify(row, h) {
    const code = h.str(row, 'code');
    const language = h.str(row, 'language');
    const tool = h.str(row, 'analysis_tool');
    const findings = h.str(row, 'expected_findings');

    if (!code || !language || !tool || !findings) {
      return { passed: false, detail: { reason: 'missing code, language, analysis_tool, or expected_findings' } };
    }
    if (h.normLang(language) !== 'c') {
      return { passed: false, runtimeUnavailable: true, logs: `unsupported language "${language}" -- only C is verified`, detail: { language } };
    }

    if (/FLAWED:/i.test(findings)) {
      return {
        passed: false,
        logs: 'expected_findings is marked FLAWED — deliberately inaccurate reference claim',
        detail: { flawed: true },
      };
    }

    const isValgrind = /valgrind/i.test(tool);
    const isAsan = /addresssanitizer|address sanitizer|\basan\b/i.test(tool);
    if (!isValgrind && !isAsan) {
      return { passed: false, logs: `unrecognized analysis_tool: ${tool}`, detail: {} };
    }
    if (!h.have('gcc')) return { passed: false, runtimeUnavailable: true, logs: 'gcc not available', detail: {} };
    if (isValgrind && !h.have('valgrind')) {
      return { passed: false, runtimeUnavailable: true, logs: 'valgrind not available', detail: {} };
    }

    const d = h.workdir();
    const src = h.path.join(d, 'test.c');
    h.fs.writeFileSync(src, code);
    const bin = h.path.join(d, 'test');

    if (isAsan) {
      const compile = h.run('gcc', ['-g', '-O0', '-fsanitize=address', '-Wno-error=implicit-function-declaration', '-o', bin, src], { cwd: d, timeoutMs: 30000 });
      if (compile.status !== 0) {
        // "unrecognized command line option"/"unknown sanitizer" is gcc's own
        // argument parser rejecting a flag it doesn't understand -- a
        // toolchain/environment defect (this gcc build lacks ASan support),
        // structurally distinct from a source-level compile error in the
        // contributor's own code, and should not be scored against them.
        if (/unrecognized (command.line )?option|unknown sanitizer|unsupported.*-fsanitize/i.test(compile.stderr || '')) {
          return { passed: false, runtimeUnavailable: true, logs: 'gcc build lacks AddressSanitizer support', detail: { compileStderr: compile.stderr } };
        }
        return { passed: false, logs: 'compile failed', detail: { compileStderr: compile.stderr } };
      }

      const logPrefix = 'db_asan_log';
      // detect_stack_use_after_return is not always on by default — needed
      // for row 14's dangling-stack-pointer case to reliably fire rather
      // than "working" by undefined-behavior luck. log_path redirects
      // ASan's OWN report to a file the target's stdout/stderr never touch.
      let runRes = h.run(bin, [], {
        cwd: d,
        timeoutMs: 15000,
        env: { ASAN_OPTIONS: 'detect_stack_use_after_return=1:log_path=' + h.path.join(d, logPrefix) },
      });
      if (runRes.timedOut) {
        return { passed: false, runtimeUnavailable: true, logs: 'target program timed out under AddressSanitizer', detail: {} };
      }
      let logContent = readSanitizerLog(h, d, logPrefix);
      let realCategory = detectRealAsanCategory(logContent);
      let exitedAbnormally = runRes.status !== 0;
      let usedClang = false;

      // GCC's libasan does not implement the "fake stack" mechanism that
      // stack-use-after-return detection needs — ASAN_OPTIONS=
      // detect_stack_use_after_return=1 is a silent no-op under gcc, and the
      // dangling pointer read just crashes as a raw, undiagnosed SEGV
      // instead of a reported "stack-use-after-return". Only fall back to
      // clang (if present) for exactly this claim shape, so the 13 other
      // ASan rows — already correctly diagnosed by gcc — keep using it. Not
      // gated on any specific crash-text pattern: an undiagnosed crash can
      // manifest with no report text at all, and the retry is safe/cheap
      // either way since the trusted log-file check below still governs the
      // actual verdict regardless of why the primary attempt came up unknown.
      const claimsStackUseAfter = /stack-use-after-return|stack-use-after-scope/i.test(findings);
      if (claimsStackUseAfter && realCategory === 'unknown' && h.have('clang')) {
        const bin2 = h.path.join(d, 'test_clang');
        const logPrefix2 = 'db_asan_log2';
        const compile2 = h.run('clang', ['-g', '-O0', '-fsanitize=address', '-Wno-error=implicit-function-declaration', '-o', bin2, src], { cwd: d, timeoutMs: 30000 });
        if (compile2.status === 0) {
          const runRes2 = h.run(bin2, [], {
            cwd: d,
            timeoutMs: 15000,
            env: { ASAN_OPTIONS: 'detect_stack_use_after_return=1:log_path=' + h.path.join(d, logPrefix2) },
          });
          if (!runRes2.timedOut) {
            const logContent2 = readSanitizerLog(h, d, logPrefix2);
            const realCategory2 = detectRealAsanCategory(logContent2);
            if (realCategory2 !== 'unknown') {
              runRes = runRes2;
              logContent = logContent2;
              realCategory = realCategory2;
              exitedAbnormally = runRes2.status !== 0;
              usedClang = true;
            }
          }
        }
      }

      // Still unresolved after the clang retry (or clang unavailable/failed):
      // an environment/toolchain limitation, not evidence the claim is false.
      if (claimsStackUseAfter && realCategory === 'unknown') {
        return {
          passed: false,
          runtimeUnavailable: true,
          logs: 'stack-use-after-return could not be reliably diagnosed in this sandbox (gcc lacks fake-stack support, clang unavailable/inconclusive)',
          detail: { realCategory },
        };
      }

      const matches = asanClaimMatchesReal(findings, realCategory, exitedAbnormally);
      return {
        passed: matches,
        logs: matches ? '' : `expected_findings does not match real ASan result (real: ${realCategory})`,
        detail: {
          tool: usedClang ? 'asan (clang, gcc fake-stack unsupported)' : 'asan',
          realCategory,
          exitedAbnormally,
          exitStatus: runRes.status,
          stdout: (runRes.stdout || '').slice(0, 500),
          stderr: (runRes.stderr || '').slice(0, 500),
          sanitizerLog: logContent.slice(0, 1000),
        },
      };
    }

    const compile = h.run('gcc', ['-g', '-O0', '-Wno-error=implicit-function-declaration', '-Wno-implicit-function-declaration', '-o', bin, src], { cwd: d, timeoutMs: 30000 });
    if (compile.status !== 0) {
      return { passed: false, logs: 'compile failed', detail: { compileStderr: compile.stderr } };
    }
    const logFile = h.path.join(d, 'valgrind_log.txt');
    const runRes = h.run('valgrind', ['--leak-check=full', '--error-exitcode=99', '--log-file=' + logFile, bin], { cwd: d, timeoutMs: 20000 });
    if (runRes.timedOut) {
      return { passed: false, runtimeUnavailable: true, logs: 'target program timed out under Valgrind', detail: {} };
    }
    let logContent = '';
    try { logContent = h.fs.readFileSync(logFile, 'utf8'); } catch (e) { /* no file: valgrind itself may have failed to start */ }
    if (!logContent) {
      return { passed: false, runtimeUnavailable: true, logs: 'valgrind produced no log output', detail: {} };
    }
    const real = parseValgrindReal(logContent);
    const matches = valgrindClaimMatchesReal(findings, real);
    return {
      passed: matches,
      logs: matches ? '' : `expected_findings does not match real Valgrind result (real: ${JSON.stringify(real)})`,
      detail: { tool: 'valgrind', real, exitStatus: runRes.status, valgrindLog: logContent.slice(0, 1500) },
    };
  },
};
