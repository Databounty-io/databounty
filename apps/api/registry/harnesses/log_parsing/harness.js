/**
 * exact-output-match — parsing_or_query_code must produce
 * expected_extracted_metrics when run against log_fixture.
 *
 * `query_language` is a descriptive label only ("SQL (log data loaded into a
 * table)", "Python + regex", etc.) — every row's actual parsing_or_query_code
 * is real Python (the "SQL" rows use the stdlib sqlite3 module via Python's
 * DB-API, not a standalone SQL engine), so there is exactly one execution
 * path needed, not one per label.
 *
 * Execution goes through h.runCode('python', ...) rather than a bare
 * h.run('python3', [file]) so this category gets the same protection every
 * other polyglot-execution category already has: PY_PRELUDE traps
 * sys.exit()/os._exit()/exit()/quit() to a raised exception instead of a
 * silent clean termination, and PY_DRIVER structurally catches
 * `raise SystemExit(...)` around the whole script (sys.exit() IS just that
 * raise, so patching the function alone does not stop it). Without this, a
 * submission could print a forged "@@..." line and call sys.exit(0) before
 * this file's own result-serialization code ever ran, unilaterally deciding
 * its own verdict. The result is also read back via a per-run random marker
 * (h.lastMarked) rather than "the last/only line of stdout", so an ordinary
 * stray print() left in while developing a parser no longer corrupts the
 * comparison target.
 */
'use strict';

const crypto = require('crypto');

const RESULT_NAMES = ['errors', 'result', 'metrics', 'out', 'counts', 'output', 'summary'];
const TIMEOUT_MS = 20000;

// Builds the full program run against a given (absolute) log-file path:
// load the fixture, run the contributor's code, then serialize every
// conventionally-named result variable the code happens to define (not just
// the first match) behind a random marker line. `_real_dumps = json.dumps`
// captured before the contributor's code runs genuinely survives a later
// `json.dumps` monkeypatch. `_real_print`, despite the name, is NOT `print`
// captured as a reference -- CPython's print() resolves its output stream
// from `sys.stdout` fresh at every call, never bound at reference-capture
// time, so code reassigning `sys.stdout` would intercept even an earlier-
// captured print reference's output. `_real_print` instead writes directly
// to file descriptor 1 via `os.write`, which never goes through the
// `sys.stdout` Python object (or any reassignment of it) at all -- the same
// fix already applied to competitive_programming's/compression's harnesses.
function buildProg(logAbsPath, code, mark) {
  return [
    'import re, json, sys, os, collections',
    'from collections import Counter, defaultdict',
    'def _real_print(_s):',
    '    os.write(1, (_s + "\\n").encode("utf-8", "replace"))',
    '_real_dumps = json.dumps',
    // encoding is pinned explicitly: Python's open() without one falls back
    // to locale.getpreferredencoding(), which is NOT guaranteed to be UTF-8
    // (confirmed mojibake on a non-UTF-8-locale host) even though the
    // fixture is always written as UTF-8 bytes by h.fs.writeFileSync.
    'LOG = open(' + JSON.stringify(logAbsPath) + ', encoding="utf-8").read()',
    'lines = LOG.splitlines()',
    code,
    '_cr_names = ' + JSON.stringify(RESULT_NAMES),
    '_cr_candidates = {}',
    'for _cr_n in _cr_names:',
    '    if _cr_n in dir():',
    '        try:',
    '            _cr_candidates[_cr_n] = eval(_cr_n)',
    '        except Exception:',
    '            pass',
    // Counter/dict/list results must serialize as real JSON (a Counter is a
    // dict subclass, so json.dumps handles it directly) — wrapping
    // everything in str() first, as an earlier version of this did,
    // produced Python repr text like "Counter({...})" that can never
    // structurally match a JSON-object expected value. A set/frozenset
    // result (not directly JSON-serializable either) is coerced to a
    // sorted list for the same reason.
    'def _cr_to_jsonable(v):',
    '    try:',
    '        json.dumps(v)',
    '        return v',
    '    except TypeError:',
    '        if isinstance(v, (set, frozenset)):',
    '            try:',
    '                return sorted(v)',
    '            except TypeError:',
    '                return str(v)',
    '        return str(v)',
    '_cr_candidates_j = {}',
    'for _cr_n, _cr_v in _cr_candidates.items():',
    '    _cr_candidates_j[_cr_n] = _cr_to_jsonable(_cr_v)',
    '_real_print(' + JSON.stringify(mark) + ' + _real_dumps(_cr_candidates_j))',
  ].join('\n');
}

function numClose(a, b) {
  const an = Number(a), bn = Number(b);
  return !Number.isNaN(an) && !Number.isNaN(bn) && Math.abs(an - bn) < 0.01;
}

// Recursive structural-equal-with-numeric-tolerance: the plain top-level
// Number()-based tolerance check below only ever fires for a bare scalar
// payload ("133.33"), never for a float nested inside a dict/list ({"avg":
// 133.33333333333334} vs {"avg": 133.33}) — a routine shape for this
// category (per-key averages/latencies/percentiles) and previously a
// guaranteed false reject of correct arithmetic.
function structuralNumericEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!structuralNumericEqual(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => structuralNumericEqual(a[k], b[k]));
  }
  if ((typeof a === 'number' || typeof a === 'string') && (typeof b === 'number' || typeof b === 'string')) {
    return numClose(a, b);
  }
  return false;
}

function isTrivialValue(v) {
  if (v === 0 || v === '0' || v === '' || v === false || v === null) return true;
  if (Array.isArray(v)) return v.length === 0 || v.every(isTrivialValue);
  if (v && typeof v === 'object') return Object.keys(v).length === 0 || Object.values(v).every(isTrivialValue);
  return false;
}

// One candidate's value against expected_extracted_metrics, trying every
// comparison mode this contract supports, from strictest to loosest.
function matchOne(h, actual, expected) {
  const actualStr = typeof actual === 'string' ? actual : JSON.stringify(actual);
  let mode = 'strict';
  let ok = actualStr.trim() === expected;
  let structuralAttempted = false;
  if (!ok && actual !== null && typeof actual === 'object') {
    const expectedParsed = h.jsonOf(expected);
    if (expectedParsed !== null) {
      structuralAttempted = true;
      const canonActual = h.canonical(actual);
      const canonExpected = h.canonical(expectedParsed);
      ok = JSON.stringify(canonActual) === JSON.stringify(canonExpected);
      if (ok) mode = 'json-structural';
      if (!ok) {
        ok = structuralNumericEqual(canonActual, canonExpected);
        if (ok) mode = 'structural-numeric-tolerance';
      }
    }
  }
  // Only fall back to the looser text-normalized comparison when a real
  // structural comparison wasn't even possible (expected isn't valid
  // JSON, or actual isn't an object) — once both sides are known,
  // comparable JSON values, a structural mismatch is a REAL mismatch.
  // looseEqual strips ALL brackets, erasing nesting depth: "[[1,2],[3,4]]"
  // and "1,2,3,4" would otherwise compare equal despite being genuinely
  // different shapes (e.g. a bug that flattens a per-group breakdown).
  if (!ok && !structuralAttempted) { ok = h.looseEqual(actualStr, expected); if (ok) mode = 'text-normalized'; }
  // Numeric metrics (averages, percentiles) can differ only in trailing
  // float precision ("362.5" vs "362.50000000000006") — a real answer, not
  // a wrong one.
  if (!ok) {
    if (numClose(actualStr, expected)) { ok = true; mode = 'numeric-tolerance'; }
  }
  return { ok, mode, actualStr };
}

module.exports = {
  contract: 'exact-output-match',
  requires: ['python3'],

  verify(row, h) {
    const logFixture = h.str(row, 'log_fixture');
    const code = h.str(row, 'parsing_or_query_code');
    const expected = h.str(row, 'expected_extracted_metrics').trim();
    if (!code || !expected) return { passed: false, detail: { reason: 'missing parsing_or_query_code or expected_extracted_metrics' } };

    // LOG/lines are the ONLY channel this harness exposes for the fixture's
    // content — code that references neither cannot possibly be a function
    // of log_fixture at all, and can only ever be passing because the
    // contributor also supplied expected_extracted_metrics themselves
    // (confirmed exploitable: `result = {"payments": 1}` against an
    // unrelated fixture passes with zero real parsing logic). This alone
    // doesn't prove genuine dependency — see the differential check below —
    // but it is a necessary condition with effectively zero false-reject
    // risk, since any code that legitimately reads the fixture must use one
    // of these two names to do so.
    if (!/\bLOG\b|\blines\b/.test(code)) {
      return { passed: false, detail: { reason: 'parsing_or_query_code never references LOG or lines -- appears independent of log_fixture' } };
    }

    const d = h.workdir();
    const logPath = h.path.join(d, 'app.log');
    h.fs.writeFileSync(logPath, logFixture);
    const mark = '@@LOGROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const prog = buildProg(logPath, code, mark);

    const r = h.runCode('python', prog, TIMEOUT_MS);
    if (r.unavailable) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: (r.runtime || 'python3') + ' not available in sandbox',
        detail: { reason: 'runtime unavailable', runtime: r.runtime },
      };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr).slice(0, 1500), detail: { ranClean: false, timedOut: !!r.timedOut } };
    }

    // rawStdout (uncapped), not the 32000-char-capped stdout: a submission
    // whose result serializes past OUT_CAP could otherwise have its trailing
    // marker line truncated away and be scored a false FAIL.
    const markedOut = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let candidates = null;
    try { candidates = markedOut === null ? null : JSON.parse(markedOut); } catch (e) { candidates = null; }
    candidates = candidates && typeof candidates === 'object' && !Array.isArray(candidates) ? candidates : {};
    const definedNames = Object.keys(candidates);

    // Try each conventionally-named candidate the code actually defined, in
    // documented priority order, and accept the first one that MATCHES
    // expected -- rather than committing to a single priority-ordered pick
    // before ever comparing it. The dataset's own convention is inconsistent
    // about which of these 7 names carries the "real" final answer; picking
    // by priority alone can select an earlier, unrelated/intermediate
    // variable over a later one that actually holds the correct result
    // (confirmed: `result` = an unfiltered intermediate Counter, `summary` =
    // the correct final dict -- old logic silently chose `result` and
    // false-rejected a correct submission).
    let chosen = null;
    let chosenMatch = null;
    for (const n of RESULT_NAMES) {
      if (!(n in candidates)) continue;
      const m = matchOne(h, candidates[n], expected);
      if (m.ok) { chosen = n; chosenMatch = m; break; }
    }
    if (!chosen) {
      chosen = RESULT_NAMES.find((n) => n in candidates) || null;
      chosenMatch = chosen ? matchOne(h, candidates[chosen], expected) : matchOne(h, null, expected);
    }
    let ambiguousNames = null;
    if (definedNames.length > 1) {
      const distinct = new Set(definedNames.map((n) => JSON.stringify(h.canonical(candidates[n]))));
      if (distinct.size > 1) ambiguousNames = definedNames;
    }

    let ok = chosenMatch.ok;
    let mode = chosenMatch.mode;
    const actualStr = chosenMatch.actualStr;

    // Fixture-independence check: a submission whose output doesn't change
    // at all when the fixture is emptied out never genuinely depended on
    // log_fixture's content, regardless of what it superficially reads.
    // Skipped when expected itself is "trivial" (0/empty/all-zero) -- for
    // those rows an empty fixture legitimately produces the same answer,
    // and the check can't discriminate. A crash on the empty fixture, or the
    // chosen variable no longer being defined at all, both PROVE dependency
    // (the behavior did change) and are correctly not flagged.
    if (ok && chosen && logFixture.trim() !== '') {
      const expectedParsed = h.jsonOf(expected);
      const trivial = expectedParsed !== null ? isTrivialValue(expectedParsed) : (expected === '' || expected === '0');
      if (!trivial) {
        const dEmpty = h.workdir();
        const emptyLogPath = h.path.join(dEmpty, 'app.log');
        h.fs.writeFileSync(emptyLogPath, '');
        const progEmpty = buildProg(emptyLogPath, code, mark);
        const rEmpty = h.runCode('python', progEmpty, TIMEOUT_MS);
        if (!rEmpty.unavailable && rEmpty.ok === true) {
          const markedEmpty = h.lastMarked(rEmpty.rawStdout != null ? rEmpty.rawStdout : rEmpty.stdout, mark);
          let candidatesEmpty = null;
          try { candidatesEmpty = markedEmpty === null ? null : JSON.parse(markedEmpty); } catch (e) { candidatesEmpty = null; }
          if (candidatesEmpty && typeof candidatesEmpty === 'object' && chosen in candidatesEmpty) {
            const sameOutput = JSON.stringify(h.canonical(candidates[chosen])) === JSON.stringify(h.canonical(candidatesEmpty[chosen]));
            if (sameOutput) {
              ok = false;
              return {
                passed: false,
                logs: 'parsing_or_query_code produced the identical result whether or not log_fixture had any content -- appears independent of the fixture (possible hardcoded/fabricated result)',
                detail: { reason: 'fixture-independence check failed', matchMode: 'none', chosenVariable: chosen },
              };
            }
          }
        }
      }
    }

    return {
      passed: ok,
      logs: ok ? '' : ('produced ' + actualStr.slice(0, 300) + ' but expected ' + expected.slice(0, 300)),
      detail: {
        matchMode: ok ? mode : 'none',
        actual: actualStr.slice(0, 300),
        expected: expected.slice(0, 300),
        chosenVariable: chosen,
        ambiguousNames,
      },
    };
  },
};
