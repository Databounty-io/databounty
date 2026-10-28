---
title: DataBounty
emoji: 🧭
colorFrom: green
colorTo: blue
sdk: gradio
sdk_version: 6.30.0
python_version: "3.12"
app_file: app.py
short_description: Contribute and review dataset items, karma and MCP tools
license: apache-2.0
pinned: true
tags:
  - datasets
  - data-collection
  - crowdsourcing
  - mcp-server
datasets:
  - databounty-io/graphql-schema-resolver-execution-validation-cmskdigf
  - databounty-io/build-competitive-programming-problem-dataset-cmsokff2
  - databounty-io/regex-pattern-generation-with-verified-match-sets-cmskdvm7
  - databounty-io/extract-metrics-from-log-fixtures-cmskdlip
  - databounty-io/python-execution-trace-output-prediction-cmskdimp
  - databounty-io/python-data-transformation-scripts-cmskdijz
---

# DataBounty

A live window onto [DataBounty](https://databounty.io), the open-source, karma-based platform where the community
builds datasets, and a place to contribute to it. Sponsors request a dataset, contributors submit items, automated checks validate each
submission and human validators review the results. Finished datasets are published here on the Hub under
[databounty-io](https://huggingface.co/databounty-io), with contributor credit.

## What's inside

It looks and works like the console on databounty.io:

- **Home**: what DataBounty is, its live totals, the three ways to take part and a few open pools.
- **Contribute**: your karma, every open pool, and your submissions. Open a pool to see what it wants and how items
  are checked, then add items one at a time or many from a file.
- **Validate**: review other people's items. Claim an open audit, check each item against the pool's spec and its
  automated checks, then approve it or reject it with a reason and a note for the contributor.
- **Sponsor**: how requesting a dataset works, with links to make and track requests on databounty.io. If you
  requested a pool, its page here also shows you every item in it, and you can dispute an accepted one.
- **Datasets**: DataBounty releases on the Hub, with download counts.
- **Leaderboard**: public karma standings and profiles. Private profiles, and any field a member hides, are never shown.
- **API & MCP**: connect Claude, Cursor or VS Code to DataBounty's own MCP server.
- **About**: live programme totals, the karma tiers and how it all works.

## Contributing from the Space

Press **sign in with DataBounty** and sign in with your DataBounty account, then approve the Space. On the Space's
own page, sign-in happens in the same tab. On the huggingface.co page, a small sign-in window opens and closes itself
when you're done, and the page signs you in where you are. The Space asks for six permissions: read pools and your
own items, contribute items, review other people's items, see the items in pools you requested, upload files for
file fields, and set up your account on first sign-in. You can untick any of them, but the Space can't contribute
without *contribute*, review without *validate*, or show your pools' items without *sponsor*.

Then pick a pool, and add one item with the form or many at once from a JSONL, JSON, CSV or TSV file (there's a
template to start from). A file is checked row by row before anything is sent. Each pool shows an example item when
it has one, and its full requirements one click away. **My submissions** shows where each item stands, check by check.

- DataBounty takes items only from accounts with a verified email and a public username. The Space walks you through
  both on first sign-in. Choosing a username makes your profile public at `databounty.io/<username>` straight away.
- Your DataBounty tokens stay in the Space's memory and are never written to disk or sent to your browser, which
  keeps only a random key to them. Signing out revokes the tokens. A restart of the Space signs everyone out.
- Revisions, contesting a reviewer's verdict, and requesting a dataset happen on [databounty.io](https://databounty.io).

## Reviewing from the Space

Open **Validate** and claim an open audit: a few items from one pool, yours for 24 hours. You never get your own work.
Go through the items one at a time and approve each one, or reject it with a reason and a note of at least 10
characters, which is all the contributor sees. Decisions are final. You earn karma for every decision when the audit
completes, and your validator rank sets how many audits you can hold at once.

## Sponsoring from the Space

Requesting a dataset happens on [databounty.io](https://console.databounty.io/sponsor/create/). Once your pool is
open, sign in here and open the pool's page: below its details you see every item in it, newest first, with its
fields, its automated checks and any reviewer flags, and you can filter by where items stand. While an accepted
item's dispute window is open, you can dispute it with a reason and an explanation of at least 10 characters. An
admin decides, and the contributor's karma is only reversed if the dispute is upheld. Nobody else sees this view:
DataBounty shows a pool's items only to the person who requested it.

## Use it from an agent

This Space is also an MCP server:

```text
https://databounty-io-databounty.hf.space/gradio_api/mcp/
```

- **Six tools browse, with nothing to set up:** `get_platform_stats`, `search_open_pools`, `get_pool_details`,
  `list_published_datasets`, `get_karma_leaderboard` and `get_contributor_profile`.
- **Five tools submit items as you:** `get_my_account`, `get_pool_contract`, `submit_items`,
  `list_my_submissions` and `check_submission`. They need a DataBounty API key:
  1. Create one at [console.databounty.io/developers](https://console.databounty.io/developers/) with the
     **contribute** scope.
  2. Add it to your MCP client's settings for this server as the `X-DataBounty-Key` header. It never goes in a
     message or a tool argument, so the model never sees it.

  The Space passes the key to DataBounty for each call and keeps nothing. Revoke it on DataBounty any time.
- **Two tools for sponsors:** `get_pool_items_as_sponsor` lists the items in a pool you requested, with their
  checks, and `dispute_accepted_item` disputes an accepted one. They need a key with the **sponsor** scope and
  work only on your own pools.

Claude Code:

```bash
claude mcp add --transport http databounty-space https://databounty-io-databounty.hf.space/gradio_api/mcp/ \
  --header "X-DataBounty-Key: db_live_sk_..."
```

Cursor (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "databounty-space": {
  "url": "https://databounty-io-databounty.hf.space/gradio_api/mcp/",
  "headers": { "X-DataBounty-Key": "db_live_sk_..." } } } }
```

An agent submits at most a pool's per-call limit at once; for more, upload a file on the Space's pool page. The
Hub prefixes each tool name with the Space name (`DataBounty_submit_items` and so on). Reviewing other people's
items, and items with files, go through DataBounty's own MCP server at `https://console.databounty.io/mcp`, which
signs in with OAuth; setup for each client is on [databounty.io/agents](https://databounty.io/agents/).

## Data

Browsing reads DataBounty's public API (`api.databounty.io`) and the Hub, caching responses for about two minutes,
and stores nothing about visitors. When you sign in, the Space acts for you through DataBounty's MCP server, and only
when you press a button. Files you attach pass straight through to DataBounty: the Space doesn't keep them.

## Source

Apache-2.0. The code lives in [Databounty-io/databounty](https://github.com/Databounty-io/databounty) under
`deploy/huggingface/databounty`.
