/**
 * The single entrypoint executed inside the sandbox.
 *
 * The loader inlines helpers.js and the selected harness.js into one uploaded
 * script, then calls main() here. Keeping one entrypoint means the API never
 * needs to know anything about a category beyond its id.
 *
 * Emits exactly one JSON line carrying a `passed` key, which is what the
 * provider-side parser looks for. A harness that throws is reported as a harness
 * fault, NOT as a failing submission — those are different things and conflating
 * them would blame a contributor for our bug.
 *
 * Plain CommonJS, no backticks: this file is embedded in a template literal.
 */
'use strict';

function main(harness, helpers, row) {
  // A declared-but-missing toolchain routes to human audit rather than recording
  // a false failure. A missing runtime is our problem, not the submission's.
  const requires = Array.isArray(harness.requires) ? harness.requires : [];
  for (const bin of requires) {
    if (!helpers.have(bin)) {
      return {
        passed: false,
        score: null,
        runtimeUnavailable: true,
        logs: bin + ' is not available in this sandbox',
        detail: { runtime: bin, contract: harness.contract || null },
      };
    }
  }

  let out;
  try {
    out = harness.verify(row, helpers);
  } catch (e) {
    return {
      passed: false,
      score: null,
      logs: 'harness fault: ' + (e && e.message ? e.message : String(e)),
      detail: { harnessFault: true, contract: harness.contract || null },
    };
  }

  if (!out || typeof out !== 'object' || typeof out.passed !== 'boolean') {
    return {
      passed: false,
      score: null,
      logs: 'harness returned no verdict',
      detail: { harnessFault: true, contract: harness.contract || null },
    };
  }

  return {
    passed: out.passed,
    score: typeof out.score === 'number' ? out.score : out.passed ? 1 : 0,
    testsRun: typeof out.testsRun === 'number' ? out.testsRun : undefined,
    brokenCodeFailedTests: out.brokenCodeFailedTests,
    runtimeUnavailable: out.runtimeUnavailable || undefined,
    logs: typeof out.logs === 'string' ? out.logs : '',
    detail: Object.assign({ contract: harness.contract || null }, out.detail || {}),
  };
}

module.exports = { main };
