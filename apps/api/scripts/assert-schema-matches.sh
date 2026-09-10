#!/usr/bin/env bash
# Asserts the LIVE database schema matches prisma/schema.prisma, in both
# directions. Run immediately after `prisma migrate deploy`.
#
# Why: `prisma migrate status` only compares the _prisma_migrations ledger. On
# 2026-09-07 it reported "Database schema is up to date!" for staging while
# `bounties_title_trgm_idx` did not exist and three foreign keys had the wrong
# ON UPDATE action. A clean ledger is not evidence of a correct schema.
#
# Both directions matter:
#   forward  (db -> schema): the database is MISSING something the code expects.
#   reverse  (schema -> db): the database HAS something the datamodel does not
#                            declare -- which is exactly what `migrate dev`
#                            will silently auto-DROP next time. This is the
#                            check that would have caught the trgm index in
#                            July, months before anyone noticed.
#
# Connection: prisma.config.ts here reads DIRECT_URL when set and falls back to
# DATABASE_URL, so either is enough. Prefer DIRECT_URL against Supabase —
# DATABASE_URL is the transaction pooler (6543), which cannot hold the
# session-scoped advisory lock Prisma Migrate needs and HANGS rather than
# failing fast.
#
# Read-only: `migrate diff` only prints SQL, it never executes it.
set -uo pipefail

if [ -z "${DIRECT_URL:-}" ] && [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: set DIRECT_URL (preferred) or DATABASE_URL to the database to assert against." >&2
  exit 1
fi

# --exit-code: empty diff = 0, non-empty = 2, error = 1
run_diff() {
  npx prisma migrate diff "$@" --script --exit-code 2>&1
}

fail=0

echo "==> Asserting live schema matches schema.prisma (forward: db -> schema)"
forward="$(run_diff --from-config-datasource --to-schema prisma/schema.prisma)"
fcode=$?
if [ "$fcode" = "2" ]; then
  echo "MISMATCH: the database is missing changes the code expects:"
  printf '%s\n' "$forward" | sed 's/^/    /'
  fail=1
elif [ "$fcode" != "0" ]; then
  echo "ERROR: forward diff failed to run:"; printf '%s\n' "$forward" | sed 's/^/    /'; fail=1
else
  echo "    OK - nothing missing"
fi

echo "==> Asserting live schema matches schema.prisma (reverse: schema -> db)"
reverse="$(run_diff --from-schema prisma/schema.prisma --to-config-datasource)"
rcode=$?
if [ "$rcode" = "2" ]; then
  echo "MISMATCH: the database contains objects schema.prisma does not declare."
  echo "          The next 'prisma migrate dev' will auto-generate DROP statements"
  echo "          for these and delete them. Declare them in the datamodel."
  printf '%s\n' "$reverse" | sed 's/^/    /'
  fail=1
elif [ "$rcode" != "0" ]; then
  echo "ERROR: reverse diff failed to run:"; printf '%s\n' "$reverse" | sed 's/^/    /'; fail=1
else
  echo "    OK - nothing undeclared"
fi

if [ "$fail" != "0" ]; then
  echo
  echo "SCHEMA ASSERTION FAILED. The migration ledger may still read as clean --"
  echo "that is expected and is precisely why this check exists."
  exit 1
fi

echo "==> Schema assertion passed (both directions empty)"
