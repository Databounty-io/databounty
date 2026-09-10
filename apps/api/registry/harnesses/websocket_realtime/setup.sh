#!/bin/sh
# Build-time documentation only -- not executed per-request.
#
# websocket_realtime harness requires:
#   - python3
#   - websockets (`import websockets`) -- added to the databounty-verify E2B
#     template's pip3 install list. Sandbox execution is no-network by
#     design: verify() only PROBES `import websockets` and fails closed to
#     runtimeUnavailable if it's missing -- there is no runtime install
#     fallback (never was one; this comment previously and incorrectly
#     claimed otherwise).
#
# Nothing else (no node/go/rust/java/etc.) is needed for this category.
echo "websocket_realtime requires: python3, websockets"
