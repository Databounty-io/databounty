#!/usr/bin/env bash
# api_function_calling — no build-time dependencies.
#
# The harness is pure JS structural/string logic — it parses JSON and
# compares strings, never executes a tool call or spawns a runtime.
set -euo pipefail
echo "api_function_calling: no dependencies required"
