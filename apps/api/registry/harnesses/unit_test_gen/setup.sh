#!/usr/bin/env bash
# unit_test_gen — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Framework is declared explicitly per row (pytest/jest/mocha/
# vitest/go test/rustc --test) — a missing one degrades to
# runtime_unavailable (human audit), it does not misroute to another runner.
set -euo pipefail

command -v python3 >/dev/null || { echo "unit_test_gen requires python3"; exit 1; }
command -v pytest >/dev/null || { echo "unit_test_gen requires pytest"; exit 1; }
command -v node >/dev/null || { echo "unit_test_gen requires node"; exit 1; }
command -v jest >/dev/null || { echo "unit_test_gen requires jest (npm install -g jest)"; exit 1; }
command -v mocha >/dev/null || { echo "unit_test_gen requires mocha (npm install -g mocha)"; exit 1; }
command -v vitest >/dev/null || { echo "unit_test_gen requires vitest (npm install -g vitest)"; exit 1; }
command -v tsc >/dev/null || { echo "unit_test_gen requires tsc (to compile TypeScript rows before handing them to jest/mocha/vitest)"; exit 1; }
command -v go >/dev/null || { echo "unit_test_gen requires go"; exit 1; }
command -v rustc >/dev/null || { echo "unit_test_gen requires rustc"; exit 1; }
echo "unit_test_gen: dependencies satisfied"
