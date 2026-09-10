#!/usr/bin/env bash
# static_compilation — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Dispatched by `language` — a missing toolchain for one language
# degrades that row to runtime_unavailable (human audit), not a routing error.
set -euo pipefail

command -v tsc >/dev/null || { echo "static_compilation requires tsc (npm install -g typescript)"; exit 1; }
command -v rustc >/dev/null || { echo "static_compilation requires rustc"; exit 1; }
command -v javac >/dev/null || { echo "static_compilation requires javac"; exit 1; }
command -v go >/dev/null || { echo "static_compilation requires go"; exit 1; }
echo "static_compilation: dependencies satisfied"
