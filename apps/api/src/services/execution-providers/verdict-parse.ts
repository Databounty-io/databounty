// SPDX-License-Identifier: Apache-2.0

import type { HarnessResult } from "./harness.js";

/**
 * The stdout → verdict contract, shared by every harness builder.
 *
 * WHY THIS IS ITS OWN MODULE. Two builders (`harness.ts` for the language
 * harnesses, `registry-loader.ts` for registry/bound harnesses) each carried a
 * private copy of this parser. A security rule enforced in one copy and not the
 * other is not enforced at all, and the two had already drifted in comments.
 * It lives here rather than in `harness.ts` so `registry-loader.ts` can import
 * the VALUE without creating an import cycle (harness.ts already imports the
 * builders from registry-loader.ts).
 *
 * THE RULE. Every harness emits exactly ONE `passed`-bearing line on fd 1 —
 * verified across all builders: each `emit()` call site in `harness.ts` is
 * either the last statement of the orchestrator body or immediately followed by
 * `return`, and `registry-loader.ts` assembles a single trailing
 * `console.log(JSON.stringify(REPORT))`. Child-process output never reaches
 * fd 1 directly: `spawnSync` is always called with `encoding` so the child's
 * stdout is captured into a string and embedded (newline-escaped) inside the
 * one JSON line.
 *
 * So MORE THAN ONE such line is not a harness variation, it is evidence that
 * something appended to the stream — which is exactly the INTRA-run forge in
 * ADR-0001 (a contributor child reopening the orchestrator's
 * `/proc/<pid>/fd/1` and appending `{"passed":true,…}` after the genuine
 * verdict). The previous parser scanned upward and took the LAST match, so the
 * forged line won and a failing submission was accepted and paid.
 *
 * Reading the FIRST line instead would be the wrong fix: it would silently
 * score a run we know was tampered with. This fails closed instead — the
 * result is reported as a harness fault, which `service.ts` already treats as a
 * non-verdict: the attempt is recorded, the chain moves to the next provider,
 * and an exhausted chain routes the item to human audit. Never a pass, and
 * never a failure charged to the contributor.
 *
 * Legitimate multi-line output is untouched: log lines, non-JSON noise, and
 * other JSON objects that carry no top-level `passed` key are all ignored, as
 * before.
 */
export function parseVerdictLine(stdout: string): HarnessResult | null {
  const lines = stdout.trim().split("\n").filter(Boolean);
  const verdicts: HarnessResult[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // not JSON — a log line, progress output, anything.
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "passed" in parsed) {
      verdicts.push(parsed as HarnessResult);
    }
  }
  if (verdicts.length === 0) return null;
  if (verdicts.length > 1) return tamperedVerdict(verdicts.length);
  return verdicts[0]!;
}

/** Shaped as a harness fault on purpose — `service.ts` already routes that to
 * the next provider and then to human audit, so this reuses an existing,
 * tested fail-closed path rather than inventing a new outcome. */
function tamperedVerdict(count: number): HarnessResult {
  return {
    passed: false,
    score: null,
    logs: `sandbox stdout carried ${count} verdict lines; every harness emits exactly one, so the extra line(s) were appended after the run`,
    detail: {
      harnessFault: true,
      reason: "multiple_verdict_lines",
      verdictLineCount: count,
    },
  };
}
