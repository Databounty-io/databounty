// SPDX-License-Identifier: Apache-2.0

import type { CacheProvider } from "./types.js";

/**
 * The default driver when `CACHE_DRIVER` is unset: every read misses, every
 * write is a no-op, `getOrLoad` just runs the loader. The application behaves
 * exactly as it did before this layer existed, which is what makes adopting
 * it safe — correct with the switch off, faster with it on.
 *
 * Ported from v1 `src/lib/cache/noop.ts`.
 */
export class NoopCache implements CacheProvider {
  async get<T>(_key: string): Promise<T | null> {
    return null;
  }
  async set<T>(_key: string, _val: T, _ttlSec: number): Promise<void> {}
  async del(_key: string | string[]): Promise<void> {}
  async getOrLoad<T>(_key: string, _ttlSec: number, load: () => Promise<T>): Promise<T> {
    return load();
  }
  async incr(_key: string, _ttlSec: number): Promise<number | null> {
    return null;
  }
}
