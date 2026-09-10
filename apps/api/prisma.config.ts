// SPDX-License-Identifier: Apache-2.0

import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma v7 CLI config. It points every CLI command (generate, migrate, db
// push, studio) at the right connection string; see the datasource note below
// for why migrate needs a different one from the app.
//
// Added 2026-08-29 to unblock spinning up an isolated `community_test`
// database for real browser/login verification, without touching the shared
// `.env` (which currently points at V1's live shared dev database — see
// project notes). At that time the schema was developed with `db push` and
// there was no migrations directory.
//
// That is no longer true, and the earlier "no migrations directory yet" note
// here was stale (corrected 2026-09-05): `prisma/migrations/` now holds a real
// migration history — 20260902170000_init,
// 20260903055305_add_dataset_type_sponsor_harness_note and
// 20260904100740_add_oauth_token_authorization_code_link, plus
// migration_lock.toml pinning provider = "postgresql". So `prisma migrate
// deploy` / `migrate status` are the supported path, CI runs
// `prisma migrate deploy` against a disposable database, and `db push` must
// NOT be used against any shared database — it would drift the schema away
// from the recorded history.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // DIRECT_URL first, DATABASE_URL as the fallback.
    //
    // This block is read ONLY by the Prisma CLI (migrate / introspect /
    // studio). The application runtime never sees it: `lib/prisma.ts` builds
    // its own connection through the `@prisma/adapter-pg` driver adapter from
    // `process.env.DATABASE_URL`. So the two connections are already
    // independent, and this is the correct place to send CLI traffic somewhere
    // different from app traffic.
    //
    // Why it matters in deployment: DATABASE_URL is Supabase's TRANSACTION
    // pooler (port 6543, `pgbouncer=true`), which cannot hold the
    // session-scoped advisory lock Prisma Migrate takes. Pointed there,
    // `prisma migrate status` does not fail fast — it HANGS (observed: no
    // output after 10 minutes, killed twice). A deploy would hang on the
    // migrate step with nothing useful in the logs. DIRECT_URL is the SESSION
    // pooler (5432), which supports advisory locks and prepared statements.
    //
    // TWO THINGS THAT DO NOT WORK HERE, both tried and measured:
    //
    //  1. `directUrl:` is NOT a valid key in this Prisma version — the config
    //     type is `{ url?, shadowDatabaseUrl? }`. It typechecks (excess
    //     properties survive through `env()`) and is then silently ignored, so
    //     migrate keeps using DATABASE_URL and the hang looks unexplained.
    //  2. `env("DIRECT_URL") ?? env("DATABASE_URL")` does NOT fall back.
    //     `env()` RESOLVES at config load and throws on a missing variable
    //     (`PrismaConfigEnvError: Cannot resolve environment variable:
    //     DIRECT_URL`), so `??` is never reached and the whole config fails to
    //     load for anyone who sets only DATABASE_URL — every local dev and
    //     every test run.
    //
    // Hence the plain `process.env` check: `env()` is only called for a
    // variable that actually exists.
    url: process.env.DIRECT_URL ? env("DIRECT_URL") : env("DATABASE_URL"),
    // Optional shadow database for `prisma migrate dev`, restored from v1
    // (`prisma.config.ts`), which this rebuild had dropped.
    //
    // Why it matters: `migrate dev` creates and drops a temporary shadow
    // database to detect drift. Against a managed Postgres whose CLI role
    // cannot CREATE DATABASE -- a pooled Supabase role, for instance -- that
    // step fails and there was no way to point it elsewhere. Deploys use
    // `migrate deploy`, which needs no shadow database, so this only affects
    // authoring a migration against such a database.
    //
    // Spread-when-present, like DIRECT_URL above and for the same reason:
    // `env()` throws at config load on a missing variable, so it must not be
    // called unless the variable exists.
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: env("SHADOW_DATABASE_URL") } : {}),
  },
});
