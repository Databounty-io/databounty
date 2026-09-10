#!/usr/bin/env bash
# schema_conformance_validation -- build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. This category needs two Python libraries, one already baked
# into the verified image and one newly added alongside this file:
#   - `lxml` (XSD validation via lxml.etree.XMLSchema) -- ALREADY baked into
#     infra/e2b/databounty-verify/template.ts's `pip3 install ...` line
#     (present for the serialization category's own XML handling).
#   - `jsonschema` (JSON Schema Draft 2020-12 / whichever draft a row's own
#     "$schema" declares) -- NEWLY added to that same pip install line by
#     this category's own change, alongside the build-time import-check
#     assertion line -- the exact same pattern `hypothesis`'s own addition
#     for property_based_testing (category #5) already used.
# This script only VERIFIES that baseline rather than installing anything new
# -- this category never installs a runtime at validation time (sandbox
# execution is no-network by design).
#
# IMPORTANT, flagged honestly for whoever rebuilds the template next: as of
# this category's own authoring date, `jsonschema` had NOT yet been added to
# the CURRENTLY-PUBLISHED/deployed E2B template (sandbox/runtimes.json's own
# last probe predates this change and does not list it). Adding `jsonschema`
# to template.ts's pip install line (done alongside this file) is a NECESSARY
# but NOT SUFFICIENT step -- the template must actually be REBUILT and
# RE-PUBLISHED (infra/e2b/databounty-verify/build.dev.ts / build.prod.ts)
# before any real sandbox has it. Until that happens, this category's
# harness.js probes for `jsonschema` live (python3 -c "import jsonschema"),
# but ONLY for a "JSON Schema" row -- an "XSD" row never touches jsonschema
# at all and is unaffected -- and returns runtimeUnavailable (routed to human
# audit, never a false contributor failure) rather than assuming the
# Dockerfile/template.ts change alone means the dependency is present -- the
# same "probed, not assumed" discipline this registry's README and
# property_based_testing's/redis_data_structure_semantics's own setup.sh
# scripts already document.
set -euo pipefail

command -v python3 >/dev/null || { echo "schema_conformance_validation requires python3"; exit 1; }
python3 -c "import jsonschema" || { echo "schema_conformance_validation requires the python3 jsonschema package"; exit 1; }
python3 -c "import lxml.etree" || { echo "schema_conformance_validation requires the python3 lxml package"; exit 1; }
echo "schema_conformance_validation: dependencies satisfied (python3 + jsonschema + lxml all present)"
