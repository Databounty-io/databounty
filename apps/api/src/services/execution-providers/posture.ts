// SPDX-License-Identifier: Apache-2.0

import { config } from "../../config.js";
import type { SandboxEgressCapability, SandboxIsolation, SandboxProvider } from "./types.js";

/**
 * The isolation posture the platform intends to enforce, derived from config
 * alone — the DEPLOYMENT's intent, and the ceiling on what any provider may be
 * asked for. Every provider still attests what it actually applied against the
 * posture it was given.
 *
 * Ported verbatim in behaviour from V1
 * (databounty-api/src/services/execution-providers/posture.ts). It lives in its
 * own module rather than inside any one provider so that adding or removing a
 * provider never creates a provider-to-provider import.
 */
export type RequestedPosture = { egress: SandboxIsolation["egress"]; allowlist: string[] };

export function requestedPosture(): RequestedPosture {
  const s = config.execution.sandbox;
  if (s.allowEgress) return { egress: "open", allowlist: [] };
  if (s.egressAllowlist.length) return { egress: "allowlist", allowlist: [...s.egressAllowlist] };
  return { egress: "blocked", allowlist: [] };
}

/**
 * The posture ONE provider is asked for: the deployment intent above, narrowed
 * to that provider's `egressCapability`. Only one narrowing exists, and it only
 * ever removes access:
 *
 *   allowlist  +  deny-only provider  ->  blocked
 *
 * `open` is deliberately NOT narrowed. Unrestricted egress is an explicit,
 * non-production opt-in that means "run this WITH the network"; silently
 * converting it to `blocked` would answer a question the operator did not ask.
 */
export function requestedPostureFor(provider: Pick<SandboxProvider, "egressCapability">): RequestedPosture {
  const intended = requestedPosture();
  if (intended.egress !== "allowlist") return intended;
  return egressCapabilityOf(provider) === "allowlist" ? intended : { egress: "blocked", allowlist: [] };
}

/** Absent = `"deny-only"`. See the contract note on
 * `SandboxProvider.egressCapability`: an unstated capability is never read as
 * "this box can open the network". */
export function egressCapabilityOf(provider: Pick<SandboxProvider, "egressCapability">): SandboxEgressCapability {
  return provider.egressCapability ?? "deny-only";
}

/**
 * The posture ONE provider is asked for on ONE run, narrowed a second time by
 * category-level policy (`allowNetwork`) on top of the provider-capability
 * narrowing above.
 *
 * This is deliberately a NARROWING ONLY: `allowNetwork` can never grant more
 * than the deployment's own posture already allows, it can only forbid egress
 * the deployment would otherwise have permitted. Community passes
 * `allowNetwork: false` for every run today (see registry-catalog.ts), so no
 * deployment config can be the sole reason a sandbox reaches the network.
 */
export function requestedPostureForCategory(
  provider: Pick<SandboxProvider, "egressCapability">,
  allowNetwork: boolean
): RequestedPosture {
  const narrowed = requestedPostureFor(provider);
  if (!allowNetwork) return { egress: "blocked", allowlist: [] };
  return narrowed;
}
