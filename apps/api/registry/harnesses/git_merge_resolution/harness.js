/**
 * merge_resolution — the resolved code must pass its tests AND the two branches
 * must genuinely conflict.
 */
'use strict';

module.exports = {
  contract: 'merge_resolution',
  // git is a hard requirement now (a missing git used to make the conflict
  // check silently abstain rather than fail the row); python3/node are NOT
  // listed here because which one a row needs is decided dynamically by
  // h.inferLang, same as every other polyglot harness in this registry.
  requires: ['git'],

  verify(row, h) {
    const resolved = h.str(row, 'resolved_code');
    const tests = h.str(row, 'tests');
    if (!resolved || !tests) return { passed: false, detail: { reason: 'missing resolved_code or tests' } };

    // A marker left inside a string literal or comment is syntactically
    // valid in most languages, so it never trips ranOk===false on its own --
    // the only other signal this harness has. Checked directly against the
    // SUBMITTED resolved_code (not the synthetic three-way merge output the
    // conflict check below runs on) so a genuinely leftover, uncleaned
    // conflict marker is always caught regardless of whether it happens to
    // also be valid syntax. Anchored at line-start and requiring the
    // marker's own conventional trailing shape (a space/ref-name after
    // <<<<<<</>>>>>>>, nothing after =======) to avoid flagging unrelated
    // 7-repeated-character content that isn't an actual git conflict marker.
    if (/^(<{7}([ \t].*)?|={7}|>{7}([ \t].*)?)$/m.test(resolved)) {
      return { passed: false, logs: 'resolved_code still contains unresolved git conflict markers', detail: { reason: 'unresolved_conflict_markers' } };
    }

    // This dataset carries no `language` field, so infer from shape using the
    // shared, battle-tested detector every other polyglot harness in this
    // registry uses. A hand-rolled 2-language guesser used to live here and
    // defaulted anything it didn't recognize to Python, which turned a
    // correct Java/Go/Rust/... submission into a false SyntaxError failure
    // instead of a clean runtimeUnavailable.
    const lang = h.inferLang(resolved);
    // Reduced from 20000: a git merge-file check runs right after this in
    // the same verify() -- at the prior values (20000 here + 10000 there)
    // the sum already equaled the ENTIRE outer sandbox command budget
    // deployed at the time (30000ms; raised to 120000ms as of the current
    // deploy, infra/terraform/ssm.tf), leaving zero
    // margin, before even accounting for a compiled language's own
    // compile-step ceiling on top. A submission-sized resolved_code plus
    // its tests is not remotely close to even this reduced value in
    // practice.
    const run = h.runWithTests(lang, resolved, tests, 8000);
    if (run.unavailable) {
      return { passed: false, runtimeUnavailable: true, logs: (run.runtime || lang) + ' unavailable in sandbox', detail: { inferredLang: lang, runtime: run.runtime } };
    }
    const ranOk = run.ok === true;
    const stderr = String(run.stderr || '');

    if (!h.have('git')) {
      return { passed: false, runtimeUnavailable: true, logs: 'git unavailable', detail: { runtime: 'git', inferredLang: lang, resolvedPassesTests: ranOk } };
    }

    // "resolved code passes its tests" is NOT sufficient for this category: if
    // both branches made the identical change there was never a conflict, so
    // the row does not exercise conflict resolution at all.
    let conflicts;
    const g = h.workdir();
    try {
      h.fs.writeFileSync(h.path.join(g, 'base.txt'), h.str(row, 'base_code'));
      h.fs.writeFileSync(h.path.join(g, 'a.txt'), h.str(row, 'branch_a_code'));
      h.fs.writeFileSync(h.path.join(g, 'b.txt'), h.str(row, 'branch_b_code'));
      const m = h.run('git', ['merge-file', '-p', 'a.txt', 'base.txt', 'b.txt'], { cwd: g, timeoutMs: 3000 });
      // git merge-file's own exit status already conclusively encodes this:
      // 0 = clean merge, a positive integer = that many conflicts, negative
      // = the command itself failed. The exit status is authoritative and
      // needs no help from scanning stdout -- a prior version also treated
      // ANY literal "<<<<<<<" in the merged stdout as a conflict signal,
      // which is redundant when a real conflict already sets a positive
      // status, and can only ever ADD a false positive when status===0 (a
      // genuinely clean, non-conflicting merge) but base/branch_a/branch_b
      // happen to share unrelated content containing that literal sequence
      // (e.g. a diff/patch-rendering utility's own example text) -- that
      // survives into stdout untouched and would wrongly flag a real clean
      // merge as "conflicting", weakening the "branches must genuinely
      // conflict" gate this check exists to enforce.
      if (m.status < 0) {
        throw new Error('git merge-file itself failed (status ' + m.status + '): ' + String(m.stderr || '').slice(0, 300));
      }
      conflicts = m.status > 0;
    } catch (e) {
      return { passed: false, runtimeUnavailable: true, logs: 'git merge-file check failed: ' + String((e && e.message) || e), detail: { runtime: 'git' } };
    }

    const ok = ranOk && conflicts !== false;
    return {
      passed: ok,
      logs: !ranOk
        ? stderr.slice(0, 1500)
        : conflicts === false
          ? 'branch_a and branch_b do not conflict, so there is nothing to resolve'
          : '',
      detail: { inferredLang: lang, resolvedPassesTests: ranOk, threeWayMergeConflicts: conflicts },
    };
  },
};
