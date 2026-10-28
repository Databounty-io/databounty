# SPDX-License-Identifier: Apache-2.0
"""The JSON API behind the Space's web page (web/app.js): contributing, reviewing, and public reads.

Public reads come straight from databounty.py. Anything done as a person goes through account.py
with the session handle the page sends as `Authorization: Bearer <handle>`. The page keeps that
handle in its own storage (account.py explains why not a cookie), and a handle only ever reaches
the page through claim_sign_in, which only the page that started the sign-in can complete.
"""

from __future__ import annotations

import json
import re
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

import account
import console
import contribute
import databounty as db
import items as checks
import sponsor
import validate

NO_STORE = {"Cache-Control": "no-store"}
MAX_FILE_BYTES = 100 * 1024 * 1024

router = APIRouter(prefix="/api")


class ApiError(Exception):
    """An answer for the page: an HTTP status and a message written for people."""

    def __init__(self, status: int, message: str, *, needs: str = ""):
        super().__init__(message)
        self.status = status
        self.message = message
        self.needs = needs  # what the page should offer next, e.g. "claim"


def api_error(_request: Request, exc: ApiError) -> JSONResponse:
    body = {"error": exc.message, **({"needs": exc.needs} if exc.needs else {})}
    return JSONResponse(body, status_code=exc.status, headers=NO_STORE)


def _ok(data: Any) -> JSONResponse:
    return JSONResponse(data, headers=NO_STORE)


def _public(load):
    try:
        return load()
    except db.UpstreamError as exc:
        raise ApiError(502, str(exc)) from exc


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header.lower().startswith("bearer ") else ""


def _session(request: Request) -> tuple[str, account.Session]:
    session_id = _bearer(request)
    session = account.session_for(session_id) if session_id else None
    if session is None:
        raise ApiError(401, "Sign in to continue.")
    return session_id, session


def _call(session: account.Session, name: str, arguments: dict[str, Any] | None = None) -> Any:
    try:
        return account.call_tool(session, name, arguments)
    except account.NotSignedIn as exc:
        raise ApiError(401, "Your sign-in ended. Sign in again to continue.") from exc
    except account.ToolError as exc:
        raise ApiError(400, str(exc)) from exc


async def _json(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError as exc:
        raise ApiError(400, "Send a JSON body.") from exc
    return body if isinstance(body, dict) else {}


# --- Public ---------------------------------------------------------------------------------------


@router.get("/overview")
def overview():
    return _ok({"stats": _public(db.stats), "tiers": _public(db.tiers), "hfOrg": db.HF_ORG, "siteUrl": db.SITE_URL, "appUrl": db.APP_URL})


@router.get("/pools")
def pools(q: str = "", domain: str = "", difficulty: str = ""):
    return _ok({"pools": _public(lambda: db.open_pools(q, domain.lower(), difficulty.lower()))})


@router.get("/datasets")
def datasets():
    return _ok({"datasets": _public(db.published_datasets)})


@router.get("/leaderboard")
def leaderboard(tier: str = "", q: str = ""):
    return _ok({"rows": _public(lambda: db.leaderboard(limit=100, tier=tier.lower(), query=q))})


@router.get("/profiles/{handle}")
def profile(handle: str):
    try:
        person = _public(lambda: db.contributor(handle))
    except ValueError as exc:
        raise ApiError(400, str(exc)) from exc
    if person is None:
        raise ApiError(404, "There's no public profile with that handle. Members can keep their profile private.")
    return _ok(person)


@router.get("/tools")
def tools():
    return _ok({"tools": _public(db.platform_mcp_tools), "mcpUrl": db.MCP_URL})


# --- Session and account ------------------------------------------------------------------------------


@router.post("/session/claim")
async def claim_session(request: Request):
    nonce = str((await _json(request)).get("nonce") or "")
    session_id = account.claim_sign_in(nonce)
    if not session_id:
        raise ApiError(404, "That sign-in isn't ready, or it was already used.")
    return _ok({"session": session_id})


@router.post("/session/sign-out")
def sign_out(request: Request):
    account.sign_out(_bearer(request) or None)
    return _ok({"ok": True})


@router.get("/me")
def me(request: Request):
    _, session = _session(request)
    who = _call(session, "whoami")
    session.me = who
    scopes = set(session.scope.split())
    step = (
        "permission" if "contribute" not in scopes
        else "verify_email" if not who.get("emailVerified")
        else "choose_handle" if not who.get("handle")
        else "finish_setup" if not who.get("onboarded")
        else "ready"
    )
    suggestion = ""
    if step == "choose_handle" and "account" in scopes:
        try:
            suggested = account.call_tool(session, "suggest_handles", {"baseName": who.get("displayName") or "", "count": 3})
            suggestion = suggested[0] if isinstance(suggested, list) and suggested else ""
        except (account.ToolError, account.NotSignedIn):
            suggestion = ""
    return _ok({
        "displayName": who.get("displayName") or "",
        "handle": who.get("handle") or "",
        "email": who.get("email") or "",
        "karma": who.get("karmaTotal") if isinstance(who.get("karmaTotal"), (int, float)) else 0,
        "step": step,
        "suggestedHandle": suggestion,
        "profileUrl": f"{db.SITE_URL}/{who.get('handle')}/" if who.get("handle") else "",
        # Sign-ins from before the Space asked for `validate` or `sponsor` can't use those screens.
        "canReview": "validate" in scopes,
        "canSponsor": "sponsor" in scopes,
        "reviewer": validate.rank_view(who),
    })


@router.post("/me/handle-check")
async def handle_check(request: Request):
    _, session = _session(request)
    handle = str((await _json(request)).get("handle") or "").strip().lower().lstrip("@")
    if not handle:
        raise ApiError(400, "Type a username first.")
    result = _call(session, "get_handle_availability", {"handle": handle})
    return _ok({"handle": handle, "available": bool(result.get("available")), "reason": result.get("reason") or ""})


@router.post("/me/finish-setup")
async def finish_setup(request: Request):
    _, session = _session(request)
    handle = str((await _json(request)).get("handle") or "").strip().lower().lstrip("@")
    who = session.me or _call(session, "whoami")
    if not who.get("handle"):
        if not handle:
            raise ApiError(400, "Type the username you want first.")
        result = _call(session, "get_handle_availability", {"handle": handle})
        if not result.get("available"):
            raise ApiError(409, f"@{handle} isn't available: {result.get('reason') or 'it is taken'}.")
        _call(session, "claim_handle", {"handle": handle})
    _call(session, "complete_onboarding", {"persona": "contributor"})
    session.me = None
    return _ok({"ok": True})


@router.post("/me/resend-verification")
def resend_verification(request: Request):
    _, session = _session(request)
    result = _call(session, "resend_email_verification") or {}
    return _ok({"alreadyVerified": result.get("status") == "already_verified"})


# --- Pools ---------------------------------------------------------------------------------------------


def _contract(session: account.Session, pool_id: str) -> dict[str, Any]:
    return contribute.contract_view(_call(session, "get_pool_contract", {"bountyId": pool_id}), pool_id)


@router.get("/pools/{pool_id}/contract")
def contract(pool_id: str, request: Request):
    session = account.session_for(_bearer(request)) if _bearer(request) else None
    if session is not None:
        return _ok(_contract(session, pool_id))
    try:
        details = _public(lambda: db.pool_details(pool_id))
    except ValueError as exc:
        raise ApiError(400, str(exc)) from exc
    if details is None:
        raise ApiError(404, "That pool is no longer listed.")
    return _ok(contribute.public_contract_view(details))


@router.get("/pools/{pool_id}/template.csv")
def template(pool_id: str):
    try:
        details = _public(lambda: db.pool_details(pool_id))
    except ValueError as exc:
        raise ApiError(400, str(exc)) from exc
    if details is None:
        raise ApiError(404, "That pool is no longer listed.")
    text = contribute.template_csv(details.get("fields") or [])
    if not text:
        raise ApiError(404, "This pool takes files, so add its items one at a time.")
    slug = re.sub(r"[^a-z0-9]+", "-", str(details.get("title") or "pool").lower()).strip("-")[:48] or "pool"
    return Response(
        text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{slug}-template.csv"', **NO_STORE},
    )


async def _save(upload: Any) -> tuple[str, str, str]:
    """An uploaded file, to a temporary path: (path, filename, content type)."""
    data = await upload.read()
    if len(data) > MAX_FILE_BYTES:
        raise ApiError(413, f"{upload.filename} is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB.")
    suffix = Path(upload.filename or "upload").suffix[:16]
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, prefix="databounty-space-") as handle:
        handle.write(data)
    return handle.name, Path(upload.filename or "upload").name, upload.content_type or "application/octet-stream"


@router.post("/pools/{pool_id}/items")
async def submit_item(pool_id: str, request: Request):
    _, session = _session(request)
    # Closing the form deletes the uploads' temporary files.
    async with request.form() as form:
        return await _submit_item(session, pool_id, form)


async def _submit_item(session: account.Session, pool_id: str, form: Any) -> JSONResponse:
    method = str(form.get("method") or "")
    if method not in contribute.GENERATION_METHODS:
        raise ApiError(400, "Choose how you made this item.")
    try:
        values = json.loads(str(form.get("values") or "{}"))
    except ValueError as exc:
        raise ApiError(400, "The form's values didn't arrive in one piece. Try again.") from exc
    files: dict[str, list[Any]] = {}
    for name, value in form.multi_items():
        if name.startswith("file:") and getattr(value, "filename", None):
            files.setdefault(name[5:], []).append(value)

    contract_data = _contract(session, pool_id)
    if not contract_data["open"]:
        raise ApiError(409, "This pool isn't taking items right now.")
    payload, problems = contribute.item_payload(contract_data["fields"], values if isinstance(values, dict) else {}, {k: len(v) for k, v in files.items()})
    if problems:
        raise ApiError(400, " ".join(problems))

    saved: list[str] = []
    try:
        for spec in contract_data["fields"]:
            uploads = files.get(spec["key"]) or []
            if spec["role"] != "file" or not uploads:
                continue
            ids = []
            for upload in uploads:
                path, filename, content_type = await _save(upload)
                saved.append(path)
                try:
                    ids.append(account.upload_file(session, pool_id, path, filename, content_type))
                except account.NotSignedIn as exc:
                    raise ApiError(401, "Your sign-in ended. Sign in again to continue.") from exc
                except account.ToolError as exc:
                    raise ApiError(400, str(exc)) from exc
            payload[spec["key"]] = ids if spec["maxCount"] > 1 else ids[0]
    finally:
        for path in saved:
            Path(path).unlink(missing_ok=True)

    title = " ".join(str(form.get("title") or "").split())[:120] or contribute.title_for(payload)
    if len(title) < 3:
        title = f"{title} item".strip()
    result = _call(
        session,
        "submit_pool_items",
        {"bountyId": pool_id, "items": [{"title": title, "payloadJson": payload, "generationMethod": method}]},
    )
    subs = result.get("submissions") or []
    duplicate = bool(subs) and all(s.get("status") == "rejected" and s.get("duplicateOfSubmissionId") for s in subs)
    return _ok({"duplicate": duplicate, "submissions": [{"id": s.get("id"), "status": s.get("status")} for s in subs], "karma": contract_data["karma"]})


@router.post("/pools/{pool_id}/bulk/preview")
async def bulk_preview(pool_id: str, request: Request):
    _, session = _session(request)
    async with request.form() as form:
        upload = form.get("file")
        if not getattr(upload, "filename", None):
            raise ApiError(400, "Choose a file first.")
        data = await upload.read()
    fields = _contract(session, pool_id)["fields"]
    try:
        rows = checks.parse_bulk(data, upload.filename)
    except ValueError as exc:
        raise ApiError(400, str(exc)) from exc
    if len(rows) > contribute.MAX_BULK_ROWS:
        raise ApiError(400, f"That file has {len(rows):,} rows. Upload up to {contribute.MAX_BULK_ROWS} at a time.")
    for row in rows:
        if row.payload is not None:
            row.payload = checks.coerce_for_contract(fields, row.payload)
    checks.check_rows(rows, fields)
    return _ok({
        "rows": [
            {
                "number": row.number,
                "ok": row.ok,
                "problem": "" if row.ok else (row.error or "; ".join(row.problems)),
                "title": contribute.title_for(row.payload, row.number),
                "payload": row.payload,
            }
            for row in rows
        ],
        "hasFileFields": any(spec["role"] == "file" for spec in fields),
    })


@router.post("/pools/{pool_id}/bulk/send")
async def bulk_send(pool_id: str, request: Request):
    _, session = _session(request)
    body = await _json(request)
    method = str(body.get("method") or "")
    if method not in contribute.GENERATION_METHODS:
        raise ApiError(400, "Choose how you made these items.")
    contract_data = _contract(session, pool_id)
    if not contract_data["open"]:
        raise ApiError(409, "This pool isn't taking items right now.")
    # Every row is checked again here: the page's copy is only a preview.
    items, skipped = [], 0
    for row in body.get("rows") or []:
        payload = row.get("payload") if isinstance(row, dict) else None
        if not isinstance(payload, dict) or checks.item_problems(contract_data["fields"], payload):
            skipped += 1
            continue
        number = int(row.get("number") or 0)
        title = " ".join(str(row.get("title") or "").split())[:120] or contribute.title_for(payload, number)
        items.append({"title": title, "payloadJson": payload, "generationMethod": method})
    if not items:
        raise ApiError(400, "None of those rows are ready to send.")
    sent = duplicates = 0
    problem = ""
    size = max(1, contract_data["maxItems"])
    for start in range(0, len(items), size):
        try:
            result = account.call_tool(session, "submit_pool_items", {"bountyId": pool_id, "items": items[start : start + size]})
        except account.NotSignedIn:
            problem = "Your sign-in ended, so the rest weren't sent. Sign in again to continue."
            break
        except account.ToolError as exc:
            problem = f"Items {start + 1} onwards weren't sent: {exc}"
            break
        created = result.get("submissions") or []
        sent += len(created)
        duplicates += sum(1 for s in created if s.get("status") == "rejected" and s.get("duplicateOfSubmissionId"))
        if result.get("stoppedAtCapacity"):
            problem = "The pool filled up, so the rest weren't sent."
            break
    return _ok({"sent": sent, "duplicates": duplicates, "skipped": skipped, "problem": problem, "karma": contract_data["karma"]})


# --- Submissions ------------------------------------------------------------------------------------------


@router.get("/submissions")
def submissions(request: Request, pool: str = ""):
    _, session = _session(request)
    arguments: dict[str, Any] = {"limit": 50}
    if pool.strip():
        arguments["bountyId"] = pool.strip()  # one pool's items, for its page
    data = _call(session, "list_my_submissions", arguments) or {}
    rows = [contribute.submission_row(item) for item in data.get("items") or []]
    return _ok({"items": rows, "total": data.get("total") if isinstance(data.get("total"), int) else len(rows)})


@router.get("/submissions/{submission_id}")
def submission(submission_id: str, request: Request):
    _, session = _session(request)
    return _ok(contribute.submission_view(_call(session, "check_submission", {"submissionId": submission_id}), db.APP_URL))


# --- Reviewing --------------------------------------------------------------------------------------
# A review is an audit: a few items from one pool, held by one reviewer for 24 hours.


def _reviewer(request: Request) -> account.Session:
    _, session = _session(request)
    if "validate" not in session.scope.split():
        raise ApiError(403, "The Space isn't allowed to review for you. Sign out, then sign in again and keep validate ticked.")
    return session


@router.get("/audits")
def audits(request: Request, q: str = ""):
    session = _reviewer(request)
    search = " ".join(q.split())[:120]
    data = _call(session, "list_audits", {"limit": 50, **({"search": search} if search else {})}) or {}
    rows = [validate.audit_row(a) for a in data.get("audits") or []]
    return _ok({
        "audits": rows,
        "total": data.get("total") if isinstance(data.get("total"), int) else len(rows),
        # Audits holding the reviewer's own work, which they can't review.
        "hidden": data.get("conflictExcluded") if isinstance(data.get("conflictExcluded"), int) else 0,
    })


@router.get("/audits/mine")
def my_audits(request: Request, status: str = "claimed"):
    session = _reviewer(request)
    status = status if status in ("claimed", "overdue_review", "completed") else "claimed"
    data = _call(session, "list_my_audits", {"status": status, "limit": 50}) or {}
    rows = [validate.audit_row(a) for a in data.get("audits") or []]
    return _ok({"audits": rows, "total": data.get("total") if isinstance(data.get("total"), int) else len(rows)})


@router.post("/audits/{audit_id}/claim")
def claim_audit(audit_id: str, request: Request):
    session = _reviewer(request)
    window = (_call(session, "claim_audit", {"windowId": audit_id}) or {}).get("window") or {}
    return _ok({"id": window.get("id") or audit_id, "deadline": window.get("claimExpiresAt")})


@router.get("/audits/{audit_id}")
def audit(audit_id: str, request: Request):
    session = _reviewer(request)
    try:
        detail = account.call_tool(session, "get_audit", {"windowId": audit_id})
    except account.NotSignedIn as exc:
        raise ApiError(401, "Your sign-in ended. Sign in again to continue.") from exc
    except account.ToolError as exc:
        # The items stay hidden until the reviewer holds the audit (DataBounty's rule).
        if "claim_audit" in str(exc) or "Claim this audit" in str(exc):
            raise ApiError(409, "Claim this audit to see its items. It's yours for 24 hours.", needs="claim") from exc
        raise ApiError(400, str(exc)) from exc
    return _ok(validate.audit_view(detail or {}, db.APP_URL))


@router.post("/audits/{audit_id}/decisions")
async def decide(audit_id: str, request: Request):
    session = _reviewer(request)
    decision, problem = validate.decision(await _json(request))
    if problem:
        raise ApiError(400, problem)
    result = _call(session, "submit_decisions", {"windowId": audit_id, "decisions": [decision]}) or {}
    return _ok({"ok": True, "decided": result.get("decisionsCount", 1)})


# --- Sponsoring ----------------------------------------------------------------------------------------
# Only a pool's requester can see its items (DataBounty's rule), so the page asks on every pool and
# shows the panel only when DataBounty says yes. Requesting a dataset stays on databounty.io.


def _sponsor(request: Request) -> account.Session:
    _, session = _session(request)
    if "sponsor" not in session.scope.split():
        raise ApiError(403, "Sign out, then sign in again and keep sponsor ticked, to see your pools here.", needs="sponsor_scope")
    return session


def _sponsor_call(session: account.Session, name: str, arguments: dict[str, Any]) -> Any:
    try:
        return account.call_tool(session, name, arguments)
    except account.NotSignedIn as exc:
        raise ApiError(401, "Your sign-in ended. Sign in again to continue.") from exc
    except account.ToolError as exc:
        message = str(exc)
        if "owner" in message.lower() or "forbidden" in message.lower():
            raise ApiError(403, "Only the person who requested this pool can see its items.", needs="not_sponsor") from exc
        raise ApiError(400, message) from exc


@router.get("/pools/{pool_id}/sponsor")
def sponsor_pool(pool_id: str, request: Request, status: str = "", q: str = ""):
    session = _sponsor(request)
    arguments: dict[str, Any] = {"bountyId": pool_id, "limit": 50}
    if status.strip():
        arguments["status"] = status.strip()
    if q.strip():
        arguments["search"] = " ".join(q.split())[:120]
    data = _sponsor_call(session, "get_sponsor_submission_evidence", arguments) or {}
    try:
        specs = (db.pool_details(pool_id) or {}).get("fields") or []
    except (ValueError, db.UpstreamError):
        specs = []  # labels are a nicety; the items still show under their keys
    return _ok(sponsor.pool_view(data, specs))


@router.post("/sponsor/submissions/{submission_id}/dispute")
async def sponsor_dispute(submission_id: str, request: Request):
    session = _sponsor(request)
    arguments, problem = sponsor.dispute(await _json(request))
    if problem:
        raise ApiError(400, problem)
    _sponsor_call(session, "dispute_accepted_submission", {"submissionId": submission_id, **arguments})
    return _ok({"ok": True})


# --- The signed-in console ------------------------------------------------------------------------------
# Each console page after login, from DataBounty's MCP tools as the person. What no tool offers (weekly
# validator charts, held karma, notification channels, API keys, profile edits) links to databounty.io.


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _pages(session: account.Session, name: str, arguments: dict[str, Any], key: str, *, older_than: str = "", cap: int = 5) -> list[dict[str, Any]]:
    """Every row of a cursor-paged tool, newest first, stopping at `older_than` or after `cap` pages."""
    rows: list[dict[str, Any]] = []
    cursor = None
    for _ in range(cap):
        page = _call(session, name, {**arguments, **({"cursor": cursor} if cursor else {})}) or {}
        items = [row for row in page.get(key) or [] if isinstance(row, dict)]
        rows.extend(items)
        cursor = page.get("nextCursor")
        if not cursor or page.get("hasMore") is False or (older_than and items and str(items[-1].get("createdAt") or "") < older_than):
            break
    return rows


def _together(session: account.Session, calls: dict[str, tuple[str, dict[str, Any]]]) -> dict[str, Any]:
    """Several tool calls at once (the session refreshes its token under its own lock)."""
    with ThreadPoolExecutor(max_workers=min(4, len(calls))) as pool:
        futures = {label: pool.submit(_call, session, name, args) for label, (name, args) in calls.items()}
        return {label: future.result() or {} for label, future in futures.items()}


@router.get("/console/shell")
def console_shell(request: Request):
    """The sidebar's karma card and unread count."""
    _, session = _session(request)
    got = _together(session, {"karma": ("get_karma_details", {"limit": 1}), "notes": ("list_notifications", {"limit": 1})})
    return _ok({**console.tier_view(got["karma"]), "unread": got["notes"].get("unreadCount") or 0})


@router.get("/console/analytics")
def console_analytics(request: Request, weeks: int = console.WEEKS):
    _, session = _session(request)
    weeks = weeks if weeks in (4, 12, 26, 52) else console.WEEKS
    now = _now()
    start = console.week_range(weeks, now)[0]
    since = datetime(start.year, start.month, start.day, tzinfo=timezone.utc).isoformat()
    subs = _pages(session, "list_my_submissions", {"limit": 100}, "items", older_than=since)
    events = _pages(session, "get_karma_details", {"limit": 100, "since": since}, "events")
    return _ok(console.analytics_view(subs, events, weeks, now))


@router.get("/console/contributor")
def console_contributor(request: Request):
    _, session = _session(request)
    got = _together(session, {"who": ("whoami", {}), "work": ("get_my_work_progress", {}), "karma": ("get_karma_details", {"limit": 1})})
    return _ok({"karma": console.tier_view(got["karma"]), "rank": console.rank_card((got["who"].get("ranks") or {}).get("contributor")),
                "funnel": got["work"].get("contributor") or {}})


@router.get("/console/my-pools")
def console_my_pools(request: Request, filter: str = "all", q: str = ""):
    """The person's submissions, one row per pool, like the console's My submissions."""
    _, session = _session(request)
    subs = _pages(session, "list_my_submissions", {"limit": 100}, "items")
    rows = console.pool_groups(subs)
    counts = {f: sum(1 for r in rows if f in r["filters"]) for f in console.POOL_FILTERS}
    needle = " ".join(q.split()).lower()
    wanted = filter if filter in console.POOL_FILTERS else "all"
    shown = [r for r in rows if wanted in r["filters"] and (not needle or needle in r["pool"].lower())]
    return _ok({"pools": shown, "counts": counts, "submitted": len(subs)})


@router.get("/console/validator")
def console_validator(request: Request):
    _, session = _session(request)
    got = _together(session, {"who": ("whoami", {}), "work": ("get_my_work_progress", {}), "karma": ("get_karma_details", {"limit": 1})})
    ranks = (got["who"].get("ranks") or {}).get("validator") or {}
    return _ok({"karma": console.tier_view(got["karma"]), "reviewer": validate.rank_view(got["who"]), "work": got["work"].get("validator") or {},
                "flags": {"decided": ranks.get("decidedFlags") or 0, "dismissed": ranks.get("dismissedFlags") or 0}})


@router.get("/console/karma")
def console_karma(request: Request, cursor: str = "", kind: str = ""):
    _, session = _session(request)
    args: dict[str, Any] = {"limit": 20}
    if cursor:
        args["cursor"] = cursor
    if kind in console.KARMA_KINDS:
        args["eventType"] = kind
    got = _together(session, {"karma": ("get_karma_details", args), "who": ("whoami", {})})
    tier = console.tier_view(got["karma"])
    try:
        ladder = db.tiers()
    except db.UpstreamError:
        ladder = []
    return _ok({
        "karma": tier,
        "tiers": console.tiers_view(ladder, tier),
        "badges": [b.get("label") for b in got["who"].get("badges") or [] if isinstance(b, dict) and b.get("label")],
        "breakdown": got["karma"].get("breakdown") or {},
        "events": [console.karma_event_row(e) for e in got["karma"].get("events") or [] if isinstance(e, dict)],
        "nextCursor": got["karma"].get("nextCursor") if got["karma"].get("hasMore") else None,
        "eventCount": got["karma"].get("eventCount") or 0,
    })


@router.get("/console/profile")
def console_profile(request: Request):
    _, session = _session(request)
    got = _together(session, {"who": ("whoami", {}), "pref": ("get_attribution_preference", {})})
    who, pref = got["who"], got["pref"]
    ranks = who.get("ranks") or {}
    handle = who.get("handle") or ""
    return _ok({
        "displayName": who.get("displayName") or "", "handle": handle, "email": who.get("email") or "",
        "publicUrl": f"{db.SITE_URL}/{handle}" if handle else "", "profilePublic": bool(pref.get("profilePublic")),
        "prefs": pref.get("publicProfilePrefs") or {}, "creditOptOut": bool(pref.get("optOut")),
        "contributor": ranks.get("contributor") or {}, "validator": validate.rank_view(who),
        "badges": [b.get("label") for b in who.get("badges") or [] if isinstance(b, dict) and b.get("label")],
        "settingsUrl": f"{db.APP_URL}/profile/",
    })


@router.get("/console/notifications")
def console_notifications(request: Request, unread: bool = False, cursor: str = ""):
    _, session = _session(request)
    args: dict[str, Any] = {"limit": 30}
    if unread:
        args["unreadOnly"] = True
    if cursor:
        args["cursor"] = cursor
    data = _call(session, "list_notifications", args) or {}
    now = _now()
    return _ok({
        "items": [console.notification_view(n, now, db.APP_URL) for n in data.get("items") or [] if isinstance(n, dict)],
        "unread": data.get("unreadCount") or 0,
        "nextCursor": data.get("nextCursor") if data.get("hasMore") else None,
        "channelsUrl": f"{db.APP_URL}/notifications/",
    })


@router.post("/console/notifications/read")
async def console_notifications_read(request: Request):
    _, session = _session(request)
    note = str((await _json(request)).get("id") or "")
    _call(session, "mark_notifications_read", {"notificationId": note} if note else {})
    return _ok({"ok": True})


@router.get("/console/issues")
def console_issues(request: Request, status: str = "", q: str = "", cursor: str = ""):
    _, session = _session(request)
    args: dict[str, Any] = {"limit": 20}
    if status in console.ISSUE_STATUS:
        args["status"] = status
    needle = " ".join(q.split())[:80]
    if len(needle) >= 2:
        args["q"] = needle
    if cursor:
        args["cursor"] = cursor
    data = _call(session, "list_my_issues", args) or {}
    now = _now()
    rows = [console.issue_row(i, now) for i in data.get("items") or [] if isinstance(i, dict)]
    return _ok({"items": rows, "count": data.get("issueCount") if isinstance(data.get("issueCount"), int) else len(rows),
                "waiting": sum(1 for r in rows if r["needsAnswer"]), "nextCursor": data.get("nextCursor") if data.get("hasMore") else None})


@router.get("/console/issues/{issue_id}")
def console_issue(issue_id: str, request: Request):
    _, session = _session(request)
    return _ok(console.issue_view(_call(session, "get_issue", {"issueId": issue_id}) or {}, _now()))


@router.post("/console/issues/{issue_id}/reply")
async def console_issue_reply(issue_id: str, request: Request):
    _, session = _session(request)
    body = str((await _json(request)).get("body") or "").strip()
    if not body:
        raise ApiError(400, "Write a reply first.")
    if len(body) > 2000:
        raise ApiError(400, "Keep the reply under 2000 characters.")
    _call(session, "reply_to_issue", {"issueId": issue_id, "body": body})
    return _ok(console.issue_view(_call(session, "get_issue", {"issueId": issue_id}) or {}, _now()))


# Which open pools this person requested. DataBounty has no "my pools" tool and its public pool data
# doesn't name the requester, so the Space asks get_sponsor_submission_evidence about each open pool
# (it answers only the requester) and keeps the answer for a few minutes.
_SPONSORED: dict[str, tuple[float, list[dict[str, Any]]]] = {}
SPONSORED_TTL = 300.0


@router.get("/console/sponsor")
def console_sponsor(request: Request, fresh: bool = False):
    session_id, session = _session(request)
    links = {"requestUrl": f"{db.APP_URL}/sponsor/create/", "requestsUrl": f"{db.APP_URL}/sponsor/"}
    if "sponsor" not in session.scope.split():
        return _ok({"pools": [], "needsScope": True, **links})
    key = account._digest(session_id)
    hit = _SPONSORED.get(key)
    if hit and not fresh and time.monotonic() - hit[0] < SPONSORED_TTL:
        return _ok({"pools": hit[1], **links})
    open_pools = _public(lambda: db.open_pools())

    def check(pool: dict[str, Any]) -> dict[str, Any] | str:
        """The pool with its item count when it's this person's, "theirs" when it isn't, "unknown" when
        DataBounty didn't say (a timeout or rate limit, which mustn't read as "not yours")."""
        try:
            data = account.call_tool(session, "get_sponsor_submission_evidence", {"bountyId": pool["id"], "limit": 1}) or {}
        except account.ToolError as exc:
            return "theirs" if "owner" in str(exc).lower() or "forbidden" in str(exc).lower() else "unknown"
        return {**pool, "items": data.get("total") if isinstance(data.get("total"), int) else 0}

    try:
        with ThreadPoolExecutor(max_workers=6) as executor:
            answers = list(executor.map(check, open_pools))
    except account.NotSignedIn as exc:
        raise ApiError(401, "Your sign-in ended. Sign in again to continue.") from exc
    mine = [row for row in answers if isinstance(row, dict)]
    if "unknown" in answers:
        return _ok({"pools": mine, "partial": True, **links})
    now = time.monotonic()
    for stale in [k for k, (at, _) in list(_SPONSORED.items()) if now - at >= SPONSORED_TTL]:
        _SPONSORED.pop(stale, None)
    _SPONSORED[key] = (now, mine)
    return _ok({"pools": mine, **links})


@router.get("/console/developers")
def console_developers():
    surface = _public(db.developer_surface)
    return _ok({
        "mcpUrl": surface.get("mcpRemoteUrl") or db.MCP_URL, "rateLimit": surface.get("rateLimitPerMinute"),
        "toolCount": len(surface.get("mcpTools") or []), "keysUrl": f"{db.APP_URL}/developers/",
    })
