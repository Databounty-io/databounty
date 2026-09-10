#!/usr/bin/env bash
# algorithmic_trading_backtest -- build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category is pure Python STDLIB: the harness's own driver
# process generates the synthetic (GBM) price path using only `random` and
# `math`, computes Sharpe/Sortino/max-drawdown/CAGR/Calmar using only
# `statistics` and `math`, and drives strategy_code bar-by-bar in a separate
# `subprocess`-spawned runner process communicating over plain stdin/stdout
# JSON lines. No numpy, no pandas, no third-party package of any kind is
# required -- see harness.js's own module doc comment for why stdlib
# `statistics.mean`/`statistics.stdev` are sufficient for this category's own
# metric formulas. No new E2B image dependency is introduced by this
# category.
set -euo pipefail

command -v python3 >/dev/null || { echo "algorithmic_trading_backtest requires python3"; exit 1; }
python3 -c "import sys, os, json, random, math, statistics, subprocess" || {
  echo "algorithmic_trading_backtest requires the python3 stdlib sys/os/json/random/math/statistics/subprocess modules"
  exit 1
}
echo "algorithmic_trading_backtest: dependencies satisfied"
