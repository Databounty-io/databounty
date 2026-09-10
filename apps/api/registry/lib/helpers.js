/**
 * The helper API every harness receives, and the only implementation of it.
 *
 * This file is inlined into the script uploaded to the sandbox, so it must be
 * plain CommonJS with no imports beyond node builtins, and no backticks (the
 * loader embeds it inside a template literal).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'db-reg-'));
let _seq = 0;

/** A fresh scratch directory per call, so harness steps cannot collide. */
function workdir() {
  const d = path.join(ROOT, 'w' + _seq++);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Object.create(null) rather than {}: a plain object's inherited
// Object.prototype properties (toString, constructor, valueOf,
// hasOwnProperty, __proto__, ...) would make `cmd in _HAVE` true for any of
// those names WITHOUT ever having probed them, short-circuiting to a stale
// inherited (truthy, non-boolean) value instead of a real answer. No real
// binary is named that today, but a bare `{}` cache is one collision away
// from a silent wrong answer for free.
const _HAVE = Object.create(null);
const _CMD_NAME_RE = /^[A-Za-z0-9_.+-]+$/;
// Windows-only: PATHEXT is how the OS loader itself resolves a bare command
// name to a real file (git.exe, node.exe, ...) when spawning it. Irrelevant
// on the deployed sandbox (a Linux container; POSIX binaries carry no
// mandatory extension), but keeps this function meaningful when exercised
// outside that sandbox (e.g. local development on Windows) instead of
// silently reporting every real binary as absent.
const _HAVE_EXTS = process.platform === 'win32'
  ? (String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean))
  : [''];

/**
 * Is a binary on PATH? Cached.
 *
 * Resolves PATH directly via fs.accessSync rather than shelling out to
 * `command -v` (the previous implementation): that ran
 * execSync('command -v ' + cmd, ...), a shell command line built by string
 * concatenation. Safe today only because every call site in this registry
 * happens to pass a hardcoded literal or a value pulled from a fixed
 * lookup table (REQUIRED_BIN[eco] and similar), never a raw contributor
 * string -- but that is a property of the CALLERS, not of this function's
 * own signature, and nothing stops a future harness calling
 * h.have(h.str(row, 'something')) directly and reintroducing real shell
 * injection through the one function in this file that didn't already use
 * spawnSync's argv-array form the way run() does. Rewritten to never touch
 * a shell at all (no spawn of any kind for the probe itself), with a strict
 * allowlist regex kept as defense in depth on top of that: even a future
 * caller that passes unsanitized contributor input can only ever probe for
 * a plausible bare command name, never inject shell syntax.
 */
function have(cmd) {
  if (typeof cmd !== 'string' || !_CMD_NAME_RE.test(cmd)) return false;
  if (Object.prototype.hasOwnProperty.call(_HAVE, cmd)) return _HAVE[cmd];
  let found = false;
  try {
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    outer:
    for (let i = 0; i < dirs.length; i++) {
      for (let j = 0; j < _HAVE_EXTS.length; j++) {
        try {
          fs.accessSync(path.join(dirs[i], cmd + _HAVE_EXTS[j]), fs.constants.X_OK);
          found = true;
          break outer;
        } catch (e) { /* not in this PATH dir (or not executable) -- keep looking */ }
      }
    }
  } catch (e) { found = false; }
  _HAVE[cmd] = found;
  return found;
}

// 8000 was tuned purely as a report/log-bounding limit, not a technical
// constraint (maxBuffer below already allows 16MB) -- confirmed too small in
// practice: performance's harness hit a CRITICAL bug this session where a
// legitimately large JSON result value, printed via a single marker line,
// got truncated mid-value by this exact cap, breaking JSON.parse for a
// correct submission (fixed locally there by never sending the full value
// through stdout at all). Any OTHER category that prints a real,
// proportional-to-input-size structure via a marker line (network_protocol_fsm's
// observed transition sequence, log_parsing's contributor-defined result
// variables) is exposed to the identical silent-truncation false-FAIL, since
// cap() truncates the raw stdout BEFORE any caller ever parses a marker line
// out of it. Raised 4x as a shared, low-risk mitigation -- still bounded, far
// less likely to land mid-value for realistic structured output.
//
// This list of affected categories was incomplete: web_scraping,
// graphql_resolver, feature_flag, compression, i18n, auth_flow, and
// cryptographic_implementation all use the identical h.lastMarked(...) +
// h.jsonOf(...) pattern over run()'s capped stdout and are equally exposed.
// A LATER audit of this file found the same root cause inside helpers.js
// ITSELF: completedCleanly() below (the Java/Go/Rust/C/C++/C# exit-forgery
// guard) checks for EXIT_TRAP_MARKER -- printed as the LITERAL LAST
// statement of runWithTests's own synthesized entrypoint -- in this same
// capped stdout, so a legitimately verbose (>OUT_CAP) but cleanly-completed
// submission in any of those six languages had its own completion marker
// truncated away and was scored a false FAIL. That internal case is now
// fixed unconditionally: run()'s return value carries an uncapped
// `rawStdout`/`rawStderr` pair alongside the capped `stdout`/`stderr` (see
// run() below), and completedCleanly() reads the raw pair. The broader,
// harness-side h.lastMarked/h.jsonOf exposure above is NOT retrofitted here
// -- doing so means editing each of the ~10 affected harness.js files
// (swapping their own `h.run(...)`/`h.runCode(...)` result's `.stdout` for
// `.rawStdout` before calling h.lastMarked) and re-verifying each category
// against its own reference dataset, which is a wider, riskier, multi-file
// change than "contained to helpers.js" -- `rawStdout`/`rawStderr` are
// exposed on every run()/runCode()/runWithTests() result specifically so
// that migration can happen per-category, verified one at a time, rather
// than as one unverified blanket edit.
const OUT_CAP = 32000;
function cap(s) {
  s = String(s == null ? '' : s);
  return s.length > OUT_CAP ? s.slice(0, OUT_CAP) + '...[truncated]' : s;
}

// Cached (computed at most once per sandbox script execution): the REAL npm
// global module root, discovered via `npm root -g` rather than assumed.
// NODE_PATH below is hardcoded to /home/user/node_modules on the assumption
// that the template build's `cp -a "$(npm root -g)"/. /home/user/node_modules/`
// step (infra/e2b/databounty-verify/e2b.Dockerfile) actually ran and is present
// in whatever template is CURRENTLY published -- confirmed false on a live
// probe of the deployed template (2026-08-18): /home/user/node_modules does
// not exist at all, even though every baked npm package (graphql, cheerio,
// @graphql-tools/schema, jest, ...) IS genuinely present, just under npm's own
// global root instead (confirmed via `npm root -g` -> /usr/lib/node_modules in
// that same probe). Every category whose harness spawns a node CHILD process
// expecting to require() a baked npm package (web_scraping's cheerio,
// graphql_resolver's graphql, ...) was reporting a false runtimeUnavailable
// as a result -- the package was never actually missing from the image, only
// unreachable from a child spawned with the wrong NODE_PATH. Appending the
// real global root (discovered live, not a second hardcoded guess -- a
// hardcoded /usr/lib/node_modules would itself silently break the moment the
// base image or npm's own prefix convention changes) as a second NODE_PATH
// entry fixes this today AND keeps working once the template is rebuilt with
// the intended /home/user/node_modules copy in place (checked first, so nothing
// changes for the case this was originally written for).
let _globalNodeModulesRoot;
function globalNodeModulesRoot() {
  if (_globalNodeModulesRoot !== undefined) return _globalNodeModulesRoot;
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 3000 });
    _globalNodeModulesRoot = (r.status === 0 && r.stdout) ? r.stdout.trim() : null;
  } catch (e) {
    _globalNodeModulesRoot = null;
  }
  return _globalNodeModulesRoot;
}

/**
 * Run a command with a hard timeout. Never throws; a failure is data.
 *
 * PYTHONHASHSEED is pinned because Python salts hash() per process, which makes
 * any hash-bucketed result unreproducible between runs.
 */
function run(cmd, args, opts) {
  opts = opts || {};
  const r = spawnSync(cmd, args || [], {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    // Several category harnesses call run() with no opts.timeoutMs at all
    // (a quick "import X"/"require(X)" availability probe, or a short
    // deliberate sleep) and silently inherited whatever this fell back to.
    // At the prior 25000ms, a handful of these unguarded calls -- combined
    // with a category's OWN, deliberately-tuned per-call timeouts elsewhere
    // in the same verify() -- could already sum past the outer sandbox
    // command budget deployed at the time (30000ms; raised to 120000ms as
    // of the current deploy, infra/terraform/ssm.tf's
    // EXECUTION_RUNNER_TIMEOUT_MS), the exact class of gap independently
    // found and fixed for individual categories throughout this registry's
    // audit (web_scraping, websocket_realtime, terminal_cli, ...). No
    // caller anywhere in this registry currently relies on getting more
    // than a few seconds from an UNSPECIFIED timeout -- every call that
    // legitimately needs longer already passes its own explicit
    // opts.timeoutMs. Lowering this shared fallback protects every call
    // site that forgets to (or hasn't yet been audited to) set one, not
    // just the ones already found.
    timeout: opts.timeoutMs || 8000,
    maxBuffer: 16 * 1024 * 1024,
    input: opts.input,
    // E2B strips NODE_PATH from the sandbox process. The verified template's
    // INTENDED layout puts baked Node dependencies (GraphQL, cheerio, XML
    // parsers, …) under /home/user/node_modules for exactly this reason,
    // while harness children correctly run inside isolated scratch
    // directories -- but the path list here also appends the real npm
    // global root (globalNodeModulesRoot() above), discovered live rather
    // than assumed, since the CURRENTLY published template does not actually
    // have /home/user/node_modules populated (see that function's comment).
    // Both are trusted image paths already baked in at template-build time;
    // never install or fetch dependencies at validation time.
    //
    // TZ is pinned for the exact same reason PYTHONHASHSEED is: Intl/Date
    // formatting is just as environment-sensitive as Python's per-process
    // hash salt, and nothing about the base image's default timezone was
    // ever verified. Confirmed empirically: several real i18n reference
    // rows (date/time formatting) flip from passing to failing purely from
    // changing this process's TZ, with no change to the row or the code
    // being verified -- e.g. a 3:30 PM UTC timestamp formats as "9:00 PM"
    // under IST and is scored a false FAIL against a row whose expected
    // output was authored assuming UTC.
    //
    // PYTHONUTF8 is pinned for the same reason again: plain open() with no
    // encoding= falls back to locale.getpreferredencoding(), which on a
    // non-UTF-8-locale host silently mis-decodes non-ASCII text -- including
    // PY_DRIVER's OWN open(_cr_path) read of the submission source file
    // itself (see PY_DRIVER below), corrupting any non-ASCII literal
    // (accented names, non-English comments/strings) in a submission BEFORE
    // it ever runs. Confirmed empirically on a non-UTF-8-locale host: a
    // submission comparing a hardcoded accented string literal against
    // separately UTF-8-decoded input silently stopped matching, purely from
    // the submission file's own text being corrupted on read -- a false
    // FAIL against a submission with no actual bug. PYTHONUTF8=1 forces
    // Python's UTF-8 mode (PEP 540), making UTF-8 open()'s default
    // regardless of locale.
    env: Object.assign({}, process.env, {
      PYTHONHASHSEED: '0',
      TZ: 'UTC',
      PYTHONUTF8: '1',
      HOME: ROOT,
      NODE_PATH: ['/home/user/node_modules', globalNodeModulesRoot()].filter(Boolean).join(path.delimiter),
    }, opts.env || {}),
  });
  const rawStdout = String(r.stdout == null ? '' : r.stdout);
  const rawStderr = String((r.stderr || '') + (r.error ? ' ' + r.error.message : ''));
  return {
    status: r.status,
    timedOut: r.signal === 'SIGTERM' || (r.error && r.error.code === 'ETIMEDOUT'),
    stdout: cap(rawStdout),
    stderr: cap(rawStderr),
    // Uncapped counterparts, for marker/exit-code detection that must not
    // be fooled by OUT_CAP's truncation -- see cap()'s own doc comment on
    // the truncation risk. completedCleanly() below reads THESE, not the
    // capped `stdout`, so a legitimately verbose (but correctly completed)
    // compiled-language submission can't have its own exit-trap marker
    // truncated away and misread as a forged/early exit. Still bounded by
    // spawnSync's maxBuffer (16MB) above -- this is not an unbounded value,
    // just not re-truncated a second time down to the much smaller
    // report-bounding OUT_CAP. Purely additive (existing `stdout`/`stderr`
    // consumers are unaffected): a harness doing its own marker extraction
    // (h.lastMarked/h.jsonOf) may read r.rawStdout the same way instead of
    // the capped r.stdout for the identical reason, though existing harness
    // call sites written against the capped field remain exposed to the
    // OUT_CAP truncation risk until individually migrated -- that broader,
    // multi-file migration was judged out of scope for this pass (see
    // OUT_CAP's own comment above), while the marker check newly added
    // inside THIS file (completedCleanly) is fixed unconditionally.
    rawStdout,
    rawStderr,
  };
}

/**
 * Normalize loosely-formatted output before comparison.
 *
 * Different languages render the same value differently — brackets, quote style,
 * True vs true — and ICU output uses non-breaking spaces that look identical in a
 * diff. Comparing raw strings reports those as wrong answers.
 */
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/ /g, ' ')
    // [] only, not (): stripping both let a Python tuple-repr string like
    // "(1, 2, 3)" compare equal to a JSON array "[1, 2, 3]" even though the
    // former isn't valid JSON and violates a "return JSON" contract -- a
    // real wrong-output-format bug, not mere notation.
    .replace(/[[\]]/g, '')
    .replace(/'/g, '"')
    .replace(/,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .trim()
    .toLowerCase();
}
function looseEqual(a, b) { return norm(a) === norm(b); }

/** Order-independent deep form, so key order is not a difference. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}

/** Parse if it parses, else null. Used where a field may be JSON or prose. */
function jsonOf(s) {
  try { return JSON.parse(String(s)); } catch (e) { return null; }
}

/** Read the last line carrying a marker prefix, e.g. '@@OUT '. */
function lastMarked(stdout, marker) {
  const lines = String(stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf(marker) === 0) return lines[i].slice(marker.length);
  }
  return null;
}

/** Field value as a string, tolerating null/number/boolean. */
function str(row, key) {
  const v = row ? row[key] : undefined;
  if (typeof v === 'string') return v;
  if (v == null) return '';
  // Row ingestion (src/routes/v1/batches.ts, bounties.ts) validates a
  // submitted item's fields only as z.record(z.unknown()) -- individual
  // field VALUES are never required to be strings. Plain String(v) silently
  // destroys information for an array/object value here: String([1,2,3]) is
  // "1,2,3" (loses the array shape entirely) and String({a:1}) is
  // "[object Object]" (loses the content entirely) -- a code/tests field
  // supplied as a native JSON array/object rather than a pre-stringified
  // one would corrupt into unusable text before ever reaching a compiler or
  // comparison. data_transformation's own harness already discovered and
  // worked around this exact trap locally (see its own jsonText() helper);
  // JSON.stringify preserves the value's real shape for the same non-string
  // cases instead.
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
  return String(v);
}

/**
 * Field value as a string array. Text editors submit list fields as one
 * newline-delimited string, while API clients may submit a real array; both
 * encode the same logical contract. Preserve blank entries deliberately: an
 * empty string can be a meaningful test case (for example, a regex that must
 * match the empty string).
 */
function list(row, key) {
  const v = row ? row[key] : undefined;
  // Same fix as str() above, applied per element: row ingestion never
  // guarantees a `list`-role field's elements are actually strings (only
  // z.record(z.unknown()) is enforced), so a naive String(x) on an
  // object/array element would silently destroy it the same way String(v)
  // used to for str() (String({a:1}) -> "[object Object]", losing the
  // content entirely). No current caller feeds this a non-string element,
  // but nothing guarantees a future one won't.
  if (Array.isArray(v)) return v.map(function (x) {
    if (x != null && typeof x === 'object') { try { return JSON.stringify(x); } catch (e) { return String(x); } }
    return String(x);
  });
  // A plain string value is split one-per-line (the schema's own authoring
  // convention for `role: "list"` fields) -- a caller needing a literal
  // newline inside a single test case should submit a real JSON array
  // instead, which the branch above still handles safely.
  if (typeof v === 'string' && v) return v.split(/\r\n|\n|\r/);
  return [];
}

// ------------------------------------------------- multi-language runtime ---
// Ported from scratch/catrun/driver.ts (the standalone test-harness runner),
// where each of these traps was found and fixed against real reference-dataset
// rows before this port: JVM assertions off by default (needs -ea), C#
// Debug.Assert compiled out unless DEBUG is defined (and even then only
// notifies trace listeners, never throws), Node's console.assert not
// throwing, Go/Java/Rust/C/C++ tests being bare statements that are not legal
// at the top level of a source file and must be wrapped in an entrypoint.
// Reused rather than re-derived: this is the same logic already proven at
// scale against the labelled reference datasets.

function normLang(l) {
  const s = String(l || '').trim().toLowerCase();
  if (['py', 'python', 'python3'].includes(s)) return 'python';
  if (['js', 'javascript', 'node', 'jsx'].includes(s)) return 'javascript';
  if (['ts', 'typescript', 'tsx'].includes(s)) return 'typescript';
  if (['java'].includes(s)) return 'java';
  if (['go', 'golang'].includes(s)) return 'go';
  if (['rust', 'rs'].includes(s)) return 'rust';
  if (['c++', 'cpp', 'cxx'].includes(s)) return 'cpp';
  if (['c'].includes(s)) return 'c';
  if (['ruby', 'rb'].includes(s)) return 'ruby';
  if (['php'].includes(s)) return 'php';
  if (['c#', 'csharp', 'cs'].includes(s)) return 'csharp';
  return s || 'unknown';
}

// JS assertion hardening. Node's console.assert does NOT throw — it only
// logs. A dataset test written as console.assert(false) would otherwise exit
// 0 and be scored as a PASS. Override it to throw so a failed assertion is a
// real failure, and expose assert globally since datasets use
// assert.deepStrictEqual. Assigned onto globalThis rather than declared with
// const: several items declare their own "const assert = require('assert')",
// and a second const in the same scope is a SyntaxError that fails the item
// before its tests even run.
var JS_PRELUDE = [
  // Freezing the MODULE OBJECT (not just the globalThis.assert binding) is
  // load-bearing: require('assert') always returns the SAME cached object,
  // so re-running "globalThis.assert = require('assert')" later (the
  // re-arm in runWithTests below) does not undo a submission mutating that
  // object's OWN methods (assert.strictEqual = noop, etc.) -- reassigning
  // the variable to point at the still-mutated object changes nothing.
  // Freezing it here, before any submission code runs, makes every later
  // attempt to overwrite assert.strictEqual/deepStrictEqual/ok a silent
  // no-op in sloppy mode (or a thrown TypeError in strict mode -- either
  // way the attack fails, since a thrown exception crashes the submission
  // non-zero just as surely as a caught assertion failure would).
  "Object.freeze(require('assert'));",
  "globalThis.assert = globalThis.assert || require('assert');",
  "console.assert = function (c) { if (!c) { throw new Error('console.assert failed: ' + Array.prototype.slice.call(arguments,1).join(' ')); } };",
  // runWithTests/runCode always run submission code and its own tests in
  // ONE process, tests appended AFTER the submission's code. A submission
  // that calls process.exit() before its tests ever run can otherwise
  // dictate the whole exit code unilaterally -- a fabricated 0 (forged
  // pass) or an early 1 that skips real assertions entirely. No submission
  // in any category consuming this prelude is a CLI program that legitimately
  // needs to call process.exit() itself, so trapping it outright is safe.
  "process.exit = function (c) { throw new Error('process.exit(' + c + ') called -- forbidden inside submission code'); };",
  'process.reallyExit = process.exit;',
].join('\n');

// Python equivalent of JS_PRELUDE's process.exit trap. Same shared process,
// same rationale: submission code that calls sys.exit()/exit()/os._exit()
// before an appended print/tests segment ever runs can otherwise dictate the
// whole exit code and stdout unilaterally. Raising (not silently swallowing)
// means code that catches the exception can still continue past it; code
// that doesn't crashes non-zero, which is the correct outcome either way.
var PY_PRELUDE = [
  'import sys as _cr_sys, os as _cr_os, builtins as _cr_builtins',
  'def _cr_exit_blocked(*_cr_a, **_cr_k):',
  '    raise RuntimeError("exit() call blocked -- forbidden inside submission code")',
  '_cr_sys.exit = _cr_exit_blocked',
  '_cr_os._exit = _cr_exit_blocked',
  '_cr_os.abort = _cr_exit_blocked',
  '_cr_builtins.exit = _cr_exit_blocked',
  '_cr_builtins.quit = _cr_exit_blocked',
].join('\n');

// Known, accepted residual: `import ctypes; ctypes.CDLL(None)._exit(0)` (or
// the Windows-equivalent kernel32.ExitProcess, or `os.kill(os.getpid(),
// signal.SIGKILL)`) terminates the OS process directly via a raw syscall,
// bypassing every Python-level name this prelude can monkeypatch and the
// PY_DRIVER try/except below (which only catches a Python *exception*, not
// a process-level kill). Confirmed working against this exact prelude+driver.
// Closing this fully would need the tests segment's completion to be
// verified from OUTSIDE the process it might kill (e.g. a sentinel file
// written only after `tests` finishes, checked by the caller regardless of
// exit status) -- a real architecture change to runCode's return contract,
// not a monkeypatch, and one a sufficiently determined submission could
// still race by reading its own source to fake the same sentinel before
// self-terminating. `ctypes`/`os.kill`/raw-syscall self-termination is
// exotic compared to the ordinary "submission writes a complete program"
// idiom the C/C++/Rust/Go fixes above address, and this residual matches
// the same class already accepted for os._exit()-style bypasses in other
// harnesses this registry (compression, competitive_programming,
// git_merge_resolution) -- flagged here for awareness, not chased further.

// sys.exit()/os._exit()/etc are just ordinary function calls PY_PRELUDE can
// wrap -- but CPython's sys.exit() is ITSELF only `raise SystemExit(code)`,
// and patching the sys.exit FUNCTION does nothing to stop submission code
// from raising SystemExit directly (`raise SystemExit(0)`), which the
// interpreter still handles specially and exits cleanly with. Confirmed
// exploitable through PY_PRELUDE alone. Closed structurally: the actual
// submission+tests source is exec()'d inside an outer driver's own
// try/except SystemExit, so ANY path to that exception -- however raised,
// at any call depth -- is caught before it can silently exit the process.
// `_cr_real_exit` is captured as a direct reference to the real os._exit
// BEFORE exec() ever runs, so even if the submission reassigns os._exit (a
// module attribute PY_PRELUDE's own trap also lives on) afterward, this
// driver's own recovery exit still terminates for real -- os._exit is a raw
// syscall that bypasses Python-level interception entirely (including its
// own try/except), so it's also the only reliable way for the DRIVER's own
// exit to survive a submission that maliciously neuters sys.exit further.
var PY_DRIVER = [
  'import sys as _cr_d_sys, os as _cr_d_os',
  '_cr_real_exit = _cr_d_os._exit',
  '_cr_path = _cr_d_sys.argv[1]',
  'with open(_cr_path) as _cr_f:',
  '    _cr_src = _cr_f.read()',
  'try:',
  '    exec(compile(_cr_src, _cr_path, "exec"), {"__name__": "__main__"})',
  'except SystemExit as _cr_e:',
  '    _cr_d_sys.stderr.write("SystemExit(%r) raised -- forbidden inside submission code\\n" % (_cr_e.code,))',
  '    try: _cr_d_sys.stdout.flush()',
  '    except Exception: pass',
  '    try: _cr_d_sys.stderr.flush()',
  '    except Exception: pass',
  '    _cr_real_exit(1)',
].join('\n');

/**
 * Strip trailing/whole-line '#'/'//' comments AND blank out string-literal
 * CONTENTS before language-shape detection, quote-aware throughout. C/C++
 * preprocessor directives (#include, #define, ...) are preserved verbatim
 * -- inferLang's own C/C++ branch keys off `#include` at line start, so
 * this must never strip that line to nothing.
 *
 * Comments: a single common English word inside a comment (e.g. "# impl
 * detail" -- ordinary prose, not Rust) used to be enough to flip the whole
 * detection to the wrong language, because several branches key off single,
 * weak keyword matches (`\bimpl\b` for Rust, `\bnil\b` for Go) with no
 * regard for whether that token is live code or prose.
 *
 * String literals: the SAME risk applies to a word inside an ordinary
 * string/log-message argument ("raise ValueError('field must not be nil')"
 * -- genuine, unremarkable Python -- misdetected as Go purely because "nil"
 * appeared inside the string). Quote characters themselves are preserved
 * (some branches, e.g. Python's bare "'...'"-without-JS-keywords fallback,
 * key off the presence of a quoted string as a shape signal) -- only the
 * text BETWEEN them is blanked.
 *
 * Quote-close detection uses a backslash-RUN parity check, not a single
 * character lookback: the original `line[i - 1] !== '\\'` treats a string
 * ending in an ESCAPED backslash (e.g. the Windows path literal "C:\\") as
 * the closing quote being itself escaped (looking back one char lands on
 * the second '\\'), so the string is wrongly considered still-open for the
 * rest of the line -- masking real, live code after it as if it were still
 * string content. Confirmed: `var p = "C:\\"; if nil { return }` used to
 * strip to `var p = "                        ` (the trailing `if nil {
 * return }`, a real Go signal, silently erased). Counting a contiguous run
 * of backslashes and checking its PARITY (even = the quote is not escaped,
 * odd = it is) is the standard, correct rule.
 *
 * Quote state persists across a newline ONLY for a still-open backtick:
 * JS/TS template literals are the one quote syntax among the languages this
 * function supports that legitimately spans multiple physical lines (a
 * single/double-quoted string cannot, absent an explicit line-continuation
 * this function does not attempt to model). Resetting quote state at every
 * newline regardless of which quote character was open used to re-expose
 * exactly the false-keyword-match failure mode this whole function exists
 * to close, but only for multi-line template literals: only the FIRST line
 * of a still-open backtick string had its content blanked; every
 * continuation line was treated as live code. Confirmed:
 *   const msg = `Diagnostic dump:
 *   def compute(value):
 *       return value * 2
 *   `;
 *   export function run(x) { return x + 1; }
 * used to infer 'python' for this entirely correct JS/TS function, purely
 * from example text inside a diagnostic string. Single/double-quote state
 * deliberately still resets every line: unlike backticks, an apparently
 * still-open '/" at end of line is far more likely to be a genuinely
 * malformed/incomplete code fragment (not unusual in this registry's
 * intentionally-buggy dataset fixtures) than a real multi-line construct --
 * letting THAT persist across the whole rest of the file on a single stray
 * quote would blank out every language signal after it, a worse failure
 * than the multi-line-backtick gap being fixed here.
 *
 * Known residual, not attempted here: this function only recognizes '#'
 * and '//' LINE comments, not '/* ... *\/' BLOCK comments (C/C++/Java/C#/
 * JS/TS all support the latter). A block comment containing a stray
 * language keyword (e.g. a Javadoc-style "/** This class of algorithm...
 * *\/" above a bare method) is not stripped and can still influence
 * detection the same way an unstripped line comment used to. Closing that
 * fully needs the same kind of cross-line state this fix already added for
 * backticks (tracking "currently inside a block comment" across lines,
 * with its own start/end token pair) -- deferred as a separate, focused
 * change rather than folded into this same edit.
 */
var CPP_DIRECTIVE_RE = /^\s*#\s*(include|define|ifdef|ifndef|endif|pragma|if|else|elif|undef|error)\b/;
function stripLineCommentsForLangDetect(code) {
  var lines = String(code).split('\n');
  var out = [];
  // Persists across the outer loop's iterations (declared OUTSIDE the
  // per-line body) so a still-open backtick correctly carries into the
  // next line -- see the multi-line-template-literal note above.
  var quote = null;
  var backslashRun = 0;
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    // A CPP directive can only start a genuinely fresh line, never a line
    // that's really still inside a string left open from a previous line.
    if (quote === null && CPP_DIRECTIVE_RE.test(line)) { out.push(line); continue; }
    var buf = '';
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (quote) {
        if (ch === '\\') { backslashRun++; buf += ' '; continue; }
        if (ch === quote && backslashRun % 2 === 0) {
          quote = null;
          backslashRun = 0;
          buf += ch;
        } else {
          backslashRun = 0;
          buf += ' ';
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; backslashRun = 0; buf += ch; continue; }
      if (ch === '#') { break; }
      if (ch === '/' && line[i + 1] === '/') { break; }
      buf += ch;
    }
    out.push(buf);
    // Single/double-quote state never survives a newline (see doc comment
    // above); a still-open backtick does.
    if (quote === "'" || quote === '"') { quote = null; backslashRun = 0; }
  }
  return out.join('\n');
}

/**
 * Infer a language from code shape, for datasets that ship no 'language'
 * field. Ordered most-distinctive first: a weak heuristic that defaults
 * everything to Python makes Java/Go/Rust/C items fail with a SyntaxError,
 * which reads as a broken submission rather than a misrouted harness.
 *
 * Comments are stripped before any check runs: a single common English word
 * inside a comment (e.g. "# impl detail" -- ordinary prose, not Rust) used
 * to be enough to flip the whole detection to the wrong language, because
 * several branches key off single, weak keyword matches (`\bimpl\b` for
 * Rust chief among them) with no regard for whether that token is live code
 * or prose.
 *
 * hasStrongJsSignal gates the two branches below (PHP, C#) whose only
 * GENERIC-token signal collides with completely ordinary JS/TS code, the
 * same shape of fix already applied to Go's `:=`/hasStrongPythonSignal
 * pair further down: the branch's OWN unambiguous signals (<?php, ->,
 * LINQ method names, Console.Write, Dictionary<, using System, ...) are
 * left ungated and still match immediately; only the generic-token
 * fallback is suppressed when a concrete JS/TS shape is also present.
 * Confirmed real, not hypothetical:
 *   - PHP's third alternative used to fire on ANY `$identifier` (a legal
 *     JS identifier -- jQuery/Angular-style `$el`/`$scope` is ordinary JS)
 *     combined with a bare `=>` ANYWHERE (near-ubiquitous in modern JS via
 *     arrow functions), e.g. `const $btn = ...; $btn.on('click', () => {
 *     ... });` used to infer 'php' for this correct JS.
 *   - C#'s `\bvar\s+\w+\s*=` collides with plain old-style JS `var` (still
 *     completely valid, common in un-modernized/generated code), e.g.
 *     `var result = data.filter(x => x > 0); console.log(result);` used to
 *     infer 'csharp' for this correct JS.
 * `->` is NOT gated for PHP (JS has no `->` operator at all, no collision
 * exists); only the `=>` alternative is, since `=>` is PHP's own array/
 * match-arm/short-arrow-function token AND JS's arrow-function token.
 */
function inferLang(code) {
  var original = String(code == null ? '' : code);
  var c = stripLineCommentsForLangDetect(original);
  // Deliberately narrow and NOT PHP/C#-valid: `let`/`const` are absent from
  // PHP entirely (well, PHP does allow top-level `const NAME = ...` but not
  // `let`, so `let` alone is PHP-safe; `const` is intentionally excluded
  // below since it collides with genuine PHP/C# local consts), a block-
  // bodied arrow (`=> {`) is not valid PHP (PHP 7.4+ arrow functions are
  // single-EXPRESSION only, no `{ }` body), `${` inside a backtick string
  // is JS/TS-only template interpolation (PHP backticks are shell_exec,
  // no interpolation), and module.exports/ESM export syntax has no PHP or
  // bare-C# equivalent.
  var hasStrongJsSignal = /\blet\s+\w+\s*=|=>\s*\{|`[^`]*\$\{|\bconsole\.(log|error|warn|info|debug)\s*\(|\bmodule\.exports\b|\bexport\s+(default\s+)?(function|class|const|let|async\s+function)\b/.test(c);
  if (/<\?php/.test(c) || /function\s+\w+\s*\([^)]*\$/.test(c) || (/\$\w+/.test(c) && /->/.test(c)) || (/\$\w+/.test(c) && /=>/.test(c) && !hasStrongJsSignal)) return 'php';
  if (/\bdef\s+\w+[^\n:]*\n[\s\S]*\bend\b/.test(c) || /\braise\s+.+\bunless\b|\bputs\b|\bnil\?|\.each\s+do\b/.test(c)) return 'ruby';
  // Confirmed against a real E2B run (fail_to_pass, New_Tester): 11 of 100
  // rows' buggy_code fell through to 'unknown' (-> runtimeUnavailable,
  // routed to human review instead of getting a real verdict) purely
  // because this entry gate required one of #include/char*/printf(/malloc(
  // before even trying the C/C++ branch -- but this dataset's own bare,
  // include-less function-snippet convention (documented in fail_to_pass's
  // own harness.js: "Java/C#/C++ method signatures use none of
  // def/function/fn/func/class -- they're bare NAME(args) {") never
  // produces any of those four signals for a C++ snippet that only uses STL
  // containers/iterators, e.g. `vector<string> check(vector<string> v) {
  // sort(v.begin(), v.end()); ... }` with no #include line at all. Added
  // `vector\s*<` (already used below to pick cpp over c, just never in the
  // GATE that decides whether to enter this branch at all) plus `.rbegin(`/
  // `.rend(` (STL-exclusive iterator methods, not present in any other
  // language this function supports) fixed 6 of the 11 confirmed rows.
  // A 7th row (`int check(int values[], int n) {...}`) had no STL token at
  // all, but IS unambiguous C-family array-parameter syntax -- `TYPE name[]`
  // (brackets AFTER the identifier) is how C/C++ declares an array
  // parameter; Java/C# spell the identical thing `TYPE[] name` (brackets
  // right after the type), so this shape has no collision risk with them.
  // The remaining 4 rows (e.g. `bool check(int year) { return year % 4 ===
  // 0; }`) have literally zero language-specific tokens of any kind and are
  // an accepted, honestly-irreducible residual -- forcing a guess for them
  // risks a wrong compiler choice (this exact snippet uses bare `bool`,
  // which is not a C keyword pre-stdbool.h and would be a spurious compile
  // error if guessed as 'c'), which is worse than the current honest
  // runtimeUnavailable.
  if (/^\s*#include|\bchar\s*\*|\bprintf\s*\(|\bmalloc\s*\(|\bvector\s*<|\.rbegin\s*\(|\.rend\s*\(|[A-Za-z_]\w*\s+[A-Za-z_]\w*\s*\[\s*\]/m.test(c)) {
    return /\bstd::|\bcout\b|\btemplate\s*<|\bnew\s+\w+\s*[\[\(]|\bdelete\s+|using\s+namespace\s+std|\bvector\s*<|\.rbegin\s*\(|\.rend\s*\(/.test(c) ? 'cpp' : 'c';
  }
  if (/\bfn\s+\w+.*->|\blet\s+mut\b|assert_eq!|\bimpl\b|&\[|\bVec<|\bOption</.test(c)) return 'rust';
  // Python's walrus operator (`:=`, valid syntax since 3.8) is textually
  // identical to Go's declare-and-assign token -- bare `:=` alone is not a
  // reliable Go signal. Only accept it as one when no strong, unambiguous
  // Python signal is also present; the other Go alternatives (func/package
  // main/[]T{/nil) have no such collision.
  //
  // def/import/self. alone missed a real, demonstrated shape: a short
  // walrus snippet with none of those three (`result = [y := x**2 for x in
  // range(10)]`, or a bare `while (chunk := f.read(n)):` loop guard) --
  // confirmed misdetected as Go without the additional signals below.
  // Comprehension syntax (`[... for ... in ...]`), a control-flow header
  // ending in a bare colon (Go's if/for never do -- Go uses braces), and
  // `is not`/`not in` are all unambiguously Python-only, so adding them
  // only ever SUPPRESSES a walrus-driven Go guess; it can never itself
  // cause a genuine Go snippet (which still trips func/package main/[]T{/nil
  // independently of this flag) to stop matching.
  var hasStrongPythonSignal = /\bdef\s+\w+\s*\(|^\s*(import|from)\s+\w+|\bself\.|\b(if|while|for)\b[^\n]*:\s*$|\bis\s+not\b|\bnot\s+in\b|\[[^[\]]*\bfor\b[^[\]]*\bin\b[^[\]]*\]/m.test(c);
  if (/\bfunc\s+\w+|\bpackage\s+main\b|\[\]\w+\{|\bnil\b/.test(c) || (/:=/.test(c) && !hasStrongPythonSignal)) return 'go';
  // Confirmed against a real E2B run (fail_to_pass, New_Tester): 5 genuinely
  // C# rows (their OWN `generated_test` uses `Debug.Assert(...)`, a .NET-only
  // idiom -- Java has no such class) were misclassified as 'java' instead,
  // because h.inferLang is only ever given `buggy_code` (never the test that
  // carries the one unambiguous signal) and this dataset's C# rows are
  // written in the exact same bare `public static TYPE Name(args) { ... }`
  // shape Java also uses -- none of the LINQ/Console/Dictionary/`List<T> x =
  // new` signals already checked for above appear in a body that short. Two
  // additional signals close this, each verified C#-exclusive against every
  // OTHER language this function supports: (1) `Math.Min`/`Math.Max`/etc --
  // .NET's PascalCase Math methods; Java's equivalents are always lowercase
  // (`Math.min`/`Math.max`). (2) `foreach` -- C#'s statement keyword; Java
  // has no such keyword (only `for (T x : xs)`, colon-based). PHP also has
  // `foreach`, but PHP requires `$`-sigiled variables for anything it does,
  // which its own earlier-checked branch (line ~594) already catches first.
  //
  // A THIRD candidate signal -- bare `bool` (C#'s keyword; Java only has
  // `boolean`) -- was tried and reverted: confirmed too broad, because C++
  // ALSO spells its boolean type `bool` (unlike Go/Rust, C++ has no mandatory
  // per-function keyword like `func`/`fn` that an earlier branch would catch
  // first). This dataset's OWN OTHER rows proved the collision is real, not
  // hypothetical: two rows (`bool check(int year) { return year % 4 == 0; }`,
  // no access modifier, lowercase name -- the SAME bare-C/C++ convention this
  // dataset's genuine C++ rows use elsewhere, confirmed by their own
  // generated_test using bare `assert(...)`, never `Debug.Assert`) were
  // wrongly swept into 'csharp' by a standalone `bool` check. The 5 genuine
  // C# rows are reliably distinguished from those instead by ALSO requiring
  // the access-modifier prefix this dataset's C#/Java rows (but never its
  // bare-style C/C++ rows) always carry: `public/private/protected static
  // bool Name(`.
  if (/\.(OrderBy|OrderByDescending|ToList|ToArray|Select|Where|FirstOrDefault|Any|Count)\s*\(|\bConsole\.(Write|WriteLine)|\bstring\[\]|\busing\s+System\b|\bDictionary<|\bList<\w+>\s*\w+\s*=\s*new\b|\bMath\.(Min|Max|Abs|Round|Floor|Ceiling|Pow|Sqrt|Truncate)\s*\(|\bforeach\s*\(|\b(?:public|private|protected)\s+(?:static\s+)?bool\s+\w+\s*\(/.test(c) || (/\bvar\s+\w+\s*=/.test(c) && !hasStrongJsSignal)) return 'csharp';
  if (/\b(public|private|protected)\s+(static\s+)?[\w<>\[\],\s]+\s+\w+\s*\(|\bList<|\bString\[\]|\bSystem\.out\b|\bnew\s+\w+<>/.test(c)) return 'java';
  if (/\bdef\s+\w+\s*\(.*\)\s*:|^\s*(import|from)\s+\w+|\bself\b|\bprint\s*\(/m.test(c)) return 'python';
  if (/\bfunction\s|\=>|\bconst\s|\blet\s|\bvar\s|console\./.test(c)) return /:\s*(string|number|boolean|any)\b|\binterface\s+\w+/.test(c) ? 'typescript' : 'javascript';
  if (/\bdef\s+\w+\s*\(/.test(c)) return 'python';
  if (/\{\s*'[^']+'\s*:|\b(True|False|None)\b/.test(c)) return 'python';
  if (/'[^']*'/.test(c) && !/\b(const|let|var|function)\b|=>/.test(c)) return 'python';
  // Checked against the ORIGINAL, unstripped source: stripLineCommentsForLangDetect
  // removes the '#' along with the rest of the comment it introduces, so
  // testing for '#' against the stripped text `c` can never be true for
  // exactly the shape this fallback exists to catch (a bare
  // "CONST = literal  # comment" line with no other distinguishing keyword)
  // -- checked against `c` this branch was unreachable dead code.
  if (/^\s*[A-Za-z_]\w*\s*=/m.test(c) && /#/.test(original) && !/\b(const|let|var|function)\b|=>|\/\//.test(c)) return 'python';
  // Confirmed against a real E2B run (fail_to_pass, New_Tester): a bare C++
  // clamp function -- `int check(...) { return minInt(low, maxInt(high,
  // value)); }`, with a ternary elsewhere in the same file (`a > b ? a : b`)
  // and no #include/vector</etc to trip the C/C++ branch earlier -- fell all
  // the way down to this LAST-RESORT fallback and was misclassified as
  // 'javascript' purely because it has a `{`, a `:` (the ternary's, not an
  // object literal's), and a `}` somewhere in the text. Run through node as
  // a result, it's an immediate SyntaxError -- not an honest "can't tell"
  // (unknown/runtimeUnavailable), an actively WRONG guess that then reports
  // a misleading verdict. A C++ range-based for-loop's own colon (`for (int
  // v : values)`) trips the identical false-positive, confirmed separately
  // in the same run. Both are ordinary C-family constructs, not evidence of
  // a JS/TS object literal -- the one shape this fallback exists to catch.
  // Stripped from a WORKING COPY only (never mutates `c`, which nothing
  // after this line still reads, but kept separate on principle) before the
  // check: a ternary's `? ... :` (bounded so it can't cross a `{`/`}`/`;`
  // into an unrelated statement -- `cond ? {a:1} : {b:2}` still correctly
  // matches via the object literals' OWN colons, since the stripped region
  // stops at the first `{`) and a range-based for-loop's `for (... : ...)`
  // header.
  var cForJsObjectFallback = c
    .replace(/\?[^:{};]*:/g, '?')
    .replace(/\bfor\s*\([^)]*:[^)]*\)/g, 'for(;;)');
  if (/\{[\s\S]*:[\s\S]*\}/.test(cForJsObjectFallback)) return 'javascript';
  return 'unknown';
}

var _NODE_TC = null;
/**
 * Resolve the TypeScript toolchain from the IMAGE. Never installs.
 *
 * Sandbox execution is no-network by design, so a missing toolchain is not
 * something a harness may fix at runtime by reaching a package registry. Both
 * binaries are baked into the verified image (see
 * infra/e2b/databounty-verify/e2b.Dockerfile, which installs typescript@5 and
 * tsx@4 globally and fails the build if either is absent from PATH), so absence
 * here means the sandbox is not the verified image — a environment fault to
 * surface, not to paper over.
 *
 * Returning nulls makes the caller report `runtimeUnavailable`, which routes the
 * item to manual review instead of recording a false failure against a
 * contributor. Installing instead would (a) require network egress, (b) let a
 * silently-unpinned version decide a verdict, and (c) charge the first item of
 * every sandbox a multi-minute install.
 */
function ensureNodeToolchain() {
  if (_NODE_TC !== null) return _NODE_TC;
  _NODE_TC = {
    tsx: have('tsx') ? 'tsx' : null,
    tsc: have('tsc') ? 'tsc' : null,
  };
  return _NODE_TC;
}

/**
 * Type-check without executing. Returns { checked, ok, diag }. Needed because
 * a compile-time-only defect (a TS type mismatch) is erased, not caught, by
 * tsx/esbuild — the broken version runs clean and a fail-then-pass contract
 * built only on execution cannot see it. checked:false means no checker was
 * available and the caller must not treat the result as a pass.
 */
function typeCheck(lang, code) {
  var L = normLang(lang);
  if (L !== 'typescript') return { checked: false, reason: 'no type checker for ' + L };
  var tc = ensureNodeToolchain();
  if (!tc.tsc) return { checked: false, reason: 'tsc unavailable' };
  var d = workdir();
  var f = path.join(d, 'main.ts');
  // Ambient declarations live in a SEPARATE .d.ts: once the submission uses
  // `import`/`export` (any node:test payload does), main.ts is a module and
  // inline `declare module` becomes an invalid augmentation (TS2664). The
  // shorthand wildcard module makes `import { test } from "node:test"` /
  // `import assert from "node:assert"` type-check without @types/node —
  // without it, bare tsc rejects every valid node:test submission with
  // TS2792, a toolchain failure misreported as bad contributor data.
  var ambientFile = path.join(d, 'ambient.d.ts');
  var ambient = [
    'declare module "node:*";',
    'declare module "assert";',
    'declare module "test";',
    'declare const assert: any;',
    'declare const process: any;',
    'declare const global: any;',
    'declare const require: any;',
    'declare const Buffer: any;',
    'declare const module: any;',
    'declare const __dirname: string;',
  ].join('\n');
  fs.writeFileSync(ambientFile, ambient);
  fs.writeFileSync(f, code);
  // 90000ms exceeded the outer sandbox command budget deployed at the time
  // (30000ms; raised to 120000ms as of the current deploy,
  // infra/terraform/ssm.tf) by 3x -- the registry-harness execution path
  // (unlike the separate per-language verifier path) never derives its
  // in-sandbox timeouts from that outer budget, so nothing else was
  // enforcing this. Reduced further (15000->6000) after debugging's own
  // harness was found calling typeCheck() TWICE per verify() alongside two
  // separate runWithTests() calls -- at 15000ms each, typeCheck alone could
  // consume the entire real budget before the actual test-running calls
  // ever got a chance to run. A cold tsc invocation on a single small file
  // is not remotely close to even this reduced value in practice; the risk
  // was a real compiler hang or a badly loaded sandbox tearing down the
  // whole outer command with no verdict at all, rather than a clean
  // checked:false.
  var r = run(tc.tsc, ['--noEmit', '--strict', '--target', 'es2022', '--lib', 'es2022,dom', '--skipLibCheck', ambientFile, f], { cwd: d, timeoutMs: 6000 });
  if (r.timedOut) return { checked: false, reason: 'tsc timed out' };
  return { checked: true, ok: r.status === 0, diag: ((r.stdout || '') + (r.stderr || '')).slice(0, 600) };
}

var _RUST_READY = null;
// Confirmed against a real E2B run (git_merge_resolution, 100-row New_Tester
// pass): 2 of 7 Rust rows came back `runtimeUnavailable: "rustc (no
// toolchain)"` while the other 5 (each in their OWN fresh sandbox -- E2B
// creates one VM per row and tears it down after, so this is never a
// warm-cache effect from a prior row) compiled and ran a real Rust program
// successfully, taking 7-14 real seconds end to end. A probe that fails 2/7
// of the time while the underlying toolchain plainly IS present and usable
// is a timeout that is too tight for real sandbox cold-start variance, not a
// genuine absence -- rustc is a substantial binary (plus shared libs) that a
// freshly booted microVM has to page in from disk on first touch, and 3000ms
// was not a safe margin against that tail, contrary to this function's own
// prior "near-instant" assumption below (which held in the common case, just
// not reliably enough: the false-negative rate observed was roughly 2/7).
/** Select a rustup default toolchain once per sandbox. Returns true if usable. */
function ensureRustToolchain() {
  if (_RUST_READY !== null) return _RUST_READY;
  // The 240000ms `rustup default stable` ceiling below assumed a real,
  // possibly slow install could legitimately happen here -- but sandbox
  // execution is no-network by design (see ensureNodeToolchain's own
  // comment), so this path can only ever fail fast against an unreachable
  // registry, never genuinely need four minutes; left at the old value it
  // could itself single-handedly consume 8x the outer sandbox command
  // budget deployed at the time (30000ms; raised to 120000ms as of the
  // current deploy, infra/terraform/ssm.tf) if it ever hung instead
  // of failing fast.
  var probe = run('rustc', ['--version'], { timeoutMs: 8000 });
  if (probe.status === 0) { _RUST_READY = true; return true; }
  if (have('rustup')) {
    run('rustup', ['default', 'stable'], { timeoutMs: 15000 });
    var after = run('rustc', ['--version'], { timeoutMs: 8000 });
    _RUST_READY = after.status === 0;
    return _RUST_READY;
  }
  _RUST_READY = false;
  return false;
}

function javaClassName(code) {
  // The primary regex used to require the literal token sequence "public
  // class" with nothing between them -- missed ordinary, common modifier
  // combinations (`public final class`, `public abstract class`, `public
  // strictfp class`), falling through to a visibility-blind fallback that
  // returns the FIRST `class NAME` found anywhere in the file. A file with
  // an earlier package-private helper class (`class Helper {...}`) ahead of
  // the real `public final class Solution {...}` got compiled as
  // "Helper.java" -- javac requires a public class's name to equal its
  // enclosing filename exactly, so this correct, idiomatic submission fails
  // to compile purely from the harness's own misnaming, not any submission
  // defect.
  //
  // Modifiers may legally appear in ANY order before `class` (`final
  // public class X` compiles identically to `public final class X`), and
  // the primary regex only recognized `public` as the FIRST token in the
  // sequence -- a reordered modifier list still fell through to the same
  // visibility-blind fallback and the same wrong-filename bug the fix
  // above already closed for the in-order case. Every modifier+class
  // occurrence in the file is scanned in order (not just the first) and
  // the first one whose modifier set contains `public` wins, so an earlier
  // reordered-but-still-public class is preferred over a later
  // package-private one, and a later public class (in either order) is
  // still found even if a package-private helper with no modifiers at all
  // precedes it (that residual case -- zero recognized modifiers on the
  // earlier class -- falls through to the same visibility-blind fallback
  // as before; distinguishing it would need parsing the file's real class
  // structure, not a regex).
  //
  // Stripped of comments/strings first (stripLineCommentsForLangDetect):
  // an ordinary doc comment mentioning "class" followed by a word (e.g.
  // "// This class of algorithm runs in O(n log n) time." above a BARE
  // method with no real class at all) used to match the fallback regex
  // directly, extracting a nonsense class name ("of", the word right after
  // "class" in the comment) for code that never declared a class in the
  // first place -- confirmed via the regex alone.
  var stripped = stripLineCommentsForLangDetect(code);
  var modRe = /((?:(?:public|final|abstract|strictfp)\s+)+)class\s+([A-Za-z_]\w*)/g;
  var m;
  while ((m = modRe.exec(stripped)) !== null) {
    if (/\bpublic\b/.test(m[1])) return m[2];
  }
  var fallback = stripped.match(/(?:^|\s)class\s+([A-Za-z_]\w*)/);
  return fallback ? fallback[1] : 'Main';
}

// Compile-step ceilings for runCode/runWithTests's compiled-language
// branches -- these are INDEPENDENT of whatever timeoutMs a caller passes
// (that only ever governs the subsequent RUN step), so no amount of
// per-category tuning elsewhere could bring a call under the outer sandbox
// command budget deployed at the time (30000ms; raised to 120000ms as of
// the current deploy, infra/terraform/ssm.tf) while these stayed at their
// prior values: javac/gcc/g++/mcs at 60000ms (2x that then-budget on the
// compile step ALONE) and rustc at 90000ms (3x). `go run`'s
// combined compile+run step was worse still -- Math.max(timeoutMs, 60000)
// meant it NEVER honored a caller's smaller request at all, always
// spending at least 60000ms regardless. None of this was hypothetical: any
// category dispatching Java/Go/Rust/C/C++/C# through runCode/runWithTests
// (fail_to_pass, debugging, code_translation, git_merge_resolution,
// implementation, unit_test_gen, refactoring) inherited it. Reduced to the
// same values already proven (via static reasoning; no local JDK/Go/Rust/
// gcc/mono toolchain to compile against) safe elsewhere in this registry
// for a small, submission-sized single file (static_compilation's own
// rustc/javac/gcc/go reductions) -- a cold compile of a short submission is
// not remotely close to even these reduced values in practice; the risk
// being closed is a hang or a badly loaded sandbox destroying the WHOLE
// outer command with no verdict at all, not the expected common case.
var COMPILE_TIMEOUT_MS = 10000;
var RUST_COMPILE_TIMEOUT_MS = 15000;
var GO_RUN_FLOOR_MS = 10000;

// The compile ceilings above are fixed and ADDITIVE to whatever timeoutMs a
// caller passes for the subsequent run step -- a caller has no way to know
// that budgeting its OWN requested timeoutMs against the real outer
// sandbox command budget also needs to leave room for a compile step this
// file adds on top, invisibly. Demonstrated concretely: refactoring's own
// both-pass-identically contract calls h.runCode(language, ..., 20000)
// TWICE, sequentially, for compiled languages including Rust -- a single
// one of those calls alone can reach RUST_COMPILE_TIMEOUT_MS (15000) +
// 20000 = 35000ms, already over the outer sandbox command budget deployed
// at the time (30000ms; raised to 120000ms as of the current deploy,
// infra/terraform/ssm.tf) on the FIRST call, before the
// second even starts. When this fires, the OUTER E2B sandbox command is
// killed by infra, not by this file's own graceful `timedOut` handling --
// no JSON verdict line is ever emitted at all, an opaque infra failure
// instead of a clean fail, for what may be an otherwise-correct submission
// with a slow/cold-cache compile.
//
// OUTER_SANDBOX_BUDGET_MS duplicates that deployed value (this file has no
// imports beyond node builtins, so it cannot read
// EXECUTION_RUNNER_TIMEOUT_MS out of src/config.ts directly) so the
// compiled-language ceilings above can be clamped against it directly,
// making the relationship every other timeout decision in this file was
// ALREADY reasoned about in comments alone (COMPILE_TIMEOUT_MS,
// RUST_COMPILE_TIMEOUT_MS, typeCheck's 6000ms, ensureRustToolchain's
// 15000ms) an enforced invariant instead of just a comment. If that env
// var is ever changed, this constant needs a matching update.
var OUTER_SANDBOX_BUDGET_MS = 120000;
// Margin reserved below the outer budget for process/file-IO overhead that
// isn't attributable to any single compile/run call but still eats into
// the same outer window (spawning node itself, writing source files to
// disk, JSON-stringifying and printing the final report).
var SANDBOX_OVERHEAD_MARGIN_MS = 3000;
var MAX_COMPILE_PLUS_RUN_MS = OUTER_SANDBOX_BUDGET_MS - SANDBOX_OVERHEAD_MARGIN_MS;

/**
 * Clamp a caller-requested RUN-step timeout so (fixed compile ceiling) +
 * (run timeout) can never exceed MAX_COMPILE_PLUS_RUN_MS, regardless of
 * what a harness passes -- a hard safety net on top of, not instead of,
 * callers budgeting sensibly themselves. Exported (see module.exports)
 * alongside the ceilings above so a harness making several sequential
 * runCode/runWithTests calls in one verify() (refactoring's own
 * both-pass-identically contract chief among them) can size its OWN
 * requested timeoutMs against the same numbers this file already enforces
 * internally, instead of guessing.
 */
function clampRunTimeout(compileCeilingMs, timeoutMs) {
  var requested = timeoutMs || 8000;
  var budget = MAX_COMPILE_PLUS_RUN_MS - compileCeilingMs;
  return Math.max(1000, Math.min(requested, budget));
}

// Java/Go/Rust/C/C++/C# have no exit-forgery trap analogous to
// PY_PRELUDE/PY_DRIVER (sys.exit/os._exit/raw SystemExit) or JS_PRELUDE
// (process.exit) -- System.exit(0)/os.Exit(0)/std::process::exit(0)/
// exit(0)/Environment.Exit(0), called from ANYWHERE the submission's own
// code runs during `tests`' execution, forces a clean process exit that
// runWithTests's `ok: r.status === 0` check cannot distinguish from a
// genuine, uninterrupted pass -- the exact same false-pass shape already
// found and closed for Python/JS, just never addressed for the rest of the
// language matrix. Unlike Python/JS, none of these languages let this file
// intercept the call itself (no monkey-patching). What IS available: for
// every one of these six, runWithTests's OWN synthesized entrypoint (never
// the submission's) is the thing that wraps `tests` -- printing a marker as
// the LITERAL LAST statement of that harness-authored entrypoint, and
// requiring its presence (not just a clean exit code) closes the same gap
// PY_DRIVER's structural try/except closes for raw `raise SystemExit`: if
// an exit call anywhere in the submission's own code (invoked from within
// `tests`) fires first, this marker never prints, and the forged status:0
// is caught by its absence. Does not help runCode's OWN compiled-language
// branches, which take an already-complete, self-contained program with no
// harness-controlled "append after everything" point to inject into --
// currently exercised only by refactoring's manual concatenation for
// compiled languages, flagged there as an accepted residual matching this
// same class already accepted for PHP/Ruby.
//
// RESIDUAL, EXPLICITLY NOT ATTEMPTED IN THIS PASS (both halves below were
// evaluated and deliberately left unfixed rather than shipped unverified;
// no ruby/php/java/go/rustc/gcc/g++/mono toolchain was available in this
// environment to compile or run ANYTHING in these languages against):
//
// 1) Ruby/PHP via runCode/runWithTests (see the "Known, accepted residual"
//    comment on runCode's ruby/php branches below). One correction to that
//    comment while re-auditing this file: Ruby's Kernel#exit is, in fact,
//    an ordinary, overridable method (Kernel is a module mixed into
//    Object; redefining `Kernel#exit`/`Kernel#abort` to raise instead is
//    valid, idiomatic Ruby) -- it is NOT a language construct the way the
//    comment there currently states, and closing the common case (a bare
//    `exit`/`exit(0)`/`exit(1)` call) is structurally possible the same
//    way PY_PRELUDE/JS_PRELUDE already do it for Python/JS, without the
//    full sentinel-file architecture change. `exit!`/`Process.exit!`
//    (bypasses at_exit and, separately, this hypothetical override) would
//    remain an accepted residual, matching Python's own raw-syscall
//    residual. PHP's exit()/die() really are language constructs with no
//    monkeypatch surface at all -- that half of the comment is accurate.
//    Not implemented here: with no ruby interpreter available to compile
//    and run even one row against, shipping a change to Ruby's execution
//    semantics blind risks silently breaking every legitimate Ruby row in
//    this registry in exchange for closing one exploit path, which is a
//    worse outcome than leaving the residual documented and open.
//
// 2) Adding EXIT_TRAP_MARKER-style verification to runCode's OWN
//    compiled-language branches (java/go/rust/cpp/c/csharp), for
//    refactoring's direct runCode use specifically. Considered: wrap the
//    ALREADY-COMPLETE program the same way runWithTests already does for
//    its OWN synthesized entrypoints -- rename the submission's real
//    main/Main to a dead-code alias, and provide a new entrypoint that
//    calls it and prints the marker only after it returns, so a forced
//    exit inside the original main prevents the marker from ever printing.
//    Rejected for this pass: unlike runWithTests's tests-only entrypoints
//    (which the driver authors from scratch and fully controls the shape
//    of), this would need to correctly call through to an ALREADY-WRITTEN,
//    arbitrary submission's real entrypoint across six languages with
//    materially different, contributor-controlled entrypoint signatures --
//    Rust's `fn main()` vs `fn main() -> Result<(), E>` (calling the
//    renamed function from a fixed-signature wrapper without also handling
//    its Result would itself be a new compile error for the common
//    `?`-in-main idiom), C/C++'s `int main()` vs `int main(int argc, char
//    **argv)`, and C#'s void/int and with/without-args Main overloads.
//    Getting this wrong is worse than the residual it would close: a
//    regex-based wrapper miscounting or mishandling any one of those
//    signature variants would turn a correct submission into a guaranteed
//    compile failure across every row of that shape, and none of these six
//    toolchains were available here to verify a wrapper actually compiles
//    for each signature variant before shipping it. Left as the same class
//    of accepted residual already documented above (refactoring's own
//    comment on this exact gap), not implemented blind.
var EXIT_TRAP_MARKER = '@@CATRUN_TESTS_COMPLETE@@';
function completedCleanly(r) {
  // Checked against the UNCAPPED stdout (see run()'s rawStdout, and
  // OUT_CAP's own doc comment above): EXIT_TRAP_MARKER is printed as the
  // literal last statement of runWithTests's synthesized entrypoint, so a
  // legitimately verbose (>OUT_CAP) but cleanly-completed submission must
  // not have its own completion marker truncated away by the same
  // report-bounding cap applied to the returned, logged `stdout` field.
  var out = r.rawStdout != null ? r.rawStdout : r.stdout;
  return r.status === 0 && String(out || '').indexOf(EXIT_TRAP_MARKER) !== -1;
}

/** Compile and run the given code (tests already appended) in the given language. */
function runCode(lang, code, timeoutMs) {
  var L = normLang(lang);
  var d = workdir();
  timeoutMs = timeoutMs || 8000;

  if (L === 'python') {
    if (!have('python3')) return { unavailable: true, runtime: 'python3' };
    // The actual submission+tests source runs INSIDE the driver's own
    // try/except SystemExit (see PY_DRIVER), not as the directly-invoked
    // script -- a bare `python3 main.py` would let a top-level `raise
    // SystemExit(0)` anywhere in `code` exit the process cleanly before this
    // file's own driver logic ever got a chance to intervene.
    var fpySubmission = path.join(d, '_submission.py'); fs.writeFileSync(fpySubmission, PY_PRELUDE + '\n' + code);
    var fpy = path.join(d, 'main.py'); fs.writeFileSync(fpy, PY_DRIVER);
    var rpy = run('python3', [fpy, fpySubmission], { cwd: d, timeoutMs: timeoutMs });
    return Object.assign({ ok: rpy.status === 0, runtime: 'python3' }, rpy);
  }
  if (L === 'javascript') {
    if (!have('node')) return { unavailable: true, runtime: 'node' };
    var fjs = path.join(d, 'main.js'); fs.writeFileSync(fjs, JS_PRELUDE + '\n' + code);
    var rjs = run('node', [fjs], { cwd: d, timeoutMs: timeoutMs });
    return Object.assign({ ok: rjs.status === 0, runtime: 'node' }, rjs);
  }
  if (L === 'typescript') {
    var tc = ensureNodeToolchain();
    if (!tc.tsx) return { unavailable: true, runtime: 'tsx (install failed)' };
    var fts = path.join(d, 'main.ts'); fs.writeFileSync(fts, JS_PRELUDE + '\n' + code);
    var rts = run(tc.tsx, [fts], { cwd: d, timeoutMs: timeoutMs });
    return Object.assign({ ok: rts.status === 0, runtime: 'tsx' }, rts);
  }
  if (L === 'java') {
    if (!have('javac')) return { unavailable: true, runtime: 'javac' };
    var clsj = javaClassName(code);
    var fjv = path.join(d, clsj + '.java'); fs.writeFileSync(fjv, code);
    var cjv = run('javac', [fjv], { cwd: d, timeoutMs: COMPILE_TIMEOUT_MS });
    if (cjv.status !== 0) return Object.assign({ ok: false, runtime: 'javac', compileFailed: true }, cjv);
    // -ea is REQUIRED: JVM assertions are disabled by default, so assert
    // statements would be silent no-ops and every item would falsely pass.
    var rjv = run('java', ['-ea', '-cp', d, clsj], { cwd: d, timeoutMs: clampRunTimeout(COMPILE_TIMEOUT_MS, timeoutMs) });
    return Object.assign({ ok: rjv.status === 0, runtime: 'java -ea' }, rjv);
  }
  if (L === 'go') {
    if (!have('go')) return { unavailable: true, runtime: 'go' };
    var fgo = path.join(d, 'main.go'); fs.writeFileSync(fgo, code);
    // `go run` compiles and runs in a single combined step (no separate
    // compile ceiling to add on top), but the requested floor/timeout
    // combination is still clamped against the same outer-budget ceiling
    // as the other compiled languages for consistency.
    var rgo = run('go', ['run', fgo], { cwd: d, timeoutMs: clampRunTimeout(0, Math.max(timeoutMs, GO_RUN_FLOOR_MS)), env: { HOME: d, GOCACHE: path.join(d, '.gocache'), GOPATH: path.join(d, '.gopath'), GOFLAGS: '-mod=mod' } });
    return Object.assign({ ok: rgo.status === 0, runtime: 'go' }, rgo);
  }
  if (L === 'rust') {
    if (!have('rustc')) return { unavailable: true, runtime: 'rustc' };
    if (!ensureRustToolchain()) return { unavailable: true, runtime: 'rustc (no toolchain)' };
    var frs = path.join(d, 'main.rs'); fs.writeFileSync(frs, code);
    var crs = run('rustc', ['-o', path.join(d, 'app'), frs], { cwd: d, timeoutMs: RUST_COMPILE_TIMEOUT_MS });
    if (crs.status !== 0) return Object.assign({ ok: false, runtime: 'rustc', compileFailed: true }, crs);
    var rrs = run(path.join(d, 'app'), [], { cwd: d, timeoutMs: clampRunTimeout(RUST_COMPILE_TIMEOUT_MS, timeoutMs) });
    return Object.assign({ ok: rrs.status === 0, runtime: 'rustc' }, rrs);
  }
  if (L === 'cpp' || L === 'c') {
    var cc = L === 'cpp' ? 'g++' : 'gcc';
    if (!have(cc)) return { unavailable: true, runtime: cc };
    var fc = path.join(d, L === 'cpp' ? 'main.cpp' : 'main.c'); fs.writeFileSync(fc, code);
    var flags = [fc, '-o', path.join(d, 'app'), '-std=' + (L === 'cpp' ? 'c++17' : 'c11'), '-w'];
    if (L === 'cpp') flags.push('-fpermissive');
    var cc1 = run(cc, flags, { cwd: d, timeoutMs: COMPILE_TIMEOUT_MS });
    if (cc1.status !== 0) return Object.assign({ ok: false, runtime: cc, compileFailed: true }, cc1);
    var rc = run(path.join(d, 'app'), [], { cwd: d, timeoutMs: clampRunTimeout(COMPILE_TIMEOUT_MS, timeoutMs) });
    return Object.assign({ ok: rc.status === 0, runtime: cc }, rc);
  }
  if (L === 'ruby') {
    if (!have('ruby')) return { unavailable: true, runtime: 'ruby' };
    var frb = path.join(d, 'main.rb'); fs.writeFileSync(frb, code);
    var rrb = run('ruby', [frb], { cwd: d, timeoutMs: timeoutMs });
    return Object.assign({ ok: rrb.status === 0, runtime: 'ruby' }, rrb);
  }
  // Known, accepted residual (Ruby and PHP both): unlike Python
  // (PY_PRELUDE/PY_DRIVER) and JS (JS_PRELUDE's process.exit trap), neither
  // branch installs anything that intercepts an early exit/die call. PHP's
  // exit()/die() are genuinely language constructs with no monkeypatch
  // surface at all. Ruby's Kernel#exit is, in fact, an ordinary overridable
  // method (a later re-audit of this file corrected this comment: redefining
  // Kernel#exit/Kernel#abort to raise instead is valid, idiomatic Ruby, NOT
  // a language construct the way this comment previously claimed) -- see
  // the detailed note next to EXIT_TRAP_MARKER/completedCleanly below for
  // why a fix was still not shipped this pass despite that. Either way,
  // right now: code appended after a submission (runWithTests's "code +
  // tests" concatenation) that calls exit/die exits the whole process
  // before the appended part ever runs, with no exception raised to
  // intercept it. Closing PHP's half properly would need the same shape as
  // PY_DRIVER: verify tests actually completed from OUTSIDE the process
  // (e.g. a sentinel file written only after tests finishes, checked by the
  // caller regardless of the child's exit code) rather than trusting the
  // raw exit code alone -- a real architecture change to this function's
  // return contract, not a monkeypatch. No local ruby/php interpreter was
  // available in this environment to verify a fix for either language, and
  // shipping one unverified risked breaking every legitimate Ruby/PHP row
  // instead of just the exploit -- flagged for a follow-up pass with both
  // interpreters available, not implemented blind.
  if (L === 'php') {
    if (!have('php')) return { unavailable: true, runtime: 'php' };
    var bodyphp = /<\?php/.test(code) ? code : '<?php\n' + code;
    var fphp = path.join(d, 'main.php'); fs.writeFileSync(fphp, bodyphp);
    // zend.assertions defaults to -1 (compiled OUT entirely) under a
    // production-style php.ini, and even at 1 a failed assert() only raises
    // an E_WARNING (script still exits 0) unless assert.exception is also
    // enabled. Without both flags every assert(false) in a dataset's tests
    // is a silent no-op, so a broken implementation exits 0 and is scored as
    // a PASS — the same false-pass trap already fixed for JVM (-ea),
    // console.assert, and Debug.Assert above.
    var rphp = run('php', ['-d', 'zend.assertions=1', '-d', 'assert.exception=1', fphp], { cwd: d, timeoutMs: timeoutMs });
    return Object.assign({ ok: rphp.status === 0, runtime: 'php' }, rphp);
  }
  if (L === 'csharp') {
    if (!have('mcs')) return { unavailable: true, runtime: 'mcs (mono)' };
    var fcs = path.join(d, 'Main.cs'); fs.writeFileSync(fcs, code);
    var ccs = run('mcs', ['-out:' + path.join(d, 'app.exe'), fcs], { cwd: d, timeoutMs: COMPILE_TIMEOUT_MS });
    if (ccs.status !== 0) return Object.assign({ ok: false, runtime: 'mcs', compileFailed: true }, ccs);
    var rcs = run('mono', [path.join(d, 'app.exe')], { cwd: d, timeoutMs: clampRunTimeout(COMPILE_TIMEOUT_MS, timeoutMs) });
    return Object.assign({ ok: rcs.status === 0, runtime: 'mono' }, rcs);
  }
  return { unavailable: true, runtime: L };
}

/**
 * Combine a solution and its test snippet into ONE runnable program.
 *
 * Scripting languages concatenate. Compiled languages do not: the datasets
 * supply bare statements (Java "assert X;", Rust "assert_eq!(..)", C++
 * "assert(..)", Go "t.Fail()") which are illegal at top level and MUST be
 * placed inside an entrypoint. Concatenating them instead produces a compile
 * error that looks like a failing submission — a false negative.
 */
function runWithTests(lang, code, tests, timeoutMs) {
  var L = normLang(lang);
  code = String(code == null ? '' : code);
  tests = String(tests == null ? '' : tests);

  if (L === 'javascript' || L === 'typescript') {
    var reqPath = tests.match(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/);
    if (reqPath && /module\.exports/.test(code)) {
      var d3 = workdir();
      var modRel = reqPath[1].replace(/^\.\//, '');
      var modFile = path.join(d3, modRel);
      // modRel is fully contributor-controlled -- parsed straight out of
      // `tests`'s own require() call, with no traversal check. A path like
      // "../../../../evil_marker" resolves OUTSIDE this row's own scratch
      // dir entirely. An unchecked write there can still corrupt OTHER
      // scratch state within the SAME sandbox process (this file's own
      // ROOT, shared across every h.workdir() call this process makes) --
      // confirmed exploitable: a crafted `tests` field wrote and then
      // required a file several directories above the workdir. Reject
      // outright (not runtimeUnavailable -- this is the row's own fault,
      // same as any other malformed/unsafe contributor input) if the
      // resolved path would land outside `d3`.
      //
      // (An earlier version of this comment additionally claimed a warm
      // sandbox is reused across many submissions, making this a
      // PERSISTENT, cross-submission corruption primitive -- traced end to
      // end during a later audit of this file and found to be false against
      // the CURRENT deployment: e2b.ts creates one sandbox per row and
      // kills it in a `finally` block every time, so there is no pooling
      // for a write here to persist into. The single-row blast radius above
      // is real and still worth rejecting outright; the cross-submission
      // framing was not. Left here as a flag: if sandbox pooling is ever
      // introduced as a latency optimization, this rejection becomes load-
      // bearing again in exactly the way the original comment assumed, and
      // workdir()'s own scratch directories (ROOT, mkdtempSync'd once per
      // process with no cleanup anywhere in this file) would need revisiting
      // too -- harmless today only because the whole process is destroyed
      // after one row.)
      var modRelToRoot = path.relative(d3, modFile);
      if (modRelToRoot.startsWith('..') || path.isAbsolute(modRelToRoot)) {
        return { ok: false, runtime: 'node (module)', stdout: '', stderr: 'tests references a module path outside the sandbox workdir (rejected): ' + reqPath[1] };
      }
      fs.mkdirSync(path.dirname(modFile), { recursive: true });
      // TypeScript on the module path must run through tsx, not plain node.
      // This used to write the code to the require()'d filename verbatim (often
      // extensionless, e.g. `submission`) and execute the test with `node` —
      // which cannot parse type annotations, so any typed TS module threw
      // `SyntaxError: Unexpected token ':'` at runtime. Combined with the
      // strict type-check gate the contracts also apply, the two gates were
      // MUTUALLY UNSATISFIABLE for module-style TS items: untyped JS failed
      // tsc (TS7006), typed TS failed node. No contributor payload could pass.
      // tsx's CJS loader resolves an extensionless require("./submission") to
      // submission.ts, so the module file gains a .ts extension when the
      // require path doesn't already carry one.
      if (L === 'typescript') {
        var tcm = ensureNodeToolchain();
        if (!tcm.tsx) return { unavailable: true, runtime: 'tsx (install failed)' };
        var modFileTs = /\.[cm]?[jt]s$/.test(modRel) ? modFile : modFile + '.ts';
        fs.writeFileSync(modFileTs, code);
        var testFileTs = path.join(d3, 'main.test.ts');
        fs.writeFileSync(testFileTs, JS_PRELUDE + '\n' + tests);
        var rts = run(tcm.tsx, [testFileTs], { cwd: d3, timeoutMs: timeoutMs });
        return Object.assign({ ok: rts.status === 0, runtime: 'tsx (module)' }, rts);
      }
      if (!have('node')) return { unavailable: true, runtime: 'node' };
      fs.writeFileSync(modFile, code);
      var testFile = path.join(d3, 'main.test.js');
      fs.writeFileSync(testFile, JS_PRELUDE + '\n' + tests);
      var rmod = run('node', [testFile], { cwd: d3, timeoutMs: timeoutMs });
      return Object.assign({ ok: rmod.status === 0, runtime: 'node (module)' }, rmod);
    }
  }

  if (L === 'python' || L === 'javascript' || L === 'typescript' || L === 'ruby' || L === 'php') {
    // Re-arm immediately before `tests`, not just once in JS_PRELUDE at the
    // very top: `code` runs between the prelude and the tests, so a
    // submission that does `globalThis.assert = () => {}` (or reassigns
    // console.assert back to a no-op) after the prelude already ran would
    // otherwise neuter every assertion the tests make, regardless of what
    // the submission actually computes. Re-binding here overwrites any such
    // monkeypatch right before it matters.
    // PHP: zend.assertions/assert.exception are documented PHP_INI_ALL --
    // runtime-changeable via ini_set(), not just start-time CLI flags (which
    // runCode's php branch sets once via -d). A submission calling
    // ini_set('zend.assertions','0') before `tests` runs makes every later
    // assert() a silent no-op regardless of what it checks, same false-pass
    // class as JS's console.assert or Java's disabled-by-default -ea.
    //
    // Ruby has no re-arm here: this dataset family's Ruby rows rely on bare
    // `raise 'fail' unless ...` (no assert library, no -ea/ini_set
    // equivalent), and a submission defining `def raise(*a); end` at the
    // top level shadows Kernel#raise for the rest of the script by design
    // of Ruby's top-level-method-defines-on-Object semantics. The fix
    // (detecting and removing an Object-level override before `tests` via
    // `Object.send(:remove_method, :raise)`) needs a real ruby interpreter
    // to verify -- none was available in this environment, and shipping an
    // unverified metaprogramming snippet risked breaking every legitimate
    // Ruby row instead of just the exploit. Flagged for a follow-up pass
    // with Ruby available, not implemented blind.
    var rearm = (L === 'javascript' || L === 'typescript')
      ? "globalThis.assert = require('assert'); console.assert = function (c) { if (!c) { throw new Error('console.assert failed: ' + Array.prototype.slice.call(arguments,1).join(' ')); } };\n"
      : (L === 'python' ? PY_PRELUDE + '\n' : (L === 'php' ? "ini_set('zend.assertions', '1'); ini_set('assert.exception', '1');\n" : ''));
    return runCode(L, code + '\n' + rearm + tests, timeoutMs);
  }

  if (L === 'java') {
    if (!have('javac')) return { unavailable: true, runtime: 'javac' };
    var dj = workdir();
    var entry;
    // Checked against comment/string-stripped text, not raw `code`: an
    // ordinary doc comment mentioning "class" followed by a word (e.g.
    // "// This class of algorithm runs in O(n log n) time." above a bare
    // method with no real class declaration at all) used to match this
    // check directly, misrouting a correct bare-method submission into the
    // "already has a class" branch below -- which then asked
    // javaClassName() to guess a name from the same code, extracting the
    // literal word AFTER "class" in that same comment ("of", in the
    // example above) as a nonsense class name for code that never declared
    // one, guaranteeing a compile failure. The actual `code` (unstripped)
    // is still what gets written to disk and compiled either way; only
    // this detection step reads the stripped text.
    if (!/\bclass\s+[A-Za-z_]\w*/.test(stripLineCommentsForLangDetect(code))) {
      entry = 'Solution';
      var staticised = code.replace(
        /\b(public|private|protected)\s+(?!static\b)([\w<>\[\],.\s]+?\s+\w+\s*\()/g,
        '$1 static $2'
      );
      var wrapped = 'import java.util.*;\npublic class Solution {\n' + staticised +
        '\npublic static void main(String[] a) throws Exception {\n' + tests + '\nSystem.out.println("' + EXIT_TRAP_MARKER + '");\n}\n}';
      fs.writeFileSync(path.join(dj, 'Solution.java'), wrapped);
      var c1 = run('javac', [path.join(dj, 'Solution.java')], { cwd: dj, timeoutMs: COMPILE_TIMEOUT_MS });
      if (c1.status !== 0) return Object.assign({ ok: false, runtime: 'javac', compileFailed: true }, c1);
    } else {
      var clsj2 = javaClassName(code);
      var needsUtil = !/^\s*import\s+java\.util/m.test(code) && !/^\s*package\s+/m.test(code);
      fs.writeFileSync(path.join(dj, clsj2 + '.java'), (needsUtil ? 'import java.util.*;\n' : '') + code);
      // Deliberately unusual name, not "CatRunMain": a submission whose
      // public class happened to be named exactly that (a real, if
      // narrow, collision) had its file silently overwritten by this
      // driver class an instant later, erasing the submission entirely --
      // compiles as "cannot find symbol" against the submission's own
      // methods, a fully deterministic, undiagnosable false negative.
      entry = '__CatRunDriverEntry__';
      var main2 = 'import java.util.*;\npublic class __CatRunDriverEntry__ { public static void main(String[] a) throws Exception {\n' + tests + '\nSystem.out.println("' + EXIT_TRAP_MARKER + '");\n} }';
      fs.writeFileSync(path.join(dj, '__CatRunDriverEntry__.java'), main2);
      var c2 = run('javac', [path.join(dj, clsj2 + '.java'), path.join(dj, '__CatRunDriverEntry__.java')], { cwd: dj, timeoutMs: COMPILE_TIMEOUT_MS });
      if (c2.status !== 0) return Object.assign({ ok: false, runtime: 'javac', compileFailed: true }, c2);
    }
    var rj = run('java', ['-ea', '-cp', dj, entry], { cwd: dj, timeoutMs: clampRunTimeout(COMPILE_TIMEOUT_MS, timeoutMs) });
    return Object.assign({ ok: completedCleanly(rj), runtime: 'java -ea' }, rj);
  }

  if (L === 'rust') {
    if (!have('rustc')) return { unavailable: true, runtime: 'rustc' };
    // A submission written as a complete, self-contained program (its own
    // `fn main`) used to be run AS-IS in that case, with `tests` never
    // appended anywhere -- the submission's own main() ran, `tests` was
    // silently dropped from the compiled program entirely, and the row
    // scored a guaranteed pass regardless of correctness. This is not an
    // exotic attack; it's the ordinary idiom of writing a runnable program
    // instead of a bare function. Renaming the submission's own main (never
    // called -- it becomes harmless dead code from the driver's point of
    // view) means the driver's own fn main(), which DOES include tests, is
    // always the sole entrypoint that actually runs.
    var bodyRs = code.replace(/\bfn\s+main\s*\(/, 'fn catrun_user_main(');
    // Marker printed as the LITERAL LAST statement of the driver's own
    // fn main() -- see EXIT_TRAP_MARKER's comment. runCode's own `ok` (a
    // bare status===0 check, shared with the "already-complete program"
    // caller path that has no such marker to look for) is overridden here,
    // in runWithTests specifically, where the marker is always ours to
    // expect.
    var progRs = bodyRs + '\nfn main() {\n' + tests + '\nprintln!("' + EXIT_TRAP_MARKER + '");\n}\n';
    var rrsWt = runCode('rust', progRs, timeoutMs);
    return rrsWt.unavailable || rrsWt.compileFailed ? rrsWt : Object.assign({}, rrsWt, { ok: completedCleanly(rrsWt) });
  }

  if (L === 'cpp' || L === 'c') {
    var inc = L === 'cpp'
      ? '#include <cassert>\n#include <iostream>\n#include <cstring>\n#include <cstdlib>\n#include <string>\n#include <vector>\nusing namespace std;\n'
      : '#include <assert.h>\n#include <stdio.h>\n#include <string.h>\n#include <stdlib.h>\n';
    // Same rationale as Rust above: a submission with its own int main()
    // used to run as-is, silently dropping `tests` from the compiled
    // program and guaranteeing a pass regardless of correctness.
    var bodyC = code.replace(/\bint\s+main\s*\(/, 'int catrun_user_main(');
    var markerStmt = L === 'cpp' ? 'cout << "' + EXIT_TRAP_MARKER + '" << endl;' : 'printf("' + EXIT_TRAP_MARKER + '\\n");';
    var progC = inc + bodyC + '\nint main() {\n' + tests + '\n  ' + markerStmt + '\n  return 0;\n}\n';
    var rcWt = runCode(L, progC, timeoutMs);
    return rcWt.unavailable || rcWt.compileFailed ? rcWt : Object.assign({}, rcWt, { ok: completedCleanly(rcWt) });
  }

  if (L === 'csharp') {
    if (!have('mcs')) return { unavailable: true, runtime: 'mcs (mono)' };
    var d2 = workdir();
    // Two false-pass traps, same family as Java's -ea and JS's console.assert:
    // Debug.Assert is compiled out entirely unless DEBUG is defined, and even
    // with DEBUG a failed assert only notifies trace listeners while the
    // process still exits 0 — install a listener that throws instead.
    //
    // A submission needing a namespace beyond the four already provided
    // below (System/.Collections.Generic/.Linq/.Diagnostics) had no way to
    // add it: `code` is spliced INSIDE the class body further down, and a
    // `using` directive is only valid at file/namespace scope in C# --
    // writing one inside a class is a compile error (CS1519: "Unexpected
    // symbol 'using' in class, struct, or interface member declaration"),
    // misclassifying an otherwise-correct submission as broken purely for
    // needing e.g. `System.Text`. Extracted and hoisted to file scope
    // instead, the same way this file's own Go branch already extracts and
    // re-splices import statements out of the submission body for the
    // exact same reason (a driver-synthesized wrapper colliding with the
    // submission's own file-scope declarations).
    var baseUsings = ['System', 'System.Collections.Generic', 'System.Linq', 'System.Diagnostics'];
    var usingSet = {};
    baseUsings.forEach(function (u) { usingSet[u] = true; });
    var bodyCs = code.replace(/^[ \t]*using\s+([\w.]+)\s*;[ \t]*$/gm, function (_m, ns) {
      usingSet[ns] = true;
      return '';
    });
    var usingLines = Object.keys(usingSet).map(function (ns) { return 'using ' + ns + ';'; });
    var progCs = [].concat(usingLines, [
      'class CatRunThrowListener : TraceListener {',
      '  public override void Write(string m) {}',
      '  public override void WriteLine(string m) {}',
      '  public override void Fail(string m) { throw new Exception("assert failed: " + m); }',
      '  public override void Fail(string m, string d) { throw new Exception("assert failed: " + m + " " + d); }',
      '}',
      'public class CatRunMain {',
      bodyCs,
      '  public static void Main(string[] args) {',
      '    Trace.Listeners.Clear();',
      '    Trace.Listeners.Add(new CatRunThrowListener());',
      tests,
      // Marker printed as the LITERAL LAST statement of the driver's own
      // Main() -- see EXIT_TRAP_MARKER's comment.
      '    Console.WriteLine("' + EXIT_TRAP_MARKER + '");',
      '  }',
      '}',
    ]).join('\n');
    var fcs2 = path.join(d2, 'Main.cs'); fs.writeFileSync(fcs2, progCs);
    var ccs2 = run('mcs', ['-define:DEBUG', '-define:TRACE', '-out:' + path.join(d2, 'app.exe'), fcs2], { cwd: d2, timeoutMs: COMPILE_TIMEOUT_MS });
    if (ccs2.status !== 0) return Object.assign({ ok: false, runtime: 'mcs', compileFailed: true }, ccs2);
    var rcs2 = run('mono', [path.join(d2, 'app.exe')], { cwd: d2, timeoutMs: clampRunTimeout(COMPILE_TIMEOUT_MS, timeoutMs) });
    return Object.assign({ ok: completedCleanly(rcs2), runtime: 'mono' }, rcs2);
  }

  if (L === 'go') {
    if (!have('go')) return { unavailable: true, runtime: 'go' };
    var hasPkg = /^\s*package\s+\w+/m.test(code);
    // `.*$` (not `\s*$`): a `package main` line carrying an ordinary
    // trailing line comment (`package main // entrypoint`) used to be
    // DETECTED by hasPkg (which has no end-anchor) but NOT stripped by
    // this regex, since `\s*$` requires nothing but whitespace after the
    // package name. The leftover, unstripped `package main // entrypoint`
    // line then collided with this function's OWN unconditional `'package
    // main'` line below the driver injects further down, guaranteeing a
    // Go compile error ("expected declaration, found package") for a
    // correct submission whose only "defect" was a comment on its package
    // line.
    var bodyGo = hasPkg ? code.replace(/^\s*package\s+\w+.*$/m, '') : code;
    var imports = { os: true, fmt: true };
    bodyGo = bodyGo.replace(/import\s*\(([\s\S]*?)\)/g, function (_m, blk) {
      String(blk).split('\n').forEach(function (line) {
        var q = line.match(/"([^"]+)"/);
        if (q) imports[q[1]] = true;
      });
      return '';
    });
    bodyGo = bodyGo.replace(/^\s*import\s+"([^"]+)"\s*$/gm, function (_m, pkg) { imports[pkg] = true; return ''; });
    // A submission written as an idiomatic complete program (its own real
    // `func main`) collides with the driver's own synthetically-appended
    // `func main` below -- an unconditional "main redeclared" compile
    // error in any Go toolchain, misclassifying a correct submission as
    // broken purely from writing it as a complete program rather than a
    // bare function. Renamed (never called -- harmless dead code from the
    // driver's point of view), same rationale as the C/C++/Rust fix above.
    bodyGo = bodyGo.replace(/\bfunc\s+main\s*\(\s*\)/, 'func catrunUserMain()');
    var STDLIB = ['time', 'sync', 'strings', 'strconv', 'math', 'sort', 'errors', 'bytes', 'regexp', 'unicode', 'bufio', 'io'];
    var combinedGo = bodyGo + '\n' + tests;
    STDLIB.forEach(function (pkg) {
      if (new RegExp('\\b' + pkg + '\\.[A-Z]').test(combinedGo)) imports[pkg] = true;
    });
    var progGo = [
      'package main',
      'import (' + Object.keys(imports).map(function (i) { return '"' + i + '"'; }).join('; ') + ')',
      'type catrunT struct{}',
      'func (catrunT) Fail() { fmt.Println("t.Fail"); os.Exit(1) }',
      'func (catrunT) FailNow() { fmt.Println("t.FailNow"); os.Exit(1) }',
      'func (catrunT) Errorf(f string, a ...interface{}) { fmt.Printf(f, a...); os.Exit(1) }',
      'func (catrunT) Fatalf(f string, a ...interface{}) { fmt.Printf(f, a...); os.Exit(1) }',
      bodyGo,
      'func main() {',
      '  t := catrunT{}',
      '  _ = t',
      tests,
      // Marker printed as the LITERAL LAST statement of the driver's own
      // func main() -- see EXIT_TRAP_MARKER's comment. runCode's own `ok`
      // (a bare status===0 check, shared with the "already-complete
      // program" caller path that has no such marker to look for) is
      // overridden below, in runWithTests specifically, where the marker
      // is always ours to expect.
      '  fmt.Println("' + EXIT_TRAP_MARKER + '")',
      '}',
    ].join('\n');
    var rgoWt = runCode('go', progGo, timeoutMs);
    return rgoWt.unavailable ? rgoWt : Object.assign({}, rgoWt, { ok: completedCleanly(rgoWt) });
  }

  return { unavailable: true, runtime: L };
}

module.exports = {
  ROOT, workdir, have, run, cap,
  norm, looseEqual, canonical, jsonOf, lastMarked, str, list,
  fs, path, os,
  normLang, inferLang, runCode, runWithTests, typeCheck,
  ensureNodeToolchain, ensureRustToolchain, javaClassName, JS_PRELUDE, PY_PRELUDE,
  // Exposed so a harness making several sequential runCode/runWithTests
  // calls in one verify() (refactoring's own both-pass-identically
  // contract chief among them) can budget its OWN requested timeoutMs
  // against the same compile-step ceilings and outer-sandbox-budget
  // numbers this file already enforces internally via clampRunTimeout.
  COMPILE_TIMEOUT_MS, RUST_COMPILE_TIMEOUT_MS, GO_RUN_FLOOR_MS,
  OUTER_SANDBOX_BUDGET_MS, MAX_COMPILE_PLUS_RUN_MS, clampRunTimeout,
};
