/**
 * exact-output-match (round-trip) — serialization_code + deserialization_code
 * must reproduce sample_object, or the SPECIFIC documented discrepancy
 * (e.g. "JSON has no tuple type, restored becomes a list") when
 * round_trip_expected_result explicitly says the round-trip is lossy in a
 * known way — a strict-equality-only check would wrongly reject those valid
 * rows, since e.g. `[1,2,3] != (1,2,3)` in Python even though that IS the
 * documented, correct JSON behavior.
 *
 * sample_object takes three different shapes across this dataset, each
 * needing different setup before serialization_code/deserialization_code can
 * run (both reference `obj` or `xml_str` directly, with no definitions of
 * their own):
 *  - a plain Python literal ("{'name': 'Ada', ...}") -> obj = eval(...)
 *  - a constructor call for a class the row never defines ("Point(x=3,
 *    y=4)") -> a matching dataclass is synthesized from the keyword names
 *  - a literal XML string ("<person>...</person>") -> assigned to xml_str,
 *    the name the row's own code expects; there is no comparable `obj` in
 *    this case, so the expected dict embedded in round_trip_expected_result
 *    ("restored == {'name': 'Ada', 'age': '36'}") is extracted and compared
 *    against directly instead.
 *
 * Protobuf rows are handled by a real round-trip, not a hold: `schema_definition`
 * is compiled with the sandbox's own `protoc` into a `schema_pb2` module (the
 * standard protoc-generated Python bindings), which is then imported into the
 * SAME script namespace serialization_code/deserialization_code already expect
 * their message classes to be pre-defined in — no dataset row imports
 * `schema_pb2` itself, so this harness must do it before either code snippet
 * runs. Protobuf rows do NOT follow this file's own "everything references
 * `obj`" convention (see the three-shape list above): every real row instead
 * names its own instance variable directly in serialization_code (`user`,
 * `path`, ...), extracted via the `.SerializeToString()` call itself rather
 * than assumed, and `sample_object` takes one of two different shapes that
 * both had to be handled empirically against the only 2 real rows that exist
 * in this dataset family today (no third shape has been observed, so this is
 * a closed, verified set, not a guess):
 *  - a bare Python dict literal ("{'name': 'Ada', 'id': ..., 'tags': [...]}"),
 *    for a message with no nested message-typed fields -- constructed via
 *    `<MessageClass>(**eval(sample_object))`, calling the target class's own
 *    keyword-argument constructor (every protoc-generated message class
 *    accepts field=value kwargs). The class name comes from
 *    deserialization_code's own zero-arg constructor call (`restored =
 *    User()`), not from schema_definition's message list, since a
 *    multi-message schema doesn't otherwise say which class the SAMPLE is an
 *    instance of.
 *  - a full constructor-call expression using the real message classes
 *    directly ("Path(points=[Point(x=0,y=0), ...])") -- this needs no keyword-
 *    argument gymnastics at all; plain `eval()` already constructs the exact
 *    object, AS LONG AS every class it references (including a nested one
 *    like `Point`, never separately declared) is present in `eval()`'s
 *    globals first. Every message name found in `schema_definition` (top-level
 *    and nested alike -- a flat regex scan, not a structural .proto parse) is
 *    injected into globals before either shape's sample-construction line
 *    runs, which is what makes the nested-class case (`Point` used inside a
 *    `Path(...)` literal) resolve correctly.
 * Known, accepted residual matching the exact shape of this dataset's only 2
 * real rows: a dict-literal sample (first shape above) whose value for some
 * field should itself become a SUBMESSAGE instance (e.g. a nested Address
 * message inside a Person dict) is not converted recursively --
 * `**eval(_sample)` passes that value to the constructor as a plain dict,
 * which protoc-generated constructors do NOT auto-coerce into the nested
 * message type the way the constructor-call shape's plain `eval()` naturally
 * does. Neither of the 2 real rows has a nested-message-typed field inside a
 * dict literal (row 1's dict is flat scalars + a repeated string; row 2 uses
 * the constructor-call shape instead, which has no such gap), so this is not
 * a live bug against the current dataset -- flagged for whoever adds the
 * first such row, rather than solved speculatively for a shape that doesn't
 * exist here yet.
 *
 * Execution goes through h.runCode('python', ...) rather than a bare
 * h.run('python3', [file]) so this category gets the same protection every
 * other polyglot-execution category already has: PY_PRELUDE traps
 * sys.exit()/os._exit()/exit()/quit(), and PY_DRIVER structurally catches
 * `raise SystemExit(...)` around the whole script. Without this, a
 * deserialization_code that printed a forged verdict line and then called
 * sys.exit(0) could dictate its own pass/fail unilaterally before this
 * file's own comparison code ever ran — confirmed exploitable against the
 * prior direct-h.run version, and independent of (not caught by) any of the
 * other checks below, since the forged line can just claim whatever the
 * comparison would have printed on success.
 *
 * Independently of that, nothing previously verified that `data` (the
 * presumed serialized form serialization_code produces) is genuinely a
 * serialization of anything — a deserialization_code of `restored = obj`
 * (never touching `data` at all) passed outright as long as it matched
 * `obj`, regardless of whether serialization_code did anything real.
 * INDEP_DECODE independently decodes `data` through the FORMAT'S OWN correct
 * stdlib call (never trusting deserialization_code for this), for every
 * format whose decode result is directly comparable to a Python value
 * (JSON/YAML/Pickle/MessagePack — not XML, whose ElementTree result has no
 * single canonical dict form to compare against `_target`, left as an
 * accepted residual). Protobuf gets the identical treatment for the identical
 * reason: an independent re-decode would need `getattr(_pb2, <ClassName>)()
 * .ParseFromString(data)`, but no single message class name is knowable in
 * the general case here (a schema can declare several `message` types, and
 * nothing about `format` alone says which one `data` was serialized from —
 * unlike JSON/YAML/Pickle/MessagePack, whose stdlib decode call takes no
 * type/class argument at all). `strict_eq` already covers protobuf's
 * correctness bar via the generated class's own `__eq__` (see below), so
 * `indep_ok` staying an unconditional True here imposes no gap in practice.
 */
'use strict';

const INDEP_DECODE = {
  json: 'json.loads(data)',
  yaml: 'yaml.safe_load(data)',
  pickle: 'pickle.loads(data)',
  // strict_map_key=False is required for any row using non-string
  // (typically int) dict keys -- msgpack-python's default strict_map_key
  // (True) makes unpackb() itself RAISE on a non-str/bytes key. Without
  // this, an entirely correct row preserving int dict keys through
  // MessagePack could never pass: the independent re-decode below would
  // raise on its own default call, marking indep_ok false regardless of
  // what deserialization_code (correctly using strict_map_key=False
  // itself) produced.
  messagepack: 'msgpack.unpackb(data, raw=False, strict_map_key=False)',
};
// Formats with a genuine type-system limitation that legitimately requires
// the lenient, type-coercing _canon() comparison instead of strict equality
// (JSON/YAML have no tuple type or int-keyed-dict support; MessagePack's
// "array" type also always decodes back to a list, confirmed empirically:
// msgpack.unpackb(msgpack.packb((1,2,3))) == [1,2,3], never a tuple). Pickle
// is deliberately NOT included: it preserves exact Python types (tuples stay
// tuples, int keys stay int keys) with no such excuse. Real dataset rows
// using any of the coercion-signaling phrases below are JSON/YAML only
// (confirmed by inspection) — no Pickle/MessagePack row currently relies on
// this, so excluding Pickle here has no regression risk today, and directly
// closes a confirmed exploit: a Pickle row whose deserializer deliberately
// stringifies int keys, described in prose as a "known limitation" borrowed
// from JSON's genuinely-different, legitimate wording, previously passed
// because the coercion allowance was decided from that prose text alone,
// with no per-format ground truth about which coercions are real.
const FORMATS_WITH_GENUINE_COERCION = new Set(['json', 'yaml', 'xml', 'messagepack']);

/** Every balanced top-level {...} object literal in `text`, in order,
 * respecting quoted strings so a '}' inside a quoted value doesn't close
 * early. A simple /\{[^{}]*\}/ can't match a NESTED object (e.g. an address
 * dict inside a person dict) -- it grabs the innermost fragment instead of
 * the intended target, which is exactly what a nested expected value looks
 * like in this dataset's prose.
 *
 * Returns every candidate, not just the first: prose describing a format
 * can genuinely contain an earlier, unrelated brace-balanced fragment
 * before the real target (e.g. "the format uses tags like {tag}text{/tag}
 * ... and restored == {'name': 'Ada', ...}") -- taking only the first match
 * previously extracted the decoy and evaluated it as a Python set literal
 * containing an undefined bare name, crashing the whole script. The caller
 * tries each candidate via eval() in order and keeps the first one that
 * doesn't raise, rather than committing to "the first {" unconditionally. */
function extractBalancedObjectLiterals(text) {
  const results = [];
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf('{', searchFrom);
    if (start === -1) break;
    let depth = 0;
    let quote = null;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote && text[i - 1] !== '\\') quote = null;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break;
    results.push(text.slice(start, end + 1));
    searchFrom = end + 1;
  }
  return results;
}

module.exports = {
  contract: 'exact-output-match',
  requires: ['python3'],

  verify(row, h) {
    const format = h.str(row, 'format');
    const sampleObject = h.str(row, 'sample_object').trim();
    const serCode = h.str(row, 'serialization_code');
    const deserCode = h.str(row, 'deserialization_code');
    // .trim()'d, matching sampleObject above -- a leading space defeated the
    // ^FLAWED: anchor below, letting a deliberately-mislabeled reference
    // description (this dataset's OWN negative-example convention) fall
    // through to normal comparison instead of being rejected outright.
    // Confirmed against this exact dataset's own row 20 text with one
    // leading space added: the row still legitimately satisfies the
    // (correct) JSON tuple->list coercion, so it was scored a false pass
    // despite its own documented claim being the deliberately-wrong one the
    // FLAWED: marker exists to flag.
    const roundTripExpected = h.str(row, 'round_trip_expected_result').trim();
    if (!sampleObject || !serCode || !deserCode) {
      return { passed: false, detail: { reason: 'missing sample_object, serialization_code, or deserialization_code' } };
    }
    // Same "FLAWED:" convention as elsewhere in this dataset family, marking
    // a deliberately-wrong reference description (e.g. claiming a tuple
    // round-trips as a tuple through JSON/YAML, when both coerce it to a
    // list).
    if (/^FLAWED:/i.test(roundTripExpected)) {
      return { passed: false, logs: 'reference description is marked FLAWED', detail: { flawedReference: true } };
    }
    const isProtobuf = /protobuf/i.test(format);
    const schemaDefinition = h.str(row, 'schema_definition').trim();
    // A missing required field is a dataset defect, not a sandbox gap -- do
    // not route it to runtimeUnavailable (which implies "this row is fine,
    // the SANDBOX can't run it"; here the ROW itself has nothing to compile).
    if (isProtobuf && !schemaDefinition) {
      return { passed: false, detail: { format, reason: 'missing schema_definition for protobuf row' } };
    }
    // protoc is a build-time-installed compiler binary, not a Python package
    // -- see infra/e2b/databounty-verify/template.ts's apt-get line. Same
    // sandbox-provisioning-gap pattern already used below for an optional
    // Python module (msgpack/yaml) missing from the image: a hold routed to
    // human audit, never scored as the contributor's own code being wrong.
    if (isProtobuf && !h.have('protoc')) {
      return { passed: false, runtimeUnavailable: true, logs: 'protoc compiler not available on this sandbox', detail: { format, reason: 'no_protoc' } };
    }
    if (!h.have('python3')) return { passed: false, runtimeUnavailable: true, logs: 'python3 not available', detail: { format } };

    // Needed earlier than every other format handled below: protoc has to
    // compile schema_definition into a real schema_pb2.py file ON DISK
    // before the Python script that imports it is even built, let alone run
    // -- every other format's "setup" is pure inline Python text with no
    // separate compile step or filesystem artifact of its own.
    const d2 = h.workdir();

    // Flat regex scan over schema_definition, not a structural .proto parse
    // -- good enough for every row that exists today (both are flat, no
    // `message { message {...} } ` nesting), and this single pass also
    // naturally catches a schema declaring several top-level messages (row
    // 2's Point + Path) in one go.
    let protoMessageNames = [];
    if (isProtobuf) {
      // protobuf itself requires `syntax = "...";` to be the file's first
      // non-comment statement, so checking only the START of the text (not
      // scanning the whole schema) is both sufficient and avoids a false
      // "already declared" match on some unrelated later occurrence of the
      // substring "syntax =".
      const protoSource = (/^\s*syntax\s*=/.test(schemaDefinition) ? '' : 'syntax = "proto3";\n') + schemaDefinition;
      h.fs.writeFileSync(h.path.join(d2, 'schema.proto'), protoSource);
      const protoc = h.run('protoc', ['--proto_path=.', '--python_out=.', 'schema.proto'], { cwd: d2, timeoutMs: 15000 });
      // Non-zero here means the ROW's OWN schema_definition is malformed
      // .proto syntax -- a real failure, not a runtimeUnavailable hold (the
      // compiler ran fine; what it was asked to compile was bad).
      if (protoc.status !== 0) {
        return { passed: false, logs: String(protoc.stderr || '').slice(0, 1500), detail: { format, reason: 'protoc compile failed' } };
      }
      protoMessageNames = [...schemaDefinition.matchAll(/\bmessage\s+(\w+)\s*\{/g)].map((m) => m[1]);
    }

    // Most rows treat sample_object as a Python literal and reference `obj`
    // directly. A few pass it as a raw STRING instead — always for formats
    // whose row-specific feature (XML nesting, YAML anchors/aliases) cannot
    // be expressed as a plain Python literal at all — under whichever
    // format-specific name their own serialization_code/deserialization_code
    // expects (`xml_str`, `yaml_str`). Detected from the code itself rather
    // than assumed from `format`, since e.g. most YAML rows still use `obj`.
    const combinedCode = serCode + '\n' + deserCode;
    const rawStringVar = /\bxml_str\b/.test(combinedCode) ? 'xml_str'
      : /\byaml_str\b/.test(combinedCode) ? 'yaml_str'
      : null;
    const expectedDictLiterals = extractBalancedObjectLiterals(roundTripExpected);

    // Protobuf is branched out completely from the generic rawStringVar /
    // dataclass-synthesis setup below, rather than layered on top of it:
    // protobuf rows reference neither `obj` nor a raw-string variable name
    // (see file header), and letting the generic dataclass-synthesis branch
    // run against a protobuf sample would silently OVERWRITE the real
    // message classes just injected from schema_pb2 with a synthesized
    // plain dataclass of the same name -- discarding every protobuf-specific
    // behavior (SerializeToString/ParseFromString, wire-format field
    // numbering, the generated __eq__) that is the entire point of this
    // format.
    let serVarName = null;
    let setup;
    if (isProtobuf) {
      // The variable serialization_code assumes already holds a populated
      // message instance (`user`, `path`, ...) is never assumed -- read
      // directly off the row's own code, since no protobuf row in this
      // dataset uses the generic `obj` name the other formats share.
      const serVarMatch = serCode.match(/(\w+)\.SerializeToString\(\)/);
      if (!serVarMatch) {
        return { passed: false, detail: { format, reason: 'could not determine serialized variable name from serialization_code (expected <var>.SerializeToString())' } };
      }
      serVarName = serVarMatch[1];
      const importLines = ['import schema_pb2 as _pb2'].concat(
        protoMessageNames.map((name) => 'globals()[' + JSON.stringify(name) + '] = getattr(_pb2, ' + JSON.stringify(name) + ')')
      );
      if (sampleObject.startsWith('{')) {
        // Bare dict literal ("{'name': 'Ada', ...}") -- construct via the
        // target class's own keyword-argument constructor (every protoc-
        // generated message class accepts field=value kwargs). The class
        // name isn't recoverable from schema_definition's message list alone
        // (a multi-message schema doesn't say which one the SAMPLE is an
        // instance of), so it's read off deserialization_code's own zero-arg
        // constructor call instead (`restored = User(); ...`) -- the one
        // place every row unambiguously names it.
        const deserClassMatch = deserCode.match(/(\w+)\s*\(\s*\)/);
        if (!deserClassMatch) {
          return { passed: false, detail: { format, reason: 'could not determine message class from deserialization_code (expected <ClassName>())' } };
        }
        setup = importLines.concat([
          '_sample = ' + JSON.stringify(sampleObject),
          serVarName + ' = ' + deserClassMatch[1] + '(**eval(_sample))',
        ]);
      } else {
        // A full constructor-call expression using the real message classes
        // directly ("Path(points=[Point(x=0,y=0), ...])") -- plain eval()
        // already builds the exact object, as long as every class it
        // references (including a nested one like Point, never separately
        // declared) is present in eval()'s globals first, which importLines
        // above already guarantees.
        setup = importLines.concat([
          '_sample = ' + JSON.stringify(sampleObject),
          serVarName + ' = eval(_sample)',
        ]);
      }
    } else if (rawStringVar) {
      setup = [rawStringVar + ' = ' + JSON.stringify(sampleObject)];
    } else {
      setup = [
          'import re as _re',
          '_sample = ' + JSON.stringify(sampleObject),
          // Quote-aware: a naive findall over the raw text also matched a
          // decoy word=... shape sitting inside a quoted STRING VALUE (e.g.
          // Point(x=3, label='a=b') spuriously captured "a" as a field),
          // crashing legitimate rows whose object contains an '=' inside an
          // ordinary string. Does not (yet) handle a NESTED constructor
          // call's own keyword names bleeding into the outer dataclass
          // (e.g. Container(items=[Point(x=1,y=2)]) folding Point's x/y
          // into Container) -- accepted residual, not observed in the
          // current reference dataset, and would need recursively
          // synthesizing a dataclass per nested Name(...) call to close.
          'def _strip_quoted(s):',
          '    out = []; quote = None',
          '    for i, c in enumerate(s):',
          '        if quote:',
          '            out.append(" ")',
          '            if c == quote and s[i-1] != chr(92): quote = None',
          '            continue',
          '        if c in ("\\x27", "\\x22"): quote = c; out.append(c); continue',
          '        out.append(c)',
          '    return "".join(out)',
          '_m = _re.match(r"^([A-Za-z_]\\w*)\\(", _sample)',
          '_KNOWN = {"dict","list","tuple","set","frozenset","bytes","bytearray"}',
          'if _m and _m.group(1) not in _KNOWN:',
          '    from dataclasses import make_dataclass',
          '    _fields = _re.findall(r"(\\w+)\\s*=", _strip_quoted(_sample))',
          '    globals()[_m.group(1)] = make_dataclass(_m.group(1), _fields)',
          'obj = eval(_sample)',
        ];
    }

    const compare = [
      'import json as _j',
      'def _canon(v):',
      '    if hasattr(v, "__dict__"): v = vars(v)',
      '    if isinstance(v, tuple): v = list(v)',
      '    if isinstance(v, bytes): return v.hex()',
      '    if isinstance(v, list): return [_canon(x) for x in v]',
      '    if isinstance(v, dict): return {str(k): _canon(x) for k, x in v.items()}',
      '    return v',
      // Recursive key-ORDER check (not just value equality, which Python's
      // dict == is inherently order-blind to) -- some rows specifically
      // claim key/insertion order is preserved through the round-trip, a
      // property plain `restored == target` cannot verify at all. Confirmed
      // this matters: a deserializer that quietly re-sorts a dict's keys
      // before returning it still satisfies `==` against the original.
      'def _order_ok(a, b):',
      '    if isinstance(a, dict) and isinstance(b, dict):',
      '        if list(a.keys()) != list(b.keys()): return False',
      '        return all(_order_ok(a[k], b[k]) for k in a)',
      '    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):',
      '        return len(a) == len(b) and all(_order_ok(x, y) for x, y in zip(a, b))',
      '    return True',
    ];
    // Protobuf's "original" is whichever variable serialization_code itself
    // populated (`user`, `path`, ...), never the literal name `obj` every
    // other format's code actually uses -- see the isProtobuf setup branch
    // above.
    const compareTarget = isProtobuf
      ? ['_target = ' + serVarName]
      : rawStringVar && expectedDictLiterals.length
        ? [
            '_target = None',
            'for _cand in ' + JSON.stringify(expectedDictLiterals) + ':',
            '    try:',
            '        _target = eval(_cand)',
            '        break',
            '    except Exception:',
            '        continue',
          ]
        : rawStringVar
          ? ['_target = None  # no expected-value literal found in round_trip_expected_result']
          : ['_target = obj'];

    const formatKey = format.trim().toLowerCase();
    const indepDecodeExpr = INDEP_DECODE[formatKey];
    const strictIndepFormats = new Set(['pickle']);
    const emit = [
      'try:',
      '    _strict_eq = (restored == _target) if _target is not None else False',
      'except Exception:',
      '    _strict_eq = False',
      'try:',
      '    _canon_eq = (_canon(restored) == _canon(_target)) if _target is not None else False',
      'except Exception:',
      '    _canon_eq = False',
      'try:',
      '    _order_eq = _order_ok(restored, _target) if _target is not None else False',
      'except Exception:',
      '    _order_eq = False',
      // Independently re-decode `data` through the format's OWN correct
      // call, never trusting deserialization_code for this -- see file
      // header. Not attempted at all for formats with no entry in
      // INDEP_DECODE (XML, or an unrecognized format string); _indep_ok
      // then stays True, imposing no extra constraint.
      indepDecodeExpr ? '_INDEP_FAIL = object()' : '_indep_ok = True',
      indepDecodeExpr ? 'try:' : null,
      indepDecodeExpr ? '    _indep = ' + indepDecodeExpr : null,
      indepDecodeExpr ? 'except Exception:' : null,
      indepDecodeExpr ? '    _indep = _INDEP_FAIL' : null,
      indepDecodeExpr ? 'try:' : null,
      indepDecodeExpr
        ? ('    _indep_ok = (_indep is not _INDEP_FAIL) and (' +
           (strictIndepFormats.has(formatKey) ? '_indep == _target' : '_canon(_indep) == _canon(_target)') +
           ') if _target is not None else False')
        : null,
      indepDecodeExpr ? 'except Exception:' : null,
      indepDecodeExpr ? '    _indep_ok = False' : null,
      // A bare print() here is exactly the stdout-hijack gap fixed elsewhere
      // in this registry: serCode/deserCode ran moments earlier in this SAME
      // script (via plain top-level execution, not exec() in a sub-
      // namespace), and sys.stdout is a mutable process-global looked up
      // fresh on every print() call -- confirmed exploitable with a
      // hand-built repro where deserialization_code returns a genuinely
      // wrong `restored` value but reassigns sys.stdout to a wrapper that
      // rewrites this final line into a forged strict_eq/canon_eq/indep_ok:
      // true. `_ser_os` (captured before PY_PRELUDE, before any submission
      // code runs) writes straight to the fd, bypassing any stdout/
      // sys.stdout reassignment.',
      '_ser_out = _j.dumps({"strict_eq": _strict_eq, "canon_eq": _canon_eq, "order_eq": _order_eq, "indep_ok": _indep_ok, "restored": repr(restored)[:300]}, default=str)',
      '_ser_os.write(1, (_ser_out + "\\n").encode("utf-8", "replace"))',
    ].filter((line) => line !== null);

    // serialization_code/deserialization_code assume their format's module is
    // already imported under its conventional name (json/pickle/msgpack/yaml/
    // ET) — none of the rows import it themselves.
    //
    // json/pickle/ET are stdlib (always present). msgpack/yaml are OPTIONAL
    // third-party packages: importing them unconditionally made EVERY sample —
    // even a pure-JSON one that needs neither — die with ModuleNotFoundError if
    // the box lacked them, and that was scored as the contributor's code
    // failing. Now: the optional imports degrade to None, and a sample that
    // ACTUALLY needs a missing module is reported runtimeUnavailable (→ human
    // audit), never a test failure. `needs` is the set the sample references.
    const needs = [];
    if (/\bmsgpack\b/.test(combinedCode)) needs.push('msgpack');
    if (/\byaml\b/.test(combinedCode)) needs.push('yaml');
    const imports = [
      'import json',
      'import pickle',
      'import xml.etree.ElementTree as ET',
      'try:\n    import msgpack\nexcept ImportError:\n    msgpack = None',
      'try:\n    import yaml\nexcept ImportError:\n    yaml = None',
      '_needs = ' + JSON.stringify(needs),
      '_missing = [m for m in _needs if globals().get(m) is None]',
      'if _missing:\n    print(json.dumps({"__runtime_unavailable__": _missing}))\n    raise SystemExit(0)',
    ];

    // The exit-trap is applied as a plain top-level try/except IN THIS SAME
    // script, run via a bare h.run -- NOT via h.runCode/PY_DRIVER, whose
    // exec(src, {"__name__": "__main__"}) executes the submission against a
    // SYNTHETIC globals dict rather than the real running module. Confirmed
    // regression when this first went through h.runCode: a dataclass
    // synthesized for a Pickle row (see `setup` above) is registered via
    // globals()[...] = make_dataclass(...) -- inside PY_DRIVER's exec, that
    // sets a key on the synthetic dict, not on sys.modules['__main__'], so
    // pickle.dumps() on an instance of it fails with "Can't pickle <class
    // '__main__.Point'>: it's not the same object as __main__.Point" even
    // for a genuinely correct row. Structuring the guard as an ordinary
    // try/except in the real top-level module (no exec(), no synthetic
    // globals) avoids that while still closing the same forgery vector:
    // capturing the real os._exit before h.PY_PRELUDE's own patching runs
    // means the driver's own recovery exit still terminates for real even
    // if submission code re-patches os._exit afterward, and the outer
    // try/except catches `raise SystemExit(...)` directly (sys.exit() IS
    // just that raise, so patching the sys.exit FUNCTION alone -- all
    // PY_PRELUDE does -- doesn't stop it called that way). Confirmed
    // exploitable through PY_PRELUDE alone during this fix's own testing.
    // Known, accepted residual (same class already documented elsewhere in
    // this registry for compression/competitive_programming/git_merge_
    // resolution/implementation/refactoring): `ctypes.CDLL(None)._exit(0)` /
    // os.kill(os.getpid(), signal.SIGKILL) bypass every Python-level trap
    // here via a raw syscall -- not chased further, same rationale as those.
    const body = [].concat(imports, setup, [serCode, deserCode], compare, compareTarget, emit)
      .join('\n').split('\n').map((line) => '    ' + line).join('\n');
    const script = [
      'import os as _ser_os',
      '_ser_real_exit = _ser_os._exit',
      h.PY_PRELUDE,
      'try:',
      body,
      'except SystemExit as _ser_caught:',
      '    import sys as _ser_sys',
      '    _ser_sys.stderr.write("SystemExit(%r) raised -- forbidden inside submission code\\n" % (_ser_caught.code,))',
      '    try:',
      '        _ser_sys.stdout.flush()',
      '    except Exception:',
      '        pass',
      '    _ser_real_exit(1)',
    ].join('\n');
    // d2 is the SAME workdir allocated earlier (before the protoc compile
    // step, for non-protobuf rows just an ordinary empty scratch dir) --
    // reused here, not re-allocated, so a protobuf row's freshly compiled
    // schema_pb2.py sits in the same directory as run.py and is importable
    // via Python's own script-directory-on-sys.path default with no extra
    // path wiring.
    const f2 = h.path.join(d2, 'run.py');
    h.fs.writeFileSync(f2, script);
    const r = h.run('python3', [f2], { cwd: d2, timeoutMs: 25000 });
    if (r.status !== 0) {
      const err = String(r.stderr || '');
      // A missing OPTIONAL third-party module is a sandbox provisioning gap,
      // not the contributor's code being wrong — route to human audit.
      if (/ModuleNotFoundError|No module named/.test(err) && /msgpack|yaml/.test(err)) {
        return { passed: false, runtimeUnavailable: true, logs: err.slice(0, 500), detail: { format, reason: 'optional serialization module not installed on this sandbox' } };
      }
      return { passed: false, logs: err.slice(0, 1500), detail: { format, ranClean: false } };
    }

    const stdoutTrim = String(r.stdout || '').trim();
    // The sample's declared format needs an optional module this box lacks.
    if (stdoutTrim.includes('__runtime_unavailable__')) {
      return { passed: false, runtimeUnavailable: true, logs: 'optional serialization module not installed on this sandbox: ' + stdoutTrim.slice(0, 200), detail: { format, reason: 'optional serialization module not installed on this sandbox' } };
    }

    let result = null;
    try {
      const lines = stdoutTrim.split('\n');
      result = JSON.parse(lines[lines.length - 1]);
    } catch (e) {
      return { passed: false, logs: 'could not parse comparison output: ' + String(r.stdout).slice(0, 500), detail: { format } };
    }

    // "NOT preserved" / "not equal to the original" language means the
    // documented outcome is a KNOWN, acceptable coercion (tuple->list,
    // int-keys->string-keys) — exact identity was never the claim, so the
    // type-normalized comparison is the right bar, not strict equality.
    // Format-aware: see FORMATS_WITH_GENUINE_COERCION above.
    const allowsCoercion = FORMATS_WITH_GENUINE_COERCION.has(formatKey)
      // "coerced ... str" added alongside the dataset's own dominant
      // phrasings ("not preserved" / "must be strings") -- confirmed too
      // narrow without it: a row phrasing the exact same genuine JSON
      // limitation this file's own module docstring already acknowledges
      // ("JSON/YAML have no ... int-keyed-dict support") as "every numeric
      // key is silently coerced to its str() form" used none of the
      // existing phrases and was scored a false FAIL against output that
      // exactly matched its own documented, correct claim.
      && /not preserved|not equal to the original|no tuple type|must be strings|coerced.{0,20}str/i.test(roundTripExpected);
    // Was a bare `\border\b` substring test -- confirmed exploitable two
    // ways: (1) it fires on "order" appearing for an unrelated reason (a
    // scenario label like "out-of-order-event"), imposing a spurious
    // key-order requirement on a row that never claimed one; (2) it fires
    // on a DISMISSIVE use ("order of keys aside", i.e. the row explicitly
    // says order does NOT matter here), imposing the exact opposite of
    // what the row itself claims. Now requires one of the affirmative
    // phrasings this dataset's own genuine order-preservation rows
    // actually use ("in the original order", "order is preserved",
    // "insertion order ... preserved/restored/kept/maintained").
    const claimsOrder = /\bin\s+(?:the\s+)?(?:original\s+|same\s+)?order\b|\border\s+is\s+(?:preserved|restored|maintained|kept)\b|\bpreserv\w*\s+(?:the\s+)?order\b|\binsertion\s+order\b(?:[^.]{0,40})\b(?:preserved|restored|kept|maintained)\b/i.test(roundTripExpected);
    const baseOk = result.strict_eq || (allowsCoercion && result.canon_eq);
    const passed = baseOk && result.indep_ok !== false && (!claimsOrder || result.order_eq === true);

    return {
      passed,
      logs: passed ? '' : ('round-trip produced ' + String(result.restored).slice(0, 300) + '; expected result: ' + roundTripExpected.slice(0, 200)),
      detail: {
        format, strictEq: result.strict_eq, canonEq: result.canon_eq, orderEq: result.order_eq, indepOk: result.indep_ok, allowsCoercion, claimsOrder,
        restored: String(result.restored).slice(0, 300),
        note: 'round_trip_expected_result drives whether exact identity or a documented, format-appropriate coercion is required; indep_ok independently re-verifies data via the format\'s own correct decoder',
      },
    };
  },
};
