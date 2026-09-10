#!/usr/bin/env bash
# concurrency_race_detection — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Nothing new to install: go1.22.5 is already baked into the
# verified image by infra/e2b/databounty-verify/template.ts (curl-installed
# to /usr/local/go, symlinked to /usr/local/bin/go and /usr/local/bin/gofmt),
# alongside gcc -- also already baked, from the same image's shared apt-get
# install step. Both are already independently listed in
# sandbox/runtimes.json (probed 2026-08-07 against the actually-published
# template, not assumed from the Dockerfile).
#
# gcc matters here specifically because `go run -race` needs it: the race
# detector's runtime is a C library (ThreadSanitizer-derived) linked in via
# cgo, which requires CGO_ENABLED=1 and a working C compiler on non-Darwin
# platforms (go.dev/doc/articles/race_detector, and multiple golang.org/x
# issue threads on the cgo requirement, fetched and confirmed during
# authoring of this category — this authoring host has no local `go` binary
# at all, so this fact is sourced from Go's own published documentation, not
# a local run). This script only VERIFIES that baseline (go + gcc both on
# PATH), never installs anything new — this category never installs a
# runtime at validation time (sandbox execution is no-network by design).
set -euo pipefail

command -v go >/dev/null || { echo "concurrency_race_detection requires the go binary"; exit 1; }
command -v gcc >/dev/null || { echo "concurrency_race_detection requires gcc (cgo dependency of 'go run -race')"; exit 1; }
echo "concurrency_race_detection: dependencies satisfied (go + gcc both present; -race relies on gcc via cgo)"
