#!/usr/bin/env bash
# data_transformation — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission: apt-get/pip on every validation would add tens of seconds per row.
set -euo pipefail

command -v python3 >/dev/null || { echo "data_transformation requires python3"; exit 1; }
echo "data_transformation: dependencies satisfied"
