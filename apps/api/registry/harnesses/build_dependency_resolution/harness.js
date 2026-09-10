/**
 * exit-code-verify — write project_manifest under its ecosystem's
 * conventional filename and run build_command for real (pip/npm/cargo all
 * hit their real registries — this needs network access in the sandbox).
 * expected_build_result states success or failure in its first word; a row
 * passes when the real exit code matches that claim.
 */
'use strict';

const MANIFEST_FILE = { pip: 'requirements.txt', npm: 'package.json', cargo: 'Cargo.toml' };
const REQUIRED_BIN = { pip: 'pip3', npm: 'npm', cargo: 'cargo' };

// Anchored to the WHOLE simple command, not just its leading binary --
// checking only the leading token let "cargo build"/"cargo test" (compiles
// the crate graph, running any dependency's build.rs) or a bare "python3"/
// "node"/"npx" invocation (each a general-purpose interpreter with no
// legitimate reason to appear here) pass as "shape-valid". Restricting to
// the exact subcommand this category actually needs closes both at once.
const ALLOWED_COMMAND_RE = {
  pip: /^pip3?\s+install\b/,
  npm: /^npm\s+(?:install|ci)\b/,
  cargo: /^cargo\s+(?:generate-lockfile|metadata|fetch)\b/,
};
// 'export'/'set' deliberately excluded: both mutate the shell's environment
// for every command that runs afterward in the same `bash -c` invocation,
// which is exactly the mechanism the env-var-injection bug below abused.
const BENIGN_SHELL_BINARIES = new Set([
  'cd', 'echo', 'mkdir', 'ls', 'cat', 'mv', 'cp', 'rm', 'true', 'false', 'test',
  'chmod', 'pwd', 'touch', 'printf', ':',
]);
// Defense in depth on top of the allowlist below: these have no legitimate
// reason to appear in a dependency-resolution build command.
const DENYLIST_PATTERN = /\b(curl|wget|nc|ncat|netcat|telnet|ssh|scp|rsync|perl|ruby|php)\b|\/dev\/tcp|\bbase64\s+-d\b/i;

/**
 * Reject anything outside "resolve/build this manifest". The network access
 * this category is granted exists for pip/npm/cargo registry traffic, not
 * for arbitrary contributor shell — build_command used to run through
 * `bash -c` completely unvalidated. Splitting on shell control operators
 * (&&, ||, ;, |) is NOT a shell parser -- it has no concept of a bare `&`
 * (job control) or `$(...)`/`` `...` ``/`<(...)`/`>(...)` (command/process
 * substitution), all of which run an embedded command as a real subprocess
 * during word expansion, independent of whether the "outer" command is
 * recognized. Those are rejected outright before the split ever runs.
 */
function validateCommandShape(cmd, eco) {
  if (DENYLIST_PATTERN.test(cmd)) return 'contains a disallowed binary/pattern (network fetch, remote shell, etc.)';
  if (/\|\s*(ba)?sh\b/i.test(cmd)) return 'pipes output into a shell interpreter';
  if (/(?<!&)&(?!&)/.test(cmd)) return 'contains a background/job-control operator (&)';
  if (/\$\(|`|<\(|>\(/.test(cmd)) return 'contains command/process substitution ($(...), `...`, <(...), >(...))';
  // No legitimate build_command for "resolve this manifest" needs to
  // redirect input/output to an arbitrary path -- and this is also the
  // mechanism a PATH-hijack shim attack needs to WRITE its fake binary in
  // the first place (e.g. `printf 'exit 0' > /tmp/x/npm`), regardless of
  // which nominally-"benign" binary is used to do the writing.
  if (/[<>]/.test(cmd)) return 'contains an I/O redirection operator (<, >, >>)';

  const simpleCommands = cmd.split(/&&|\|\||[;\n]|\|/).map((s) => s.trim()).filter(Boolean);
  const commandRe = ALLOWED_COMMAND_RE[eco];
  for (const sc of simpleCommands) {
    // A leading `VAR=value` environment-assignment prefix used to be
    // silently STRIPPED before the allowlist check ran below, discarding it
    // rather than validating it -- confirmed exploitable: real package
    // managers genuinely honor these overrides (`NPM_CONFIG_REGISTRY=
    // http://bad npm install`, `PIP_INDEX_URL=file:///dev/null pip3 install
    // ...`, `CARGO_NET_OFFLINE=true cargo generate-lockfile`), so the
    // stripped-and-ignored prefix let a contributor force the real exit
    // code of the install step independent of whether project_manifest's
    // dependencies genuinely resolve. Rejected outright instead -- there is
    // no legitimate reason for this category's build_command to set an
    // environment variable inline.
    if (/^[A-Za-z_][A-Za-z0-9_]*=\S*(\s|$)/.test(sc)) {
      return 'command "' + sc.trim() + '" sets an environment variable inline -- not permitted';
    }
    const bin = sc.split(/\s+/)[0];
    if (!bin) continue;
    if (BENIGN_SHELL_BINARIES.has(bin)) continue;
    if (!commandRe || !commandRe.test(sc)) {
      return 'command "' + sc.trim() + '" is not a recognized ' + eco + ' build command (only "' + (commandRe ? commandRe.source : '(none)') + '" is permitted)';
    }
  }
  return null;
}

/**
 * project_manifest is written close to verbatim so a malformed-on-purpose
 * manifest still fails to parse the way the row intends — but for npm, a
 * VALID manifest's `scripts.{preinstall,install,postinstall,prepare}` runs
 * automatically on `npm install`, regardless of what build_command says.
 * Stripping `scripts` doesn't affect what this category actually tests
 * (whether the declared dependencies resolve), and closes that off.
 */
function sanitizeNpmManifest(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.scripts) {
      delete parsed.scripts;
      return JSON.stringify(parsed, null, 2);
    }
    return raw;
  } catch (e) {
    return raw; // malformed on purpose in some rows -- let it fail as intended
  }
}

// Stripping the ROOT manifest's own `scripts` (above) does nothing about a
// DEPENDENCY specifier that points at attacker-controlled infrastructure --
// npm/pip/cargo all execute that dependency's OWN install-time hooks
// (postinstall, setup.py, build.rs) as part of completely ordinary,
// expected behavior when resolving it, using a build_command that is
// indistinguishable from a legitimate row's. Restricting every ecosystem's
// dependency specifiers to plain registry versions (never a git/URL/local
// path) closes that off regardless of what build_command says.
const UNSAFE_NPM_DEP_SPEC = /^(?:git\+|git:|https?:|github:|gitlab:|bitbucket:|file:)/i;
function findUnsafeNpmDependency(parsed) {
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = parsed[key];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && UNSAFE_NPM_DEP_SPEC.test(spec.trim())) return name + '@' + spec;
    }
  }
  // npm (8.3+) also honors a top-level `overrides` field, which can pin a
  // package to an arbitrary git/URL source at install time -- including
  // nested forms like {"foo": {".": "git+https://attacker/repo.git"}} --
  // completely bypassing the dependencies-only check above and letting that
  // attacker-controlled package's own postinstall hook run during npm
  // install, the exact class of risk this file exists to prevent.
  if (parsed.overrides && typeof parsed.overrides === 'object') {
    const bad = findUnsafeOverrideValue(parsed.overrides);
    if (bad) return 'overrides: ' + bad;
  }
  return null;
}
function findUnsafeOverrideValue(node) {
  if (typeof node === 'string') return UNSAFE_NPM_DEP_SPEC.test(node.trim()) ? node : null;
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) {
      const bad = findUnsafeOverrideValue(v);
      if (bad) return bad;
    }
  }
  return null;
}

const PIP_UNSAFE_LINE_RE = /^\s*(?:-e\s+|--editable\s+)?(?:git\+|hg\+|svn\+|bzr\+|https?:\/\/|file:)/i;
const PIP_UNSAFE_FLAG_RE = /^\s*(?:-i\b|--index-url\b|--extra-index-url\b|--find-links\b|-f\b|--trusted-host\b)/i;
// PEP 508 direct-reference syntax ("packagename @ https://attacker/payload
// .whl", or "pkg @ git+https://...") starts with the package NAME, not the
// URL scheme -- PIP_UNSAFE_LINE_RE is anchored to the start of the line and
// never matches this form, so a requirements-file line written this way
// passed unrejected and pip3 install genuinely fetches and builds that
// arbitrary URL's sdist (running its setup.py).
const PIP_UNSAFE_DIRECT_REF_RE = /^\s*[\w.-]+(?:\[[^\]]*\])?\s*@\s*(?:git\+|hg\+|svn\+|bzr\+|https?:\/\/|file:)/i;
function findUnsafePipLine(manifest) {
  for (const rawLine of String(manifest).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (PIP_UNSAFE_LINE_RE.test(line) || PIP_UNSAFE_FLAG_RE.test(line) || PIP_UNSAFE_DIRECT_REF_RE.test(line)) return line;
  }
  return null;
}

// cargo generate-lockfile/metadata/fetch never compile a crate (no build.rs
// execution), but a git-sourced dependency still makes them clone an
// attacker-controlled repository -- an SSRF-ish fetch a plain registry
// dependency never triggers.
const CARGO_UNSAFE_DEP_RE = /\bgit\s*=\s*['"]/i;
function findUnsafeCargoDependency(manifest) {
  for (const rawLine of String(manifest).split('\n')) {
    if (CARGO_UNSAFE_DEP_RE.test(rawLine)) return rawLine.trim();
  }
  return null;
}

module.exports = {
  contract: 'exit-code-verify',
  requires: ['bash'],

  verify(row, h) {
    const manifest = h.str(row, 'project_manifest');
    const buildCmd = h.str(row, 'build_command');
    const expectedResult = h.str(row, 'expected_build_result');
    const eco = h.str(row, 'language_ecosystem').toLowerCase();
    if (!manifest || !buildCmd || !eco) {
      return { passed: false, detail: { reason: 'missing project_manifest, build_command, or language_ecosystem' } };
    }
    // Same "FLAWED:" convention as elsewhere in this dataset family, but
    // embedded mid-string here ("failure: ... (FLAWED: ...)") rather than as
    // a strict prefix — searched anywhere rather than anchored.
    if (/FLAWED:/i.test(expectedResult)) {
      return { passed: false, logs: 'reference description is marked FLAWED', detail: { flawedReference: true } };
    }
    const manifestFile = MANIFEST_FILE[eco];
    if (!manifestFile) return { passed: false, runtimeUnavailable: true, logs: 'unsupported ecosystem: ' + eco, detail: { eco } };
    const bin = REQUIRED_BIN[eco];
    if (!h.have(bin)) return { passed: false, runtimeUnavailable: true, logs: bin + ' not available', detail: { eco } };

    const shapeErr = validateCommandShape(buildCmd, eco);
    if (shapeErr) {
      return { passed: false, logs: 'build_command rejected: ' + shapeErr, detail: { eco, rejectedField: 'build_command' } };
    }

    if (eco === 'npm') {
      try {
        const parsedForCheck = JSON.parse(manifest);
        if (parsedForCheck && typeof parsedForCheck === 'object' && !Array.isArray(parsedForCheck)) {
          const unsafe = findUnsafeNpmDependency(parsedForCheck);
          if (unsafe) {
            return { passed: false, logs: 'project_manifest rejected: dependency "' + unsafe + '" is not a plain registry version specifier', detail: { eco, rejectedField: 'project_manifest' } };
          }
        }
      } catch (e) {
        // malformed on purpose in some rows -- let it fail as intended at install time
      }
    } else if (eco === 'pip') {
      const unsafeLine = findUnsafePipLine(manifest);
      if (unsafeLine) {
        return { passed: false, logs: 'project_manifest rejected: line "' + unsafeLine + '" is not a plain registry requirement', detail: { eco, rejectedField: 'project_manifest' } };
      }
    } else if (eco === 'cargo') {
      const unsafeDep = findUnsafeCargoDependency(manifest);
      if (unsafeDep) {
        return { passed: false, logs: 'project_manifest rejected: line "' + unsafeDep + '" specifies a git dependency', detail: { eco, rejectedField: 'project_manifest' } };
      }
    }

    const expectSuccess = /^success/i.test(expectedResult.trim());

    const d = h.workdir();

    // FAST, CLEAN no-egress HOLD — the same 4s TCP preflight the sibling
    // dependency_vuln_audit harness uses, and what this category's own setup.sh
    // already says must happen ("a sandboxed environment with no outbound
    // network would need every row here to fall back to runtime_unavailable").
    //
    // Without it this harness FABRICATES verdicts on a deny-all sandbox, in both
    // directions and silently: a row claiming `success` has its build fail for
    // lack of network and is REJECTED as the contributor's fault, and a row
    // claiming `failure` "passes" because the build failed for entirely the
    // wrong reason. Exit code alone cannot tell "this manifest does not resolve"
    // apart from "nothing could be fetched at all", so the reachability question
    // has to be asked before the exit code is allowed to mean anything.
    //
    // Measured per run on the box that will actually do the install, which is
    // strictly better than a static "this type needs egress" flag: it is also
    // right when the sandbox HAS an allowlist that simply does not carry this
    // ecosystem's registry.
    const REGISTRY_HOSTS = { pip: ['pypi.org', 'files.pythonhosted.org'], npm: ['registry.npmjs.org'], cargo: ['index.crates.io', 'static.crates.io'] };
    const hosts = REGISTRY_HOSTS[eco] || [];
    if (hosts.length) {
      // Any one host reachable = the registry is reachable; all of them timing
      // out or erroring = egress is blocked for this ecosystem.
      const probe = 'const net=require("net");const hosts=' + JSON.stringify(hosts) + ';let done=false,pending=hosts.length;const fin=c=>{if(!done){done=true;process.exit(c)}};hosts.forEach(hst=>{const s=net.connect({host:hst,port:443});s.setTimeout(4000);s.on("connect",()=>{s.destroy();fin(0)});s.on("timeout",()=>{s.destroy();if(--pending===0)fin(1)});s.on("error",()=>{if(--pending===0)fin(1)})});';
      const reach = h.run('node', ['-e', probe], { cwd: d, timeoutMs: 8000 });
      if (reach.status !== 0) {
        return {
          passed: false,
          runtimeUnavailable: true,
          logs: hosts.join('/') + ' unreachable (sandbox egress blocked for this ecosystem); a real ' + eco + ' install cannot run, and its exit code would not mean what this contract needs it to — routed to human audit',
          detail: { eco, reason: 'no_egress', hosts },
        };
      }
    }
    if (eco === 'cargo') {
      // cargo generate-lockfile still expects a real crate layout, not just
      // a bare Cargo.toml.
      h.fs.mkdirSync(h.path.join(d, 'src'), { recursive: true });
      h.fs.writeFileSync(h.path.join(d, 'src', 'lib.rs'), '');
    }
    h.fs.writeFileSync(h.path.join(d, manifestFile), eco === 'npm' ? sanitizeNpmManifest(manifest) : manifest);

    // 100s, not the full 120s outer sandbox command budget
    // (EXECUTION_RUNNER_TIMEOUT_MS): this h.run timeout must stay STRICTLY
    // below the outer per-command budget passed to e2bSandboxProvider.runScript,
    // same rule the config.ts boot invariant enforces for helpers.js's own
    // childTimeoutMs/probeTimeoutMs. At the prior 120000 (exactly equal to the
    // outer budget), a build that genuinely runs close to the ceiling is a
    // race the OUTER e2b command timeout always wins -- its clock starts
    // before this h.run call even begins (sandbox prologue + node startup +
    // file writes), so it fires first and tears the whole command down with
    // an ambiguous provider-level timeout/error instead of this harness's
    // own clean, informative runtimeUnavailable verdict. 20s of margin is
    // still generous relative to the documented worst case ("occasionally
    // exceed 90s") while leaving real headroom for that startup overhead.
    const r = h.run('bash', ['-c', buildCmd], { cwd: d, timeoutMs: 100000 });
    if (r.timedOut) {
      return { passed: false, runtimeUnavailable: true, logs: 'build timed out after 100s', detail: { eco, timedOut: true } };
    }
    const succeeded = r.status === 0;
    const passed = succeeded === expectSuccess;

    return {
      passed,
      logs: passed ? '' : ('expected ' + (expectSuccess ? 'success' : 'failure') + ' but build ' + (succeeded ? 'succeeded' : 'failed') + ':\n' + String(r.stderr || r.stdout).slice(0, 800)),
      detail: { eco, expectSuccess, succeeded, exitCode: r.status },
    };
  },
};
