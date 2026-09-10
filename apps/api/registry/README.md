# Category registry

The routing table and per-category verification contracts. **Adding a category is
adding a folder here** — no changes to the API, the seed script, or the web app.

```
registry/
  categories.json              routing table: category id -> folder + runtime needs
  lib/helpers.js               the helper API every harness receives
  run.js                       single entrypoint executed inside the sandbox
  harnesses/<category_id>/
    schema.json                AUTHORITATIVE field spec (see below)
    harness.js                 verify(row, h) -> { passed, score, detail, logs }
    setup.sh                   dependencies, consumed at TEMPLATE BUILD time
```

## schema.json is the single source of truth

`prisma/seed-catalog.ts` generates `DatasetType.fields` and
`verification.harness` from these files. The sponsor's spec form, the
contributor's submission form and the validator's review screen all render from
that same field list.

This is deliberate. When the field spec was hand-maintained in three places, they
drifted: `regex_generation` collected `regex_pattern`/`positive_matches` while the
data used `generated_regex`/`test_strings_match`, so the form gathered fields the
verifier could never read and the category silently returned
`no_executable_harness` with nothing verified. Generating from one file makes that
class of bug structurally impossible rather than a thing to remember.

**Never hand-edit `DatasetType.fields` in the DB or the web catalog.** Edit
`schema.json` and re-seed.

## Why harnesses are JavaScript, not Python

The proposed layout used `harness.py`. Harnesses here are `harness.js` because the
helper API (`run`, `have`, `workdir`, comparison helpers) then has exactly one
implementation. A Python harness API would need a parallel Python helper library
kept in sync with the Node one.

This costs nothing in expressiveness: the harness's language is independent of the
**subject's** language. `harness.js` calls `h.run("python3", [file])`,
`h.run("gcc", ...)`, `h.run("mono", ...)` as needed — most of the verified
harnesses execute Python, and one executes both Node and Python because the regex
dialect matters.

## setup.sh is a build input, not a per-request step

`setup.sh` declares what the category needs so it can be composed into the E2B
template image (`infra/e2b/`). It is **not** executed per submission — running
`apt-get`/`pip install` on every validation would add tens of seconds to each row.

## Sandbox execution is no-network by default

A harness must **never** install a toolchain at runtime. Every interpreter,
compiler and library a harness needs is baked into the verified image
(`infra/e2b/databounty-verify/e2b.Dockerfile`, whose final stage fails the build
if any expected binary or import is missing).

When something is absent, the harness returns `runtimeUnavailable: true`, which
routes the item to manual review. It does not fetch the dependency and it does
not fail the contributor. Three reasons this is a hard rule rather than a
preference:

- it needs network egress from the sandbox, widening the blast radius of running
  untrusted submitted code;
- an unpinned version resolved at run time would decide a pass/fail verdict, so
  the same submission could be judged differently on two days;
- the first item in every fresh sandbox would pay a multi-minute install, and
  E2B creates one sandbox per row.

**Three categories are declared exceptions**, because reaching the network *is
the thing being verified*, not a way to obtain a tool:

| Category | Why it needs egress |
|---|---|
| `dependency_vuln_audit` | `npm audit` / `pip-audit` query live advisory data (registry.npmjs.org, PyPI/OSV.dev) |
| `build_dependency_resolution` | resolves/installs the manifest under test |
| `package_publishing` | builds and installs the package under test |

Each already fails closed: with no egress they report `runtimeUnavailable` and go
to manual review rather than recording a false verdict. Running the platform with
a strict no-network sandbox is therefore safe — those three degrade to manual
review instead of breaking.

This is enforced per category, not just documented: a category's `categories.json`
entry must set `"networkEgress": true` before its sandbox can reach the network at
all (`categoryAllowsNetworkEgress` in `src/services/execution-providers/registry-loader.ts`).
Every other category is force-blocked regardless of the operator's global
`EXECUTION_SANDBOX_ALLOW_EGRESS`/`EXECUTION_SANDBOX_EGRESS_ALLOWLIST` config — that
config only widens egress for a category that already declared it needs some;
it can never be the sole reason an unrelated category's sandbox gets network access.
Set `networkEgress` **only** on the three categories above.

## The harness contract

```js
module.exports = {
  // Optional. Declared so the runner can report runtime_unavailable rather than
  // failing the submission when a toolchain is missing.
  requires: ["python3"],

  /**
   * @param row  the submission payload, already schema-validated
   * @param h    helpers: { run, have, workdir, path, fs, norm, looseEqual, canonical, jsonOf }
   * @returns { passed, score, detail, logs?, runtimeUnavailable? }
   *          Returning runtimeUnavailable routes the item to human audit instead
   *          of recording a false failure.
   */
  verify(row, h) { ... },
};
```

## Adding a category

1. `mkdir registry/harnesses/<id>` with the three files.
2. Add the entry to `categories.json`.
3. `npx tsx prisma/seed-catalog.ts` — the DB type is created/updated from `schema.json`.
4. `npx tsx scratch/catrun/run.ts <id>` to validate against the reference dataset.

No API code changes. `buildCategoryHarness` resolves the folder by id at runtime.
