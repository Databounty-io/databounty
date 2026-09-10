/**
 * graphql_resolver — resolver-execution-and-structural-consistency.
 *
 * Every row supplies an SDL `schema_definition`, a resolver-map fragment
 * `resolver_code` (the inner body of `{ Type: { field: (parent,args)=>... } }`),
 * a `sample_query` document, and an `expected_response` JSON envelope.
 *
 * Two tiers, both applied to every row:
 *  1. Structural: build the schema from the SDL, wire each resolver map
 *     entry onto the matching type/field, and record an error for any
 *     resolver key that doesn't correspond to a real schema field (catches
 *     naming/typo bugs regardless of what data the resolver would return).
 *  2. Execution: ALWAYS actually run the query end-to-end with graphql-js —
 *     never skipped based on a static guess. If the resolver references an
 *     external `db` fixture (the dataset never defines `db` anywhere — it's
 *     an assumed, unsupplied external data source for the rows that use it),
 *     that surfaces as a REAL `ReferenceError: db is not defined` inside
 *     graphql-js's own per-field error handling, detected from the executed
 *     result's `errors[].originalError` — not from matching `resolver_code`'s
 *     source text against a regex. A text match is gameable (a dead comment
 *     mentioning "db.records" would previously skip execution entirely and
 *     rubber-stamp a structural-only pass regardless of what the resolver
 *     actually returns); requiring the runtime engine to actually throw
 *     specifically because `db` is undefined is not.
 *
 * Rows whose resolvers DO touch `db` get a structural-only verdict: there is
 * no ground truth in the row to reconstruct the literal business data (users,
 * books, prices, ...) that `db` would hold, and fabricating it would not be a
 * real verification. This mirrors api_function_calling's documented boundary
 * (tool_response's factual correctness is out of scope there for the same
 * "no ground truth supplied" reason). That bypass is restricted to rows whose
 * OWN expected_response claims `data` (never `errors`): a row that claims a
 * SPECIFIC error (e.g. "division by zero") and gets a DIFFERENT one (an
 * unrelated `db` ReferenceError) is a genuine mismatch, not something the
 * missing-fixture exception should excuse.
 *
 * resolver_code executes inline, sharing this script's process and stdout
 * with the harness's own structural/execution verdict logic that runs after
 * it -- unlike every other polyglot harness in this registry, this category
 * hand-rolls its own Node execution rather than going through the shared
 * h.runCode/h.runWithTests (which carry a process.exit trap for exactly this
 * reason). A resolver that prints a forged "@@OUT ..." line and then calls
 * process.exit(0) terminates the process with exit code 0 before the real
 * structural checks or graphql() call ever run, and h.run's own status check
 * never catches a clean, zero-status exit -- confirmed exploitable. Trusted
 * console.log/JSON.stringify references are captured, and process.exit is
 * trapped (so it throws -- caught by graphql-js's own per-field error
 * handling or the outer try/catch, letting real execution continue), all
 * BEFORE resolver_code ever runs; the verdict is emitted behind a per-run
 * random marker parsed via h.lastMarked, never "whatever the last line of
 * stdout happens to say."
 */
'use strict';

const crypto = require('crypto');

function extractLeadingFunctions(src) {
  // resolver_code sometimes prefixes the resolver map with one or more plain
  // `function name(...) { ... }` helper declarations (e.g. a `fib` helper
  // used by a `fibonacci` resolver). Those are STATEMENTS and cannot appear
  // as members of an object literal — wrapping the whole string in `({...})`
  // would be a syntax error. Peel them off so they can be re-emitted as
  // statements ahead of the object literal instead of inside it.
  let rest = src;
  let prelude = '';
  for (;;) {
    const m = rest.match(/^\s*function\s+\w+\s*\([^)]*\)\s*\{/);
    if (!m) break;
    const braceIdx = rest.indexOf('{', m.index);
    let depth = 0;
    let end = -1;
    for (let i = braceIdx; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break; // unbalanced — give up peeling, let it fail loudly downstream
    prelude += rest.slice(0, end + 1) + '\n';
    rest = rest.slice(end + 1);
  }
  return { prelude, rest };
}

module.exports = {
  contract: 'resolver-execution-and-structural-consistency',
  requires: ['node'],

  verify(row, h) {
    const schemaDef = h.str(row, 'schema_definition');
    const resolverCode = h.str(row, 'resolver_code');
    const sampleQuery = h.str(row, 'sample_query');
    const expectedRaw = h.str(row, 'expected_response');
    if (!schemaDef || !resolverCode || !sampleQuery || !expectedRaw) {
      return { passed: false, detail: { reason: 'missing schema_definition, resolver_code, sample_query or expected_response' } };
    }

    const expected = h.jsonOf(expectedRaw);
    if (expected === null || typeof expected !== 'object') {
      return { passed: false, logs: 'expected_response is not valid JSON: ' + expectedRaw.slice(0, 200), detail: {} };
    }

    if (!h.have('node')) {
      return { passed: false, runtimeUnavailable: true, logs: 'node unavailable', detail: { runtime: 'node' } };
    }

    // graphql@16 is installed globally in the verified image and never fetched
    // at runtime — sandbox execution is no-network by design. If the require
    // fails, the sandbox is not the verified image: report runtimeUnavailable so
    // the row goes to manual review instead of failing the contributor.
    // Explicit short timeout: previously unguarded, which combined with
    // this file's own main-run timeout below could approach the outer
    // sandbox command budget deployed at the time (30000ms; raised to
    // 120000ms as of the current deploy, infra/terraform/ssm.tf). A cold "require graphql" check is not
    // remotely close to even this reduced value in practice.
    const ok = h.run('node', ['-e', 'require("graphql")'], { timeoutMs: 3000 }).status === 0;
    if (!ok) return { passed: false, runtimeUnavailable: true, logs: 'graphql unavailable in this sandbox image', detail: { runtime: 'graphql' } };

    const { prelude, rest } = extractLeadingFunctions(resolverCode);
    const mark = '@@GQL_' + crypto.randomBytes(12).toString('hex') + '_';

    const d = h.workdir();
    const scriptLines = [
      "'use strict';",
      // process.exit is replaced with a function that THROWS rather than
      // terminating, so a resolver calling it can no longer forge a clean,
      // zero-status exit before the real verdict is ever computed. A
      // submission that catches the thrown error simply continues past it,
      // same as the shared JS_PRELUDE elsewhere in this registry.
      //
      // _real_console_log is NOT `console.log.bind(console)` -- binding
      // captures a reference to the console.log FUNCTION, but Node's
      // built-in console.log still writes through `process.stdout`'s own
      // `.write` METHOD internally, which is a plain, reassignable property
      // on a shared object. resolver_code doing
      // `process.stdout.write = <wrapper>` intercepts even a captured
      // `console.log.bind(console)` call's output, no matter when the bind
      // happened -- confirmed exploitable, the same class already found and
      // fixed in compression's/competitive_programming's harnesses.
      // fs.writeSync(1, ...) writes directly to the real OS file
      // descriptor, bypassing `process.stdout`/`console` entirely.
      'const _real_console_log = (s) => { require("fs").writeSync(1, s + "\\n"); };',
      'const _real_json_stringify = JSON.stringify;',
      'process.exit = function (c) { throw new Error("process.exit(" + c + ") called -- forbidden inside resolver code"); };',
      'process.reallyExit = process.exit;',
      '(async () => {',
      '  const { graphql, buildSchema, isInterfaceType, isUnionType, isScalarType } = require("graphql");',
      '  const typeDefs = ' + JSON.stringify(schemaDef) + ';',
      '  const sampleQuery = ' + JSON.stringify(sampleQuery) + ';',
      '  const out = { structuralErrors: [], executed: false };',
      '',
      '  let resolvers;',
      '  try {',
      '    resolvers = (new Function(' + JSON.stringify(prelude + '\nreturn ({' + rest + '});') + '))();',
      '  } catch (e) {',
      '    out.structuralErrors.push("resolver_code failed to evaluate: " + (e && e.message));',
      '    _real_console_log(' + JSON.stringify(mark) + ' + _real_json_stringify(out));',
      '    return;',
      '  }',
      '',
      '  let schema;',
      '  try {',
      '    schema = buildSchema(typeDefs);',
      '  } catch (e) {',
      '    out.structuralErrors.push("schema_definition failed to parse: " + (e && e.message));',
      '    _real_console_log(' + JSON.stringify(mark) + ' + _real_json_stringify(out));',
      '    return;',
      '  }',
      '',
      '  for (const typeName of Object.keys(resolvers)) {',
      '    const type = schema.getType(typeName);',
      '    if (!type) {',
      '      out.structuralErrors.push("resolver map references unknown type \\"" + typeName + "\\"");',
      '      continue;',
      '    }',
      '    const fieldResolvers = resolvers[typeName];',
      '    if (!fieldResolvers || typeof fieldResolvers !== "object") continue;',
      '    const isAbstract = isInterfaceType(type) || isUnionType(type);',
      '    const isScalar = isScalarType(type);',
      '    const hasFields = typeof type.getFields === "function";',
      '    const fields = hasFields ? type.getFields() : null;',
      '    for (const fieldName of Object.keys(fieldResolvers)) {',
      // __resolveType is graphql-js's own documented convention for interface
      // and union types (never a real schema field), and is assigned directly
      // to type.resolveType -- looking it up in getFields() (which for a
      // union does not even exist, and for an interface never includes it)
      // previously rejected every interface/union row supplying it as a
      // "no matching field" structural error before execution ever ran.
      // Scoped to isAbstract (interface/union) only: an object type has no
      // legitimate use for __resolveType (graphql-js never reads it there --
      // isTypeOf/default duck-typing governs object-type resolution
      // instead), so a resolver map that puts "__resolveType" under an
      // OBJECT type keeps being flagged as a genuine "no matching field"
      // structural error exactly like before, rather than silently becoming
      // a no-op that could mask a real naming mistake.
      '      if (fieldName === "__resolveType" && isAbstract) {',
      '        type.resolveType = fieldResolvers[fieldName];',
      '        continue;',
      '      }',
      // graphql-js's own documented convention for a custom scalar
      // (GraphQLScalarType, which has no getFields() at all -- confirmed
      // false for `typeof type.getFields === "function"`) is a resolver-map
      // entry like `DateTime: { serialize: fn, parseValue: fn, parseLiteral:
      // fn } assigned directly onto the scalar type object, exactly
      // analogous to __resolveType above. Looking these up in getFields()
      // previously rejected every row supplying a custom scalar this way as
      // "no matching field" before execution ever ran -- same root cause as
      // the __resolveType bug already fixed, just for a different,
      // equally-legitimate graphql-js convention.
      '      if (isScalar && (fieldName === "serialize" || fieldName === "parseValue" || fieldName === "parseLiteral")) {',
      '        type[fieldName] = fieldResolvers[fieldName];',
      '        continue;',
      '      }',
      '      if (!hasFields || !fields[fieldName]) {',
      '        out.structuralErrors.push("resolver key \\"" + typeName + "." + fieldName + "\\" has no matching field on schema type \\"" + typeName + "\\"");',
      '        continue;',
      '      }',
      '      fields[fieldName].resolve = fieldResolvers[fieldName];',
      '    }',
      '  }',
      '',
      '  let result;',
      '  try {',
      '    result = await graphql({ schema, source: sampleQuery });',
      '    out.executed = true;',
      '    out.result = result;',
      '  } catch (e) {',
      '    out.executed = true;',
      '    out.execThrew = String((e && e.message) || e);',
      '  }',
      '',
      '  if (result && Array.isArray(result.errors) && result.errors.length > 0) {',
      '    const dbMissing = result.errors.every((err) => {',
      '      const orig = err && err.originalError;',
      // instanceof, not a `.name === "ReferenceError"` string comparison --
      // .name is a normal, freely-reassignable property, so a resolver could
      // construct a plain Error, rename it, and throw that to spoof this
      // check regardless of what it actually did. instanceof checks the
      // REAL prototype chain, which only a genuine native ReferenceError
      // (or another explicit, deliberate spoof well beyond this scope) has.
      '      return !!orig && orig instanceof ReferenceError && /\\bdb\\b/.test(String(orig.message || ""));',
      '    });',
      '    if (dbMissing) {',
      '      out.dbUnavailable = true;',
      '      out.reason = "resolver_code references an undeclared `db` (or similar external fixture) at RUNTIME (confirmed by a real ReferenceError), not supplied by this row; structural-only verdict";',
      '    }',
      '  }',
      '',
      '  _real_console_log(' + JSON.stringify(mark) + ' + _real_json_stringify(out));',
      '})().catch((e) => { _real_console_log(' + JSON.stringify(mark) + ' + _real_json_stringify({ structuralErrors: ["uncaught: " + (e && e.message)] })); });',
    ];
    h.fs.writeFileSync(h.path.join(d, 's.js'), scriptLines.join('\n'));

    const r = h.run('node', [h.path.join(d, 's.js')], { cwd: d, timeoutMs: 20000 });
    if (r.status !== 0) {
      return { passed: false, logs: 'harness script crashed: ' + String(r.stderr).slice(0, 1500), detail: { ranClean: false } };
    }
    const outRaw = h.lastMarked(String(r.stdout), mark);
    if (outRaw === null) {
      return { passed: false, logs: 'no verdict marker in script output', detail: { stdout: String(r.stdout).slice(0, 500), stderr: String(r.stderr).slice(0, 500) } };
    }
    const out = h.jsonOf(outRaw);
    if (out === null) {
      return { passed: false, logs: 'could not parse harness script output', detail: { outRaw: outRaw.slice(0, 500) } };
    }

    const structuralOk = out.structuralErrors.length === 0;
    if (!structuralOk) {
      return {
        passed: false,
        logs: 'structural check failed: ' + out.structuralErrors.join('; '),
        detail: { structuralErrors: out.structuralErrors, executed: out.executed },
      };
    }

    const expectedHasErrors = Array.isArray(expected.errors);

    // Restricted to rows that claim `data` (never `errors`): the bypass
    // exists because this row's LITERAL data can't be verified without a
    // `db` fixture the dataset never supplies -- it was never meant to
    // excuse getting some OTHER, unrelated error instead of a row's own
    // SPECIFIC claimed error message. Without this restriction, a resolver
    // that references `db` for ANY reason on an error-claiming row (e.g.
    // "division by zero") would auto-pass regardless of whether it ever
    // produced that claimed error at all.
    if (out.dbUnavailable && !expectedHasErrors) {
      // db-touching row: structural wiring is correct and the query WAS
      // actually executed, but it failed specifically because `db` is a real
      // runtime ReferenceError — the literal business data this row's
      // expected_response claims (e.g. specific user names, prices) cannot
      // be independently verified without a fixture this dataset never
      // supplies. See module docstring.
      return {
        passed: true,
        logs: 'structural check passed; resolver_code references an undeclared external `db` fixture at runtime (confirmed by a real ReferenceError, not a text guess) — literal response data not independently verified',
        detail: { structuralOk: true, executed: true, dbUnavailable: true, reason: out.reason },
      };
    }

    if (out.execThrew) {
      return {
        passed: false,
        logs: 'query execution threw: ' + out.execThrew,
        detail: { structuralOk: true, executed: true, execThrew: out.execThrew },
      };
    }

    const actual = out.result || {};
    const actualHasErrors = Array.isArray(actual.errors) && actual.errors.length > 0;

    if (expectedHasErrors !== actualHasErrors) {
      return {
        passed: false,
        logs: expectedHasErrors
          ? 'expected_response claims an error but execution produced data: ' + JSON.stringify(actual).slice(0, 300)
          : 'expected_response claims data but execution produced an error: ' + JSON.stringify(actual).slice(0, 300),
        detail: { actual, expected },
      };
    }

    if (expectedHasErrors) {
      // Real graphql-js error objects carry extra keys (locations, path,
      // extensions) that expected_response never includes — comparing only
      // the message text is what the dataset actually claims.
      const actualMsgs = (actual.errors || []).map((e) => String(e && e.message));
      const expectedMsgs = (expected.errors || []).map((e) => String(e && e.message));
      const errsMatch = JSON.stringify(actualMsgs) === JSON.stringify(expectedMsgs);
      // GraphQL's null-propagation means a response can legitimately carry a
      // real PARTIAL `data` object alongside `errors` at the same time (a
      // non-null field error only nullifies the nearest NULLABLE ancestor,
      // not necessarily the whole response) -- when expected_response
      // supplies a `data` key alongside `errors`, that data half must match
      // too. Previously this branch never looked at data at all once
      // `errors` was present, so a resolver returning the right error but
      // WRONG data on a sibling field of a partially-null response would
      // falsely pass.
      const expectsData = Object.prototype.hasOwnProperty.call(expected, 'data') && expected.data !== undefined;
      const dataMatch = !expectsData || JSON.stringify(h.canonical(actual.data)) === JSON.stringify(h.canonical(expected.data));
      const matched = errsMatch && dataMatch;
      return {
        passed: matched,
        logs: matched ? '' : (!errsMatch
          ? 'error messages differ: actual=' + JSON.stringify(actualMsgs) + ' expected=' + JSON.stringify(expectedMsgs)
          : 'response data differs (errors matched): actual=' + JSON.stringify(actual.data).slice(0, 300) + ' expected=' + JSON.stringify(expected.data).slice(0, 300)),
        detail: { structuralOk: true, executed: true, actualMsgs, expectedMsgs, dataChecked: expectsData },
      };
    }

    const matched = JSON.stringify(h.canonical(actual.data)) === JSON.stringify(h.canonical(expected.data));
    return {
      passed: matched,
      logs: matched ? '' : 'response data differs: actual=' + JSON.stringify(actual.data).slice(0, 300) + ' expected=' + JSON.stringify(expected.data).slice(0, 300),
      detail: { structuralOk: true, executed: true, actual: actual.data, expected: expected.data },
    };
  },
};
