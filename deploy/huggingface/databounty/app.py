# SPDX-License-Identifier: Apache-2.0
"""DataBounty on Hugging Face: a read-only window onto DataBounty's community programme.

Every tab renders live public data from databounty.io's API (see databounty.py).
The `gr.api` endpoints at the bottom are this Space's programmatic surface;
launched with `mcp_server=True`, each one is also an MCP tool described by its
docstring. UI handlers are registered with `api_visibility="private"` so they do
not show up as duplicate, UI-shaped tools next to them.
"""

from __future__ import annotations

import html
import os
import re
from pathlib import Path
from typing import Any

import gradio as gr
import pandas as pd

import databounty as db

HERE = Path(__file__).parent
SPACE_HOST = os.environ.get("SPACE_HOST", "databounty-io-databounty.hf.space")
SPACE_MCP_URL = f"https://{SPACE_HOST}/gradio_api/mcp/"
REPO_URL = "https://github.com/Databounty-io/databounty"
LIME = "#b6ff1c"

ANY_DOMAIN = "Any domain"
ANY_DIFFICULTY = "Any difficulty"
ALL_TIERS = "All tiers"

_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{3,8}$")
_MD_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+!|<>])")


def _e(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _md(value: Any) -> str:
    # Pool titles and display names are user-supplied; escape Markdown so they
    # render as text and cannot break a table cell or forge a link.
    return _MD_SPECIAL.sub(r"\\\1", str(value or ""))


def _num(value: Any) -> str:
    return f"{value:,}" if isinstance(value, (int, float)) and not isinstance(value, bool) else "—"


def _color(value: Any) -> str:
    return value if isinstance(value, str) and _HEX_COLOR.match(value) else LIME


def _choice(value: str | None, any_label: str) -> str:
    return "" if not value or value == any_label else value


def _unavailable(exc: Exception) -> str:
    return (
        f'<div class="db-note">{_e(exc)} Try again in a minute, or visit '
        f'<a href="{_e(db.SITE_URL)}" target="_blank" rel="noopener">databounty.io</a>.</div>'
    )


# --- Overview ----------------------------------------------------------------------


def render_overview() -> str:
    try:
        stats = db.stats()
        ladder = db.tiers()
    except db.UpstreamError as exc:
        return _unavailable(exc)
    cards = [
        ("Items accepted", stats.get("acceptedItems")),
        ("Dataset programmes", stats.get("programs")),
        ("Contributors", stats.get("contributors")),
        ("Datasets published", stats.get("publishedDatasets")),
        ("Karma awarded", stats.get("totalKarmaAwarded")),
    ]
    cards_html = "".join(
        f'<div class="db-card"><div class="db-v">{_num(value)}</div><div class="db-k">{_e(label)}</div></div>'
        for label, value in cards
    )
    cleared = stats.get("clearedItems") or 0
    target = stats.get("targetItems") or 0
    pct = min(100.0, 100 * cleared / target) if target else 0.0
    tiers_html = "".join(
        f'<div class="db-tier"><span class="db-dot" style="background:{_color(tier.get("color"))}"></span>'
        f'<b>{_e(tier.get("label"))}</b> <span class="db-k">from {_num(tier.get("minKarma"))} karma</span></div>'
        for tier in ladder
    )
    return f"""
<div class="db-cards">{cards_html}</div>
<div class="db-section">
  <div class="db-k">{_num(cleared)} of {_num(target)} target items have cleared the automated checks, across every programme</div>
  <div class="db-bar"><span style="width:{pct:.1f}%"></span></div>
</div>
<div class="db-section">
  <div class="db-k">Karma tiers: standing is public and permanent</div>
  <div class="db-tiers">{tiers_html}</div>
</div>
"""


HOW_IT_WORKS = f"""
### How DataBounty works

1. **A sponsor requests a dataset.** An operator reviews the request and opens a **pool**: a field contract, a target size, a licence and the karma paid per accepted item.
2. **Contributors submit items** from the dashboard, or through an AI agent connected over MCP.
3. **Automated checks run on every item**: exact and near-duplicate detection, an AI-attribution scan and, where the dataset type has tests, sandboxed execution.
4. **Human validators review the work.** Contributors earn karma only for accepted items; validators earn karma for their audits.
5. **Finished datasets are published to the Hub** under [{db.HF_ORG}](https://huggingface.co/{db.HF_ORG}), with contributor credit in the dataset card and a `manifest.json`.
"""


# --- Open pools ----------------------------------------------------------------------

POOL_COLUMNS = ["Pool", "Dataset type", "Difficulty", "Accepted / target", "Progress", "Karma per item", "Licence"]
POOL_TYPES = ["markdown", "str", "str", "str", "str", "str", "str"]


def render_pools(query: str, domain: str, difficulty: str):
    try:
        pools = db.open_pools(query or "", _choice(domain, ANY_DOMAIN), _choice(difficulty, ANY_DIFFICULTY))
    except db.UpstreamError as exc:
        return pd.DataFrame(columns=POOL_COLUMNS), gr.update(choices=[], value=None), str(exc)
    rows = [
        {
            "Pool": f"[{_md(pool['title'])}]({pool['page_url']})",
            "Dataset type": pool["dataset_type"],
            "Difficulty": pool["difficulty"].capitalize() or "—",
            "Accepted / target": f"{pool['accepted_items']:,} / {pool['target_items']:,}",
            "Progress": f"{pool['progress_pct']:.1f}%" if pool["progress_pct"] is not None else "—",
            "Karma per item": _num(pool["karma_per_accepted_item"]),
            "Licence": pool["license"] or "—",
        }
        for pool in pools
    ]
    count = len(pools)
    summary = (
        f"**{count}** open pool{'' if count == 1 else 's'} match. *Karma per item* is what a contributor "
        "earns for each accepted item. Pick a pool below for its field contract."
        if count
        else "No open pool matches those filters."
    )
    choices = [(pool["title"], pool["id"]) for pool in pools]
    return (
        pd.DataFrame(rows, columns=POOL_COLUMNS),
        gr.update(choices=choices, value=choices[0][1] if choices else None),
        summary,
    )


def render_pool(pool_id: str | None) -> str:
    if not pool_id:
        return ""
    try:
        pool = db.pool_details(pool_id)
    except (ValueError, db.UpstreamError) as exc:
        return str(exc)
    if pool is None:
        return "That pool is no longer listed."
    fields = "\n".join(
        f"| `{_md(field['key'])}` | {_md(field['label'])} | {_md(field['role'])} | {'yes' if field['required'] else 'no'} |"
        for field in pool["fields"]
    )
    people = " · ".join(
        part
        for part in (
            f"{pool['contributors']:,} contributors" if isinstance(pool["contributors"], int) else "",
            f"{pool['validators']:,} validators" if isinstance(pool["validators"], int) else "",
        )
        if part
    )
    audit = f"{pool['audit_coverage_pct']}% of items" if pool["audit_coverage_pct"] is not None else "—"
    return f"""
### [{_md(pool['title'])}]({pool['page_url']})

{_md(pool['description'])}

| | |
|---|---|
| Dataset type | {_md(pool['dataset_type'])} · {_md(pool['trust_tier'].replace('_', ' ')) or '—'} |
| Progress | {pool['accepted_items']:,} accepted of {pool['target_items']:,} · {pool['in_review_items']:,} waiting on human review |
| Karma | {_num(pool['karma_per_accepted_item'])} per accepted item · {_num(pool['validator_karma_per_audited_item'])} per audited item for validators |
| Human audit coverage | {audit} |
| People | {people or '—'} |
| Licence | {_md(pool['license']) or '—'} |

**Field contract**: every item supplies these fields.

| Field | Label | Role | Required |
|---|---|---|---|
{fields}

[**Contribute to this pool →**]({pool['contribute_url']}) &nbsp;·&nbsp; [View it on databounty.io]({pool['page_url']})
"""


# --- Published datasets ------------------------------------------------------------------

DATASET_COLUMNS = ["Dataset", "Items", "Licence", "Published", "Downloads", "Likes", "Also on"]
DATASET_TYPES = ["markdown", "str", "str", "str", "str", "str", "markdown"]


def render_datasets():
    try:
        datasets = db.published_datasets()
    except db.UpstreamError as exc:
        return pd.DataFrame(columns=DATASET_COLUMNS), str(exc)
    rows = [
        {
            "Dataset": f"[{_md(d['title'])}]({d['hugging_face_url']})" if d["hugging_face_url"] else _md(d["title"]),
            "Items": f"{d['items']:,}",
            "Licence": d["license"] or "—",
            "Published": d["published_on"] or "—",
            "Downloads": _num(d["downloads"]),
            "Likes": _num(d["likes"]),
            "Also on": f"[GitHub]({d['github_url']})" if d["github_url"] else "—",
        }
        for d in datasets
    ]
    example = next((d["hugging_face_id"] for d in datasets if d["hugging_face_id"]), None)
    snippet = (
        f"Every dataset ships `data/items.jsonl` plus a `manifest.json` with contributor credit. "
        f"Load one with 🤗 Datasets:\n\n```python\nfrom datasets import load_dataset\n\n"
        f'ds = load_dataset("{example}")\n```'
        if example
        else ""
    )
    return pd.DataFrame(rows, columns=DATASET_COLUMNS), snippet


# --- Leaderboard and profiles --------------------------------------------------------------

BOARD_COLUMNS = ["Rank", "Contributor", "Tier", "Karma", "Accepted items"]
BOARD_TYPES = ["str", "markdown", "str", "str", "str"]


def render_leaderboard(tier: str, query: str):
    try:
        board = db.leaderboard(limit=100, tier=_choice(tier, ALL_TIERS).lower(), query=query or "")
    except db.UpstreamError as exc:
        gr.Warning(str(exc))
        return pd.DataFrame(columns=BOARD_COLUMNS)
    rows = [
        {
            "Rank": str(row["rank"] or "—"),
            "Contributor": f"[{_md(row['display_name'])}]({row['profile_url']}) @{_md(row['handle'])}",
            "Tier": row["tier"] or "—",
            "Karma": _num(row["karma"]),
            "Accepted items": _num(row["accepted_items"]),
        }
        for row in board
    ]
    return pd.DataFrame(rows, columns=BOARD_COLUMNS)


def render_profile(handle: str) -> str:
    if not (handle or "").strip():
        return "Enter a handle to look someone up."
    try:
        handle = db.normalize_handle(handle)
        person = db.contributor(handle)
    except (ValueError, db.UpstreamError) as exc:
        return str(exc)
    if person is None:
        return f"There is no public profile for **@{_md(handle)}**. Members can keep their profile private."
    facts = [
        f"**{_md(person['tier'])}** tier" if person["tier"] else "",
        f"**{person['karma']:,}** karma" if isinstance(person["karma"], int) else "",
        f"**{person['accepted_items']:,}** accepted items" if isinstance(person["accepted_items"], int) else "",
        f"**{person['audits']:,}** audits" if person["audits"] else "",
        f"member since {person['member_since']}" if person["member_since"] else "",
    ]
    parts = [f"## {_md(person['display_name'])} &nbsp;`@{person['handle']}`", " · ".join(f for f in facts if f)]
    if person["badges"]:
        parts.append("**Badges:** " + ", ".join(_md(b) for b in person["badges"]))
    if person["published_credits"]:
        parts.append(
            "**Credited on published datasets**\n\n"
            + "\n".join(f"- [{_md(c['title'])}]({c['hugging_face_url']})" for c in person["published_credits"])
        )
    contributed = sorted(person["datasets_contributed_to"] or [], key=lambda d: d.get("items") or 0, reverse=True)
    if contributed:
        more = f"\n- …and {len(contributed) - 8} more" if len(contributed) > 8 else ""
        parts.append(
            "**Most accepted items in**\n\n"
            + "\n".join(
                f"- {_md(d['title'])}: {_num(d['items'])} item{'' if d['items'] == 1 else 's'}" for d in contributed[:8]
            )
            + more
        )
    parts.append(f"[Full profile on databounty.io →]({person['profile_url']})")
    return "\n\n".join(p for p in parts if p)


def example_handles(limit: int = 3) -> list[str]:
    """Top leaderboard handles that have a public profile, for the examples row."""
    handles: list[str] = []
    try:
        top = db.stats().get("leaderboard") or []
        for row in top:
            handle = row.get("handle")
            if handle and db.contributor(handle):
                handles.append(handle)
            if len(handles) == limit:
                break
    except (ValueError, db.UpstreamError):
        pass
    return handles


# --- Agents ------------------------------------------------------------------------------------

TOOL_COLUMNS = ["Tool", "Scope", "What it does"]

AGENTS_INTRO = f"""
### Connect your agent to DataBounty

DataBounty runs its own MCP server. Agents can browse pools, submit items, run validator audits and track
karma. Sign-in is OAuth, so you never paste a key anywhere.

**Endpoint:** `{db.MCP_URL}` (streamable HTTP)

**Claude Code**: run this, then `/mcp` in the session and choose *authenticate*.

```bash
claude mcp add --transport http databounty {db.MCP_URL}
```

**Cursor**: `~/.cursor/mcp.json`

```json
{{ "mcpServers": {{ "databounty": {{ "url": "{db.MCP_URL}" }} }} }}
```

**VS Code / Copilot**: `.vscode/mcp.json`

```json
{{ "servers": {{ "databounty": {{ "type": "http", "url": "{db.MCP_URL}" }} }} }}
```

ChatGPT, Codex CLI, Gemini CLI and raw JSON-RPC: see [databounty.io/agents]({db.SITE_URL}/agents/).

### This Space is an MCP server too

Read-only and no sign-in, for agents that only need to read the catalogue:

```text
{SPACE_MCP_URL}
```

Tools, each prefixed `DataBounty_` by the Hub: `get_platform_stats`, `search_open_pools`,
`get_pool_details`, `list_published_datasets`, `get_karma_leaderboard`, `get_contributor_profile`.

### DataBounty's MCP tools

*Scope* is the permission a tool needs. **public** tools work without signing in.
"""


def render_tools() -> pd.DataFrame:
    try:
        tools = db.platform_mcp_tools()
    except db.UpstreamError:
        return pd.DataFrame(columns=TOOL_COLUMNS)
    order = {"public": 0, "read": 1, "account": 2, "contribute": 3, "validate": 4, "artifact": 5, "sponsor": 6}
    tools.sort(key=lambda t: (order.get(t["scope"], 9), t["name"]))
    rows = [
        {
            "Tool": tool["name"],
            "Scope": tool["scope"],
            "What it does": tool["description"][:220] + ("…" if len(tool["description"]) > 220 else ""),
        }
        for tool in tools
    ]
    return pd.DataFrame(rows, columns=TOOL_COLUMNS)


# --- API and MCP tools ----------------------------------------------------------------------------


def _upstream(exc: db.UpstreamError) -> gr.Error:
    return gr.Error(str(exc))


def get_platform_stats() -> dict:
    """Get live totals for DataBounty's community dataset programme.

    Returns:
        The number of dataset programmes, target and accepted item counts, items that have
        cleared the automated checks, contributors, published datasets, total karma awarded,
        and the karma tier ladder.
    """
    try:
        stats = db.stats()
        ladder = db.tiers()
    except db.UpstreamError as exc:
        raise _upstream(exc) from exc
    return {
        "dataset_programmes": stats.get("programs"),
        "target_items": stats.get("targetItems"),
        "accepted_items": stats.get("acceptedItems"),
        "items_cleared_automated_checks": stats.get("clearedItems"),
        "contributors": stats.get("contributors"),
        "published_datasets": stats.get("publishedDatasets"),
        "total_karma_awarded": stats.get("totalKarmaAwarded"),
        "karma_tiers": [{"tier": t.get("label"), "min_karma": t.get("minKarma")} for t in ladder],
        "source": db.SITE_URL,
    }


def search_open_pools(query: str = "", domain: str = "", difficulty: str = "", limit: int = 20) -> list[dict]:
    """Search DataBounty's open community pools: datasets currently accepting contributions.

    Args:
        query: Free-text filter on pool title, dataset type, language and description. Leave empty to list all.
        domain: Optional domain filter: coding, legal, healthcare, finance or science.
        difficulty: Optional difficulty filter: beginner, intermediate or advanced.
        limit: Maximum number of pools to return, from 1 to 50.

    Returns:
        Open pools, each with its id, title, dataset type, difficulty, accepted and target item counts,
        karma per accepted item, licence, and links to view the pool or contribute to it.
    """
    domain = (domain or "").strip().lower()
    difficulty = (difficulty or "").strip().lower()
    if domain and domain not in db.DOMAINS:
        raise gr.Error(f"Unknown domain {domain!r}. Use one of: {', '.join(db.DOMAINS)}.")
    if difficulty and difficulty not in db.DIFFICULTIES:
        raise gr.Error(f"Unknown difficulty {difficulty!r}. Use one of: {', '.join(db.DIFFICULTIES)}.")
    try:
        pools = db.open_pools(query or "", domain, difficulty)
    except db.UpstreamError as exc:
        raise _upstream(exc) from exc
    return pools[: max(1, min(int(limit or 20), 50))]


def get_pool_details(pool_id: str) -> dict:
    """Get one DataBounty pool's public details: description, field contract, karma pricing and progress.

    Args:
        pool_id: The pool id, as returned by search_open_pools.

    Returns:
        The pool's description, every field an item must supply, karma per accepted and per audited item,
        audit coverage, progress and links, or an "error" key when no pool has that id.
    """
    try:
        pool = db.pool_details(pool_id)
    except ValueError as exc:
        return {"error": str(exc)}
    except db.UpstreamError as exc:
        raise _upstream(exc) from exc
    return pool if pool is not None else {"error": f"No pool with id {pool_id!r}."}


def list_published_datasets() -> list[dict]:
    """List the datasets DataBounty has published to the Hugging Face Hub, newest first.

    Returns:
        Each dataset's title, item count, licence, publication date, Hugging Face repo id and URL,
        GitHub mirror URL when there is one, and Hub download and like counts.
    """
    try:
        return db.published_datasets()
    except db.UpstreamError as exc:
        raise _upstream(exc) from exc


def get_karma_leaderboard(limit: int = 20, tier: str = "", query: str = "") -> list[dict]:
    """Get DataBounty's all-time karma leaderboard.

    Args:
        limit: Number of contributors to return, from 1 to 100.
        tier: Optional tier filter: dharma, bodhi, moksha or nirvana.
        query: Optional search on handle or display name.

    Returns:
        Ranked contributors with handle, display name, karma, accepted item count, tier and public profile URL.
    """
    tier = (tier or "").strip().lower()
    if tier and tier not in db.TIERS:
        raise gr.Error(f"Unknown tier {tier!r}. Use one of: {', '.join(db.TIERS)}.")
    try:
        return db.leaderboard(limit=limit, tier=tier, query=query or "")
    except db.UpstreamError as exc:
        raise _upstream(exc) from exc


def get_contributor_profile(handle: str) -> dict:
    """Get a DataBounty contributor's public profile.

    Only public profiles are returned, and only the fields the member chose to show.

    Args:
        handle: The contributor's public handle, for example "starlord". A leading @ or a databounty.io profile URL also works.

    Returns:
        Display name, tier, karma, badges, accepted items, audits, datasets contributed to and Hugging Face
        datasets they are credited on, or an "error" key when there is no public profile.
    """
    try:
        person = db.contributor(handle)
    except ValueError as exc:
        return {"error": str(exc)}
    except db.UpstreamError as exc:
        raise _upstream(exc) from exc
    return person if person is not None else {"error": "No public profile with that handle."}


# --- Layout ----------------------------------------------------------------------------------------

LOGO_SVG = (HERE / "assets" / "logo.svg").read_text(encoding="utf-8")

HEADER = f"""
<div class="db-header">
  <div class="db-logo" aria-hidden="true">{LOGO_SVG}</div>
  <div>
    <h1>DataBounty</h1>
    <p>Open datasets built by the community, checked by people and credited with karma.
       Live from <a href="{_e(db.SITE_URL)}" target="_blank" rel="noopener">databounty.io</a>.</p>
  </div>
</div>
<div class="db-cta">
  <a class="db-btn db-btn-primary" href="{_e(db.APP_URL)}/contributor/" target="_blank" rel="noopener">Start contributing →</a>
  <a class="db-btn" href="{_e(db.APP_URL)}/sponsor/create/" target="_blank" rel="noopener">Request a dataset</a>
  <a class="db-btn" href="https://huggingface.co/{_e(db.HF_ORG)}" target="_blank" rel="noopener">Datasets on the Hub</a>
  <a class="db-btn" href="{REPO_URL}" target="_blank" rel="noopener">Source (Apache-2.0)</a>
</div>
"""

FOOTER = (
    f"Read-only: this Space reads DataBounty's public API and stores nothing about visitors. "
    f"Figures refresh every {int(db.CACHE_TTL_SECONDS // 60) or 1} minutes or so. "
    f"Contributing, validating and requesting datasets happen on [databounty.io]({db.SITE_URL})."
)

CSS = f"""
#col-container {{ max-width: 1120px; margin: 0 auto; }}
.dark .gradio-container {{ color: var(--body-text-color); }}
.db-header {{ display: flex; gap: 16px; align-items: center; margin: 10px 0 4px; }}
.db-logo svg {{ width: 56px; height: 56px; display: block; }}
.db-header h1 {{ margin: 0; font-size: 1.9rem; line-height: 1.15; }}
.db-header p {{ margin: 4px 0 0; color: var(--body-text-color-subdued); }}
.db-cta {{ display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 6px; }}
.db-btn {{ padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border-color-primary);
  text-decoration: none !important; color: var(--body-text-color) !important; font-weight: 600; font-size: .9rem; }}
.db-btn-primary {{ background: {LIME}; border-color: {LIME}; color: #0b0b0b !important; }}
.db-cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }}
.db-card {{ border: 1px solid var(--border-color-primary); border-radius: 12px; padding: 14px 16px;
  background: var(--block-background-fill); }}
.db-v {{ font-size: 1.7rem; font-weight: 700; line-height: 1.2; }}
.db-k {{ color: var(--body-text-color-subdued); font-size: .85rem; }}
.db-section {{ margin-top: 18px; }}
.db-bar {{ height: 10px; border-radius: 6px; background: var(--border-color-primary); overflow: hidden; margin-top: 6px; }}
.db-bar > span {{ display: block; height: 100%; background: {LIME}; }}
.db-tiers {{ display: flex; flex-wrap: wrap; gap: 10px 22px; margin-top: 8px; }}
.db-dot {{ display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }}
.db-note {{ padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border-color-primary); }}
"""

THEME = gr.themes.Citrus(
    primary_hue=gr.themes.colors.lime,
    font=[gr.themes.GoogleFont("Hanken Grotesk"), "ui-sans-serif", "system-ui", "sans-serif"],
    font_mono=[gr.themes.GoogleFont("JetBrains Mono"), "ui-monospace", "monospace"],
)

with gr.Blocks(title="DataBounty") as demo:
    with gr.Column(elem_id="col-container"):
        gr.HTML(HEADER)

        with gr.Tabs():
            with gr.Tab("Overview", id="overview"):
                overview = gr.HTML('<div class="db-k">Loading live totals…</div>')
                gr.Markdown(HOW_IT_WORKS)

            with gr.Tab("Open pools", id="pools"):
                with gr.Row(equal_height=True):
                    pool_query = gr.Textbox(
                        placeholder="Search pools: try sql, cache or git",
                        show_label=False,
                        container=False,
                        scale=4,
                    )
                    pool_domain = gr.Dropdown(
                        [ANY_DOMAIN, *db.DOMAINS], value=ANY_DOMAIN, show_label=False, container=False, scale=1
                    )
                    pool_difficulty = gr.Dropdown(
                        [ANY_DIFFICULTY, *db.DIFFICULTIES], value=ANY_DIFFICULTY, show_label=False, container=False, scale=1
                    )
                    pool_search = gr.Button("Search", variant="primary", scale=1)
                pools_summary = gr.Markdown()
                pools_table = gr.Dataframe(
                    headers=POOL_COLUMNS,
                    datatype=POOL_TYPES,
                    interactive=False,
                    wrap=True,
                    max_height=460,
                    show_label=False,
                )
                pool_pick = gr.Dropdown(label="Pool details", choices=[], interactive=True)
                pool_detail = gr.Markdown()

            with gr.Tab("Published datasets", id="datasets"):
                datasets_table = gr.Dataframe(
                    headers=DATASET_COLUMNS,
                    datatype=DATASET_TYPES,
                    interactive=False,
                    wrap=True,
                    show_label=False,
                )
                datasets_snippet = gr.Markdown()

            with gr.Tab("Leaderboard", id="leaderboard"):
                with gr.Row(equal_height=True):
                    board_query = gr.Textbox(
                        placeholder="Search by handle or name", show_label=False, container=False, scale=4
                    )
                    board_tier = gr.Dropdown(
                        [ALL_TIERS, *(t.capitalize() for t in db.TIERS)],
                        value=ALL_TIERS,
                        show_label=False,
                        container=False,
                        scale=1,
                    )
                board_table = gr.Dataframe(
                    headers=BOARD_COLUMNS,
                    datatype=BOARD_TYPES,
                    interactive=False,
                    wrap=True,
                    max_height=560,
                    show_label=False,
                )

            with gr.Tab("Contributor profile", id="profile"):
                with gr.Row(equal_height=True):
                    profile_handle = gr.Textbox(
                        placeholder="A handle such as starlord, or a databounty.io profile URL",
                        show_label=False,
                        container=False,
                        scale=4,
                    )
                    profile_go = gr.Button("Look up", variant="primary", scale=1)
                profile_card = gr.Markdown()
                handles = example_handles()
                if handles:
                    # Not cached: a profile is live data, and a cached example
                    # would keep showing yesterday's karma forever.
                    gr.Examples(
                        examples=[[h] for h in handles],
                        inputs=[profile_handle],
                        outputs=[profile_card],
                        fn=render_profile,
                        cache_examples=False,
                        run_on_click=True,
                        label="Try a top contributor",
                    )

            with gr.Tab("For agents (MCP)", id="agents"):
                gr.Markdown(AGENTS_INTRO)
                tools_table = gr.Dataframe(
                    headers=TOOL_COLUMNS,
                    datatype=["str", "str", "str"],
                    interactive=False,
                    wrap=True,
                    max_height=520,
                    show_label=False,
                )

        gr.Markdown(FOOTER, elem_classes=["db-k"])

    pool_inputs = [pool_query, pool_domain, pool_difficulty]
    pool_outputs = [pools_table, pool_pick, pools_summary]
    for trigger in (pool_search.click, pool_query.submit, pool_domain.change, pool_difficulty.change):
        trigger(render_pools, pool_inputs, pool_outputs, api_visibility="private")
    pool_pick.change(render_pool, pool_pick, pool_detail, api_visibility="private")

    board_inputs = [board_tier, board_query]
    for trigger in (board_tier.change, board_query.submit):
        trigger(render_leaderboard, board_inputs, board_table, api_visibility="private")

    for trigger in (profile_go.click, profile_handle.submit):
        trigger(render_profile, profile_handle, profile_card, api_visibility="private")

    demo.load(render_overview, None, overview, api_visibility="private")
    demo.load(render_pools, pool_inputs, pool_outputs, api_visibility="private")
    demo.load(render_datasets, None, [datasets_table, datasets_snippet], api_visibility="private")
    demo.load(render_leaderboard, board_inputs, board_table, api_visibility="private")
    demo.load(render_tools, None, tools_table, api_visibility="private")

    gr.api(get_platform_stats, api_name="get_platform_stats")
    gr.api(search_open_pools, api_name="search_open_pools")
    gr.api(get_pool_details, api_name="get_pool_details")
    gr.api(list_published_datasets, api_name="list_published_datasets")
    gr.api(get_karma_leaderboard, api_name="get_karma_leaderboard")
    gr.api(get_contributor_profile, api_name="get_contributor_profile")

# Every handler is network-bound and mostly answered from cache, so let several
# visitors through at once instead of Gradio's default of one per event.
demo.queue(default_concurrency_limit=8)

if __name__ == "__main__":
    demo.launch(theme=THEME, css=CSS, mcp_server=True, favicon_path=str(HERE / "assets" / "logo.svg"))
