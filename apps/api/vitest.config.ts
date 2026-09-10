// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

/**
 * Test runner config, added 2026-09-02.
 *
 * Why this file exists: almost every test in this app is a real integration
 * test — it boots the Fastify app and drives it over HTTP against a real
 * Postgres database (`databounty_community_parity_verify`). Several flows
 * legitimately take 4–6 seconds: the dispute-acceptance test signs in, mints a
 * pool, submits, accepts and then disputes; the alerts test exercises the
 * activation/resolution/re-activation contract end to end.
 *
 * Vitest's default `testTimeout` is 5000ms. That is a fine default for unit
 * tests and the wrong one for this suite: those tests passed when run alone
 * and failed in a full run, purely because a loaded machine pushed a 4.6s flow
 * past 5s. That produced a rotating cast of "failures" in files nobody had
 * touched, and the noise has already been mis-attributed to unrelated changes
 * more than once — which is worse than a slow suite, because it teaches people
 * to ignore red.
 *
 * 30s is chosen to be comfortably above the slowest observed flow (~6s) while
 * still failing fast on a genuine hang. If a test needs longer than this, that
 * is a signal about the test, not a reason to raise the number again.
 *
 * Note on parallelism: `package.json`'s `test` script pins
 * `--maxWorkers=1 --minWorkers=1` on purpose. These tests share one database,
 * so parallel files contaminate each other — one file's `drainJobs` eats
 * another's rows, and count-parity assertions see data a neighbouring file
 * created. Run the suite with `npm test`, not bare `vitest run`.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
