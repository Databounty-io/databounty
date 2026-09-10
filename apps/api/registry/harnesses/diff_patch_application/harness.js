/**
 * patch-apply-result-match -- diff_patch_application.
 *
 * THE CONTRACT: patch_diff (a contributor-authored unified diff) must apply
 * cleanly, via REAL `git apply`, to base_file_content and produce EXACTLY
 * expected_final_content. Single-file, conflict-free patch APPLICATION --
 * there is no merge, no conflict markers, no two-branch scenario, unlike
 * this registry's other git-shelling-out harness (git_merge_resolution).
 *
 * FIXED TARGET FILENAME, HARNESS-CONTROLLED -- THE SECURITY DESIGN DECISION
 * FOR THIS CATEGORY: a unified diff's own '--- a/<path>' / '+++ b/<path>'
 * header lines name arbitrary file paths chosen by whoever authored the
 * diff. Letting patch_diff (contributor-controlled, role: solution_code)
 * dictate its own target path -- or touch more than one file -- is an
 * unnecessary risk surface this category has no reason to accept: it only
 * ever needs to prove ONE transform, of ONE file, that THIS harness already
 * knows the exact before/after content of. base_file_content is therefore
 * always written to one fixed, harness-chosen filename (TARGET_FILENAME,
 * 'target.txt') inside a fresh h.workdir(), and patch_diff is REJECTED
 * upfront (a real failure, not runtimeUnavailable) if any of its own diff
 * headers name a path other than that exact fixed filename, or if it
 * touches more than one file. See validateHeaders() below.
 *
 * HEADER FORMAT CHOSEN: the git-default a/ b/ prefixed form -- literally
 * '--- a/target.txt' and '+++ b/target.txt' -- not the no-prefix form GNU
 * `diff -u` produces ('--- target.txt', often with a trailing tab+
 * timestamp). Confirmed via a real local `git diff`/`git diff --no-index`
 * run (git 2.44, both inside and outside a repo) that this a/ b/ form is
 * exactly what git itself naturally emits by default, with no timestamp
 * suffix -- the shape a contributor running the ordinary `git diff` workflow
 * this category is named after would actually produce. Only this ONE shape
 * is accepted; a patch using the no-prefix GNU form is rejected by the same
 * exact-match header gate (a real, meaningful reject -- "regenerate as a
 * git-style diff", not a false negative on a legitimate submission this
 * category is meant to grade).
 *
 * EXACT-MATCH, NOT SUBSTRING-MATCH -- CONFIRMED, NOT ASSUMED: validateHeaders
 * compares each header LINE against the fixed literal string in full
 * ('--- a/target.txt', '+++ b/target.txt', 'diff --git a/target.txt
 * b/target.txt'), never merely checking that the fixed filename appears
 * somewhere inside the line. A substring check would let
 * '--- a/../../../../etc/target.txt' or '--- a/target.txt.evil' both slip
 * through (both textually CONTAIN 'target.txt'); an exact `line === header`
 * comparison rejects both, since neither string equals the fixed header in
 * full. Verified structurally impossible to bypass rather than merely
 * assumed: there is no '..' anywhere in TARGET_FILENAME itself, so no
 * traversal path can ever equal it exactly regardless of what a contributor
 * writes.
 *
 * WHY THIS GATE IS STILL WORTH HAVING EVEN THOUGH REAL git apply ALREADY HAS
 * SOME OF ITS OWN PATH DEFENSES (confirmed via real local git 2.44 probes,
 * not assumed): a header naming a nonexistent sibling file fails --check
 * naturally ('error: <path>: No such file or directory'), and git apply
 * itself refuses a literal '..' path component outright ('error: invalid
 * path'). Relying on those alone is NOT equivalent to this harness's own
 * gate for two reasons specific to this category's contract: (1) a patch
 * that legitimately creates a brand-new sibling file with NO '..' at all
 * (e.g. '+++ b/evil.txt') is neither a traversal nor a missing-file error --
 * git would apply it successfully and silently write a second file into the
 * workdir this category was never meant to touch or grade, which this
 * gate's own multi-file / wrong-filename check closes but git's own
 * defenses do not; (2) this harness's gate runs BEFORE ever invoking git at
 * all, so a malformed/adversarial patch_diff never reaches the git process
 * in the first place -- defense in depth, not a substitute for git's own
 * (real, confirmed) protections, on top of them.
 *
 * TWO-PHASE APPLY (--check, then apply for real): `git apply --check`
 * validates the patch against base_file_content's real on-disk bytes
 * without touching the file, so a context-mismatched or malformed patch is
 * distinguishable from a real apply-then-compare failure. A --check FAILURE
 * (nonzero exit, context lines don't match, corrupt/lying hunk header,
 * malformed patch syntax, ...) is a REAL failure, never runtimeUnavailable
 * -- the git binary ran fine; what it was asked to apply is bad, or doesn't
 * match the given base file. Confirmed via a real local probe that git
 * apply's own parser already rejects a hunk header lying about its line
 * counts ('@@ -1,3 +1,3 @@' over a body with fewer than 3 removed/context
 * lines) with 'error: corrupt patch at line N' -- no separate hand-rolled
 * hunk-header-line-count check is needed in THIS file; git's real parser
 * already refuses a lying header before this harness ever sees resulting
 * content.
 *
 * `git apply` NEEDS NO `git init`/REPOSITORY -- CONFIRMED, NOT ASSUMED: a
 * real local run (git 2.44.0) applied a genuine `git diff`-produced patch
 * against a target file sitting in a PLAIN directory with no .git anywhere
 * in it or any ancestor, both --check and the real apply succeeding
 * identically to running inside a repo. No `git init` step is used here.
 *
 * core.autocrlf PINNED EXPLICITLY -- A REAL, LOCALLY-REPRODUCED BUG THIS
 * HARNESS MUST NOT REINTRODUCE: a real local probe (git 2.44.0 for Windows)
 * showed `git apply`, run in a PLAIN directory with NO repository and NO
 * global core.autocrlf set, still silently rewrote a patch-applied file's
 * trailing '\n' into '\r\n' -- sourced from that git installation's own
 * SYSTEM-level config (outside this harness's control, and NOT visible via
 * `git config --global --get core.autocrlf`, which reported nothing set).
 * This is exactly the class of unpinned-environment-decides-the-verdict risk
 * this registry's own run() already guards against for PYTHONHASHSEED/TZ/
 * PYTHONUTF8 (see helpers.js) -- a byte-exact comparison against
 * expected_final_content (this category's own comparison rule, see below)
 * would silently, non-reproducibly false-FAIL a correct submission purely
 * because of a git installation's own ambient config, not the submission or
 * the dataset row. EVERY git invocation in this file therefore passes
 * `-c core.autocrlf=false` explicitly (confirmed via the same local probe to
 * fully restore exact-byte output), rather than trusting whatever the
 * sandbox image's git happens to default to.
 *
 * TRAILING-NEWLINE COMPARISON RULE: byte-exact string equality between the
 * post-apply file content and expected_final_content, with NO trimming of a
 * trailing-newline difference. This is deliberate, not an oversight: unified
 * diffs already have a well-defined, standard way to represent whether a
 * line lacks a trailing newline -- the literal '\ No newline at end of file'
 * marker line immediately following the affected '+'/'-' line (confirmed via
 * a real local `git diff` on a file with no trailing newline). A correctly
 * authored patch_diff therefore always reproduces the correct trailing-
 * newline state of expected_final_content exactly, byte for byte, once
 * applied by real git apply -- confirmed via a real local apply of such a
 * patch (both the no-newline-preserved and no-newline-to-newline-added
 * cases reproduced exactly, once core.autocrlf was pinned as above). Being
 * lenient here (trimming a trailing-newline difference before comparing)
 * would mask exactly the defect this category exists to catch: a patch that
 * mechanically "works" (git apply accepts it) but gets the documented final
 * content subtly wrong. No other normalization is applied either (no
 * whitespace collapsing, no case-folding) -- this category's claim is an
 * EXACT resulting file, not a loosely-equivalent one.
 *
 * NO-OP-HUNK GUARD (defense in depth, not the primary correctness check):
 * hasRealHunk() rejects a patch_diff containing zero actual '+'/'-' content
 * lines outside its own file-header lines, before ever invoking git. A
 * context-only patch that changes nothing would, in practice, already fail
 * the final content-match against a genuinely different expected_final_content
 * -- this check exists to give a clearer, more specific error message for
 * what is fundamentally a dataset-authoring defect (a patch with nothing to
 * apply is never a legitimate row for this category), matching this
 * registry's "reject dataset defects at their own gate, with a specific
 * reason" convention (schema_conformance_validation's own GATE ORDER is the
 * same shape, applied to a different defect).
 *
 * TIMEOUT BUDGET: two h.run('git', ...) subprocess calls against one small
 * text file and one small patch -- no compilation, no external process, no
 * network. CHECK_TIMEOUT_MS/APPLY_TIMEOUT_MS (5000ms each) are generous
 * multiples of the sub-second real-world cost of either call; a genuine
 * hang at that budget on input this small is itself meaningful signal (an
 * adversarial/pathological patch), not an infra problem, so a timeout here
 * is treated as a real failure, not runtimeUnavailable -- the same
 * "timeout on tiny, fast work is data about the input" convention this
 * registry's Python-exec categories (schema_conformance_validation,
 * property_based_testing) already use for their own contributor-code
 * timeouts. The two calls combined (worst case 10000ms) stay comfortably
 * under the outer sandbox command budget (120000ms,
 * infra/terraform/ssm.tf's EXECUTION_RUNNER_TIMEOUT_MS, duplicated in
 * helpers.js as OUTER_SANDBOX_BUDGET_MS) with roughly 110000ms of margin.
 *
 * A git process that is itself killed by a signal (not this harness's own
 * timeout, which is reported separately via r.timedOut) -- r.status===null
 * with no timedOut flag -- is treated as runtimeUnavailable rather than a
 * real failure: that shape means the git TOOL malfunctioned in this sandbox
 * (crashed), not that it ran fine and rejected a bad patch (which always
 * produces an ordinary nonzero exit CODE, confirmed above, e.g. status 1 or
 * 128), mirroring git_merge_resolution's own "the git binary works fine vs.
 * the git binary itself failed" distinction for its git merge-file call.
 */
'use strict';

const TARGET_FILENAME = 'target.txt';
const CHECK_TIMEOUT_MS = 5000;
const APPLY_TIMEOUT_MS = 5000;
// Cheap defensive bound on total per-row work, mirroring
// schema_conformance_validation's own MAX_PAYLOADS -- not expected to matter
// for realistic authored rows (this category's fields are single small-to-
// medium text files/diffs, not bulk data), just insurance against a
// pathologically large row.
const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_PATCH_BYTES = 512 * 1024; // 512KB

const A_HEADER = '--- a/' + TARGET_FILENAME;
const B_HEADER = '+++ b/' + TARGET_FILENAME;
const GIT_HEADER = 'diff --git a/' + TARGET_FILENAME + ' b/' + TARGET_FILENAME;

/**
 * Validate that every file-header-shaped line in patch_diff refers to the
 * one fixed target filename, and only that filename -- see this file's own
 * module doc comment (FIXED TARGET FILENAME / EXACT-MATCH) for the full
 * reasoning. Deliberately scans EVERY line matching these prefixes, not just
 * lines that look like they precede the first '@@' hunk marker: a stray
 * '---'/'+++'-shaped line embedded inside a hunk BODY (unusual, but not
 * impossible if a hunk's own added/removed content happens to start with
 * those characters) is held to the identical exact-match standard rather
 * than assumed to be "just content" -- the safe failure mode here is an
 * over-cautious reject, never a bypass.
 */
function validateHeaders(patchText) {
  const lines = String(patchText).split(/\r\n|\n|\r/);
  let aCount = 0;
  let bCount = 0;
  let gitCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('--- ') === 0) {
      if (line !== A_HEADER) {
        return { ok: false, reason: 'patch_diff old-file header must read exactly "' + A_HEADER + '", found "' + line.slice(0, 200) + '"' };
      }
      aCount++;
    } else if (line.indexOf('+++ ') === 0) {
      if (line !== B_HEADER) {
        return { ok: false, reason: 'patch_diff new-file header must read exactly "' + B_HEADER + '", found "' + line.slice(0, 200) + '"' };
      }
      bCount++;
    } else if (line.indexOf('diff --git ') === 0) {
      if (line !== GIT_HEADER) {
        return { ok: false, reason: 'patch_diff "diff --git" header must read exactly "' + GIT_HEADER + '", found "' + line.slice(0, 200) + '"' };
      }
      gitCount++;
    }
  }
  if (aCount !== 1 || bCount !== 1) {
    return { ok: false, reason: 'patch_diff must contain exactly one "' + A_HEADER + '" line and one "' + B_HEADER + '" line (found ' + aCount + ' / ' + bCount + ')' };
  }
  if (gitCount > 1) {
    return { ok: false, reason: 'patch_diff touches more than one file (multiple "diff --git" headers) -- this category verifies a single-file patch only' };
  }
  return { ok: true };
}

/** True if patch_diff contains at least one real content-changing line
 * ('+'/'-' outside the file-header lines themselves) -- see this file's own
 * module doc comment (NO-OP-HUNK GUARD). */
function hasRealHunk(patchText) {
  const lines = String(patchText).split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('+') === 0 && line.indexOf('+++') !== 0) return true;
    if (line.indexOf('-') === 0 && line.indexOf('---') !== 0) return true;
  }
  return false;
}

module.exports = {
  contract: 'patch-apply-result-match',
  // git is a hard requirement (gated once here explicitly, in addition to
  // run.js's own top-level `requires` gate -- see git_merge_resolution's
  // identical belt-and-suspenders convention, which this file matches for
  // the same reason: a harness invoked directly, outside run.js's own
  // gating loop, should still fail safe rather than crash).
  requires: ['git'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const baseContent = h.str(row, 'base_file_content');
    const patchDiff = h.str(row, 'patch_diff');
    const expectedFinal = h.str(row, 'expected_final_content');

    if (!taskDescription.trim() || !baseContent || !patchDiff.trim() || expectedFinal === '') {
      return { passed: false, detail: { reason: 'missing task_description, base_file_content, patch_diff, or expected_final_content' } };
    }
    if (Buffer.byteLength(baseContent, 'utf8') > MAX_CONTENT_BYTES || Buffer.byteLength(expectedFinal, 'utf8') > MAX_CONTENT_BYTES) {
      return { passed: false, detail: { reason: 'base_file_content or expected_final_content exceeds the ' + MAX_CONTENT_BYTES + '-byte cap for this category' } };
    }
    if (Buffer.byteLength(patchDiff, 'utf8') > MAX_PATCH_BYTES) {
      return { passed: false, detail: { reason: 'patch_diff exceeds the ' + MAX_PATCH_BYTES + '-byte cap for this category' } };
    }

    // Gate 1: header/path validation -- see FIXED TARGET FILENAME doc
    // comment. Runs BEFORE base_file_content or patch_diff ever touch disk.
    const headerCheck = validateHeaders(patchDiff);
    if (!headerCheck.ok) {
      return { passed: false, logs: headerCheck.reason, detail: { reason: 'invalid_patch_header' } };
    }

    // Gate 2: no-op-hunk guard -- see NO-OP-HUNK GUARD doc comment.
    if (!hasRealHunk(patchDiff)) {
      return { passed: false, logs: 'patch_diff contains no content-changing lines -- a context-only/no-op patch is not a valid row for this category', detail: { reason: 'no_op_patch' } };
    }

    if (!h.have('git')) {
      return { passed: false, runtimeUnavailable: true, logs: 'git unavailable', detail: { runtime: 'git' } };
    }

    const d = h.workdir();
    const targetPath = h.path.join(d, TARGET_FILENAME);
    const patchPath = h.path.join(d, 'patch.diff');
    h.fs.writeFileSync(targetPath, baseContent);
    h.fs.writeFileSync(patchPath, patchDiff);

    // core.autocrlf pinned explicitly on every invocation -- see this file's
    // own module doc comment (core.autocrlf PINNED EXPLICITLY) for the real,
    // locally-reproduced bug this guards against. -p1 made explicit (git's
    // own default already strips one leading path component, matching the
    // a/ b/ header convention required above) rather than relying silently
    // on that default.
    const gitArgsBase = ['-c', 'core.autocrlf=false'];

    const check = h.run('git', gitArgsBase.concat(['apply', '--check', '-p1', patchPath]), { cwd: d, timeoutMs: CHECK_TIMEOUT_MS });
    if (check.timedOut) {
      return { passed: false, logs: 'git apply --check did not complete within the time budget -- treated as a real failure, not a missing toolchain (see TIMEOUT BUDGET doc comment)', detail: { reason: 'check_timed_out' } };
    }
    if (check.status === null) {
      // Process killed by a signal, not our own timeout -- a git TOOL
      // malfunction in this sandbox, distinct from "git ran fine and
      // rejected the patch" (which is always an ordinary nonzero exit code,
      // confirmed via real local probes -- see module doc comment).
      return { passed: false, runtimeUnavailable: true, logs: 'git apply --check process terminated unexpectedly (signal), not a clean exit', detail: { reason: 'git_apply_check_signal_killed', stderr: check.stderr.slice(0, 500) } };
    }
    if (check.status !== 0) {
      return {
        passed: false,
        logs: 'git apply --check rejected patch_diff against base_file_content: ' + check.stderr.slice(0, 1500),
        detail: { reason: 'check_failed', exitCode: check.status },
      };
    }

    const apply = h.run('git', gitArgsBase.concat(['apply', '-p1', patchPath]), { cwd: d, timeoutMs: APPLY_TIMEOUT_MS });
    if (apply.timedOut) {
      return { passed: false, logs: 'git apply did not complete within the time budget -- treated as a real failure, not a missing toolchain', detail: { reason: 'apply_timed_out' } };
    }
    if (apply.status === null) {
      return { passed: false, runtimeUnavailable: true, logs: 'git apply process terminated unexpectedly (signal), not a clean exit', detail: { reason: 'git_apply_signal_killed', stderr: apply.stderr.slice(0, 500) } };
    }
    if (apply.status !== 0) {
      // --check passed but the real apply failed -- should not normally
      // happen (both run against the identical on-disk file, back to back,
      // in the same fresh workdir with nothing else touching it between the
      // two calls), but handled explicitly rather than assumed impossible.
      return {
        passed: false,
        logs: 'git apply failed after --check succeeded (unexpected): ' + apply.stderr.slice(0, 1500),
        detail: { reason: 'apply_failed_after_check_passed', exitCode: apply.status },
      };
    }

    let actualFinal;
    try {
      actualFinal = h.fs.readFileSync(targetPath, 'utf8');
    } catch (e) {
      return { passed: false, runtimeUnavailable: true, logs: 'could not read patched file after a successful git apply: ' + String((e && e.message) || e), detail: { reason: 'post_apply_read_failed' } };
    }

    // Byte-exact comparison, no trailing-newline trimming -- see this file's
    // own module doc comment (TRAILING-NEWLINE COMPARISON RULE) for why.
    const matched = actualFinal === expectedFinal;
    return {
      passed: matched,
      logs: matched ? '' : ('patch applied cleanly but the resulting content did not exactly match expected_final_content (lengths: actual=' + actualFinal.length + ' expected=' + expectedFinal.length + ')'),
      detail: {
        reason: matched ? 'ok' : 'result_mismatch',
        actualLength: actualFinal.length,
        expectedLength: expectedFinal.length,
        actualPreview: actualFinal.slice(0, 300),
        expectedPreview: expectedFinal.slice(0, 300),
      },
    };
  },
};
