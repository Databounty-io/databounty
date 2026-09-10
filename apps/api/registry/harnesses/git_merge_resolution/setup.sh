#!/usr/bin/env bash
# git_merge_resolution — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission: apt-get/pip on every validation would add tens of seconds per row.
set -euo pipefail

apt-get update && apt-get install -y --no-install-recommends git

command -v git >/dev/null || { echo "git_merge_resolution requires git"; exit 1; }
echo "git_merge_resolution: dependencies satisfied"
