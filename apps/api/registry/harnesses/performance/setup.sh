#!/usr/bin/env bash
# performance — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission.
set -euo pipefail

command -v python3 >/dev/null || { echo "performance requires python3"; exit 1; }
echo "performance: dependencies satisfied"
