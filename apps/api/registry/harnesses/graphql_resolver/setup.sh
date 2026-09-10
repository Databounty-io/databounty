#!/usr/bin/env bash
# graphql_resolver — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. graphql@16 must be resolvable globally — baked into the image,
# never installed at runtime (sandbox execution is no-network by design).
set -euo pipefail

command -v node >/dev/null || { echo "graphql_resolver requires node"; exit 1; }
node -e "require('graphql')" || { echo "graphql_resolver requires the graphql package"; exit 1; }
echo "graphql_resolver: dependencies satisfied"
