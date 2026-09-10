#!/usr/bin/env bash
# refactoring — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Language is declared per row and dispatched through the shared
# polyglot runner (h.runWithTests) — a missing toolchain degrades to
# runtime_unavailable (human audit), it does not misroute to another runner.
set -euo pipefail

command -v python3 >/dev/null || { echo "refactoring requires python3"; exit 1; }
command -v node >/dev/null || { echo "refactoring requires node"; exit 1; }
# language enum also permits Java/Go/Rust/C++/Ruby/PHP (schema.json), all
# dispatched through the same shared h.runCode -- checked here too so a
# regression in any of them is caught at build time, not silently degraded
# to runtime_unavailable for those rows only.
command -v javac >/dev/null || { echo "refactoring requires javac"; exit 1; }
command -v go >/dev/null || { echo "refactoring requires go"; exit 1; }
command -v rustc >/dev/null || { echo "refactoring requires rustc"; exit 1; }
command -v g++ >/dev/null || { echo "refactoring requires g++"; exit 1; }
command -v ruby >/dev/null || { echo "refactoring requires ruby"; exit 1; }
command -v php >/dev/null || { echo "refactoring requires php"; exit 1; }
echo "refactoring: dependencies satisfied"
