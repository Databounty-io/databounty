/**
 * both-pass-identically + relative-timing — original_code and optimized_code
 * must both pass the shared tests, AND produce the SAME result as each
 * other on benchmark_input itself (tests alone only exercises small, fixed
 * literal cases — confirmed exploitable: an optimized_code that special-cases
 * exactly the values tests checks and returns a wrong/constant answer for
 * everything else, including benchmark_input, previously passed outright,
 * since nothing compared its actual return value against anything), AND the
 * optimized version must run at most max_allowed_relative_runtime times as
 * long as the original, measured on benchmark_input in one process so the
 * comparison is meaningful.
 *
 * No `language` field on this dataset — every row is Python.
 */
'use strict';

module.exports = {
  contract: 'both-pass-identically',
  requires: ['python3'],

  verify(row, h) {
    const original = h.str(row, 'original_code');
    const optimized = h.str(row, 'optimized_code');
    const tests = h.str(row, 'tests');
    const benchmarkInput = h.str(row, 'benchmark_input');
    const maxRelRaw = row.max_allowed_relative_runtime;
    if (!original || !optimized || !tests) {
      return { passed: false, detail: { reason: 'missing original_code, optimized_code, or tests' } };
    }
    if (!h.have('python3')) return { passed: false, runtimeUnavailable: true, logs: 'python3 not available', detail: {} };

    // Timeouts reduced from 25000/25000/60000 (up to 110s worst case): all
    // three of these subprocesses run SEQUENTIALLY within the same outer
    // sandbox command, whose default budget was 60s total at the time (now
    // raised to 120s) -- the old combined worst case already exceeded that
    // then-budget on its own, and confirmed empirically to approach/exceed
    // it even on ordinary reference-dataset rows (a deliberately slow
    // "naive" original run 7 times, exactly this category's core use case,
    // is the shape most likely to blow the budget). 10s/10s leaves bench.py
    // up to 35s of the now-120s outer window, with margin for
    // process-spawn/JSON overhead.
    const a = h.runCode('python', original + '\n' + tests, 10000);
    const b = h.runCode('python', optimized + '\n' + tests, 10000);
    const bothCorrect = a.ok === true && b.ok === true;

    const maxRelMatch = String(maxRelRaw == null ? '' : maxRelRaw).match(/([0-9]*\.?[0-9]+)/);
    let maxRel = maxRelMatch ? parseFloat(maxRelMatch[1]) : null;
    // A ratio threshold outside (0, 1] cannot be a genuine "must be at most
    // this much of the original's time" claim (0 is unsatisfiable by any
    // real timing; above 1 would accept a slower "optimization") -- most
    // plausibly a unit mismatch (e.g. "20" meaning "20x faster", which as a
    // ratio threshold would instead accept almost anything). Confirmed
    // against the real 25-row dataset: every row's value already falls
    // inside (0, 1], so this has no false-reject risk there.
    if (maxRel != null && (maxRel <= 0 || maxRel > 1)) maxRel = null;

    let ratio = null, timingErr = null, benchmarkCorrect = null;
    if (bothCorrect && maxRel != null) {
      const d = h.workdir();
      const prog = [
        'import time, json, re, os, inspect',
        'ORIG = ' + JSON.stringify(original),
        'OPT  = ' + JSON.stringify(optimized),
        'ARG  = ' + JSON.stringify(benchmarkInput),
        'TESTS = ' + JSON.stringify(tests),
        // Shared wall-clock deadline across BOTH bench(ORIG) and bench(OPT):
        // each side always gets at least its first trial regardless of how
        // long that takes, but additional best-of-N trials only run while
        // time remains -- so a deliberately slow "naive" original (exactly
        // this category's core case) can't alone blow the whole script's
        // time budget just from repeating it 7 times.
        'BENCH_DEADLINE = time.perf_counter() + 22.0',
        'def bench_once(src):',
        '    g = {}',
        '    exec(src, g)',
        // type(v).__name__ == "function" alone would exclude decorator-wrapped
        // functions (e.g. @lru_cache -- one of the most idiomatic Python
        // speedups, and exactly what this category exists to reward): its
        // wrapper's type name is "_lru_cache_wrapper", not "function". A
        // well-behaved decorator (lru_cache included) sets __wrapped__ via
        // functools.wraps, so accepting that too covers it without also
        // accepting unrelated callables like an imported class or builtin.
        '    candidates = [(k, v) for k, v in g.items() if callable(v) and not k.startswith("__") and (type(v).__name__ == "function" or hasattr(v, "__wrapped__"))]',
        '    if not candidates: return None, "no callable defined", None',
        // When a row defines more than one top-level function, benchmark the
        // one TESTS actually calls -- not just "whichever is defined first",
        // which could time an unrelated helper on one side and the real
        // implementation on the other. Falls back to the first candidate
        // (prior behavior) if nothing in TESTS matches by name.
        '    called = set(re.findall(r"\\b([A-Za-z_]\\w*)\\s*\\(", TESTS))',
        '    matching = [v for k, v in candidates if k in called]',
        '    fn = matching[0] if matching else candidates[0][1]',
        '    try:',
        // benchmark_input is sometimes a single value ("30",
        // "list(range(6000))") and sometimes ALREADY a parenthesized
        // multi-argument tuple ("(list(range(5000)), [1,2,3])") for
        // functions taking more than one parameter. Evaluating it directly
        // and checking the result's own type — rather than unconditionally
        // wrapping it in one more layer of parens — handles both without
        // double-wrapping the tuple case into a single nested argument.
        '        _val = eval(ARG, dict(g))',
        // Whether a tuple-shaped benchmark_input should be unpacked as
        // *args used to depend purely on the VALUE's own shape (any tuple
        // was unpacked) -- confirmed exploitable: a row whose function
        // takes exactly ONE parameter and destructures a tuple INSIDE its
        // own body ("def f(data): a, b = data") had that same tuple
        // unpacked into two separate positional arguments here instead,
        // raising "takes 1 positional argument but 2 were given" before
        // the function ever ran, for an entirely ordinary, valid
        // single-argument function. Deciding from the function's REAL
        // arity instead resolves this unambiguously: every row in this
        // dataset's own reference corpus with a tuple-shaped
        // benchmark_input pairs it with a function whose parameter count
        // already equals the tuple length, so this is purely additive --
        // identical behavior there, correct behavior for the
        // single-parameter case that arity-blind unpacking could never
        // have told apart from the multi-argument one.
        '        try:',
        '            _arity = len(inspect.signature(fn).parameters)',
        '        except Exception:',
        '            _arity = None',
        '        arg = _val if (isinstance(_val, tuple) and (_arity is None or _arity > 1)) else (_val,)',
        '    except Exception as e:',
        '        return None, "arg eval failed: " + repr(e), None',
        // Deliberately NO warm-up call within one bench_once: several
        // optimized versions memoize into a default-argument dict, so a
        // warm-up would make the timed call ~0s and manufacture a speedup
        // that is not being measured.
        '    t0 = time.perf_counter()',
        '    try:',
        '        _result = fn(*arg)',
        // BaseException (not just Exception): a call that raises SystemExit
        // (e.g. argparse-style CLI code, or an evasive sys.exit()) used to
        // crash the entire bench.py script uncaught -- losing BOTH sides'
        // timing data and reporting only an opaque parse failure. Catching
        // it here scores just that one trial as failed instead.
        '    except BaseException as e:',
        '        return None, "call failed: " + repr(e), None',
        '    return time.perf_counter() - t0, None, _result',
        // Best-of-N across INDEPENDENT fresh exec()s (each with its own
        // clean memo state, so this does not reintroduce the warm-up problem
        // above) — a single wall-clock sample is noisy enough that a
        // genuinely-met speedup can measure just over the threshold by
        // chance on one unlucky run. The RESULT returned is from whichever
        // trial produced the best time -- compared against the other side's
        // best-trial result below to confirm optimized_code is not just
        // fast, but actually correct on the real benchmark_input (tests
        // alone only exercises small fixed literals, not this value).',
        'def bench(src, trials=7):',
        '    best = None',
        '    best_result = None',
        '    last_err = None',
        '    for i in range(trials):',
        '        if i > 0 and time.perf_counter() > BENCH_DEADLINE:',
        '            break',
        '        t, e, res = bench_once(src)',
        '        if e is not None:',
        '            last_err = e',
        '            continue',
        '        if best is None or t < best:',
        '            best = t',
        '            best_result = res',
        '    return best, (last_err if best is None else None), best_result',
        't1, e1, r1 = bench(ORIG)',
        't2, e2, r2 = bench(OPT)',
        // Compared HERE, in Python, with the real (possibly large) values
        // still in memory -- transmitting r1/r2 themselves back through
        // stdout risked exceeding helpers.js's 8KB output-capture cap for
        // any row whose result is a sizeable list/dict (confirmed: this
        // silently truncated the JSON line mid-value and broke parsing for
        // roughly half the real reference dataset). Only a short, bounded
        // preview is ever sent back, and only on an actual mismatch.',
        'try:',
        '    results_match = (r1 == r2)',
        'except Exception:',
        '    results_match = None',
        // Order-insensitive fallback: confirmed against the real reference
        // dataset that a legitimate optimization can return the SAME
        // multiset of results in a genuinely different order (e.g. a
        // seen-set-based rewrite of a pair-finding double loop naturally
        // emits matches in a different sequence than the original) -- the
        // row's OWN tests field already wraps its assertion in sorted(...)
        // for exactly this reason, so raw order-sensitive equality here
        // would false-reject a pair the row's own author already judged
        // equivalent. Only reached when direct equality disagreed.
        'if results_match is False:',
        '    try:',
        '        results_match = (sorted(r1) == sorted(r2))',
        '    except Exception:',
        '        pass',
        'def _preview(v):',
        '    try:',
        '        return repr(v)[:200]',
        '    except Exception:',
        '        return "<unrepresentable>"',
        // A bare print() here would be exactly the stdout-hijack gap fixed
        // elsewhere in this registry: ORIG/OPT ran moments earlier via
        // exec(src, g) in this SAME process, and sys.stdout is a mutable
        // process-global looked up fresh on every print() call -- confirmed
        // exploitable with a hand-built repro where optimized_code returns a
        // genuinely wrong result but reassigns sys.stdout to a wrapper that
        // rewrites this final line into a forged results_match: true. Writing
        // straight to the fd bypasses any stdout/sys.stdout reassignment.
        '_out = json.dumps({',
        '    "orig": t1, "opt": t2, "e1": e1, "e2": e2, "results_match": results_match,',
        '    "r1_preview": None if results_match else _preview(r1),',
        '    "r2_preview": None if results_match else _preview(r2),',
        '})',
        'os.write(1, (_out + "\\n").encode("utf-8", "replace"))',
      ].join('\n');
      const f = h.path.join(d, 'bench.py');
      h.fs.writeFileSync(f, prog);
      const r = h.run('python3', [f], { cwd: d, timeoutMs: 35000 });
      try {
        const lines = String(r.stdout || '').trim().split('\n');
        const j = JSON.parse(lines[lines.length - 1]);
        if (j.orig != null && j.opt != null) {
          benchmarkCorrect = j.results_match === true;
          if (benchmarkCorrect) {
            ratio = j.opt / j.orig;
          } else if (j.results_match === false) {
            timingErr = 'optimized_code produced a different result than original_code on benchmark_input (original: '
              + String(j.r1_preview).slice(0, 150) + ', optimized: ' + String(j.r2_preview).slice(0, 150) + ')';
          } else {
            timingErr = 'original_code and optimized_code returned values that could not be compared for equality on benchmark_input';
          }
        } else {
          timingErr = j.e1 || j.e2 || 'no timing';
        }
      } catch (e) {
        timingErr = 'bench parse failed: ' + String(r.stderr || '').slice(0, 200);
      }
    }

    const fastEnough = ratio != null && maxRel != null ? ratio <= maxRel : null;
    const passed = bothCorrect && benchmarkCorrect === true && fastEnough === true;
    return {
      passed,
      logs: passed ? '' : (!bothCorrect ? 'original or optimized code failed the shared tests'
        : (timingErr || (maxRel == null ? 'max_allowed_relative_runtime is not a parseable ratio in (0, 1]'
          : ('measured ratio ' + ratio + ' exceeds max allowed ' + maxRel)))),
      detail: {
        bothPassTests: bothCorrect, maxAllowedRelative: maxRel, measuredRatio: ratio, fastEnough, benchmarkCorrect, timingErr,
        benchmarkInput: benchmarkInput.slice(0, 120),
      },
    };
  },
};
