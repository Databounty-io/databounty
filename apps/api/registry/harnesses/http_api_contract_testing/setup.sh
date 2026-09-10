#!/usr/bin/env bash
# http_api_contract_testing — build-time dependency check.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category needs NOTHING beyond python3's own standard
# library (http.server/socketserver/BaseHTTPRequestHandler for
# server_implementation, http.client for the harness's own real client) --
# no new pip/apt package, unlike several of this expansion's other new
# categories (redis_data_structure_semantics -> redis-server + redis-py,
# property_based_testing -> hypothesis, schema_conformance_validation ->
# jsonschema/lxml). This script only verifies that baseline is genuinely
# present -- it never installs anything at validation time (sandbox
# execution is no-network by design) and it never starts a long-lived
# server itself; harness.js's own driver.py starts and tears down the
# contributor's server process fresh, per row, from inside its own
# subprocess lifecycle.
set -euo pipefail

command -v python3 >/dev/null || { echo "http_api_contract_testing requires python3"; exit 1; }
python3 -c "import http.server, http.client, socketserver, subprocess, socket, base64, json" \
  || { echo "http_api_contract_testing requires the python3 standard library's http.server/http.client/socketserver modules"; exit 1; }
echo "http_api_contract_testing: dependencies satisfied (python3 stdlib http.server/http.client/socketserver all importable; no server left running)"
