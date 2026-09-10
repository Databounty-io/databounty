/**
 * exact-decimal-output-match -- numerical_precision.
 *
 * THE CONTRACT: solution_code (real, contributor-controlled Python) defines
 * exactly one top-level function `solve(inputs, rounding_mode)`. The harness
 * calls it once with the row's own curator-authored `inputs` dict and
 * `rounding_mode` string, and its real returned value -- serialized to a
 * string exactly as documented below -- must equal `expected_output` via
 * EXACT STRING EQUALITY (surrounding whitespace trimmed on both sides only;
 * never numeric/float tolerance, never any other normalization). A category
 * about precision correctness must not itself paper over precision
 * differences with a tolerance band -- see schema.json's own expected_output
 * help text for why trailing zeros are treated as significant.
 *
 * NO INDEPENDENT ORACLE -- A DELIBERATE, REASONED DECISION, NOT A SHORTCUT:
 * rate_limiting_policy_simulation and caching_strategy both ship a real
 * independent oracle because each supports a SMALL, FIXED set of named
 * algorithms (5 policy types / 5 eviction disciplines apiece) that this
 * harness's own author can implement once, in plain JS, and cross-check
 * every row against regardless of what that row's own curator claims. This
 * category has no equivalent closed set: "calculate compound interest",
 * "split a bill N ways with no lost pennies", "convert currency at a fixed
 * rate", "compare per-line vs per-total tax rounding", "compute a weighted
 * average to 4 decimal places" are each a DIFFERENT, curator-authored
 * formula, arbitrarily different from one row to the next -- there is no
 * single reference algorithm this file could implement once and reuse
 * across every row the way computeOracleDecisions()/computeOracle() do for
 * those two categories. Writing a genuinely GENERAL "recompute what ANY
 * row's computation should produce" oracle would mean re-implementing an
 * open-ended natural-language-described formula from task_description's own
 * prose -- exactly the problem this category exists to have a human/
 * contributor solve, not something this harness can mechanically re-derive
 * as a trusted ground truth. expected_output is therefore trusted directly,
 * the same trust model this registry already uses for diff_patch_
 * application's own expected_final_content (verified only by real `git
 * apply` + exact comparison, never by independently re-deriving what the
 * patch SHOULD produce from the diff's own semantics) and data_
 * transformation's own output_data_sample -- mitigated by this category's
 * pipeline's own llm + human_audit stages downstream of execution, not by
 * mechanical re-derivation. See schema.json's own expected_output help text
 * for the honest, explicitly-documented residual this leaves: a curator's
 * own arithmetic mistake in expected_output is not mechanically detectable
 * here and would wrongly fail an otherwise-correct solution_code.
 *
 * FLOAT-VS-DECIMAL INTERNAL COMPUTATION -- ALLOWED INTERNALLY, ENFORCED ONLY
 * AT THE RETURN BOUNDARY: solve() may use Python float arithmetic internally
 * if convenient (never statically scanned for or banned) -- but its RETURNED
 * value must be exactly one of `decimal.Decimal` or `str` (see PY driver's
 * own _call() below), never a bare `float`/`int`/anything else, checked at
 * runtime after solve() returns. This is deliberately NOT "ban float use" --
 * it is "control the one moment float's own uncontrolled string
 * representation could otherwise silently decide the verdict". A bare
 * float's str() form is governed by CPython's own shortest-round-trip repr
 * algorithm, not something solve() has direct authorial control over
 * (missing trailing zeros for a value like 1051.1 when "1051.10" was
 * intended, scientific notation past a magnitude threshold); a str/Decimal
 * return forces solve() to make that formatting decision explicitly rather
 * than inheriting whatever CPython's float formatter happens to produce.
 * This does NOT prevent a genuine float-precision defect from reaching the
 * final output -- and it should not: if solve() computes an intermediate
 * result using float arithmetic (`total = principal * (1 + rate) ** periods`)
 * and that computation is itself imprecise at the bit this row's own
 * rounding boundary cares about (the well-known `round(2.675, 2)` ->
 * 2.67-not-2.68 IEEE-754-double-representation artifact, since 2.675 is
 * actually stored as ...674999999999982...), the resulting Decimal/str
 * solve() ultimately returns will simply be WRONG and fail the ordinary
 * exact-string-equality check below like any other incorrect answer -- this
 * is real, valuable signal this category exists to catch (see this
 * category's own self-test, which includes exactly this case), not
 * something this harness looks past or specially detects/flags. No separate
 * "did solution_code touch a float anywhere" scan exists, or is needed: the
 * exact-match gate alone already catches every case where float imprecision
 * actually corrupts the final answer, and a float use that happens not to
 * corrupt the final answer (most ordinary arithmetic, most of the time) is
 * not a defect worth flagging.
 *
 * ANTI-HARDCODING -- MUTATE-AND-RERUN, NOT A CURATOR-SUPPLIED SECOND
 * VARIANT: two designs were weighed (see task brief). (a) require curators to
 * author 2+ independent input variants per row that must produce different
 * outputs -- doubles per-row authoring burden (a second full input+expected_
 * output pair, itself just as exposed to the SAME undetectable-arithmetic-
 * mistake residual as the first) for a category whose computations already
 * vary arbitrarily per row, with no stronger guarantee than option (b) below
 * actually provides. (b) MUTATE-AND-RERUN (this file's choice, ported from
 * sql_query_correctness's own proven "no full oracle available, so prove
 * data-dependence instead of correctness" design): perturbDecimalString()/
 * validateInputs() below build a SECOND, harness-generated `inputs` object --
 * every decimal-string scalar (top-level or inside an array) nudged by a
 * real, exact (BigInt-computed, never floating point)
 * +10%-plus-one-whole-unit-at-that-field's-own-precision delta, every
 * integer scalar incremented by 1 -- and solve() is re-run
 * against it. Its output must come back DIFFERENT from expected_output, or
 * the row is rejected as suspected_hardcoded (a solve() that simply `return
 * "1051.16"` regardless of input is caught: it returns the identical literal
 * both times). Chosen over (a) because it needs no second curator-authored
 * ground truth at all (nothing for a curator to get wrong a second time),
 * and because perturbing EVERY numeric field simultaneously, by an amount
 * exact enough to move a typical cent-level rounding boundary, gives
 * overwhelming (though not, in principle, perfect -- see residual below)
 * confidence that ANY row whose real formula uses at least one of its own
 * declared inputs will produce a different final string.
 *
 * WHY A PERTURBED-CALL ERROR COUNTS AS "DIFFERS" (PASSES THIS GATE) HERE,
 * UNLIKE sql_query_correctness'S OWN CONSERVATIVE "error != differed" RULE:
 * sql_query_correctness's mutation perturbs actual DATABASE ROWS through a
 * constraint-enforcing SQL engine sitting between the mutation and the query
 * under test -- a mutated-run error there (a UNIQUE/CHECK/NOT NULL
 * violation) can be entirely UNRELATED to whether sql_query itself is
 * data-dependent, so treating it as inconclusive rather than as proof is the
 * correct, conservative call. Here there is no such intermediary: the
 * perturbed `inputs` dict is handed DIRECTLY to solve() as its own first
 * argument, with nothing in between. A solve() that is truly hardcoded (its
 * body never actually reads `inputs` at all) cannot raise an exception
 * BECAUSE of a change to a dict it never inspects -- so if the perturbed
 * call raises, that is itself direct, unambiguous evidence solve()'s own
 * control flow branched on the (perturbed) input value, at least as strong a
 * signal of input-sensitivity as a merely-different return value. Both
 * outcomes (a different value, or a raised exception/bad-type return) are
 * therefore treated identically as "not hardcoded" below.
 *
 * RESIDUAL, HONESTLY DOCUMENTED: a genuinely correct, non-hardcoded solve()
 * could in principle still produce a byte-identical output under this exact
 * perturbation for a pathological formula insensitive to it (e.g. one that
 * depends only on a RATIO between two fields that happens to be preserved --
 * deliberately made unlikely, not impossible, by adding a fixed absolute
 * unit on top of the proportional 10% bump, which generally breaks exact
 * ratio preservation, but not provably for every conceivable formula). This
 * mirrors sql_query_correctness's own accepted "a query could theoretically
 * be insensitive to this specific mutation" residual and is left
 * undocumented-further for the same reason: closing it completely would
 * require the same kind of multi-strategy redundancy sql_query_correctness
 * itself needed two real, confirmed production false-positives to justify --
 * not warranted here without equivalent evidence.
 *
 * ROUNDING-MODE-DIVERGENCE WAS CONSIDERED AND REJECTED AS A MECHANICAL GATE:
 * a tempting third anti-hardcoding check would re-run solve() with a
 * DIFFERENT rounding_mode and require its output to differ too (catching a
 * solve() that silently ignores rounding_mode and always behaves like one
 * fixed mode). Rejected as a MECHANICAL, every-row gate: ROUND_HALF_UP and
 * ROUND_HALF_EVEN (this category's two "ties" modes) only diverge from each
 * other AT AN EXACT ROUNDING-BOUNDARY TIE -- a row whose own curator-chosen
 * numbers do not happen to land on one (the common case; not every
 * legitimate financial computation needs to) would have NO reason to change
 * output under a different rounding mode even for a fully correct, properly
 * rounding_mode-sensitive solve(), making this an unacceptably high false-
 * positive-prone gate to apply uniformly. Left as schema.json's own
 * AUTHORING GUIDANCE instead (encouraged for at least some rows across the
 * dataset, never mechanically required per-row) -- the same "mechanical gate
 * only where it cannot false-positive; guidance prose otherwise" split this
 * registry already uses elsewhere (rate_limiting_policy_simulation's own
 * policy_description prose vs policy_params' mechanically-checked JSON).
 *
 * WHY INPUTS ARE STRINGS (DECIMAL) / PLAIN INTEGERS (COUNTS), NEVER BARE
 * FLOATS: this category's entire reason for existing is that a JSON/JS/
 * Python float literal cannot exactly represent most decimal values a
 * curator intends (0.1 is really
 * 0.1000000000000000055511151231257827021181583404541015625 in IEEE-754
 * double) -- accepting a bare float number for a decimal-precision-sensitive
 * field would silently reintroduce, into this category's OWN dataset-
 * authoring step, the exact defect it exists to make contributors avoid.
 * validateInputs() below rejects a JSON number with a fractional part
 * outright (as a dataset-authoring defect, before solution_code is ever
 * touched); a JSON number is accepted only when it is a plain, exact
 * integer (a genuine count -- compounding periods, number of people,
 * number of line items -- which floats represent exactly up to 2^53).
 *
 * PERTURBATION ARITHMETIC IS BigInt, NEVER FLOATING POINT: perturbDecimalString()
 * below parses a decimal string into an unscaled BigInt (the digits with the
 * decimal point removed) plus an integer scale (how many of those digits are
 * fractional), does exact BigInt addition, and re-inserts the decimal point
 * by plain string slicing -- never touching a JS `number` at any point. This
 * is deliberate: computing the perturbation itself via floating point would
 * be a category error for a harness whose entire subject is float-vs-exact-
 * decimal precision.
 *
 * GATE ORDER: field presence -> rounding_mode enum membership -> inputs
 * shape/decimal-literal/anti-degenerate validation (computing the perturbed
 * copy alongside, in the same pass) -> expected_output presence/length ->
 * solution_code's own static `def solve(` structural check -> h.have
 * ('python3') -> the one Python subprocess (solve() called twice: primary,
 * then perturbed) -> return-type validation -> exact-string comparison ->
 * anti-hardcoding (perturbed-output-must-differ) comparison.
 *
 * TIMEOUT BUDGET: exactly two plain Python function calls (solve() on
 * `inputs`, then again on the perturbed copy), each expected to be pure,
 * fast, in-process Decimal arithmetic with zero I/O, zero subprocess
 * spawning, zero real sleeping. TIMEOUT_MS (10000ms) is a wide, generous
 * multiple of the realistic sub-50ms cost of that -- matching rate_limiting_
 * policy_simulation/caching_strategy's identical sizing rationale -- and a
 * genuine timeout at this budget is itself meaningful signal (a
 * pathological/adversarial busy-loop inside solve()), treated as a real
 * failure, not runtimeUnavailable. Comfortably under the outer sandbox
 * command budget (120000ms, helpers.js's OUTER_SANDBOX_BUDGET_MS) with
 * roughly 110000ms of margin.
 */
'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 10000;
const MAX_INPUT_KEYS = 20;
const MAX_KEY_LEN = 40;
const MAX_DECIMAL_STR_LEN = 40;
const MAX_INT_ABS = 1000000000; // 1e9 -- generous for any realistic count (periods, people, line items)
const MAX_ARRAY_LEN = 50; // a per-key LIST of decimal-strings/integers -- e.g. weighted-average scores, per-line prices
const MAX_EXPECTED_OUTPUT_LEN = 2000;

const ROUNDING_MODES = ['ROUND_HALF_UP', 'ROUND_HALF_EVEN', 'ROUND_UP', 'ROUND_DOWN', 'ROUND_CEILING', 'ROUND_FLOOR'];

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DECIMAL_STR_RE = /^-?\d+(\.\d+)?$/;

// --------------------------------------------------------------- inputs ---

/**
 * Exact, BigInt-only decimal-string perturbation -- see module doc comment
 * (PERTURBATION ARITHMETIC). Adds a real, exact delta = 10% of the value's
 * own magnitude (floor division, so 0 for very small magnitudes -- harmless,
 * since the flat "+1 whole unit at this field's own precision" term below
 * always contributes a real, non-zero change regardless) PLUS one whole unit
 * at the field's OWN decimal precision (e.g. "+1.00" for a 2-decimal field,
 * "+1" for a 0-decimal field) -- sized specifically to survive typical
 * cent-level rounding rather than risk being lost inside it. The perturbed
 * value's sign always matches the original's; magnitude always increases.
 */
function perturbDecimalString(s) {
  const m = DECIMAL_STR_RE.exec(s);
  const neg = s.charAt(0) === '-';
  const intPart = m[0].replace('-', '').split('.')[0];
  const fracPart = s.indexOf('.') >= 0 ? s.split('.')[1] : '';
  const scale = fracPart.length;
  const unscaledAbs = BigInt(intPart + fracPart);
  const unit = 10n ** BigInt(scale);
  const tenPercent = unscaledAbs / 10n;
  const newUnscaledAbs = unscaledAbs + tenPercent + unit;
  let digits = newUnscaledAbs.toString();
  if (scale === 0) return (neg ? '-' : '') + digits;
  while (digits.length <= scale) digits = '0' + digits;
  const newIntPart = digits.slice(0, digits.length - scale);
  const newFracPart = digits.slice(digits.length - scale);
  return (neg ? '-' : '') + newIntPart + '.' + newFracPart;
}

/**
 * Validate ONE scalar inputs value (a decimal-literal string, or a plain
 * JSON integer) and compute its perturbed counterpart. Returns
 * { ok, reason, value, perturbed, isDecimal }. `where` is only used to
 * phrase a reject reason (e.g. "inputs.rate" or "inputs.scores[2]").
 */
function validateScalar(v, where) {
  if (typeof v === 'string') {
    if (v.length > MAX_DECIMAL_STR_LEN || !DECIMAL_STR_RE.test(v)) {
      return {
        ok: false,
        reason: where + ' (' + JSON.stringify(v) + ') must be a string matching an exact decimal literal, e.g. "1000.00" or "-12.5" (<=' + MAX_DECIMAL_STR_LEN + ' chars) -- a bare JSON float number is rejected separately below for the exact same reason',
      };
    }
    return { ok: true, value: v, perturbed: perturbDecimalString(v), isDecimal: true };
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || Math.abs(v) > MAX_INT_ABS) {
      return {
        ok: false,
        reason: where + ' (' + JSON.stringify(v) + ') is a bare JSON number with a fractional part or out of range -- this category never accepts a float literal for a decimal-precision-sensitive value (it cannot exactly represent most decimals a curator intends); author it as a STRING decimal literal instead (e.g. "0.05"), or as a plain JSON INTEGER only if it is genuinely a count (periods, people, line items)',
      };
    }
    return { ok: true, value: v, perturbed: v + 1, isDecimal: false };
  }
  return { ok: false, reason: where + ' must be a decimal-literal string or a plain JSON integer, got ' + JSON.stringify(v) };
}

/** Validate inputs' shape and build the perturbed copy alongside, in the
 * same pass. Every key's own value is either a scalar (decimal-literal
 * string / plain integer) or a flat (one level deep, no nesting) JSON ARRAY
 * of such scalars -- the latter covers a genuinely multi-value computation
 * (a weighted average over `scores`+`weights`, a per-line tax list) without
 * this category needing a second, structurally different field. Returns
 * { ok, reason, inputs, perturbedInputs }. */
function validateInputs(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'inputs must be valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'inputs must be a JSON object' };
  }
  const keys = Object.keys(parsed);
  if (keys.length < 1) {
    return { ok: false, reason: 'inputs must contain at least one key' };
  }
  if (keys.length > MAX_INPUT_KEYS) {
    return { ok: false, reason: 'inputs exceeds the maximum of ' + MAX_INPUT_KEYS + ' keys for this category' };
  }

  const inputs = {};
  const perturbedInputs = {};
  let hasDecimalField = false;

  for (const key of keys) {
    if (!KEY_RE.test(key) || key.length > MAX_KEY_LEN) {
      return { ok: false, reason: 'inputs key ' + JSON.stringify(key) + ' must be a plain identifier (letters/digits/underscore, starting with a letter or underscore, <=' + MAX_KEY_LEN + ' chars)' };
    }
    const v = parsed[key];

    if (Array.isArray(v)) {
      if (v.length < 1) {
        return { ok: false, reason: 'inputs.' + key + ' is an empty array -- omit the key instead if it has nothing to contribute' };
      }
      if (v.length > MAX_ARRAY_LEN) {
        return { ok: false, reason: 'inputs.' + key + ' exceeds the maximum array length of ' + MAX_ARRAY_LEN + ' for this category' };
      }
      const values = [];
      const perturbedValues = [];
      for (let i = 0; i < v.length; i++) {
        const r = validateScalar(v[i], 'inputs.' + key + '[' + i + ']');
        if (!r.ok) return r;
        values.push(r.value);
        perturbedValues.push(r.perturbed);
        if (r.isDecimal) hasDecimalField = true;
      }
      inputs[key] = values;
      perturbedInputs[key] = perturbedValues;
      continue;
    }

    const r = validateScalar(v, 'inputs.' + key);
    if (!r.ok) return r;
    if (r.isDecimal) hasDecimalField = true;
    inputs[key] = r.value;
    perturbedInputs[key] = r.perturbed;
  }

  if (!hasDecimalField) {
    return { ok: false, reason: 'inputs must include at least one decimal-string-valued key (scalar or inside an array) -- a row using only integer counts is not actually testing decimal precision' };
  }

  return { ok: true, inputs, perturbedInputs };
}

// -------------------------------------------------------- python driver ---

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/**
 * The Python driver -- see module doc comment (FLOAT-VS-DECIMAL INTERNAL
 * COMPUTATION, ANTI-HARDCODING). Calls solve(inputs, rounding_mode) exactly
 * twice: once against the row's own real inputs (`primary`), once against
 * the harness-computed perturbed copy (`perturbed`). Neither call ever sees
 * expected_output -- there is nothing here for solve() to read that could
 * make hardcoding it trivially undetectable by any OTHER means than this
 * file's own perturbed-output-must-differ check.
 */
function buildDriverScript(pyPrelude, solutionCode, roundingMode, inputs, perturbedInputs, mark) {
  return [
    'import sys, os, json',
    'from decimal import Decimal, getcontext',
    '',
    pyPrelude,
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark),
    '    SOLUTION_SRC = ' + pyStr(solutionCode),
    '    ROUNDING_MODE = ' + pyStr(roundingMode),
    '    INPUTS = json.loads(' + pyStr(JSON.stringify(inputs)) + ')',
    '    PERTURBED_INPUTS = json.loads(' + pyStr(JSON.stringify(perturbedInputs)) + ')',
    '    # Generous precision ceiling -- realistic financial/scientific',
    "    # magnitudes this category's own inputs length limits allow never",
    '    # approach it; this only exists so a long chain of solve()-internal',
    '    # Decimal operations never silently loses precision to the default',
    '    # 28-digit context.',
    '    getcontext().prec = 80',
    '    _real_write = os.write',
    '    result = {"stage": "started"}',
    '',
    '    def _emit():',
    '        _real_write(1, (MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
    '',
    '    try:',
    '        ns = {}',
    '        exec(compile(SOLUTION_SRC, "<solution_code>", "exec"), ns)',
    '    except BaseException as e:',
    '        result["stage"] = "load_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    solve_fn = ns.get("solve")',
    '    if not callable(solve_fn):',
    '        result["stage"] = "no_solve_function"',
    '        _emit(); return',
    '',
    '    def _call(inputs_dict):',
    '        try:',
    '            r = solve_fn(inputs_dict, ROUNDING_MODE)',
    '        except BaseException as e:',
    '            return {"ok": False, "error": repr(e)}',
    '        if isinstance(r, Decimal):',
    '            return {"ok": True, "type": "decimal", "value": str(r)}',
    '        if isinstance(r, str):',
    '            return {"ok": True, "type": "str", "value": r}',
    '        return {',
    '            "ok": False,',
    '            "error": "solve() returned %r (type %s) -- must return a decimal.Decimal or a str, never a bare float/int" % (r, type(r).__name__),',
    '        }',
    '',
    '    result["stage"] = "in_progress"',
    '    result["primary"] = _call(INPUTS)',
    '    _emit()  # checkpoint after the PRIMARY call -- a hang inside the',
    '             # perturbed call still leaves the primary result readable,',
    '             # matching rate_limiting_policy_simulation/caching_strategy\'s',
    '             # own incremental-checkpoint precedent.',
    '    result["perturbed"] = _call(PERTURBED_INPUTS)',
    '    result["stage"] = "ok"',
    '    _emit()',
    '',
    '_main()',
  ].join('\n');
}

module.exports = {
  contract: 'exact-decimal-output-match',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const roundingMode = h.str(row, 'rounding_mode').trim();
    const inputsRaw = h.str(row, 'inputs');
    const solutionCode = h.str(row, 'solution_code');
    const expectedOutput = h.str(row, 'expected_output').trim();

    if (!taskDescription.trim() || !roundingMode || !inputsRaw.trim() || !solutionCode.trim() || !expectedOutput) {
      return { passed: false, detail: { reason: 'missing task_description, rounding_mode, inputs, solution_code, or expected_output' } };
    }

    if (!ROUNDING_MODES.includes(roundingMode)) {
      return {
        passed: false,
        logs: 'rounding_mode "' + roundingMode + '" is not one of the recognized values: ' + ROUNDING_MODES.join(', '),
        detail: { reason: 'unrecognized_rounding_mode' },
      };
    }

    if (expectedOutput.length > MAX_EXPECTED_OUTPUT_LEN) {
      return { passed: false, logs: 'expected_output exceeds the maximum of ' + MAX_EXPECTED_OUTPUT_LEN + ' characters for this category', detail: { reason: 'expected_output_too_long' } };
    }

    const inputsCheck = validateInputs(inputsRaw);
    if (!inputsCheck.ok) {
      return { passed: false, logs: inputsCheck.reason, detail: { reason: 'bad_inputs' } };
    }
    const { inputs, perturbedInputs } = inputsCheck;

    if (!/^\s*def\s+solve\s*\(/m.test(solutionCode)) {
      return {
        passed: false,
        logs: 'solution_code must define a top-level function named exactly solve, with signature solve(inputs, rounding_mode)',
        detail: { reason: 'no_solve_function' },
      };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    const d = h.workdir();
    const mark = '@@NUMPRECROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = buildDriverScript(h.PY_PRELUDE, solutionCode, roundingMode, inputs, perturbedInputs, mark);
    const scriptPath = h.path.join(d, 'run_numerical_precision.py');
    h.fs.writeFileSync(scriptPath, script);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: a
    // legitimately long structured expected_output (e.g. a JSON-array-of-
    // amounts string for a multi-person bill split) could exceed the
    // report-bounding cap before the trailing "ok" marker line is reached.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }

    if (!out || typeof out !== 'object' || !out.stage) {
      return {
        passed: false,
        logs: r.timedOut
          ? ('solve() did not complete within the ' + TIMEOUT_MS + 'ms budget -- for work this small (two plain Decimal-arithmetic calls), this is itself a real failure, not an infra problem')
          : ('could not parse verification output: ' + String(r.stderr || '').slice(0, 500)),
        detail: { reason: 'unparseable_output', timedOut: !!r.timedOut },
      };
    }

    if (out.stage === 'load_failed') {
      return { passed: false, logs: 'solution_code failed to load: ' + String(out.error || '').slice(0, 800), detail: { reason: 'load_failed' } };
    }
    if (out.stage === 'no_solve_function') {
      return { passed: false, logs: 'solution_code does not define a top-level solve function after exec', detail: { reason: 'no_solve_function' } };
    }

    const primary = out.primary;
    if (!primary || typeof primary !== 'object') {
      return {
        passed: false,
        logs: r.timedOut
          ? ('solve() did not complete its primary call within the ' + TIMEOUT_MS + 'ms budget')
          : 'solve() primary call produced no result',
        detail: { reason: 'primary_incomplete' },
      };
    }
    if (primary.ok !== true) {
      return { passed: false, logs: 'solve(inputs, rounding_mode) failed on this row\'s own real inputs: ' + String(primary.error || '').slice(0, 800), detail: { reason: 'primary_failed' } };
    }

    const actual = String(primary.value == null ? '' : primary.value).trim();
    if (actual !== expectedOutput) {
      return {
        passed: false,
        logs: 'solve() returned ' + JSON.stringify(actual.slice(0, 300)) + ' but expected_output is ' + JSON.stringify(expectedOutput.slice(0, 300)),
        detail: { reason: 'output_mismatch', actual: actual.slice(0, 300), expected: expectedOutput.slice(0, 300) },
      };
    }

    // ANTI-HARDCODING GATE -- see module doc comment. A perturbed-call
    // failure (exception, or a bad-type return) counts as "differs" here --
    // see module doc comment (WHY A PERTURBED-CALL ERROR COUNTS AS
    // "DIFFERS") for why that is the correct call for THIS category's shape,
    // unlike sql_query_correctness's own conservative "error != differed"
    // rule for a constraint-mediated mutation.
    const perturbed = out.perturbed;
    if (perturbed && typeof perturbed === 'object' && perturbed.ok === true) {
      const perturbedValue = String(perturbed.value == null ? '' : perturbed.value).trim();
      if (perturbedValue === expectedOutput) {
        return {
          passed: false,
          logs: 'solve() returned the IDENTICAL output (' + JSON.stringify(expectedOutput.slice(0, 300)) + ') for this row\'s own real inputs AND for a harness-perturbed copy of inputs (every numeric field genuinely changed) -- solution_code appears to be returning a hardcoded constant rather than actually computing from its own inputs argument',
          detail: { reason: 'suspected_hardcoded', expected: expectedOutput.slice(0, 300) },
        };
      }
    }

    return {
      passed: true,
      score: 1,
      detail: { reason: 'ok' },
    };
  },
};
