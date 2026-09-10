/**
 * http_api_contract_testing -- live-http-server-contract-match.
 *
 * THE CONTRACT: server_implementation (real, submitter-controlled Python,
 * stdlib only) is started as its own REAL, SEPARATE OS process -- never
 * exec()'d in-process, never mocked -- bound to a real loopback TCP port on
 * 127.0.0.1 (loopback, not egress: this category's sandbox posture is
 * identical to websocket_realtime's, which already binds a real local server
 * the exact same way; see registry/categories.json's own networkEgress
 * comment -- this category does NOT set networkEgress, on purpose). The
 * harness polls for genuine readiness with real socket connection attempts
 * (never a fixed sleep), then drives every request in the row's own
 * `requests` array against it for real, via Python's stdlib http.client --
 * never by inspecting server_implementation's source text, never by trusting
 * anything the server process prints to stdout/stderr. Every request's real
 * status code / selected response headers / body is compared against that
 * SAME request's own curator-declared expected values.
 *
 * WHY THIS CATEGORY'S SECURITY MODEL IS SIMPLER THAN ITS SIBLINGS' (a real
 * design property, not an oversight -- worth reading before touching this
 * file): redis_data_structure_semantics's solution_code is exec()'d INSIDE
 * the same trusted driver process as the code that computes/reports the
 * verdict, which is exactly why that harness needs h.PY_PRELUDE's sys.exit
 * trapping plus a hand-rolled try/except BaseException around every exec().
 * HERE, server_implementation is never exec()'d by the driver at all -- it
 * is written to its own file and started as a genuinely separate
 * `python3 server.py` OS process (playing the same architectural role
 * redis-server itself plays in that sibling harness: a real, independent,
 * killable child process -- NOT the role solution_code plays there). A
 * sys.exit()/os._exit()/unhandled exception inside server_implementation
 * just ends ITS OWN process normally, observed via the driver's own
 * subprocess.poll()/returncode -- exactly the "broken server" signal this
 * category needs to detect, not a hijack risk against the driver's own exit
 * code or stdout. No PY_PRELUDE/PY_DRIVER machinery is needed or used here.
 *
 * WHY THE `requests` CONTRACT (CURATOR GROUND TRUTH) IS NEVER WRITTEN TO
 * DISK ANYWHERE THE CONTRIBUTOR'S PROCESS CAN TRIVIALLY READ IT: both
 * server_implementation's source and the requests contract are embedded into
 * driver.py (a FIXED, 100%-harness-authored template -- no per-row
 * interpolation of contributor text into another script's source at all) as
 * base64 payloads, decoded only inside the trusted driver's own process
 * memory. driver.py then writes ONLY server_implementation's decoded source
 * to disk, into a freshly-created, DEDICATED subdirectory containing nothing
 * else, and starts the contributor's server with that subdirectory as its
 * cwd -- so a naive `open("contract.json")`/`os.listdir(".")` from inside
 * server_implementation cannot recover the expected_status/expected_body
 * ground truth and hardcode responses to match it. ACCEPTED RESIDUAL,
 * documented rather than silently assumed closed: this is a directory-
 * separation convention, not a hard filesystem jail -- E2B's sandbox has no
 * chroot for this category, so a sufficiently determined server could still
 * try `open("../driver.py")` (one literal directory up) and recover the
 * base64 blob by construction. Judged low-value-to-attack (the same tier as
 * helpers.js's own ctypes/os._exit residual and redis_data_structure_
 * semantics's orphaned-grandchild residual): there is no reward for a
 * contributor "gaming" their own submission's verification this way -- doing
 * so requires visibly adversarial code in server_implementation itself,
 * which is exactly what this registry's human_audit pipeline stage (see
 * schema.json's `pipeline`) exists to catch before any karma is awarded, and a
 * deliberately hardcoded/reflective response is easy for a human reviewer to
 * spot on read. Base64 (not driver.py's redis-sibling's pyStr()-style Python-
 * string-literal escaping) is used specifically because both payloads here
 * are DATA that only ever needs to survive one JSON/text round trip, never
 * re-parsed as Python source -- this sidesteps any quoting/escaping edge
 * case entirely, including the deliberately adversarial punctuation-heavy
 * request bodies this category's own dataset rows are expected to include
 * (see ANTI-INJECTION note below).
 *
 * ANTI-HARDCODING (this category's answer to sql_query_correctness's
 * mutate-and-recompare technique -- a genuinely different, and simpler,
 * mechanism, because unlike a SQL mutation this category always has real,
 * curator-declared ground truth available for MULTIPLE independent checks
 * per row, not just one): a server that ignores the real request and always
 * returns one fixed canned response can satisfy AT MOST one entry of a
 * `requests` array whose entries do not all share the same expected outcome
 * -- every OTHER entry is checked against its own, different, independently
 * declared expected_status/expected_body, so it fails on exactly the same
 * ordinary per-request comparison every row already goes through. No
 * mutate-and-rerun step is needed (there is nothing analogous to "the
 * database" to mutate here), so this file enforces the one condition that
 * makes that argument hold mechanically: the ANTI-HARDCODING GATE inside
 * validateRequests() below rejects (as a bad row, not a harness fault --
 * mirrors sql_query_correctness's Gate 2 discipline for a malformed
 * sql_query) any `requests`
 * array whose every entry shares an IDENTICAL (expected_status,
 * canonicalized expected_body) pair, since such a row provides zero
 * anti-hardcoding signal by construction regardless of what
 * server_implementation does. This does not require entries to share a
 * method+path (schema.json's own help text recommends that stronger,
 * same-route-varying-input pattern as best AUTHORING practice for maximum
 * realism, but the mechanically ENFORCED bar here is the weaker, cheaply and
 * robustly checkable "not every expected outcome is identical").
 *
 * ANTI-INJECTION: request bodies/paths/headers are NEVER shell-interpolated
 * anywhere in this file or in driver.py -- driver.py sends every request via
 * Python's stdlib http.client.HTTPConnection.request(method, path,
 * body=..., headers=...), a programmatic API call, never a shell command
 * line built by string concatenation. This means a request body containing
 * shell metacharacters, quotes, or JSON-breaking punctuation is transmitted
 * and compared byte-for-byte like any other request body -- there is no
 * separate code path that would treat it specially, and no shell is ever
 * invoked to send it.
 *
 * PER-ROW SERVER LIFECYCLE: mirrors redis_data_structure_semantics's own
 * documented convention almost exactly (random port in [20000,29999], one
 * retry on an immediate bind failure, a real-connection-attempt poll loop
 * bounded by READY_TIMEOUT_S rather than a fixed sleep, always terminated in
 * a try/finally regardless of outcome). ACCEPTED RESIDUAL, same as that
 * sibling's own documented one: if the OUTER h.run() timeout fires,
 * spawnSync's SIGTERM reaches the direct `python3 driver.py` child only --
 * the server_implementation GRANDCHILD is not automatically reaped by that
 * signal, and driver.py deliberately does not install its own SIGTERM
 * handler to cover that gap (a handler that does not itself terminate the
 * process would silently defeat spawnSync's own timeout enforcement, the
 * same reasoning redis_data_structure_semantics's own module doc comment
 * gives). Bounded to the remainder of that one row's own E2B microVM, torn
 * down after the row regardless -- no cross-row leakage.
 *
 * BROKEN-SERVER HANDLING IS A REAL, SCORED FAILURE, NEVER runtimeUnavailable:
 * server_implementation is graded contributor code, not trusted registry
 * infra (unlike redis-server in the sibling category) -- a server that
 * crashes on startup, never binds the given PORT, or hangs without ever
 * accepting a connection is exactly the same class of defect as any other
 * category's "solution_code raises an exception", and is scored `passed:
 * false` with a clear, specific reason. `runtimeUnavailable` is reserved
 * strictly for a genuine environment/toolchain gap (python3 itself missing
 * from the sandbox), matching this registry's own documented distinction.
 *
 * TIMEOUT BUDGET: READY_TIMEOUT_S (6s, matching redis_data_structure_
 * semantics's own tuned cold-microVM-first-touch margin) once, plus up to
 * MAX_REQUESTS (12) requests at REQUEST_TIMEOUT_S (5s) each in the
 * absolute worst case (a hung request on every single one, which the
 * sequence aborts after the FIRST such hang -- see driver.py's own loop),
 * comfortably inside TIMEOUT_MS (45000ms), itself well under the outer
 * sandbox command budget (120000ms, infra/terraform/ssm.tf's
 * EXECUTION_RUNNER_TIMEOUT_MS) -- the same "stay strictly under the outer
 * budget" discipline this registry enforces everywhere else.
 */
'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 45000;
const MAX_REQUESTS = 12;
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function b64(s) {
  return Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');
}

/** Numeric-tolerant, key-order-insensitive (objects) / index-ordered
 * (arrays) structural equality -- ported from redis_data_structure_
 * semantics's own deepEqualTolerant for the exact same reason: an HTTP JSON
 * body is data of the same shape, and array order is frequently the very
 * thing under test (e.g. a listing endpoint's ordering) while object key
 * order never is. */
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

/** A stable canonical JSON string, used only to compare "is this expected
 * outcome identical to that one" for the anti-hardcoding gate below -- key
 * order must not matter there either, for the same reason it doesn't for
 * the real body comparison. */
function canonicalKey(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalKey).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalKey(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * Validate the `requests` field's shape. Returns { ok, reason, requests }.
 * A malformed contract is a bad ROW (dataset-authoring defect), never a
 * harness fault and never runtimeUnavailable -- mirrors sql_query_
 * correctness's own Gate 2 discipline for a malformed sql_query.
 */
function validateRequests(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'requests must be valid JSON' };
  }
  if (!Array.isArray(parsed) || parsed.length < 2) {
    return { ok: false, reason: 'requests must be a JSON array of at least 2 request/expected-response objects' };
  }
  if (parsed.length > MAX_REQUESTS) {
    return { ok: false, reason: 'requests exceeds the maximum of ' + MAX_REQUESTS + ' entries for this category' };
  }

  const outcomes = [];
  for (let i = 0; i < parsed.length; i++) {
    const req = parsed[i];
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      return { ok: false, reason: 'requests[' + i + '] must be an object' };
    }
    const method = String(req.method || '').toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
      return { ok: false, reason: 'requests[' + i + '].method must be one of ' + ALLOWED_METHODS.join(', ') };
    }
    const path = req.path;
    if (typeof path !== 'string' || path[0] !== '/') {
      return { ok: false, reason: 'requests[' + i + '].path must be a string starting with "/"' };
    }
    if (!Number.isInteger(req.expected_status) || req.expected_status < 100 || req.expected_status > 599) {
      return { ok: false, reason: 'requests[' + i + '].expected_status must be an integer HTTP status code' };
    }
    if (req.headers != null) {
      if (typeof req.headers !== 'object' || Array.isArray(req.headers)) {
        return { ok: false, reason: 'requests[' + i + '].headers must be an object if present' };
      }
      if (Object.values(req.headers).some((v) => typeof v !== 'string')) {
        return { ok: false, reason: 'requests[' + i + '].headers values must all be strings' };
      }
    }
    if (req.expected_headers != null) {
      if (typeof req.expected_headers !== 'object' || Array.isArray(req.expected_headers)) {
        return { ok: false, reason: 'requests[' + i + '].expected_headers must be an object if present' };
      }
      if (Object.values(req.expected_headers).some((v) => typeof v !== 'string')) {
        return { ok: false, reason: 'requests[' + i + '].expected_headers values must all be strings' };
      }
    }
    let bodyMatch = req.body_match;
    if (bodyMatch != null && !['json', 'exact', 'contains', 'absent'].includes(bodyMatch)) {
      return { ok: false, reason: 'requests[' + i + '].body_match must be one of json, exact, contains, absent' };
    }
    // expected_body may be authored either as a NATIVE JSON value (object/
    // array/number/boolean/null -- the natural way to write it inline in a
    // JSON array field) or as a pre-stringified JSON/plain-text string.
    // Confirmed via this file's own self-test: String(anObject) yields the
    // useless literal "[object Object]", which used to make JSON.parse
    // throw and silently default every native-object expected_body to
    // 'exact' mode -- comparing http.client's real (correctly single-
    // encoded) response text against "[object Object]" and failing EVERY
    // genuinely correct submission whose expected_body was written as a
    // plain JSON object, the single most natural way to author it.
    if (!bodyMatch && req.expected_body !== undefined) {
      if (req.expected_body !== null && typeof req.expected_body === 'object') {
        bodyMatch = 'json';
      } else if (typeof req.expected_body === 'string') {
        try {
          JSON.parse(req.expected_body);
          bodyMatch = 'json';
        } catch (e) {
          bodyMatch = 'exact';
        }
      } else {
        // number/boolean/null authored bare -- has a sensible exact textual
        // form (String(true) === 'true', etc.), never "[object Object]".
        bodyMatch = 'exact';
      }
    }
    if (bodyMatch === 'exact' && req.expected_body !== null && typeof req.expected_body === 'object') {
      return { ok: false, reason: 'requests[' + i + '].body_match cannot be "exact" when expected_body is a JSON object/array -- use "json" instead' };
    }
    outcomes.push(req.expected_status + '|' + canonicalKey(req.expected_body !== undefined ? req.expected_body : null));
    parsed[i] = Object.assign({}, req, { method, body_match: bodyMatch || null });
  }

  // ANTI-HARDCODING GATE -- see module doc comment. A row whose every
  // request shares one identical expected outcome cannot detect a
  // constant-response server no matter what the harness does downstream, so
  // it is rejected here as a dataset-authoring defect rather than silently
  // accepted as a weak row.
  if (outcomes.every((o) => o === outcomes[0])) {
    return { ok: false, reason: 'requests must include at least one request whose expected_status/expected_body genuinely differs from another -- a row where every request expects the identical outcome cannot distinguish a real implementation from a hardcoded constant response' };
  }

  return { ok: true, requests: parsed };
}

/** The whole verification program, run once via a single python3 subprocess.
 * A FIXED, harness-authored template -- server_implementation's source and
 * the requests contract are the only per-row inputs, and both are embedded
 * as opaque base64 DATA (never interpolated as Python source text). See
 * this file's module doc comment for why. */
function buildDriverScript(serverB64, contractB64, mark) {
  return [
    'import os, sys, json, base64, subprocess, socket, time, random',
    '',
    'MARK = ' + JSON.stringify(mark),
    'SERVER_B64 = ' + JSON.stringify(serverB64),
    'CONTRACT_B64 = ' + JSON.stringify(contractB64),
    'READY_TIMEOUT_S = 6.0',
    'REQUEST_TIMEOUT_S = 5.0',
    '',
    'def _pick_port():',
    '    return random.randint(20000, 29999)',
    '',
    'def _main():',
    '    contract = json.loads(base64.b64decode(CONTRACT_B64).decode("utf-8"))',
    '    server_src = base64.b64decode(SERVER_B64).decode("utf-8")',
    '',
    '    run_dir = os.path.join(os.getcwd(), "server_run")',
    '    os.makedirs(run_dir, exist_ok=True)',
    '    with open(os.path.join(run_dir, "server.py"), "w", encoding="utf-8") as f:',
    '        f.write(server_src)',
    '',
    '    out = {"server_ready": False, "results": []}',
    '    proc = None',
    '    port = None',
    '    stdout_path = os.path.join(run_dir, "server.stdout.log")',
    '    stderr_path = os.path.join(run_dir, "server.stderr.log")',
    '',
    '    for _attempt in range(2):',
    '        port = _pick_port()',
    '        env = os.environ.copy()',
    '        env["PORT"] = str(port)',
    '        try:',
    '            so = open(stdout_path, "wb")',
    '            se = open(stderr_path, "wb")',
    '            proc = subprocess.Popen(["python3", "server.py"], cwd=run_dir, env=env, stdout=so, stderr=se)',
    '        except OSError as e:',
    '            proc = None',
    '            out["server_start_error"] = "failed to spawn server process: " + repr(e)',
    '            continue',
    '        finally:',
    '            try: so.close()',
    '            except Exception: pass',
    '            try: se.close()',
    '            except Exception: pass',
    '        time.sleep(0.05)',
    '        if proc.poll() is None:',
    '            break',
    '',
    '    def _tail(path, n=2000):',
    '        try:',
    '            with open(path, "rb") as f:',
    '                data = f.read()',
    '            return data[-n:].decode("utf-8", "replace")',
    '        except Exception:',
    '            return ""',
    '',
    '    try:',
    '        if proc is None:',
    '            out["server_start_error"] = out.get("server_start_error") or "could not start server process"',
    '            return out',
    '        if proc.poll() is not None:',
    '            out["server_exit_code"] = proc.returncode',
    '            out["server_start_error"] = "server process exited immediately (exit code %r); stderr: %s" % (proc.returncode, _tail(stderr_path))',
    '            return out',
    '',
    '        deadline = time.time() + READY_TIMEOUT_S',
    '        ready = False',
    '        while time.time() < deadline:',
    '            if proc.poll() is not None:',
    '                out["server_exit_code"] = proc.returncode',
    '                out["server_start_error"] = "server process exited while waiting for readiness (exit code %r); stderr: %s" % (proc.returncode, _tail(stderr_path))',
    '                return out',
    '            try:',
    '                s = socket.create_connection(("127.0.0.1", port), timeout=0.3)',
    '                s.close()',
    '                ready = True',
    '                break',
    '            except OSError:',
    '                time.sleep(0.05)',
    '        if not ready:',
    '            out["server_start_error"] = "server did not accept connections on 127.0.0.1:%d within %.1fs -- check it reads PORT from the environment and calls a real blocking serve loop; stderr: %s" % (port, READY_TIMEOUT_S, _tail(stderr_path))',
    '            return out',
    '',
    '        out["server_ready"] = True',
    '',
    '        import http.client',
    '        for i, req in enumerate(contract):',
    '            if proc.poll() is not None:',
    '                out["results"].append({"index": i, "error": "server process had already exited (exit code %r) before this request could be sent" % (proc.returncode,)})',
    '                out["server_exit_code"] = proc.returncode',
    '                break',
    '            entry = {"index": i}',
    '            conn = None',
    '            try:',
    '                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=REQUEST_TIMEOUT_S)',
    '                body = req.get("body")',
    '                if body is not None and not isinstance(body, str):',
    '                    body = json.dumps(body)',
    '                headers = dict(req.get("headers") or {})',
    '                if body is not None and not any(k.lower() == "content-type" for k in headers):',
    '                    headers["Content-Type"] = "application/json"',
    '                conn.request(req["method"], req["path"], body=body, headers=headers)',
    '                resp = conn.getresponse()',
    '                raw = resp.read()',
    '                try:',
    '                    text = raw.decode("utf-8")',
    '                    undecodable = False',
    '                except UnicodeDecodeError:',
    '                    text = None',
    '                    undecodable = True',
    '                entry["status"] = resp.status',
    '                entry["headers"] = {str(k).lower(): v for k, v in resp.getheaders()}',
    '                entry["body"] = text',
    '                entry["body_undecodable"] = undecodable',
    '            except Exception as e:',
    '                entry["error"] = repr(e)',
    '            finally:',
    '                if conn is not None:',
    '                    try: conn.close()',
    '                    except Exception: pass',
    '            out["results"].append(entry)',
    '            if "error" in entry:',
    '                # A hung/reset connection makes any later, stateful',
    '                # request meaningless -- stop here rather than pile on',
    '                # further, likely-identical failures.',
    '                if proc.poll() is not None:',
    '                    out["server_exit_code"] = proc.returncode',
    '                break',
    '        return out',
    '    finally:',
    '        if proc is not None:',
    '            try:',
    '                proc.terminate()',
    '                proc.wait(timeout=3)',
    '            except Exception:',
    '                try:',
    '                    proc.kill()',
    '                except Exception:',
    '                    pass',
    '',
    'result = _main()',
    'os.write(1, (MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
  ].join('\n');
}

/** Compare one real response entry against its declared expected values.
 * Returns { ok, reason }. */
function checkResponse(req, entry, index) {
  const label = req.id ? String(req.id) : req.method + ' ' + req.path;
  if (entry.error) {
    return { ok: false, reason: 'requests[' + index + '] (' + label + '): request failed: ' + entry.error };
  }
  if (entry.status !== req.expected_status) {
    return { ok: false, reason: 'requests[' + index + '] (' + label + '): expected status ' + req.expected_status + ', got ' + entry.status };
  }
  const respHeaders = entry.headers || {};
  if (req.expected_headers) {
    for (const key of Object.keys(req.expected_headers)) {
      const want = req.expected_headers[key];
      const got = respHeaders[String(key).toLowerCase()];
      if (got !== want) {
        return { ok: false, reason: 'requests[' + index + '] (' + label + '): expected header ' + key + '=' + JSON.stringify(want) + ', got ' + JSON.stringify(got) };
      }
    }
  }
  if (req.expected_body === undefined) return { ok: true };

  const mode = req.body_match || 'exact';
  if (mode === 'absent') {
    const ok = !entry.body || entry.body.length === 0;
    return { ok, reason: ok ? '' : 'requests[' + index + '] (' + label + '): expected an empty body, got ' + JSON.stringify(String(entry.body).slice(0, 200)) };
  }
  if (entry.body_undecodable) {
    return { ok: false, reason: 'requests[' + index + '] (' + label + '): response body was not valid UTF-8 text' };
  }
  const actualBody = entry.body == null ? '' : entry.body;
  if (mode === 'contains') {
    const ok = actualBody.indexOf(String(req.expected_body)) !== -1;
    return { ok, reason: ok ? '' : 'requests[' + index + '] (' + label + '): expected body to contain ' + JSON.stringify(req.expected_body) + ', got ' + JSON.stringify(actualBody.slice(0, 300)) };
  }
  if (mode === 'json') {
    let actualParsed, expectedParsed;
    try {
      actualParsed = JSON.parse(actualBody);
    } catch (e) {
      return { ok: false, reason: 'requests[' + index + '] (' + label + '): response body is not valid JSON: ' + JSON.stringify(actualBody.slice(0, 300)) };
    }
    try {
      expectedParsed = typeof req.expected_body === 'string' ? JSON.parse(req.expected_body) : req.expected_body;
    } catch (e) {
      return { ok: false, reason: 'requests[' + index + '] (' + label + '): row\'s own expected_body is not valid JSON' };
    }
    const ok = deepEqualTolerant(actualParsed, expectedParsed);
    return { ok, reason: ok ? '' : 'requests[' + index + '] (' + label + '): expected body ' + JSON.stringify(expectedParsed).slice(0, 300) + ', got ' + JSON.stringify(actualParsed).slice(0, 300) };
  }
  // 'exact'
  const ok = actualBody === String(req.expected_body);
  return { ok, reason: ok ? '' : 'requests[' + index + '] (' + label + '): expected body ' + JSON.stringify(req.expected_body).slice(0, 300) + ', got ' + JSON.stringify(actualBody).slice(0, 300) };
}

module.exports = {
  contract: 'live-http-server-contract-match',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const serverImplementation = h.str(row, 'server_implementation');
    const requestsRaw = h.str(row, 'requests');

    if (!taskDescription.trim() || !serverImplementation.trim() || !requestsRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, server_implementation, or requests' } };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    const validated = validateRequests(requestsRaw);
    if (!validated.ok) {
      return { passed: false, detail: { reason: 'bad_requests_contract', message: validated.reason } };
    }
    const requests = validated.requests;

    const d = h.workdir();
    const mark = '@@HTTPROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = buildDriverScript(b64(serverImplementation), b64(JSON.stringify(requests)), mark);
    const scriptPath = h.path.join(d, 'run_http_contract.py');
    h.fs.writeFileSync(scriptPath, script);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });
    if (r.timedOut) {
      return { passed: false, logs: 'server_implementation did not complete the request sequence within the time budget', detail: { reason: 'timed_out' } };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr || '').slice(0, 1500), detail: { reason: 'driver_crashed' } };
    }

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: a row with
    // several requests/responses could legitimately exceed the report-
    // bounding cap before the trailing marker line is ever reached.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }
    if (!out || typeof out !== 'object' || !Array.isArray(out.results)) {
      return { passed: false, logs: 'could not parse verification output', detail: { reason: 'unparseable_output' } };
    }

    // A server that never becomes ready (crashes, hangs, binds the wrong
    // port, never listens) is a REAL, scored contributor failure -- never
    // runtimeUnavailable. python3 itself is already confirmed present above
    // (h.have('python3') passed), so a failure here is attributable to
    // server_implementation's own content, matching this registry's
    // documented distinction between an environment fault and a broken
    // submission.
    if (!out.server_ready) {
      return {
        passed: false,
        logs: String(out.server_start_error || 'server never became ready').slice(0, 1500),
        detail: { reason: 'server_never_ready', serverExitCode: out.server_exit_code != null ? out.server_exit_code : null },
      };
    }

    if (out.results.length < requests.length) {
      const missingFrom = out.results.length;
      const lastEntry = out.results[out.results.length - 1];
      return {
        passed: false,
        logs: 'server_implementation stopped responding partway through the request sequence (after ' + missingFrom + ' of ' + requests.length + ' requests): ' +
          String((lastEntry && lastEntry.error) || 'process exited').slice(0, 800),
        detail: { reason: 'sequence_incomplete', completedRequests: missingFrom, totalRequests: requests.length },
      };
    }

    for (let i = 0; i < requests.length; i++) {
      const check = checkResponse(requests[i], out.results[i], i);
      if (!check.ok) {
        return {
          passed: false,
          logs: check.reason.slice(0, 1500),
          detail: { reason: 'response_mismatch', failedIndex: i },
        };
      }
    }

    return {
      passed: true,
      score: 1,
      detail: { reason: 'ok', requestsChecked: requests.length },
    };
  },
};
