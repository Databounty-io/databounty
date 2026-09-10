#!/usr/bin/env bash
# execution_trace — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission.
set -euo pipefail

command -v python3 >/dev/null || { echo "execution_trace requires python3"; exit 1; }
command -v node >/dev/null || { echo "execution_trace requires node"; exit 1; }
# language enum also permits Java/Go/Rust/C++ (schema.json), dispatched
# through the shared h.runCode -- checked here too so a regression in any
# of them is caught at build time rather than silently degrading only
# those rows to runtime_unavailable.
command -v javac >/dev/null || { echo "execution_trace requires javac"; exit 1; }
command -v go >/dev/null || { echo "execution_trace requires go"; exit 1; }
command -v rustc >/dev/null || { echo "execution_trace requires rustc"; exit 1; }
command -v g++ >/dev/null || { echo "execution_trace requires g++"; exit 1; }
echo "execution_trace: dependencies satisfied"
