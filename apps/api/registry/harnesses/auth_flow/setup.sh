#!/bin/sh
# Build-time documentation only — not executed per-request.
#
# auth_flow harness requires:
#   - python3
#   - PyJWT (`import jwt`) — already present in the databounty-verify E2B template
#   - stdlib `time` — no install needed
#
# Nothing else (no node/go/rust/java/etc.) is needed for this category.
echo "auth_flow requires: python3, PyJWT (jwt)"
