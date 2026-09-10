#!/usr/bin/env bash
# shell_idempotency — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission.
set -euo pipefail

command -v bash >/dev/null || { echo "shell_idempotency requires bash"; exit 1; }
command -v md5sum >/dev/null || { echo "shell_idempotency requires md5sum"; exit 1; }
# setsid isolates each script run in its own process group so any background
# job it forks can be forcibly reaped afterward; find/sort/xargs/stat/
# readlink build the filesystem snapshot (content, permissions, and symlink
# targets) that idempotency is judged against.
command -v setsid >/dev/null || { echo "shell_idempotency requires setsid"; exit 1; }
command -v find >/dev/null || { echo "shell_idempotency requires find"; exit 1; }
command -v sort >/dev/null || { echo "shell_idempotency requires sort"; exit 1; }
command -v xargs >/dev/null || { echo "shell_idempotency requires xargs"; exit 1; }
command -v stat >/dev/null || { echo "shell_idempotency requires stat"; exit 1; }
command -v readlink >/dev/null || { echo "shell_idempotency requires readlink"; exit 1; }
echo "shell_idempotency: dependencies satisfied"
