# SPDX-License-Identifier: Apache-2.0
"""Contributing through this Space's MCP server, as the owner of a DataBounty API key.

The key comes from the agent's MCP client settings, sent as the X-DataBounty-Key header (app.py
reads it with gr.Header), never from a tool argument, so the model never sees it. The Space uses it
for one call to DataBounty's MCP server at a time and keeps nothing. DataBounty checks the key, its
scopes and its owner on every call, so an agent can do exactly what the key allows, as its owner.

Plain data in, plain data out, like contribute.py: app.py wraps these as MCP tools.
"""

from __future__ import annotations

from typing import Any

import account
import contribute
import databounty as db
import items as checks
import sponsor

KEY_HEADER = "X-DataBounty-Key"
KEYS_URL = f"{db.APP_URL}/developers/"


class AgentError(Exception):
    """Why a tool call can't go ahead, written for the agent to relay or act on."""


def _key(raw: str | None) -> str:
    key = (raw or "").strip()
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    if not key:
        raise AgentError(
            f"No DataBounty API key was sent. Create one at {KEYS_URL} (with the contribute scope) and add it to "
            f"this MCP server's settings as the {KEY_HEADER} header. Never put it in a message."
        )
    if not key.startswith(account.API_KEY_PREFIX):
        raise AgentError(f"The {KEY_HEADER} header must hold a DataBounty API key, which starts with {account.API_KEY_PREFIX}.")
    return key


def _call(key: str, name: str, arguments: dict[str, Any] | None = None) -> Any:
    try:
        return account.call_tool_with_key(key, name, arguments)
    except account.NotSignedIn as exc:
        raise AgentError(
            f"DataBounty didn't accept that API key: it may be mistyped, revoked or expired. Create a new one at {KEYS_URL}."
        ) from exc
    except account.ToolError as exc:
        raise AgentError(str(exc)) from exc


def _contract(key: str, pool_id: str) -> dict[str, Any]:
    pool_id = (pool_id or "").strip()
    if not pool_id:
        raise AgentError("Say which pool: pass its id from search_open_pools.")
    return contribute.contract_view(_call(key, "get_pool_contract", {"bountyId": pool_id}), pool_id)


def my_account(raw_key: str | None) -> dict[str, Any]:
    """Who the key belongs to, and whether the account can submit yet."""
    who = _call(_key(raw_key), "whoami") or {}
    ready = bool(who.get("emailVerified")) and bool(who.get("handle")) and bool(who.get("onboarded"))
    next_step = (
        "Verify the account's email address (the link DataBounty sent), then try again."
        if not who.get("emailVerified")
        else f"Finish setting up the account (choose a username) at {db.APP_URL}, then try again."
        if not (who.get("handle") and who.get("onboarded"))
        else "Ready. Pick a pool with search_open_pools, read it with get_pool_contract, then submit_items."
    )
    return {
        "handle": who.get("handle"),
        "display_name": who.get("displayName"),
        "karma": who.get("karmaTotal"),
        "ready_to_submit": ready,
        "next_step": next_step,
    }


def pool_contract(pool_id: str, raw_key: str | None) -> dict[str, Any]:
    """What a pool's items must contain, in the shape submit_items takes."""
    c = _contract(_key(raw_key), pool_id)
    return {
        "pool_id": c["id"],
        "title": c["title"],
        "dataset_type": c["typeName"],
        "open": c["open"],
        "karma_per_accepted_item": c["karma"],
        "items_still_wanted": c["remaining"],
        "max_items_per_call": c["maxItems"],
        "difficulty": c["difficulty"],
        "difficulty_tip": c["tip"],
        "license": c["license"],
        "fields": [
            {
                "key": f["key"],
                "label": f["label"],
                "required": f["required"],
                "kind": f["kind"],
                "help": f["help"] or f["hint"],
                **({"options": f["options"]} if f["options"] else {}),
            }
            for f in c["fields"]
        ],
        "example_item": c["samples"][0] if c["samples"] else None,
        "checks": [f"{step['label']}: {step['what']}" for step in c["pipeline"]],
    }


def submit_items(pool_id: str, items: list[Any], generation_method: str, raw_key: str | None) -> dict[str, Any]:
    """Check items against the pool's fields, then submit them in one call. Nothing is sent when
    any item would be refused, so the agent fixes and resends the whole set."""
    key = _key(raw_key)
    method = (generation_method or "").strip()
    if method not in contribute.GENERATION_METHODS:
        raise AgentError(
            "generation_method must say honestly how the items were made: human, ai_assisted or ai_generated."
        )
    if not isinstance(items, list) or not items:
        raise AgentError("Send at least one item: an object of the pool's field values.")
    c = _contract(key, pool_id)
    if not c["open"]:
        raise AgentError(f"This pool isn't taking items right now. {c['nextStep']}".strip())
    if len(items) > c["maxItems"]:
        raise AgentError(
            f"This pool takes at most {c['maxItems']} items per call, and you sent {len(items)}. Send them in smaller "
            f"sets, or upload a file on the Space's pool page, where the contributor reviews the rows first."
        )
    if any(f["kind"] == "file" and f["required"] for f in c["fields"]):
        raise AgentError(
            "This pool needs a file with each item, which this server can't upload. Use DataBounty's own MCP "
            f"server ({db.MCP_URL}) or the Space's pool page."
        )

    problems: list[str] = []
    ready: list[dict[str, Any]] = []
    for number, item in enumerate(items, 1):
        if not isinstance(item, dict):
            problems.append(f"item {number}: must be an object of the pool's field values")
            continue
        payload = checks.coerce_for_contract(c["fields"], item)
        found = checks.item_problems(c["fields"], payload)
        if found:
            problems.append(f"item {number}: {'; '.join(found)}")
            continue
        title = contribute.title_for(payload, number)
        ready.append({"title": title if len(title) >= 3 else f"{title} item".strip(), "payloadJson": payload, "generationMethod": method})
    if problems:
        raise AgentError("Nothing was sent. Fix these items and send the set again: " + " | ".join(problems))

    result = _call(key, "submit_pool_items", {"bountyId": c["id"], "items": ready}) or {}
    created = result.get("submissions") or []
    duplicates = sum(1 for s in created if s.get("status") == "rejected" and s.get("duplicateOfSubmissionId"))
    return {
        "sent": len(created),
        "duplicates": duplicates,
        "submissions": [{"id": s.get("id"), "status": s.get("status")} for s in created],
        "pool_filled_up": bool(result.get("stoppedAtCapacity")),
        "next_step": "Each item is now checked automatically, then reviewed by a person. Follow one with check_submission.",
    }


def my_submissions(raw_key: str | None, status: str = "", pool_id: str = "") -> dict[str, Any]:
    """The key owner's submissions, newest first."""
    arguments: dict[str, Any] = {"limit": 50}
    if status.strip():
        arguments["status"] = status.strip()
    if pool_id.strip():
        arguments["bountyId"] = pool_id.strip()
    data = _call(_key(raw_key), "list_my_submissions", arguments) or {}
    rows = [contribute.submission_row(item) for item in data.get("items") or []]
    return {
        "total": data.get("total") if isinstance(data.get("total"), int) else len(rows),
        "submissions": [
            {"id": r["id"], "title": r["title"], "pool": r["pool"], "status": r["status"], "where_it_stands": r["statusLabel"], "submitted": r["date"]}
            for r in rows
        ],
    }


def submission_status(submission_id: str, raw_key: str | None) -> dict[str, Any]:
    """One submission: where it stands and each check, in plain words."""
    submission_id = (submission_id or "").strip()
    if not submission_id:
        raise AgentError("Say which submission: pass its id from submit_items or list_my_submissions.")
    view = contribute.submission_view(_call(_key(raw_key), "check_submission", {"submissionId": submission_id}), db.APP_URL)
    return {
        "id": view["id"],
        "title": view["title"],
        "pool": view["pool"],
        "status": view["status"],
        "where_it_stands": view["statusLabel"],
        "checks": [{"check": ch["label"], "result": ch["state"], **({"reason": ch["reason"]} if ch["reason"] else {})} for ch in view["checks"]],
        "reviewer_notes": view["notes"],
        **({"fix_it_at": view["fixUrl"]} if view["fixUrl"] else {}),
    }


def sponsor_items(pool_id: str, raw_key: str | None, status: str = "", search: str = "") -> dict[str, Any]:
    """The items in a pool the key's owner requested, with each one's checks. Needs the sponsor scope."""
    pool_id = (pool_id or "").strip()
    if not pool_id:
        raise AgentError("Say which pool: pass the id of a pool this account requested.")
    arguments: dict[str, Any] = {"bountyId": pool_id, "limit": 50}
    if status.strip():
        arguments["status"] = status.strip()
    if search.strip():
        arguments["search"] = search.strip()[:120]
    data = _call(_key(raw_key), "get_sponsor_submission_evidence", arguments) or {}
    try:
        specs = (db.pool_details(pool_id) or {}).get("fields") or []
    except (ValueError, db.UpstreamError):
        specs = []
    view = sponsor.pool_view(data, specs)
    return {
        "total": view["total"],
        "items": [
            {
                "id": item["id"],
                "title": item["title"],
                "status": item["status"],
                "where_it_stands": item["statusLabel"],
                "contributor": item["handle"] or item["contributor"],
                "submitted": item["date"],
                "how_it_was_made": item["method"],
                "fields": {f["key"]: f["value"] for f in item["fields"]},
                "checks": [{"check": c["label"], "result": c["state"], **({"reason": c["reason"]} if c["reason"] else {})} for c in item["checks"]],
                **({"flags": item["flags"]} if item["flags"] else {}),
                **({"dispute_until": item["disputeUntil"], "can_dispute": item["canDispute"]} if item["status"] == "accepted" else {}),
            }
            for item in view["items"]
        ],
        "more": view["more"],
    }


def dispute_item(submission_id: str, reason: str, argument: str, raw_key: str | None) -> dict[str, Any]:
    """Dispute an accepted item in a pool the key's owner requested. An admin decides it."""
    submission_id = (submission_id or "").strip()
    if not submission_id:
        raise AgentError("Say which item: pass its id from get_pool_items_as_sponsor.")
    arguments, problem = sponsor.dispute({"reason": reason, "argument": argument})
    if problem:
        raise AgentError(problem)
    _call(_key(raw_key), "dispute_accepted_submission", {"submissionId": submission_id, **arguments})
    return {"disputed": True, "next_step": "An admin decides the dispute. The contributor's karma is only reversed if the dispute is upheld."}
