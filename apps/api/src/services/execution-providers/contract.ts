// SPDX-License-Identifier: Apache-2.0

/** Field keys, across every fail-then-pass-shaped category in registry/,
 * whose value is the "negative side" that must behave badly (a test that
 * must fail, an exploit that must succeed) before the "positive side"
 * passing means anything. Kept as a set rather than one literal name
 * ("broken_code") because each category names its own negative-side field
 * differently — debugging: broken_code, fail_to_pass: buggy_code,
 * vulnerability: vulnerable_code — and the safety net below only ever
 * applied to whichever one row's schema happened to use the first literal
 * name, leaving the others' `brokenCodeFailedTests` unchecked at this layer.
 *
 * Deliberately excluded:
 * - `source_code`: across the whole catalog it is only ever a translation /
 *   migration / compilation INPUT (role `input_code`), never a version
 *   supposed to fail. Its inclusion made `executionContractPassed` demand a
 *   broken-failure signal those types never emit → every one of their items
 *   forced to human audit — and made the harness try to run an input as a
 *   "broken variant". Both wrong.
 * - `starter_code`: the identical mistake as `source_code`, one field name
 *   over. Its own schema help text says it is "never executed or checked by
 *   verification" (role `input_code`, implementation category) — it is not a
 *   must-fail negative variant.
 * - `slow_code`: does not exist as a field key anywhere in the registry
 *   today. The one category shaped like "slow version" (`performance`) uses
 *   `original_code` as its key instead. Left out until/unless a category
 *   actually ships a `slow_code` field — don't guess a schema into
 *   existence.
 * - `target_code_or_spec`: same shape — an input to `test_generation`, which
 *   is not currently active; revisit if it is activated.
 */
export const BROKEN_VARIANT_KEYS = ["broken_code", "buggy_code", "vulnerable_code"];

/** Debugging-shaped contracts have two execution obligations: the broken/
 * negative version must fail (or otherwise misbehave), and the fixed/positive
 * version must pass. The runner's top-level `passed` covers the positive-side
 * result; this helper keeps the negative-side invariant explicit and
 * testable, independent of which provider produced the raw result. */
export function executionContractPassed(args: {
  runnerPassed: boolean;
  brokenCodeFailedTests?: boolean;
  fields: Array<{ key?: string }>;
}): boolean | null {
  const expectsBrokenFailure = args.fields.some((field) => !!field.key && BROKEN_VARIANT_KEYS.includes(field.key));
  if (expectsBrokenFailure && args.brokenCodeFailedTests === undefined) return null;
  return args.runnerPassed && (!expectsBrokenFailure || args.brokenCodeFailedTests === true);
}
