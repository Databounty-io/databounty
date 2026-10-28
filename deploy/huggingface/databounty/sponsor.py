# SPDX-License-Identifier: Apache-2.0
"""Sponsoring from the Space: what a pool's requester sees of the items in their pool.

Plain data in, plain data out, like contribute.py and validate.py. It reads DataBounty's
get_sponsor_submission_evidence, which only the pool's requester may call, and shapes a dispute for
dispute_accepted_submission. Requesting a dataset stays on databounty.io: DataBounty keeps that on
its dashboard by design.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import contribute
import validate

# DataBounty refuses a dispute whose argument is shorter or longer than this (dispute_accepted_submission).
MIN_ARGUMENT, MAX_ARGUMENT = 10, 2000


def _open(closes_at: Any, now: datetime) -> bool:
    if not isinstance(closes_at, str):
        return False
    try:
        return datetime.fromisoformat(closes_at.replace("Z", "+00:00")) > now
    except ValueError:
        return False


def item_view(sub: dict[str, Any], specs: list[dict[str, Any]], now: datetime | None = None) -> dict[str, Any]:
    """One item in the sponsor's pool: what it is, where it stands, its checks, and whether it can be disputed."""
    now = now or datetime.now(timezone.utc)
    status = contribute.status_view(sub.get("status"))
    contributor = sub.get("contributor") or {}
    closes = sub.get("disputeWindowClosesAt")
    flags = [
        {"reason": validate.FLAG_REASONS.get(str(f.get("reason") or ""), str(f.get("reason") or "").replace("_", " ")), "note": f.get("details") or ""}
        for f in sub.get("flags") or []
        if isinstance(f, dict)
    ]
    # Seen from the sponsor's side: an item that came back waits on its contributor, not on them.
    label = "Sent back for a fix" if status["group"] == "action" else status["label"]
    return {
        "id": sub.get("id"),
        "title": sub.get("title") or "",
        "status": sub.get("status"),
        "statusLabel": label,
        "statusTone": status["tone"],
        "statusGroup": status["group"],
        "contributor": contributor.get("displayName") or contributor.get("handle") or "",
        "handle": contributor.get("handle") or "",
        "date": str(sub.get("createdAt") or "")[:10],
        "method": validate.METHOD_LABELS.get(str(sub.get("generationMethod") or ""), ""),
        "fields": validate.fields_view(sub.get("payloadJson"), specs),
        "checks": [c for c in contribute.checks_for(sub.get("validationResults")) if c["stage"] != "human_audit"],
        "flags": flags,
        "canDispute": sub.get("status") == "accepted" and _open(closes, now),
        "disputeUntil": closes if sub.get("status") == "accepted" else None,
    }


def pool_view(data: dict[str, Any], specs: list[dict[str, Any]], now: datetime | None = None) -> dict[str, Any]:
    """The sponsor's view of their pool, from get_sponsor_submission_evidence."""
    items = [item_view(sub, specs, now) for sub in data.get("submissions") or [] if isinstance(sub, dict)]
    total = data.get("total")
    return {"total": total if isinstance(total, int) else len(items), "items": items, "more": bool(data.get("hasMore"))}


def dispute(body: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """A dispute in dispute_accepted_submission's shape, or why DataBounty would refuse it."""
    reason = str(body.get("reason") or "")
    argument = str(body.get("argument") or "").strip()  # DataBounty trims it too
    if reason not in validate.FLAG_REASONS:
        return None, "Choose why the item shouldn't have been accepted."
    if len(argument) < MIN_ARGUMENT:
        return None, f"Explain what's wrong in at least {MIN_ARGUMENT} characters. An admin decides the dispute."
    if len(argument) > MAX_ARGUMENT:
        return None, f"Keep the explanation under {MAX_ARGUMENT} characters."
    return {"reason": reason, "argument": argument}, ""
