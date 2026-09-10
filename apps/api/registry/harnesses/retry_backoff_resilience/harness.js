/**
 * retry-policy-behavior-match -- retry_backoff_resilience.
 *
 * THE CONTRACT: solution_code (real, contributor-controlled Python) defines
 * exactly one top-level function `retry_call(dependency, sleep)`, mirroring
 * how a real retry decorator wraps an arbitrary callable. The harness (never
 * solution_code) owns and constructs BOTH arguments fresh for every row and
 * calls retry_call() ONCE: `dependency` is a zero-argument callable that
 * either returns the dependency's own successful result value or raises,
 * per this row's own harness-scripted `dependency_behavior`; `sleep` is a
 * one-argument callable, `sleep(seconds)`, that solution_code MUST call
 * instead of time.sleep() for every backoff delay -- the harness intercepts
 * it, records exactly what was requested, and never actually blocks. The
 * harness then checks THREE things about what really happened: the exact
 * number of real calls made to the dependency, the exact sequence of delay
 * values requested between them (bounds-checked rather than exact-matched
 * for the one strategy_type -- exponential_backoff_with_jitter -- whose
 * delays are genuinely randomized), and the final outcome (the dependency's
 * own successful value returned, or an exception propagated after every
 * allowed attempt is exhausted).
 *
 * WHY THIS CALLING CONVENTION (harness calls INTO solution_code's own
 * function, which itself takes a callable) OVER THE ALTERNATIVE (solution_
 * code calls a harness-provided dependency_call() function directly): this
 * is the realistic, standard shape of retry/backoff code in production --
 * `tenacity`, `backoff`, and hand-rolled retry decorators alike all wrap an
 * arbitrary caller-supplied callable, they are never themselves the thing
 * that owns a fixed, hardcoded dependency to call. It also makes THIS
 * category's own two central verifications direct rather than inferred:
 * dependency-call-count and delay-sequence are both observed exactly as
 * solution_code produces them, by intercepting the two functions it MUST
 * use to do any of this at all, rather than trying to reverse-engineer
 * retry behavior from stdout text or a side-channel log. The one added
 * mechanical cost -- injecting a live Python callable across the exec()
 * boundary -- is unremarkable: the driver script below simply defines
 * `_dependency`/`_sleep` as ordinary Python closures in the SAME process
 * BEFORE exec()'ing solution_code, then calls the resulting `retry_call`
 * with them as plain positional arguments, no different in kind from how
 * rate_limiting_policy_simulation's own driver calls solution_code's
 * check(key, timestamp) with plain data arguments.
 *
 * WHY solution_code NEVER RECEIVES strategy_params: identical reasoning to
 * rate_limiting_policy_simulation/caching_strategy's own module doc
 * comments -- strategy_params is curator-authored ground truth the
 * harness's own oracle trusts mechanically; solution_code is instead
 * expected to read strategy_description (natural-language prose stating
 * the identical numbers) and hardcode its own retry_call accordingly.
 *
 * WHY THIS CATEGORY'S ORACLE SHAPE DIFFERS FROM ITS SIBLINGS' (a forward
 * SIMULATION producing one row-level trace, not a per-INDEX decision
 * function): rate_limiting_policy_simulation/caching_strategy's own oracles
 * decide each timeline event/operation independently, in order, because
 * their timelines/operations are externally driven -- every event happens
 * regardless of what the previous one decided. A retry sequence is
 * fundamentally NOT like that: dependency_behavior's own "succeed" entries
 * SHORT-CIRCUIT the whole sequence (nothing after a genuine success is ever
 * reached), and circuit_breaker's own open/half-open transitions change
 * which entries even get consumed at all. simulateStrategy() below is
 * therefore a small forward STATE-MACHINE walk over dependency_behavior,
 * not an independent per-index decider -- the natural shape for this
 * domain, not a deviation from the proven pattern for its own sake.
 *
 * INDEPENDENT ORACLE -- IMPLEMENTED FOR ALL FOUR strategy_type VALUES: every
 * strategy this category supports is a small, fully-specified, deterministic
 * state machine over (attempt outcome so far), identical in spirit to
 * rate_limiting_policy_simulation/caching_strategy's own small deterministic
 * algorithms -- no external library is needed as a trusted oracle, so the
 * oracle lives and dies entirely inside this Node harness process, for the
 * same "stronger than a second-process design" reasons documented at length
 * in rate_limiting_policy_simulation's own module doc comment (never
 * repeated verbatim here -- see that file). The ONLY thing ever written
 * into the one Python subprocess this category spawns is solution_code's
 * own source plus dependency_behavior's own script (fail/succeed strings,
 * carrying no expected_result information at all) -- expected_result is
 * stripped out before the Python driver script is ever built.
 *
 * HANDLING exponential_backoff_with_jitter'S INHERENT RANDOMNESS -- BOUNDS,
 * NOT EXACT MATCH, AND WHY THE BOUNDS THEMSELVES ARE STILL AN INDEPENDENT
 * ORACLE: a genuinely randomized delay cannot be exact-matched by design --
 * demanding exact equality would either force solution_code to fake
 * determinism (defeating the entire point of jitter, which exists to
 * decorrelate many clients' retry timing) or make every jittered row
 * unverifiable. This harness instead computes the RAW, pre-jitter center
 * value raw_n = min(base_delay_seconds * multiplier^(n-1), max_delay_seconds)
 * -- deterministic, exactly the same value exponential_backoff itself would
 * use -- and requires every REAL delay solution_code requests to fall
 * inside [raw_n*(1-jitter_ratio), raw_n*(1+jitter_ratio)]. The curator's own
 * declared expected_result.delay_sequence holds these RAW center values
 * (never a random sample), so it is STILL exactly cross-checked against the
 * oracle before solution_code ever runs -- only the FINAL comparison against
 * solution_code's own real, randomized output is a bounds check rather than
 * an exact one. ADDITIONAL HEURISTIC (documented as a heuristic, not a
 * proof -- see checkSuspectedMissingJitter()'s own comment below): when a
 * row has at least two jittered delays, a solution_code that returns the
 * bit-exact raw_n center value for EVERY one of them is flagged as
 * suspected_missing_jitter -- the probability of a genuine
 * random.uniform(lo, hi) draw landing on the exact floating-point midpoint,
 * repeatedly, is negligible, so this is a real, low-false-positive signal
 * that solution_code silently ignored jitter_ratio and just returned the
 * unjittered exponential value. ACCEPTED, HONESTLY DOCUMENTED RESIDUAL:
 * this harness does NOT attempt to statistically verify that jitter is
 * GENUINELY random (as opposed to some other non-uniform-but-in-bounds
 * scheme) -- doing so rigorously would require running solution_code many
 * times per row and applying a real randomness test, disproportionate for a
 * per-row execution-verification harness. A solution_code that always
 * returns, say, raw_n*(1-jitter_ratio) exactly (the band's own lower edge,
 * never randomized) passes this harness's bounds check and evades the
 * bit-exact-center heuristic above -- not chased further, the same
 * documented-residual tier as this registry's other accepted gaps (e.g.
 * PY_PRELUDE's own ctypes-raw-syscall-bypass residual in helpers.js).
 *
 * CIRCUIT_BREAKER STATE-MACHINE VERIFICATION -- CHECKED THROUGH THE CALL/
 * DELAY SEQUENCE ITSELF, NOT A SEPARATE DECLARED FINAL-STATE FIELD: the
 * central risk this strategy_type must catch is a submission that keeps
 * CALLING the dependency after the circuit should be open (fast-failing
 * AFTER a real call, not genuinely skipping it), or that never actually
 * waits reset_timeout_seconds before its half-open trial. Both are caught
 * mechanically, without needing solution_code to expose its own internal
 * circuit state at all: dependency_behavior's own length is authored to be
 * EXACTLY the number of real calls a correct implementation would ever make
 * (see that field's own help text) -- a submission that wrongly calls the
 * dependency during a should-be-skipped OPEN slot consumes a script entry
 * one step too early, misaligning every subsequent comparison and, at the
 * latest, overrunning the script's own length (the harness's injected
 * dependency() callable simply keeps returning simulated failures forever
 * once the script is exhausted -- see solution_code's own help text) --
 * surfaced as a real final-call-count mismatch against expected_result.
 * final_attempts. Whether the half-open wait genuinely happened, and for
 * the right duration, is checked by the ordinary delay-sequence comparison
 * (exact match for this strategy_type -- no jitter involved): a submission
 * that skips the wait, or waits the wrong amount, produces a delay array
 * that does not match the oracle's own exactly-computed reset_timeout_
 * seconds entries. A THIRD, EXPLICIT anti-hardcoding gate (see
 * checkCircuitOpensAtLeastOnce below, its own distinctly-tagged
 * circuit_never_opened reason) additionally rejects any circuit_breaker row
 * whose own dependency_behavior/strategy_params never actually trips the
 * circuit open at all -- a row that never exercises the open state cannot
 * distinguish a real circuit breaker from plain sequential retrying, no
 * matter how carefully the rest of it is graded.
 *
 * REAL-CLOCK-INJECTION ENFORCEMENT -- SAME PROVEN PATTERN, REUSED VERBATIM
 * FROM rate_limiting_policy_simulation/caching_strategy: a retry/backoff
 * implementation that secretly reads the real system clock, or really
 * sleeps, instead of using the injected `sleep` callable cannot be verified
 * without truly waiting out its own (potentially multi-second, per-row)
 * backoff schedule -- exactly the reason a 100-row dataset of this category
 * would otherwise take forever to verify. Two layers, identical in shape to
 * both siblings' own module doc comments (not re-argued at length here --
 * see rate_limiting_policy_simulation's own module doc comment for the full
 * reasoning behind each layer, including the documented over-rejection
 * trade-off for layer 1 and the sys._getframe()-closed-by-construction
 * residual tier for layer 2): (1) STATIC, pre-execution -- findForbidden
 * ClockUsage() below, copied field-for-field from both siblings' own
 * FORBIDDEN_CLOCK_PATTERNS/findForbiddenClockUsage; (2) RUNTIME, mechanical
 * backstop -- the Python driver's sys.modules['time']/['datetime']/
 * ['calendar'] stub-and-raise-on-any-attribute-access, installed BEFORE
 * solution_code is ever exec()'d, identical to both siblings' own
 * implementation.
 *
 * NO REAL SLEEPING, EVER -- CONFIRMED BY CONSTRUCTION: the Python driver's
 * own injected `_sleep` closure never calls time.sleep() (nor anything that
 * could) -- it only records the requested seconds and returns immediately.
 * A row whose own backoff schedule spans simulated minutes still verifies
 * in a handful of real milliseconds, identical to both siblings' own
 * "virtual timeline never actually elapses" guarantee.
 *
 * TIMEOUT BUDGET -- WHY THIS CATEGORY HAS NO MAX_EVENTS-STYLE EXTERNAL LOOP
 * BOUND: unlike rate_limiting_policy_simulation/caching_strategy (where the
 * HARNESS itself drives a bounded, externally-counted loop of events/
 * operations, letting it checkpoint after every single one), this
 * category's retry loop lives entirely INSIDE solution_code's own
 * retry_call -- there is no external per-call boundary the harness can
 * checkpoint against beyond the two intercepted callables themselves
 * (which DO checkpoint on every call -- see buildDriverScript's own _emit()
 * calls inside _dependency/_sleep). A solution_code that ignores
 * max_attempts and retries forever is instead caught structurally: once
 * dependency_behavior's own (exactly-sized) script is exhausted, every
 * further dependency() call keeps simulating failure forever (see
 * buildDriverScript below), so a runaway implementation either eventually
 * raises (caught downstream as a real call-count mismatch) or spins until
 * TIMEOUT_MS (10000ms) fires -- treated as a real failure, not
 * runtimeUnavailable, matching this registry's "a genuine timeout on tiny,
 * fast work is itself meaningful signal" convention (rate_limiting_policy_
 * simulation/caching_strategy's identical framing for a pathological/
 * adversarial busy loop). TIMEOUT_MS is a wide, generous multiple of the
 * realistic sub-50ms cost of at most MAX_ATTEMPTS_CAP (12) plain Python
 * function calls plus arithmetic -- comfortably under the outer sandbox
 * command budget (120000ms, helpers.js's OUTER_SANDBOX_BUDGET_MS) with
 * roughly 110000ms of margin.
 *
 * GATE ORDER: field presence -> strategy_type enum membership ->
 * strategy_params shape/range validation -> dependency_behavior shape/range
 * validation -> expected_result shape validation -> INDEPENDENT ORACLE
 * simulation (bad_dependency_behavior for a script whose length does not
 * match what a correct implementation would ever consume) -> circuit_
 * breaker-only anti-hardcoding gate (circuit_never_opened) -> ORACLE
 * cross-check against expected_result's own declared values (oracle_
 * mismatch) -- all of which are dataset-authoring-defect rejections, none
 * of which ever touch solution_code or the sandbox -- -> solution_code's
 * own static clock-usage/structural checks -> h.have('python3') -> the one
 * Python subprocess -> real call-count/delay-sequence/outcome comparison.
 */
'use strict';

const crypto = require('crypto');

const MIN_ATTEMPTS = 2;
const MAX_ATTEMPTS_CAP = 12;
const MAX_PARAM_VALUE = 1000000;
const TIMEOUT_MS = 10000;

const STRATEGY_TYPES = ['fixed_delay', 'exponential_backoff', 'exponential_backoff_with_jitter', 'circuit_breaker'];

// ------------------------------------------------------ strategy_params ---

function positiveFiniteNumber(v, max) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null;
}

function boundedInt(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** Validate strategy_params' shape against strategy_type. Returns { ok, reason, params }. */
function validateStrategyParams(raw, strategyType) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'strategy_params must be valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'strategy_params must be a JSON object' };
  }

  const maxAttempts = boundedInt(parsed.max_attempts, MIN_ATTEMPTS, MAX_ATTEMPTS_CAP);
  if (maxAttempts == null) {
    return { ok: false, reason: 'strategy_params.max_attempts must be an integer between ' + MIN_ATTEMPTS + ' and ' + MAX_ATTEMPTS_CAP + ' (inclusive)' };
  }

  if (strategyType === 'fixed_delay') {
    const delay = positiveFiniteNumber(parsed.delay_seconds, MAX_PARAM_VALUE);
    if (delay == null) return { ok: false, reason: 'strategy_params.delay_seconds must be a positive finite number (<=' + MAX_PARAM_VALUE + ') for strategy_type "fixed_delay"' };
    return { ok: true, params: { delay_seconds: delay, max_attempts: maxAttempts } };
  }

  if (strategyType === 'exponential_backoff' || strategyType === 'exponential_backoff_with_jitter') {
    const base = positiveFiniteNumber(parsed.base_delay_seconds, MAX_PARAM_VALUE);
    if (base == null) return { ok: false, reason: 'strategy_params.base_delay_seconds must be a positive finite number (<=' + MAX_PARAM_VALUE + ') for strategy_type "' + strategyType + '"' };
    const multiplier = typeof parsed.multiplier === 'number' && Number.isFinite(parsed.multiplier) && parsed.multiplier > 1 && parsed.multiplier <= 100 ? parsed.multiplier : null;
    if (multiplier == null) return { ok: false, reason: 'strategy_params.multiplier must be a finite number strictly greater than 1 and at most 100 for strategy_type "' + strategyType + '"' };
    const maxDelay = positiveFiniteNumber(parsed.max_delay_seconds, MAX_PARAM_VALUE);
    if (maxDelay == null) return { ok: false, reason: 'strategy_params.max_delay_seconds must be a positive finite number (<=' + MAX_PARAM_VALUE + ') for strategy_type "' + strategyType + '"' };
    if (maxDelay < base) return { ok: false, reason: 'strategy_params.max_delay_seconds must be >= base_delay_seconds' };
    const params = { base_delay_seconds: base, multiplier: multiplier, max_delay_seconds: maxDelay, max_attempts: maxAttempts };
    if (strategyType === 'exponential_backoff_with_jitter') {
      const jitter = typeof parsed.jitter_ratio === 'number' && Number.isFinite(parsed.jitter_ratio) && parsed.jitter_ratio > 0 && parsed.jitter_ratio <= 1 ? parsed.jitter_ratio : null;
      if (jitter == null) return { ok: false, reason: 'strategy_params.jitter_ratio must be a finite number in (0, 1] for strategy_type "exponential_backoff_with_jitter"' };
      params.jitter_ratio = jitter;
    }
    return { ok: true, params };
  }

  if (strategyType === 'circuit_breaker') {
    const threshold = boundedInt(parsed.failure_threshold, 1, MAX_ATTEMPTS_CAP);
    if (threshold == null) return { ok: false, reason: 'strategy_params.failure_threshold must be an integer between 1 and ' + MAX_ATTEMPTS_CAP + ' for strategy_type "circuit_breaker"' };
    if (threshold > maxAttempts - 1) {
      return { ok: false, reason: 'strategy_params.failure_threshold must be <= max_attempts - 1 (so at least one half-open trial is reachable after the circuit trips)' };
    }
    const resetTimeout = positiveFiniteNumber(parsed.reset_timeout_seconds, MAX_PARAM_VALUE);
    if (resetTimeout == null) return { ok: false, reason: 'strategy_params.reset_timeout_seconds must be a positive finite number (<=' + MAX_PARAM_VALUE + ') for strategy_type "circuit_breaker"' };
    return { ok: true, params: { failure_threshold: threshold, reset_timeout_seconds: resetTimeout, max_attempts: maxAttempts } };
  }

  return { ok: false, reason: 'unrecognized strategy_type "' + strategyType + '"' };
}

// -------------------------------------------------- dependency_behavior ---

/** Validate dependency_behavior's shape and the length-floor anti-hardcoding
 * gate. Returns { ok, reason, script }. script: array of 'fail'/'succeed'. */
function validateDependencyBehavior(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'dependency_behavior must be valid JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'dependency_behavior must be a JSON array' };
  }
  if (parsed.length < MIN_ATTEMPTS) {
    return {
      ok: false,
      reason: 'dependency_behavior must contain at least ' + MIN_ATTEMPTS + ' entries -- a single-entry script can never exercise a genuine retry (the very first call already decides everything)',
    };
  }
  if (parsed.length > MAX_ATTEMPTS_CAP) {
    return { ok: false, reason: 'dependency_behavior exceeds the maximum of ' + MAX_ATTEMPTS_CAP + ' entries for this category' };
  }
  const script = [];
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i] !== 'fail' && parsed[i] !== 'succeed') {
      return { ok: false, reason: 'dependency_behavior[' + i + '] must be exactly the string "fail" or "succeed"' };
    }
    script.push(parsed[i]);
  }
  return { ok: true, script };
}

// ------------------------------------------------------- expected_result ---

/** Validate expected_result's shape. Returns { ok, reason, declared }. */
function validateExpectedResult(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'expected_result must be valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'expected_result must be a JSON object' };
  }
  if (parsed.outcome !== 'success' && parsed.outcome !== 'exhausted') {
    return { ok: false, reason: 'expected_result.outcome must be exactly "success" or "exhausted"' };
  }
  if (!Number.isInteger(parsed.final_attempts) || parsed.final_attempts < 1 || parsed.final_attempts > MAX_ATTEMPTS_CAP) {
    return { ok: false, reason: 'expected_result.final_attempts must be a positive integer (<=' + MAX_ATTEMPTS_CAP + ')' };
  }
  if (!Array.isArray(parsed.delay_sequence)) {
    return { ok: false, reason: 'expected_result.delay_sequence must be a JSON array' };
  }
  const delays = [];
  for (let i = 0; i < parsed.delay_sequence.length; i++) {
    const v = parsed.delay_sequence[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { ok: false, reason: 'expected_result.delay_sequence[' + i + '] must be a non-negative finite number' };
    }
    delays.push(v);
  }
  return { ok: true, declared: { outcome: parsed.outcome, finalAttempts: parsed.final_attempts, delaySequence: delays } };
}

// --------------------------------------------------- independent oracle ---
// See module doc comment (INDEPENDENT ORACLE, WHY THIS CATEGORY'S ORACLE
// SHAPE DIFFERS). One forward state-machine simulation per strategy_type,
// run entirely in this Node process, operating on curator-authored
// strategy_params + dependency_behavior alone. Never sees solution_code;
// never runs in Python.

function numClose(a, b) {
  const diff = Math.abs(a - b);
  return diff < 1e-6 || diff <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
}

/** Shared "consume the next script entry or report why that's impossible"
 * step used by every non-circuit-breaker simulator below. */
function nextScriptOutcome(script, calls) {
  if (calls >= script.length) {
    return { ok: false, reason: 'dependency_behavior has only ' + script.length + ' entries, but strategy_params requires at least ' + (calls + 1) + ' real dependency call(s) to reach a definitive outcome -- lengthen dependency_behavior or reduce max_attempts' };
  }
  return { ok: true, outcome: script[calls] };
}

function simulateFixedDelay(params, script) {
  const delays = [];
  let calls = 0;
  for (let attempt = 1; attempt <= params.max_attempts; attempt++) {
    const next = nextScriptOutcome(script, calls);
    if (!next.ok) return next;
    calls++;
    if (next.outcome === 'succeed') return { ok: true, calls, delays, outcome: 'success' };
    if (calls < params.max_attempts) delays.push(params.delay_seconds);
  }
  return { ok: true, calls, delays, outcome: 'exhausted' };
}

function simulateExponential(params, script, wantRaws) {
  const delays = [];
  const raws = [];
  let calls = 0;
  for (let attempt = 1; attempt <= params.max_attempts; attempt++) {
    const next = nextScriptOutcome(script, calls);
    if (!next.ok) return next;
    calls++;
    if (next.outcome === 'succeed') return { ok: true, calls, delays, raws, outcome: 'success' };
    if (calls < params.max_attempts) {
      const n = calls; // 1-indexed count of consecutive real failures so far
      const raw = Math.min(params.base_delay_seconds * Math.pow(params.multiplier, n - 1), params.max_delay_seconds);
      raws.push(raw);
      if (!wantRaws) delays.push(raw);
    }
  }
  return { ok: true, calls, delays, raws, outcome: 'exhausted' };
}

function simulateJitter(params, script) {
  const sim = simulateExponential(params, script, true);
  if (!sim.ok) return sim;
  const bounds = sim.raws.map((raw) => ({ lo: raw * (1 - params.jitter_ratio), hi: raw * (1 + params.jitter_ratio) }));
  return { ok: true, calls: sim.calls, delays: sim.raws, bounds, outcome: sim.outcome };
}

function simulateCircuitBreaker(params, script) {
  const delays = [];
  let calls = 0;
  let state = 'closed';
  let failCount = 0;
  let openedAtLeastOnce = false;
  const MAX_ITER = params.max_attempts * 2 + 10; // safety bound against an oracle bug looping forever -- never reached by any valid input.
  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (state === 'closed' || state === 'half_open') {
      if (calls >= params.max_attempts) return { ok: true, calls, delays, outcome: 'exhausted', openedAtLeastOnce };
      const next = nextScriptOutcome(script, calls);
      if (!next.ok) return next;
      calls++;
      if (next.outcome === 'succeed') return { ok: true, calls, delays, outcome: 'success', openedAtLeastOnce };
      if (state === 'closed') {
        failCount++;
        if (failCount >= params.failure_threshold) { state = 'open'; openedAtLeastOnce = true; }
      } else {
        state = 'open';
        openedAtLeastOnce = true;
      }
      continue;
    }
    // state === 'open'
    if (calls >= params.max_attempts) return { ok: true, calls, delays, outcome: 'exhausted', openedAtLeastOnce };
    delays.push(params.reset_timeout_seconds);
    state = 'half_open';
  }
  return { ok: false, reason: 'harness oracle exceeded its own safety iteration bound -- this indicates a harness bug, not a row defect' };
}

/** Runs the reference oracle for strategyType, THEN enforces the
 * strategy-agnostic "no unreachable trailing entries" consistency rule (see
 * dependency_behavior's own help text) uniformly across all four. Returns
 * { ok, reason, calls, delays, bounds?, outcome, openedAtLeastOnce? }. */
function simulateStrategy(strategyType, params, script) {
  let sim;
  if (strategyType === 'fixed_delay') sim = simulateFixedDelay(params, script);
  else if (strategyType === 'exponential_backoff') sim = simulateExponential(params, script, false);
  else if (strategyType === 'exponential_backoff_with_jitter') sim = simulateJitter(params, script);
  else sim = simulateCircuitBreaker(params, script);

  if (!sim.ok) return sim;
  if (sim.calls !== script.length) {
    return {
      ok: false,
      reason: 'dependency_behavior has ' + script.length + ' entries, but a correct implementation of this row\'s own declared strategy_type/strategy_params would only ever make ' + sim.calls + ' real dependency call(s) before reaching outcome "' + sim.outcome + '" -- ' + (script.length - sim.calls) + ' trailing entry(ies) could never be reached by any correct implementation',
    };
  }
  return sim;
}

/** Cross-check expected_result's own declared values against the
 * independent oracle. Returns { ok, reason }. */
function crossCheckOracle(strategyType, declared, trace) {
  if (declared.outcome !== trace.outcome) {
    return { ok: false, reason: 'expected_result.outcome declares "' + declared.outcome + '" but this row\'s own strategy_type/strategy_params/dependency_behavior independently compute outcome "' + trace.outcome + '"' };
  }
  if (declared.finalAttempts !== trace.calls) {
    return { ok: false, reason: 'expected_result.final_attempts declares ' + declared.finalAttempts + ' but the independent oracle computes ' + trace.calls + ' real dependency call(s)' };
  }
  const expectedDelays = trace.delays;
  if (declared.delaySequence.length !== expectedDelays.length) {
    return { ok: false, reason: 'expected_result.delay_sequence has ' + declared.delaySequence.length + ' entries but the independent oracle computes ' + expectedDelays.length };
  }
  for (let i = 0; i < expectedDelays.length; i++) {
    if (!numClose(declared.delaySequence[i], expectedDelays[i])) {
      return { ok: false, reason: 'expected_result.delay_sequence[' + i + '] declares ' + declared.delaySequence[i] + ' but the independent oracle computes ' + expectedDelays[i] + (strategyType === 'exponential_backoff_with_jitter' ? ' (the RAW, pre-jitter center value -- see expected_result\'s own help text)' : '') };
    }
  }
  return { ok: true };
}

/** ANTI-HARDCODING GATE, circuit_breaker ONLY -- see dependency_behavior's
 * own help text and module doc comment (CIRCUIT_BREAKER STATE-MACHINE
 * VERIFICATION). Kept as its own distinctly-tagged gate (reason
 * 'circuit_never_opened'), separate from oracle_mismatch, because it is not
 * about expected_result disagreeing with the oracle -- a row can be fully
 * SELF-CONSISTENT (expected_result matches the oracle exactly) and still be
 * a degenerate row that never exercises this strategy_type's own defining
 * behavior at all. */
function checkCircuitOpensAtLeastOnce(strategyType, trace) {
  if (strategyType !== 'circuit_breaker') return { ok: true };
  if (!trace.openedAtLeastOnce) {
    return {
      ok: false,
      reason: 'this circuit_breaker row never actually trips the circuit open (dependency_behavior never accumulates strategy_params.failure_threshold consecutive real failures while closed) -- a row that never exercises the open state tests nothing this strategy_type doesn\'t already share with plain sequential retrying',
    };
  }
  return { ok: true };
}

// --------------------------------------------- clock-injection gate 1 ---
// Static, pre-execution -- reused verbatim from rate_limiting_policy_
// simulation/caching_strategy's own FORBIDDEN_CLOCK_PATTERNS/
// findForbiddenClockUsage. See module doc comment (REAL-CLOCK-INJECTION
// ENFORCEMENT). Deliberately a plain substring/regex scan of the WHOLE
// source text, including comments/docstrings -- the safe failure mode here
// is an over-cautious reject, never a bypass, matching this registry's
// stated design preference.
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
  { re: /\btime\s*\.\s*sleep\s*\(/, reason: 'calls time.sleep() -- this category never uses real sleeping; use the harness-injected sleep(seconds) argument instead, which the harness intercepts and never actually blocks' },
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
 * The Python driver -- see module doc comment (WHY THIS CALLING CONVENTION,
 * REAL-CLOCK-INJECTION ENFORCEMENT layer 2). scriptForPython carries ONLY
 * the ordered 'fail'/'succeed' entries -- expected_result is never threaded
 * in here; the caller (verify() below) never even builds a combined object
 * that contains both.
 */
function buildDriverScript(pyPrelude, solutionCode, scriptForPython, mark) {
  return [
    'import sys, os, json',
    '',
    pyPrelude,
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark),
    '    SOLUTION_SRC = ' + pyStr(solutionCode),
    '    SCRIPT = json.loads(' + pyStr(JSON.stringify(scriptForPython)) + ')',
    '    SUCCESS_MARKER = MARK + "_OK"',
    '    _real_write = os.write',
    '    result = {"stage": "started", "calls": 0, "delays": []}',
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
    '                "retry_call must decide every delay using ONLY the injected " +',
    '                "sleep(seconds) argument, never a real wall-clock/monotonic read " +',
    '                "or a real time.sleep()."',
    '            )',
    '    sys.modules["time"] = _BlockedClockModule("time")',
    '    sys.modules["datetime"] = _BlockedClockModule("datetime")',
    '    sys.modules["calendar"] = _BlockedClockModule("calendar")',
    '',
    '    state = {"idx": 0}',
    '',
    '    def _dependency():',
    '        i = state["idx"]',
    '        outcome = SCRIPT[i] if i < len(SCRIPT) else "fail"  # script exhausted -- see solution_code\'s own help text: keep simulating failure forever rather than raising a special sentinel, so an over-retrying submission is caught by a plain call-count mismatch, not a distinct code path.',
    '        state["idx"] = i + 1',
    '        result["calls"] = state["idx"]',
    '        _emit()  # checkpoint after EVERY real call -- see module doc comment (TIMEOUT BUDGET).',
    '        if outcome == "succeed":',
    '            return SUCCESS_MARKER',
    '        raise RuntimeError("simulated dependency failure (call #%d)" % state["idx"])',
    '',
    '    def _sleep(seconds):',
    '        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):',
    '            raise TypeError("sleep() must be called with a real number of seconds, got %r" % (seconds,))',
    '        if seconds != seconds or seconds < 0 or seconds == float("inf"):',
    '            raise ValueError("sleep() must be called with a non-negative, finite number of seconds, got %r" % (seconds,))',
    '        result["delays"].append(seconds)',
    '        _emit()  # checkpoint after EVERY sleep -- see module doc comment (TIMEOUT BUDGET).',
    '',
    '    try:',
    '        ns = {}',
    '        exec(compile(SOLUTION_SRC, "<solution_code>", "exec"), ns)',
    '    except BaseException as e:',
    '        result["stage"] = "load_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    fn = ns.get("retry_call")',
    '    if not callable(fn):',
    '        result["stage"] = "no_retry_call_function"',
    '        _emit(); return',
    '',
    '    result["stage"] = "in_progress"',
    '    _emit()',
    '    try:',
    '        ret = fn(_dependency, _sleep)',
    '    except BaseException as e:',
    '        result["stage"] = "ok"',
    '        result["raised"] = True',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    result["stage"] = "ok"',
    '    result["raised"] = False',
    '    result["returned_matches_marker"] = (ret == SUCCESS_MARKER)',
    '    result["returned_repr"] = repr(ret)[:300]',
    '    _emit()',
    '',
    '_main()',
  ].join('\n');
}

/** See module doc comment (HANDLING exponential_backoff_with_jitter's
 * INHERENT RANDOMNESS). Heuristic, not proof -- documented as such. Returns
 * true iff every one of >=2 jittered delays is bit-exactly its own raw
 * center value. */
function checkSuspectedMissingJitter(actualDelays, rawCenters) {
  if (rawCenters.length < 2) return false;
  return actualDelays.every((d, i) => d === rawCenters[i]);
}

module.exports = {
  contract: 'retry-policy-behavior-match',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const strategyType = h.str(row, 'strategy_type').trim();
    const strategyDescription = h.str(row, 'strategy_description');
    const strategyParamsRaw = h.str(row, 'strategy_params');
    const solutionCode = h.str(row, 'solution_code');
    const dependencyBehaviorRaw = h.str(row, 'dependency_behavior');
    const expectedResultRaw = h.str(row, 'expected_result');

    if (!taskDescription.trim() || !strategyType || !strategyDescription.trim() || !strategyParamsRaw.trim() || !solutionCode.trim() || !dependencyBehaviorRaw.trim() || !expectedResultRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, strategy_type, strategy_description, strategy_params, solution_code, dependency_behavior, or expected_result' } };
    }

    if (!STRATEGY_TYPES.includes(strategyType)) {
      return {
        passed: false,
        logs: 'strategy_type "' + strategyType + '" is not one of the recognized values: ' + STRATEGY_TYPES.join(', '),
        detail: { reason: 'unrecognized_strategy_type' },
      };
    }

    const paramsCheck = validateStrategyParams(strategyParamsRaw, strategyType);
    if (!paramsCheck.ok) {
      return { passed: false, logs: paramsCheck.reason, detail: { reason: 'bad_strategy_params' } };
    }
    const params = paramsCheck.params;

    const behaviorCheck = validateDependencyBehavior(dependencyBehaviorRaw);
    if (!behaviorCheck.ok) {
      return { passed: false, logs: behaviorCheck.reason, detail: { reason: 'bad_dependency_behavior' } };
    }
    const script = behaviorCheck.script;

    const expectedCheck = validateExpectedResult(expectedResultRaw);
    if (!expectedCheck.ok) {
      return { passed: false, logs: expectedCheck.reason, detail: { reason: 'bad_expected_result' } };
    }
    const declared = expectedCheck.declared;

    // INDEPENDENT ORACLE -- see module doc comment. Runs entirely in this
    // Node process, before solution_code (or python3's own availability) is
    // ever considered.
    const trace = simulateStrategy(strategyType, params, script);
    if (!trace.ok) {
      return { passed: false, logs: trace.reason, detail: { reason: 'bad_dependency_behavior' } };
    }

    const circuitCheck = checkCircuitOpensAtLeastOnce(strategyType, trace);
    if (!circuitCheck.ok) {
      return { passed: false, logs: circuitCheck.reason, detail: { reason: 'circuit_never_opened' } };
    }

    const oracleCheck = crossCheckOracle(strategyType, declared, trace);
    if (!oracleCheck.ok) {
      return {
        passed: false,
        logs: oracleCheck.reason + ' -- dataset-authoring defect, rejected before solution_code is ever run',
        detail: { reason: 'oracle_mismatch' },
      };
    }

    // solution_code's own static clock-usage gate -- see module doc comment
    // (REAL-CLOCK-INJECTION ENFORCEMENT, layer 1).
    const forbidden = findForbiddenClockUsage(solutionCode);
    if (forbidden) {
      return {
        passed: false,
        logs: 'solution_code ' + forbidden + ' -- forbidden for this category: retry_call must decide every delay using ONLY the injected sleep(seconds) argument, never a real clock read or a real sleep',
        detail: { reason: 'forbidden_clock_usage', matched: forbidden },
      };
    }
    if (!/\bdef\s+retry_call\s*\(/.test(solutionCode)) {
      return {
        passed: false,
        logs: 'solution_code must define a top-level function named exactly retry_call (e.g. def retry_call(dependency, sleep):)',
        detail: { reason: 'no_retry_call_function' },
      };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    const d = h.workdir();
    const mark = '@@RETRYROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script2 = buildDriverScript(h.PY_PRELUDE, solutionCode, script, mark);
    const scriptPath = h.path.join(d, 'run_retry.py');
    h.fs.writeFileSync(scriptPath, script2);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: up to
    // MAX_ATTEMPTS_CAP*2 checkpoint lines could exceed the report-bounding
    // cap before the trailing "ok" marker line is reached.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }

    if (!out || typeof out !== 'object' || !out.stage) {
      return {
        passed: false,
        logs: r.timedOut
          ? ('solution_code did not complete its retry_call() within the ' + TIMEOUT_MS + 'ms budget -- for work this small (at most ' + MAX_ATTEMPTS_CAP + ' plain function calls), this is itself a real failure (most likely a runaway retry loop that never honors max_attempts), not an infra problem')
          : ('could not parse verification output: ' + String(r.stderr || '').slice(0, 500)),
        detail: { reason: 'unparseable_output', timedOut: !!r.timedOut },
      };
    }

    if (out.stage === 'load_failed') {
      return { passed: false, logs: 'solution_code failed to load: ' + String(out.error || '').slice(0, 800), detail: { reason: 'load_failed' } };
    }
    if (out.stage === 'no_retry_call_function') {
      return { passed: false, logs: 'solution_code does not define a top-level retry_call function after exec', detail: { reason: 'no_retry_call_function' } };
    }
    if (out.stage !== 'ok') {
      return { passed: false, logs: 'verification did not complete (stage=' + String(out.stage) + ')', detail: { reason: 'incomplete', stage: out.stage } };
    }

    const actualCalls = typeof out.calls === 'number' ? out.calls : 0;
    const actualDelays = Array.isArray(out.delays) ? out.delays : [];

    if (actualCalls !== trace.calls) {
      return {
        passed: false,
        logs: 'expected exactly ' + trace.calls + ' real dependency call(s), but retry_call made ' + actualCalls + ' -- ' + (actualCalls > trace.calls ? 'solution_code kept calling the dependency past where a correct implementation would have stopped (ignoring max_attempts, or calling through while the circuit should be open/skipping)' : 'solution_code gave up before making every call a correct implementation would have made'),
        detail: { reason: 'call_count_mismatch', expected: trace.calls, actual: actualCalls },
      };
    }

    const expectedDelayCount = strategyType === 'exponential_backoff_with_jitter' ? trace.bounds.length : trace.delays.length;
    if (actualDelays.length !== expectedDelayCount) {
      return {
        passed: false,
        logs: 'expected exactly ' + expectedDelayCount + ' sleep() call(s), but retry_call made ' + actualDelays.length,
        detail: { reason: 'delay_count_mismatch', expected: expectedDelayCount, actual: actualDelays.length },
      };
    }

    if (strategyType === 'exponential_backoff_with_jitter') {
      for (let i = 0; i < trace.bounds.length; i++) {
        const v = actualDelays[i];
        const b = trace.bounds[i];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < b.lo - 1e-9 || v > b.hi + 1e-9) {
          return {
            passed: false,
            logs: 'delay #' + (i + 1) + ' (' + v + ') falls outside the required jitter band [' + b.lo + ', ' + b.hi + '] (raw center ' + trace.delays[i] + ' +/- jitter_ratio)',
            detail: { reason: 'delay_out_of_bounds', index: i, actual: v, lo: b.lo, hi: b.hi },
          };
        }
      }
      if (checkSuspectedMissingJitter(actualDelays, trace.delays)) {
        return {
          passed: false,
          logs: 'every requested delay exactly equals its own unjittered raw center value -- solution_code appears to ignore jitter_ratio entirely rather than genuinely randomizing within the required band (see harness.js\'s own module doc comment on this heuristic)',
          detail: { reason: 'suspected_missing_jitter' },
        };
      }
    } else {
      for (let i = 0; i < trace.delays.length; i++) {
        if (!numClose(actualDelays[i], trace.delays[i])) {
          return {
            passed: false,
            logs: 'delay #' + (i + 1) + ' expected ' + trace.delays[i] + ' but retry_call requested ' + actualDelays[i],
            detail: { reason: 'delay_mismatch', index: i, expected: trace.delays[i], actual: actualDelays[i] },
          };
        }
      }
    }

    const actualOutcome = out.raised ? 'exhausted' : 'success';
    if (actualOutcome !== trace.outcome) {
      return {
        passed: false,
        logs: 'expected outcome "' + trace.outcome + '" but retry_call ' + (out.raised ? ('raised: ' + String(out.error || '').slice(0, 300)) : 'returned normally instead of raising'),
        detail: { reason: 'outcome_mismatch', expected: trace.outcome, actual: actualOutcome },
      };
    }
    if (actualOutcome === 'success' && !out.returned_matches_marker) {
      return {
        passed: false,
        logs: 'retry_call returned normally but its return value (' + String(out.returned_repr || '').slice(0, 200) + ') is not the exact value the dependency itself returned on success -- solution_code must propagate the dependency\'s own successful result, never fabricate a substitute',
        detail: { reason: 'returned_value_mismatch' },
      };
    }

    return {
      passed: true,
      score: 1,
      detail: { reason: 'ok', callsChecked: trace.calls, delaysChecked: actualDelays.length, strategyType },
    };
  },
};
