#!/usr/bin/env bash
# package_publishing — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission.
set -euo pipefail

command -v pip3 >/dev/null || { echo "package_publishing requires pip3"; exit 1; }
command -v npm >/dev/null || { echo "package_publishing requires npm"; exit 1; }
command -v cargo >/dev/null || { echo "package_publishing requires cargo"; exit 1; }
python3 -c "import setuptools" || { echo "package_publishing requires setuptools"; exit 1; }
echo "package_publishing: dependencies satisfied"
