#!/usr/bin/env bash
# algorithmic_complexity_verification — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Nothing beyond python3 itself is required: correctness checking
# and growth-curve timing are both done entirely through Python's stdlib --
# `time.perf_counter()` (wall-clock) and `time.process_time()` (CPU time,
# the anti-`time.sleep()`-gaming signal -- see harness.js's own module doc
# comment) -- no third-party package, no separate runtime, nothing this
# script needs to install.
set -euo pipefail

command -v python3 >/dev/null || { echo "algorithmic_complexity_verification requires python3"; exit 1; }
python3 -c "import time, json" || { echo "algorithmic_complexity_verification requires the python3 stdlib time and json modules"; exit 1; }
echo "algorithmic_complexity_verification: dependencies satisfied"
