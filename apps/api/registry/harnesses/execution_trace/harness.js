/**
 * exact-output-match — run `code` and check that its output matches
 * predicted_output.
 *
 * Two different row shapes share this one dataset type:
 *  - Python/JS rows: `code` is a bare function definition with no
 *    entrypoint; `input` is a real, evaluable expression ("f(10)") that gets
 *    appended as a print call.
 *  - Java/Go/Rust/C++ rows: `code` is already a COMPLETE, self-printing
 *    program (its own main()/fn main() that prints the traced value);
 *    `input` is a human-readable description of what's being traced, not
 *    always valid syntax in the language ("count of primes in 2..30", "max
 *    of {5, 3, 8, 1, 9}") — nothing to append, just run the code as-is.
 */
'use strict';

/**
 * Cut `expr` at the first '#' or '//' that is NOT inside a quoted string
 * (so a URL or similar literal argument containing '//' survives), then
 * drop a trailing ';'. Quote-aware on purpose: a blind regex cut at the
 * first '//' would also truncate a perfectly legitimate string-literal
 * argument like parse_url("http://example.com").
 */
function stripTrailingNoise(expr) {
  let quote = null;
  let cutAt = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === quote && expr[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '#') { cutAt = i; break; }
    if (c === '/' && expr[i + 1] === '/') { cutAt = i; break; }
  }
  const cut = cutAt === -1 ? expr : expr.slice(0, cutAt);
  return cut.trim().replace(/;\s*$/, '');
}

/**
 * True if `expr` contains an unquoted ';' or a raw line-break character --
 * any of these would let `input` early-close the harness's own generated
 * print/console.log call and inject new top-level statements before a dummy
 * expression re-opens a balanced call for the harness's own trailing ')' to
 * land on. This forges a passing verdict with ZERO changes to `code` (so it
 * isn't visible to anyone reviewing `code` alone) and does not depend on any
 * exit()-style trick, so it is independent of and not mitigated by the
 * process.exit trap in helpers.js's JS_PRELUDE. stripTrailingNoise only
 * strips a single TRAILING terminator/comment; this additionally rejects one
 * embedded anywhere.
 *
 * `\n` alone is NOT the only line-break byte that matters here -- confirmed
 * exploitable via a bare `\r` (U+000D), trivially expressible as an ordinary
 * `\r` JSON escape in `input`: Python's PY_DRIVER reads the submission file
 * with plain `open(path)`, i.e. universal-newlines TEXT mode, which silently
 * translates a lone `\r` to `\n` before compile()/exec() ever see the
 * source -- so a `\r` this check never recognized as a separator becomes a
 * genuine newline by the time the program actually runs. JavaScript needs no
 * translation at all: ECMAScript's own lexical grammar defines a bare `\r`
 * as a LineTerminator in its own right, independent of `\n`, and additionally
 * treats U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR) as real line breaks too --
 * both are trivially embeddable via ` `/` ` JSON escapes.
 */
function hasStatementSeparator(expr) {
  let quote = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === quote && expr[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === ';' || c === '\n' || c === '\r' || c === ' ' || c === ' ') return true;
  }
  return false;
}

module.exports = {
  contract: 'exact-output-match',
  requires: [],

  verify(row, h) {
    const code = h.str(row, 'code');
    const input = h.str(row, 'input').trim();
    const predicted = h.str(row, 'predicted_output').trim();
    const language = h.str(row, 'language');
    if (!code || !predicted) return { passed: false, detail: { reason: 'missing code or predicted_output' } };

    // input is spliced directly into a generated print/console.log call — a
    // trailing statement terminator or line comment (both entirely ordinary
    // things to type, and nothing in the schema warns against either) would
    // otherwise corrupt that line: a trailing `;` lands INSIDE the call's
    // argument list where it's a syntax error, and a trailing `#`/`//`
    // comments out the harness's own appended closing paren along with it.
    const cleanInput = stripTrailingNoise(input);

    const lang = h.normLang(language);
    let program;
    if (lang === 'python' || lang === 'javascript' || lang === 'typescript') {
      if (hasStatementSeparator(cleanInput)) {
        return {
          passed: false,
          logs: 'input contains an unquoted ";" or newline, which is not a single evaluable expression',
          detail: { language, rejected: 'unsafe-input-expression' },
        };
      }
    }
    if (lang === 'python') {
      program = code + '\nprint(' + cleanInput + ')';
    } else if (lang === 'javascript' || lang === 'typescript') {
      // Plain console.log, not JSON.stringify: predicted_output was generated
      // from Node's own default inspect formatting (unquoted object keys,
      // spaced brackets, no quotes around a bare string result) — wrapping in
      // JSON.stringify produces "quoted strings" and {"compact":"json"} that
      // never match that format.
      program = code + '\nconsole.log(' + cleanInput + ');';
    } else {
      program = code;
    }

    const r = h.runCode(lang, program, 20000);
    if (r.unavailable) {
      return { passed: false, runtimeUnavailable: true, logs: (r.runtime || lang) + ' not available in sandbox', detail: { language } };
    }
    if (r.ok !== true) {
      return { passed: false, logs: String(r.stderr || '').slice(0, 1500), detail: { language, ranClean: false, timedOut: !!r.timedOut } };
    }

    const actual = String(r.stdout || '').trim();
    // Deliberately NOT h.looseEqual here: this category predicts exact
    // printed output, where "[ 1, 2, 3, 4 ]" (console.log's array format) and
    // "1,2,3,4" (Array#toString) are genuinely different results, not the
    // same value in different notation — h.looseEqual's bracket-stripping
    // made a row with a wrong predicted format pass. Only normalize the
    // things that really are notation, not content (quote style, Python
    // True/False/None vs JSON, incidental whitespace).
    const normLite = (s) => String(s).replace(/'/g, '"').replace(/\s+/g, ' ').trim()
      .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
    let mode = 'strict';
    let ok = actual === predicted;
    if (!ok) { ok = normLite(actual) === normLite(predicted); if (ok) mode = 'notation-normalized'; }
    if (!ok) {
      const an = Number(actual), en = Number(predicted);
      if (!Number.isNaN(an) && !Number.isNaN(en) && Math.abs(an - en) < 0.001) { ok = true; mode = 'numeric-tolerance'; }
    }

    return {
      passed: ok,
      logs: ok ? '' : ('produced ' + actual.slice(0, 300) + ' but predicted ' + predicted.slice(0, 300)),
      detail: { language, matchMode: ok ? mode : 'none', actual: actual.slice(0, 300), predicted: predicted.slice(0, 300) },
    };
  },
};
