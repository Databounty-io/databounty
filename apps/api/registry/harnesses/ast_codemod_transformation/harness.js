/**
 * transformation-plus-behavior-preservation -- ast_codemod_transformation.
 *
 * THE CONTRACT, AND WHY IT IS GENUINELY DIFFERENT FROM refactoring's OWN
 * both-pass-identically CONTRACT (read registry/harnesses/refactoring/
 * harness.js before touching this file -- this category's closest sibling):
 * refactoring only ever checks that original_code and refactored_code BOTH
 * pass the SAME `tests` fragment -- it never asks whether refactored_code is
 * structurally related to original_code at all, let alone whether it applies
 * any SPECIFIC, named transformation. A `refactored_code` that is a totally
 * different implementation achieving the same test-passing behavior is,
 * under that contract, a perfectly valid refactor. THIS category's whole
 * reason for existing is to check the STRUCTURAL EDIT ITSELF: transformed_
 * code must be original_code with the SPECIFIC, curator-declared
 * transformation_type genuinely applied -- verified by parsing BOTH sources
 * with Python's real stdlib `ast` module and mechanically walking the
 * resulting trees, never by text/regex diffing (trivially gameable -- a
 * regex could be satisfied by a comment, a renamed-but-unrelated variable,
 * or a string literal that merely LOOKS like the right shape) and never by
 * behavior alone (satisfied just as easily by an unrelated rewrite, exactly
 * refactoring's own accepted scope). Two independent gates, both required:
 * (a) STRUCTURAL -- see STRUCTURAL_CHECKS below, one real ast-walking
 * function per transformation_type, each documented with the exact
 * reasoning for why its particular check proves the claimed transformation
 * genuinely happened; (b) BEHAVIORAL -- entry_point_original/entry_point_
 * transformed are actually called against shared behavior_check test cases
 * and their real results compared.
 *
 * WHY 7 OF 8 transformation_type VALUES ARE PURELY BEHAVIOR-PRESERVING, AND
 * WHY THE 8TH (except_pass_to_logging) WAS INCLUDED ANYWAY -- A DELIBERATE,
 * REASONED TRADE-OFF: a purely behavior-preserving set is unambiguously
 * easier to verify correctly -- "the transformed function must return
 * EXACTLY what the original returned, for every test case" is a single,
 * simple, universal comparison rule with no per-type special-casing needed
 * on the behavioral side. A set that also allows semantic-CHANGING
 * transformations forces a harder question for each one: WHAT, exactly,
 * counts as "correctly changed" versus "broken", and how is that verified
 * without either (i) trusting the contributor's own claim about what
 * changed (no different from not checking behavior at all), or (ii) writing
 * a bespoke oracle per row (defeats the point of a small, reusable
 * mechanical check). This category was deliberately scoped to include
 * exactly ONE semantic-changing type rather than zero, because the task
 * this category exists to cover genuinely includes real-world codemods
 * whose entire point IS a behavior change (a bare `except: pass` silently
 * swallowing an error is *the bug*; the fix is not behavior-preserving by
 * design) -- excluding that shape entirely would leave a real gap in what
 * this category can represent. except_pass_to_logging resolves the harder
 * question cleanly: the RETURN VALUE / control-flow (does the function
 * still catch the exception and continue, and with what result) is required
 * to stay IDENTICAL to original_code's own (checked by the exact same
 * uniform comparison every other type uses) -- the transformation's whole
 * "change" is an ADDED, purely observational side effect (a log call),
 * which this harness verifies not by trusting the AST claim alone but by
 * actually running transformed_code with logging.{exception,error,warning,
 * critical} monkeypatched to a recorder and checking a call was genuinely
 * observed. This keeps the same uniform "compare real return values" engine
 * for all 8 types, with exactly one additional, narrowly-scoped, runtime-
 * verified side-effect check layered on top for the one type that needs it
 * -- not a second bespoke comparison engine.
 *
 * WHY EACH transformation_type WAS EXCLUDED OR INCLUDED (full list
 * considered): dict.has_key(k) -> `k in d` and `.iteritems()`/`.iterkeys()`/
 * `.itervalues()` migrations (both suggested by this category's own task
 * brief) were deliberately DROPPED -- both are Python-2-ONLY APIs that raise
 * AttributeError under a real Python 3 interpreter, so original_code could
 * never actually be executed to prove behavior preservation in the first
 * place; a category whose own behavioral half cannot run its own "before"
 * side is not exercising the contract this file exists to check. Every one
 * of the 8 types actually shipped is genuinely Python-3-runnable on both
 * sides.
 *
 * PER-transformation_type STRUCTURAL REASONING (why THIS specific AST check
 * proves the transformation happened, not merely that something changed):
 *
 *   rename_identifier -- checks that OLD_NAME has ZERO remaining Name-node
 *   references or function definitions ANYWHERE in transformed_code's AST
 *   (a leftover reference means the rename was not applied everywhere), that
 *   NEW_NAME is defined as a function if OLD_NAME was, and that the COUNT of
 *   NEW_NAME references in transformed_code is at least as large as OLD_
 *   NAME's own reference count in original_code (a def-only rename that
 *   left call sites untouched, or renamed the def but not its call sites,
 *   fails this). A pure identifier-count check, not a full call-graph
 *   re-derivation -- accepted as proportionate given the identical-count
 *   floor already rules out the common "renamed the definition but forgot
 *   the call sites" mistake.
 *
 *   percent_format_to_fstring -- counts BinOp(Mod) nodes whose LEFT operand
 *   is a string Constant (the unambiguous `"...": % (...)` shape; a `%`
 *   BinOp against anything else is ordinary arithmetic modulo, correctly
 *   never counted) in original_code, requires ZERO such nodes remain in
 *   transformed_code, and requires transformed_code's own JoinedStr
 *   (f-string) count to have grown by at least as many as were converted.
 *   Both halves matter: without the "zero remaining" half, converting only
 *   the FIRST of three % expressions and leaving the rest untouched would
 *   still add a JoinedStr and pass; without the "gained JoinedStr" half, a
 *   transformed_code that just deletes the % expression (rather than
 *   genuinely converting it) would also satisfy "zero remaining".
 *
 *   hoist_nested_imports -- collects every Import/ImportFrom node found
 *   anywhere inside a top-level function body in original_code (walked
 *   per-function, so a nested-inside-a-nested-function import is still
 *   caught), requires every name THOSE statements bind to now appear as a
 *   TOP-LEVEL (Module.body-direct) Import/ImportFrom in transformed_code,
 *   and requires ZERO Import/ImportFrom nodes remain inside any function
 *   body in transformed_code. Checking bound NAMES rather than raw source
 *   text tolerates a legitimate `import os` -> `import os` (same statement,
 *   just relocated) without requiring byte-identical statement text.
 *
 *   listcomp_to_genexpr -- unlike the two "convert every occurrence" checks
 *   above, this one is deliberately NOT a "zero ListComp nodes remain" rule
 *   -- the task this type represents ("convert A comprehension that is only
 *   ever consumed once", per this category's own task_description framing)
 *   is inherently SELECTIVE, not exhaustive; a file may have other list
 *   comprehensions that genuinely need to stay lists (consumed more than
 *   once, or need indexing/len()). Instead requires original_code to
 *   contain >= min_conversions ListComp nodes, transformed_code's ListComp
 *   count to have DROPPED by >= min_conversions, and transformed_code's
 *   GeneratorExp count to have GROWN by >= min_conversions -- a genuine
 *   swap, not merely "a comprehension disappeared" (which a deletion would
 *   also satisfy) or "a generator expression exists somewhere" (which an
 *   unrelated addition would also satisfy). An additional anti-gaming check
 *   rejects any GeneratorExp immediately re-wrapped in `list(...)` in
 *   transformed_code -- structurally still "a GeneratorExp exists", but
 *   functionally identical to never having converted it at all (still
 *   materializes the full list eagerly), defeating the entire point of the
 *   claimed transformation.
 *
 *   add_param_type_hints -- locates the SAME top-level function (by
 *   curator-declared function_name) in both trees, requires its parameter
 *   NAME/ORDER list to be byte-identical between original_code and
 *   transformed_code (this transformation must only ADD annotations, never
 *   touch the signature otherwise), then for each curator-named parameter
 *   requires original_code's own arg to have NO annotation (there must be
 *   something real to add) and transformed_code's matching arg to have an
 *   annotation whose resolved name (a bare ast.Name, e.g. `int`) matches the
 *   curator-declared type exactly. Deliberately behaviorally inert by
 *   construction: Python annotations are never evaluated/enforced at
 *   runtime, so this type's own behavioral half is trivially, always
 *   satisfied for any transformed_code that merely adds correct-looking
 *   annotations without touching the function BODY at all -- included
 *   anyway as a genuinely distinct, common, real-world codemod shape (the
 *   AST check IS the entire verification burden for this type; the
 *   behavioral check exists mainly as a regression guard against a
 *   transformed_code that broke the body while adding annotations, not as
 *   this type's primary evidence).
 *
 *   eq_none_to_is_none -- counts Compare nodes with exactly one Eq/NotEq op
 *   where either operand is the Constant `None` in original_code, requires
 *   ZERO such nodes remain in transformed_code, and requires the count of
 *   equivalent Is/IsNot-against-None Compare nodes to have grown by at least
 *   as many as were converted. HONEST RESIDUAL, documented rather than
 *   chased: `x == None` and `x is None` are usually but not ALWAYS
 *   equivalent -- an object with a pathological `__eq__` override (e.g. one
 *   that raises, or that returns something other than a genuine bool for
 *   `x == None`) could make this transformation a real, if rare, behavior
 *   change. The behavioral check (this category's own real Python execution
 *   of both sides against shared test cases) is the actual backstop here:
 *   a row built around such a pathological type would fail behaviorally
 *   even though it passes structurally, exactly the intended layered
 *   defense -- the structural check proves the EDIT happened; the
 *   behavioral check independently proves whether it was safe.
 *
 *   except_pass_to_logging -- see the module-level discussion above for why
 *   this is this category's one semantic-changing type. Structurally:
 *   requires original_code to contain >= min_conversions ExceptHandler nodes
 *   whose entire body is a single bare Pass statement, requires ZERO such
 *   bare-pass handlers remain in transformed_code, and requires >=
 *   min_conversions of transformed_code's ExceptHandler nodes to contain a
 *   real Call node shaped like `logging.exception(...)` /
 *   `logger.error(...)` / etc. (an Attribute-call whose method name is one
 *   of exception/error/warning/critical on a base named logging/logger/log,
 *   case-insensitive) -- deliberately tolerant of either the module-level
 *   convenience-function idiom (`import logging; logging.exception(...)`)
 *   or the Logger-instance idiom (`logger = logging.getLogger(__name__);
 *   logger.exception(...)`), since both are equally idiomatic real Python.
 *   The RUNTIME half (see buildDriverScript's logging monkeypatch) is what
 *   actually PROVES a log call fires when the handler is genuinely
 *   exercised, rather than trusting the AST shape alone -- a transformed_
 *   code that defines a `logging.exception` CALL syntactically but never
 *   actually reaches it at runtime (e.g. behind an always-false guard) would
 *   pass the structural check but fail the mechanical expect_log_call
 *   runtime assertion below.
 *
 *   remove_unused_import -- requires original_code to have a TOP-LEVEL
 *   Import/ImportFrom binding the curator-declared bound_name, requires that
 *   name to have ZERO other references anywhere else in original_code's own
 *   AST (mechanically enforcing the row's own premise that the import is
 *   genuinely unused -- a row whose import IS used elsewhere is rejected as
 *   a dataset-authoring defect before transformed_code is ever touched,
 *   since removing a used import would not be a valid instance of this
 *   transformation_type at all), and requires transformed_code to no longer
 *   bind that name via any top-level import. HONEST RESIDUAL, same
 *   character as eq_none_to_is_none's: an import can have a real SIDE
 *   EFFECT even if the bound name itself is never referenced again (plugin
 *   self-registration, a module-level `atexit.register(...)` call) -- the
 *   "genuinely unused" check here is about the NAME never being referenced,
 *   not about the import statement being provably side-effect-free (that is
 *   undecidable in general). See transformation_params' own help text for
 *   the matching authoring guidance (prefer plainly side-effect-free stdlib
 *   modules for this type); the behavioral check remains the real backstop
 *   for any row that violates that guidance, exactly as for eq_none_to_is_
 *   none and hoist_nested_imports above.
 *
 * ANTI-GAMING, THE TWO CONCRETE THREATS THIS CATEGORY'S TASK BRIEF CALLED
 * OUT BY NAME:
 *   (1) transformed_code byte-identical to original_code (no transformation
 *   at all) -- caught structurally in TWO independent ways: a cheap,
 *   pre-execution whitespace-collapsed identical-code gate (below, same
 *   mechanism refactoring's/static_lint_rule_fix_verification's own
 *   harnesses already use), AND organically by every single per-type
 *   structural check above, each of which requires the "after" shape to
 *   differ from the "before" shape in a specific, non-trivial way -- an
 *   unmodified original_code cannot pass ANY of the 8 checks (e.g.
 *   rename_identifier's own "old_name must have zero remaining references"
 *   rule is trivially false if nothing was renamed at all).
 *   (2) transformed_code is a totally different, unrelated program that
 *   merely happens to pass behavior_check -- addressed by a structural-
 *   similarity FLOOR (jaccardSimilarity() below, over identifier-token
 *   sets), ported from static_lint_rule_fix_verification's own proven
 *   "not gutted/replaced" mechanism and adapted here to the analogous
 *   "not an unrelated replacement" concern: an unrelated rewrite sharing
 *   little of original_code's own identifier vocabulary cannot clear
 *   MIN_JACCARD regardless of how well it satisfies behavior_check.
 *   Combined with the per-type structural check (which an unrelated program
 *   would ALSO have to satisfy by real accident or deliberate reverse-
 *   engineering of this exact harness) and the behavioral check itself
 *   (which an unrelated program has no reason to satisfy at all unless it
 *   was specifically built to), this is a genuinely high combined bar --
 *   not a mathematical proof of relatedness (no token-overlap heuristic can
 *   ever be that), the same documented, accepted-residual tier static_lint_
 *   rule_fix_verification's own module doc comment already established for
 *   this exact class of defense.
 *
 * SECRET-LEAK PREVENTION, APPLYING A LESSON FROM A SIBLING CATEGORY'S OWN
 * PAST BUG: schema_conformance_validation's own harness once let contributor
 * code sys._getframe()-walk into the SAME process's ground-truth-computation
 * locals and read the precomputed answer key directly, fixed only by
 * splitting oracle computation and contributor execution into two separate
 * OS processes. This category closes the equivalent risk more simply, by
 * construction rather than by process-splitting: buildDriverScript below
 * NEVER embeds behavior_check's own expected_output/expect_log_call values
 * into the Python subprocess's source AT ALL -- only args/kwargs (the
 * legitimate function INPUTS, not a secret) are ever sent across the
 * Node-to-Python boundary (see stripForPython() below). There is no
 * same-process oracle value for a frame-walking transformed_code to reach
 * for in the first place; the actual expected_output comparison happens
 * entirely in THIS Node process, after the Python subprocess has already
 * exited and reported only its own real, independently-observed return
 * values.
 *
 * EXECUTION SAFETY -- SAME PROVEN PRIMITIVES AS EVERY OTHER PYTHON-EXECUTING
 * CATEGORY IN THIS REGISTRY: h.PY_PRELUDE is installed once at the top of
 * the driver (traps sys.exit()/os._exit()/raise SystemExit -- see helpers.js
 * for the full reasoning), and every call into original_code's or
 * transformed_code's own entry point is wrapped in try/except BaseException
 * (catches SystemExit too). original_code and transformed_code are exec()'d
 * into SEPARATE, fresh namespace dicts (never a shared globals() dict) --
 * not because either side holds a secret from the other (neither does; see
 * SECRET-LEAK PREVENTION above), but as ordinary hygiene against one side's
 * module-level state (a mutable global, a monkeypatch) leaking into the
 * other's execution.
 *
 * GATE ORDER: field presence -> transformation_type enum membership ->
 * transformation_params shape/range validation (per-type) -> behavior_check
 * shape/range validation (incl. the args-vary / outputs-vary / except_pass_
 * to_logging's log-call-exercised anti-hardcoding floors) -> original_code/
 * transformed_code size floors/ceilings -> identical-code gate ->
 * Jaccard structural-similarity floor -> static entry-point-definition
 * regex pre-check (both sides) -> h.have('python3') -> the one Python
 * subprocess (parse both ASTs -> per-type STRUCTURAL check -> only if that
 * passes: exec + run original_code's entry point against every test case,
 * cross-checked against expected_output as curator ground truth -> exec +
 * run transformed_code's entry point against every test case, with logging
 * capture) -> Node-side interpretation of every stage in order.
 *
 * TIMEOUT BUDGET: TIMEOUT_MS (10000ms) covers two ast.parse() calls, one
 * small per-type AST walk, and up to 2*MAX_TEST_CASES (16) plain Python
 * function calls with zero I/O and zero real sleeping -- a wide, generous
 * multiple of the realistic sub-50ms cost of that, matching this session's
 * numerical_precision/retry_backoff_resilience sizing rationale exactly.
 * Comfortably under the outer sandbox command budget (120000ms, helpers.js's
 * OUTER_SANDBOX_BUDGET_MS).
 */
'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 10000;
const MAX_CODE_CHARS = 12000;
const MIN_CODE_CHARS = 40;
const MIN_NONBLANK_LINES = 3;
const MIN_JACCARD = 0.35;
const MIN_TEST_CASES = 3;
const MAX_TEST_CASES = 8;
const MAX_ARGS = 6;
const MIN_CONV = 1;
const MAX_CONV = 20;

const TRANSFORMATION_TYPES = [
  'rename_identifier',
  'percent_format_to_fstring',
  'hoist_nested_imports',
  'listcomp_to_genexpr',
  'add_param_type_hints',
  'eq_none_to_is_none',
  'except_pass_to_logging',
  'remove_unused_import',
];

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function isIdent(s) { return typeof s === 'string' && s.length > 0 && s.length <= 80 && IDENT_RE.test(s); }
function boundedInt(v, min, max) { return Number.isInteger(v) && v >= min && v <= max ? v : null; }

// ------------------------------------------------- transformation_params ---

/** Validate transformation_params' shape against transformation_type.
 * Returns { ok, reason, params }. See schema.json's own help text for the
 * exact per-type key list this mirrors. */
function validateTransformationParams(type, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'transformation_params must be valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'transformation_params must be a JSON object' };
  }

  if (!isIdent(parsed.entry_point_original)) {
    return { ok: false, reason: 'transformation_params.entry_point_original must be a plain Python identifier naming a top-level function in original_code' };
  }
  if (!isIdent(parsed.entry_point_transformed)) {
    return { ok: false, reason: 'transformation_params.entry_point_transformed must be a plain Python identifier naming a top-level function in transformed_code' };
  }
  const params = { entry_point_original: parsed.entry_point_original, entry_point_transformed: parsed.entry_point_transformed };

  if (type === 'rename_identifier') {
    if (!isIdent(parsed.old_name)) return { ok: false, reason: 'transformation_params.old_name must be a plain Python identifier for transformation_type "rename_identifier"' };
    if (!isIdent(parsed.new_name)) return { ok: false, reason: 'transformation_params.new_name must be a plain Python identifier for transformation_type "rename_identifier"' };
    if (parsed.old_name === parsed.new_name) return { ok: false, reason: 'transformation_params.old_name and new_name must differ' };
    params.old_name = parsed.old_name;
    params.new_name = parsed.new_name;
    return { ok: true, params };
  }

  if (type === 'hoist_nested_imports') {
    const n = boundedInt(parsed.min_hoisted, MIN_CONV, MAX_CONV);
    if (n == null) return { ok: false, reason: 'transformation_params.min_hoisted must be an integer between ' + MIN_CONV + ' and ' + MAX_CONV + ' for transformation_type "hoist_nested_imports"' };
    params.min_hoisted = n;
    return { ok: true, params };
  }

  if (type === 'percent_format_to_fstring' || type === 'listcomp_to_genexpr' || type === 'eq_none_to_is_none' || type === 'except_pass_to_logging') {
    const n = boundedInt(parsed.min_conversions, MIN_CONV, MAX_CONV);
    if (n == null) return { ok: false, reason: 'transformation_params.min_conversions must be an integer between ' + MIN_CONV + ' and ' + MAX_CONV + ' for transformation_type "' + type + '"' };
    params.min_conversions = n;
    return { ok: true, params };
  }

  if (type === 'add_param_type_hints') {
    if (!isIdent(parsed.function_name)) return { ok: false, reason: 'transformation_params.function_name must be a plain Python identifier for transformation_type "add_param_type_hints"' };
    if (!Array.isArray(parsed.params) || parsed.params.length < 1 || parsed.params.length > 6) {
      return { ok: false, reason: 'transformation_params.params must be a JSON array of 1-6 entries for transformation_type "add_param_type_hints"' };
    }
    const ALLOWED = ['int', 'float', 'str', 'bool'];
    const list = [];
    const seen = new Set();
    for (let i = 0; i < parsed.params.length; i++) {
      const p = parsed.params[i];
      if (!p || typeof p !== 'object' || Array.isArray(p) || !isIdent(p.name) || !ALLOWED.includes(p.type)) {
        return { ok: false, reason: 'transformation_params.params[' + i + '] must be {"name": <identifier>, "type": one of ' + ALLOWED.join('/') + '}' };
      }
      if (seen.has(p.name)) return { ok: false, reason: 'transformation_params.params has a duplicate parameter name ' + JSON.stringify(p.name) };
      seen.add(p.name);
      list.push({ name: p.name, type: p.type });
    }
    params.function_name = parsed.function_name;
    params.params = list;
    return { ok: true, params };
  }

  if (type === 'remove_unused_import') {
    if (!isIdent(parsed.bound_name)) return { ok: false, reason: 'transformation_params.bound_name must be a plain Python identifier for transformation_type "remove_unused_import"' };
    params.bound_name = parsed.bound_name;
    return { ok: true, params };
  }

  return { ok: false, reason: 'unrecognized transformation_type "' + type + '"' };
}

// ------------------------------------------------------- behavior_check ---

function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k]);
    return o;
  }
  return v;
}

/** JSON-value equality, with a small numeric tolerance when BOTH sides are
 * plain numbers (guards against harmless float-representation noise between
 * two independently-executed call paths without weakening exact comparison
 * for every other JSON type). */
function jsonEqualCanonical(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    const diff = Math.abs(a - b);
    return diff < 1e-9 || diff <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
  }
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/** Validate behavior_check's shape and the anti-hardcoding floors (see
 * module doc comment). Returns { ok, reason, cases }. Each case:
 * { args, kwargs, expected_output, expect_log_call }. */
function validateBehaviorCheck(raw, transformationType) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'behavior_check must be valid JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'behavior_check must be a JSON array' };
  }
  if (parsed.length < MIN_TEST_CASES || parsed.length > MAX_TEST_CASES) {
    return { ok: false, reason: 'behavior_check must contain between ' + MIN_TEST_CASES + ' and ' + MAX_TEST_CASES + ' test cases' };
  }

  const cases = [];
  for (let i = 0; i < parsed.length; i++) {
    const c = parsed[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, reason: 'behavior_check[' + i + '] must be a JSON object' };
    if (!Array.isArray(c.args) || c.args.length > MAX_ARGS) {
      return { ok: false, reason: 'behavior_check[' + i + '].args must be a JSON array of at most ' + MAX_ARGS + ' values' };
    }
    let kwargs = {};
    if (c.kwargs !== undefined) {
      if (!c.kwargs || typeof c.kwargs !== 'object' || Array.isArray(c.kwargs)) {
        return { ok: false, reason: 'behavior_check[' + i + '].kwargs must be a JSON object if present' };
      }
      kwargs = c.kwargs;
    }
    if (!Object.prototype.hasOwnProperty.call(c, 'expected_output')) {
      return { ok: false, reason: 'behavior_check[' + i + '] must include an expected_output key' };
    }
    let expectLog = false;
    if (c.expect_log_call !== undefined) {
      if (typeof c.expect_log_call !== 'boolean') return { ok: false, reason: 'behavior_check[' + i + '].expect_log_call must be a boolean if present' };
      expectLog = c.expect_log_call;
    }
    cases.push({ args: c.args, kwargs, expected_output: c.expected_output, expect_log_call: expectLog });
  }

  // ANTI-HARDCODING FLOORS -- see module doc comment (ANTI-GAMING).
  const allArgsIdentical = cases.every((c) => JSON.stringify(c.args) === JSON.stringify(cases[0].args) && JSON.stringify(c.kwargs) === JSON.stringify(cases[0].kwargs));
  if (allArgsIdentical) {
    return { ok: false, reason: 'every behavior_check test case calls the entry point with the exact same args/kwargs -- at least one pair of cases must differ to genuinely exercise data-dependent behavior' };
  }
  const allOutputsIdentical = cases.every((c) => jsonEqualCanonical(c.expected_output, cases[0].expected_output));
  if (allOutputsIdentical) {
    return { ok: false, reason: 'every behavior_check test case declares the exact same expected_output -- at least two cases must produce genuinely different outputs, or a hardcoded-constant transformed_code could pass this check with no real logic at all' };
  }

  if (transformationType === 'except_pass_to_logging' && !cases.some((c) => c.expect_log_call)) {
    return {
      ok: false,
      reason: 'transformation_type "except_pass_to_logging" requires at least one behavior_check test case with expect_log_call:true -- a row that never actually exercises the new logging call tests nothing this transformation_type doesn\'t already share with a no-op',
    };
  }

  return { ok: true, cases };
}

// ------------------------------------------ structural anti-gaming (JS) ---
// Ported from static_lint_rule_fix_verification's own proven mechanism --
// see that file's module doc comment (STRUCTURAL SIMILARITY FLOOR) for the
// original reasoning, adapted here to the analogous "not an unrelated
// replacement" concern (see this file's own module doc comment, ANTI-GAMING).

function nonBlankLineCount(code) {
  return String(code).split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0).length;
}

function tokenSet(code) {
  const out = new Set();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m;
  while ((m = re.exec(code))) out.add(m[0]);
  return out;
}

function jaccardSimilarity(codeA, codeB) {
  const a = tokenSet(codeA);
  const b = tokenSet(codeB);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// --------------------------------------------------------- python driver ---

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/** See module doc comment (SECRET-LEAK PREVENTION): strips expected_output/
 * expect_log_call before anything crosses into the Python subprocess -- only
 * args/kwargs (real function inputs, not a secret) are ever sent. */
function stripForPython(cases) {
  return cases.map((c) => ({ args: c.args, kwargs: c.kwargs }));
}

// Module-level Python helper/check functions -- defined OUTSIDE _main() (0
// indentation) deliberately, unlike this session's other buildDriverScript
// functions which nest everything inside _main(): this file's per-type
// check functions are long enough that an extra indentation level across
// all of them meaningfully raises the risk of an indentation mistake in a
// plain-text JS array with no editor/linter support for the embedded
// Python. Functionally equivalent either way (a single dedicated subprocess
// per verify() call either way) -- purely a hand-authoring-safety choice.
var PY_HELPERS = [
  "def _fail(reason):",
  "    return {'ok': False, 'reason': reason}",
  "",
  "def _ok():",
  "    return {'ok': True}",
  "",
  "def _name_refs(tree, name):",
  "    return [n for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id == name]",
  "",
  "def _func_defs(tree, name):",
  "    return [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name]",
  "",
  "def _find_toplevel_func(tree, name):",
  "    for top in tree.body:",
  "        if isinstance(top, (ast.FunctionDef, ast.AsyncFunctionDef)) and top.name == name:",
  "            return top",
  "    return None",
  "",
  "def _arg_names(fn):",
  "    return [a.arg for a in fn.args.args]",
  "",
  "# ---- rename_identifier ----",
  "def check_rename_identifier(ot, tt, params):",
  "    old = params.get('old_name')",
  "    new = params.get('new_name')",
  "    orig_refs = _name_refs(ot, old)",
  "    orig_defs = _func_defs(ot, old)",
  "    if not orig_refs and not orig_defs:",
  "        return _fail('old_name %r does not appear anywhere in original_code -- nothing to rename' % (old,))",
  "    trans_refs = _name_refs(tt, old)",
  "    trans_defs = _func_defs(tt, old)",
  "    if trans_refs or trans_defs:",
  "        return _fail('transformed_code still references or defines %r -- the rename was not applied everywhere' % (old,))",
  "    if orig_defs and not _func_defs(tt, new):",
  "        return _fail('transformed_code does not define a function named %r (original_code defined %r as a function)' % (new, old))",
  "    trans_new_refs = _name_refs(tt, new)",
  "    if len(trans_new_refs) < len(orig_refs):",
  "        return _fail('transformed_code has only %d reference(s) to %r, but original_code had %d reference(s) to %r -- not every call site appears to have been renamed' % (len(trans_new_refs), new, len(orig_refs), old))",
  "    return _ok()",
  "",
  "# ---- percent_format_to_fstring ----",
  "def _count_percent_fmt(tree):",
  "    return len([n for n in ast.walk(tree) if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Mod) and isinstance(n.left, ast.Constant) and isinstance(n.left.value, str)])",
  "",
  "def _count_fstrings(tree):",
  "    return len([n for n in ast.walk(tree) if isinstance(n, ast.JoinedStr)])",
  "",
  "def check_percent_format_to_fstring(ot, tt, params):",
  "    min_c = params.get('min_conversions', 1)",
  "    orig_pct = _count_percent_fmt(ot)",
  "    if orig_pct < min_c:",
  "        return _fail('original_code contains only %d %%-style formatting expression(s), fewer than transformation_params.min_conversions=%d' % (orig_pct, min_c))",
  "    remaining = _count_percent_fmt(tt)",
  "    if remaining > 0:",
  "        return _fail('transformed_code still contains %d unconverted %%-style formatting expression(s)' % (remaining,))",
  "    gained = _count_fstrings(tt) - _count_fstrings(ot)",
  "    if gained < min_c:",
  "        return _fail('transformed_code only gained %d new f-string(s), expected at least %d' % (gained, min_c))",
  "    return _ok()",
  "",
  "# ---- hoist_nested_imports ----",
  "def _nested_imports(tree):",
  "    out = []",
  "    for top in tree.body:",
  "        if isinstance(top, (ast.FunctionDef, ast.AsyncFunctionDef)):",
  "            for n in ast.walk(top):",
  "                if isinstance(n, (ast.Import, ast.ImportFrom)):",
  "                    out.append(n)",
  "    return out",
  "",
  "def _toplevel_import_names(tree):",
  "    names = set()",
  "    for top in tree.body:",
  "        if isinstance(top, ast.Import):",
  "            for a in top.names:",
  "                names.add(a.asname or a.name.split('.')[0])",
  "        elif isinstance(top, ast.ImportFrom):",
  "            for a in top.names:",
  "                names.add(a.asname or a.name)",
  "    return names",
  "",
  "def _imported_names(node):",
  "    out = set()",
  "    for a in node.names:",
  "        if isinstance(node, ast.Import):",
  "            out.add(a.asname or a.name.split('.')[0])",
  "        else:",
  "            out.add(a.asname or a.name)",
  "    return out",
  "",
  "def check_hoist_nested_imports(ot, tt, params):",
  "    min_h = params.get('min_hoisted', 1)",
  "    orig_nested = _nested_imports(ot)",
  "    if len(orig_nested) < min_h:",
  "        return _fail('original_code contains only %d import statement(s) nested inside a function body, fewer than transformation_params.min_hoisted=%d' % (len(orig_nested), min_h))",
  "    names_to_hoist = set()",
  "    for n in orig_nested:",
  "        names_to_hoist |= _imported_names(n)",
  "    trans_top_names = _toplevel_import_names(tt)",
  "    missing = names_to_hoist - trans_top_names",
  "    if missing:",
  "        return _fail('the following imported name(s) are not present as top-level imports in transformed_code: %s' % (', '.join(sorted(missing)),))",
  "    trans_nested = _nested_imports(tt)",
  "    if trans_nested:",
  "        return _fail('transformed_code still has %d import statement(s) nested inside a function body' % (len(trans_nested),))",
  "    return _ok()",
  "",
  "# ---- listcomp_to_genexpr ----",
  "def _count_listcomps(tree):",
  "    return len([n for n in ast.walk(tree) if isinstance(n, ast.ListComp)])",
  "",
  "def _count_genexprs(tree):",
  "    return len([n for n in ast.walk(tree) if isinstance(n, ast.GeneratorExp)])",
  "",
  "def _genexpr_wrapped_in_list(tree):",
  "    c = 0",
  "    for n in ast.walk(tree):",
  "        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'list' and len(n.args) == 1 and isinstance(n.args[0], ast.GeneratorExp):",
  "            c += 1",
  "    return c",
  "",
  "def check_listcomp_to_genexpr(ot, tt, params):",
  "    min_c = params.get('min_conversions', 1)",
  "    orig_lc = _count_listcomps(ot)",
  "    if orig_lc < min_c:",
  "        return _fail('original_code contains only %d list comprehension(s), fewer than transformation_params.min_conversions=%d' % (orig_lc, min_c))",
  "    trans_lc = _count_listcomps(tt)",
  "    reduced = orig_lc - trans_lc",
  "    if reduced < min_c:",
  "        return _fail('transformed_code only removed %d list comprehension(s), expected at least %d converted to generator expressions' % (reduced, min_c))",
  "    gained = _count_genexprs(tt) - _count_genexprs(ot)",
  "    if gained < min_c:",
  "        return _fail('transformed_code only gained %d new generator expression(s), expected at least %d' % (gained, min_c))",
  "    wrapped = _genexpr_wrapped_in_list(tt)",
  "    if wrapped > 0:",
  "        return _fail('%d generator expression(s) in transformed_code are immediately wrapped in list(...) -- this defeats the purpose of the conversion' % (wrapped,))",
  "    return _ok()",
  "",
  "# ---- add_param_type_hints ----",
  "def _annotation_name(ann):",
  "    if ann is None:",
  "        return None",
  "    if isinstance(ann, ast.Name):",
  "        return ann.id",
  "    if isinstance(ann, ast.Constant):",
  "        return ann.value",
  "    return None",
  "",
  "def check_add_param_type_hints(ot, tt, params):",
  "    fname = params.get('function_name')",
  "    wanted = params.get('params') or []",
  "    ofn = _find_toplevel_func(ot, fname)",
  "    tfn = _find_toplevel_func(tt, fname)",
  "    if ofn is None:",
  "        return _fail('original_code does not define a top-level function named %r' % (fname,))",
  "    if tfn is None:",
  "        return _fail('transformed_code does not define a top-level function named %r' % (fname,))",
  "    if _arg_names(ofn) != _arg_names(tfn):",
  "        return _fail('the parameter name/order of %r changed between original_code and transformed_code -- this transformation must only ADD annotations, never alter the signature' % (fname,))",
  "    oargs = dict((a.arg, a) for a in ofn.args.args)",
  "    targs = dict((a.arg, a) for a in tfn.args.args)",
  "    for spec in wanted:",
  "        pname = spec.get('name')",
  "        ptype = spec.get('type')",
  "        oa = oargs.get(pname)",
  "        if oa is None:",
  "            return _fail('original_code function %r has no parameter named %r' % (fname, pname))",
  "        if oa.annotation is not None:",
  "            return _fail('original_code parameter %r already has an annotation -- there is nothing to add' % (pname,))",
  "        ta = targs.get(pname)",
  "        if ta is None or ta.annotation is None:",
  "            return _fail('transformed_code parameter %r has no annotation added' % (pname,))",
  "        if _annotation_name(ta.annotation) != ptype:",
  "            return _fail('transformed_code parameter %r has annotation %s, expected %r' % (pname, ast.dump(ta.annotation), ptype))",
  "    return _ok()",
  "",
  "# ---- eq_none_to_is_none ----",
  "def _has_none_operand(n):",
  "    operands = [n.left] + list(n.comparators)",
  "    return any(isinstance(o, ast.Constant) and o.value is None for o in operands)",
  "",
  "def _count_eq_none(tree):",
  "    c = 0",
  "    for n in ast.walk(tree):",
  "        if isinstance(n, ast.Compare) and len(n.ops) == 1 and isinstance(n.ops[0], (ast.Eq, ast.NotEq)) and _has_none_operand(n):",
  "            c += 1",
  "    return c",
  "",
  "def _count_is_none(tree):",
  "    c = 0",
  "    for n in ast.walk(tree):",
  "        if isinstance(n, ast.Compare) and len(n.ops) == 1 and isinstance(n.ops[0], (ast.Is, ast.IsNot)) and _has_none_operand(n):",
  "            c += 1",
  "    return c",
  "",
  "def check_eq_none_to_is_none(ot, tt, params):",
  "    min_c = params.get('min_conversions', 1)",
  "    orig_eq = _count_eq_none(ot)",
  "    if orig_eq < min_c:",
  "        return _fail('original_code contains only %d ==/!= None comparison(s), fewer than transformation_params.min_conversions=%d' % (orig_eq, min_c))",
  "    remaining = _count_eq_none(tt)",
  "    if remaining > 0:",
  "        return _fail('transformed_code still contains %d ==/!= None comparison(s)' % (remaining,))",
  "    gained = _count_is_none(tt) - _count_is_none(ot)",
  "    if gained < min_c:",
  "        return _fail('transformed_code only gained %d new is/is-not None comparison(s), expected at least %d' % (gained, min_c))",
  "    return _ok()",
  "",
  "# ---- except_pass_to_logging ----",
  "_LOG_METHOD_NAMES = set(['exception', 'error', 'warning', 'critical'])",
  "_LOG_BASE_NAMES = set(['logging', 'logger', 'log'])",
  "",
  "def _bare_pass_handlers(tree):",
  "    return [n for n in ast.walk(tree) if isinstance(n, ast.ExceptHandler) and len(n.body) == 1 and isinstance(n.body[0], ast.Pass)]",
  "",
  "def _handler_has_log_call(handler):",
  "    for n in ast.walk(handler):",
  "        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in _LOG_METHOD_NAMES:",
  "            base = n.func.value",
  "            base_name = base.id if isinstance(base, ast.Name) else (base.attr if isinstance(base, ast.Attribute) else None)",
  "            if base_name and base_name.lower() in _LOG_BASE_NAMES:",
  "                return True",
  "    return False",
  "",
  "def check_except_pass_to_logging(ot, tt, params):",
  "    min_c = params.get('min_conversions', 1)",
  "    orig_handlers = _bare_pass_handlers(ot)",
  "    if len(orig_handlers) < min_c:",
  "        return _fail('original_code contains only %d bare \"except ...: pass\" handler(s), fewer than transformation_params.min_conversions=%d' % (len(orig_handlers), min_c))",
  "    trans_bare = _bare_pass_handlers(tt)",
  "    if trans_bare:",
  "        return _fail('transformed_code still has %d bare \"except ...: pass\" handler(s) that were not converted' % (len(trans_bare),))",
  "    trans_handlers = [n for n in ast.walk(tt) if isinstance(n, ast.ExceptHandler)]",
  "    logged = sum(1 for h in trans_handlers if _handler_has_log_call(h))",
  "    if logged < min_c:",
  "        return _fail('transformed_code has only %d except-handler(s) with a real logging call (e.g. logging.exception/error/warning/critical), expected at least %d' % (logged, min_c))",
  "    return _ok()",
  "",
  "# ---- remove_unused_import ----",
  "def _toplevel_import_binds(tree, name):",
  "    out = []",
  "    for top in tree.body:",
  "        if isinstance(top, ast.Import):",
  "            for a in top.names:",
  "                if (a.asname or a.name.split('.')[0]) == name:",
  "                    out.append(top)",
  "        elif isinstance(top, ast.ImportFrom):",
  "            for a in top.names:",
  "                if (a.asname or a.name) == name:",
  "                    out.append(top)",
  "    return out",
  "",
  "def check_remove_unused_import(ot, tt, params):",
  "    bound = params.get('bound_name')",
  "    binds = _toplevel_import_binds(ot, bound)",
  "    if not binds:",
  "        return _fail('original_code has no top-level import binding the name %r' % (bound,))",
  "    if _name_refs(ot, bound):",
  "        return _fail('original_code actually USES %r elsewhere -- this import is not unused, so removing it would be a behavior-changing edit, not a valid remove_unused_import transformation' % (bound,))",
  "    if _toplevel_import_binds(tt, bound):",
  "        return _fail('transformed_code still imports %r' % (bound,))",
  "    return _ok()",
  "",
  "STRUCTURAL_CHECKS = {",
  "    'rename_identifier': check_rename_identifier,",
  "    'percent_format_to_fstring': check_percent_format_to_fstring,",
  "    'hoist_nested_imports': check_hoist_nested_imports,",
  "    'listcomp_to_genexpr': check_listcomp_to_genexpr,",
  "    'add_param_type_hints': check_add_param_type_hints,",
  "    'eq_none_to_is_none': check_eq_none_to_is_none,",
  "    'except_pass_to_logging': check_except_pass_to_logging,",
  "    'remove_unused_import': check_remove_unused_import,",
  "}",
].join('\n');

/** The Python driver -- see module doc comment (SECRET-LEAK PREVENTION,
 * EXECUTION SAFETY, GATE ORDER). testCasesForPython carries ONLY args/kwargs
 * (see stripForPython above) -- expected_output/expect_log_call never cross
 * into this subprocess at all. */
function buildDriverScript(pyPrelude, originalCode, transformedCode, transformationType, params, testCasesForPython, mark) {
  return [
    'import sys, os, json, ast',
    '',
    pyPrelude,
    '',
    PY_HELPERS,
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark),
    '    ORIGINAL_SRC = ' + pyStr(originalCode),
    '    TRANSFORMED_SRC = ' + pyStr(transformedCode),
    '    TRANSFORMATION_TYPE = ' + pyStr(transformationType),
    '    PARAMS = json.loads(' + pyStr(JSON.stringify(params)) + ')',
    '    TEST_CASES = json.loads(' + pyStr(JSON.stringify(testCasesForPython)) + ')',
    '    ENTRY_ORIG = PARAMS.get(\'entry_point_original\')',
    '    ENTRY_TRANS = PARAMS.get(\'entry_point_transformed\')',
    '    _real_write = os.write',
    '    result = {\'stage\': \'started\'}',
    '',
    '    def _emit():',
    '        _real_write(1, (MARK + json.dumps(result, default=str) + "\\n").encode(\'utf-8\', \'replace\'))',
    '',
    '    try:',
    '        orig_tree = ast.parse(ORIGINAL_SRC, \'<original_code>\')',
    '    except SyntaxError as e:',
    '        result[\'stage\'] = \'original_syntax_error\'',
    '        result[\'error\'] = repr(e)',
    '        _emit(); return',
    '    try:',
    '        trans_tree = ast.parse(TRANSFORMED_SRC, \'<transformed_code>\')',
    '    except SyntaxError as e:',
    '        result[\'stage\'] = \'transformed_syntax_error\'',
    '        result[\'error\'] = repr(e)',
    '        _emit(); return',
    '',
    '    checker = STRUCTURAL_CHECKS.get(TRANSFORMATION_TYPE)',
    '    if checker is None:',
    '        result[\'stage\'] = \'unrecognized_transformation_type\'',
    '        _emit(); return',
    '    struct = checker(orig_tree, trans_tree, PARAMS)',
    '    result[\'structural\'] = struct',
    '    result[\'stage\'] = \'structural_checked\'',
    '    _emit()',
    '    if not struct.get(\'ok\'):',
    '        result[\'stage\'] = \'ok\'',
    '        _emit(); return',
    '',
    '    def _load(src, label):',
    '        ns = {}',
    '        try:',
    '            exec(compile(src, \'<%s>\' % label, \'exec\'), ns)',
    '        except BaseException as e:',
    '            return None, repr(e)',
    '        return ns, None',
    '',
    '    ns_orig, err_orig = _load(ORIGINAL_SRC, \'original_code\')',
    '    if ns_orig is None:',
    '        result[\'stage\'] = \'original_load_failed\'',
    '        result[\'error\'] = err_orig',
    '        _emit(); return',
    '    fn_orig = ns_orig.get(ENTRY_ORIG)',
    '    if not callable(fn_orig):',
    '        result[\'stage\'] = \'original_entry_point_missing\'',
    '        _emit(); return',
    '',
    '    def _call(fn, case):',
    '        args = case.get(\'args\') or []',
    '        kwargs = case.get(\'kwargs\') or {}',
    '        try:',
    '            v = fn(*args, **kwargs)',
    '        except BaseException as e:',
    '            return {\'ok\': False, \'error\': repr(e)}',
    '        try:',
    '            json.dumps(v)',
    '        except Exception:',
    '            return {\'ok\': False, \'error\': \'return value is not JSON-serializable: %r\' % (v,)}',
    '        return {\'ok\': True, \'value\': v}',
    '',
    '    orig_results = []',
    '    for case in TEST_CASES:',
    '        orig_results.append(_call(fn_orig, case))',
    '        result[\'origResults\'] = orig_results',
    '        _emit()',
    '    result[\'stage\'] = \'original_executed\'',
    '    _emit()',
    '',
    '    ns_trans, err_trans = _load(TRANSFORMED_SRC, \'transformed_code\')',
    '    if ns_trans is None:',
    '        result[\'stage\'] = \'transformed_load_failed\'',
    '        result[\'error\'] = err_trans',
    '        _emit(); return',
    '    fn_trans = ns_trans.get(ENTRY_TRANS)',
    '    if not callable(fn_trans):',
    '        result[\'stage\'] = \'transformed_entry_point_missing\'',
    '        _emit(); return',
    '',
    '    import logging as _logging_mod',
    '    _log_calls = []',
    '',
    '    def _make_module_recorder(name):',
    '        def _rec(*a, **k):',
    '            _log_calls.append(name)',
    '        return _rec',
    '',
    '    def _make_method_recorder(name):',
    '        def _rec(self, *a, **k):',
    '            _log_calls.append(name)',
    '        return _rec',
    '',
    '    for _m in (\'exception\', \'error\', \'warning\', \'critical\'):',
    '        setattr(_logging_mod, _m, _make_module_recorder(_m))',
    '        setattr(_logging_mod.Logger, _m, _make_method_recorder(_m))',
    '',
    '    trans_results = []',
    '    for case in TEST_CASES:',
    '        del _log_calls[:]',
    '        r = _call(fn_trans, case)',
    '        r[\'logCalled\'] = len(_log_calls) > 0',
    '        trans_results.append(r)',
    '        result[\'transResults\'] = trans_results',
    '        _emit()',
    '    result[\'stage\'] = \'ok\'',
    '    _emit()',
    '',
    '_main()',
  ].join('\n');
}

module.exports = {
  contract: 'transformation-plus-behavior-preservation',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const transformationType = h.str(row, 'transformation_type').trim();
    const transformationParamsRaw = h.str(row, 'transformation_params');
    const originalCode = h.str(row, 'original_code');
    const transformedCode = h.str(row, 'transformed_code');
    const behaviorCheckRaw = h.str(row, 'behavior_check');

    if (!taskDescription.trim() || !transformationType || !transformationParamsRaw.trim() || !originalCode.trim() || !transformedCode.trim() || !behaviorCheckRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, transformation_type, transformation_params, original_code, transformed_code, or behavior_check' } };
    }

    if (!TRANSFORMATION_TYPES.includes(transformationType)) {
      return {
        passed: false,
        logs: 'transformation_type "' + transformationType + '" is not one of the recognized values: ' + TRANSFORMATION_TYPES.join(', '),
        detail: { reason: 'unrecognized_transformation_type' },
      };
    }

    const paramsCheck = validateTransformationParams(transformationType, transformationParamsRaw);
    if (!paramsCheck.ok) {
      return { passed: false, logs: paramsCheck.reason, detail: { reason: 'bad_transformation_params' } };
    }
    const params = paramsCheck.params;

    const behaviorCheck = validateBehaviorCheck(behaviorCheckRaw, transformationType);
    if (!behaviorCheck.ok) {
      return { passed: false, logs: behaviorCheck.reason, detail: { reason: 'bad_behavior_check' } };
    }
    const cases = behaviorCheck.cases;

    if (originalCode.length > MAX_CODE_CHARS || transformedCode.length > MAX_CODE_CHARS) {
      return { passed: false, logs: 'original_code/transformed_code exceed the ' + MAX_CODE_CHARS + '-character cap for this category', detail: { reason: 'too_large' } };
    }
    if (originalCode.trim().length < MIN_CODE_CHARS || transformedCode.trim().length < MIN_CODE_CHARS || nonBlankLineCount(originalCode) < MIN_NONBLANK_LINES || nonBlankLineCount(transformedCode) < MIN_NONBLANK_LINES) {
      return {
        passed: false,
        logs: 'original_code/transformed_code must each be a real, non-trivial snippet (at least ' + MIN_NONBLANK_LINES + ' non-blank lines and ' + MIN_CODE_CHARS + ' characters)',
        detail: { reason: 'too_trivial' },
      };
    }

    // ANTI-GAMING gate 1 -- see module doc comment (ANTI-GAMING, threat 1).
    if (originalCode.replace(/\s+/g, ' ').trim() === transformedCode.replace(/\s+/g, ' ').trim()) {
      return { passed: false, logs: 'transformed_code is identical to original_code (ignoring whitespace) -- this is not a transformation', detail: { reason: 'identical_to_original' } };
    }

    // ANTI-GAMING gate 2 -- see module doc comment (ANTI-GAMING, threat 2).
    const similarity = jaccardSimilarity(originalCode, transformedCode);
    if (similarity < MIN_JACCARD) {
      return {
        passed: false,
        logs: 'transformed_code has diverged too far structurally from original_code (identifier-token similarity ' + similarity.toFixed(2) + ' < ' + MIN_JACCARD + ') -- looks like an unrelated rewrite rather than a genuine transformation OF original_code',
        detail: { reason: 'too_dissimilar', similarity },
      };
    }

    // Cheap static pre-flight before ever spawning python3 -- mirrors
    // numerical_precision's own "def solve(" structural check.
    const entryOrigRe = new RegExp('^\\s*def\\s+' + params.entry_point_original + '\\s*\\(', 'm');
    if (!entryOrigRe.test(originalCode)) {
      return { passed: false, logs: 'original_code does not define a top-level function named ' + params.entry_point_original + ' (transformation_params.entry_point_original)', detail: { reason: 'no_entry_point_original' } };
    }
    const entryTransRe = new RegExp('^\\s*def\\s+' + params.entry_point_transformed + '\\s*\\(', 'm');
    if (!entryTransRe.test(transformedCode)) {
      return { passed: false, logs: 'transformed_code does not define a top-level function named ' + params.entry_point_transformed + ' (transformation_params.entry_point_transformed)', detail: { reason: 'no_entry_point_transformed' } };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    const d = h.workdir();
    const mark = '@@ASTCODEMODROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = buildDriverScript(h.PY_PRELUDE, originalCode, transformedCode, transformationType, params, stripForPython(cases), mark);
    const scriptPath = h.path.join(d, 'run_ast_codemod.py');
    h.fs.writeFileSync(scriptPath, script);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: checkpointed
    // per-test-case emits could exceed the report-bounding cap before the
    // trailing "ok" marker line is reached for a row near MAX_TEST_CASES.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }

    if (!out || typeof out !== 'object' || !out.stage) {
      return {
        passed: false,
        logs: r.timedOut
          ? ('verification did not complete within the ' + TIMEOUT_MS + 'ms budget -- for work this small (AST parsing plus a handful of plain function calls), this is itself a real failure, not an infra problem')
          : ('could not parse verification output: ' + String(r.stderr || '').slice(0, 500)),
        detail: { reason: 'unparseable_output', timedOut: !!r.timedOut },
      };
    }

    if (out.stage === 'original_syntax_error') {
      return { passed: false, logs: 'original_code failed to parse as Python: ' + String(out.error || '').slice(0, 500), detail: { reason: 'original_syntax_error' } };
    }
    if (out.stage === 'transformed_syntax_error') {
      return { passed: false, logs: 'transformed_code failed to parse as Python: ' + String(out.error || '').slice(0, 500), detail: { reason: 'transformed_syntax_error' } };
    }
    if (out.stage === 'unrecognized_transformation_type') {
      return { passed: false, logs: 'harness could not resolve a structural checker for transformation_type "' + transformationType + '"', detail: { reason: 'unrecognized_transformation_type' } };
    }

    const structural = out.structural;
    if (!structural || typeof structural !== 'object') {
      return { passed: false, logs: 'structural check did not complete', detail: { reason: 'structural_incomplete' } };
    }
    if (structural.ok !== true) {
      return {
        passed: false,
        logs: 'STRUCTURAL check failed for transformation_type "' + transformationType + '": ' + String(structural.reason || '').slice(0, 500),
        detail: { reason: 'transformation_not_applied', structuralReason: structural.reason },
      };
    }

    if (out.stage === 'original_load_failed') {
      return { passed: false, logs: 'original_code failed to load: ' + String(out.error || '').slice(0, 800), detail: { reason: 'original_load_failed' } };
    }
    if (out.stage === 'original_entry_point_missing') {
      return { passed: false, logs: 'original_code does not define ' + params.entry_point_original + ' after exec (transformation_params.entry_point_original)', detail: { reason: 'original_entry_point_missing' } };
    }

    const origResults = Array.isArray(out.origResults) ? out.origResults : [];
    for (let i = 0; i < cases.length; i++) {
      const r0 = origResults[i];
      if (!r0 || r0.ok !== true) {
        return {
          passed: false,
          logs: 'original_code\'s own entry point (' + params.entry_point_original + ') raised on behavior_check[' + i + ']: ' + String((r0 && r0.error) || 'no result').slice(0, 500) + ' -- dataset-authoring defect (original_code + behavior_check are curator-declared ground truth, checked before transformed_code is ever graded)',
          detail: { reason: 'bad_original_behavior', index: i },
        };
      }
      if (!jsonEqualCanonical(r0.value, cases[i].expected_output)) {
        return {
          passed: false,
          logs: 'original_code\'s own entry point returned ' + JSON.stringify(r0.value).slice(0, 300) + ' on behavior_check[' + i + '] but expected_output declares ' + JSON.stringify(cases[i].expected_output).slice(0, 300) + ' -- dataset-authoring defect',
          detail: { reason: 'bad_original_behavior', index: i },
        };
      }
    }

    if (out.stage === 'transformed_load_failed') {
      return { passed: false, logs: 'transformed_code failed to load: ' + String(out.error || '').slice(0, 800), detail: { reason: 'transformed_load_failed' } };
    }
    if (out.stage === 'transformed_entry_point_missing') {
      return { passed: false, logs: 'transformed_code does not define ' + params.entry_point_transformed + ' after exec (transformation_params.entry_point_transformed)', detail: { reason: 'transformed_entry_point_missing' } };
    }
    if (out.stage !== 'ok') {
      return { passed: false, logs: 'verification did not complete (stage=' + String(out.stage) + ')', detail: { reason: 'incomplete', stage: out.stage } };
    }

    const transResults = Array.isArray(out.transResults) ? out.transResults : [];
    for (let i = 0; i < cases.length; i++) {
      const rt = transResults[i];
      if (!rt || rt.ok !== true) {
        return {
          passed: false,
          logs: 'transformed_code\'s entry point (' + params.entry_point_transformed + ') raised on behavior_check[' + i + ']: ' + String((rt && rt.error) || 'no result').slice(0, 500),
          detail: { reason: 'transformed_behavior_mismatch', index: i },
        };
      }
      if (!jsonEqualCanonical(rt.value, cases[i].expected_output)) {
        return {
          passed: false,
          logs: 'transformed_code returned ' + JSON.stringify(rt.value).slice(0, 300) + ' on behavior_check[' + i + '] but expected ' + JSON.stringify(cases[i].expected_output).slice(0, 300) + ' -- the transformation did not preserve behavior',
          detail: { reason: 'transformed_behavior_mismatch', index: i },
        };
      }
      if (cases[i].expect_log_call && !rt.logCalled) {
        return {
          passed: false,
          logs: 'behavior_check[' + i + '] declares expect_log_call:true, but no logging.exception/error/warning/critical call was observed while running transformed_code\'s entry point -- the claimed except_pass_to_logging transformation does not appear to actually log at runtime',
          detail: { reason: 'expected_log_call_missing', index: i },
        };
      }
    }

    return {
      passed: true,
      score: 1,
      detail: { reason: 'ok', transformationType, similarity },
    };
  },
};
