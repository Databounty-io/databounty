#!/usr/bin/env bash
# retry_backoff_resilience -- build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category is pure Python stdlib logic -- solution_code's
# retry_call function is exec()'d directly and driven with a harness-owned
# dependency()/sleep() pair of closures (plain in-process function calls,
# never real time.sleep()/time.time()/datetime.now(), never a real network
# call) -- so nothing beyond python3 itself is required. No new E2B image
# dependency is introduced by this category.
set -euo pipefail

command -v python3 >/dev/null || { echo "retry_backoff_resilience requires python3"; exit 1; }
python3 -c "import sys, os, json" || { echo "retry_backoff_resilience requires the python3 stdlib sys/os/json modules"; exit 1; }
echo "retry_backoff_resilience: dependencies satisfied"
