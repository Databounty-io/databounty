#!/usr/bin/env bash
# debugging — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This dataset carries no 'language' field and is TypeScript-only
# (filename + type annotations confirm it); node is the base requirement and
# the harness additionally needs a TypeScript toolchain (tsx to run, tsc to
# type-check) to catch compile-time-only bugs (bug_type "types") that a
# runtime-only check would erase silently. h.ensureNodeToolchain() NEVER
# installs -- it only probes whether `tsx`/`tsc` are already on PATH and
# returns null on absence, routing to runtimeUnavailable (sandbox execution
# is no-network by design; this comment previously and incorrectly claimed a
# runtime install-into-writable-prefix fallback existed).
set -euo pipefail

command -v node >/dev/null || { echo "debugging requires node"; exit 1; }
command -v tsx >/dev/null || echo "debugging: tsx not found on PATH -- TypeScript rows will report runtimeUnavailable"
command -v tsc >/dev/null || echo "debugging: tsc not found on PATH -- the type-check gate will report runtimeUnavailable"
echo "debugging: dependencies satisfied"
