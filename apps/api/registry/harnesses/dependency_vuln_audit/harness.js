/**
 * claim-polarity-vs-live-tool-output — write the manifest under its real
 * ecosystem's tool and run a real vulnerability audit against the live
 * registry/advisory database (npm audit hits registry.npmjs.org's advisory
 * data, pip-audit hits PyPI/OSV.dev — both need outbound network access in
 * the sandbox, same precedent as the sibling build_dependency_resolution
 * harness). expected_audit_findings is prose ("one or more high-severity
 * vulnerabilities... recommended upgrade...") and not machine-diffable
 * against raw tool JSON, so the only mechanical signal used is binary
 * polarity: did the real tool report zero findings or >=1 findings for this
 * exact package@version, compared against whether expected_audit_findings
 * asserts "no known vulnerabilities found" or asserts findings exist.
 *
 * The manifest's real ecosystem is derived independently from
 * project_manifest itself (JSON-with-dependencies => npm, "pkg==version"
 * line => pip) rather than trusted from audit_tool — a row can claim
 * "pip-audit" against an npm-shaped manifest (impossible: pip-audit cannot
 * resolve a JS package from PyPI), which is caught as a hard mismatch
 * regardless of whether the vulnerability claim about the package is
 * otherwise true.
 */
'use strict';

// The pip branch anchors pkg/version to a strict charset via pipMatch's own
// regex before ever writing them to disk. The npm branch used to have no
// equivalent — pkg/version came straight from the contributor's
// project_manifest.dependencies with zero validation, and npm's own
// "version" field accepts non-registry specifiers (git+https://..., a
// tarball URL, file:...) that `npm install` will actually try to fetch.
// This category's network exception is scoped (per registry/README.md) to
// npm-audit/pip-audit querying live advisory data at their real registries
// — not to letting a submission redirect the sandbox's egress anywhere it
// wants. Reject anything that isn't a bare package name / plain semver-ish
// range before it ever reaches package.json.
const NPM_PKG_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_VERSION_SPEC_RE = /^[A-Za-z0-9.\-^~<>=|* ]+$/;

module.exports = {
  contract: 'claim-polarity-vs-live-tool-output',
  requires: [],

  verify(row, h) {
    const manifest = h.str(row, 'project_manifest');
    const tool = h.str(row, 'audit_tool').trim().toLowerCase();
    const knownVuln = h.str(row, 'known_vulnerable_dependency');
    const claim = h.str(row, 'expected_audit_findings');

    if (!manifest || !tool || !claim) {
      return { passed: false, detail: { reason: 'missing project_manifest, audit_tool, or expected_audit_findings' } };
    }

    // Same "FLAWED:" convention as elsewhere in this dataset family, marking
    // a deliberately-wrong reference field. Searched case-insensitively
    // anywhere in either prose field, since this dataset places it in
    // expected_audit_findings on some rows and known_vulnerable_dependency
    // on another.
    if (/FLAWED:/i.test(claim) || /FLAWED:/i.test(knownVuln)) {
      return { passed: false, logs: 'reference field is marked FLAWED', detail: { flawedReference: true } };
    }

    // Derive the manifest's real ecosystem from its own shape, independent
    // of what audit_tool claims.
    const parsedJson = h.jsonOf(manifest);
    const isNpmShaped = !!(parsedJson && typeof parsedJson === 'object' && parsedJson.dependencies && typeof parsedJson.dependencies === 'object');
    const pipMatch = /^\s*([A-Za-z0-9_.-]+)\s*==\s*([A-Za-z0-9_.!+-]+)\s*$/.exec(manifest);
    const isPipShaped = !!pipMatch;

    let ecosystem = null;
    if (isNpmShaped) ecosystem = 'npm';
    else if (isPipShaped) ecosystem = 'pip';

    if (!ecosystem) {
      return { passed: false, logs: 'project_manifest is neither npm-shaped ({"dependencies":{...}}) nor a pip "pkg==version" line', detail: { manifest } };
    }

    const toolWantsNpm = tool === 'npm audit';
    const toolWantsPip = tool === 'pip-audit';
    if (!toolWantsNpm && !toolWantsPip) {
      return { passed: false, logs: 'unrecognized audit_tool: ' + tool, detail: { tool } };
    }
    if ((toolWantsNpm && ecosystem !== 'npm') || (toolWantsPip && ecosystem !== 'pip')) {
      return {
        passed: false,
        logs: 'audit_tool (' + tool + ') does not match project_manifest\'s real ecosystem (' + ecosystem + ') — the tool has no mechanism to audit a manifest from a different package ecosystem',
        detail: { tool, ecosystem, manifest },
      };
    }

    // Broadened beyond one literal phrase, but still a closed set: silently
    // guessing a polarity from an unrecognized-shape claim is worse than
    // failing closed, so anything matching NEITHER pattern below (or,
    // contradictorily, both) is reported as inconclusive rather than
    // defaulting to "vulnerabilities claimed" the way a bare `!claimsNone`
    // used to.
    // The earlier broadening still fell over on this dataset's own dominant
    // phrasings: CLAIMS_NONE's adjective slot only accepted a fixed
    // known/security order (breaking on "critical"/"high-severity" in that
    // position), and CLAIMS_SOME's verb list omitted "reported" entirely --
    // the verb this dataset actually uses in every "vulnerabilities found"
    // row ("one or more vulnerabilities REPORTED for X"). Together those
    // gaps misclassified the large majority of this category's own reference
    // rows as ambiguous before ever reaching npm/pip-audit.
    //
    // NOUN: "advisory/advisories" recognized as an equivalent noun to
    // "vulnerability/vulnerabilities" -- confirmed exploitable without this:
    // this dataset's own dominant phrasing for a real finding is "pip-audit
    // reports a moderate-severity ReDoS advisory for X, fixed in version Y",
    // with the word "vulnerability" absent entirely, misclassifying every
    // one of those rows as ambiguous rather than the clear "findings exist"
    // claim it actually is.
    const NOUN = '(?:vulnerabilit(?:y|ies)|advisor(?:y|ies))';
    const NOUN_STEM = '(?:vulnerabilit|advisor)';
    // A COUNT must start with a nonzero digit -- confirmed exploitable
    // without this: bare `\d+` matches the digit "0" exactly as it matches
    // any other count, so "0 vulnerabilities" (a NONE claim) tripped the
    // SAME positive-count branch as "3 vulnerabilities" (a SOME claim),
    // silently misreading a negation as a positive claim.
    const COUNT = '(?:[1-9]\\d*)';
    // CLAIMS_NONE_RE: a denial word within a short span of the finding
    // noun, with no fixed adjective slots -- "critical"/"high-severity"/
    // "known"/"security" can all sit freely in between. The literal digit
    // "0" is recognized alongside the word "zero" for the same reason COUNT
    // above excludes it from the positive branches.
    const CLAIMS_NONE_RE = new RegExp(
      '\\bno\\b(?:\\s+[a-z][a-z-]*){0,4}?\\s+(?:' + NOUN + '|issues?|cves?)\\b' +
      '|\\bzero\\b(?:\\s+[a-z][a-z-]*){0,3}?\\s+' + NOUN_STEM +
      // The digit "0" gets a TIGHT window (immediately, or through the
      // single word "known") rather than "zero"'s wider 0-3-filler-word
      // tolerance -- confirmed exploitable with the wide window: a bare "0"
      // collides with the trailing zero of an ordinary version number
      // (e.g. "axios@0.21.0 in the npm advisory database" has a
      // word-bounded "0" a few words before "advisory"), which the wide
      // window misread as "0 ... advisory" i.e. a NONE claim on a row that
      // was actually asserting vulnerabilities exist. "0 known
      // vulnerabilities"/"0 vulnerabilities" -- the only real phrasing this
      // needs to catch -- always has the noun immediately adjacent.
      '|\\b0\\s+(?:known\\s+)?' + NOUN_STEM +
      '|\\bclean\\s+(?:audit|scan|result)\\b' +
      '|\\bnot\\s+aware\\s+of\\s+any\\b' +
      '|\\bwithout\\s+any\\b(?:\\s+[a-z][a-z-]*){0,3}?\\s+' + NOUN_STEM,
      'i'
    );
    // CLAIMS_SOME_RE: tolerant of an auxiliary verb ("are"/"were"/"has been")
    // and includes "reported"/"noted"/"flagged" alongside the original verbs.
    // The dedicated report(s|ed) branch covers "X reports a moderate-severity
    // ReDoS advisory for Y" -- a finding-noun preceded by a determiner/count
    // and any number of adjectives, which none of the other branches (all
    // anchored to a specific verb immediately after the noun, or to
    // has/contains/a bare count) were shaped to catch.
    const CLAIMS_SOME_RE = new RegExp(
      '\\b' + NOUN + '\\s+(?:(?:are|is|were|was|have\\s+been|has\\s+been)\\s+)?(?:exist(?:s)?|found|present|identified|detected|reported|noted|flagged)\\b' +
      '|\\breport(?:s|ed)\\s+(?:a|an|one or more|' + COUNT + ')\\s+(?:[a-z][a-z-]*\\s+){0,4}?' + NOUN + '\\b' +
      '|\\bhas\\s+(?:a|one or more|' + COUNT + ')\\s+(?:known\\s+)?' + NOUN_STEM +
      '|\\bcontains?\\s+(?:a|one or more|' + COUNT + ')\\s+(?:known\\s+)?' + NOUN_STEM +
      '|' + COUNT + '\\s+(?:known\\s+)?' + NOUN_STEM +
      '|\\bcve[-\\s]?\\d' +
      '|\\bhigh[-\\s]severity\\b' +
      '|\\bcritical\\s+(?:severity|' + NOUN + ')',
      'i'
    );
    // A bare CLAIMS_SOME_RE has no negation-awareness, so "no [x] vulnerabilities
    // found" trips BOTH regexes on the same clause (the "vulnerabilities found"
    // tail). Negation wins unless a genuinely distinct positive signal (a
    // count, a CVE id, or "has/contains/reports a vulnerability" phrasing) is
    // also present elsewhere in the text.
    const RESIDUAL_POSITIVE_RE = new RegExp(
      COUNT + '\\s+(?:known\\s+)?' + NOUN_STEM +
      '|\\bcve[-\\s]?\\d' +
      '|\\breport(?:s|ed)\\s+(?:a|an|one or more|' + COUNT + ')\\s+(?:[a-z][a-z-]*\\s+){0,4}?' + NOUN + '\\b' +
      '|\\bhas\\s+(?:a|one or more|' + COUNT + ')\\s+(?:known\\s+)?' + NOUN_STEM +
      '|\\bcontains?\\s+(?:a|one or more|' + COUNT + ')\\s+(?:known\\s+)?' + NOUN_STEM,
      'i'
    );
    const noneCue = CLAIMS_NONE_RE.test(claim);
    const someCue = CLAIMS_SOME_RE.test(claim);
    const claimsNoneMatch = noneCue && (!someCue || !RESIDUAL_POSITIVE_RE.test(claim));
    const claimsSomeMatch = someCue && !claimsNoneMatch;
    if (claimsNoneMatch === claimsSomeMatch) {
      return {
        passed: false,
        logs: 'could not determine a clear "vulnerabilities exist" vs "none found" claim from expected_audit_findings: "' + claim.slice(0, 200) + '"',
        detail: { claim: claim.slice(0, 300), ambiguous: true },
      };
    }
    const claimsNone = claimsNoneMatch;

    if (ecosystem === 'npm') {
      const bin = 'npm';
      if (!h.have(bin)) return { passed: false, runtimeUnavailable: true, logs: bin + ' not available', detail: {} };
      const deps = parsedJson.dependencies;
      const pkgNames = Object.keys(deps);
      if (pkgNames.length !== 1) {
        return { passed: false, logs: 'expected exactly one dependency in manifest, found ' + pkgNames.length, detail: { deps } };
      }
      const pkg = pkgNames[0];
      const version = String(deps[pkg]);
      if (!NPM_PKG_NAME_RE.test(pkg) || !NPM_VERSION_SPEC_RE.test(version) || version.length > 100) {
        return {
          passed: false,
          logs: 'project_manifest dependency is not a plain npm package name/version specifier: ' + pkg + '@' + version,
          detail: { pkg, version, rejected: 'unsafe-npm-specifier' },
        };
      }

      const d = h.workdir();
      const pkgJson = { name: 'audit-check', version: '1.0.0', private: true, dependencies: { [pkg]: version } };
      h.fs.writeFileSync(h.path.join(d, 'package.json'), JSON.stringify(pkgJson, null, 2));

      // FAST, CLEAN no-egress fail. npm install/audit reach registry.npmjs.org
      // for the advisory data; under the production deny-all egress posture the
      // DNS/connect otherwise HANGS the whole ~90s install budget and the outer
      // sandbox timeout tears the VM down before any verdict is emitted — the
      // execution stage then records NO verdict (wasted VM time + an ambiguous
      // result) instead of an honest runtimeUnavailable. A 4s TCP preflight
      // turns that into an immediate, correct human-audit route.
      const reach = h.run('node', ['-e', 'const s=require("net").connect({host:"registry.npmjs.org",port:443});s.setTimeout(4000);s.on("connect",()=>{s.destroy();process.exit(0)});s.on("timeout",()=>process.exit(1));s.on("error",()=>process.exit(1));'], { cwd: d, timeoutMs: 5000 });
      if (reach.status !== 0) {
        return { passed: false, runtimeUnavailable: true, logs: 'registry.npmjs.org unreachable (sandbox egress blocked); a live-advisory audit cannot run — routed to human audit', detail: { pkg, version, reason: 'no_egress' } };
      }

      // --fetch-retries=0 + a short fetch-timeout so a genuine registry outage
      // (as opposed to full block, caught above) also fails in seconds instead
      // of npm's default multi-minute exponential backoff. install+audit
      // timeouts (20s each) are sized to stay well under the outer sandbox
      // command budget (EXECUTION_RUNNER_TIMEOUT_MS, 120s by default) alongside
      // the reach preflight -- the pair used to be 60s each, which alone
      // already equaled or exceeded the entire outer budget: any row slower
      // than instant had its whole sandbox command killed by the OUTER
      // timeout before this harness ever got to emit its own runtimeUnavailable
      // verdict, landing on a less-informative "all_providers_failed" instead.
      const npmEnv = { npm_config_fetch_retries: '0', npm_config_fetch_timeout: '15000', npm_config_fetch_retry_maxtimeout: '15000' };
      const install = h.run('npm', ['install', '--no-audit', '--no-fund', '--package-lock-only'], { cwd: d, timeoutMs: 20000, env: npmEnv });
      // Any non-zero exit routes to runtimeUnavailable, not just the narrow
      // network-error stderr shapes below -- permission errors, a corrupted
      // npm cache, or a differently-worded registry failure across npm
      // versions would otherwise fall through into `npm audit` against a
      // directory with no real lockfile, relying entirely on the downstream
      // "did audit produce parseable JSON" check to catch it indirectly.
      if (install.timedOut || install.status !== 0) {
        const isNetworky = /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|getaddrinfo/i.test(install.stderr || '');
        return {
          passed: false,
          runtimeUnavailable: true,
          logs: (isNetworky ? 'npm install could not reach the registry: ' : 'npm install failed: ') + String(install.stderr || '').slice(0, 400),
          detail: { pkg, version },
        };
      }

      // npm audit --json can easily exceed h.run's shared 8000-char stdout
      // cap (real transitive-vulnerability trees run well past 10KB), which
      // truncates the JSON mid-object and makes it unparseable. Redirect the
      // full output to a file instead, and only pull a tiny {total, parsed}
      // summary back through the captured stdout so the cap never bites.
      h.fs.writeFileSync(h.path.join(d, 'extract-npm-audit.js'), [
        "const fs = require('fs');",
        "let j = null;",
        "try { j = JSON.parse(fs.readFileSync('.audit-out.json', 'utf8')); } catch (e) {}",
        "let total = null;",
        "if (j && j.metadata && j.metadata.vulnerabilities) {",
        "  total = Object.values(j.metadata.vulnerabilities).reduce((a, b) => a + (Number(b) || 0), 0);",
        "} else if (j && j.vulnerabilities) {",
        "  total = Object.keys(j.vulnerabilities).length;",
        "}",
        "console.log(JSON.stringify({ total: total, parsed: !!j }));",
      ].join('\n'));
      const audit = h.run('bash', ['-c', 'npm audit --json > .audit-out.json 2>.audit-err.log; node extract-npm-audit.js'], { cwd: d, timeoutMs: 20000, env: npmEnv });
      const summary = h.jsonOf(audit.stdout);
      if (!summary || !summary.parsed || summary.total === null) {
        return { passed: false, runtimeUnavailable: true, logs: 'npm audit did not produce parseable JSON: ' + String(audit.stdout || audit.stderr).slice(0, 400), detail: { pkg, version } };
      }
      const total = summary.total;
      const foundVulns = total > 0;
      const passed = foundVulns === !claimsNone;

      return {
        passed,
        logs: passed ? '' : ('expected ' + (claimsNone ? 'no vulnerabilities' : 'vulnerabilities') + ' but npm audit ' + (foundVulns ? 'found ' + total : 'found none') + ' for ' + pkg + '@' + version),
        detail: { ecosystem, pkg, version, claimsNone, foundVulns, total, installExit: install.status, auditExit: audit.status },
      };
    }

    // pip path
    const bin = 'pip-audit';
    if (!h.have(bin)) return { passed: false, runtimeUnavailable: true, logs: bin + ' not available', detail: {} };
    const pkg = pipMatch[1];
    const version = pipMatch[2];

    const d = h.workdir();
    h.fs.writeFileSync(h.path.join(d, 'requirements.txt'), manifest.trim() + '\n');

    // Same fast, clean no-egress fail as the npm path: pip-audit reaches PyPI
    // and OSV.dev, which hang under the deny-all egress posture. Preflight both
    // (either being reachable is enough to attempt the audit) so a blocked
    // sandbox routes to human audit in ~4s instead of exhausting the budget.
    const pipReach = h.run('node', ['-e', 'const net=require("net");let done=false;const fin=c=>{if(!done){done=true;process.exit(c)}};let pending=2;const t=(host)=>{const s=net.connect({host,port:443});s.setTimeout(4000);s.on("connect",()=>{s.destroy();fin(0)});s.on("timeout",()=>{if(--pending===0)fin(1)});s.on("error",()=>{if(--pending===0)fin(1)})};t("pypi.org");t("api.osv.dev");'], { cwd: d, timeoutMs: 5000 });
    if (pipReach.status !== 0) {
      return { passed: false, runtimeUnavailable: true, logs: 'PyPI/OSV.dev unreachable (sandbox egress blocked); a live-advisory audit cannot run — routed to human audit', detail: { pkg, version, reason: 'no_egress' } };
    }

    // Same output-cap hazard as npm audit above (pip-audit's JSON, one
    // object per resolved dependency plus transitive deps, also routinely
    // exceeds h.run's 8000-char stdout cap) — redirect to a file and pull
    // back only a small summary.
    h.fs.writeFileSync(h.path.join(d, 'extract-pip-audit.js'), [
      "const fs = require('fs');",
      "let j = null;",
      "try { j = JSON.parse(fs.readFileSync('.pip-audit-out.json', 'utf8')); } catch (e) {}",
      "let total = null;",
      "if (j) {",
      "  const depsArr = Array.isArray(j) ? j : (Array.isArray(j.dependencies) ? j.dependencies : null);",
      "  if (depsArr) total = depsArr.reduce((a, dep) => a + (Array.isArray(dep.vulns) ? dep.vulns.length : 0), 0);",
      "}",
      "console.log(JSON.stringify({ total: total, parsed: !!j }));",
    ].join('\n'));
    // 35s, not 90s: sized to stay well under the outer sandbox command
    // budget (EXECUTION_RUNNER_TIMEOUT_MS, 120s by default) alongside the
    // reach preflight and the error-path tail read below -- 90s alone
    // already exceeded the entire outer budget, so any row slower than
    // instant had its whole sandbox command killed by the OUTER timeout
    // before this harness ever got to emit its own runtimeUnavailable
    // verdict, landing on a less-informative "all_providers_failed" instead.
    const audit = h.run('bash', ['-c', 'pip-audit -r requirements.txt --format json --progress-spinner off > .pip-audit-out.json 2>.pip-audit-err.log; node extract-pip-audit.js'], { cwd: d, timeoutMs: 35000 });
    if (audit.timedOut) {
      return { passed: false, runtimeUnavailable: true, logs: 'pip-audit timed out', detail: { pkg, version } };
    }
    const summary = h.jsonOf(audit.stdout);
    if (!summary || !summary.parsed || summary.total === null) {
      const errTail = h.run('bash', ['-c', 'tail -c 4000 .pip-audit-err.log 2>/dev/null || true'], { cwd: d, timeoutMs: 10000 }).stdout;
      if (/ConnectionError|Temporary failure|Name or service not known|Network is unreachable/i.test(errTail || '')) {
        return { passed: false, runtimeUnavailable: true, logs: 'pip-audit could not reach PyPI/OSV.dev: ' + String(errTail).slice(0, 400), detail: { pkg, version, errTail: errTail.slice(0, 2000) } };
      }
      // pip-audit's dependency-resolution step (a pip dry-run install used to
      // determine the exact package to look up) needs to build the package
      // when no compatible wheel exists for the sandbox's Python version.
      // Some old binary/C-extension packages (pillow==9.0.0 predates Python
      // 3.13 wheels) have legacy sdist builds that are simply broken under
      // modern setuptools — a real, package-specific incompatibility with
      // this sandbox's toolchain, not something a flag or retry fixes, and
      // unrelated to whether the package has any vulnerabilities.
      return { passed: false, runtimeUnavailable: true, logs: 'pip-audit could not resolve/build this pinned version in this sandbox: ' + String(errTail).slice(0, 400), detail: { pkg, version, errTail: errTail.slice(0, 2000) } };
    }
    const total = summary.total;
    const foundVulns = total > 0;
    const passed = foundVulns === !claimsNone;

    return {
      passed,
      logs: passed ? '' : ('expected ' + (claimsNone ? 'no vulnerabilities' : 'vulnerabilities') + ' but pip-audit ' + (foundVulns ? 'found ' + total : 'found none') + ' for ' + pkg + '@' + version),
      detail: { ecosystem, pkg, version, claimsNone, foundVulns, total, auditExit: audit.status },
    };
  },
};
