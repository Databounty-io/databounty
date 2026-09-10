/**
 * policy-simulation-match -- rate_limiting_policy_simulation.
 *
 * THE CONTRACT: solution_code (real, contributor-controlled Python) defines
 * exactly one top-level class `RateLimiter`, with a no-argument constructor
 * (the row's own policy numbers are hardcoded inside it, read from
 * policy_description -- the harness never passes policy parameters in) and a
 * method `check(self, key, timestamp)` returning admit/reject. The harness
 * instantiates RateLimiter() ONCE per row and drives it, IN ORDER, through
 * every event in `timeline` -- calling check(key, timestamp) with the EXACT
 * curator-supplied simulated timestamp -- and every real decision must match
 * that event's own curator-declared `expected` outcome.
 *
 * TWO INDEPENDENT GATES, NOT ONE -- THE CORE DESIGN DECISION FOR THIS
 * CATEGORY (see INDEPENDENT ORACLE below for the second one): checking
 * "does solution_code's own behavior match timeline's own declared
 * `expected` values" alone would never catch a curator who wrote a
 * self-consistent but WRONG timeline/policy pairing (e.g. declares
 * policy_type "fixed_window" with a limit of 5, but hand-computed
 * `expected` values that actually describe a limit of 6) -- a solution_code
 * that correctly implements the CORRECT policy would then be scored a false
 * FAIL against a row that was never a valid fixed_window-limit-5 row to
 * begin with. This harness therefore NEVER trusts timeline's own `expected`
 * values as ground truth on their own; they are only ever used after being
 * independently re-derived and confirmed by this file's own reference
 * implementation of the declared policy_type (see INDEPENDENT ORACLE below),
 * mirroring this registry's documented preference for an independent-oracle
 * design over a trust-the-curator design (schema_conformance_validation's
 * own jsonschema/lxml oracle, sql_query_correctness's own mutate-and-
 * recompare technique).
 *
 * INDEPENDENT ORACLE -- IMPLEMENTED FOR ALL FIVE policy_type VALUES, NOT
 * JUST SOME: unlike schema_conformance_validation (which needs a real,
 * external, complex validation LIBRARY -- jsonschema/lxml -- as its trusted
 * oracle, itself only available from inside a Python process), every policy
 * this category supports is a small, fully-specified, deterministic
 * arithmetic state machine over (key, timestamp) -- see EXACT PINNED
 * SEMANTICS in schema.json's own policy_params help text for the precise,
 * boundary-exact rule this file implements for each of fixed_window /
 * sliding_window_log / sliding_window_counter / token_bucket / leaky_bucket.
 * There is therefore no reason to defer this oracle to a second language or
 * external library at all -- computeOracleDecisions() below implements all
 * five directly in this file's own plain JS, run entirely inside the Node
 * harness process, well before solution_code (or even python3 itself) is
 * ever touched. GATE ORDER below runs this oracle and cross-checks it
 * against every one of timeline's own declared `expected` values; ANY
 * mismatch rejects the row outright as a dataset-authoring defect (passed:
 * false, reason 'oracle_mismatch'), before solution_code is ever executed --
 * matching schema_conformance_validation's own "reject dataset-authoring
 * defects at their own gate, before spending sandbox time" discipline.
 *
 * WHY THIS CATEGORY'S ORACLE/CONTRIBUTOR SEPARATION IS STRONGER THAN A
 * SECOND-PROCESS DESIGN, NOT MERELY EQUAL TO ONE: schema_conformance_
 * validation's own module doc comment documents, as a real, CONFIRMED-
 * EXPLOITABLE gap in an early draft, that computing ground truth and
 * running contributor code as local variables in the SAME Python process
 * lets contributor code recover the ground truth via sys._getframe()
 * stack-walking -- closed there by using TWO SEPARATE Python OS processes
 * (oracle process never sees validation_code; contributor process never
 * sees the schema/ground-truth). This category does not merely copy that
 * fix -- computeOracleDecisions() never runs in Python at ALL. The oracle
 * lives and dies entirely inside THIS Node.js harness process; the ONLY
 * thing ever written into the one Python subprocess this category spawns is
 * solution_code's own source plus the timeline's (key, timestamp) pairs --
 * `expected` is stripped out before the Python driver script is even built
 * (see buildDriverScript's own EVENTS_JSON, which the caller constructs from
 * `{key, timestamp}` only -- grep this file for the one place `.expected`
 * is read and confirm it is never threaded into anything sent to Python).
 * A sys._getframe() stack-walk from inside solution_code's check() can reach
 * only this ONE Python process's own frames, which never held the answer at
 * any point -- there is no address space anywhere for such a walk to reach
 * that contains it. This is a stronger structural guarantee than "two
 * separate processes of the same language," achieved for free by this
 * category's own shape (the oracle needs no library only Python has), not
 * as an extra hardening step bolted on afterward.
 *
 * REAL-CLOCK-INJECTION ENFORCEMENT -- THE OTHER MOST IMPORTANT DESIGN
 * DECISION HERE: a rate limiter that secretly reads the real system clock
 * instead of using the `timestamp` argument cannot be verified against a
 * simulated timeline at all (its real behavior depends on real wall-clock
 * time, which this harness never lets elapse -- the whole timeline runs in
 * a handful of milliseconds regardless of how many virtual seconds/hours it
 * spans). Two layers, matching this registry's existing "cheap textual
 * pre-filter + mechanical backstop" convention (diff_patch_application's own
 * header-gate-on-top-of-git's-own-defenses is the closest precedent):
 *   (1) STATIC, pre-execution: findForbiddenClockUsage() rejects solution_code
 *       outright (a real, specific failure, before python3 is even checked
 *       for availability) if its source contains a literal import of
 *       time/datetime/calendar, a call to any of their real-clock-reading
 *       functions, time.sleep() (this category never needs real sleeping --
 *       every second is a plain number), os.times(), or any use of ctypes
 *       (a documented raw-syscall clock-access escape hatch, banned outright
 *       here rather than chased case-by-case). ACCEPTED, DOCUMENTED
 *       OVER-REJECTION RISK: this is a plain substring/regex scan of the
 *       WHOLE source text, including comments and docstrings -- a submission
 *       whose own comment happens to contain the literal phrase "import
 *       time" is rejected too. Deliberate, not an oversight: this category's
 *       own solution_code is graded code, not documentation prose, so a
 *       false reject here costs nothing legitimate, and "the safe failure
 *       mode here is an over-cautious reject, never a bypass" is this
 *       registry's own stated design preference (diff_patch_application's
 *       identical framing for its own header-exact-match gate).
 *   (2) RUNTIME, mechanical backstop, inside the Python driver itself,
 *       BEFORE solution_code is ever exec()'d: sys.modules['time'],
 *       ['datetime'], and ['calendar'] are replaced with a stub object whose
 *       __getattr__ raises immediately on ANY attribute access. Because
 *       CPython's import machinery ALWAYS consults sys.modules first --
 *       for a bare `import X`, `from X import Y`, `importlib.import_module
 *       ('X')`, or the `__import__` builtin alike -- this closes off every
 *       ordinary import mechanism regardless of how solution_code phrases
 *       it, including ones that dodge (1)'s literal-text scan entirely
 *       (confirmed in this file's own self-test via
 *       `importlib.import_module('time').time()`, which contains neither
 *       the substring "import time" nor "time.time(" and passes gate (1)
 *       clean, then is caught here at runtime instead). ACCEPTED RESIDUAL,
 *       same documented tier as PY_PRELUDE's own ctypes-raw-syscall-bypass
 *       residual in helpers.js: a submission that reaches the real C-level
 *       clock via a mechanism that never touches the Python `time`/
 *       `datetime`/`calendar` module objects at all (a raw ctypes call
 *       into libc, for one -- already separately banned outright by gate
 *       (1) above rather than left to this layer) is not caught here either;
 *       not chased further, matching this registry's own existing tier for
 *       this exact class of attack.
 *
 * NO REAL SLEEPING, EVER -- CONFIRMED BY CONSTRUCTION, NOT MERELY BY POLICY:
 * the Python driver never calls time.sleep() (nor anything that could), and
 * the ENTIRE timeline -- however many virtual seconds/hours/days it spans --
 * is driven by a single, ordinary Python for-loop calling check(key,
 * timestamp) with plain numbers. A row whose timeline spans a simulated week
 * verifies exactly as fast as one spanning a simulated minute; TIMEOUT_MS
 * below is sized for the REAL cost of up to MAX_EVENTS plain function calls
 * (near-instant), never for anything resembling the virtual timespan a row's
 * own timestamps describe.
 *
 * ANTI-HARDCODING GATE: validateTimeline() rejects (as a bad row, mirroring
 * http_api_contract_testing's own bad_requests_contract gate) any timeline
 * whose every event shares one identical `expected` outcome (all "admit" or
 * all "reject") -- such a row cannot distinguish a real rate limiter from a
 * stub that always returns one fixed answer, regardless of what
 * computeOracleDecisions() or solution_code do downstream.
 *
 * WHY solution_code NEVER RECEIVES policy_params: policy_params is curator-
 * authored ground truth the harness's own oracle trusts mechanically;
 * solution_code is instead expected to read policy_description (natural-
 * language prose stating the identical numbers) and hardcode its own
 * RateLimiter accordingly -- the same "read the prose, implement it"
 * contract every other category in this registry already uses for
 * task_description. Never passing policy_params to solution_code also means
 * there is nothing for it to blindly echo back even if it wanted to.
 *
 * GATE ORDER: field presence -> policy_type enum membership -> policy_params
 * shape/range validation -> timeline shape/ordering/anti-hardcoding
 * validation -> INDEPENDENT ORACLE cross-check (all dataset-authoring-defect
 * rejections, none of which ever touch solution_code or the sandbox) ->
 * solution_code's own static clock-usage/structural checks -> h.have
 * ('python3') -> the one Python subprocess -> per-event decision comparison.
 *
 * TIMEOUT BUDGET: MAX_EVENTS (100) plain Python method calls plus one class
 * instantiation, all pure in-process arithmetic with zero I/O, zero real
 * sleeping, and zero subprocess spawning inside the driver itself.
 * TIMEOUT_MS (10000ms) is a wide, generous multiple of the realistic
 * sub-50ms cost of that -- a genuine timeout at this budget, for work this
 * small, is itself meaningful signal (a pathological/adversarial busy-loop
 * inside check(), the one class of "fake slowness" this category's clock-
 * injection defenses cannot themselves detect -- see schema.json's own
 * RateLimiter contract text) and is treated as a real failure, not
 * runtimeUnavailable, matching this registry's "timeout on tiny, fast work
 * is data about the input" convention (diff_patch_application's identical
 * framing). Comfortably under the outer sandbox command budget (120000ms,
 * helpers.js's OUTER_SANDBOX_BUDGET_MS) with roughly 110000ms of margin.
 */
'use strict';

const crypto = require('crypto');

const MIN_EVENTS = 4;
const MAX_EVENTS = 100;
const MAX_KEY_LEN = 200;
const TIMEOUT_MS = 10000;
const MAX_PARAM_VALUE = 1000000;

const POLICY_TYPES = ['fixed_window', 'sliding_window_log', 'sliding_window_counter', 'token_bucket', 'leaky_bucket'];

// ------------------------------------------------------- policy_params ---

function positiveFiniteNumber(v, max) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null;
}

/** Validate policy_params' shape against policy_type. Returns { ok, reason, params }. */
function validatePolicyParams(raw, policyType) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'policy_params must be valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'policy_params must be a JSON object' };
  }

  if (policyType === 'fixed_window' || policyType === 'sliding_window_log' || policyType === 'sliding_window_counter') {
    const windowSeconds = positiveFiniteNumber(parsed.window_seconds, MAX_PARAM_VALUE);
    if (windowSeconds == null) {
      return { ok: false, reason: 'policy_params.window_seconds must be a positive finite number (<=' + MAX_PARAM_VALUE + ') for policy_type "' + policyType + '"' };
    }
    if (!Number.isInteger(parsed.limit) || parsed.limit < 1 || parsed.limit > MAX_PARAM_VALUE) {
      return { ok: false, reason: 'policy_params.limit must be a positive integer (1-' + MAX_PARAM_VALUE + ') for policy_type "' + policyType + '"' };
    }
    return { ok: true, params: { window_seconds: windowSeconds, limit: parsed.limit } };
  }
  if (policyType === 'token_bucket') {
    const capacity = positiveFiniteNumber(parsed.capacity, MAX_PARAM_VALUE);
    const refillRate = positiveFiniteNumber(parsed.refill_rate, MAX_PARAM_VALUE);
    if (capacity == null) return { ok: false, reason: 'policy_params.capacity must be a positive finite number (<=' + MAX_PARAM_VALUE + ') for policy_type "token_bucket"' };
    if (refillRate == null) return { ok: false, reason: 'policy_params.refill_rate must be a positive finite number (<=' + MAX_PARAM_VALUE + ') for policy_type "token_bucket"' };
    return { ok: true, params: { capacity, refill_rate: refillRate } };
  }
  if (policyType === 'leaky_bucket') {
    const capacity = positiveFiniteNumber(parsed.capacity, MAX_PARAM_VALUE);
    const leakRate = positiveFiniteNumber(parsed.leak_rate, MAX_PARAM_VALUE);
    if (capacity == null) return { ok: false, reason: 'policy_params.capacity must be a positive finite number (<=' + MAX_PARAM_VALUE + ') for policy_type "leaky_bucket"' };
    if (leakRate == null) return { ok: false, reason: 'policy_params.leak_rate must be a positive finite number (<=' + MAX_PARAM_VALUE + ') for policy_type "leaky_bucket"' };
    return { ok: true, params: { capacity, leak_rate: leakRate } };
  }
  return { ok: false, reason: 'unrecognized policy_type "' + policyType + '"' };
}

// ------------------------------------------------------------ timeline ---

/** Validate timeline's shape, ordering, and the anti-hardcoding gate.
 * Returns { ok, reason, events }. events: [{key, timestamp, expected}]. */
function validateTimeline(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'timeline must be valid JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'timeline must be a JSON array' };
  }
  if (parsed.length < MIN_EVENTS) {
    return { ok: false, reason: 'timeline must contain at least ' + MIN_EVENTS + ' events' };
  }
  if (parsed.length > MAX_EVENTS) {
    return { ok: false, reason: 'timeline exceeds the maximum of ' + MAX_EVENTS + ' events for this category' };
  }

  const events = [];
  let lastTs = -Infinity;
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, reason: 'timeline[' + i + '] must be an object' };
    }
    if (typeof e.key !== 'string' || !e.key.trim() || e.key.length > MAX_KEY_LEN) {
      return { ok: false, reason: 'timeline[' + i + '].key must be a non-empty string (<=' + MAX_KEY_LEN + ' chars)' };
    }
    const ts = e.timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) {
      return { ok: false, reason: 'timeline[' + i + '].timestamp must be a non-negative finite number (a virtual clock value, never a real wall-clock timestamp)' };
    }
    if (ts < lastTs) {
      return { ok: false, reason: 'timeline[' + i + '].timestamp (' + ts + ') is earlier than a previous event\'s timestamp (' + lastTs + ') -- timeline must be ordered non-decreasing by timestamp, matching how a real limiter only ever observes requests in the order they happen' };
    }
    lastTs = ts;
    if (e.expected !== 'admit' && e.expected !== 'reject') {
      return { ok: false, reason: 'timeline[' + i + '].expected must be exactly "admit" or "reject"' };
    }
    events.push({ key: e.key, timestamp: ts, expected: e.expected });
  }

  // ANTI-HARDCODING GATE -- see module doc comment.
  const first = events[0].expected;
  if (events.every((e) => e.expected === first)) {
    return {
      ok: false,
      reason: 'timeline must include at least one event whose expected outcome genuinely differs from another -- a row where every event expects the identical outcome ("' + first + '") cannot distinguish a real rate limiter from a stub that always returns one fixed answer',
    };
  }

  return { ok: true, events };
}

// --------------------------------------------------- independent oracle ---
// See module doc comment (INDEPENDENT ORACLE) -- one pure, deterministic
// reference function per policy_type, run entirely in this Node process,
// operating on curator-authored policy_params alone. Never sees
// solution_code; never runs in Python.

function decideFixedWindow(params, st, t) {
  const idx = Math.floor(t / params.window_seconds);
  if (st.windowIndex !== idx) {
    st.windowIndex = idx;
    st.count = 0;
  }
  if (st.count < params.limit) {
    st.count += 1;
    return 'admit';
  }
  return 'reject';
}

function decideSlidingWindowLog(params, st, t) {
  if (!st.log) st.log = [];
  const cutoff = t - params.window_seconds;
  st.log = st.log.filter((ts) => ts > cutoff);
  if (st.log.length < params.limit) {
    st.log.push(t);
    return 'admit';
  }
  return 'reject';
}

function decideSlidingWindowCounter(params, st, t) {
  const idx = Math.floor(t / params.window_seconds);
  if (st.currentIndex === undefined) {
    st.currentIndex = idx;
    st.currentCount = 0;
    st.previousCount = 0;
  } else if (idx === st.currentIndex) {
    // same fixed window as the previous event -- no shift.
  } else if (idx === st.currentIndex + 1) {
    st.previousCount = st.currentCount;
    st.currentCount = 0;
    st.currentIndex = idx;
  } else {
    // A gap of more than one whole window with no requests at all --
    // whatever was "previous" is now itself stale.
    st.previousCount = 0;
    st.currentCount = 0;
    st.currentIndex = idx;
  }
  const windowStart = idx * params.window_seconds;
  const elapsedInCurrent = t - windowStart;
  const weight = (params.window_seconds - elapsedInCurrent) / params.window_seconds;
  const estimate = st.currentCount + st.previousCount * weight;
  if (estimate < params.limit) {
    st.currentCount += 1;
    return 'admit';
  }
  return 'reject';
}

function decideTokenBucket(params, st, t) {
  if (st.lastTime === undefined) {
    // Bucket starts FULL at the first request -- see schema.json.
    st.tokens = params.capacity;
    st.lastTime = t;
  } else {
    const elapsed = t - st.lastTime;
    st.tokens = Math.min(params.capacity, st.tokens + elapsed * params.refill_rate);
    st.lastTime = t;
  }
  if (st.tokens >= 1) {
    st.tokens -= 1;
    return 'admit';
  }
  return 'reject';
}

function decideLeakyBucket(params, st, t) {
  if (st.lastTime === undefined) {
    // Bucket starts EMPTY at the first request -- see schema.json.
    st.level = 0;
    st.lastTime = t;
  } else {
    const elapsed = t - st.lastTime;
    st.level = Math.max(0, st.level - elapsed * params.leak_rate);
    st.lastTime = t;
  }
  if (st.level < params.capacity) {
    st.level += 1;
    return 'admit';
  }
  return 'reject';
}

const DECIDERS = {
  fixed_window: decideFixedWindow,
  sliding_window_log: decideSlidingWindowLog,
  sliding_window_counter: decideSlidingWindowCounter,
  token_bucket: decideTokenBucket,
  leaky_bucket: decideLeakyBucket,
};

/** Runs the reference oracle for policyType across every event, IN ORDER,
 * with independent per-key state -- returns an array of 'admit'/'reject',
 * index-aligned with `events`. */
function computeOracleDecisions(policyType, params, events) {
  const decide = DECIDERS[policyType];
  const stateByKey = new Map();
  const out = [];
  for (const ev of events) {
    let st = stateByKey.get(ev.key);
    if (!st) {
      st = {};
      stateByKey.set(ev.key, st);
    }
    out.push(decide(params, st, ev.timestamp));
  }
  return out;
}

// --------------------------------------------- clock-injection gate 1 ---
// Static, pre-execution -- see module doc comment (REAL-CLOCK-INJECTION
// ENFORCEMENT). A whole-source-text scan, deliberately including comments/
// docstrings -- see module doc comment for why an over-cautious reject here
// is accepted.
const FORBIDDEN_CLOCK_PATTERNS = [
  { re: /\bimport\s+time\b/, reason: 'imports the "time" module' },
  { re: /\bfrom\s+time\s+import\b/, reason: 'imports from the "time" module' },
  { re: /\bimport\s+datetime\b/, reason: 'imports the "datetime" module' },
  { re: /\bfrom\s+datetime\s+import\b/, reason: 'imports from the "datetime" module' },
  { re: /\bimport\s+calendar\b/, reason: 'imports the "calendar" module' },
  { re: /\btime\s*\.\s*time\s*\(/, reason: 'calls time.time()' },
  { re: /\btime\s*\.\s*time_ns\s*\(/, reason: 'calls time.time_ns()' },
  { re: /\btime\s*\.\s*monotonic\s*\(/, reason: 'calls time.monotonic()' },
  { re: /\btime\s*\.\s*monotonic_ns\s*\(/, reason: 'calls time.monotonic_ns()' },
  { re: /\btime\s*\.\s*perf_counter\s*\(/, reason: 'calls time.perf_counter()' },
  { re: /\btime\s*\.\s*sleep\s*\(/, reason: 'calls time.sleep() -- this category never uses real sleeping; every "second" is a plain number passed to check()' },
  { re: /\bdatetime\s*\.\s*now\s*\(/, reason: 'calls datetime.now()' },
  { re: /\butcnow\s*\(/, reason: 'calls .utcnow()' },
  { re: /\bdatetime\s*\.\s*today\s*\(/, reason: 'calls datetime.today()' },
  { re: /\bdate\s*\.\s*today\s*\(/, reason: 'calls date.today()' },
  { re: /\bos\s*\.\s*times\s*\(/, reason: 'calls os.times() (a real elapsed-time source)' },
  { re: /\bctypes\b/, reason: 'uses ctypes -- a documented raw-syscall clock-access escape hatch, banned outright for this category' },
];

function findForbiddenClockUsage(code) {
  for (const p of FORBIDDEN_CLOCK_PATTERNS) {
    if (p.re.test(code)) return p.reason;
  }
  return null;
}

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/**
 * The Python driver -- see module doc comment (WHY THIS CATEGORY'S ORACLE/
 * CONTRIBUTOR SEPARATION IS STRONGER, REAL-CLOCK-INJECTION ENFORCEMENT
 * layer 2). eventsForPython carries ONLY {key, timestamp} -- `expected` is
 * never threaded in here; the caller (verify() below) strips it before this
 * function is ever invoked.
 */
function buildDriverScript(pyPrelude, solutionCode, eventsForPython, mark) {
  return [
    'import sys, os, json',
    '',
    pyPrelude,
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark),
    '    SOLUTION_SRC = ' + pyStr(solutionCode),
    '    EVENTS = json.loads(' + pyStr(JSON.stringify(eventsForPython)) + ')',
    '    _real_write = os.write',
    '    result = {"stage": "started"}',
    '',
    '    def _emit():',
    '        _real_write(1, (MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
    '',
    '    # RUNTIME CLOCK-BLOCK -- gate 2 of the REAL-CLOCK-INJECTION',
    '    # ENFORCEMENT (see harness.js module doc comment). Installed BEFORE',
    '    # solution_code is ever exec\'d: CPython\'s import machinery always',
    '    # consults sys.modules first, for every import mechanism alike, so',
    '    # replacing these three entries here closes off bare `import X`,',
    '    # `from X import Y`, `importlib.import_module("X")`, and',
    '    # `__import__("X")` uniformly, regardless of which one',
    '    # solution_code uses.',
    '    class _BlockedClockModule(object):',
    '        def __init__(self, name):',
    '            self._name = name',
    '        def __getattr__(self, attr):',
    '            raise RuntimeError(',
    '                "solution_code attempted to access the real system clock via " +',
    '                self._name + "." + attr + "() -- forbidden for this category: " +',
    '                "RateLimiter.check(key, timestamp) must decide admit/reject using " +',
    '                "ONLY the timestamp argument the harness passes in, never a real " +',
    '                "wall-clock/monotonic read."',
    '            )',
    '    sys.modules["time"] = _BlockedClockModule("time")',
    '    sys.modules["datetime"] = _BlockedClockModule("datetime")',
    '    sys.modules["calendar"] = _BlockedClockModule("calendar")',
    '',
    '    try:',
    '        ns = {}',
    '        exec(compile(SOLUTION_SRC, "<solution_code>", "exec"), ns)',
    '    except BaseException as e:',
    '        result["stage"] = "load_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    cls = ns.get("RateLimiter")',
    '    if not isinstance(cls, type):',
    '        result["stage"] = "no_ratelimiter_class"',
    '        _emit(); return',
    '',
    '    try:',
    '        limiter = cls()',
    '    except BaseException as e:',
    '        result["stage"] = "init_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    check_fn = getattr(limiter, "check", None)',
    '    if not callable(check_fn):',
    '        result["stage"] = "no_check_method"',
    '        _emit(); return',
    '',
    '    decisions = []',
    '    result["stage"] = "in_progress"',
    '    result["decisions"] = decisions',
    '    for i, ev in enumerate(EVENTS):',
    '        try:',
    '            r = check_fn(ev["key"], ev["timestamp"])',
    '            decisions.append({"index": i, "ok": True, "admit": bool(r)})',
    '        except BaseException as e:',
    '            decisions.append({"index": i, "ok": False, "error": repr(e)})',
    '        _emit()  # checkpoint after EVERY event -- see module doc comment',
    '                 # (TIMEOUT BUDGET) and algorithmic_complexity_verification\'s',
    '                 # own INCREMENTAL-CHECKPOINT precedent: a hang inside one',
    '                 # check() call still leaves every prior decision readable.',
    '',
    '    result["stage"] = "ok"',
    '    _emit()',
    '',
    '_main()',
  ].join('\n');
}

module.exports = {
  contract: 'policy-simulation-match',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const policyType = h.str(row, 'policy_type').trim();
    const policyDescription = h.str(row, 'policy_description');
    const policyParamsRaw = h.str(row, 'policy_params');
    const solutionCode = h.str(row, 'solution_code');
    const timelineRaw = h.str(row, 'timeline');

    if (!taskDescription.trim() || !policyType || !policyDescription.trim() || !policyParamsRaw.trim() || !solutionCode.trim() || !timelineRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, policy_type, policy_description, policy_params, solution_code, or timeline' } };
    }

    if (!POLICY_TYPES.includes(policyType)) {
      return {
        passed: false,
        logs: 'policy_type "' + policyType + '" is not one of the recognized values: ' + POLICY_TYPES.join(', '),
        detail: { reason: 'unrecognized_policy_type' },
      };
    }

    const paramsCheck = validatePolicyParams(policyParamsRaw, policyType);
    if (!paramsCheck.ok) {
      return { passed: false, logs: paramsCheck.reason, detail: { reason: 'bad_policy_params' } };
    }
    const params = paramsCheck.params;

    const timelineCheck = validateTimeline(timelineRaw);
    if (!timelineCheck.ok) {
      return { passed: false, logs: timelineCheck.reason, detail: { reason: 'bad_timeline' } };
    }
    const events = timelineCheck.events;

    // INDEPENDENT ORACLE CROSS-CHECK -- see module doc comment. Runs
    // entirely in this Node process, before solution_code (or python3's
    // own availability) is ever considered.
    const oracleDecisions = computeOracleDecisions(policyType, params, events);
    for (let i = 0; i < events.length; i++) {
      if (oracleDecisions[i] !== events[i].expected) {
        return {
          passed: false,
          logs: 'timeline[' + i + '] declares expected="' + events[i].expected + '" but this row\'s own policy_type ("' + policyType + '") + policy_params independently compute "' + oracleDecisions[i] + '" at key=' + JSON.stringify(events[i].key) + ' timestamp=' + events[i].timestamp + ' -- dataset-authoring defect (timeline does not actually match its own declared policy), rejected before solution_code is ever run',
          detail: { reason: 'oracle_mismatch', index: i, declaredExpected: events[i].expected, oracleExpected: oracleDecisions[i] },
        };
      }
    }

    // solution_code's own static clock-usage gate -- see module doc comment
    // (REAL-CLOCK-INJECTION ENFORCEMENT, layer 1).
    const forbidden = findForbiddenClockUsage(solutionCode);
    if (forbidden) {
      return {
        passed: false,
        logs: 'solution_code ' + forbidden + ' -- forbidden for this category: RateLimiter.check(key, timestamp) must decide admit/reject using ONLY the timestamp argument, never a real clock read or a real sleep',
        detail: { reason: 'forbidden_clock_usage', matched: forbidden },
      };
    }
    if (!/^\s*class\s+RateLimiter\b/m.test(solutionCode)) {
      return {
        passed: false,
        logs: 'solution_code must define a top-level class named exactly RateLimiter',
        detail: { reason: 'no_ratelimiter_class' },
      };
    }
    if (!/\bdef\s+check\s*\(/.test(solutionCode)) {
      return {
        passed: false,
        logs: 'solution_code\'s RateLimiter class must define a method named exactly check (e.g. def check(self, key, timestamp):)',
        detail: { reason: 'no_check_method' },
      };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    // eventsForPython carries ONLY {key, timestamp} -- `expected` is
    // deliberately never included. See module doc comment.
    const eventsForPython = events.map((e) => ({ key: e.key, timestamp: e.timestamp }));

    const d = h.workdir();
    const mark = '@@RLROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = buildDriverScript(h.PY_PRELUDE, solutionCode, eventsForPython, mark);
    const scriptPath = h.path.join(d, 'run_rate_limit.py');
    h.fs.writeFileSync(scriptPath, script);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: up to
    // MAX_EVENTS checkpoint lines could exceed the report-bounding cap
    // before the trailing "ok" marker line is reached.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }

    if (!out || typeof out !== 'object' || !out.stage) {
      return {
        passed: false,
        logs: r.timedOut
          ? ('solution_code did not complete its check() calls within the ' + TIMEOUT_MS + 'ms budget -- for work this small (a plain loop over ' + events.length + ' events), this is itself a real failure, not an infra problem')
          : ('could not parse verification output: ' + String(r.stderr || '').slice(0, 500)),
        detail: { reason: 'unparseable_output', timedOut: !!r.timedOut },
      };
    }

    if (out.stage === 'load_failed') {
      return { passed: false, logs: 'solution_code failed to load: ' + String(out.error || '').slice(0, 800), detail: { reason: 'load_failed' } };
    }
    if (out.stage === 'no_ratelimiter_class') {
      return { passed: false, logs: 'solution_code does not define a top-level RateLimiter class after exec', detail: { reason: 'no_ratelimiter_class' } };
    }
    if (out.stage === 'init_failed') {
      return { passed: false, logs: 'RateLimiter() raised during construction: ' + String(out.error || '').slice(0, 800), detail: { reason: 'init_failed' } };
    }
    if (out.stage === 'no_check_method') {
      return { passed: false, logs: 'RateLimiter instance has no callable check method', detail: { reason: 'no_check_method' } };
    }

    const decisions = Array.isArray(out.decisions) ? out.decisions : [];
    if (decisions.length < events.length) {
      return {
        passed: false,
        logs: 'check() calls did not complete for the whole timeline (reached ' + decisions.length + ' of ' + events.length + ' events within the ' + TIMEOUT_MS + 'ms budget)',
        detail: { reason: 'sequence_incomplete', completed: decisions.length, total: events.length },
      };
    }

    const mismatches = [];
    for (let i = 0; i < events.length; i++) {
      const dec = decisions[i] || {};
      if (dec.ok !== true) {
        mismatches.push({ index: i, reason: 'check() raised: ' + String(dec.error || '').slice(0, 300) });
        continue;
      }
      const actualOutcome = dec.admit ? 'admit' : 'reject';
      if (actualOutcome !== events[i].expected) {
        mismatches.push({ index: i, reason: 'expected "' + events[i].expected + '" but RateLimiter.check(' + JSON.stringify(events[i].key) + ', ' + events[i].timestamp + ') returned "' + actualOutcome + '"' });
      }
    }

    if (mismatches.length > 0) {
      return {
        passed: false,
        logs: 'timeline[' + mismatches[0].index + ']: ' + mismatches[0].reason + (mismatches.length > 1 ? ' (+' + (mismatches.length - 1) + ' more mismatch(es))' : ''),
        detail: { reason: 'decision_mismatch', mismatches: mismatches.slice(0, 20), totalMismatches: mismatches.length, totalEvents: events.length },
      };
    }

    return {
      passed: true,
      score: 1,
      detail: { reason: 'ok', eventsChecked: events.length, policyType },
    };
  },
};
