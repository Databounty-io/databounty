// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const handler = async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "databounty-community-api",
    };
  };

  app.get("/health", handler);
  app.get("/healthz", handler);
}
