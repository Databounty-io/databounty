// SPDX-License-Identifier: Apache-2.0

/**
 * Redactor for UNTRUSTED execution logs (contributor code's stdout/stderr)
 * before they are stored as evidence and shown to validators/sponsors. Applies
 * to output from ANY sandbox provider (E2B, ec2, …) — it is wired in at the one
 * chokepoint in `service.ts` where provider logs enter the stored evidence row.
 *
 * DESIGN — deliberately conservative, a targeted redactor, NOT a DLP engine:
 *  - It masks only well-known secret SHAPES, so ordinary test output and code
 *    snippets pass through untouched. Over-redaction that mangles a validator's
 *    view is a real cost; the goal is to catch the obvious leaks.
 *  - It is PURE: string in, string out. No DB, no network, no heavy imports —
 *    keeps this off any hot dependency and trivially testable.
 *
 * TRUST-HONESTY GUARANTEE: redaction rewrites the human-visible log TEXT only.
 * It is NEVER allowed to influence pass/fail, score, or any verdict — callers
 * pass only the `.logs` string through here, never a decision field. And it
 * FAILS CLOSED: if anything throws while redacting, we return a safe placeholder
 * string, never the raw (possibly secret-bearing) logs.
 */

/** What every masked hit is replaced with. Contains no long alnum run and no
 * `=`/`:`, so a placeholder can never itself be re-matched by a later rule. */
export const REDACTION_PLACEHOLDER = "«redacted:secret»";

/** Returned when the redactor itself throws — we must not fall back to raw
 * logs, because the whole point was that those logs are untrusted. */
export const REDACTION_ERROR_PLACEHOLDER = "«logs unavailable: redaction error»";

interface Rule {
  readonly re: RegExp;
  /** Replacement — either a fixed string or a function that rebuilds the match
   * keeping the non-secret parts (e.g. the key name in `token=…`). */
  readonly replace: string | ((...args: string[]) => string);
}

/**
 * Ordered secret-shape rules. Order matters: block/structured matches run
 * before the broad generic high-entropy sweep so the specific rules win and the
 * generic rule only mops up what is left.
 */
const RULES: Rule[] = [
  // 1. PEM private-key blocks (RSA/EC/OPENSSH/PKCS8/…). Whole block, non-greedy.
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: REDACTION_PLACEHOLDER,
  },
  // 2. Authorization header — mask the entire value to end of line (this also
  //    covers `Authorization: Bearer <token>`). Keep the header name visible.
  {
    re: /\bAuthorization\b(\s*[:=]\s*)[^\r\n]+/gi,
    replace: (_m: string, sep: string) => `Authorization${sep}${REDACTION_PLACEHOLDER}`,
  },
  // 3. Standalone `Bearer <token>` anywhere else.
  {
    re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replace: `Bearer ${REDACTION_PLACEHOLDER}`,
  },
  // 4. Named-secret assignments: password / passwd / secret / token / api_key /
  //    apikey, optionally prefixed by one identifier segment (access_token,
  //    aws.secret), followed by `=` or `:` then a quoted or bare value. The
  //    keyword must sit immediately before the separator, so `tokens=100` and
  //    `tokenizer=x` do NOT match (the keyword there is followed by more word
  //    chars, never the separator).
  {
    re: /\b(?:[A-Za-z0-9]+[._-])?(password|passwd|secret|token|api[_-]?key|apikey)(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s'";,]+)/gi,
    replace: (m: string, ...groups: string[]) => {
      // Rebuild `<prefix?><keyword><sep>` verbatim, mask only the value. The
      // captured groups are keyword, sep, value; the prefix (if any) sits
      // between the match start and the keyword, so recover it from the match.
      const keyword = groups[0] ?? "";
      const sep = groups[1] ?? "";
      const head = m.slice(0, m.indexOf(keyword) + keyword.length) + sep;
      return `${head}${REDACTION_PLACEHOLDER}`;
    },
  },
  // 5. AWS access key IDs — `AKIA`/`ASIA` + 16 uppercase alnum (20 total).
  {
    re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: REDACTION_PLACEHOLDER,
  },
  // 6. AWS-secret-key-shaped value: exactly 40 base64 chars sitting as an
  //    assignment value (preceded by `=`/`:`, optionally quoted). Targeted so a
  //    stray 40-char string in prose is left alone.
  {
    re: /([:=]\s*["']?)([A-Za-z0-9+/]{40}={0,2})(["']?(?=$|[\s,;]))/gm,
    replace: (_m: string, head: string, _val: string, tail: string) =>
      `${head}${REDACTION_PLACEHOLDER}${tail}`,
  },
  // 7. Generic high-entropy hex run (git SHAs, hex tokens), >= 32 chars. Not
  //    bounded by other hex/word chars so we mask the whole run.
  {
    re: /(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])/g,
    replace: REDACTION_PLACEHOLDER,
  },
  // 8. Generic long alnum token run (base64url / opaque tokens), >= 32 chars.
  //    Alnum-only on purpose: `/` and `+` are excluded so filesystem paths
  //    (segmented by `/`, and usually containing `_`/`.`) are not swept up —
  //    real base64 secrets with `+`/`/` are caught by the assignment rules.
  {
    re: /(?<![A-Za-z0-9+/=])[A-Za-z0-9]{32,}(?![A-Za-z0-9+/=])/g,
    replace: REDACTION_PLACEHOLDER,
  },
];

/**
 * Mask well-known secret shapes in an untrusted log string.
 *
 * @param raw the provider's captured stdout/stderr (may be undefined/null)
 * @returns `{ text, redacted }` — `text` is the safe-to-store log string;
 *          `redacted` is true iff at least one secret shape was masked. On a
 *          nullish input, returns `{ text: "", redacted: false }`. If redaction
 *          throws, FAILS CLOSED to the error placeholder (never the raw logs).
 */
export function redactExecutionLogs(raw: string | undefined | null): { text: string; redacted: boolean } {
  if (raw === undefined || raw === null) return { text: "", redacted: false };
  try {
    let text = String(raw);
    let redacted = false;
    for (const rule of RULES) {
      // Only flip `redacted` when a rule actually changes the text, so the flag
      // is truthful — a run of clean output reports `redacted: false`.
      const next = text.replace(rule.re, rule.replace as never);
      if (next !== text) redacted = true;
      text = next;
    }
    return { text, redacted };
  } catch {
    // FAIL CLOSED — the input is untrusted; a redactor bug must never leak it.
    return { text: REDACTION_ERROR_PLACEHOLDER, redacted: true };
  }
}
