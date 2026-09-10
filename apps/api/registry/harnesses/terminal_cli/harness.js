/**
 * exit-code-verify — environment_setup builds the starting filesystem state,
 * command_sequence is the task itself, and expected_final_state is a bash
 * script that exits 0 exactly when the resulting state is correct (checked
 * mechanically — it asserts real conditions like file existence/counts, not
 * prose). This dataset is unusually self-verifying: the reference material
 * already IS the verifier.
 *
 * That self-verifying design has no harness-owned check of its own unless
 * something requires expected_final_state to actually DEPEND on
 * command_sequence having run — confirmed exploitable without it: a rigged
 * row (a no-op command_sequence like "true", paired with an
 * expected_final_state like "exit 0" that's true regardless of anything)
 * passed unconditionally, since nothing before this required the verify
 * script to have been FALSE before the task ran. PRE-CHECK runs
 * expected_final_state once against the untouched post-setup state and
 * requires it to fail there — the same fail-then-pass shape this registry
 * already enforces structurally for other categories (fail_to_pass,
 * debugging). Confirmed zero regression risk: every one of the real 25
 * reference rows' own expected_final_state genuinely returns non-zero
 * before command_sequence runs.
 *
 * Every bash invocation's stdout/stderr is redirected to a file INSIDE the
 * script itself, rather than left on the inherited pipe h.run()'s
 * spawnSync reads from directly. A command_sequence that legitimately
 * backgrounds a job without redirecting its own I/O (an ordinary "start a
 * server in the background" idiom) otherwise keeps that pipe open long
 * after the foreground work is done -- spawnSync doesn't resolve until
 * every holder of the pipe closes it, not just the direct bash child --
 * confirmed to hang for the entire timeout budget (and, escalated to a
 * never-exiting background loop, to leave an orphaned process running
 * after the timeout fires). Redirecting to a file first means nothing
 * inherits that pipe at all, so a background job can no longer block
 * (or fully defeat, via a long-enough sleep) this harness's own timeout.
 */
'use strict';

// Comfortably under the outer sandbox command budget deployed at the time
// (30000ms; raised to 120000ms as of the current deploy,
// infra/terraform/ssm.tf) -- the prior 15000/30000/15000 literals summed to
// double that then-budget on their own, before this file even added a 4th invocation,
// and the registry-harness execution path (unlike the separate per-language
// verifier path) never derives its own timeouts from that outer budget.
const SETUP_TIMEOUT_MS = 5000;
const PRECHECK_TIMEOUT_MS = 3000;
const COMMAND_TIMEOUT_MS = 12000;
const VERIFY_TIMEOUT_MS = 3000;

let _seq = 0;
/** Runs `script` with stdout+stderr captured via an on-disk redirect rather
 * than the inherited pipe h.run()'s spawnSync reads directly -- see file
 * header for why. `script` (environment_setup/command_sequence/
 * expected_final_state, all contributor/dataset-row-controlled) is written
 * to its OWN file and run via `bash <file>`, never concatenated into the
 * `bash -c` wrapper string itself -- an earlier version built the wrapper as
 * `'{ ' + script + '\n} > ' + outName + ' 2>&1'`, and an UNBALANCED closing
 * brace inside `script` broke out of that grouping, letting the contributor
 * inject trailing statements (e.g. a bare `exit 0` in a second `{ }` group)
 * whose exit status became what this harness reports, fully decoupled from
 * whether the real commands succeeded -- confirmed exploitable, and it
 * defeated the `cmdR.status===0` check this file's own comment (further
 * down) says was added specifically to prevent exactly that. With `script`
 * isolated into its own file, the outer wrapper contains ONLY
 * harness-authored text (a fixed, predictable filename), so there is
 * nothing left in it for contributor content to break out of. */
function runCaptured(h, d, script, timeoutMs) {
  const idx = _seq++;
  const scriptFile = '.cli_script_' + idx + '.sh';
  const outName = '.cli_out_' + idx + '.txt';
  h.fs.writeFileSync(h.path.join(d, scriptFile), script);
  const wrapped = 'bash "' + scriptFile + '" > "' + outName + '" 2>&1';
  const r = h.run('bash', ['-c', wrapped], { cwd: d, timeoutMs });
  let captured = '';
  try { captured = h.fs.readFileSync(h.path.join(d, outName), 'utf8'); } catch (e) { /* never written */ }
  return { status: r.status, timedOut: !!r.timedOut, output: captured };
}

/** Shallow-safe recursive copy of `src` into `dest` (both real directories),
 * skipping symlinks defensively (same rationale as notebook_pipeline's own
 * fix: contributor-created content shouldn't be followed blindly). Used to
 * give PRE-CHECK its own throwaway snapshot of the post-setup filesystem
 * state -- see PRE-CHECK's own comment below for why sharing the real
 * workdir between the two verify-script runs is exploitable. */
function copyDirRecursive(h, src, dest) {
  h.fs.mkdirSync(dest, { recursive: true });
  for (const name of h.fs.readdirSync(src)) {
    const s = h.path.join(src, name);
    const dpath = h.path.join(dest, name);
    let st;
    try { st = h.fs.lstatSync(s); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyDirRecursive(h, s, dpath);
    else h.fs.copyFileSync(s, dpath);
  }
}

module.exports = {
  contract: 'exit-code-verify',
  requires: ['bash'],

  verify(row, h) {
    const setup = h.str(row, 'environment_setup');
    const commands = h.str(row, 'command_sequence');
    const verifyScript = h.str(row, 'expected_final_state');
    if (!commands || !verifyScript) {
      return { passed: false, detail: { reason: 'missing command_sequence or expected_final_state' } };
    }
    if (!h.have('bash')) return { passed: false, runtimeUnavailable: true, logs: 'bash not available', detail: {} };

    const d = h.workdir();
    if (setup) {
      const s = runCaptured(h, d, setup, SETUP_TIMEOUT_MS);
      if (s.timedOut) return { passed: false, runtimeUnavailable: true, logs: 'environment_setup did not finish within the time budget', detail: {} };
      if (s.status !== 0) {
        return { passed: false, logs: 'environment_setup failed:\n' + s.output.slice(0, 800), detail: { setupFailed: true } };
      }
    }

    // Run against a THROWAWAY COPY of the post-setup state, never the real
    // workdir `d` -- PRE-CHECK's own assumption is "if expected_final_state's
    // exit code differs between this run and the real one later, that's
    // because command_sequence changed genuine task state." That assumption
    // is false if both runs share the same mutable directory: an
    // expected_final_state can plant a sentinel file on this FIRST
    // invocation and check for it on the second, making its own exit code a
    // function of "which call number is this" rather than of anything
    // command_sequence actually did -- confirmed exploitable (a completely
    // ordinary, non-malicious-looking verify script using `touch`/`[ -f ]`
    // reproduces this with a no-op command_sequence). Running PRE-CHECK
    // against a disposable snapshot means any state it plants is discarded
    // before command_sequence or the real final verify ever run against `d`.
    const precheckDir = h.workdir();
    copyDirRecursive(h, d, precheckDir);
    const preVerifyR = runCaptured(h, precheckDir, verifyScript, PRECHECK_TIMEOUT_MS);
    if (preVerifyR.timedOut) return { passed: false, runtimeUnavailable: true, logs: 'expected_final_state (pre-check) did not finish within the time budget', detail: {} };
    if (preVerifyR.status === 0) {
      return {
        passed: false,
        logs: 'expected_final_state already exits 0 before command_sequence ever runs -- the verify script does not actually depend on the task being solved',
        detail: { prematureVerify: true },
      };
    }

    const cmdR = runCaptured(h, d, commands, COMMAND_TIMEOUT_MS);
    if (cmdR.timedOut) return { passed: false, runtimeUnavailable: true, logs: 'command_sequence did not finish within the time budget', detail: {} };
    const verifyR = runCaptured(h, d, verifyScript, VERIFY_TIMEOUT_MS);
    if (verifyR.timedOut) return { passed: false, runtimeUnavailable: true, logs: 'expected_final_state did not finish within the time budget', detail: {} };
    // command_sequence itself must also succeed. Checking only verifyR
    // let a command_sequence that errored out immediately still pass
    // whenever environment_setup happened to already satisfy
    // expected_final_state on its own -- rewarding a task that never ran.
    const passed = cmdR.status === 0 && verifyR.status === 0;

    return {
      passed,
      logs: passed
        ? ''
        : cmdR.status !== 0
          ? ('command_sequence exited ' + cmdR.status + ':\n' + cmdR.output.slice(0, 500))
          : ('verification script exited ' + verifyR.status + ':\n' + verifyR.output.slice(0, 500)),
      detail: {
        commandExit: cmdR.status, verifyExit: verifyR.status,
        commandOutput: cmdR.output.slice(0, 400),
      },
    };
  },
};
