// SPDX-License-Identifier: Apache-2.0

import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startBackgroundWorkers } from "./worker.js";
import { assertConfiguredProvidersBootable } from "./services/execution.js";

async function main() {
  // Every execution-sandbox provider this deploy configured must be safe to
  // start. Asserted here (the single process entrypoint) rather than in
  // config.ts, which is
  // the foundational module every other module imports — reaching the provider
  // registry from its load-time guards would create a circular import. A
  // misconfigured provider fails at startup instead of at the first submission.
  assertConfiguredProvidersBootable();

  const app = await buildApp();

  // Background work runs IN THIS PROCESS (owner decision, 2026-09-02). There is
  // no separate worker process any more — see the comment on
  // startBackgroundWorkers for why, and for the one rule that comes with it:
  // this is safe while a single instance runs, and must be split back out
  // before running more than one.
  //
  // Started after buildApp() so routes and plugins are wired first, but before
  // listen() so the queue is already draining by the time the first request
  // arrives.
  startBackgroundWorkers();

  const shutdown = async () => {
    app.log.info("shutting down server...");
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Server listening on ${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
