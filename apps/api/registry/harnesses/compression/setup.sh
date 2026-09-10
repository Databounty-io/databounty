#!/usr/bin/env bash
# compression — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. zlib/gzip/bz2/lzma are all Python stdlib.
set -euo pipefail

command -v python3 >/dev/null || { echo "compression requires python3"; exit 1; }
echo "compression: dependencies satisfied"
