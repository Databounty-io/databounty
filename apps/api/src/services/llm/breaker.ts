// SPDX-License-Identifier: Apache-2.0

import type { LlmProviderName } from "./types.js";

/**
 * Circuit breaker. Ported verbatim from v1's `services/llm/breaker.ts`.
 * Protects the calling instance from a brown-out provider so one bad upstream
 * can't stack full timeouts across every candidate on every request. After
 * `threshold` consecutive failures a provider is "open" for `cooldownMs`; the
 * first call after cooldown is a half-open probe.
 *
 * State is per-instance by design: a breaker guards *this* process's event
 * loop and latency budget, and each instance re-learns provider health in
 * seconds.
 */
interface BreakerState {
  failures: number;
  openUntil: number; // epoch ms; 0 = closed
}

const state = new Map<LlmProviderName, BreakerState>();

function get(provider: LlmProviderName): BreakerState {
  let s = state.get(provider);
  if (!s) {
    s = { failures: 0, openUntil: 0 };
    state.set(provider, s);
  }
  return s;
}

/** True when the provider should be skipped right now (open, cooldown active). */
export function isOpen(provider: LlmProviderName): boolean {
  const s = get(provider);
  if (s.openUntil === 0) return false;
  if (Date.now() >= s.openUntil) {
    s.openUntil = 0; // cooldown elapsed -> allow a single half-open probe
    return false;
  }
  return true;
}

export function recordSuccess(provider: LlmProviderName): void {
  const s = get(provider);
  s.failures = 0;
  s.openUntil = 0;
}

export function recordFailure(provider: LlmProviderName, threshold: number, cooldownMs: number): void {
  const s = get(provider);
  s.failures += 1;
  if (s.failures >= threshold) {
    s.openUntil = Date.now() + cooldownMs;
    s.failures = 0;
  }
}

/** Test/reset hook. */
export function resetBreakers(): void {
  state.clear();
}
