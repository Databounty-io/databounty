#!/usr/bin/env bash
# competitive_programming — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission: apt-get/pip on every validation would add tens of seconds per row.
set -euo pipefail

command -v python3 >/dev/null || { echo "competitive_programming requires python3"; exit 1; }
echo "competitive_programming: dependencies satisfied"
