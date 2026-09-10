#!/bin/sh
# Build-time documentation only — not executed per-request.
#
# cryptographic_implementation harness requires:
#   - python3
#   - stdlib hashlib / hmac / zlib / base64 — no install needed (SHA-*, MD5,
#     HMAC-*, PBKDF2, CRC32, Base64 rows)
#   - pycryptodome (`import Crypto`) — already present in the
#     databounty-verify E2B template (AES rows). Sandbox execution is
#     no-network by design: verify() only PROBES `import Crypto` when a
#     row's own code imports Crypto.* and fails closed to runtimeUnavailable
#     if it's missing -- there is no runtime install fallback.
#
# Nothing else (no node/go/rust/java/etc.) is needed for this category.
echo "cryptographic_implementation requires: python3, stdlib hashlib/hmac/zlib/base64, pycryptodome (Crypto) for AES rows"
