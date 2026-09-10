/**
 * exact-output-match, per-locale — formatting_code (an Intl.* expression
 * referencing `locale` and `value`/`date`) must produce the specific output
 * documented for EACH locale in locales_tested.
 *
 * expected_outputs_per_locale is structured prose with one exploitable
 * regularity: "locale: 'output' · locale: 'output' -- optional explanation".
 * Parsed into a real per-locale map and compared directly, rather than
 * checking whether the combined prose string merely CONTAINS each output as
 * a substring (which could not tell a correct value in the wrong locale from
 * one that just happens to overlap).
 *
 * formatting_code runs inline, sharing this script's process and stdout with
 * the harness's own verdict-emission logic that runs after it -- unlike the
 * shared h.runCode/h.runWithTests path other categories use (which carries a
 * process.exit trap for exactly this reason), this harness hand-rolls its
 * own Node execution. A formatting_code that prints a forged result object
 * and calls process.exit(0) before the harness's own per-locale loop
 * finishes terminates the process with exit code 0, which this harness's own
 * status check never catches -- confirmed exploitable. process.exit is
 * trapped BEFORE evalCode ever runs, and the verdict is emitted behind a
 * per-run random marker parsed via h.lastMarked, never "whatever stdout
 * happens to contain" -- but TWO further things had to be closed beyond
 * that, both confirmed exploitable independent of the marker's randomness:
 *  - `console.log.bind(console)` does NOT protect against formatting_code
 *    mutating `process.stdout.write` in place (Node's Console instance
 *    still writes through a live reference to the SAME stream object it
 *    already holds, so reassigning that object's `.write` property
 *    intercepts console.log's output too, no `sys.stdout`-style whole-
 *    object reassignment needed). Fixed by writing the verdict directly to
 *    file descriptor 1 via `fs.writeSync`, bypassing `process.stdout`/
 *    `console` entirely.
 *  - A captured `JSON.stringify` reference does NOT protect against
 *    `Object.prototype.toJSON` poisoning: `JSON.stringify(out)` looks up
 *    `out.toJSON` via the prototype chain AT CALL TIME regardless of which
 *    `JSON.stringify` reference is invoked, so formatting_code assigning
 *    `Object.prototype.toJSON = () => <forged object>` makes even the
 *    pristine captured reference serialize a fabricated result instead of
 *    `out`'s own real per-locale values. Fixed by freezing Object.prototype
 *    before formatting_code/evalCode ever runs, so that assignment silently
 *    no-ops (this script has no top-level 'use strict', so a write to a
 *    frozen property fails silently rather than throwing).
 */
'use strict';

const crypto = require('crypto');

module.exports = {
  contract: 'exact-output-match',
  requires: ['node'],

  verify(row, h) {
    const code = h.str(row, 'formatting_code');
    const localesTested = h.str(row, 'locales_tested');
    const sampleValues = h.str(row, 'sample_values').trim();
    const expectedRaw = h.str(row, 'expected_outputs_per_locale');
    if (!code || !localesTested || !expectedRaw) {
      return { passed: false, detail: { reason: 'missing formatting_code, locales_tested, or expected_outputs_per_locale' } };
    }
    // Cheap sanity gate against a hardcoded lookup with zero real locale
    // awareness (e.g. "locale === 'de-DE' ? '1.234,50 $' : '$1,234.50'") --
    // self-consistency alone can never tell that apart from genuine Intl
    // usage, since expected_outputs_per_locale is itself contributor-
    // authored. This doesn't prove the code is CORRECT, only that it at
    // least attempts real locale-aware formatting rather than a static
    // per-locale answer table.
    if (!/\bIntl\./.test(code)) {
      return { passed: false, logs: 'formatting_code does not reference Intl.* at all -- cannot be genuine locale-aware formatting', detail: {} };
    }
    if (!h.have('node')) return { passed: false, runtimeUnavailable: true, logs: 'node not available', detail: {} };

    const locales = localesTested.split(',').map((s) => s.trim()).filter(Boolean);

    // Strip an optional trailing "-- explanation" suffix (the documented
    // format is "locale: 'output' · locale: 'output' -- optional
    // explanation") BEFORE splitting into per-locale parts. Without this, an
    // explanation that itself contains an apostrophe (e.g.
    // "-- roundingMode:'ceil'") supplies the greedy quote-match below with
    // its OWN closing quote instead of the real one right after the actual
    // expected value -- confirmed exploitable: the whole explanation got
    // folded into the last locale's "expected" value, failing an otherwise
    // fully correct row. Non-greedy on the prefix so this cuts at the FIRST
    // " -- " (the one the format documents), not a later one the
    // explanation's own prose might happen to contain.
    const explanationSplit = expectedRaw.match(/^([\s\S]*?)\s+--\s+[\s\S]*$/);
    const expectedCore = explanationSplit ? explanationSplit[1] : expectedRaw;

    const perLocaleExpected = {};
    for (const part of expectedCore.split('·')) {
      // Greedy (not `[^']*`) so an apostrophe legitimately appearing INSIDE
      // the expected output itself (a French elision like "aujourd'hui", an
      // English possessive/contraction) doesn't truncate the match at that
      // first apostrophe -- confirmed exploitable without this: "aujourd'hui"
      // was silently cut down to "aujourd", producing a spurious mismatch
      // against a fully correct real computed value.
      const quoted = part.match(/([\w-]+)\s*:\s*'(.*)'/);
      // Collator#compare-style rows document a bare true/false, not a
      // quoted string.
      const bareBool = part.match(/([\w-]+)\s*:\s*(true|false)\b/);
      if (quoted) perLocaleExpected[quoted[1].trim()] = quoted[2];
      else if (bareBool) perLocaleExpected[bareBool[1].trim()] = bareBool[2];
    }

    // formatting_code's own trailing method call names the exact variables
    // it needs (.format(items), .format(value, unit), .compare(a, b)) — used
    // to decide how to parse sample_values rather than assuming it's always
    // a single date/number. Matched anywhere in the code and taking the LAST
    // occurrence (not anchored to end-of-string): a contributor who writes
    // the boolean comparison explicitly and correctly, e.g.
    // "new Intl.Collator(locale).compare(a, b) < 0" -- arguably the MORE
    // robust style, since nothing in this schema documents the alternative
    // bare-`.compare()` convention -- used to leave NOTHING at the literal
    // end of the string but ") < 0", so the anchored form found no call at
    // all and silently fell back to defining date/value instead of a/b,
    // producing an opaque "ERR:a is not defined" with no hint that the real
    // cause was variable-name inference, not the comparison logic.
    const callMatches = [...code.matchAll(/\.\w+\(([^()]*)\)/g)];
    const lastCallMatch = callMatches.length ? callMatches[callMatches.length - 1] : null;
    const argNames = lastCallMatch ? lastCallMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];

    // "count = 2" — a direct assignment statement rather than a bare value.
    const assignMatch = sampleValues.match(/^\s*(\w+)\s*=\s*(.+)$/);

    let setupLines;
    if (assignMatch) {
      setupLines = ['const ' + assignMatch[1] + ' = ' + assignMatch[2] + ';'];
    } else if (argNames.length === 1 && argNames[0] === 'items') {
      // sample_values is already a valid JS array literal ("['a','b','c']").
      setupLines = ['const items = ' + sampleValues + ';'];
    } else if (argNames.length === 1 && argNames[0] === 'date') {
      setupLines = ['const date = new Date(' + JSON.stringify(sampleValues) + ');'];
    } else if (argNames.length === 1) {
      // Generic single named argument (e.g. `code` for DisplayNames) —
      // sample_values is already valid JS on its own ("'DE'", a number).
      setupLines = ['const ' + argNames[0] + ' = ' + sampleValues + ';'];
    } else if (argNames.length >= 2) {
      // Multi-arg case ("-1, 'day'" for value+unit, or "'z', 'ö'" for a/b) —
      // sometimes wrapped in a descriptive functionName(...) shell
      // ("compare('z', 'ö')") that is not itself part of the values. Strip
      // that wrapper if present, then destructure positionally by name.
      const wrapped = sampleValues.match(/^\s*[\w.]+\((.*)\)\s*$/s);
      const inner = wrapped ? wrapped[1] : sampleValues;
      // A trailing call argument can be a LITERAL the code itself hardcodes
      // (e.g. the unit string in `.format(value, 'day')` for
      // RelativeTimeFormat), not a variable name sample_values needs to
      // supply -- confirmed exploitable without this: `const [value, 'day']
      // = [...]` is a SyntaxError (an array-destructuring target must be an
      // identifier, not a string literal), so every row using this entirely
      // ordinary convention crashed before formatting_code ever ran. Only
      // genuine identifier-shaped names need a sample_values-supplied
      // binding; a literal argument is already complete as written.
      const identifierNames = argNames.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
      if (identifierNames.length === argNames.length) {
        setupLines = ['const [' + argNames.join(', ') + '] = [' + inner + '];'];
      } else if (identifierNames.length === 1) {
        setupLines = ['const ' + identifierNames[0] + ' = ' + inner + ';'];
      } else if (identifierNames.length > 1) {
        setupLines = ['const [' + identifierNames.join(', ') + '] = [' + inner + '];'];
      } else {
        setupLines = [
          'const date = new Date(' + JSON.stringify(sampleValues) + ');',
          'const value = Number(' + JSON.stringify(sampleValues) + ');',
        ];
      }
    } else {
      // No trailing call detected at all — fall back to defining both
      // date and value defensively.
      setupLines = [
        'const date = new Date(' + JSON.stringify(sampleValues) + ');',
        'const value = Number(' + JSON.stringify(sampleValues) + ');',
      ];
    }

    // Intl.Collator#compare returns a signed number (negative/zero/positive),
    // but this dataset's expected_outputs_per_locale documents the derived
    // yes/no question ("does 'z' sort before 'ö'?") as a bare true/false —
    // stringifying the raw compare() result directly would produce "-1"
    // and never match "true"/"false" for any locale. Anchored to the
    // TRAILING call (not a bare substring test) so code that already wraps
    // its own compare() result in a boolean comparison isn't wrapped a
    // second time — `true < 0` and `false < 0` are BOTH `false` in JS, so a
    // blind substring test forced every already-boolean row to evaluate to
    // "false" unconditionally, regardless of the real comparison result.
    const endsWithRawCompare = /\.compare\([^()]*\)\s*;?\s*$/.test(code.trim());
    const evalCode = endsWithRawCompare ? '(' + code + ') < 0' : code;

    const mark = '@@I18N_' + crypto.randomBytes(12).toString('hex') + '_';

    const d = h.workdir();
    const prog = [
      // Set up BEFORE formatting_code (or any setup/evalCode derived from
      // it) ever runs. process.exit is replaced with a function that THROWS
      // rather than terminates, so code calling it can no longer forge a
      // clean, zero-status exit before the real verdict is ever computed.
      // _real_console_log writes directly to file descriptor 1 -- NOT
      // console.log/process.stdout.write, both of which formatting_code can
      // intercept by mutating process.stdout's own `.write` property in
      // place (no need to reassign process.stdout itself). Object.prototype
      // is frozen so formatting_code cannot poison a global `toJSON` that
      // JSON.stringify(out) would consult via the prototype chain regardless
      // of which JSON.stringify reference calls it.
      'const _real_console_log = (s) => { require("fs").writeSync(1, s + "\\n"); };',
      'const _real_json_stringify = JSON.stringify;',
      'Object.freeze(Object.prototype);',
      'process.exit = function (c) { throw new Error("process.exit(" + c + ") called -- forbidden inside formatting_code"); };',
      'process.reallyExit = process.exit;',
      'const out = {};',
      'const locales = ' + JSON.stringify(locales) + ';',
    ].concat(setupLines, [
      'for (const locale of locales) {',
      '  try {',
      // evalCode on its OWN line, with the closing `);` on the line after —
      // a trailing '//' comment inside contributor-authored `code` (an
      // entirely ordinary thing to write) used to land on the SAME line as
      // the harness's own appended `); }`, commenting those out along with
      // it and corrupting the whole generated script. Isolating evalCode on
      // its own line means a trailing comment can only consume that one
      // line, never the harness's own surrounding structure.
      '    const __v = (',
      '      ' + evalCode,
      '    );',
      '    out[locale] = String(__v);',
      '  } catch (e) { out[locale] = "ERR:" + e.message; }',
      '}',
      '_real_console_log(' + JSON.stringify(mark) + ' + _real_json_stringify(out));',
    ]).join('\n');
    const f = h.path.join(d, 'i.js');
    h.fs.writeFileSync(f, prog);
    const r = h.run('node', [f], { cwd: d, timeoutMs: 20000 });
    if (r.timedOut) {
      return { passed: false, runtimeUnavailable: true, logs: 'formatting_code timed out after 20s', detail: { timedOut: true } };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr || '').slice(0, 800), detail: { ranClean: false } };
    }

    // rawStdout (uncapped), not the 32000-char-capped stdout: a submission
    // with many locales_tested entries and/or large per-locale results could
    // otherwise have its trailing marker line truncated away and be scored a
    // false FAIL -- helpers.js's own OUT_CAP comment names this category as
    // still exposed to that.
    const outRaw = h.lastMarked(String(r.rawStdout != null ? r.rawStdout : r.stdout), mark);
    const got = outRaw === null ? null : h.jsonOf(outRaw);
    if (got === null) {
      return { passed: false, logs: 'could not parse output: ' + String(r.stdout).slice(0, 300), detail: {} };
    }

    const mismatches = [];
    for (const locale of locales) {
      const expectedForLocale = perLocaleExpected[locale];
      const actualForLocale = got ? got[locale] : undefined;
      if (expectedForLocale == null) { mismatches.push(locale + ': no expected value found in expected_outputs_per_locale'); continue; }
      if (actualForLocale == null || String(actualForLocale).startsWith('ERR:')) { mismatches.push(locale + ': ' + actualForLocale); continue; }
      if (actualForLocale !== expectedForLocale && !h.looseEqual(actualForLocale, expectedForLocale)) {
        mismatches.push(locale + ': got "' + actualForLocale + '" expected "' + expectedForLocale + '"');
      }
    }

    const passed = mismatches.length === 0 && locales.every((l) => l in perLocaleExpected);
    return {
      passed,
      logs: passed ? '' : mismatches.join('; '),
      detail: { locales, produced: got, expected: perLocaleExpected },
    };
  },
};
