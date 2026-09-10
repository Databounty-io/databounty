#!/usr/bin/env bash
# network_protocol_fsm — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission: apt-get/pip on every validation would add tens of seconds per row.
set -euo pipefail

command -v python3 >/dev/null || { echo "network_protocol_fsm requires python3"; exit 1; }
echo "network_protocol_fsm: dependencies satisfied"
