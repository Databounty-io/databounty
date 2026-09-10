#!/usr/bin/env bash
# cli_argument_parsing -- build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category is pure Python stdlib logic -- solution_code's
# build_parser() is exec()'d directly and driven with real, unmodified
# argparse.ArgumentParser.parse_args(argv) calls (never a reimplementation,
# never click/yargs -- a prior, deliberate scoping decision preserved here),
# with contextlib.redirect_stdout/redirect_stderr capturing real output --
# never a real subprocess beyond python3 itself, never a network call. No new
# E2B image dependency is introduced by this category.
set -euo pipefail

command -v python3 >/dev/null || { echo "cli_argument_parsing requires python3"; exit 1; }
python3 -c "import sys, os, json, io, contextlib, argparse" || { echo "cli_argument_parsing requires the python3 stdlib sys/os/json/io/contextlib/argparse modules"; exit 1; }
echo "cli_argument_parsing: dependencies satisfied"
