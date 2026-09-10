#!/usr/bin/env bash
# ast_codemod_transformation -- build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category is pure Python stdlib logic -- both original_code
# and transformed_code are parsed with the real interpreter's own built-in
# `ast` module (never a reimplementation, never regex/text diffing) and then
# exec()'d directly, with logging.{exception,error,warning,critical}
# monkeypatched to a plain in-process recorder for the one transformation_type
# that needs runtime side-effect verification (except_pass_to_logging) --
# never a real network call, never a subprocess beyond python3 itself. No new
# E2B image dependency is introduced by this category.
set -euo pipefail

command -v python3 >/dev/null || { echo "ast_codemod_transformation requires python3"; exit 1; }
python3 -c "import sys, os, json, ast, logging" || { echo "ast_codemod_transformation requires the python3 stdlib sys/os/json/ast/logging modules"; exit 1; }
python3 -c "import ast; ast.parse('def f(x):\n    return x\n'); assert hasattr(ast, 'Constant') and hasattr(ast, 'JoinedStr')" || { echo "ast_codemod_transformation requires a Python 3 whose ast module exposes Constant/JoinedStr (Python 3.8+)"; exit 1; }
echo "ast_codemod_transformation: dependencies satisfied"
