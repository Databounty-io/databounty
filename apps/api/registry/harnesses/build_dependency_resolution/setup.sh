#!/usr/bin/env bash
# build_dependency_resolution — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category's OWN verification also needs network access at
# RUN time (real pip/npm/cargo installs against the live registry) — a
# sandboxed environment with no outbound network would need every row here
# to fall back to runtime_unavailable.
set -euo pipefail

command -v pip3 >/dev/null || { echo "build_dependency_resolution requires pip3"; exit 1; }
command -v npm >/dev/null || { echo "build_dependency_resolution requires npm"; exit 1; }
command -v cargo >/dev/null || { echo "build_dependency_resolution requires cargo"; exit 1; }
echo "build_dependency_resolution: dependencies satisfied"
