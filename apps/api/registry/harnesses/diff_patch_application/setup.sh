#!/usr/bin/env bash
# diff_patch_application -- build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category needs only `git`, which is ALREADY a `requires`
# dependency baked into the verified image for the git_merge_resolution
# category -- no new E2B image dependency is introduced here. This script
# only verifies that existing baseline rather than installing anything new
# (sandbox execution is no-network by design; a category's harness never
# installs a toolchain at validation time).
set -euo pipefail

command -v git >/dev/null || { echo "diff_patch_application requires git"; exit 1; }
echo "diff_patch_application: dependencies satisfied (git present)"
