// SPDX-License-Identifier: Apache-2.0
import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template.js";

/**
 * Build the DEV execution-sandbox image.
 *
 * Publishes to the `databounty-verify-dev` alias. It deliberately does NOT
 * build `databounty-verify`: that alias is the image V1's live deployments run
 * on, both trees currently point at it, and rebuilding it in place would put a
 * fresh image under a running paid product. Promoting to that alias is an owner
 * decision, not something a dev task does as a side effect.
 *
 * Ported from V1's `infra/e2b/databounty-verify/build.dev.ts`, whose dev alias
 * had never actually been built (only `databounty-verify` exists on the team).
 *
 * Run:  E2B_API_KEY=... npx tsx sandbox/build.dev.ts
 * Then: set the printed template id as E2B_TEMPLATE in apps/api/.env (dev only,
 *       per AGENTS.md §7 — local `.env` files stay on localhost), re-probe the
 *       built image, and update provider-runtimes.ts's manifest from the probe.
 */
async function main() {
  if (!process.env.E2B_API_KEY) {
    console.error("E2B_API_KEY is not set — refusing to build.");
    process.exit(1);
  }
  await Template.build(template, "databounty-verify-dev", {
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});