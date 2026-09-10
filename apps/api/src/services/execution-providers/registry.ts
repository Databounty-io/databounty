// SPDX-License-Identifier: Apache-2.0

import { ALL_PROVIDERS, configuredProviderOrder, configuredProviders } from "./provider-order.js";
import type { SandboxProvider } from "./types.js";

export { ALL_PROVIDERS, configuredProviderOrder, configuredProviders };

/**
 * The provider chain used for ONE execution.
 *
 * In V1 this layer also applies a live, DB-backed admission kill switch, read
 * per execution with no cache (a kill switch that takes a TTL to land is not a
 * kill switch). That switch exists only for capacity-limited SELF-HOSTED
 * providers, which declare `admissionSettingKey`. The only provider registered
 * here — `e2b` — declares none in V1 either, so the E2B-only chain incurs zero
 * DB reads there and does the same here. The function stays async, and stays the
 * single per-run entry point, so re-introducing an admission-gated provider is a
 * change in one place rather than at every call site.
 */
export async function sandboxProviderChain(): Promise<SandboxProvider[]> {
  const order = configuredProviderOrder();
  return order.map((key) => ALL_PROVIDERS[key]).filter((p): p is SandboxProvider => Boolean(p));
}
