// SPDX-License-Identifier: Apache-2.0

/**
 * Concurrent callers for one key share a single in-flight load instead of
 * stampeding the loader. A failed load rejects every waiter and clears the
 * slot, so the next call retries fresh — errors are never cached.
 *
 * Ported from v1 `src/lib/cache/single-flight.ts`.
 */
export class SingleFlight {
  private inflight = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }
}
