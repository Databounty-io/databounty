/**
 * argparse-behavior-match -- cli_argument_parsing.
 *
 * THE CONTRACT: solution_code (real, contributor-controlled Python) defines
 * exactly one top-level, zero-argument function `build_parser()` that
 * constructs and returns a real `argparse.ArgumentParser` instance (or a
 * subclass instance) per the row's own task_description. The harness calls
 * build_parser() EXACTLY ONCE, then drives the SAME parser instance through
 * every one of invocations' own argv lists, IN ORDER, via real,
 * unmodified `parser.parse_args(argv)` calls. Each invocation declares its
 * own required outcome -- a successful parse (checked via exact equality
 * against parse_args' own real returned Namespace.__dict__) or a real parse
 * failure (checked via the real SystemExit exit code plus a required
 * substring of the real captured stderr text) -- and the harness's only job
 * is comparing what solution_code's REAL argparse execution actually did
 * against what each invocation's own curator declared it must do.
 *
 * WHY THIS CALLING CONVENTION (harness owns and drives parse_args(), never
 * solution_code): this is the only convention under which the harness can
 * exercise MANY different argv combinations against ONE row's own parser
 * without re-executing solution_code's own module-level code (and thus
 * re-running any import-time side effects) once per invocation, and without
 * needing solution_code to itself read sys.argv or call sys.exit() --
 * neither of which this category's contract needs or wants solution_code to
 * do. It also makes the two things this category cares about -- the exact
 * resulting Namespace, and the exact real SystemExit/stderr behavior on a
 * genuine validation failure -- directly observable, by intercepting nothing
 * at all: parse_args() is called completely unmodified, on a completely real
 * ArgumentParser, and its own real behavior (including argparse's own
 * SystemExit-based error convention) is simply observed from outside via a
 * plain try/except SystemExit plus contextlib.redirect_stderr/redirect_stdout
 * around each call.
 *
 * ONE PARSER INSTANCE ACROSS ALL INVOCATIONS -- CONFIRMED SAFE, NOT ASSUMED:
 * build_parser() is called ONCE; every invocation's parse_args(argv) call
 * reuses that same instance. The obvious risk this raises -- CPython's
 * historical action='append'/'extend' gotcha, where a mutable default list
 * object is reused (and therefore silently accumulates) across repeated
 * parse_args() calls on the same parser -- was verified NOT to reproduce
 * empirically against a live Python 3 interpreter before this design was
 * finalized (CPython copies such a default list per call since Python 3.8,
 * bpo-16399): a parser with `add_argument('--tag', action='append',
 * default=[])` parsed twice on the same instance (once supplying --tag,
 * once not) correctly returns an accumulated list on the first call and a
 * FRESH empty list on the second, never a leaked, growing list across calls.
 * Subcommand reuse (repeated parse_args() calls selecting DIFFERENT
 * subparsers on the same top-level parser) was verified the same way and is
 * equally safe -- each call produces an independent Namespace with exactly
 * that subcommand's own dest keys, nothing bleeding in from a prior call.
 *
 * SystemExit CAPTURE MECHANICS: argparse never raises an ordinary catchable
 * exception on a validation failure -- ArgumentParser.error() always calls
 * self.exit(2, message), which is itself always `raise SystemExit(status)`
 * after writing the message to stderr via self._print_message(..., stderr).
 * The Python driver below therefore wraps EVERY parse_args(argv) call in a
 * real `try / except SystemExit as e:` (never a bare `except Exception`,
 * which would NOT catch SystemExit -- it does not inherit from Exception,
 * only from BaseException, precisely so ordinary exception handlers don't
 * accidentally swallow an intentional process exit) and additionally wraps
 * the call in `contextlib.redirect_stderr(io.StringIO())` /
 * `contextlib.redirect_stdout(io.StringIO())` so the real stderr TEXT
 * argparse's own error() printed is captured and inspectable, and so no
 * per-invocation output (including a stray print_usage()/print_help() a
 * misbehaving custom action might trigger) ever reaches this driver's own
 * stdout, where it could otherwise land between two of this driver's own
 * marker-line checkpoints and corrupt them (see MARKER LINE ROBUSTNESS
 * below). A plain BaseException OTHER than SystemExit escaping parse_args()
 * (e.g. a custom `type=`/`action=` callable that raises something argparse's
 * own _get_value() does NOT catch and convert into a proper .error() call --
 * argparse only catches ArgumentTypeError/TypeError/ValueError there) is
 * real, meaningful signal of its own: it means solution_code's parser is
 * broken in a way argparse's own contract does not paper over, and is
 * reported as invocation_unexpected_exception, a real failure, regardless of
 * that invocation's own declared outcome.
 *
 * PY_PRELUDE'S sys.exit BLOCK VS argparse'S OWN LEGITIMATE sys.exit USE --
 * A REAL BUG FOUND AND FIXED DURING THIS CATEGORY'S OWN SELF-TEST, NOT
 * HYPOTHETICAL: helpers.js's shared PY_PRELUDE (used registry-wide) patches
 * sys.exit/os._exit/os.abort/builtins.exit/builtins.quit to raise instead of
 * exiting, on the (elsewhere-correct) assumption that no ordinary submission
 * legitimately needs to call sys.exit() itself. That assumption is FALSE for
 * this one category specifically: argparse's OWN internal ArgumentParser.
 * exit()/.error() calls the REAL sys.exit(status) as its documented,
 * standard failure-signaling mechanism -- and because sys is a process-wide
 * singleton module object (PY_PRELUDE's own `import sys as _cr_sys` binds a
 * SECOND name to the exact same object, never a copy), patching sys.exit
 * ANYWHERE patches it for argparse's own internal `_sys.exit(status)` call
 * too. Confirmed by this category's own self-test: every one of a correct
 * solution_code's own genuine parse-failure invocations came back
 * `invocation_unexpected_exception: RuntimeError('exit() call blocked --
 * forbidden inside submission code')` instead of a real SystemExit, before
 * this fix. FIXED HERE, NOT IN helpers.js: rewriting PY_PRELUDE itself would
 * weaken the exit-forgery guard for every OTHER category that correctly
 * relies on it being unconditional, for the sake of one category's own
 * narrow, legitimate need -- out of scope and unnecessarily risky. Instead,
 * `_CR_REAL_SYS_EXIT = sys.exit` is captured in THIS driver's own script,
 * BEFORE pyPrelude ever runs (see buildDriverScript below), and sys.exit is
 * restored to that real reference for the exact duration of each
 * parser.parse_args(argv) call ONLY, then immediately re-patched back to
 * pyPrelude's own blocked version in a `finally` -- so the guard stays fully
 * active for solution_code's own module-level exec() (where build_parser()
 * is defined) and everywhere else, and is only ever relaxed around the one
 * real, standard-library call site that legitimately needs it. This does
 * NOT reopen the exit-forgery hole PY_PRELUDE exists to close: ANY SystemExit
 * caught during that window -- whether raised by argparse's own real
 * error() path or by a misbehaving custom type=/action= callable invoked
 * FROM WITHIN that same parse_args() call, calling sys.exit() directly -- is
 * routed uniformly to this invocation's own real "parse failure" outcome and
 * compared against ITS OWN declared expected_exit_code/expected_error_
 * substring; raised_system_exit=True can never itself produce a "success"
 * verdict (see verify()'s own per-invocation comparison below), so a
 * malicious callable calling sys.exit(0) to LOOK like a clean exit still
 * only ever reaches the failure-comparison branch, where it must still match
 * the row's own declared failure expectation to pass.
 *
 * MARKER LINE ROBUSTNESS: every checkpoint the driver writes is prefixed
 * with a leading "\n" before the mark itself (`"\n" + MARK + json...`),
 * defensive hardening against the one realistic way a marker line could be
 * corrupted here -- build_parser() itself (called OUTSIDE any stdout
 * redirection, since it must be free to construct real objects, and
 * argparse's own construction never writes anything, but a contributor's
 * own top-level code technically could) printing a partial line with no
 * trailing newline immediately before a checkpoint write, which would
 * otherwise land mid-line and defeat h.lastMarked's own start-of-line marker
 * scan.
 *
 * ANTI-HARDCODING -- TWO LAYERS, NEITHER OPTIONAL:
 * (a) STRUCTURAL, RUNTIME: `isinstance(parser, argparse.ArgumentParser)`,
 * checked immediately after build_parser() returns, before a single
 * invocation is ever run. This alone already rules out the overwhelming
 * majority of a "fake parser" attack (a hand-rolled if/elif dispatcher, a
 * dict lookup table, a bespoke object exposing only a few methods) -- fully
 * reimplementing ArgumentParser's real interface (parse_args' own return
 * contract, subparsers, mutually-exclusive-group enforcement, real
 * SystemExit-based error signaling with matching stderr text) convincingly
 * enough to pass every downstream invocation check is far more work than
 * just using the real stdlib class it would be impersonating.
 * (b) STRUCTURAL, DATASET-AUTHORING, PRE-EXECUTION: validateInvocations()
 * below enforces (i) a minimum invocation count (4), (ii) at least 2
 * outcome:"success" invocations whose OWN declared expected_namespace values
 * are mutually different (canonical-JSON compared), and (iii) at least 1
 * outcome:"failure" invocation. Because a passing row's real actual results
 * are required to exactly equal their own declared expectations (see the
 * per-invocation comparison below), (ii) transitively guarantees that a
 * PASSING row's own real, distinct argv combinations produced real,
 * genuinely distinct Namespace results too -- a solution_code whose parser
 * secretly ignores argv and always returns one fixed Namespace cannot
 * satisfy two invocations whose declared expected_namespace values
 * genuinely differ, no matter how it is built. Unlike numerical_precision's
 * own perturb-and-rerun runtime gate, no equivalent runtime mutation is
 * needed or meaningful here: argparse's own parse_args(argv) is already a
 * pure, deterministic function of argv against the parser's own declared
 * configuration -- there is no separate "hardcode the return value" attack
 * surface once (a) has ruled out a non-real ArgumentParser, since a REAL
 * ArgumentParser's behavior is governed entirely by argparse's own C-python-
 * level machinery, not by anything solution_code could special-case per
 * argv short of adding genuinely-real, task_description-matching
 * add_argument()/add_subparsers() configuration.
 *
 * NO INDEPENDENT ORACLE -- SAME REASONED DECISION AS numerical_precision /
 * retry_backoff_resilience's OWN EXPECTED-VALUE FIELDS: task_description is
 * open-ended natural-language prose describing an arbitrary CLI interface;
 * there is no small, fixed algorithm set this harness could implement once
 * and cross-check every row against (unlike rate_limiting_policy_simulation/
 * caching_strategy's five named policies/eviction disciplines apiece).
 * invocations' own expected_namespace/expected_exit_code/
 * expected_error_substring are therefore trusted directly as curator-
 * authored ground truth, mitigated by this pipeline's own llm + human_audit
 * stages downstream of execution, not by mechanical re-derivation --
 * mirroring exactly the trust model and residual numerical_precision's
 * expected_output and retry_backoff_resilience's expected_result already
 * document for this registry. RESIDUAL, HONESTLY DOCUMENTED: a curator's own
 * mistake in hand-tracing argparse's real behavior for a given argv (an
 * expected_namespace value that does not actually match what a CORRECT
 * build_parser() would produce, or an expected_error_substring that happens
 * not to appear in the real message for that failure kind) is not
 * mechanically detectable here and would wrongly fail an otherwise-correct
 * solution_code -- the same class of residual already accepted for both
 * sibling categories above.
 *
 * WHY expected_error_substring, NOT EXACT stderr MATCH: argparse's own
 * usage-line wording is verbose and directly reflects the parser's own
 * metavar/prog/option-string choices (e.g. `usage: conv [-h] --input INPUT
 * [--output OUTPUT] ...`) -- demanding a byte-exact stderr match would force
 * every curator to hand-predict argparse's own internal usage-line wrapping
 * and metavar-derivation rules, an implementation detail of THIS category's
 * own verification, not a property of solution_code's own correctness.
 * argparse's own VALIDATION-KIND vocabulary, however, is stable, documented
 * stdlib convention -- confirmed empirically (not assumed) against a live
 * Python 3 interpreter for every failure kind this category's own schema.json
 * enumerates: a missing required argument or an unfilled required
 * mutually-exclusive group always includes the word "required"; an
 * out-of-choices value always includes "invalid choice"; a `type=int`
 * coercion failure always includes "invalid int value"; a violated
 * mutually-exclusive group always includes "not allowed with argument"; an
 * extra/unknown token always includes "unrecognized arguments". A substring
 * check against these stable phrases proves the RIGHT KIND of validation
 * logic fired without over-fitting to argparse's own cosmetic formatting.
 *
 * TIMEOUT BUDGET: build_parser() plus up to MAX_INVOCATIONS (20) plain
 * parse_args(argv) calls are all pure, in-process, zero-I/O, zero-subprocess,
 * zero-real-sleeping work -- realistically sub-millisecond each even for a
 * deeply nested subcommand tree. TIMEOUT_MS (10000ms) is a wide, generous
 * multiple of that, matching this session's other simulation-style
 * categories' identical sizing rationale; a genuine timeout at this budget
 * is itself meaningful signal (a pathological/adversarial custom type=/
 * action= callable), treated as a real failure, not runtimeUnavailable.
 * Comfortably under the outer sandbox command budget (120000ms, helpers.js's
 * own OUTER_SANDBOX_BUDGET_MS) with roughly 110000ms of margin.
 *
 * GATE ORDER: field presence -> invocations shape/range/per-outcome-shape
 * validation -> invocations diversity anti-hardcoding gates (see ANTI-
 * HARDCODING (b)) -- all four surfaced under the SAME detail.reason
 * "bad_invocations" (distinguished only by the human-readable `logs`
 * message, mirroring retry_backoff_resilience's own single
 * "bad_dependency_behavior" reason covering several distinct structural
 * checks), all dataset-authoring-defect rejections that never touch
 * solution_code or the sandbox -- -> solution_code's own static
 * `def build_parser(` structural check -> h.have('python3') -> the one
 * Python subprocess (build_parser() called once, isinstance-checked, then
 * every invocation's parse_args() called in order with a checkpoint after
 * each) -> per-invocation real-vs-declared comparison, in declared order,
 * first mismatch wins.
 */
'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 10000;
const MIN_INVOCATIONS = 4;
const MAX_INVOCATIONS = 20;
const MIN_DISTINCT_SUCCESS_NAMESPACES = 2;
const MAX_ARGV_LEN = 20;
const MAX_ARGV_STR_LEN = 300;
const MAX_NAMESPACE_KEYS = 20;
const MAX_NAMESPACE_KEY_LEN = 40;
const MAX_NAMESPACE_STR_LEN = 500;
const MAX_NAMESPACE_ARRAY_LEN = 20;
const MIN_ERROR_SUBSTRING_LEN = 3;
const MAX_ERROR_SUBSTRING_LEN = 200;
const MAX_STDERR_CAPTURE_LEN = 4000;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ----------------------------------------------------------- invocations ---

/** A single expected_namespace VALUE: a JSON scalar (string/number/boolean/
 * null), or a flat (one level, no nesting) array of such scalars -- covers
 * argparse's own realistic Namespace value shapes (str, int/float via
 * type=, bool via store_true/store_false, None as an unset default, list
 * via nargs='+'/append/extend). Returns { ok, reason }. */
function validateNamespaceValue(v, where) {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    if (typeof v === 'string' && v.length > MAX_NAMESPACE_STR_LEN) {
      return { ok: false, reason: where + ' string value exceeds the maximum of ' + MAX_NAMESPACE_STR_LEN + ' characters' };
    }
    if (typeof v === 'number' && !Number.isFinite(v)) {
      return { ok: false, reason: where + ' must be a finite number' };
    }
    return { ok: true };
  }
  if (Array.isArray(v)) {
    if (v.length > MAX_NAMESPACE_ARRAY_LEN) {
      return { ok: false, reason: where + ' array exceeds the maximum length of ' + MAX_NAMESPACE_ARRAY_LEN };
    }
    for (let i = 0; i < v.length; i++) {
      const item = v[i];
      if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        if (typeof item === 'string' && item.length > MAX_NAMESPACE_STR_LEN) {
          return { ok: false, reason: where + '[' + i + '] string value exceeds the maximum of ' + MAX_NAMESPACE_STR_LEN + ' characters' };
        }
        if (typeof item === 'number' && !Number.isFinite(item)) {
          return { ok: false, reason: where + '[' + i + '] must be a finite number' };
        }
        continue;
      }
      return { ok: false, reason: where + '[' + i + '] must be a string, number, boolean, or null (no nested arrays/objects)' };
    }
    return { ok: true };
  }
  return { ok: false, reason: where + ' must be a string, number, boolean, null, or a flat array of such scalars -- got ' + JSON.stringify(v) };
}

/** Validate one expected_namespace object. Returns { ok, reason }. */
function validateExpectedNamespace(ns, where) {
  if (!ns || typeof ns !== 'object' || Array.isArray(ns)) {
    return { ok: false, reason: where + ' must be a JSON object' };
  }
  const keys = Object.keys(ns);
  if (keys.length > MAX_NAMESPACE_KEYS) {
    return { ok: false, reason: where + ' exceeds the maximum of ' + MAX_NAMESPACE_KEYS + ' keys' };
  }
  for (const key of keys) {
    if (!KEY_RE.test(key) || key.length > MAX_NAMESPACE_KEY_LEN) {
      return { ok: false, reason: where + ' key ' + JSON.stringify(key) + ' must be a plain identifier (letters/digits/underscore, starting with a letter or underscore, <=' + MAX_NAMESPACE_KEY_LEN + ' chars)' };
    }
    const r = validateNamespaceValue(ns[key], where + '.' + key);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** Validate one invocation entry. Returns { ok, reason, invocation }. */
function validateInvocation(raw, idx) {
  const where = 'invocations[' + idx + ']';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: where + ' must be a JSON object' };
  }
  if (!Array.isArray(raw.argv)) {
    return { ok: false, reason: where + '.argv must be a JSON array of strings' };
  }
  if (raw.argv.length > MAX_ARGV_LEN) {
    return { ok: false, reason: where + '.argv exceeds the maximum length of ' + MAX_ARGV_LEN };
  }
  const argv = [];
  for (let i = 0; i < raw.argv.length; i++) {
    const a = raw.argv[i];
    if (typeof a !== 'string') {
      return { ok: false, reason: where + '.argv[' + i + '] must be a string (a real CLI argv element)' };
    }
    if (a.length > MAX_ARGV_STR_LEN) {
      return { ok: false, reason: where + '.argv[' + i + '] exceeds the maximum length of ' + MAX_ARGV_STR_LEN + ' characters' };
    }
    argv.push(a);
  }

  if (raw.outcome === 'success') {
    const r = validateExpectedNamespace(raw.expected_namespace, where + '.expected_namespace');
    if (!r.ok) return r;
    return { ok: true, invocation: { argv, outcome: 'success', expectedNamespace: raw.expected_namespace } };
  }

  if (raw.outcome === 'failure') {
    if (!Number.isInteger(raw.expected_exit_code) || raw.expected_exit_code < 1 || raw.expected_exit_code > 255) {
      return { ok: false, reason: where + '.expected_exit_code must be an integer between 1 and 255 (stdlib argparse always uses 2 for a real parse_args() validation failure)' };
    }
    if (typeof raw.expected_error_substring !== 'string' || raw.expected_error_substring.trim().length < MIN_ERROR_SUBSTRING_LEN || raw.expected_error_substring.length > MAX_ERROR_SUBSTRING_LEN) {
      return { ok: false, reason: where + '.expected_error_substring must be a non-trivial string, ' + MIN_ERROR_SUBSTRING_LEN + '-' + MAX_ERROR_SUBSTRING_LEN + ' characters, expected to appear literally in the real captured stderr text' };
    }
    return {
      ok: true,
      invocation: { argv, outcome: 'failure', expectedExitCode: raw.expected_exit_code, expectedErrorSubstring: raw.expected_error_substring },
    };
  }

  return { ok: false, reason: where + '.outcome must be exactly "success" or "failure"' };
}

/** Validate invocations' shape AND the anti-hardcoding diversity gates (see
 * module doc comment, ANTI-HARDCODING (b)). Returns { ok, reason, invocations }. */
function validateInvocations(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'invocations must be valid JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'invocations must be a JSON array' };
  }
  if (parsed.length < MIN_INVOCATIONS) {
    return { ok: false, reason: 'invocations must contain at least ' + MIN_INVOCATIONS + ' entries' };
  }
  if (parsed.length > MAX_INVOCATIONS) {
    return { ok: false, reason: 'invocations exceeds the maximum of ' + MAX_INVOCATIONS + ' entries for this category' };
  }

  const invocations = [];
  const successNamespaceSignatures = new Set();
  let failureCount = 0;

  for (let i = 0; i < parsed.length; i++) {
    const r = validateInvocation(parsed[i], i);
    if (!r.ok) return r;
    invocations.push(r.invocation);
    if (r.invocation.outcome === 'success') {
      successNamespaceSignatures.add(JSON.stringify(canonicalize(r.invocation.expectedNamespace)));
    } else {
      failureCount++;
    }
  }

  if (successNamespaceSignatures.size < MIN_DISTINCT_SUCCESS_NAMESPACES) {
    return {
      ok: false,
      reason: 'invocations must include at least ' + MIN_DISTINCT_SUCCESS_NAMESPACES + ' outcome:"success" entries whose own expected_namespace values are mutually DIFFERENT (found ' + successNamespaceSignatures.size + ' distinct value(s)) -- a row whose successful invocations all resolve to the same result cannot distinguish a genuinely argv-driven parser from a degenerate one',
    };
  }
  if (failureCount < 1) {
    return { ok: false, reason: 'invocations must include at least 1 outcome:"failure" entry -- a row that never exercises a real parse failure cannot prove solution_code implements any required/choices/type/mutually-exclusive validation at all' };
  }

  return { ok: true, invocations };
}

/** Order-independent deep form for object keys (array order preserved --
 * significant for a Namespace's own list-valued attributes). Local, tiny
 * copy of helpers.js's own h.canonical -- kept local rather than threaded
 * through h so validateInvocations (a pure, pre-h-availability structural
 * gate) does not need an h reference at all. */
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k]);
    return o;
  }
  return v;
}

// -------------------------------------------------------- python driver ---

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/**
 * The Python driver -- see module doc comment (SystemExit CAPTURE MECHANICS,
 * MARKER LINE ROBUSTNESS, ONE PARSER INSTANCE ACROSS ALL INVOCATIONS).
 * invocationsForPython carries ONLY each invocation's own `argv` -- the
 * curator's own expected_namespace/expected_exit_code/expected_error_substring
 * are never sent into solution_code's own Python subprocess at all; every
 * comparison against them happens back in this Node process, in verify()
 * below, against the real observed results this driver reports.
 */
function buildDriverScript(pyPrelude, solutionCode, invocationsForPython, mark) {
  return [
    'import sys, os, json, io, contextlib',
    'import argparse',
    // Captured BEFORE pyPrelude patches sys.exit -- see module doc comment
    // (PY_PRELUDE'S sys.exit BLOCK VS argparse'S OWN LEGITIMATE sys.exit USE).
    // sys/os are process-wide singletons: pyPrelude's own
    // "_cr_sys.exit = _cr_exit_blocked" mutates THIS SAME sys module object
    // (import sys as _cr_sys binds a second name to the identical object,
    // never a copy), so this reference, taken first, is the one and only way
    // to get back the real, unpatched function afterward.
    '_CR_REAL_SYS_EXIT = sys.exit',
    '',
    pyPrelude,
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark),
    '    SOLUTION_SRC = ' + pyStr(solutionCode),
    '    ARGV_LIST = json.loads(' + pyStr(JSON.stringify(invocationsForPython)) + ')',
    '    _real_write = os.write',
    '    result = {"stage": "started", "results": []}',
    '',
    '    def _emit():',
    '        _real_write(1, ("\\n" + MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
    '',
    '    try:',
    '        ns = {}',
    '        exec(compile(SOLUTION_SRC, "<solution_code>", "exec"), ns)',
    '    except BaseException as e:',
    '        result["stage"] = "load_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    build_fn = ns.get("build_parser")',
    '    if not callable(build_fn):',
    '        result["stage"] = "no_build_parser_function"',
    '        _emit(); return',
    '',
    '    try:',
    '        parser = build_fn()',
    '    except BaseException as e:',
    '        result["stage"] = "build_parser_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    if not isinstance(parser, argparse.ArgumentParser):',
    '        result["stage"] = "not_argument_parser"',
    '        result["actual_type"] = type(parser).__name__',
    '        _emit(); return',
    '',
    '    result["stage"] = "in_progress"',
    '    _emit()',
    '',
    '    for i, argv in enumerate(ARGV_LIST):',
    '        entry = {"index": i}',
    '        out_buf = io.StringIO()',
    '        err_buf = io.StringIO()',
    '        try:',
    '            # sys.exit is real ONLY for the duration of this one',
    '            # parse_args() call -- argparse\'s own error()/exit() path',
    '            # legitimately calls the REAL sys.exit(status) as its',
    '            # documented, standard failure-signaling contract (raising',
    '            # SystemExit, caught below), which pyPrelude\'s own',
    '            # registry-wide exit-forgery guard would otherwise also',
    '            # block -- see module doc comment. Re-blocked immediately',
    '            # after in a finally, whether this call raised or not, so',
    '            # the guard stays active everywhere else (solution_code\'s',
    '            # own module-level exec() above, and anything running',
    '            # outside this narrow window). Any SystemExit caught here,',
    '            # from ANY source (argparse\'s own error() path, or a',
    '            # misbehaving custom type=/action= callable calling',
    '            # sys.exit() directly), is uniformly treated below as this',
    '            # invocation\'s own real failure outcome and compared',
    '            # against its own declared expectation -- it can never be',
    '            # used to fabricate a "success" verdict, since',
    '            # raised_system_exit=True unconditionally routes to the',
    '            # failure-outcome comparison in verify(), never the',
    '            # success one.',
    '            sys.exit = _CR_REAL_SYS_EXIT',
    '            try:',
    '                with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):',
    '                    parsed_ns = parser.parse_args(list(argv))',
    '                entry["raised_system_exit"] = False',
    '                try:',
    '                    entry["namespace"] = json.loads(json.dumps(vars(parsed_ns)))',
    '                except BaseException as e:',
    '                    entry["namespace_error"] = repr(e)',
    '            finally:',
    '                sys.exit = _cr_exit_blocked',
    '        except SystemExit as e:',
    '            entry["raised_system_exit"] = True',
    '            entry["exit_code"] = e.code',
    '            entry["stderr"] = err_buf.getvalue()[:' + MAX_STDERR_CAPTURE_LEN + ']',
    '        except BaseException as e:',
    '            entry["unexpected_exception"] = repr(e)',
    '        result["results"].append(entry)',
    '        _emit()',
    '',
    '    result["stage"] = "ok"',
    '    _emit()',
    '',
    '_main()',
  ].join('\n');
}

module.exports = {
  contract: 'argparse-behavior-match',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const solutionCode = h.str(row, 'solution_code');
    const invocationsRaw = h.str(row, 'invocations');

    if (!taskDescription.trim() || !solutionCode.trim() || !invocationsRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, solution_code, or invocations' } };
    }

    const invCheck = validateInvocations(invocationsRaw);
    if (!invCheck.ok) {
      return { passed: false, logs: invCheck.reason, detail: { reason: 'bad_invocations' } };
    }
    const invocations = invCheck.invocations;

    if (!/\bdef\s+build_parser\s*\(\s*\)/.test(solutionCode)) {
      return {
        passed: false,
        logs: 'solution_code must define a top-level, zero-argument function named exactly build_parser (e.g. def build_parser():), returning a configured argparse.ArgumentParser instance',
        detail: { reason: 'no_build_parser_function' },
      };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    const d = h.workdir();
    const mark = '@@CLIARGROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const argvList = invocations.map((inv) => inv.argv);
    const script = buildDriverScript(h.PY_PRELUDE, solutionCode, argvList, mark);
    const scriptPath = h.path.join(d, 'run_cli_argument_parsing.py');
    h.fs.writeFileSync(scriptPath, script);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: up to
    // MAX_INVOCATIONS checkpoint lines, each carrying every result seen so
    // far, could exceed the report-bounding cap before the trailing "ok"
    // marker line is reached.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }

    if (!out || typeof out !== 'object' || !out.stage) {
      return {
        passed: false,
        logs: r.timedOut
          ? ('solution_code did not complete within the ' + TIMEOUT_MS + 'ms budget -- for work this small (build_parser() plus at most ' + MAX_INVOCATIONS + ' plain parse_args() calls), this is itself a real failure, not an infra problem')
          : ('could not parse verification output: ' + String(r.stderr || '').slice(0, 500)),
        detail: { reason: 'unparseable_output', timedOut: !!r.timedOut },
      };
    }

    if (out.stage === 'load_failed') {
      return { passed: false, logs: 'solution_code failed to load: ' + String(out.error || '').slice(0, 800), detail: { reason: 'load_failed' } };
    }
    if (out.stage === 'no_build_parser_function') {
      return { passed: false, logs: 'solution_code does not define a top-level build_parser function after exec', detail: { reason: 'no_build_parser_function' } };
    }
    if (out.stage === 'build_parser_failed') {
      return { passed: false, logs: 'build_parser() raised while constructing the parser: ' + String(out.error || '').slice(0, 800), detail: { reason: 'build_parser_failed' } };
    }
    if (out.stage === 'not_argument_parser') {
      return {
        passed: false,
        logs: 'build_parser() returned a ' + String(out.actual_type) + ', not a real argparse.ArgumentParser instance -- this category requires solution_code to use argparse\'s own real machinery, never a hand-rolled parser',
        detail: { reason: 'not_argument_parser', actualType: out.actual_type },
      };
    }
    if (out.stage !== 'ok') {
      return {
        passed: false,
        logs: r.timedOut
          ? ('solution_code did not complete every invocation within the ' + TIMEOUT_MS + 'ms budget (stage=' + String(out.stage) + ', ' + (Array.isArray(out.results) ? out.results.length : 0) + '/' + invocations.length + ' invocations completed)')
          : ('verification did not complete (stage=' + String(out.stage) + ')'),
        detail: { reason: 'incomplete', stage: out.stage, timedOut: !!r.timedOut },
      };
    }

    const results = Array.isArray(out.results) ? out.results : [];
    if (results.length !== invocations.length) {
      return {
        passed: false,
        logs: 'expected ' + invocations.length + ' invocation result(s) but got ' + results.length,
        detail: { reason: 'result_count_mismatch', expected: invocations.length, actual: results.length },
      };
    }

    for (let i = 0; i < invocations.length; i++) {
      const inv = invocations[i];
      const res = results[i] || {};
      const argvDisplay = JSON.stringify(inv.argv);

      if (res.unexpected_exception) {
        return {
          passed: false,
          logs: 'invocation[' + i + '] (argv=' + argvDisplay + ') raised an unexpected exception (not SystemExit -- argparse\'s own convention never raises anything else on a real validation failure): ' + String(res.unexpected_exception).slice(0, 500),
          detail: { reason: 'invocation_unexpected_exception', index: i, error: String(res.unexpected_exception).slice(0, 500) },
        };
      }

      if (inv.outcome === 'success') {
        if (res.raised_system_exit) {
          return {
            passed: false,
            logs: 'invocation[' + i + '] (argv=' + argvDisplay + ') was declared a successful parse, but solution_code\'s parser exited (code ' + JSON.stringify(res.exit_code) + ', stderr: ' + JSON.stringify(String(res.stderr || '').slice(0, 300)) + ')',
            detail: { reason: 'expected_success_but_failed', index: i, exitCode: res.exit_code, stderr: String(res.stderr || '').slice(0, 300) },
          };
        }
        if (res.namespace_error) {
          return {
            passed: false,
            logs: 'invocation[' + i + '] (argv=' + argvDisplay + ') produced a Namespace that could not be serialized for comparison: ' + String(res.namespace_error).slice(0, 300) + ' -- every Namespace attribute value must be a plain JSON-representable scalar or flat list of scalars',
            detail: { reason: 'namespace_not_serializable', index: i },
          };
        }
        const actualSig = JSON.stringify(canonicalize(res.namespace || {}));
        const expectedSig = JSON.stringify(canonicalize(inv.expectedNamespace));
        if (actualSig !== expectedSig) {
          return {
            passed: false,
            logs: 'invocation[' + i + '] (argv=' + argvDisplay + ') produced namespace ' + JSON.stringify(res.namespace).slice(0, 400) + ' but expected_namespace declares ' + JSON.stringify(inv.expectedNamespace).slice(0, 400),
            detail: { reason: 'namespace_mismatch', index: i, actual: res.namespace, expected: inv.expectedNamespace },
          };
        }
      } else {
        // inv.outcome === 'failure'
        if (!res.raised_system_exit) {
          return {
            passed: false,
            logs: 'invocation[' + i + '] (argv=' + argvDisplay + ') was declared a real parse FAILURE, but solution_code\'s parser accepted it and returned namespace ' + JSON.stringify(res.namespace).slice(0, 400),
            detail: { reason: 'expected_failure_but_succeeded', index: i, actualNamespace: res.namespace },
          };
        }
        if (res.exit_code !== inv.expectedExitCode) {
          return {
            passed: false,
            logs: 'invocation[' + i + '] (argv=' + argvDisplay + ') exited with code ' + JSON.stringify(res.exit_code) + ' but expected_exit_code declares ' + inv.expectedExitCode,
            detail: { reason: 'exit_code_mismatch', index: i, actual: res.exit_code, expected: inv.expectedExitCode },
          };
        }
        const stderrText = String(res.stderr || '');
        if (stderrText.indexOf(inv.expectedErrorSubstring) === -1) {
          return {
            passed: false,
            logs: 'invocation[' + i + '] (argv=' + argvDisplay + ') real stderr did not contain the declared expected_error_substring ' + JSON.stringify(inv.expectedErrorSubstring) + ' -- real stderr was: ' + JSON.stringify(stderrText.slice(0, 500)),
            detail: { reason: 'error_substring_not_found', index: i, expectedSubstring: inv.expectedErrorSubstring, actualStderr: stderrText.slice(0, 500) },
          };
        }
      }
    }

    return {
      passed: true,
      score: 1,
      detail: { reason: 'ok', invocationsChecked: invocations.length },
    };
  },
};
