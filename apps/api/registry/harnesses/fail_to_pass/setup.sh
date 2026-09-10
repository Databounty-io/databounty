#!/usr/bin/env bash
# fail_to_pass — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Language is inferred per-row from code shape (no `language`
# field in this dataset), so any of the polyglot sandbox's toolchains may be
# hit — python3/node are required, the rest degrade to runtime_unavailable
# (human audit) when absent, exactly like the compiled-language categories.
set -euo pipefail

command -v python3 >/dev/null || { echo "fail_to_pass requires python3"; exit 1; }
command -v node >/dev/null || { echo "fail_to_pass requires node"; exit 1; }
echo "fail_to_pass: dependencies satisfied"
