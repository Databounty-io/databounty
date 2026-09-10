/**
 * distribution-match — flag_evaluation_code is run against a simulated
 * population and the OBSERVED enabled-rate must fall within the tolerance
 * expected_distribution documents (both fields are prose: "flag enabled for
 * 30% ± 2% of simulated users").
 *
 * This dataset has far more verification shapes than a single mechanism can
 * cover: plain hash-bucket rollout, sticky-assignment-across-repeated-calls,
 * weighted N-way variant splits, attribute-targeted rollouts, salted/
 * multi-salt rollouts, cross-process determinism claims, and chi-square-
 * style bucket uniformity are all genuinely different things to check, not
 * variations of one contract. Scoped to what's mechanically tractable
 * without guessing at population composition from free-form prose —
 * everything else reports runtimeUnavailable with a specific reason rather
 * than a fabricated verdict.
 *
 * Covered: plain is_enabled(user_id, pct) rollouts, sticky-assignment
 * verification, assign_variant(...)-style weighted N-way splits, and (as of
 * this pass) a bounded class of attribute-targeted is_enabled(user)
 * dict-based rollouts.
 *
 * NOT covered: salted/multi-salt is_enabled(user_id, pct, salt, ...)
 * rollouts (>=3 positional args), cross-process determinism, monotonic-
 * growth-across-percentages, and chi-square-style bucket-uniformity checks.
 * These were left as documented residuals rather than folded into this
 * pass: unlike attribute-targeting, none of them had evidenced, measured
 * production impact (a real bounty's execution-pass-rate collapsing to 0%),
 * and each is a genuinely different mechanism worth its own focused pass
 * rather than risking this one's quality via scope creep.
 *
 * --- Attribute-targeted rollouts (is_enabled(user) dict-based) -----------
 *
 * Real production evidence this was a live, high-frequency gap, not a
 * hypothetical: a real "advanced"-difficulty feature-flag bounty had 90/90
 * submitted items finally accepted, but a 0% real execution-pass rate — all
 * 30 submissions from one contributor sampled used the exact same
 * `def is_enabled(user)` single-dict-param shape, none the plain
 * `is_enabled(user_id, pct)` shape this harness already covered. Every one
 * of the 90 items landed in a SINGLE human-audit window (nothing was
 * mechanically verifiable, so a validator had to manually judge all of
 * them) — a direct consequence of this gap, not a separate problem.
 *
 * This is intentionally NOT a natural-language interpreter of arbitrary
 * eligibility/population prose — that would be a fundamentally different,
 * much riskier kind of "verification" than everything else in this file,
 * which is all deterministic pattern-matching over a constrained
 * vocabulary. The eligibility predicate itself is never parsed from prose
 * at all: instead, the real `flag_evaluation_code` is executed for real
 * (mirroring buildSimplePctScript's own philosophy — run the real code,
 * check the real observed rate) against a synthetic population built from a
 * SEPARATE, narrow grammar recognized in `simulated_user_contexts`. Two
 * mechanical extraction steps, both over a constrained shape, neither one
 * "reading" free prose for meaning:
 *
 * 1. Which attribute keys does the code actually read? Extracted directly
 *    from flag_evaluation_code's own `<param>['key']` / `<param>.get('key')`
 *    occurrences (extractCodeAttributeRefs) — code shape, not prose,
 *    exactly the class of signal this file already trusts elsewhere
 *    (isAttributeDict's own params-shape detection). Also collects every
 *    `<param>['key'] == 'literal'` / `!=` comparison (either operand
 *    order), used below to anchor a population-clause label to the EXACT
 *    literal spelling the code compares against, never a guessed spelling.
 *
 * 2. Does simulated_user_contexts describe a value for EVERY one of those
 *    keys, using ONE of these recognized clause shapes (parsePopulationDistribution)?
 *      a. "1/3 each across A, B, and C plans/regions/countries/devices" —
 *         an N-way EVEN split, attribute identified by the trailing plural
 *         keyword (plan(s)/region(s)/country|countries/device(s)). The
 *         stated fraction is cross-checked against the label count (a
 *         "1/4 each" over 3 labels does not silently pass).
 *      b. "N% <boolean-flag-name>[=true|=false]" — a boolean attribute set
 *         true for N% of the population, flag-name matched (name-normalized,
 *         case/hyphen/underscore-insensitive) directly against a key the
 *         code reads, not a value comparison.
 *      c. "among [non-]<boolean-flag-name> users, N% have <other-flag>" —
 *         ONE level of conditional sampling (the flag is only meaningfully
 *         defined within the stated subgroup); the condition's own key must
 *         independently resolve via (b) elsewhere in the same text. Outside
 *         the stated subgroup, the conditioned flag defaults to false — a
 *         documented modeling choice (the prose makes no claim about that
 *         subgroup, and false is the non-exceptional default), not a
 *         guess presented as fact.
 *      d. "N% <label>[ plan|region|country|device]" where <label> (after
 *         stripping a trailing attribute-name hint) matches — case/
 *         hyphen/underscore-insensitive — a string literal the code
 *         compares that SAME key against (from step 1's collected
 *         comparisons). A bare "N% other <keyword>s" or a "non-<label>"
 *         complement is recognized as the remaining weight, never guessed
 *         at a specific value. Any label that resolves to NEITHER a known
 *         boolean flag NOR a code-compared literal contributes nothing
 *         (silently) rather than blocking the parse on its own — the real
 *         safety gate is (3) below, not this.
 *    Every recognized clause span is consumed from a working copy of the
 *    text; whatever is population-size boilerplate ("N simulated users",
 *    "user ids are unique sequential integers", ...) is also consumed. If
 *    anything else MEANINGFUL is left over (a construct outside this
 *    grammar — multi-way date/cohort splits, a second level of
 *    conditioning, an unrecognized distribution phrasing, ...), the whole
 *    population parse is rejected.
 *
 * 3. The gate that actually matters: this only proceeds when (a) EVERY
 *    attribute key the code reads (other than the id key) resolved to a
 *    clause in (2), (b) the population-clause residual-text check in (2)
 *    passed, and (c) expected_distribution states exactly one confidently-
 *    identifiable OVERALL population-wide percentage (extractOverallPct,
 *    below — deliberately NOT extractPct/extractTolerance, see that
 *    function's own comment for why the existing ones are the wrong tool
 *    here). Any failure at any of these returns null/false and the row
 *    falls back to the existing honest runtimeUnavailable, identical in
 *    spirit to every other unresolved shape in this file — never a
 *    fabricated verdict from a low-confidence parse.
 *
 * Once these hold, a real synthetic population (independent per-attribute
 * assignment via a deterministic SHA-256-derived fraction per (attribute,
 * user-index) pair — reproducible, no unpinned randomness) is built and the
 * REAL, unmodified is_enabled(user) is run against every synthetic user in
 * one Python subprocess; the OBSERVED overall enabled rate is compared to
 * expected_distribution's own claimed overall rate. Because the real code
 * runs for real, within-eligible salted/hashed bucketing (if any) is
 * naturally exercised correctly-or-incorrectly as part of this — but this
 * is NOT independent verification of "uses this exact salt": two different
 * salt strings produce statistically indistinguishable rates, so a
 * wrong-salt bug is a known, accepted residual of rate-matching alone, not
 * something this pass claims to catch.
 *
 * Known, accepted residual (confirmed, not hypothetical): rate-matching
 * cannot distinguish "compares against the wrong SYMMETRIC-share category"
 * (e.g. a rollout requiring region=='apac' instead of region=='us', when
 * both regions are declared at an identical population share) from the
 * genuinely correct code — the observed overall rate is statistically
 * identical either way. This is an inherent limitation of any statistical
 * rate-matching check, not specific to this parser; a targeting bug against
 * an ASYMMETRIC-share category (unequal population shares) is still caught,
 * since it does shift the observed rate.
 */
'use strict';

const crypto = require('crypto');

// All percentages in `text`, skipping any that is itself the "±N%"
// tolerance clause (that number is the allowed error margin, never a
// target rate).
function allPctsSkippingTolerance(text) {
  const s = String(text);
  const re = /(\d+(?:\.\d+)?)\s*%/g;
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 3), m.index);
    if (/±\s*$/.test(before)) continue;
    out.push(parseFloat(m[1]));
  }
  return out;
}

// expected_distribution is schema-role "expected_output" -- the
// contributor's own claim about the FINAL resulting enabled rate, which is
// exactly what observed-vs-target should be checked against. A compound
// row (a holdout carved out of a base rollout, a kill-switch overriding a
// rollout, ...) states a DIFFERENT resulting percentage in
// expected_distribution than the raw mechanism percentage(s) named in
// rollout_definition -- confirmed exploitable without this: a genuinely
// correct implementation of a "5% holdout + 40% rollout" row was checked
// against the raw 40% from rollout_definition instead of the row's own
// stated resulting rate, and a kill-switch row (0% real, by design) was
// checked against the underlying rollout percentage instead of the row's
// own claimed 0%.
//
// Only trusted when expected_distribution states EXACTLY ONE non-tolerance
// percentage -- a row describing a SEGMENTED claim ("non-US users enabled
// for exactly 0%; US users enabled for roughly 40% ± 3%") states two, and
// neither one is "the" uniform target for the whole simulated population
// (this harness's population has no per-user country/device/opt-in
// attribute to even represent that split) -- confirmed exploitable without
// this restriction: naively taking expected_distribution's FIRST
// percentage picked up one segment's rate (e.g. the 0% non-US figure)
// instead of falling back to rollout_definition's single overall rate,
// which is what these existing, correctly-covered rows actually need.
function extractPct(rolloutDef, expectedDist) {
  const rolloutPcts = allPctsSkippingTolerance(rolloutDef);
  if (!rolloutPcts.length) {
    // No percentage in rollout_definition at all -- same fallback this
    // function already relied on before: take expected_distribution's
    // first (tolerance-excluded) percentage unconditionally on count. A
    // row whose targeting is described entirely in rollout_definition's
    // prose with no literal "%" there (e.g. "targeted only at
    // enterprise-plan users") still needs SOME number, and this preserves
    // exactly what already worked for those rows.
    return distPcts0(expectedDist);
  }
  // rollout_definition DOES have its own percentage -- only override it
  // with expected_distribution's number when expected_distribution states
  // exactly one (a genuinely single overall resulting rate, not a
  // segmented claim where neither number is "the" uniform target).
  const distPcts = allPctsSkippingTolerance(expectedDist);
  return distPcts.length === 1 ? distPcts[0] : rolloutPcts[0];
}
function distPcts0(text) {
  const p = allPctsSkippingTolerance(text);
  return p.length ? p[0] : null;
}
// expected_distribution is contributor-authored prose (schema.json marks it
// expected_output, submitted alongside the code -- not platform-supplied
// ground truth), so an unbounded ±N lets a careless or adversarial
// contributor pad the tolerance arbitrarily and guarantee acceptance
// regardless of code correctness. Capped well above every real tolerance
// convention in this dataset (±1 to ±6) so no legitimate row is affected.
function extractTolerance(expectedDist) {
  const m = String(expectedDist).match(/±\s*(\d+(?:\.\d+)?)/);
  const t = m ? parseFloat(m[1]) : 3;
  return Math.min(t, 15);
}
// Anchored to a number DIRECTLY (within a few descriptive words) followed by
// "user(s)"/"user_id(s)"/"ids" -- an unanchored "first 3+-digit run anywhere"
// picks up a batch/session id, a year, or an unrelated count instead of the
// real population size ("Simulation batch #2026081200001, generated 5,000
// user_ids..." used to extract 2026081200001, hanging the generated script
// for the full 40s budget on range(2e12) and scoring a correct submission an
// outright FAIL rather than runtimeUnavailable). Capped at a sane upper
// bound so even a genuine match can't produce a runaway loop.
function extractN(contexts) {
  const s = String(contexts).replace(/,/g, '');
  const re = /(\d{2,})\s+(?:[a-z][\w-]*\s+){0,3}(?:simulated\s+)?(?:users?|user_ids?|ids?)\b/gi;
  const candidates = [...s.matchAll(re)].map((m) => parseInt(m[1], 10)).filter((n) => n > 0 && n <= 1000000);
  if (!candidates.length) return null;
  // Multiple named sub-populations ("5,000 X and 5,000 Y") are ambiguous as
  // to which one a single simulated population should represent; the
  // largest named count is at least a defensible size proxy, not a guess
  // pulled from an unrelated number elsewhere in the text.
  return Math.max(...candidates);
}
// A hash-based rollout has irreducible sampling noise: at a small N, even a
// genuinely correct implementation can land outside a tight documented
// tolerance purely by chance (confirmed empirically: fixed ±2% at N=100-400
// false-fails a canonical-correct implementation ~9.5% of the time). This is
// a harness-side flakiness problem, not a data-quality one -- the row's own
// documented tolerance is honored as a FLOOR, never loosened below it, but
// widened up to a statistically-justified minimum (~3 standard errors under
// the normal approximation to a binomial proportion) so a correct submission
// isn't penalized for an arbitrary, unlucky sample realization of this
// harness's own sequential "user_%d" ids.
function minStatisticalTolerance(pct, n) {
  const p = Math.max(0.01, Math.min(0.99, pct / 100));
  const sePct = 100 * Math.sqrt((p * (1 - p)) / Math.max(1, n));
  return 3 * sePct;
}

// --------------------------------------------------------- attribute-targeted rollouts ---
// See the module doc comment above for the full grammar, rationale, and
// documented residuals. Everything below is purely additive: it never
// touches allPctsSkippingTolerance/extractPct/extractTolerance/extractN,
// so the three already-covered branches (plain pct, sticky, variant split)
// are completely unaffected by this section.

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Same value-with-position extraction as allPctsSkippingTolerance, but also
// returning each match's index — needed to bind a percentage to the nearest
// "overall"-style cue word / nearest tolerance clause, both of which care
// about WHERE in the text a number appears, not just its value.
function pctMatchesIndexed(text) {
  const s = String(text);
  const re = /(\d+(?:\.\d+)?)\s*%/g;
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 3), m.index);
    if (/±\s*$/.test(before)) continue;
    out.push({ value: parseFloat(m[1]), index: m.index });
  }
  return out;
}

var OVERALL_CUE_RE = /\b(overall|population[- ]wide|across (?:the )?(?:whole|entire|full) population)\b/i;

// extractPct's existing single-vs-multiple-percentage heuristic exists for a
// DIFFERENT compound shape (a genuinely segmented claim, e.g. "non-US 0%,
// US ~40%", where NEITHER stated number is a uniform target for the whole
// population) and would silently fall back to rollout_definition's raw
// within-eligible number here — the wrong target once the simulated
// population is the FULL heterogeneous population rather than just the
// eligible subset. Confirmed against a real row: rollout_definition states
// "...enable the flag for 10%...", expected_distribution restates that same
// "...enabled rate is 10% ± 2%..." (the within-eligible figure again) and
// THEN separately states "...the overall enabled rate is approximately
// 0.8%...". extractPct(rolloutDef, expectedDist) returns 10 for this row
// (expectedDist states two non-tolerance percentages, so it falls back to
// rolloutDef's own 10) — but the actually-correct target against a full
// simulated population is 0.8, not 10. Deliberately narrow in the opposite
// direction from extractPct: only trusted when exactly one stated
// percentage is BOTH (a) distinct from every percentage already named in
// rollout_definition and (b) explicitly cued as the population-wide figure
// ("overall"/"population-wide"/"across the whole population") within a
// short lookback window. Zero or multiple such candidates returns null —
// the caller falls back to runtimeUnavailable rather than guessing which
// number is "the" overall one.
function extractOverallPct(rolloutDef, expectedDist) {
  const rolloutPcts = allPctsSkippingTolerance(rolloutDef);
  const distMatches = pctMatchesIndexed(expectedDist);
  if (distMatches.length === 1 && !rolloutPcts.includes(distMatches[0].value)) {
    return distMatches[0];
  }
  const s = String(expectedDist);
  const candidates = distMatches.filter((m) => {
    if (rolloutPcts.includes(m.value)) return false;
    const windowStart = Math.max(0, m.index - 80);
    return OVERALL_CUE_RE.test(s.slice(windowStart, m.index));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

// extractTolerance takes the text's FIRST "±N" match unconditionally, which
// is the wrong clause once expected_distribution states more than one
// tolerance-bearing figure (the within-eligible restatement AND the overall
// figure, each with its own "±"). Binds to the NEAREST "±N" to the chosen
// overall-percentage match instead, within a generous same-sentence window;
// falls back to the existing global-first-match behavior when nothing is
// nearby, which is never worse than what extractTolerance already does.
function extractToleranceNear(expectedDist, pctIndex) {
  const s = String(expectedDist);
  const re = /±\s*(\d+(?:\.\d+)?)/g;
  let m;
  let best = null;
  let bestDist = Infinity;
  while ((m = re.exec(s))) {
    const d = Math.abs(m.index - pctIndex);
    if (d < bestDist) { bestDist = d; best = parseFloat(m[1]); }
  }
  if (best !== null && bestDist <= 120) return Math.min(best, 15);
  return extractTolerance(expectedDist);
}

var ATTR_PLURAL_TO_KEY = {
  plan: 'plan', plans: 'plan',
  region: 'region', regions: 'region',
  country: 'country', countries: 'country',
  device: 'device', devices: 'device',
};

// Extracted directly from the CODE, never from prose — the same mechanical
// trust level as isAttributeDict's own params-shape detection just above.
// `paramName` is the actual single-dict parameter's own name (usually
// "user", but not assumed to be — a differently-named single-dict param is
// still this same shape).
function extractCodeAttributeRefs(code, paramName) {
  const p = escapeRegExp(paramName || 'user');
  const KEY_RE = new RegExp('\\b' + p + '\\s*(?:\\.\\s*get\\s*\\(\\s*[\'"](\\w+)[\'"]|\\[\\s*[\'"](\\w+)[\'"]\\s*\\])', 'g');
  const EQ_FWD_RE = new RegExp('\\b' + p + '\\s*(?:\\.\\s*get\\s*\\(\\s*[\'"](\\w+)[\'"]\\s*\\)|\\[\\s*[\'"](\\w+)[\'"]\\s*\\])\\s*(==|!=)\\s*[\'"]([^\'"]*)[\'"]', 'g');
  const EQ_REV_RE = new RegExp('[\'"]([^\'"]*)[\'"]\\s*(==|!=)\\s*\\b' + p + '\\s*(?:\\.\\s*get\\s*\\(\\s*[\'"](\\w+)[\'"]\\s*\\)|\\[\\s*[\'"](\\w+)[\'"]\\s*\\])', 'g');
  const s = String(code);
  const keys = new Set();
  let m;
  KEY_RE.lastIndex = 0;
  while ((m = KEY_RE.exec(s))) keys.add(m[1] || m[2]);
  const literalEq = new Map();
  const addEq = (key, lit) => {
    if (!key) return;
    if (!literalEq.has(key)) literalEq.set(key, new Set());
    literalEq.get(key).add(lit);
  };
  EQ_FWD_RE.lastIndex = 0;
  while ((m = EQ_FWD_RE.exec(s))) addEq(m[1] || m[2], m[4]);
  EQ_REV_RE.lastIndex = 0;
  while ((m = EQ_REV_RE.exec(s))) addEq(m[3] || m[4], m[1]);
  keys.delete('id'); // the id key is always synthesized separately (see buildAttributeScript), never part of the population-distribution grammar
  return { keys, literalEq };
}

function normLabel(s) {
  return String(s).toLowerCase().replace(/[\s_-]+/g, '');
}

function resolveBoolKey(label, codeKeys) {
  const norm = normLabel(label);
  for (const k of codeKeys) {
    if (normLabel(k) === norm) return k;
  }
  return null;
}

// Matches a "N% <label>[ <plan|region|country|device>(s)]" percent-label
// pair skipping a "±N%" tolerance figure the same way allPctsSkippingTolerance
// does, and — like EACH_ACROSS_RE — optionally consuming a trailing
// attribute-name keyword so that consumed span fully covers phrasings like
// "80% other plans" (not just the bare "80% other").
var SINGLE_LABEL_PCT_RE = /(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:whom\s+)?)?(?:are\s+|have\s+|has\s+)?([a-z][\w-]*)(?:\s+(plans?|regions?|countries?|devices?))?\b(?:\s*=\s*(?:true|false))?/gi;
var EACH_ACROSS_RE = /(?:(\d+)\s*\/\s*(\d+)\s+each|evenly|equally|uniformly)\s+(?:split\s+|distributed\s+)?across\s+([a-z0-9 ,&'-]+?)\s+(plans?|regions?|countries?|devices?)\b/gi;
var COND_BOOL_RE = /\bamong\s+(non-|non\s+)?([a-z][\w-]*)\s+users?,?\s+(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:whom\s+)?)?(?:are\s+|have\s+|has\s+)?([a-z][\w-]*)(?:\s*=\s*(?:true|false))?\b/gi;
var POP_SIZE_RE = /\d[\d,]*\s+(?:[a-z][\w-]*\s+){0,3}(?:simulated\s+)?(?:users?|user_ids?|ids?)\b/gi;
var BOILERPLATE_RES = [
  /\bwith\s+independent\s+attributes\s*:?/gi,
  /\bindependently\s+of\s+hash\s+bucket\b/gi,
  /\buser\s*ids?\s+are\s+unique\s+sequential\s+integers?\b/gi,
  /\buniformly\s+(?:distributed|exercise)\b[^.;]*/gi,
];

function blankSpans(text, spans) {
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const [a, b] = spans[i];
    out = out.slice(0, a) + ' '.repeat(b - a) + out.slice(b);
  }
  return out;
}
function runPass(text, re, handler) {
  const spans = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    spans.push([m.index, m.index + m[0].length]);
    handler(m);
  }
  return blankSpans(text, spans);
}

// Attempts to resolve a single label word (from a "N% <label>" clause)
// against `literalEq` (the code's own `key == 'literal'` comparisons),
// after stripping a trailing attribute-name hint ("enterprise-plan" ->
// "enterprise") — case/hyphen/underscore-insensitive. A bare "other"/
// "others", or a "non-<label>" complement whose <label> itself resolves,
// is recognized as a complement marker rather than a real value.
function resolveCategoricalLabel(rawLabel, literalEq) {
  const label = String(rawLabel).trim();
  if (/^others?$/i.test(label)) return { key: null, other: true };
  const nonMatch = /^non[-\s]+(.+)$/i.exec(label);
  const core = nonMatch ? nonMatch[1] : label;
  const stripped = core.replace(/[\s-](plans?|regions?|countries?|devices?)$/i, '');
  const candidates = [stripped, core];
  for (const cand of candidates) {
    const norm = normLabel(cand);
    for (const [key, lits] of literalEq) {
      for (const lit of lits) {
        if (normLabel(lit) === norm) return { key, value: lit, other: !!nonMatch };
      }
    }
  }
  return null;
}

function normalizeWeights(values) {
  const sum = values.reduce((a, v) => a + v.weight, 0) || 1;
  return values.map((v) => ({ value: v.value, weight: v.weight / sum }));
}

// The core population-distribution parser. Returns { ok:true, attrs } (a
// Map of attribute key -> spec) or { ok:false, reason }. See the module doc
// comment for the recognized grammar (a-d) and the residual-text confidence
// gate.
function parsePopulationDistribution(contexts, codeKeys, literalEq) {
  const attrs = new Map();
  let text = ' ' + String(contexts) + ' ';

  text = runPass(text, POP_SIZE_RE, () => {});
  for (const re of BOILERPLATE_RES) text = runPass(text, re, () => {});

  // (a) N-way even split: "1/3 each across A, B, and C plans"
  text = runPass(text, EACH_ACROSS_RE, (m) => {
    const key = ATTR_PLURAL_TO_KEY[m[4].toLowerCase()];
    const labels = m[3].split(/,|&|\band\b/i).map((s) => s.trim()).filter(Boolean);
    if (!key || !codeKeys.has(key) || labels.length < 2) return;
    if (m[1] && m[2]) {
      const claimed = parseFloat(m[1]) / parseFloat(m[2]);
      const even = 1 / labels.length;
      if (Math.abs(claimed - even) > 0.02) return; // stated fraction doesn't match label count -- ambiguous, don't guess
    }
    const w = 1 / labels.length;
    const prior = attrs.get(key);
    const values = (prior && prior.kind === 'categorical' ? prior.values : []).concat(labels.map((v) => ({ value: v, weight: w })));
    attrs.set(key, { kind: 'categorical', values: normalizeWeights(values) });
  });

  // (c) conditional boolean shape: "among non-suspended users, 20% have
  // beta_opt_out=true" — resolution is DEFERRED (condition key may not be
  // parsed yet), only the shape is consumed here.
  const pendingConditional = [];
  text = runPass(text, COND_BOOL_RE, (m) => {
    const negated = !!m[1];
    const condKey = resolveBoolKey(m[2], codeKeys);
    const targetKey = resolveBoolKey(m[4], codeKeys);
    const pct = parseFloat(m[3]);
    if (!condKey || !targetKey || condKey === targetKey) return;
    pendingConditional.push({ targetKey, condKey, pct, value: !negated });
  });

  // (b) unconditional boolean OR (d) categorical-via-literal-cross-reference
  // -- syntactically identical "N% <label>" shape, resolved by trying a
  // boolean-key-name match first, then a literal cross-reference.
  text = runPass(text, SINGLE_LABEL_PCT_RE, (m) => {
    const pct = parseFloat(m[1]);
    const boolKey = resolveBoolKey(m[2], codeKeys);
    if (boolKey && !attrs.has(boolKey)) {
      attrs.set(boolKey, { kind: 'boolean', pctTrue: pct, condition: null });
      return;
    }
    const cat = resolveCategoricalLabel(m[2], literalEq);
    if (cat && cat.key && codeKeys.has(cat.key)) {
      const prior = attrs.get(cat.key);
      const values = (prior && prior.kind === 'categorical' ? prior.values : []);
      values.push({ value: cat.other ? '__OTHER__' + cat.key : cat.value, weight: pct / 100 });
      attrs.set(cat.key, { kind: 'categorical', values });
    }
    // else: shape recognized (a "N% word" clause), but not resolvable to
    // anything the code reads -- consumed (blanked) but contributes
    // nothing. Safety comes from the missing-key-coverage gate below, not
    // from rejecting every unresolved incidental clause.
  });

  for (const p of pendingConditional) {
    const cond = attrs.get(p.condKey);
    if (cond && cond.kind === 'boolean' && !attrs.has(p.targetKey)) {
      attrs.set(p.targetKey, { kind: 'boolean', pctTrue: p.pct, condition: { key: p.condKey, value: p.value } });
    }
  }

  // Fill an automatic complement for any categorical attribute whose
  // resolved (d)-pattern weights don't already sum to ~1 -- covers "80%
  // other plans" / a bare "non-US" complement without needing to pair
  // labels up explicitly.
  for (const [key, spec] of attrs) {
    if (spec.kind !== 'categorical') continue;
    const sum = spec.values.reduce((a, v) => a + v.weight, 0);
    if (sum < 0.995) spec.values.push({ value: '__OTHER__' + key, weight: 1 - sum });
    attrs.set(key, { kind: 'categorical', values: normalizeWeights(spec.values) });
  }

  const residual = text.replace(/[\s,.;:&]+/g, ' ').replace(/\b(and|the|of|with|users?|is|are|a|an)\b/gi, ' ').trim();
  if (residual.length > 0) {
    return { ok: false, reason: 'unrecognized population-distribution clause in simulated_user_contexts: "' + residual.slice(0, 120) + '"' };
  }

  const missing = [...codeKeys].filter((k) => !attrs.has(k));
  if (missing.length) {
    return { ok: false, reason: 'no population-distribution clause for attribute(s) [' + missing.join(', ') + '] referenced by flag_evaluation_code' };
  }
  return { ok: true, attrs };
}

// Deterministic (no real randomness — reproducible per-verdict) synthetic
// population + real is_enabled(user) execution, mirroring buildSimplePctScript's
// own "run the real code, check the real observed rate" philosophy.
function buildAttributeScript(code, N, target, tol, attrs, mark) {
  const effTol = Math.max(tol, minStatisticalTolerance(target, N));
  // Categorical specs first (order-independent), then unconditional
  // booleans, then conditional booleans LAST (each depends on its own
  // condition key already having been assigned for the same synthetic
  // user — see buildAttributeScript's Python _build_user below).
  const ordered = [...attrs.entries()];
  const rank = (spec) => (spec.kind === 'categorical' ? 0 : spec.condition ? 2 : 1);
  ordered.sort((a, b) => rank(a[1]) - rank(b[1]));
  const attrsList = ordered.map(([key, spec]) => Object.assign({ key }, spec));
  return [
    'import hashlib',
    PY_VERDICT_PRELUDE,
    code,
    'N = ' + N,
    'TARGET = ' + target,
    // Parsed via json.loads from a Python STRING literal, not spliced in as
    // raw Python source -- JSON's null/true/false are not valid Python
    // literals (None/True/False), so a naive `'ATTRS = ' + JSON.stringify(...)`
    // is a NameError on the very first row exercising this path (confirmed:
    // any spec containing "condition":null crashes with `NameError: name
    // 'null' is not defined` before is_enabled is ever called). JSON string
    // escaping is a valid subset of Python string literal escaping, so the
    // doubly-stringified form below is always valid Python source.
    'ATTRS = _real_json.loads(' + JSON.stringify(JSON.stringify(attrsList)) + ')',
    'def _frac(key, i):',
    '    h = hashlib.sha256((str(key) + ":" + str(i)).encode()).hexdigest()[:8]',
    '    return int(h, 16) / 4294967295.0',
    'def _build_user(i):',
    '    u = {"id": "user_%d" % i}',
    '    for spec in ATTRS:',
    '        k = spec["key"]',
    '        if spec["kind"] == "categorical":',
    '            f = _frac(k, i)',
    '            acc = 0.0',
    '            val = spec["values"][-1]["value"]',
    '            for entry in spec["values"]:',
    '                acc += entry["weight"]',
    '                if f < acc:',
    '                    val = entry["value"]',
    '                    break',
    '            u[k] = val',
    '        else:',
    '            cond = spec.get("condition")',
    '            if cond is None:',
    '                u[k] = _frac(k, i) < (spec["pctTrue"] / 100.0)',
    '            elif u.get(cond["key"]) == cond["value"]:',
    '                u[k] = _frac(k, i) < (spec["pctTrue"] / 100.0)',
    '            else:',
    '                u[k] = False',
    '    return u',
    'on = 0',
    'for _i in range(N):',
    '    _u = _build_user(_i)',
    '    if is_enabled(_u): on += 1',
    'observed = 100.0 * on / N',
    '_eff_tol = ' + effTol,
    '_ok = abs(observed - TARGET) <= _eff_tol',
    '_real_print(' + JSON.stringify(mark) + ' + _real_dumps({"ok": _ok, "observedPct": round(observed, 3), "targetPct": TARGET, "tolerance": ' + tol + ', "effectiveTolerance": round(_eff_tol, 3), "n": N, "attrs": [a["key"] for a in ATTRS]}))',
  ].join('\n');
}

// Orchestrates the whole attribute-targeted parse + script build. Returns
// { prog } on a confident parse, or { reason, detail } when any step falls
// short of the confidence bar — the caller routes the latter to the
// existing honest runtimeUnavailable.
function tryBuildAttributeTargetedScript(code, paramName, rolloutDef, expectedDist, contexts, N, mark) {
  const overall = extractOverallPct(rolloutDef, expectedDist);
  if (!overall) {
    return { reason: 'could not confidently identify a single overall population-wide percentage in expected_distribution (attribute-targeted rollout)', detail: {} };
  }
  const refs = extractCodeAttributeRefs(code, paramName);
  if (!refs.keys.size) {
    return { reason: 'flag_evaluation_code reads no attribute keys off its single dict parameter — nothing to model', detail: {} };
  }
  const pop = parsePopulationDistribution(contexts, refs.keys, refs.literalEq);
  if (!pop.ok) {
    return { reason: pop.reason, detail: { codeKeys: [...refs.keys] } };
  }
  const tol = extractToleranceNear(expectedDist, overall.index);
  const prog = buildAttributeScript(code, N, overall.value, tol, pop.attrs, mark);
  return { prog };
}

module.exports = {
  contract: 'distribution-match',
  requires: ['python3'],

  verify(row, h) {
    const code = h.str(row, 'flag_evaluation_code');
    const rolloutDef = h.str(row, 'rollout_definition');
    const contexts = h.str(row, 'simulated_user_contexts');
    const expectedDist = h.str(row, 'expected_distribution');
    if (!code || !expectedDist) return { passed: false, detail: { reason: 'missing flag_evaluation_code or expected_distribution' } };

    // Same "FLAWED:" convention as elsewhere in this dataset family —
    // searched anywhere rather than anchored, matching
    // build_dependency_resolution and dependency_vuln_audit, since a
    // reference row can embed the marker mid-string rather than as a
    // strict prefix. The negative lookbehind excludes "NOT FLAWED:"/"isn't
    // FLAWED:" -- a legitimately-correct row phrased as an explicit denial
    // ("this description is NOT FLAWED: the flag is genuinely...") would
    // otherwise be force-failed purely because the literal substring
    // "FLAWED:" appears, regardless of the negation in front of it.
    if (/(?<!not\s)(?<!n't\s)\bFLAWED:/i.test(expectedDist)) {
      return { passed: false, logs: 'reference description is marked FLAWED', detail: { flawedReference: true } };
    }
    const N = extractN(contexts);
    const defMatch = code.match(/def\s+(is_enabled|assign_variant)\s*\(([^)]*)\)/);
    const fnName = defMatch ? defMatch[1] : null;
    const params = defMatch ? defMatch[2].split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (!N || !fnName) {
      // This is a submission-contract problem, not an infrastructure
      // problem. Marking it `runtimeUnavailable` sends an otherwise
      // immediately-actionable malformed row to human audit with the
      // misleading "provider: none configured" UI. Keep runtimeUnavailable
      // reserved for a genuinely absent Python runtime or an intentionally
      // unsupported verification shape below.
      const missing = [];
      if (!fnName) missing.push('a Python entrypoint: `def is_enabled(user_id, pct)` or `def assign_variant(...)`');
      if (!N) missing.push('a numeric population in simulated_user_contexts, for example `10,000 simulated user_ids`');
      return {
        passed: false,
        logs: 'feature_flag contract is incomplete: add ' + missing.join(' and '),
        detail: {
          reason: 'invalid_feature_flag_contract',
          missing,
          contexts: contexts.slice(0, 150),
          entrypoint: fnName,
        },
      };
    }
    if (!h.have('python3')) return { passed: false, runtimeUnavailable: true, logs: 'python3 not available', detail: {} };

    const mark = '@@FF_' + crypto.randomBytes(12).toString('hex') + '_';
    const source = rolloutDef + ' ' + expectedDist;
    const isSticky = /sticky|repeated evaluations|identical.*result/i.test(source);
    // Strip a type annotation (": str", ": Any", ...) before the exact-match
    // comparison -- a perfectly idiomatic, plain user_id-only rollout typed
    // as `def is_enabled(user_id: str) -> bool:` was otherwise misrouted to
    // runtimeUnavailable as if it were an attribute-dict rollout, purely
    // because the raw parameter text "user_id: str" isn't the bare string
    // "user_id".
    const firstParamName = params[0] ? params[0].replace(/:.*/, '').trim() : '';
    const isAttributeDict = fnName === 'is_enabled' && params.length === 1 && firstParamName !== 'user_id';
    const isVariantSplit = fnName === 'assign_variant';
    // is_enabled(user_id, pct, salt, ...) — a salted/multi-salt call this
    // pass's simple 1-or-2-arg caller cannot invoke at all. Calling it with
    // too few arguments doesn't raise cleanly into the existing TypeError
    // fallback (both attempts fail), it silently produces r=None for every
    // user and a false 0%-observed verdict — worth excluding explicitly
    // rather than letting that happen.
    const isMultiArgSalted = fnName === 'is_enabled' && params.length >= 3;
    // The module docstring documents monotonic-growth-across-percentages and
    // chi-square-style bucket-uniformity as NOT covered -- but nothing
    // actually gated on that before this, so both silently fell through to
    // the plain is_enabled branch: extractPct grabbed only the FIRST of the
    // several percentages a monotonic-growth row states (never checking the
    // superset claim across them), and extractTolerance grabbed an absolute
    // per-bin user count as if it were a percentage-point tolerance (making
    // the bucket-uniformity check vacuous, since any rate is within ±150 of
    // anything). Both were confirmed to score a maximally-broken
    // `is_enabled` (always False) as passed:true against real reference
    // rows using these exact phrasings.
    const isMonotonicGrowth = /monotonic|superset|\d+%\s*->\s*\d+%/i.test(source);
    const isBucketUniformity = /\bbins?\b|chi-square/i.test(source);

    let prog = null;
    if (isAttributeDict) {
      // Attempt the mechanical, pattern-based attribute-targeted parse
      // (see module doc comment). A failed attempt is NOT itself an error
      // -- it's the expected, honest outcome for any row whose prose falls
      // outside the recognized grammar, and falls back to the same
      // runtimeUnavailable routing this branch always used before this
      // pass.
      const attempt = tryBuildAttributeTargetedScript(code, firstParamName, rolloutDef, expectedDist, contexts, N, mark);
      if (!attempt.prog) {
        return {
          passed: false, runtimeUnavailable: true,
          logs: attempt.reason,
          detail: Object.assign({ params, contexts: contexts.slice(0, 150) }, attempt.detail),
        };
      }
      prog = attempt.prog;
    } else if (isMultiArgSalted || isMonotonicGrowth || isBucketUniformity) {
      let logs;
      if (isMultiArgSalted) logs = 'is_enabled(' + params.join(', ') + ') — salted/multi-argument signature not called in this pass';
      else if (isMonotonicGrowth) logs = 'monotonic-growth-across-percentages claim — not mechanically checked in this pass';
      else logs = 'chi-square-style bucket-uniformity claim — not mechanically checked in this pass';
      return {
        passed: false, runtimeUnavailable: true,
        logs,
        detail: { params, contexts: contexts.slice(0, 150) },
      };
    } else if (isVariantSplit) {
      prog = buildVariantScript(code, params, rolloutDef, expectedDist, N, extractTolerance(expectedDist), mark);
      if (!prog) {
        return { passed: false, runtimeUnavailable: true, logs: 'could not parse weighted variant split from rollout_definition/expected_distribution', detail: { rolloutDef: rolloutDef.slice(0, 150) } };
      }
    } else if (fnName === 'is_enabled' && isSticky) {
      prog = buildStickyScript(code, N, mark);
    } else if (fnName === 'is_enabled') {
      const target = extractPct(rolloutDef, expectedDist);
      if (target == null) {
        return { passed: false, runtimeUnavailable: true, logs: 'could not extract a target percentage from rollout_definition/expected_distribution', detail: { rolloutDef: rolloutDef.slice(0, 150), expectedDist: expectedDist.slice(0, 150) } };
      }
      prog = buildSimplePctScript(code, N, target, extractTolerance(expectedDist), mark);
    }

    const d = h.workdir();
    const f = h.path.join(d, 'f.py');
    h.fs.writeFileSync(f, prog);
    const r = h.run('python3', [f], { cwd: d, timeoutMs: 40000 });
    if (r.timedOut) {
      return { passed: false, runtimeUnavailable: true, logs: 'flag_evaluation_code timed out after 40s', detail: { timedOut: true } };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr || '').slice(0, 1500), detail: { ranClean: false } };
    }

    const marked = h.lastMarked(String(r.stdout || ''), mark);
    const got = marked === null ? null : h.jsonOf(marked);
    if (!got) {
      return { passed: false, logs: 'could not parse output: ' + String(r.stdout).slice(0, 300), detail: {} };
    }
    if (got.ambiguous) {
      return { passed: false, runtimeUnavailable: true, logs: 'extracted variant labels/weights did not confidently match any real observed variant — cannot mechanically verify', detail: got };
    }

    return { passed: got.ok === true, logs: got.ok === true ? '' : JSON.stringify(got).slice(0, 500), detail: got };
  },
};

// flag_evaluation_code runs inline, sharing this script's process and stdout
// with the harness's own verdict-emission logic that runs after it.
// `_real_dumps = json.dumps` captured as a direct reference before any of
// that code runs genuinely survives a later `json.dumps` monkeypatch (that
// capture is a plain function-object reference, and json.dumps isn't looked
// up dynamically the way sys.stdout is). `_real_print`, DESPITE THE NAME, is
// NOT `print` captured as a reference -- an earlier version was exactly
// that (`_real_print = print`), and it does NOT protect against contributor
// code reassigning `sys.stdout`: CPython's print() resolves its output
// stream from `sys.stdout` FRESH at every call, never bound at reference-
// capture time, so a wrapper object assigned to sys.stdout intercepts even
// an earlier-captured print reference's output -- confirmed exploitable
// (a maximally-broken `is_enabled`, always False i.e. genuinely 0% enabled
// vs. a documented 30%+/-2% target, scored passed:true by rewriting
// "ok": false to "ok": true in transit, no exit()/marker-guessing needed at
// all). `_real_print` is instead a small function writing directly to file
// descriptor 1 via `os.write`, which never goes through the `sys.stdout`
// Python object (or any reassignment of it) at all -- the same fix already
// applied to competitive_programming's/compression's harnesses.
const PY_VERDICT_PRELUDE = [
  'import json as _real_json, os as _real_os',
  'def _real_print(_s):',
  '    _real_os.write(1, (_s + "\\n").encode("utf-8", "replace"))',
  '_real_dumps = _real_json.dumps',
].join('\n');

function buildSimplePctScript(code, N, target, tol, mark) {
  const effTol = Math.max(tol, minStatisticalTolerance(target, N));
  return [
    'import hashlib',
    PY_VERDICT_PRELUDE,
    code,
    'N = ' + N + '; PCT = ' + target,
    'ids = ["user_%d" % i for i in range(N)]',
    'on = 0',
    'for u in ids:',
    '    try: r = is_enabled(u, PCT)',
    '    except TypeError:',
    '        try: r = is_enabled(u)',
    '        except Exception: r = None',
    '    if r: on += 1',
    'observed = 100.0 * on / N',
    '_eff_tol = ' + effTol,
    '_ok = abs(observed - PCT) <= _eff_tol',
    '_real_print(' + JSON.stringify(mark) + ' + _real_dumps({"ok": _ok, "observedPct": round(observed, 2), "targetPct": PCT, "tolerance": ' + tol + ', "effectiveTolerance": round(_eff_tol, 3), "n": N}))',
  ].join('\n');
}

function buildStickyScript(code, N, mark) {
  // Every user evaluated 5 times; every single user must get the identical
  // result across all 5 — 0 tolerance, this is a determinism property, not
  // a statistical one.
  return [
    'import hashlib',
    PY_VERDICT_PRELUDE,
    code,
    'N = ' + N,
    'ids = ["user_%d" % i for i in range(N)]',
    'PCT = 50',
    'inconsistent = 0',
    'for u in ids:',
    '    results = set()',
    '    for _ in range(5):',
    '        try: r = is_enabled(u, PCT)',
    '        except TypeError: r = is_enabled(u)',
    '        results.add(bool(r))',
    '    if len(results) > 1: inconsistent += 1',
    '_ok = inconsistent == 0',
    '_real_print(' + JSON.stringify(mark) + ' + _real_dumps({"ok": _ok, "inconsistentUsers": inconsistent, "n": N}))',
  ].join('\n');
}

function buildVariantScript(code, params, rolloutDef, expectedDist, N, tol, mark) {
  // "weighted 3-way split: 70% control, 20% variant_a, 10% variant_b" — the
  // labels and weights are both in the text, extracted together rather than
  // assumed from a fixed variant name list.
  const weights = {};
  const re = /(\d+(?:\.\d+)?)\s*%?\s*([\w-]+)/g;
  let m;
  const source = rolloutDef + ' ' + expectedDist;
  while ((m = re.exec(source))) {
    const label = m[2].toLowerCase();
    if (['control', 'variant', 'variant_a', 'variant_b', 'variant_c'].some((k) => label.includes(k)) || /^[a-z]$/.test(label)) {
      weights[m[2]] = parseFloat(m[1]);
    }
  }
  const labels = Object.keys(weights);
  if (labels.length < 2) return null;

  // Per-label statistical floor, same rationale as buildSimplePctScript: a
  // correct implementation shouldn't spuriously fail a variant purely from
  // sampling noise on this harness's own sequential "user_%d" ids.
  const effTol = {};
  for (const k of labels) effTol[k] = Math.max(tol, minStatisticalTolerance(weights[k], N));

  const takesWeights = params.length >= 2;
  const lines = ['import hashlib', PY_VERDICT_PRELUDE, code, 'N = ' + N];
  if (takesWeights) {
    lines.push('WEIGHTS = ' + JSON.stringify(weights));
    lines.push('ids = ["user_%d" % i for i in range(N)]');
    lines.push('counts = {}');
    lines.push('for u in ids:');
    lines.push('    v = assign_variant(u, WEIGHTS)');
    lines.push('    counts[v] = counts.get(v, 0) + 1');
  } else {
    lines.push('ids = ["user_%d" % i for i in range(N)]');
    lines.push('counts = {}');
    lines.push('for u in ids:');
    lines.push('    v = assign_variant(u)');
    lines.push('    counts[v] = counts.get(v, 0) + 1');
  }
  lines.push('pcts = {k: 100.0 * v / N for k, v in counts.items()}');
  lines.push('EXPECTED_RAW = ' + JSON.stringify(weights));
  lines.push('EFFTOL = ' + JSON.stringify(effTol));
  // Extraction pulls candidate (label, weight) pairs from free-form prose --
  // a phrase like "no single variant should swing by more than 5
  // variant-points run over run" can inject a spurious "variant-points": 5
  // entry that the real assign_variant() never returns, forcing a genuinely
  // correct 70/20/10 implementation to fail solely on that phantom entry
  // (pcts.get('variant-points', 0) = 0, |0-5| > tol). Cross-checking against
  // labels the CODE actually produced (not just text extraction) drops any
  // candidate that never appears among real observed values; only when NONE
  // of the extracted candidates correspond to anything real is this
  // genuinely ambiguous (extraction likely grabbed the wrong words
  // entirely) rather than evidence the implementation is broken.
  lines.push('EXPECTED = {k: v for k, v in EXPECTED_RAW.items() if k in counts}');
  lines.push('_ambiguous = len(EXPECTED) == 0');
  lines.push('_ok = (not _ambiguous) and all(abs(pcts.get(k, 0) - EXPECTED[k]) <= EFFTOL.get(k, ' + tol + ') for k in EXPECTED)');
  lines.push('_real_print(' + JSON.stringify(mark) + ' + _real_dumps({"ok": _ok, "ambiguous": _ambiguous, "observed": pcts, "expected": EXPECTED, "expectedRaw": EXPECTED_RAW, "n": N}))');
  return lines.join('\n');
}
