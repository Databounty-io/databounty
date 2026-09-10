/**
 * transform_io - a transform(input) entrypoint must map the sample input to
 * exactly the expected output.
 *
 * input_data_sample is raw text. transform(input) receives that text as-is and
 * parses it itself; output_data_sample is compared to transform()'s output as
 * text unless both values are valid JSON.
 */
'use strict';

/**
 * input_data_sample is raw text -- a query string, a Markdown table, CSV
 * lines, log lines, ISO timestamps, whatever the row's own
 * transformation_instruction describes. transform(input) receives that text
 * AS-IS and does its own parsing (urllib.parse.parse_qs, csv.DictReader,
 * datetime.fromisoformat, re.findall, ...), exactly like a real standalone
 * script would; it is never pre-decoded by the harness. output_data_sample
 * is compared against transform()'s real output (JSON text, CSV text, plain
 * text -- whatever the task calls for), never assumed to be JSON itself.
 *
 * Nothing upstream enforces that a row's fields actually ARE strings —
 * validation only requires `z.record(z.unknown())` per item — so a row
 * submitted with a native JSON array/object value here would otherwise go
 * through h.str()'s `String(v)` coercion, which is LOSSY for exactly this
 * shape: String([1,2,3]) is "1,2,3", not valid JSON. jsonText() re-serializes
 * a native value back into real JSON text instead, so it round-trips as the
 * same text a string-typed row would have supplied.
 */
function jsonText(row, key) {
  const v = row ? row[key] : undefined;
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return JSON.stringify(v);
}

module.exports = {
  contract: 'transform_io',
  requires: ['python3'],

  verify(row, h) {
    const code = h.str(row, 'output_code');
    // Checked on the raw field, not the trimmed text below -- a
    // legitimately-empty correct output (e.g. a filter-everything-out task)
    // must not be indistinguishable from a genuinely missing field.
    if (!code || row.output_data_sample == null) {
      return { passed: false, detail: { reason: 'missing output_code or output_data_sample' } };
    }
    const expected = jsonText(row, 'output_data_sample').trim();

    if (!/def\s+transform\s*\(/.test(code)) {
      return { passed: false, logs: 'output_code does not define a transform() entrypoint', detail: {} };
    }

    const d = h.workdir();
    h.fs.writeFileSync(h.path.join(d, 't.py'), [
      code,
      'import sys, json',
      // JSON.stringify (not a Python literal): the input may contain quotes,
      // newlines or backslashes that would not survive interpolation. This
      // is only ever used to safely EMBED the text as a Python string
      // literal -- it is never decoded, since transform(input) receives the
      // raw text itself and does its own parsing.
      'INP = ' + JSON.stringify(jsonText(row, 'input_data_sample')),
      'out = transform(INP)',
      // Serialize structured return values so they remain comparable to JSON
      // output samples rather than being rendered with Python repr().
      'sys.stdout.write(out if isinstance(out, str) else json.dumps(out))',
    ].join('\n'));

    const r = h.run('python3', [h.path.join(d, 't.py')], { cwd: d, timeoutMs: 25000, env: { PYTHONIOENCODING: 'utf-8' } });
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr).slice(0, 1500), detail: { ranClean: false } };
    }

    // rawStdout (uncapped), not the 32000-char-capped stdout: a genuinely
    // correct transform() whose real output exceeds OUT_CAP would otherwise
    // have it silently truncated (a literal "...[truncated]" suffix) while
    // `expected` -- read straight from the row, never capped -- stays full
    // length, guaranteeing a false FAIL for an otherwise-correct submission.
    const actual = String(r.rawStdout != null ? r.rawStdout : r.stdout).trim();
    // Strict first, then JSON-structural, then normalized text. A key-order or
    // whitespace difference is not a wrong transformation.
    let mode = 'strict';
    let ok = actual === expected;
    let structuralAttempted = false;
    if (!ok) {
      const a = h.jsonOf(actual);
      const e = h.jsonOf(expected);
      if (a !== null && e !== null) {
        // Both sides are known, comparable JSON values -- a structural
        // mismatch here is a REAL mismatch, not license to fall through to
        // a looser check. h.looseEqual's normalization strips every `[`/`]`
        // character unconditionally, erasing nesting depth: a transform()
        // that should group values per key (expected [[1,2],[3,4]]) but
        // instead flattens everything ([1,2,3,4], a genuinely wrong shape
        // for the task) previously matched anyway once both normalized to
        // the same "1,2,3,4" text -- confirmed as a real false PASS.
        // log_parsing's harness independently hit and fixed this exact
        // trap; ported the same structuralAttempted gate here.
        structuralAttempted = true;
        ok = JSON.stringify(h.canonical(a)) === JSON.stringify(h.canonical(e));
        if (ok) mode = 'json-structural';
      } else if (e !== null) {
        // expected IS structured JSON but actual does not even parse as
        // JSON syntax at all -- the bracket-free variant of the same trap
        // above (e.g. actual = "1,2,3,4", a flattened, comma-joined string
        // with no brackets at all, vs expected = "[[1,2],[3,4]]"). Falling
        // through to h.looseEqual here would strip expected's brackets and
        // match it against actual's bracket-free text, erasing the exact
        // structural information (nesting depth) that makes expected's
        // shape meaningful -- confirmed exploitable without this branch.
        // This harness's own script always serializes a non-string
        // transform() return via json.dumps (see the script assembly
        // above), so a genuinely correct submission returning structured
        // data always produces valid JSON text here; treating a non-JSON
        // actual against a JSON-shaped expected as a real mismatch has no
        // legitimate false-reject risk.
        structuralAttempted = true;
        ok = false;
      }
    }
    if (!ok && !structuralAttempted) { ok = h.looseEqual(actual, expected); if (ok) mode = 'text-normalized'; }

    return {
      passed: ok,
      logs: ok ? '' : 'produced ' + actual.slice(0, 300) + ' but expected ' + expected.slice(0, 300),
      detail: { matchMode: ok ? mode : 'none', actual: actual.slice(0, 300), expected: expected.slice(0, 300) },
    };
  },
};
