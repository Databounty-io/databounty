/**
 * fixture-accuracy check — a structurally narrower contract than this
 * category's name suggests, and deliberately so: every row's
 * `notebook_cells` only creates a data fixture (matching what
 * `dataset_fixture_ref` describes) and never actually performs the analysis
 * `expected_artifacts` describes (fitting a model, writing totals.csv,
 * computing stats.csv, ...). None of the 25 reference rows produce the
 * artifact they claim to — this is true of the labeled-valid rows too, not
 * just the flawed ones — so `expected_artifacts` cannot be mechanically
 * checked from what this dataset provides at all.
 *
 * What IS checkable, and what this harness verifies: does
 * `dataset_fixture_ref`'s claim about the fixture (row count) match what
 * `notebook_cells` actually produces? One of the five deliberately-flawed
 * rows is exactly this mismatch (claims 100 rows, the code creates 3); the
 * other four flaws are about the unverifiable `expected_artifacts` claim
 * and will not be caught here — reported honestly rather than guessed at.
 *
 * The row-count claim is re-derived by handing the produced CSV to pandas
 * itself (a real RFC4180 parser), not by counting '\n' bytes in Node — a
 * naive newline count is inflated by an embedded newline inside a quoted
 * text field, AND is trivially gamed by appending garbage lines after a
 * genuine, correctly-sized file (confirmed exploitable: a 3-row fixture
 * padded with 97 blank comma-lines "passed" a naive count as 100 rows).
 * Re-parsing with pandas closes the accidental case outright, and closes one
 * shape of deliberate gaming: appended garbage with MORE fields than the
 * real header (e.g. "x,y,z" against a 2-column file) now raises a genuine
 * pandas ParserError instead of silently inflating the count. It does NOT
 * close every shape: pandas' C parser is lenient about rows with FEWER
 * fields than the header (missing trailing fields are NaN-padded, not
 * rejected), so a garbage line with the right-or-fewer comma count (a bare
 * "," for a 2-column file, or even a bare blank-ish line) still parses as an
 * additional row and still inflates the count. Fully closing that residual
 * would need content-plausibility checking against dataset_fixture_ref's
 * prose, the same kind of judgment call already deferred to LLM/human audit
 * for expected_artifacts.
 */
'use strict';

/** Recursive .csv search: a submission writing its fixture into a
 * subdirectory (an ordinary organizational habit, e.g. os.makedirs('output')
 * then to_csv('output/data.csv')) previously produced no matches at all from
 * a single, non-recursive readdirSync, and was rejected with a misleading
 * "created no .csv file" message despite being entirely correct. */
/** True if any line of `code` shaped like an import statement
 * ("import X"/"import X, Y"/"from X import Y") mentions one of `libs` as a
 * whole word anywhere on that line -- a plain `/\bimport\s+numpy\b/` misses
 * Python's ordinary comma-joined multi-module form ("import os, numpy as
 * np"), where "import" is directly followed by "os", not "numpy". */
function importsAnyOf(code, libs) {
  return String(code).split('\n').some((line) => {
    if (!/^\s*(import|from)\s+/.test(line)) return false;
    return libs.some((lib) => new RegExp('\\b' + lib + '\\b').test(line));
  });
}

function findCsvFiles(h, dir, base) {
  base = base || dir;
  let out = [];
  for (const name of h.fs.readdirSync(dir)) {
    const full = h.path.join(dir, name);
    // lstatSync (never follows symlinks) rather than statSync: notebook_cells
    // is real contributor Python with full stdlib access, executed BEFORE
    // this scan runs, and can create a symlink here (e.g. os.symlink('.',
    // 'loop')) before this recursive walk ever sees it. statSync on a
    // self-referencing directory symlink recurses into the same directory
    // forever (uncaught RangeError); on a dangling symlink it throws ENOENT.
    // Neither is exploitable as a false pass (both propagate out of verify()
    // as a harnessFault, not a contributor-blamed wrong-answer), but treating
    // any symlink as neither a directory nor a .csv file (skip it outright)
    // avoids the crash entirely rather than merely failing safe from one.
    let st;
    try { st = h.fs.lstatSync(full); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out = out.concat(findCsvFiles(h, full, base));
    else if (name.toLowerCase().endsWith('.csv')) out.push(h.path.relative(base, full));
  }
  return out;
}

module.exports = {
  contract: 'fixture-accuracy',
  requires: ['python3'],

  verify(row, h) {
    const cells = h.str(row, 'notebook_cells');
    const fixtureRef = h.str(row, 'dataset_fixture_ref');
    if (!cells || !fixtureRef) return { passed: false, detail: { reason: 'missing notebook_cells or dataset_fixture_ref' } };
    if (!h.have('python3')) return { passed: false, runtimeUnavailable: true, logs: 'python3 not available', detail: {} };

    // Cheap but load-bearing: without this, code that never touches
    // pandas/numpy/scikit-learn at all (plain open()/write() in a loop) can
    // still satisfy the row-count check below with zero relationship to
    // genuine data-science fixture generation, despite schema.json's
    // executionEnv committing to "python3 (pandas/numpy/scikit-learn)".
    // Confirmed exploitable against the prior version of this file.
    if (!importsAnyOf(cells, ['pandas', 'numpy', 'sklearn'])) {
      return { passed: false, logs: 'notebook_cells does not import pandas, numpy, or scikit-learn — not genuine data-science fixture generation', detail: {} };
    }

    // pandas is only guaranteed at image BUILD time (setup.sh); nothing
    // previously checked it at request time, so if it ever regressed out of
    // the image a row would fail with a raw ImportError traceback -- scored
    // as a genuine code failure instead of a clean runtimeUnavailable.
    // Explicit timeouts on all three probes below: previously unguarded
    // (inherited whatever run()'s own shared default fell back to), and
    // summed with this file's own main-run/rowcount calls further down,
    // could exceed the outer sandbox command budget deployed at the time
    // (30000ms; raised to 120000ms as of the current deploy,
    // infra/terraform/ssm.tf) on their own -- the same class of gap already
    // found and fixed for individual timeouts throughout this registry's
    // audit. Values are NOT the generic lightweight-probe constant (3000ms)
    // used elsewhere for a quick "import jwt"/"require(graphql)" check --
    // measured directly on this dev box: a cold "import pandas" alone
    // reliably took 2700-3300ms, and "import sklearn" (which pulls in scipy)
    // took 5600-11500ms, an order of magnitude heavier than a lightweight
    // library check. A too-short timeout here fails closed to a clean
    // runtimeUnavailable (routes to human review), never a wrong verdict --
    // safe, but still worth sizing realistically rather than guessing.
    const pandasOk = h.run('python3', ['-c', 'import pandas'], { timeoutMs: 6000 }).status === 0;
    if (!pandasOk) return { passed: false, runtimeUnavailable: true, logs: 'pandas unavailable in this sandbox image', detail: { runtime: 'pandas' } };
    // numpy/scikit-learn are schema-declared (schema.json's executionEnv)
    // and genuinely used by several reference rows, but were never probed
    // at all -- checked only when a row's own code actually imports them, so
    // a row that only needs pandas is never blocked by an unrelated,
    // unneeded dependency happening to be missing.
    if (importsAnyOf(cells, ['numpy']) && h.run('python3', ['-c', 'import numpy'], { timeoutMs: 3000 }).status !== 0) {
      return { passed: false, runtimeUnavailable: true, logs: 'numpy unavailable in this sandbox image', detail: { runtime: 'numpy' } };
    }
    // Cold sklearn imports measured up to 11.5s; 8s turns a healthy but
    // warming sandbox into a misleading runtimeUnavailable verdict.
    if (importsAnyOf(cells, ['sklearn']) && h.run('python3', ['-c', 'import sklearn'], { timeoutMs: 15000 }).status !== 0) {
      return { passed: false, runtimeUnavailable: true, logs: 'scikit-learn unavailable in this sandbox image', detail: { runtime: 'sklearn' } };
    }

    // Thousands separators ("1,000 rows") are an ordinary way to phrase this
    // and were silently mis-parsed: \d+ matched only the trailing "000"
    // after skipping "1,", parsing to 0 and producing a misleading "claims 0
    // rows" message that looks like a real large mismatch.
    const claimedRowsMatch = fixtureRef.match(/((?:\d{1,3}(?:,\d{3})+|\d+))\s*rows?/i);
    if (!claimedRowsMatch) {
      return { passed: false, runtimeUnavailable: true, logs: 'dataset_fixture_ref does not state a row count to check against', detail: { fixtureRef: fixtureRef.slice(0, 150) } };
    }
    const claimedRows = parseInt(claimedRowsMatch[1].replace(/,/g, ''), 10);

    const d = h.workdir();
    const f = h.path.join(d, 'nb.py');
    h.fs.writeFileSync(f, cells);
    // Was 30000ms -- equal to the ENTIRE outer sandbox command budget
    // deployed at the time (30000ms; raised to 120000ms as of the current
    // deploy, infra/terraform/ssm.tf) by itself, leaving
    // zero margin for the three probes above or the rowcount check below.
    // Reduced to 8000ms to comfortably fit the whole sequence -- but that
    // fixed value ignored the SAME import costs this file's own probes above
    // already measured and sized for: a cold "import sklearn" alone can take
    // up to 11500ms, and "import pandas" up to 3300ms, sequentially, BEFORE
    // notebook_cells' own fixture-generation code ever runs. A perfectly
    // correct row importing both (an ordinary, even encouraged combination
    // per the importsAnyOf gate above) could need up to ~14800ms of import
    // time alone under a cold sandbox -- already exceeding the old 8000ms
    // budget with zero fixture-generation work done yet, misclassifying a
    // correct submission as runtimeUnavailable. Sized per-row to what it
    // actually needs: sklearn's own heavier, scipy-pulling import gets the
    // larger budget; there is enormous headroom to do this safely (every
    // timeout in this file, even at the new values, sums to well under half
    // of the 120000ms outer sandbox budget).
    const r = h.run('python3', [f], { cwd: d, timeoutMs: importsAnyOf(cells, ['sklearn']) ? 20000 : 12000 });
    if (r.timedOut) {
      return { passed: false, runtimeUnavailable: true, logs: 'notebook_cells did not finish within the time budget', detail: {} };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr || '').slice(0, 1200), detail: { ranClean: false } };
    }

    const csvFiles = findCsvFiles(h, d);
    if (csvFiles.length === 0) {
      return { passed: false, logs: 'notebook_cells ran but created no .csv file to check against dataset_fixture_ref', detail: { files: h.fs.readdirSync(d) } };
    }
    // dataset_fixture_ref names the file; match case-insensitively (the
    // extraction regex is itself case-insensitive, but the old lookup was a
    // case-SENSITIVE includes() against it -- a real, if narrow, mismatch).
    // With more than one CSV and no unambiguous named match, fail closed
    // (runtimeUnavailable) rather than guessing csvFiles[0]: directory
    // enumeration order is not guaranteed across filesystems/OSes, so a
    // silent guess could pick the wrong file on the real sandbox even when
    // it happened to pick right in local testing.
    const namedFile = fixtureRef.match(/([\w.-]+\.csv)/i);
    let targetFile;
    if (namedFile) {
      const wanted = namedFile[1].toLowerCase();
      const matches = csvFiles.filter((name) => name.toLowerCase() === wanted || h.path.basename(name).toLowerCase() === wanted);
      if (matches.length === 1) targetFile = matches[0];
      else if (csvFiles.length === 1) targetFile = csvFiles[0];
    } else if (csvFiles.length === 1) {
      targetFile = csvFiles[0];
    }
    if (!targetFile) {
      return { passed: false, runtimeUnavailable: true, logs: 'multiple CSV files exist and dataset_fixture_ref\'s named file could not be unambiguously matched', detail: { csvFiles } };
    }

    // Re-derive the row count through pandas itself rather than a Node-side
    // '\n' split: RFC4180-aware (an embedded newline inside a quoted text
    // field no longer inflates the count), and no longer satisfiable by
    // blind newline-padding after a correctly-sized file (see file header).
    const targetPath = h.path.join(d, targetFile);
    const countScript = [
      'import pandas as pd, sys, json',
      'try:',
      '    print(json.dumps({"ok": True, "rows": len(pd.read_csv(sys.argv[1]))}))',
      'except Exception as e:',
      '    print(json.dumps({"ok": False, "error": str(e)}))',
    ].join('\n');
    const countFile = h.path.join(d, '_rowcount.py');
    h.fs.writeFileSync(countFile, countScript);
    const cr = h.run('python3', [countFile, targetPath], { cwd: d, timeoutMs: 5000 });
    if (cr.status !== 0) {
      return { passed: false, runtimeUnavailable: true, logs: 'failed to inspect the produced CSV with pandas', detail: { stderr: String(cr.stderr || '').slice(0, 500) } };
    }
    const countResult = h.jsonOf(String(cr.stdout).trim());
    if (!countResult || countResult.ok !== true) {
      return { passed: false, logs: targetFile + ' could not be parsed as a valid CSV: ' + (countResult && countResult.error), detail: { targetFile } };
    }
    // Assumes a header row, matching this dataset's own convention
    // (pandas.to_csv's default). A submission writing header=False/None
    // undercounts by exactly one here, same residual as before this fix —
    // low-value/high-brittleness to detect from source text, not chased.
    const actualRows = countResult.rows;

    const passed = actualRows === claimedRows;
    return {
      passed,
      logs: passed ? '' : ('dataset_fixture_ref claims ' + claimedRows + ' rows but ' + targetFile + ' actually has ' + actualRows),
      detail: {
        claimedRows, actualRows, targetFile,
        note: 'expected_artifacts (model/derived-file claims) is not verified — no row in this dataset actually produces it',
      },
    };
  },
};
