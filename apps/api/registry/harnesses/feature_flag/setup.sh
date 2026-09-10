#!/usr/bin/env bash
# feature_flag — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission.
set -euo pipefail

command -v python3 >/dev/null || { echo "feature_flag requires python3"; exit 1; }
echo "feature_flag: dependencies satisfied"
