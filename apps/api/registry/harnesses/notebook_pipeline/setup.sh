#!/usr/bin/env bash
# notebook_pipeline — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission.
set -euo pipefail

command -v python3 >/dev/null || { echo "notebook_pipeline requires python3"; exit 1; }
python3 -c "import pandas" || { echo "notebook_pipeline requires pandas"; exit 1; }
# numpy/scikit-learn are schema-declared (schema.json's executionEnv) and
# genuinely used by several reference rows, but were never asserted at build
# time -- only checked (at request time, per-row) by harness.js now.
python3 -c "import numpy" || { echo "notebook_pipeline requires numpy"; exit 1; }
python3 -c "import sklearn" || { echo "notebook_pipeline requires scikit-learn"; exit 1; }
echo "notebook_pipeline: dependencies satisfied"
