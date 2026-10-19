---
title: DataBounty
emoji: 🧭
colorFrom: green
colorTo: blue
sdk: gradio
sdk_version: 6.30.0
python_version: "3.12"
app_file: app.py
short_description: Live pools, published datasets, karma and MCP tools
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

A live, read-only window onto [DataBounty](https://databounty.io), the open-source, karma-based platform where the
community builds datasets. Sponsors request a dataset, contributors submit items, automated checks validate each
submission and human validators review the results. Finished datasets are published here on the Hub under
[databounty-io](https://huggingface.co/databounty-io), with contributor credit.

## What's inside

- **Overview**: live programme totals and the karma tier ladder.
- **Open pools**: every dataset currently accepting contributions, with its field contract and the karma paid per accepted item.
- **Published datasets**: DataBounty releases on the Hub, with download counts.
- **Leaderboard** and **Contributor profile**: public karma standings. Private profiles, and any field a member hides, are never shown.
- **For agents (MCP)**: connect Claude, Cursor, VS Code or ChatGPT to DataBounty's own MCP server.

## Use it from an agent

This Space is also a read-only MCP server that needs no sign-in:

```text
https://databounty-io-databounty.hf.space/gradio_api/mcp/
```

The Hub prefixes each tool name with the Space name, so the tools are `DataBounty_get_platform_stats`,
`DataBounty_search_open_pools`, `DataBounty_get_pool_details`, `DataBounty_list_published_datasets`,
`DataBounty_get_karma_leaderboard` and `DataBounty_get_contributor_profile`.

To contribute or validate through an agent, use DataBounty's own MCP server at `https://console.databounty.io/mcp`.
It signs in with OAuth; setup for each client is on [databounty.io/agents](https://databounty.io/agents/).

## Data

The Space reads DataBounty's public API (`api.databounty.io`) and the Hub, caching responses for about two minutes.
It stores nothing about visitors.

## Source

Apache-2.0. The code lives in [Databounty-io/databounty](https://github.com/Databounty-io/databounty) under
`deploy/huggingface/databounty`.
