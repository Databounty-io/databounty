/**
 * counterexample-differential -- property_based_testing.
 *
 * THE CONTRACT: property_test_code (real, contributor-controlled Python,
 * using the real `hypothesis` library) must genuinely discriminate
 * correct_implementation from broken_implementation via Hypothesis's OWN
 * `@given` example-generation and shrinking machinery -- never by static
 * inspection of the source, never by example-based (fixed-input) testing.
 * Run the SAME property test twice, once with each implementation bound to
 * IMPL: it must complete cleanly (no exception) against correct_implementation
 * and must fail (Hypothesis reports a genuine counterexample) against
 * broken_implementation. Passing against both (too weak to catch the specific
 * bug) or failing against both (broken independent of which implementation is
 * under test) does not satisfy this contract.
 *
 * IMPL BINDING CONVENTION -- read before letting property_test_code redeclare
 * a name (the same lesson web_scraping's own module doc comment documents for
 * its injected `html`/cheerio names, and redis_data_structure_semantics's own
 * module doc comment documents for its injected `r` connection variable): a
 * @given-decorated test function's ENTIRE parameter list is consumed by
 * Hypothesis's own generated arguments, so it cannot also take an explicit
 * "which implementation" parameter without functools.partial-style
 * gymnastics Hypothesis itself does not idiomatically support. This category
 * instead exposes a single, harness-injected MODULE-LEVEL name, `IMPL`, that
 * property_test_code's test-function body must reference (call), and the
 * driver script below REBINDS that same global between the two runs --
 * correct_implementation's function object first, then broken_implementation's
 * -- calling the identical, already-`@given`-wrapped callable both times. A
 * Python function resolves a bare global name (IMPL) from its own
 * `__globals__` dict AT CALL TIME, not at `def` time, so rebinding
 * `ns['IMPL']` between the two calls changes what the SAME already-defined
 * test function observes on its second invocation with no need to re-exec or
 * re-parse property_test_code at all -- confirmed empirically against a real
 * local Hypothesis installation before writing this file (see this category's
 * own task report for the exact probe).
 *
 * WHY DIRECT INVOCATION, NOT PYTEST: hypothesis.readthedocs.io ("Anatomy of a
 * Hypothesis Based Test" / the API reference for `given`) documents that a
 * `@given`-decorated function is a perfectly ordinary Python callable once
 * every one of its own parameters has been filled by `@given`'s arguments --
 * calling it directly (`test_fn()`) runs Hypothesis's real generation loop
 * and either returns normally (every generated example satisfied every
 * assertion) or raises (Hypothesis found -- and, by default, already
 * shrunk -- a genuine counterexample). No pytest collection/runner is needed
 * or used here; this driver imports `hypothesis` and calls the discovered
 * test function as a plain callable, exactly as Hypothesis's own docs
 * describe as supported.
 *
 * FINDING "THE" TEST FUNCTION: property_test_code is free to name its test
 * function anything and to define helper functions/imports alongside it.
 * Hypothesis itself exposes a public, documented predicate for exactly this
 * purpose -- `hypothesis.is_hypothesis_test(obj)` (confirmed present and
 * working against a real local Hypothesis 6.165 install; also how pytest's
 * own Hypothesis integration recognizes a Hypothesis test during collection)
 * -- so the driver scans property_test_code's own exec() namespace for
 * exactly one callable satisfying it, rather than requiring a fixed function
 * name. Zero or more than one is rejected as ambiguous (see
 * `test_function_discovery_failed` below); this category's own schema help
 * text also requires exactly one `@given(...)` use, checked structurally in
 * JS (hasExactlyOneGiven) BEFORE ever spending a Python subprocess call on a
 * multi-test or test-less submission.
 *
 * HARNESS-ENFORCED SETTINGS, NOT THE CONTRIBUTOR'S OWN -- determinism/budget:
 * hypothesis.readthedocs.io's own settings reference documents `max_examples`
 * ("Once this many satisfying test cases have been considered without
 * finding any failing test case, Hypothesis will stop looking", default 100),
 * `deadline` ("the maximum allowed duration of an individual test case... If
 * None, the deadline is disabled entirely", default 200ms, defaulting to None
 * under Hypothesis's own CI profile) and `derandomize` ("seed Hypothesis's
 * random number generator using a hash of the test function, so every run
 * will test the same set of test cases", default False, defaulting to True
 * under Hypothesis's own CI profile). This harness applies
 * `settings(max_examples=MAX_EXAMPLES, deadline=None, derandomize=True,
 * database=None)` itself -- deadline=None so a slower/colder sandbox CPU
 * cannot turn a genuinely correct property into a spurious
 * `DeadlineExceeded` failure (the exact false-FAIL class this registry
 * already guards against elsewhere for environment-timing-sensitive checks,
 * e.g. helpers.js's own TZ/PYTHONHASHSEED pinning rationale); derandomize=True
 * so a verdict cannot flip between two runs of the identical row purely from
 * which random examples Hypothesis happened to pick; database=None so no
 * on-disk `.hypothesis/examples` state can carry between the two differential
 * calls made in this one process (each row's sandbox is destroyed after use
 * regardless, so this is defense in depth, not a leakage fix). Mirrors this
 * registry's existing "harness owns the timeout/determinism budget, not the
 * caller" discipline (helpers.js's COMPILE_TIMEOUT_MS/typeCheck() comments,
 * concurrency_race_detection's own GOMAXPROCS/derandomize-adjacent reasoning).
 *
 * property_test_code is STRUCTURALLY PREVENTED from overriding these with its
 * own `@settings(...)`: confirmed empirically (real local Hypothesis) that
 * applying a SECOND `settings(...)` decorator to an already-`@settings`-
 * decorated test raises `hypothesis.errors.InvalidArgument` ("test_x has
 * already been decorated with a settings object") -- exactly the documented
 * behavior ("A test may only have one settings object applied to it").
 * Rather than statically grep property_test_code's text for `@settings` (a
 * textual check a contributor could dodge via
 * `settings(max_examples=100000)(test_fn)` written as an ordinary function
 * call instead of a decorator, or any other non-`@`-spelled equivalent), the
 * driver structurally ATTEMPTS its own settings wrap and catches
 * `InvalidArgument` for real -- the same "structural check over textual
 * check" preference this registry already documents (redis_data_structure_
 * semantics's own module doc comment, "WHY NO REDIS-COMMAND TEXT DENYLIST").
 *
 * DEGENERATE-STRATEGY GUARD, DOCUMENTED RESIDUAL (this category's answer to
 * concurrency_race_detection's own ANTI-GAMING RESIDUAL convention -- honest
 * about what is and is not closed, not chased further this pass):
 * `@given(st.just(<one fixed value>))` technically uses Hypothesis's real API
 * but explores exactly one example, defeating property-based testing's whole
 * point while still satisfying every other structural check in this file (it
 * genuinely calls IMPL, it is genuinely a hypothesis test, it can genuinely
 * differ between correct/broken on that ONE value). Closed for the LITERAL
 * shape described in this category's own schema help text: every top-level
 * argument passed to the row's single `@given(...)` call, once split on
 * top-level commas and a leading `name=` keyword-argument prefix stripped, is
 * checked against `^(?:st\.)?just\(...\)(?:\.\w+\(...\))*$` (a `just(...)`
 * call, optionally chained with further method calls like `.map(...)` --
 * still only ever one underlying fixed base value) -- if EVERY argument
 * matches that shape, the row is rejected. NOT CLOSED, BY DESIGN (a
 * materially harder, real-value-space static-analysis problem this pass does
 * not attempt, mirroring concurrency_race_detection's own explicitly-accepted
 * "-race reports ANY race, not specifically the described one" residual): a
 * differently-spelled single-value strategy is not caught by this text-shape
 * check -- `st.integers(min_value=5, max_value=5)`, `st.sampled_from([5])`,
 * or `st.just(1) | st.just(1)` (a two-armed but still single-valued
 * `one_of`) all pass this structural check while still only ever generating
 * one distinct value. Mitigated by dataset-authoring discipline, not
 * verification-time logic (property_test_code's own schema help text states
 * the requirement to genuinely explore a real input space; the curator
 * pairing correct_implementation/broken_implementation with a
 * property_test_code test remains responsible for authoring/reviewing a test
 * that actually varies its inputs) -- the same "documented, not fully
 * closeable, mitigated by authoring discipline" posture this registry already
 * uses throughout (redis_data_structure_semantics's TTL-sleep-margin residual,
 * concurrency_race_detection's map-race residual).
 *
 * STDOUT-HIJACK / EXIT-FORGERY DEFENSES -- the same tier vulnerability's and
 * redis_data_structure_semantics's harnesses use, because property_test_code
 * really is exec()'d Python sharing this process:
 *   - h.PY_PRELUDE is spliced in verbatim: sys.exit/os._exit/os.abort/
 *     builtins.exit/quit are monkeypatched (process-wide, so this applies
 *     equally to code called from deep inside Hypothesis's own generation
 *     loop, not just top-level statements) to raise instead of terminating.
 *     A property_test_code that tries `sys.exit(0)` inside its own assertion
 *     body to force an apparent "clean pass" instead raises RuntimeError,
 *     which Hypothesis's own test-running machinery treats exactly like any
 *     other assertion failure for that generated example -- it does not
 *     bypass anything, it just becomes ordinary evidence the property failed.
 *   - Every stage of the driver (loading each implementation, exec'ing
 *     property_test_code, wrapping settings, and both differential calls) is
 *     individually wrapped in its own `try/except BaseException` -- catches a
 *     raw `raise SystemExit(...)` too -- so control always returns to this
 *     file's own trusted `_emit()` call regardless of what any stage does.
 *   - The FINAL verdict is written via a per-run-random-marker-prefixed line
 *     through a raw `os.write(1, ...)` fd write, never print()/sys.stdout.
 *     write() (which resolve their stream from the reassignable `sys.stdout`
 *     object fresh at every call) -- direct-fd writes bypass a reassigned
 *     sys.stdout entirely, the same defense vulnerability's SNAPSHOT and
 *     redis_data_structure_semantics's final verdict line both already use.
 *   - The marker itself is a local inside the driver's own `_main()`
 *     function, never a bare top-level/`__main__`-scope statement, so a cheap
 *     `sys.modules["__main__"].MARK` probe from property_test_code cannot
 *     read and pre-emptively echo it -- same convention as
 *     redis_data_structure_semantics's own final-marker hardening. Even
 *     without that, `h.lastMarked`'s LAST-line-wins rule already means any
 *     forged marker-prefixed line property_test_code manages to print DURING
 *     its own execution is superseded by this file's own genuine line,
 *     printed strictly afterward. ACCEPTED RESIDUAL, not chased further here
 *     (identical to every other last-line-wins marker convention already in
 *     this registry): a raw-syscall self-termination
 *     (`ctypes.CDLL(None)._exit(0)`, `os.kill(os.getpid(), SIGKILL)`) bypasses
 *     every Python-level trap this file or PY_PRELUDE installs, the same
 *     residual PY_PRELUDE's own module doc comment in helpers.js already
 *     documents registry-wide.
 *
 * TIMEOUT BUDGET: one h.run('python3', ...) subprocess call covers loading
 * both implementations, exec'ing property_test_code once, and BOTH
 * differential calls of the discovered test function (MAX_EXAMPLES=100 each,
 * Hypothesis's own default -- kept at the default rather than lowered,
 * because deadline=None already removes the main real risk a slower sandbox
 * CPU posed, and a genuinely simple property test over simple generated
 * inputs is the expected common case for this category). Measured for real
 * against a local Hypothesis 6.165 install (see this category's own task
 * report): a fresh-process `import hypothesis` alone took ~1.3s on this
 * authoring host, and a full two-run differential (trivial add/subtract
 * property, 100 examples each) completed in ~1.75s total wall time --
 * TIMEOUT_MS below (60000ms) is roughly 34x that measured total, generous
 * headroom for a colder/slower sandbox CPU, a heavier curator-authored
 * strategy (nested lists/tuples/composite), and Hypothesis's own internal
 * shrinking phase on the broken-implementation run (bounded internally by
 * Hypothesis, not unbounded, but not free either) -- while staying
 * comfortably under the outer sandbox command budget (120000ms,
 * infra/terraform/ssm.tf's EXECUTION_RUNNER_TIMEOUT_MS, duplicated in
 * helpers.js as OUTER_SANDBOX_BUDGET_MS) with roughly 60000ms of margin left,
 * the same "stay strictly under the outer budget, with an explicit
 * documented margin" discipline this registry already enforces everywhere
 * else.
 */
'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 60000;
const PROBE_TIMEOUT_MS = 3000;
const MAX_EXAMPLES = 100;

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/** True if `name` is CALLED or attribute-accessed in `text` (not merely
 * mentioned in a comment/string) -- same provenance pattern as
 * vulnerability's/network_protocol_fsm's harnesses, applied here to require
 * property_test_code to actually engage with the injected IMPL name rather
 * than running a self-contained check disconnected from either
 * implementation. */
function referencesCall(name, text) {
  let masked = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      masked += c === '\n' ? '\n' : ' ';
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; masked += ' '; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') { masked += ' '; i++; } masked += '\n'; continue; }
    masked += c;
  }
  return new RegExp('\\b' + name + '[ \\t]*[(.]').test(masked);
}

/** The sole top-level `def`/`async def` name in a curator-authored
 * implementation field. Anchored with NO leading whitespace allowed (a
 * method nested inside a class must not count as "top-level" -- same
 * rationale as vulnerability's own topLevelNames extraction). Returns null
 * if the code declares zero or more than one -- ambiguous either way, and
 * this category's IMPL-binding convention needs exactly one real function to
 * bind. */
function soleTopLevelFunctionName(code) {
  const re = /^(?:async\s+def|def)\s+(\w+)\s*\(/gm;
  const names = [];
  let m;
  while ((m = re.exec(code))) names.push(m[1]);
  return names.length === 1 ? names[0] : null;
}

/** How many `@given(` decorator applications appear in property_test_code.
 * This category requires exactly one -- see this file's module doc comment
 * ("FINDING 'THE' TEST FUNCTION") for why a single, unambiguous graded test
 * function is required, checked here structurally (cheap, no Python
 * subprocess needed) before the degenerate-strategy check below (which only
 * makes sense applied to a single, unambiguous @given call) and before
 * spending any sandbox time at all. */
function countGivenDecorators(code) {
  const m = code.match(/@given\s*\(/g);
  return m ? m.length : 0;
}

/** Balanced-paren extraction of the argument-list text passed to the FIRST
 * `@given(...)` call in `code`. Returns null if `@given(` never appears or
 * the parens never balance (malformed source -- left for the real Python
 * exec/compile step to report properly rather than guessed at here). */
function extractGivenArgs(code) {
  const at = code.indexOf('@given');
  if (at === -1) return null;
  const parenStart = code.indexOf('(', at);
  if (parenStart === -1) return null;
  let depth = 0, i = parenStart;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null;
  return code.slice(parenStart + 1, i);
}

/** Split a `@given(...)` argument-list text on TOP-LEVEL commas (respecting
 * nested parens/brackets/braces, so a comma inside e.g. `st.tuples(st.integers(),
 * st.text())` does not split that single argument in two). */
function splitTopLevelArgs(text) {
  const parts = [];
  let depth = 0, cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Is one `@given(...)` argument shaped like a single fixed value with no
 * real exploration -- `st.just(...)` (bare or `st.`-qualified), optionally
 * chained with further method calls (`.map(...)`, `.filter(...)`) that still
 * only ever transform/gate that one base value? See this file's module doc
 * comment (DEGENERATE-STRATEGY GUARD) for exactly what this does and does
 * not catch. */
function isDegenerateArg(part) {
  let s = part.trim();
  const kw = /^\w+\s*=\s*(?!=)/.exec(s);
  if (kw) s = s.slice(kw[0].length).trim();
  const m = /^(?:st\.)?just\s*\(/.exec(s);
  if (!m) return false;
  let depth = 0, i = m[0].length - 1;
  for (; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return false;
  const rest = s.slice(i + 1).trim();
  return rest === '' || /^(?:\.\w+\([^()]*\))*$/.test(rest);
}

/** True if EVERY top-level argument to property_test_code's single
 * `@given(...)` call is degenerate (isDegenerateArg) -- i.e. the whole
 * property explores exactly one input combination. */
function looksDegenerateGivenStrategy(code) {
  const argsText = extractGivenArgs(code);
  if (argsText === null) return false; // malformed/unextractable -- not this check's job
  const parts = splitTopLevelArgs(argsText);
  if (!parts.length) return false; // @given() with no args at all -- a different, real error, not this check's job
  return parts.every(isDegenerateArg);
}

/** The whole verification program, run once via a single python3 subprocess.
 * Loads both implementations, exec's property_test_code once, then calls the
 * SAME discovered, settings-wrapped test function twice -- rebinding the
 * module-level IMPL name between calls -- see this file's module doc comment
 * (IMPL BINDING CONVENTION) for why one exec + two calls is correct and
 * sufficient, no need to re-exec property_test_code per implementation. */
function buildDriverScript(pyPrelude, correctCode, correctName, brokenCode, brokenName, testCode, maxExamples, mark) {
  return [
    'import sys, os, json',
    'import hypothesis',
    'from hypothesis import given, strategies as st, settings',
    'from hypothesis.errors import InvalidArgument',
    '',
    pyPrelude,
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark), // local, not a __main__ attribute -- see module doc comment
    '    CORRECT_SRC = ' + pyStr(correctCode),
    '    CORRECT_NAME = ' + pyStr(correctName),
    '    BROKEN_SRC = ' + pyStr(brokenCode),
    '    BROKEN_NAME = ' + pyStr(brokenName),
    '    TEST_SRC = ' + pyStr(testCode),
    '    MAX_EXAMPLES = ' + JSON.stringify(maxExamples),
    '    result = {}',
    '',
    '    def _emit():',
    '        os.write(1, (MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
    '',
    '    try:',
    '        ns_c = {}',
    '        exec(compile(CORRECT_SRC, "<correct_implementation>", "exec"), ns_c)',
    '        correct_fn = ns_c.get(CORRECT_NAME)',
    '        if not callable(correct_fn):',
    '            result["stage"] = "correct_implementation_load_failed"',
    '            result["error"] = "top-level function " + CORRECT_NAME + " not found or not callable after exec"',
    '            _emit(); return',
    '    except BaseException as e:',
    '        result["stage"] = "correct_implementation_load_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    try:',
    '        ns_b = {}',
    '        exec(compile(BROKEN_SRC, "<broken_implementation>", "exec"), ns_b)',
    '        broken_fn = ns_b.get(BROKEN_NAME)',
    '        if not callable(broken_fn):',
    '            result["stage"] = "broken_implementation_load_failed"',
    '            result["error"] = "top-level function " + BROKEN_NAME + " not found or not callable after exec"',
    '            _emit(); return',
    '    except BaseException as e:',
    '        result["stage"] = "broken_implementation_load_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    ns_t = {"IMPL": correct_fn}',
    '    try:',
    '        exec(compile(TEST_SRC, "<property_test_code>", "exec"), ns_t)',
    '    except BaseException as e:',
    '        result["stage"] = "property_test_code_load_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    candidates = [v for v in ns_t.values() if callable(v) and hypothesis.is_hypothesis_test(v)]',
    '    if len(candidates) != 1:',
    '        result["stage"] = "test_function_discovery_failed"',
    '        result["candidate_count"] = len(candidates)',
    '        _emit(); return',
    '    test_fn = candidates[0]',
    '',
    '    try:',
    '        bounded = settings(max_examples=MAX_EXAMPLES, deadline=None, derandomize=True, database=None)(test_fn)',
    '    except InvalidArgument as e:',
    '        result["stage"] = "own_settings_forbidden"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '    except BaseException as e:',
    '        result["stage"] = "settings_wrap_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    ns_t["IMPL"] = correct_fn',
    '    try:',
    '        bounded()',
    '        result["correct_passed"] = True',
    '    except BaseException as e:',
    '        result["correct_passed"] = False',
    '        result["correct_error"] = repr(e)',
    '',
    '    ns_t["IMPL"] = broken_fn',
    '    try:',
    '        bounded()',
    '        result["broken_passed"] = True',
    '    except BaseException as e:',
    '        result["broken_passed"] = False',
    '        result["broken_error"] = repr(e)',
    '',
    '    result["stage"] = "ok"',
    '    _emit()',
    '',
    '_main()',
  ].join('\n');
}

module.exports = {
  contract: 'counterexample-differential',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const correctCode = h.str(row, 'correct_implementation');
    const brokenCode = h.str(row, 'broken_implementation');
    const testCode = h.str(row, 'property_test_code');

    if (!taskDescription.trim() || !correctCode.trim() || !brokenCode.trim() || !testCode.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, correct_implementation, broken_implementation, or property_test_code' } };
    }

    const correctName = soleTopLevelFunctionName(correctCode);
    if (!correctName) {
      return {
        passed: false,
        logs: 'correct_implementation must define EXACTLY ONE top-level function (def/async def) -- this category\'s IMPL-binding convention needs one unambiguous callable',
        detail: { reason: 'correct_implementation_not_single_function' },
      };
    }
    const brokenName = soleTopLevelFunctionName(brokenCode);
    if (!brokenName) {
      return {
        passed: false,
        logs: 'broken_implementation must define EXACTLY ONE top-level function (def/async def) -- this category\'s IMPL-binding convention needs one unambiguous callable',
        detail: { reason: 'broken_implementation_not_single_function' },
      };
    }

    // Provenance: property_test_code must actually CALL/attribute-access the
    // injected IMPL name, not run a self-contained check disconnected from
    // either implementation -- same pattern as vulnerability's harness.
    if (!referencesCall('IMPL', testCode)) {
      return {
        passed: false,
        logs: 'property_test_code never calls or attribute-accesses IMPL -- it cannot be genuinely exercising either implementation (see this category\'s IMPL BINDING CONVENTION)',
        detail: { reason: 'no_impl_reference' },
      };
    }

    // Exactly one @given(...) use required -- see module doc comment
    // ("FINDING 'THE' TEST FUNCTION"). Checked structurally before spending
    // any sandbox time.
    const givenCount = countGivenDecorators(testCode);
    if (givenCount !== 1) {
      return {
        passed: false,
        logs: 'property_test_code must contain exactly one @given(...)-decorated property test (found ' + givenCount + ')',
        detail: { reason: 'not_exactly_one_given', givenCount },
      };
    }

    // Degenerate-strategy guard -- see module doc comment (DEGENERATE-STRATEGY
    // GUARD) for exactly what this catches and its documented residual.
    if (looksDegenerateGivenStrategy(testCode)) {
      return {
        passed: false,
        logs: 'property_test_code\'s @given(...) strategy looks degenerate -- every argument is a bare st.just(...) (optionally chained), which explores exactly one example and defeats property-based testing\'s whole point. Combine a real generator (st.integers(), st.lists(...), st.one_of(...), ...) instead',
        detail: { reason: 'degenerate_strategy' },
      };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }
    // Probed, not assumed from the Dockerfile/template.ts -- same discipline
    // redis_data_structure_semantics's own redis-py probe and this category's
    // own task brief both call for. Matters especially right now: hypothesis
    // is a NEW E2B image dependency this category's own change adds to
    // template.ts, and the currently-published/deployed template does not
    // have it until that template is rebuilt -- this probe is what routes
    // every row to runtimeUnavailable (human audit), not a false contributor
    // failure, until that rebuild happens.
    const hypothesisOk = h.run('python3', ['-c', 'import hypothesis'], { timeoutMs: PROBE_TIMEOUT_MS }).status === 0;
    if (!hypothesisOk) {
      return { passed: false, runtimeUnavailable: true, logs: 'python hypothesis library unavailable in this sandbox image', detail: { reason: 'no_hypothesis' } };
    }

    const d = h.workdir();
    const mark = '@@PBTROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = buildDriverScript(h.PY_PRELUDE, correctCode, correctName, brokenCode, brokenName, testCode, MAX_EXAMPLES, mark);
    const scriptPath = h.path.join(d, 'run_pbt.py');
    h.fs.writeFileSync(scriptPath, script);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });
    if (r.timedOut) {
      return { passed: false, logs: 'property_test_code did not complete within the time budget (possibly a pathological/expensive Hypothesis strategy)', detail: { reason: 'timed_out' } };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr || '').slice(0, 1500), detail: { reason: 'driver_crashed' } };
    }

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: a verbose
    // Hypothesis failure report (a shrunk counterexample plus traceback) must
    // not have its trailing marker line truncated away by the report-bounding
    // cap applied to the returned, logged stdout.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }
    if (!out || typeof out !== 'object' || !out.stage) {
      return { passed: false, logs: 'could not parse verification output', detail: { reason: 'unparseable_output' } };
    }

    if (out.stage === 'correct_implementation_load_failed' || out.stage === 'broken_implementation_load_failed') {
      // A curator-authored context field failing to exec on its own is a
      // dataset-authoring defect, not a contributor failure -- but still
      // reported as passed:false (not runtimeUnavailable: this is not an
      // environment fault, python3/hypothesis are both confirmed healthy by
      // this point).
      return {
        passed: false,
        logs: out.stage + ': ' + String(out.error || '').slice(0, 800),
        detail: { reason: out.stage },
      };
    }
    if (out.stage === 'property_test_code_load_failed') {
      return {
        passed: false,
        logs: 'property_test_code failed to load/exec: ' + String(out.error || '').slice(0, 800),
        detail: { reason: 'property_test_code_load_failed' },
      };
    }
    if (out.stage === 'test_function_discovery_failed') {
      return {
        passed: false,
        logs: 'property_test_code must define exactly one Hypothesis @given-decorated test function (found ' + out.candidate_count + ')',
        detail: { reason: 'test_function_discovery_failed', candidateCount: out.candidate_count },
      };
    }
    if (out.stage === 'own_settings_forbidden') {
      return {
        passed: false,
        logs: 'property_test_code applies its own @settings(...) to the test function -- forbidden; the harness enforces bounded, deterministic settings itself: ' + String(out.error || '').slice(0, 500),
        detail: { reason: 'own_settings_forbidden' },
      };
    }
    if (out.stage === 'settings_wrap_failed') {
      return { passed: false, logs: 'failed to apply harness settings to property_test_code\'s test function: ' + String(out.error || '').slice(0, 500), detail: { reason: 'settings_wrap_failed' } };
    }
    if (out.stage !== 'ok') {
      return { passed: false, logs: 'unrecognized driver stage: ' + String(out.stage), detail: { reason: 'unknown_stage', stage: out.stage } };
    }

    if (!out.correct_passed) {
      return {
        passed: false,
        logs: 'property_test_code FAILED against correct_implementation (a genuinely correct implementation must never trigger a counterexample): ' + String(out.correct_error || '').slice(0, 800),
        detail: { reason: 'failed_against_correct', correctError: String(out.correct_error || '').slice(0, 800) },
      };
    }
    if (out.broken_passed) {
      return {
        passed: false,
        logs: 'property_test_code PASSED against broken_implementation too -- it did not discriminate the deliberately broken implementation from the correct one (too weak an assertion, or a strategy that never generates the input the bug depends on)',
        detail: { reason: 'did_not_discriminate' },
      };
    }

    return {
      passed: true,
      score: 1,
      logs: '',
      detail: {
        reason: 'ok',
        brokenError: String(out.broken_error || '').slice(0, 500),
      },
    };
  },
};
