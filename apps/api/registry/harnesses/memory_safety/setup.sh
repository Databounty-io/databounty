#!/usr/bin/env bash
# memory_safety — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission.
set -euo pipefail

command -v gcc >/dev/null || { echo "memory_safety requires gcc"; exit 1; }
command -v valgrind >/dev/null || { echo "memory_safety requires valgrind"; exit 1; }
# clang (+ compiler-rt, e.g. libclang-rt-19-dev) is used as a fallback, not a
# hard requirement: GCC's libasan does not implement the "fake stack"
# mechanism AddressSanitizer's stack-use-after-return detection needs, so the
# harness only reaches for clang on that one specific claim shape (the
# get_dangling()-style row). Without clang present, that one row's real
# result stays an undiagnosed SEGV and is scored a mismatch against its
# claim — the category still runs, just with that one row wrong.
echo "memory_safety: dependencies satisfied"
