#!/usr/bin/env bash
# terminal_cli — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission.
set -euo pipefail

command -v bash >/dev/null || { echo "terminal_cli requires bash"; exit 1; }
echo "terminal_cli: dependencies satisfied"
