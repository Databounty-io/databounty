/**
 * schema-and-fact-consistency — no code runs here at all; this verifies an
 * LLM agent's tool-use TRACE is internally consistent:
 *  - tool_call_json must be valid JSON naming a function that exists in
 *    available_tools_schema, supplying every parameter the schema requires.
 *  - final_answer must actually state the facts tool_response contains
 *    (every leaf value, loosely matched for numeric formatting).
 *
 * This intentionally does NOT verify that tool_response itself is factually
 * correct (e.g. a currency conversion using a fabricated exchange rate, or a
 * mock weather response for a fictional city) — that needs real-world
 * ground truth this dataset doesn't provide, not a structural check. Rows
 * whose only flaw is a wrong-but-internally-consistent tool_response will
 * pass here and need human/LLM audit to catch.
 */
'use strict';

const CURRENCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', INR: '₹' };

// Internal identifiers and raw booleans are typically NOT restated literally
// in a natural-language answer ("Got it, I've set a reminder" rather than
// "reminder_id: rem_501, confirmed: true") — only requiring the
// user-relevant facts (price, balance, count, status text) avoids treating
// that natural phrasing as a missing fact.
//
// The camelCase check (`[a-z]Id$`) is deliberately case-SENSITIVE and
// requires the capital I: `_id$`/`^id$` are already case-insensitive, and
// naively adding a bare case-insensitive `id$` here to catch "orderId" would
// also match any ordinary word ending in "id" (solid, paid, grid, valid) —
// silently exempting those as "internal" and making them unfalsifiable
// facts. Requiring the capital I keeps this to the actual camelCase
// convention (orderId, userId, transactionId) without that collateral damage.
function isInternalKey(key) {
  return /(^id$|_id$)/i.test(key) || /[a-z]Id$/.test(key);
}

// `out` collects facts that MUST all appear; `arrayOut` collects facts from
// inside an array of multiple items (e.g. a list of flight options) — a
// reasonable answer summarizes those (mentions the cheapest, say) rather
// than restating every item's every field, so those are checked more
// loosely: at least one must appear, not all of them.
function collectLeafFacts(value, key, out, arrayOut) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) collectLeafFacts(v, key, arrayOut, arrayOut);
  } else if (typeof value === 'object') {
    for (const k of Object.keys(value)) collectLeafFacts(value[k], k, out, arrayOut);
  } else if (typeof value === 'boolean' || isInternalKey(key)) {
    // skip — not expected to be restated literally
  } else if (typeof value === 'string' && (value.trim().startsWith('{') || value.trim().startsWith('['))) {
    // A string leaf that is ITSELF JSON text (a doubly-encoded field, e.g.
    // a "data" key whose value is a JSON-stringified object) is not
    // something any natural answer would restate verbatim — recurse into
    // its parsed form so the facts checked are the real leaf values, not
    // the opaque wrapper string.
    const inner = (() => { try { return JSON.parse(value); } catch (e) { return undefined; } })();
    if (inner !== undefined && inner !== null && typeof inner === 'object') {
      collectLeafFacts(inner, key, out, arrayOut);
    } else {
      out.push({ key, value });
    }
  } else {
    out.push({ key, value });
  }
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function numericVariants(v) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return [];
  const variants = new Set([String(v), String(n), String(Math.trunc(n))]);
  for (let d = 0; d <= 4; d++) variants.add(n.toFixed(d));
  // A fraction/rate is routinely restated as a percentage ("0.53" -> "53%").
  if (Math.abs(n) <= 1) {
    const pct = n * 100;
    variants.add(String(pct) + '%');
    for (let d = 0; d <= 2; d++) variants.add(pct.toFixed(d) + '%');
  }
  return [...variants];
}

/**
 * Does `answerNorm` contain this numeric variant as an actual NUMBER, not
 * merely as a run of the same digits inside a longer, different number?
 * Plain `String.includes` let a fact of 1 match inside "10 days", a fact of
 * 42 match inside "142", and a fact of 1000000 match inside "100,000,000"
 * (a 100x different figure) — this requires the digit run not be
 * immediately bordered by another digit or a decimal point on either side.
 */
function numericVariantStated(answerNorm, variant) {
  // Lookbehind excludes any preceding digit or decimal point (so "5" can't
  // match inside "12.5" or "125"). Lookahead only excludes a following
  // digit, or a decimal point that itself continues into another digit
  // (so "42" can't match inside "142" or "42.5") — a following decimal
  // point that does NOT continue into a digit is ordinary sentence
  // punctuation ("...is $42.") and must not disqualify the match.
  const re = new RegExp('(?<![\\d.])' + escapeRegExp(variant) + '(?!\\d)(?!\\.\\d)');
  return re.test(answerNorm);
}

// A monetary amount is usually written with thousands separators
// ("$2,543.19") — comparing against the comma-stripped answer text avoids
// treating that formatting as a missing fact.
function stripCommasInNumbers(text) {
  return text.replace(/(\d),(\d)/g, '$1$2');
}

/** Top-level comma split, ignoring commas nested inside (), [], {} — a
 * parameter type annotation like `Dict[str, str]` or `List[int, int]` has
 * an internal comma that must not be treated as a parameter separator. */
function splitTopLevelCommas(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[' || c === '(' || c === '{') depth += 1;
    else if (c === ']' || c === ')' || c === '}') depth -= 1;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

module.exports = {
  contract: 'schema-and-fact-consistency',
  requires: [],

  verify(row, h) {
    const schema = h.str(row, 'available_tools_schema');
    const toolCallJson = h.str(row, 'tool_call_json');
    const toolResponse = h.str(row, 'tool_response');
    const finalAnswer = h.str(row, 'final_answer');
    // tool_response is schema.json's own "required": true — it used to be
    // exempt from this check, which combined with the JSON.parse fallback
    // below to make an empty/malformed tool_response the cheapest possible
    // way to bypass the entire fact-consistency gate.
    if (!schema || !toolCallJson || !toolResponse || !finalAnswer) {
      return { passed: false, detail: { reason: 'missing available_tools_schema, tool_call_json, tool_response, or final_answer' } };
    }

    let call;
    try { call = JSON.parse(toolCallJson); } catch (e) {
      return { passed: false, logs: 'tool_call_json is not valid JSON: ' + e.message, detail: {} };
    }
    if (!call || typeof call.name !== 'string' || typeof call.arguments !== 'object' || call.arguments === null) {
      return { passed: false, logs: 'tool_call_json is missing a string "name" or object "arguments"', detail: {} };
    }

    // available_tools_schema names AVAILABLE tools, plural — often more than
    // one, and written in whatever prose shape a contributor chooses: one
    // signature per line, several joined with "and"/commas on one line, or
    // a bulleted/numbered list. Matched ANYWHERE in the text rather than
    // anchored to a line start — the anchored version rejected every
    // correct call to a tool whose signature wasn't the very first token on
    // its own line, which is not an exotic way to write this field.
    // NOT_A_TOOL_NAME guards the small set of common words that precede an
    // ordinary parenthetical aside in prose ("the weather (in celsius)"
    // should not be read as a tool literally named "weather"). `[\w-]+`
    // (not just `\w+`) also accepts a kebab-case tool name.
    const NOT_A_TOOL_NAME = new Set(['see', 'eg', 'ie', 'example', 'note', 'also', 'call', 'calling', 'using', 'via', 'like', 'such', 'returns', 'similar', 'above', 'below', 'the', 'a', 'an']);
    const schemaMatches = [...schema.matchAll(/\b([\w-]+)\s*\(([^)]*)\)/g)].filter((m) => !NOT_A_TOOL_NAME.has(m[1].toLowerCase()));
    if (!schemaMatches.length) return { passed: false, logs: 'could not parse a function signature from available_tools_schema', detail: { schema: schema.slice(0, 150) } };
    const tools = schemaMatches.map((m) => ({
      name: m[1],
      // Top-level comma split (not a bare .split(',')) so a type annotation
      // with its own internal comma (Dict[str, str], List[int, int]) isn't
      // mistaken for two separate parameters. The name is the leading
      // identifier token, not "everything before the first colon" — a
      // parameter written with a default and no type (`limit=10`, common
      // informal style) has no colon at all, and the old split-on-":"
      // extraction took the whole "limit=10" as the parameter's NAME,
      // making every correct call to that signature fail as "missing
      // required argument limit=10" regardless of what was actually passed.
      //
      // `optional` (a parameter carrying `= <default>` anywhere after its
      // name, e.g. "units: string = 'celsius'" or the informal "limit=10")
      // is tracked separately from the name itself: every extracted
      // parameter used to be treated as unconditionally REQUIRED regardless
      // of whether it had a default, so a genuinely correct call that
      // omitted a defaulted argument -- exactly how a real function-calling
      // API caller behaves -- was rejected as "missing required argument".
      params: splitTopLevelCommas(m[2])
        .map((p) => {
          const t = p.trim();
          const pm = t.match(/^([\w-]+)/);
          return pm ? { name: pm[1], optional: t.includes('=') } : null;
        })
        .filter(Boolean),
    }));

    const matchedTool = tools.find((t) => t.name === call.name);
    if (!matchedTool) {
      return {
        passed: false,
        logs: 'tool_call_json calls "' + call.name + '" but available_tools_schema defines: ' + tools.map((t) => t.name).join(', '),
        detail: { called: call.name, availableTools: tools.map((t) => t.name) },
      };
    }

    const paramNames = matchedTool.params.map((p) => p.name);
    const callArgKeys = Object.keys(call.arguments);
    const missingParams = matchedTool.params.filter((p) => !p.optional && !callArgKeys.includes(p.name)).map((p) => p.name);
    if (missingParams.length) {
      return {
        passed: false,
        logs: 'tool_call_json is missing required argument(s): ' + missingParams.join(', '),
        detail: { missingParams, schemaParams: paramNames, callArgKeys },
      };
    }
    // The reverse check: every argument in the call must be something the
    // schema actually declares (required OR optional-with-default -- an
    // optional parameter is still a legitimate one to supply, just not
    // mandatory). Without this, a call carrying a fabricated/hallucinated
    // extra parameter the tool doesn't define was indistinguishable from a
    // genuinely clean call.
    const extraParams = callArgKeys.filter((k) => !paramNames.includes(k));
    if (extraParams.length) {
      return {
        passed: false,
        logs: 'tool_call_json supplies argument(s) not declared by the matched tool: ' + extraParams.join(', '),
        detail: { extraParams, schemaParams: paramNames, callArgKeys },
      };
    }

    let responseObj = null;
    let responseParseError = null;
    try { responseObj = JSON.parse(toolResponse); } catch (e) { responseParseError = e.message; }
    if (responseObj && typeof responseObj === 'object') {
      const facts = [];
      const arrayFacts = [];
      collectLeafFacts(responseObj, null, facts, arrayFacts);
      const answerNorm = stripCommasInNumbers(finalAnswer.toLowerCase());
      const factStated = ({ key, value }) => {
        const vNorm = String(value).toLowerCase();
        if (typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(vNorm)) {
          return numericVariants(value).some((variant) => numericVariantStated(answerNorm, variant.toLowerCase()));
        }
        // A currency code ("USD") is routinely written as its symbol
        // instead ("$154.32") — either satisfies the fact.
        if (/currency/i.test(key || '') && CURRENCY_SYMBOL[value.toUpperCase && value.toUpperCase()]) {
          if (answerNorm.includes(CURRENCY_SYMBOL[value.toUpperCase()])) return true;
        }
        return answerNorm.includes(vNorm);
      };

      const missingFacts = facts.filter((f) => !factStated(f));
      if (missingFacts.length) {
        return {
          passed: false,
          logs: 'final_answer does not state these facts from tool_response: ' + missingFacts.map((f) => f.key + '=' + f.value).join(', '),
          detail: { missingFacts, finalAnswer: finalAnswer.slice(0, 200) },
        };
      }
      // A response array (multiple flight options, etc.) is reasonably
      // summarized rather than enumerated — the answer needs to reference
      // at least ONE real item from it, not restate every field of every
      // item, so a totally fabricated answer still gets caught.
      if (arrayFacts.length && !arrayFacts.some(factStated)) {
        return {
          passed: false,
          logs: 'final_answer does not reference any item from the tool_response array',
          detail: { arrayFacts, finalAnswer: finalAnswer.slice(0, 200) },
        };
      }
    } else {
      // tool_response is required but didn't parse as a JSON object/array —
      // the mechanical fact-consistency check this category exists to run
      // cannot be performed against free-form prose. This used to silently
      // skip straight to passed:true, which made a single malformed
      // character (a trailing comma is the single most common LLM-JSON
      // slip) the cheapest possible way to launder a completely fabricated
      // final_answer through the harness undetected. Route to human audit
      // instead of fabricating a verdict this check has no basis for.
      return {
        passed: false,
        runtimeUnavailable: true,
        logs: 'tool_response is not valid JSON, so fact-consistency cannot be mechanically checked' + (responseParseError ? ': ' + responseParseError : ''),
        detail: { toolResponse: toolResponse.slice(0, 200) },
      };
    }

    return { passed: true, logs: '', detail: { calledFn: call.name, schemaFn: matchedTool.name } };
  },
};
