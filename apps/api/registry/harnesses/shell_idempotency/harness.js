/**
 * state-sequence-match — the recorded expected_second_run_result must
 * accurately describe what actually happens on a second run: run the script
 * twice, hash the filesystem after each run, and check whether "state
 * changed" matches what the prose claims ("no change" / "idempotent" /
 * "safe no-op" vs anything else). A row is correct when its description is
 * TRUTHFUL about the observed behavior, whichever direction that goes —
 * this is what catches a row that claims idempotency but is not.
 *
 * environment_setup runs once before either script invocation. The dataset
 * ships scripts that assume setup-created files already exist (e.g. copying
 * a defaults.yml a setup step created) — skipping it, as an earlier harness
 * did, makes the very first run fail on a missing file that was never the
 * script's own bug.
 *
 * Each script invocation runs under setsid, in its own new session/process
 * group, so it (and anything it forked) can be forcibly reaped afterward via
 * a single group-wide SIGKILL. h.run only waits for the direct child
 * (spawnSync semantics) — a script that backgrounds a job with its own I/O
 * redirected away (a bare "(...) &" needs no special tooling) previously
 * kept running unsupervised after h.run returned, invisible to the harness.
 * Confirmed exploitable: a script that appends to a file, then backgrounds a
 * delayed self-revert timed to land between the two snapshots (comfortably
 * inside the mandatory 1.1s inter-run gap) made a script that is provably
 * NOT idempotent measure as a clean, unchanged no-op across both runs, with
 * no elevated privileges or unusual syscalls needed.
 */
'use strict';

const NO_CHANGE_RE = /no change|no-op|already|idempotent|unchanged/i;
// "NOT idempotent" / "not a no-op" contains the same positive keyword the
// no-change regex looks for, but negated — checked first so the negation
// wins rather than the keyword match.
const NEGATED_RE = /\bnot\s+(?:a\s+)?(?:idempotent|no-?op|unchanged|safe)\b/i;

// Runs `bash s.sh` as the leader of a brand-new session (setsid), then
// forcibly SIGKILLs that whole process group once it exits (or once
// timeoutMs is hit) — reaping any background job it spawned that h.run's
// own spawnSync-level wait would otherwise never see. `--` before the
// negative PID stops `kill` from parsing it as an option flag.
function runIsolated(h, d, timeoutMs) {
  const wrapper = 'setsid bash s.sh & CHILD=$!; wait "$CHILD"; EC=$?; kill -KILL -- -"$CHILD" 2>/dev/null; exit $EC';
  return h.run('bash', ['-c', wrapper], { cwd: d, timeoutMs });
}

module.exports = {
  contract: 'state-sequence-match',
  requires: ['bash', 'md5sum', 'setsid', 'find', 'sort', 'xargs', 'stat', 'readlink'],

  verify(row, h) {
    const script = h.str(row, 'script');
    const setup = h.str(row, 'environment_setup');
    const expectedFirst = h.str(row, 'expected_first_run_result');
    const expectedSecond = h.str(row, 'expected_second_run_result');
    if (!script) return { passed: false, detail: { reason: 'missing script' } };

    // The dataset marks a deliberately-wrong reference description with a
    // literal "FLAWED:" prefix on whichever field is wrong — sometimes the
    // second-run field (already checked below), sometimes the first-run
    // field, which nothing else here verifies (expected_first_run_result's
    // free-form prose has no shared vocabulary a regex could check against
    // observed behavior the way "no change"/"idempotent" works for the
    // second run).
    if (/^FLAWED:/i.test(expectedFirst) || /^FLAWED:/i.test(expectedSecond)) {
      return { passed: false, logs: 'reference description is marked FLAWED', detail: { flawedReference: true } };
    }

    const d = h.workdir();
    if (setup) {
      const setupR = h.run('bash', ['-c', setup], { cwd: d, timeoutMs: 4000 });
      if (setupR.status !== 0) {
        return { passed: false, logs: 'environment_setup failed:\n' + String(setupR.stderr).slice(0, 800), detail: { setupFailed: true } };
      }
    }
    h.fs.writeFileSync(h.path.join(d, 's.sh'), script);

    // Covers mode bits and symlink targets, not just regular-file content —
    // a chmod-only or symlink-retarget change (both real, natural shapes for
    // an idempotency row; this dataset's own rows 12/23 are chmod-based) was
    // previously entirely invisible: `find -type f` never matches a symlink
    // at all, and content hashing never touches permissions. Confirmed
    // exploitable for the permissions half (a script whose only real effect
    // is flipping a file's mode between runs measured as "unchanged").
    // set -o pipefail: without it, only the FINAL command's exit status
    // (the outer md5sum) was ever checked -- if find/sort/stat/the inner
    // xargs-driven md5sum silently failed or were unavailable, the whole
    // pipeline still reported status 0 with the hash-of-empty-input,
    // indistinguishable from "genuinely zero files" and collapsing every
    // row in this category to a fail-open "state always unchanged".
    const SNAPSHOT_CMD = [
      'set -o pipefail;',
      '{',
      '  find . -type f -exec stat -c "%a %n" {} \\; 2>/dev/null | sort;',
      '  find . -type l -exec sh -c \'printf "L %s -> %s\\n" "$1" "$(readlink "$1")"\' _ {} \\; 2>/dev/null | sort;',
      '  find . -type f -print0 2>/dev/null | sort -z | xargs -0 -r md5sum 2>/dev/null;',
      '} | md5sum',
    ].join(' ');
    const snapshot = () => {
      const r = h.run('bash', ['-c', SNAPSHOT_CMD], { cwd: d, timeoutMs: 4000 });
      return { hash: String(r.stdout || '').trim(), ok: r.status === 0, timedOut: !!r.timedOut };
    };

    const r1 = runIsolated(h, d, 5000);
    if (r1.timedOut) return { passed: false, runtimeUnavailable: true, logs: 'first run did not finish within the time budget', detail: {} };
    const snap1 = snapshot();
    if (snap1.timedOut) return { passed: false, runtimeUnavailable: true, logs: 'could not snapshot filesystem state in time', detail: {} };
    if (!snap1.ok) return { passed: false, runtimeUnavailable: true, logs: 'snapshot pipeline failed (missing/broken find, sort, stat, xargs, or md5sum)', detail: { runtime: 'md5sum' } };
    // A script whose state depends on wall-clock time (e.g. `date +%s`,
    // 1-second resolution) can run both invocations within the same second
    // back-to-back, making a genuinely time-varying script look falsely
    // idempotent. A short real delay makes that class of row deterministic
    // instead of occasionally flaky.
    // Explicit timeout: previously unguarded, meaning a hang here (however
    // unlikely for a fixed 1.1s sleep) had a much larger ceiling than the
    // ~1.1s this call actually needs, eating into the outer sandbox
    // command budget deployed at the time (30000ms; raised to 120000ms as
    // of the current deploy, infra/terraform/ssm.tf) shared with
    // every other call in this sequence.
    h.run('bash', ['-c', 'sleep 1.1'], { timeoutMs: 3000 });
    const r2 = runIsolated(h, d, 5000);
    if (r2.timedOut) return { passed: false, runtimeUnavailable: true, logs: 'second run did not finish within the time budget', detail: {} };
    const snap2 = snapshot();
    if (snap2.timedOut) return { passed: false, runtimeUnavailable: true, logs: 'could not snapshot filesystem state in time', detail: {} };
    if (!snap2.ok) return { passed: false, runtimeUnavailable: true, logs: 'snapshot pipeline failed (missing/broken find, sort, stat, xargs, or md5sum)', detail: { runtime: 'md5sum' } };

    const stateUnchangedOnRerun = snap1.hash === snap2.hash;
    // Idempotency is violated either by changed state OR by the second run
    // erroring where the first did not (e.g. `mkdir` with no -p: same
    // directory, but the rerun fails with "File exists") — content-only
    // hashing misses that second case entirely.
    const ranIdempotently = stateUnchangedOnRerun && r2.status === 0;
    const expectsNoChange = NEGATED_RE.test(expectedSecond) ? false : NO_CHANGE_RE.test(expectedSecond);
    const descriptionMatchesReality = ranIdempotently === expectsNoChange;

    return {
      passed: descriptionMatchesReality,
      logs: descriptionMatchesReality ? '' :
        ('expected_second_run_result claims "' + (expectsNoChange ? 'no change' : 'a change') +
         '" but the second run was ' + (ranIdempotently ? 'a clean no-op' : 'not a clean no-op') + ' (exit ' + r2.status + ', state ' + (stateUnchangedOnRerun ? 'unchanged' : 'changed') + ')'),
      detail: {
        firstRunExit: r1.status,
        secondRunExit: r2.status,
        stateUnchangedOnRerun,
        ranIdempotently,
        expectsNoChange,
        note: 'expected_*_run_result is prose; verdict is whether that description matches the observed re-run behavior',
        expectedSecond: expectedSecond.slice(0, 200),
      },
    };
  },
};
