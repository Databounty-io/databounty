// SPDX-License-Identifier: Apache-2.0

import type { RuntimeCapability } from "./provider-runtimes.js";

/**
 * Sandbox provider abstraction, ported from V1
 * (databounty-api/src/services/execution-providers/types.ts).
 *
 * A SandboxProvider only knows how to run an arbitrary script somewhere
 * isolated and hand back raw output — it has no idea what language the
 * submission is in or what a "debugging contract" is. That lets the vendor be
 * swapped underneath (E2B today) without touching harness-building or pipeline
 * logic, and vice versa: add a new language harness without touching any
 * provider.
 */

/** Loose JSON object shape used for evidence payloads. */
export type JsonRecord = Record<string, unknown>;

/**
 * What egress postures a provider is ABLE to apply. Deliberately not the same
 * union as `SandboxIsolation["egress"]`: that one records what a single run
 * got, this one declares what the box can ever do. `"open"` is not a capability
 * anyone declares — unrestricted egress is a deployment-level opt-in
 * (`EXECUTION_SANDBOX_ALLOW_EGRESS`), never a provider feature.
 */
export type SandboxEgressCapability = "allowlist" | "deny-only";

/**
 * What isolation was ACTUALLY applied to the run, read back from the provider —
 * not what we asked for. Attached to every SandboxRunResult so the evidence row
 * can state the posture honestly instead of implying a hardened run.
 */
export interface SandboxIsolation {
  egress: "blocked" | "allowlist" | "open";
  /** Hosts/CIDRs permitted out, when egress === "allowlist". */
  egressAllowlist?: string[];
  /** True when the posture above was confirmed by reading provider state back,
   * false when it is only what we requested. */
  verified: boolean;
  cpuCount?: number;
  memoryMB?: number;
  /** Effective rlimits reported by the sandbox shell before exec'ing the
   * runner (nproc / fsize-blocks / nofile). */
  rlimits?: { nproc?: string; fsize?: string; nofile?: string };
  /** What ran the code, for providers that can name it. Optional because E2B
   * cannot report an image digest — it is a property of a template we do not
   * build — so requiring it would make the honest provider invalid. */
  image?: string;
  imageDigest?: string;
  runtimes?: Record<string, string>;
  /** The provider's own id for this run, when it has one. */
  runId?: string;
}

export interface SandboxRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Present for providers that enforce isolation (E2B). Callers that persist
   * execution evidence SHOULD record this verbatim. */
  isolation?: SandboxIsolation;
}

/** Thrown by a provider on failure. `retryable` distinguishes a transient infra
 * blip (network/timeout/5xx — worth trying the next provider) from a hard
 * failure (bad config/auth/quota). Never silently swallowed by callers. */
export class SandboxProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean = true
  ) {
    super(message);
    this.name = "SandboxProviderError";
  }
}

export interface SandboxProvider {
  readonly name: string;
  /** Cheap, synchronous-ish check (env/key presence) — no network call. */
  isConfigured(): boolean;

  /**
   * Run `script` (a self-contained node script) in isolation with a timeout.
   * MUST throw SandboxProviderError on failure — never return a fabricated
   * result.
   *
   * `allowNetwork` is SECURITY-RELEVANT. A provider MUST NOT grant egress when
   * this is false, regardless of any global operator configuration — the caller
   * has already decided this specific run has no legitimate reason to reach the
   * network. See `requestedPostureForCategory` in posture.ts for how this
   * composes with the provider-capability narrowing below.
   */
  runScript(script: string, timeoutMs: number, allowNetwork: boolean): Promise<SandboxRunResult>;

  /**
   * OPTIONAL per-provider runtime inventory — "which binaries can THIS sandbox
   * run". Capability is a property of the box, not of the platform. A provider
   * that can answer implements this; one that cannot omits it and is treated as
   * "unknown" (→ cannot claim), never as "runs everything".
   */
  runtimeCapability?(): RuntimeCapability;

  /**
   * OPTIONAL per-provider EGRESS capability — "can THIS sandbox open a *subset*
   * of the network, or only nothing at all".
   *
   *  · `"allowlist"` — the provider can apply a requested allowlist and report
   *    back what it applied. It receives the deployment's allowlist verbatim.
   *  · `"deny-only"` — the provider can apply default-deny egress and nothing
   *    else. `requestedPostureFor()` narrows an allowlist to `blocked` for it.
   *
   * A provider that omits this is treated as `"deny-only"`, the conservative
   * direction: it is asked for LESS network than the deployment permits, never
   * more. Never inferred as "allowlist".
   */
  readonly egressCapability?: SandboxEgressCapability;

  /**
   * OPTIONAL boot validation. Returns an error string (→ refuse to boot) or
   * null; may console.warn for non-fatal misconfiguration. Called by
   * `assertConfiguredProvidersBootable()` at startup (server.ts / worker.ts)
   * ONLY when this provider is in EXECUTION_SANDBOX_ORDER, so a provider
   * carries its own start-up requirements instead of the boot file hardcoding a
   * per-provider block. (Asserted at the entrypoints rather than in config.ts to
   * avoid a circular import on the foundational config module.)
   */
  validateBootConfig?(): string | null;
}

/** One provider attempt, kept for evidence — surfaced on the ValidationResult
 * row so a human reviewer sees exactly why execution didn't produce a verdict,
 * instead of a generic "no runner" message. */
export interface SandboxAttempt {
  provider: string;
  ok: boolean;
  retryable?: boolean;
  error?: string;
  /** Wall-clock for THIS attempt, when the provider was actually dispatched to.
   * Absent (not zero) when nothing ran — an unconfigured provider is skipped,
   * never "instant". */
  durationMs?: number;
}
