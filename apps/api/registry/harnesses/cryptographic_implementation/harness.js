/**
 * cryptographic_implementation — official-test-vector execution match.
 *
 * Every row supplies a Python implementation of a cryptographic primitive
 * (`implementation_code`: a hash, HMAC, block/stream cipher, KDF, checksum,
 * or encoding function), the language it's written in (`language`, always
 * "Python" in the reference dataset), the primitive's own documented
 * official test vector(s) as a ';'-separated string of Python statements
 * (`official_test_vectors`, e.g. "key = bytes.fromhex('...'); plaintext =
 * bytes.fromhex('...'); aes128_encrypt_block(key, plaintext) ==
 * bytes.fromhex('...')" or several independent "<call> == <expected>"
 * comparisons chained with ';'), and a prose claim that the implementation
 * matches that vector (`expected_results`, e.g. "ciphertext matches the
 * FIPS-197 Appendix C.1 AES-128 test vector exactly"). Across the reference
 * dataset `expected_results` is always phrased as an affirmative match claim
 * — there is no "does NOT match" variant — so the row's truth is entirely
 * decided by whether real execution makes every comparison in
 * `official_test_vectors` come out True, never by parsing polarity out of
 * `expected_results` itself.
 *
 * `official_test_vectors` is executed almost verbatim as real Python
 * (against the row's own `implementation_code`, actually run): the string is
 * split on top-level ';' (respecting quotes, since a semicolon could in
 * principle appear inside a quoted literal), each statement containing '=='
 * is treated as a comparison to evaluate and record, and every other
 * statement (a setup assignment, e.g. `key = bytes.fromhex(...)`) is executed
 * first so later comparisons can reference it. This does NOT special-case on
 * the literal substring "FLAWED" anywhere — a flaw is only ever detected
 * because the row's own implementation_code, when actually run against the
 * row's own official_test_vectors, produces a value that does not equal the
 * documented expected one (wrong algorithm entirely, wrong cipher mode, an
 * off-by-one, a misspelled stdlib reference, or — for one dataset row — a
 * correct implementation checked against a deliberately-corrupted vector
 * string). All five of those failure shapes are indistinguishable from this
 * harness's point of view: they are simply "the comparison evaluated False",
 * which is exactly the generic signal this check is built to catch.
 *
 * AES rows import `Crypto.Cipher` (pycryptodome), which is baked into the
 * databounty-verify E2B image. It is never installed at runtime — sandbox
 * execution is no-network by design — so if the import fails the row reports
 * runtimeUnavailable and routes to manual review.
 *
 * Self-consistency alone is a tautology: implementation_code and
 * official_test_vectors' "expected" literal are BOTH authored by the same
 * submission, so a fabricated implementation paired with a fabricated
 * matching vector agrees with itself every time. Wherever the algorithm is a
 * plain hash, HMAC, CRC32, or base64 encoding — a family Python's own
 * hashlib/hmac/zlib/base64 can compute independently — the RHS of each
 * "<call> == <expected>" vector is ALSO cross-checked against a trusted
 * stdlib computation over the SAME argument text the contributor's own call
 * used (see `trustedExpr`). That sidesteps guessing the contributor's
 * argument order: we never call their function for this check, only reuse
 * the literal text of the arguments they already wrote, applied to the real
 * primitive. Block ciphers, stream ciphers, and KDFs aren't in that
 * independently-checkable set; those rows keep self-consistency as their
 * only mechanical signal, surfaced honestly via `independentGroundTruth`
 * rather than silently presented as fully verified.
 */
'use strict';

const crypto = require('crypto');

/**
 * Split a Python one-liner "a = 1; b = 2; f(a, b) == 3" into individual
 * statements on top-level ';', without breaking a ';' that happens to sit
 * inside a quoted string literal.
 */
function splitStatements(s) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote && s[i - 1] !== '\\') quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === ';') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Find the FIRST top-level '==' (not inside (), [], {}, or a quoted string)
 * and split "<call> == <expected>" into its two halves. */
function splitTopLevelEq(stmt) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < stmt.length - 1; i++) {
    const c = stmt[i];
    if (quote) {
      if (c === quote && stmt[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && c === '=' && stmt[i + 1] === '=' && !'!<>'.includes(stmt[i - 1] || '')) {
      return [stmt.slice(0, i).trim(), stmt.slice(i + 2).trim()];
    }
  }
  return null;
}

/** Raw text between the outermost matching parens of the (single, flat) call
 * in `expr` — every LHS in this dataset's vectors is "<fn_name>(<args>)". */
function extractCallArgs(expr) {
  const open = expr.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = open; i < expr.length; i++) {
    const c = expr[i];
    if (quote) { if (c === quote && expr[i - 1] !== '\\') quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return expr.slice(open + 1, i);
    }
  }
  return null;
}

/** True when every arg is positional -- none is Python keyword-argument
 * syntax ("name=value"). trustedExpr splices arg text verbatim into a
 * DIFFERENT callee's positional slots; a keyword-shaped arg (a perfectly
 * normal, common call style, e.g. hmac_sha256(key=b'k', msg=b'm')) spliced
 * that way produces "hmac.new(key=b'k', msg=b'm', hashlib.sha256)" -- a
 * Python SyntaxError ("positional argument follows keyword argument") that
 * crashes the whole script, not just the affected assertion. */
function isPositionalOnly(args) {
  return args.every((a) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(a));
}

/** Strip a Python '#' comment (to end of line), quote-aware so a literal
 * '#' inside a string argument is never mistaken for one. */
function stripHashComments(s) {
  return String(s)
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote && line[i - 1] !== '\\') quote = null;
          continue;
        }
        if (c === "'" || c === '"') { quote = c; continue; }
        if (c === '#') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Split a raw argument-list string on top-level commas. */
function splitArgsTopLevel(argsText) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < argsText.length; i++) {
    const c = argsText[i];
    if (quote) { cur += c; if (c === quote && argsText[i - 1] !== '\\') quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth += 1; cur += c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth -= 1; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const HASH_ALGOS = {
  md5: 'md5', sha1: 'sha1', sha224: 'sha224', sha256: 'sha256', sha384: 'sha384', sha512: 'sha512',
  sha3224: 'sha3_224', sha3256: 'sha3_256', sha3384: 'sha3_384', sha3512: 'sha3_512',
  blake2b: 'blake2b', blake2s: 'blake2s',
};

/**
 * Independent ground truth for the RHS of a "<call> == <expected>" vector,
 * for the primitive families Python's own stdlib can compute without any
 * help from implementation_code: plain hashes, HMAC, CRC32, base64. Reuses
 * the CONTRIBUTOR's own argument text verbatim (only the function name
 * changes) instead of calling their function — so it never needs to guess
 * their argument order beyond the primitive's own textbook signature
 * (data-only for a hash, key-then-message for HMAC, matching hashlib/hmac's
 * own signatures and how every official test vector for these is written).
 *
 * Returns a Python expression string, or null when the algorithm/arg-shape
 * isn't one of the families covered here (block/stream ciphers, KDFs, and
 * anything unrecognized) — those rows keep self-consistency as their only
 * signal, surfaced honestly via `independentGroundTruth` rather than being
 * silently presented as fully verified.
 */
function trustedExpr(algorithmName, argsText) {
  const algo = String(algorithmName || '').toLowerCase().replace(/[\s_-]+/g, '');
  const args = splitArgsTopLevel(argsText);
  if (!isPositionalOnly(args)) return null;
  // KDF names conventionally embed "hmac" too (e.g. "PBKDF2-HMAC-SHA256"),
  // and PBKDF2/scrypt/bcrypt/argon calls commonly take 3-4+ args (password,
  // salt, iterations, dklen, ...) -- the old `args.length < 2` guard let any
  // of those through into a single-round hmac.new() computation, which is
  // NOT what PBKDF2 computes. KDFs stay outside the independently-checkable
  // set (self-consistency only) rather than being misidentified as HMAC.
  const isKdf = /pbkdf|scrypt|bcrypt|argon/.test(algo);
  if (!isKdf && algo.includes('hmac')) {
    if (args.length !== 2) return null;
    let sub = 'sha256';
    for (const key of Object.keys(HASH_ALGOS)) {
      if (algo.includes(key)) { sub = HASH_ALGOS[key]; break; }
    }
    return `hmac.new(${args[0]}, ${args[1]}, hashlib.${sub}).hexdigest()`;
  }
  if (args.length === 1) {
    for (const key of Object.keys(HASH_ALGOS)) {
      if (algo.includes(key)) return `hashlib.${HASH_ALGOS[key]}(${args[0]}).hexdigest()`;
    }
    if (algo.includes('crc32')) {
      // An already-zero-padded 8-hex-digit STRING, not a raw int: _norm()'s
      // int branch (`format(v, "x")`) drops a leading zero nibble, breaking
      // roughly 1 in 16 real CRC32 values (e.g. 0x0a6216d9 -> "a6216d9")
      // against the conventional zero-padded hex string test vectors use.
      return `format(zlib.crc32(${args[0]}) & 0xffffffff, '08x')`;
    }
    if (algo.includes('base64')) {
      // b64decode already returns bytes, matching how a decode vector's
      // expected literal is conventionally written (bytes.fromhex(...) or
      // a bytes literal). b64encode also returns bytes, but an encode
      // vector's expected literal is conventionally a plain str (e.g.
      // 'TWFu') -- comparing those bytes to that str is never equal except
      // by degenerate empty-string coincidence, so decode to str here.
      // The URL-safe alphabet (-_ instead of +/) needs its own stdlib call
      // -- confirmed exploitable without this: a genuinely correct
      // urlsafe_b64encode/decode implementation was checked against
      // ordinary base64.b64encode/decode's DIFFERENT alphabet, so a value
      // containing a '+'/'/' (standard) vs '-'/'_' (URL-safe) character
      // never matched regardless of how correct the submission was.
      const fn = algo.includes('urlsafe') ? 'urlsafe_b64' : 'b64';
      return algo.includes('decod') ? `base64.${fn}decode(${args[0]})` : `base64.${fn}encode(${args[0]}).decode('ascii')`;
    }
  }
  return null;
}

module.exports = {
  contract: 'official-test-vector-execution-match',
  requires: ['python3'],

  verify(row, h) {
    const algorithmName = h.str(row, 'algorithm_name');
    const implementationCode = h.str(row, 'implementation_code');
    const language = h.str(row, 'language');
    const testVectors = h.str(row, 'official_test_vectors');
    const expectedResults = h.str(row, 'expected_results');

    if (!implementationCode || !testVectors) {
      return { passed: false, detail: { reason: 'missing implementation_code or official_test_vectors' } };
    }

    const lang = h.normLang(language || 'python');
    if (lang !== 'python') {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: `unsupported language "${language}" -- only Python implementations are verified`,
        detail: { language },
      };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 unavailable', detail: { runtime: 'python3' } };
    }

    // pycryptodome is only needed by rows whose implementation_code actually
    // imports Crypto.* (the AES rows) -- don't gate every row on it.
    if (/\bCrypto\b/.test(implementationCode)) {
      // From the verified image only — no runtime install (no-network sandbox).
      // Explicit short timeout: previously unguarded, which combined with
      // this file's own main-run timeout below could approach the outer
      // sandbox command budget deployed at the time (30000ms; raised to
      // 120000ms as of the current deploy, infra/terraform/ssm.tf). A cold "import Crypto" check is not
      // remotely close to even this reduced value in practice.
      const cryptoOk = h.run('python3', ['-c', 'import Crypto'], { timeoutMs: 3000 }).status === 0;
      if (!cryptoOk) {
        return { passed: false, runtimeUnavailable: true, logs: 'pycryptodome (Crypto) unavailable', detail: { runtime: 'pycryptodome' } };
      }
    }

    const statements = splitStatements(stripHashComments(testVectors));
    if (!statements.length) {
      return { passed: false, logs: 'official_test_vectors had no parseable statements', detail: { testVectors: testVectors.slice(0, 300) } };
    }

    const setupLines = [];
    const assertions = [];
    for (const stmt of statements) {
      if (stmt.includes('==')) assertions.push(stmt);
      else setupLines.push(stmt);
    }
    if (!assertions.length) {
      return { passed: false, logs: 'official_test_vectors had no "==" comparison to check', detail: { testVectors: testVectors.slice(0, 300) } };
    }

    const d = h.workdir();
    // implementation_code and official_test_vectors' setup/assertion text are
    // ALL contributor-controlled, and used to be spliced as literal top-level
    // statements sharing the SAME process, namespace, and exit path as the
    // grading code that followed -- a forged `print('@@OUT ' + ...)` +
    // `sys.exit(0)` anywhere in that content ran ahead of the real grading
    // print (the only trust signal) and produced a clean process exit before
    // official_test_vectors' actual assertions ever executed, certifying a
    // fake stub (e.g. a `sha256()` that never touches hashlib) as
    // execution_verified against a real vector. Fixed the same way
    // competitive_programming's harness already had to: the untrusted
    // content executes inside its OWN namespace (`_ns`, exec'd separately --
    // never the grading loop's own globals, so it can't rebind names the
    // grading code itself later resolves, and `globals()` called from inside
    // it resolves to `_ns` itself, not this module's real globals), wrapped
    // in a try/except BaseException (catches SystemExit too, unlike
    // Exception) so an early sys.exit()/raised SystemExit can't skip the real
    // grading print, and the verdict is read from a run-specific,
    // unguessable-at-authoring-time marker -- a forged print can no longer
    // reproduce the exact marker text, since the random suffix is generated
    // fresh per run, after the row's content was already authored.
    const mark = '@@OUT_' + crypto.randomBytes(12).toString('hex') + '_';
    const untrusted = implementationCode + '\n' + setupLines.join('\n');
    const scriptLines = [];
    scriptLines.push('import json as _json, hashlib, hmac, zlib, base64, os as _os');
    scriptLines.push('_ns = {}');
    scriptLines.push('try:');
    scriptLines.push('    exec(compile(' + JSON.stringify(untrusted) + ', "<submission>", "exec"), _ns)');
    scriptLines.push('except BaseException:');
    scriptLines.push('    pass');
    scriptLines.push('def _norm(v):');
    scriptLines.push('    if isinstance(v, bytes): return v.hex()');
    scriptLines.push('    if isinstance(v, str):');
    scriptLines.push('        sl = v.strip().lower()');
    scriptLines.push('        if sl and len(sl) % 2 == 0 and all(c in "0123456789abcdef" for c in sl): return sl');
    scriptLines.push('        return v.strip()');
    scriptLines.push('    if isinstance(v, int): return format(v, "x")');
    scriptLines.push('    return v');
    scriptLines.push('def _as_int(v):');
    scriptLines.push('    if isinstance(v, bool): raise ValueError("bool")');
    scriptLines.push('    if isinstance(v, int): return v');
    scriptLines.push('    if isinstance(v, bytes): return int.from_bytes(v, "big")');
    scriptLines.push('    s = v.strip()');
    scriptLines.push('    if s and len(s) % 2 == 0 and all(c in "0123456789abcdefABCDEF" for c in s): return int(s, 16)');
    scriptLines.push('    return int(s)');
    scriptLines.push('def _values_equal(a, b):');
    scriptLines.push('    if a == b: return True');
    // A bare int on one side (e.g. a vector's expected literal written as a
    // plain integer) compared against a zero-padded hex STRING on the other
    // (e.g. trustedExpr's CRC32 output, format(..., '08x')) used to go
    // through _norm's int branch (format(v, "x"), no padding) and silently
    // drop a leading zero nibble for ~1 in 16 real values -- a false FAIL for
    // a genuinely correct implementation. Comparing as integers first (which
    // a zero-padded vs unpadded hex string both parse to identically) closes
    // that gap without touching _norm's own bytes/string-only comparisons.
    scriptLines.push('    if isinstance(a, int) or isinstance(b, int):');
    scriptLines.push('        try: return _as_int(a) == _as_int(b)');
    scriptLines.push('        except Exception: pass');
    scriptLines.push('    try: return _norm(a) == _norm(b)');
    scriptLines.push('    except Exception: return False');
    scriptLines.push('_results = []');
    scriptLines.push('_errors = []');
    scriptLines.push('_independent = []');
    for (const a of assertions) {
      scriptLines.push('try:');
      scriptLines.push('    _results.append(bool(eval(' + JSON.stringify(a) + ', globals(), _ns)))');
      scriptLines.push('    _errors.append(None)');
      scriptLines.push('except BaseException as _e:');
      scriptLines.push('    _results.append(False)');
      scriptLines.push("    _errors.append(type(_e).__name__ + ': ' + str(_e))");

      const split = splitTopLevelEq(a);
      const argsText = split ? extractCallArgs(split[0]) : null;
      const trusted = argsText !== null ? trustedExpr(algorithmName, argsText) : null;
      if (trusted && split) {
        scriptLines.push('try:');
        scriptLines.push('    _independent.append(_values_equal(eval(' + JSON.stringify(trusted) + ', globals(), _ns), eval(' + JSON.stringify(split[1]) + ', globals(), _ns)))');
        scriptLines.push('except BaseException as _e:');
        scriptLines.push('    _independent.append(None)');
      } else {
        scriptLines.push('_independent.append(None)');
      }
    }
    // os.write(1, ...) writes directly to the real OS file descriptor,
    // never through the `sys.stdout` Python object -- a plain `print()`
    // call resolves its output stream from `sys.stdout` FRESH at every
    // call, so untrusted code (running inside `_ns`, but `sys` is a
    // process-global module, not namespace-scoped) reassigning `sys.stdout`
    // to a wrapper object would intercept a `print()` call here regardless
    // of the per-run marker's randomness -- confirmed exploitable, the same
    // class already found and fixed in compression's harness.
    scriptLines.push('_os.write(1, (' + JSON.stringify(mark) + ' + _json.dumps({"results": _results, "errors": _errors, "independent": _independent}) + "\\n").encode("utf-8", "replace"))');
    const script = scriptLines.join('\n');
    h.fs.writeFileSync(h.path.join(d, 'run_crypto.py'), script);

    const r = h.run('python3', [h.path.join(d, 'run_crypto.py')], { cwd: d, timeoutMs: 20000 });
    if (r.timedOut) {
      return { passed: false, runtimeUnavailable: true, logs: 'implementation_code timed out after 20s', detail: { algorithmName, timedOut: true } };
    }
    if (r.status !== 0) {
      return { passed: false, logs: 'harness script crashed: ' + String(r.stderr).slice(0, 1500), detail: { ranClean: false, assertions } };
    }
    const outRaw = h.lastMarked(String(r.stdout), mark);
    if (outRaw === null) {
      return { passed: false, logs: 'no @@OUT marker in script output', detail: { stdout: String(r.stdout).slice(0, 500), stderr: String(r.stderr).slice(0, 500) } };
    }
    const out = h.jsonOf(outRaw);
    if (out === null || !Array.isArray(out.results)) {
      return { passed: false, logs: 'could not parse harness script output', detail: { outRaw: outRaw.slice(0, 500) } };
    }

    const allTrue = out.results.length > 0 && out.results.every((v) => v === true);
    const independent = Array.isArray(out.independent) ? out.independent : [];
    const independentFailures = independent.filter((v) => v === false).length;
    const independentlyVerifiedCount = independent.filter((v) => v === true || v === false).length;
    const passed = allTrue && independentFailures === 0;

    return {
      passed,
      logs: !allTrue
        ? `official_test_vectors expects a match but real execution disagreed: results=${JSON.stringify(out.results)} errors=${JSON.stringify(out.errors)}`
        : independentFailures > 0
          ? `implementation_code matches its own official_test_vectors, but ${independentFailures} vector(s) do not match an INDEPENDENTLY computed reference value (via Python's own hashlib/hmac/zlib/base64) — the reference data itself may be fabricated or wrong`
          : '',
      detail: {
        algorithmName,
        assertions,
        results: out.results,
        errors: out.errors,
        expectedResults,
        independentGroundTruth: independent,
        independentlyVerifiedCount,
        note: independentlyVerifiedCount > 0
          ? 'vector(s) independently cross-checked against Python stdlib (hashlib/hmac/zlib/base64) — not just self-consistency'
          : 'algorithm not in the independently-checkable set (e.g. a block/stream cipher or KDF) — this row relies on self-consistency only; weight LLM/human audit accordingly',
      },
    };
  },
};
