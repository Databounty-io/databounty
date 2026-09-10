#!/usr/bin/env bash
# regex_generation — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Both engines are needed: the reference data is mixed-dialect, so a
# pattern that will not compile in JS is retried under Python.
set -euo pipefail
# node and python3 are in the base image; nothing further is required.
command -v node    >/dev/null || { echo "regex_generation requires node";    exit 1; }
command -v python3 >/dev/null || { echo "regex_generation requires python3"; exit 1; }
echo "regex_generation: dependencies satisfied"
