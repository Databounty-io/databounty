#!/usr/bin/env bash
# implementation — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. `language` spans all 10 languages this dataset carries (Python,
# JavaScript, TypeScript, Java, Go, Rust, C++, C#, Ruby, PHP), so `requires`
# in categories.json is deliberately empty — the harness checks h.have() per
# row for whichever runtime that row's language actually needs (via
# h.runWithTests) and reports runtimeUnavailable rather than failing the
# submission when it is missing. This script just documents what the
# template must already have on PATH for every row to be executable:
# python3, node (+ tsx via h.ensureNodeToolchain for TypeScript), javac/java,
# go, rustc, gcc/g++, ruby, php-cli, and mono (mcs) for C#.
#
# starter_code is intentionally never executed by this harness (see
# harness.js) — it is a stub only, so it needs no runtime of its own beyond
# whatever `language` already requires.
set -euo pipefail

for bin in python3 node javac java go rustc gcc g++ ruby php mcs mono; do
  command -v "$bin" >/dev/null || echo "implementation: $bin not found — rows in that language will report runtimeUnavailable"
done
echo "implementation: dependency check complete"
