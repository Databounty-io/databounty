# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** A public report tells everyone
running this software about the hole at the same moment it tells us.

Report privately through **GitHub's private vulnerability reporting**: go to the **Security** tab of
this repository → **Report a vulnerability**. This creates a private advisory visible only to you and
the maintainers, and needs no email exchange to get started.

If you cannot use GitHub advisories, email **support@databounty.io** with `SECURITY` in the subject
line. Please do not include the details in an unencrypted attachment you would not want forwarded.

Please include, as far as you can:

- What the issue is, and which app it affects (`apps/api`, `apps/web`, `apps/admin`, `apps/landing`).
- Steps to reproduce, or a proof-of-concept request.
- The commit SHA you tested against.
- What an attacker gets out of it (read another user's submissions, escalate to `admin`, escape the
  execution sandbox, and so on).

We will acknowledge your report, tell you whether we consider it in scope, and keep you updated as we
work on a fix. If we disagree that it is a vulnerability, we will say so and explain why rather than
going quiet.

Please give us reasonable time to ship a fix before disclosing publicly. We will credit you in the
advisory unless you ask us not to.

## Supported versions

This project has not yet cut a tagged release. **Only the current `main` branch is supported** —
fixes land there, and there are no backports to older commits. If you are running a fork or a pinned
commit, you are responsible for pulling fixes forward.

## Scope

In scope — anything that lets someone:

- Read, modify, or delete data belonging to another user or workspace.
- Gain a role they were not granted (`admin`, `member`, `support`), or act past a role check. Note that
  the API's `requireRole()` is the real security boundary; the admin console's client-side redirect is
  UX only, and reporting that redirect as bypassable is not a finding by itself.
- Escape or abuse the execution sandbox that runs contributed code.
- Forge, replay, or steal session cookies, API keys, or MCP OAuth tokens.
- Cause the validation pipeline to report a check as passed when it did not run, or was skipped,
  unsupported, or unconfigured. **We treat dishonest trust state as a security issue, not a cosmetic
  one** — the whole product rests on those claims being true.
- Read files, environment variables, or network destinations the API should not reach.

Out of scope:

- Missing wallet, payment, escrow, payout, or on-chain functionality. None of it exists in this
  codebase by design — see [Where we draw the line](README.md#where-we-draw-the-line). Its absence is not a bug.
- Findings that require a misconfigured deployment you control, where the fix is your configuration
  (for example running with a weak `SESSION_SECRET`, or exposing the API with `CORS_ORIGINS` set to `*`).
- Optional integrations behaving as documented when unconfigured. Execution sandboxing, LLM review, and
  notification channels **fail closed and say so** rather than silently passing; that is the intended
  behavior.
- Automated scanner output with no demonstrated impact, missing security headers with no exploit path,
  or dependency CVEs that are not reachable from this code.
- Social engineering, physical attacks, or denial of service by brute traffic volume.

## Running this yourself

If you self-host, these are yours to get right, and no upstream fix can cover them:

- Set a strong, unique `SESSION_SECRET`. Do not reuse the example value.
- Set `CORS_ORIGINS` to exactly the frontend origins you run — no wildcard.
- Serve every app over HTTPS. Session cookies are not safe over plain HTTP.
- Keep `apps/api/.env` out of version control. It is gitignored here; keep it that way in your fork.
- Give the database its own credentials, not a superuser shared with anything else.
- Read [DEPLOYMENT.md](DEPLOYMENT.md) for which integrations fail closed and what has to be true for a
  real deployment.

## Known dependency advisories

Production-only `npm audit --omit=dev --package-lock-only` against the per-app lockfiles that CI and the
Dockerfiles actually install from, re-run 2026-09-09:

| App | Critical | High | Moderate | Total affected packages |
| --- | --- | --- | --- | --- |
| `apps/api` | 0 | 0 | 0 | 0 |
| `apps/web` | 0 | 0 | 0 | 0 |
| `apps/admin` | 0 | 0 | 0 | 0 |
| `apps/landing` | 0 | 0 | 0 | 0 |

**Production is clean across all four apps.** The four `apps/api` high-severity rows that stood here
previously (`mysql2`, `deepmerge-ts`, and their carriers `@prisma/config` and `prisma`) were **fixed by
tested version overrides on 2026-09-09**, not accepted as exceptions — see below.

This table is **production-only by design** (`--omit=dev`), matching what `npm prune --omit=dev` actually
ships in the `Dockerfile`'s `runner` stage. `vitest`/`@vitest/mocker` are pure devDependencies — never
installed in that image — and remain the one open item; see their subsection below.

### Which lockfile this audit uses, and why it matters

`apps/<app>/package-lock.json` is the authoritative source. Both `Dockerfile`
(`COPY apps/api/package.json apps/api/package-lock.json ./` then `npm ci`) and `ci.yml`
(`cache-dependency-path: apps/${{ matrix.app }}/package-lock.json`, `working-directory: apps/<app>`)
install from it. In the private development workspace these apps are also npm *workspaces* under a
parent `package.json`, and that parent keeps its own lockfile — **npm honours `overrides` only from the
workspace root during a workspace install**, so a local `node_modules/` can resolve different (older)
versions than the shipped lockfile. That divergence was real and observed: `qs` resolved to the
vulnerable 6.15.3 locally while the shipped lockfile already carried the fixed 6.16.0.

Two consequences, both load-bearing:

- **Audit the per-app lockfile, in isolation from any workspace root** (copy `package.json` +
  `package-lock.json` into an empty directory and run `npm audit --package-lock-only` there). Auditing a
  local `node_modules/` reports the developer's tree, not the artefact.
- The parent workspace is a private development convenience. It is not exported and never builds a
  released image.

### Resolved by tested override — 2026-09-09

Declared in `apps/api/package.json` `overrides`:

| Package | Was | Now | Advisory closed |
| --- | --- | --- | --- |
| `mysql2` | 3.15.3 | ^3.24.4 | Auth-plugin downgrade to `mysql_clear_password` leaking plaintext credentials ([GHSA-3f6p-5ww8-9rcr](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr)); unbounded zlib inflate in the compressed protocol handler ([GHSA-rgwj-5xj2-c3m3](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3)) |
| `deepmerge-ts` | 7.1.5 | ^8.0.2 | Stack exhaustion when merging recursive object graphs ([GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)) |
| `qs` | 6.15.3 | ^6.16.0 | Array-limit bypass via bracket-key comma parsing ([GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)); DoS via attacker-controlled `isBuffer` ([GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)) — override predates this pass |

`@prisma/config` and `prisma` needed no override of their own: both were reported solely as carriers of
the two packages above, and both drop off the report once those resolve to patched versions.

**This reverses an earlier recorded decision.** The previous revision of this section stated that
overriding these transitive versions had been "evaluated and rejected" because it would "mask an advisory
in a CLI that never runs in the serving process while risking the config loader." The masking half of
that reasoning does not apply — an override to a patched release is an upgrade, not a suppression. The
config-loader risk was the real concern, since `@prisma/config@7.9.1` pins `deepmerge-ts` to exactly
`7.1.5` and `^8.0.2` is a semver-major jump past that pin. **It was tested rather than assumed**, in an
isolated `npm ci` install of the shipped lockfile with the overrides applied:

| Prisma CLI path | Where it runs | Result with `deepmerge-ts@8.0.2` |
| --- | --- | --- |
| `prisma validate` | config load — the exact `@prisma/config` → `deepmerge-ts` path | Passes: *"Loaded Prisma config from prisma.config.ts"*, schema valid |
| `prisma generate` | `Dockerfile` `build` stage | Passes: Prisma Client v7.9.1 generated |
| `prisma migrate status` | `api-migrate` one-shot container | Passes: connects and reports migration state |
| `tsc -p tsconfig.json --noEmit` | whole API source against the overridden tree | Clean, 0 errors |

**Residual maintenance risk, stated plainly:** `deepmerge-ts@8` is held past an exact pin by an override.
A future Prisma release could depend on 7.x-specific `deepmerge-ts` behaviour, and the override would then
force an untested combination. Re-run the four checks above on every Prisma upgrade, and drop the override
entirely once Prisma ships a release whose own dependencies are unaffected.

### `vitest`/`@vitest/mocker` — dev-only, the one open item

Not part of the production count above on purpose: `vitest` is a direct `devDependency` and
`@vitest/mocker` only exists beneath it, so a `--omit=dev` audit — matching what `npm prune --omit=dev`
ships in the `runner` stage — never installs either.

| Package (installed) | Advisory | Severity | Reachability finding | Decision |
| --- | --- | --- | --- | --- |
| `vitest` 3.2.7 / `@vitest/mocker` | Path traversal / arbitrary file read via redirect mock ([GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)) | Moderate | **Test-only and pruned from the production image.** Exploiting it requires vitest's own dev/UI server to serve untrusted requests, which happens on a developer machine or in CI, never in a deployed container. The advisory covers `<= 4.1.10`; npm's only fix is `vitest@5.0.0`, a **two-major** jump from the pinned `^3.2.7`. Note for a public repository: a fork pull request does execute test code in CI, but such a PR can already run arbitrary code by definition, so this advisory adds no capability an attacker does not already have — the real control is that fork PRs run without organization secrets (tracked separately in the release checklist). | Scoped exception |

**Clearing condition:** a dedicated `vitest` 3 → 5 migration with a full passing test run. Until then this
row stays, and it is the only dependency advisory this repository carries.

### Fixed 2026-09-09 — `qs`, `nodemailer`, and vitest's critical advisory

Three findings from this section's prior revision are now resolved in `apps/api/package.json` and its
lockfile, each verified with a full test run before being applied:

- **`qs` 6.15.3 → `^6.16.0`.** Added `"overrides": { "qs": "^6.16.0" }` to `apps/api/package.json`. It
  satisfies `express@5.2.1`'s `qs@^6.14.0` and `body-parser`'s `qs@^6.15.2`, so this is a **no
  major-version bump anywhere** fix, exactly as previously recorded as available. Verified the override
  actually takes effect in a standalone install matching how CI installs this app (`working-directory:
  apps/api`, no parent-workspace `package.json` in the published tree) — a plain in-place `npm install`
  from this monorepo checkout does *not* apply it, because the sibling `databounty-v1-parity-rebuild`
  workspace root shadows it; that root is dev-only tooling, absent from the published repo.
- **`nodemailer` 9.0.6 → `^9.1.1`.** Same major version, no code change needed. Fixes four advisories:
  [GHSA-8m3c-c648-2xjj](https://github.com/advisories/GHSA-8m3c-c648-2xjj) (disableFileAccess/disableUrlAccess
  bypass via legacy `resolveContent()` signature), [GHSA-wmmp-3585-3rmp](https://github.com/advisories/GHSA-wmmp-3585-3rmp)
  (IDN/punycode allow-list bypass), [GHSA-2x7j-588g-ccc2](https://github.com/advisories/GHSA-2x7j-588g-ccc2)
  (quadratic-time address parsing DoS), [GHSA-cc9r-2j5m-2m83](https://github.com/advisories/GHSA-cc9r-2j5m-2m83)
  (recipient-domain validation bypass via RFC 5322 comment mis-parsing).
- **`vitest` 2.1.9 → `^3.2.7`.** A major-version bump, taken deliberately to close a **critical**
  (CVSS 9.8) advisory — [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp), arbitrary
  file read/execution when Vitest's UI server is listening — fixed at `3.2.6`. Tested before applying:
  ran the full suite (`npm test`, which pins `--maxWorkers=1 --minWorkers=1` because these integration
  tests share one database) against a fresh disposable Postgres database on both the original `vitest@2.1.9`
  and the bumped `vitest@3.2.7`, from a clean `git clone`-equivalent standalone copy of `apps/api`. Same 4
  pre-existing failures on both versions (`src/pipeline.integration.test.ts`, all dependent on an
  unconfigured execution/LLM provider producing a different pipeline-stage outcome than the test expects —
  a known, already-documented gap, not something this bump introduced or fixed) — the version bump changed
  zero test outcomes. `@vitest/mocker`'s own moderate advisory is *not* fixed by this bump (see the table
  row above); vitest's own critical advisory is.

**Result:** the previously-projected "4 High / 0 Moderate" outcome from removing just the `qs` row did not
land exactly as predicted, because two more advisories (the vitest critical one, and `@vitest/mocker`'s
moderate one) had been published against this dependency tree since 2026-09-05 and were caught by this
same pass. Net: one critical advisory closed, `qs` and `nodemailer` fully closed, one moderate
(`@vitest/mocker`) scoped-excepted above. That row now requires **vitest 5**, not 4: the advisory range was
subsequently widened to `<= 4.1.10`, so npm's only fix is `vitest@5.0.0`.

### What is *not* proven here

Stated plainly, because a dependency claim that overstates its evidence is exactly the kind of
dishonest trust state this policy treats as a security issue:

- Reachability above was established from `apps/api/package-lock.json` and an installed tree.
  **Re-verified 2026-09-09 against the generated export candidate's own per-app lockfiles**, each audited
  in isolation from the development workspace root (`package.json` + `package-lock.json` copied into an
  empty directory, `npm audit --package-lock-only`): production is 0 across all four apps and the only
  remaining row is the dev-only vitest one. Re-run this at export time if the lockfiles change again.
- The module-load probes cover the static import graph reachable from the entry points this app
  actually imports. A dependency that reached one of these packages through a *dynamic* import on a
  code path the probe never triggered would not show up. No such path was found by inspection; that is
  an inspection result, not a proof.
- These packages are still **present on disk** in the production image, now at patched versions rather
  than absent. `npm prune --omit=dev` (`Dockerfile`, `runner` stage) does not remove `prisma`, `mysql2`,
  `@prisma/config`, `deepmerge-ts`, `express`, `body-parser` or `qs`, because `@prisma/client` pulls the
  Prisma CLI in as an optional peer. "Patched" is the claim being made here; "not shipped" is not.
- No exploit was attempted against any of these packages. These are reachability findings.
