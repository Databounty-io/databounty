#!/usr/bin/env bash
# property_based_testing -- build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. The one dependency this category needs beyond python3 itself is
# the `hypothesis` PyPI package (real @given example-generation + shrinking
# engine) -- installed via infra/e2b/databounty-verify/template.ts's existing
# `pip3 install ...` step, alongside this project's other Python libraries
# (pycryptodome, beautifulsoup4, redis, ...). This script only VERIFIES that
# baseline rather than installing anything new -- this category never installs
# a runtime at validation time (sandbox execution is no-network by design).
#
# IMPORTANT, flagged honestly for whoever rebuilds the template next: as of
# this category's own authoring date, `hypothesis` had NOT yet been added to
# the CURRENTLY-PUBLISHED/deployed E2B template (sandbox/runtimes.json's own
# last probe, 2026-08-07, predates this change and does not list it). Adding
# `hypothesis` to template.ts's pip install line (done alongside this file) is
# a NECESSARY but NOT SUFFICIENT step -- the template must actually be
# REBUILT and RE-PUBLISHED (infra/e2b/databounty-verify/build.dev.ts /
# build.prod.ts) before any real sandbox has it. Until that happens, this
# category's harness.js probes for `hypothesis` live (python3 -c "import
# hypothesis") on every verify() call and returns runtimeUnavailable (routed
# to human audit, never a false contributor failure) rather than assuming the
# Dockerfile/template.ts change alone means the dependency is present -- the
# same "probed, not assumed" discipline this registry's README and
# redis_data_structure_semantics's own setup.sh already document.
set -euo pipefail

command -v python3 >/dev/null || { echo "property_based_testing requires python3"; exit 1; }
python3 -c "import hypothesis" || { echo "property_based_testing requires the python3 hypothesis package"; exit 1; }
echo "property_based_testing: dependencies satisfied (python3 + hypothesis both present)"
