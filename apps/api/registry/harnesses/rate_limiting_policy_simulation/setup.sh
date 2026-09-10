#!/usr/bin/env bash
# rate_limiting_policy_simulation -- build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category is pure Python stdlib logic -- solution_code's
# RateLimiter class is exec()'d directly and driven through a harness-
# controlled virtual timeline (plain numbers, never real time.sleep()/
# time.time()/datetime.now()) -- so nothing beyond python3 itself is
# required. No new E2B image dependency is introduced by this category.
set -euo pipefail

command -v python3 >/dev/null || { echo "rate_limiting_policy_simulation requires python3"; exit 1; }
python3 -c "import sys, os, json" || { echo "rate_limiting_policy_simulation requires the python3 stdlib sys/os/json modules"; exit 1; }
echo "rate_limiting_policy_simulation: dependencies satisfied"
