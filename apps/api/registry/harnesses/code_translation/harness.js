/**
 * translation-equivalence-gated-pass — "target_code passes its tests" is
 * necessary but far too weak for a TRANSLATION contract on its own: it would
 * accept a target that implements an unrelated function, a test suite that
 * only checks a return type, and source metadata that does not match the
 * source code it is attached to. Four gates, each reported separately so a
 * rejection is explainable rather than a bare false:
 *
 *   A. target_code + tests actually pass, executed in target_language.
 *   B. source_code parses as the DECLARED source_language (abstains — null —
 *      when no cheap parse-only checker exists for that language, rather
 *      than rejecting on missing evidence).
 *   C. target_code implements the SAME function as source_code (identifier
 *      token overlap, tolerant of a snake_case -> camelCase rename).
 *   D. the test suite asserts on VALUES, not merely a typeof/instanceof check
 *      that any implementation — right or wrong — would also satisfy.
 *
 * Ported from scratch/catrun/reports/code_translation.json (19/25 raw pass,
 * 24/25 label-correct there; row 15's Ruby->PHP pair was the sole discrepancy,
 * purely because that prototype's sandbox had no php binary — this template
 * ships php-cli, so gate A can actually execute it here).
 *
 * Round-2 hardening (Gate D binding + comment/string stripping): every gate
 * above is a TEXT-PATTERN match, not a real parse, and every text-pattern
 * match in this file used to share one structural weakness — a match proved
 * a token exists somewhere in the string, never that the token is LIVE code
 * bound to the thing it's supposed to be checking. Two concrete instances,
 * both confirmed exploitable and both fixed here:
 *   (1) Gate D's hasValueAssert ran against RAW `tests` text with no
 *       comment/string stripping — a `//` comment or a string literal
 *       CONTAINING `===`/`==`/etc. satisfied it exactly as well as a real
 *       comparison (`sumValues([1,2,3]); // ===` or `sumValues([1,2,3]);
 *       "a == b";` both used to pass).
 *   (2) Even with real operators, hasValueAssert never required the
 *       comparison to actually involve the function under test — a test
 *       body of `sumValues([1, 2, 3]); 1 === 1;` (call on one line, a
 *       vacuous same-literal comparison on the next) used to pass, because
 *       "contains a call" and "contains a comparison" were checked
 *       independently across the WHOLE file rather than within one bound
 *       statement.
 * Fixed by (a) stripCommentsAndStrings() blanking comment text and string-
 * literal CONTENTS before ANY of this file's raw-text regexes run over
 * `tests`/`source_code` (calledNames/fnNames were exposed to the identical
 * class of false match and are stripped too, for the same reason), and (b)
 * boundValueAssert() requiring a passing comparison to occur within the same
 * logical statement as a direct call to one of calledNames(tests), or to a
 * variable previously assigned FROM such a call (derivedResultVars) — the
 * latter needed because this dataset's own real Go/Rust/C++ rows write the
 * call and the comparison on separate lines by idiom (`got := f(...)` then
 * `if got[0] == ... {}`), not because it was invented for the adversarial
 * case alone. See each function's own doc comment for exact scope and the
 * residual gaps this does NOT close (multi-language raw-string/heredoc
 * lexing, cross-scope dataflow, and assertions made unreachable by dead
 * code/swallowed exceptions — the last of these is a `tests`-authoring
 * attack this round did not attempt to close; see boundValueAssert's comment).
 */
'use strict';

/**
 * Syntax-check code in a declared language WITHOUT executing it. Used only to
 * validate the row's OWN source_language metadata — a shape-based guess
 * cannot tell C# from Java or PHP from JavaScript, so guessing would reject
 * valid rows; asking the real parser is precise, and abstains (checked:false)
 * for the languages with no cheap parse-only mode wired up here.
 */
function syntaxCheck(lang, code, h) {
  const L = h.normLang(lang);
  const d = h.workdir();
  const write = (name) => {
    const f = h.path.join(d, name);
    h.fs.writeFileSync(f, String(code == null ? '' : code));
    return f;
  };
  if (L === 'python') {
    if (!h.have('python3')) return { checked: false, reason: 'python3 absent' };
    const r = h.run('python3', ['-m', 'py_compile', write('s.py')], { cwd: d, timeoutMs: 5000 });
    return { checked: true, ok: r.status === 0, diag: (r.stderr || '').slice(0, 300) };
  }
  if (L === 'javascript') {
    if (!h.have('node')) return { checked: false, reason: 'node absent' };
    const r = h.run('node', ['--check', write('s.js')], { cwd: d, timeoutMs: 5000 });
    return { checked: true, ok: r.status === 0, diag: (r.stderr || '').slice(0, 300) };
  }
  if (L === 'go') {
    if (!h.have('gofmt')) return { checked: false, reason: 'gofmt absent' };
    const r = h.run('gofmt', ['-e', write('s.go')], { cwd: d, timeoutMs: 5000 });
    return { checked: true, ok: r.status === 0, diag: (r.stderr || '').slice(0, 300) };
  }
  if (L === 'ruby') {
    if (!h.have('ruby')) return { checked: false, reason: 'ruby absent' };
    const r = h.run('ruby', ['-c', write('s.rb')], { cwd: d, timeoutMs: 5000 });
    return { checked: true, ok: r.status === 0, diag: (r.stderr || '').slice(0, 300) };
  }
  if (L === 'php') {
    if (!h.have('php')) return { checked: false, reason: 'php absent' };
    // The `<?php` tag is REQUIRED, not cosmetic: php treats anything outside a
    // tag as literal HTML and never parses it, so `php -l` on an untagged
    // function body reports "No syntax errors" unconditionally — a silently
    // vacuous gate. Every PHP `source_code` in this dataset is a bare function
    // body with no tag. Same guard helpers.js's own runCode php branch applies.
    // Anchored to the START of the code, not a substring search anywhere in
    // it: a legitimate source_code that merely MENTIONS "<?php" inside a
    // comment or doc-string (e.g. a usage example) used to be detected as
    // "already tagged", so the real opening tag was never prepended — php's
    // lexer then treats everything before that in-text occurrence as literal
    // HTML (parsing nothing), re-enters PHP mode mid-comment at an arbitrary
    // offset, and reports a real-looking but spurious syntax error for a
    // correctly-written submission.
    const tagged = /^\s*<\?php/.test(String(code == null ? '' : code));
    const f = h.path.join(d, 's.php');
    h.fs.writeFileSync(f, (tagged ? '' : '<?php\n') + String(code == null ? '' : code));
    const r = h.run('php', ['-l', f], { cwd: d, timeoutMs: 5000 });
    return { checked: true, ok: r.status === 0, diag: (r.stderr || '').slice(0, 300) };
  }
  // No cheap parse-only mode for the rest (C#, Java, Rust, C++, TypeScript):
  // abstain rather than compile, which would conflate a type error with a
  // syntax error. Distinguished from a genuinely-unrecognized language
  // string (a typo/variant like "Golang"/"NodeJS" that h.normLang doesn't
  // map to anything) so an auditor can tell "we chose not to check this"
  // apart from "the declared language string didn't resolve at all".
  if (L === 'unknown') {
    return { checked: false, reason: 'declared language "' + lang + '" did not normalize to any recognized language' };
  }
  return { checked: false, reason: 'no parse-only checker for ' + L };
}

/**
 * Blank out comment TEXT and string-literal CONTENTS (quote characters kept)
 * before any of this file's own text-scanning regexes run over `tests` or
 * `source_code` — hasValueAssert (via boundValueAssert), calledNames, and
 * fnNames all previously ran directly against raw, unstripped source, so a
 * comparison operator or an apparent function call sitting inside a
 * `//`/`#`/`/* *\/` comment, or inside a string literal, read identically to
 * a live one:
 *   sumValues([1, 2, 3]);
 *   // ===
 * satisfied hasValueAssert's raw regex just as well as a REAL `===`, and
 *   // old: sumValues(x)
 * would satisfy calledNames'/fnNames' raw `NAME(` regex just as well as a
 * genuine call/declaration. Adapted from helpers.js's own (internal, not
 * exposed on `h`) stripLineCommentsForLangDetect — same backslash-run-parity
 * quote-close rule, same cross-line-persisting-backtick rule for JS/TS
 * template literals — but that function only strips LINE comments (`#`/
 * `//`), which was sufficient for its own job (a one-shot language GUESS,
 * where a stray keyword in a block comment only risked a wrong language
 * pick). This file's job is an assertion-CORRECTNESS gate, where an operator
 * hiding in a `/* *\/` block comment is directly exploitable, so block
 * comments are stripped here too.
 *
 * `#` is treated as a line-comment starter whenever it is not immediately
 * preceded by an identifier character or `.` — correct for Python/Ruby/PHP
 * line comments, harmless for the other seven languages in this category's
 * enum (Python, JavaScript, TypeScript, Java, Go, Rust, C++, C#, Ruby, PHP
 * per schema.json — none of the other seven use a bare `#` as a live
 * operator; Rust's `#[attr]` and C/C++'s `#include` only ever occupy a
 * whole line in code this short, so losing the rest of that line costs
 * nothing this file's regexes look for), and the preceding-char guard
 * specifically avoids misreading JS's `this.#field` private-class-field
 * syntax as a comment start.
 *
 * Known, accepted residual (documented rather than silently unhandled, same
 * house style as this file's other scope-limit comments): Rust raw strings
 * (`r"..."`, `r#"..."#`), C#-style verbatim strings (`@"..."`, where `""` —
 * not backslash — escapes an embedded quote), and PHP/Ruby heredoc/nowdoc
 * and `=begin`/`=end` block comments are not specially recognized — each is
 * scanned with the same plain quote/backslash-parity rule as every other
 * string/comment, which prevents MOST accidental operator leakage but is
 * not a fully correct lexer for those specific syntaxes. Nested block
 * comments are not supported (the first `*\/` closes) — none of this
 * category's 10 supported languages use nested block comments in ordinary
 * test code.
 */
function stripCommentsAndStrings(code) {
  const src = String(code == null ? '' : code);
  const n = src.length;
  let out = '';
  let quote = null;
  let backslashRun = 0;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\n') {
        // Single/double-quote state never survives a newline (a still-open
        // '/" at end of line is far more likely a malformed fragment than a
        // real multi-line construct); a still-open backtick does.
        if (quote === "'" || quote === '"') { quote = null; backslashRun = 0; }
        out += '\n';
        continue;
      }
      if (ch === '\\') { backslashRun++; out += ' '; continue; }
      if (ch === quote && backslashRun % 2 === 0) { quote = null; backslashRun = 0; out += ch; continue; }
      backslashRun = 0;
      out += ' ';
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      const stop = j < n ? j + 2 : n;
      for (let k = i; k < stop; k++) out += src[k] === '\n' ? '\n' : ' ';
      i = stop - 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j - 1;
      continue;
    }
    if (ch === '#') {
      const prev = i > 0 ? src[i - 1] : '';
      if (!/[A-Za-z0-9_.$]/.test(prev)) {
        let j = i;
        while (j < n && src[j] !== '\n') j++;
        out += ' '.repeat(j - i);
        i = j - 1;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; backslashRun = 0; out += ch; continue; }
    out += ch;
  }
  return out;
}

/** Identifier extraction across all 10 languages this dataset uses. */
function fnNames(code) {
  const out = [];
  const pats = [
    /\bdef\s+([A-Za-z_]\w*)/g,
    /\bfunction\s+([A-Za-z_]\w*)/g,
    /\bfn\s+([A-Za-z_]\w*)/g,
    /\bfunc\s+([A-Za-z_]\w*)/g,
    // Go's idiomatic receiver-method form -- `func (r *Type) Name(...)` --
    // has no identifier immediately after `func`, so the plain `func` pattern
    // above never matches it. Without this, any Go side written as a method
    // extracted zero names, silently abstaining Gate C ("same function, not a
    // substitute") for a language this dataset explicitly supports.
    /\bfunc\s*\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/g,
    // The `\(` alternative REQUIRES an actual arrow marker after the
    // parameter list, not just any parenthesized expression -- a plain
    // `const value = (a * b);` used to be mis-extracted as a pseudo function
    // named "value", polluting the token set with a name unrelated to any
    // real function.
    /(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:\([^)]*\)\s*=>|function|async)/g,
    /\b(?:public|private|static)[\w<>[\],\s]*?\s([A-Za-z_]\w*)\s*\(/g,
    // Anonymous-function assignment forms with no declaration keyword to
    // anchor on -- Python `lambda`, Ruby `->`/`lambda`, PHP closures/arrow
    // functions. Without these, a source_code written as a bare lambda (one
    // of the most idiomatic ways to write a short translatable function in
    // exactly these languages) extracted ZERO names, and an empty
    // extraction silently disables Gate C rather than rejecting.
    /\b([A-Za-z_]\w*)\s*=\s*lambda\b/g,
    /\b([A-Za-z_]\w*)\s*=\s*(?:->|lambda\b)/g,
    /\$([A-Za-z_]\w*)\s*=\s*(?:function|fn)\s*\(/g,
  ];
  for (const p of pats) {
    let m;
    while ((m = p.exec(String(code || '')))) out.push(m[1]);
  }
  return out;
}

/**
 * Identifiers actually CALLED in `tests` -- the authoritative "function
 * under test" signal, since Gate A already proved target_code satisfies
 * exactly these calls. Comparing source_code's declared names against THIS
 * instead of against every name target_code happens to declare closes the
 * decoy-function hole: a throwaway/unrelated helper sitting next to the
 * real target function used to be swept into the same token set and could
 * manufacture a coincidental match with source_code that says nothing
 * about the actual tested logic.
 *
 * Expects comment/string-stripped input (stripCommentsAndStrings' output),
 * not raw `tests` — the same raw regex previously ran directly against
 * unstripped text, so `// old: sumValues(x)` (a comment mentioning a call
 * that never actually runs) fed a decoy name into this set just as easily
 * as a real call, which could then spuriously satisfy Gate C's overlap
 * check against a source_code name that has nothing to do with what the
 * tests actually exercise. All call sites in this file now strip first.
 */
function calledNames(testsSrc) {
  const out = new Set();
  const RESERVED = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
    'instanceof', 'new', 'console', 'assert', 'expect', 'describe', 'it', 'test',
    'require', 'import', 'print', 'println', 'System',
    // Assertion-library / test-framework method names -- these are the
    // MECHANISM that reports pass/fail, never the function under test, but
    // `\b([A-Za-z_]\w*)\s*\(` can't tell "the thing being asserted on"
    // (e.g. `add(2,3)` in `assert.strictEqual(add(2,3), 5)`) from "the
    // assertion helper doing the asserting" (`strictEqual` in the same
    // line) -- both are just identifiers immediately followed by `(`. Left
    // unreserved, a source_code function whose name happens to share a
    // token with one of these (isStrict/strictEqual, arraysEqual/deepEqual,
    // isSequential/SequenceEqual, ...) spuriously satisfies Gate C against
    // almost any test file using that helper, no matter what target_code
    // actually implements. First eight entries are exactly Gate D's own
    // hasValueAssert vocabulary (kept in sync deliberately: anything Gate D
    // recognizes as "the value-assertion call", Gate C must not mistake for
    // "the function under test"); the rest are additional assertion/test-
    // failure calls confirmed to actually appear in this registry's own
    // code_translation rows (New_Tester / sample_datasets), plus a few
    // same-family xunit names (assertTrue/assertFalse/assertNotEqual(s),
    // C#'s Assert.AreEqual) that are effectively zero-risk to reserve since
    // none of them could plausibly be an actual translated function's name.
    'assertEquals', 'assertEqual', 'deepEqual', 'deepStrictEqual', 'toEqual',
    'strictEqual', 'SequenceEqual', 'equals',
    'Assert', 'AssertionError', 'Fatalf', 'Fail',
    'assertTrue', 'assertFalse', 'assertNotEqual', 'assertNotEquals', 'AreEqual',
  ]);
  const re = /\b([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(String(testsSrc || '')))) {
    if (!RESERVED.has(m[1])) out.add(m[1]);
  }
  return out;
}

/**
 * Word tokens, not substrings — substring matching rejects the legitimate
 * idiomatic rename merge_dicts -> mergeObjects, while token overlap keeps it
 * (shared "merge") and still rejects title_case -> slugify (nothing shared).
 * snake_case and camelCase both split to the same tokens. An acronym run
 * (parseXMLData) is also split at its own boundary (parse / XML / Data),
 * not left glued to the following word.
 */
function tokens(s) {
  return String(s || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

// Generic verbs/nouns that show up in decl-name fragments constantly and
// prove nothing about two functions being related on their own -- a match
// must include at least one token OUTSIDE this list. Without this,
// getData/getResult (unrelated functions that merely both start with "get")
// or two decoy helpers both named helper_get() were enough to satisfy Gate C.
const GENERIC_TOKENS = new Set([
  'get', 'set', 'run', 'add', 'new', 'do', 'main', 'helper', 'util', 'utils',
  'temp', 'tmp', 'fn', 'func', 'value', 'data', 'obj', 'item', 'result',
]);
function hasMeaningfulOverlap(aTok, bTok) {
  for (const t of aTok) {
    if (bTok.has(t) && !GENERIC_TOKENS.has(t)) return true;
  }
  return false;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Variables whose value is DIRECTLY the return of a call to one of
 * `calledFnNames` — e.g. `let result = word_count(...)` (Rust), `ListNode*
 * newHead = reverse(&a)` (C++), `got := rotateValues13(...)` (Go). A later
 * statement asserting on one of THESE names is asserting on the
 * function-under-test's own output just as surely as a statement calling it
 * directly — and both real reference corpora this harness is verified
 * against actually use this idiom (Go's own two-statement `got := f(...)` /
 * `if got[0] == ... {}` convention; a Rust `let result = word_count(...);
 * assert_eq!(result["the"], 2);` pair): requiring the call to appear
 * literally inline with the comparison would reject those as false FAILs.
 *
 * Deliberately un-scoped: tracked across the WHOLE cleaned `tests` text, not
 * confined to one block/function. A real dataflow-scoped tracer would need
 * an actual per-language parser, which this file does not have and is not
 * attempting to build. The practical risk this accepts is a false ACCEPT —
 * a short generic variable name reused for something unrelated to the
 * function under test elsewhere in the same tests string, then asserted on
 * — not a false reject, and it requires the tests file to reuse the exact
 * same identifier for two different things; not observed in either real
 * reference corpus this file has been verified against.
 */
function derivedResultVars(cleanText, calledFnNames) {
  const out = new Set();
  if (!calledFnNames.size) return out;
  const alt = [...calledFnNames].map(escapeRegExp).join('|');
  // `:=` (Go) or a bare `=` NOT immediately part of `==`/`!=`/`<=`/`>=`/`=>`
  // — the trailing (?!=) lookahead alone is sufficient to exclude all of
  // those without needing a lookbehind (a leading `!`/`<`/`>` before the
  // `=` already fails to match the literal `=`/`:=` alternation at that
  // position at all, so the regex engine only ever succeeds on a genuine
  // assignment operator).
  const re = new RegExp('\\b([A-Za-z_]\\w*)\\s*(?::=|=(?!=))\\s*(?:await\\s+)?(?:' + alt + ')\\s*\\(', 'g');
  let m;
  while ((m = re.exec(cleanText))) out.add(m[1]);
  return out;
}

/**
 * Split cleaned `tests` text into independent logical statements, so
 * boundValueAssert can require a value-comparison to occur WITHIN the same
 * statement as a call to (or a variable derived from) the function under
 * test, rather than merely somewhere in the whole file — closing the exact
 * gap the `sumValues([1, 2, 3]); 1 === 1;` bug report demonstrated (two
 * textually adjacent but logically unrelated statements, previously
 * indistinguishable from a real bound assertion because hasValueAssert and
 * "the file calls the function somewhere" were checked independently
 * against the whole text).
 *
 * Splits on top-level `;` and newline, where "top-level" means paren/
 * bracket depth 0 — a still-open `(`/`[` (a multi-line call's argument
 * list, or an array/object literal spanning lines) keeps accumulating
 * instead of being severed mid-expression.
 *
 * `{`/`}` are deliberately NOT depth-tracked. Tracking them would also
 * require special-casing Go's paren-less `if init; cond { ... }` header (so
 * the header's OWN internal `;` isn't treated as a split point and doesn't
 * sever the bound variable from its comparison) — but this dataset's own Go
 * rows never use that single-line form (confirmed empirically against both
 * real reference corpora: every Go row writes the bound variable on its own
 * preceding line, e.g. `got := f(...)` then `if got[0] == ... {}` on the
 * next), so tracking only `()`/`[]` handles the idiom actually in use
 * without that extra special case. Named residual: a hypothetical
 * single-line `if x := f(); x != y { ... }` would be split into two
 * statements here and lose the binding — a false REJECT, not a false
 * accept, if a future row ever uses that exact form.
 */
function splitLogicalStatements(cleanText) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ';' || ch === '\n')) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

const TYPEOF_OPERAND = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]*\\])*';
// The quoted type-name's own character class is `[a-z ]*`, not `[a-z]+`:
// stripTypeOnlyAsserts always runs AFTER stripCommentsAndStrings has already
// blanked string-literal CONTENTS to spaces (quote characters kept) --
// `typeof result === 'object'` arrives here as `typeof result === '      '`.
// Requiring literal lowercase letters would never match the now-blanked
// type name, silently un-recognizing every real typeof-check statement and
// making its own `===` count as a (bogus) value assertion instead of being
// correctly excluded -- confirmed as a real regression during this round's
// own local verification (a genuine `typeof result === "object"` statement
// stopped being recognized as type-only once string-blanking was added).
// Matching blanked space content too is safe: this only ever REMOVES more
// text from a statement before HAS_VALUE_ASSERT_RE runs on it, which can
// only make a false REJECT more likely, never manufacture a false ACCEPT.
const TYPE_ONLY_RE_1 = new RegExp('typeof\\s+' + TYPEOF_OPERAND + '\\s*\\([^;]*?\\)\\s*===?\\s*[\'"][a-z ]*[\'"]', 'g');
const TYPE_ONLY_RE_2 = new RegExp('typeof\\s+' + TYPEOF_OPERAND + '\\s*===?\\s*[\'"][a-z ]*[\'"]', 'g');
/**
 * typeof's operand pattern accepts a member-access chain (`typeof u.name`),
 * not just a bare identifier — a disguised type check's own literal `===`
 * would otherwise be left uncounted as a real assertion, miscounting
 * `typeof u.name === 'string'` as a value assertion instead of the
 * type-only check it actually is. Same removal logic as before this round's
 * refactor, just scoped to one statement instead of the whole file.
 */
function stripTypeOnlyAsserts(stmt) {
  return stmt
    .replace(TYPE_ONLY_RE_1, '')
    .replace(TYPE_ONLY_RE_2, '')
    .replace(/Array\.isArray\s*\([^;]*?\)/g, '')
    .replace(/\w+\s+instanceof\s+\w+/g, '');
}

// Confirmed against a real E2B run (sample_datasets' own reference rows):
// two genuinely correct, undecorated translations were rejected here ("test
// asserts no real value") purely because their otherwise-ordinary value
// comparisons are written in an idiom this regex didn't recognize -- Go's
// `if got != want { t.Fail() }` (Go has no `===`/`==`-based assert helper at
// all; `!=`/`==` IS the idiomatic comparison), and Java/general-OOP's
// `x.equals(y)` (the CORRECT way to compare strings/objects in Java, where
// `==`/`===` would wrongly test reference identity instead of value
// equality -- a Java test that avoids `==` is doing the right thing, not
// skipping the assertion). Neither row was labeled FLAWED; both were
// legitimate passes this gate was incorrectly blocking.
//
// A second, distinct gap in the same family surfaced immediately after
// fixing the above, against New_Tester's own C++->C# rows: C# has no usable
// `==`/`.Equals()` for element-wise ARRAY/sequence comparison (`.Equals()`
// on an array is reference identity, and `==` doesn't exist for array types
// at all) -- the correct, idiomatic C# check is LINQ's `a.SequenceEqual(b)`.
// `Arrays.equals(a, b)` (Java's static array-equality utility) already
// matched the `\.equals\s*\(` alternative above via a plain substring match
// ("Arrays.equals(" contains ".equals("), so only `SequenceEqual` needed
// adding explicitly.
const HAS_VALUE_ASSERT_RE = /===|==|!=|\.equals\s*\(|SequenceEqual|deepStrictEqual|deepEqual|assert_eq|toEqual|strictEqual|assertEquals|assertEqual\b|\.to\s+eql?\b/;

/**
 * Gate D's real check: at least one logical statement in cleaned `tests`
 * must (a) contain a real value comparison/assert call, with any type-only
 * check already stripped, AND (b) reference a name that is either directly
 * one of `calledFnNames` (the function(s) actually called anywhere in
 * `tests`) or a variable previously derived from such a call
 * (derivedResultVars) — closing both halves of the bug report: a comment/
 * string-manufactured `===` never reaches here at all (already blanked by
 * stripCommentsAndStrings before this runs), and a real-but-unbound
 * comparison like `1 === 1` sitting in its own statement fails condition
 * (b) because neither a called-function name nor a derived variable ever
 * appears in that statement.
 *
 * Known, accepted residual — NOT attempted in this pass: a `tests` value
 * whose only real assertion is made intentionally UNREACHABLE (inside a
 * function that is declared but never called, inside a try/catch that
 * swallows the exception a failed assert would throw, or after an early
 * `return`/`break` in the same block) still satisfies this check today,
 * because "does this text exist in a statement bound to the function under
 * test" says nothing about whether that statement's ENCLOSING control flow
 * ever actually executes it — proving that needs real control-flow
 * reachability analysis (or just running it and observing which lines
 * execute), not a regex over source text. Gate A (runWithTests) already
 * can't distinguish "ran and all assertions held" from "ran and asserted
 * nothing" for the identical structural reason (see this file's top-level
 * doc comment) — that is the root enabler this residual shares. Flagged for
 * a follow-up pass, not chased further here: closing it fully is a real
 * architecture change (per-statement coverage/execution tracing), not a
 * text-matching refinement like the rest of this file.
 */
function boundValueAssert(cleanTests, calledFnNames) {
  const derived = derivedResultVars(cleanTests, calledFnNames);
  const bindingNames = new Set([...calledFnNames, ...derived]);
  const bindingRe = bindingNames.size
    ? new RegExp('\\b(?:' + [...bindingNames].map(escapeRegExp).join('|') + ')\\b')
    : null;
  const statements = splitLogicalStatements(cleanTests);
  let hasTypeOnlyAssertAnywhere = false;
  for (const raw of statements) {
    if (/typeof\s|instanceof\s|Array\.isArray/.test(raw)) hasTypeOnlyAssertAnywhere = true;
    const stripped = stripTypeOnlyAsserts(raw);
    if (!HAS_VALUE_ASSERT_RE.test(stripped)) continue;
    if (bindingRe && bindingRe.test(raw)) return { ok: true, hasTypeOnlyAssertAnywhere };
  }
  return { ok: false, hasTypeOnlyAssertAnywhere };
}

module.exports = {
  contract: 'translation-equivalence-gated-pass',
  requires: [],

  verify(row, h) {
    const sourceCode = h.str(row, 'source_code');
    const sourceLanguage = h.str(row, 'source_language');
    const targetCode = h.str(row, 'target_code');
    const targetLanguage = h.str(row, 'target_language');
    const tests = h.str(row, 'tests');
    if (!sourceCode || !sourceLanguage || !targetCode || !targetLanguage || !tests) {
      return { passed: false, detail: { reason: 'missing source_code, source_language, target_code, target_language, or tests' } };
    }

    // Gate A — target_code + tests must actually pass, run in target_language.
    // Reduced from 20000: Gate B's syntaxCheck() runs sequentially right
    // after this in the same verify() -- at the prior values, the worst
    // case (this call, plus a compiled target_language's own compile-step
    // ceiling, plus Gate B's own then-25000ms-ceiling parse check) already
    // summed well past the outer sandbox command budget deployed at the
    // time (30000ms; raised to 120000ms as of the current deploy,
    // infra/terraform/ssm.tf). A submission-sized target_code
    // plus its tests is not remotely close to even this reduced value in
    // practice.
    const r = h.runWithTests(targetLanguage, targetCode, tests, 8000);
    if (r.unavailable) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: (r.runtime || targetLanguage) + ' not available in sandbox',
        detail: { sourceLanguage, targetLanguage, reason: 'runtime unavailable', runtime: r.runtime },
      };
    }
    const testsPass = r.ok === true;

    // Gate B — source_code must parse as its declared source_language.
    const srcParse = syntaxCheck(sourceLanguage, sourceCode, h);
    const langConsistent = srcParse.checked ? srcParse.ok === true : null;

    // Both Gate C and Gate D scan `tests`/`source_code` as raw text — every
    // such scan in this file is stripped of comments and string-literal
    // CONTENTS first (stripCommentsAndStrings, see its own doc comment for
    // exact scope/residuals), so an operator/identifier that only appears
    // inside a `//`/`#`/`/* *\/` comment or a string literal can no longer
    // manufacture a false match the way it could pre-round-2 (`// ===`,
    // `"a == b"`, `// old: sumValues(x)`). `targetCode`/`tests` as actually
    // EXECUTED by Gate A above are the raw, unstripped originals — stripping
    // is a detection-only concern and never touches what actually runs.
    const sourceClean = stripCommentsAndStrings(sourceCode);
    const targetClean = stripCommentsAndStrings(targetCode);
    const testsClean = stripCommentsAndStrings(tests);

    // Gate C — target_code must implement the SAME function as source_code.
    // Compared against what `tests` actually CALLS (the function Gate A just
    // proved target_code correctly satisfies), not against every name
    // target_code happens to declare — the latter sweeps in unrelated
    // helper/decoy functions that have nothing to do with what's actually
    // under test. A shared token must include at least one non-generic word.
    const srcNames = fnNames(sourceClean);
    const tgtNames = fnNames(targetClean);
    const testCallNames = calledNames(testsClean);
    const srcTok = new Set(srcNames.flatMap(tokens));
    const testCallTok = new Set([...testCallNames].flatMap(tokens));
    const nameCorresponds = srcTok.size && testCallTok.size ? hasMeaningfulOverlap(srcTok, testCallTok) : null;

    // Gate D — the test suite must assert on VALUES, not merely a type, must
    // contain a REAL assertion at all, and (round-2 hardening) that
    // assertion must be BOUND to a call to one of testCallNames (or a
    // variable derived from such a call) within the same logical statement
    // — see boundValueAssert's own doc comment for the exact bug this
    // closes (`sumValues([1, 2, 3]); 1 === 1;` used to pass: a real call and
    // a real `===` both existed in the file, just never in the same,
    // logically connected place) and its documented residual (assertions
    // made deliberately unreachable by dead code/swallowed exceptions are
    // NOT detected by this or any other gate here).
    const valueAssert = boundValueAssert(testsClean, testCallNames);
    const hasTypeOnlyAssert = valueAssert.hasTypeOnlyAssertAnywhere;
    const testIsDiscriminating = valueAssert.ok;

    const passed = testsPass && langConsistent !== false && nameCorresponds !== false && testIsDiscriminating;
    const rejectedBy = !testsPass
      ? 'tests'
      : langConsistent === false
      ? 'source_language mismatch'
      : nameCorresponds === false
      ? 'target implements a different function'
      : !testIsDiscriminating
      ? 'test asserts no real value (missing, type-only, or not bound to a call under test)'
      : null;

    return {
      passed,
      logs: passed ? '' : (rejectedBy || 'target_code failed one or more translation gates') + ': ' + String(r.stderr || '').slice(0, 300),
      detail: {
        sourceLanguage,
        targetLanguage,
        runtime: r.runtime,
        gate_testsPass: testsPass,
        gate_langConsistent: langConsistent,
        sourceParseChecked: srcParse.checked,
        sourceParseDiag: (srcParse.diag || srcParse.reason || '').slice(0, 200),
        gate_nameCorresponds: nameCorresponds,
        srcNames,
        tgtNames,
        testCallNames: [...testCallNames],
        gate_testIsDiscriminating: testIsDiscriminating,
        hasTypeOnlyAssert,
        rejectedBy,
        compileFailed: !!r.compileFailed,
        stderr: String(r.stderr || '').slice(0, 300),
      },
    };
  },
};
