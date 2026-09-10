/**
 * auth_flow — claim-vs-execution contradiction check.
 *
 * Every row supplies a Python auth handler (`auth_flow_code`), a one-line
 * description of the fake identity provider's token shape
 * (`mock_identity_provider`), a one-line description of the specific request
 * being made (`test_scenarios`), and a prose claim of the resulting status
 * (`expected_access_results`, e.g. "200, correct profile returned" or
 * "403 -- insufficient scope"). The row's SECRET/jwt/time free variables are
 * never defined anywhere in the dataset — they are implicit sandbox
 * environment injected here.
 *
 * Verification synthesizes a JWT matching the scenario purely from
 * `mock_identity_provider` + `test_scenarios` (never from
 * `expected_access_results` — that field is the claim being checked, not an
 * input), actually runs the resolved function against it, and compares the
 * claimed status against the real returned status. The claim is read either
 * from the phrase "claims NNN" (the FLAWED-row convention, e.g. "FLAWED:
 * claims 200 ... but ... real result is 401") or, otherwise, from a 3-digit
 * number leading the string ("200, ..." / "401 -- ..."); a number appearing
 * elsewhere in the prose (a duration, a port, some other status) is never
 * eligible, so it can't be picked up in place of the real claim. This
 * mirrors how every other FLAWED-marker category in this registry is
 * verified, but derived generically instead of gating on the literal
 * substring "FLAWED", per the dataset's own documented intent: a submission
 * that lacks that authoring tell must still be checked.
 *
 * Before any of the above runs, `auth_flow_code` is statically confirmed (via
 * Python's own ast.parse, in a disposable subprocess that never executes the
 * candidate) to contain exactly one top-level function definition and
 * nothing else. This code is later spliced as literal source into the same
 * script that builds the JWT, calls the function, and prints the result --
 * without this check, an extra top-level statement could forge that result
 * outright or monkey-patch the shared jwt module before the real call.
 *
 * `auth_flow_code` is sometimes the literal placeholder text
 * "same <fn>() as above" instead of real code — referring to a function
 * defined in an earlier row that this single-row verify() has no access to
 * (the product pipeline hands the harness exactly one row's fields, never
 * sibling rows; this is not a harness limitation, it reflects how a real
 * standalone submission is evaluated). Rather than fail all such rows or
 * guess at a specific sibling's exact text, each referenced name is resolved
 * against a small canonical-template table (one obvious minimal
 * implementation per name, e.g. "get_admin_panel" is authorization gated on
 * an admin role). Where a function has two claim-shape variants elsewhere in
 * the dataset (singular 'role' string vs a 'roles' list), the template
 * generalizes over both rather than guessing one, so it is correct
 * regardless of which shape the *current* row's own `mock_identity_provider`
 * implies. A name with no template is honestly reported as unresolved rather
 * than executed against an invented body.
 */
'use strict';

const crypto = require('crypto');

const SECRET = 'auth-flow-verify-secret';
const WRONG_SECRET = 'auth-flow-verify-wrong-secret';

const CANONICAL_TEMPLATES = {
  get_profile: [
    'def get_profile(request_token):',
    '    try:',
    "        payload = jwt.decode(request_token, SECRET, algorithms=['HS256'])",
    '    except jwt.InvalidTokenError:',
    '        return 401',
    "    if payload.get('revoked'):",
    '        return 401',
    "    return {'status': 200, 'user': payload.get('sub')}",
  ].join('\n'),
  get_admin_panel: [
    'def get_admin_panel(request_token):',
    '    try:',
    "        payload = jwt.decode(request_token, SECRET, algorithms=['HS256'])",
    '    except jwt.InvalidTokenError:',
    '        return 401',
    "    roles = payload.get('roles')",
    '    if roles is None:',
    "        roles = [payload['role']] if 'role' in payload else []",
    "    if 'admin' not in roles:",
    '        return 403',
    "    return {'status': 200, 'panel': 'admin-data'}",
  ].join('\n'),
  get_reports: [
    "def get_reports(request_token, required_scope='reports:read'):",
    '    try:',
    "        payload = jwt.decode(request_token, SECRET, algorithms=['HS256'])",
    '    except jwt.InvalidTokenError:',
    '        return 401',
    "    scopes = payload.get('scope', '').split()",
    '    if required_scope not in scopes:',
    '        return 403',
    "    return {'status': 200, 'reports': []}",
  ].join('\n'),
  refresh_access_token: [
    'def refresh_access_token(refresh_token):',
    '    try:',
    "        payload = jwt.decode(refresh_token, SECRET, algorithms=['HS256'])",
    '    except jwt.InvalidTokenError:',
    '        return 401',
    "    if payload.get('type') != 'refresh':",
    '        return 401',
    "    new_access = jwt.encode({'sub': payload.get('sub'), 'type': 'access', 'exp': time.time() + 300}, SECRET, algorithm='HS256')",
    "    return {'status': 200, 'access_token': new_access}",
  ].join('\n'),
  get_resource: [
    'def get_resource(request_token, resource_owner_id):',
    '    try:',
    "        payload = jwt.decode(request_token, SECRET, algorithms=['HS256'])",
    '    except jwt.InvalidTokenError:',
    '        return 401',
    "    if payload.get('sub') != resource_owner_id:",
    '        return 403',
    "    return {'status': 200, 'resource': 'data-for-' + str(resource_owner_id)}",
  ].join('\n'),
  get_data: [
    "def get_data(request_token, required_audience='api.example.com'):",
    '    try:',
    "        payload = jwt.decode(request_token, SECRET, algorithms=['HS256'], audience=required_audience)",
    '    except jwt.InvalidTokenError:',
    '        return 401',
    "    return {'status': 200, 'data': 'secret-data'}",
  ].join('\n'),
  get_billing: [
    'def get_billing(request_token):',
    '    try:',
    "        payload = jwt.decode(request_token, SECRET, algorithms=['HS256'])",
    '    except jwt.InvalidTokenError:',
    '        return 401',
    "    if payload.get('mfa_verified') is not True:",
    '        return 403',
    "    return {'status': 200, 'billing': 'sensitive-data'}",
  ].join('\n'),
};

function extractDefName(code) {
  const m = code.match(/def\s+(\w+)\s*\(/);
  return m ? m[1] : null;
}

/** Statically confirm `code` contains exactly one top-level function
 * definition and nothing else, using Python's own ast.parse (never
 * executing the candidate) in a disposable subprocess. Below, `resolved.code`
 * is spliced into the verification script as literal source, in the SAME
 * process that later builds the JWT, calls the function, and prints the
 * @@OUT result line -- without this check, any extra top-level statement
 * (an early `print('@@OUT ...')` + `sys.exit(0)` that forges the verdict, or
 * an `import jwt; jwt.decode = lambda *_,**__: {...}` that monkey-patches
 * the shared module before the real call happens) runs inline and can
 * fabricate the result outright. This is checked by parsing `code` as a
 * string in a separate process that never calls exec()/eval() on it -- a
 * malicious payload cannot influence its own validation. */
function validateSingleFunctionDef(code, h) {
  const validator = [
    'import ast, json, sys',
    'src = sys.stdin.read()',
    'try:',
    '    tree = ast.parse(src)',
    'except SyntaxError as e:',
    '    print(json.dumps({"ok": False, "reason": "syntax error: " + str(e)}))',
    '    sys.exit(0)',
    'body = tree.body',
    'ok = len(body) == 1 and isinstance(body[0], (ast.FunctionDef, ast.AsyncFunctionDef))',
    'name = body[0].name if ok else None',
    'print(json.dumps({"ok": ok, "name": name, "topLevelStatementCount": len(body)}))',
  ].join('\n');
  const r = h.run('python3', ['-c', validator], { input: code, timeoutMs: 10000 });
  if (r.status !== 0) return { ok: false, reason: 'validator crashed: ' + String(r.stderr).slice(0, 300) };
  const parsed = h.jsonOf(String(r.stdout || '').trim());
  return parsed || { ok: false, reason: 'validator produced no parseable output' };
}

/** Resolve `auth_flow_code`, expanding a "same X() as above" reference via
 * the canonical template table. Returns { code, name, isPlaceholder } or
 * { unresolved: name }. `isPlaceholder: true` means `code` is a
 * harness-authored stand-in, not anything the submission itself wrote --
 * the caller must never let that execute as if it were a verified result
 * for the actual submission (see the placeholder check in verify()). */
function resolveCode(rawCode) {
  const trimmed = rawCode.trim();
  // Natural rewordings of the identical back-reference idea -- "same as
  // X() above", "see X() above", "identical to X() as above", an optional
  // trailing period -- all name the same unresolvable sibling-row
  // situation, so all must route the same way rather than a rewording
  // silently falling through to a misleadingly-worded "no def statement"
  // failure below.
  const stub =
    trimmed.match(/^(?:same(?:\s+as)?|see|identical to)\s+(\w+)\(\)\s+as\s+above\.?$/i) ||
    trimmed.match(/^(?:same(?:\s+as)?|see|identical to)\s+(\w+)\(\)\s+above\.?$/i);
  if (!stub) return { code: rawCode, name: extractDefName(rawCode), isPlaceholder: false };
  const name = stub[1];
  const tmpl = CANONICAL_TEMPLATES[name];
  if (!tmpl) return { unresolved: name };
  return { code: tmpl, name, isPlaceholder: true };
}

/**
 * Whether the request scenario explicitly describes a token state. Provider
 * prose often says it *can* issue, reject, or track tokens with a property
 * (for example, "tracks revoked sessions"). That is capability/background,
 * not an instruction to synthesize every request token with that property.
 * Read request-specific state from test_scenarios only; explicit negation
 * wins when an author says, for example, "without tampering" or
 * "fresh non-revoked token".
 */
function hasScenarioState(scenario, positive, negative) {
  return positive.test(scenario) && !(negative && negative.test(scenario));
}

/** Derive the token/call scenario from test_scenarios (never from
 * expected_access_results, which is the claim being checked). The identity
 * provider describes the available protocol, while test_scenarios describes
 * the particular request token to synthesize. */
function buildSpec(_mock, scenario) {
  const scenarioText = String(scenario || '');
  const spec = {
    malformed: false,
    tampered: false,
    wrongSecret: false,
    expOffsetSec: 300,
    nbfOffsetSec: null,
    aud: null,
    role: null,
    roles: null,
    scope: null,
    type: null,
    revoked: false,
    mfaVerified: null,
    sub: 'alice',
    resourceOwnerId: null,
  };

  spec.malformed = hasScenarioState(
    scenarioText,
    /malformed|garbage token|garbage string|garbage\/malformed|no token at all|not a (?:real|valid) token|gibberish|corrupt(?:ed)? token|junk (?:string|token)/i,
    /(?:not|non)[-\s]+malformed|well[-\s]+formed/i
  );
  spec.tampered = hasScenarioState(
    scenarioText,
    /tamper|flip(?:ped|s)?|bit[- ]flip|alter(?:ed|ing|s)?\s+(?:the\s+)?(?:payload|token|signature)|modif(?:y|ied|ies|ication)\s+(?:the\s+)?(?:payload|token)/i,
    /(?:without|not|never|non)[-\s]+(?:being\s+)?tamper(?:ed|ing)?|untampered|intact token/i
  );
  spec.wrongSecret = hasScenarioState(
    scenarioText,
    /\bwrong[-\s]+(?:secret|key)\b|\buntrusted(?:[-\s]+(?:signer|key|secret))\b|\buntrusted\/wrong key\b|\bdifferent (?:key|secret)\b|\bnot (?:the |signed with the )?(?:trusted|expected|correct) (?:secret|key)\b|\bunauthorized key\b|\bsomeone else'?s? key\b|\battacker[-\s]+controlled(?:[-\s]+(?:signer|key|secret))?\b/i,
    /\b(?:not|no|without)[-\s]+(?:the\s+)?(?:wrong|untrusted)(?:[-\s]+(?:signer|key|secret))?\b|\btrusted (?:signer|key|secret)\b/i
  );
  if (hasScenarioState(
    scenarioText,
    /\bnow[-\s]+expired\b|\bexpired\b|\b(?:expiry|expiration)(?:\s+(?:timestamp|time|claim))?\b[^.]{0,60}\b(?:has )?(?:passed|elapsed|is in the past)\b|\bafter\b[^.]{0,40}\b(?:expiry|expiration)\b/i,
    /not yet expired|has not expired|hasn't expired|is not expired|(?:before|prior to) (?:the )?(?:expiry|expiration)|expires? (?:in the future|later)/i
  )) spec.expOffsetSec = -300;

  const nbfIdx = scenarioText.search(/\bnbf\b/i);
  if (nbfIdx !== -1) {
    // Stop at the next distinct claim ('exp' as a standalone word, not
    // "expired"/"expiry") so ITS direction words can't leak into the nbf
    // clause below (e.g. "nbf ... has already passed and exp has not yet
    // arrived"). Deliberately NOT cut on every "and" -- natural authoring
    // often continues describing the SAME nbf claim across one ("an nbf
    // claim, and it is set in the future"), which a blind "and" cut would
    // truncate before the direction words ever appear.
    const rest = scenarioText.slice(nbfIdx);
    const expBoundary = rest.search(/\bexp\b/i);
    const nbfClause = expBoundary > 0 ? rest.slice(0, expBoundary) : rest;
    if (/already passed|in the past|has passed/i.test(nbfClause)) spec.nbfOffsetSec = -300;
    else if (/not yet arrived|in the future|has not arrived/i.test(nbfClause)) spec.nbfOffsetSec = 300;
  }

  spec.revoked = hasScenarioState(
    scenarioText,
    /\brevoked\b/i,
    /(?:not|never|non)[-\s]+revoked|unrevoked|revoked\s*(?:=|is)\s*false|no revocation/i
  );

  if (/mfa_verified|mfa[- ]?verified|step-up|multi-factor|two-factor|\b2fa\b|second factor/i.test(scenarioText)) {
    spec.mfaVerified = !/lacks mfa_verified|only completed basic|without.*mfa|does not have mfa|has(?:n't| not) completed|did not complete|no step-up|single-factor|not mfa[- ]?verified|mfa_verified (?:is )?(?:false|absent|missing|not (?:true|present))/i.test(scenarioText);
  }

  const audMatch = scenario.match(/(?:audience|\baud\b)[^'"]*?['"]([^'"]+)['"]/i);
  if (audMatch) spec.aud = audMatch[1];

  const roleMatch = scenario.match(/role(?!s)\s*(?:is|of|:|=)?\s*'([^']+)'/i);
  if (roleMatch) spec.role = roleMatch[1];

  const rolesMatch = scenario.match(/roles\s*(?:list\s*)?(?:is|:|=)?\s*\[([^\]]+)\]/i);
  if (rolesMatch) {
    spec.roles = rolesMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  }

  const scopeQuotes = [...scenario.matchAll(/'([\w:]+)'/g)].map((m) => m[1]).filter((v) => v.includes(':'));
  if (/scope/i.test(scenarioText) && scopeQuotes.length) {
    spec.scope = /includes.*among others|among others|in addition to|along with other|plus other|as well as other/i.test(scenario)
      ? scopeQuotes.join(' ') + ' extra:scope'
      : scopeQuotes[0];
  }

  if (/access token/i.test(scenario)) spec.type = 'access';
  else if (/refresh token/i.test(scenario)) spec.type = 'refresh';

  const userMatch = scenario.match(/user '([^']+)'/i);
  if (userMatch) spec.sub = userMatch[1];
  const ownerMatch = scenario.match(/(?:owned by|belongs? to|belonging to)\s*'([^']+)'/i);
  if (ownerMatch) spec.resourceOwnerId = ownerMatch[1];
  else if (/own resource|their own (?:resource|data)|resource that('?s| is) theirs/i.test(scenario)) spec.resourceOwnerId = spec.sub;

  return spec;
}

module.exports = {
  contract: 'claim-vs-execution contradiction check',
  requires: ['python3'],

  verify(row, h) {
    const rawCode = h.str(row, 'auth_flow_code');
    const mock = h.str(row, 'mock_identity_provider');
    const scenario = h.str(row, 'test_scenarios');
    const expectedRaw = h.str(row, 'expected_access_results');
    if (!rawCode || !mock || !scenario || !expectedRaw) {
      return { passed: false, detail: { reason: 'missing auth_flow_code, mock_identity_provider, test_scenarios or expected_access_results' } };
    }

    // FLAWED rows always state the claim explicitly after "claims"; anchoring
    // there means a genuinely different number mentioned earlier in the same
    // sentence (a duration, a port, an unrelated status) can never be picked
    // up instead. Non-flawed rows always lead the sentence with the status
    // ("200, ..." / "401 -- ..."), so requiring the number to be the leading
    // token (rather than merely "the first number anywhere in the string")
    // rejects that same class of false extraction rather than guessing wrong.
    const claimedFlawed = expectedRaw.trim().match(/\bclaims?\s+(\d{3})\b/i);
    const claimedLeading = expectedRaw.trim().match(/^(\d{3})\b/);
    const claimedMatch = claimedFlawed || claimedLeading;
    if (!claimedMatch) {
      return { passed: false, logs: 'expected_access_results has no parseable leading/claimed 3-digit status: ' + expectedRaw.slice(0, 200), detail: {} };
    }
    const claimed = Number(claimedMatch[1]);

    const resolved = resolveCode(rawCode);
    if (resolved.unresolved) {
      return { passed: false, logs: `auth_flow_code references "${resolved.unresolved}()" which has no canonical template`, detail: { unresolvedReference: resolved.unresolved } };
    }
    if (!resolved.name) {
      // A botched back-reference ("...as above" in some form resolveCode()
      // doesn't recognize) is the same unresolvable-sibling-row situation as
      // a clean one -- route it to human review too, rather than a flat,
      // contributor-blaming "no def statement" failure.
      if (/\babove\b/i.test(rawCode) && rawCode.length < 200) {
        return {
          passed: false,
          runtimeUnavailable: true,
          logs: 'auth_flow_code appears to reference another row ("...above") in a form this harness does not recognize -- cannot mechanically verify',
          detail: { rawCode: rawCode.slice(0, 200) },
        };
      }
      return { passed: false, logs: 'could not find a def statement in auth_flow_code', detail: {} };
    }
    // A live submission is never legitimately "same X() as above" -- that
    // shorthand only makes sense as a back-reference within the labeled
    // reference dataset this harness was validated against, and this
    // single-row verify() has no access to confirm any such sibling exists.
    // Executing the harness-authored template instead of anything the
    // submission wrote would let a placeholder with no real code attached
    // earn a genuine execution-verified pass -- route to human audit instead.
    if (resolved.isPlaceholder) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: `auth_flow_code is the placeholder "same ${resolved.name}() as above" -- no real code was submitted to execute, so this cannot be mechanically verified`,
        detail: { placeholderReference: resolved.name },
      };
    }

    if (!h.have('python3')) return { passed: false, runtimeUnavailable: true, logs: 'python3 unavailable', detail: { runtime: 'python3' } };
    // PyJWT comes from the verified image, never from a runtime install:
    // sandbox execution is no-network by design. If it is missing the sandbox is
    // not the verified image, so report runtimeUnavailable (manual review)
    // rather than recording a false failure against the contributor.
    // Explicit short timeout: previously unguarded (inherited whatever
    // run()'s own shared default fell back to), which combined with this
    // file's own main-run timeout below could approach the outer sandbox
    // command budget deployed at the time (30000ms; raised to 120000ms as
    // of the current deploy, infra/terraform/ssm.tf). A
    // cold "import jwt" check is not remotely close to even this reduced
    // value in practice.
    const jwtOk = h.run('python3', ['-c', 'import jwt'], { timeoutMs: 3000 }).status === 0;
    if (!jwtOk) return { passed: false, runtimeUnavailable: true, logs: 'PyJWT unavailable in this sandbox image', detail: { runtime: 'PyJWT' } };

    // resolved.isPlaceholder rows already returned above, so resolved.code
    // here is always what the submission itself wrote -- exactly the case
    // this injection check needs to cover.
    const staticCheck = validateSingleFunctionDef(resolved.code, h);
    if (!staticCheck.ok) {
      return {
        passed: false,
        logs: `auth_flow_code must contain exactly one function definition and nothing else (${staticCheck.reason || 'multiple top-level statements or non-function code detected'})`,
        detail: { staticCheck },
      };
    }

    const spec = buildSpec(mock, scenario);

    // get_resource() takes resource_owner_id as a required positional
    // argument. If test_scenarios/mock_identity_provider never names the
    // owner in a way buildSpec() recognizes, calling the function below
    // would raise a TypeError that the script's own try/except would then
    // misreport as "auth_flow_code raised an uncaught exception" -- i.e. the
    // harness's own extraction gap, blamed on the contributor. Route to
    // human review instead.
    const needsResourceOwnerId = /def\s+\w+\s*\([^)]*\bresource_owner_id\b/.test(resolved.code);
    if (needsResourceOwnerId && spec.resourceOwnerId == null) {
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: 'auth_flow_code requires a resource_owner_id argument but test_scenarios/mock_identity_provider does not name the resource owner in a recognized way',
        detail: { spec },
      };
    }

    const d = h.workdir();
    // resolved.code is spliced as literal source sharing this script's own
    // process -- validateSingleFunctionDef only confirms the TOP LEVEL is
    // exactly one function def, it has no way to (and does not try to)
    // inspect what's INSIDE that function's own body, which this script
    // later actually CALLS (see `func(token, **kwargs)` below). Confirmed
    // exploitable: a function body containing `print('@@OUT ' + <forged
    // json>); sys.exit(0)` runs to completion and terminates the process
    // before this script's own trailing print (the only real trust signal)
    // ever executes -- h.lastMarked takes the LAST matching line, and
    // without a real second line, the forged one simply wins outright. Fixed
    // the same way every other polyglot-execution category in this registry
    // already is: h.PY_PRELUDE traps sys.exit()/os._exit()/exit()/quit() to
    // raise instead of terminating, the func() call below is wrapped in
    // except BaseException (not just Exception) so a raw `raise
    // SystemExit(...)` is caught too, and the marker is a per-run random
    // string rather than the fixed '@@OUT ' text -- closing the residual an
    // atexit.register() callback would otherwise still have (registered
    // inside the function body, firing at normal interpreter shutdown well
    // after this script's own trailing print already ran, the same bug class
    // already found and fixed in network_protocol_fsm/web_scraping).
    const mark = '@@OUT_' + crypto.randomBytes(12).toString('hex') + '_';
    const scriptLines = [
      h.PY_PRELUDE,
      'import json, time, os',
      'import jwt',
      'SECRET = ' + JSON.stringify(SECRET),
      'WRONG_SECRET = ' + JSON.stringify(WRONG_SECRET),
      '',
      resolved.code,
      '',
      'SPEC = json.loads(' + JSON.stringify(JSON.stringify(spec)) + ')',
      '',
      'now = time.time()',
      "claims = {'sub': SPEC.get('sub') or 'alice'}",
      "if SPEC.get('role') is not None: claims['role'] = SPEC['role']",
      "if SPEC.get('roles') is not None: claims['roles'] = SPEC['roles']",
      "if SPEC.get('scope') is not None: claims['scope'] = SPEC['scope']",
      "if SPEC.get('type') is not None: claims['type'] = SPEC['type']",
      "if SPEC.get('revoked'): claims['revoked'] = True",
      "if SPEC.get('mfaVerified') is not None: claims['mfa_verified'] = SPEC['mfaVerified']",
      "if SPEC.get('aud') is not None: claims['aud'] = SPEC['aud']",
      "claims['exp'] = now + SPEC.get('expOffsetSec', 300)",
      "if SPEC.get('nbfOffsetSec') is not None: claims['nbf'] = now + SPEC['nbfOffsetSec']",
      '',
      "signing_key = WRONG_SECRET if SPEC.get('wrongSecret') else SECRET",
      "if SPEC.get('malformed'):",
      "    token = 'not-a-real-token-xyz'",
      'else:',
      "    token = jwt.encode(claims, signing_key, algorithm='HS256')",
      "    if SPEC.get('tampered'):",
      "        parts = token.split('.')",
      '        seg = parts[1]',
      '        c0 = seg[0]',
      "        parts[1] = ('b' if c0 != 'b' else 'c') + seg[1:]",
      "        token = '.'.join(parts)",
      '',
      'import inspect',
      'func = globals()[' + JSON.stringify(resolved.name) + ']',
      'params = inspect.signature(func).parameters',
      'kwargs = {}',
      "if 'resource_owner_id' in params and SPEC.get('resourceOwnerId') is not None:",
      "    kwargs['resource_owner_id'] = SPEC['resourceOwnerId']",
      'try:',
      '    result = func(token, **kwargs)',
      "    out = {'ok': True, 'result': result}",
      'except BaseException as e:',
      "    out = {'ok': False, 'error': type(e).__name__ + ': ' + str(e)}",
      // os.write(1, ...) writes directly to the real OS file descriptor,
      // never through the `sys.stdout` Python object -- a plain `print()`
      // call resolves its output stream from `sys.stdout` FRESH at every
      // call, so a function body (auth_flow_code, called just above via
      // `func(token, **kwargs)`) reassigning `sys.stdout` would intercept a
      // `print()` call here regardless of the per-run marker's randomness
      // -- confirmed exploitable, the same class already found and fixed
      // in compression's/competitive_programming's harnesses.
      "os.write(1, (" + JSON.stringify(mark) + " + json.dumps(out, default=str) + '\\n').encode('utf-8', 'replace'))",
    ];
    h.fs.writeFileSync(h.path.join(d, 'run_auth.py'), scriptLines.join('\n'));

    const r = h.run('python3', [h.path.join(d, 'run_auth.py')], { cwd: d, timeoutMs: 15000 });
    if (r.status !== 0) {
      return { passed: false, logs: 'harness script crashed: ' + String(r.stderr).slice(0, 1500), detail: { ranClean: false, spec } };
    }
    const outRaw = h.lastMarked(String(r.stdout), mark);
    if (outRaw === null) {
      return { passed: false, logs: 'no @@OUT marker in script output', detail: { stdout: String(r.stdout).slice(0, 500), stderr: String(r.stderr).slice(0, 500) } };
    }
    const out = h.jsonOf(outRaw);
    if (out === null) {
      return { passed: false, logs: 'could not parse harness script output', detail: { outRaw: outRaw.slice(0, 500) } };
    }

    if (!out.ok) {
      return { passed: false, logs: 'auth_flow_code raised an uncaught exception: ' + out.error, detail: { execThrew: out.error, spec } };
    }

    const actual = out.result;
    const actualStatus = typeof actual === 'number' ? actual : actual && typeof actual === 'object' ? actual.status : null;
    if (actualStatus === null || actualStatus === undefined) {
      return { passed: false, logs: 'function returned neither a bare status nor a dict with a status key: ' + JSON.stringify(actual).slice(0, 300), detail: { actual, spec } };
    }

    const matched = actualStatus === claimed;
    return {
      passed: matched,
      logs: matched ? '' : `expected_access_results claims ${claimed} but real execution returned ${actualStatus}`,
      detail: { claimed, actualStatus, spec, resolvedFrom: resolved.name },
    };
  },
};
