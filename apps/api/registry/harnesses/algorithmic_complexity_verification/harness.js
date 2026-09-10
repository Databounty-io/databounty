/**
 * empirical-complexity-claim-vs-reality -- algorithmic_complexity_verification.
 *
 * NOT A DUPLICATE OF 'performance' -- READ THIS FIRST IF THAT IS YOUR
 * INSTINCT. performance/harness.js ('both-pass-identically') is a SINGLE-
 * SCALE, TWO-IMPLEMENTATION relative-speed-ratio check: original_code vs
 * optimized_code, both run ONCE on the SAME fixed benchmark_input, and the
 * only question is "is optimized/original's wall-clock ratio <= a fixed
 * threshold". This category is a different, harder shape entirely: ONE
 * implementation (implementation_code), run at MULTIPLE, increasing input
 * sizes, and the question is "does the GROWTH CURVE across those sizes match
 * a claimed asymptotic class" -- there is no second implementation to compare
 * against, and no single fixed threshold; the pass/fail signal is a ratio
 * BETWEEN two of implementation_code's OWN measurements at different n; and
 * unlike performance (fixed benchmark_input controls for machine-timing noise
 * inherent in any single reading), this category cannot avoid comparing
 * timings ACROSS separate runs at different n, which is exactly what makes it
 * this registry's most budget- and noise-sensitive design (see below).
 *
 * THE CONTRACT:
 *   1) CORRECTNESS GATE, before any timing: implementation_code must define
 *      exactly one top-level 'def solve(n):', deterministically generating
 *      its own input of size n internally (fixed seed, no I/O, no wall-clock
 *      dependence) and returning a JSON-serializable result. solve(n) is
 *      called once per (n, expected) pair in expected_outputs_at_sizes (small,
 *      cheap, curator-authored, computed by a trusted reference implementation
 *      at generation time) and must match EXACTLY every time. A wrong answer
 *      at a small, cheap size is a real failure regardless of what the
 *      growth curve would have looked like -- no timing measurement is even
 *      attempted until every correctness check passes.
 *   2) GROWTH-CURVE GATE: solve(n) is called at three increasing, DOUBLING
 *      sizes (N, 2N, 4N -- the base N is chosen per claimed_complexity, see
 *      SIZE/TIMEOUT TABLE below), REPEATS=3 times per size, taking the MIN of
 *      the 3 repeats at each size (see MIN VS MEDIAN below). The empirical
 *      growth ratio between consecutive doublings is compared against
 *      claimed_complexity's theoretically-expected ratio, with generous
 *      tolerance bands (see TOLERANCE BANDS below). Measured on CPU time
 *      (time.process_time()), not wall-clock, specifically to defeat a
 *      time.sleep()-based fake growth curve (see CPU TIME VS WALL-CLOCK
 *      below) -- both are still measured and reported for audit visibility.
 *
 * SIZE/TIMEOUT TABLE -- REAL MEASUREMENTS, NOT GUESSES. Every number below
 * was measured on this authoring host (Windows 11, Python 3.13.9) against
 * genuine reference implementations of each class before being chosen. FIRST
 * PASS used wall-clock (min of 2-3 repeats): O(n) sum-of-list n=64000->8.5ms,
 * 128000->20ms, 256000->40ms (clean ~2.0x/doubling); O(n log n) merge sort
 * n=8000->28ms, 16000->53ms, 32000->112ms (~2.2x/doubling); O(n^2) all-pairs
 * scan n=800->14ms, 1600->59ms, 3200->248ms (~4.0-4.2x/doubling); O(n^3)
 * triple loop n=100->12ms, 200->100ms, 400->944ms (~8.6-9.5x/doubling) --
 * O(log n) fast-doubling Fibonacci mod 1e9+7 (bounded-int, see next
 * paragraph) n=1000->5.1us, 10,000,000->10.3us, 100,000,000->11.8us
 * (100,000x growth in n, only ~2.3x growth in time -- genuine log n); O(1)
 * 'n % 2 == 0' n=1000 through n=10,000,000 -> flat ~1.2us.
 *
 * SECOND PASS, AND A REAL BUG THIS CAUGHT: measuring CPU time
 * (time.process_time()) at those SAME wall-clock-derived sizes -- as the
 * actual pass/fail signal will (see CPU TIME VS WALL-CLOCK below) -- against
 * this authoring host's real self-test rows produced WRONG verdicts for
 * genuinely correct O(n) and O(n^2) implementations (measured cpuRatio 6.85x
 * and 17.23x respectively, both far outside their own correct band). Root
 * cause, confirmed by direct measurement (a controlled busy-loop timed with
 * time.process_time() at several target durations): this host's
 * time.process_time() (Windows' GetProcessTimes) only updates in ~15.625ms
 * (1/64s) TICKS -- a real value below one tick reads as exactly 0.0, and
 * real values are otherwise rounded to a tick multiple, e.g. a controlled
 * 10ms-of-real-work busy-loop measured anywhere from 0ms to 15.625ms
 * depending on tick alignment. At the FIRST-PASS sizes above, the smallest
 * rung's real CPU cost (a few ms) was mostly BELOW one tick and got floor-
 * clamped to FLOOR_MS while the larger rungs landed on 1-3 real ticks --
 * comparing a floor artifact against tick-quantized real values manufactured
 * a growth ratio with no relationship to the algorithm's real behavior. Sizes
 * were bumped so the SMALLEST rung of every real (non-{O(1),O(log n)}) class
 * costs comfortably more than one tick (targeted ~60-125ms, i.e. 4-8 ticks,
 * keeping quantization error to a small fraction of the measured value even
 * on this coarse a clock) -- REMEASURED directly on CPU time at the new
 * sizes: O(n) n=640000->125.0ms, 1280000->265.625ms, 2560000->562.5ms
 * (~2.12x/doubling, clean); O(n log n) n=32000->140.625ms, 64000->281.25ms,
 * 128000->578.125ms (~2.03x/doubling); O(n^2) n=1600->62.5ms, 3200->250.0ms,
 * 6400->1015.625ms (~4.03x/doubling, excellent); O(n^3) n=150->62.5ms,
 * 300->562.5ms, 600->5859.375ms (~9.2-10.4x/doubling, within the [6,30) band
 * with room). The deployed E2B sandbox is Linux, where clock_gettime
 * (CLOCK_PROCESS_CPUTIME_ID) typically has microsecond-or-better resolution
 * and this exact quantization artifact is NOT expected to reproduce -- but
 * these bumped sizes were kept as the shipped design anyway, deliberately,
 * as a portability safety margin rather than a Windows-only workaround: a
 * clock coarser than the ideal case is a real possibility on SOME
 * virtualized/containerized CPU-time sources regardless of host OS, and
 * sizing for robustness against that costs only a modest, still-comfortably-
 * budgeted increase in real run time (see the revised TIMEOUT BUDGET below),
 * not a design compromise.
 *
 *   CAUTIONARY MEASUREMENT (why this category's O(log n)/O(1) size choices
 *   look the way they do, and why the schema warns curators against
 *   "materialized array + binary search" as an O(log n) task shape): a
 *   binary search over a FRESHLY BUILT sorted list of size n measured at
 *   13.4us(n=1000) -> 2.6ms(n=128000), a clean ~2.0x-per-doubling curve
 *   THROUGHOUT -- i.e. it measures as O(n), not O(log n), because building
 *   the size-n list is itself O(n) work that dominates the O(log n) search
 *   step end-to-end. A NAIVE (non-modular) fast-doubling Fibonacci showed the
 *   identical trap from a different cause: 8.1us(n=1000) -> 76.8ms(n=1,000,000),
 *   a ~9500x blowup for a 1000x n increase, because Fibonacci numbers grow
 *   exponentially and multiplying the resulting huge (unbounded) integers
 *   is NOT O(1) per multiplication -- reducing modulo a fixed constant at
 *   EVERY step (as this file's own measured example above does) keeps every
 *   intermediate value bounded-size and restores genuine O(log n) behavior.
 *   Both are documented in schema.json's task_description help text so
 *   curators do not author an O(log n)/O(1) row this harness structurally
 *   cannot verify honestly.
 *
 * Base N per claimed_complexity (COMPLEXITY_TABLE below) is chosen directly
 * from the SECOND-PASS (CPU-time, tick-quantization-safe) measurements above
 * so the 3-repeat SUM across the whole N/2N/4N ladder stays small even on a
 * much slower sandbox CPU: O(n)=~2.86s, O(n log n)=~3.00s, O(n^2)=~3.98s,
 * O(n^3)=~19.45s (3x the measured 150/300/600 single-repeat sum of 6484ms);
 * O(1)/O(log n) are negligible (<1ms) regardless of size, so their bases are
 * chosen large (hundreds of thousands to millions) purely to give a real,
 * non-degenerate n to a curious/adversarial implementation, not for timing-
 * cost reasons.
 *
 * TIMEOUT BUDGET -- explicit arithmetic, comfortably under the 120000ms
 * outer sandbox command budget (helpers.js's OUTER_SANDBOX_BUDGET_MS):
 * COMPLEXITY_TABLE below gives each class a single h.run() timeout (covering
 * BOTH the correctness gate AND the full timing ladder in ONE subprocess --
 * see INCREMENTAL-CHECKPOINT DESIGN below for why splitting into two calls
 * was not necessary), each sized at 3-6x its OWN measured 3-repeat real cost:
 * O(1)/O(log n)=10000ms (negligible real cost either way), O(n)=15000ms
 * (~5.2x measured 2.86s), O(n log n)=20000ms (~6.7x measured 3.00s),
 * O(n^2)=25000ms (~6.3x measured 3.98s), O(n^3)=60000ms (~3.1x measured
 * 19.45s -- the tightest margin of the six, and still real margin, not a
 * hairline). The WORST case across every claimed_complexity is therefore a
 * single 60000ms h.run() call (O(n^3)) -- 60000ms (50%) of margin below the
 * 120000ms outer budget, with no other h.run() call in this verify()
 * (everything happens in one subprocess; h.have('python3') is a free PATH
 * probe, not a spawn). This margin absorbs a colder/slower sandbox CPU AND
 * the "worse actual complexity than claimed" adversarial case (see
 * WORST-CASE MISMATCH TIMEOUT below).
 *
 * WORST-CASE MISMATCH TIMEOUT (a claimed complexity paired with a much worse
 * REAL implementation, whether adversarial or just a buggy submission):
 * e.g. an O(n) claim (sizes up to 2,560,000) paired with a genuinely O(n^2)
 * implementation would take roughly (2,560,000/1600)^2 * 62.5ms =~ 44 HOURS
 * at the largest size -- far beyond any timeout. This is the CORRECT, intended
 * outcome, not a design flaw: h.run()'s timeoutMs kills the child well before
 * that, and a killed/incomplete timing ladder is reported as an honest FAIL
 * ("did not complete within budget for its claimed complexity" -- see
 * INCREMENTAL-CHECKPOINT DESIGN), which is a true statement about the claim
 * not holding up, not a harness fault.
 *
 * INCREMENTAL-CHECKPOINT DESIGN (why ONE h.run() call, not two): the driver
 * re-emits its full progress (via the SAME os.write marker line -- last-line-
 * wins, the same convention h.lastMarked already uses registry-wide) after
 * the correctness gate AND after EVERY size in the timing ladder completes,
 * not just once at the very end. If the largest size (the riskiest, per
 * WORST-CASE MISMATCH TIMEOUT above) never finishes before h.run()'s timeout
 * fires (SIGTERM), os.write()'s already-flushed earlier checkpoint lines
 * (os.write is an unbuffered raw syscall, not Python's buffered print/
 * sys.stdout.write, so a SIGTERM cannot lose a write that already completed)
 * are still readable, and this harness reports a precise, honest reason
 * ("reached N of 3 sizes") instead of an opaque "no output at all". This
 * also means the correctness gate and timing ladder can safely share ONE
 * subprocess (saving a second Python cold-start, ~290-390ms measured on this
 * authoring host via 'python empty.py' -- likely a Windows-specific
 * WindowsApps-launcher-shim cost, not necessarily representative of the
 * Linux E2B sandbox, but treated as a real, conservative pad regardless)
 * rather than needing two separate h.run() calls to isolate "did correctness
 * finish" from "did timing finish".
 *
 * TOLERANCE BANDS -- derivation and the adjacent-class residual. Theoretical
 * per-doubling ratios: O(1)~1.0, O(log n)~1.0-1.1 (negligible over any
 * feasible doubling range), O(n)~2.0, O(n log n)~2.0-2.2 (the log factor
 * barely moves per doubling at these sizes), O(n^2)~4.0, O(n^3)~8.0. Two
 * pairs of these are NOT empirically separable at sizes this budget can
 * afford (an honest, documented residual, not a bug -- see
 * claimed_complexity's own schema.json help text): {O(1), O(log n)} and
 * {O(n), O(n log n)}. This harness therefore uses FOUR tolerance clusters,
 * not six, with boundaries at the GEOMETRIC MIDPOINT between adjacent
 * clusters' theoretical ratios (geometric, not arithmetic, because these are
 * multiplicative ratios: sqrt(1.1*2.0)=1.48, sqrt(2.2*4.0)=2.97,
 * sqrt(4.0*8.0)=5.66 -- rounded to clean numbers below):
 *   {O(1), O(log n)}:       ratio in [0,   1.5)
 *   {O(n), O(n log n)}:     ratio in [1.5, 3.0)
 *   O(n^2):                 ratio in [3.0, 6.0)
 *   O(n^3):                 ratio in [6.0, 30.0)   (30x is a generous sanity
 *                            ceiling, not a tight bound -- real measured
 *                            O(n^3) ratios were 8.6-9.5x; anything past 30x
 *                            at these tiny sizes (100-400) is more consistent
 *                            with an exponential-time implementation than a
 *                            genuine, if noisy, cubic one)
 * These four clusters are wide enough to absorb real sandbox timing noise
 * while still cleanly separating the ONE distinction this category exists to
 * make and that its own required self-tests exercise: O(n) (~2.0x, cluster
 * 2) vs O(n^2) (~4.0x, cluster 3) -- a factor of 2 apart in the theoretical
 * ratio itself, comfortably split by the 3.0 boundary with room on both
 * sides for noise.
 *
 * OVER-CLAIMING FAILS TOO, NOT JUST UNDER-CLAIMING -- a deliberate design
 * decision, not an oversight. A claim of O(n^2) for a genuinely O(n)
 * implementation is a "pessimistic but technically-a-valid-upper-bound"
 * claim under strict Big-O semantics (O(n) subset O(n^2)) -- but this
 * category exists to verify a contributor genuinely understands their OWN
 * algorithm's TIGHT complexity, not merely A valid loose bound. Accepting
 * over-claims would open an obvious, trivial exploit: always claim the
 * slowest class the schema offers (O(n^3)) regardless of your real
 * algorithm, and its wide upper tolerance would rubber-stamp almost
 * anything genuinely polynomial. Both directions are therefore rejected
 * symmetrically by the same two-sided band check -- an O(n) implementation
 * claiming O(n^2) measures ~2.0x, outside O(n^2)'s [3.0, 6.0) band, and
 * fails exactly like an O(n^2) implementation claiming O(n) (measures ~4.0x,
 * outside {O(n),O(n log n)}'s [1.5, 3.0) band) fails.
 *
 * MIN VS MEDIAN ACROSS REPEATS -- min chosen, matching this registry's own
 * existing precedent (performance/harness.js's own bench(): "best = min(...)").
 * OS-scheduling noise (a context switch, a page fault, a GC pause, a cold
 * cache line) is one-directional -- it can only ADD time above the true
 * minimal cost of the work, never subtract time below it. The minimum across
 * a few repeats is therefore the best available point estimate of that true
 * cost; the median (or mean) instead lets a single unlucky repeat drag the
 * estimate upward and would need MORE repeats to converge to the same
 * accuracy, which this category's tight time budget (see SIZE/TIMEOUT TABLE)
 * cannot spend as freely as 'performance' (which already made this same
 * choice for the identical reason).
 *
 * CPU TIME VS WALL-CLOCK -- gated on CPU time (time.process_time()) alone,
 * not "both must match". THE THREAT: implementation_code could compute the
 * correct answer via a genuinely fast algorithm, then call
 * time.sleep(f(n)) to fake looking like a slower claimed complexity while
 * still passing every correctness check (which only runs at small, cheap
 * sizes) and still returning the correct VALUE at every timing size too.
 * time.sleep() burns real wall-clock time but essentially ZERO CPU time, so
 * a sleep-based fake shows near-flat CPU-time growth regardless of n,
 * failing the CPU-ratio check against any claim other than {O(1),O(log n)}
 * (and claiming O(1)/O(log n) for something that needs to fake being SLOWER
 * gains an attacker nothing). CPU time is ALSO, independently, a more
 * ROBUST signal against ordinary sandbox scheduling noise than wall-clock --
 * process_time() only counts time this process was actually scheduled on a
 * CPU, so a momentarily busy/contended sandbox that stalls this process
 * between timeslices inflates wall-clock without inflating CPU time at all.
 * Requiring BOTH wall-clock AND CPU time to independently match the claimed
 * band was considered and rejected: it would only ADD false-reject risk from
 * transient sandbox contention (inflating wall, not CPU, for a genuinely
 * honest submission) without closing any gaming vector beyond what the
 * CPU-only check already closes. Wall-clock is still measured and reported
 * in 'detail' (including an informational, non-gating 'suspiciousSleepPattern'
 * flag: large wall time at the largest size alongside near-floor CPU time)
 * for human-audit visibility, but never participates in the pass/fail
 * decision. RESIDUAL, EXPLICITLY NOT CLOSED (matching this registry's
 * existing "documented, not fully closeable, mitigated by the cost of the
 * attack itself" tier -- e.g. PY_PRELUDE's own raw-syscall self-termination
 * residual in helpers.js): a busy-loop that burns REAL CPU cycles (not
 * sleep()) to fake a slower complexity is not caught by this or any timing-
 * based check -- but doing so is a MUCH more expensive, harder-to-disguise
 * attack than a one-line time.sleep() call (the attacker must actually spend
 * real, scaling CPU work to fake the curve, at which point they are close to
 * just implementing the claimed complexity for real), and is accepted as an
 * open, documented residual rather than chased further here.
 *
 * HARDENING TIER -- matching redis_data_structure_semantics/
 * property_based_testing/schema_conformance_validation (implementation_code
 * is real, contributor-controlled Python, exec()'d for real, in the same
 * process as this driver's own verdict-reporting code):
 *   - h.PY_PRELUDE spliced in verbatim: sys.exit/os._exit/os.abort/
 *     builtins.exit/quit are monkeypatched process-wide to raise instead of
 *     terminating, closing the same exit-forgery gap documented in
 *     helpers.js.
 *   - implementation_code is exec()'d into an ISOLATED namespace ('ns = {}'),
 *     never the driver's own globals/locals -- same isolation
 *     property_based_testing uses for correct_implementation/broken_
 *     implementation/property_test_code.
 *   - Every stage (load, each correctness call, each timing call) is
 *     individually wrapped in its own try/except BaseException, so control
 *     always returns to this driver's own _emit() regardless of what
 *     implementation_code's exec() or any individual solve(n) call does.
 *   - The verdict/checkpoint line is written via a raw os.write(1, ...) fd
 *     write, never print()/sys.stdout.write (which resolve their stream from
 *     the reassignable sys.stdout object fresh on every call).
 *   - MARK is a local inside _main(), never top-level/'__main__'-scope, so a
 *     'sys.modules["__main__"].MARK'-style probe from implementation_code
 *     cannot read and pre-emptively forge it -- same convention property_
 *     based_testing's own module doc comment documents.
 *   - GOES FURTHER THAN THOSE THREE SIBLINGS, deliberately, because CPU-time
 *     INTEGRITY is itself inside this category's trust boundary in a way it
 *     is not for them: 'os.write', 'time.perf_counter', and
 *     'time.process_time' are all attributes of process-wide-singleton
 *     module objects (Python caches modules in sys.modules; 'ns = {}'
 *     isolates NAME BINDINGS, not the underlying module objects a fresh
 *     'import os'/'import time' inside implementation_code's own namespace
 *     would still resolve to). implementation_code doing
 *     'import time; time.process_time = lambda: 0' (or the same for
 *     'os.write') would otherwise corrupt every LATER timing/verdict call
 *     this driver itself makes -- a far more direct and dangerous attack
 *     than the time.sleep() gaming this file's CPU-time defense already
 *     targets, since it can fake a result in EITHER direction, not just
 *     "looks slower". Closed the same way PY_DRIVER already closes the
 *     analogous os._exit risk ('_cr_real_exit = _cr_d_os._exit', captured
 *     BEFORE any submission code runs): this driver captures its OWN
 *     '_real_perf_counter'/'_real_process_time'/'_real_write' local
 *     references at the very top of _main(), strictly before
 *     implementation_code is ever exec()'d, and uses only those captured
 *     references for every later measurement/checkpoint -- a module-
 *     attribute reassignment made afterward cannot retroactively change a
 *     reference this driver already holds directly. ACCEPTED RESIDUAL,
 *     matching PY_PRELUDE's own documented tier: an attack that rewrites the
 *     captured function OBJECT's own underlying code in place (e.g. via
 *     ctypes memory patching) rather than merely reassigning a module
 *     attribute is far more exotic and expensive, and is not attempted to be
 *     closed here.
 */
'use strict';

const crypto = require('crypto');

// Curator-authored correctness sizes must stay cheap regardless of
// claimed_complexity -- these are NEVER used for timing, only to check
// solve(n)'s returned VALUE, so there is no reason for one to be large. 200
// is generous headroom above what any reasonable correctness fixture needs
// (even a genuine O(n^3) implementation at n=200 measured ~100ms above --
// see the module doc comment's SIZE/TIMEOUT TABLE) while still cheap enough
// that several such checks together cannot meaningfully eat into the timing
// budget.
const MAX_CORRECTNESS_N = 200;

// A few repeats per size, MIN taken across them -- see module doc comment
// (MIN VS MEDIAN ACROSS REPEATS).
const REPEATS = 3;

// Below this, a measured millisecond value is treated as "too fast to
// reliably distinguish from zero" rather than trusted as a real signal --
// protects the ratio computation from divide-by-near-zero noise for
// {O(1), O(log n)} claims, whose genuine costs are consistently far below
// this floor (measured: ~0.0012ms for O(1), ~0.01ms for O(log n) -- see
// module doc comment) and would otherwise turn ordinary clock-resolution
// jitter into an arbitrary, meaningless ratio.
const FLOOR_MS = 1.0;

// See module doc comment (SIZE/TIMEOUT TABLE, TOLERANCE BANDS,
// TIMEOUT BUDGET) for the real measurements and reasoning behind every
// number below. 'band' is [inclusiveLow, exclusiveHigh) applied to the
// geometric-mean CPU-time growth ratio across the two consecutive doublings.
const COMPLEXITY_TABLE = {
  'O(1)':       { sizes: [200000, 400000, 800000],      timeoutMs: 10000, band: [0, 1.5] },
  'O(log n)':   { sizes: [1000000, 2000000, 4000000],   timeoutMs: 10000, band: [0, 1.5] },
  'O(n)':       { sizes: [640000, 1280000, 2560000],    timeoutMs: 15000, band: [1.5, 3.0] },
  'O(n log n)': { sizes: [32000, 64000, 128000],        timeoutMs: 20000, band: [1.5, 3.0] },
  'O(n^2)':     { sizes: [1600, 3200, 6400],            timeoutMs: 25000, band: [3.0, 6.0] },
  'O(n^3)':     { sizes: [150, 300, 600],               timeoutMs: 60000, band: [6.0, 30.0] },
};

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/** Geometric mean of the two consecutive-doubling ratios across a 3-element
 * [t(N), t(2N), t(4N)] series -- see module doc comment (TOLERANCE BANDS)
 * for why geometric (not arithmetic) is the correct way to average two
 * multiplicative ratios. Returns null if the series is not exactly 3 real,
 * positive numbers (an incomplete/corrupt timing series must never be
 * silently treated as a real ratio). */
function geometricRatio(ms) {
  if (!Array.isArray(ms) || ms.length !== 3) return null;
  const [a, b, c] = ms;
  if (!(a > 0) || !(b > 0) || !(c > 0)) return null;
  const r1 = b / a;
  const r2 = c / b;
  return Math.sqrt(r1 * r2);
}

/** The whole verification program, run once via a single python3 subprocess.
 * See module doc comment (INCREMENTAL-CHECKPOINT DESIGN, HARDENING TIER) for
 * why this is ONE combined correctness+timing script rather than two, and
 * why _real_perf_counter/_real_process_time/_real_write are captured before
 * implementation_code is ever exec()'d. */
function buildDriverScript(pyPrelude, implCode, expectedJson, sizes, repeats, floorMs, mark) {
  return [
    'import sys, os, json, time',
    '',
    pyPrelude,
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark),
    '    IMPL_SRC = ' + pyStr(implCode),
    '    EXPECTED_JSON = ' + pyStr(expectedJson),
    '    SIZES = ' + JSON.stringify(sizes),
    '    REPEATS = ' + JSON.stringify(repeats),
    '    FLOOR_MS = ' + JSON.stringify(floorMs),
    '    # Captured BEFORE implementation_code ever runs -- see module doc',
    '    # comment (HARDENING TIER) for why this matters: os/time are',
    '    # process-wide singleton modules a fresh import os / import time',
    '    # inside implementation_code\'s own isolated namespace would still',
    '    # resolve to, so a mutated os.write/time.process_time attribute',
    '    # would otherwise corrupt every later measurement/checkpoint this',
    '    # driver itself makes -- these captured local references cannot be',
    '    # retroactively affected by a later reassignment.',
    '    _real_perf_counter = time.perf_counter',
    '    _real_process_time = time.process_time',
    '    _real_write = os.write',
    '    result = {"stage": "started"}',
    '',
    '    def _emit():',
    '        _real_write(1, (MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
    '',
    '    try:',
    '        ns = {}',
    '        exec(compile(IMPL_SRC, "<implementation_code>", "exec"), ns)',
    '    except BaseException as e:',
    '        result["stage"] = "load_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    solve_fn = ns.get("solve")',
    '    if not callable(solve_fn):',
    '        result["stage"] = "solve_not_found"',
    '        _emit(); return',
    '',
    '    try:',
    '        expected_pairs = json.loads(EXPECTED_JSON)',
    '    except BaseException as e:',
    '        result["stage"] = "bad_expected_json"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    # CORRECTNESS GATE -- before any timing measurement (module doc',
    '    # comment, THE CONTRACT). A wrong answer here is a real failure',
    '    # regardless of what the growth curve would have looked like.',
    '    for pair in expected_pairs:',
    '        n, expected = pair[0], pair[1]',
    '        try:',
    '            actual = solve_fn(n)',
    '        except BaseException as e:',
    '            result["stage"] = "correctness_crashed"',
    '            result["n"] = n',
    '            result["error"] = repr(e)',
    '            _emit(); return',
    '        try:',
    '            json.dumps(actual)',
    '        except BaseException as e:',
    '            result["stage"] = "non_serializable_result"',
    '            result["n"] = n',
    '            result["error"] = repr(e)',
    '            _emit(); return',
    '        if actual != expected:',
    '            result["stage"] = "correctness_failed"',
    '            result["n"] = n',
    '            result["expected"] = expected',
    '            result["actual"] = actual',
    '            _emit(); return',
    '',
    '    result["stage"] = "timing_in_progress"',
    '    result["sizes"] = SIZES',
    '    result["wall_ms"] = []',
    '    result["cpu_ms"] = []',
    '    _emit()',
    '',
    '    # GROWTH-CURVE GATE -- min-of-REPEATS per size (module doc comment,',
    '    # MIN VS MEDIAN ACROSS REPEATS), checkpointed after EVERY size so a',
    '    # timeout mid-ladder still leaves a readable, honest partial result',
    '    # (module doc comment, INCREMENTAL-CHECKPOINT DESIGN).',
    '    for size in SIZES:',
    '        wall_samples = []',
    '        cpu_samples = []',
    '        crashed = None',
    '        for _r in range(REPEATS):',
    '            t0w = _real_perf_counter()',
    '            t0c = _real_process_time()',
    '            try:',
    '                solve_fn(size)',
    '            except BaseException as e:',
    '                crashed = repr(e)',
    '                break',
    '            t1w = _real_perf_counter()',
    '            t1c = _real_process_time()',
    '            wall_samples.append((t1w - t0w) * 1000.0)',
    '            cpu_samples.append((t1c - t0c) * 1000.0)',
    '        if crashed is not None:',
    '            result["stage"] = "timing_crashed"',
    '            result["crashed_at_size"] = size',
    '            result["error"] = crashed',
    '            _emit(); return',
    '        result["wall_ms"].append(max(min(wall_samples), FLOOR_MS))',
    '        result["cpu_ms"].append(max(min(cpu_samples), FLOOR_MS))',
    '        _emit()',
    '',
    '    result["stage"] = "ok"',
    '    _emit()',
    '',
    '_main()',
  ].join('\n');
}

module.exports = {
  contract: 'empirical-complexity-claim-vs-reality',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const implCode = h.str(row, 'implementation_code');
    const claimedComplexity = h.str(row, 'claimed_complexity').trim();
    const expectedRaw = h.str(row, 'expected_outputs_at_sizes');

    if (!taskDescription.trim() || !implCode.trim() || !claimedComplexity || !expectedRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, implementation_code, claimed_complexity, or expected_outputs_at_sizes' } };
    }

    const spec = COMPLEXITY_TABLE[claimedComplexity];
    if (!spec) {
      return {
        passed: false,
        logs: 'claimed_complexity "' + claimedComplexity + '" is not one of the recognized values: ' + Object.keys(COMPLEXITY_TABLE).join(', '),
        detail: { reason: 'unrecognized_claimed_complexity' },
      };
    }

    // Structural, cheap check before spending any sandbox time -- the fixed-
    // name convention this category's IMPL-binding relies on (see
    // schema.json's implementation_code help text).
    if (!/^def\s+solve\s*\(/m.test(implCode)) {
      return {
        passed: false,
        logs: 'implementation_code must define a top-level function named exactly solve (e.g. def solve(n):)',
        detail: { reason: 'no_solve_function' },
      };
    }

    const expectedPairs = h.jsonOf(expectedRaw);
    const expectedPairsOk = Array.isArray(expectedPairs) && expectedPairs.length > 0 &&
      expectedPairs.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && p[0] >= 0 && p[0] <= MAX_CORRECTNESS_N);
    if (!expectedPairsOk) {
      return {
        passed: false,
        logs: 'expected_outputs_at_sizes must be a non-empty JSON array of [n, expected_result] pairs, each n a non-negative integer at most ' + MAX_CORRECTNESS_N + ' (correctness sizes are never used for timing and must stay cheap for every claimed_complexity)',
        detail: { reason: 'bad_expected_outputs_at_sizes' },
      };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    const d = h.workdir();
    const mark = '@@ACVROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = buildDriverScript(h.PY_PRELUDE, implCode, JSON.stringify(expectedPairs), spec.sizes, REPEATS, FLOOR_MS, mark);
    const scriptPath = h.path.join(d, 'run_acv.py');
    h.fs.writeFileSync(scriptPath, script);

    // Single h.run() call for the whole correctness+timing driver -- see
    // module doc comment (TIMEOUT BUDGET, INCREMENTAL-CHECKPOINT DESIGN).
    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: spec.timeoutMs });

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: this
    // driver's own checkpoint lines are small, but a verbose stderr/traceback
    // from a crashing implementation_code must not risk truncating the
    // trailing marker line out of the capped stdout either.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }

    if (!out || typeof out !== 'object' || !out.stage) {
      return {
        passed: false,
        logs: r.timedOut
          ? ('implementation_code did not complete even its first checkpoint within the ' + spec.timeoutMs + 'ms budget for a ' + claimedComplexity + ' claim -- almost certainly far slower than claimed')
          : ('could not parse verification output: ' + String(r.stderr || '').slice(0, 500)),
        detail: { reason: 'unparseable_output', timedOut: !!r.timedOut },
      };
    }

    if (out.stage === 'load_failed') {
      return { passed: false, logs: 'implementation_code failed to load: ' + String(out.error || '').slice(0, 800), detail: { reason: 'load_failed' } };
    }
    if (out.stage === 'solve_not_found') {
      return { passed: false, logs: 'implementation_code does not define a callable top-level solve after exec', detail: { reason: 'solve_not_found' } };
    }
    if (out.stage === 'bad_expected_json') {
      return { passed: false, logs: 'harness fault: expected_outputs_at_sizes failed to parse inside the sandbox: ' + String(out.error || '').slice(0, 500), detail: { reason: 'bad_expected_json' } };
    }
    if (out.stage === 'correctness_crashed') {
      return {
        passed: false,
        logs: 'solve(' + out.n + ') raised: ' + String(out.error || '').slice(0, 500),
        detail: { reason: 'correctness_crashed', n: out.n },
      };
    }
    if (out.stage === 'non_serializable_result') {
      return {
        passed: false,
        logs: 'solve(' + out.n + ') returned a value that is not JSON-serializable: ' + String(out.error || '').slice(0, 500),
        detail: { reason: 'non_serializable_result', n: out.n },
      };
    }
    if (out.stage === 'correctness_failed') {
      return {
        passed: false,
        logs: 'solve(' + out.n + ') returned ' + JSON.stringify(out.actual).slice(0, 200) + ' but expected ' + JSON.stringify(out.expected).slice(0, 200),
        detail: { reason: 'correctness_failed', n: out.n },
      };
    }
    if (out.stage === 'timing_crashed') {
      return {
        passed: false,
        logs: 'solve(' + out.crashed_at_size + ') raised during timing measurement (after passing every correctness check): ' + String(out.error || '').slice(0, 500),
        detail: { reason: 'timing_crashed', crashedAtSize: out.crashed_at_size },
      };
    }
    if (out.stage !== 'ok') {
      // "timing_in_progress" (or an unrecognized future stage) with no "ok"
      // -- the ladder was killed mid-flight, most likely by the timeout (see
      // module doc comment, WORST-CASE MISMATCH TIMEOUT).
      const completed = Array.isArray(out.cpu_ms) ? out.cpu_ms.length : 0;
      return {
        passed: false,
        logs: 'timing measurement did not complete (reached ' + completed + ' of ' + spec.sizes.length + ' sizes within the ' + spec.timeoutMs + 'ms budget) -- implementation_code is likely far slower than its claimed ' + claimedComplexity,
        detail: { reason: 'timing_incomplete', completedSizes: completed, timedOut: !!r.timedOut },
      };
    }

    const wallMs = out.wall_ms;
    const cpuMs = out.cpu_ms;
    const cpuRatio = geometricRatio(cpuMs);
    const wallRatio = geometricRatio(wallMs);
    if (cpuRatio == null) {
      return { passed: false, logs: 'harness fault: incomplete timing data despite an "ok" stage', detail: { reason: 'bad_timing_data' } };
    }

    const [lo, hi] = spec.band;
    const matchesClaim = cpuRatio >= lo && cpuRatio < hi;

    // Informational only -- see module doc comment (CPU TIME VS WALL-CLOCK):
    // cpuRatio above is the sole, authoritative pass/fail signal. This flag
    // gives a human auditor a visible breadcrumb for a large-wall/near-floor-
    // CPU gap at the largest size (the time.sleep()-gaming signature) without
    // adding any false-reject risk of its own.
    const largestWall = wallMs[wallMs.length - 1];
    const largestCpu = cpuMs[cpuMs.length - 1];
    const suspiciousSleepPattern = largestWall > 50 && largestCpu <= FLOOR_MS * 1.5 && largestWall > largestCpu * 10;

    return {
      passed: matchesClaim,
      score: matchesClaim ? 1 : 0,
      logs: matchesClaim ? '' : ('measured CPU-time growth ratio ' + cpuRatio.toFixed(2) + 'x per size-doubling does not match claimed ' + claimedComplexity + ' (expected in [' + lo + ', ' + hi + '))'),
      detail: {
        claimedComplexity,
        sizes: spec.sizes,
        wallMs, cpuMs,
        cpuRatio, wallRatio,
        band: spec.band,
        suspiciousSleepPattern,
      },
    };
  },
};
