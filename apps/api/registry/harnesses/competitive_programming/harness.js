/**
 * testcases_io — a solve() entrypoint must satisfy every supplied
 * { input: [args], output } case, AND must hold up at the row's OWN
 * declared `constraints` bound (schema.json: role "rationale", required:
 * true — "Input size and value bounds").
 *
 * `reference_solution` used to be spliced as literal top-level source ahead
 * of the grading code, sharing its process, globals, and stdout -- an extra
 * top-level statement (a forged `print()` + `sys.exit(0)`, or `json.dumps =
 * <forger>`) ran inline and could fabricate the verdict outright, since only
 * the LAST line of stdout was ever trusted. `_real_dumps` is captured as a
 * direct reference BEFORE the contributor's code runs, so a later rebinding
 * of `json.dumps` can't affect it; the solution executes in its own isolated
 * namespace (never the grading loop's globals) inside a try/except that
 * swallows even SystemExit, so the grading loop always runs to completion
 * regardless of what that code prints or how it tries to exit; and the
 * verdict is read from a run-specific, unguessable-at-authoring-time marker
 * emitted once per case (not "whatever the last line of stdout says")
 * requiring every case index to be present exactly once. `_real_print`
 * (despite the name) is NOT a captured `print` reference -- CPython's
 * print() resolves its output stream from `sys.stdout` fresh at EVERY call,
 * never bound at reference-capture time, so a solution reassigning
 * `sys.stdout` to a wrapper object would intercept even an earlier-captured
 * `print` reference's output with no marker-guessing needed at all (the
 * wrapper just rewrites whatever text is written to it). `_real_print` is
 * instead a small function writing directly to file descriptor 1 via
 * `os.write`, which never goes through the `sys.stdout` Python object (or
 * any reassignment of it) at all.
 *
 * `constraints` was, until now, never read at all: only `test_cases`
 * (typically small, comfortable examples) were ever executed, so a
 * reference solution that is only correct/fast for small n -- an O(2^n)
 * exponential blow-up, or an off-by-one that only breaks exactly at a
 * stated boundary like n==0 or n==<declared max> -- sailed through as
 * "execution_verified" as long as the contributor's OWN examples stayed
 * small. Confirmed exploitable: an O(2^n) subset-counting reference
 * solution declaring "1 <= n <= 100000" but only ever tested at n<=4
 * previously passed this harness outright.
 *
 * Fixed the same way regex_generation's harness always runs its own
 * fixed-shape stress probes regardless of what the contributor supplied,
 * rather than trusting the contributor's own cases alone: `constraints` is
 * parsed (tolerantly -- it is free-form prose, not a fixed grammar; see
 * parseConstraintBound's own doc comment for exactly which shapes this can
 * and cannot extract a bound from) for the primary size bound, and:
 *   1. every test_cases[i].input is checked against that bound -- a
 *      contributor's own example that ALREADY exceeds their own declared
 *      max is a real authoring bug (grading correctness on input outside
 *      the row's declared contract) and hard-fails the row.
 *   2. if the bound parses AND test_cases[0].input's shape allows it, one
 *      or two boundary-liveness probes (at the declared min, if stated, and
 *      at/near the declared max) are constructed by resizing
 *      test_cases[0].input's own array/string arguments -- never inventing
 *      new element VALUES, only replicating ones the contributor already
 *      supplied, so every value the probe exercises is already known-valid
 *      for this row -- and run through fn() using this exact same isolated-
 *      namespace/trapped-print/marker machinery.
 *
 * SCOPE, explicitly: the boundary probe proves LIVENESS at declared scale
 * (terminates within a generous multiple of time_limit_ms, does not raise)
 * -- it is NOT a value-correctness check at that size. There is no ground-
 * truth expected output at a size the contributor never supplied a case
 * for, so "held up" means exactly "ran to completion without crashing or
 * timing out", nothing stronger. An unparseable `constraints` string (no
 * recognizable bound pattern) skips these two checks entirely rather than
 * hard-failing the row -- a required-but-unparseable-bounds string is a
 * separate, milder authoring problem than stating a bound and then either
 * violating it or failing to hold up at it.
 */
'use strict';

const crypto = require('crypto');

// Large enough to expose an O(n^2)/exponential blow-up at realistic
// declared sizes; bounded so this harness's OWN probe-construction and
// in-sandbox execution stay within a sane time/memory footprint even when a
// row declares a bound far larger than this (2*10^6+ has been observed in
// this dataset's own corpus). Matches the single most common declared
// upper bound observed in that corpus (200,000), so the common case is
// tested at (not merely "near") its real declared bound.
const BOUNDARY_SIZE_CAP = 200000;

// Recognized bound-introducing phrases, matched in the order they appear in
// the text -- see parseConstraintBound below for why "first match wins"
// rather than "largest number wins".
const BOUND_CONTEXT_RE = /<=|≤|\bup to\b|\bat most\b|\bno more than\b|\bmaximum of\b|\bmay reach\b/gi;

/**
 * Parse a NUMBER token starting at the front of `text` (leading whitespace
 * ignored), in any of the three notations this dataset's own `constraints`
 * strings use: coefficient*10^power ("2*10^6"), bare 10^power ("10^4", no
 * explicit coefficient), or a plain integer with optional comma grouping
 * ("200,000"). Order matters: trying the plain-integer form first would
 * misparse "10^4" as the plain integer "10".
 */
function parseNumAt(text) {
  let m = /^\s*(\d+)\s*\*\s*10\s*\^\s*(\d+)/.exec(text);
  if (m) return parseInt(m[1], 10) * Math.pow(10, parseInt(m[2], 10));
  m = /^\s*10\s*\^\s*(\d+)/.exec(text);
  if (m) return Math.pow(10, parseInt(m[1], 10));
  m = /^\s*(\d[\d,]*)/.exec(text);
  if (m) {
    const v = parseInt(m[1].replace(/,/g, ''), 10);
    return isNaN(v) ? null : v;
  }
  return null;
}

/**
 * Extract the PRIMARY size bound from a free-form `constraints` string.
 * Real examples from this dataset's own reference/test corpora include
 * "1 <= n <= 10^4, -10^4 <= value <= 10^4", "0 <= |V| <= 200,000 and
 * 0 <= |E| <= 400,000. ...", "Up to 200,000 vertices and 400,000 edges; ...",
 * "Amount <= 100,000; ...", "Each string length is at most 3,000; ...", and
 * "Source length may reach 200,000 ...".
 *
 * Returns the FIRST recognizable bound in the text, not the largest number
 * anywhere in it: this dataset's own convention consistently states the
 * SIZE bound (the one governing array/string length) before any VALUE bound
 * (the one governing individual element magnitude, e.g. "-10^9 <= value <=
 * 10^9"), and a value bound is very often numerically larger than the size
 * bound. Taking the max instead of the first would, for a row like
 * "2 <= n <= 10^4, -10^9 <= value <= 10^9", construct a boundary probe with
 * an array of ~10^9 elements instead of the intended ~10^4 -- confirmed via
 * this exact shape occurring in the real reference dataset. Also recovers,
 * where present, the paired lower bound from the SAME "<=" clause (e.g. the
 * "1" in "1 <= n <= 10^4") -- never a fabricated default, since a wrong
 * assumed minimum (testing n=0 against a solution that legitimately assumes
 * the row's own stated n>=1) would be a false-fail this harness must not
 * introduce; a row with no explicit lower bound simply gets no min-probe.
 *
 * Returns null (not a guess) when nothing recognizable is found -- e.g.
 * "array is strictly sorted" or "values fit in 32-bit signed int" alone
 * carry no extractable bound; callers must treat null as "skip the extra
 * checks for this row", never as a hard failure.
 */
function parseConstraintBound(text) {
  text = String(text || '');
  BOUND_CONTEXT_RE.lastIndex = 0;
  let m;
  while ((m = BOUND_CONTEXT_RE.exec(text))) {
    const after = text.slice(m.index + m[0].length);
    const max = parseNumAt(after);
    if (max == null || !(max > 0)) continue;
    let min = null;
    let varName = null;
    if (m[0] === '<=' || m[0] === '≤') {
      const clauseStart = Math.max(text.lastIndexOf(',', m.index), text.lastIndexOf(';', m.index), text.lastIndexOf('.', m.index)) + 1;
      const before = text.slice(clauseStart, m.index);
      // The lower bound sits at the START of this clause ("MIN <= var <=
      // MAX"), not necessarily immediately before the operator just
      // matched -- a variable name sits between the two "<="s.
      const lowMatch = /^\s*(\d[\d,]*)\s*(?:<=|≤)/.exec(before);
      let nameRegion = before;
      if (lowMatch) {
        const lowVal = parseInt(lowMatch[1].replace(/,/g, ''), 10);
        if (!isNaN(lowVal)) min = lowVal;
        nameRegion = before.slice(lowMatch[0].length);
      }
      // Bug 1 fix: the variable name this bound actually describes sits
      // between the low-bound numeral just consumed above and the "<="
      // just matched (e.g. "amount" in "0 <= amount <= 10^4", "Amount" in
      // "Amount <= 100,000") -- see extractVarNameBefore's own doc comment
      // for exactly how narrowly this is trusted. Recovering this lets
      // scaleArgsToSize's caller correlate the bound to the SPECIFIC
      // solve() parameter it describes, instead of resizing whichever
      // array/string argument merely comes first positionally regardless
      // of whether that argument has anything to do with this bound.
      varName = extractVarNameBefore(nameRegion);
    }
    return { max, min, varName };
  }
  return null;
}

/**
 * Best-effort extraction of the variable/parameter name a "<=" bound
 * describes, from the text immediately preceding the operator within its
 * own clause (with any paired lower-bound numeral already stripped by the
 * caller) -- e.g. "amount" from "0 <= amount <= 10^4", "coin value" from
 * "1 <= coin value <= 10^4", "Amount" from "Amount <= 100,000". Deliberately
 * narrow: only a short, trailing run of letters/digits/spaces/underscores
 * immediately abutting the operator is trusted (anchored at the END of the
 * given text) -- anything further back (earlier clauses, connective words,
 * non-identifier punctuation like the "|V|" graph-notation example in
 * parseConstraintBound's own doc comment) is deliberately NOT captured,
 * since it is just as likely to be unrelated prose as an actual variable
 * name. Returns null (not a guess) when nothing recognizable abuts the
 * operator -- callers must treat null the same as an unmatched varName.
 */
function extractVarNameBefore(text) {
  const m = /([A-Za-z_][A-Za-z0-9_ ]{0,30}?)\s*$/.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

/**
 * Tokenize an identifier/free-text name the same way code_translation's own
 * tokens() helper does (camelCase/snake_case/space-aware, lowercased) --
 * duplicated locally rather than imported since every harness.js in this
 * registry is a standalone CommonJS file with no imports beyond Node
 * builtins (it is inlined into a template literal).
 *
 * Deliberately DOES NOT apply code_translation's own length>=2 short-
 * fragment filter: that filter exists there to drop generic filler words
 * (prepositions, articles) out of free-form prose before a loose "ANY
 * shared token" overlap check, where a stray one-letter fragment is noise.
 * matchVarNameToParamIndex (this file's only caller of tokens()) instead
 * requires the FULL token SET to match exactly -- a single short token
 * carries no comparable false-positive risk there, since it can only match
 * another name that ALSO tokenizes to that exact single token. Filtering
 * short tokens here would instead silently defeat correlation for the most
 * common shape of variable name in this exact domain: a bound stated over
 * a single-letter identifier (`n`, `k`, `m`, `r`, `c`) -- tokens("n") would
 * come back [] and matchVarNameToParamIndex would return null even when
 * `solve()` declares a same-named parameter, unable to tell "no name" from
 * "a name too short to trust." Confirmed via this exact case: a
 * `solve(coins, n)` signature bounded by "... <= n <= ...` never
 * correlated to the `n` parameter with the length>=2 filter in place.
 */
function tokens(s) {
  return String(s || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Extract the reference_solution's declared `solve(...)` parameter names,
 * in order, from a simple top-level `def solve(...):` match -- this
 * dataset's schema.json fixes the contract to a single required Python
 * `solve()` entrypoint (see schema.json's `reference_solution.help`), so no
 * multi-language detection is needed here. Splits the parameter list on
 * top-level commas only (a default value can itself legally contain a comma,
 * e.g. `def solve(arr, opts={"a": 1, "b": 2})`), then strips each parameter
 * down to its bare name (drops `: type` hints, `=default` values, and a
 * leading `*`/`**` for varargs/kwargs). Returns [] (not a guess) when no
 * `def solve(` is found or its parameter list can't be parsed -- callers
 * must treat that the same as "no correlation possible".
 */
function extractSolveParamNames(source) {
  const m = /\bdef\s+solve\s*\(([^)]*)\)/.exec(String(source || ''));
  if (!m || !m[1].trim()) return [];
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts
    .map(function (p) { return p.split('=')[0].split(':')[0].replace(/^\*+/, '').trim(); })
    .filter(Boolean);
}

/**
 * Match a bound's extracted `varName` (see extractVarNameBefore) against the
 * reference_solution's declared parameter names (see extractSolveParamNames),
 * returning the matching parameter's index or null. Requires the FULL token
 * SET to match exactly (e.g. "coin value" <-> "coinValue"; "amount" <->
 * "amount") rather than code_translation's looser hasMeaningfulOverlap (ANY
 * shared non-generic token) -- a partial overlap here (e.g. "amount" vs
 * "totalAmount", or "value" appearing in both "coin value" and some
 * unrelated "returnValue" parameter) would fabricate a correlation between
 * two DIFFERENT parameters, which is worse than no correlation at all (see
 * this file's Bug 1 fix: "do NOT fall back to guessing at some other
 * unrelated argument"). Returns null when varName is empty/unset or matches
 * no parameter -- callers must fall back to the uncorrelated heuristic.
 */
function matchVarNameToParamIndex(varName, paramNames) {
  if (!varName || !paramNames || !paramNames.length) return null;
  const vTok = tokens(varName);
  if (!vTok.length) return null;
  const vSet = new Set(vTok);
  for (let i = 0; i < paramNames.length; i++) {
    const pTok = tokens(paramNames[i]);
    if (pTok.length && pTok.length === vTok.length && pTok.every(function (t) { return vSet.has(t); })) {
      return i;
    }
  }
  return null;
}

/**
 * Every test_cases[i].input array/string argument longer than the row's OWN
 * declared max is a real authoring bug: the harness would otherwise be
 * "verifying" correctness on input the row itself declares out of contract.
 * Checked against the RAW parsed max (uncapped by BOUNDARY_SIZE_CAP) -- this
 * is a data-validation check against what the row itself claims, unrelated
 * to how large a boundary probe this harness is willing to construct.
 */
function findBoundViolations(cases, rawMax) {
  if (rawMax == null) return [];
  const violations = [];
  cases.forEach(function (c, i) {
    const args = Array.isArray(c.input) ? c.input : [c.input];
    args.forEach(function (a, argIdx) {
      let len = null;
      if (Array.isArray(a)) len = a.length;
      else if (typeof a === 'string') len = a.length;
      if (len != null && len > rawMax) violations.push({ case: i, arg: argIdx, len, max: rawMax });
    });
  });
  return violations;
}

/**
 * Build a boundary-probe args array shaped like `template` (test_cases[0]
 * .input). Never invents new element VALUES: an array is filled by cycling
 * the template's OWN existing elements (arg[i % arg.length]), a string by
 * repeating the template's own characters -- every value the probe ever
 * sees already appeared in a contributor-supplied case, so it is guaranteed
 * shape/type/range-valid for this row (this is deliberately simpler than
 * reconstructing a semantically valid large instance -- e.g. a graph's
 * edges are just the original edges repeated, not new edges over a larger
 * vertex set -- see the module doc comment's SCOPE paragraph: this probes
 * liveness, not a specific data shape's semantics).
 *
 * `targetArgIndex` (Bug 1 fix), when not null, is the index into `template`
 * that the row's parsed constraints bound was actually correlated to (see
 * verify()'s call site, parseConstraintBound's `varName`, and
 * matchVarNameToParamIndex) -- a PROVEN correlation to a specific declared
 * solve() parameter, not a positional guess. When present:
 *   - if that argument is itself a bare number, it unambiguously IS the
 *     bound's own size variable (e.g. "amount" in a solve(coins, amount)
 *     signature bounded by "0 <= amount <= 10^4") and is replaced with
 *     targetLen directly -- no OTHER argument is touched, since nothing
 *     else was shown to be governed by this bound (confirmed regression:
 *     previously this harness resized the unrelated `coins` array to 10000
 *     elements while leaving `amount` stale at its example value, so the
 *     probe never actually exercised the declared bound at all).
 *   - if that argument is array/string-shaped, ONLY it is resized (subject
 *     to the same matrix protection described below) -- sibling arguments
 *     that were not correlated to this bound are left alone rather than
 *     uniformly resized.
 *   - if that argument is neither (unexpected shape), no probe is built at
 *     all: a proven-but-unusable correlation must not fall back to guessing
 *     at some other, unrelated argument.
 *
 * When `targetArgIndex` is null (constraints unparseable, or its varName
 * didn't match any declared solve() parameter), this falls back to the
 * ORIGINAL heuristic -- documented here as exactly that, a heuristic, not a
 * proven correlation: every top-level array/string argument gets resized to
 * `targetLen` uniformly (some correlation is still better than none for the
 * common single-array-argument case), while a plain scalar (non-array,
 * non-string) argument is left UNCHANGED, with one exception: when the
 * ENTIRE args list is a single bare number (e.g. solve(n) for an
 * n-queens-style problem), that number unambiguously IS the size parameter
 * itself and is replaced with targetLen directly.
 *
 * A NESTED array (every element itself an array -- a matrix/grid, or a
 * list-of-tuples like edges/intervals) is always left UNCHANGED rather than
 * resized on the outer dimension alone, correlated or not: for a genuine
 * matrix argument the declared bound very often governs BOTH dimensions
 * together (the standard "n x n matrix" convention), and resizing only the
 * outer length produces a structurally-inconsistent instance (e.g. 100 rows
 * of width 3) that crashes even a genuinely correct solution on a dimension
 * mismatch that has nothing to do with the solution's own correctness.
 * Confirmed against this exact dataset's own "rotate an n x n matrix in
 * place" reference solution: scaling only the outer array raised an
 * IndexError from a completely correct rotation implementation. A row whose
 * only resizable-looking argument is matrix/grid-shaped therefore gets no
 * boundary probe at all -- an accepted, documented residual, the same class
 * as an unparseable `constraints` string: this check trades that narrower
 * coverage gap for zero risk of fabricating a structurally invalid
 * instance.
 *
 * Bug 2 fix: whenever an array/string argument at index `ri` actually gets
 * resized (correlated or fallback path), any OTHER plain-number argument
 * whose ORIGINAL value exactly equals that array's/string's ORIGINAL length
 * is synced to the new target length too. This is a strong, narrow signal
 * (not a positional guess) that the number is a count mirroring that
 * specific collection -- e.g. a solve(n, arr) signature where n === len(arr)
 * -- and without it, a min-probe that shrinks arr below a now-stale n
 * crashes an otherwise-correct reference solution on an out-of-range access
 * (a false hard-fail, not a genuine solution defect). A bare number that
 * does NOT match any resized array's original length (e.g. max-flow's
 * numNodes/source/sink, none of which happen to equal any array's length)
 * is left untouched exactly as before -- this must not regress into
 * guessing at those.
 *
 * Returns null when NOTHING in `template` actually changes size at
 * `targetLen` (every argument is a left-alone scalar/nested-array, every
 * resizable argument already happens to be exactly `targetLen` long, or a
 * correlated target index turned out not to be resizable) -- a probe
 * identical to the case it was built from proves nothing new and is not
 * worth the extra execution.
 */
function scaleArgsToSize(template, targetLen, targetArgIndex) {
  if (targetLen == null || targetLen < 0 || !Array.isArray(template)) return null;
  if (template.length === 1 && typeof template[0] === 'number') {
    return targetLen === template[0] ? null : [targetLen];
  }

  const hasCorrelatedTarget =
    typeof targetArgIndex === 'number' && targetArgIndex >= 0 && targetArgIndex < template.length;

  if (hasCorrelatedTarget) {
    const targetArg = template[targetArgIndex];
    if (typeof targetArg === 'number') {
      // This scalar IS the bound's own variable -- no sibling argument was
      // shown to be governed by it, so nothing else is touched.
      if (targetLen === targetArg) return null;
      // Bug 4 fix: shrinking this scalar below its original value is only
      // safe to probe when nothing ELSE in the same call plausibly holds
      // index/reference values bounded BY it. A nested-array sibling
      // (edges/intervals-style: a list of [node, node, weight] tuples --
      // the exact shape this function's own matrix protection further
      // below already treats as too structurally entangled to resize
      // blindly) is precisely that signal. Confirmed live: a min-probe
      // shrinking a max-flow row's own `n` to 0 left its sibling `edges`
      // list referencing node indices 0-3 completely untouched, producing
      // solve(n=0, edges=[[0,1,...], ...]) -- a self-contradictory
      // instance the reference solution's OWN defensive bounds check
      // correctly rejected. That is a false fail on this harness's part,
      // not a defect in the reference solution or the row's data. Growing
      // this scalar is unaffected and stays fully probed: a larger n never
      // invalidates indices that were already valid under the smaller,
      // original n. Accepted residual, not attempted here (same class as
      // the matrix carve-out below): a bare scalar sibling that is ALSO an
      // index into this same collection (e.g. a lone `source`/`sink` with
      // no accompanying edges array) is not detected by this check and
      // could in principle hit the same failure mode -- not observed in
      // either real corpus (New_Tester ~100 rows, sample_datasets 25 rows)
      // without a nested-array sibling also present.
      const hasNestedArraySibling = template.some(function (a, i) {
        return i !== targetArgIndex && Array.isArray(a) && a.length &&
          a.some(function (el) { return Array.isArray(el); });
      });
      if (targetLen < targetArg && hasNestedArraySibling) return null;
      const out = template.slice();
      out[targetArgIndex] = targetLen;
      return out;
    }
    if (!(Array.isArray(targetArg) || typeof targetArg === 'string')) {
      // Correlated to something not resizable (unexpected shape) -- no
      // probe rather than a guess at some other, unrelated argument.
      return null;
    }
    // else: array/string -- falls through to the general resize loop below,
    // restricted to ONLY this index via onlyIdx.
  }

  const onlyIdx = hasCorrelatedTarget ? targetArgIndex : null;
  const origLens = template.map(function (a) {
    if (Array.isArray(a)) return a.length;
    if (typeof a === 'string') return a.length;
    return null;
  });

  let changed = false;
  const resizedIdxs = [];
  const out = template.map(function (arg, idx) {
    if (onlyIdx != null && idx !== onlyIdx) return arg;
    if (Array.isArray(arg)) {
      if (arg.length && arg.some(function (el) { return Array.isArray(el); })) return arg;
      if (targetLen === arg.length) return arg;
      changed = true;
      resizedIdxs.push(idx);
      if (targetLen === 0) return [];
      if (arg.length === 0) return arg.slice();
      const scaled = new Array(targetLen);
      for (let i = 0; i < targetLen; i++) scaled[i] = arg[i % arg.length];
      return scaled;
    }
    if (typeof arg === 'string') {
      if (targetLen === arg.length) return arg;
      changed = true;
      resizedIdxs.push(idx);
      if (targetLen === 0) return '';
      if (arg.length === 0) return arg;
      if (arg.length >= targetLen) return arg.slice(0, targetLen);
      const reps = Math.ceil(targetLen / arg.length);
      return arg.repeat(reps).slice(0, targetLen);
    }
    return arg;
  });

  if (!changed) return null;

  // Bug 2 fix -- see doc comment above.
  for (let i = 0; i < out.length; i++) {
    if (typeof template[i] !== 'number') continue;
    if (resizedIdxs.indexOf(i) !== -1) continue;
    const matchesResized = resizedIdxs.some(function (ri) {
      return origLens[ri] != null && template[i] === origLens[ri];
    });
    if (matchesResized) out[i] = targetLen;
  }

  return out;
}

module.exports = {
  contract: 'testcases_io',
  requires: ['python3'],

  verify(row, h) {
    const solution = h.str(row, 'reference_solution');
    const cases = Array.isArray(row.test_cases) ? row.test_cases : h.jsonOf(h.str(row, 'test_cases'));
    if (!solution) return { passed: false, detail: { reason: 'no reference_solution' } };
    if (!Array.isArray(cases) || !cases.length) {
      return { passed: false, detail: { reason: 'test_cases is not a non-empty array', got: typeof row.test_cases } };
    }

    // See parseConstraintBound's own doc comment: tolerant, prose-aware
    // extraction of the row's declared size bound. `bound` is null when
    // `constraints` carries no recognizable pattern -- both checks below
    // are skipped gracefully in that case, never hard-failed for it.
    const bound = parseConstraintBound(h.str(row, 'constraints'));

    if (bound) {
      const violations = findBoundViolations(cases, bound.max);
      if (violations.length) {
        // The contributor's OWN test data already exceeds their OWN
        // declared valid range -- a real authoring bug, not a solution
        // defect. Hard fail rather than silently grade an out-of-contract
        // case as if it were in-contract.
        return {
          passed: false,
          logs: 'test_cases contains an argument longer than this row\'s own declared constraints bound (max=' + bound.max + ')',
          detail: { boundViolations: violations.slice(0, 5), declaredBound: bound },
        };
      }
    }

    const limitMs = parseInt(h.str(row, 'time_limit_ms') || '1000', 10) || 1000;
    const d = h.workdir();
    const mark = '@@ROW_' + crypto.randomBytes(12).toString('hex') + '_';

    // Bug 1 fix: correlate the parsed bound's variable name (if any) to a
    // SPECIFIC declared solve() parameter, by index, so the probe below
    // resizes/sets the argument the bound actually describes rather than
    // whichever array/string argument merely comes first positionally. Both
    // helpers degrade to [] / null on anything unparseable/unmatched, which
    // scaleArgsToSize's uncorrelated fallback path already handles.
    const solveParamNames = extractSolveParamNames(solution);
    const targetArgIndex = bound && bound.varName ? matchVarNameToParamIndex(bound.varName, solveParamNames) : null;

    // Boundary-liveness probes -- see scaleArgsToSize's and the module doc
    // comment's SCOPE paragraph for exactly what these do and do not prove.
    // Only constructed when the bound parsed AND test_cases[0].input has a
    // shape this harness can safely resize; otherwise this degrades to "no
    // extra probe for this row" rather than guessing.
    const probes = [];
    if (bound && Array.isArray(cases[0].input)) {
      const maxLen = Math.min(bound.max, BOUNDARY_SIZE_CAP);
      const maxArgs = scaleArgsToSize(cases[0].input, maxLen, targetArgIndex);
      if (maxArgs) probes.push({ probe: 'max@' + maxLen, input: maxArgs });
      if (bound.min != null && bound.min !== maxLen) {
        const minArgs = scaleArgsToSize(cases[0].input, bound.min, targetArgIndex);
        if (minArgs) probes.push({ probe: 'min@' + bound.min, input: minArgs });
      }
    }

    // Probes are appended to the SAME cases array the contributor's own
    // test_cases already populate, and graded by the SAME per-entry
    // try/except loop below (one execution, one isolated namespace, one
    // marker scheme) -- not a second, parallel execution path.
    const allCases = cases.concat(probes);

    h.fs.writeFileSync(h.path.join(d, 'run.py'), [
      'import json as _json, os',
      // A captured `print` reference is NOT equivalent to a captured
      // OUTPUT CHANNEL: CPython's print() resolves its target stream from
      // `sys.stdout` FRESH at every call (never bound at reference-capture
      // time), so a submission reassigning `sys.stdout` to a wrapper object
      // intercepts even this captured `_real_print`'s output -- no marker-
      // guessing needed at all, since the wrapper just rewrites whatever
      // text is written to it. os.write(1, ...) talks directly to the real
      // OS file descriptor, bypassing the `sys.stdout` Python object (and
      // any reassignment of it) entirely.
      'def _real_print(_s):',
      '    os.write(1, (_s + "\\n").encode("utf-8", "replace"))',
      '_real_dumps = _json.dumps',
      // json.loads, NOT a Python literal: JSON true/false/null are undefined
      // NAMES in Python and would raise NameError on the first boolean case.
      'CASES = _json.loads(' + JSON.stringify(JSON.stringify(allCases)) + ')',
      '',
      '_solution_globals = {}',
      'try:',
      '    exec(compile(' + JSON.stringify(solution) + ', "reference_solution", "exec"), _solution_globals)',
      'except BaseException:',
      '    pass  # whatever the submission\'s top-level code did, grading below still runs',
      '',
      'fn = _solution_globals.get("solve")',
      'if fn is None:',
      '    _real_print(' + JSON.stringify(mark) + ' + _real_dumps({"noEntrypoint": True}))',
      'else:',
      // Tuples and lists are the same sequence for comparison: a solution
      // returning [(1,6)] satisfies an expectation of [[1,6]].
      '    def canon(v):',
      '        if isinstance(v, (list, tuple)): return [canon(x) for x in v]',
      '        if isinstance(v, dict): return {k: canon(x) for k, x in v.items()}',
      '        return v',
      '    for i, c in enumerate(CASES):',
      '        args = c.get("input")',
      '        if not isinstance(args, list): args = [args]',
      '        probe_name = c.get("probe")',
      '        try:',
      '            got = fn(*args)',
      '            if probe_name:',
      // A boundary probe has no ground-truth expected value at this size --
      // "ok" here means only "returned without raising", never a value
      // comparison. See this file's own module doc comment (SCOPE).
      '                row_out = {"i": i, "ok": True, "probe": probe_name}',
      '            else:',
      '                ok = canon(got) == canon(c.get("output"))',
      '                row_out = {"i": i, "ok": ok, "got": repr(got)[:120], "want": repr(c.get("output"))[:120]}',
      '        except BaseException as e:',
      '            row_out = {"i": i, "ok": False, "err": repr(e)[:160]}',
      '            if probe_name: row_out["probe"] = probe_name',
      '        _real_print(' + JSON.stringify(mark) + ' + _real_dumps(row_out))',
    ].join('\n'));

    // Generous headroom for the contributor's OWN test_cases, exactly as
    // before. Each boundary probe adds its OWN modest, fixed allowance
    // rather than compounding the *20-per-case multiplier meant for small
    // example cases: a probe deliberately runs at declared SCALE and may
    // legitimately take longer than an example-sized case even for a
    // genuinely correct O(n log n) solution.
    //
    // Bug 3 fix: the ceiling here USED TO be 120000ms -- exactly
    // EXECUTION_RUNNER_TIMEOUT_MS's default (src/config.ts), the OUTER e2b
    // sandbox command budget, whose clock starts before this h.run call even
    // begins (sandbox prologue + node startup + file writes) and so always
    // wins that race, tearing the whole command down with an ambiguous
    // provider-level failure instead of this harness's own clean `timedOut`
    // verdict. Trimmed to 100000ms (20s margin), matching the convention
    // build_dependency_resolution and package_publishing's harnesses both
    // settled on for the identical shape of bug.
    const perProbeMs = Math.min(Math.max(limitMs * 20, 5000), 15000);
    const budget = Math.min(Math.max(limitMs * cases.length * 20, 30000) + perProbeMs * probes.length, 100000);
    const r = h.run('python3', [h.path.join(d, 'run.py')], { cwd: d, timeoutMs: budget });
    if (r.status !== 0) {
      return {
        passed: false,
        logs: (r.timedOut ? '[timed out] ' : '') + String(r.stderr).slice(0, 1500),
        detail: { ranClean: false, boundaryProbesAttempted: probes.map(function (p) { return p.probe; }) },
      };
    }

    const markedLines = String(r.stdout)
      .split('\n')
      .filter(function (line) { return line.indexOf(mark) === 0; })
      .map(function (line) { return h.jsonOf(line.slice(mark.length)); })
      .filter(Boolean);

    if (markedLines.length === 1 && markedLines[0].noEntrypoint) {
      return { passed: false, logs: 'no solve() entrypoint found', detail: {} };
    }

    // Every case index must appear exactly once -- a solution that exits
    // early, crashes the interpreter, or otherwise short-circuits the loop
    // produces fewer marked rows than cases.length, which must fail rather
    // than be padded or silently ignored.
    const byIndex = new Map();
    markedLines.forEach(function (m) {
      if (m && typeof m.i === 'number') byIndex.set(m.i, m);
    });
    const rows = [];
    for (let i = 0; i < cases.length; i++) {
      const m = byIndex.get(i);
      if (m) rows.push(m);
    }
    const passedCount = rows.filter(function (x) { return x.ok; }).length;
    const ok = rows.length === cases.length && passedCount === rows.length;

    if (!ok) {
      return {
        passed: false,
        score: cases.length ? passedCount / cases.length : 0,
        testsRun: rows.length,
        logs: JSON.stringify(rows.filter(function (x) { return !x.ok; }).slice(0, 5)),
        detail: { cases: cases.length, casesPassed: passedCount, rowsReported: rows.length },
      };
    }

    // test_cases all passed -- now require the boundary probe(s) (if any
    // were constructed) to ALSO hold up. This is the check that catches an
    // O(2^n)/off-by-one solution that is only correct/fast on the
    // contributor's own small examples; see this file's module doc comment
    // (SCOPE) for exactly what "hold up" does and does not mean here.
    let probeRows = [];
    let probesOk = true;
    if (probes.length) {
      for (let i = 0; i < probes.length; i++) {
        const m = byIndex.get(cases.length + i);
        if (m) probeRows.push(m);
      }
      probesOk = probeRows.length === probes.length && probeRows.every(function (x) { return x.ok; });
    }

    if (!probesOk) {
      return {
        passed: false,
        score: 0,
        testsRun: rows.length,
        logs: 'reference_solution did not hold up at its own declared constraints bound: ' +
          JSON.stringify(probeRows.filter(function (x) { return !x.ok; }).slice(0, 5)),
        detail: {
          cases: cases.length,
          casesPassed: passedCount,
          boundaryCheck: 'failed',
          declaredBound: bound,
          probesAttempted: probes.map(function (p) { return p.probe; }),
          probesCompleted: probeRows.length,
        },
      };
    }

    return {
      passed: true,
      score: cases.length ? passedCount / cases.length : 0,
      testsRun: rows.length,
      logs: '',
      detail: {
        cases: cases.length,
        casesPassed: passedCount,
        rowsReported: rows.length,
        boundaryCheck: probes.length ? 'passed' : (bound ? 'skipped_no_scalable_arg' : 'skipped_unparseable_constraints'),
        declaredBound: bound || null,
        probesAttempted: probes.map(function (p) { return p.probe; }),
      },
    };
  },
};
