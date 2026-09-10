#!/usr/bin/env bash
# static_lint_rule_fix_verification -- build-time dependency check.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category needs real `eslint` and real `ruff` on PATH --
# both were added to infra/e2b/databounty-verify/template.ts's build script
# (`npm install -g ... eslint@9`, `pip3 install ... ruff`) as part of this
# category's own design, but the PUBLISHED sandbox image has not been
# rebuilt from that script as of this file's authoring (see harness.js's own
# module doc comment, "REAL E2B CONFIRMATION DEFERRED"). This script only
# verifies the baseline is genuinely present -- it never installs anything at
# validation time (sandbox execution is no-network by design). Until the
# image is rebuilt, harness.js's own h.have('eslint')/h.have('ruff') checks
# correctly report runtimeUnavailable (routed to human audit) rather than a
# false contributor failure.
set -euo pipefail

command -v eslint >/dev/null || { echo "static_lint_rule_fix_verification requires eslint (core, no plugins) on PATH"; exit 1; }
command -v ruff >/dev/null || { echo "static_lint_rule_fix_verification requires ruff on PATH"; exit 1; }
eslint --version >/dev/null
ruff --version >/dev/null
echo "static_lint_rule_fix_verification: dependencies satisfied (eslint and ruff both present and runnable; no code executed by either)"
