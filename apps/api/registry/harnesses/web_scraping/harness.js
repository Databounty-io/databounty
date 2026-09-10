/**
 * html_extract — parsing code reads an injected `html` variable and assigns
 * `result`, which must equal the expected extraction.
 *
 * Nothing is fetched despite the category name: the page is supplied inline, so
 * this needs no network access.
 */
'use strict';

const crypto = require('crypto');

// Comfortably under the outer sandbox command budget deployed at the time
// (30000ms; raised to 120000ms as of the current deploy,
// infra/terraform/ssm.tf's EXECUTION_RUNNER_TIMEOUT_MS): the prior
// 20000/25000ms (Python) and unset-default(25000)/25000ms (Node) literals
// already summed to 45000-50000ms for the two sequential calls this file
// made per language, before this file even added a third (differential)
// call -- nearly double that then-budget on their own. Same class of gap
// already found and fixed elsewhere in this registry (see helpers.js's
// typeCheck() comment). A cold `import bs4` / `require("cheerio")` probe,
// or parsing a small inline HTML fixture, is not remotely close to even
// these reduced values in practice.
const PROBE_TIMEOUT_MS = 3000;
const RUN_TIMEOUT_MS = 9000;

/** Every string leaf (>=2 chars) inside a parsed JSON value -- candidate
 * "this text should appear verbatim in the source HTML" ground-truth hints. */
function stringLeaves(v, out) {
  out = out || [];
  if (typeof v === 'string') { if (v.trim().length >= 2) out.push(v); return out; }
  if (Array.isArray(v)) { v.forEach((x) => stringLeaves(x, out)); return out; }
  if (v && typeof v === 'object') { Object.keys(v).forEach((k) => stringLeaves(v[k], out)); return out; }
  return out;
}

/** Reverses every occurrence of every `needle` found inside a visible-text
 * run (`>...<`) of `html` -- tags/attributes untouched. Returns null if none
 * of the needles appear inside any text run at all (nothing to mutate). */
function mutateTextRuns(html, needles) {
  let foundAny = false;
  const mutated = html.replace(/>([^<]*)</g, (m, text) => {
    let t = text;
    for (const needle of needles) {
      if (t.includes(needle)) {
        foundAny = true;
        t = t.split(needle).join(needle.split('').reverse().join(''));
      }
    }
    return '>' + t + '<';
  });
  return foundAny ? mutated : null;
}

module.exports = {
  contract: 'html_extract',
  requires: [],

  verify(row, h) {
    const code = h.str(row, 'scraping_code');
    const html = h.str(row, 'mock_html_page');
    const expectedRaw = h.str(row, 'expected_extracted_data');
    if (!code || !html || !expectedRaw) {
      return { passed: false, detail: { reason: 'missing scraping_code, mock_html_page or expected_extracted_data' } };
    }

    const lang = String(h.str(row, 'language') || 'python').toLowerCase();
    const isPy = /^(py|python)/.test(lang);
    const runtime = isPy ? 'python3' : 'node';
    const langKey = isPy ? 'python' : 'javascript';

    // A FIXED marker string is forgeable via a shutdown hook neither
    // JS_PRELUDE nor PY_PRELUDE/PY_DRIVER cover: Node always fires
    // `process.on('exit', ...)` callbacks after every synchronous top-level
    // statement completes (JS_PRELUDE only traps process.exit/reallyExit,
    // never that event), and Python's `atexit.register(...)` callbacks run
    // at normal interpreter shutdown, strictly after PY_DRIVER's own
    // try/except SystemExit has already returned control to the interpreter.
    // Either one can register a callback that prints a second, later
    // '@@OUT ' line AFTER this file's own genuine result print -- and
    // h.lastMarked takes the LAST matching line, so the forged one wins.
    // Confirmed exploitable even past this file's own anti-hardcode
    // differential check (further down): the forged output can be made
    // conditional on an exact-literal match against the injected `html`
    // text (which the row author already knows verbatim, having authored
    // mock_html_page too), so the differential re-run against mutated HTML
    // produces a DIFFERENT forged answer instead of the same one, evading
    // the "identical output twice looks hardcoded" heuristic entirely. Fixed
    // the same way network_protocol_fsm's identical bug was: a per-run
    // random marker, generated fresh after the row was already authored, so
    // a forged line can never reproduce it.
    const mark = '@@OUT_' + crypto.randomBytes(12).toString('hex') + '_';

    function compare(stdout) {
      const actualRaw = h.lastMarked(String(stdout), mark);
      if (actualRaw === null) {
        return { passed: false, logs: 'scraping_code did not assign result', detail: { runtime } };
      }
      const a = h.jsonOf(actualRaw);
      const e = h.jsonOf(expectedRaw);
      const matched = a !== null && e !== null
        ? JSON.stringify(h.canonical(a)) === JSON.stringify(h.canonical(e))
        : h.looseEqual(actualRaw, expectedRaw);
      return {
        passed: matched,
        logs: matched ? '' : 'extracted ' + actualRaw.slice(0, 300) + ' but expected ' + expectedRaw.slice(0, 300),
        detail: {
          runtime,
          comparison: a !== null && e !== null ? 'json-structural' : 'text-normalized',
          actual: actualRaw.slice(0, 300),
          expected: expectedRaw.slice(0, 300),
        },
      };
    }

    // The verdict is written via a REAL FILE-DESCRIPTOR write, never
    // print()/process.stdout.write() -- CPython's print() resolves its
    // output stream from `sys.stdout` FRESH at every call (not bound at any
    // earlier reference-capture time), and Node's process.stdout.write is a
    // plain, reassignable property on a shared object console.log also
    // writes through -- so scraping_code reassigning `sys.stdout` (Python)
    // or `process.stdout.write` (JS) intercepts even this trailing line
    // regardless of the per-run marker's randomness. Confirmed exploitable
    // (the same class already found and fixed in compression's/
    // competitive_programming's harnesses); os.write(1, ...) / fs.writeSync
    // (1, ...) talk directly to the real OS file descriptor, bypassing that
    // object entirely.
    function buildScript(targetHtml) {
      if (isPy) {
        return [
          'import json, os',
          'html = json.loads(' + JSON.stringify(JSON.stringify(targetHtml)) + ')',
          code,
          'os.write(1, (' + JSON.stringify(mark) + ' + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
        ].join('\n');
      }
      return [
        'const cheerio = require("cheerio");',
        'const html = ' + JSON.stringify(targetHtml) + ';',
        'let result;',
        code,
        'require("fs").writeSync(1, ' + JSON.stringify(mark) + ' + JSON.stringify(result));',
      ].join('\n');
    }

    if (isPy) {
      if (!h.have('python3')) return { passed: false, runtimeUnavailable: true, logs: 'python3 unavailable', detail: { runtime } };
      // From the verified image only — no runtime install (no-network sandbox).
      const ok = h.run('python3', ['-c', 'import bs4'], { timeoutMs: PROBE_TIMEOUT_MS }).status === 0;
      if (!ok) return { passed: false, runtimeUnavailable: true, logs: 'beautifulsoup4 unavailable in this sandbox image', detail: { runtime: 'beautifulsoup4' } };
    } else {
      if (!h.have('node')) return { passed: false, runtimeUnavailable: true, logs: 'node unavailable', detail: { runtime } };
      // From the verified image only — no runtime install (no-network sandbox).
      const ok = h.run('node', ['-e', 'require("cheerio")'], { timeoutMs: PROBE_TIMEOUT_MS }).status === 0;
      if (!ok) return { passed: false, runtimeUnavailable: true, logs: 'cheerio unavailable in this sandbox image', detail: { runtime: 'cheerio' } };
    }

    // Runs scraping_code through h.runCode (PY_PRELUDE+PY_DRIVER /
    // JS_PRELUDE), not a bare h.run -- confirmed exploitable without this: a
    // bare run() lets scraping_code print a forged "@@OUT ..." marker line
    // and exit before the harness's own trailing print/write line ever runs
    // (h.lastMarked reads the LAST matching line, so the forged one wins).
    // In this specific harness the same submitter already controls
    // expected_extracted_data too, so exit-forgery alone grants no extra
    // capability beyond hardcoding (which the differential check below
    // catches independently) -- applied anyway for defense-in-depth and for
    // consistency with every other harness in this registry that runs
    // contributor code and its own verdict logic in one process.
    const r = h.runCode(langKey, buildScript(html), RUN_TIMEOUT_MS);
    if (r.unavailable) return { passed: false, runtimeUnavailable: true, logs: runtime + ' unavailable', detail: { runtime } };
    if (r.timedOut) return { passed: false, runtimeUnavailable: true, logs: 'scraping_code did not finish within the time budget', detail: { runtime } };
    if (!r.ok) return { passed: false, logs: String(r.stderr).slice(0, 1500), detail: { ranClean: false } };

    // rawStdout (uncapped), not the 32000-char-capped stdout: a genuinely
    // correct scrape whose extracted structure serializes past OUT_CAP would
    // otherwise have its trailing marker line truncated away and be scored a
    // false FAIL -- helpers.js's own OUT_CAP comment names this category as
    // still exposed to that, migrated here since this file is already being
    // touched for the marker fix above.
    const primary = compare(r.rawStdout != null ? r.rawStdout : r.stdout);
    if (!primary.passed) return primary;

    // Nothing above requires scraping_code to have ever consulted `html` at
    // all -- confirmed exploitable without this: a hardcoded
    // `result = <copy of expected_extracted_data>` satisfies every check so
    // far regardless of what mock_html_page actually says, and passes at the
    // execution_verified trust tier alongside genuine parsers. When at least
    // one string leaf of expected_extracted_data appears verbatim inside a
    // visible-text run of mock_html_page (true for essentially every genuine
    // text-extraction task in this dataset), mutate exactly that text and
    // re-run the SAME scraping_code against the mutated page: code that
    // actually parses `html` must now produce something different, since
    // the source text it reads changed. Code that hardcodes the expected
    // literal is html-independent by construction and reproduces the
    // identical answer regardless -- a structural-equality match here is
    // direct, mechanical proof of that, not a guess.
    //
    // Skipped entirely (no verdict either way, no false-reject risk) when no
    // expected leaf is text-derived at all (e.g. the task extracts a count
    // or a boolean, which a text-only mutation can't speak to), or when the
    // only findable leaf(s) happen to be palindromic and the "mutation"
    // leaves the HTML byte-for-byte unchanged.
    //
    // Known, accepted residual: a row whose mock_html_page and
    // expected_extracted_data already disagree about basic facts (no leaf
    // of the latter appears anywhere in the former) leaves no live
    // ground-truth text for this check to grab onto either -- a hardcoded
    // stub on such a row still passes. That is a data-quality defect in the
    // row itself, not a code-behavior question this mechanism can verify;
    // closing it would need the harness to independently judge whether
    // mock_html_page and expected_extracted_data describe the same thing at
    // all, which is a semantic question outside what a differential
    // execution check can decide.
    const expectedParsed = h.jsonOf(expectedRaw);
    const leaves = expectedParsed !== null ? stringLeaves(expectedParsed) : (expectedRaw.trim().length >= 2 ? [expectedRaw] : []);
    const mutatedHtml = leaves.length ? mutateTextRuns(html, leaves) : null;
    if (mutatedHtml && mutatedHtml !== html) {
      const rMut = h.runCode(langKey, buildScript(mutatedHtml), RUN_TIMEOUT_MS);
      if (!rMut.unavailable && !rMut.timedOut && rMut.ok) {
        const mutCompare = compare(rMut.rawStdout != null ? rMut.rawStdout : rMut.stdout);
        if (mutCompare.passed) {
          return {
            passed: false,
            logs: 'scraping_code produced the SAME extracted result even after the source text it should be reading from was altered -- this looks hardcoded rather than genuinely parsed from mock_html_page',
            detail: { runtime, hardcodedSuspected: true },
          };
        }
      }
    }

    return primary;
  },
};
