// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { SandboxProviderError } from "./types.js";

/**
 * Guarded loader + local typings for the `e2b` SDK.
 *
 * WHY THIS FILE EXISTS. V1 does `import { ALL_TRAFFIC, Sandbox } from "e2b"` and
 * lists `e2b` in its package.json; this rebuild's `apps/api/package.json` now
 * declares the same dependency (`"e2b": "^2.32.0"`). The provider still loads the
 * SDK lazily rather than statically importing it, and still FAILS CLOSED if
 * loading it ever fails for any reason (a broken install, a version resolving to
 * an incompatible export shape, etc.): the run is abandoned with a non-retryable
 * SandboxProviderError, which `service.ts` records as an attempt that produced no
 * verdict → the item routes to human review. Nothing degrades to an in-process
 * run on this path.
 *
 * The interfaces below mirror only the members the provider actually uses, from
 * `e2b@2.35.x`. They are a compile-time contract, not a reimplementation: the
 * object at runtime is always the genuine SDK or nothing at all.
 */

/** `e2b`'s own constant for "every destination". Mirrored, not re-derived —
 * `declare const ALL_TRAFFIC = "0.0.0.0/0"` in e2b@2.35.3's index.d.ts. */
export const ALL_TRAFFIC = "0.0.0.0/0";

export interface E2BSandboxNetworkInfo {
  denyOut?: string[];
  allowOut?: string[];
}

export interface E2BSandboxInfo {
  cpuCount?: number;
  memoryMB?: number;
  allowInternetAccess?: boolean;
  network?: E2BSandboxNetworkInfo;
}

export interface E2BCommandResult {
  exitCode?: number | null;
  stdout: string;
  stderr: string;
}

export interface E2BSandboxInstance {
  getInfo(): Promise<E2BSandboxInfo>;
  files: { write(entries: Array<{ path: string; data: string }>): Promise<unknown> };
  commands: {
    run(
      cmd: string,
      opts: { timeoutMs?: number; requestTimeoutMs?: number; envs?: Record<string, string> }
    ): Promise<E2BCommandResult>;
  };
  fork(opts: { count: number; timeoutMs?: number }): Promise<Array<E2BSandboxInstance | Error>>;
  kill(): Promise<unknown>;
}

export interface E2BSandboxOpts {
  timeoutMs?: number;
  secure?: boolean;
  allowInternetAccess?: boolean;
  network?: { denyOut?: string[]; allowOut?: string[] };
}

export interface E2BSdk {
  Sandbox: {
    create(opts?: E2BSandboxOpts): Promise<E2BSandboxInstance>;
    create(template: string, opts?: E2BSandboxOpts): Promise<E2BSandboxInstance>;
  };
}

/** Not a literal, so TypeScript does not try to resolve the module at compile
 * time. The resolution that matters happens at runtime, below. */
const E2B_MODULE_ID: string = "e2b";

let sdk: E2BSdk | null = null;

/**
 * Resolve the SDK, or throw a NON-RETRYABLE provider error. Non-retryable
 * because retrying cannot install a missing package, and a run that cannot
 * reach an isolated sandbox must never quietly become an unisolated one.
 */
export async function loadE2bSdk(): Promise<E2BSdk> {
  if (sdk) return sdk;
  try {
    sdk = (await import(E2B_MODULE_ID)) as E2BSdk;
  } catch (e) {
    throw new SandboxProviderError(
      `the "e2b" SDK is not installed in this deployment, so no isolated sandbox is reachable — ` +
        `add "e2b" to apps/api dependencies (${e instanceof Error ? e.message : String(e)})`,
      "e2b",
      false
    );
  }
  return sdk;
}

/**
 * Synchronous load check for the boot guard. `SandboxProvider.validateBootConfig`
 * is sync by contract (it runs inside `assertConfiguredProvidersBootable()`), so
 * use Node's CommonJS loader to prove that E2B and its transitive dependencies
 * can actually initialise. `require.resolve()` is deliberately insufficient:
 * it succeeds when the top-level package exists even if a dependency it imports
 * is absent, which used to let the API boot only for every execution job to fail
 * later. Catching that failure at boot is the whole point.
 */
export function e2bSdkResolvable(load: (moduleId: string) => unknown = createRequire(import.meta.url)): boolean {
  try {
    load(E2B_MODULE_ID);
    return true;
  } catch {
    return false;
  }
}
