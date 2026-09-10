// SPDX-License-Identifier: Apache-2.0

import { config } from "../../config.js";
import {
  ALL_TRAFFIC,
  loadE2bSdk,
  e2bSdkResolvable,
  type E2BSandboxInstance,
  type E2BSandboxOpts,
} from "./e2b-sdk.js";
import { requestedPostureForCategory, type RequestedPosture } from "./posture.js";
import { e2bRuntimeCapability } from "./provider-runtimes.js";
import {
  SandboxProviderError,
  type SandboxIsolation,
  type SandboxProvider,
  type SandboxRunResult,
} from "./types.js";

/**
 * ISOLATION CONTRACT (this file is the enforcement point).
 * Ported from V1 (databounty-api/src/services/execution-providers/e2b.ts).
 *
 * Untrusted contributor code runs in here. Three things must hold before a
 * single line of it executes, and all three FAIL CLOSED — if any cannot be
 * applied we abandon the run with a non-retryable SandboxProviderError, which
 * surfaces as an execution attempt with no verdict (→ human review). We never
 * silently degrade to an unisolated run, because the UI would then show
 * "execution passed" for a run that had no isolation at all.
 *
 *  1. Network egress. Default-deny via the E2B SDK's own options:
 *     `allowInternetAccess: false` (documented as equivalent to
 *     `denyOut: ['0.0.0.0/0']`), or, when an allowlist is configured,
 *     `network: { denyOut: [ALL_TRAFFIC], allowOut: [...] }` — allow entries
 *     take precedence over deny entries. The applied posture is then READ BACK
 *     with `sandbox.getInfo()` and compared against what we asked for; a
 *     mismatch (or a provider that won't report it) aborts the run.
 *
 *  2. VM size. `getInfo()` reports `cpuCount`/`memoryMB`; a template that hands
 *     untrusted code more than the configured ceiling is rejected. The SDK
 *     exposes no per-sandbox cpu/memory option — sizing is a property of the
 *     template, so this is a verification gate, not a setter.
 *
 *  3. In-VM resource caps. The runner is exec'd behind Bash rlimits set by a
 *     shell prologue: RLIMIT_NPROC (the fork-bomb cap), RLIMIT_FSIZE and
 *     RLIMIT_NOFILE. The prologue exits non-zero if a limit cannot be applied,
 *     and only ever lowers limits. RLIMIT_AS is deliberately NOT set: Go and the
 *     JVM reserve huge virtual address spaces, so capping it would turn valid
 *     submissions into false `tests_failed` verdicts. Memory is bounded by the
 *     VM's own RAM (#2).
 *
 * V1's optional fork-per-submission warm-base optimisation is NOT ported. It is
 * opt-in and off by default in V1 (`EXECUTION_SANDBOX_E2B_FORK=false`), so this
 * is V1's default path byte for byte: every run cold-creates its own sandbox,
 * and isolation is verified on it before any untrusted byte executes.
 */

/** Exit code the shell prologue uses when a required rlimit cannot be set. */
const RLIMIT_FAILED_EXIT = 97;
/** Marker line the prologue writes to stderr with the effective rlimits. */
const RLIMIT_MARKER = "__databounty_rlimits__";
/**
 * Must remain below /home/user so Node's normal ancestor lookup reaches the
 * template's baked /home/user/node_modules directory.
 */
export const sandboxNodeRunnerPath = "/home/user/databounty-runner.cjs";

/**
 * Turn a completed command into a run result, from either the success path or a
 * CommandExitError. Non-zero exit is normal here — the harness signals a failing
 * test that way — with ONE exception: the rlimit prologue's dedicated exit code
 * means the sandbox refused to apply the process/file/fd caps, which is an
 * isolation failure and must be non-retryable.
 */
function finishRun(
  result: { exitCode?: number | null; stdout: string; stderr: string },
  isolation: SandboxIsolation
): SandboxRunResult {
  if (result.exitCode === RLIMIT_FAILED_EXIT) {
    throw isolationFailure(
      `sandbox refused to apply process/file/fd limits (exit ${RLIMIT_FAILED_EXIT}): ${result.stderr.slice(0, 500)}`
    );
  }
  return {
    exitCode: result.exitCode ?? null,
    signal: null,
    stdout: result.stdout,
    stderr: result.stderr,
    isolation: { ...isolation, rlimits: parseRlimits(result.stderr) },
  };
}

/** Maps a thrown value to a classified SandboxProviderError. E2B/undici error
 * shapes vary (TLS cause chains, HTTP status on 4xx/5xx, AbortError on timeout)
 * so this is the one place that has to know about them. */
function classify(e: unknown, phase: "create" | "run" | "isolate"): SandboxProviderError {
  const err = e instanceof Error ? e : new Error(String(e));
  const name = err.name;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code === "SELF_SIGNED_CERT_IN_CHAIN" || cause?.code?.includes("CERT")) {
    return new SandboxProviderError(
      `e2b ${phase} failed: TLS certificate verification failed (corporate proxy/SSL inspection?) — ${err.message}`,
      "e2b",
      false
    );
  }
  if (name === "AbortError") return new SandboxProviderError(`e2b ${phase} timed out`, "e2b", true);
  const status = (err as { status?: number }).status;
  if (typeof status === "number") {
    // 404 (bad template), 401/403 (bad key) are config problems, not transient.
    const retryable = status === 429 || status >= 500;
    return new SandboxProviderError(`e2b ${phase} failed: ${status} ${err.message}`, "e2b", retryable);
  }
  return new SandboxProviderError(`e2b ${phase} failed: ${err.message}`, "e2b", true);
}

/** Non-retryable: retrying cannot make an unenforceable sandbox safe. */
function isolationFailure(message: string): SandboxProviderError {
  return new SandboxProviderError(`e2b isolation not enforced: ${message}`, "e2b", false);
}

/** Translate the requested posture into real, SDK-supported create options. */
function isolationOpts(posture: RequestedPosture): Pick<E2BSandboxOpts, "allowInternetAccess" | "network"> {
  if (posture.egress === "open") return {};
  if (posture.egress === "allowlist") {
    // Deny everything, then punch through only the allowlisted destinations.
    return { network: { denyOut: [ALL_TRAFFIC], allowOut: posture.allowlist } };
  }
  return { allowInternetAccess: false, network: { denyOut: [ALL_TRAFFIC] } };
}

/**
 * Shell prologue that lowers rlimits and then exec's the runner.
 *
 * Only ever LOWERS: if the hard limit is already at or below what we want, the
 * existing (stricter) limit stands. A genuine failure to apply exits
 * RLIMIT_FAILED_EXIT so the caller fails closed instead of running uncapped.
 *
 * Order matters and is not cosmetic. RLIMIT_NPROC is enforced per real UID
 * across the whole machine, so once it is lowered near the current process
 * count, ANY fork fails — including the `$(...)` command substitutions and
 * `echo` a naive prologue would use afterwards. So: read every hard limit first,
 * resolve the effective values, report them with the `printf` BUILTIN (no fork),
 * then apply, then `exec` (which replaces the shell rather than forking).
 */
export function buildRlimitScript(runnerPath: string): string {
  const s = config.execution.sandbox;
  // RLIMIT_FSIZE is expressed in 512-byte blocks by `ulimit -f`.
  const fsizeBlocks = Math.max(1, Math.floor((s.maxFileSizeMB * 1024 * 1024) / 512));
  const want: Array<[flag: string, want: number, name: string]> = [
    ["u", s.maxProcesses, "nproc"],
    ["f", fsizeBlocks, "fsize"],
    ["n", s.maxOpenFiles, "nofile"],
  ];
  return [
    // 1) Read hard limits (forks — must happen before anything is lowered).
    ...want.map(([flag]) => `h_${flag}=$(ulimit -H${flag} 2>/dev/null) || h_${flag}=unlimited`),
    // 2) Resolve the effective value: our ceiling, or the stricter hard limit.
    ...want.map(
      ([flag, value]) =>
        `e_${flag}=${value}; if [ "$h_${flag}" != "unlimited" ] && [ "$h_${flag}" -le ${value} ] 2>/dev/null; then e_${flag}=$h_${flag}; fi`
    ),
    // 3) Report (printf is a builtin — no fork).
    `printf '%s nproc=%s fsize=%s nofile=%s\\n' '${RLIMIT_MARKER}' "$e_u" "$e_f" "$e_n" 1>&2`,
    // 4) Apply. Failure here means we could not cap an untrusted process.
    ...want.map(([flag]) => `ulimit -S${flag} "$e_${flag}" || exit ${RLIMIT_FAILED_EXIT}`),
    // 5) exec replaces this shell — no fork required to start the runner.
    `exec node ${runnerPath}`,
  ].join("\n");
}

/**
 * Command that starts a staged rlimit script.
 *
 * Do not pass the multiline script with `bash -c`: E2B runs its command via
 * another shell, so nested JSON quoting can truncate the script and exit 2. The
 * caller writes it to this path first, leaving E2B one simple command. It must
 * use Bash rather than `/bin/sh`: E2B's stock `sh` is dash, whose `ulimit`
 * builtin does not implement `-u` (RLIMIT_NPROC).
 */
export function buildRlimitCommand(scriptPath: string): string {
  return `/bin/bash ${scriptPath}`;
}

/** Pull the effective rlimits the prologue reported back out of stderr. */
function parseRlimits(stderr: string): SandboxIsolation["rlimits"] | undefined {
  const m = stderr.match(new RegExp(`${RLIMIT_MARKER} nproc=(\\S+) fsize=(\\S+) nofile=(\\S+)`));
  if (!m) return undefined;
  return { nproc: m[1], fsize: m[2], nofile: m[3] };
}

async function createSandbox(posture: RequestedPosture): Promise<E2BSandboxInstance> {
  const { Sandbox } = await loadE2bSdk();
  const opts: E2BSandboxOpts = {
    // The VM must outlive the command budget, or it gets reaped mid-run.
    timeoutMs: config.execution.sandboxLifetimeMs,
    secure: true,
    ...isolationOpts(posture),
  };
  const template = config.execution.e2bTemplate;
  if (!template) {
    try {
      return await Sandbox.create(opts);
    } catch (e) {
      throw classify(e, "create");
    }
  }
  try {
    return await Sandbox.create(template, opts);
  } catch (templateErr) {
    // An explicit template is part of the execution contract: it supplies the
    // baked dependencies and runtime inventory the harness was approved for.
    // Falling back to the account-default image on a typo/retirement would make
    // a different, unpinned execution environment look like the configured one.
    // Fail this provider instead; the item is then held for human review.
    throw classify(templateErr, "create");
  }
}

/**
 * Read the sandbox's real state back and prove it matches what we asked for.
 * Throws (non-retryable) when the posture is weaker than requested, when the VM
 * is bigger than the configured ceiling, or when the provider does not report
 * enough to decide — "can't prove it" is treated as "not isolated".
 */
export async function verifyIsolation(
  sandbox: E2BSandboxInstance,
  posture: RequestedPosture
): Promise<SandboxIsolation> {
  const s = config.execution.sandbox;
  const base: SandboxIsolation = {
    egress: posture.egress,
    ...(posture.egress === "allowlist" ? { egressAllowlist: posture.allowlist } : {}),
    verified: false,
  };
  if (!s.verifyIsolation) return base;

  let info: Awaited<ReturnType<E2BSandboxInstance["getInfo"]>>;
  try {
    info = await sandbox.getInfo();
  } catch (e) {
    throw isolationFailure(
      `could not read sandbox state back to confirm isolation — ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // VM size ceiling (the SDK offers no per-sandbox setter; this is the gate).
  // A missing field cannot establish a ceiling. Treat it exactly like any other
  // unverifiable posture: fail closed before untrusted code is written or run.
  if (typeof info.cpuCount !== "number") {
    throw isolationFailure("provider did not report sandbox vCPU count");
  }
  if (typeof info.memoryMB !== "number") {
    throw isolationFailure("provider did not report sandbox memory limit");
  }
  if (info.cpuCount > s.maxCpus) {
    throw isolationFailure(`sandbox has ${info.cpuCount} vCPU, ceiling is ${s.maxCpus} (fix the E2B template)`);
  }
  if (info.memoryMB > s.maxMemoryMB) {
    throw isolationFailure(`sandbox has ${info.memoryMB}MiB RAM, ceiling is ${s.maxMemoryMB} (fix the E2B template)`);
  }

  if (posture.egress === "open") {
    // Nothing to verify — the operator explicitly opted out of isolation.
    return { ...base, verified: true, cpuCount: info.cpuCount, memoryMB: info.memoryMB };
  }

  const denyOut = info.network?.denyOut ?? [];
  const allowOut = info.network?.allowOut ?? [];
  const blockedAll = info.allowInternetAccess === false || denyOut.includes(ALL_TRAFFIC);

  if (posture.egress === "blocked") {
    if (!blockedAll) {
      throw isolationFailure(
        `requested full egress block but provider reports allowInternetAccess=${String(info.allowInternetAccess)} denyOut=${JSON.stringify(denyOut)}`
      );
    }
  } else {
    // allowlist: everything must be denied by default, and the effective
    // allowOut must not be WIDER than what we asked for.
    if (!blockedAll) {
      throw isolationFailure(
        `requested default-deny egress with an allowlist but provider reports denyOut=${JSON.stringify(denyOut)}`
      );
    }
    const unexpected = allowOut.filter((entry) => entry === ALL_TRAFFIC || !posture.allowlist.includes(entry));
    if (unexpected.length) {
      throw isolationFailure(`provider allows egress destinations we did not request: ${JSON.stringify(unexpected)}`);
    }
  }

  return { ...base, verified: true, cpuCount: info.cpuCount, memoryMB: info.memoryMB };
}

export const e2bSandboxProvider: SandboxProvider = {
  name: "e2b",
  isConfigured: () => !!config.execution.e2bApiKey,
  /** The probed template manifest — see provider-runtimes.ts for why capability
   * is answered per provider rather than as one global platform fact. */
  runtimeCapability: () => e2bRuntimeCapability(),
  /**
   * E2B can apply a real egress ALLOWLIST: `network.allowOut` over a
   * `denyOut: 0.0.0.0/0` default, read back and compared in `verifyIsolation`.
   */
  egressCapability: "allowlist",
  /**
   * Boot requirement. A deployment that lists `e2b` in EXECUTION_SANDBOX_ORDER
   * and sets an API key, but has no `e2b` SDK installed, would otherwise look
   * healthy until the first submission — at which point every item is held.
   * Refuse to start instead, which is the whole point of the boot guard.
   */
  validateBootConfig(): string | null {
    if (!config.execution.e2bApiKey) {
      // Not an error: an unconfigured provider is a legitimate deployment state.
      // Execution then records `no_provider_configured` and routes items to
      // human review — honest, and never an in-process fallback.
      console.warn(
        "[execution] the e2b sandbox provider has no E2B_API_KEY — the execution stage will record " +
          "`no_provider_configured` and route every item to human review. No contributor code is executed."
      );
      return null;
    }
    if (!e2bSdkResolvable()) {
      return 'E2B_API_KEY is set but the "e2b" SDK is not installed — add "e2b" to apps/api dependencies';
    }
    return null;
  },
  /**
   * `allowNetwork` is SECURITY-RELEVANT (see types.ts's doc comment on
   * `SandboxProvider.runScript`): it is the caller's per-category decision (see
   * registry-catalog.ts's `categoryAllowsNetworkEgress`), layered on top of this
   * provider's own egress capability via `requestedPostureForCategory`. When
   * `allowNetwork` is false, egress is forced `blocked` unconditionally,
   * regardless of the operator's global EXECUTION_SANDBOX_ALLOW_EGRESS /
   * EGRESS_ALLOWLIST config.
   */
  async runScript(script, timeoutMs, allowNetwork): Promise<SandboxRunResult> {
    const posture = requestedPostureForCategory(this, allowNetwork);
    let sandbox: E2BSandboxInstance | null = null;
    // Hoisted so the catch below can still build an honest result from a
    // CommandExitError (non-zero exit is data, not a transport failure).
    let isolation: SandboxIsolation | null = null;
    try {
      sandbox = await createSandbox(posture);
      // Prove the isolation before any untrusted byte executes. This throws
      // (non-retryable) rather than degrading to an unisolated run.
      isolation = await verifyIsolation(sandbox, posture);

      // Write the orchestrator to a file and run it — robust for large scripts
      // and arbitrary content (a `node <<HEREDOC` pipe truncates/errors on some
      // payloads). Node resolves `require()` relative to the script being
      // executed, and the E2B template places baked dependencies under
      // /home/user/node_modules (E2B strips NODE_PATH), so the runner must stay
      // beneath /home/user; /tmp is fine for the non-Node shell helper.
      const runnerPath = sandboxNodeRunnerPath;
      const rlimitScriptPath = "/tmp/databounty-rlimits.sh";
      // ONE round trip for both files. They were never independent — the run
      // needs both or neither.
      await sandbox.files.write([
        { path: runnerPath, data: script },
        { path: rlimitScriptPath, data: buildRlimitScript(runnerPath) },
      ]);
      const result = await sandbox.commands.run(buildRlimitCommand(rlimitScriptPath), {
        // Outer backstop. Every in-sandbox timeout is derived to be strictly
        // smaller (config.execution.harness.*), so this really does bound the
        // run instead of being shadowed by a longer child timeout.
        timeoutMs,
        // The SDK has a SECOND, independent timeout on this same call:
        // `requestTimeoutMs` bounds the underlying HTTP/stream request used to
        // execute and stream the command's output, and defaults to 60000ms
        // regardless of what `timeoutMs` says — so a legitimately slow run was
        // killed with no verdict at all while `timeoutMs` still had room. Tying
        // it to `timeoutMs` (plus a buffer, so the intended outer backstop is
        // always what fires first) closes that gap.
        requestTimeoutMs: timeoutMs + 10_000,
        envs: { E2B_API_KEY: "" }, // never leak our own key into the untrusted sandbox process env
      });
      return finishRun(result, isolation);
    } catch (e) {
      if (e instanceof SandboxProviderError) throw e;
      // `commands.run` THROWS on any non-zero exit (CommandExitError), so
      // exit-code checks are unreachable from the success path: the rlimit
      // refusal — a sandbox that could not cap untrusted processes — would fall
      // through to the generic classifier and be recorded as a RETRYABLE network
      // blip. Recover the command result from the error and treat a non-zero
      // exit as data, not as a transport failure.
      const exit = e as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
      if (typeof exit?.exitCode === "number") {
        return finishRun(
          { exitCode: exit.exitCode, stdout: String(exit.stdout ?? ""), stderr: String(exit.stderr ?? "") },
          isolation ?? { egress: posture.egress, verified: false }
        );
      }
      throw classify(e, "run");
    } finally {
      if (sandbox) {
        await sandbox.kill().catch((err: unknown) => {
          // A leaked sandbox keeps billing until E2B's own timeout reaps it —
          // never fail the run over it, but always log it.
          console.warn(
            "[e2b] sandbox.kill failed (sandbox may linger until provider timeout):",
            err instanceof Error ? err.message : err
          );
        });
      }
    }
  },
};
