#!/usr/bin/env bash
# i18n — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Requires a full-icu Node build — a small-icu build silently
# collapses every non-English locale to en-US formatting, which would report
# as wrong output rather than a missing runtime.
set -euo pipefail

command -v node >/dev/null || { echo "i18n requires node"; exit 1; }
node -e "const s=new Intl.NumberFormat('de-DE',{style:'currency',currency:'USD'}).format(1234.5); if(!/1\.234,50/.test(s)){ console.error('small-icu build: got '+s); process.exit(1); }"
echo "i18n: dependencies satisfied (full-icu confirmed)"
