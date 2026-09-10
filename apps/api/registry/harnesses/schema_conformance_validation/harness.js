/**
 * schema-conformance-independent-oracle -- schema_conformance_validation.
 *
 * THE CONTRACT: validation_code (real, contributor-controlled Python) defines
 * exactly one top-level function `validate(payload_text: str) -> bool`. It is
 * called once per entry in test_payloads (curator-authored JSON/XML document
 * text, one document per array element) and its verdict must match the REAL,
 * independently-computed verdict from a TRUSTED library -- jsonschema for
 * "JSON Schema" rows, lxml.etree.XMLSchema for "XSD" rows -- for every single
 * payload. Ground truth is never derived from anything a row itself declares
 * as "expected" (no such field exists in this schema on purpose) and never
 * trusts validation_code's own verdict for computing it.
 *
 * ONE CATEGORY, ONE FORMAT-SELECTOR ENUM: mirrors serialization/harness.js's
 * own `format` enum spanning JSON/Protobuf/MessagePack/YAML/XML/Pickle in one
 * category -- `schema_language` ("JSON Schema" | "XSD") selects the
 * format-specific code path below rather than splitting into two categories.
 *
 * TEST_PAYLOADS SHAPE, DELIBERATELY NOT role:"list": a genuine JSON array
 * literal of raw document-text strings, parsed with JSON.parse by this file
 * itself -- the same convention sql_query_correctness's own expected_result
 * field uses. A role:"list" field only splits a genuine JS array correctly;
 * fed a plain string it comes back as ONE element holding the whole blob,
 * a documented, real gotcha this category sidesteps entirely by using an
 * ordinary field whose value literally IS JSON text.
 *
 * TWO SEPARATE python3 SUBPROCESSES, NOT ONE -- THE ANTI-LEAKAGE DESIGN
 * DECISION FOR THIS CATEGORY: an early single-process draft of this driver
 * computed ground truth (SCHEMA_OBJ, ground_truths) as local variables inside
 * one Python `_main()`, then called validation_code's `validate()` from
 * inside that SAME frame's call stack. Confirmed exploitable against that
 * draft: `sys._getframe(1)` (or repeated `.f_back` walks) from inside
 * `validate()` reaches `_main`'s own still-live frame and can read
 * `ground_truths`/`SCHEMA_OBJ` directly out of its locals -- a validate()
 * that does nothing but frame-walk for a variable named "ground_truth" and
 * echo the precomputed answer back, correlated by call order, scores a
 * perfect 1.0 while performing zero genuine validation. This is a strictly
 * more dangerous, more directly exploitable gap than the generic "raw
 * syscall bypasses every Python-level trap" residual documented elsewhere in
 * this registry (property_based_testing's/redis_data_structure_semantics's
 * own PY_PRELUDE comments) -- it is not a bypass of a defense, it is a
 * leaked answer key sitting in an ancestor stack frame, reachable with a few
 * lines of ordinary, undisguised Python. No amount of adding indirection
 * functions between _main and validate() closes it (frame-walking simply
 * walks one more `.f_back` hop); the only real fix is ensuring there is no
 * shared address space for it to walk into at all. This harness therefore
 * runs ground-truth computation and validation_code execution as TWO
 * genuinely separate OS processes: buildOracleScript's process NEVER sees
 * validation_code (it is not even passed as an argument), and
 * buildContributorScript's process NEVER sees schema_definition, the parsed
 * SCHEMA_OBJ, or the computed ground_truths array (it only receives
 * validation_code + the raw test_payloads text) -- there is no process
 * memory for a frame-walk to reach across, closing the leak structurally
 * rather than relying on validation_code choosing not to look. Mirrors this
 * registry's existing "separate connection/process so one side cannot
 * observe the other's state" discipline (redis_data_structure_semantics's
 * own verification_code getting a SEPARATE connection than solution_code),
 * translated to two OS processes here since there is no live server to
 * connect to a second time.
 *
 * ASYMMETRIC HARDENING BETWEEN THE TWO PROCESSES, ON PURPOSE: the oracle
 * process only ever touches CURATOR-authored content (schema_definition,
 * test_payloads -- both role: input_code, "never graded, never written by
 * the contributor", the same trust tier as property_based_testing's own
 * correct_implementation/broken_implementation) fed through the real,
 * vetted jsonschema/lxml libraries -- it never exec()'s anything, so it gets
 * no PY_PRELUDE exit-trap and no try/except BaseException wrapping (there is
 * no untrusted code path for either to guard). The contributor process gets
 * the FULL hardening tier this registry's other Python-exec categories use
 * (redis_data_structure_semantics, property_based_testing, vulnerability):
 * h.PY_PRELUDE spliced in verbatim (sys.exit/os._exit/os.abort/exit/quit
 * monkeypatched to raise), the exec() of validation_code wrapped in its own
 * try/except BaseException (catches a raw `raise SystemExit(...)` too), and
 * EACH of the N calls to the discovered validate() function individually
 * wrapped in its own try/except BaseException -- a validate() that raises on
 * one specific payload counts as only that ONE payload's verdict being
 * wrong, never a whole-row crash (this category's own explicit, documented
 * design choice; a single flaky/edge-case payload should not zero out an
 * otherwise-correct validator's score on every other payload). The final
 * verdict of BOTH processes is written via a per-run-random-marker-prefixed
 * line through a raw `os.write(1, ...)` fd write (never print()/
 * sys.stdout.write(), which resolve the reassignable `sys.stdout` object
 * fresh at every call), with the marker kept as a LOCAL inside each script's
 * own `_main()` function, never a bare top-level/__main__-scope statement --
 * same convention as redis_data_structure_semantics's/property_based_testing's
 * own final-marker hardening, so a cheap `sys.modules["__main__"].MARK`
 * probe from validation_code cannot read and pre-emptively echo it (and even
 * without that, h.lastMarked's LAST-line-wins rule already means any forged
 * marker-prefixed line validation_code prints during its own execution is
 * superseded by this file's genuine line, printed strictly afterward).
 * ACCEPTED RESIDUAL, not chased further, identical to every other
 * last-line-wins marker convention already in this registry: a raw-syscall
 * self-termination (`ctypes.CDLL(None)._exit(0)`,
 * `os.kill(os.getpid(), SIGKILL)`) bypasses every Python-level trap PY_PRELUDE
 * or this file installs.
 *
 * GATE ORDER (2-4 are dataset-authoring-defect rejections, evaluated ENTIRELY
 * inside the oracle process, before the contributor process is ever
 * launched -- both to match this category's own conceptual ordering and
 * because there is no reason to spend a second subprocess, or expose
 * test_payloads text to a to-be-exec'd contributor script, for a row that is
 * already known to be unusable):
 *   2. schema_definition itself must be valid per its own format --
 *      jsonschema.validators.validator_for(schema).check_schema(schema) for
 *      "JSON Schema" (resolves whichever draft the schema's own "$schema"
 *      key declares, or the library's latest-known draft if absent --
 *      confirmed via a real local jsonschema 4.25 install:
 *      validator_for({}) resolves to Draft202012Validator), or a real
 *      lxml.etree.XMLSchema(...) construction not raising for "XSD". A
 *      failure here is a dataset-authoring defect, not a contributor
 *      failure -- rejected outright (passed:false), never runtimeUnavailable
 *      (the trusted library ran fine; what it was asked to parse was bad),
 *      matching this registry's "reject dataset defects at their own gate"
 *      convention already used by the SQL siblings.
 *   3. Ground truth is computed for EVERY test_payloads entry via the SAME
 *      trusted library. A payload that is not even well-formed JSON/XML is
 *      real, meaningful ground truth of FALSE (it cannot conform to any
 *      schema if it isn't a document of the right kind at all) -- distinct
 *      from an unexpected ENGINE error (e.g. a schema_definition with a
 *      dangling/unresolvable "$ref": confirmed via a real local probe that
 *      jsonschema 4.25's referencing-based resolver raises
 *      `Unresolvable` immediately with NO network attempt at all when a
 *      schema references an unfetchable URI -- this category needs no
 *      socket-timeout/network hardening of its own for that specific risk,
 *      since the library itself never reaches for the network by default;
 *      confirmed NOT a subclass of jsonschema.exceptions.ValidationError, so
 *      it cannot be misclassified as "this payload is merely invalid").
 *      An engine error on any payload marks the WHOLE ROW a dataset defect
 *      (ground_truth_computation_failed) -- ground truth could not be
 *      reliably established, so nothing downstream can be trusted either.
 *   4. ANTI-GAMING GATE ON THE ROW ITSELF, NOT THE CONTRIBUTOR: if the real
 *      ground truth computed in step 3 is unanimous across every
 *      test_payloads entry (all valid, or all invalid), the row is REJECTED
 *      as inadequate. A hardcoded `return True`/`return False` validate()
 *      would trivially "pass" such a row, so every row must genuinely
 *      contain BOTH at least one really-valid and at least one
 *      really-invalid payload per the trusted oracle. THIS IS THE ENTIRE
 *      anti-hardcoding mechanism for this category -- deliberately, there is
 *      no fixed "must call jsonschema/lxml" provenance check (the kind
 *      vulnerability's/property_based_testing's harnesses use for their own
 *      categories): a contributor writing genuinely correct, hand-rolled
 *      validation logic that never imports jsonschema/lxml at all would be
 *      entirely legitimate here, not suspicious -- this category never
 *      checks HOW a verdict was reached, only whether it is correct, so a
 *      provenance/"must reference X" check would reject valid submissions
 *      for no real reason. The unanimous-ground-truth gate is judged
 *      sufficient BECAUSE it is the only shape of "trivial validator" that
 *      can pass without doing real work: with a genuine mix present, EVERY
 *      one of the N payloads independently has a 50% chance of exposing an
 *      `return True`/`return False`/`return random.choice(...)` constant or
 *      degenerate validator, and this category additionally requires ALL N
 *      to match (see REQUIRE-EVERY-PAYLOAD below), not just a majority --
 *      the larger test_payloads is (and the more evenly split), the lower
 *      the odds any non-genuine strategy survives by chance. A dataset
 *      curator who authors an inadequately-sized or lopsided-but-technically-
 *      mixed test_payloads set (e.g. 9 valid + 1 invalid) weakens this
 *      probabilistically without tripping the gate outright -- a documented,
 *      accepted authoring-discipline residual, the same "mitigated by
 *      dataset-authoring discipline, not verification-time logic" posture
 *      this registry already uses elsewhere (property_based_testing's own
 *      degenerate-@given-strategy residual, redis_data_structure_semantics's
 *      TTL-sleep-margin residual).
 *
 * REQUIRE-EVERY-PAYLOAD, NOT A THRESHOLD: validation_code's verdict must
 * match ground truth for every single entry in test_payloads, not merely a
 * majority or an average score -- one mismatch is a real failure. This is
 * what makes the anti-gaming gate above meaningfully strict (see its own
 * comment) and matches how the category is pitched: a schema validator that
 * is only sometimes right is not a correct validator.
 *
 * TIMEOUT BUDGET: two h.run('python3', ...) subprocess calls, each in one
 * short-lived process. No compilation step, no external server, no network
 * call (see the $ref-resolution finding above) -- jsonschema/lxml validating
 * a handful of small-to-medium JSON/XML documents is sub-second work in
 * practice. ORACLE_TIMEOUT_MS/CONTRIBUTOR_TIMEOUT_MS (each 20000ms) are
 * generous multiples of that expected real runtime, primarily to absorb a
 * cold sandbox's first-import tax for jsonschema/lxml (a substantial C
 * extension for lxml specifically -- the same cold-page-in tail latency
 * helpers.js's own ensureRustToolchain comment documents for rustc) rather
 * than any expected steady-state cost. The two calls combined (worst case
 * 40000ms) stay comfortably under the outer sandbox command budget
 * (120000ms, infra/terraform/ssm.tf's EXECUTION_RUNNER_TIMEOUT_MS, duplicated
 * in helpers.js as OUTER_SANDBOX_BUDGET_MS) with roughly 80000ms of margin,
 * the same "stay strictly under the outer budget, with an explicit
 * documented margin" discipline this registry enforces everywhere else.
 * A soft MAX_PAYLOADS cap (100) rejects a pathologically large test_payloads
 * array before either subprocess is ever launched -- defensive bound on
 * total per-row work, not a limit expected to matter for realistic authored
 * rows.
 */
'use strict';

const crypto = require('crypto');

const ORACLE_TIMEOUT_MS = 20000;
const CONTRIBUTOR_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 3000;
const MAX_PAYLOADS = 100;

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/** Embed a JS array of strings as a Python list-of-str literal, via
 * double-JSON-encoding (JSON.stringify the array, then pyStr the resulting
 * JSON text so it becomes a valid Python string literal) + json.loads(...)
 * on the Python side -- the same pyStr convention this registry already uses
 * for arbitrary code/text fields, applied once more to an array instead of a
 * single string. Avoids any Python literal-syntax edge case a payload's own
 * content (quotes, backslashes, newlines) could otherwise trigger. */
function pyStrList(arr) {
  return pyStr(JSON.stringify(arr));
}

/** True if `code` contains EXACTLY ONE top-level (zero leading whitespace --
 * a method nested inside a class must not count) `def validate(` -- this
 * category's fixed, required entrypoint name (simpler than discovering an
 * arbitrarily-named function the way property_based_testing's harness does,
 * since there is no competing "which function is graded" ambiguity to
 * resolve here: the name is part of the contract). */
function hasExactlyOneTopLevelValidate(code) {
  const m = code.match(/^def\s+validate\s*\(/gm);
  return !!m && m.length === 1;
}

/** The ground-truth-only driver. NEVER receives validation_code -- see this
 * file's module doc comment (TWO SEPARATE python3 SUBPROCESSES) for why that
 * separation is load-bearing, not incidental. Computes gates 2-4 and, if the
 * row is not rejected at either gate, emits `ground_truths` (one boolean per
 * test_payloads entry, in order) for the caller to combine with the
 * contributor process's own verdicts afterward. */
function buildOracleScript(schemaLanguage, schemaDefinition, payloads, mark) {
  const isJsonSchema = schemaLanguage === 'JSON Schema';
  const lines = [
    'import json, os',
    isJsonSchema ? 'import jsonschema' : 'import lxml.etree as etree',
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark),
    '    SCHEMA_DEFINITION = ' + pyStr(schemaDefinition),
    '    PAYLOADS = json.loads(' + pyStrList(payloads) + ')',
    '    result = {}',
    '',
    '    def _emit():',
    '        os.write(1, (MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
    '',
  ];
  if (isJsonSchema) {
    lines.push(
      '    try:',
      '        SCHEMA_OBJ = json.loads(SCHEMA_DEFINITION)',
      '    except Exception as e:',
      '        result["stage"] = "schema_definition_invalid"',
      '        result["error"] = "schema_definition is not valid JSON: " + repr(e)',
      '        _emit(); return',
      '    try:',
      '        _Validator = jsonschema.validators.validator_for(SCHEMA_OBJ)',
      '        _Validator.check_schema(SCHEMA_OBJ)',
      '    except Exception as e:',
      '        result["stage"] = "schema_definition_invalid"',
      '        result["error"] = repr(e)',
      '        _emit(); return',
      '',
      '    def _ground_truth(payload_text):',
      '        try:',
      '            obj = json.loads(payload_text)',
      '        except Exception:',
      '            return False, "malformed_json_payload"',
      '        try:',
      '            jsonschema.validate(instance=obj, schema=SCHEMA_OBJ, cls=_Validator)',
      '            return True, None',
      '        except jsonschema.exceptions.ValidationError as e:',
      '            return False, ("schema_violation: " + str(e))[:200]',
      '        except Exception as e:',
      '            return None, ("ground_truth_engine_error: " + repr(e))[:300]',
      '',
    );
  } else {
    lines.push(
      '    _XML_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, dtd_validation=False)',
      '    try:',
      '        _schema_root = etree.fromstring(SCHEMA_DEFINITION.encode("utf-8"), parser=_XML_PARSER)',
      '        XSD_SCHEMA = etree.XMLSchema(_schema_root)',
      '    except Exception as e:',
      '        result["stage"] = "schema_definition_invalid"',
      '        result["error"] = repr(e)',
      '        _emit(); return',
      '',
      '    def _ground_truth(payload_text):',
      '        try:',
      '            doc = etree.fromstring(payload_text.encode("utf-8"), parser=_XML_PARSER)',
      '        except Exception:',
      '            return False, "malformed_xml_payload"',
      '        try:',
      '            return bool(XSD_SCHEMA.validate(doc)), None',
      '        except Exception as e:',
      '            return None, ("ground_truth_engine_error: " + repr(e))[:300]',
      '',
    );
  }
  lines.push(
    '    ground_truths = []',
    '    for idx, payload in enumerate(PAYLOADS):',
    '        gt, note = _ground_truth(payload)',
    '        if gt is None:',
    '            result["stage"] = "ground_truth_computation_failed"',
    '            result["payload_index"] = idx',
    '            result["error"] = note',
    '            _emit(); return',
    '        ground_truths.append(gt)',
    '',
    '    all_valid = all(ground_truths)',
    '    all_invalid = not any(ground_truths)',
    '    if all_valid or all_invalid:',
    '        result["stage"] = "unanimous_ground_truth"',
    '        result["ground_truths"] = ground_truths',
    '        _emit(); return',
    '',
    '    result["stage"] = "ok"',
    '    result["ground_truths"] = ground_truths',
    '    _emit()',
    '',
    '_main()',
  );
  return lines.join('\n');
}

/** The contributor-execution-only driver. NEVER receives schema_definition,
 * the parsed schema object, or ground_truths -- see this file's module doc
 * comment (TWO SEPARATE python3 SUBPROCESSES) for why. Full PY_PRELUDE/
 * try-except-BaseException hardening throughout, since validation_code is
 * real, contributor-controlled Python sharing this process. */
function buildContributorScript(pyPrelude, validationCode, payloads, mark) {
  return [
    'import json, os',
    '',
    pyPrelude,
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark),
    '    VALIDATION_CODE = ' + pyStr(validationCode),
    '    PAYLOADS = json.loads(' + pyStrList(payloads) + ')',
    '    result = {}',
    '',
    '    def _emit():',
    '        os.write(1, (MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
    '',
    '    ns = {}',
    '    try:',
    '        exec(compile(VALIDATION_CODE, "<validation_code>", "exec"), ns)',
    '    except BaseException as e:',
    '        result["stage"] = "validation_code_load_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    validate_fn = ns.get("validate")',
    '    if not callable(validate_fn):',
    '        result["stage"] = "validate_function_not_found"',
    '        _emit(); return',
    '',
    '    verdicts = []',
    '    for idx, payload in enumerate(PAYLOADS):',
    '        try:',
    '            verdicts.append({"index": idx, "verdict": bool(validate_fn(payload)), "error": None})',
    '        except BaseException as e:',
    '            verdicts.append({"index": idx, "verdict": None, "error": repr(e)[:300]})',
    '',
    '    result["stage"] = "ok"',
    '    result["verdicts"] = verdicts',
    '    _emit()',
    '',
    '_main()',
  ].join('\n');
}

module.exports = {
  contract: 'schema-conformance-independent-oracle',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const schemaLanguage = h.str(row, 'schema_language').trim();
    const schemaDefinition = h.str(row, 'schema_definition');
    const testPayloadsRaw = h.str(row, 'test_payloads');
    const validationCode = h.str(row, 'validation_code');

    if (!taskDescription.trim() || !schemaLanguage || !schemaDefinition.trim() || !testPayloadsRaw.trim() || !validationCode.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, schema_language, schema_definition, test_payloads, or validation_code' } };
    }

    if (schemaLanguage !== 'JSON Schema' && schemaLanguage !== 'XSD') {
      return { passed: false, detail: { reason: 'schema_language must be exactly "JSON Schema" or "XSD"', schemaLanguage } };
    }

    // test_payloads must be a genuine JSON array of strings -- see this
    // file's module doc comment (TEST_PAYLOADS SHAPE) for why this is a
    // hand-parsed field rather than a role:"list" field. A malformed/wrong-
    // shaped field is a dataset-authoring defect, never routed to
    // runtimeUnavailable.
    let payloads;
    try {
      payloads = JSON.parse(testPayloadsRaw);
    } catch (e) {
      return { passed: false, detail: { reason: 'test_payloads is not valid JSON' } };
    }
    if (!Array.isArray(payloads) || payloads.length === 0 || !payloads.every((p) => typeof p === 'string')) {
      return { passed: false, detail: { reason: 'test_payloads must be a non-empty JSON array of document-text strings' } };
    }
    if (payloads.length > MAX_PAYLOADS) {
      return { passed: false, detail: { reason: 'test_payloads exceeds the ' + MAX_PAYLOADS + '-entry cap for this category', count: payloads.length } };
    }

    // Structural, cheap, checked before spending any sandbox time -- see
    // hasExactlyOneTopLevelValidate's own doc comment.
    if (!hasExactlyOneTopLevelValidate(validationCode)) {
      return {
        passed: false,
        logs: 'validation_code must define EXACTLY ONE top-level `def validate(payload_text):` -- this category\'s fixed entrypoint name',
        detail: { reason: 'not_exactly_one_top_level_validate_function' },
      };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }
    // Probed, not assumed from the Dockerfile/template.ts -- same discipline
    // every other optional-dependency category in this registry uses. Only
    // the library THIS row's schema_language actually needs is probed, so a
    // pure-XSD row is never held over a missing jsonschema (or vice versa).
    // jsonschema is a NEW E2B image dependency this category's own change
    // adds to template.ts -- until that template is rebuilt, every "JSON
    // Schema" row on the currently-published image routes here, to
    // runtimeUnavailable (human audit), never a false contributor failure.
    const neededModule = schemaLanguage === 'JSON Schema' ? 'jsonschema' : 'lxml.etree';
    const depOk = h.run('python3', ['-c', 'import ' + neededModule], { timeoutMs: PROBE_TIMEOUT_MS }).status === 0;
    if (!depOk) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: 'python ' + neededModule + ' unavailable in this sandbox image',
        detail: { reason: schemaLanguage === 'JSON Schema' ? 'no_jsonschema' : 'no_lxml' },
      };
    }

    const d = h.workdir();

    // ---- Oracle process: ground truth ONLY, never sees validation_code ----
    const oracleMark = '@@SCVROW_ORACLE_' + crypto.randomBytes(12).toString('hex') + '_';
    const oracleScript = buildOracleScript(schemaLanguage, schemaDefinition, payloads, oracleMark);
    const oraclePath = h.path.join(d, 'oracle.py');
    h.fs.writeFileSync(oraclePath, oracleScript);
    const oracleRun = h.run('python3', [oraclePath], { cwd: d, timeoutMs: ORACLE_TIMEOUT_MS });
    if (oracleRun.timedOut) {
      return { passed: false, logs: 'ground-truth computation did not complete within the time budget', detail: { reason: 'oracle_timed_out' } };
    }
    if (oracleRun.status !== 0) {
      return { passed: false, logs: String(oracleRun.stderr || '').slice(0, 1500), detail: { reason: 'oracle_crashed' } };
    }
    const oracleMarked = h.lastMarked(oracleRun.rawStdout != null ? oracleRun.rawStdout : oracleRun.stdout, oracleMark);
    let oracleOut = null;
    try { oracleOut = oracleMarked === null ? null : JSON.parse(oracleMarked); } catch (e) { oracleOut = null; }
    if (!oracleOut || typeof oracleOut !== 'object' || !oracleOut.stage) {
      return { passed: false, logs: 'could not parse ground-truth computation output', detail: { reason: 'oracle_unparseable_output' } };
    }

    if (oracleOut.stage === 'schema_definition_invalid') {
      // Dataset-authoring defect (the schema itself is broken), not a
      // contributor failure -- but still a real reject, not
      // runtimeUnavailable (see module doc comment, GATE ORDER #2).
      return {
        passed: false,
        logs: 'schema_definition is not valid ' + schemaLanguage + ': ' + String(oracleOut.error || '').slice(0, 800),
        detail: { reason: 'schema_definition_invalid' },
      };
    }
    if (oracleOut.stage === 'ground_truth_computation_failed') {
      return {
        passed: false,
        logs: 'could not compute real ground truth for test_payloads[' + oracleOut.payload_index + ']: ' + String(oracleOut.error || '').slice(0, 800),
        detail: { reason: 'ground_truth_computation_failed', payloadIndex: oracleOut.payload_index },
      };
    }
    if (oracleOut.stage === 'unanimous_ground_truth') {
      // The anti-gaming gate -- see module doc comment (GATE ORDER #4) for
      // full reasoning. A row whose real, independently-computed ground
      // truth is all-valid or all-invalid across every payload would let a
      // hardcoded validator trivially "pass" -- rejected as an inadequate
      // row, never scored against validation_code at all.
      return {
        passed: false,
        logs: 'test_payloads\' REAL ground truth (per the trusted ' + (schemaLanguage === 'JSON Schema' ? 'jsonschema' : 'lxml') + ' validator) is unanimous -- every payload is ' + (oracleOut.ground_truths[0] ? 'schema-VALID' : 'schema-INVALID') + '. This row cannot discriminate a hardcoded/degenerate validator and is rejected as an inadequate row (dataset-authoring defect), not a contributor failure',
        detail: { reason: 'unanimous_ground_truth', groundTruths: oracleOut.ground_truths },
      };
    }
    if (oracleOut.stage !== 'ok' || !Array.isArray(oracleOut.ground_truths)) {
      return { passed: false, logs: 'unrecognized oracle stage: ' + String(oracleOut.stage), detail: { reason: 'unknown_oracle_stage', stage: oracleOut.stage } };
    }
    const groundTruths = oracleOut.ground_truths;

    // ---- Contributor process: validation_code ONLY, never sees the schema
    // or ground truth -- see module doc comment (TWO SEPARATE python3
    // SUBPROCESSES) for why this separation is load-bearing. ----
    const contribMark = '@@SCVROW_CONTRIB_' + crypto.randomBytes(12).toString('hex') + '_';
    const contribScript = buildContributorScript(h.PY_PRELUDE, validationCode, payloads, contribMark);
    const contribPath = h.path.join(d, 'contributor.py');
    h.fs.writeFileSync(contribPath, contribScript);
    const contribRun = h.run('python3', [contribPath], { cwd: d, timeoutMs: CONTRIBUTOR_TIMEOUT_MS });
    if (contribRun.timedOut) {
      return { passed: false, logs: 'validation_code did not complete within the time budget', detail: { reason: 'contributor_timed_out' } };
    }
    if (contribRun.status !== 0) {
      return { passed: false, logs: String(contribRun.stderr || '').slice(0, 1500), detail: { reason: 'contributor_crashed' } };
    }
    const contribMarked = h.lastMarked(contribRun.rawStdout != null ? contribRun.rawStdout : contribRun.stdout, contribMark);
    let contribOut = null;
    try { contribOut = contribMarked === null ? null : JSON.parse(contribMarked); } catch (e) { contribOut = null; }
    if (!contribOut || typeof contribOut !== 'object' || !contribOut.stage) {
      return { passed: false, logs: 'could not parse validation_code execution output', detail: { reason: 'contributor_unparseable_output' } };
    }

    if (contribOut.stage === 'validation_code_load_failed') {
      return {
        passed: false,
        logs: 'validation_code failed to load/exec: ' + String(contribOut.error || '').slice(0, 800),
        detail: { reason: 'validation_code_load_failed' },
      };
    }
    if (contribOut.stage === 'validate_function_not_found') {
      return {
        passed: false,
        logs: 'validation_code did not define a callable top-level `validate` function',
        detail: { reason: 'validate_function_not_found' },
      };
    }
    if (contribOut.stage !== 'ok' || !Array.isArray(contribOut.verdicts)) {
      return { passed: false, logs: 'unrecognized contributor stage: ' + String(contribOut.stage), detail: { reason: 'unknown_contributor_stage', stage: contribOut.stage } };
    }

    // ---- Combine: require EVERY payload's verdict to match ground truth ----
    // (see module doc comment, REQUIRE-EVERY-PAYLOAD). A raised exception on
    // one payload (verdict: null) counts as that ONE payload's verdict being
    // wrong, never a whole-row crash.
    const verdicts = contribOut.verdicts;
    if (verdicts.length !== groundTruths.length) {
      return { passed: false, logs: 'validate() verdict count (' + verdicts.length + ') does not match test_payloads count (' + groundTruths.length + ')', detail: { reason: 'verdict_count_mismatch' } };
    }
    const mismatches = [];
    for (let i = 0; i < groundTruths.length; i++) {
      const v = verdicts[i];
      const contributorVerdict = v && v.verdict === true ? true : v && v.verdict === false ? false : null;
      const matched = contributorVerdict !== null && contributorVerdict === groundTruths[i];
      if (!matched) {
        mismatches.push({
          index: i,
          groundTruth: groundTruths[i],
          contributorVerdict,
          error: v && v.error ? String(v.error).slice(0, 300) : null,
        });
      }
    }

    if (mismatches.length > 0) {
      const first = mismatches[0];
      return {
        passed: false,
        logs: 'validate() disagreed with the real ' + (schemaLanguage === 'JSON Schema' ? 'jsonschema' : 'lxml') + ' verdict on ' + mismatches.length + '/' + groundTruths.length + ' payload(s) -- first at test_payloads[' + first.index + ']: ground truth is ' + first.groundTruth + ', validate() returned ' + (first.error ? ('an exception (' + first.error + ')') : first.contributorVerdict),
        detail: { reason: 'verdict_mismatch', mismatchCount: mismatches.length, totalCount: groundTruths.length, mismatches: mismatches.slice(0, 10) },
      };
    }

    return {
      passed: true,
      score: 1,
      logs: '',
      detail: { reason: 'ok', payloadCount: groundTruths.length },
    };
  },
};
