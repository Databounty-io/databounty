#!/usr/bin/env bash
# web_scraping — build-time dependencies.
#
# Consumed when composing the E2B template image (infra/e2b/), NOT run per
# submission. Nothing is fetched at request time -- the harness reads the
# injected `html` variable and needs only bs4 (Python) / cheerio (Node),
# both self-checked at runtime with a clean runtimeUnavailable fallback.
set -euo pipefail

python3 -c "import bs4" || { echo "web_scraping requires beautifulsoup4"; exit 1; }
node -e "require('cheerio')" || { echo "web_scraping requires cheerio"; exit 1; }
echo "web_scraping: dependencies satisfied"
