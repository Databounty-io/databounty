// SPDX-License-Identifier: Apache-2.0
import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template.js";

/**
 * Build the PRODUCTION execution-sandbox image.
 *
 * WHY THIS EXISTS. On 2026-09-09 production and dev were both pointed at
 * `rezal50dxbt0wwjplr77` — the image published under the `databounty-verify-dev`
 * alias. Production was therefore executing contributor code in the DEV sandbox
 * image, which means a routine dev rebuild (adding a package, bumping a
 * toolchain) would have changed production's execution environment with no prod
 * deploy, no review, and nothing to roll back to.
 *
 * This publishes the SAME definition (`template.ts`) under its own alias so the
 * two environments can never drift into each other. Same bytes, separate
 * identity: promoting a change to prod becomes an explicit build + env switch
 * rather than a side effect of someone else's dev work.
 *
 * It publishes a NEW alias and never rebuilds `databounty-verify` (the
 * 2026-08-13 image) or `databounty-verify-dev` in place — nobody holds the
 * definition the old prod image was built from, so an in-place rebuild of it
 * would be irreversible. Switching `E2B_TEMPLATE` back is instant.
 *
 * Run:  E2B_API_KEY=... npx tsx sandbox/build.prod.ts
 * Then: set the printed template id as the `E2B_TEMPLATE` Environment Variable
 *       on databounty-infra-prod (production env) and redeploy. Re-probe the
 *       built image and refresh provider-runtimes.ts's manifest from that probe.
 */
async function main() {
  if (!process.env.E2B_API_KEY) {
    console.error("E2B_API_KEY is not set — refusing to build.");
    process.exit(1);
  }
  await Template.build(template, "databounty-verify-prod", {
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});