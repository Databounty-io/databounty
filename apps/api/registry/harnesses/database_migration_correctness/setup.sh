#!/usr/bin/env bash
# database_migration_correctness — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Nothing beyond python3 is required, identical to its sibling
# sql_query_correctness: the initial and post-migration databases are built
# and queried entirely through Python's stdlib `sqlite3` module (DB-API,
# executescript() for the multi-statement DDL/DML fields) -- there is no
# standalone SQL engine/server to install, and the standalone `sqlite3` CLI
# binary (also present in the verified image per sandbox/runtimes.json) is
# deliberately NOT used here.
set -euo pipefail

command -v python3 >/dev/null || { echo "database_migration_correctness requires python3"; exit 1; }
python3 -c "import sqlite3" || { echo "database_migration_correctness requires the python3 stdlib sqlite3 module"; exit 1; }
echo "database_migration_correctness: dependencies satisfied"
