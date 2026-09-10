#!/usr/bin/env bash
# dependency_vuln_audit — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category's OWN verification also needs network access at
# RUN time (real npm audit / pip-audit runs against the live registry and
# advisory database) — a sandboxed environment with no outbound network would
# need every row here to fall back to runtime_unavailable.
set -euo pipefail

command -v npm >/dev/null || { echo "dependency_vuln_audit requires npm"; exit 1; }
command -v pip-audit >/dev/null || { echo "dependency_vuln_audit requires pip-audit"; exit 1; }
echo "dependency_vuln_audit: dependencies satisfied"
