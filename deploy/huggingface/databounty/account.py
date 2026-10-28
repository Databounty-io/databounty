# SPDX-License-Identifier: Apache-2.0
"""Signing in to DataBounty from the Space, and acting as the person who signed in.

The Space is an OAuth 2.1 public client of DataBounty's MCP authorization server,
whose endpoints it reads from the server's own metadata document. It identifies
itself with a Client ID Metadata Document that it serves (/oauth/client-metadata.json),
so there is no registration step and no client secret to keep.

How a sign-in finishes where it started. Opened at its own address, the Space signs in
in the same tab. Inside the huggingface.co embed it can't: the embed may open windows
but not leave the page, and DataBounty's sign-in pages refuse to be framed. There it
opens a small sign-in window, which closes itself when done.

1. The page keeps a random secret in its own sessionStorage and starts the sign-in
   with only the secret's hash (/oauth/start?n=<hash>). /oauth/start refuses a start
   that didn't come from the Space's own page (Sec-Fetch-Site), so nobody can hand
   someone a link that signs *them* in for the sender to collect.
2. /oauth/start sets a short-lived, signed, httpOnly cookie holding the `state`, the
   PKCE verifier and the hash, then sends the browser to DataBounty. The callback
   accepts only a `state` matching that cookie, so it ties the round trip to the
   browser that started it.
3. The callback holds the new session under the hash for a few minutes
   (hold_sign_in). The page that started it claims it with the secret itself
   (claim_sign_in): nobody else has that secret, and it is never in a URL.
4. The page keeps the session handle in its own localStorage and sends it as a
   bearer token (webapi.py), not in a cookie: inside the embed, the Space's cookies
   are third-party and most browsers withhold them.

Starting a sign-in keeps nothing on the server, so hitting /oauth/start repeatedly
cannot crowd out real sign-ins. Tokens never reach the browser: it holds only a
random session handle. The access and refresh tokens stay in this process's memory,
so a restart signs everyone out; nothing is written to disk.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import itertools
import json
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx

DATABOUNTY_MCP_URL = os.environ.get("DATABOUNTY_MCP_URL", "https://console.databounty.io/mcp").rstrip("/")
# Only for an upload URL DataBounty returns as a path (local storage); everything else goes through MCP.
DATABOUNTY_API_URL = os.environ.get("DATABOUNTY_API_URL", "https://api.databounty.io").rstrip("/")
SPACE_HOST = os.environ.get("SPACE_HOST", "databounty-io-databounty.hf.space")
SPACE_URL = os.environ.get("SPACE_PUBLIC_URL", f"https://{SPACE_HOST}").rstrip("/")

# DataBounty fetches this URL to learn who the Space is. DATABOUNTY_CLIENT_ID overrides it only for a
# local run, where DataBounty refuses to fetch a localhost document and a registered client id is used.
CLIENT_ID = os.environ.get("DATABOUNTY_CLIENT_ID") or f"{SPACE_URL}/oauth/client-metadata.json"
REDIRECT_URI = f"{SPACE_URL}/oauth/callback"
# Only what the Space's screens need: read pools and your own items, submit and
# revise them, upload files for file fields, review other people's items, see the
# items in a pool you requested, and set up a handle on first sign-in. Each is a
# box the person can untick.
SCOPES = "read contribute validate artifact sponsor account"

LOGIN_COOKIE = "dbspace_login"
LOGIN_TTL_SECONDS = 10 * 60
SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60
MAX_SESSIONS = 20_000
REFRESH_MARGIN_SECONDS = 60
# How long a finished sign-in waits for the page that started it to claim it.
CLAIM_TTL_SECONDS = 5 * 60
_NONCE_HASH = re.compile(r"^[0-9a-f]{64}$")
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
USER_AGENT = "databounty-space/1.0 (+https://huggingface.co/spaces/databounty-io/DataBounty)"

# Secure cookies everywhere except a local run over plain http.
COOKIE_SECURE = SPACE_URL.startswith("https://")
# Signs the login cookie. A Space secret keeps sign-ins in flight valid across a
# restart; without one, a restart only means starting that sign-in again.
_COOKIE_KEY = (os.environ.get("SPACE_COOKIE_SECRET") or secrets.token_urlsafe(32)).encode()

_client = httpx.Client(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})


class SignInError(Exception):
    """A sign-in that cannot complete, with a message fit to show the person."""


class NotSignedIn(Exception):
    """The session has no usable tokens left; the person has to sign in again."""


class ToolError(Exception):
    """DataBounty refused a tool call. The message is DataBounty's own, written for people."""

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


def client_metadata() -> dict[str, Any]:
    """The Client ID Metadata Document DataBounty fetches to learn who this client is."""
    return {
        "client_id": CLIENT_ID,
        "client_name": "DataBounty on Hugging Face",
        "client_uri": "https://huggingface.co/spaces/databounty-io/DataBounty",
        "redirect_uris": [REDIRECT_URI],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": SCOPES,
    }


_metadata: dict[str, Any] | None = None
_metadata_at = 0.0
_metadata_lock = threading.Lock()


def server_metadata() -> dict[str, Any]:
    """DataBounty's authorization server metadata (RFC 8414), cached for an hour."""
    global _metadata, _metadata_at
    with _metadata_lock:
        if _metadata and time.monotonic() - _metadata_at < 3600:
            return _metadata
        origin = "{0.scheme}://{0.netloc}".format(urlsplit(DATABOUNTY_MCP_URL))
        res = _client.get(f"{origin}/.well-known/oauth-authorization-server")
        res.raise_for_status()
        doc = res.json()
        for key in ("issuer", "authorization_endpoint", "token_endpoint"):
            if not isinstance(doc.get(key), str):
                raise SignInError("DataBounty's sign-in service is misconfigured. Try again later.")
        _metadata, _metadata_at = doc, time.monotonic()
        return doc


@dataclass
class Session:
    access_token: str
    refresh_token: str | None
    expires_at: float
    scope: str
    last_used: float = field(default_factory=time.time)
    me: dict[str, Any] | None = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


_sessions: dict[str, Session] = {}
_store_lock = threading.Lock()


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _prune(now: float) -> None:
    for key in [k for k, s in _sessions.items() if now - s.last_used > SESSION_IDLE_SECONDS]:
        _sessions.pop(key, None)


def _seal(data: dict[str, Any]) -> str:
    # Unpadded base64url plus a hex MAC: only characters a cookie may carry unquoted, so the
    # value never relies on every proxy and client handling a quoted cookie correctly.
    payload = base64.urlsafe_b64encode(json.dumps(data, separators=(",", ":")).encode()).rstrip(b"=").decode()
    mac = hmac.new(_COOKIE_KEY, payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{mac}"


def _unseal(value: str | None) -> dict[str, Any] | None:
    if not value or value.count(".") != 1:
        return None
    payload, mac = value.split(".")
    expected = hmac.new(_COOKIE_KEY, payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expected):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def valid_nonce_hash(value: str | None) -> bool:
    """Whether `value` looks like the SHA-256 hex digest a page sends to /oauth/start."""
    return bool(value) and bool(_NONCE_HASH.match(value))


def begin_sign_in(nonce_hash: str = "", popup: bool = False) -> tuple[str, str]:
    """A new sign-in: (the URL to send the browser to, the login cookie that binds it to this browser).

    `nonce_hash` is the hash of the starting page's secret, kept for claim_sign_in; `popup`
    says the sign-in runs in its own small window, which the callback closes when done."""
    meta = server_metadata()
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    cookie = _seal({"s": state, "v": verifier, "t": int(time.time()), "n": nonce_hash, "p": bool(popup)})
    query = urlencode(
        {
            "response_type": "code",
            "client_id": CLIENT_ID,
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPES,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": DATABOUNTY_MCP_URL,
        }
    )
    return f"{meta['authorization_endpoint']}?{query}", cookie


def _token_request(data: dict[str, str]) -> dict[str, Any]:
    meta = server_metadata()
    res = _client.post(meta["token_endpoint"], data={**data, "client_id": CLIENT_ID, "resource": DATABOUNTY_MCP_URL})
    try:
        body = res.json()
    except ValueError:
        body = {}
    if res.status_code != 200 or not isinstance(body.get("access_token"), str):
        raise SignInError(str(body.get("error_description") or body.get("error") or f"HTTP {res.status_code}"))
    return body


def complete_sign_in(query: dict[str, str], login_cookie: str | None) -> str:
    """Finish the round trip that /oauth/start began. Returns the new session id."""
    started = _unseal(login_cookie)
    state = query.get("state") or ""
    if not started or not state or not hmac.compare_digest(state, str(started.get("s", ""))):
        raise SignInError("This sign-in was not started in this browser, or it expired. Start again from the Space.")
    if time.time() - float(started.get("t", 0)) > LOGIN_TTL_SECONDS:
        raise SignInError("This sign-in expired. Start again from the Space.")
    if query.get("error"):
        if query["error"] == "access_denied":
            raise SignInError("You didn't approve the Space, so nothing was connected.")
        raise SignInError(query.get("error_description") or "DataBounty couldn't complete the sign-in.")
    meta = server_metadata()
    # RFC 9207: the response names the server that issued it, so a code from a
    # different authorization server can never be redeemed here by mistake.
    if query.get("iss") and query["iss"] != meta["issuer"]:
        raise SignInError("That sign-in came back from an unexpected server, so it was not used.")
    code = query.get("code") or ""
    if not code:
        raise SignInError("DataBounty didn't return a sign-in code. Start again from the Space.")
    try:
        tokens = _token_request(
            {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI, "code_verifier": str(started["v"])}
        )
    except SignInError as exc:
        raise SignInError(f"DataBounty didn't accept the sign-in ({exc}). Start again from the Space.") from exc
    session = Session(
        access_token=tokens["access_token"],
        refresh_token=tokens.get("refresh_token"),
        expires_at=time.time() + float(tokens.get("expires_in") or 3600),
        scope=str(tokens.get("scope") or SCOPES),
    )
    session_id = secrets.token_urlsafe(32)
    with _store_lock:
        _prune(time.time())
        if len(_sessions) >= MAX_SESSIONS:
            oldest = min(_sessions, key=lambda key: _sessions[key].last_used)
            _sessions.pop(oldest, None)
        _sessions[_digest(session_id)] = session
    return session_id


def login_context(login_cookie: str | None) -> dict[str, Any]:
    """What /oauth/start recorded about this sign-in: the page's secret hash and whether it runs in a window."""
    started = _unseal(login_cookie) or {}
    return {"n": str(started.get("n") or ""), "p": bool(started.get("p"))}


_pending: dict[str, tuple[str, float]] = {}


def hold_sign_in(nonce_hash: str, session_id: str) -> None:
    """Keep a finished sign-in for the page that started it to claim."""
    now = time.time()
    with _store_lock:
        for key in [k for k, (_, at) in _pending.items() if now - at > CLAIM_TTL_SECONDS]:
            _pending.pop(key, None)
        _pending[nonce_hash] = (session_id, now)


def sign_in_ready(nonce_hash: str | None) -> bool:
    """Whether a sign-in started with this hash has finished. Says nothing else, so it is safe to poll."""
    if not valid_nonce_hash(nonce_hash):
        return False
    with _store_lock:
        entry = _pending.get(nonce_hash)
    return bool(entry) and time.time() - entry[1] <= CLAIM_TTL_SECONDS


def claim_sign_in(nonce: str | None) -> str | None:
    """The session a finished sign-in left for the page holding `nonce`, once. Only the page
    that started the sign-in has the nonce; everyone else has at most its hash."""
    if not nonce:
        return None
    with _store_lock:
        entry = _pending.pop(_digest(nonce), None)
    if not entry or time.time() - entry[1] > CLAIM_TTL_SECONDS:
        return None
    return entry[0]


def session_for(session_id: str | None) -> Session | None:
    if not session_id:
        return None
    with _store_lock:
        session = _sessions.get(_digest(session_id))
    if session:
        session.last_used = time.time()
    return session


def sign_out(session_id: str | None) -> None:
    """Forget the session here and revoke its tokens at DataBounty (best effort)."""
    if not session_id:
        return
    with _store_lock:
        session = _sessions.pop(_digest(session_id), None)
    if not session:
        return
    endpoint = server_metadata().get("revocation_endpoint")
    if not endpoint:
        return
    for token, hint in ((session.refresh_token, "refresh_token"), (session.access_token, "access_token")):
        if token:
            try:
                _client.post(endpoint, data={"token": token, "token_type_hint": hint, "client_id": CLIENT_ID})
            except httpx.HTTPError:
                pass


def _access_token(session: Session) -> str:
    """A live access token, refreshed first when it is about to expire."""
    with session.lock:
        if session.expires_at - REFRESH_MARGIN_SECONDS > time.time():
            return session.access_token
        if not session.refresh_token:
            raise NotSignedIn()
        try:
            tokens = _token_request({"grant_type": "refresh_token", "refresh_token": session.refresh_token})
        except SignInError as exc:
            raise NotSignedIn() from exc
        session.access_token = tokens["access_token"]
        # Refresh tokens rotate: keep the new one, the old one is now spent.
        session.refresh_token = tokens.get("refresh_token") or session.refresh_token
        session.expires_at = time.time() + float(tokens.get("expires_in") or 3600)
        return session.access_token


# --- Calling DataBounty's MCP tools as the signed-in person -------------------------------------

MCP_PROTOCOL = "2026-07-28"
_rpc_ids = itertools.count(1)


def _rpc_body(text: str) -> dict[str, Any]:
    """The JSON-RPC reply, whether DataBounty answered with plain JSON or a one-event SSE stream."""
    trimmed = text.lstrip()
    if trimmed.startswith("{"):
        return json.loads(trimmed)
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            return json.loads(line[len("data:"):].strip())
    raise ToolError("DataBounty sent a reply the Space could not read. Try again.")


def _post_tool(token: str, name: str, arguments: dict[str, Any] | None) -> httpx.Response:
    """One tools/call to DataBounty's MCP server with this bearer token, in the stateless MCP
    protocol: no handshake and no server-side MCP session to expire."""
    payload = {
        "jsonrpc": "2.0",
        "id": next(_rpc_ids),
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments or {},
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {"name": "databounty-hf-space", "version": "1.0.0"},
            },
        },
    }
    try:
        return _client.post(
            DATABOUNTY_MCP_URL,
            json=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": MCP_PROTOCOL,
                "Mcp-Method": "tools/call",
                "Mcp-Name": name,
            },
        )
    except httpx.HTTPError as exc:
        raise ToolError("DataBounty didn't answer in time. Try again in a moment.") from exc


def _tool_result(res: httpx.Response) -> Any:
    """A tool's parsed result, or ToolError with DataBounty's own message. (401 is the caller's.)"""
    if res.status_code == 429:
        wait = res.headers.get("Retry-After", "a few")
        raise ToolError(f"DataBounty is limiting requests right now. Try again in {wait} seconds.")
    if res.status_code >= 400:
        try:
            detail = res.json()
            message = detail.get("error_description") or detail.get("message") or detail.get("error")
        except ValueError:
            message = None
        raise ToolError(str(message or f"DataBounty refused the request (HTTP {res.status_code})."))
    body = _rpc_body(res.text)
    if body.get("error"):
        raise ToolError(str(body["error"].get("message") or "DataBounty refused the request."))
    result = body.get("result") or {}
    content = result.get("content") or [{}]
    text = content[0].get("text", "") if isinstance(content[0], dict) else ""
    if result.get("isError"):
        raise ToolError(text or "DataBounty refused the request.")
    try:
        return json.loads(text)
    except ValueError:
        return text


def call_tool(session: Session, name: str, arguments: dict[str, Any] | None = None) -> Any:
    """Call one DataBounty tool as this session's person. Returns the tool's parsed result."""
    for attempt in (1, 2):
        res = _post_tool(_access_token(session), name, arguments)
        if res.status_code == 401:
            if attempt == 1:
                # Revoked or expired early (another device signed out): refresh once and retry.
                with session.lock:
                    session.expires_at = 0
                continue
            raise NotSignedIn()
        return _tool_result(res)
    raise NotSignedIn()


# DataBounty's personal API keys (apps/api services/api-keys.ts KEY_PREFIX). Only strings that
# look like one are ever forwarded, so a token pasted into the wrong setting goes nowhere.
API_KEY_PREFIX = "db_live_sk_"


def call_tool_with_key(api_key: str, name: str, arguments: dict[str, Any] | None = None) -> Any:
    """Call one DataBounty tool as the owner of a DataBounty API key (the agent tools in
    agent_tools.py). The key is used for this one request, and never stored or logged; DataBounty
    checks it, its scopes and its owner on every call."""
    if not api_key.startswith(API_KEY_PREFIX):
        raise NotSignedIn()
    res = _post_tool(api_key, name, arguments)
    if res.status_code == 401:
        raise NotSignedIn()
    return _tool_result(res)


def upload_file(session: Session, bounty_id: str, path: str, filename: str, content_type: str) -> str:
    """Upload one file for a file field and wait for DataBounty's scan. Returns the artifact id
    that goes in the item's payload."""
    data = Path(path).read_bytes()
    slot = call_tool(
        session,
        "prepare_file_upload",
        {
            "filename": filename,
            "contentType": content_type,
            "kind": "submission_attachment",
            "sizeBytes": len(data),
            "checksumSha256": hashlib.sha256(data).hexdigest(),
            "bountyId": bounty_id,
        },
    )
    upload = slot.get("upload") or {}
    # A reused slot is the same pending file with a fresh URL: it still needs the bytes.
    url = str(upload.get("url") or "")
    if url.startswith("/"):
        url = f"{DATABOUNTY_API_URL}{url}"
    try:
        # A signed form POST: every policy field first, then the file as `file`.
        res = _client.post(
            url,
            data=upload.get("fields") or {},
            files={"file": (filename, data, content_type)},
            timeout=httpx.Timeout(120.0, connect=10.0),
        )
    except httpx.HTTPError as exc:
        raise ToolError(f"{filename} could not be uploaded. Try again.") from exc
    if res.status_code >= 300:
        raise ToolError(f"{filename} was refused by storage (HTTP {res.status_code}).")
    file_id = slot.get("fileId") or slot.get("artifactId")
    call_tool(session, "complete_file_upload", {"fileId": file_id})
    deadline = time.time() + 120
    while True:
        status = call_tool(session, "get_file_status", {"fileId": file_id}) or {}
        state = status.get("status")
        if state == "ready":
            return slot["artifactId"]
        if state in {"quarantined", "deleted"}:
            raise ToolError(f"{filename} did not pass DataBounty's file checks, so it can't be attached.")
        progress = status.get("scanProgress") or {}
        if progress.get("blocked"):
            raise ToolError(f"{filename} is stuck in DataBounty's file scan and needs an operator. Try again later.")
        # Pace by DataBounty's own estimate instead of polling blindly.
        wait = (status.get("ingest") or {}).get("recheckAfterSeconds")
        wait = min(max(float(wait), 2.0), 15.0) if isinstance(wait, (int, float)) else 3.0
        if time.time() + wait > deadline:
            raise ToolError(f"{filename} is still being checked. Submit again in a minute.")
        time.sleep(wait)
