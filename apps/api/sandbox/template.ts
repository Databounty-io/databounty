// SPDX-License-Identifier: Apache-2.0
import { Template } from "e2b";

/**
 * The execution sandbox image, as code.
 *
 * Ported from V1 (`databounty-api/infra/e2b/databounty-verify/template.ts`,
 * read-only reference) so this rebuild can build and re-probe its own sandbox
 * image without depending on the frozen V1 tree.
 *
 * WHY THIS EXISTS HERE NOW. `provider-runtimes.ts` inlines the probed runtime
 * manifest with the note "this rebuild's API package ships no `sandbox/`
 * directory yet". It does now, and this is it.
 *
 * WHAT IT FIXES. Four dataset categories could not execute even after the
 * registry harness corpus was ported, because the image itself lacked the tools
 * their harnesses shell out to:
 *
 *   - `property_based_testing`            -> `hypothesis`
 *   - `static_lint_rule_fix_verification` -> `ruff` (Python rows) and `eslint` (JS/TS rows)
 *   - `static_compilation`                -> `mypy` (its Python `--strict` branch only)
 *
 * All four are installed below, and the final assertion block FAILS THE BUILD
 * if any of them is missing — so a published image can never quietly lack them
 * again. This was verified as a real gap by running V1's own unmodified harness
 * code against the currently-published image: it reported `no_hypothesis`,
 * `no_ruff` and `no_eslint`, i.e. the same categories are broken in V1 today.
 *
 * The gap was NOT that V1's definition omits these tools — V1 added them on
 * 2026-09-03. It is that the published `databounty-verify` image was last built
 * 2026-08-13 and never rebuilt afterwards, so the definition and the deployed
 * image had drifted three weeks apart.
 *
 * BUILD IT WITH `build.dev.ts` (see that file). Building publishes to the
 * `databounty-verify-dev` alias and NEVER touches `databounty-verify`, which is
 * the image V1's live deployments run on.
 *
 * TO CHANGE A RUNTIME: edit here, rebuild, re-probe the built image, then update
 * `E2B_TEMPLATE_BINARIES` in `src/services/execution-providers/provider-runtimes.ts`
 * from that probe. Never add a binary to that manifest because this file
 * declares it — the manifest is what the platform is allowed to CLAIM it can
 * execution-verify, so it must describe an image that was actually observed.
 */
export const template = Template()
  .fromImage("e2bdev/code-interpreter:latest")
  .setUser("root")
  .setWorkdir("/")
  .setEnvs({ DEBIAN_FRONTEND: "noninteractive" })
  .setEnvs({ PIP_DISABLE_PIP_VERSION_CHECK: "1" })
  .setEnvs({ PIP_NO_CACHE_DIR: "1" })
  .runCmd(
    "apt-get update && apt-get install -y --no-install-recommends php-cli ruby-full sqlite3 libsqlite3-dev valgrind clang libclang-rt-19-dev redis-server default-jdk mono-mcs mono-runtime libxml2-utils rustc cargo build-essential curl ca-certificates unzip protobuf-compiler && rm -rf /var/lib/apt/lists/* && rustc --version"
  )
  .runCmd(
    "curl -fsSL https://go.dev/dl/go1.22.5.linux-amd64.tar.gz -o /tmp/go.tar.gz && tar -C /usr/local -xzf /tmp/go.tar.gz && rm /tmp/go.tar.gz"
  )
  .runCmd("ln -s /usr/local/go/bin/go /usr/local/bin/go && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt && go version")
  .runCmd(
    'npm install -g --no-audit --no-fund typescript@5 tsx@4 jest@29 mocha@10 vitest@2 graphql@16 @graphql-tools/schema@10 fast-xml-parser@5 xml2js@0.6 cheerio@1 ajv@8 eslint@9 && npm cache clean --force && global_node_modules="$(npm root -g)" && mkdir -p /home/user/node_modules && cp -a "$global_node_modules"/. /home/user/node_modules/ && chown -R user:user /home/user/node_modules'
  )
  .runCmd(
    "pip3 install --no-cache-dir pycryptodome beautifulsoup4 lxml PyJWT protobuf redis requests pip-audit build wheel setuptools flit_core websockets mypy hypothesis jsonschema ruff"
  )
  // Fail the build rather than publish an image that silently lacks a runtime a
  // harness depends on. `mypy`, `eslint`, `ruff` and `hypothesis` are asserted
  // explicitly because their absence is exactly what took four categories out.
  .runCmd(
    String.raw`set -eux; for c in python3 node npm gcc g++ go rustc cargo javac java git tsx tsc jest php ruby sqlite3 valgrind clang redis-server mcs mono xmllint protoc mypy eslint ruff; do command -v "$c" >/dev/null || { echo "MISSING BINARY: $c"; exit 1; }; done; python3 -m mypy --version >/dev/null; ruff --version >/dev/null; eslint --version >/dev/null; test "$(node -p 'process.versions.node')" = "20.20.2"; test "$(python3 -c 'import platform; print(platform.python_version())')" = "3.13.14"; python3 -c "import Crypto, bs4, jwt, google.protobuf, redis, websockets, hypothesis, jsonschema; print('python deps ok')"; cd /home/user && node -e "require('graphql'); require('@graphql-tools/schema'); require('cheerio'); require('fast-xml-parser'); require('xml2js'); console.log('node deps ok')"; printf '<root><item id="1">ok</item></root>\n' | xmllint --noout -; node -e "const s=new Intl.NumberFormat('de-DE',{style:'currency',currency:'USD'}).format(1234.5); if(!/1\.234,50/.test(s)) { console.error('SMALL-ICU: got '+s); process.exit(1); } console.log('full-icu ok')"`
  )
  .setUser("user")
  .setWorkdir("/home/user");