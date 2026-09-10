/**
 * live-server-execution-match (Redis flavor) -- redis_data_structure_semantics.
 *
 * THE CONTRACT: solution_code (real, submitter-controlled Python) runs
 * against a REAL redis-server process started fresh for this one verify()
 * call -- never a mock/in-memory reimplementation, never a server reused
 * across rows. initial_state_commands (curator-authored) seeds starting
 * state first, on the SAME connection solution_code then continues to use.
 * verification_code (curator-authored) then opens a SEPARATE, independent
 * connection and reads the server's REAL final state, assigning it to a
 * `result` variable, which is compared to expected_verification_result. A
 * row is correct only when the ACTUAL post-execution server state, read back
 * independently, matches -- never by inspecting solution_code's text or
 * trusting anything it prints.
 *
 * THIS CATEGORY IS UNLIKE ITS SQL SIBLINGS (sql_query_correctness,
 * database_migration_correctness): there, every contributor-controlled field
 * is pure SQL TEXT, passed as data into sqlite3 calls a trusted Python driver
 * writes in full -- there is no code path where contributor text becomes
 * Python bytecode. HERE, solution_code (and, since it shares one execution
 * scope with it, initial_state_commands too) IS real, exec()'d Python. Every
 * defense below exists because of that one difference; see the two SQL
 * siblings' own module doc comments for the mirror-image explanation of why
 * they deliberately skip these exact defenses.
 *
 * CONNECTION-VARIABLE CONVENTION -- read before letting either code field
 * redeclare a name (the same lesson web_scraping's own module doc comment
 * documents for its injected `html`/cheerio names): every Python-bearing
 * field is handed a pre-existing, pre-connected variable named `r`
 * (redis.Redis(host='127.0.0.1', port=<this row's port>, decode_responses=True)).
 * initial_state_commands and solution_code share the SAME `r` object/socket,
 * executed back-to-back in one exec() call (mirrors the SQL siblings sharing
 * one sqlite3 connection across schema_ddl+fixture_data). verification_code
 * gets its OWN, separately-constructed `r` -- same server, a genuinely
 * different TCP connection -- so it is structurally impossible for anything
 * solution_code assigns in Python-variable space (reassigning `r`, monkey-
 * patching a method on it, closing it) to influence what verification_code
 * observes: verification_code only ever sees real, independently-queried
 * server state. decode_responses=True is used on every connection (a
 * deliberate, documented convention, not redis-py's own default): it makes
 * every string reply a plain Python str rather than bytes, which is what
 * `result`'s JSON-serializability requirement above assumes throughout. A
 * task that genuinely needs raw/non-UTF8 binary values is out of scope for
 * this category as designed -- a documented limitation, not a silent gap.
 *
 * PER-ROW SERVER LIFECYCLE: `apt-get install redis-server` at template-build
 * time does NOT mean a server is already listening in the sandbox (E2B
 * microVMs run no init/systemd services) -- this harness explicitly starts
 * its OWN `redis-server --port <random> --daemonize no --save "" --appendonly
 * no --bind 127.0.0.1` child process per scenario, from INSIDE the Python
 * driver (via subprocess.Popen, not from this JS file), polls it with a real
 * PING over a real socket until it answers or a 6s deadline passes, and
 * terminates it in a try/finally once the scenario completes. Persistence is
 * disabled outright (no RDB/AOF) since each server's entire lifetime is one
 * scenario inside one verify() call -- there is nothing worth persisting and
 * doing so would only add shutdown latency. The port is chosen randomly per
 * scenario (not a fixed port, not derived from anything row-specific) with
 * one retry on an immediate bind failure, specifically so the TWO scenarios
 * this file always runs (see ANTI-LEAKAGE below) are genuinely independent
 * processes on genuinely independent ports, never the same server reused.
 * ACCEPTED RESIDUAL: if the outer h.run() timeout fires (or the sandbox
 * delivers a harder signal), Node's spawnSync sends SIGTERM to the direct
 * python3 child only -- the redis-server GRANDCHILD is not automatically
 * reaped, and this file deliberately does NOT install a Python-level SIGTERM
 * handler to cover that gap (tried, and reverted: a handler that does not
 * itself terminate the process would silently defeat spawnSync's own
 * timeout enforcement -- r.signal would no longer read 'SIGTERM' and
 * run()'s own `timedOut` detection, which every other harness in this
 * registry also depends on, would stop firing). The orphaned process is
 * bounded to the remainder of that one row's own E2B microVM, which is
 * torn down after the row regardless (no cross-row leakage) -- the same
 * "documented, bounded, not chased further" tier as PY_PRELUDE's own
 * ctypes/raw-syscall residual below.
 *
 * STDOUT-HIJACK / EXIT-FORGERY DEFENSES -- the full hardening this category
 * needs (unlike its SQL siblings), because solution_code really is exec()'d
 * Python sharing this process:
 *   - h.PY_PRELUDE is spliced in verbatim: sys.exit/os._exit/os.abort/
 *     builtins.exit/quit are monkeypatched to raise instead of terminating.
 *   - Both exec() calls per scenario (initial_state_commands+solution_code,
 *     then verification_code) are individually wrapped in their own
 *     `try/except BaseException: ...` -- catches a raw `raise SystemExit(...)`
 *     too (BaseException, not merely Exception), so control always returns
 *     to this file's own trusted code afterward regardless of what either
 *     field does. This is the same pattern vulnerability's harness.js uses
 *     (PY_PRELUDE's monkeypatch + a hand-written try/except BaseException
 *     around the untrusted exec) rather than h.runCode/PY_DRIVER's two-file
 *     argv dance -- that dance exists to protect a submission's own TOP-LEVEL
 *     module code from a bare top-level SystemExit; here the untrusted
 *     content is never the top-level module itself, it is always exec()'d
 *     from INSIDE an explicit try/except this file already controls, which
 *     achieves the identical containment more directly.
 *   - The actual VALUE verification_code computes is read directly out of
 *     its exec() namespace dict (`ns2['result']`) by this file's own trusted
 *     code -- never parsed back out of stdout at all. This closes an entire
 *     class of marker-forgery risk other harnesses defend against with a
 *     random per-run marker + os.write: there is nothing for solution_code
 *     or verification_code to forge via a fake printed line, because no
 *     printed line is ever trusted for the result value in the first place.
 *   - The FINAL combined verdict (both scenarios' outcomes) is still written
 *     via a per-run-random-marker-prefixed line through a raw `os.write(1,
 *     ...)` fd write -- not print()/sys.stdout.write(), which resolve their
 *     stream from the (reassignable) `sys.stdout` object fresh at every call
 *     -- so a reassigned sys.stdout cannot intercept it either. The marker
 *     itself is kept OUT of module (__main__) scope -- assigned as a local
 *     inside the driver's own `_main()` function, not a bare top-level
 *     statement -- specifically so a cheap `import sys;
 *     sys.modules["__main__"].MARK` probe from solution_code cannot read it
 *     and print a forged, earlier, marker-prefixed line of its own (the
 *     genuine line, printed afterward by this file's own trusted code,
 *     would still win h.lastMarked's LAST-line-wins rule regardless, but
 *     closing the cheap read is free and consistent with this category's
 *     explicitly higher rigor bar). ACCEPTED RESIDUAL, not chased further:
 *     a sufficiently determined submission could still reach the same local
 *     via CPython frame introspection (sys._getframe walking), or spawn a
 *     background thread that races a forged write against this file's own
 *     trailing one -- the same generic, hard-to-fully-close "late writer"
 *     class every last-line-wins marker convention in this registry already
 *     carries, not something specific to this file.
 *
 * WHY NO REDIS-COMMAND TEXT DENYLIST (a deliberate, reasoned choice, not an
 * oversight -- contrast with the SQL siblings' real, load-bearing ATTACH/
 * DETACH/PRAGMA denylist): a textual keyword scan is a genuine security
 * boundary for the SQL siblings because SQL syntax cannot express dynamic
 * command construction -- `stripSqlNoise` + a keyword regex sees everything
 * the interpreter (sqlite3) will ever see. Python is Turing-complete:
 * `getattr(r, chr(115)+chr(101)+chr(116))(...)` builds a call a source-text
 * scan cannot see, so a "denylist MODULE/CONFIG/DEBUG/SHUTDOWN" scan here
 * would be bypassable and would give FALSE confidence, exactly the trap this
 * registry's own PY_PRELUDE takes the opposite (structural, not textual)
 * approach to close for sys.exit. The actual isolation boundary for this
 * category is identical to every other Python-executing harness already in
 * this registry (vulnerability, cryptographic_implementation, serialization,
 * compression, ...): the E2B microVM itself -- ephemeral, no network egress,
 * torn down after the row, least-privilege sandbox user. Redis's own
 * `MODULE LOAD` (loading a native .so into the redis-server process, a
 * known Redis privilege-escalation technique in OTHER deployment contexts)
 * grants NO capability solution_code does not already have more directly:
 * it is already unrestricted Python running as an OS process in the same
 * already-fully-untrusted sandbox VM, with the same filesystem/user/network
 * posture as redis-server itself -- gaining code execution inside a SIBLING
 * process it could already reach via plain `subprocess`/`os.system` adds
 * nothing. Blocking MODULE LOAD textually would therefore be theater, not a
 * real control, and is deliberately not attempted; the redis-server process
 * itself is still bound to 127.0.0.1 only, ephemeral, persistence-disabled,
 * and torn down every scenario as ordinary operational hygiene regardless.
 *
 * ANTI-LEAKAGE / DETERMINISM CHECK (this category's answer to the SQL
 * siblings' anti-hardcoding mutation-and-rerun check -- a genuinely
 * different mechanism, because there is no "table" here to generically
 * clone-and-perturb the way sql_query_correctness's mutateDb does): every
 * row runs the WHOLE scenario -- fresh server, initial_state_commands,
 * solution_code, verification_code -- TWICE, each against its OWN
 * independently-started server on its OWN independently-chosen port, and
 * requires the observed `result` to be identical both times. Because both
 * runs use byte-IDENTICAL inputs (same three code fields) against
 * byte-IDENTICAL starting conditions (persistence disabled, fresh process,
 * no shared state possible), a genuinely correct, deterministic
 * solution_code cannot legitimately diverge between them -- unlike the SQL
 * siblings' mutation (which perturbs the DATA and can legitimately make an
 * otherwise-correct, merely fragile query error afterward, hence their
 * "mutation_run_failed_inconclusive" outcome), nothing here is perturbed
 * between the two runs, so there is no plausible "fragile but correct"
 * explanation for a divergence. A run2 that crashes or disagrees with run1
 * is therefore treated as a hard FAILURE (`suspected_nondeterministic`), not
 * inconclusive -- direct, mechanical proof the row's observed behavior is
 * not reliably reproducible, which is exactly the category-specific risk
 * the task brief calls out (a solution that only "works" because of
 * incidental state left by something else, here caught even though each
 * row's own two runs are both fresh, rather than relying on a prior ROW's
 * leftover state existing to be detected at all). Simplification versus the
 * SQL siblings' own "only mutate if the primary run already passed"
 * optimization: BOTH scenarios always run unconditionally here, rather than
 * conditionally skipping the second one -- duplicating the comparison logic
 * in Python (to let the driver itself decide whether run1 "looks correct"
 * before deciding to attempt run2) would cost more in cross-language-logic-
 * duplication risk than the two extra redis-server boot cycles cost in
 * sandbox time, unlike the SQL siblings' mutation (an in-memory SQLite
 * rebuild, cheap enough that this tradeoff does not arise the same way).
 * DOCUMENTED, ACCEPTED FALSE-REJECT RISK: a TTL-based row whose
 * verification_code sleeps too close to its TTL's boundary (rather than
 * comfortably past it) could in principle observe a different result across
 * the two runs purely from sandbox scheduling jitter, not from any real
 * defect in solution_code. Not mitigated mechanically (Redis's own TTL
 * countdown is server-side and precise; the risk is entirely in how
 * generously verification_code sleeps, which the curator, not the graded
 * contributor, controls) -- mitigated by dataset-authoring discipline
 * instead: task_description's own field help already asks for short (1-2s)
 * TTLs specifically so verification_code can use a comfortably generous
 * sleep margin without pushing this file's own timeout budget.
 *
 * TIMEOUT BUDGET: TIMEOUT_MS below covers BOTH full scenarios in one h.run()
 * call. Worst case per scenario: up to READY_TIMEOUT_S (6s, generous for a
 * cold microVM's first touch of the redis-server binary -- the same tail-
 * latency lesson helpers.js's ensureRustToolchain comment documents for
 * rustc) waiting for readiness, plus a curator-authored TTL sleep (bounded
 * to a few seconds by the short-TTL authoring convention above), plus
 * negligible command/exec overhead. Two scenarios comfortably fit inside
 * TIMEOUT_MS with large margin, which itself stays well under the outer
 * sandbox command budget (120000ms, infra/terraform/ssm.tf's
 * EXECUTION_RUNNER_TIMEOUT_MS) -- the same "stay strictly under the outer
 * budget" discipline this registry already enforces everywhere else
 * (helpers.js's typeCheck()/ensureRustToolchain() comments, web_scraping's
 * own PROBE_TIMEOUT_MS/RUN_TIMEOUT_MS comment).
 */
'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 45000;
const PROBE_TIMEOUT_MS = 3000;

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/** Numeric-tolerant, key-order-insensitive (objects) / index-ordered (arrays)
 * structural equality over JSON-decoded values -- see schema.json's
 * expected_verification_result help text for why array order always matters
 * (Redis list/zset ordering is frequently the thing under test) while object
 * key order never does, and why there is no cross-type coercion (a JSON
 * string "1" and a JSON number 1 are different values, matching this
 * registry's own SQL siblings' documented cellsEqual convention). */
function deepEqualTolerant(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    const diff = Math.abs(a - b);
    return diff < 1e-6 || diff <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqualTolerant(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return false;
    for (const k of ak) if (!deepEqualTolerant(a[k], b[k])) return false;
    return true;
  }
  return a === b;
}

/** The whole verification program, run once via a single python3 subprocess.
 * Always runs the full scenario (fresh server + initial_state_commands +
 * solution_code + verification_code) TWICE, each against its own
 * independently-started server -- see this file's module doc comment
 * (ANTI-LEAKAGE / DETERMINISM CHECK) for why both always run, unconditionally. */
function buildDriverScript(pyPrelude, initialStateCommands, solutionCode, verificationCode, mark) {
  return [
    'import subprocess, time, os, sys, json, random',
    'import redis',
    '',
    pyPrelude,
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark), // local, not a __main__ attribute -- see module doc comment
    '    INITIAL_STATE_COMMANDS = ' + pyStr(initialStateCommands),
    '    SOLUTION_CODE = ' + pyStr(solutionCode),
    '    VERIFICATION_CODE = ' + pyStr(verificationCode),
    '    READY_TIMEOUT_S = 6.0',
    '',
    '    def _pick_port():',
    '        return random.randint(20000, 29999)',
    '',
    '    def _start_server():',
    '        proc = None',
    '        port = None',
    '        for _attempt in range(2):',
    '            port = _pick_port()',
    '            try:',
    '                proc = subprocess.Popen(',
    '                    ["redis-server", "--port", str(port), "--daemonize", "no",',
    '                     "--save", "", "--appendonly", "no", "--bind", "127.0.0.1",',
    '                     "--protected-mode", "yes", "--loglevel", "warning"],',
    '                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,',
    '                )',
    '            except OSError:',
    '                proc = None',
    '                continue',
    '            time.sleep(0.05)',
    '            if proc.poll() is None:',
    '                break',
    '        return proc, port',
    '',
    '    def _wait_ready(port, deadline):',
    '        while time.time() < deadline:',
    '            try:',
    '                c = redis.Redis(host="127.0.0.1", port=port, socket_connect_timeout=0.3, socket_timeout=0.3)',
    '                if c.ping():',
    '                    try:',
    '                        c.close()',
    '                    except Exception:',
    '                        pass',
    '                    return True',
    '            except Exception:',
    '                pass',
    '            time.sleep(0.05)',
    '        return False',
    '',
    '    def _stop_server(proc):',
    '        if proc is None:',
    '            return',
    '        try:',
    '            proc.terminate()',
    '            proc.wait(timeout=3)',
    '        except Exception:',
    '            try:',
    '                proc.kill()',
    '            except Exception:',
    '                pass',
    '',
    '    def _run_scenario():',
    '        out = {}',
    '        proc, port = _start_server()',
    '        try:',
    '            if proc is None or proc.poll() is not None:',
    '                out["server_ready"] = False',
    '                out["server_start_error"] = "redis-server exited immediately (bind failure or missing binary)"',
    '                return out',
    '            if not _wait_ready(port, time.time() + READY_TIMEOUT_S):',
    '                out["server_ready"] = False',
    '                out["server_start_error"] = "redis-server did not accept connections within %.1fs" % READY_TIMEOUT_S',
    '                return out',
    '            out["server_ready"] = True',
    '',
    '            r = redis.Redis(host="127.0.0.1", port=port, decode_responses=True, socket_connect_timeout=2, socket_timeout=5)',
    '            try:',
    '                r.ping()',
    '            except Exception as e:',
    '                out["server_ready"] = False',
    '                out["server_start_error"] = "post-ready ping failed: " + repr(e)',
    '                return out',
    '',
    '            ns = {"r": r, "redis": redis}',
    '            combined = INITIAL_STATE_COMMANDS + "\\n" + SOLUTION_CODE',
    '            try:',
    '                exec(compile(combined, "<row>", "exec"), ns)',
    '                out["setup_and_solution_ok"] = True',
    '            except BaseException as e:',
    '                out["setup_and_solution_ok"] = False',
    '                out["setup_and_solution_error"] = repr(e)',
    '',
    '            r2 = redis.Redis(host="127.0.0.1", port=port, decode_responses=True, socket_connect_timeout=2, socket_timeout=5)',
    '            ns2 = {"r": r2, "redis": redis}',
    '            try:',
    '                exec(compile(VERIFICATION_CODE, "<verify>", "exec"), ns2)',
    '                if "result" not in ns2:',
    '                    raise RuntimeError("verification_code did not assign a result variable")',
    '                _res = ns2["result"]',
    '                json.dumps(_res)',
    '                out["verification_ok"] = True',
    '                out["result"] = _res',
    '            except BaseException as e:',
    '                out["verification_ok"] = False',
    '                out["verification_error"] = repr(e)',
    '            return out',
    '        finally:',
    '            _stop_server(proc)',
    '',
    '    result = {"run1": _run_scenario(), "run2": _run_scenario()}',
    '    os.write(1, (MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
    '',
    '_main()',
  ].join('\n');
}

module.exports = {
  contract: 'live-server-execution-match',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const initialStateCommands = h.str(row, 'initial_state_commands');
    const solutionCode = h.str(row, 'solution_code');
    const verificationCode = h.str(row, 'verification_code');
    const expectedRaw = h.str(row, 'expected_verification_result');

    if (!taskDescription.trim() || !solutionCode.trim() || !verificationCode.trim() || !expectedRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, solution_code, verification_code, or expected_verification_result' } };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }
    // Cheap, near-instant PATH probe -- catches the "binary entirely missing"
    // case before spending a full run() call. Does NOT catch "installed but
    // fails to actually bind/start", which is why _run_scenario's own
    // server_ready check (inside the driver) is still the load-bearing gate.
    if (!h.have('redis-server')) {
      return { passed: false, runtimeUnavailable: true, logs: 'redis-server not available in sandbox', detail: { reason: 'no_redis_server_binary' } };
    }
    // From the verified image only -- no runtime install (no-network sandbox).
    // Probed rather than assumed, same discipline web_scraping's own bs4/
    // cheerio probes and this category's own task brief both call for
    // ("probed, not assumed from the Dockerfile").
    const redisPyOk = h.run('python3', ['-c', 'import redis'], { timeoutMs: PROBE_TIMEOUT_MS }).status === 0;
    if (!redisPyOk) {
      return { passed: false, runtimeUnavailable: true, logs: 'python redis client (redis-py) unavailable in this sandbox image', detail: { reason: 'no_redis_py' } };
    }

    // expected_verification_result must be valid JSON -- deliberately NOT
    // using h.jsonOf here (its "parse if it parses, else null" contract is
    // indistinguishable from a row whose expected value genuinely IS the
    // JSON literal `null`, e.g. "the key should not exist" -- a real,
    // meaningful expected value for this category). A hand-rolled
    // try/catch keeps that case distinguishable from a real parse failure.
    let expectedParsed;
    try {
      expectedParsed = JSON.parse(expectedRaw);
    } catch (e) {
      return { passed: false, detail: { reason: 'expected_verification_result must be valid JSON' } };
    }

    const d = h.workdir();
    const mark = '@@REDISROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = buildDriverScript(h.PY_PRELUDE, initialStateCommands, solutionCode, verificationCode, mark);
    const scriptPath = h.path.join(d, 'run_redis.py');
    h.fs.writeFileSync(scriptPath, script);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });
    if (r.timedOut) {
      return { passed: false, logs: 'solution_code/verification_code did not complete within the time budget', detail: { reason: 'timed_out' } };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr || '').slice(0, 1500), detail: { reason: 'driver_crashed' } };
    }

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: a genuinely
    // large verification result must not have its trailing marker line
    // truncated away by the report-bounding cap applied to the returned,
    // logged stdout.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }
    if (!out || typeof out !== 'object' || !out.run1 || !out.run2) {
      return { passed: false, logs: 'could not parse verification output', detail: { reason: 'unparseable_output' } };
    }

    const run1 = out.run1;
    const run2 = out.run2;

    // Either scenario's server failing to come up is OUR problem (a sandbox/
    // environment fault), never a contributor failure -- see module doc
    // comment. Deliberately checked before anything else: a server that
    // never started makes every downstream field meaningless.
    if (!run1.server_ready || !run2.server_ready) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: 'redis-server failed to start/become ready for at least one scenario: ' +
          String(run1.server_start_error || run2.server_start_error || '').slice(0, 500),
        detail: { reason: 'redis_server_not_ready' },
      };
    }

    // initial_state_commands/solution_code raising is a REAL failure -- the
    // solution itself is broken -- never runtimeUnavailable, exactly like
    // database_migration_correctness treats a migration_script that fails
    // to execute. By this point python3 and redis-server are both confirmed
    // healthy (server_ready + a real PING already succeeded), so a
    // subsequent exception is attributable to solution_code's own content.
    if (!run1.setup_and_solution_ok) {
      return {
        passed: false,
        logs: 'initial_state_commands/solution_code failed to execute against the live server: ' + String(run1.setup_and_solution_error || '').slice(0, 500),
        detail: { reason: 'solution_failed' },
      };
    }
    if (!run1.verification_ok) {
      return {
        passed: false,
        logs: 'verification_code failed to execute against the live server: ' + String(run1.verification_error || '').slice(0, 500),
        detail: { reason: 'verification_code_failed' },
      };
    }

    const primaryMatches = deepEqualTolerant(run1.result, expectedParsed);
    if (!primaryMatches) {
      return {
        passed: false,
        logs: 'verification_code observed ' + JSON.stringify(run1.result).slice(0, 300) + ' but expected_verification_result is ' + JSON.stringify(expectedParsed).slice(0, 300),
        detail: { reason: 'result_mismatch' },
      };
    }

    // Anti-leakage / determinism check -- see module doc comment for why a
    // divergence here is a hard failure, not inconclusive (unlike the SQL
    // siblings' mutation-triggered-crash exemption): both runs use
    // byte-identical inputs against byte-identical starting conditions, so
    // there is no plausible "fragile but correct" explanation for run2
    // erroring or disagreeing with run1.
    if (!run2.setup_and_solution_ok || !run2.verification_ok) {
      return {
        passed: false,
        logs: 'the identical scenario failed to execute cleanly on a second, independently-started server (run1 succeeded) -- this is not reliably reproducible: ' +
          String(run2.setup_and_solution_error || run2.verification_error || '').slice(0, 500),
        detail: { reason: 'suspected_nondeterministic', stage: 'crashed_on_rerun' },
      };
    }
    const reproducible = deepEqualTolerant(run2.result, run1.result);
    if (!reproducible) {
      return {
        passed: false,
        logs: 'the identical scenario produced a DIFFERENT verification result on a second, independently-started server -- run1 observed ' +
          JSON.stringify(run1.result).slice(0, 200) + ', run2 observed ' + JSON.stringify(run2.result).slice(0, 200) +
          ' -- this looks non-deterministic/timing-dependent rather than a reliably correct implementation',
        detail: { reason: 'suspected_nondeterministic', stage: 'diverged_on_rerun' },
      };
    }

    return {
      passed: true,
      score: 1,
      detail: { reason: 'ok' },
    };
  },
};
