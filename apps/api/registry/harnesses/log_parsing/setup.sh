#!/usr/bin/env bash
# log_parsing — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Only python3 is required — the "SQL" rows use Python's stdlib
# sqlite3 module (DB-API), not a standalone SQL engine.
set -euo pipefail

command -v python3 >/dev/null || { echo "log_parsing requires python3"; exit 1; }
echo "log_parsing: dependencies satisfied"
