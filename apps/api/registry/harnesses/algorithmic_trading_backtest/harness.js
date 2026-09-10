/**
 * synthetic-backtest-metrics-match -- algorithmic_trading_backtest.
 *
 * THE CONTRACT: strategy_code (real, contributor-controlled Python) defines
 * exactly one top-level class `Strategy`, with a no-argument constructor and
 * a method `decide(self, price_history, portfolio)`. The harness (never
 * strategy_code) owns and drives the ENTIRE walk-forward backtest event
 * loop: it generates a synthetic price path from market_params' own pinned
 * Geometric Brownian Motion formula (see PRICE PATH FORMULA below), then
 * calls decide() once per bar, in order, handing it ONLY price_history[0..i]
 * (today's price and every prior bar -- never a future one) plus the real
 * portfolio state before today's trade. decide() returns a single float in
 * [0.0, 1.0], the TARGET FRACTION of total equity to hold in the asset after
 * today's trade; the harness itself executes the resulting rebalance and
 * builds the REAL equity curve from REAL portfolio state after every bar.
 * From that real curve, the harness independently computes Sharpe ratio,
 * Sortino ratio, max drawdown, CAGR, and Calmar ratio using its own
 * from-scratch formula implementation (see METRICS FORMULAS below) and
 * cross-checks them against the curator's own declared expected_metrics,
 * per seed, within a curator-declared tolerance -- strategy_code itself
 * never computes, sees, or reports a single metric; it only ever returns a
 * target weight, once per bar.
 *
 * WHY THIS CALLING CONVENTION (harness owns the loop, injects only
 * past-and-current data, exactly mirroring retry_backoff_resilience's own
 * dependency()/sleep() injection and rate_limiting_policy_simulation's own
 * check(key, timestamp) injection): the single most important property this
 * category must guarantee is that strategy_code is ARCHITECTURALLY INCAPABLE
 * of seeing a future bar -- lookahead bias is the single most commonly
 * documented real-world failure mode in bad backtests, and the only fix that
 * actually closes it is architectural (never hand the strategy the whole
 * price array), not a text-scan-based gate (which a submission could always
 * route around via an alternate spelling, an indirect import, or simply
 * encoding the same lookahead differently). Returning a TARGET WEIGHT rather
 * than a raw buy/sell/hold action or a raw share count was a deliberate,
 * considered choice among the options the task brief itself raised: a
 * target-weight-in-[0,1] contract needs no commission/slippage model, no
 * partial-fill semantics, and no insufficient-cash edge case (see EQUITY
 * ALWAYS STAYS POSITIVE below) -- it is "simple, hard to misuse", the same
 * design bar this registry already holds retry_call/RateLimiter.check/
 * Cache.get-put to.
 *
 * WHY TWO SEPARATE OS PROCESSES (driver + runner), NOT ONE -- THE CENTRAL
 * SECURITY DESIGN DECISION FOR THIS CATEGORY, AND WHY A THREAD SPLIT WOULD
 * NOT HAVE BEEN ENOUGH: the price path for every declared seed must be known
 * BEFORE the bar-by-bar loop starts generating it in order, and something
 * has to hold that (still partially "future", from decide()'s point of view)
 * data in memory while driving the loop. If the SAME Python process that
 * holds those future prices as a local variable ALSO exec()'d strategy_code
 * and called decide() directly, strategy_code could reach them anyway via
 * `sys._getframe(1).f_locals` (decide() is invoked directly by whatever
 * frame owns the price array, so that frame is decide()'s own immediate
 * caller) -- this is the EXACT leak class schema_conformance_validation's
 * own module doc comment documents finding and closing for its own
 * single-process draft. A tempting cheaper fix would be to keep everything
 * in one process but run strategy_code on a separate THREAD instead of a
 * separate PROCESS (avoiding subprocess/pipe overhead) -- this was
 * considered and REJECTED as insufficient: `sys._getframe()` only walks the
 * CALLING thread's own stack, but CPython's stdlib also exposes
 * `sys._current_frames()`, an explicitly documented (if debugging-oriented)
 * function returning the topmost frame of EVERY thread currently running in
 * the process -- since threads share one address space completely, code
 * running on a worker thread can use `sys._current_frames()` to walk into
 * the driver thread's own frames and reach the same future-price array a
 * thread split was supposed to hide. Only a genuine, separate OS PROCESS
 * (a fully disjoint address space, per the OS's own memory-protection
 * guarantees) closes this: the runner process that exec()s strategy_code
 * and calls decide() NEVER receives anything beyond price_history[0..i] for
 * whichever bar it is currently being asked to decide -- the future prices
 * simply do not exist anywhere in that process's memory, at any point in
 * time, for any introspection mechanism (short of a raw cross-process memory
 * read via ctypes/ptrace, the same documented, accepted, exotic-attack
 * residual tier already carried by PY_PRELUDE's own ctypes-raw-syscall-exit
 * residual in helpers.js) to ever find.
 *
 * THE RUNNER PROTOCOL: one long-lived runner subprocess per row (not one per
 * bar or per seed -- respawning a fresh interpreter per bar would be far
 * slower for no security benefit, since the security property comes from
 * WHICH process ever sees the future, not from how often a process is
 * spawned), speaking a strict line-delimited JSON protocol over its own
 * stdin/stdout: {"cmd":"start"} (construct a fresh Strategy() for the next
 * seed), {"cmd":"decide","price_history":[...],"portfolio":{...}} (call
 * decide(), return {"ok":true,"target_weight":w} or {"ok":false,"error":...}
 * if it raised), {"cmd":"end"}, {"cmd":"shutdown"}. STDOUT HYGIENE, A REAL
 * BUG CAUGHT DURING DESIGN, NOT JUST A RESIDUAL: strategy_code's own
 * decide()/__init__() could call a bare print() for debugging, which by
 * default writes to the SAME fd 1 this protocol's response lines travel
 * over -- interleaved with a genuine protocol line, this would desynchronize
 * the driver's readline()-based parsing for the REST of that seed's backtest
 * (every subsequent read would consume the wrong line). Fixed structurally,
 * not by asking contributors not to print(): runner.py reassigns the
 * `sys.stdout` PYTHON OBJECT to a no-op sink BEFORE strategy_code is ever
 * exec()'d, while every one of the runner's own protocol responses is
 * written via `os.write(1, ...)` directly (bypassing `sys.stdout` entirely,
 * the identical `_real_write = os.write` technique retry_backoff_resilience/
 * rate_limiting_policy_simulation already use for their own single-line
 * emits) -- so strategy_code's own stdout is unconditionally neutralized
 * while the runner's own responses are entirely unaffected. The runner's
 * stderr is redirected to DEVNULL for the same reason from the other
 * direction: leaving it as an unread PIPE risks a full OS pipe buffer
 * blocking the runner process the moment a verbose (or merely buggy, e.g. a
 * warnings-emitting) strategy writes enough to it, hanging the whole
 * backtest until TIMEOUT_MS.
 *
 * PRICE PATH FORMULA -- GEOMETRIC BROWNIAN MOTION, PINNED EXACTLY: price[0] =
 * initial_price; for i = 1..num_bars, price[i] = price[i-1] *
 * exp((drift - 0.5*volatility^2) + volatility*Z_i), Z_i ~ Python stdlib
 * `random.gauss(0.0, 1.0)`, drawn in order immediately after `random.seed
 * (seed)` is called once at the start of that seed's own path generation.
 * GBM (not a plain arithmetic random walk) was chosen for two concrete
 * reasons: (1) it is the standard, textbook-documented model for a
 * synthetic asset price with no real embedded edge, so a curator authoring
 * drift/volatility in the units this schema declares (per-bar log-return
 * mean/stdev) is working from a well-known, unambiguous convention rather
 * than an ad hoc one; (2) it structurally GUARANTEES price stays strictly
 * positive for every finite draw (exp() of anything finite is always > 0),
 * which combined with this category's own long-only, no-leverage [0,1]
 * target-weight contract PROVES equity_curve never touches zero or goes
 * negative either -- see EQUITY ALWAYS STAYS POSITIVE below -- removing an
 * entire class of "what does CAGR even mean for a bankrupt account" special
 * casing an arithmetic random walk (which CAN go negative) would otherwise
 * force.
 *
 * WHY THE PRICE PATH IS GENERATED IN A SEPARATE (driver) PYTHON PROCESS FROM
 * strategy_code, YET STILL GUARANTEED BYTE-IDENTICAL TO WHAT A CURATOR
 * COMPUTES LOCALLY: the task brief's own research flagged a real risk --
 * cross-LANGUAGE RNG/float mismatches (e.g. generating in this harness's own
 * Node.js process and running strategy_code in Python) -- and suggested
 * generating the path in the SAME process that runs strategy_code as the
 * safest fix. This harness's own two-process security requirement (above)
 * means the price path is generated in the DRIVER process while strategy_code
 * runs in a separate RUNNER process -- but the reproducibility property the
 * task brief was actually protecting (curator and harness see byte-identical
 * paths) survives fully intact: both the driver here and a curator's own
 * local verification script are genuine CPython processes executing the
 * IDENTICAL pinned algorithm (`random.seed(seed)` then `random.gauss(0.0,
 * 1.0)` num_bars times) -- the risk the task brief was flagging was ONLY
 * ever about crossing LANGUAGES (Node's own RNG/float semantics differing
 * from Python's), never about which of two same-language OS processes does
 * the computing. Generating in the driver rather than literally inside the
 * runner is therefore a refinement, not a compromise: it keeps the
 * reproducibility guarantee the task asked for while also closing the
 * frame-leak vulnerability a literal single-process reading of that
 * suggestion would have reopened.
 *
 * EQUITY ALWAYS STAYS POSITIVE -- A PROVABLE PROPERTY OF THE [0,1] TARGET-
 * WEIGHT CONTRACT, NOT AN ASSUMPTION: rebalancing to target_weight w in
 * [0,1] every bar is frictionless (cash_new = equity_before*(1-w),
 * position_new*price = equity_before*w), so equity_after == equity_before
 * EXACTLY every single bar (a pure reallocation creates or destroys no
 * value) -- equity only ever changes BETWEEN bars, via price movement on
 * whatever position is held, and since position_new*price_i <=
 * equity_before(bar i) always (no leverage) and price_{i+1} > 0 always (GBM
 * is strictly positive), equity_before(bar i+1) >= equity_after(bar i)*(1 -
 * f) for the fractional price move f < 1 -- equity can shrink but never
 * reach zero or go negative. This means CAGR's final/initial ratio is always
 * well-defined without any bankruptcy/negative-equity special-casing this
 * harness would otherwise need.
 *
 * NO INDEPENDENT ORACLE FOR STRATEGY LOGIC ITSELF -- THE SAME DELIBERATE,
 * REASONED DECISION numerical_precision's OWN MODULE DOC COMMENT ALREADY
 * MAKES, APPLIED HERE: unlike rate_limiting_policy_simulation/caching_
 * strategy (a small, closed, named set of policies this harness can
 * implement once and cross-check ANY row against), a trading strategy's own
 * decision logic is open-ended and arbitrary -- "a moving-average crossover
 * strategy" and "a mean-reversion strategy" are not two branches of one
 * finite enumeration the way fixed_window/token_bucket/etc are. There is
 * therefore no way to independently derive what a GENUINELY NOVEL strategy
 * should decide at any given bar, and this harness does not attempt to.
 * task_description is explicitly flavor text for this reason (see
 * schema.json's own help text) -- ground truth for a given row is
 * expected_metrics, curator-authored by ACTUALLY RUNNING that row's own
 * strategy_code (the same "curator must genuinely verify their own row"
 * discipline numerical_precision/retry_backoff_resilience already
 * established), not independently re-derivable from prose.
 *
 * ...BUT A GENUINE, REAL, POST-EXECUTION INDEPENDENT ORACLE FOR THE METRICS
 * FORMULAS THEMSELVES: unlike the strategy's own logic, Sharpe/Sortino/max
 * drawdown/CAGR/Calmar ARE a small, fixed, universally-defined set of
 * formulas over an equity curve -- this harness implements every one of them
 * from scratch (see _compute_metrics in buildDriverScript below) and applies
 * them to the REAL equity curve the REAL strategy_code produces when driven
 * for real against the REAL seeded price path, in the driver process, which
 * never once exec()s strategy_code itself (so there is no shared-frame risk
 * for this computation either -- the SAME two-process separation that
 * protects the price path also means the metrics oracle needs no further
 * isolation of its own). strategy_code has no channel to report a number of
 * any kind -- it returns a target_weight, nothing else -- so "never trust
 * the contributor's own printed verdict, independently recompute from real
 * observed state" (this registry's own established principle, per redis_
 * data_structure_semantics' second-connection verification and http_api_
 * contract_testing's real response inspection) is satisfied structurally,
 * not by choosing to ignore a self-reported number that was never offered in
 * the first place.
 *
 * METRICS FORMULAS -- EXACTLY PINNED (see schema.json's expected_metrics
 * help text for the identical prose a curator hand-verifies against; kept
 * consistent word-for-word with this file's own implementation):
 *   returns[i] = (equity[i] - equity[i-1]) / equity[i-1], i = 1..num_bars
 *   sharpe  = (mean(returns) / stdev(returns)) * sqrt(252), 0.0 if stdev==0
 *             (statistics.stdev -- SAMPLE stdev, divisor n-1)
 *   sortino = (mean(returns) / downside_dev) * sqrt(252), 0.0 if downside_dev==0
 *             downside_dev = sqrt(mean(min(r,0)^2)) over ALL bars (the "full"
 *             downside-deviation convention, minimum acceptable return = 0)
 *   max_drawdown = min over the whole curve of (equity[i]-running_peak[i])/running_peak[i]
 *                  (non-positive; 0.0 if the curve never fell below its own peak)
 *   cagr = (equity[-1]/equity[0]) ** (252/num_bars) - 1
 *   calmar = cagr / abs(max_drawdown), 0.0 if max_drawdown==0
 * 252 (trading days/year) is a fixed harness constant, uniform across every
 * row -- never curator-configurable, so two different rows' Sharpe/CAGR
 * numbers are always annualized on the same basis.
 *
 * ANTI-OVERFITTING -- MULTI-SEED, MECHANICALLY ENFORCED (>=2 REQUIRED): the
 * task brief's own framing is followed directly here, not reinvented: running
 * against every declared seed and independently cross-checking the curator's
 * OWN per-seed expected_metrics claim against what strategy_code REALLY
 * produces on that REAL, independently-drawn path is this category's primary
 * defense -- it forces the curator to have genuinely run strategy_code
 * against every seed for real (an untruthful or lazily-copied per-seed claim
 * fails the ordinary metric cross-check below), rather than authoring a row
 * against a single, possibly cherry-picked, lucky path. A SEPARATE, STATISTICAL
 * cross-seed-consistency THRESHOLD gate (e.g. rejecting rows whose Sharpe
 * varies too much between seeds) was considered and DELIBERATELY NOT added:
 * genuine, non-curve-fit strategies can legitimately see substantial
 * performance variance across only 2-5 independent 50-500-bar random draws
 * (finite-sample noise on a random walk is real and can be large), so a
 * mechanical variance threshold risks false-rejecting good rows without a
 * reliable way to tell it apart from real curve-fitting from the outside --
 * left as a documented, deliberate scope decision, not an oversight.
 *
 * IMPLAUSIBLE-PERFORMANCE SANITY GATE: since market_params' own price path
 * is, by construction, a pure random walk with no genuine embedded edge, a
 * real, independently-computed Sharpe ratio above IMPLAUSIBLE_SHARPE_
 * THRESHOLD (5.0) on EVERY declared seed SIMULTANEOUSLY is rejected outright
 * (reason 'implausible_sharpe_all_seeds') rather than silently accepted.
 * 5.0 was chosen because even top-tier real-world quantitative strategies
 * rarely sustain an annualized Sharpe above 3-4 over any meaningful sample --
 * consistently clearing 5.0 across MULTIPLE independent random draws that
 * share no real structure is far more likely a lookahead bug that evaded
 * this category's own architectural defenses, or an equity-accounting
 * defect, than genuine skill. Documented as a heuristic threshold, not a
 * mathematical proof, the same tier as this registry's other documented
 * heuristic gates (retry_backoff_resilience's own checkSuspectedMissingJitter
 * is the closest precedent). Requiring ALL seeds to trip it (never just one)
 * is deliberate: a single seed clearing 5.0 by pure luck is unremarkable and
 * must not fail an otherwise-legitimate row.
 *
 * TIMEOUT BUDGET -- SIZED FOR MAX_SEEDS(5) x MAX_BARS(500) = 2500 bar
 * iterations, each a small JSON write+readline round trip over a real local
 * pipe (no network, no disk I/O beyond the two small script files written
 * once up front) -- realistically low hundreds of milliseconds to a few
 * seconds even at the maximum, similar in spirit to algorithmic_complexity_
 * verification's own documented "budget carefully for multi-run-in-one-
 * verify()" discipline. TIMEOUT_MS (45000ms) is sized generously above that
 * realistic cost specifically to tolerate a strategy_code whose own decide()
 * does non-trivial per-bar work (e.g. an O(n) or even a naive O(n^2)
 * recomputation over the whole growing price_history every bar) without
 * being unfairly timed out for legitimate, if inefficient, code -- while
 * still leaving roughly 75000ms of margin under the outer sandbox command
 * budget (120000ms, helpers.js's OUTER_SANDBOX_BUDGET_MS). A genuine timeout
 * at this budget is itself meaningful signal (a pathological per-bar
 * computation, or a strategy that never returns), treated as a real failure,
 * not runtimeUnavailable, matching this registry's established convention.
 *
 * GATE ORDER: field presence -> market_params shape/range/seed-count
 * validation -> expected_metrics shape/seed-coverage/tolerance validation
 * (dataset-authoring-defect rejections, before strategy_code is ever run) ->
 * strategy_code's own static `class Strategy`/`def decide(` structural check
 * -> h.have('python3') -> spawn the runner subprocess -> spawn/drive the
 * driver subprocess (which itself drives the runner) -> per-seed execution-
 * failure check -> IMPLAUSIBLE-PERFORMANCE sanity gate (checked against REAL
 * computed metrics) -> per-seed, per-metric cross-check against the
 * curator's own declared expected_metrics within tolerance.
 */
'use strict';

const crypto = require('crypto');

const MIN_SEEDS = 2;
const MAX_SEEDS = 5;
const MAX_SEED_VALUE = 2147483647; // 2**31 - 1
const MAX_DRIFT_ABS = 0.01; // per-bar expected log-return
const MAX_VOLATILITY = 0.05; // per-bar log-return standard deviation
const MIN_BARS = 50;
const MAX_BARS = 500;
const MAX_INITIAL_PRICE = 1000000;
const INITIAL_CAPITAL = 100000.0; // fixed harness constant, identical for every row/seed
const PERIODS_PER_YEAR = 252; // fixed annualization constant -- see module doc comment
const IMPLAUSIBLE_SHARPE_THRESHOLD = 5.0;
const TIMEOUT_MS = 45000;

const METRIC_KEYS = ['sharpe', 'sortino', 'max_drawdown', 'cagr', 'calmar'];
// Sanity bounds on the CURATOR'S OWN CLAIMED values -- generous, only to
// reject obvious garbage/DoS-sized numbers before any execution happens.
// Plausibility of the REAL computed values is instead handled by the
// IMPLAUSIBLE-PERFORMANCE sanity gate below, post-execution.
const METRIC_BOUNDS = {
  sharpe: [-50, 50],
  sortino: [-50, 50],
  max_drawdown: [-1, 0],
  cagr: [-1, 100],
  calmar: [-1000, 1000],
};
const TOLERANCE_BOUNDS = { sharpe: [0, 5], sortino: [0, 5], max_drawdown: [0, 5], cagr: [0, 5], calmar: [0, 5] };

// ------------------------------------------------------- market_params ---

/** Validate market_params' shape/ranges. Returns { ok, reason, params }.
 * params: { seeds: number[], drift, volatility, numBars, initialPrice }. */
function validateMarketParams(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'market_params must be valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'market_params must be a JSON object' };
  }

  if (!Array.isArray(parsed.seeds)) {
    return { ok: false, reason: 'market_params.seeds must be a JSON array of integers' };
  }
  if (parsed.seeds.length < MIN_SEEDS) {
    return {
      ok: false,
      reason: 'market_params.seeds must contain at least ' + MIN_SEEDS + ' distinct seeds -- a single-seed row cannot demonstrate the strategy generalizes beyond one specific price path (this category\'s primary anti-overfitting mechanism)',
    };
  }
  if (parsed.seeds.length > MAX_SEEDS) {
    return { ok: false, reason: 'market_params.seeds exceeds the maximum of ' + MAX_SEEDS + ' seeds for this category' };
  }
  const seeds = [];
  const seenSeeds = new Set();
  for (let i = 0; i < parsed.seeds.length; i++) {
    const s = parsed.seeds[i];
    if (!Number.isInteger(s) || s < 0 || s > MAX_SEED_VALUE) {
      return { ok: false, reason: 'market_params.seeds[' + i + '] must be an integer between 0 and ' + MAX_SEED_VALUE };
    }
    if (seenSeeds.has(s)) {
      return { ok: false, reason: 'market_params.seeds contains duplicate seed ' + s + ' -- every seed must be genuinely distinct' };
    }
    seenSeeds.add(s);
    seeds.push(s);
  }

  const drift = parsed.drift;
  if (typeof drift !== 'number' || !Number.isFinite(drift) || drift < -MAX_DRIFT_ABS || drift > MAX_DRIFT_ABS) {
    return { ok: false, reason: 'market_params.drift must be a finite number between -' + MAX_DRIFT_ABS + ' and ' + MAX_DRIFT_ABS + ' (per-bar expected log-return)' };
  }
  const volatility = parsed.volatility;
  if (typeof volatility !== 'number' || !Number.isFinite(volatility) || volatility <= 0 || volatility > MAX_VOLATILITY) {
    return { ok: false, reason: 'market_params.volatility must be a finite number greater than 0 and at most ' + MAX_VOLATILITY + ' (per-bar log-return standard deviation)' };
  }
  const numBars = parsed.num_bars;
  if (!Number.isInteger(numBars) || numBars < MIN_BARS || numBars > MAX_BARS) {
    return { ok: false, reason: 'market_params.num_bars must be an integer between ' + MIN_BARS + ' and ' + MAX_BARS };
  }
  const initialPrice = parsed.initial_price;
  if (typeof initialPrice !== 'number' || !Number.isFinite(initialPrice) || initialPrice <= 0 || initialPrice > MAX_INITIAL_PRICE) {
    return { ok: false, reason: 'market_params.initial_price must be a finite number greater than 0 and at most ' + MAX_INITIAL_PRICE };
  }

  return { ok: true, params: { seeds, drift, volatility, numBars, initialPrice } };
}

// ----------------------------------------------------- expected_metrics ---

/** Validate expected_metrics' shape against the already-validated seed list.
 * Returns { ok, reason, tolerance, bySeed }. bySeed: Map<seed, {metric:val}>. */
function validateExpectedMetrics(raw, seeds) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'expected_metrics must be valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'expected_metrics must be a JSON object' };
  }

  if (!parsed.tolerance || typeof parsed.tolerance !== 'object' || Array.isArray(parsed.tolerance)) {
    return { ok: false, reason: 'expected_metrics.tolerance must be a JSON object' };
  }
  const tolerance = {};
  for (const k of METRIC_KEYS) {
    const v = parsed.tolerance[k];
    const bounds = TOLERANCE_BOUNDS[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= bounds[0] || v > bounds[1]) {
      return { ok: false, reason: 'expected_metrics.tolerance.' + k + ' must be a finite number greater than 0 and at most ' + bounds[1] };
    }
    tolerance[k] = v;
  }

  if (!Array.isArray(parsed.per_seed)) {
    return { ok: false, reason: 'expected_metrics.per_seed must be a JSON array' };
  }
  if (parsed.per_seed.length !== seeds.length) {
    return {
      ok: false,
      reason: 'expected_metrics.per_seed has ' + parsed.per_seed.length + ' entries but market_params.seeds declares ' + seeds.length + ' -- must be exactly one entry per declared seed',
    };
  }
  const seedSet = new Set(seeds);
  const bySeed = new Map();
  for (let i = 0; i < parsed.per_seed.length; i++) {
    const entry = parsed.per_seed[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: 'expected_metrics.per_seed[' + i + '] must be a JSON object' };
    }
    if (!Number.isInteger(entry.seed) || !seedSet.has(entry.seed)) {
      return { ok: false, reason: 'expected_metrics.per_seed[' + i + '].seed (' + JSON.stringify(entry.seed) + ') is not one of market_params.seeds' };
    }
    if (bySeed.has(entry.seed)) {
      return { ok: false, reason: 'expected_metrics.per_seed contains a duplicate entry for seed ' + entry.seed };
    }
    const vals = {};
    for (const k of METRIC_KEYS) {
      const v = entry[k];
      const bounds = METRIC_BOUNDS[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < bounds[0] || v > bounds[1]) {
        return { ok: false, reason: 'expected_metrics.per_seed[' + i + '].' + k + ' must be a finite number between ' + bounds[0] + ' and ' + bounds[1] };
      }
      vals[k] = v;
    }
    bySeed.set(entry.seed, vals);
  }

  return { ok: true, tolerance, bySeed };
}

// -------------------------------------------------------- python driver ---

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/**
 * The runner subprocess -- see module doc comment (WHY TWO SEPARATE OS
 * PROCESSES, THE RUNNER PROTOCOL). NEVER templated with row-specific price
 * data -- only h.PY_PRELUDE (a fixed constant) is baked in. Receives
 * strategy_code's own source via argv[1] (a file path -- source code is not
 * a secret, only future prices are), and speaks a strict line-delimited JSON
 * protocol over its own real stdin/stdout thereafter.
 */
function buildRunnerScript(pyPrelude) {
  return [
    'import sys, os, json',
    '',
    '# STDOUT HYGIENE -- see module doc comment. Neutralize the sys.stdout',
    '# PYTHON OBJECT (not fd 1 itself) before strategy_code is ever exec\'d:',
    '# every real protocol response below is written via os.write(1, ...)',
    '# directly, bypassing this object entirely, so this can only ever',
    '# silence strategy_code\'s own accidental/debugging print() calls, never',
    '# the runner\'s own real responses.',
    'class _SinkIO(object):',
    '    def write(self, s):',
    '        return len(s) if isinstance(s, str) else 0',
    '    def flush(self):',
    '        pass',
    'sys.stdout = _SinkIO()',
    '',
    pyPrelude,
    '',
    '_real_write = os.write',
    '',
    'def _respond(obj):',
    '    try:',
    '        line = json.dumps(obj, default=str)',
    '    except BaseException:',
    '        line = json.dumps({"ok": False, "error": "response not JSON-serializable"})',
    '    _real_write(1, (line + "\\n").encode("utf-8", "replace"))',
    '',
    'def _main():',
    '    solution_path = sys.argv[1]',
    '    with open(solution_path, "r", encoding="utf-8") as f:',
    '        solution_src = f.read()',
    '',
    '    try:',
    '        ns = {}',
    '        exec(compile(solution_src, "<strategy_code>", "exec"), ns)',
    '    except BaseException as e:',
    '        _respond({"ok": False, "stage": "load_failed", "error": repr(e)[:800]})',
    '        return',
    '',
    '    cls = ns.get("Strategy")',
    '    if not isinstance(cls, type):',
    '        _respond({"ok": False, "stage": "no_strategy_class", "error": "strategy_code does not define a top-level class named Strategy"})',
    '        return',
    '    if not callable(getattr(cls, "decide", None)):',
    '        _respond({"ok": False, "stage": "no_decide_method", "error": "Strategy class has no callable decide method"})',
    '        return',
    '',
    '    _respond({"ok": True, "stage": "loaded"})',
    '',
    '    instance = None',
    '    for raw_line in sys.stdin:',
    '        raw_line = raw_line.strip()',
    '        if not raw_line:',
    '            continue',
    '        try:',
    '            msg = json.loads(raw_line)',
    '        except BaseException as e:',
    '            _respond({"ok": False, "error": "bad request JSON: " + repr(e)[:300]})',
    '            continue',
    '        cmd = msg.get("cmd") if isinstance(msg, dict) else None',
    '        if cmd == "start":',
    '            try:',
    '                instance = cls()',
    '                _respond({"ok": True})',
    '            except BaseException as e:',
    '                instance = None',
    '                _respond({"ok": False, "error": repr(e)[:500]})',
    '        elif cmd == "decide":',
    '            if instance is None:',
    '                _respond({"ok": False, "error": "decide requested before a successful start"})',
    '                continue',
    '            try:',
    '                r = instance.decide(msg.get("price_history"), msg.get("portfolio"))',
    '            except BaseException as e:',
    '                _respond({"ok": False, "error": repr(e)[:500]})',
    '            else:',
    '                _respond({"ok": True, "target_weight": r})',
    '        elif cmd == "end":',
    '            instance = None',
    '            _respond({"ok": True})',
    '        elif cmd == "shutdown":',
    '            _respond({"ok": True})',
    '            return',
    '        else:',
    '            _respond({"ok": False, "error": "unrecognized cmd"})',
    '',
    '_main()',
  ].join('\n');
}

/**
 * The driver -- see module doc comment (PRICE PATH FORMULA, METRICS
 * FORMULAS, WHY GENERATED IN A SEPARATE PROCESS). Templated per row with
 * market_params' own validated values plus the two file paths written
 * alongside it. Generates every seed's price path itself, spawns the runner
 * ONCE, drives it bar-by-bar per seed, and independently computes metrics
 * from the REAL resulting equity curve -- NEVER passes market_params, a
 * price array, or any metric back INTO the runner; the runner only ever
 * receives price_history/portfolio per bar and returns a target_weight.
 */
function buildDriverScript(mark, params, solutionPath, runnerPath) {
  return [
    'import sys, os, json, random, math, statistics, subprocess',
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark),
    '    SEEDS = ' + JSON.stringify(params.seeds),
    '    DRIFT = ' + JSON.stringify(params.drift),
    '    VOLATILITY = ' + JSON.stringify(params.volatility),
    '    NUM_BARS = ' + JSON.stringify(params.numBars),
    '    INITIAL_PRICE = ' + JSON.stringify(params.initialPrice),
    '    INITIAL_CAPITAL = ' + JSON.stringify(INITIAL_CAPITAL),
    '    PERIODS_PER_YEAR = ' + JSON.stringify(PERIODS_PER_YEAR),
    '    RUNNER_PATH = ' + pyStr(runnerPath),
    '    SOLUTION_PATH = ' + pyStr(solutionPath),
    '',
    '    _real_write = os.write',
    '    result = {"stage": "started", "seeds": {}}',
    '',
    '    def _emit():',
    '        _real_write(1, (MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
    '',
    '    def _generate_prices(seed):',
    '        # EXACT PINNED GBM FORMULA -- see schema.json market_params help',
    '        # text and this file\'s own module doc comment (PRICE PATH',
    '        # FORMULA). random.seed(seed) then random.gauss(0.0, 1.0) called',
    '        # exactly NUM_BARS times, in order, nothing else drawing from the',
    '        # random module in between -- a curator\'s own identical local',
    '        # snippet reproduces this path byte-for-byte.',
    '        random.seed(seed)',
    '        prices = [float(INITIAL_PRICE)]',
    '        for _ in range(NUM_BARS):',
    '            z = random.gauss(0.0, 1.0)',
    '            prices.append(prices[-1] * math.exp((DRIFT - 0.5 * VOLATILITY * VOLATILITY) + VOLATILITY * z))',
    '        return prices',
    '',
    '    def _compute_metrics(equity_curve):',
    '        # See module doc comment (METRICS FORMULAS) -- pinned exactly,',
    '        # matching schema.json\'s own expected_metrics help text word for',
    '        # word.',
    '        n = len(equity_curve)',
    '        returns = []',
    '        for i in range(1, n):',
    '            prev = equity_curve[i - 1]',
    '            cur = equity_curve[i]',
    '            returns.append((cur - prev) / prev if prev != 0 else 0.0)',
    '        if len(returns) >= 2:',
    '            mean_r = statistics.mean(returns)',
    '            std_r = statistics.stdev(returns)',
    '        else:',
    '            mean_r = 0.0',
    '            std_r = 0.0',
    '        sharpe = (mean_r / std_r) * math.sqrt(PERIODS_PER_YEAR) if std_r > 0 else 0.0',
    '        downside_sq = [min(r, 0.0) ** 2 for r in returns]',
    '        downside_dev = math.sqrt(sum(downside_sq) / len(downside_sq)) if downside_sq else 0.0',
    '        sortino = (mean_r / downside_dev) * math.sqrt(PERIODS_PER_YEAR) if downside_dev > 0 else 0.0',
    '        peak = equity_curve[0] if equity_curve else 0.0',
    '        max_dd = 0.0',
    '        for v in equity_curve:',
    '            if v > peak:',
    '                peak = v',
    '            dd = (v - peak) / peak if peak > 0 else 0.0',
    '            if dd < max_dd:',
    '                max_dd = dd',
    '        initial = equity_curve[0] if equity_curve else 0.0',
    '        final = equity_curve[-1] if equity_curve else 0.0',
    '        if initial > 0 and NUM_BARS > 0:',
    '            cagr = (final / initial) ** (PERIODS_PER_YEAR / NUM_BARS) - 1.0',
    '        else:',
    '            cagr = 0.0',
    '        calmar = (cagr / abs(max_dd)) if max_dd < 0 else 0.0',
    '        return {"sharpe": sharpe, "sortino": sortino, "max_drawdown": max_dd, "cagr": cagr, "calmar": calmar}',
    '',
    '    env = dict(os.environ)',
    '    env["PYTHONUNBUFFERED"] = "1"',
    '    try:',
    '        proc = subprocess.Popen(',
    '            [sys.executable, RUNNER_PATH, SOLUTION_PATH],',
    '            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,',
    '            text=True, bufsize=1, env=env,',
    '        )',
    '    except BaseException as e:',
    '        result["stage"] = "runner_spawn_failed"',
    '        result["error"] = repr(e)[:500]',
    '        _emit(); return',
    '',
    '    def _send(obj):',
    '        proc.stdin.write(json.dumps(obj) + "\\n")',
    '        proc.stdin.flush()',
    '',
    '    def _recv():',
    '        line = proc.stdout.readline()',
    '        if not line:',
    '            return None',
    '        try:',
    '            obj = json.loads(line)',
    '        except BaseException:',
    '            return None',
    '        return obj if isinstance(obj, dict) else None',
    '',
    '    handshake = _recv()',
    '    if not handshake or handshake.get("ok") is not True:',
    '        result["stage"] = "strategy_load_failed"',
    '        result["error"] = (handshake or {}).get("error", "no handshake from runner (process exited or produced no output)")',
    '        _emit()',
    '        try:',
    '            proc.kill()',
    '        except BaseException:',
    '            pass',
    '        return',
    '',
    '    for seed in SEEDS:',
    '        prices = _generate_prices(seed)',
    '        _send({"cmd": "start"})',
    '        resp = _recv()',
    '        if not resp or resp.get("ok") is not True:',
    '            result["seeds"][str(seed)] = {"ok": False, "error": (resp or {}).get("error", "start failed (no response)")}',
    '            _emit()',
    '            continue',
    '',
    '        cash = float(INITIAL_CAPITAL)',
    '        position = 0.0',
    '        equity_curve = []',
    '        seed_ok = True',
    '        err = None',
    '        for i, price in enumerate(prices):',
    '            equity_before = cash + position * price',
    '            _send({',
    '                "cmd": "decide",',
    '                "price_history": prices[0:i + 1],',
    '                "portfolio": {"cash": cash, "position": position, "equity": equity_before},',
    '            })',
    '            resp = _recv()',
    '            if resp is None:',
    '                seed_ok = False',
    '                err = "runner process exited unexpectedly (broken pipe) at bar %d" % i',
    '                break',
    '            if resp.get("ok") is not True:',
    '                seed_ok = False',
    '                err = resp.get("error", "decide() failed")',
    '                break',
    '            tw = resp.get("target_weight")',
    '            bad_tw = (isinstance(tw, bool) or not isinstance(tw, (int, float)) or not math.isfinite(float(tw)) or tw < 0.0 or tw > 1.0)',
    '            if bad_tw:',
    '                seed_ok = False',
    '                err = "decide() returned target_weight=%r at bar %d, must be a finite real number in [0.0, 1.0]" % (tw, i)',
    '                break',
    '            target_value = float(tw) * equity_before',
    '            target_shares = target_value / price',
    '            cash = cash - (target_shares - position) * price',
    '            position = target_shares',
    '            equity_curve.append(cash + position * price)',
    '',
    '        _send({"cmd": "end"})',
    '        _recv()',
    '',
    '        if not seed_ok:',
    '            result["seeds"][str(seed)] = {"ok": False, "error": err}',
    '        else:',
    '            result["seeds"][str(seed)] = {"ok": True, "metrics": _compute_metrics(equity_curve), "bars": len(equity_curve)}',
    '        _emit()  # checkpoint after EVERY seed -- a hang inside one seed',
    '                 # still leaves every prior seed\'s own result readable.',
    '',
    '    try:',
    '        _send({"cmd": "shutdown"})',
    '        proc.stdin.close()',
    '    except BaseException:',
    '        pass',
    '    try:',
    '        proc.wait(timeout=5)',
    '    except BaseException:',
    '        try:',
    '            proc.kill()',
    '        except BaseException:',
    '            pass',
    '',
    '    result["stage"] = "ok"',
    '    _emit()',
    '',
    '_main()',
  ].join('\n');
}

module.exports = {
  contract: 'synthetic-backtest-metrics-match',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const marketParamsRaw = h.str(row, 'market_params');
    const strategyCode = h.str(row, 'strategy_code');
    const expectedMetricsRaw = h.str(row, 'expected_metrics');

    if (!taskDescription.trim() || !marketParamsRaw.trim() || !strategyCode.trim() || !expectedMetricsRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, market_params, strategy_code, or expected_metrics' } };
    }

    const paramsCheck = validateMarketParams(marketParamsRaw);
    if (!paramsCheck.ok) {
      return { passed: false, logs: paramsCheck.reason, detail: { reason: 'bad_market_params' } };
    }
    const params = paramsCheck.params;

    const metricsCheck = validateExpectedMetrics(expectedMetricsRaw, params.seeds);
    if (!metricsCheck.ok) {
      return { passed: false, logs: metricsCheck.reason, detail: { reason: 'bad_expected_metrics' } };
    }
    const expectedBySeed = metricsCheck.bySeed;
    const tolerance = metricsCheck.tolerance;

    if (!/^\s*class\s+Strategy\b/m.test(strategyCode)) {
      return { passed: false, logs: 'strategy_code must define a top-level class named exactly Strategy', detail: { reason: 'no_strategy_class' } };
    }
    if (!/\bdef\s+decide\s*\(/.test(strategyCode)) {
      return {
        passed: false,
        logs: 'strategy_code\'s Strategy class must define a method named exactly decide (e.g. def decide(self, price_history, portfolio):)',
        detail: { reason: 'no_decide_method' },
      };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    const d = h.workdir();
    const mark = '@@BACKTESTROW_' + crypto.randomBytes(12).toString('hex') + '_';

    const solutionPath = h.path.join(d, 'strategy_code.py');
    h.fs.writeFileSync(solutionPath, strategyCode);

    const runnerScript = buildRunnerScript(h.PY_PRELUDE);
    const runnerPath = h.path.join(d, 'run_strategy_runner.py');
    h.fs.writeFileSync(runnerPath, runnerScript);

    const driverScript = buildDriverScript(mark, params, solutionPath, runnerPath);
    const driverPath = h.path.join(d, 'run_backtest_driver.py');
    h.fs.writeFileSync(driverPath, driverScript);

    const r = h.run('python3', [driverPath], { cwd: d, timeoutMs: TIMEOUT_MS });

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: up to
    // MAX_SEEDS checkpoint lines, each carrying a full metrics object, could
    // exceed the report-bounding cap before the trailing "ok" marker line.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }

    if (!out || typeof out !== 'object' || !out.stage) {
      return {
        passed: false,
        logs: r.timedOut
          ? ('strategy_code did not complete its backtest within the ' + TIMEOUT_MS + 'ms budget across ' + params.seeds.length + ' seed(s) x ' + params.numBars + ' bar(s) -- for this category\'s own sizing, this is itself a real failure (most likely a pathological per-bar computation inside decide(), or a decide() that never returns), not an infra problem')
          : ('could not parse verification output: ' + String(r.stderr || '').slice(0, 500)),
        detail: { reason: 'unparseable_output', timedOut: !!r.timedOut },
      };
    }

    if (out.stage === 'runner_spawn_failed') {
      return { passed: false, logs: 'harness could not spawn the strategy runner process: ' + String(out.error || '').slice(0, 500), detail: { reason: 'runner_spawn_failed' } };
    }
    if (out.stage === 'strategy_load_failed') {
      // Covers load_failed / no_strategy_class / no_decide_method, all
      // surfaced through the runner's own single handshake response.
      return { passed: false, logs: 'strategy_code failed to load: ' + String(out.error || '').slice(0, 800), detail: { reason: 'strategy_load_failed' } };
    }

    const seedResults = out.seeds && typeof out.seeds === 'object' ? out.seeds : {};

    for (const seed of params.seeds) {
      if (!seedResults[String(seed)]) {
        return {
          passed: false,
          logs: 'no result recorded for seed ' + seed + ' -- the backtest did not complete for every declared seed within the time budget',
          detail: { reason: 'incomplete_seed_results', seed },
        };
      }
    }

    // Execution failures (strategy raised, returned a bad target_weight, or
    // the runner process died mid-seed) -- report the first one found, in
    // params.seeds' own declared order.
    for (const seed of params.seeds) {
      const sr = seedResults[String(seed)];
      if (sr.ok !== true) {
        return {
          passed: false,
          logs: 'strategy_code failed on seed ' + seed + ': ' + String(sr.error || '').slice(0, 500),
          detail: { reason: 'strategy_execution_failed', seed, error: String(sr.error || '').slice(0, 500) },
        };
      }
    }

    // IMPLAUSIBLE-PERFORMANCE SANITY GATE -- see module doc comment. Checked
    // against the REAL, independently-computed metrics, BEFORE cross-
    // checking against the curator's own claims.
    const allSharpes = params.seeds.map((seed) => seedResults[String(seed)].metrics.sharpe);
    if (allSharpes.every((s) => typeof s === 'number' && s > IMPLAUSIBLE_SHARPE_THRESHOLD)) {
      return {
        passed: false,
        logs: 'strategy_code achieves a real, independently-computed Sharpe ratio above ' + IMPLAUSIBLE_SHARPE_THRESHOLD + ' on EVERY declared seed simultaneously (' + allSharpes.map((s) => s.toFixed(2)).join(', ') + ') -- market_params describes a pure random walk with no genuine exploitable edge, so consistently exceeding real-world top-tier quant performance across multiple independent random draws is far more likely a lookahead bug or an equity-accounting defect than genuine strategy skill (see schema.json\'s own documented heuristic)',
        detail: { reason: 'implausible_sharpe_all_seeds', sharpes: allSharpes },
      };
    }

    // Cross-check the REAL, independently-computed metrics against the
    // curator's own declared expected_metrics, per seed, within tolerance.
    for (const seed of params.seeds) {
      const real = seedResults[String(seed)].metrics;
      const declared = expectedBySeed.get(seed);
      for (const k of METRIC_KEYS) {
        const diff = Math.abs(real[k] - declared[k]);
        if (!(diff <= tolerance[k])) {
          return {
            passed: false,
            logs: 'seed ' + seed + ': expected_metrics.' + k + ' declares ' + declared[k] + ' but strategy_code\'s own REAL, independently-computed ' + k + ' is ' + real[k] + ' (|diff|=' + diff.toFixed(6) + ' > tolerance ' + tolerance[k] + ')',
            detail: { reason: 'metric_mismatch', seed, metric: k, expected: declared[k], actual: real[k], tolerance: tolerance[k] },
          };
        }
      }
    }

    return {
      passed: true,
      score: 1,
      detail: { reason: 'ok', seedsChecked: params.seeds.length, numBars: params.numBars },
    };
  },
};
