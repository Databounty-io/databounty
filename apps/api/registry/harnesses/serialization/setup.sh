#!/usr/bin/env bash
# serialization — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. json/pickle/xml are stdlib; msgpack/yaml are third-party but
# already present in the base image.
set -euo pipefail

command -v python3 >/dev/null || { echo "serialization requires python3"; exit 1; }
python3 -c "import msgpack, yaml" || { echo "serialization requires msgpack + pyyaml"; exit 1; }
echo "serialization: dependencies satisfied"
