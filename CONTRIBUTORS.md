# Contributors

**Version:** v1.1.0 · **Status:** Active · **Area:** Contributor recognition · **Last verified:** 2026-09-05 · **Source of truth:** owner-provided developer credits and contributor records

Everyone who has helped build DataBounty Community.

**You do not need to add yourself.** Credit here is not a favour you have to ask for — see
[How credit works](#how-credit-works) below. If you contributed and you are not listed, that is a
bug in our process, not a judgement about your work. Open an issue and we will fix it.

---

## How credit works

Credit comes from four places, and you get all four automatically:

1. **Git history.** Your commit carries your name and email forever. `git log`, `git blame`, and the
   repository's Contributors graph all read from it. Nothing can take this away, and nothing here
   replaces it — the other three layers exist because git history only records *code*.

2. **This file.** The table below credits **every kind of contribution**, not just commits — bug
   reports, documentation, design, review, accessibility work, dataset types, translations,
   infrastructure. It is maintained by the [all-contributors](https://allcontributors.org) bot;
   see [Getting listed](#getting-listed).

3. **Release notes.** Each release names the people whose work is in it, with a link to the pull
   request. Product-facing entries live in [`CHANGELOG.md`](CHANGELOG.md).

4. **The pull request itself.** It stays public, attached to your account, and linked from the
   commit — the most durable and most detailed record of what you actually did.

We deliberately do **not** keep an `AUTHORS` file. `AUTHORS` conventionally means *copyright
holders*, which is a legal register, not a thank-you list — and this repository already answers that
question in [`NOTICE`](NOTICE). Conflating the two is how projects end up with a credit file
nobody trusts. This file is credit; `NOTICE` and [`LICENSE`](LICENSE) are ownership and terms.

---

## Getting listed

A maintainer comments on your merged pull request:

```
@all-contributors please add @your-handle for code, doc
```

The bot opens a follow-up pull request adding you to the table below and to
[`.all-contributorsrc`](.all-contributorsrc). Nothing for you to do.

If you would rather **not** be listed, say so in your pull request and we will skip you. Credit is
offered, never imposed. Your commit in git history stays either way — that is a record of authorship,
not a promotional listing, and we do not rewrite history.

### Contribution types we use

| Key | | What it means |
|---|---|---|
| `code` | 💻 | Wrote or changed code |
| `doc` | 📖 | Documentation, including corrections to docs that were wrong |
| `bug` | 🐛 | Reported a reproducible bug |
| `test` | ⚠️ | Added or fixed tests |
| `review` | 👀 | Reviewed pull requests |
| `design` | 🎨 | UI, visual, or interaction design |
| `a11y` | ️️️️♿️ | Accessibility |
| `ideas` | 🤔 | Ideas, planning, or feedback that changed the outcome |
| `infra` | 🚇 | CI, Docker, deployment, tooling |
| `security` | 🛡️ | Responsibly disclosed a vulnerability (credited unless you ask us not to — see [SECURITY.md](SECURITY.md)) |
| `data` | 🔣 | Dataset types, validation harnesses, catalog content |
| `translation` | 🌍 | Translation |
| `question` | 💬 | Answered other people's questions |
| `maintenance` | 🚧 | Dependency, release, and repository upkeep |

The list is not a ranking and the order is not meaningful.

---

## Developers

| Developer | Email | Role |
|---|---|---|
| Cipher | [cipher@databounty.io](mailto:cipher@databounty.io) | Developer |
| Phantom | [phantom@databounty.io](mailto:phantom@databounty.io) | Developer |

Developer credits are maintained here separately from the generated contributor table.

## Contributors

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<!-- The table below is generated. Do not hand-edit it — run the bot instead. -->

_No external contributors yet. This repository has not been published._

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## Original product

DataBounty Community is a rebuild of the original DataBounty product. The people who designed and
built that product are the reason this one has a shape at all, even where none of their code
survived the rebuild. Copyright in the codebase is held as stated in [`NOTICE`](NOTICE), under the terms of [`LICENSE`](LICENSE).

## Identity and duplicates

If your commits appear under more than one name or email — a work laptop, an old address, a changed
display name — the Contributors graph will show you as several different people. Fix it by adding
yourself to [`.mailmap`](.mailmap); the file explains the format. This is a correction to the
record, not a rewrite of history, and it is always welcome.
