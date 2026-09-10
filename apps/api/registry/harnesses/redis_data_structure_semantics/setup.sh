#!/usr/bin/env bash
# redis_data_structure_semantics — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Both dependencies this category needs are ALREADY baked into
# the verified image by infra/e2b/databounty-verify/template.ts:
#   - `redis-server` (apt package `redis-server`, installed alongside the
#     rest of this registry's other language toolchains)
#   - the Python `redis` client (redis-py, installed via `pip3 install ...
#     redis ...`)
# so this script only VERIFIES that baseline rather than installing
# anything new — this category never installs a runtime at validation time
# (sandbox execution is no-network by design).
#
# IMPORTANT, verified empirically for this project (not assumed from the
# Dockerfile): `apt-get install redis-server` does NOT mean a server is
# already listening anywhere in the sandbox. E2B microVMs run no init/
# systemd services, so nothing auto-starts the packaged redis-server binary.
# harness.js starts its OWN redis-server child process, per scenario, from
# inside its own driver script, and tears it down again before verify()
# returns — this setup script's only job is confirming the BINARY and the
# Python client library are present and importable, never starting a
# long-lived server itself.
set -euo pipefail

command -v python3 >/dev/null || { echo "redis_data_structure_semantics requires python3"; exit 1; }
command -v redis-server >/dev/null || { echo "redis_data_structure_semantics requires the redis-server binary"; exit 1; }
python3 -c "import redis" || { echo "redis_data_structure_semantics requires the python3 redis-py package"; exit 1; }
echo "redis_data_structure_semantics: dependencies satisfied (redis-server binary + redis-py both present; no server left running)"
