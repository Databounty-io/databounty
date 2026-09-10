// SPDX-License-Identifier: Apache-2.0

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const DEFAULT_POOL_MAX = 25;

function poolMax(): number {
  const raw = Number(process.env.DB_POOL_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_POOL_MAX;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

function statementTimeoutMs(): number {
  const raw = Number(process.env.DB_STATEMENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_STATEMENT_TIMEOUT_MS;
}

export function createPrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) {
    throw new Error("A PostgreSQL connection string is required to create PrismaClient");
  }
  const timeout = statementTimeoutMs();
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: poolMax(),
      ...(timeout > 0
        ? {
            statement_timeout: timeout,
            query_timeout: timeout,
            idle_in_transaction_session_timeout: timeout,
          }
        : {}),
    }),
  });
}

/** Single shared Prisma client for the community API. */
export const prisma = createPrismaClient();
