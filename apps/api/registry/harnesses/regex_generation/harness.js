/**
 * regex_match — the pattern must match every positive string, no negative
 * string, and must not catastrophically backtrack.
 *
 * ReDoS detection does NOT rely solely on whatever strings the contributor
 * happened to supply: schema.json only ADVISES including an adversarial
 * string, it never enforces it, so a genuinely catastrophic pattern whose
 * contributor-supplied test strings all happen to be short/benign would
 * otherwise sail through with redosTimeout:false. Confirmed exploitable
 * against the prior version of this file using this exact dataset's own
 * "FLAWED... vulnerable to catastrophic backtracking" reference pattern
 * (^(a+)+$) with only short, non-adversarial test strings. A small, fixed
 * set of harness-generated stress probes now always runs first, using its
 * OWN short timeout independent of the contributor-declared timeout_ms (so
 * declaring an enormous timeout_ms can't hide a catastrophic pattern behind
 * a budget that makes a real hang look "within expectations"). This does
 * not prove absence of ReDoS for every conceivable pattern shape (that's a
 * genuinely hard, near-undecidable static-analysis problem) -- it targets
 * the classic nested/alternated-quantifier blowup shape this dataset's own
 * flawed rows use, which covers the overwhelming majority of real-world
 * catastrophic patterns; a pattern keyed to an alphabet the probe strings
 * never touch (e.g. only ever blows up on a specific Unicode range) is an
 * accepted residual.
 */
'use strict';

const PATTERN_LEN_CAP = 10000;
// Guards the exact same argv-length failure mode as PATTERN_LEN_CAP (both
// values get JSON.stringify()'d into a single argv element for the child
// process -- see attempt() below), but the previous 100000 had effectively
// no safety margin: a control-character-heavy string near that cap can
// JSON-escape (each such char needs a \u00XX 6-character escape) to ~6x its
// length, i.e. ~600000 bytes, well past Linux's ~128KB MAX_ARG_STRLEN. Real
// dataset's longest test string is 900 chars (verified against New_Tester +
// sample_datasets), so this has enormous headroom left over.
const STRING_LEN_CAP = 15000;
const MAX_STRINGS_PER_LIST = 50;
// Comfortably under the outer sandbox command's default 120s budget, leaving
// margin for node/python process-spawn overhead across every call this
// verify() makes (probes + both contributor lists) and file-write overhead.
const TOTAL_BUDGET_MS = 40000;
const PROBE_LENGTHS = [20, 30];
const PROBE_TIMEOUT_MS = 1500;

/**
 * A regex test-set field is normally entered as one test case per textarea
 * line. A JSON array is the unambiguous form for cases that themselves contain
 * a newline, because splitting that value would turn one test into many.
 */
function testStrings(row, key, h) {
  const value = row ? row[key] : undefined;
  if (Array.isArray(value)) return value.map(function (entry) { return String(entry); });
  if (typeof value !== 'string') return value == null ? [] : [String(value)];
  if (!value) return [];

  const parsed = h.jsonOf(value);
  if (Array.isArray(parsed)) return parsed.map(function (entry) { return String(entry); });

  const lines = value.split(/\r?\n/);
  // Textareas commonly retain one final newline. It is a terminator, not an
  // extra empty test case; interior blank lines remain intentional test data.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

module.exports = {
  contract: 'regex_match',
  requires: ['node'],

  verify(row, h) {
    const pattern = h.str(row, 'generated_regex');
    if (!pattern) return { passed: false, detail: { reason: 'no pattern supplied' } };
    // A pattern/string long enough to blow an OS argv-length limit
    // (confirmed platform-dependent, e.g. ENAMETOOLONG on Windows around
    // 2MB, Linux's MAX_ARG_STRLEN around 128KB) previously surfaced as
    // r.status===null and was misread as a ReDoS timeout -- rejecting
    // outright here (ambiguous, not a wrong-answer or a hang) is more
    // honest than either mislabeling it or risking the platform-dependent
    // failure. Real dataset's longest pattern/string are 77/900 chars, so
    // this has no false-reject risk there.
    if (pattern.length > PATTERN_LEN_CAP) {
      return { passed: false, runtimeUnavailable: true, logs: 'generated_regex exceeds the length this harness can safely pass to a child process', detail: {} };
    }

    // Preserve the pre-slice totals: schema.json places no upper bound on how
    // many test strings a contributor can supply for these list-role fields,
    // so a list silently truncated from e.g. 60 down to MAX_STRINGS_PER_LIST
    // must remain detectable -- otherwise a row with its one pattern-breaking
    // string sitting at position 51+ would report a clean passed:true with
    // nothing in logs/detail indicating the truncation ever happened.
    const mustMatchAll = testStrings(row, 'test_strings_match', h);
    const mustNotAll = testStrings(row, 'test_strings_no_match', h);
    const mustMatch = mustMatchAll.slice(0, MAX_STRINGS_PER_LIST);
    const mustNot = mustNotAll.slice(0, MAX_STRINGS_PER_LIST);
    const truncated = mustMatchAll.length > mustMatch.length || mustNotAll.length > mustNot.length;
    if (!mustMatch.length && !mustNot.length) {
      return { passed: false, detail: { reason: 'no test strings supplied' } };
    }
    if ([...mustMatch, ...mustNot].some((s) => String(s).length > STRING_LEN_CAP)) {
      return { passed: false, runtimeUnavailable: true, logs: 'a test string exceeds the length this harness can safely pass to a child process', detail: {} };
    }

    const declared = parseInt(h.str(row, 'timeout_ms') || '200', 10) || 200;
    // A few hundred ms is not reliably measurable on a shared sandbox host, so
    // allow a floor while still catching a true ReDoS hang. Ceiling caps a
    // contributor-controlled timeout_ms from holding the sandbox indefinitely.
    const budget = Math.min(Math.max(declared, 2000), 30000);

    const d = h.workdir();
    h.fs.writeFileSync(h.path.join(d, 'm.js'), [
      'const pat = JSON.parse(process.argv[2]); const s = JSON.parse(process.argv[3]);',
      'let re; try { re = new RegExp(pat); } catch (e) { process.stdout.write(JSON.stringify({ uncompilable: true })); process.exit(0); }',
      'process.stdout.write(JSON.stringify({ m: re.test(s) }));',
    ].join('\n'));
    h.fs.writeFileSync(h.path.join(d, 'm.py'), [
      'import re, sys, json',
      'pat = json.loads(sys.argv[1]); s = json.loads(sys.argv[2])',
      'try:',
      '    c = re.compile(pat)',
      'except Exception:',
      '    print(json.dumps({"uncompilable": True})); sys.exit(0)',
      'print(json.dumps({"m": bool(c.search(s))}))',
    ].join('\n'));

    // Tracked across EVERY child-process call this verify() makes (probes
    // and both contributor lists) -- an earlier version derived each call's
    // own timeout purely from the contributor-declared budget with no
    // aggregate cap, so a row with several large/adversarial strings could
    // legitimately accumulate well past the outer sandbox command's own
    // budget (confirmed: 3 adversarial strings at an allowed declared
    // timeout already took 24s; the harness's own permitted ceiling of
    // 30000ms needs only 4 such strings to meet the entire 120s outer
    // budget). When a real outer timeout fires mid-verify(), nothing after
    // it runs at all -- no clean verdict, just an infra-level failure.
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    function remaining() { return deadline - Date.now(); }

    // The reference data is MIXED-DIALECT and never says which flavour a
    // pattern is written in: Python's `re` is Unicode-aware for \d/\w where
    // JS's are ASCII-only, and Python's `$` also matches just before a
    // trailing newline where JS's (no /m/) matches only true end-of-string.
    // Try JS first and fall back to Python on a compile failure. A pattern
    // valid in neither is a rejection, not a harness fault. (Whether a
    // (?i:...) inline-flag group actually fails to compile in JS is Node
    // version-dependent -- true on older engines, not on the one probed for
    // this audit -- so that specific rationale may not always be why the
    // fallback triggers for a given sandbox image, but the fallback itself
    // is still correct to have regardless of which row exercises it.)
    //
    // "Try compiling in Node first" is not a sufficient signal on its own:
    // Python's \A / \Z / \z string anchors are NOT invalid syntax in a JS
    // RegExp compiled without the `u` flag (which is exactly how this
    // harness compiles it, in the m.js source written below: `new
    // RegExp(pat)` with no flags argument). Per ECMA-262 Annex B they are
    // silently accepted as identity-escapes for the literal letters A/Z/z --
    // confirmed: new RegExp('\\Aabc\\Z').test('xAabcZy') === true, matching
    // the literal substring "AabcZ" with no anchoring at all. So a
    // Python-authored pattern like \Aabc\Z compiles cleanly in Node, never
    // trips the compile-failure fallback below, and then gets verified
    // against completely different (unanchored, literal-letter) semantics
    // than the contributor intended. Detect the anchor escape directly in
    // the pattern's actual runtime string content and force the Python path
    // when found, rather than trusting a successful Node compile.
    //
    // Must distinguish the escape sequence \A (single backslash + letter --
    // an anchor) from an escaped literal backslash followed by a literal
    // letter, e.g. \\A (two backslash *characters* in the string content,
    // meaning "match a literal backslash, then literal A"). A run of N
    // backslash characters immediately preceding A/Z/z resolves (regex
    // engines process backslash-pairs left to right) to floor(N/2) literal
    // backslashes plus, if N is odd, one leftover backslash that escapes the
    // following letter -- i.e. only an ODD backslash-run signals a real
    // anchor escape.
    function hasPythonStringAnchor(pat) {
      const re = /\\+[AZz]/g;
      let m;
      while ((m = re.exec(pat))) {
        const backslashRun = m[0].length - 1;
        if (backslashRun % 2 === 1) return true;
      }
      return false;
    }
    const pythonAnchorSignal = hasPythonStringAnchor(pattern);
    let engine = null;

    function attempt(which, s, timeoutMs) {
      const isNode = which === 'node';
      const file = h.path.join(d, isNode ? 'm.js' : 'm.py');
      const r = h.run(isNode ? 'node' : 'python3', [file, JSON.stringify(pattern), JSON.stringify(s)], { cwd: d, timeoutMs });
      // Only a REAL timeout (helpers.js's r.timedOut, correctly derived from
      // SIGTERM/ETIMEDOUT) counts as a possible ReDoS hang. r.status===null
      // for any OTHER reason (e.g. a spawn failure) is a distinct error, not
      // a timing signal -- conflating the two previously mislabeled an
      // unrelated OS-level failure as "possible catastrophic backtracking".
      if (r.timedOut) return { timedOut: true };
      // A non-timeout, non-zero status is not something a well-formed
      // compile-or-match run of m.js/m.py is expected to produce on any
      // NORMAL path (every intended branch in both scripts prints JSON and
      // exits 0), so in practice this means something went wrong outside
      // this harness's own control -- e.g. spawnSync itself failing
      // (ENAMETOOLONG/E2BIG on an argv this harness's own length caps failed
      // to catch), node/python3 missing or crashing, or some other
      // unanticipated child-process failure. This file has no reliable way
      // to distinguish that from a genuine "pattern is wrong" case here, so
      // -- per the same philosophy PATTERN_LEN_CAP's rejection already uses
      // (see that comment) -- an ambiguous result routes to
      // runtimeUnavailable rather than being scored as a wrong answer.
      if (r.status !== 0) return { runtimeUnavailable: true, err: 'spawn/runtime error: ' + String(r.stderr || '').slice(0, 160) };
      const parsed = h.jsonOf(String(r.stdout).trim());
      return parsed || { err: String(r.stderr).slice(0, 160) };
    }

    // Resolve which engine the pattern actually compiles in ONCE (compiling
    // is a property of the pattern alone, not of which string is tested),
    // using a throwaway string so this doesn't consume a contributor slot.
    function resolveEngine(timeoutMs) {
      if (engine) return null;

      // A literal \A/\Z/\z string-anchor escape is a strong Python-dialect
      // signal that a successful Node compile must NOT be allowed to
      // override (see the comment above pythonAnchorSignal) -- go straight
      // to Python without ever attempting the Node compile.
      if (pythonAnchorSignal) {
        if (!h.have('python3')) {
          return { runtimeUnavailable: true, err: 'pattern uses a Python-style \\A/\\Z/\\z string anchor but python3 is unavailable to verify Python-dialect semantics' };
        }
        const pyOut = attempt('python3', '', timeoutMs);
        if (pyOut && pyOut.runtimeUnavailable) return pyOut;
        if (pyOut && !pyOut.uncompilable) { engine = 'python3'; return null; }
        return { err: 'pattern uses a Python-style \\A/\\Z/\\z string anchor but does not compile in Python' };
      }

      const out = attempt('node', '', timeoutMs);
      if (out && out.runtimeUnavailable) return out;
      if (out && out.uncompilable) {
        if (!h.have('python3')) return { runtimeUnavailable: true, err: 'pattern does not compile in JS and python3 is unavailable' };
        const alt = attempt('python3', '', timeoutMs);
        if (alt && alt.runtimeUnavailable) return alt;
        if (alt && !alt.uncompilable) { engine = 'python3'; return null; }
        return { err: 'pattern compiles in neither JS nor Python' };
      }
      if (!out.timedOut) engine = 'node';
      return null;
    }

    function test(s, timeoutMs) {
      if (!engine) {
        const resolveErr = resolveEngine(timeoutMs);
        if (resolveErr) return resolveErr;
      }
      return attempt(engine || 'node', s, timeoutMs);
    }

    // Always-run synthetic stress probes, independent of anything the
    // contributor supplied, using PROBE_TIMEOUT_MS (never the
    // contributor-declared budget) so this can't be defeated by declaring
    // an inflated timeout_ms. Increasing lengths so a genuinely catastrophic
    // pattern is very likely to hang even at the shorter length, and the
    // super-linear growth pattern itself is additional (logged) evidence.
    let redos = false;
    const probeResults = [];
    for (const n of PROBE_LENGTHS) {
      if (remaining() < PROBE_TIMEOUT_MS) break;
      const probeStr = 'a'.repeat(n) + '!';
      const t = test(probeStr, Math.min(PROBE_TIMEOUT_MS, Math.max(0, remaining())));
      if (t && t.runtimeUnavailable) {
        return { passed: false, runtimeUnavailable: true, logs: t.err, detail: { engine: engine || 'node' } };
      }
      probeResults.push({ n, timedOut: !!(t && t.timedOut) });
      if (t && t.timedOut) { redos = true; break; }
    }

    const checks = [];
    let ok = !redos;
    let unavailable = null;

    if (!redos) {
      for (const s of mustMatch) {
        if (unavailable || remaining() <= 0) break;
        const t = test(s, Math.min(budget, Math.max(0, remaining())));
        if (t.runtimeUnavailable) { unavailable = t; break; }
        checks.push({ s: String(s).slice(0, 60), want: true, got: t });
        if (t.timedOut) { redos = true; ok = false; } else if (t.m !== true) ok = false;
      }
      if (!unavailable) {
        for (const s of mustNot) {
          if (remaining() <= 0) break;
          const t = test(s, Math.min(budget, Math.max(0, remaining())));
          if (t.runtimeUnavailable) { unavailable = t; break; }
          checks.push({ s: String(s).slice(0, 60), want: false, got: t });
          if (t.timedOut) { redos = true; ok = false; } else if (t.m !== false) ok = false;
        }
      }
    }

    if (unavailable) {
      return { passed: false, runtimeUnavailable: true, logs: unavailable.err, detail: { engine: engine || 'node' } };
    }
    // Two distinct ways verification can be INCOMPLETE despite no failure
    // found in what WAS checked -- neither is a clean pass; both route to
    // human review rather than reward an incompletely-verified row:
    //   1. ran out of aggregate time budget before finishing every RETAINED
    //      (post-slice) string;
    //   2. one or both contributor lists were themselves silently truncated
    //      to MAX_STRINGS_PER_LIST before any checking even began, so
    //      entries beyond that cut were never examined at all. This is
    //      forced to runtimeUnavailable rather than merely noted in detail
    //      on an otherwise-clean pass, because it is the same class of
    //      hazard as (1) -- unverified contributor-declared cases -- and a
    //      contributor padding a list past the cut with the one
    //      pattern-breaking (or ReDoS-triggering) case at the end must not
    //      be able to obtain a silent, undocumented pass this way.
    if (ok && (truncated || (remaining() <= 0 && checks.length < mustMatch.length + mustNot.length))) {
      const logs = truncated
        ? 'test_strings_match/test_strings_no_match had more entries than this harness retains per list (MAX_STRINGS_PER_LIST=' + MAX_STRINGS_PER_LIST + '); entries beyond the cut were never verified'
        : 'ran out of verification time budget before checking every test string';
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: logs,
        detail: {
          engine: engine || 'node',
          checksCompleted: checks.length,
          checksTotal: mustMatch.length + mustNot.length,
          mustMatchTotal: mustMatchAll.length,
          mustNotTotal: mustNotAll.length,
          truncated: truncated,
        },
      };
    }

    return {
      passed: ok,
      testsRun: checks.length,
      logs: redos ? 'pattern exceeded the matching budget (possible catastrophic backtracking)' : '',
      detail: {
        engine: engine || 'node',
        declaredTimeoutMs: declared,
        budgetMs: budget,
        redosTimeout: redos,
        probeResults,
        checks: checks.slice(0, 10),
      },
    };
  },
};
