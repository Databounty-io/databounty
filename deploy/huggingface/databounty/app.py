# SPDX-License-Identifier: Apache-2.0
"""DataBounty on Hugging Face: DataBounty's community programme, and a place to contribute to it.

The page people see is web/ (index.html, app.css, app.js): a small web app drawn like the
DataBounty console, talking to webapi.py. Public data comes from databounty.io's API (see
databounty.py); signing in and contributing go through account.py and contribute.py.

Gradio is mounted underneath for one job: the `gr.api` endpoints at the bottom are this Space's
programmatic surface, and with `mcp_server=True` each is also an MCP tool described by its
docstring (served under /gradio_api/mcp/). Six browse DataBounty and need nothing. Five contribute,
as the owner of the DataBounty API key the agent's MCP client sends in the X-DataBounty-Key header
(agent_tools.py); the key is read with `gr.Header`, so it is never a tool argument the model sees.
"""

from __future__ import annotations

import html
import json
import os
import threading
from pathlib import Path
from typing import Any

import gradio as gr
import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

import account
import agent_tools
import databounty as db
import webapi

HERE = Path(__file__).parent
WEB = HERE / "web"


def _e(value: Any) -> str:
    return html.escape(str(value), quote=True)


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
        The pool's description, every field an item must supply, up to three approved example items,
        karma per accepted and per audited item, audit coverage, progress and links, or an "error" key
        when no pool has that id.
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


# --- Contributing through MCP, as the owner of a DataBounty API key ------------------------------


def _as_agent(call) -> str:
    """The result as JSON text. Gradio would otherwise send an unqueued tool's dict as Python's repr."""
    try:
        return json.dumps(call(), indent=2, ensure_ascii=False)
    except agent_tools.AgentError as exc:
        raise gr.Error(str(exc)) from exc


def get_my_account(x_databounty_key: gr.Header) -> str:
    """Check this server's DataBounty connection: whose API key it uses, and whether that account can submit.

    The contribute tools (this one, get_pool_contract, submit_items, list_my_submissions and check_submission)
    act as the owner of a DataBounty API key, which the MCP client sends as the X-DataBounty-Key header. Create
    one at console.databounty.io/developers with the contribute scope and add it to this server's settings.
    Never ask for the key in a message or pass it as an argument.

    Returns:
        The account's handle, display name and karma, whether it is ready to submit, and what to do next.
    """
    return _as_agent(lambda: agent_tools.my_account(x_databounty_key))


def get_pool_contract(pool_id: str, x_databounty_key: gr.Header) -> str:
    """Read exactly what a pool's items must contain, before submitting to it. Needs the X-DataBounty-Key header.

    Args:
        pool_id: The pool id, as returned by search_open_pools.

    Returns:
        Each field (its key, whether it is required, its kind, help and allowed options), how many items one
        submit_items call may carry, the karma per accepted item, an approved example item when there is one,
        and the checks every item goes through.
    """
    return _as_agent(lambda: agent_tools.pool_contract(pool_id, x_databounty_key))


def submit_items(pool_id: str, items: list[dict], generation_method: str, x_databounty_key: gr.Header) -> str:
    """Submit items to an open DataBounty pool, as the owner of this server's API key (X-DataBounty-Key header).

    Read the pool with get_pool_contract first and check every item against its fields and difficulty. Each
    item is an object mapping the pool's field keys to values. Items are checked here before anything is sent:
    if any would be refused, nothing is sent and the reasons come back, so fix them and send the set again.
    Say honestly how the items were made; DataBounty accepts AI help when it is declared. After submitting,
    each item is checked automatically and then reviewed by a person.

    Args:
        items: The items, each an object of the pool's field values. At most the pool's max_items_per_call.
        pool_id: The pool id, as returned by search_open_pools.
        generation_method: How the items were made: human, ai_assisted or ai_generated.

    Returns:
        How many items were sent, each submission's id and status, how many duplicated items already in the
        pool, and whether the pool filled up.
    """
    return _as_agent(lambda: agent_tools.submit_items(pool_id, items, generation_method, x_databounty_key))


def list_my_submissions(status: str = "", pool_id: str = "", x_databounty_key: gr.Header = None) -> str:
    """List the submissions of this server's API key owner, newest first. Needs the X-DataBounty-Key header.

    Args:
        status: Optional status to filter by, e.g. needs_fixes, in_audit, accepted or rejected.
        pool_id: Optional pool id, to list only that pool's submissions.

    Returns:
        The total, and each submission's id, title, pool, status, where it stands in plain words, and date.
    """
    return _as_agent(lambda: agent_tools.my_submissions(x_databounty_key, status or "", pool_id or ""))


def check_submission(submission_id: str, x_databounty_key: gr.Header) -> str:
    """Read where one submission stands: its status and each check with its reason. Needs the X-DataBounty-Key header.

    Read it to act on the result, not in a loop: checks take minutes and reviews take longer.

    Args:
        submission_id: The submission id, as returned by submit_items or list_my_submissions.

    Returns:
        The submission's status in plain words, each check and its result, any reviewer notes, and where to
        fix it when it came back.
    """
    return _as_agent(lambda: agent_tools.submission_status(submission_id, x_databounty_key))


def get_pool_items_as_sponsor(pool_id: str, status: str = "", search: str = "", x_databounty_key: gr.Header = None) -> str:
    """See the items submitted to a pool you requested, as its sponsor. Needs the X-DataBounty-Key header (sponsor scope).

    Only the account that requested the pool can read its items.

    Args:
        pool_id: The id of a pool this account requested.
        status: Optional status to filter by, e.g. accepted, in_audit or rejected.
        search: Optional text to look for in item titles.

    Returns:
        Each item's id, title, status, contributor, how it was made, its fields and checks, any flags, and for an
        accepted item whether it can still be disputed and until when.
    """
    return _as_agent(lambda: agent_tools.sponsor_items(pool_id, x_databounty_key, status or "", search or ""))


def dispute_accepted_item(submission_id: str, reason: str, argument: str, x_databounty_key: gr.Header = None) -> str:
    """Dispute an accepted item in a pool you requested, while its dispute window is open. Needs the X-DataBounty-Key header (sponsor scope).

    An admin decides the dispute; the contributor's karma is only reversed if it is upheld. Dispute only with a
    specific, real reason.

    Args:
        submission_id: The item's id, from get_pool_items_as_sponsor.
        reason: Why: duplicate, contaminated, tests_invalid, solution_incorrect, too_trivial, low_quality, off_spec or other.
        argument: What is wrong with the item, in 10 to 2000 characters.

    Returns:
        Whether the dispute was filed, and what happens next.
    """
    return _as_agent(lambda: agent_tools.dispute_item(submission_id, reason, argument, x_databounty_key))


with gr.Blocks(title="DataBounty") as demo:
    gr.Markdown("DataBounty's MCP tools. The Space itself is at [/](/).")
    gr.api(get_platform_stats, api_name="get_platform_stats")
    gr.api(search_open_pools, api_name="search_open_pools")
    gr.api(get_pool_details, api_name="get_pool_details")
    gr.api(list_published_datasets, api_name="list_published_datasets")
    gr.api(get_karma_leaderboard, api_name="get_karma_leaderboard")
    gr.api(get_contributor_profile, api_name="get_contributor_profile")
    # Not queued, so Gradio calls them in the MCP request itself: the key header never makes the
    # queue's loopback trip out through Hugging Face and back. The header parameter must come last in
    # each signature: Gradio puts its value at that position, overwriting an argument that sits there.
    for tool in (
        get_my_account,
        get_pool_contract,
        submit_items,
        list_my_submissions,
        check_submission,
        get_pool_items_as_sponsor,
        dispute_accepted_item,
    ):
        gr.api(tool, api_name=tool.__name__, queue=False)

# Every handler is network-bound and mostly answered from cache, so let several
# visitors through at once instead of Gradio's default of one per event.
demo.queue(default_concurrency_limit=8)

# --- The page, its API and sign-in ------------------------------------------------------------------
# All registered before Gradio's mount at "/", so they answer first.

server = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class _CompressPage:
    """Compress the page, its files and its JSON API: app.js is about a quarter of its size
    gzipped, which matters for visitors far from Hugging Face's servers. Gradio's own routes, the
    MCP server among them, pass through untouched."""

    def __init__(self, app):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1024)

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "") if scope["type"] == "http" else ""
        page = path == "/" or path.startswith(("/static/", "/api/"))
        await (self.gzip if page else self.app)(scope, receive, send)


server.add_middleware(_CompressPage)
NO_STORE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
server.include_router(webapi.router)
server.add_exception_handler(webapi.ApiError, webapi.api_error)


@server.get("/", include_in_schema=False)
def index() -> FileResponse:
    # Always fresh, so a redeploy shows at once; the assets it loads carry a version.
    return FileResponse(WEB / "index.html", media_type="text/html", headers={"Cache-Control": "no-cache"})


class _Assets(StaticFiles):
    """The page's files. index.html names app.css and app.js with a `?v=` version that changes with
    them, so a versioned URL never changes and browsers may keep it; anything else, for an hour."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            versioned = b"v=" in (scope.get("query_string") or b"")
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if versioned else "public, max-age=3600"
        return response


server.mount("/static", _Assets(directory=WEB), name="static")

SIGN_IN_PAGE_STYLE = (
    "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f4f0;color:#14170f;"
    "font-family:Geist,ui-sans-serif,system-ui,sans-serif}"
    ".card{width:min(380px,calc(100vw - 32px));box-sizing:border-box;padding:32px;background:#fff;border:1px solid #e4e6df;"
    "border-radius:14px;text-align:center}"
    ".logo{width:38px;height:38px;margin:0 auto 14px;display:block}"
    "h1{margin:0 0 8px;font:600 18px/1.3 'Geist Mono',ui-monospace,monospace}"
    "p{margin:0 0 18px;color:#6b7360;font-size:14px;line-height:1.55}"
    "button,a.btn{display:inline-block;width:100%;box-sizing:border-box;padding:11px 14px;border:0;border-radius:8px;"
    "background:#14170f;color:#a3f60a;font:500 13px 'Geist Mono',ui-monospace,monospace;cursor:pointer;text-decoration:none}"
)


def _sign_in_page(message: str, status: int, *, popup: bool = False, title: str = "Sign-in didn't finish", close: bool = False) -> HTMLResponse:
    action = (
        '<button onclick="window.close()">close this window</button>'
        if popup
        else '<a class="btn" href="/">back to the Space</a>'
    )
    body = (
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{_e(title)}</title>"
        '<link rel="preconnect" href="https://fonts.googleapis.com">'
        '<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500;600&display=swap" rel="stylesheet">'
        f"<style>{SIGN_IN_PAGE_STYLE}</style>"
        '<div class="card"><img class="logo" src="/static/logo.svg" alt="">'
        f"<h1>{_e(title)}</h1><p>{_e(message)}</p>{action}</div>"
        + ("<script>setTimeout(() => window.close(), 800)</script>" if close else "")
    )
    return HTMLResponse(body, status_code=status, headers=NO_STORE)


@server.get("/oauth/client-metadata.json")
def oauth_client_metadata() -> JSONResponse:
    # DataBounty reads this to learn the Space's name and where it may send people back to.
    return JSONResponse(account.client_metadata(), headers={"Cache-Control": "public, max-age=300"})


@server.get("/oauth/start")
def oauth_start(request: Request, n: str = "", popup: str = ""):
    in_window = popup == "1"
    # Only a sign-in the Space's own page started: a link from anywhere else could otherwise
    # sign someone in for the sender to collect (see account.py).
    if not account.valid_nonce_hash(n) or request.headers.get("sec-fetch-site") != "same-origin":
        return _sign_in_page("Start signing in from the Space.", 400, popup=in_window)
    try:
        url, login_cookie = account.begin_sign_in(n, in_window)
    except (account.SignInError, httpx.HTTPError, ValueError):
        return _sign_in_page("DataBounty's sign-in service didn't answer. Try again in a minute.", 503, popup=in_window)
    response = RedirectResponse(url, status_code=302, headers=NO_STORE)
    response.set_cookie(
        account.LOGIN_COOKIE,
        login_cookie,
        max_age=account.LOGIN_TTL_SECONDS,
        path="/oauth",
        httponly=True,
        secure=account.COOKIE_SECURE,
        samesite="lax",
    )
    return response


@server.get("/oauth/callback")
def oauth_callback(request: Request):
    login_cookie = request.cookies.get(account.LOGIN_COOKIE)
    context = account.login_context(login_cookie)
    in_window = context["p"]
    try:
        session_id = account.complete_sign_in(dict(request.query_params), login_cookie)
        if not account.valid_nonce_hash(context["n"]):
            raise account.SignInError("Start signing in from the Space.")
    except account.SignInError as exc:
        response = _sign_in_page(str(exc), 400, popup=in_window)
    except (httpx.HTTPError, ValueError):
        response = _sign_in_page("DataBounty's sign-in service didn't answer. Start again from the Space.", 503, popup=in_window)
    else:
        # The page that started this claims the session with its secret (account.claim_sign_in).
        account.hold_sign_in(context["n"], session_id)
        if in_window:
            response = _sign_in_page(
                "You can close this window. The Space updates by itself.", 200, popup=True, title="You're signed in", close=True
            )
        else:
            response = RedirectResponse("/", status_code=302, headers=NO_STORE)
    response.delete_cookie(account.LOGIN_COOKIE, path="/oauth")
    return response


@server.get("/oauth/status")
def oauth_status(n: str = "") -> JSONResponse:
    # Only "has this sign-in finished": claiming it needs the secret the hash came from.
    return JSONResponse({"ready": account.sign_in_ready(n)}, headers=NO_STORE)


app = gr.mount_gradio_app(
    server,
    demo,
    path="/",
    mcp_server=True,
    favicon_path=str(WEB / "logo.svg"),
    # Spaces set GRADIO_SSR_MODE, and in SSR mode Gradio starts a Node server on
    # the Space's one public port, which uvicorn below must own.
    ssr_mode=False,
)

if __name__ == "__main__":
    # Fill the public-data cache while the server starts, so the first visitor doesn't wait.
    threading.Thread(target=db.warm, name="databounty-warm", daemon=True).start()
    uvicorn.run(
        app,
        host=os.environ.get("GRADIO_SERVER_NAME", "0.0.0.0"),
        port=int(os.environ.get("GRADIO_SERVER_PORT", "7860")),
        # Spaces sit behind Hugging Face's proxy; trust its forwarded scheme and host.
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
