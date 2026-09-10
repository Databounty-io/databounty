/**
 * exact-output-match (round-trip identity) — compression_code +
 * decompression_code must reproduce sample_input exactly. Never a fixed
 * size/hash check: os.urandom-based inputs are nondeterministic by design,
 * and expected_result explicitly allows a larger-than-input compressed size
 * for incompressible/edge-case data.
 *
 * Three dataset-wide irregularities, not row-specific quirks:
 *  - sample_input is often prose with a trailing parenthetical explanation
 *    ("b'' (empty bytes)", "b'AB' * 500  (alternating bytes...)") rather
 *    than a bare Python literal — the parenthetical is stripped before
 *    eval'ing what remains. Rows that are prose all the way through (no
 *    recoverable literal) report runtimeUnavailable instead of a guessed
 *    reconstruction.
 *  - The RLE rows split into one that DEFINES rle_compress/rle_decompress
 *    but never calls them, and several "same rle_compress() as above" stub
 *    rows that reference those functions without redefining them at all —
 *    neither shape is independently runnable. The canonical implementation
 *    (copied verbatim from the one row that defines it) is always
 *    available, stub lines are skipped rather than executed as invalid
 *    Python, and compressed/restored are invoked automatically whenever the
 *    row's own code didn't already produce them.
 *  - The output variable is `restored` for most rows but `restored_text`
 *    (via an intermediate `restored_bytes`) for the one row using `text`
 *    instead of `data` — resolved via a closed candidate list checked
 *    against globals(), not a wildcard `dir()` scan: the latter picks
 *    whichever name sorts alphabetically last, which a throwaway line like
 *    `restored_zzz_cheat = data` can hijack to fabricate a pass (or a
 *    harmless debug variable like `restored_debug_preview` can accidentally
 *    hijack into a false fail), regardless of what the real `restored`
 *    value was.
 *
 * compression_code/decompression_code run inline, sharing this script's
 * process and stdout with the grading logic that runs after them. Two
 * layers protect the verdict:
 *  - h.PY_PRELUDE traps sys.exit()/os._exit()/exit()/quit(), and the
 *    untrusted body runs inside try/except BaseException so even a raw
 *    `raise SystemExit(...)` can't skip this script's own trailing output.
 *  - The verdict is written via a REAL FILE-DESCRIPTOR write (`os.write(1,
 *    ...)`), never Python's `print()`. A prior version captured
 *    `_real_print = print`/`_real_dumps = json.dumps` as direct references
 *    before untrusted code ran, on the theory that a later `print`/
 *    `json.dumps` rebinding couldn't affect an already-captured reference --
 *    true, but irrelevant: CPython's `print()` resolves its output stream
 *    from `sys.stdout` FRESH at every call (it is not bound at reference-
 *    capture time), so untrusted code reassigning `sys.stdout` to a wrapper
 *    object intercepts even a captured `_real_print`'s output, with NO
 *    marker-guessing needed at all -- confirmed exploitable: a wrapper whose
 *    write() substitutes forged JSON for any line matching the marker
 *    forged a `roundTrip: true` verdict for a submission whose decompression
 *    never worked. `os.write(1, ...)` talks directly to the OS file
 *    descriptor, never through the `sys.stdout` Python object at all, so
 *    reassigning that object has nothing to intercept.
 * This does NOT close every variant: a sufficiently determined submission
 * could still read its own source text (`open(__file__)`) to recover the
 * marker value at runtime and forge a matching line before calling the
 * (now-trapped, so this no longer even works via sys.exit -- os._exit()
 * remains the raw-syscall residual). Closing that fully needs the
 * comparison to happen somewhere the submission's code can't terminate or
 * introspect (e.g. a separate process the parent alone controls) -- a real
 * architecture change, not a harness patch; the same accepted residual
 * documented elsewhere in this registry (e.g. competitive_programming,
 * git_merge_resolution).
 */
'use strict';

const crypto = require('crypto');

const RLE_COMPRESS_DEFAULT = [
  'def rle_compress(data):',
  "    if not data: return b''",
  '    out = bytearray(); prev = data[0]; count = 1',
  '    for b in data[1:]:',
  '        if b == prev and count < 255: count += 1',
  '        else:',
  '            out += bytes([count, prev]); prev = b; count = 1',
  '    out += bytes([count, prev]); return bytes(out)',
].join('\n');

const RLE_DECOMPRESS_DEFAULT = [
  'def rle_decompress(data):',
  '    out = bytearray()',
  '    for i in range(0, len(data), 2):',
  '        count, val = data[i], data[i + 1]',
  '        out += bytes([val]) * count',
  '    return bytes(out)',
].join('\n');

function isStubReference(code) {
  return /^\s*same\s+\w+.*\bas\b/i.test(code);
}

module.exports = {
  contract: 'exact-output-match',
  requires: ['python3'],

  verify(row, h) {
    const algorithm = h.str(row, 'algorithm');
    const sampleInput = h.str(row, 'sample_input');
    const compCode = h.str(row, 'compression_code');
    const decompCode = h.str(row, 'decompression_code');
    const expectedResult = h.str(row, 'expected_result');
    if (!sampleInput || !compCode || !decompCode) {
      return { passed: false, detail: { reason: 'missing sample_input, compression_code, or decompression_code' } };
    }
    // Same "FLAWED:" convention as elsewhere in this dataset family — searched
    // anywhere rather than anchored, matching build_dependency_resolution and
    // dependency_vuln_audit, since a reference row can embed the marker
    // mid-string ("failure: ... (FLAWED: ...)") rather than as a strict prefix.
    if (/FLAWED:/i.test(expectedResult)) {
      return { passed: false, logs: 'reference description is marked FLAWED', detail: { flawedReference: true } };
    }
    if (!h.have('python3')) return { passed: false, runtimeUnavailable: true, logs: 'python3 not available', detail: { algorithm } };
    // The RLE auto-invoke fallback below must only fire for rows that
    // actually declare RLE. Without this gate, a stub row claiming a
    // DIFFERENT algorithm (e.g. "same rle_compress() as above" mislabeled
    // as bzip2) would silently round-trip via the RLE default and pass,
    // having tested nothing about the algorithm it claims to be.
    const isRle = /\brle\b|run[\s-]*length\s+encod/i.test(algorithm);
    // "corrupted stream raises zlib.error", "truncated stream raises an
    // exception" — for these rows the CORRECT behavior is an uncaught
    // exception during decompression, not a clean round-trip. Detected from
    // expected_result rather than assumed from `algorithm` containing
    // "negative example", since the flawed duplicates of these same rows
    // also say "negative example" but expect the opposite outcome (and are
    // already handled above by the FLAWED marker).
    const expectsException = /\braises?\b/i.test(expectedResult) && /(exception|error|zlib\.error|oserror|eoferror)/i.test(expectedResult);

    const compLine = isStubReference(compCode) ? '# ' + compCode.replace(/\n/g, ' ') : compCode;
    const decompLine = isStubReference(decompCode) ? '# ' + decompCode.replace(/\n/g, ' ') : decompCode;
    // "n/a -- this test checks compression determinism, not decompression":
    // not Python at all, and there is no round-trip to check for this row —
    // the assertion is compressed1 == compressed2, already computed by
    // compression_code itself.
    const isDeterminismCheck = /^\s*n\/a\b/i.test(decompCode);
    // compression_code references a bare `level` with no definition
    // anywhere — expected_result requires the round-trip to hold "at EVERY
    // compression level from 0 through 9", so it is meant to be looped, not
    // run once with an undefined name.
    const needsLevelSweep = /\blevel\b/.test(compCode) && !/\blevel\s*=/.test(compCode);

    const indent = (code, spaces) => code.split('\n').map((line) => ' '.repeat(spaces) + line).join('\n');

    const textLine = 'text = data if isinstance(data, str) else (data.decode("utf-8", errors="replace") if isinstance(data, (bytes, bytearray)) else data)';
    // Auto-invoke the RLE round-trip when the row's own code (or its "same as
    // above" stub) never actually called it -- ONLY for rows that declare RLE.
    // Empty string for every other algorithm, so a non-RLE stub reference
    // correctly leaves `compressed`/`restored` undefined instead of silently
    // round-tripping through an unrelated canonical implementation.
    const autoInvokeRle = isRle
      ? [
          'if "compressed" not in dir() and "rle_compress" in dir():',
          '    compressed = rle_compress(data)',
          'if not [n for n in dir() if n.startswith("restored")] and "rle_decompress" in dir() and "compressed" in dir():',
          '    restored = rle_decompress(compressed)',
        ].join('\n')
      : '';

    let guardedBody;
    if (isDeterminismCheck) {
      // The check is compressed1 == compressed2 — compression_code already
      // computes both; there is no decompression step and no restored value.
      guardedBody = [textLine, compLine, '_ok = ("compressed1" in dir() and "compressed2" in dir() and compressed1 == compressed2)', '_clen = len(compressed1) if "compressed1" in dir() else None'].join('\n');
    } else if (needsLevelSweep) {
      guardedBody = [
        textLine, '_ok = True', '_clen = None', 'for level in range(10):',
        indent(compLine, 4), indent(decompLine, 4), indent(autoInvokeRle, 4),
        '    _fr = _pick_restored()',
        '    if not (_fr is not None and (_fr == data or _fr == text)):', '        _ok = False',
        '    _clen = len(compressed) if "compressed" in dir() else _clen',
      ].join('\n');
    } else {
      const restoredPickLines = ['_final_restored = _pick_restored()', '_restored_names = [n for n in _RESTORED_CANDIDATES if n in globals()]'];
      const finalOkLine = '_ok = _final_restored is not None and (_final_restored == data or _final_restored == text)';
      const clenLine = '_clen = len(compressed) if "compressed" in dir() else None';
      // A handful of rows document that decompression is SUPPOSED to raise
      // (corrupted stream, truncated stream, mismatched wbits) — for those
      // the correct outcome IS an exception, not a clean round-trip, so
      // success means catching one rather than avoiding one. Only
      // decompLine (+ the restored-value round-trip check) is inside the
      // try -- compLine runs unguarded first, so a compression_code that
      // merely raises (never actually compressing anything) can no longer
      // be mistaken for "decompression correctly detected corruption".
      if (expectsException) {
        guardedBody = [
          textLine,
          compLine,
          'try:',
          indent([decompLine, autoInvokeRle].concat(restoredPickLines).concat([finalOkLine, clenLine]).join('\n'), 4),
          '    _ok = False  # decompression completed cleanly when it should have raised',
          'except Exception as _exc:',
          '    _ok = True',
          '    ' + clenLine,
        ].join('\n');
      } else {
        guardedBody = [textLine, compLine, decompLine, autoInvokeRle].concat(restoredPickLines).concat([finalOkLine, clenLine]).join('\n');
      }
    }

    const mark = '@@CMP_' + crypto.randomBytes(12).toString('hex') + '_';

    const prog = [
      'import zlib, gzip, bz2, lzma, os, io, json as _json, base64, re',
      h.PY_PRELUDE,
      '_real_dumps = _json.dumps',
      isRle ? RLE_COMPRESS_DEFAULT : '',
      isRle ? RLE_DECOMPRESS_DEFAULT : '',
      '_raw_input = ' + JSON.stringify(sampleInput),
      // \\s+ (one or more) before the paren, not \\s* — "os.urandom(500)" has
      // NO space before its argument list and must be left alone, while
      // "b'' (empty bytes)" has a real space before its explanatory remark.
      // \\s* would strip both, leaving "os.urandom" (a bare function
      // reference, not bytes) for the first case.
      '_stripped = re.sub(r"\\s+\\([^()]*\\)\\s*$", "", _raw_input).strip()',
      'try:',
      '    data = eval(_stripped)',
      '    _input_unparseable = None',
      'except Exception as _e:',
      '    data = None',
      '    _input_unparseable = str(_e)',
      '_ok = False',
      '_clen = None',
      // Closed candidate list, checked via globals() -- NOT a `dir()`
      // wildcard scan, which picks whichever name sorts alphabetically
      // last and can be hijacked by an unrelated throwaway assignment.
      '_RESTORED_CANDIDATES = ("restored_text", "restored")',
      'def _pick_restored():',
      '    for _name in _RESTORED_CANDIDATES:',
      '        if _name in globals():',
      '            return globals()[_name]',
      '    return None',
      '_restored_names = []',
      // Wrapped in try/except BaseException (catches a raw `raise
      // SystemExit(...)` too, not just calls to sys.exit()) so an early
      // exit/exception inside compression_code/decompression_code can't
      // skip this script's own trailing verdict write below.
      'try:',
      '    if data is not None:',
      indent(indent(guardedBody, 4), 4),
      'except BaseException:',
      '    pass',
      // os.write(1, ...) writes directly to the real OS file descriptor,
      // never through the `sys.stdout` Python object -- see module doc
      // comment for why a captured `print`/`_real_print` reference is NOT
      // equivalent (print() resolves sys.stdout fresh at every call, so
      // reassigning sys.stdout intercepts it regardless of when the
      // reference was captured).
      'os.write(1, (' + JSON.stringify(mark) + ' + _real_dumps({"roundTrip": bool(_ok), "inputUnparseable": _input_unparseable, "inLen": (len(data) if data is not None else None), "compressedLen": _clen, "restoredNames": _restored_names}) + "\\n").encode("utf-8", "replace"))',
    ].join('\n');

    const d = h.workdir();
    const f = h.path.join(d, 'c.py');
    h.fs.writeFileSync(f, prog);
    const r = h.run('python3', [f], { cwd: d, timeoutMs: 30000 });
    if (r.timedOut) {
      return { passed: false, runtimeUnavailable: true, logs: 'compression/decompression timed out after 30s', detail: { algorithm, timedOut: true } };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr || '').slice(0, 1500), detail: { algorithm, ranClean: false } };
    }

    const marked = h.lastMarked(String(r.stdout || ''), mark);
    const j = marked === null ? null : h.jsonOf(marked);
    if (!j) {
      return { passed: false, logs: 'could not parse output: ' + String(r.stdout).slice(0, 300), detail: { algorithm } };
    }

    if (j.inputUnparseable) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: 'sample_input is prose with no recoverable Python literal: ' + j.inputUnparseable,
        detail: { algorithm, sampleInput: sampleInput.slice(0, 150) },
      };
    }

    return {
      passed: j.roundTrip === true,
      logs: j.roundTrip === true ? '' : 'round-trip did not reproduce the original input',
      detail: {
        algorithm, roundTrip: j.roundTrip, inputLen: j.inLen, compressedLen: j.compressedLen,
        restoredNames: j.restoredNames,
        note: 'round-trip identity only; expected_result is prose and a larger-than-input result is valid',
      },
    };
  },
};
