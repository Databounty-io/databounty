#!/usr/bin/env bash
# code_translation — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. target_language spans all 10 languages this dataset carries
# (Python, JavaScript, TypeScript, Java, Go, Rust, C++, C#, Ruby, PHP), so
# `requires` in categories.json is deliberately empty — the harness checks
# h.have() per-row for whichever runtime that row's target_language actually
# needs (via h.runWithTests) and reports runtimeUnavailable rather than
# failing the submission when it is missing. This script just documents what
# the template must already have on PATH for every row to be executable:
# python3, node (+ tsx/tsc for TypeScript via h.ensureNodeToolchain), javac/java,
# go (+ gofmt, used only for a parse-only sanity check on Go source_code),
# rustc, gcc/g++, ruby, php-cli, and mono (mcs) for C#.
set -euo pipefail

for bin in python3 node javac java go gofmt rustc gcc g++ ruby php mcs mono; do
  command -v "$bin" >/dev/null || echo "code_translation: $bin not found — rows targeting/sourcing that language will report runtimeUnavailable or abstain from the parse-only gate"
done
echo "code_translation: dependency check complete"
