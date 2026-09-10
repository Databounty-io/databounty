/**
 * state_sequence — drive an implementation through its reference harness and
 * compare the OBSERVED transition sequence with the expected one.
 *
 * `reference_test_harness` is a contributor-controlled field, same row as
 * `implementation_code` — nothing before this ran the harness's own
 * assertions structurally requires the printed `result`/`sequence` to have
 * actually come FROM `implementation_code`. Without a provenance check, a
 * `reference_test_harness` that just does `result = <copy of
 * expected_state_sequence>` and never touches implementation_code at all
 * passes unconditionally, regardless of whether the implementation works,
 * or even parses past its own class/function definitions. `implTopLevelNames`
 * requires at least one name `implementation_code` actually defines to be
 * CALLED or attribute-accessed (not merely mentioned, e.g. inside a dead
 * comment) somewhere in `reference_test_harness`, which closes both the
 * trivial "just copy the expected answer" version of this gap AND the
 * narrower "reference a real name from a throwaway comment token, never
 * actually instantiate/call it" version. It does not (and cannot, short of
 * coverage-tracing execution) prove the reference harness genuinely
 * EXERCISES the implementation THROUGH A REALISTIC CODE PATH rather than,
 * say, calling it once in a way that happens to satisfy this regex while the
 * actual assertions are hardcoded — that residual gap is left to LLM/human
 * audit, same as this registry's other claim-vs-execution categories.
 *
 * Execution goes through h.runCode('python', ...) rather than a bare
 * h.run('python3', [file]) so this category gets the same protection every
 * other polyglot-execution category already has: PY_PRELUDE traps
 * sys.exit()/os._exit()/exit()/quit(), and PY_DRIVER structurally catches
 * `raise SystemExit(...)` around the whole script. Without this, a
 * `reference_test_harness` could print a forged "@@SEQ [...]" line matching
 * expected_state_sequence and then call sys.exit(0) before this file's own
 * detector code (appended after impl+harness in the same script) ever ran —
 * confirmed exploitable against the prior direct-h.run version, independent
 * of and not caught by the provenance check above (the forged harness can
 * still textually reference a real impl name to satisfy it).
 */
'use strict';

const crypto = require('crypto');

function implTopLevelNames(code) {
  const names = new Set();
  // Anchored with NO leading whitespace allowed (unlike an earlier `^\s*`
  // version): multiline `^` alone still matches an INDENTED line's start,
  // so `\s*` let a method def nested inside a class (e.g. `    def
  // handle(self, ...)`) count as a "top-level" name too. A genuine
  // top-level Python def/class never has leading whitespace, so this
  // change only excludes names that were never top-level to begin with --
  // confirmed necessary: an unrelated helper class's method sharing a name
  // like `handle` or the extremely common `__init__` (satisfied
  // incidentally by almost any class-based harness via `super().__init__()`)
  // previously let referencesImplCall() below pass without
  // reference_test_harness ever touching the real implementation at all.
  const re = /^(?:class|def)\s+(\w+)/gm;
  let m;
  while ((m = re.exec(code))) names.add(m[1]);
  return names;
}

/** Blank out '#' comments and string-literal contents (quote-aware; not
 * triple-quote-precise, matching the level of rigor already used elsewhere
 * in this registry's language-detection helpers) so a name mentioned only
 * inside a comment or string can't satisfy the call-syntax check below. */
function stripPyCommentsAndStrings(code) {
  const s = String(code == null ? '' : code);
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      out += ch === '\n' ? '\n' : ' ';
      if (ch === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ' '; continue; }
    if (ch === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** True only when `name` is actually called (`name(`) or attribute-accessed
 * (`name.`) in live code — a bare `\bname\b` mention anywhere (a comment, a
 * docstring, an unrelated string) is not evidence the harness ever touches
 * this implementation. Confirmed against the real reference dataset: every
 * genuine row's harness calls/accesses its impl names this way already, so
 * this tightening has no false-reject risk there. */
function referencesImplCall(name, harnessText) {
  const stripped = stripPyCommentsAndStrings(harnessText);
  return new RegExp('\\b' + name + '[ \\t]*[(.]').test(stripped);
}

module.exports = {
  contract: 'state_sequence',
  requires: ['python3'],

  verify(row, h) {
    const impl = h.str(row, 'implementation_code');
    const harness = h.str(row, 'reference_test_harness');
    const expectedRaw = h.str(row, 'expected_state_sequence');
    if (!impl || !harness || !expectedRaw) {
      return { passed: false, detail: { reason: 'missing implementation_code, reference_test_harness or expected_state_sequence' } };
    }

    const implNames = implTopLevelNames(impl);
    // No recognizable top-level class/def at all means provenance cannot be
    // established by this check at all -- NOT a free pass. An earlier
    // version treated implNames.size === 0 as automatically satisfying
    // referencesImpl, letting a harness with a completely fabricated,
    // impl-independent `result` through unconditionally whenever
    // implementation_code happened to be written without def/class.
    if (implNames.size === 0) {
      return {
        passed: false,
        logs: 'implementation_code defines no top-level class/def — provenance of reference_test_harness cannot be established',
        detail: { implNames: [] },
      };
    }
    const referencesImpl = [...implNames].some((name) => referencesImplCall(name, harness));
    if (!referencesImpl) {
      return {
        passed: false,
        logs: 'reference_test_harness never calls or attribute-accesses any top-level class/function defined in implementation_code (' + [...implNames].join(', ') + ') — it cannot be observing this implementation',
        detail: { implNames: [...implNames] },
      };
    }

    // A FIXED marker string is itself forgeable: PY_PRELUDE/PY_DRIVER trap
    // sys.exit()/os._exit()/raised SystemExit, but neither traps
    // atexit.register() -- a callback registered there runs at normal
    // interpreter shutdown, i.e. AFTER impl+harness+this file's own trailer
    // print all complete with no exception at all (the "everything
    // succeeded cleanly" path PY_DRIVER waves straight through). Since
    // h.lastMarked takes the LAST matching line, a `reference_test_harness`
    // that legitimately calls the real (broken) implementation_code -- so
    // the provenance check above is satisfied honestly -- can still register
    // an atexit hook that prints a forged, textually-correct verdict line
    // AFTER the real trailer print, and that forged line wins. Confirmed
    // exploitable against the fixed '@@SEQ ' string. A per-run random suffix
    // (same fix cryptographic_implementation already needed for the
    // analogous forged-print class) closes this: the random component isn't
    // known until the row is already authored, so a forged line can never
    // reproduce it.
    const mark = '@@SEQ_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = [
      impl,
      harness,
      'import json, os',
      // Every harness in the reference data ends with "result = sequence"; accept
      // either name so a slightly different convention still reports.
      '_obs = result if "result" in dir() else (sequence if "sequence" in dir() else None)',
      // os.write(1, ...) writes directly to the real OS file descriptor,
      // never through the `sys.stdout` Python object -- a plain `print()`
      // call resolves its output stream from `sys.stdout` FRESH at every
      // call, so `reference_test_harness` reassigning `sys.stdout` (it
      // shares this exact same top-level source/namespace with this
      // trailing line, both concatenated into the one file PY_DRIVER execs)
      // would intercept a `print()` call here regardless of the per-run
      // marker's randomness -- confirmed exploitable, the same class
      // already found and fixed in compression's/competitive_programming's
      // harnesses.
      'os.write(1, (' + JSON.stringify(mark) + ' + json.dumps(_obs, default=str) + "\\n").encode("utf-8", "replace"))',
    ].join('\n');

    const r = h.runCode('python', script, 25000);
    if (r.unavailable) {
      return { passed: false, runtimeUnavailable: true, logs: (r.runtime || 'python3') + ' not available in sandbox', detail: {} };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr).slice(0, 1500), detail: { ranClean: false, timedOut: !!r.timedOut } };
    }

    // A clean exit is necessary but NOT sufficient: these harnesses assert
    // internally and print nothing, so accepting on exit code alone verifies
    // nothing at all. An earlier version did exactly that and "passed" 24 of 25.
    // Reads the UNCAPPED rawStdout (not the 32000-char-capped stdout) so a
    // harness that legitimately logs a lot of debug output before printing
    // its final marker line doesn't have that marker sliced off by the cap
    // and get scored as "no observable state sequence" -- helpers.js's own
    // OUT_CAP comment names this exact category as exposed to that risk and
    // invites migrating call sites individually as they're touched.
    const observedRaw = h.lastMarked(String(r.rawStdout != null ? r.rawStdout : r.stdout), mark);
    if (observedRaw === null) {
      return { passed: false, logs: 'harness produced no observable state sequence', detail: {} };
    }

    const observed = h.jsonOf(observedRaw);
    const expected = h.jsonOf(expectedRaw);
    const matched = observed !== null && expected !== null
      ? JSON.stringify(h.canonical(observed)) === JSON.stringify(h.canonical(expected))
      : h.looseEqual(observedRaw, expectedRaw);

    return {
      passed: matched,
      logs: matched ? '' : 'observed ' + observedRaw.slice(0, 300) + ' but expected ' + expectedRaw.slice(0, 300),
      detail: {
        observed: observedRaw.slice(0, 300),
        expected: expectedRaw.slice(0, 300),
        comparison: observed !== null && expected !== null ? 'json-structural' : 'text-normalized',
      },
    };
  },
};
