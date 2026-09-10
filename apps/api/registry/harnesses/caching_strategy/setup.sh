#!/usr/bin/env bash
# caching_strategy -- build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category is pure Python stdlib logic -- solution_code's
# Cache class is exec()'d directly and driven through a harness-controlled
# operation sequence (get/put/advance_time/check_store, plain numbers for
# any virtual time -- never real time.sleep()/time.time()/datetime.now())
# -- so nothing beyond python3 itself is required. No new E2B image
# dependency is introduced by this category.
set -euo pipefail

command -v python3 >/dev/null || { echo "caching_strategy requires python3"; exit 1; }
python3 -c "import sys, os, json" || { echo "caching_strategy requires the python3 stdlib sys/os/json modules"; exit 1; }
echo "caching_strategy: dependencies satisfied"
