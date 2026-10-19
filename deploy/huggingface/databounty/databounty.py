# SPDX-License-Identifier: Apache-2.0
"""Read-only client for DataBounty's public API and the Hugging Face Hub.

Everything here reads public data: the same unauthenticated endpoints that
databounty.io renders from. Each response is kept in a small in-process cache
for CACHE_TTL_SECONDS, so a burst of visitors, or an agent calling the MCP tools
in a loop, never turns into a burst of upstream requests. Errors are never
cached, so a recovered upstream is picked up on the next call.

Profiles are read only from /v1/profiles/handle/:handle, which answers 404 for a
private profile and leaves out every field the member chose to hide. Nothing
here calls /v1/community/members/:handle, which applies neither rule.
"""

from __future__ import annotations

import os
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

import httpx
from huggingface_hub import HfApi

API_URL = os.environ.get("DATABOUNTY_API_URL", "https://api.databounty.io").rstrip("/")
SITE_URL = os.environ.get("DATABOUNTY_SITE_URL", "https://databounty.io").rstrip("/")
APP_URL = os.environ.get("DATABOUNTY_APP_URL", "https://console.databounty.io").rstrip("/")
HF_ORG = os.environ.get("DATABOUNTY_HF_ORG", "databounty-io")
CACHE_TTL_SECONDS = float(os.environ.get("CACHE_TTL_SECONDS", "120"))

# DataBounty's own MCP server. The dashboard origin proxies /mcp to the API, and
# the API binds every OAuth credential to that origin, so this is the URL
# clients must use (not API_URL).
MCP_URL = f"{APP_URL}/mcp"

DOMAINS = ("coding", "legal", "healthcare", "finance", "science")
DIFFICULTIES = ("beginner", "intermediate", "advanced")
TIERS = ("dharma", "bodhi", "moksha", "nirvana")

# Same rule the dashboard applies when a member claims a handle.
_HANDLE = re.compile(r"^[a-z0-9-]{3,20}$")
_POOL_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PROFILE_URL = re.compile(r"^(?:https?://)?(?:www\.)?databounty\.io/+@?([^/?#]+)/*$", re.IGNORECASE)
_BADGE_STEP = re.compile(r"^(?P<ladder>.+)_(?P<value>\d+)$")

_PAGE_SIZE = {"/v1/community/catalog": 100, "/v1/community/pools": 50}
_MAX_PAGES = 5
_CACHE_MAX_ENTRIES = 256


class UpstreamError(RuntimeError):
    """DataBounty's API could not be reached, or answered with an error."""


_http = httpx.Client(
    base_url=API_URL,
    timeout=httpx.Timeout(15.0, connect=5.0),
    headers={
        "Accept": "application/json",
        "User-Agent": "databounty-space/1.0 (+https://huggingface.co/spaces/databounty-io/DataBounty)",
    },
)
_hub = HfApi()
_cache: OrderedDict[tuple, tuple[float, Any]] = OrderedDict()
_lock = threading.Lock()


def _cached(key: tuple, load: Callable[[], Any]) -> Any:
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit is not None and now - hit[0] < CACHE_TTL_SECONDS:
            _cache.move_to_end(key)
            return hit[1]
    value = load()  # raises on failure, so errors never reach the cache
    with _lock:
        _cache[key] = (now, value)
        _cache.move_to_end(key)
        # Keys include free-text search terms, so bound the cache rather than
        # let a stream of unique queries grow it forever.
        while len(_cache) > _CACHE_MAX_ENTRIES:
            _cache.popitem(last=False)
    return value


def _get(path: str, params: dict[str, Any] | None = None, *, not_found_ok: bool = False) -> Any:
    query = {k: v for k, v in (params or {}).items() if v not in (None, "")}

    def load() -> Any:
        try:
            resp = _http.get(path, params=query)
        except httpx.HTTPError as exc:
            raise UpstreamError(f"DataBounty's API could not be reached ({type(exc).__name__}).") from exc
        if resp.status_code == 404 and not_found_ok:
            return None
        if resp.status_code >= 400:
            raise UpstreamError(f"DataBounty's API answered HTTP {resp.status_code} for {path}.")
        try:
            return resp.json()
        except ValueError as exc:
            raise UpstreamError(f"DataBounty's API returned an unreadable response for {path}.") from exc

    return _cached(("api", path, tuple(sorted(query.items()))), load)


def _all_pages(path: str, key: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor = None
    for _ in range(_MAX_PAGES):
        page = _get(path, {"limit": _PAGE_SIZE[path], "cursor": cursor}) or {}
        rows.extend(page.get(key) or [])
        cursor = page.get("nextCursor")
        if not cursor:
            break
    return rows


def _int(value: Any) -> int:
    # Counts arrive as numbers or as numeric strings (targetItems is a BigInt
    # serialised as text), so accept both.
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _pct(part: int, whole: int) -> float | None:
    return round(100 * part / whole, 1) if whole else None


def _date(value: Any) -> str | None:
    return value[:10] if isinstance(value, str) and len(value) >= 10 else None


# --- Programme totals and karma tiers -----------------------------------------


def stats() -> dict[str, Any]:
    """Programme totals, the karma tier ladder and the top of the leaderboard."""
    return _get("/v1/community/stats") or {}


def tiers() -> list[dict[str, Any]]:
    """The live karma tier ladder, lowest threshold first."""
    return sorted(stats().get("tiers") or [], key=lambda t: _int(t.get("minKarma")))


def tier_for(karma: int, ladder: list[dict[str, Any]]) -> dict[str, Any] | None:
    current = None
    for tier in ladder:
        if karma >= _int(tier.get("minKarma")):
            current = tier
    return current


# --- Pools and datasets ---------------------------------------------------------


def _programme(row: dict[str, Any]) -> dict[str, Any]:
    dataset_type = row.get("datasetType") or {}
    pricing = row.get("karmaPricing") or {}
    target = _int(row.get("targetItems"))
    accepted = _int(row.get("acceptedItems"))
    cleared = _int(row.get("clearedItems"))
    pool_id = str(row.get("id") or "")
    return {
        "id": pool_id,
        "title": row.get("title") or "",
        "status": row.get("status") or "",
        "dataset_type": dataset_type.get("name") or "",
        "domain": dataset_type.get("domain") or "",
        "category": row.get("datasetCategory") or "",
        "language": row.get("language") or "",
        "difficulty": row.get("difficulty") or "",
        "trust_tier": dataset_type.get("trustTier") or "",
        "target_items": target,
        "accepted_items": accepted,
        # Cleared items passed the automated checks and hold a slot in the pool;
        # the ones not yet accepted are waiting on a human validator.
        "in_review_items": max(cleared - accepted, 0),
        "progress_pct": _pct(accepted, target),
        "karma_per_accepted_item": pricing.get("contributorPerItem"),
        "validator_karma_per_audited_item": pricing.get("validatorPerAuditedItem"),
        "audit_coverage_pct": row.get("auditCoveragePct"),
        "license": row.get("communityLicense") or "",
        "page_url": f"{SITE_URL}/pools/{pool_id}/",
        "contribute_url": f"{APP_URL}/contributor/pool/{pool_id}/",
    }


def _catalog() -> list[dict[str, Any]]:
    return _cached(("catalog",), lambda: _all_pages("/v1/community/catalog", "bounties"))


def open_pools(query: str = "", domain: str = "", difficulty: str = "") -> list[dict[str, Any]]:
    """Pools currently open for contribution, optionally filtered.

    "Open" is whatever the platform's own open-pools endpoint lists; the catalog
    supplies the descriptive fields that endpoint leaves out.
    """
    open_ids = {row.get("id") for row in _all_pages("/v1/community/pools", "pools")}
    needle = query.strip().lower()
    pools = []
    for row in _catalog():
        if row.get("id") not in open_ids:
            continue
        pool = _programme(row)
        if domain and pool["domain"] != domain:
            continue
        if difficulty and pool["difficulty"] != difficulty:
            continue
        haystack = " ".join((pool["title"], pool["dataset_type"], pool["language"], row.get("description") or ""))
        if needle and needle not in haystack.lower():
            continue
        pools.append(pool)
    return pools


def pool_details(pool_id: str) -> dict[str, Any] | None:
    """One pool's full public record, or None when the id is unknown."""
    pool_id = (pool_id or "").strip()
    if not _POOL_ID.match(pool_id):
        raise ValueError("That doesn't look like a DataBounty pool id.")
    row = (_get(f"/v1/community/catalog/{quote(pool_id, safe='')}", not_found_ok=True) or {}).get("bounty")
    if not row:
        return None
    pool = _programme(row)
    dataset_type = row.get("datasetType") or {}
    pool.update(
        description=row.get("description") or "",
        contributors=row.get("contributorCount"),
        validators=row.get("validatorCount"),
        duplicate_rate=row.get("duplicateRate"),
        created_at=_date(row.get("createdAt")),
        fields=[
            {
                "key": field.get("key"),
                "label": field.get("label") or field.get("key"),
                "role": field.get("role"),
                "required": bool(field.get("required")),
                "help": field.get("help") or "",
            }
            for field in dataset_type.get("fields") or []
        ],
        hugging_face_dataset=row.get("huggingFaceDataset"),
    )
    return pool


def _hub_datasets() -> dict[str, dict[str, Any]]:
    def load() -> dict[str, dict[str, Any]]:
        return {
            info.id: {"downloads": info.downloads, "likes": info.likes}
            for info in _hub.list_datasets(author=HF_ORG, full=True)
        }

    try:
        return _cached(("hub", HF_ORG), load)
    except Exception:
        # Download counts are decoration; the catalog is the source of truth,
        # so a Hub hiccup must not take the datasets list down with it.
        return {}


def published_datasets() -> list[dict[str, Any]]:
    """Datasets DataBounty has published, newest first, with Hub download counts."""
    hub = _hub_datasets()
    datasets = []
    for row in _catalog():
        if row.get("publicationStatus") != "published":
            continue
        pool = _programme(row)
        targets = (row.get("publication") or {}).get("targets") or []

        def published_url(target: str) -> str | None:
            return next(
                (t.get("url") for t in targets if t.get("target") == target and t.get("state") == "published" and t.get("url")),
                None,
            )

        repo_id = row.get("huggingFaceDataset") or None
        counts = hub.get(repo_id or "", {})
        datasets.append(
            {
                "title": pool["title"],
                "dataset_type": pool["dataset_type"],
                "items": pool["accepted_items"],
                "license": pool["license"],
                "difficulty": pool["difficulty"],
                "published_on": _date(row.get("deliveredAt")),
                "hugging_face_id": repo_id,
                "hugging_face_url": published_url("huggingface") or (f"https://huggingface.co/datasets/{repo_id}" if repo_id else None),
                "github_url": published_url("github"),
                "downloads": counts.get("downloads"),
                "likes": counts.get("likes"),
                "page_url": pool["page_url"],
            }
        )
    datasets.sort(key=lambda d: d["published_on"] or "", reverse=True)
    return datasets


# --- People -----------------------------------------------------------------------


def leaderboard(limit: int = 50, tier: str = "", query: str = "") -> list[dict[str, Any]]:
    """The all-time karma leaderboard.

    The API already leaves out members who hide their karma, so this never
    shows more than databounty.io's own leaderboard does.
    """
    params = {
        "limit": max(1, min(_int(limit) or 50, 100)),
        "tier": tier if tier in TIERS else None,
        "q": query.strip()[:60] or None,
    }
    rows = (_get("/v1/community/leaderboard", params) or {}).get("leaderboard") or []
    ladder = tiers()
    board = []
    for row in rows:
        karma = _int(row.get("karma"))
        handle = row.get("handle")
        board.append(
            {
                "rank": row.get("rank"),
                "handle": handle,
                "display_name": row.get("displayName") or handle,
                "karma": karma,
                "accepted_items": row.get("acceptedItems"),
                "tier": (tier_for(karma, ladder) or {}).get("label"),
                "profile_url": f"{SITE_URL}/{handle}/" if handle else None,
            }
        )
    return board


def normalize_handle(handle: str) -> str:
    """Accept "starlord", "@starlord" or a pasted databounty.io profile URL."""
    value = (handle or "").strip()
    match = _PROFILE_URL.match(value)
    if match:
        value = match.group(1)
    value = value.lstrip("@").lower()
    if not _HANDLE.match(value):
        raise ValueError("Handles are 3-20 characters long and use lowercase letters, digits and hyphens.")
    return value


def _badge_labels(badges: list[dict[str, Any]]) -> list[str]:
    """Readable badge labels, keeping only the highest step of each tiered badge.

    Tiered badges (10, 25, 100 audits and so on) share a "{value} ..." label and
    carry their threshold as the id suffix (bdg_audits_100), which is how the
    catalog is seeded. The public profile response does not include the
    threshold itself, so the suffix is the only place to read it from.
    """
    highest: dict[str, tuple[int, str]] = {}
    plain: list[str] = []
    for badge in badges:
        label = badge.get("label") or ""
        step = _BADGE_STEP.match(badge.get("id") or "")
        if "{value}" in label and step:
            value = int(step.group("value"))
            if value > highest.get(step.group("ladder"), (-1, ""))[0]:
                highest[step.group("ladder")] = (value, label.replace("{value}", f"{value:,}"))
        elif label:
            plain.append(" ".join(label.replace("{value}", "").split()))
    return [label for _, label in highest.values()] + plain


def contributor(handle: str) -> dict[str, Any] | None:
    """A contributor's public profile, or None if there is no public profile.

    Fields the member chose to hide are absent upstream and come back as None
    here, so callers must treat every field except the handle as optional.
    """
    handle = normalize_handle(handle)
    data = _get(f"/v1/profiles/handle/{quote(handle, safe='')}", not_found_ok=True)
    if not data:
        return None
    tier = data.get("tier") if isinstance(data.get("tier"), dict) else None
    return {
        "handle": data.get("handle") or handle,
        "display_name": data.get("displayName") or data.get("handle") or handle,
        "member_since": _date(data.get("memberSince")),
        "karma": data.get("karma"),
        "tier": tier.get("label") if tier else None,
        "tier_color": tier.get("color") if tier else None,
        "badges": _badge_labels(data["badges"]) if "badges" in data else None,
        "accepted_items": data.get("acceptedItems"),
        "audits": data.get("audits"),
        "datasets_contributed_to": (
            [{"title": d.get("title"), "items": d.get("items")} for d in data["datasets"]] if "datasets" in data else None
        ),
        "published_credits": [
            {"title": c.get("title"), "hugging_face_url": c.get("hfUrl")}
            for c in data.get("publishedCredits") or []
            if c.get("hfUrl")
        ],
        "profile_url": f"{SITE_URL}/{handle}/",
    }


# --- Agents -------------------------------------------------------------------------


def platform_mcp_tools() -> list[dict[str, str]]:
    """DataBounty's own MCP tool catalog, with the credential scope each one needs."""
    tools = (_get("/mcp/tools") or {}).get("tools") or []
    return [
        {
            "name": tool.get("name") or "",
            "scope": tool.get("scope") or "",
            "description": " ".join((tool.get("description") or "").split()),
        }
        for tool in tools
    ]
