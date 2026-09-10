// SPDX-License-Identifier: Apache-2.0

import type { DatasetType } from "@prisma/client";
import { config } from "../../config.js";
import { executionContractPassed } from "./contract.js";
import { redactExecutionLogs } from "./execution-log-safety.js";
import { resolveHarness } from "./harness.js";
import { categoryAllowsNetworkEgress } from "./registry-catalog.js";
import { sandboxProviderChain } from "./registry.js";
import { SandboxProviderError, type JsonRecord, type SandboxAttempt } from "./types.js";

export interface ExecutionOutcome {
  available: true;
  passed: boolean;
  score: number | null;
  detail: JsonRecord;
  /** True ONLY when a real isolated provider ran this and reported back a
   * posture we verified. Never defaulted, never hardcoded. */
  isolationVerified: boolean;
  provider: string;
  durationMs: number;
}

/** Every failure path is distinguishable and logged — never a bare silent
 * `catch { return null }`. `attempts` is stored on the ValidationResult row so a
 * human reviewer (or the next engineer debugging this) can see exactly why
 * execution didn't produce a verdict, instead of a generic "no runner"
 * message with zero diagnostic value. */
export interface ExecutionPending {
  available: false;
  reason:
    | "no_provider_configured"
    | "no_executable_harness"
    | "all_providers_failed"
    | "runtime_unavailable"
    | "execution_unverifiable";
  attempts: SandboxAttempt[];
}

function logExecutionFailure(context: string, detail: unknown): void {
  // Floor-level ops visibility; no request-scoped logger is reachable from this
  // background job path.
  console.error(`[execution] ${context}`, detail);
}

/** Normalize either branch into the shape the validation stage persists, plus a
 * human-readable reason on the pending branch — used by every call site so the
 * "why" (attempts, executionEnv) is never dropped or reworded ad hoc. */
export function executionToStageResult(
  execution: ExecutionOutcome | ExecutionPending,
  executionEnv: string
): { passed: boolean; score: number | null; detail: JsonRecord } {
  if (execution.available) {
    return { passed: execution.passed, score: execution.score, detail: execution.detail };
  }
  return {
    passed: false,
    score: null,
    detail: {
      status: execution.reason,
      executionEnv,
      attempts: execution.attempts,
      reason:
        execution.reason === "no_executable_harness"
          ? "This submission's fields don't match any known execution harness; a validator must verify it manually."
          : execution.reason === "runtime_unavailable"
            ? "The sandbox does not have a runtime for this submission's language; a validator must verify it manually."
            : execution.reason === "execution_unverifiable"
              ? "The fixed code could not be run to a verdict for an infrastructure reason (not a test failure); a validator must verify it manually."
              : execution.reason === "no_provider_configured"
                ? "No isolated execution sandbox is configured in this environment, so nothing was executed; a validator must verify it manually."
                : "No sandbox/runner attempt produced a usable result — see attempts for why.",
    },
  };
}

/** The two "the harness ran, but no verdict came out of it" outcomes. Both are
 * holds → human review; neither is ever a pass or a fail. */
type HoldReason = "runtime_unavailable" | "execution_unverifiable";

/**
 * Which hold an exhausted chain reports when providers disagree.
 *
 * `execution_unverifiable` wins. It is the strictly more specific finding: it
 * can only be produced by a sandbox that HAD the runtime and still could not
 * reach a verdict, so it names an infrastructure fault an operator can chase.
 * Both route identically (no verdict → human review, never a score), so this
 * choice only ever affects wording, never the outcome.
 */
function worseHold(current: HoldReason | null, next: HoldReason): HoldReason {
  if (current === "execution_unverifiable" || next === "execution_unverifiable") return "execution_unverifiable";
  return "runtime_unavailable";
}

/**
 * Run the execution stage for one submission, in an ISOLATED SANDBOX.
 *
 * There is no in-process branch anywhere in this function. If no provider is
 * configured, or every configured provider fails, it returns an
 * `ExecutionPending` — an explicit "no verdict" the caller records as evidence
 * and routes to human review. It never executes contributor code in this
 * process, and never fabricates a pass.
 */
export async function runExecution(args: {
  datasetType: DatasetType;
  payload: JsonRecord;
  requestId: string;
}): Promise<ExecutionOutcome | ExecutionPending> {
  const resolved = resolveHarness(args.payload, args.datasetType);
  if (!resolved) {
    return { available: false, reason: "no_executable_harness", attempts: [] };
  }
  const { harness, provenance } = resolved;

  // SECURITY-RELEVANT: decided once per category, not per provider, so every
  // provider attempt below for this row gets the same, correctly-scoped egress
  // decision. See categoryAllowsNetworkEgress's own doc comment for why this
  // can't just be the operator's global egress config.
  //
  // ALSO gated on `provenance.harnessSource === "registry"` (restored from V1
  // when the registry loader was ported): the three network-exception ids are
  // all built-in registry categories that `resolveHarness()` resolves BEFORE it
  // would ever reach a role-fallback harness for that same id, so in practice
  // this conjunct should never decide anything — but it means a NON-registry
  // harness can never inherit network access purely by reusing one of those
  // three dataset-type ids, whatever the resolution order later becomes. While
  // `categoryAllowsNetworkEgress` was a hardcoded `false` stub this conjunct was
  // moot and had been dropped; with the real per-category declarations back in
  // force, dropping it would have been a genuine weakening.
  const allowNetwork = provenance.harnessSource === "registry" && categoryAllowsNetworkEgress(args.datasetType.id);

  const providers = await sandboxProviderChain();
  const attempts: SandboxAttempt[] = [];
  /** The strongest "the run happened but produced no verdict" outcome seen so
   * far, carried across providers so an exhausted chain reports it. */
  let holdReason: HoldReason | null = null;

  for (const provider of providers) {
    if (!provider.isConfigured()) {
      attempts.push({ provider: provider.name, ok: false, error: "not configured" });
      continue;
    }
    // Timed from BEFORE dispatch and read on every exit path below (pass,
    // non-verdict, throw) so a slow/hanging provider is measurable even when it
    // never produced a verdict.
    const runStart = Date.now();
    const took = () => Date.now() - runStart;
    try {
      const raw = await provider.runScript(harness.script, config.execution.timeoutMs, allowNetwork);
      const durationMs = took();
      const parsed = harness.parse(raw.stdout);
      if (!parsed) {
        attempts.push({
          provider: provider.name,
          ok: false,
          retryable: false,
          error: "harness produced unparseable output",
          durationMs,
        });
        logExecutionFailure("harness output unparseable", {
          provider: provider.name,
          requestId: args.requestId,
          stderr: raw.stderr.slice(0, 2000),
        });
        continue;
      }
      // The HARNESS threw, or returned no boolean verdict. Flagged separately
      // from a failing submission precisely so our bug is never recorded as the
      // contributor's. Treated as a non-verdict — try the next provider, then
      // route to human review — never as a failure of the submission.
      if ((parsed.detail as { harnessFault?: unknown } | undefined)?.harnessFault === true) {
        attempts.push({
          provider: provider.name,
          ok: false,
          retryable: false,
          error: `harness fault (not a submission failure): ${redactExecutionLogs(parsed.logs).text.slice(0, 200)}`,
          durationMs,
        });
        logExecutionFailure("harness fault — routing to human review, not failing the submission", {
          provider: provider.name,
          requestId: args.requestId,
          datasetTypeId: args.datasetType.id,
          ...provenance,
        });
        continue;
      }
      // The harness ran but THIS sandbox lacks the target runtime — not a
      // failure of the submission, and not a statement about the NEXT provider.
      // Record the attempt, remember the hold, and keep going.
      if (parsed.runtimeUnavailable) {
        attempts.push({
          provider: provider.name,
          ok: false,
          retryable: false,
          error: `runtime unavailable in sandbox: ${redactExecutionLogs(parsed.logs).text.slice(0, 120)}`,
          durationMs,
        });
        holdReason = worseHold(holdReason, "runtime_unavailable");
        logExecutionFailure("runtime unavailable on this provider — trying the next one", {
          provider: provider.name,
          requestId: args.requestId,
          datasetTypeId: args.datasetType.id,
        });
        continue;
      }
      // The FIXED variant failed to load/compile for an infrastructure reason
      // (missing module, syntax error the runtime couldn't start on, OOM,
      // timeout) rather than failing its tests. Scoring that as a failed
      // submission would burn a contributor's revision on our problem, so it is
      // a non-verdict → human review, distinct from a genuine test failure.
      if ((parsed.detail as { fixedRunUnverifiable?: unknown } | undefined)?.fixedRunUnverifiable === true) {
        attempts.push({
          provider: provider.name,
          ok: false,
          retryable: false,
          error: "fixed variant could not be executed to a verdict (infrastructure fault, not a test failure)",
          durationMs,
        });
        holdReason = worseHold(holdReason, "execution_unverifiable");
        logExecutionFailure("fixed variant unverifiable on this provider — trying the next one", {
          provider: provider.name,
          requestId: args.requestId,
          datasetTypeId: args.datasetType.id,
        });
        continue;
      }
      const contractPassed = executionContractPassed({
        runnerPassed: parsed.passed,
        brokenCodeFailedTests: parsed.brokenCodeFailedTests,
        fields: Array.isArray(args.datasetType.fields)
          ? (args.datasetType.fields as Array<{ key?: string }>)
          : [],
      });
      if (contractPassed === null) {
        attempts.push({
          provider: provider.name,
          ok: false,
          retryable: false,
          error: "harness omitted the required broken-code assertion",
          durationMs,
        });
        continue;
      }
      return {
        available: true,
        passed: contractPassed,
        score: parsed.score ?? (contractPassed ? 1 : 0),
        // TRUE only because a real provider ran this AND reported back an
        // isolation posture we verified against what we asked for. Anything
        // else — including a provider that ran but could not prove its posture
        // — records false, and the UI must present it as unverified.
        isolationVerified: raw.isolation?.verified === true,
        provider: provider.name,
        durationMs,
        detail: {
          // HARNESS-SUPPLIED DETAIL GOES FIRST, deliberately. Spread last, a
          // harness (or a payload it echoes) could overwrite `isolation`,
          // `provider`, `harnessSource` or `status` in the row that IS the
          // platform's audit record. Trusted keys must win over anything the
          // executed code had a hand in producing.
          ...parsed.detail,
          status: "runner_completed",
          provider: provider.name,
          // Verdict provenance: which resolution branch produced this result.
          ...provenance,
          // The isolation the provider actually applied. Recorded verbatim:
          // without it a row cannot honestly support an execution-verified trust
          // claim. `null` for a provider that reports none — never a silent
          // omission that reads as "fine".
          isolation: (raw.isolation ?? null) as JsonRecord[string],
          durationMs,
          // Keep the failed attempts on the success path too, and name the
          // fallback explicitly, so a provider's failures are not erased just
          // because a later provider succeeded.
          ...(attempts.length ? { attempts, fallbackFrom: attempts.map((a) => a.provider) } : {}),
          testsRun: parsed.testsRun ?? 0,
          brokenCodeFailedTests: parsed.brokenCodeFailedTests ?? null,
          fixedCodePassedTests: parsed.passed,
          ...(parsed.unverifiable && parsed.unverifiable.length ? { unverifiable: parsed.unverifiable } : {}),
          // Untrusted contributor-code output — scrub obvious secrets before it
          // is stored as evidence and shown to validators. Text-only rewrite; it
          // cannot touch the pass/fail/score computed above.
          logs: redactExecutionLogs(parsed.logs).text,
        },
      };
    } catch (e) {
      const err =
        e instanceof SandboxProviderError ? e : new SandboxProviderError((e as Error).message, provider.name, true);
      attempts.push({
        provider: provider.name,
        ok: false,
        retryable: err.retryable,
        error: err.message,
        durationMs: took(),
      });
      logExecutionFailure("sandbox provider failed", {
        provider: provider.name,
        requestId: args.requestId,
        retryable: err.retryable,
        error: err.message,
      });
    }
  }

  // `providers.length` counts REGISTERED providers, not usable ones. With the
  // default order that is 1 even when E2B has no API key, so an unconfigured
  // deployment would report "all providers failed" — which reads as "we tried
  // and they broke" — and make the honest `no_provider_configured` reason
  // unreachable. Count what could actually have run.
  const attempted = providers.filter((p) => p.isConfigured()).length;
  // A hold seen anywhere in the chain outranks the generic chain-failure
  // reasons: it is the one outcome that says something specific about WHY no
  // verdict exists. Never collapsed into a generic reason, and never — on any
  // branch here — turned into a pass or a fail.
  if (holdReason) return { available: false, reason: holdReason, attempts };
  return { available: false, reason: attempted ? "all_providers_failed" : "no_provider_configured", attempts };
}
