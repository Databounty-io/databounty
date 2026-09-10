// SPDX-License-Identifier: Apache-2.0

import { e2bSandboxProvider } from "./e2b.js";
import type { SandboxProvider } from "./types.js";

/**
 * The registered providers and the configured order — WITHOUT any database
 * dependency. This module deliberately does not import prisma: it answers the
 * capability question ("what could this deployment execute at all"), which must
 * stay free of a DB round-trip.
 *
 * V1 also registers an `ec2` self-hosted provider here. It is DELIBERATELY NOT
 * PORTED: V1 keeps it inert by default (it is absent from DEFAULT_ORDER and only
 * runs when an operator lists it), and it carries mTLS transport identity, pinned
 * attestation keys and signed-posture verification that this rebuild has no
 * deployment for yet. Adding it later needs no edit to this loop — a provider
 * carries its own boot requirements via `validateBootConfig()`.
 */
export const ALL_PROVIDERS: Record<string, SandboxProvider> = {
  e2b: e2bSandboxProvider,
};

/** E2B is the only default, exactly as in V1. */
const DEFAULT_ORDER = ["e2b"];

export function configuredProviderOrder(): string[] {
  const order = (process.env.EXECUTION_SANDBOX_ORDER ?? DEFAULT_ORDER.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = order.filter((key) => !(key in ALL_PROVIDERS));
  if (unknown.length) {
    throw new Error(
      `[execution] EXECUTION_SANDBOX_ORDER contains unknown provider(s): ${[...new Set(unknown)].join(", ")}`
    );
  }
  const duplicate = order.find((key, index) => order.indexOf(key) !== index);
  if (duplicate) {
    throw new Error(`[execution] EXECUTION_SANDBOX_ORDER lists provider "${duplicate}" more than once`);
  }
  return order;
}

/**
 * Providers the deploy has configured. Capability question only — "can this
 * platform execute at all". A per-run decision goes through
 * `sandboxProviderChain()` in registry.ts.
 */
export function configuredProviders(): SandboxProvider[] {
  return configuredProviderOrder().map((key) => ALL_PROVIDERS[key]!);
}

/**
 * Boot guard: every provider the deploy put in EXECUTION_SANDBOX_ORDER must be
 * safe to start. Each provider owns its own start-up requirements via
 * `validateBootConfig()` (a provider with no requirements omits it), so adding a
 * provider needs no edit here — this loop is generic. Called once from each
 * runtime entrypoint (server.ts, worker.ts) AFTER config has loaded, which is
 * why the check does not live in config.ts: doing it there would force config to
 * import this module (and the providers) at load, a circular edge on the
 * foundational config module. Throwing here refuses boot; the runtime
 * fail-closed path in service.ts is the backstop if an entrypoint ever skips
 * the call.
 */
export function assertConfiguredProvidersBootable(): void {
  const order = configuredProviders();
  for (const provider of order) {
    const error = provider.validateBootConfig?.();
    if (error) {
      throw new Error(`[execution] sandbox provider "${provider.name}" refused to boot: ${error}`);
    }
  }
}
